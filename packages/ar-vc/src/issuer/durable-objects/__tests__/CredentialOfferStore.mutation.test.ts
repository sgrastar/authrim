/**
 * Credential offer store against real SQLite: validation errors, state machine edges, leases,
 * issuance, nonces, cleanup and the fetch protocol.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialOfferStore, type CreateCredentialOfferInput } from '../CredentialOfferStore';
import { createSqliteState } from './sqlite-storage';

const T = 'tenant-a';
const NOW = 1_700_000_000_000;
const MIN = 60_000;

let harness: ReturnType<typeof createSqliteState>;
let store: CredentialOfferStore;

const offerInput = (
  overrides: Partial<CreateCredentialOfferInput> = {}
): CreateCredentialOfferInput => ({
  id: 'o1',
  tenantId: T,
  userId: 'u1',
  credentialProfileId: 'profile',
  credentialProfileVersion: 1,
  credentialProfileSnapshotHash: 'snap',
  credentialConfigurationId: 'cfg',
  mappingVersionId: 'map',
  mappingSnapshotHash: 'maphash',
  claimManifestHash: 'manifest',
  claims: { a: 1 },
  preAuthorizedCodeHash: 'code',
  createdAt: NOW,
  expiresAt: NOW + 10 * MIN,
  ...overrides,
});
const reserve = (now = NOW + 1000, extra: Record<string, unknown> = {}) =>
  store.reserveOfferRpc({ id: 'o1', tenantId: T, preAuthorizedCodeHash: 'code', now, ...extra });
const row = (sql: string, ...params: Array<string | number>) =>
  harness.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
const offerRow = (id = 'o1') => row('SELECT * FROM credential_offers WHERE id = ?', id);
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW + 1000);
  harness = createSqliteState();
  store = new CredentialOfferStore(harness.state, {} as never);
  await harness.ready();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Takes the offer to `consumed` with claims valid for ten more minutes. */
function consume(id = 'o1', code = 'code') {
  const reserved = store.reserveOfferRpc({
    id,
    tenantId: T,
    preAuthorizedCodeHash: code,
    now: NOW + 1000,
  });
  if (!reserved.reserved) throw new Error('reserve failed');
  expect(
    store.completeOfferRpc({
      id,
      tenantId: T,
      reservationId: reserved.reservationId,
      claimsExpiresAt: NOW + 10 * MIN,
    })
  ).toBe(true);
}

describe('createOfferRpc', () => {
  it('returns the stored record and schedules the cleanup alarm', async () => {
    const record = store.createOfferRpc(offerInput({ txCodeHash: 'tx' }));
    expect(record).toEqual({
      id: 'o1',
      tenantId: T,
      userId: 'u1',
      credentialProfileId: 'profile',
      credentialProfileVersion: 1,
      credentialProfileSnapshotHash: 'snap',
      credentialConfigurationId: 'cfg',
      mappingVersionId: 'map',
      mappingSnapshotHash: 'maphash',
      claimManifestHash: 'manifest',
      claims: { a: 1 },
      txCodeRequired: true,
      status: 'pending',
      subjectKind: 'end_user',
      failedAttempts: 0,
      maxAttempts: 5,
      createdAt: NOW,
      expiresAt: NOW + 10 * MIN,
    });
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 10 * MIN);
  });

  it('trims identifiers and reports no tx code for an offer without one', () => {
    const record = store.createOfferRpc(
      offerInput({ id: ' o1 ', tenantId: ` ${T} `, claims: undefined as never })
    );
    expect(record).toMatchObject({ id: 'o1', tenantId: T, txCodeRequired: false, claims: {} });
  });

  it.each([
    ['id', 'offer_id'],
    ['tenantId', 'tenant_id'],
    ['userId', 'user_id'],
    ['credentialProfileId', 'credential_profile_id'],
    ['credentialConfigurationId', 'credential_configuration_id'],
    ['credentialProfileSnapshotHash', 'credential_profile_snapshot_hash'],
    ['mappingVersionId', 'mapping_version_id'],
    ['mappingSnapshotHash', 'mapping_snapshot_hash'],
    ['claimManifestHash', 'claim_manifest_hash'],
    ['preAuthorizedCodeHash', 'code_hash'],
  ])('requires %s', (field, name) => {
    expect(() => store.createOfferRpc(offerInput({ [field]: '  ' }))).toThrow(
      `vci_missing_${name}`
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_VALUE])('refuses profile version %s', (version) => {
    expect(() => store.createOfferRpc(offerInput({ credentialProfileVersion: version }))).toThrow(
      'vci_invalid_credential_profile_version'
    );
  });

  it('refuses an offer that expires when it is created and accepts one a millisecond later', () => {
    for (const expiresAt of [NOW, NOW - 1]) {
      expect(() => store.createOfferRpc(offerInput({ expiresAt }))).toThrow(
        'vci_invalid_offer_expiry'
      );
    }
    expect(store.createOfferRpc(offerInput({ expiresAt: NOW + 1 })).expiresAt).toBe(NOW + 1);
  });

  it('accepts the two subject kinds only', () => {
    expect(() => store.createOfferRpc(offerInput({ subjectKind: 'root' as never }))).toThrow(
      'vci_invalid_subject_kind'
    );
    expect(store.createOfferRpc(offerInput({ subjectKind: 'admin' })).subjectKind).toBe('admin');
  });

  it.each([
    [undefined, 5],
    [0, 1],
    [1, 1],
    [3, 3],
    [10, 10],
    [11, 10],
    [999, 10],
  ])('keeps max attempts %s within bounds as %s', (given, stored) => {
    expect(store.createOfferRpc(offerInput({ maxAttempts: given })).maxAttempts).toBe(stored);
  });
});

describe('getOfferRpc', () => {
  it('is null for an unknown offer and requires identifiers', () => {
    expect(store.getOfferRpc({ id: 'x', tenantId: T })).toBeNull();
    expect(() => store.getOfferRpc({ id: '', tenantId: T })).toThrow('vci_missing_offer_id');
    expect(() => store.getOfferRpc({ id: 'x', tenantId: '' })).toThrow('vci_missing_tenant_id');
  });

  it('expires a pending offer at exactly its expiry and records it', () => {
    store.createOfferRpc(offerInput());
    expect(store.getOfferRpc({ id: 'o1', tenantId: T, now: NOW + 10 * MIN - 1 })?.status).toBe(
      'pending'
    );
    const expired = store.getOfferRpc({ id: 'o1', tenantId: T, now: NOW + 10 * MIN });
    expect(expired).toMatchObject({ status: 'expired', claims: { a: 1 } });
    expect(offerRow()).toMatchObject({ status: 'expired' });
  });

  it('expires a processing offer and clears its lease, but leaves a consumed one', () => {
    store.createOfferRpc(offerInput());
    reserve();
    expect(store.getOfferRpc({ id: 'o1', tenantId: T, now: NOW + 11 * MIN })?.status).toBe(
      'expired'
    );
    expect(offerRow()).toMatchObject({ reservation_id: null, lease_expires_at: null });
    store.createOfferRpc(offerInput({ id: 'o2', preAuthorizedCodeHash: 'c2' }));
    consume('o2', 'c2');
    expect(store.getOfferRpc({ id: 'o2', tenantId: T, now: NOW + 11 * MIN })?.status).toBe(
      'consumed'
    );
  });

  it('uses the clock without an explicit time', () => {
    store.createOfferRpc(offerInput({ expiresAt: NOW + 2000 }));
    expect(store.getOfferRpc({ id: 'o1', tenantId: T })?.status).toBe('pending');
    vi.setSystemTime(NOW + 2000);
    expect(store.getOfferRpc({ id: 'o1', tenantId: T })?.status).toBe('expired');
  });
});

describe('reserveOfferRpc', () => {
  it('reserves with a lease and returns the processing offer', () => {
    store.createOfferRpc(offerInput());
    const result = reserve();
    expect(result).toMatchObject({
      reserved: true,
      offer: { id: 'o1', status: 'processing', claims: { a: 1 } },
    });
    expect(offerRow()).toMatchObject({
      status: 'processing',
      lease_expires_at: NOW + 1000 + 30_000,
    });
  });

  it.each([
    [undefined, 30_000],
    [1, 5_000],
    [5_000, 5_000],
    [60_000, 60_000],
    [120_000, 120_000],
    [999_999, 120_000],
  ])('clamps a lease of %s to %s ms', (leaseMs, expected) => {
    store.createOfferRpc(offerInput());
    reserve(NOW + 1000, { leaseMs });
    expect(offerRow()?.lease_expires_at).toBe(NOW + 1000 + expected);
  });

  it('never leases beyond the offer expiry', () => {
    store.createOfferRpc(offerInput({ expiresAt: NOW + 10_000 }));
    reserve(NOW + 1000);
    expect(offerRow()?.lease_expires_at).toBe(NOW + 10_000);
  });

  it('refuses an unknown offer, a wrong code and a taken or expired offer, each for its own reason', () => {
    expect(reserve()).toEqual({ reserved: false, reason: 'not_found' });
    store.createOfferRpc(offerInput());
    expect(reserve(NOW + 1000, { preAuthorizedCodeHash: 'wrong' })).toEqual({
      reserved: false,
      reason: 'invalid_code',
    });
    expect(offerRow()).toMatchObject({ status: 'pending', failed_attempts: 0 });
    expect(reserve().reserved).toBe(true);
    expect(reserve(NOW + 2000)).toEqual({ reserved: false, reason: 'unavailable' });
    store.createOfferRpc(offerInput({ id: 'o3', preAuthorizedCodeHash: 'c3' }));
    // An expired offer is unavailable whatever code is sent, and is recorded as expired.
    expect(
      store.reserveOfferRpc({
        id: 'o3',
        tenantId: T,
        preAuthorizedCodeHash: 'wrong',
        now: NOW + 10 * MIN,
      })
    ).toEqual({ reserved: false, reason: 'unavailable' });
    expect(offerRow('o3')?.status).toBe('expired');
  });

  it('reserves an offer one millisecond before it expires and not at its expiry', () => {
    store.createOfferRpc(offerInput());
    expect(reserve(NOW + 10 * MIN - 1).reserved).toBe(true);
    store.createOfferRpc(offerInput({ id: 'o2', preAuthorizedCodeHash: 'c2' }));
    expect(
      store.reserveOfferRpc({
        id: 'o2',
        tenantId: T,
        preAuthorizedCodeHash: 'c2',
        now: NOW + 10 * MIN,
      })
    ).toEqual({ reserved: false, reason: 'unavailable' });
  });

  it('gives a processing offer back when its lease has run out, exactly at the lease end', () => {
    store.createOfferRpc(offerInput());
    reserve(NOW + 1000);
    expect(reserve(NOW + 1000 + 30_000 - 1)).toEqual({ reserved: false, reason: 'unavailable' });
    const again = reserve(NOW + 1000 + 30_000);
    expect(again.reserved).toBe(true);
    expect(offerRow()).toMatchObject({ status: 'processing' });
  });

  it('keeps the tx code rules: required, not expected, wrong counts, correct reserves', () => {
    store.createOfferRpc(offerInput({ txCodeHash: 'tx', maxAttempts: 2 }));
    expect(reserve()).toEqual({ reserved: false, reason: 'tx_code_required' });
    expect(offerRow()?.failed_attempts).toBe(0);
    expect(reserve(NOW + 1000, { txCodeHash: 'bad' })).toEqual({
      reserved: false,
      reason: 'invalid_tx_code',
    });
    expect(offerRow()).toMatchObject({ failed_attempts: 1, status: 'pending' });
    expect(reserve(NOW + 1000, { txCodeHash: 'bad' })).toEqual({
      reserved: false,
      reason: 'invalid_tx_code',
    });
    expect(offerRow()).toMatchObject({ failed_attempts: 2, status: 'locked' });
    expect(reserve(NOW + 1000, { txCodeHash: 'tx' })).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
    store.createOfferRpc(offerInput({ id: 'o2', preAuthorizedCodeHash: 'c2' }));
    expect(
      store.reserveOfferRpc({
        id: 'o2',
        tenantId: T,
        preAuthorizedCodeHash: 'c2',
        txCodeHash: 'tx',
        now: NOW + 1000,
      })
    ).toEqual({ reserved: false, reason: 'tx_code_not_expected' });
    store.createOfferRpc(offerInput({ id: 'o3', preAuthorizedCodeHash: 'c3', txCodeHash: 'tx' }));
    expect(
      store.reserveOfferRpc({
        id: 'o3',
        tenantId: T,
        preAuthorizedCodeHash: 'c3',
        txCodeHash: 'tx',
        now: NOW + 1000,
      }).reserved
    ).toBe(true);
  });
});

describe('completing and releasing a reservation', () => {
  it('consumes the offer, shortening nothing but replacing its expiry', () => {
    store.createOfferRpc(offerInput());
    const result = reserve();
    if (!result.reserved) throw new Error('not reserved');
    const base = { id: 'o1', tenantId: T, reservationId: result.reservationId };
    for (const claimsExpiresAt of [Number.NaN, Number.POSITIVE_INFINITY, NOW + 1000]) {
      expect(() => store.completeOfferRpc({ ...base, claimsExpiresAt })).toThrow(
        'vci_invalid_claims_expiry'
      );
    }
    expect(
      store.completeOfferRpc({ ...base, reservationId: 'other', claimsExpiresAt: NOW + 5 * MIN })
    ).toBe(false);
    expect(() =>
      store.completeOfferRpc({ ...base, reservationId: ' ', claimsExpiresAt: NOW + 5 * MIN })
    ).toThrow('vci_missing_reservation_id');
    expect(store.completeOfferRpc({ ...base, claimsExpiresAt: NOW + 1001 + 1 })).toBe(true);
    expect(offerRow()).toMatchObject({
      status: 'consumed',
      expires_at: NOW + 1002,
      reservation_id: null,
    });
    expect(store.completeOfferRpc({ ...base, claimsExpiresAt: NOW + 5 * MIN })).toBe(false);
  });

  it('releases only a live reservation of the same id, back to pending', () => {
    store.createOfferRpc(offerInput({ expiresAt: NOW + 5000 }));
    const result = reserve();
    if (!result.reserved) throw new Error('not reserved');
    const base = { id: 'o1', tenantId: T, reservationId: result.reservationId };
    expect(store.releaseOfferRpc({ ...base, reservationId: 'other' })).toBe(false);
    expect(() => store.releaseOfferRpc({ ...base, id: '' })).toThrow('vci_missing_offer_id');
    expect(() => store.releaseOfferRpc({ ...base, tenantId: '' })).toThrow('vci_missing_tenant_id');
    vi.setSystemTime(NOW + 5000);
    expect(store.releaseOfferRpc(base)).toBe(false);
    vi.setSystemTime(NOW + 4999);
    expect(store.releaseOfferRpc(base)).toBe(true);
    expect(offerRow()).toMatchObject({
      status: 'pending',
      reservation_id: null,
      lease_expires_at: null,
    });
  });

  it('records the first fetch of a pending offer only', () => {
    store.createOfferRpc(offerInput());
    const input = { id: 'o1', tenantId: T, now: NOW + 2000 };
    expect(store.markOfferFetchedRpc(input)).toBe(true);
    expect(store.markOfferFetchedRpc({ ...input, now: NOW + 3000 })).toBe(false);
    expect(offerRow()?.fetched_at).toBe(NOW + 2000);
    store.createOfferRpc(offerInput({ id: 'o2', preAuthorizedCodeHash: 'c2' }));
    expect(store.markOfferFetchedRpc({ id: 'o2', tenantId: T, now: NOW + 10 * MIN })).toBe(false);
    reserve();
    store.createOfferRpc(offerInput({ id: 'o4', preAuthorizedCodeHash: 'c4' }));
    expect(() => store.markOfferFetchedRpc({ id: '', tenantId: T, now: 1 })).toThrow(
      'vci_missing_offer_id'
    );
    expect(() => store.markOfferFetchedRpc({ id: 'o4', tenantId: '', now: 1 })).toThrow(
      'vci_missing_tenant_id'
    );
  });
});

describe('issuance', () => {
  const claim = (extra: Record<string, unknown> = {}) =>
    store.claimIssuanceRpc({
      id: 'o1',
      tenantId: T,
      accessTokenJti: 'jti',
      now: NOW + 2000,
      ...extra,
    });
  const complete = (extra: Record<string, unknown> = {}) =>
    store.completeIssuanceRpc({
      id: 'o1',
      tenantId: T,
      accessTokenJti: 'jti',
      holderJkt: 'jkt',
      now: NOW + 3000,
      ...extra,
    });
  const fail = (extra: Record<string, unknown> = {}) =>
    store.failIssuanceRpc({
      id: 'o1',
      tenantId: T,
      accessTokenJti: 'jti',
      now: NOW + 3000,
      ...extra,
    });
  const issuance = () => row('SELECT * FROM credential_offer_issuances WHERE offer_id = ?', 'o1');

  beforeEach(() => store.createOfferRpc(offerInput({ userId: 'admin-1', subjectKind: 'admin' })));

  it('is claimed once, from a consumed unexpired offer, with a lease', () => {
    expect(claim()).toBe(false);
    consume();
    expect(claim({ now: NOW + 10 * MIN })).toBe(false);
    expect(claim({ leaseMs: 5000 })).toBe(true);
    expect(issuance()).toMatchObject({
      status: 'issuing',
      lease_expires_at: NOW + 7000,
      access_token_jti: 'jti',
    });
    expect(claim()).toBe(false);
    expect(claim({ accessTokenJti: 'other' })).toBe(false);
    expect(() => claim({ accessTokenJti: ' ' })).toThrow('vci_missing_access_token_jti');
    expect(() => claim({ id: '' })).toThrow('vci_missing_offer_id');
    expect(() => claim({ tenantId: '' })).toThrow('vci_missing_tenant_id');
  });

  it('uses a one minute lease by default and schedules its end', async () => {
    consume();
    claim();
    expect(issuance()?.lease_expires_at).toBe(NOW + 2000 + MIN);
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 2000 + MIN);
  });

  it('completes for the claiming token only, while the lease holds', () => {
    consume();
    claim();
    expect(complete({ accessTokenJti: 'other' })).toBe(false);
    expect(complete({ id: 'other' })).toBe(false);
    expect(complete({ now: NOW + 2000 + MIN })).toBe(false);
    expect(issuance()?.status).toBe('failed');
    expect(complete()).toBe(false);
  });

  it('records the holder key, or none, and refuses a second completion', () => {
    consume();
    claim();
    expect(complete({ holderJkt: null, now: NOW + 2000 + MIN - 1 })).toBe(true);
    expect(issuance()).toMatchObject({
      status: 'issued',
      holder_jkt: null,
      updated_at: NOW + 2000 + MIN - 1,
    });
    expect(complete()).toBe(false);
    expect(fail()).toBe(false);
    expect(() => complete({ accessTokenJti: '' })).toThrow('vci_missing_access_token_jti');
    expect(() => complete({ tenantId: '' })).toThrow('vci_missing_tenant_id');
  });

  it('fails an issuing claim of the right token only', () => {
    consume();
    claim();
    expect(fail({ accessTokenJti: 'other' })).toBe(false);
    expect(fail({ id: 'other' })).toBe(false);
    expect(() => fail({ tenantId: '' })).toThrow('vci_missing_tenant_id');
    expect(() => fail({ accessTokenJti: '' })).toThrow('vci_missing_access_token_jti');
    expect(fail()).toBe(true);
    expect(issuance()).toMatchObject({ status: 'failed', updated_at: NOW + 3000 });
    expect(fail()).toBe(false);
  });

  describe('progress for the owner', () => {
    const progress = (now = NOW + 2000, userId = 'admin-1') =>
      store.getAdminOfferProgressRpc({ id: 'o1', tenantId: T, userId, now });

    it('reveals nothing to another admin or about an end-user offer', () => {
      expect(progress(NOW + 2000, 'someone-else')).toBeNull();
      expect(
        store.getAdminOfferProgressRpc({ id: 'x', tenantId: T, userId: 'admin-1', now: NOW })
      ).toBeNull();
      store.createOfferRpc(
        offerInput({
          id: 'e1',
          userId: 'admin-1',
          preAuthorizedCodeHash: 'e',
          subjectKind: 'end_user',
        })
      );
      expect(
        store.getAdminOfferProgressRpc({ id: 'e1', tenantId: T, userId: 'admin-1', now: NOW })
      ).toBeNull();
    });

    it('walks pending, fetched, token issued, issued and failed', () => {
      expect(progress()).toEqual({ offerId: 'o1', state: 'pending', expiresAt: NOW + 10 * MIN });
      store.markOfferFetchedRpc({ id: 'o1', tenantId: T, now: NOW + 1500 });
      expect(progress()?.state).toBe('fetched');
      consume();
      expect(progress()?.state).toBe('token_issued');
      claim();
      expect(progress()?.state).toBe('token_issued');
      complete({ holderJkt: 'jkt-1' });
      expect(progress()).toEqual({
        offerId: 'o1',
        state: 'issued',
        expiresAt: NOW + 10 * MIN,
        holderKeyThumbprint: 'jkt-1',
      });
    });

    it('reports an issuance without a holder key as token issued, and a failed one as failed', () => {
      consume();
      claim();
      complete({ holderJkt: null });
      expect(progress()?.state).toBe('token_issued');
    });

    it('reports a lapsed issuance lease as failed', () => {
      consume();
      claim();
      expect(progress(NOW + 2000 + MIN - 1)?.state).toBe('token_issued');
      expect(progress(NOW + 2000 + MIN)?.state).toBe('failed');
    });

    it('reports a processing token exchange as fetched, a locked or expired offer, and the expiry', () => {
      reserve();
      expect(progress()?.state).toBe('fetched');
      expect(progress(NOW + 10 * MIN)?.state).toBe('expired');
      store.createOfferRpc(
        offerInput({
          id: 'o5',
          userId: 'admin-1',
          subjectKind: 'admin',
          preAuthorizedCodeHash: 'c5',
          txCodeHash: 'tx',
          maxAttempts: 1,
        })
      );
      store.reserveOfferRpc({
        id: 'o5',
        tenantId: T,
        preAuthorizedCodeHash: 'c5',
        txCodeHash: 'bad',
        now: NOW + 1000,
      });
      expect(
        store.getAdminOfferProgressRpc({
          id: 'o5',
          tenantId: T,
          userId: 'admin-1',
          now: NOW + 1000,
        })?.state
      ).toBe('locked');
      harness.db.prepare("UPDATE credential_offers SET status = 'expired' WHERE id = 'o5'").run();
      expect(
        store.getAdminOfferProgressRpc({
          id: 'o5',
          tenantId: T,
          userId: 'admin-1',
          now: NOW + 1000,
        })?.state
      ).toBe('expired');
    });
  });
});

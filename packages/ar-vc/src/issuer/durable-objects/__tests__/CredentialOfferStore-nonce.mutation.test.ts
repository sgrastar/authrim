/**
 * Credential offer store against real SQLite: proof nonces, the cleanup alarm and the fetch
 * protocol.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialOfferStore, type CreateCredentialOfferInput } from '../CredentialOfferStore';
import { createSqliteState } from './sqlite-storage';

const T = 'tenant-a';
const NOW = 1_700_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;

let harness: ReturnType<typeof createSqliteState>;
let store: CredentialOfferStore;

const nonceInput = (overrides: Record<string, unknown> = {}) => ({
  id: 'n1',
  tenantId: T,
  nonceHash: 'hash',
  createdAt: NOW,
  expiresAt: NOW + 5 * MIN,
  ...overrides,
});
const reserveInput = (overrides: Record<string, unknown> = {}) => ({
  id: 'n1',
  tenantId: T,
  nonceHash: 'hash',
  proofFingerprint: 'fp-1',
  accessTokenJti: 'jti',
  now: NOW + 1000,
  ...overrides,
});
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
const row = (sql: string, ...params: Array<string | number>) =>
  harness.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
const nonceRow = (id = 'n1') => row('SELECT * FROM proof_nonces WHERE id = ?', id);
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

describe('proof nonces', () => {
  it('creates an issued nonce and schedules its expiry', async () => {
    store.createProofNonceRpc(nonceInput());
    expect(nonceRow()).toMatchObject({
      status: 'issued',
      nonce_hash: 'hash',
      expires_at: NOW + 5 * MIN,
    });
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 5 * MIN);
  });

  it('requires its fields and an expiry after creation', () => {
    expect(() => store.createProofNonceRpc(nonceInput({ expiresAt: NOW }))).toThrow(
      'vci_invalid_nonce_expiry'
    );
    expect(() => store.createProofNonceRpc(nonceInput({ expiresAt: NOW - 1 }))).toThrow(
      'vci_invalid_nonce_expiry'
    );
    expect(() => store.createProofNonceRpc(nonceInput({ id: ' ' }))).toThrow(
      'vci_missing_nonce_id'
    );
    expect(() => store.createProofNonceRpc(nonceInput({ tenantId: '' }))).toThrow(
      'vci_missing_tenant_id'
    );
    expect(() => store.createProofNonceRpc(nonceInput({ nonceHash: '' }))).toThrow(
      'vci_missing_nonce_hash'
    );
    store.createProofNonceRpc(nonceInput({ expiresAt: NOW + 1 }));
    expect(nonceRow()).toBeDefined();
  });

  it('reserves with a lease and records the proof it was reserved for', () => {
    store.createProofNonceRpc(nonceInput());
    const result = store.reserveProofNonceRpc(reserveInput());
    expect(result).toEqual({ reserved: true, reservationId: expect.any(String) });
    expect(nonceRow()).toMatchObject({
      status: 'processing',
      proof_fingerprint: 'fp-1',
      access_token_jti: 'jti',
      lease_expires_at: NOW + 1000 + 30_000,
    });
  });

  it.each([
    [undefined, 30_000],
    [1, 5_000],
    [45_000, 45_000],
    [999_999, 120_000],
  ])('clamps a lease of %s to %s ms and never past the expiry', (leaseMs, expected) => {
    store.createProofNonceRpc(nonceInput({ expiresAt: NOW + 10 * MIN }));
    store.reserveProofNonceRpc(reserveInput({ leaseMs }));
    expect(nonceRow()?.lease_expires_at).toBe(NOW + 1000 + expected);
    store.createProofNonceRpc(
      nonceInput({ id: 'short', nonceHash: 'hash-short', expiresAt: NOW + 4000 })
    );
    store.reserveProofNonceRpc(
      reserveInput({ id: 'short', nonceHash: 'hash-short', proofFingerprint: 'fp-2' })
    );
    expect(nonceRow('short')?.lease_expires_at).toBe(NOW + 4000);
  });

  it('tells an unknown nonce, a wrong hash and an unusable nonce apart', () => {
    expect(store.reserveProofNonceRpc(reserveInput())).toEqual({
      reserved: false,
      reason: 'not_found',
    });
    store.createProofNonceRpc(nonceInput());
    expect(store.reserveProofNonceRpc(reserveInput({ nonceHash: 'wrong' }))).toEqual({
      reserved: false,
      reason: 'invalid_nonce',
    });
    store.reserveProofNonceRpc(reserveInput());
    expect(store.reserveProofNonceRpc(reserveInput({ proofFingerprint: 'fp-2' }))).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
    expect(store.reserveProofNonceRpc(reserveInput({ nonceHash: 'wrong' }))).toEqual({
      reserved: false,
      reason: 'invalid_nonce',
    });
  });

  it('refuses an expired nonce at its expiry and accepts it a millisecond before', () => {
    store.createProofNonceRpc(nonceInput());
    expect(store.reserveProofNonceRpc(reserveInput({ now: NOW + 5 * MIN }))).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
    expect(store.reserveProofNonceRpc(reserveInput({ now: NOW + 5 * MIN - 1 })).reserved).toBe(
      true
    );
  });

  it('gives a processing nonce back when its lease ends, clearing the old proof', () => {
    store.createProofNonceRpc(nonceInput());
    store.reserveProofNonceRpc(reserveInput());
    const leaseEnd = NOW + 1000 + 30_000;
    expect(
      store.reserveProofNonceRpc(reserveInput({ now: leaseEnd - 1, proofFingerprint: 'fp-2' }))
    ).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
    expect(
      store.reserveProofNonceRpc(reserveInput({ now: leaseEnd, proofFingerprint: 'fp-2' })).reserved
    ).toBe(true);
    expect(nonceRow()).toMatchObject({ proof_fingerprint: 'fp-2', status: 'processing' });
  });

  it('refuses a proof that another nonce already carried', () => {
    store.createProofNonceRpc(nonceInput());
    store.createProofNonceRpc(nonceInput({ id: 'n2', nonceHash: 'hash-2' }));
    store.reserveProofNonceRpc(reserveInput());
    expect(store.reserveProofNonceRpc(reserveInput({ id: 'n2', nonceHash: 'hash-2' }))).toEqual({
      reserved: false,
      reason: 'replayed_proof',
    });
    expect(() =>
      store.reserveProofNonceRpc(
        reserveInput({ id: 'n2', nonceHash: 'hash-2', proofFingerprint: '' })
      )
    ).toThrow('vci_missing_proof_fingerprint');
    expect(() => store.reserveProofNonceRpc(reserveInput({ id: '' }))).toThrow(
      'vci_missing_nonce_id'
    );
    expect(() => store.reserveProofNonceRpc(reserveInput({ tenantId: '' }))).toThrow(
      'vci_missing_tenant_id'
    );
  });

  it('completes once for its reservation, and releases only a live one', () => {
    store.createProofNonceRpc(nonceInput());
    const result = store.reserveProofNonceRpc(reserveInput());
    if (!result.reserved) throw new Error('not reserved');
    const base = { id: 'n1', tenantId: T, reservationId: result.reservationId };
    expect(store.completeProofNonceRpc({ ...base, reservationId: 'other' })).toBe(false);
    expect(() => store.completeProofNonceRpc({ ...base, reservationId: '' })).toThrow(
      'vci_missing_reservation_id'
    );
    expect(() => store.completeProofNonceRpc({ ...base, id: '' })).toThrow('vci_missing_nonce_id');
    expect(() => store.completeProofNonceRpc({ ...base, tenantId: '' })).toThrow(
      'vci_missing_tenant_id'
    );
    expect(store.releaseProofNonceRpc({ ...base, reservationId: 'other' })).toBe(false);
    expect(store.releaseProofNonceRpc(base)).toBe(true);
    expect(nonceRow()).toMatchObject({
      status: 'issued',
      proof_fingerprint: null,
      reservation_id: null,
    });
    const again = store.reserveProofNonceRpc(reserveInput({ proofFingerprint: 'fp-3' }));
    if (!again.reserved) throw new Error('not reserved');
    expect(store.completeProofNonceRpc({ ...base, reservationId: again.reservationId })).toBe(true);
    expect(nonceRow()?.status).toBe('consumed');
    expect(store.completeProofNonceRpc({ ...base, reservationId: again.reservationId })).toBe(
      false
    );
  });

  it('does not release a reservation once the nonce has expired', () => {
    store.createProofNonceRpc(nonceInput({ expiresAt: NOW + 5000 }));
    const result = store.reserveProofNonceRpc(reserveInput());
    if (!result.reserved) throw new Error('not reserved');
    const base = { id: 'n1', tenantId: T, reservationId: result.reservationId };
    vi.setSystemTime(NOW + 5000);
    expect(store.releaseProofNonceRpc(base)).toBe(false);
    vi.setSystemTime(NOW + 4999);
    expect(store.releaseProofNonceRpc(base)).toBe(true);
    expect(() => store.releaseProofNonceRpc({ ...base, id: '' })).toThrow('vci_missing_nonce_id');
    expect(() => store.releaseProofNonceRpc({ ...base, tenantId: '' })).toThrow(
      'vci_missing_tenant_id'
    );
    expect(() => store.releaseProofNonceRpc({ ...base, reservationId: '' })).toThrow(
      'vci_missing_reservation_id'
    );
  });
});

describe('cleanup alarm', () => {
  const status = (table: string, id: string) =>
    row(`SELECT status FROM ${table} WHERE id = ?`, id)?.status;

  it('expires what ran out, scrubs consumed claims and keeps live rows', async () => {
    store.createOfferRpc(
      offerInput({ id: 'pending-old', preAuthorizedCodeHash: 'a', expiresAt: NOW + 1000 })
    );
    store.createOfferRpc(offerInput({ id: 'pending-live', preAuthorizedCodeHash: 'b' }));
    store.createOfferRpc(
      offerInput({ id: 'processing', preAuthorizedCodeHash: 'c', expiresAt: NOW + 2000 })
    );
    store.reserveOfferRpc({
      id: 'processing',
      tenantId: T,
      preAuthorizedCodeHash: 'c',
      now: NOW + 1000,
    });
    store.createOfferRpc(offerInput({ id: 'consumed', preAuthorizedCodeHash: 'd' }));
    const reserved = store.reserveOfferRpc({
      id: 'consumed',
      tenantId: T,
      preAuthorizedCodeHash: 'd',
      now: NOW + 1000,
    });
    if (!reserved.reserved) throw new Error('not reserved');
    store.completeOfferRpc({
      id: 'consumed',
      tenantId: T,
      reservationId: reserved.reservationId,
      claimsExpiresAt: NOW + 3000,
    });
    store.createProofNonceRpc(nonceInput({ id: 'nonce-old', expiresAt: NOW + 1000 }));
    store.createProofNonceRpc(nonceInput({ id: 'nonce-live', nonceHash: 'h2' }));
    vi.setSystemTime(NOW + 3000);
    await store.alarm();
    expect(status('credential_offers', 'pending-old')).toBe('expired');
    expect(status('credential_offers', 'pending-live')).toBe('pending');
    expect(status('credential_offers', 'processing')).toBe('expired');
    expect(
      row("SELECT reservation_id, lease_expires_at FROM credential_offers WHERE id = 'processing'")
    ).toEqual({
      reservation_id: null,
      lease_expires_at: null,
    });
    expect(row("SELECT status, claims_json FROM credential_offers WHERE id = 'consumed'")).toEqual({
      status: 'consumed',
      claims_json: '{}',
    });
    expect(
      row("SELECT claims_json FROM credential_offers WHERE id = 'pending-live'")?.claims_json
    ).toBe('{"a":1}');
    expect(nonceRow('nonce-old')).toBeUndefined();
    expect(status('proof_nonces', 'nonce-live')).toBe('issued');
  });

  it('expires processing nonces but keeps the proof an expired one carried', async () => {
    store.createProofNonceRpc(nonceInput({ expiresAt: NOW + 2000 }));
    store.reserveProofNonceRpc(reserveInput());
    vi.setSystemTime(NOW + 2000);
    await store.alarm();
    expect(nonceRow()).toMatchObject({
      status: 'expired',
      proof_fingerprint: 'fp-1',
      reservation_id: null,
      lease_expires_at: null,
    });
  });

  it('fails issuances whose lease ended', async () => {
    store.createOfferRpc(offerInput({ subjectKind: 'admin' }));
    const reserved = store.reserveOfferRpc({
      id: 'o1',
      tenantId: T,
      preAuthorizedCodeHash: 'code',
      now: NOW + 1000,
    });
    if (!reserved.reserved) throw new Error('not reserved');
    store.completeOfferRpc({
      id: 'o1',
      tenantId: T,
      reservationId: reserved.reservationId,
      claimsExpiresAt: NOW + 9 * MIN,
    });
    store.claimIssuanceRpc({ id: 'o1', tenantId: T, accessTokenJti: 'jti', now: NOW + 1000 });
    vi.setSystemTime(NOW + 1000 + MIN);
    await store.alarm();
    expect(row('SELECT status FROM credential_offer_issuances')?.status).toBe('failed');
  });

  it('deletes offers, issuances and nonces a day after their expiry, and not before', async () => {
    store.createOfferRpc(
      offerInput({
        id: 'gone',
        preAuthorizedCodeHash: 'g',
        subjectKind: 'admin',
        expiresAt: NOW + 1000,
      })
    );
    store.createOfferRpc(
      offerInput({ id: 'kept', preAuthorizedCodeHash: 'k', expiresAt: NOW + 2000 })
    );
    store.createProofNonceRpc(nonceInput({ id: 'n-gone', expiresAt: NOW + 1000 }));
    harness.db
      .prepare(
        "UPDATE proof_nonces SET status = 'consumed', proof_fingerprint = 'p' WHERE id = 'n-gone'"
      )
      .run();
    harness.db
      .prepare(
        "INSERT INTO credential_offer_issuances (offer_id, tenant_id, status, access_token_jti, lease_expires_at, created_at, updated_at) VALUES ('gone', ?, 'issued', 'j', 1, 1, 1)"
      )
      .run(T);
    vi.setSystemTime(NOW + 1000 + DAY);
    await store.alarm();
    expect(row("SELECT id FROM credential_offers WHERE id = 'gone'")).toBeDefined();
    expect(nonceRow('n-gone')).toBeDefined();
    vi.setSystemTime(NOW + 1000 + DAY + 1);
    await store.alarm();
    expect(row("SELECT id FROM credential_offers WHERE id = 'gone'")).toBeUndefined();
    expect(
      row("SELECT offer_id FROM credential_offer_issuances WHERE offer_id = 'gone'")
    ).toBeUndefined();
    expect(nonceRow('n-gone')).toBeUndefined();
    expect(row("SELECT id FROM credential_offers WHERE id = 'kept'")).toBeDefined();
  });

  it('schedules the next alarm at the earliest of expiry, retention end and lease end', async () => {
    store.createOfferRpc(offerInput({ expiresAt: NOW + 20 * MIN }));
    store.createProofNonceRpc(nonceInput({ expiresAt: NOW + 10 * MIN }));
    vi.setSystemTime(NOW + 2000);
    await flush();
    harness.setAlarm.mockClear();
    await store.alarm();
    expect(harness.setAlarm).toHaveBeenCalledTimes(1);
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 10 * MIN);
    // An expired row waits for the end of its retention.
    vi.setSystemTime(NOW + 11 * MIN);
    harness.setAlarm.mockClear();
    await store.alarm();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 20 * MIN);
  });

  it('never schedules sooner than a second ahead, and not at all when nothing is left', async () => {
    store.createProofNonceRpc(nonceInput({ expiresAt: NOW + 2000 }));
    vi.setSystemTime(NOW + 1999);
    await flush();
    harness.setAlarm.mockClear();
    await store.alarm();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 1999 + 1000);
    const empty = createSqliteState();
    const bare = new CredentialOfferStore(empty.state, {} as never);
    await empty.ready();
    await bare.alarm();
    expect(empty.setAlarm).not.toHaveBeenCalled();
  });
});

describe('fetch protocol', () => {
  const post = (path: string, body: unknown) =>
    store.fetch(
      new Request(`https://internal${path}`, { method: 'POST', body: JSON.stringify(body) })
    );
  const json = async (response: Response) => (await response.json()) as unknown;

  it('creates, reads, reserves, completes and releases an offer', async () => {
    const created = await post('/create', offerInput());
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ id: 'o1', status: 'pending' });
    const byQuery = await store.fetch(new Request(`https://internal/get?id=o1&tenant_id=${T}`));
    expect(byQuery.status).toBe(200);
    expect(await json(byQuery)).toMatchObject({ id: 'o1' });
    const byBody = await post('/get', { id: 'o1', tenantId: T });
    expect(await json(byBody)).toMatchObject({ id: 'o1' });
    const missing = await post('/get', { id: 'nope', tenantId: T });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: 'not_found' });
    const reserved = (await json(
      await post('/reserve', {
        id: 'o1',
        tenantId: T,
        preAuthorizedCodeHash: 'code',
        now: NOW + 1000,
      })
    )) as {
      reserved: boolean;
      reservationId: string;
    };
    expect(reserved.reserved).toBe(true);
    const base = { id: 'o1', tenantId: T, reservationId: reserved.reservationId };
    expect(await json(await post('/release', base))).toEqual({ released: true });
    expect(await json(await post('/release', base))).toEqual({ released: false });
    expect(
      await json(await post('/complete', { ...base, claimsExpiresAt: NOW + 9 * MIN }))
    ).toEqual({ completed: false });
    expect(
      await json(await post('/offer/fetched', { id: 'o1', tenantId: T, now: NOW + 1500 }))
    ).toEqual({ marked: true });
  });

  it('drives issuance and nonces over fetch', async () => {
    await post('/create', offerInput());
    const reserved = (await json(
      await post('/reserve', {
        id: 'o1',
        tenantId: T,
        preAuthorizedCodeHash: 'code',
        now: NOW + 1000,
      })
    )) as {
      reservationId: string;
    };
    expect(
      await json(
        await post('/complete', {
          id: 'o1',
          tenantId: T,
          reservationId: reserved.reservationId,
          claimsExpiresAt: NOW + 9 * MIN,
        })
      )
    ).toEqual({
      completed: true,
    });
    const issuance = { id: 'o1', tenantId: T, accessTokenJti: 'jti', now: NOW + 1000 };
    expect(await json(await post('/issuance/claim', issuance))).toEqual({ claimed: true });
    expect(await json(await post('/issuance/complete', { ...issuance, holderJkt: null }))).toEqual({
      completed: true,
    });
    expect(await json(await post('/issuance/fail', issuance))).toEqual({ failed: false });

    const created = await post('/nonce/create', nonceInput());
    expect(created.status).toBe(201);
    expect(await json(created)).toEqual({ created: true });
    expect(nonceRow()).toBeDefined();
    const nonce = (await json(await post('/nonce/reserve', reserveInput()))) as {
      reserved: boolean;
      reservationId: string;
    };
    expect(nonce.reserved).toBe(true);
    const base = { id: 'n1', tenantId: T, reservationId: nonce.reservationId };
    expect(await json(await post('/nonce/release', base))).toEqual({ released: true });
    const again = (await json(
      await post('/nonce/reserve', reserveInput({ proofFingerprint: 'fp-9' }))
    )) as { reservationId: string };
    expect(
      await json(await post('/nonce/complete', { ...base, reservationId: again.reservationId }))
    ).toEqual({ completed: true });
  });

  it('answers 404 for an unknown path and a generic 500 for a failing operation', async () => {
    const unknown = await store.fetch(new Request('https://internal/nope'));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('Not found');
    const failing = await post('/create', offerInput({ userId: '' }));
    expect(failing.status).toBe(500);
    expect(await json(failing)).toEqual({ error: 'internal_error' });
    const getWithoutBody = await store.fetch(new Request('https://internal/get?id=o1&tenant_id='));
    expect(getWithoutBody.status).toBe(500);
  });
});

describe('offer store extras', () => {
  const claimsInput = (extra: Record<string, unknown> = {}) => ({
    id: 'o1',
    tenantId: T,
    accessTokenJti: 'jti',
    now: NOW + 1000,
    ...extra,
  });

  it('reports a missing identifier by its name, also when it is undefined', () => {
    expect(() => store.createOfferRpc(offerInput({ userId: undefined as never }))).toThrow(
      'vci_missing_user_id'
    );
    expect(() => store.createProofNonceRpc(nonceInput({ nonceHash: undefined }))).toThrow(
      'vci_missing_nonce_hash'
    );
  });

  it('completes an offer only for named ids and schedules the end of its claims', async () => {
    store.createOfferRpc(offerInput());
    const reserved = store.reserveOfferRpc({
      id: 'o1',
      tenantId: T,
      preAuthorizedCodeHash: 'code',
      now: NOW + 1000,
    });
    if (!reserved.reserved) throw new Error('not reserved');
    const base = {
      id: 'o1',
      tenantId: T,
      reservationId: reserved.reservationId,
      claimsExpiresAt: NOW + 5 * MIN,
    };
    expect(() => store.completeOfferRpc({ ...base, id: '' })).toThrow('vci_missing_offer_id');
    expect(() => store.completeOfferRpc({ ...base, tenantId: '' })).toThrow(
      'vci_missing_tenant_id'
    );
    await flush();
    harness.setAlarm.mockClear();
    expect(store.completeOfferRpc({ ...base, reservationId: 'other' })).toBe(false);
    await flush();
    expect(harness.setAlarm).not.toHaveBeenCalled();
    expect(store.completeOfferRpc(base)).toBe(true);
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 5 * MIN);
  });

  it('schedules the lease end of a claim only when it is made, and keeps the earliest alarm', async () => {
    store.createOfferRpc(offerInput({ subjectKind: 'admin' }));
    const reserved = store.reserveOfferRpc({
      id: 'o1',
      tenantId: T,
      preAuthorizedCodeHash: 'code',
      now: NOW + 1000,
    });
    if (!reserved.reserved) throw new Error('not reserved');
    store.completeOfferRpc({
      id: 'o1',
      tenantId: T,
      reservationId: reserved.reservationId,
      claimsExpiresAt: NOW + 9 * MIN,
    });
    await flush();
    harness.setAlarm.mockClear();
    expect(store.claimIssuanceRpc(claimsInput())).toBe(true);
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledTimes(1);
    harness.setAlarm.mockClear();
    expect(store.claimIssuanceRpc(claimsInput())).toBe(false);
    await flush();
    expect(harness.setAlarm).not.toHaveBeenCalled();
  });

  it('only moves the alarm earlier, never later', async () => {
    (
      harness.state.storage as unknown as { getAlarm: ReturnType<typeof vi.fn> }
    ).getAlarm.mockResolvedValue(NOW + 5 * MIN);
    store.createOfferRpc(
      offerInput({ id: 'later', preAuthorizedCodeHash: 'a', expiresAt: NOW + 10 * MIN })
    );
    await flush();
    expect(harness.setAlarm).not.toHaveBeenCalled();
    store.createOfferRpc(
      offerInput({ id: 'same', preAuthorizedCodeHash: 'b', expiresAt: NOW + 5 * MIN })
    );
    await flush();
    expect(harness.setAlarm).not.toHaveBeenCalled();
    store.createOfferRpc(
      offerInput({ id: 'earlier', preAuthorizedCodeHash: 'c', expiresAt: NOW + 2 * MIN })
    );
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 2 * MIN);
  });
});

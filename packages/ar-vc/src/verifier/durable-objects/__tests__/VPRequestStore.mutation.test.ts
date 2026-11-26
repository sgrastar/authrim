/**
 * VP request store against real SQLite: validation, the reserve/complete/fail/release state
 * machine, claim-name minimization, cleanup, the fetch protocol and the delegation to the admin and
 * login tables.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VPRequestStore } from '../VPRequestStore';
import type { VPRequestState } from '../../../types';
import { createSqliteState } from '../../../issuer/durable-objects/__tests__/sqlite-storage';

const T = 'tenant-a';
const NOW = 1_700_000_000_000;
const MIN = 60_000;

let harness: ReturnType<typeof createSqliteState>;
let store: VPRequestStore;

const input = (overrides: Record<string, unknown> & { id?: string } = {}): VPRequestState =>
  ({
    id: 'r1',
    tenantId: T,
    clientId: 'client',
    nonce: `nonce-${overrides.id ?? 'r1'}`,
    statusTokenHash: overrides.id === undefined ? 'status-hash' : `hash-${overrides.id}`,
    responseUri: 'https://verifier.example/response',
    responseMode: 'direct_post',
    status: 'pending',
    createdAt: NOW,
    expiresAt: NOW + 10 * MIN,
    ...overrides,
  }) as VPRequestState;
const reserve = (overrides: Record<string, unknown> = {}) =>
  store.reserveResponseRpc({
    id: 'r1',
    tenantId: T,
    responseFingerprint: 'fp-1',
    now: NOW + 1000,
    ...overrides,
  });
const row = (sql: string, ...params: Array<string | number>) =>
  harness.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
const requestRow = (id = 'r1') => row('SELECT * FROM vp_requests WHERE id = ?', id);
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW + 1000);
  harness = createSqliteState();
  store = new VPRequestStore(harness.state, {} as never);
  await harness.ready();
});
afterEach(() => {
  vi.useRealTimers();
});

function reserved(overrides: Record<string, unknown> = {}) {
  const result = reserve(overrides);
  if (!result.reserved) throw new Error(`not reserved: ${result.reason}`);
  return result.reservationId;
}

describe('createRequestRpc', () => {
  it('stores and returns every field and schedules the cleanup alarm', async () => {
    const created = store.createRequestRpc(
      input({
        userId: 'user-1',
        credentialProfileId: 'profile',
        credentialProfileVersionId: 'profile-v',
        verificationFlowVersionId: 'flow-v',
        verificationMappingVersionId: 'map-v',
        verificationMappingSnapshotHash: 'map-hash',
        maximumAttributeAgeSeconds: 600,
        presentationDefinition: { id: 'pd' },
        dcqlQuery: { credentials: [] },
        responseMode: 'direct_post.jwt',
      })
    );
    expect(created).toEqual({
      id: 'r1',
      tenantId: T,
      clientId: 'client',
      userId: 'user-1',
      credentialProfileId: 'profile',
      credentialProfileVersionId: 'profile-v',
      verificationFlowVersionId: 'flow-v',
      verificationMappingVersionId: 'map-v',
      verificationMappingSnapshotHash: 'map-hash',
      maximumAttributeAgeSeconds: 600,
      nonce: 'nonce-r1',
      state: 'r1',
      presentationDefinition: { id: 'pd' },
      dcqlQuery: { credentials: [] },
      responseUri: 'https://verifier.example/response',
      responseMode: 'direct_post.jwt',
      status: 'pending',
      verifiedClaimNames: undefined,
      errorCode: undefined,
      errorDescription: undefined,
      createdAt: NOW,
      expiresAt: NOW + 10 * MIN,
    });
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 10 * MIN);
  });

  it('leaves absent optional fields undefined and stores them as NULL', () => {
    const created = store.createRequestRpc(input());
    expect(created.userId).toBeUndefined();
    expect(created.presentationDefinition).toBeUndefined();
    expect(created.dcqlQuery).toBeUndefined();
    expect(created.maximumAttributeAgeSeconds).toBeUndefined();
    expect(requestRow()).toMatchObject({
      user_id: null,
      credential_profile_id: null,
      credential_profile_version_id: null,
      verification_flow_version_id: null,
      verification_mapping_version_id: null,
      verification_mapping_snapshot_hash: null,
      maximum_attribute_age_seconds: null,
      presentation_definition_json: null,
      dcql_query_json: null,
    });
  });

  it.each([
    ['id', 'request_id'],
    ['tenantId', 'tenant_id'],
    ['clientId', 'client_id'],
    ['nonce', 'nonce'],
    ['statusTokenHash', 'status_token_hash'],
    ['responseUri', 'response_uri'],
  ])('requires %s', (field, name) => {
    expect(() => store.createRequestRpc(input({ [field]: ' ' }))).toThrow(`vp_missing_${name}`);
    expect(() => store.createRequestRpc(input({ [field]: undefined }))).toThrow(
      `vp_missing_${name}`
    );
  });

  it('trims identifiers, and refuses an expiry that is not after creation or a started request', () => {
    expect(store.createRequestRpc(input({ id: ' r1 ', tenantId: ` ${T} ` })).id).toBe('r1');
    expect(() => store.createRequestRpc(input({ id: 'r2', expiresAt: NOW }))).toThrow(
      'vp_invalid_request_expiry'
    );
    expect(() => store.createRequestRpc(input({ id: 'r2', expiresAt: NOW - 1 }))).toThrow(
      'vp_invalid_request_expiry'
    );
    expect(store.createRequestRpc(input({ id: 'r3', expiresAt: NOW + 1 })).expiresAt).toBe(NOW + 1);
    for (const status of ['processing', 'verified', 'expired']) {
      expect(() => store.createRequestRpc(input({ id: 'r4', status }))).toThrow(
        'vp_invalid_initial_status'
      );
    }
  });
});

describe('reads', () => {
  it('expires a pending or processing request at its expiry and leaves terminal ones', () => {
    store.createRequestRpc(input());
    expect(store.getRequestRpc({ id: 'r1', tenantId: T, now: NOW + 10 * MIN - 1 })?.status).toBe(
      'pending'
    );
    expect(store.getRequestRpc({ id: 'r1', tenantId: T, now: NOW + 10 * MIN })?.status).toBe(
      'expired'
    );
    expect(requestRow()).toMatchObject({ status: 'expired' });
    store.createRequestRpc(input({ id: 'r2', statusTokenHash: 'h2' }));
    reserved({ id: 'r2', responseFingerprint: 'fp-2' });
    expect(store.getRequestRpc({ id: 'r2', tenantId: T, now: NOW + 11 * MIN })?.status).toBe(
      'expired'
    );
    expect(requestRow('r2')).toMatchObject({ reservation_id: null, lease_expires_at: null });
    store.createRequestRpc(input({ id: 'r3', statusTokenHash: 'h3' }));
    const reservation = reserved({ id: 'r3', responseFingerprint: 'fp-3' });
    store.failResponseRpc({ id: 'r3', tenantId: T, reservationId: reservation, errorCode: 'x' });
    expect(store.getRequestRpc({ id: 'r3', tenantId: T, now: NOW + 11 * MIN })?.status).toBe(
      'failed'
    );
  });

  it('is null for unknown or foreign requests and requires identifiers', () => {
    store.createRequestRpc(input());
    expect(store.getRequestRpc({ id: 'nope', tenantId: T })).toBeNull();
    expect(store.getRequestRpc({ id: 'r1', tenantId: 'other' })).toBeNull();
    expect(() => store.getRequestRpc({ id: '', tenantId: T })).toThrow('vp_missing_request_id');
    expect(() => store.getRequestRpc({ id: 'r1', tenantId: '' })).toThrow('vp_missing_tenant_id');
  });

  it('uses the clock without an explicit time', () => {
    store.createRequestRpc(input({ expiresAt: NOW + 2000 }));
    expect(store.getRequestRpc({ id: 'r1', tenantId: T })?.status).toBe('pending');
    vi.setSystemTime(NOW + 2000);
    expect(store.getRequestRpc({ id: 'r1', tenantId: T })?.status).toBe('expired');
  });

  it('serves the status only with the capability digest of the request', () => {
    store.createRequestRpc(input());
    expect(store.getStatusRpc({ id: 'r1', tenantId: T, statusTokenHash: 'status-hash' })?.id).toBe(
      'r1'
    );
    expect(store.getStatusRpc({ id: 'r1', tenantId: T, statusTokenHash: 'other' })).toBeNull();
    expect(
      store.getStatusRpc({ id: 'r1', tenantId: 'other', statusTokenHash: 'status-hash' })
    ).toBeNull();
    expect(
      store.getStatusRpc({
        id: 'r1',
        tenantId: T,
        statusTokenHash: 'status-hash',
        now: NOW + 10 * MIN,
      })?.status
    ).toBe('expired');
    expect(() => store.getStatusRpc({ id: 'r1', tenantId: T, statusTokenHash: ' ' })).toThrow(
      'vp_missing_status_token_hash'
    );
    expect(() => store.getStatusRpc({ id: '', tenantId: T, statusTokenHash: 'h' })).toThrow(
      'vp_missing_request_id'
    );
    expect(() => store.getStatusRpc({ id: 'r1', tenantId: '', statusTokenHash: 'h' })).toThrow(
      'vp_missing_tenant_id'
    );
  });
});

describe('reserveResponseRpc', () => {
  beforeEach(() => store.createRequestRpc(input({ userId: 'user-1' })));

  it('reserves with a lease and returns the processing request', () => {
    const result = reserve();
    expect(result).toMatchObject({
      reserved: true,
      request: { id: 'r1', status: 'processing', userId: 'user-1' },
    });
    expect(requestRow()).toMatchObject({
      status: 'processing',
      response_fingerprint: 'fp-1',
      lease_expires_at: NOW + 1000 + 60_000,
    });
  });

  it.each([
    [undefined, 60_000],
    [1, 5_000],
    [90_000, 90_000],
    [999_999, 120_000],
  ])('clamps a lease of %s to %s ms', (leaseMs, expected) => {
    reserve({ leaseMs });
    expect(requestRow()?.lease_expires_at).toBe(NOW + 1000 + expected);
  });

  it('never leases past the expiry', () => {
    store.createRequestRpc(input({ id: 'r2', statusTokenHash: 'h2', expiresAt: NOW + 10_000 }));
    reserve({ id: 'r2', responseFingerprint: 'fp-2' });
    expect(requestRow('r2')?.lease_expires_at).toBe(NOW + 10_000);
  });

  it('reports each refusal with its own reason', () => {
    expect(reserve({ id: 'nope' })).toEqual({ reserved: false, reason: 'not_found' });
    expect(reserve({ tenantId: 'other' })).toEqual({ reserved: false, reason: 'not_found' });
    reserve();
    expect(reserve({ now: NOW + 2000 })).toEqual({ reserved: false, reason: 'replayed' });
    expect(reserve({ now: NOW + 2000, responseFingerprint: 'fp-2' })).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
    expect(reserve({ now: NOW + 10 * MIN })).toEqual({ reserved: false, reason: 'expired' });
    expect(requestRow()).toMatchObject({
      status: 'expired',
      reservation_id: null,
      lease_expires_at: null,
    });
  });

  it('refuses a response another request already carried, and requires its fields', () => {
    store.createRequestRpc(input({ id: 'r2', statusTokenHash: 'h2' }));
    reserve();
    expect(reserve({ id: 'r2' })).toEqual({ reserved: false, reason: 'replayed' });
    expect(() => reserve({ responseFingerprint: ' ' })).toThrow('vp_missing_response_fingerprint');
    expect(() => reserve({ id: '' })).toThrow('vp_missing_request_id');
    expect(() => reserve({ tenantId: '' })).toThrow('vp_missing_tenant_id');
  });

  it('is expired at exactly the expiry and reservable a millisecond before', () => {
    expect(reserve({ now: NOW + 10 * MIN - 1 }).reserved).toBe(true);
  });

  it('takes a stuck verification over exactly when its lease ended, dropping the old response', () => {
    reserve();
    const leaseEnd = NOW + 1000 + 60_000;
    expect(reserve({ now: leaseEnd - 1, responseFingerprint: 'fp-2' })).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
    expect(reserve({ now: leaseEnd, responseFingerprint: 'fp-2' }).reserved).toBe(true);
    expect(requestRow()).toMatchObject({ response_fingerprint: 'fp-2', status: 'processing' });
    expect(reserve({ now: leaseEnd + 1, responseFingerprint: 'fp-1' })).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
  });
});

describe('completing, failing and releasing', () => {
  const create = (overrides: Record<string, unknown> = {}) =>
    store.createRequestRpc(input(overrides));

  it('completes only with the reservation, once', () => {
    create();
    const reservationId = reserved();
    const base = { id: 'r1', tenantId: T, reservationId };
    expect(store.completeResponseRpc({ ...base, reservationId: 'other' })).toBe(false);
    expect(store.completeResponseRpc({ id: 'nope', tenantId: T, reservationId })).toBe(false);
    expect(() => store.completeResponseRpc({ ...base, reservationId: ' ' })).toThrow(
      'vp_missing_reservation_id'
    );
    expect(() => store.completeResponseRpc({ ...base, id: '' })).toThrow('vp_missing_request_id');
    expect(() => store.completeResponseRpc({ ...base, tenantId: '' })).toThrow(
      'vp_missing_tenant_id'
    );
    expect(store.completeResponseRpc(base)).toBe(true);
    expect(requestRow()).toMatchObject({
      status: 'verified',
      reservation_id: null,
      lease_expires_at: null,
      error_code: null,
    });
    expect(store.completeResponseRpc(base)).toBe(false);
  });

  it('keeps only claim names the request asked for, valid, distinct and at most 64', () => {
    create({
      dcqlQuery: {
        credentials: [
          { claims: [{ path: ['given_name'] }, { path: ['bad name'] }, { path: [5] }, {}] },
          { claims: [{ path: ['family_name'] }] },
          {},
        ],
      },
      presentationDefinition: {
        input_descriptors: [
          {
            constraints: {
              fields: [
                { path: ['$.age', "$['birth-date']", '$["email"]', '$.a.b.c', '$.nested.deep:x'] },
                {},
              ],
            },
          },
          {},
        ],
      },
    });
    const reservationId = reserved();
    store.completeResponseRpc({
      id: 'r1',
      tenantId: T,
      reservationId,
      verifiedClaimNames: [
        'given_name',
        'given_name',
        'family_name',
        'age',
        'birth-date',
        'email',
        'c',
        'deep:x',
        'not_requested',
        'bad name',
        'b',
      ],
    });
    expect(JSON.parse(String(requestRow()?.verified_claim_names_json))).toEqual([
      'given_name',
      'family_name',
      'age',
      'birth-date',
      'email',
      'c',
      'deep:x',
    ]);
    expect(store.getRequestRpc({ id: 'r1', tenantId: T })?.verifiedClaimNames).toEqual([
      'given_name',
      'family_name',
      'age',
      'birth-date',
      'email',
      'c',
      'deep:x',
    ]);
  });

  it('stores no claim names when none were requested or reported', () => {
    create();
    const reservationId = reserved();
    store.completeResponseRpc({ id: 'r1', tenantId: T, reservationId, verifiedClaimNames: ['x'] });
    expect(requestRow()?.verified_claim_names_json).toBeNull();
    create({
      id: 'r2',
      statusTokenHash: 'h2',
      dcqlQuery: { credentials: [{ claims: [{ path: ['x'] }] }] },
    });
    const second = reserved({ id: 'r2', responseFingerprint: 'fp-2' });
    store.completeResponseRpc({ id: 'r2', tenantId: T, reservationId: second });
    expect(requestRow('r2')?.verified_claim_names_json).toBeNull();
  });

  it('caps requested and reported names at 64', () => {
    const names = Array.from({ length: 70 }, (_, index) => `claim_${index}`);
    create({ dcqlQuery: { credentials: [{ claims: names.map((name) => ({ path: [name] })) }] } });
    const reservationId = reserved();
    store.completeResponseRpc({
      id: 'r1',
      tenantId: T,
      reservationId,
      verifiedClaimNames: [...names].reverse(),
    });
    // The last 70 reported are cut to the first 64 of them; only requested names among them stay.
    const stored = JSON.parse(String(requestRow()?.verified_claim_names_json)) as string[];
    expect(stored).toEqual(
      names
        .slice(6)
        .reverse()
        .filter((name) => names.slice(0, 64).includes(name))
    );
    expect(stored).toHaveLength(58);
  });

  it('fails a response terminally, with a bounded description', () => {
    create();
    const reservationId = reserved();
    const base = { id: 'r1', tenantId: T, reservationId, errorCode: 'verification_failed' };
    expect(store.failResponseRpc({ ...base, reservationId: 'other' })).toBe(false);
    expect(() => store.failResponseRpc({ ...base, errorCode: ' ' })).toThrow(
      'vp_missing_error_code'
    );
    expect(() => store.failResponseRpc({ ...base, id: '' })).toThrow('vp_missing_request_id');
    expect(() => store.failResponseRpc({ ...base, tenantId: '' })).toThrow('vp_missing_tenant_id');
    expect(() => store.failResponseRpc({ ...base, reservationId: '' })).toThrow(
      'vp_missing_reservation_id'
    );
    expect(store.failResponseRpc({ ...base, errorDescription: 'e'.repeat(600) })).toBe(true);
    expect(requestRow()).toMatchObject({
      status: 'failed',
      error_code: 'verification_failed',
      reservation_id: null,
    });
    expect(String(requestRow()?.error_description)).toHaveLength(500);
    expect(store.failResponseRpc(base)).toBe(false);
    expect(store.getRequestRpc({ id: 'r1', tenantId: T })).toMatchObject({
      errorCode: 'verification_failed',
      status: 'failed',
    });
  });

  it('stores no description when none is given', () => {
    create();
    const reservationId = reserved();
    store.failResponseRpc({ id: 'r1', tenantId: T, reservationId, errorCode: 'x' });
    expect(requestRow()?.error_description).toBeNull();
  });

  it('releases a live reservation back to pending so a different response may follow', () => {
    create({ expiresAt: NOW + 5000 });
    const reservationId = reserved();
    const base = { id: 'r1', tenantId: T, reservationId };
    expect(store.releaseResponseRpc({ ...base, reservationId: 'other' })).toBe(false);
    expect(() => store.releaseResponseRpc({ ...base, id: '' })).toThrow('vp_missing_request_id');
    expect(() => store.releaseResponseRpc({ ...base, tenantId: '' })).toThrow(
      'vp_missing_tenant_id'
    );
    expect(() => store.releaseResponseRpc({ ...base, reservationId: '' })).toThrow(
      'vp_missing_reservation_id'
    );
    vi.setSystemTime(NOW + 5000);
    expect(store.releaseResponseRpc(base)).toBe(false);
    vi.setSystemTime(NOW + 4999);
    expect(store.releaseResponseRpc(base)).toBe(true);
    expect(requestRow()).toMatchObject({
      status: 'pending',
      response_fingerprint: null,
      reservation_id: null,
    });
    expect(reserve({ responseFingerprint: 'fp-2', now: NOW + 4999 }).reserved).toBe(true);
  });
});

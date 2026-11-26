/**
 * VP request store against real SQLite: cleanup, the fetch protocol and the delegation to the
 * administrator and login tables.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VPRequestStore } from '../VPRequestStore';
import type { VPRequestState } from '../../../types';
import { createSqliteState } from '../../../issuer/durable-objects/__tests__/sqlite-storage';

const T = 'tenant-a';
const NOW = 1_700_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;
const JKT = 'A'.repeat(43);

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

describe('cleanup alarm', () => {
  it('expires, deletes a day after expiry and plans the next alarm', async () => {
    store.createRequestRpc(input({ id: 'old', statusTokenHash: 'h1', expiresAt: NOW + 1000 }));
    store.createRequestRpc(input({ id: 'live', statusTokenHash: 'h2', expiresAt: NOW + 20 * MIN }));
    store.createRequestRpc(input({ id: 'proc', statusTokenHash: 'h3', expiresAt: NOW + 2000 }));
    reserved({ id: 'proc', responseFingerprint: 'fp-p' });
    await flush();
    vi.setSystemTime(NOW + 2000);
    harness.setAlarm.mockClear();
    await store.alarm();
    expect(requestRow('old')?.status).toBe('expired');
    expect(requestRow('proc')).toMatchObject({
      status: 'expired',
      reservation_id: null,
      lease_expires_at: null,
    });
    expect(requestRow('live')?.status).toBe('pending');
    // `old` waits for its retention, `live` for its expiry: the earlier of the two.
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 20 * MIN);
    vi.setSystemTime(NOW + 1000 + DAY);
    await store.alarm();
    expect(requestRow('old')).toBeDefined();
    vi.setSystemTime(NOW + 1000 + DAY + 1);
    await store.alarm();
    expect(requestRow('old')).toBeUndefined();
    expect(requestRow('live')).toBeDefined();
  });

  it('plans retention ends, never sooner than a second ahead, and nothing when empty', async () => {
    store.createRequestRpc(input({ expiresAt: NOW + 2000 }));
    await flush();
    vi.setSystemTime(NOW + 5000);
    harness.setAlarm.mockClear();
    await store.alarm();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 2000 + DAY);
    vi.setSystemTime(NOW + 1999);
    harness.setAlarm.mockClear();
    store.createRequestRpc(
      input({ id: 'r2', statusTokenHash: 'h2', createdAt: NOW, expiresAt: NOW + 2000 })
    );
    await store.alarm();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 1999 + 1000);
    const empty = createSqliteState();
    const bare = new VPRequestStore(empty.state, {} as never);
    await empty.ready();
    await bare.alarm();
    expect(empty.setAlarm).not.toHaveBeenCalled();
  });
});

describe('fetch protocol', () => {
  const call = (path: string, body?: unknown, method = 'POST') =>
    store.fetch(
      new Request(`https://internal${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
  const json = async (response: Response) => (await response.json()) as unknown;

  it('creates, reads and reports status, taking the tenant from the query before the body', async () => {
    const created = await call('/create', input());
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ id: 'r1', status: 'pending' });
    expect(await json(await call(`/get?id=r1&tenant_id=${T}`, undefined, 'GET'))).toMatchObject({
      id: 'r1',
    });
    expect(await json(await call('/get', { id: 'r1', tenantId: T }))).toMatchObject({ id: 'r1' });
    const missing = await call('/get', { id: 'nope', tenantId: T });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ error: 'not_found' });
    expect(
      await json(await call('/status', { id: 'r1', tenantId: T, statusTokenHash: 'status-hash' }))
    ).toMatchObject({ id: 'r1' });
    const denied = await call('/status', { id: 'r1', tenantId: T, statusTokenHash: 'wrong' });
    expect(denied.status).toBe(404);
    expect(await json(denied)).toEqual({ error: 'not_found' });
    expect((await call('/status', { id: 'r1', tenantId: T })).status).toBe(500);
    expect((await call(`/get?id=r1&tenant_id=other`, { id: 'r1', tenantId: T })).status).toBe(404);
  });

  it('reserves, completes, releases and fails over fetch', async () => {
    await call('/create', input());
    const result = (await json(
      await call('/reserve', { id: 'r1', tenantId: T, responseFingerprint: 'fp', now: NOW + 1000 })
    )) as {
      reserved: boolean;
      reservationId: string;
    };
    expect(result.reserved).toBe(true);
    const base = { id: 'r1', tenantId: T, reservationId: result.reservationId };
    expect(await json(await call('/release', base))).toEqual({ released: true });
    expect(await json(await call('/release', base))).toEqual({ released: false });
    const again = (await json(
      await call('/reserve', { id: 'r1', tenantId: T, responseFingerprint: 'fp2', now: NOW + 1000 })
    )) as {
      reservationId: string;
    };
    expect(
      await json(
        await call('/fail', {
          id: 'r1',
          tenantId: T,
          reservationId: again.reservationId,
          errorCode: 'x',
        })
      )
    ).toEqual({ failed: true });
    expect(
      await json(await call('/complete', { ...base, reservationId: again.reservationId }))
    ).toEqual({ completed: false });
  });

  it('answers 404 for unknown paths and 500 for failures without detail', async () => {
    const unknown = await call('/nope', undefined, 'GET');
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('Not found');
    const failing = await call('/create', input({ clientId: '' }));
    expect(failing.status).toBe(500);
    expect(await json(failing)).toEqual({ error: 'internal_error' });
  });
});

describe('administrator and login tables', () => {
  const admin = (overrides: Record<string, unknown> = {}) => ({
    id: 'a1',
    tenantId: T,
    adminUserId: 'admin-1',
    sessionId: 'session-1',
    purpose: 'step_up' as const,
    holderJkts: [JKT],
    nonce: 'nonce',
    matchCode: '07',
    clientId: 'client',
    credentialIssuer: 'https://idp.example',
    transactionData: 'td',
    requestObject: 'a.b.c',
    createdAt: NOW,
    expiresAt: NOW + 5 * MIN,
    ...overrides,
  });

  it('runs an administrator presentation through create, reserve, complete, status and consume', async () => {
    store.createAdminRequestRpc(admin());
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 5 * MIN);
    expect(store.getAdminRequestObjectRpc({ id: 'a1', tenantId: T, now: NOW + 1000 })).toBe(
      'a.b.c'
    );
    const result = store.reserveAdminResponseRpc({
      id: 'a1',
      tenantId: T,
      responseFingerprint: 'fp',
      now: NOW + 1000,
    });
    if (!result.reserved) throw new Error('not reserved');
    expect(result.request.mode).toBe('direct_post');
    expect(
      store.completeAdminResponseRpc({
        id: 'a1',
        tenantId: T,
        reservationId: result.reservationId,
        holderJkt: JKT,
        credentialId: 'cred-1',
        now: NOW + 2000,
      })
    ).toBe(true);
    const who = {
      id: 'a1',
      tenantId: T,
      adminUserId: 'admin-1',
      sessionId: 'session-1',
      now: NOW + 3000,
    };
    expect(store.getAdminStatusRpc(who)).toMatchObject({ status: 'verified' });
    expect(store.consumeAdminResultRpc(who)).toMatchObject({
      holderJkt: JKT,
      credentialId: 'cred-1',
      verifiedAt: NOW + 2000,
    });
    expect(store.consumeAdminResultRpc(who)).toBeNull();
  });

  it('fails and releases administrator responses, and honours the dc_api mode', () => {
    store.createAdminRequestRpc(
      admin({
        mode: 'dc_api',
        matchCode: '',
        expectedOrigin: 'https://console.example',
        encryptionJwk: '{"kty":"EC"}',
      })
    );
    const dc = store.reserveAdminResponseRpc({
      id: 'a1',
      tenantId: T,
      responseFingerprint: 'fp',
      now: NOW + 1000,
      mode: 'dc_api',
    });
    expect(dc).toMatchObject({ reserved: true, request: { mode: 'dc_api' } });
    const direct = store.reserveAdminResponseRpc({
      id: 'a1',
      tenantId: T,
      responseFingerprint: 'fp2',
      now: NOW + 1000,
    });
    expect(direct.reserved).toBe(false);
    if (!dc.reserved) throw new Error('not reserved');
    expect(
      store.releaseAdminResponseRpc({
        id: 'a1',
        tenantId: T,
        reservationId: dc.reservationId,
        now: NOW + 1500,
      })
    ).toBe(true);
    const again = store.reserveAdminResponseRpc({
      id: 'a1',
      tenantId: T,
      responseFingerprint: 'fp3',
      now: NOW + 1600,
      mode: 'dc_api',
    });
    if (!again.reserved) throw new Error('not reserved');
    expect(
      store.failAdminResponseRpc({
        id: 'a1',
        tenantId: T,
        reservationId: again.reservationId,
        errorCode: 'bad',
      })
    ).toBe(true);
    expect(
      store.getAdminStatusRpc({
        id: 'a1',
        tenantId: T,
        adminUserId: 'admin-1',
        sessionId: 'session-1',
        now: NOW + 2000,
      })
    ).toEqual({ status: 'failed', expiresAt: NOW + 5 * MIN, errorCode: 'bad' });
  });

  const login = (overrides: Record<string, unknown> = {}) => ({
    id: 'l1',
    tenantId: T,
    flow: 'cross_device' as const,
    bindingHash: 'B'.repeat(43),
    clientId: 'client',
    credentialIssuer: 'https://idp.example',
    nonce: 'nonce',
    state: 'state',
    encryptionJwk: '{"kty":"EC"}',
    requestObject: 'a.b.c',
    createdAt: NOW,
    expiresAt: NOW + 5 * MIN,
    ...overrides,
  });

  it('runs a login presentation through create, reserve, complete, status and consume', async () => {
    store.createHaipLoginRequestRpc(login());
    await flush();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 5 * MIN);
    expect(store.getHaipLoginRequestObjectRpc({ id: 'l1', tenantId: T, now: NOW + 1000 })).toBe(
      'a.b.c'
    );
    const result = store.reserveHaipLoginResponseRpc({
      id: 'l1',
      tenantId: T,
      responseFingerprint: 'fp',
      now: NOW + 1000,
    });
    if (!result.reserved) throw new Error('not reserved');
    const complete = {
      id: 'l1',
      tenantId: T,
      reservationId: result.reservationId,
      adminUserId: 'admin-1',
      holderJkt: JKT,
      credentialId: 'cred-1',
      now: NOW + 2000,
    };
    expect(store.completeHaipLoginResponseRpc({ ...complete, reservationId: 'other' })).toBe(false);
    expect(store.completeHaipLoginResponseRpc(complete)).toBe(true);
    expect(
      store.getHaipLoginStatusRpc({
        id: 'l1',
        tenantId: T,
        bindingHash: 'B'.repeat(43),
        now: NOW + 3000,
      })
    ).toMatchObject({
      status: 'verified',
      flow: 'cross_device',
    });
    expect(
      store.consumeHaipLoginResultRpc({
        id: 'l1',
        tenantId: T,
        bindingHash: 'B'.repeat(43),
        now: NOW + 3000,
      })
    ).toMatchObject({
      adminUserId: 'admin-1',
      holderJkt: JKT,
      credentialId: 'cred-1',
    });
  });

  it('carries the response code hash of a same-device login through completion and consumption', () => {
    store.createHaipLoginRequestRpc(
      login({ flow: 'same_device', redirectUri: 'https://console.example/cb' })
    );
    const result = store.reserveHaipLoginResponseRpc({
      id: 'l1',
      tenantId: T,
      responseFingerprint: 'fp',
      now: NOW + 1000,
    });
    if (!result.reserved) throw new Error('not reserved');
    const complete = {
      id: 'l1',
      tenantId: T,
      reservationId: result.reservationId,
      adminUserId: 'admin-1',
      holderJkt: JKT,
      credentialId: 'cred-1',
      responseCodeHash: 'C'.repeat(43),
      now: NOW + 2000,
    };
    expect(store.completeHaipLoginResponseRpc(complete)).toBe(true);
    const consume = { id: 'l1', tenantId: T, bindingHash: 'B'.repeat(43), now: NOW + 3000 };
    expect(
      store.consumeHaipLoginResultRpc({ ...consume, responseCodeHash: 'D'.repeat(43) })
    ).toBeNull();
    expect(store.consumeHaipLoginResultRpc(consume)).toBeNull();
    expect(
      store.consumeHaipLoginResultRpc({ ...consume, responseCodeHash: 'C'.repeat(43) })
    ).toMatchObject({ adminUserId: 'admin-1' });
  });

  it('fails and releases login responses', () => {
    store.createHaipLoginRequestRpc(login());
    const first = store.reserveHaipLoginResponseRpc({
      id: 'l1',
      tenantId: T,
      responseFingerprint: 'fp',
      now: NOW + 1000,
    });
    if (!first.reserved) throw new Error('not reserved');
    expect(
      store.releaseHaipLoginResponseRpc({
        id: 'l1',
        tenantId: T,
        reservationId: first.reservationId,
        now: NOW + 1500,
      })
    ).toBe(true);
    const second = store.reserveHaipLoginResponseRpc({
      id: 'l1',
      tenantId: T,
      responseFingerprint: 'fp2',
      now: NOW + 1600,
    });
    if (!second.reserved) throw new Error('not reserved');
    expect(
      store.failHaipLoginResponseRpc({
        id: 'l1',
        tenantId: T,
        reservationId: second.reservationId,
        errorCode: 'bad',
      })
    ).toBe(true);
    expect(
      store.getHaipLoginStatusRpc({
        id: 'l1',
        tenantId: T,
        bindingHash: 'B'.repeat(43),
        now: NOW + 2000,
      })
    ).toEqual({
      status: 'failed',
      flow: 'cross_device',
      expiresAt: NOW + 5 * MIN,
      errorCode: 'bad',
    });
  });

  it('plans the alarm for the earliest of the three tables', async () => {
    store.createRequestRpc(input({ expiresAt: NOW + 30 * MIN }));
    store.createAdminRequestRpc(admin({ expiresAt: NOW + 20 * MIN }));
    store.createHaipLoginRequestRpc(login({ expiresAt: NOW + 10 * MIN }));
    await flush();
    harness.setAlarm.mockClear();
    vi.setSystemTime(NOW + 2000);
    await store.alarm();
    expect(harness.setAlarm).toHaveBeenCalledWith(NOW + 10 * MIN);
  });
});

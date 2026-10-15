/**
 * The DeviceCodeStore user code mapping in its two key shapes.
 *
 * New codes are mapped under the CANONICAL user code (upper case, separators removed:
 * `u:ABCDEFGH`). Before the user code format became configurable the key was the hyphenated 4-4
 * form (`u:ABCD-EFGH`); a code issued by the previous release is still live for up to 30 minutes
 * after the upgrade, so for one release it must stay findable, stay protected against a duplicate,
 * and have its mapping removed when it goes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCodeMetadata } from '../../types/oidc';
import { DeviceCodeStore } from '../DeviceCodeStore';
import { MemoryStorage, durableState, storeRequest } from './store-test-support';

vi.mock('../../utils/audit-log', () => ({ createAuditLog: vi.fn().mockResolvedValue(undefined) }));

const runtimeEnv = {} as never;
type Store = { fetch(request: Request): Promise<Response> };

function record(overrides: Partial<DeviceCodeMetadata> = {}): DeviceCodeMetadata {
  const now = Date.now();
  return {
    tenant_id: 'tenant-a',
    device_code: 'device-1',
    user_code: 'ABCD-EFGH',
    client_id: 'client-1',
    scope: 'openid',
    status: 'pending',
    created_at: now,
    expires_at: now + 600_000,
    poll_count: 0,
    interval: 5,
    ...overrides,
  };
}

async function open(storage = new MemoryStorage()) {
  const harness = durableState(storage);
  const store = new DeviceCodeStore(harness.state, runtimeEnv);
  await harness.initialized();
  return { store, storage };
}

const call = (store: Store, path: string, body: unknown) => store.fetch(storeRequest(path, body));

async function byUserCode(store: Store, userCode: string) {
  const response = await call(store, '/get-by-user-code', { user_code: userCode });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceCodeMetadata | null;
}

/** What the previous release left in storage for a live code. */
function legacyCode(storage: MemoryStorage, deviceCode: string, userCode: string) {
  storage.values.set(`d:${deviceCode}`, {
    ...record({ device_code: deviceCode, user_code: userCode }),
    token_issued: false,
  });
  storage.values.set(`u:${userCode}`, deviceCode);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('new codes are mapped under the canonical user code', () => {
  it.each([
    ['8 characters, shown ABCD-EFGH', 'ABCD-EFGH', 'u:ABCDEFGH'],
    ['11 digits, shown 1234-5678-901', '1234-5678-901', 'u:12345678901'],
    ['4 characters, no hyphen', 'ABCD', 'u:ABCD'],
    ['16 characters', 'ABCD-EFGH-JKMN-PQRS', 'u:ABCDEFGHJKMNPQRS'],
  ])('%s', async (_name, shown, key) => {
    const { store, storage } = await open();
    expect((await call(store, '/store', record({ user_code: shown }))).status).toBe(200);

    expect(storage.values.get(key)).toBe('device-1');
    // only the canonical key is written, never a hyphenated one
    expect([...storage.values.keys()].filter((k) => k.startsWith('u:'))).toEqual([key]);
    // the code keeps the display form the device was shown
    expect(storage.values.get('d:device-1')).toMatchObject({ user_code: shown });
  });

  it.each(['ABCD-EFGH', 'abcd-efgh', 'ABCDEFGH', 'abcd efgh', ' ABCD–EFGH ', 'a-b-c-d-e-f-g-h'])(
    'is found by "%s"',
    async (typed) => {
      const { store } = await open();
      await call(store, '/store', record());

      expect(await byUserCode(store, typed)).toMatchObject({ device_code: 'device-1' });
    }
  );

  it('is found by a code that is not the one stored, as null', async () => {
    const { store } = await open();
    await call(store, '/store', record());

    expect(await byUserCode(store, 'ABCD-EFGJ')).toBeNull();
    expect(await byUserCode(store, 'ABCD')).toBeNull();
  });

  it('answers a request without a user code with null, not an error', async () => {
    const { store } = await open();
    expect(await byUserCode(store, undefined as unknown as string)).toBeNull();
  });

  it('is found after a restart of the object (cold start from storage)', async () => {
    const first = await open();
    await call(first.store, '/store', record({ user_code: '1234-5678-901' }));

    const { store } = await open(first.storage);

    expect(await byUserCode(store, '12345678901')).toMatchObject({ device_code: 'device-1' });
    expect(await byUserCode(store, '1234-5678-901')).toMatchObject({ device_code: 'device-1' });
  });

  it('is approved and denied by any form of the code', async () => {
    const { store } = await open();
    await call(store, '/store', record());
    await call(store, '/store', record({ device_code: 'device-2', user_code: 'WXYZ-2345' }));

    expect(
      (await call(store, '/approve', { user_code: 'abcdefgh', user_id: 'u', sub: 's' })).status
    ).toBe(200);
    expect((await call(store, '/deny', { user_code: 'wxyz 2345' })).status).toBe(200);

    expect(await byUserCode(store, 'ABCD-EFGH')).toMatchObject({ status: 'approved' });
    expect(await byUserCode(store, 'WXYZ2345')).toMatchObject({ status: 'denied' });
  });
});

describe('a code issued by the previous release (legacy u:XXXX-XXXX mapping)', () => {
  it('is found by every form of the code, warm from the first read and after a restart', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    const { store } = await open(storage);

    for (const typed of ['ABCD-EFGH', 'abcdefgh', 'abcd efgh', 'ABCD‐EFGH']) {
      expect(await byUserCode(store, typed), typed).toMatchObject({ device_code: 'legacy-1' });
    }
  });

  it('is found through storage when the mapping is not in the cache yet', async () => {
    const { store, storage } = await open();
    // written after the object started, as another isolate or an earlier version would have
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');

    expect(await byUserCode(store, 'ABCDEFGH')).toMatchObject({ device_code: 'legacy-1' });
  });

  it('can be approved and denied by the canonical or the hyphenated code', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    legacyCode(storage, 'legacy-2', 'WXYZ-2345');
    const { store } = await open(storage);

    expect(
      (await call(store, '/approve', { user_code: 'ABCDEFGH', user_id: 'u', sub: 's' })).status
    ).toBe(200);
    expect((await call(store, '/deny', { user_code: 'WXYZ-2345' })).status).toBe(200);

    expect(storage.values.get('d:legacy-1')).toMatchObject({ status: 'approved' });
    expect(storage.values.get('d:legacy-2')).toMatchObject({ status: 'denied' });
  });

  it('keeps a new code from taking its user code, in either shape', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    const { store } = await open(storage);

    for (const shown of ['ABCD-EFGH', 'ABCDEFGH']) {
      const response = await call(
        store,
        '/store',
        record({ device_code: 'new-1', user_code: shown })
      );
      expect(response.status, shown).toBe(409);
      expect(await response.json()).toEqual({ error: 'user_code_conflict' });
    }
    expect(storage.values.has('d:new-1')).toBe(false);
    expect(await byUserCode(store, 'ABCD-EFGH')).toMatchObject({ device_code: 'legacy-1' });
  });

  it('keeps a legacy code from being shadowed even when the cache has not seen it', async () => {
    const { store, storage } = await open();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');

    const response = await call(store, '/store', record({ device_code: 'new-1' }));

    expect(response.status).toBe(409);
  });

  it('rejects the same user code typed in another form', async () => {
    const { store } = await open();
    await call(store, '/store', record({ device_code: 'new-1' }));

    expect((await call(store, '/store', record({ device_code: 'new-2' }))).status).toBe(409);
    expect(
      (await call(store, '/store', record({ device_code: 'new-2', user_code: 'abcdefgh' }))).status
    ).toBe(409);
  });

  it('loses its mapping, in the legacy key, when it is deleted', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    const { store } = await open(storage);

    await call(store, '/delete', { device_code: 'legacy-1' });

    expect(storage.values.has('d:legacy-1')).toBe(false);
    expect(storage.values.has('u:ABCD-EFGH')).toBe(false);
    expect(await byUserCode(store, 'ABCD-EFGH')).toBeNull();
  });

  it('loses its mapping when it expires, found by the device code or by the user code', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    legacyCode(storage, 'legacy-2', 'WXYZ-2345');
    const { store } = await open(storage);
    vi.setSystemTime(Date.now() + 600_001);

    expect(await byUserCode(store, 'ABCD-EFGH')).toBeNull();
    expect(storage.values.has('u:ABCD-EFGH')).toBe(false);
    const byDevice = await call(store, '/get-by-device-code', { device_code: 'legacy-2' });
    expect(await byDevice.json()).toBeNull();
    expect(storage.values.has('u:WXYZ-2345')).toBe(false);
  });

  it('loses its mapping in the cleanup alarm', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    const { store } = await open(storage);
    vi.setSystemTime(Date.now() + 600_001);

    await (store as unknown as DeviceCodeStore).alarm();

    expect(storage.values.has('d:legacy-1')).toBe(false);
    expect(storage.values.has('u:ABCD-EFGH')).toBe(false);
  });

  it('hands its user code to a new code once it has expired, without the new mapping being removed', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    const { store } = await open(storage);
    vi.setSystemTime(Date.now() + 600_001);

    expect((await call(store, '/store', record({ device_code: 'new-1' }))).status).toBe(200);

    expect(storage.values.get('u:ABCDEFGH')).toBe('new-1');
    expect(storage.values.has('u:ABCD-EFGH')).toBe(false);
    expect(await byUserCode(store, 'ABCD-EFGH')).toMatchObject({ device_code: 'new-1' });
  });

  it('does not delete the mapping of a newer code when an older one with the same user code goes', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    const { store } = await open(storage);
    // the legacy code expired (but was never cleaned up), the same user code was issued again
    vi.setSystemTime(Date.now() + 600_001);
    expect((await call(store, '/store', record({ device_code: 'new-1' }))).status).toBe(200);
    // an expired record of the old code that is still in storage is removed by the alarm
    storage.values.set('d:legacy-1', {
      ...record({ device_code: 'legacy-1' }),
      expires_at: Date.now() - 1,
    });
    await call(store, '/delete', { device_code: 'legacy-1' });

    expect(storage.values.get('u:ABCDEFGH')).toBe('new-1');
    expect(await byUserCode(store, 'ABCDEFGH')).toMatchObject({ device_code: 'new-1' });
  });

  it('prefers the canonical mapping when both shapes are in storage', async () => {
    const storage = new MemoryStorage();
    legacyCode(storage, 'legacy-1', 'ABCD-EFGH');
    storage.values.set('d:new-1', { ...record({ device_code: 'new-1' }), token_issued: false });
    storage.values.set('u:ABCDEFGH', 'new-1');
    const { store } = await open(storage);

    expect(await byUserCode(store, 'ABCD-EFGH')).toMatchObject({ device_code: 'new-1' });
  });
});

describe('legacy keys only exist for 8 characters', () => {
  it('does not turn another length into a hyphenated key', async () => {
    const { store, storage } = await open();
    storage.values.set('u:ABCD-EFGH-JKM', 'ghost');
    storage.values.set('d:ghost', { ...record({ device_code: 'ghost' }), token_issued: false });

    expect(await byUserCode(store, 'ABCDEFGHJKM')).toBeNull();
  });
});

describe('both key shapes held by different codes', () => {
  /** A canonical mapping of an expired code next to a legacy mapping of a live one, or reverse. */
  function coexisting(storage: MemoryStorage, expiredUnder: 'canonical' | 'legacy') {
    const expired = {
      ...record({ device_code: 'expired-A' }),
      expires_at: Date.now() - 1,
      token_issued: false,
    };
    const live = { ...record({ device_code: 'live-B' }), token_issued: false };
    storage.values.set('d:expired-A', expired);
    storage.values.set('d:live-B', live);
    storage.values.set(expiredUnder === 'canonical' ? 'u:ABCDEFGH' : 'u:ABCD-EFGH', 'expired-A');
    storage.values.set(expiredUnder === 'canonical' ? 'u:ABCD-EFGH' : 'u:ABCDEFGH', 'live-B');
  }

  it.each(['canonical', 'legacy'] as const)(
    'rejects a new code while the live holder is under the other key (expired holder under the %s key)',
    async (expiredUnder) => {
      const storage = new MemoryStorage();
      coexisting(storage, expiredUnder);
      const { store } = await open(storage);

      for (const shown of ['ABCD-EFGH', 'ABCDEFGH']) {
        const response = await call(
          store,
          '/store',
          record({ device_code: 'new-C', user_code: shown })
        );
        expect(response.status, shown).toBe(409);
      }
      expect(storage.values.has('d:new-C')).toBe(false);
      expect(await byUserCode(store, 'ABCD-EFGH')).toMatchObject({ device_code: 'live-B' });
    }
  );

  it.each(['canonical', 'legacy'] as const)(
    'resolves to the live holder, from a cold start and from a warm cache (expired holder under the %s key)',
    async (expiredUnder) => {
      const storage = new MemoryStorage();
      coexisting(storage, expiredUnder);
      const cold = await open(storage);
      expect(await byUserCode(cold.store, 'abcdefgh')).toMatchObject({ device_code: 'live-B' });
      expect(await byUserCode(cold.store, 'ABCD-EFGH')).toMatchObject({ device_code: 'live-B' });

      const warm = await open(storage);
      await call(warm.store, '/get-by-device-code', { device_code: 'live-B' });
      expect(await byUserCode(warm.store, 'ABCDEFGH')).toMatchObject({ device_code: 'live-B' });
    }
  );

  it('approves the live holder, not the expired one', async () => {
    const storage = new MemoryStorage();
    coexisting(storage, 'canonical');
    const { store } = await open(storage);

    expect(
      (await call(store, '/approve', { user_code: 'ABCD-EFGH', user_id: 'u', sub: 's' })).status
    ).toBe(200);

    expect(storage.values.get('d:live-B')).toMatchObject({ status: 'approved' });
  });

  it('takes the code once both holders are gone', async () => {
    const storage = new MemoryStorage();
    coexisting(storage, 'canonical');
    const { store } = await open(storage);
    await call(store, '/delete', { device_code: 'live-B' });

    expect(await byUserCode(store, 'ABCD-EFGH')).toBeNull();
    expect((await call(store, '/store', record({ device_code: 'new-C' }))).status).toBe(200);
    expect(await byUserCode(store, 'ABCDEFGH')).toMatchObject({ device_code: 'new-C' });
  });
});

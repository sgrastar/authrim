import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { CIBARequestMetadata, DeviceCodeMetadata } from '../../types/oidc';
import { TENANT_D1_STORAGE_PROFILE_ID } from '../../types/runtime-profile';
import { CIBARequestStore } from '../CIBARequestStore';
import { DeviceCodeStore } from '../DeviceCodeStore';

const audit = vi.hoisted(() => ({ create: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../utils/audit-log', () => ({ createAuditLog: audit.create }));

const LEGACY_AUTH_CORE_PERSISTENCE_CONTEXT_KEY = 'm:auth-core-persistence-context';
const disabledColdPersistenceEnv = {
  DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
} as never;

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly alarms: number[] = [];

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()].filter(([key]) => key.startsWith(options?.prefix ?? ''))
    ) as Map<string, T>;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(keys: string | string[]): Promise<boolean> {
    const list = Array.isArray(keys) ? keys : [keys];
    return list.map((key) => this.values.delete(key)).some(Boolean);
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarms.push(timestamp);
  }
}

function state(storage = new MemoryStorage()): {
  state: DurableObjectState;
  storage: MemoryStorage;
  initialized: Promise<void>;
} {
  let initialized = Promise.resolve();
  const durableState = {
    storage,
    blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) => {
      initialized = callback();
      return initialized;
    }),
  } as unknown as DurableObjectState;
  return {
    state: durableState,
    storage,
    get initialized() {
      return initialized;
    },
  };
}

function request(path: string, body?: unknown, tenant = 'tenant-a'): Request {
  return new Request(`https://store.example${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(tenant ? { 'X-Authrim-Tenant-Id': tenant } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

function device(overrides: Partial<DeviceCodeMetadata> = {}): DeviceCodeMetadata {
  const now = Date.now();
  return {
    tenant_id: 'tenant-a',
    device_code: 'device-1',
    user_code: 'ABCD-EFGH',
    client_id: 'client-1',
    scope: 'openid profile',
    status: 'pending',
    created_at: now,
    expires_at: now + 300_000,
    poll_count: 0,
    ...overrides,
  };
}

function ciba(overrides: Partial<CIBARequestMetadata> = {}): CIBARequestMetadata {
  const now = Date.now();
  return {
    tenant_id: 'tenant-a',
    auth_req_id: 'request-1',
    user_code: 'CIBA-123',
    client_id: 'client-1',
    scope: 'openid profile',
    login_hint: 'user@example.com',
    status: 'pending',
    delivery_mode: 'poll',
    created_at: now,
    expires_at: now + 300_000,
    interval: 5,
    poll_count: 0,
    ...overrides,
  };
}

describe('DeviceCodeStore state transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    audit.create.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('stores, resolves by both codes, approves, polls, and issues exactly once', async () => {
    const harness = state();
    const store = new DeviceCodeStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;

    expect(await json(await store.fetch(request('/store', device())))).toEqual({ success: true });
    expect(harness.storage.values.get('u:ABCD-EFGH')).toBe('device-1');
    expect(
      await json(await store.fetch(request('/get-by-device-code', { device_code: 'device-1' })))
    ).toMatchObject({
      device_code: 'device-1',
      status: 'pending',
      token_issued: false,
    });
    expect(
      await json(await store.fetch(request('/get-by-user-code', { user_code: 'ABCD-EFGH' })))
    ).toMatchObject({
      device_code: 'device-1',
    });

    expect(
      await json(
        await store.fetch(
          request('/approve', { user_code: 'ABCD-EFGH', user_id: 'user-1', sub: 'subject-1' })
        )
      )
    ).toEqual({ success: true });
    await store.fetch(request('/update-poll', { device_code: 'device-1' }));
    await store.fetch(request('/mark-token-issued', { device_code: 'device-1' }));
    const issued = (await json(
      await store.fetch(request('/get-by-device-code', { device_code: 'device-1' }))
    )) as DeviceCodeMetadata;
    expect(issued).toMatchObject({
      status: 'approved',
      user_id: 'user-1',
      sub: 'subject-1',
      poll_count: 1,
      token_issued: true,
    });
    expect(audit.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-a', action: 'device_flow.device_code_consumed' })
    );

    const replay = await store.fetch(request('/mark-token-issued', { device_code: 'device-1' }));
    expect(replay.status).toBe(500);
    expect(await json(replay)).toEqual({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  });

  it('enforces pending-only approval/denial and hides internal failures', async () => {
    const harness = state();
    const store = new DeviceCodeStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;
    await store.fetch(request('/store', device()));
    await store.fetch(request('/deny', { user_code: 'ABCD-EFGH' }));
    expect(
      await json(await store.fetch(request('/get-by-user-code', { user_code: 'ABCD-EFGH' })))
    ).toMatchObject({ status: 'denied' });
    expect((await store.fetch(request('/deny', { user_code: 'ABCD-EFGH' }))).status).toBe(500);
    expect(
      (await store.fetch(request('/approve', { user_code: 'missing', user_id: 'u', sub: 's' })))
        .status
    ).toBe(500);
    expect(
      (await store.fetch(request('/mark-token-issued', { device_code: 'missing' }))).status
    ).toBe(500);
  });

  it('removes expired codes and mappings and reports status without exposing them', async () => {
    const storage = new MemoryStorage();
    storage.values.set('d:expired', device({ device_code: 'expired', expires_at: Date.now() - 1 }));
    storage.values.set('u:ABCD-EFGH', 'expired');
    const harness = state(storage);
    const store = new DeviceCodeStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;
    expect(
      await json(await store.fetch(request('/get-by-device-code', { device_code: 'expired' })))
    ).toBeNull();
    expect(storage.values.has('d:expired')).toBe(false);
    const status = (await json(await store.fetch(request('/status')))) as Record<string, unknown>;
    expect(status).toMatchObject({ status: 'ok', version: 'v2', userMappings: 0 });
    expect((await store.fetch(request('/unknown'))).status).toBe(404);
  });

  it('deletes codes and makes cleanup alarms idempotent', async () => {
    const harness = state();
    const store = new DeviceCodeStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;
    await store.fetch(request('/store', device()));
    await store.fetch(request('/delete', { device_code: 'device-1' }));
    expect(harness.storage.values.has('d:device-1')).toBe(false);
    expect(harness.storage.values.has('u:ABCD-EFGH')).toBe(false);

    await store.alarm();
    expect(harness.storage.values.get('m:lastCleanup')).toBe(Date.now());
    const alarmCount = harness.storage.alarms.length;
    await store.alarm();
    expect(harness.storage.alarms).toHaveLength(alarmCount + 1);
  });

  it('ignores a stale persisted runtime profile and applies the current deployment profile', async () => {
    const storage = new MemoryStorage();
    storage.values.set(LEGACY_AUTH_CORE_PERSISTENCE_CONTEXT_KEY, {
      storageProfileId: 'builtin:storage:shared-d1',
      transientAuth: { deviceCibaColdPersistence: 'enabled' },
    });
    const harness = state(storage);
    const store = new DeviceCodeStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;

    expect(await json(await store.fetch(request('/store', device())))).toEqual({ success: true });
    expect(storage.values.get(LEGACY_AUTH_CORE_PERSISTENCE_CONTEXT_KEY)).toMatchObject({
      transientAuth: { deviceCibaColdPersistence: 'enabled' },
    });
  });
});

describe('CIBARequestStore state transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    audit.create.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('stores, resolves, approves with nonce, polls, and issues exactly once', async () => {
    const harness = state();
    const store = new CIBARequestStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;
    await store.fetch(request('/store', ciba()));
    expect(
      await json(await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'request-1' })))
    ).toMatchObject({
      status: 'pending',
      token_issued: false,
    });
    expect(
      await json(await store.fetch(request('/get-by-user-code', { user_code: 'CIBA-123' })))
    ).toMatchObject({
      auth_req_id: 'request-1',
    });
    expect(
      await json(
        await store.fetch(
          request('/get-by-login-hint', { login_hint: 'user@example.com', client_id: 'client-1' })
        )
      )
    ).toMatchObject({ auth_req_id: 'request-1' });

    await store.fetch(
      request('/approve', {
        auth_req_id: 'request-1',
        user_id: 'user-1',
        sub: 'subject-1',
        nonce: 'nonce-1',
      })
    );
    await store.fetch(request('/update-poll', { auth_req_id: 'request-1' }));
    await store.fetch(request('/mark-token-issued', { auth_req_id: 'request-1' }));
    expect(
      await json(await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'request-1' })))
    ).toMatchObject({
      status: 'approved',
      nonce: 'nonce-1',
      poll_count: 1,
      token_issued: true,
    });
    expect(
      (await store.fetch(request('/mark-token-issued', { auth_req_id: 'request-1' }))).status
    ).toBe(500);
  });

  it('denies pending requests and rejects missing or completed requests', async () => {
    const harness = state();
    const store = new CIBARequestStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;
    await store.fetch(request('/store', ciba()));
    await store.fetch(request('/deny', { auth_req_id: 'request-1' }));
    expect(
      await json(await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'request-1' })))
    ).toMatchObject({
      status: 'denied',
    });
    expect((await store.fetch(request('/deny', { auth_req_id: 'request-1' }))).status).toBe(500);
    expect(
      (await store.fetch(request('/approve', { auth_req_id: 'missing', user_id: 'u', sub: 's' })))
        .status
    ).toBe(500);
  });

  it('expires, deletes, reports status, and runs idempotent cleanup', async () => {
    const storage = new MemoryStorage();
    storage.values.set('r:expired', ciba({ auth_req_id: 'expired', expires_at: Date.now() - 1 }));
    storage.values.set('u:CIBA-123', 'expired');
    const harness = state(storage);
    const store = new CIBARequestStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;
    expect(
      await json(await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'expired' })))
    ).toBeNull();
    expect(storage.values.has('r:expired')).toBe(false);
    expect(
      await json(
        await store.fetch(
          request('/get-by-login-hint', { login_hint: 'none', client_id: 'client-1' })
        )
      )
    ).toBeNull();
    expect(await json(await store.fetch(request('/status')))).toMatchObject({
      status: 'ok',
      version: 'v2',
      userMappings: 0,
    });
    await store.alarm();
    await store.alarm();
    expect(storage.alarms.length).toBeGreaterThanOrEqual(2);
    expect((await store.fetch(request('/unknown'))).status).toBe(404);
  });

  it('ignores a stale persisted runtime profile and applies the current deployment profile', async () => {
    const storage = new MemoryStorage();
    storage.values.set(LEGACY_AUTH_CORE_PERSISTENCE_CONTEXT_KEY, {
      storageProfileId: 'builtin:storage:shared-d1',
      transientAuth: { deviceCibaColdPersistence: 'enabled' },
    });
    const harness = state(storage);
    const store = new CIBARequestStore(harness.state, disabledColdPersistenceEnv);
    await harness.initialized;

    expect(await json(await store.fetch(request('/store', ciba())))).toEqual({ success: true });
    expect(storage.values.get(LEGACY_AUTH_CORE_PERSISTENCE_CONTEXT_KEY)).toMatchObject({
      transientAuth: { deviceCibaColdPersistence: 'enabled' },
    });
  });
});

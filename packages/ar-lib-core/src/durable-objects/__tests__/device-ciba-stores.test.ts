import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { CIBARequestMetadata, DeviceCodeMetadata } from '../../types/oidc';
import { CIBARequestStore } from '../CIBARequestStore';
import { DeviceCodeStore } from '../DeviceCodeStore';

const audit = vi.hoisted(() => ({ create: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../utils/audit-log', () => ({ createAuditLog: audit.create }));

const runtimeEnv = {} as never;

/**
 * In-memory Durable Storage with the behaviour the stores rely on: keys listed in ascending
 * order, `limit` and `startAfter`, and at most 128 keys per multi-key get, put, or delete.
 */
class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly alarms: number[] = [];
  /** How many of the next writes (put) fail, as when Durable Storage is unavailable. */
  failPuts = 0;
  /**
   * While set, a write is applied at once but its promise waits for this one. Durable Storage
   * applies writes in the order they are issued, whatever the caller does with the promise.
   */
  holdPuts: Promise<void> | null = null;
  putCount = 0;

  private static assertBatch(count: number): void {
    if (count > 128) throw new RangeError(`Durable Storage batch of ${count} keys exceeds 128`);
  }

  async list<T>(options?: {
    prefix?: string;
    limit?: number;
    startAfter?: string;
  }): Promise<Map<string, T>> {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options?.prefix ?? ''))
      .filter((key) => options?.startAfter === undefined || key > options.startAfter)
      .sort();
    const limited = options?.limit === undefined ? keys : keys.slice(0, options.limit);
    return new Map(limited.map((key) => [key, structuredClone(this.values.get(key))])) as Map<
      string,
      T
    >;
  }

  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(key)) {
      MemoryStorage.assertBatch(key.length);
      return new Map(
        key
          .filter((entry) => this.values.has(entry))
          .map((entry) => [entry, structuredClone(this.values.get(entry))])
      ) as Map<string, T>;
    }
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (this.failPuts > 0) {
      this.failPuts -= 1;
      throw new Error('Durable Storage unavailable');
    }
    this.putCount += 1;
    if (typeof key === 'string') {
      this.values.set(key, structuredClone(value));
    } else {
      MemoryStorage.assertBatch(Object.keys(key).length);
      for (const [entryKey, entryValue] of Object.entries(key)) {
        this.values.set(entryKey, structuredClone(entryValue));
      }
    }
    if (this.holdPuts) await this.holdPuts;
  }

  async delete(keys: string | string[]): Promise<boolean | number> {
    if (!Array.isArray(keys)) return this.values.delete(keys);
    MemoryStorage.assertBatch(keys.length);
    return keys.filter((key) => this.values.delete(key)).length;
  }

  /** Durable Storage's explicit transaction: a throw in the callback undoes every write in it. */
  async transaction<T>(
    callback: (txn: Pick<MemoryStorage, 'get' | 'put' | 'delete' | 'list'>) => Promise<T>
  ): Promise<T> {
    const before = new Map(this.values);
    try {
      return await callback({
        get: this.get.bind(this),
        put: this.put.bind(this),
        delete: this.delete.bind(this),
        list: this.list.bind(this),
      });
    } catch (error) {
      this.values.clear();
      for (const [key, value] of before) this.values.set(key, value);
      throw error;
    }
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarms.push(timestamp);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarms.at(-1) ?? null;
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
    const store = new DeviceCodeStore(harness.state, runtimeEnv);
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
    expect(audit.create).not.toHaveBeenCalled();

    const replay = await store.fetch(request('/mark-token-issued', { device_code: 'device-1' }));
    expect(replay.status).toBe(500);
    expect(await json(replay)).toEqual({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  });

  it('enforces pending-only approval/denial and hides internal failures', async () => {
    const harness = state();
    const store = new DeviceCodeStore(harness.state, runtimeEnv);
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
    const store = new DeviceCodeStore(harness.state, runtimeEnv);
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
    const store = new DeviceCodeStore(harness.state, runtimeEnv);
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
    const store = new CIBARequestStore(harness.state, runtimeEnv);
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
    const store = new CIBARequestStore(harness.state, runtimeEnv);
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
    const store = new CIBARequestStore(harness.state, runtimeEnv);
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
});

describe('CIBARequestStore pending list for one user', () => {
  const ids = (body: unknown) =>
    (body as { requests: CIBARequestMetadata[] }).requests.map((entry) => entry.auth_req_id);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const hintEntry = (id: string, hint = 'user@example.com') => `ph:${digest(hint)}:${id}`;
  const indexKeys = (storage: MemoryStorage) =>
    [...storage.values.keys()].filter((key) => key.startsWith('ph:') || key.startsWith('ps:'));

  async function storeWith(storage = new MemoryStorage()) {
    const harness = state(storage);
    const store = new CIBARequestStore(harness.state, runtimeEnv);
    await harness.initialized;
    return { store, storage };
  }

  async function list(store: CIBARequestStore, body: Record<string, unknown>) {
    return store.fetch(request('/list-pending-for-user', body));
  }

  async function seeded() {
    const { store: writer, storage } = await storeWith();
    for (const entry of [
      ciba({ auth_req_id: 'by-email', login_hint: 'User@Example.com', client_id: 'client-1' }),
      ciba({ auth_req_id: 'by-sub-hint', login_hint: 'sub:subject-1', client_id: 'client-2' }),
      ciba({
        auth_req_id: 'by-resolved-subject',
        login_hint: undefined,
        resolved_subject_id: 'subject-1',
      }),
      ciba({ auth_req_id: 'someone-else', login_hint: 'victim@example.com' }),
      ciba({
        auth_req_id: 'resolved-to-someone-else',
        login_hint: 'user@example.com',
        resolved_subject_id: 'subject-2',
      }),
      ciba({ auth_req_id: 'no-hint', login_hint: undefined }),
      ciba({ auth_req_id: 'expired', expires_at: Date.now() + 1 }),
    ]) {
      await writer.fetch(request('/store', { ...entry, user_code: undefined }));
    }
    await writer.fetch(
      request('/approve', { auth_req_id: 'someone-else', user_id: 'u', sub: 'u' })
    );
    vi.advanceTimersByTime(10);
    return storage;
  }

  /** Requests written straight to storage, as an older version stored them (no index). */
  async function legacyStorage(entries: CIBARequestMetadata[]) {
    const storage = new MemoryStorage();
    for (const entry of entries) storage.values.set(`r:${entry.auth_req_id}`, entry);
    return storage;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lists every pending request addressed to the user, across clients, from storage', async () => {
    const { store } = await storeWith(await seeded());

    const response = await list(store, {
      subject_ids: ['subject-1'],
      login_hints: ['user@example.com', 'sub:subject-1'],
    });

    expect(ids(await json(response)).sort()).toEqual([
      'by-email',
      'by-resolved-subject',
      'by-sub-hint',
    ]);
  });

  it('lists nothing without identifiers, and never a request that names no user', async () => {
    const { store } = await storeWith(await seeded());

    expect(ids(await json(await list(store, {})))).toEqual([]);
    expect(
      ids(await json(await list(store, { subject_ids: [''], login_hints: [42, ''] })))
    ).toEqual([]);
  });

  it("reads only the user's index entries and requests, not the tenant's", async () => {
    const storage = await seeded();
    const { store } = await storeWith(storage);
    const listSpy = vi.spyOn(storage, 'list');
    const getSpy = vi.spyOn(storage, 'get');

    await list(store, { subject_ids: ['subject-1'], login_hints: [] });

    expect(listSpy.mock.calls.map(([options]) => options?.prefix)).toEqual([
      `ps:${digest('subject-1')}:`,
    ]);
    expect(getSpy.mock.calls.map(([keys]) => keys)).toEqual([['r:by-resolved-subject']]);
  });

  it('drops a request from the index in the same write that decides or deletes it', async () => {
    const { store, storage } = await storeWith();
    for (const id of ['approved', 'denied', 'deleted', 'waiting']) {
      await store.fetch(request('/store', ciba({ auth_req_id: id, user_code: undefined })));
    }
    const put = vi.spyOn(storage, 'put');
    const remove = vi.spyOn(storage, 'delete');

    await store.fetch(request('/approve', { auth_req_id: 'approved', user_id: 'u', sub: 'u' }));
    await store.fetch(request('/deny', { auth_req_id: 'denied' }));
    await store.fetch(request('/delete', { auth_req_id: 'deleted' }));

    expect(indexKeys(storage)).toEqual([hintEntry('waiting')]);
    // Each decision: the request and its index entry, nothing else.
    expect(put.mock.calls.map(([key]) => key)).toEqual(['r:approved', 'r:denied']);
    expect(remove.mock.calls.map(([key]) => key)).toEqual([
      hintEntry('approved'),
      hintEntry('denied'),
      ['r:deleted', hintEntry('deleted')],
    ]);
  });

  it('finds pending requests behind any number of leftover entries for the same address', async () => {
    // Entries a failed write may have left behind: they must never hide a pending request.
    const storage = new MemoryStorage();
    for (let index = 0; index < 120; index++) {
      const id = `a-old-${String(index).padStart(3, '0')}`;
      storage.values.set(`r:${id}`, ciba({ auth_req_id: id, status: 'approved' }));
      storage.values.set(hintEntry(id), id);
    }
    storage.values.set('r:z-pending', ciba({ auth_req_id: 'z-pending', user_code: undefined }));
    storage.values.set(hintEntry('z-pending'), 'z-pending');
    const { store } = await storeWith(storage);

    const response = await list(store, { login_hints: ['user@example.com'] });

    expect(ids(await json(response))).toEqual(['z-pending']);
    // The leftovers are gone, deleted in batches of at most 128 keys.
    expect(indexKeys(storage)).toEqual([hintEntry('z-pending')]);
  });

  it('returns at most 50 requests for one user', async () => {
    const { store } = await storeWith();
    for (let index = 0; index < 60; index++) {
      await store.fetch(
        request('/store', ciba({ auth_req_id: `request-${index}`, user_code: undefined }))
      );
    }

    expect(ids(await json(await list(store, { login_hints: ['user@example.com'] })))).toHaveLength(
      50
    );
  });

  it('indexes more than 128 requests stored before the index existed, in batches', async () => {
    const storage = await legacyStorage([
      ...Array.from({ length: 200 }, (_, index) =>
        ciba({ auth_req_id: `legacy-${index}`, user_code: undefined })
      ),
      ciba({ auth_req_id: 'legacy-done', status: 'approved' }),
    ]);
    const { store } = await storeWith(storage);

    expect(indexKeys(storage)).toHaveLength(200);
    expect(ids(await json(await list(store, { login_hints: ['user@example.com'] })))).toHaveLength(
      50
    );

    // A later start finds every entry and writes nothing.
    const put = vi.spyOn(storage, 'put');
    await storeWith(storage);
    expect(put).not.toHaveBeenCalled();
  });

  it('answers 503, not an incomplete list, until the index can be brought up to date', async () => {
    const storage = await legacyStorage([ciba({ auth_req_id: 'legacy', user_code: undefined })]);
    const put = vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    const { store } = await storeWith(storage);
    expect(indexKeys(storage)).toEqual([]);

    // The next list retries the backfill (storage works again) and lists the request.
    put.mockRejectedValueOnce(new Error('storage unavailable'));
    const failed = await list(store, { login_hints: ['user@example.com'] });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: 'temporarily_unavailable' });

    const recovered = await list(store, { login_hints: ['user@example.com'] });
    expect(recovered.status).toBe(200);
    expect(ids(await json(recovered))).toEqual(['legacy']);
  });

  it('skips a request whose address is not well-formed Unicode, and indexes the others', async () => {
    const storage = await legacyStorage([
      ciba({ auth_req_id: 'broken-pending', login_hint: 'user\ud800@example.com' }),
      ciba({ auth_req_id: 'broken-decided', login_hint: '\ud800', status: 'approved' }),
      ciba({ auth_req_id: 'broken-subject', login_hint: undefined, resolved_subject_id: '\udfff' }),
      ciba({ auth_req_id: 'fine', user_code: undefined }),
    ]);
    const { store } = await storeWith(storage);

    expect(indexKeys(storage)).toEqual([hintEntry('fine')]);
    expect(ids(await json(await list(store, { login_hints: ['user@example.com'] })))).toEqual([
      'fine',
    ]);
    // A lookup by such an address finds nothing rather than failing.
    const odd = await list(store, { subject_ids: ['\udfff'], login_hints: ['\ud800'] });
    expect(odd.status).toBe(200);
    expect(ids(await json(odd))).toEqual([]);
  });

  it('keeps index keys short however long the address', async () => {
    const longHint = 'あ'.repeat(250_000);
    const storage = await legacyStorage([
      ciba({ auth_req_id: 'long', login_hint: longHint, user_code: undefined }),
    ]);
    const { store } = await storeWith(storage);

    const keys = indexKeys(storage);
    expect(keys).toEqual([hintEntry('long', longHint)]);
    expect(keys[0].length).toBeLessThan(100);
    expect(ids(await json(await list(store, { login_hints: [longHint] })))).toEqual(['long']);
  });

  it('never lists a request addressed to someone else, even under the same digest', async () => {
    // Stands in for a digest collision: an entry under this user's address points at a request
    // addressed to someone else. The request's own address decides.
    const storage = new MemoryStorage();
    storage.values.set(
      'r:not-mine',
      ciba({ auth_req_id: 'not-mine', login_hint: 'victim@example.com', user_code: undefined })
    );
    storage.values.set(hintEntry('not-mine'), 'not-mine');
    const { store } = await storeWith(storage);

    expect(ids(await json(await list(store, { login_hints: ['user@example.com'] })))).toEqual([]);
  });

  it('reloads the requests when the startup load failed, and answers 503 until it works', async () => {
    const storage = await legacyStorage([ciba({ auth_req_id: 'legacy', user_code: undefined })]);
    const listSpy = vi.spyOn(storage, 'list').mockRejectedValueOnce(new Error('storage down'));
    const { store } = await storeWith(storage);

    // The failed load must not count as "nothing to index".
    listSpy.mockRejectedValueOnce(new Error('storage down'));
    expect((await list(store, { login_hints: ['user@example.com'] })).status).toBe(503);

    const recovered = await list(store, { login_hints: ['user@example.com'] });
    expect(recovered.status).toBe(200);
    expect(ids(await json(recovered))).toEqual(['legacy']);
  });

  it('answers 503 rather than an empty list when its read budget ends among expired entries', async () => {
    const storage = new MemoryStorage();
    const past = Date.now() - 1;
    for (let index = 0; index < 200; index++) {
      const id = `a-expired-${String(index).padStart(3, '0')}`;
      storage.values.set(`r:${id}`, ciba({ auth_req_id: id, expires_at: past }));
      storage.values.set(hintEntry(id), id);
    }
    storage.values.set('r:z-pending', ciba({ auth_req_id: 'z-pending', user_code: undefined }));
    storage.values.set(hintEntry('z-pending'), 'z-pending');
    const { store } = await storeWith(storage);

    const first = await list(store, { login_hints: ['user@example.com'] });
    expect(first.status).toBe(503);
    // The 200 expired entries it read are gone, so the retry gets to the pending request.
    expect(indexKeys(storage)).toEqual([hintEntry('z-pending')]);

    const second = await list(store, { login_hints: ['user@example.com'] });
    expect(second.status).toBe(200);
    expect(ids(await json(second))).toEqual(['z-pending']);
  });

  it('answers in one go when the expired entries fit in the read budget', async () => {
    const storage = new MemoryStorage();
    const past = Date.now() - 1;
    for (let index = 0; index < 199; index++) {
      const id = `a-expired-${String(index).padStart(3, '0')}`;
      storage.values.set(`r:${id}`, ciba({ auth_req_id: id, expires_at: past }));
      storage.values.set(hintEntry(id), id);
    }
    storage.values.set('r:z-pending', ciba({ auth_req_id: 'z-pending', user_code: undefined }));
    storage.values.set(hintEntry('z-pending'), 'z-pending');
    const { store } = await storeWith(storage);

    const response = await list(store, { login_hints: ['user@example.com'] });
    expect(response.status).toBe(200);
    expect(ids(await json(response))).toEqual(['z-pending']);
  });

  it('keeps the cleanup alarm at the earliest expiry', async () => {
    const { store, storage } = await storeWith();

    await store.fetch(
      request('/store', ciba({ auth_req_id: 'soon', expires_at: Date.now() + 60_000 }))
    );
    await store.fetch(
      request('/store', ciba({ auth_req_id: 'later', expires_at: Date.now() + 600_000 }))
    );

    expect(await storage.getAlarm()).toBe(Date.now() + 60_000);
  });

  it('stores a new request with an address that cannot be indexed, without listing it', async () => {
    const { store, storage } = await storeWith();

    const stored = await store.fetch(
      request('/store', ciba({ auth_req_id: 'broken', login_hint: '\ud800', user_code: undefined }))
    );

    expect(stored.status).toBe(200);
    expect(storage.values.has('r:broken')).toBe(true);
    expect(indexKeys(storage)).toEqual([]);
  });
});

describe('a state change whose save fails leaves the request as it was', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    audit.create.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function cibaStore() {
    const harness = state();
    const store = new CIBARequestStore(harness.state, runtimeEnv);
    await harness.initialized;
    await store.fetch(request('/store', ciba()));
    const read = async () =>
      (await json(
        await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'request-1' }))
      )) as { status: string; token_issued: boolean; poll_count: number };
    const approve = () =>
      store.fetch(
        request('/approve', { auth_req_id: 'request-1', user_id: 'user-1', sub: 'subject-1' })
      );
    return { harness, store, read, approve };
  }

  /** The pending-address index entries (ps: by subject, ph: by login hint). */
  const pendingIndex = (storage: MemoryStorage) =>
    [...storage.values.keys()].filter((key) => key.startsWith('ps:') || key.startsWith('ph:'));

  async function listedFor(store: CIBARequestStore): Promise<string[]> {
    const listed = (await json(
      await store.fetch(request('/list-pending-for-user', { login_hints: ['user@example.com'] }))
    )) as { requests: Array<{ auth_req_id: string }> };
    return listed.requests.map((entry) => entry.auth_req_id);
  }

  it('CIBA: a failed approval is still pending for readers and can be retried', async () => {
    const { harness, store, read, approve } = await cibaStore();
    const indexBefore = pendingIndex(harness.storage);
    expect(indexBefore).toHaveLength(1);
    harness.storage.failPuts = 1;

    expect((await approve()).status).toBe(500);

    expect(await read()).toMatchObject({ status: 'pending' });
    expect(
      await json(await store.fetch(request('/get-by-user-code', { user_code: 'CIBA-123' })))
    ).toMatchObject({ status: 'pending' });
    expect(harness.storage.values.get('r:request-1')).toMatchObject({ status: 'pending' });
    expect(pendingIndex(harness.storage)).toEqual(indexBefore);
    expect(await listedFor(store)).toEqual(['request-1']);

    expect((await approve()).status).toBe(200);
    expect(await read()).toMatchObject({ status: 'approved' });
    expect(harness.storage.values.get('r:request-1')).toMatchObject({ status: 'approved' });
    expect(pendingIndex(harness.storage)).toEqual([]);
    expect(await listedFor(store)).toEqual([]);
  });

  it('CIBA: a request that cannot be saved keeps its index entry, so it is still listed', async () => {
    const { harness, store } = await cibaStore();
    expect(pendingIndex(harness.storage)).toHaveLength(1);
    // Durable Storage rejects the request value (a nonce over its size limit) before applying
    // the write; the index delete is not allowed to go through alone.
    const put = harness.storage.put.bind(harness.storage);
    harness.storage.put = async (key, value) => {
      if (typeof key === 'string' && key === 'r:request-1' && (value as { nonce?: string }).nonce) {
        throw new RangeError('Value too large');
      }
      return put(key, value);
    };

    const answer = await store.fetch(
      request('/approve', {
        auth_req_id: 'request-1',
        user_id: 'user-1',
        sub: 'subject-1',
        nonce: 'n'.repeat(200_000),
      })
    );

    expect(answer.status).toBe(500);
    expect(pendingIndex(harness.storage)).toHaveLength(1);
    expect(await listedFor(store)).toEqual(['request-1']);
    expect(harness.storage.values.get('r:request-1')).toMatchObject({ status: 'pending' });
  });

  it('CIBA: a failed denial is still pending and can be retried', async () => {
    const { harness, store, read } = await cibaStore();
    expect(pendingIndex(harness.storage)).toHaveLength(1);
    harness.storage.failPuts = 1;
    const deny = () => store.fetch(request('/deny', { auth_req_id: 'request-1' }));

    expect((await deny()).status).toBe(500);
    expect(await read()).toMatchObject({ status: 'pending' });
    expect(pendingIndex(harness.storage)).toHaveLength(1);
    expect(await listedFor(store)).toEqual(['request-1']);

    expect((await deny()).status).toBe(200);
    expect(await read()).toMatchObject({ status: 'denied' });
  });

  it('CIBA: a failed token mark does not use up the one-time issue, and a failed poll does not count', async () => {
    const { harness, store, read, approve } = await cibaStore();
    await approve();
    harness.storage.failPuts = 1;
    expect((await store.fetch(request('/update-poll', { auth_req_id: 'request-1' }))).status).toBe(
      500
    );
    expect(await read()).toMatchObject({ poll_count: 0 });

    harness.storage.failPuts = 1;
    const issue = () => store.fetch(request('/mark-token-issued', { auth_req_id: 'request-1' }));
    expect((await issue()).status).toBe(500);
    expect(await read()).toMatchObject({ token_issued: false });

    expect((await issue()).status).toBe(200);
    expect((await issue()).status).toBe(500);
  });

  it('CIBA: two approvals at once decide the request once', async () => {
    const { read, approve } = await cibaStore();

    const answers = await Promise.all([approve(), approve()]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 500]);
    expect(await read()).toMatchObject({ status: 'approved' });
  });

  it('CIBA: a request that could not be stored cannot be read', async () => {
    const harness = state();
    const store = new CIBARequestStore(harness.state, runtimeEnv);
    await harness.initialized;
    harness.storage.failPuts = 1;

    expect((await store.fetch(request('/store', ciba()))).status).toBe(500);

    expect(
      await json(await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'request-1' })))
    ).toBeNull();
    expect(
      await json(await store.fetch(request('/get-by-user-code', { user_code: 'CIBA-123' })))
    ).toBeNull();
  });

  async function deviceStore() {
    const harness = state();
    const store = new DeviceCodeStore(harness.state, runtimeEnv);
    await harness.initialized;
    await store.fetch(request('/store', device()));
    const read = async () =>
      (await json(
        await store.fetch(request('/get-by-device-code', { device_code: 'device-1' }))
      )) as { status: string; token_issued: boolean; poll_count: number };
    const approve = () =>
      store.fetch(request('/approve', { user_code: 'ABCD-EFGH', user_id: 'u', sub: 's' }));
    return { harness, store, read, approve };
  }

  it('device code: a failed approval is still pending and can be retried', async () => {
    const { harness, store, read, approve } = await deviceStore();
    harness.storage.failPuts = 1;

    expect((await approve()).status).toBe(500);
    expect(await read()).toMatchObject({ status: 'pending' });
    expect(
      await json(await store.fetch(request('/get-by-user-code', { user_code: 'ABCD-EFGH' })))
    ).toMatchObject({ status: 'pending' });

    expect((await approve()).status).toBe(200);
    expect(await read()).toMatchObject({ status: 'approved' });
  });

  it('device code: a failed denial is still pending and can be retried', async () => {
    const { harness, store, read } = await deviceStore();
    harness.storage.failPuts = 1;
    const deny = () => store.fetch(request('/deny', { user_code: 'ABCD-EFGH' }));

    expect((await deny()).status).toBe(500);
    expect(await read()).toMatchObject({ status: 'pending' });

    expect((await deny()).status).toBe(200);
    expect(await read()).toMatchObject({ status: 'denied' });
  });

  it('device code: a failed token mark does not use up the one-time issue', async () => {
    const { harness, store, read, approve } = await deviceStore();
    await approve();
    harness.storage.failPuts = 1;
    const issue = () => store.fetch(request('/mark-token-issued', { device_code: 'device-1' }));

    expect((await issue()).status).toBe(500);
    expect(await read()).toMatchObject({ token_issued: false });

    expect((await issue()).status).toBe(200);
    expect((await issue()).status).toBe(500);
  });

  it('device code: two approvals at once decide the code once', async () => {
    const { read, approve } = await deviceStore();

    const answers = await Promise.all([approve(), approve()]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 500]);
    expect(await read()).toMatchObject({ status: 'approved' });
  });

  it('device code: a code that could not be stored cannot be read', async () => {
    const harness = state();
    const store = new DeviceCodeStore(harness.state, runtimeEnv);
    await harness.initialized;
    harness.storage.failPuts = 1;

    expect((await store.fetch(request('/store', device()))).status).toBe(500);

    expect(
      await json(await store.fetch(request('/get-by-device-code', { device_code: 'device-1' })))
    ).toBeNull();
  });

  /** Let the stores run until `condition` holds (real event-loop turns: digests are async I/O). */
  async function until(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 1000 && !condition(); turn += 1) await setImmediate();
    expect(condition()).toBe(true);
  }

  it('CIBA: a delete during a change that is saving does not bring the request back', async () => {
    const { harness, store, read, approve } = await cibaStore();
    let release!: () => void;
    harness.storage.holdPuts = new Promise<void>((resolve) => (release = resolve));
    const putsBefore = harness.storage.putCount;

    const approval = approve();
    await until(() => harness.storage.putCount > putsBefore);
    const deletion = store.fetch(request('/delete', { auth_req_id: 'request-1' }));
    // The delete reaches the store while the change's write is still pending.
    await setImmediate();
    release();
    await Promise.all([approval, deletion]);

    expect(
      await json(await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'request-1' })))
    ).toBeNull();
    expect(harness.storage.values.has('r:request-1')).toBe(false);
    expect(harness.storage.values.has('u:CIBA-123')).toBe(false);
    void read;
  });

  it('CIBA: a change that finds the request deleted before it writes does not write it back', async () => {
    const { harness, store, approve } = await cibaStore();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    // While the approval prepares its write, a read finds the request expired and removes it.
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      vi.setSystemTime(Date.now() + 301_000);
      await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'request-1' }));
      return digest(...args);
    });

    const answer = await approve();

    expect(answer.status).toBe(500);
    expect(harness.storage.values.has('r:request-1')).toBe(false);
    expect(
      await json(await store.fetch(request('/get-by-auth-req-id', { auth_req_id: 'request-1' })))
    ).toBeNull();
    vi.restoreAllMocks();
  });

  it('device code: a delete during a change that is saving does not bring the code back', async () => {
    const { harness, store, read, approve } = await deviceStore();
    let release!: () => void;
    harness.storage.holdPuts = new Promise<void>((resolve) => (release = resolve));
    const putsBefore = harness.storage.putCount;

    const approval = approve();
    await until(() => harness.storage.putCount > putsBefore);
    const deletion = store.fetch(request('/delete', { device_code: 'device-1' }));
    // The delete reaches the store while the change's write is still pending.
    await setImmediate();
    release();
    await Promise.all([approval, deletion]);

    expect(
      await json(await store.fetch(request('/get-by-device-code', { device_code: 'device-1' })))
    ).toBeNull();
    expect(harness.storage.values.has('d:device-1')).toBe(false);
    expect(harness.storage.values.has('u:ABCD-EFGH')).toBe(false);
    void read;
  });
});

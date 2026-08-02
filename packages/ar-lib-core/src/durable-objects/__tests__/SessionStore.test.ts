/**
 * SessionStore Durable Object Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionStore } from '../SessionStore.ts';
import type { Env } from '../../types/env';
import {
  DEFAULT_STORAGE_PROFILE_ID,
  TENANT_D1_STORAGE_PROFILE_ID,
} from '../../types/runtime-profile';
import { AUTH_CORE_PERSISTENCE_CONTEXT_KEY } from '../../services/auth-core-persistence-context';

const runtimeDataContextMocks = vi.hoisted(() => ({
  resolveAccountCoreDataContext: vi.fn(),
  resolveSessionAccountCoreDataContext: vi.fn(),
}));

vi.mock('../../services/runtime-data-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAccountCoreDataContext: runtimeDataContextMocks.resolveAccountCoreDataContext,
  resolveSessionAccountCoreDataContext:
    runtimeDataContextMocks.resolveSessionAccountCoreDataContext,
}));

// Mock DurableObjectState
class MockDurableObjectState implements Partial<DurableObjectState> {
  private _storage = new Map<string, unknown>();
  id!: DurableObjectId;
  storage: DurableObjectStorage;

  constructor() {
    this.storage = {
      get: <T>(key: string): Promise<T | undefined> => {
        return Promise.resolve(this._storage.get(key) as T | undefined);
      },
      put: (keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> => {
        if (typeof keyOrEntries === 'string') {
          this._storage.set(keyOrEntries, value);
        } else {
          Object.entries(keyOrEntries).forEach(([k, v]) => this._storage.set(k, v));
        }
        return Promise.resolve();
      },
      delete: (keyOrKeys: string | string[]): Promise<boolean | number> => {
        if (typeof keyOrKeys === 'string') {
          const existed = this._storage.has(keyOrKeys);
          this._storage.delete(keyOrKeys);
          return Promise.resolve(existed);
        } else {
          let count = 0;
          keyOrKeys.forEach((key) => {
            if (this._storage.delete(key)) count++;
          });
          return Promise.resolve(count);
        }
      },
      deleteAll: (): Promise<void> => {
        this._storage.clear();
        return Promise.resolve();
      },
      list: <T>(): Promise<Map<string, T>> => {
        return Promise.resolve(new Map(this._storage as Map<string, T>));
      },
      transaction: <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> => {
        return closure(this.storage);
      },
      getAlarm: (): Promise<number | null> => {
        return Promise.resolve(null);
      },
      setAlarm: (): Promise<void> => {
        return Promise.resolve();
      },
      deleteAlarm: (): Promise<void> => {
        return Promise.resolve();
      },
      sync: (): Promise<void> => {
        return Promise.resolve();
      },
      transactionSync: <T>(closure: () => T): T => {
        return closure();
      },
      sql: {} as SqlStorage,
      kv: {} as KVNamespace,
      getCurrentBookmark: (): string => '',
      getBookmarkForTime: (): string => '',
      onNextSessionRestoreBookmark: (): void => {},
    } as unknown as DurableObjectStorage;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  waitUntil(): void {
    // No-op for testing
  }
}

// Mock Env
const createMockD1 = (overrides: Partial<D1Database> = {}): D1Database =>
  ({
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
    }),
    batch: vi.fn().mockResolvedValue([]),
    ...overrides,
  }) as unknown as D1Database;

const createMockEnv = (): Env =>
  ({
    DB: createMockD1(),
    DEFAULT_STORAGE_PROFILE_ID,
    // Add other required Env properties as needed
  }) as Env;

describe('SessionStore', () => {
  let sessionStore: SessionStore;
  let mockState: MockDurableObjectState;
  let mockEnv: Env;

  beforeEach(() => {
    runtimeDataContextMocks.resolveAccountCoreDataContext.mockReset();
    runtimeDataContextMocks.resolveSessionAccountCoreDataContext.mockReset();
    mockState = new MockDurableObjectState();
    mockEnv = createMockEnv();
    sessionStore = new SessionStore(mockState as unknown as DurableObjectState, mockEnv);
  });

  describe('Session Creation', () => {
    it('should create a new session with valid data', async () => {
      const sessionId = '0_session_test_123';
      const request = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userId: 'user_123',
          ttl: 3600,
          tenantId: 'default',
          data: { amr: ['pwd'] },
        }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(201);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('id', sessionId);
      expect(body).toHaveProperty('userId', 'user_123');
      expect(body).toHaveProperty('accountId', 'account:user_123');
      expect(body).toHaveProperty('expiresAt');
      expect(body).toHaveProperty('createdAt');
    });

    it('should reject creation without required fields', async () => {
      const request = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: '0_session_missing_ttl',
          userId: 'user_123',
          // Missing ttl
        }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('error');
    });

    it('should reject creation without tenantId', async () => {
      const request = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: '0_session_missing_tenant',
          userId: 'user_123',
          ttl: 3600,
        }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error).toContain('tenantId');
    });

    it('should reject a mismatched tenant after the DO context is established', async () => {
      await sessionStore.createSessionRpc(
        '0_session_tenant_context',
        'user_123',
        3600,
        undefined,
        'tenant-a'
      );

      await expect(
        sessionStore.createSessionRpc(
          '0_session_wrong_tenant',
          'user_456',
          3600,
          undefined,
          'tenant-b'
        )
      ).rejects.toThrow('SessionStore tenant context mismatch');
    });

    it('updates the trusted account route when an anonymous session subject changes', async () => {
      const created = await sessionStore.createSessionRpc(
        '0_session_upgrade',
        'anonymous-user',
        3600,
        { is_anonymous: true },
        'tenant-a'
      );
      expect(created.accountId).toBe('account:anonymous-user');

      const updated = await sessionStore.updateSessionUserIdRpc(
        '0_session_upgrade',
        'registered-user'
      );

      expect(updated).toMatchObject({
        userId: 'registered-user',
        accountId: 'account:registered-user',
      });
    });

    it('should use provided sessionId (sharding support)', async () => {
      const createSession = async (sessionId: string) => {
        const request = new Request('http://localhost/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, userId: 'user_123', ttl: 3600, tenantId: 'default' }),
        });
        const response = await sessionStore.fetch(request);
        const body = (await response.json()) as any;
        return body.id;
      };

      const id1 = await createSession('0_session_first');
      const id2 = await createSession('1_session_second');
      expect(id1).toBe('0_session_first');
      expect(id2).toBe('1_session_second');
      expect(id1).not.toBe(id2);
    });

    it('pins the auth core persistence context on first cold persistence write', async () => {
      const sessionId = '0_session_persistence_context_test';
      const request = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userId: 'user_123',
          ttl: 3600,
          tenantId: 'default',
        }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(201);

      let context: unknown;
      for (let i = 0; i < 5; i++) {
        context = await mockState.storage.get(AUTH_CORE_PERSISTENCE_CONTEXT_KEY);
        if (context) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(context).toMatchObject({
        storageProfileId: DEFAULT_STORAGE_PROFILE_ID,
        coreTarget: {
          driver: 'd1',
          bindingRef: 'DB',
          role: 'core',
        },
        transientAuth: {
          sessionColdPersistence: 'enabled',
          sessionClientMirror: 'async',
          deviceCibaColdPersistence: 'enabled',
          externalDurableMirror: 'disabled',
        },
      });
    });

    it('does not share a never-settling session persistence initialization', async () => {
      let markFirstStarted: (() => void) | undefined;
      let resolveFirstInitialization: ((value: null) => void) | undefined;
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      const resolvedPersistence = {};
      const internals = sessionStore as unknown as {
        initializeSessionPersistence: () => Promise<unknown>;
        ensureSessionPersistence: () => Promise<unknown>;
      };
      const initializeSessionPersistence = vi
        .fn()
        .mockImplementationOnce(() => {
          markFirstStarted?.();
          return new Promise<null>((resolve) => {
            resolveFirstInitialization = resolve;
          });
        })
        .mockResolvedValueOnce(resolvedPersistence);
      internals.initializeSessionPersistence = initializeSessionPersistence;

      const firstLoad = internals.ensureSessionPersistence();
      await firstStarted;
      const secondLoad = internals.ensureSessionPersistence();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const secondResult = await Promise.race([
        secondLoad,
        new Promise<null>((resolveTimeout) => {
          timeoutId = setTimeout(() => resolveTimeout(null), 1000);
        }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (!secondResult) {
        resolveFirstInitialization?.(null);
        await Promise.allSettled([firstLoad, secondLoad]);
      }

      expect(secondResult).toBe(resolvedPersistence);
      expect(initializeSessionPersistence).toHaveBeenCalledTimes(2);
      resolveFirstInitialization?.(null);
      await firstLoad;
    });

    it('writes the tenant-D1 cold session mirror only to the resolved users shard', async () => {
      const metadataD1 = createMockD1();
      const usersD1 = createMockD1();
      runtimeDataContextMocks.resolveAccountCoreDataContext.mockResolvedValue({
        tenantId: 'tenant-a',
        accountId: 'account:user_123',
        coreDb: usersD1,
      });
      mockEnv = {
        ...createMockEnv(),
        DB: metadataD1,
        DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
      } as Env;
      sessionStore = new SessionStore(mockState as unknown as DurableObjectState, mockEnv);

      await sessionStore.createSessionRpc(
        '0_session_tenant_d1_cold_persistence',
        'user_123',
        3600,
        undefined,
        'tenant-a'
      );

      let context: unknown;
      for (let i = 0; i < 5; i++) {
        context = await mockState.storage.get(AUTH_CORE_PERSISTENCE_CONTEXT_KEY);
        if (context) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(context).toMatchObject({
        storageProfileId: TENANT_D1_STORAGE_PROFILE_ID,
        transientAuth: {
          sessionColdPersistence: 'enabled',
          sessionClientMirror: 'async',
          deviceCibaColdPersistence: 'disabled',
        },
      });
      for (let i = 0; i < 5 && !vi.mocked(usersD1.prepare).mock.calls.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(runtimeDataContextMocks.resolveAccountCoreDataContext).toHaveBeenCalledWith(mockEnv, {
        tenantId: 'tenant-a',
        accountId: 'account:user_123',
      });
      expect(usersD1.prepare).toHaveBeenCalled();
      expect(metadataD1.prepare).not.toHaveBeenCalled();
    });
  });

  describe('Session Retrieval', () => {
    it('fails closed when a tenant-D1 session account route cannot be resolved', async () => {
      const usersD1 = createMockD1();
      runtimeDataContextMocks.resolveAccountCoreDataContext.mockResolvedValue({
        tenantId: 'tenant-a',
        accountId: 'account:user_123',
        coreDb: usersD1,
      });
      sessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        {
          ...createMockEnv(),
          DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
        } as Env
      );
      await sessionStore.createSessionRpc(
        '0_session_route_failure',
        'user_123',
        3600,
        undefined,
        'tenant-a'
      );
      runtimeDataContextMocks.resolveSessionAccountCoreDataContext.mockRejectedValue(
        new Error('account_data_runtime_registry_unavailable')
      );

      await expect(sessionStore.getSessionRpc('0_session_route_failure')).rejects.toThrow(
        'account_data_runtime_registry_unavailable'
      );
    });

    it('rejects a tenant-D1 session at the user-wide revocation epoch from the routed Core batch', async () => {
      const usersD1 = createMockD1();
      runtimeDataContextMocks.resolveAccountCoreDataContext.mockResolvedValue({
        tenantId: 'tenant-a',
        accountId: 'account:user_123',
        coreDb: usersD1,
      });
      runtimeDataContextMocks.resolveSessionAccountCoreDataContext.mockResolvedValue({
        tenantId: 'tenant-a',
        accountId: 'account:user_123',
        coreDb: usersD1,
        revokedAfterMs: Date.now() + 10_000,
      });
      sessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        {
          ...createMockEnv(),
          DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
        } as Env
      );
      await sessionStore.createSessionRpc(
        '0_session_revoked_at_epoch',
        'user_123',
        3600,
        undefined,
        'tenant-a'
      );

      await expect(sessionStore.getSessionRpc('0_session_revoked_at_epoch')).resolves.toBeNull();
      expect(runtimeDataContextMocks.resolveSessionAccountCoreDataContext).toHaveBeenCalledWith(
        expect.anything(),
        {
          tenantId: 'tenant-a',
          accountId: 'account:user_123',
          userId: 'user_123',
          nowMs: expect.any(Number),
        }
      );
    });

    it('fails closed when the session Core resolver crosses its durable tenant route', async () => {
      const usersD1 = createMockD1();
      runtimeDataContextMocks.resolveAccountCoreDataContext.mockResolvedValue({
        tenantId: 'tenant-a',
        accountId: 'account:user_123',
        coreDb: usersD1,
      });
      runtimeDataContextMocks.resolveSessionAccountCoreDataContext.mockResolvedValue({
        tenantId: 'tenant-b',
        accountId: 'account:user_123',
        coreDb: usersD1,
        revokedAfterMs: null,
      });
      sessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        {
          ...createMockEnv(),
          DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
        } as Env
      );
      await sessionStore.createSessionRpc(
        '0_session_cross_tenant_core',
        'user_123',
        3600,
        undefined,
        'tenant-a'
      );

      await expect(sessionStore.getSessionRpc('0_session_cross_tenant_core')).rejects.toThrow(
        'session_account_route_mismatch'
      );
    });

    it('fails closed when the user-wide revocation epoch cannot be read', async () => {
      const d1 = createMockD1({
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      });
      sessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        { ...createMockEnv(), DB: d1 } as Env
      );
      await sessionStore.createSessionRpc(
        '0_session_revocation_epoch_failure',
        'user_123',
        3600,
        undefined,
        'tenant-a'
      );

      await expect(
        sessionStore.getSessionRpc('0_session_revocation_epoch_failure')
      ).rejects.toThrow('session_revocation_epoch_unavailable');
    });

    it('rejects a cold session whose account does not match the durable route hint', async () => {
      const sessionId = '0_session_tampered_account_route';
      const expiresAt = Date.now() + 60_000;
      const statement = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({
          id: sessionId,
          tenant_id: 'tenant-a',
          user_id: 'different-user',
          expires_at: Math.floor(expiresAt / 1000),
          created_at: Math.floor(Date.now() / 1000),
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      };
      const usersD1 = createMockD1({
        prepare: vi.fn().mockReturnValue(statement),
      });
      runtimeDataContextMocks.resolveAccountCoreDataContext.mockResolvedValue({
        tenantId: 'tenant-a',
        accountId: 'account:expected-user',
        coreDb: usersD1,
      });
      await mockState.storage.put('session-store:tenant-context', 'tenant-a');
      await mockState.storage.put(`session-route:${sessionId}`, {
        tenantId: 'tenant-a',
        accountId: 'account:expected-user',
        expiresAt,
      });
      sessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        {
          ...createMockEnv(),
          DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
        } as Env
      );

      await expect(sessionStore.getSessionRpc(sessionId)).resolves.toBeNull();
    });

    it('should retrieve an existing session', async () => {
      // Create session
      const sessionId = '0_session_retrieval_test';
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userId: 'user_123', ttl: 3600, tenantId: 'default' }),
      });
      const createResponse = await sessionStore.fetch(createRequest);
      expect(createResponse.status).toBe(201);

      // Retrieve session
      const getRequest = new Request(`http://localhost/session/${sessionId}`, {
        method: 'GET',
      });
      const getResponse = await sessionStore.fetch(getRequest);
      expect(getResponse.status).toBe(200);

      const body = (await getResponse.json()) as any;
      expect(body.id).toBe(sessionId);
      expect(body.userId).toBe('user_123');
    });

    it('should return 404 for non-existent session', async () => {
      const request = new Request('http://localhost/session/session_nonexistent', {
        method: 'GET',
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(404);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('error');
    });

    it('should not return expired sessions', async () => {
      // Create session with very short TTL
      const sessionId = '0_session_expired_test';
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userId: 'user_123', ttl: -1, tenantId: 'default' }), // Already expired
      });
      const createResponse = await sessionStore.fetch(createRequest);
      expect(createResponse.status).toBe(201);

      // Try to retrieve expired session
      const getRequest = new Request(`http://localhost/session/${sessionId}`, {
        method: 'GET',
      });
      const getResponse = await sessionStore.fetch(getRequest);
      expect(getResponse.status).toBe(404);
    });
  });

  describe('Session Invalidation', () => {
    it('should invalidate an existing session', async () => {
      // Create session
      const sessionId = '0_session_invalidate_test';
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userId: 'user_123', ttl: 3600, tenantId: 'default' }),
      });
      const createResponse = await sessionStore.fetch(createRequest);
      expect(createResponse.status).toBe(201);

      // Invalidate session
      const deleteRequest = new Request(`http://localhost/session/${sessionId}`, {
        method: 'DELETE',
      });
      const deleteResponse = await sessionStore.fetch(deleteRequest);
      expect(deleteResponse.status).toBe(200);

      const body = (await deleteResponse.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(sessionId);

      // Verify session is gone
      const getRequest = new Request(`http://localhost/session/${sessionId}`, {
        method: 'GET',
      });
      const getResponse = await sessionStore.fetch(getRequest);
      expect(getResponse.status).toBe(404);
    });

    it('keeps a deletion tombstone until the original long-lived session expires', async () => {
      const sessionId = '0_session_long_lived_tombstone';
      const sessionExpiresAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
      await mockState.storage.put('session-store:tenant-context', 'tenant-a');
      await mockState.storage.put(`session-route:${sessionId}`, {
        tenantId: 'tenant-b',
        accountId: 'account:user-123',
        expiresAt: sessionExpiresAt,
      });
      sessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        {
          ...createMockEnv(),
          DEFAULT_STORAGE_PROFILE_ID: TENANT_D1_STORAGE_PROFILE_ID,
        } as Env
      );

      await sessionStore.invalidateSessionRpc(sessionId);

      const tombstone = await mockState.storage.get<{ expiresAt: number }>(
        `tombstone:${sessionId}`
      );
      expect(tombstone?.expiresAt).toBe(sessionExpiresAt);
      expect(runtimeDataContextMocks.resolveAccountCoreDataContext).not.toHaveBeenCalled();
      expect(runtimeDataContextMocks.resolveSessionAccountCoreDataContext).not.toHaveBeenCalled();
    });

    it('should handle invalidation of non-existent session', async () => {
      const request = new Request('http://localhost/session/session_nonexistent', {
        method: 'DELETE',
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBeNull();
    });
  });

  describe('Multi-Device Session Listing', () => {
    it('should list all sessions for a user', async () => {
      const userId = 'user_multi';

      // Create multiple sessions
      for (let i = 0; i < 3; i++) {
        const sessionId = `${i}_session_multi_${i}`;
        const request = new Request('http://localhost/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, userId, ttl: 3600, tenantId: 'default' }),
        });
        await sessionStore.fetch(request);
      }

      // List sessions
      const listRequest = new Request(`http://localhost/sessions/user/${userId}`, {
        method: 'GET',
      });
      const listResponse = await sessionStore.fetch(listRequest);
      expect(listResponse.status).toBe(200);

      const body = (await listResponse.json()) as any;
      expect(body.sessions).toHaveLength(3);
      expect(body.sessions.every((s: { userId: string }) => s.userId === userId)).toBe(true);
    });

    it('should return empty array for user with no sessions', async () => {
      await sessionStore.fetch(
        new Request('http://localhost/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: '0_session_context_for_empty_list',
            userId: 'other_user',
            ttl: 3600,
            tenantId: 'default',
          }),
        })
      );

      const request = new Request('http://localhost/sessions/user/user_nosessions', {
        method: 'GET',
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.sessions).toEqual([]);
    });

    it('should not include expired sessions in listing', async () => {
      const userId = 'user_expired';

      // Create active session
      const activeRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: '0_session_active_expired',
          userId,
          ttl: 3600,
          tenantId: 'default',
        }),
      });
      await sessionStore.fetch(activeRequest);

      // Create expired session
      const expiredRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: '1_session_expired_expired',
          userId,
          ttl: -1,
          tenantId: 'default',
        }),
      });
      await sessionStore.fetch(expiredRequest);

      // List sessions
      const listRequest = new Request(`http://localhost/sessions/user/${userId}`, {
        method: 'GET',
      });
      const listResponse = await sessionStore.fetch(listRequest);
      const body = (await listResponse.json()) as any;

      // Should only have 1 active session
      expect(body.sessions).toHaveLength(1);
    });
  });

  describe('Session Extension (Active TTL)', () => {
    it('should extend session expiration', async () => {
      // Create session
      const sessionId = '0_session_extend_test';
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userId: 'user_123', ttl: 3600, tenantId: 'default' }),
      });
      const createResponse = await sessionStore.fetch(createRequest);
      const { id, expiresAt: originalExpiry } = (await createResponse.json()) as any;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Extend session
      const extendRequest = new Request(`http://localhost/session/${id}/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 3600 }),
      });
      const extendResponse = await sessionStore.fetch(extendRequest);
      expect(extendResponse.status).toBe(200);

      const body = (await extendResponse.json()) as any;
      expect(body.expiresAt).toBeGreaterThan(originalExpiry);
    });

    it('should reject extension with invalid seconds', async () => {
      const request = new Request('http://localhost/session/0_session_invalid_extend/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: -100 }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(400);
    });

    it('should return 404 for extending non-existent session', async () => {
      const request = new Request('http://localhost/session/0_session_nonexistent_ext/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 3600 }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(404);
    });
  });

  describe('Health Check', () => {
    it('should return status endpoint', async () => {
      const request = new Request('http://localhost/status', {
        method: 'GET',
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('sessions');
      expect(body).toHaveProperty('timestamp');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown routes', async () => {
      const request = new Request('http://localhost/unknown', {
        method: 'GET',
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(404);
    });

    it('should handle malformed JSON', async () => {
      const request = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(500);
    });
  });

  describe('Batch Session Invalidation', () => {
    it('should batch delete multiple sessions', async () => {
      // Create multiple sessions
      const sessionIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const sessionId = `${i}_session_batch_${i}`;
        const request = new Request('http://localhost/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            userId: `user_batch_${i}`,
            ttl: 3600,
            tenantId: 'default',
          }),
        });
        const response = await sessionStore.fetch(request);
        const { id } = (await response.json()) as any;
        sessionIds.push(id);
      }

      // Batch delete
      const batchRequest = new Request('http://localhost/sessions/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds }),
      });
      const batchResponse = await sessionStore.fetch(batchRequest);
      expect(batchResponse.status).toBe(200);

      const body = (await batchResponse.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(3);
      expect(body.failed).toBe(0);
      expect(body.failedIds).toEqual([]);

      // Verify sessions are deleted
      for (const id of sessionIds) {
        const getRequest = new Request(`http://localhost/session/${id}`, {
          method: 'GET',
        });
        const getResponse = await sessionStore.fetch(getRequest);
        expect(getResponse.status).toBe(404);
      }
    });

    it('should report failed deletions for non-existent sessions', async () => {
      // Create one session
      const sessionId = '0_session_batch_fail_test';
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userId: 'user_batch_fail',
          ttl: 3600,
          tenantId: 'default',
        }),
      });
      const createResponse = await sessionStore.fetch(createRequest);
      const { id: existingId } = (await createResponse.json()) as any;

      // Try to delete existing + non-existent sessions
      const sessionIdsToDelete = [existingId, '0_session_nonexistent_1', '0_session_nonexistent_2'];
      const batchRequest = new Request('http://localhost/sessions/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: sessionIdsToDelete }),
      });
      const batchResponse = await sessionStore.fetch(batchRequest);
      expect(batchResponse.status).toBe(200);

      const body = (await batchResponse.json()) as any;
      expect(body.success).toBe(true);
      // With optimized idempotent delete, all sessions are reported as deleted
      // (no read-before-delete pattern)
      expect(body.deleted).toBe(3);
      expect(body.failed).toBe(0);
      expect(body.failedIds).toEqual([]);
    });

    it('should reject batch delete with missing sessionIds', async () => {
      const request = new Request('http://localhost/sessions/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error).toContain('sessionIds');
    });

    it('should reject batch delete with invalid sessionIds type', async () => {
      const request = new Request('http://localhost/sessions/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: 'not-an-array' }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error).toContain('sessionIds');
    });

    it('should handle batch delete with empty array', async () => {
      const request = new Request('http://localhost/sessions/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [] }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
      expect(body.failed).toBe(0);
    });
  });

  describe('D1 Integration', () => {
    it('should handle D1 errors gracefully during session creation', async () => {
      // Mock D1 to throw error
      const errorEnv = {
        ...mockEnv,
        DB: createMockD1({
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnThis(),
            run: vi.fn().mockRejectedValue(new Error('D1 connection failed')),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
          }),
        }),
      } as unknown as Env;

      const errorSessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        errorEnv
      );

      // Session creation should succeed even if D1 fails
      const sessionId = '0_session_d1_error';
      const request = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userId: 'user_d1_error',
          ttl: 3600,
          tenantId: 'default',
        }),
      });

      const response = await errorSessionStore.fetch(request);
      expect(response.status).toBe(201);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('id', sessionId);
      expect(body.userId).toBe('user_d1_error');
    });

    it('should handle D1 errors during session extension', async () => {
      // Create session first
      const sessionId = '0_session_extend_d1_error';
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          userId: 'user_extend_error',
          ttl: 3600,
          tenantId: 'default',
        }),
      });
      const createResponse = await sessionStore.fetch(createRequest);
      const { id } = (await createResponse.json()) as any;

      // Mock D1 to throw error for extension
      const errorEnv = {
        ...mockEnv,
        DB: createMockD1({
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnThis(),
            run: vi.fn().mockRejectedValue(new Error('D1 update failed')),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({ results: [] }),
          }),
        }),
      } as unknown as Env;

      const errorSessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        errorEnv
      );

      // Extension should succeed in memory even if D1 fails
      const extendRequest = new Request(`http://localhost/session/${id}/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 3600 }),
      });

      const extendResponse = await errorSessionStore.fetch(extendRequest);
      expect(extendResponse.status).toBe(200);

      const body = (await extendResponse.json()) as any;
      expect(body).toHaveProperty('expiresAt');
    });

    it('should load cold sessions from D1 when listing user sessions', async () => {
      const userId = 'user_cold_storage';
      const now = Date.now();
      const coldSessionId = 'session_cold_123';

      // Mock D1 to return a session not in memory (cold storage)
      const d1Env = {
        ...mockEnv,
        DB: createMockD1({
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnThis(),
            run: vi.fn().mockResolvedValue({}),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockResolvedValue({
              results: [
                {
                  id: coldSessionId,
                  user_id: userId,
                  expires_at: Math.floor((now + 3600000) / 1000), // expires in 1 hour
                  created_at: Math.floor((now - 1000) / 1000),
                },
              ],
            }),
          }),
        }),
      } as unknown as Env;

      const d1SessionStore = new SessionStore(mockState as unknown as DurableObjectState, d1Env);

      await d1SessionStore.createSessionRpc(
        '0_session_context_for_d1_list',
        'other_user',
        3600,
        undefined,
        'default'
      );

      // List sessions should include cold session from D1
      const listRequest = new Request(`http://localhost/sessions/user/${userId}`, {
        method: 'GET',
      });
      const listResponse = await d1SessionStore.fetch(listRequest);
      expect(listResponse.status).toBe(200);

      const body = (await listResponse.json()) as any;
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe(coldSessionId);
      expect(body.sessions[0].userId).toBe(userId);
    });

    it('should handle D1 errors during session listing', async () => {
      // Mock D1 to throw error
      const errorEnv = {
        ...mockEnv,
        DB: createMockD1({
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnThis(),
            run: vi.fn().mockResolvedValue({}),
            first: vi.fn().mockResolvedValue(null),
            all: vi.fn().mockRejectedValue(new Error('D1 list error')),
          }),
        }),
      } as unknown as Env;

      const errorSessionStore = new SessionStore(
        mockState as unknown as DurableObjectState,
        errorEnv
      );

      await errorSessionStore.createSessionRpc(
        '0_session_context_for_d1_error_list',
        'other_user',
        3600,
        undefined,
        'default'
      );

      // Listing should still work with in-memory sessions only
      const listRequest = new Request('http://localhost/sessions/user/user_list_error', {
        method: 'GET',
      });
      const listResponse = await errorSessionStore.fetch(listRequest);
      expect(listResponse.status).toBe(200);

      const body = (await listResponse.json()) as any;
      expect(body.sessions).toEqual([]);
    });
  });
});

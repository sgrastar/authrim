/**
 * SessionStore Durable Object Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionStore } from '../SessionStore';
import type { Env } from '../../types/env';

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
const createMockEnv = (): Env =>
  ({
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      }),
    } as unknown as D1Database,
    // Add other required Env properties as needed
  }) as Env;

describe('SessionStore', () => {
  let sessionStore: SessionStore;
  let mockState: MockDurableObjectState;
  let mockEnv: Env;

  beforeEach(() => {
    mockState = new MockDurableObjectState();
    mockEnv = createMockEnv();
    sessionStore = new SessionStore(mockState as unknown as DurableObjectState, mockEnv);
  });

  describe('Session Creation', () => {
    it('should create a new session with valid data', async () => {
      const request = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user_123',
          ttl: 3600,
          data: { amr: ['pwd'] },
        }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(201);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('userId', 'user_123');
      expect(body).toHaveProperty('expiresAt');
      expect(body).toHaveProperty('createdAt');
    });

    it('should reject creation without required fields', async () => {
      const request = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'user_123',
          // Missing ttl
        }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('error');
    });

    it('should generate unique session IDs', async () => {
      const createSession = async () => {
        const request = new Request('http://localhost/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: 'user_123', ttl: 3600 }),
        });
        const response = await sessionStore.fetch(request);
        const body = (await response.json()) as any;
        return body.id;
      };

      const id1 = await createSession();
      const id2 = await createSession();
      expect(id1).not.toBe(id2);
    });
  });

  describe('Session Retrieval', () => {
    it('should retrieve an existing session', async () => {
      // Create session
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user_123', ttl: 3600 }),
      });
      const createResponse = await sessionStore.fetch(createRequest);
      const { id } = (await createResponse.json()) as any;

      // Retrieve session
      const getRequest = new Request(`http://localhost/session/${id}`, {
        method: 'GET',
      });
      const getResponse = await sessionStore.fetch(getRequest);
      expect(getResponse.status).toBe(200);

      const body = (await getResponse.json()) as any;
      expect(body.id).toBe(id);
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
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user_123', ttl: -1 }), // Already expired
      });
      const createResponse = await sessionStore.fetch(createRequest);
      const { id } = (await createResponse.json()) as any;

      // Try to retrieve expired session
      const getRequest = new Request(`http://localhost/session/${id}`, {
        method: 'GET',
      });
      const getResponse = await sessionStore.fetch(getRequest);
      expect(getResponse.status).toBe(404);
    });
  });

  describe('Session Invalidation', () => {
    it('should invalidate an existing session', async () => {
      // Create session
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user_123', ttl: 3600 }),
      });
      const createResponse = await sessionStore.fetch(createRequest);
      const { id } = (await createResponse.json()) as any;

      // Invalidate session
      const deleteRequest = new Request(`http://localhost/session/${id}`, {
        method: 'DELETE',
      });
      const deleteResponse = await sessionStore.fetch(deleteRequest);
      expect(deleteResponse.status).toBe(200);

      const body = (await deleteResponse.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(id);

      // Verify session is gone
      const getRequest = new Request(`http://localhost/session/${id}`, {
        method: 'GET',
      });
      const getResponse = await sessionStore.fetch(getRequest);
      expect(getResponse.status).toBe(404);
    });

    it('should handle invalidation of non-existent session', async () => {
      const request = new Request('http://localhost/session/session_nonexistent', {
        method: 'DELETE',
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(null);
    });
  });

  describe('Multi-Device Session Listing', () => {
    it('should list all sessions for a user', async () => {
      const userId = 'user_multi';

      // Create multiple sessions
      for (let i = 0; i < 3; i++) {
        const request = new Request('http://localhost/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, ttl: 3600 }),
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
        body: JSON.stringify({ userId, ttl: 3600 }),
      });
      await sessionStore.fetch(activeRequest);

      // Create expired session
      const expiredRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ttl: -1 }),
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
      const createRequest = new Request('http://localhost/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user_123', ttl: 3600 }),
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
      const request = new Request('http://localhost/session/session_123/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: -100 }),
      });

      const response = await sessionStore.fetch(request);
      expect(response.status).toBe(400);
    });

    it('should return 404 for extending non-existent session', async () => {
      const request = new Request('http://localhost/session/session_nonexistent/extend', {
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

      const body = await response.json();
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
});

/**
 * PARRequestStore Durable Object Unit Tests
 *
 * Tests for RFC 9126 Pushed Authorization Request (PAR) request_uri management.
 * Critical security tests for single-use guarantee.
 *
 * Security-critical tests:
 * - Single-use enforcement (request_uri can only be used once)
 * - Client ID validation
 * - TTL enforcement
 * - Replay attack prevention
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PARRequestStore } from '../PARRequestStore';
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
const createMockEnv = (): Env => ({}) as Env;

describe('PARRequestStore', () => {
  let store: PARRequestStore;
  let mockState: MockDurableObjectState;
  let mockEnv: Env;

  const createValidPARRequest = () => ({
    requestUri: `urn:ietf:params:oauth:request_uri:${Math.random().toString(36).substring(7)}`,
    data: {
      client_id: 'test-client',
      redirect_uri: 'https://example.com/callback',
      scope: 'openid profile',
      state: 'random-state',
      code_challenge: 'challenge123',
      code_challenge_method: 'S256',
    },
    ttl: 600, // 10 minutes
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    mockState = new MockDurableObjectState();
    mockEnv = createMockEnv();
    store = new PARRequestStore(mockState as unknown as DurableObjectState, mockEnv);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Store PAR Request', () => {
    it('should store a new PAR request', async () => {
      const parRequest = createValidPARRequest();

      const response = await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
    });

    it('should reject request without requestUri', async () => {
      const response = await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: { client_id: 'test', redirect_uri: 'https://example.com', scope: 'openid' },
            ttl: 600,
          }),
        })
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error).toBe('invalid_request');
    });

    it('should reject request without data', async () => {
      const response = await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: 'urn:ietf:params:oauth:request_uri:test',
            ttl: 600,
          }),
        })
      );

      expect(response.status).toBe(400);
    });

    it('should reject request without ttl', async () => {
      const response = await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: 'urn:ietf:params:oauth:request_uri:test',
            data: { client_id: 'test', redirect_uri: 'https://example.com', scope: 'openid' },
          }),
        })
      );

      expect(response.status).toBe(400);
    });
  });

  describe('Consume PAR Request (Single-Use Guarantee)', () => {
    it('should consume a valid PAR request', async () => {
      const parRequest = createValidPARRequest();

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Consume
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.client_id).toBe(parRequest.data.client_id);
      expect(body.redirect_uri).toBe(parRequest.data.redirect_uri);
      expect(body.scope).toBe(parRequest.data.scope);
    });

    it('should reject second consumption (single-use)', async () => {
      const parRequest = createValidPARRequest();

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // First consume - should succeed
      const firstResponse = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );
      expect(firstResponse.status).toBe(200);

      // Second consume - should fail
      const secondResponse = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );
      expect(secondResponse.status).toBe(400);

      const body = (await secondResponse.json()) as any;
      expect(body.error).toBe('invalid_request_uri');
      expect(body.error_description).toContain('already consumed');
    });

    it('should reject consumption with wrong client_id', async () => {
      const parRequest = createValidPARRequest();

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Try to consume with different client_id
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: 'attacker-client',
          }),
        })
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error_description).toContain('client_id mismatch');
    });

    it('should reject consumption of non-existent request_uri', async () => {
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: 'urn:ietf:params:oauth:request_uri:nonexistent',
            client_id: 'test-client',
          }),
        })
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error_description).toContain('not found');
    });

    it('should reject consumption without requestUri', async () => {
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: 'test-client',
          }),
        })
      );

      expect(response.status).toBe(400);
    });

    it('should reject consumption without client_id', async () => {
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: 'urn:ietf:params:oauth:request_uri:test',
          }),
        })
      );

      expect(response.status).toBe(400);
    });
  });

  describe('TTL Expiration', () => {
    it('should reject consumption of expired request_uri', async () => {
      const parRequest = createValidPARRequest();
      parRequest.ttl = 60; // 1 minute

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Advance time past TTL
      vi.advanceTimersByTime(61 * 1000);

      // Try to consume
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error_description).toContain('expired');
    });

    it('should accept consumption just before expiration', async () => {
      const parRequest = createValidPARRequest();
      parRequest.ttl = 60; // 1 minute

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Advance time to just before TTL
      vi.advanceTimersByTime(59 * 1000);

      // Consume - should succeed
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );

      expect(response.status).toBe(200);
    });
  });

  describe('Get Request Info', () => {
    it('should return request info without consuming', async () => {
      const parRequest = createValidPARRequest();

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Get info
      const response = await store.fetch(
        new Request(
          `http://localhost/request/${encodeURIComponent(parRequest.requestUri)}`,
          { method: 'GET' }
        )
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.client_id).toBe(parRequest.data.client_id);
      expect(body.consumed).toBe(false);

      // Should still be consumable
      const consumeResponse = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );
      expect(consumeResponse.status).toBe(200);
    });

    it('should return 404 for non-existent request', async () => {
      const response = await store.fetch(
        new Request(
          'http://localhost/request/urn:ietf:params:oauth:request_uri:nonexistent',
          { method: 'GET' }
        )
      );

      expect(response.status).toBe(404);
    });

    it('should return 404 for expired request', async () => {
      const parRequest = createValidPARRequest();
      parRequest.ttl = 60;

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Advance time past TTL
      vi.advanceTimersByTime(61 * 1000);

      // Get info - should be 404
      const response = await store.fetch(
        new Request(
          `http://localhost/request/${encodeURIComponent(parRequest.requestUri)}`,
          { method: 'GET' }
        )
      );

      expect(response.status).toBe(404);
    });
  });

  describe('Delete Request', () => {
    it('should delete an existing request', async () => {
      const parRequest = createValidPARRequest();

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Delete
      const deleteResponse = await store.fetch(
        new Request(
          `http://localhost/request/${encodeURIComponent(parRequest.requestUri)}`,
          { method: 'DELETE' }
        )
      );

      expect(deleteResponse.status).toBe(200);
      const body = (await deleteResponse.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(true);

      // Verify deleted
      const getResponse = await store.fetch(
        new Request(
          `http://localhost/request/${encodeURIComponent(parRequest.requestUri)}`,
          { method: 'GET' }
        )
      );
      expect(getResponse.status).toBe(404);
    });

    it('should handle deletion of non-existent request', async () => {
      const response = await store.fetch(
        new Request(
          'http://localhost/request/urn:ietf:params:oauth:request_uri:nonexistent',
          { method: 'DELETE' }
        )
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(false);
    });
  });

  describe('Health Check', () => {
    it('should return health status with counts', async () => {
      // Store multiple requests
      for (let i = 0; i < 3; i++) {
        await store.fetch(
          new Request('http://localhost/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createValidPARRequest()),
          })
        );
      }

      const response = await store.fetch(
        new Request('http://localhost/health', { method: 'GET' })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.status).toBe('ok');
      expect(body.requests.total).toBe(3);
      expect(body.requests.active).toBe(3);
    });

    it('should distinguish active and consumed requests', async () => {
      const parRequest = createValidPARRequest();

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Consume
      await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );

      const response = await store.fetch(
        new Request('http://localhost/health', { method: 'GET' })
      );

      const body = (await response.json()) as any;
      expect(body.requests.active).toBe(0);
      expect(body.requests.consumed).toBe(1);
    });
  });

  describe('Unknown Endpoints', () => {
    it('should return 404 for unknown path', async () => {
      const response = await store.fetch(
        new Request('http://localhost/unknown', { method: 'GET' })
      );

      expect(response.status).toBe(404);
    });
  });

  describe('Security Edge Cases', () => {
    it('should handle URL-encoded request_uri', async () => {
      const parRequest = createValidPARRequest();
      parRequest.requestUri = 'urn:ietf:params:oauth:request_uri:special/chars?test=1';

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Consume with URL encoding
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );

      expect(response.status).toBe(200);
    });

    it('should preserve all PAR parameters in consumed data', async () => {
      const parRequest = {
        requestUri: `urn:ietf:params:oauth:request_uri:full-params-${Date.now()}`,
        data: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile email',
          state: 'state-value',
          nonce: 'nonce-value',
          code_challenge: 'code-challenge-value',
          code_challenge_method: 'S256',
          response_type: 'code',
          prompt: 'consent',
          max_age: 3600,
          ui_locales: 'ja en',
          login_hint: 'user@example.com',
          acr_values: 'urn:mace:incommon:iap:silver',
        },
        ttl: 600,
      };

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Consume
      const response = await store.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );

      const body = (await response.json()) as any;
      expect(body.scope).toBe('openid profile email');
      expect(body.state).toBe('state-value');
      expect(body.nonce).toBe('nonce-value');
      expect(body.code_challenge).toBe('code-challenge-value');
      expect(body.code_challenge_method).toBe('S256');
      expect(body.prompt).toBe('consent');
      expect(body.max_age).toBe(3600);
      expect(body.login_hint).toBe('user@example.com');
    });
  });

  describe('Persistence', () => {
    it('should persist requests across initialization', async () => {
      const parRequest = createValidPARRequest();

      // Store
      await store.fetch(
        new Request('http://localhost/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parRequest),
        })
      );

      // Create new store instance
      const newStore = new PARRequestStore(mockState as unknown as DurableObjectState, mockEnv);

      // Should still find the request
      const response = await newStore.fetch(
        new Request('http://localhost/request/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestUri: parRequest.requestUri,
            client_id: parRequest.data.client_id,
          }),
        })
      );

      expect(response.status).toBe(200);
    });
  });
});

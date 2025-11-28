/**
 * TokenRevocationStore Durable Object Unit Tests
 *
 * Tests for token revocation management with strong consistency.
 * Ensures proper revocation tracking and TTL enforcement.
 *
 * Security-critical tests:
 * - Token revocation state consistency
 * - Bulk revocation for code reuse attacks
 * - TTL enforcement
 * - Persistence across restarts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenRevocationStore } from '../TokenRevocationStore';
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

describe('TokenRevocationStore', () => {
  let store: TokenRevocationStore;
  let mockState: MockDurableObjectState;
  let mockEnv: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    mockState = new MockDurableObjectState();
    mockEnv = createMockEnv();
    store = new TokenRevocationStore(mockState as unknown as DurableObjectState, mockEnv);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Revoke Token', () => {
    it('should revoke a token', async () => {
      const response = await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'token-jti-123',
            ttl: 3600,
            reason: 'user_logout',
          }),
        })
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
    });

    it('should revoke token without reason', async () => {
      const response = await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'token-no-reason',
            ttl: 3600,
          }),
        })
      );

      expect(response.status).toBe(201);
    });

    it('should reject revocation without jti', async () => {
      const response = await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ttl: 3600,
          }),
        })
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error).toBe('invalid_request');
    });

    it('should reject revocation without ttl', async () => {
      const response = await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'token-no-ttl',
          }),
        })
      );

      expect(response.status).toBe(400);
    });
  });

  describe('Check Revocation', () => {
    it('should return revoked=true for revoked token', async () => {
      // Revoke token
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'revoked-token',
            ttl: 3600,
            reason: 'test_revocation',
          }),
        })
      );

      // Check revocation
      const response = await store.fetch(
        new Request('http://localhost/check?jti=revoked-token', {
          method: 'GET',
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.revoked).toBe(true);
      expect(body.reason).toBe('test_revocation');
      expect(body.revokedAt).toBeDefined();
      expect(body.expiresAt).toBeDefined();
    });

    it('should return revoked=false for non-revoked token', async () => {
      const response = await store.fetch(
        new Request('http://localhost/check?jti=non-revoked-token', {
          method: 'GET',
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.revoked).toBe(false);
    });

    it('should reject check without jti parameter', async () => {
      const response = await store.fetch(
        new Request('http://localhost/check', {
          method: 'GET',
        })
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      expect(body.error).toBe('invalid_request');
    });

    it('should return revoked=false for expired revocation', async () => {
      // Revoke token with short TTL
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'expired-revocation',
            ttl: 60,
          }),
        })
      );

      // Advance time past TTL
      vi.advanceTimersByTime(61 * 1000);

      // Check revocation
      const response = await store.fetch(
        new Request('http://localhost/check?jti=expired-revocation', {
          method: 'GET',
        })
      );

      const body = (await response.json()) as any;
      expect(body.revoked).toBe(false);
    });
  });

  describe('Bulk Revocation', () => {
    it('should revoke multiple tokens at once', async () => {
      const response = await store.fetch(
        new Request('http://localhost/bulk-revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jtis: ['token-1', 'token-2', 'token-3'],
            ttl: 3600,
            reason: 'authorization_code_reuse',
          }),
        })
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
      expect(body.revoked).toBe(3);

      // Verify all are revoked
      for (const jti of ['token-1', 'token-2', 'token-3']) {
        const checkResponse = await store.fetch(
          new Request(`http://localhost/check?jti=${jti}`, {
            method: 'GET',
          })
        );
        const checkBody = (await checkResponse.json()) as any;
        expect(checkBody.revoked).toBe(true);
      }
    });

    it('should reject bulk revocation without jtis array', async () => {
      const response = await store.fetch(
        new Request('http://localhost/bulk-revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ttl: 3600,
            reason: 'test',
          }),
        })
      );

      expect(response.status).toBe(400);
    });

    it('should reject bulk revocation with non-array jtis', async () => {
      const response = await store.fetch(
        new Request('http://localhost/bulk-revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jtis: 'not-an-array',
            ttl: 3600,
          }),
        })
      );

      expect(response.status).toBe(400);
    });

    it('should reject bulk revocation without ttl', async () => {
      const response = await store.fetch(
        new Request('http://localhost/bulk-revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jtis: ['token-1', 'token-2'],
          }),
        })
      );

      expect(response.status).toBe(400);
    });

    it('should handle empty jtis array gracefully', async () => {
      const response = await store.fetch(
        new Request('http://localhost/bulk-revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jtis: [],
            ttl: 3600,
            reason: 'test',
          }),
        })
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as any;
      expect(body.revoked).toBe(0);
    });
  });

  describe('Delete Token Record', () => {
    it('should delete a revoked token record', async () => {
      // Revoke
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'to-delete',
            ttl: 3600,
          }),
        })
      );

      // Delete
      const deleteResponse = await store.fetch(
        new Request('http://localhost/token/to-delete', {
          method: 'DELETE',
        })
      );

      expect(deleteResponse.status).toBe(200);
      const body = (await deleteResponse.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(true);

      // Verify no longer revoked
      const checkResponse = await store.fetch(
        new Request('http://localhost/check?jti=to-delete', {
          method: 'GET',
        })
      );
      const checkBody = (await checkResponse.json()) as any;
      expect(checkBody.revoked).toBe(false);
    });

    it('should handle deletion of non-existent token', async () => {
      const response = await store.fetch(
        new Request('http://localhost/token/nonexistent', {
          method: 'DELETE',
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(false);
    });

    it('should handle URL-encoded JTI in delete', async () => {
      const jti = 'jti/with/slashes';

      // Revoke
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti,
            ttl: 3600,
          }),
        })
      );

      // Delete with URL encoding
      const response = await store.fetch(
        new Request(`http://localhost/token/${encodeURIComponent(jti)}`, {
          method: 'DELETE',
        })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.deleted).toBe(true);
    });
  });

  describe('Health Check', () => {
    it('should return health status with counts', async () => {
      // Revoke some tokens
      for (let i = 0; i < 5; i++) {
        await store.fetch(
          new Request('http://localhost/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jti: `health-check-${i}`,
              ttl: 3600,
            }),
          })
        );
      }

      const response = await store.fetch(
        new Request('http://localhost/health', { method: 'GET' })
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.status).toBe('ok');
      expect(body.revokedTokens.total).toBe(5);
      expect(body.revokedTokens.active).toBe(5);
      expect(body.revokedTokens.expired).toBe(0);
    });

    it('should distinguish active and expired tokens', async () => {
      // Revoke with short TTL
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'short-ttl',
            ttl: 60,
          }),
        })
      );

      // Revoke with long TTL
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'long-ttl',
            ttl: 3600,
          }),
        })
      );

      // Advance time to expire short TTL
      vi.advanceTimersByTime(61 * 1000);

      const response = await store.fetch(
        new Request('http://localhost/health', { method: 'GET' })
      );

      const body = (await response.json()) as any;
      expect(body.revokedTokens.active).toBe(1);
      expect(body.revokedTokens.expired).toBe(1);
    });
  });

  describe('Unknown Endpoints', () => {
    it('should return 404 for unknown path', async () => {
      const response = await store.fetch(
        new Request('http://localhost/unknown', { method: 'GET' })
      );

      expect(response.status).toBe(404);
    });

    it('should return 404 for wrong method on check', async () => {
      const response = await store.fetch(
        new Request('http://localhost/check?jti=test', { method: 'POST' })
      );

      expect(response.status).toBe(404);
    });
  });

  describe('Persistence', () => {
    it('should persist revoked tokens across initialization', async () => {
      // Revoke
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: 'persistent-token',
            ttl: 3600,
          }),
        })
      );

      // Create new store instance
      const newStore = new TokenRevocationStore(
        mockState as unknown as DurableObjectState,
        mockEnv
      );

      // Should still find the revoked token
      const response = await newStore.fetch(
        new Request('http://localhost/check?jti=persistent-token', {
          method: 'GET',
        })
      );

      const body = (await response.json()) as any;
      expect(body.revoked).toBe(true);
    });
  });

  describe('Security Edge Cases', () => {
    it('should handle very long JTI', async () => {
      const longJti = 'a'.repeat(1000);

      const response = await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: longJti,
            ttl: 3600,
          }),
        })
      );

      expect(response.status).toBe(201);

      // Verify revocation
      const checkResponse = await store.fetch(
        new Request(`http://localhost/check?jti=${encodeURIComponent(longJti)}`, {
          method: 'GET',
        })
      );
      const body = (await checkResponse.json()) as any;
      expect(body.revoked).toBe(true);
    });

    it('should handle special characters in JTI', async () => {
      const specialJti = 'jti-!@#$%^&*()_+-=[]{}|;:,.<>?';

      const response = await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti: specialJti,
            ttl: 3600,
          }),
        })
      );

      expect(response.status).toBe(201);
    });

    it('should handle re-revocation of already revoked token', async () => {
      const jti = 'double-revoke';

      // First revocation
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti,
            ttl: 3600,
            reason: 'first_revocation',
          }),
        })
      );

      // Second revocation - should update
      await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jti,
            ttl: 7200,
            reason: 'second_revocation',
          }),
        })
      );

      // Check - should show second revocation
      const response = await store.fetch(
        new Request(`http://localhost/check?jti=${jti}`, {
          method: 'GET',
        })
      );

      const body = (await response.json()) as any;
      expect(body.revoked).toBe(true);
      expect(body.reason).toBe('second_revocation');
    });
  });

  describe('JSON Error Handling', () => {
    it('should handle malformed JSON in revoke request', async () => {
      const response = await store.fetch(
        new Request('http://localhost/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not valid json',
        })
      );

      expect(response.status).toBe(500);
    });

    it('should handle malformed JSON in bulk-revoke request', async () => {
      const response = await store.fetch(
        new Request('http://localhost/bulk-revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{invalid}',
        })
      );

      expect(response.status).toBe(500);
    });
  });
});

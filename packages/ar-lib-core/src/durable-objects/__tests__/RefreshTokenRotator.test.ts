/**
 * RefreshTokenRotator Durable Object Unit Tests (V2)
 *
 * Tests for the version-based Refresh Token Rotation system.
 * V2 uses rtv (Refresh Token Version) for theft detection instead of token string comparison.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RefreshTokenRotator } from '../RefreshTokenRotator';
import type { Env } from '../../types/env';

// Mock DurableObjectState
class MockDurableObjectState implements Partial<DurableObjectState> {
  private _storage = new Map<string, unknown>();
  private failPutKey: string | null = null;
  listCallCount = 0;
  putCallCount = 0;
  id!: DurableObjectId;
  storage: DurableObjectStorage;

  constructor() {
    this.storage = {
      get: <T>(key: string): Promise<T | undefined> => {
        return Promise.resolve(this._storage.get(key) as T | undefined);
      },
      put: (keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> => {
        this.putCallCount++;
        if (typeof keyOrEntries === 'string') {
          if (this.failPutKey === keyOrEntries) {
            this.failPutKey = null;
            return Promise.reject(new Error('simulated storage write failure'));
          }
          this._storage.set(keyOrEntries, value);
        } else {
          if (this.failPutKey && Object.hasOwn(keyOrEntries, this.failPutKey)) {
            this.failPutKey = null;
            return Promise.reject(new Error('simulated storage write failure'));
          }
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
      list: <T>(options?: DurableObjectListOptions): Promise<Map<string, T>> => {
        this.listCallCount++;
        const result = new Map<string, T>();
        const prefix = options?.prefix || '';
        for (const [key, value] of this._storage) {
          if (key.startsWith(prefix)) {
            result.set(key, value as T);
          }
        }
        return Promise.resolve(result);
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

  failNextPut(key: string): void {
    this.failPutKey = key;
  }

  seed(key: string, value: unknown): void {
    this._storage.set(key, value);
  }
}

// Mock Env
const createMockD1 = () =>
  ({
    prepare: () => ({
      bind: () => ({
        run: async () => ({ success: true }),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    }),
    batch: async () => [],
  }) as unknown as D1Database;

const createMockEnv = (): Env =>
  ({
    DB: createMockD1(),
    DB_PII: createMockD1(),
  }) as unknown as Env;

describe('RefreshTokenRotator V2', () => {
  let rotator: RefreshTokenRotator;
  let mockState: MockDurableObjectState;
  let mockEnv: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    mockState = new MockDurableObjectState();
    mockEnv = createMockEnv();
    rotator = new RefreshTokenRotator(mockState as unknown as DurableObjectState, mockEnv);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('Token Family Creation', () => {
    it('does not enumerate all families on cold start and lazily restores one family', async () => {
      await rotator.createFamilyRpc({
        jti: 'cold-jti',
        userId: 'cold-user',
        clientId: 'client_1',
        tenantId: 'default',
        scope: 'openid',
        ttl: 2592000,
        generation: 1,
        shardIndex: 0,
      });

      const restarted = new RefreshTokenRotator(
        mockState as unknown as DurableObjectState,
        mockEnv
      );
      const restored = await restarted.getFamilyRpc('cold-user');

      expect(restored).toMatchObject({ user_id: 'cold-user', last_jti: 'cold-jti' });
      expect(mockState.listCallCount).toBe(0);
      expect(mockState.putCallCount).toBe(1);
    });

    it('rejects invalid family input before writing any state', async () => {
      await expect(
        rotator.createFamilyRpc({
          jti: 'invalid-ttl-jti',
          userId: 'invalid-ttl-user',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 0,
          generation: 1,
          shardIndex: 0,
        })
      ).rejects.toThrow('Invalid refresh token family input');
      expect(mockState.putCallCount).toBe(0);
    });

    it('does not expose a family in memory when its durable create fails', async () => {
      mockState.failNextPut('f:undurable-user');

      await expect(
        rotator.createFamilyRpc({
          jti: 'undurable-jti',
          userId: 'undurable-user',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        })
      ).rejects.toThrow('simulated storage write failure');
      await expect(rotator.getFamilyRpc('undurable-user')).resolves.toBeNull();
    });

    it('does not retain tenant context when its durable write fails', async () => {
      mockState.failNextPut('m:tenantId');

      await expect(
        rotator.createFamilyRpc({
          jti: 'failed-tenant-jti',
          userId: 'failed-tenant-user',
          clientId: 'client_1',
          tenantId: 'tenant-a',
          scope: 'openid',
          ttl: 2592000,
        })
      ).rejects.toThrow('simulated storage write failure');

      await expect(
        rotator.createFamilyRpc({
          jti: 'recovered-tenant-jti',
          userId: 'recovered-tenant-user',
          clientId: 'client_1',
          tenantId: 'tenant-b',
          scope: 'openid',
          ttl: 2592000,
        })
      ).resolves.toMatchObject({ version: 1 });
    });

    it('does not retain shard metadata when its durable write fails', async () => {
      mockState.failNextPut('m:generation');

      await expect(
        rotator.createFamilyRpc({
          jti: 'failed-shard-jti',
          userId: 'failed-shard-user',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
          generation: 1,
          shardIndex: 0,
        })
      ).rejects.toThrow('simulated storage write failure');

      await expect(
        rotator.createFamilyRpc({
          jti: 'recovered-shard-jti',
          userId: 'recovered-shard-user',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
          generation: 2,
          shardIndex: 1,
        })
      ).resolves.toMatchObject({ version: 1 });
    });

    it('retains the prior cached version when a rotation write fails', async () => {
      await rotator.createFamilyRpc({
        jti: 'durable-v1',
        userId: 'durable-user',
        clientId: 'client_1',
        tenantId: 'default',
        scope: 'openid',
        ttl: 2592000,
      });
      mockState.failNextPut('f:durable-user');

      await expect(
        rotator.rotateRpc({
          incomingVersion: 1,
          incomingJti: 'durable-v1',
          userId: 'durable-user',
          clientId: 'client_1',
          tenantId: 'default',
        })
      ).rejects.toThrow('simulated storage write failure');
      await expect(rotator.validateRpc('durable-user', 1, 'client_1')).resolves.toMatchObject({
        valid: true,
      });
      await expect(rotator.validateRpc('durable-user', 2, 'client_1')).resolves.toEqual({
        valid: false,
      });
    });

    it('rejects a request routed to an existing shard with different metadata', async () => {
      await rotator.createFamilyRpc({
        jti: 'shard-v1',
        userId: 'shard-user',
        clientId: 'client_1',
        tenantId: 'default',
        scope: 'openid',
        ttl: 2592000,
        generation: 1,
        shardIndex: 0,
      });

      await expect(
        rotator.createFamilyRpc({
          jti: 'wrong-shard',
          userId: 'other-user',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
          generation: 2,
          shardIndex: 0,
        })
      ).rejects.toThrow('Refresh token shard metadata mismatch');
      await expect(rotator.getFamilyRpc('other-user')).resolves.toBeNull();
    });

    it('fails closed when a lazily loaded family does not match its storage key', async () => {
      const corruptedState = new MockDurableObjectState();
      corruptedState.seed('m:tenantId', 'default');
      corruptedState.seed('f:expected-user', {
        tenant_id: 'default',
        version: 1,
        last_jti: 'corrupt-jti',
        last_used_at: Date.now(),
        expires_at: Date.now() + 60_000,
        user_id: 'different-user',
        client_id: 'client_1',
        allowed_scope: 'openid',
      });
      const corruptedRotator = new RefreshTokenRotator(
        corruptedState as unknown as DurableObjectState,
        mockEnv
      );

      await expect(corruptedRotator.getFamilyRpc('expected-user')).rejects.toThrow(
        'refresh_token_family_storage_invalid'
      );
    });

    it('fails closed when persisted families have no tenant metadata', async () => {
      const missingTenantState = new MockDurableObjectState();
      missingTenantState.seed('f:expected-user', {
        tenant_id: 'default',
        version: 1,
        last_jti: 'legacy-jti',
        last_used_at: Date.now(),
        expires_at: Date.now() + 60_000,
        user_id: 'expected-user',
        client_id: 'client_1',
        allowed_scope: 'openid',
      });
      const missingTenantRotator = new RefreshTokenRotator(
        missingTenantState as unknown as DurableObjectState,
        mockEnv
      );

      await expect(missingTenantRotator.getFamilyRpc('expected-user')).rejects.toThrow(
        'refresh_token_family_storage_invalid'
      );
    });

    it('should create new token family successfully', async () => {
      const request = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'initial-jti-12345',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid profile',
          ttl: 2592000, // 30 days
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(201);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('version', 1);
      expect(body).toHaveProperty('newJti', 'initial-jti-12345');
      expect(body).toHaveProperty('expiresIn');
      expect(body).toHaveProperty('allowedScope', 'openid profile');
      expect(body.expiresIn).toBeGreaterThan(0);
    });

    it('should reject family creation without required fields', async () => {
      const request = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'test-jti',
          // Missing userId, clientId, scope
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error).toBe('invalid_request');
    });

    it('should initialize family with version 1', async () => {
      const request = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'initial-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });

      const response = await rotator.fetch(request);
      const body = (await response.json()) as any;

      expect(body.version).toBe(1);
    });

    it('should persist original resource audience in token family metadata', async () => {
      await rotator.createFamilyRpc({
        jti: 'resource-jti',
        userId: 'user_123',
        clientId: 'client_1',
        tenantId: 'default',
        scope: 'openid',
        ttl: 2592000,
        resourceAudience: ['svc://api', 'svc://admin'],
      });

      const validation = await rotator.validateRpc('user_123', 1, 'client_1');
      const rotation = await rotator.rotateRpc({
        incomingVersion: 1,
        incomingJti: 'resource-jti',
        userId: 'user_123',
        clientId: 'client_1',
        tenantId: 'default',
      });

      expect(validation.family?.resource_aud).toEqual(['svc://api', 'svc://admin']);
      expect(rotation.resourceAudience).toEqual(['svc://api', 'svc://admin']);
    });

    it('should reject tenant mismatch on the same rotator instance', async () => {
      await rotator.createFamilyRpc({
        jti: 'tenant-bound-jti',
        userId: 'user_123',
        clientId: 'client_1',
        tenantId: 'tenant-a',
        scope: 'openid',
        ttl: 2592000,
      });

      await expect(
        rotator.rotateRpc({
          incomingVersion: 1,
          incomingJti: 'tenant-bound-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'tenant-b',
        })
      ).rejects.toThrow('Tenant mismatch');
    });
  });

  describe('Atomic Token Rotation', () => {
    it('should rotate token successfully with version increment', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'original-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid profile',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // Rotate token
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: createBody.version,
          incomingJti: 'original-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.newVersion).toBe(2);
      expect(body.newJti).toBeDefined();
      expect(body.newJti).not.toBe('original-jti');
      expect(body.expiresIn).toBeGreaterThan(0);
      expect(body.allowedScope).toBe('openid profile');
    });

    it('should increment version on each rotation', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'jti-v1',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      let currentVersion = createBody.version;
      let currentJti = createBody.newJti;

      // Rotate 3 times
      for (let i = 1; i <= 3; i++) {
        const rotateRequest = new Request('http://localhost/rotate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            incomingVersion: currentVersion,
            incomingJti: currentJti,
            userId: 'user_123',
            clientId: 'client_1',
            tenantId: 'default',
          }),
        });

        const response = await rotator.fetch(rotateRequest);
        const body = (await response.json()) as any;

        expect(body.newVersion).toBe(i + 1);

        // Update for next iteration
        currentVersion = body.newVersion;
        currentJti = body.newJti;
      }
    });
  });

  describe('Theft Detection (Version Mismatch)', () => {
    it('should detect version mismatch and revoke family', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'theft-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // First rotation (legitimate) - version 1 → 2
      const rotate1 = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: createBody.version,
          incomingJti: 'theft-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const response1 = await rotator.fetch(rotate1);
      const body1 = (await response1.json()) as any;
      expect(body1.newVersion).toBe(2);

      // Second rotation (legitimate) - version 2 → 3
      const rotate2 = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: body1.newVersion,
          incomingJti: body1.newJti,
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const response2 = await rotator.fetch(rotate2);
      expect(response2.status).toBe(200);

      // Attempt to reuse old version (THEFT!) - version 1 when current is 3
      const replayAttempt = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: 1, // Old version!
          incomingJti: 'theft-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const replayResponse = await rotator.fetch(replayAttempt);
      expect(replayResponse.status).toBe(400);

      const replayBody = (await replayResponse.json()) as any;
      expect(replayBody.error).toBe('invalid_grant');
      // Security: Generic message to prevent token state enumeration
      expect(replayBody.error_description).toContain('Refresh token');
    });

    it('should revoke family after theft detection', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'revoke-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // Rotate token - version 1 → 2
      const rotate = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: createBody.version,
          incomingJti: 'revoke-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const rotateResponse = await rotator.fetch(rotate);
      const rotateBody = (await rotateResponse.json()) as any;

      // Trigger theft detection with old version
      const replayAttempt = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: 1, // Old version
          incomingJti: 'revoke-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      await rotator.fetch(replayAttempt);

      // Try to use the new (legitimate) token - should also be revoked
      const legitimateAttempt = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: rotateBody.newVersion,
          incomingJti: rotateBody.newJti,
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });
      const legitResponse = await rotator.fetch(legitimateAttempt);
      expect(legitResponse.status).toBe(400);

      const legitBody = (await legitResponse.json()) as any;
      // Security: Generic message
      expect(legitBody.error_description).toContain('Refresh token');
    });
  });

  describe('Token Ownership Validation', () => {
    it('should reject rotation with wrong userId', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'user-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // Try to rotate with different user
      // Note: Family lookup is by userId, so wrong userId = family not found
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: createBody.version,
          incomingJti: 'user-test-jti',
          userId: 'user_456', // Wrong user! Will result in "not found"
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      // Family is keyed by userId, so wrong userId means family not found
      // Security: Generic message
      expect(body.error_description).toContain('Refresh token');
    });

    it('should reject rotation with wrong clientId', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'client-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // Try to rotate with different client
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: createBody.version,
          incomingJti: 'client-test-jti',
          userId: 'user_123',
          clientId: 'client_2', // Wrong client!
          tenantId: 'default',
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      // Security: Generic message to prevent client enumeration
      expect(body.error_description).toContain('Refresh token');
    });
  });

  describe('Scope Amplification Prevention', () => {
    it('should reject scope amplification attempt', async () => {
      // Create family with limited scope
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'scope-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid profile', // Limited scope
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // Try to rotate with expanded scope
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: createBody.version,
          incomingJti: 'scope-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          requestedScope: 'openid profile email admin', // Trying to amplify scope!
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      // Security: Generic message
      expect(body.error_description).toContain('Refresh token');
    });

    it('should allow subset of original scope', async () => {
      // Create family with full scope
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'scope-subset-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid profile email',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // Rotate with subset scope
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: createBody.version,
          incomingJti: 'scope-subset-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          requestedScope: 'openid profile', // Subset of allowed scope
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      // Returns the requested subset (since it's valid)
      expect(body.allowedScope).toBe('openid profile');
    });
  });

  describe('Token Not Found / Expired', () => {
    it('should reject rotation of non-existent family', async () => {
      const request = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: 1,
          incomingJti: 'nonexistent-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      // Security: Generic message
      expect(body.error_description).toContain('Refresh token');
    });
  });

  describe('Family Revocation', () => {
    it('should manually revoke token family', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'manual-revoke-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      await rotator.fetch(createRequest);

      // Revoke family
      const revokeRequest = new Request('http://localhost/revoke-family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user_123' }),
      });
      const revokeResponse = await rotator.fetch(revokeRequest);
      expect(revokeResponse.status).toBe(200);

      const revokeBody = (await revokeResponse.json()) as any;
      expect(revokeBody.success).toBe(true);
    });

    it('should handle revocation of non-existent family gracefully', async () => {
      const request = new Request('http://localhost/revoke-family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'nonexistent_user' }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.success).toBe(true);
    });
  });

  describe('Token Validation Endpoint', () => {
    it('should validate active token', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'validate-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // Validate token
      const validateRequest = new Request(
        `http://localhost/validate?userId=user_123&version=${createBody.version}&clientId=client_1`,
        { method: 'GET' }
      );
      const response = await rotator.fetch(validateRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.valid).toBe(true);
    });

    it('should return invalid for non-existent user', async () => {
      const request = new Request(
        'http://localhost/validate?userId=nonexistent&version=1&clientId=client_1',
        { method: 'GET' }
      );

      const response = await rotator.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body.valid).toBe(false);
    });
  });

  describe('Health Check and Status', () => {
    it('should return status endpoint', async () => {
      const request = new Request('http://localhost/status', {
        method: 'GET',
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as any;
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('version', 'v2');
      expect(body).toHaveProperty('families');
      expect(body.families).toHaveProperty('total');
      expect(body.families).toHaveProperty('active');
      expect(body).toHaveProperty('timestamp');
    });

    it('should track family count', async () => {
      // Create a family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'status-test-jti',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      await rotator.fetch(createRequest);

      const statusRequest = new Request('http://localhost/status', {
        method: 'GET',
      });
      const response = await rotator.fetch(statusRequest);
      const body = (await response.json()) as any;

      expect(body.families.total).toBe(1);
      expect(body.families.active).toBe(1);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should reject rotation without required fields', async () => {
      const request = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: 1,
          // Missing incomingJti, userId, clientId
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error).toBe('invalid_request');
    });

    it('should return 404 for unknown endpoints', async () => {
      const request = new Request('http://localhost/unknown', {
        method: 'GET',
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(404);
    });

    it('should handle malformed JSON gracefully', async () => {
      const request = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);
    });
  });

  describe('JTI Mismatch Detection', () => {
    it('should detect JTI mismatch as potential theft', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'jti-mismatch-test',
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as any;

      // Try to rotate with correct version but wrong JTI
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incomingVersion: createBody.version,
          incomingJti: 'wrong-jti', // Wrong JTI!
          userId: 'user_123',
          clientId: 'client_1',
          tenantId: 'default',
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      // Either theft or not found - both indicate invalid token
      expect(body.error).toBe('invalid_grant');
    });
  });
});

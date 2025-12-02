/**
 * RefreshTokenRotator Durable Object Unit Tests (V2)
 *
 * Tests for the version-based Refresh Token Rotation system.
 * V2 uses rtv (Refresh Token Version) for theft detection instead of token string comparison.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RefreshTokenRotator } from '../RefreshTokenRotator';
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
      list: <T>(options?: DurableObjectListOptions): Promise<Map<string, T>> => {
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
}

// Mock Env
const createMockEnv = (): Env => ({}) as Env;

describe('RefreshTokenRotator V2', () => {
  let rotator: RefreshTokenRotator;
  let mockState: MockDurableObjectState;
  let mockEnv: Env;

  beforeEach(() => {
    mockState = new MockDurableObjectState();
    mockEnv = createMockEnv();
    rotator = new RefreshTokenRotator(mockState as unknown as DurableObjectState, mockEnv);
  });

  describe('Token Family Creation', () => {
    it('should create new token family successfully', async () => {
      const request = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jti: 'initial-jti-12345',
          userId: 'user_123',
          clientId: 'client_1',
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
          scope: 'openid',
          ttl: 2592000,
        }),
      });

      const response = await rotator.fetch(request);
      const body = (await response.json()) as any;

      expect(body.version).toBe(1);
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
        }),
      });
      const replayResponse = await rotator.fetch(replayAttempt);
      expect(replayResponse.status).toBe(400);

      const replayBody = (await replayResponse.json()) as any;
      expect(replayBody.error).toBe('invalid_grant');
      expect(replayBody.error_description).toContain('theft');
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
        }),
      });
      const legitResponse = await rotator.fetch(legitimateAttempt);
      expect(legitResponse.status).toBe(400);

      const legitBody = (await legitResponse.json()) as any;
      expect(legitBody.error_description).toContain('not found');
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
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      // Family is keyed by userId, so wrong userId means family not found
      expect(body.error_description).toContain('not found');
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
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error_description).toContain('mismatch');
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
          requestedScope: 'openid profile email admin', // Trying to amplify scope!
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error_description).toContain('scope');
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
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as any;
      expect(body.error_description).toContain('not found');
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

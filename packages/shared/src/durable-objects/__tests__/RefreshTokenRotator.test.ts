/**
 * RefreshTokenRotator Durable Object Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('RefreshTokenRotator', () => {
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
          token: 'rt_initial_token',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid profile',
          ttl: 2592000, // 30 days
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(201);

      const body = (await response.json()) as { familyId: string; expiresAt: number };
      expect(body).toHaveProperty('familyId');
      expect(body).toHaveProperty('expiresAt');
      expect(body.familyId).toMatch(/^family_/);
    });

    it('should reject family creation without required fields', async () => {
      const request = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_token',
          // Missing userId, clientId, scope
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should initialize family with rotation count 0', async () => {
      const request = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_initial',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });

      const createResponse = await rotator.fetch(request);
      const createBody = (await createResponse.json()) as { familyId: string };
      const familyId = createBody.familyId;

      // Get family info
      const infoRequest = new Request(`http://localhost/family/${familyId}`, {
        method: 'GET',
      });
      const infoResponse = await rotator.fetch(infoRequest);
      const infoBody = (await infoResponse.json()) as {
        rotationCount: number;
        tokenCount: { current: number; previous: number };
      };

      expect(infoBody.rotationCount).toBe(0);
      expect(infoBody.tokenCount.current).toBe(1);
      expect(infoBody.tokenCount.previous).toBe(0);
    });
  });

  describe('Atomic Token Rotation', () => {
    it('should rotate token successfully', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_original',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid profile',
          ttl: 2592000,
        }),
      });
      await rotator.fetch(createRequest);

      // Rotate token
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_original',
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        newToken: string;
        rotationCount: number;
        familyId: string;
        expiresIn: number;
      };
      expect(body.newToken).toBeDefined();
      expect(body.newToken).toMatch(/^rt_/);
      expect(body.newToken).not.toBe('rt_original');
      expect(body.rotationCount).toBe(1);
      expect(body.familyId).toBeDefined();
      expect(body.expiresIn).toBeGreaterThan(0);
    });

    it('should increment rotation count on each rotation', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_token_1',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as { familyId: string };

      // Rotate 3 times
      let currentToken = 'rt_token_1';
      for (let i = 1; i <= 3; i++) {
        const rotateRequest = new Request('http://localhost/rotate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentToken,
            userId: 'user_123',
            clientId: 'client_1',
          }),
        });

        const response = await rotator.fetch(rotateRequest);
        const body = (await response.json()) as { rotationCount: number; newToken: string };

        expect(body.rotationCount).toBe(i);
        currentToken = body.newToken;
      }

      // Verify final state
      const infoRequest = new Request(`http://localhost/family/${createBody.familyId}`, {
        method: 'GET',
      });
      const infoResponse = await rotator.fetch(infoRequest);
      const infoBody = (await infoResponse.json()) as {
        rotationCount: number;
        tokenCount: { previous: number };
      };

      expect(infoBody.rotationCount).toBe(3);
      expect(infoBody.tokenCount.previous).toBe(3);
    });

    it('should track previous tokens in rotation chain', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_token_1',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as { familyId: string };

      // Rotate twice
      const rotate1 = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_token_1',
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });
      const response1 = await rotator.fetch(rotate1);
      const body1 = (await response1.json()) as { newToken: string };

      const rotate2 = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: body1.newToken,
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });
      await rotator.fetch(rotate2);

      // Check family info
      const infoRequest = new Request(`http://localhost/family/${createBody.familyId}`, {
        method: 'GET',
      });
      const infoResponse = await rotator.fetch(infoRequest);
      const infoBody = (await infoResponse.json()) as { tokenCount: { previous: number } };

      expect(infoBody.tokenCount.previous).toBe(2);
    });
  });

  describe('Theft Detection (Replay Attack)', () => {
    it('should detect token replay and revoke family', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_theft_test',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      await rotator.fetch(createRequest);

      // First rotation (legitimate)
      const rotate1 = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_theft_test',
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });
      const response1 = await rotator.fetch(rotate1);
      const body1 = (await response1.json()) as { newToken: string };

      // Second rotation (legitimate)
      const rotate2 = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: body1.newToken,
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });
      const response2 = await rotator.fetch(rotate2);
      expect(response2.status).toBe(200);

      // Attempt to reuse old token (THEFT!)
      const replayAttempt = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_theft_test', // Old token from 2 rotations ago
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });
      const replayResponse = await rotator.fetch(replayAttempt);
      expect(replayResponse.status).toBe(400);

      const replayBody = (await replayResponse.json()) as {
        error: string;
        error_description: string;
        action: string;
      };
      expect(replayBody.error).toBe('invalid_grant');
      expect(replayBody.error_description).toContain('theft detected');
      expect(replayBody.action).toBe('all_tokens_revoked');
    });

    it('should revoke all tokens after theft detection', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_revoke_test',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as { familyId: string };

      // Rotate token
      const rotate = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_revoke_test',
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });
      const rotateResponse = await rotator.fetch(rotate);
      const rotateBody = (await rotateResponse.json()) as { newToken: string };

      // Trigger theft detection with old token
      const replayAttempt = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_revoke_test',
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
          currentToken: rotateBody.newToken,
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });
      const legitResponse = await rotator.fetch(legitimateAttempt);
      expect(legitResponse.status).toBe(400);

      const legitBody = (await legitResponse.json()) as { error_description: string };
      expect(legitBody.error_description).toContain('not found or expired');

      // Verify family is completely gone
      const infoRequest = new Request(`http://localhost/family/${createBody.familyId}`, {
        method: 'GET',
      });
      const infoResponse = await rotator.fetch(infoRequest);
      expect(infoResponse.status).toBe(404);
    });
  });

  describe('Token Ownership Validation', () => {
    it('should reject rotation with wrong userId', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_user_test',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      await rotator.fetch(createRequest);

      // Try to rotate with different user
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_user_test',
          userId: 'user_456', // Wrong user!
          clientId: 'client_1',
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error_description: string };
      expect(body.error_description).toContain('mismatch');
    });

    it('should reject rotation with wrong clientId', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_client_test',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      await rotator.fetch(createRequest);

      // Try to rotate with different client
      const rotateRequest = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_client_test',
          userId: 'user_123',
          clientId: 'client_2', // Wrong client!
        }),
      });

      const response = await rotator.fetch(rotateRequest);
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error_description: string };
      expect(body.error_description).toContain('mismatch');
    });
  });

  describe('Token Not Found / Expired', () => {
    it('should reject rotation of non-existent token', async () => {
      const request = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_nonexistent',
          userId: 'user_123',
          clientId: 'client_1',
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error_description: string };
      expect(body.error_description).toContain('not found or expired');
    });
  });

  describe('Family Revocation', () => {
    it('should manually revoke token family', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_manual_revoke',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as { familyId: string };

      // Revoke family
      const revokeRequest = new Request('http://localhost/revoke-family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          familyId: createBody.familyId,
          reason: 'user_logout',
        }),
      });
      const revokeResponse = await rotator.fetch(revokeRequest);
      expect(revokeResponse.status).toBe(200);

      const revokeBody = (await revokeResponse.json()) as { success: boolean };
      expect(revokeBody.success).toBe(true);

      // Verify family is gone
      const infoRequest = new Request(`http://localhost/family/${createBody.familyId}`, {
        method: 'GET',
      });
      const infoResponse = await rotator.fetch(infoRequest);
      expect(infoResponse.status).toBe(404);
    });

    it('should handle revocation of non-existent family gracefully', async () => {
      const request = new Request('http://localhost/revoke-family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          familyId: 'family_nonexistent',
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  describe('Family Info Endpoint', () => {
    it('should return family information without exposing tokens', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_info_test',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid profile email',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as { familyId: string };

      // Get family info
      const infoRequest = new Request(`http://localhost/family/${createBody.familyId}`, {
        method: 'GET',
      });
      const response = await rotator.fetch(infoRequest);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        id: string;
        userId: string;
        clientId: string;
        scope: string;
        rotationCount: number;
        createdAt: number;
        lastRotation: number;
        expiresAt: number;
        tokenCount: unknown;
        currentToken?: unknown;
        previousTokens?: unknown;
      };
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('userId', 'user_123');
      expect(body).toHaveProperty('clientId', 'client_1');
      expect(body).toHaveProperty('scope', 'openid profile email');
      expect(body).toHaveProperty('rotationCount', 0);
      expect(body).toHaveProperty('createdAt');
      expect(body).toHaveProperty('lastRotation');
      expect(body).toHaveProperty('expiresAt');
      expect(body).toHaveProperty('tokenCount');

      // Ensure actual tokens are NOT exposed
      expect(body).not.toHaveProperty('currentToken');
      expect(body).not.toHaveProperty('previousTokens');
    });

    it('should return 404 for non-existent family', async () => {
      const request = new Request('http://localhost/family/family_nonexistent', {
        method: 'GET',
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(404);
    });
  });

  describe('Health Check and Status', () => {
    it('should return status endpoint with stats', async () => {
      const request = new Request('http://localhost/status', {
        method: 'GET',
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        status: string;
        families: unknown;
        tokens: unknown;
        config: { defaultTtl: number; maxPreviousTokens: number };
        timestamp: number;
      };
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('families');
      expect(body).toHaveProperty('tokens');
      expect(body).toHaveProperty('config');
      expect(body).toHaveProperty('timestamp');
      expect(body.config).toHaveProperty('defaultTtl');
      expect(body.config).toHaveProperty('maxPreviousTokens');
    });

    it('should track active vs expired families', async () => {
      // Create a family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_status_test',
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
      const body = (await response.json()) as {
        families: { total: number; active: number; expired: number };
      };

      expect(body.families.total).toBe(1);
      expect(body.families.active).toBe(1);
      expect(body.families.expired).toBe(0);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should reject rotation without required fields', async () => {
      const request = new Request('http://localhost/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentToken: 'rt_test',
          // Missing userId and clientId
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should reject family revocation without familyId', async () => {
      const request = new Request('http://localhost/revoke-family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'test',
          // Missing familyId
        }),
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(400);
    });

    it('should return 404 for unknown endpoints', async () => {
      const request = new Request('http://localhost/unknown', {
        method: 'GET',
      });

      const response = await rotator.fetch(request);
      expect(response.status).toBe(404);
    });
  });

  describe('Previous Tokens Limit', () => {
    it('should limit previous tokens to MAX_PREVIOUS_TOKENS', async () => {
      // Create family
      const createRequest = new Request('http://localhost/family', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'rt_limit_test',
          userId: 'user_123',
          clientId: 'client_1',
          scope: 'openid',
          ttl: 2592000,
        }),
      });
      const createResponse = await rotator.fetch(createRequest);
      const createBody = (await createResponse.json()) as { familyId: string };

      // Rotate 10 times (MAX_PREVIOUS_TOKENS is 5)
      let currentToken = 'rt_limit_test';
      for (let i = 0; i < 10; i++) {
        const rotateRequest = new Request('http://localhost/rotate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentToken,
            userId: 'user_123',
            clientId: 'client_1',
          }),
        });
        const response = await rotator.fetch(rotateRequest);
        const body = (await response.json()) as { newToken: string };
        currentToken = body.newToken;
      }

      // Check family info
      const infoRequest = new Request(`http://localhost/family/${createBody.familyId}`, {
        method: 'GET',
      });
      const infoResponse = await rotator.fetch(infoRequest);
      const infoBody = (await infoResponse.json()) as { tokenCount: { previous: number } };

      // Should only keep last 5 previous tokens
      expect(infoBody.tokenCount.previous).toBeLessThanOrEqual(5);
    });
  });
});

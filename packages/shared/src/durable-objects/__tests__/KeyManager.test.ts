import { describe, it, expect, beforeEach } from 'vitest';
import { KeyManager } from '../KeyManager';
import type { Env } from '../../types/env';

/**
 * Mock implementation of DurableObjectState for testing
 */
class MockDurableObjectState {
  public storage = {
    map: new Map<string, unknown>(),

    get: async <T>(key: string): Promise<T | undefined> => {
      return this.storage.map.get(key) as T | undefined;
    },

    put: async <T>(key: string, value: T): Promise<void> => {
      this.storage.map.set(key, value);
    },

    delete: async (key: string): Promise<void> => {
      this.storage.map.delete(key);
    },

    list: async (): Promise<Map<string, unknown>> => {
      return new Map(this.storage.map);
    },
  };

  constructor() {
    // Ensure storage methods are bound to the storage object
    this.storage = {
      map: new Map<string, unknown>(),
      get: this.get.bind(this),
      put: this.put.bind(this),
      delete: this.delete.bind(this),
      list: this.list.bind(this),
    };
  }

  /**
   * Mock blockConcurrencyWhile - executes callback immediately
   * In production, this blocks all requests until the callback completes
   */
  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return await callback();
  }

  private async get<T>(key: string): Promise<T | undefined> {
    return this.storage.map.get(key) as T | undefined;
  }

  private async put<T>(key: string, value: T): Promise<void> {
    this.storage.map.set(key, value);
  }

  private async delete(key: string): Promise<void> {
    this.storage.map.delete(key);
  }

  private async list(): Promise<Map<string, unknown>> {
    return new Map(this.storage.map);
  }
}

/**
 * Create a mock environment with required bindings
 */
function createMockEnv(secret?: string): Env {
  return {
    KEY_MANAGER_SECRET: secret || 'test-secret-token',
    ISSUER_URL: 'https://test.example.com',
    TOKEN_EXPIRY: '3600',
    CODE_EXPIRY: '600',
    STATE_EXPIRY: '600',
    NONCE_EXPIRY: '600',
    // KV namespaces are not needed for KeyManager tests
  } as Env;
}

/**
 * Create an HTTP request for testing
 */
function createRequest(
  path: string,
  method: string = 'GET',
  auth?: string,
  body?: unknown
): Request {
  const headers = new Headers();
  if (auth) {
    headers.set('Authorization', `Bearer ${auth}`);
  }
  if (body) {
    headers.set('Content-Type', 'application/json');
  }

  return new Request(`https://test.example.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('KeyManager Durable Object', () => {
  let state: MockDurableObjectState;
  let env: Env;
  let keyManager: KeyManager;

  beforeEach(() => {
    state = new MockDurableObjectState();
    env = createMockEnv();
    keyManager = new KeyManager(state as unknown as DurableObjectState, env);
  });

  describe('Authentication', () => {
    it('should require authentication for all endpoints except /jwks', async () => {
      // Note: /jwks is public because it only returns public keys for JWT verification
      const protectedEndpoints = [
        { path: '/active', method: 'GET' },
        { path: '/rotate', method: 'POST' },
        { path: '/should-rotate', method: 'GET' },
        { path: '/config', method: 'GET' },
        { path: '/config', method: 'POST' },
        { path: '/emergency-rotate', method: 'POST' },
        { path: '/status', method: 'GET' },
      ];

      for (const endpoint of protectedEndpoints) {
        const request = createRequest(endpoint.path, endpoint.method);
        const response = await keyManager.fetch(request);

        expect(response.status).toBe(401);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data).toHaveProperty('error', 'Unauthorized');
      }
    });

    it('should allow public access to /jwks endpoint', async () => {
      // First, rotate to create a key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // /jwks should be accessible without authentication
      const request = createRequest('/jwks', 'GET'); // No auth token
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty('keys');
    });

    it('should reject requests with invalid Bearer token', async () => {
      const request = createRequest('/active', 'GET', 'invalid-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(401);
    });

    it('should accept requests with valid Bearer token', async () => {
      const request = createRequest('/active', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      // Should not be 401 (may be 404 if no active key exists)
      expect(response.status).not.toBe(401);
    });

    it('should reject requests without Authorization header', async () => {
      const request = createRequest('/active', 'GET');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(401);
    });

    it('should reject requests when KEY_MANAGER_SECRET is not configured', async () => {
      const envNoSecret = createMockEnv(undefined);
      envNoSecret.KEY_MANAGER_SECRET = undefined;
      const kmNoSecret = new KeyManager(state as unknown as DurableObjectState, envNoSecret);

      const request = createRequest('/active', 'GET', 'any-token');
      const response = await kmNoSecret.fetch(request);

      expect(response.status).toBe(401);
    });
  });

  describe('Private Key Protection', () => {
    it('should not expose private keys in /active endpoint', async () => {
      // First, rotate to create a key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Get active key
      const activeRequest = createRequest('/active', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(activeRequest);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      // Should not contain privatePEM
      expect(data).not.toHaveProperty('privatePEM');
      // Should contain safe fields
      expect(data).toHaveProperty('kid');
      expect(data).toHaveProperty('publicJWK');
      expect(data).toHaveProperty('createdAt');
      expect(data).toHaveProperty('status');
    });

    it('should not expose private keys in /rotate endpoint', async () => {
      const request = createRequest('/rotate', 'POST', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.success).toBe(true);
      expect(data.key).not.toHaveProperty('privatePEM');
      expect(data.key).toHaveProperty('kid');
      expect(data.key).toHaveProperty('publicJWK');
    });

    it('should expose private keys in /internal/active-with-private endpoint', async () => {
      // First, rotate to create a key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Get active key with private
      const request = createRequest('/internal/active-with-private', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      // Should contain privatePEM for internal use
      expect(data).toHaveProperty('privatePEM');
      expect(data).toHaveProperty('kid');
      expect(data).toHaveProperty('publicJWK');
    });
  });

  describe('Key Generation', () => {
    it('should generate a new key with crypto.randomUUID()', async () => {
      const key1 = await keyManager.generateNewKey();
      const key2 = await keyManager.generateNewKey();

      // Key IDs should be unique
      expect(key1.kid).not.toBe(key2.kid);

      // Key ID format should match pattern: key-{timestamp}-{uuid}
      expect(key1.kid).toMatch(/^key-\d+-[0-9a-f-]+$/);
      expect(key2.kid).toMatch(/^key-\d+-[0-9a-f-]+$/);
    });

    it('should generate keys with correct properties including status', async () => {
      const key = await keyManager.generateNewKey();

      expect(key).toHaveProperty('kid');
      expect(key).toHaveProperty('publicJWK');
      expect(key).toHaveProperty('privatePEM');
      expect(key).toHaveProperty('createdAt');
      expect(key).toHaveProperty('status');

      expect(typeof key.kid).toBe('string');
      expect(typeof key.publicJWK).toBe('object');
      expect(typeof key.privatePEM).toBe('string');
      expect(typeof key.createdAt).toBe('number');
      // New keys start as overlap until set as active
      expect(key.status).toBe('overlap');
    });
  });

  describe('Key Status Management', () => {
    it('should set key status to active after rotation', async () => {
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      const response = await keyManager.fetch(rotateRequest);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.key.status).toBe('active');
    });

    it('should set previous active key to overlap status after rotation', async () => {
      // First rotation
      const rotate1 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response1 = await keyManager.fetch(rotate1);
      const data1 = (await response1.json()) as Record<string, unknown>;
      const firstKid = data1.key.kid;

      // Second rotation
      const rotate2 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response2 = await keyManager.fetch(rotate2);
      const data2 = (await response2.json()) as Record<string, unknown>;

      expect(data2.key.status).toBe('active');
      expect(data2.key.kid).not.toBe(firstKid);

      // Check status endpoint to verify first key is now overlap
      const statusRequest = createRequest('/status', 'GET', 'test-secret-token');
      const statusResponse = await keyManager.fetch(statusRequest);
      const statusData = (await statusResponse.json()) as Record<string, unknown>;

      const firstKey = statusData.keys.find((k: { kid: string }) => k.kid === firstKid);
      expect(firstKey.status).toBe('overlap');
      expect(firstKey).toHaveProperty('expiresAt');
    });

    it('should exclude revoked keys from JWKS', async () => {
      // Create and rotate keys
      const rotate1 = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotate1);

      // Emergency rotate to revoke the first key
      const emergencyRequest = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'Test key compromise scenario',
      });
      await keyManager.fetch(emergencyRequest);

      // Get JWKS
      const jwksRequest = createRequest('/jwks', 'GET');
      const jwksResponse = await keyManager.fetch(jwksRequest);
      const jwksData = (await jwksResponse.json()) as Record<string, unknown>;

      // Should only have the new active key, not the revoked one
      expect(jwksData.keys.length).toBe(1);

      // Get status to verify revoked key exists but not in JWKS
      const statusRequest = createRequest('/status', 'GET', 'test-secret-token');
      const statusResponse = await keyManager.fetch(statusRequest);
      const statusData = (await statusResponse.json()) as Record<string, unknown>;

      // Should have 2 keys in status (one revoked, one active)
      expect(statusData.keys.length).toBe(2);
      const revokedKey = statusData.keys.find((k: { status: string }) => k.status === 'revoked');
      expect(revokedKey).toBeDefined();
    });
  });

  describe('Key Rotation', () => {
    it('should rotate keys successfully', async () => {
      const request = createRequest('/rotate', 'POST', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.success).toBe(true);
      expect(data.key).toBeDefined();
      expect(data.key.kid).toBeDefined();
    });

    it('should set new key as active after rotation', async () => {
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      const rotateResponse = await keyManager.fetch(rotateRequest);
      const rotateData = (await rotateResponse.json()) as Record<string, unknown>;
      const newKid = rotateData.key.kid;

      const activeRequest = createRequest('/active', 'GET', 'test-secret-token');
      const activeResponse = await keyManager.fetch(activeRequest);
      const activeData = (await activeResponse.json()) as Record<string, unknown>;

      expect(activeData.kid).toBe(newKid);
      expect(activeData.status).toBe('active');
    });

    it('should handle multiple rotations', async () => {
      const rotateRequest1 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response1 = await keyManager.fetch(rotateRequest1);
      const data1 = (await response1.json()) as Record<string, unknown>;

      const rotateRequest2 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response2 = await keyManager.fetch(rotateRequest2);
      const data2 = (await response2.json()) as Record<string, unknown>;

      // Keys should be different
      expect(data1.key.kid).not.toBe(data2.key.kid);

      // Latest key should be active
      const activeRequest = createRequest('/active', 'GET', 'test-secret-token');
      const activeResponse = await keyManager.fetch(activeRequest);
      const activeData = (await activeResponse.json()) as Record<string, unknown>;

      expect(activeData.kid).toBe(data2.key.kid);
    });
  });

  describe('Emergency Key Rotation', () => {
    it('should perform emergency rotation successfully', async () => {
      // First create an active key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Emergency rotate
      const request = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'Private key compromised - detected in public repository',
      });
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data).toHaveProperty('oldKid');
      expect(data).toHaveProperty('newKid');
      expect(data.oldKid).not.toBe(data.newKid);
    });

    it('should immediately revoke old key on emergency rotation', async () => {
      // Create active key
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      const rotateResponse = await keyManager.fetch(rotateRequest);
      const rotateData = (await rotateResponse.json()) as Record<string, unknown>;
      const oldKid = rotateData.key.kid;

      // Emergency rotate
      const emergencyRequest = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'Key compromise detected in logs',
      });
      await keyManager.fetch(emergencyRequest);

      // Check status
      const statusRequest = createRequest('/status', 'GET', 'test-secret-token');
      const statusResponse = await keyManager.fetch(statusRequest);
      const statusData = (await statusResponse.json()) as Record<string, unknown>;

      const oldKey = statusData.keys.find((k: { kid: string }) => k.kid === oldKid);
      expect(oldKey.status).toBe('revoked');
      expect(oldKey).toHaveProperty('revokedAt');
      expect(oldKey.revokedReason).toBe('Key compromise detected in logs');
    });

    it('should require reason for emergency rotation', async () => {
      // Create active key first
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Try emergency rotate without reason
      const request = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {});
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe('Bad Request');
    });

    it('should require minimum 10 characters for reason', async () => {
      // Create active key first
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      await keyManager.fetch(rotateRequest);

      // Try with short reason
      const request = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'short',
      });
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(400);
    });

    it('should fail if no active key exists', async () => {
      // Try emergency rotate without any keys
      const request = createRequest('/emergency-rotate', 'POST', 'test-secret-token', {
        reason: 'Testing without active key',
      });
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(500);
    });
  });

  describe('Status Endpoint', () => {
    it('should return status of all keys', async () => {
      // Create some keys
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/status', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data).toHaveProperty('keys');
      expect(data).toHaveProperty('activeKeyId');
      expect(data).toHaveProperty('lastRotation');
      expect(Array.isArray(data.keys)).toBe(true);
      expect(data.keys.length).toBe(2);
    });

    it('should not expose private keys in status endpoint', async () => {
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/status', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);
      const data = (await response.json()) as Record<string, unknown>;

      for (const key of data.keys) {
        expect(key).not.toHaveProperty('privatePEM');
        expect(key).not.toHaveProperty('publicJWK');
        expect(key).toHaveProperty('kid');
        expect(key).toHaveProperty('status');
        expect(key).toHaveProperty('createdAt');
      }
    });
  });

  describe('JWKS Endpoint', () => {
    it('should return all public keys except revoked', async () => {
      // Rotate to create some keys
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/jwks', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data).toHaveProperty('keys');
      expect(Array.isArray(data.keys)).toBe(true);
      // Should have 2 keys (1 active, 1 overlap)
      expect(data.keys.length).toBe(2);
    });
  });

  describe('Configuration', () => {
    it('should return default configuration', async () => {
      const request = createRequest('/config', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const config = (await response.json()) as Record<string, unknown>;

      expect(config).toHaveProperty('rotationIntervalDays');
      expect(config).toHaveProperty('retentionPeriodDays');
      expect(config.rotationIntervalDays).toBe(90);
      expect(config.retentionPeriodDays).toBe(30);
    });

    it('should update configuration', async () => {
      const newConfig = {
        rotationIntervalDays: 60,
        retentionPeriodDays: 15,
      };

      const updateRequest = createRequest('/config', 'POST', 'test-secret-token', newConfig);
      const updateResponse = await keyManager.fetch(updateRequest);

      expect(updateResponse.status).toBe(200);
      const updateData = (await updateResponse.json()) as Record<string, unknown>;
      expect(updateData.success).toBe(true);

      // Verify configuration was updated
      const getRequest = createRequest('/config', 'GET', 'test-secret-token');
      const getResponse = await keyManager.fetch(getRequest);
      const config = (await getResponse.json()) as Record<string, unknown>;

      expect(config.rotationIntervalDays).toBe(60);
      expect(config.retentionPeriodDays).toBe(15);
    });
  });

  describe('Rotation Check', () => {
    it('should indicate rotation needed when no keys exist', async () => {
      const request = createRequest('/should-rotate', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      expect(data.shouldRotate).toBe(true);
    });

    it('should indicate rotation not needed after recent rotation', async () => {
      // Rotate to create a key
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/should-rotate', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;

      // Should not need rotation immediately after rotating
      expect(data.shouldRotate).toBe(false);
    });
  });

  describe('Migration (isActive to status)', () => {
    it('should migrate old isActive schema to new status schema', async () => {
      // Simulate old schema data
      const oldSchemaState = {
        keys: [
          {
            kid: 'old-key-1',
            publicJWK: { kty: 'RSA', n: 'test', e: 'AQAB' },
            privatePEM: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
            createdAt: Date.now() - 1000000,
            isActive: false,
          },
          {
            kid: 'old-key-2',
            publicJWK: { kty: 'RSA', n: 'test2', e: 'AQAB' },
            privatePEM: '-----BEGIN PRIVATE KEY-----\ntest2\n-----END PRIVATE KEY-----',
            createdAt: Date.now(),
            isActive: true,
          },
        ],
        activeKeyId: 'old-key-2',
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: Date.now(),
      };

      // Set old schema data directly
      await state.storage.put('state', oldSchemaState);

      // Create new KeyManager instance to trigger migration
      const newKeyManager = new KeyManager(state as unknown as DurableObjectState, env);

      // Access status endpoint to trigger initialization and migration
      const request = createRequest('/status', 'GET', 'test-secret-token');
      const response = await newKeyManager.fetch(request);
      const data = (await response.json()) as Record<string, unknown>;

      // Check migration worked
      const key1 = data.keys.find((k: { kid: string }) => k.kid === 'old-key-1');
      const key2 = data.keys.find((k: { kid: string }) => k.kid === 'old-key-2');

      expect(key1.status).toBe('overlap'); // was isActive: false
      expect(key2.status).toBe('active'); // was isActive: true
      expect(key1).not.toHaveProperty('isActive');
      expect(key2).not.toHaveProperty('isActive');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 when no active key exists', async () => {
      const request = createRequest('/active', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(404);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toContain('No active key found');
    });

    it('should return 404 for unknown endpoints', async () => {
      const request = createRequest('/unknown', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(404);
    });
  });
});

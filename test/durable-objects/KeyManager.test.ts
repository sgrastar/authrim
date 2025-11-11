import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyManager } from '../../src/durable-objects/KeyManager';
import type { Env } from '../../src/types/env';

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
    it('should require authentication for all endpoints', async () => {
      const endpoints = [
        { path: '/active', method: 'GET' },
        { path: '/jwks', method: 'GET' },
        { path: '/rotate', method: 'POST' },
        { path: '/should-rotate', method: 'GET' },
        { path: '/config', method: 'GET' },
        { path: '/config', method: 'POST' },
      ];

      for (const endpoint of endpoints) {
        const request = createRequest(endpoint.path, endpoint.method);
        const response = await keyManager.fetch(request);

        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data).toHaveProperty('error', 'Unauthorized');
      }
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
      const data = await response.json();

      // Should not contain privatePEM
      expect(data).not.toHaveProperty('privatePEM');
      // Should contain safe fields
      expect(data).toHaveProperty('kid');
      expect(data).toHaveProperty('publicJWK');
      expect(data).toHaveProperty('createdAt');
      expect(data).toHaveProperty('isActive');
    });

    it('should not expose private keys in /rotate endpoint', async () => {
      const request = createRequest('/rotate', 'POST', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.key).not.toHaveProperty('privatePEM');
      expect(data.key).toHaveProperty('kid');
      expect(data.key).toHaveProperty('publicJWK');
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

    it('should generate keys with correct properties', async () => {
      const key = await keyManager.generateNewKey();

      expect(key).toHaveProperty('kid');
      expect(key).toHaveProperty('publicJWK');
      expect(key).toHaveProperty('privatePEM');
      expect(key).toHaveProperty('createdAt');
      expect(key).toHaveProperty('isActive');

      expect(typeof key.kid).toBe('string');
      expect(typeof key.publicJWK).toBe('object');
      expect(typeof key.privatePEM).toBe('string');
      expect(typeof key.createdAt).toBe('number');
      expect(key.isActive).toBe(false);
    });
  });

  describe('Key Rotation', () => {
    it('should rotate keys successfully', async () => {
      const request = createRequest('/rotate', 'POST', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.key).toBeDefined();
      expect(data.key.kid).toBeDefined();
    });

    it('should set new key as active after rotation', async () => {
      const rotateRequest = createRequest('/rotate', 'POST', 'test-secret-token');
      const rotateResponse = await keyManager.fetch(rotateRequest);
      const rotateData = await rotateResponse.json();
      const newKid = rotateData.key.kid;

      const activeRequest = createRequest('/active', 'GET', 'test-secret-token');
      const activeResponse = await keyManager.fetch(activeRequest);
      const activeData = await activeResponse.json();

      expect(activeData.kid).toBe(newKid);
      expect(activeData.isActive).toBe(true);
    });

    it('should handle multiple rotations', async () => {
      const rotateRequest1 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response1 = await keyManager.fetch(rotateRequest1);
      const data1 = await response1.json();

      const rotateRequest2 = createRequest('/rotate', 'POST', 'test-secret-token');
      const response2 = await keyManager.fetch(rotateRequest2);
      const data2 = await response2.json();

      // Keys should be different
      expect(data1.key.kid).not.toBe(data2.key.kid);

      // Latest key should be active
      const activeRequest = createRequest('/active', 'GET', 'test-secret-token');
      const activeResponse = await keyManager.fetch(activeRequest);
      const activeData = await activeResponse.json();

      expect(activeData.kid).toBe(data2.key.kid);
    });
  });

  describe('JWKS Endpoint', () => {
    it('should return all public keys', async () => {
      // Rotate to create some keys
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/jwks', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data).toHaveProperty('keys');
      expect(Array.isArray(data.keys)).toBe(true);
      expect(data.keys.length).toBeGreaterThan(0);
    });
  });

  describe('Configuration', () => {
    it('should return default configuration', async () => {
      const request = createRequest('/config', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const config = await response.json();

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
      const updateData = await updateResponse.json();
      expect(updateData.success).toBe(true);

      // Verify configuration was updated
      const getRequest = createRequest('/config', 'GET', 'test-secret-token');
      const getResponse = await keyManager.fetch(getRequest);
      const config = await getResponse.json();

      expect(config.rotationIntervalDays).toBe(60);
      expect(config.retentionPeriodDays).toBe(15);
    });
  });

  describe('Rotation Check', () => {
    it('should indicate rotation needed when no keys exist', async () => {
      const request = createRequest('/should-rotate', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.shouldRotate).toBe(true);
    });

    it('should indicate rotation not needed after recent rotation', async () => {
      // Rotate to create a key
      await keyManager.fetch(createRequest('/rotate', 'POST', 'test-secret-token'));

      const request = createRequest('/should-rotate', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      // Should not need rotation immediately after rotating
      expect(data.shouldRotate).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 when no active key exists', async () => {
      const request = createRequest('/active', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain('No active key found');
    });

    it('should return 404 for unknown endpoints', async () => {
      const request = createRequest('/unknown', 'GET', 'test-secret-token');
      const response = await keyManager.fetch(request);

      expect(response.status).toBe(404);
    });
  });
});

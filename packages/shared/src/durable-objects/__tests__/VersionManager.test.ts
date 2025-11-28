import { describe, it, expect, beforeEach } from 'vitest';
import { VersionManager } from '../VersionManager';
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
    ADMIN_API_SECRET: secret || 'test-secret-token',
    ISSUER_URL: 'https://test.example.com',
    TOKEN_EXPIRY: '3600',
    CODE_EXPIRY: '600',
    STATE_EXPIRY: '600',
    NONCE_EXPIRY: '600',
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

describe('VersionManager Durable Object', () => {
  let state: MockDurableObjectState;
  let env: Env;
  let versionManager: VersionManager;

  const testUUID1 = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
  const testUUID2 = 'b2c3d4e5-f6a7-8901-bcde-f01234567890';
  const testDeployTime1 = '2025-11-28T10:00:00Z';
  const testDeployTime2 = '2025-11-28T11:00:00Z';

  beforeEach(() => {
    state = new MockDurableObjectState();
    env = createMockEnv();
    versionManager = new VersionManager(state as unknown as DurableObjectState, env);
  });

  describe('Authentication', () => {
    it('should require authentication for POST /version/:workerName', async () => {
      const request = createRequest('/version/op-auth', 'POST', undefined, {
        uuid: testUUID1,
        deployTime: testDeployTime1,
      });
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data).toHaveProperty('error', 'Unauthorized');
    });

    it('should require authentication for GET /version-manager/status', async () => {
      const request = createRequest('/version-manager/status', 'GET');
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data).toHaveProperty('error', 'Unauthorized');
    });

    it('should allow public access to GET /version/:workerName', async () => {
      // First register a version (with auth)
      const registerRequest = createRequest('/version/op-auth', 'POST', 'test-secret-token', {
        uuid: testUUID1,
        deployTime: testDeployTime1,
      });
      await versionManager.fetch(registerRequest);

      // GET should be accessible without authentication
      const request = createRequest('/version/op-auth', 'GET'); // No auth
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('uuid', testUUID1);
    });

    it('should reject requests with invalid Bearer token', async () => {
      const request = createRequest('/version/op-auth', 'POST', 'invalid-token', {
        uuid: testUUID1,
        deployTime: testDeployTime1,
      });
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(401);
    });

    it('should accept requests with valid Bearer token', async () => {
      const request = createRequest('/version/op-auth', 'POST', 'test-secret-token', {
        uuid: testUUID1,
        deployTime: testDeployTime1,
      });
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(200);
    });

    it('should reject requests when ADMIN_API_SECRET is not configured', async () => {
      const envNoSecret = createMockEnv(undefined);
      envNoSecret.ADMIN_API_SECRET = undefined;
      const vmNoSecret = new VersionManager(state as unknown as DurableObjectState, envNoSecret);

      const request = createRequest('/version/op-auth', 'POST', 'any-token', {
        uuid: testUUID1,
        deployTime: testDeployTime1,
      });
      const response = await vmNoSecret.fetch(request);

      expect(response.status).toBe(401);
    });
  });

  describe('Version Registration', () => {
    it('should register a version successfully', async () => {
      const request = createRequest('/version/op-auth', 'POST', 'test-secret-token', {
        uuid: testUUID1,
        deployTime: testDeployTime1,
      });
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('success', true);
    });

    it('should require uuid field', async () => {
      const request = createRequest('/version/op-auth', 'POST', 'test-secret-token', {
        deployTime: testDeployTime1,
      });
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).toHaveProperty('error', 'Bad Request');
    });

    it('should require deployTime field', async () => {
      const request = createRequest('/version/op-auth', 'POST', 'test-secret-token', {
        uuid: testUUID1,
      });
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).toHaveProperty('error', 'Bad Request');
    });

    it('should allow updating version for the same worker', async () => {
      // Register first version
      const request1 = createRequest('/version/op-auth', 'POST', 'test-secret-token', {
        uuid: testUUID1,
        deployTime: testDeployTime1,
      });
      await versionManager.fetch(request1);

      // Register second version (update)
      const request2 = createRequest('/version/op-auth', 'POST', 'test-secret-token', {
        uuid: testUUID2,
        deployTime: testDeployTime2,
      });
      await versionManager.fetch(request2);

      // Verify the version was updated
      const getRequest = createRequest('/version/op-auth', 'GET');
      const response = await versionManager.fetch(getRequest);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.uuid).toBe(testUUID2);
      expect(data.deployTime).toBe(testDeployTime2);
    });
  });

  describe('Version Retrieval', () => {
    it('should return version for a registered worker', async () => {
      // Register version
      const registerRequest = createRequest('/version/op-auth', 'POST', 'test-secret-token', {
        uuid: testUUID1,
        deployTime: testDeployTime1,
      });
      await versionManager.fetch(registerRequest);

      // Get version
      const getRequest = createRequest('/version/op-auth', 'GET');
      const response = await versionManager.fetch(getRequest);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('uuid', testUUID1);
      expect(data).toHaveProperty('deployTime', testDeployTime1);
      expect(data).toHaveProperty('registeredAt');
    });

    it('should return 404 for unregistered worker', async () => {
      const request = createRequest('/version/nonexistent-worker', 'GET');
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data).toHaveProperty('error', 'Version not found');
    });
  });

  describe('Multiple Worker Management', () => {
    it('should manage versions for multiple workers independently', async () => {
      // Register versions for different workers
      const workers = ['op-auth', 'op-token', 'op-management', 'op-userinfo'];

      for (let i = 0; i < workers.length; i++) {
        const request = createRequest(`/version/${workers[i]}`, 'POST', 'test-secret-token', {
          uuid: `uuid-${i}-${testUUID1.substring(5)}`,
          deployTime: testDeployTime1,
        });
        await versionManager.fetch(request);
      }

      // Verify each worker has the correct version
      for (let i = 0; i < workers.length; i++) {
        const request = createRequest(`/version/${workers[i]}`, 'GET');
        const response = await versionManager.fetch(request);
        const data = await response.json();

        expect(data.uuid).toBe(`uuid-${i}-${testUUID1.substring(5)}`);
      }
    });

    it('should allow partial updates without affecting other workers', async () => {
      // Register initial versions for two workers
      await versionManager.fetch(
        createRequest('/version/op-auth', 'POST', 'test-secret-token', {
          uuid: testUUID1,
          deployTime: testDeployTime1,
        })
      );

      await versionManager.fetch(
        createRequest('/version/op-token', 'POST', 'test-secret-token', {
          uuid: testUUID1,
          deployTime: testDeployTime1,
        })
      );

      // Update only op-auth
      await versionManager.fetch(
        createRequest('/version/op-auth', 'POST', 'test-secret-token', {
          uuid: testUUID2,
          deployTime: testDeployTime2,
        })
      );

      // Verify op-auth was updated
      const authResponse = await versionManager.fetch(createRequest('/version/op-auth', 'GET'));
      const authData = await authResponse.json();
      expect(authData.uuid).toBe(testUUID2);

      // Verify op-token was NOT changed
      const tokenResponse = await versionManager.fetch(createRequest('/version/op-token', 'GET'));
      const tokenData = await tokenResponse.json();
      expect(tokenData.uuid).toBe(testUUID1);
    });
  });

  describe('Status Endpoint', () => {
    it('should return all registered versions', async () => {
      // Register versions for multiple workers
      await versionManager.fetch(
        createRequest('/version/op-auth', 'POST', 'test-secret-token', {
          uuid: testUUID1,
          deployTime: testDeployTime1,
        })
      );

      await versionManager.fetch(
        createRequest('/version/op-token', 'POST', 'test-secret-token', {
          uuid: testUUID2,
          deployTime: testDeployTime2,
        })
      );

      // Get status (requires auth)
      const request = createRequest('/version-manager/status', 'GET', 'test-secret-token');
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data).toHaveProperty('versions');
      expect(data).toHaveProperty('workerCount', 2);
      expect(data).toHaveProperty('timestamp');
      expect(data.versions['op-auth'].uuid).toBe(testUUID1);
      expect(data.versions['op-token'].uuid).toBe(testUUID2);
    });

    it('should return empty versions when none registered', async () => {
      const request = createRequest('/version-manager/status', 'GET', 'test-secret-token');
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.workerCount).toBe(0);
      expect(Object.keys(data.versions)).toHaveLength(0);
    });
  });

  describe('Worker Name Validation', () => {
    it('should accept valid worker names', async () => {
      const validNames = ['op-auth', 'op-token', 'my-worker-123', 'a'];

      for (const name of validNames) {
        const request = createRequest(`/version/${name}`, 'POST', 'test-secret-token', {
          uuid: testUUID1,
          deployTime: testDeployTime1,
        });
        const response = await versionManager.fetch(request);
        expect(response.status).toBe(200);
      }
    });

    it('should reject invalid worker name patterns', async () => {
      // Worker names with invalid characters should 404 (not match route)
      const invalidNames = ['op_auth', 'Op-Auth', 'op/auth'];

      for (const name of invalidNames) {
        const request = createRequest(`/version/${name}`, 'GET');
        const response = await versionManager.fetch(request);
        // Should return 404 because the route pattern doesn't match
        expect(response.status).toBe(404);
      }
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const request = createRequest('/unknown', 'GET');
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(404);
    });

    it('should return 404 for unsupported methods', async () => {
      const request = createRequest('/version/op-auth', 'DELETE', 'test-secret-token');
      const response = await versionManager.fetch(request);

      expect(response.status).toBe(404);
    });
  });

  describe('State Persistence', () => {
    it('should persist state across instances', async () => {
      // Register a version
      await versionManager.fetch(
        createRequest('/version/op-auth', 'POST', 'test-secret-token', {
          uuid: testUUID1,
          deployTime: testDeployTime1,
        })
      );

      // Create a new instance with the same state
      const newVersionManager = new VersionManager(state as unknown as DurableObjectState, env);

      // Verify the version is still there
      const response = await newVersionManager.fetch(createRequest('/version/op-auth', 'GET'));
      const data = await response.json();

      expect(data.uuid).toBe(testUUID1);
    });
  });
});

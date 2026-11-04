/**
 * Signing Keys Admin API Handlers Tests
 *
 * Tests for the signing key management endpoints:
 * - GET /api/admin/signing-keys/status
 * - POST /api/admin/signing-keys/rotate
 * - POST /api/admin/signing-keys/emergency-rotate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const stepUp = vi.hoisted(() => ({ gate: vi.fn(async (): Promise<Response | null> => null) }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp.gate,
  refuseAdminFreshAuth: vi.fn(),
}));
import { Hono } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  adminSigningKeysStatusHandler,
  adminSigningKeysRotateHandler,
  adminSigningKeysEmergencyRotateHandler,
} from '../signing-keys';

const audit = vi.hoisted(() => ({ write: vi.fn(async () => {}) }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuditLogFromContext: audit.write,
}));

// Type definitions for test data
interface KeyInfo {
  kid: string;
  status: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

interface StatusResponse {
  keys: KeyInfo[];
  activeKeyId: string;
  lastRotation: number;
}

interface RotationResponse {
  success: boolean;
  message?: string;
  newKeyId?: string;
  revokedKeyId?: string;
  warning?: string;
}

interface ErrorResponse {
  error: string;
  error_description?: string;
}

/**
 * Create a mock KeyManager Durable Object
 */
function createMockKeyManager(
  options: {
    statusResponse?: unknown;
    rotateResponse?: unknown;
    emergencyRotateResponse?: unknown;
    shouldFail?: boolean;
    failMessage?: string;
  } = {}
) {
  const {
    statusResponse = {
      keys: [
        { kid: 'key-123', status: 'active', createdAt: Date.now() },
        {
          kid: 'key-122',
          status: 'overlap',
          createdAt: Date.now() - 86400000,
          expiresAt: Date.now() + 86400000,
        },
      ],
      activeKeyId: 'key-123',
      lastRotation: Date.now(),
    },
    rotateResponse = { kid: 'key-new-456' },
    emergencyRotateResponse = { oldKid: 'key-123', newKid: 'key-emergency-789' },
    shouldFail = false,
    failMessage = 'KeyManager error',
  } = options;

  return {
    // RPC methods used by the actual implementation
    getStatusRpc: vi.fn().mockImplementation(() => {
      if (shouldFail) {
        return Promise.reject(new Error(failMessage));
      }
      return Promise.resolve(statusResponse);
    }),
    rotateKeysRpc: vi.fn().mockImplementation(() => {
      if (shouldFail) {
        return Promise.reject(new Error(failMessage));
      }
      return Promise.resolve(rotateResponse);
    }),
    emergencyRotateKeysRpc: vi.fn().mockImplementation((_reason: string) => {
      if (shouldFail) {
        return Promise.reject(new Error(failMessage));
      }
      return Promise.resolve(emergencyRotateResponse);
    }),
    // Legacy fetch method (kept for backwards compatibility tests if needed)
    fetch: vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const urlObj = new URL(url);
      const path = urlObj.pathname;

      if (shouldFail) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: failMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }

      if (path === '/status' && init?.method === 'GET') {
        return Promise.resolve(
          new Response(JSON.stringify(statusResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }

      if (path === '/rotate' && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify(rotateResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }

      if (path === '/emergency-rotate' && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify(emergencyRotateResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }

      return Promise.resolve(new Response('Not Found', { status: 404 }));
    }),
  };
}

/**
 * Create a mock environment
 */
function createMockD1(): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({}),
    }),
  } as unknown as D1Database;
}

function createMockEnv(keyManagerOptions: Parameters<typeof createMockKeyManager>[0] = {}): Env {
  const mockKeyManager = createMockKeyManager(keyManagerOptions);

  return {
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({ id: 'mock-id' }),
      get: vi.fn().mockReturnValue(mockKeyManager),
    } as unknown as Env['KEY_MANAGER'],
    KEY_MANAGER_SECRET: 'test-secret',
    AUTHRIM_CONFIG: {
      delete: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as KVNamespace,
    DB: createMockD1(),
    DB_PII: createMockD1(),
    ISSUER_URL: 'https://test.example.com',
  } as unknown as Env;
}

/**
 * Create a test Hono app
 */
function createTestApp() {
  const app = new Hono<{
    Bindings: Env;
    Variables: { adminAuth: AdminAuthContext; tenantId: string };
  }>();

  // Mock admin auth middleware by setting adminAuth context
  app.use('/api/admin/*', async (c, next) => {
    c.set('adminAuth', { userId: 'test-admin', authMethod: 'bearer', roles: ['admin'] });
    c.set('tenantId', 'default');
    await next();
  });

  app.get('/api/admin/signing-keys/status', adminSigningKeysStatusHandler);
  app.post('/api/admin/signing-keys/rotate', adminSigningKeysRotateHandler);
  app.post('/api/admin/signing-keys/emergency-rotate', adminSigningKeysEmergencyRotateHandler);

  return app;
}

describe('Signing Keys Admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('GET /api/admin/signing-keys/status', () => {
    it('should return signing keys status', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/status');
      const response = await app.fetch(request, env);

      expect(response.status).toBe(200);
      const data = await response.json<StatusResponse>();

      expect(data).toHaveProperty('keys');
      expect(data).toHaveProperty('activeKeyId');
      expect(data).toHaveProperty('lastRotation');
      expect(Array.isArray(data.keys)).toBe(true);
    });

    it('should include key status information', async () => {
      const app = createTestApp();
      const env = createMockEnv({
        statusResponse: {
          keys: [
            { kid: 'active-key', status: 'active', createdAt: Date.now() },
            {
              kid: 'overlap-key',
              status: 'overlap',
              createdAt: Date.now() - 100000,
              expiresAt: Date.now() + 86400000,
            },
            {
              kid: 'revoked-key',
              status: 'revoked',
              createdAt: Date.now() - 200000,
              revokedAt: Date.now() - 50000,
              revokedReason: 'Compromised',
            },
          ],
          activeKeyId: 'active-key',
          lastRotation: Date.now(),
        },
      });

      const request = new Request('http://localhost/api/admin/signing-keys/status');
      const response = await app.fetch(request, env);
      const data = await response.json<StatusResponse>();

      const activeKey = data.keys.find((k) => k.kid === 'active-key');
      const overlapKey = data.keys.find((k) => k.kid === 'overlap-key');
      const revokedKey = data.keys.find((k) => k.kid === 'revoked-key');

      expect(activeKey?.status).toBe('active');
      expect(overlapKey?.status).toBe('overlap');
      expect(overlapKey).toHaveProperty('expiresAt');
      expect(revokedKey?.status).toBe('revoked');
      expect(revokedKey).toHaveProperty('revokedAt');
      expect(revokedKey).toHaveProperty('revokedReason');
    });

    it('should handle KeyManager errors gracefully', async () => {
      const app = createTestApp();
      const env = createMockEnv({ shouldFail: true });

      const request = new Request('http://localhost/api/admin/signing-keys/status');
      const response = await app.fetch(request, env);

      expect(response.status).toBe(500);
      const data = await response.json<ErrorResponse>();
      expect(data).toHaveProperty('error', 'server_error');
    });

    it('should create audit log for status read', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/status');
      await app.fetch(request, env);

      expect(audit.write).toHaveBeenCalledWith(
        expect.anything(),
        'signing_keys.status.read',
        'signing_keys',
        'key-123',
        { keyCount: 2 },
        'info'
      );
    });
  });

  describe('POST /api/admin/signing-keys/rotate', () => {
    it('should perform normal key rotation', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await app.fetch(request, env);

      expect(response.status).toBe(200);
      const data = await response.json<RotationResponse>();

      expect(data.success).toBe(true);
      expect(data).toHaveProperty('message');
      expect(data).toHaveProperty('newKeyId');
      expect(data.warning).toContain('24 hours');
    });

    it('should invalidate JWKS cache after rotation', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      if (!env.AUTHRIM_CONFIG) throw new Error('Missing test config');
      const deleteCache = vi.spyOn(env.AUTHRIM_CONFIG, 'delete');

      const request = new Request('http://localhost/api/admin/signing-keys/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await app.fetch(request, env);

      // New implementation: JWKS cache key is per-tenant in AUTHRIM_CONFIG
      expect(deleteCache).toHaveBeenCalledWith(expect.stringContaining('cache:jwks:'));
    });

    it('should handle KeyManager errors gracefully', async () => {
      const app = createTestApp();
      const env = createMockEnv({ shouldFail: true });

      const request = new Request('http://localhost/api/admin/signing-keys/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await app.fetch(request, env);

      expect(response.status).toBe(500);
      const data = await response.json<ErrorResponse>();
      expect(data).toHaveProperty('error', 'server_error');
    });

    it('should continue even if JWKS cache invalidation fails', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      // Make AUTHRIM_CONFIG cache deletion fail
      (env.AUTHRIM_CONFIG as unknown as { delete: ReturnType<typeof vi.fn> }).delete = vi
        .fn()
        .mockRejectedValue(new Error('Cache error'));

      const request = new Request('http://localhost/api/admin/signing-keys/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await app.fetch(request, env);

      // Should still succeed
      expect(response.status).toBe(200);
    });

    it('should create audit log with warning severity', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await app.fetch(request, env);

      expect(audit.write).toHaveBeenCalledWith(
        expect.anything(),
        'signing_keys.rotate.normal',
        'signing_keys',
        'key-new-456',
        { oldKeyId: 'previous-key', newKeyId: 'key-new-456', overlapPeriod: '24h' },
        'warning'
      );
    });
  });

  describe('POST /api/admin/signing-keys/emergency-rotate', () => {
    it('should perform emergency key rotation with valid reason', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Private key compromised - detected in public GitHub repository',
        }),
      });
      const response = await app.fetch(request, env);

      expect(response.status).toBe(200);
      const data = await response.json<RotationResponse>();

      expect(data.success).toBe(true);
      expect(data).toHaveProperty('revokedKeyId');
      expect(data).toHaveProperty('newKeyId');
      expect(data.warning).toContain('immediately revoked');
    });

    it('should reject request without reason', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await app.fetch(request, env);

      expect(response.status).toBe(400);
      const data = await response.json<ErrorResponse>();
      expect(data.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD uses standardized message
      expect(data.error_description).toContain('required');
    });

    it('should reject reason shorter than 10 characters', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'too short' }),
      });
      const response = await app.fetch(request, env);

      expect(response.status).toBe(400);
    });

    it('should accept reason with exactly 10 characters', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '1234567890' }), // Exactly 10 chars
      });
      const response = await app.fetch(request, env);

      expect(response.status).toBe(200);
    });

    it('should invalidate JWKS cache immediately', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      if (!env.AUTHRIM_CONFIG) throw new Error('Missing test config');
      const deleteCache = vi.spyOn(env.AUTHRIM_CONFIG, 'delete');

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Key compromise detected in production logs',
        }),
      });
      await app.fetch(request, env);

      // New implementation: JWKS cache key is per-tenant in AUTHRIM_CONFIG
      expect(deleteCache).toHaveBeenCalledWith(expect.stringContaining('cache:jwks:'));
    });

    it('should handle KeyManager errors gracefully', async () => {
      const app = createTestApp();
      const env = createMockEnv({ shouldFail: true });

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Emergency rotation test with failure',
        }),
      });
      const response = await app.fetch(request, env);

      expect(response.status).toBe(500);
      const data = await response.json<ErrorResponse>();
      expect(data).toHaveProperty('error', 'server_error');
    });

    it('should create CRITICAL audit log', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Critical security incident - key exposed',
        }),
      });
      await app.fetch(request, env);

      expect(audit.write).toHaveBeenCalledWith(
        expect.anything(),
        'signing_keys.rotate.emergency',
        'signing_keys',
        'key-emergency-789',
        expect.objectContaining({ reason: 'Critical security incident - key exposed' }),
        'critical'
      );
    });

    it('should continue even if cache invalidation fails', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      (env.AUTHRIM_CONFIG as unknown as { delete: ReturnType<typeof vi.fn> }).delete = vi
        .fn()
        .mockRejectedValue(new Error('Cache unavailable'));

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Emergency with cache failure scenario',
        }),
      });
      const response = await app.fetch(request, env);

      // Should still succeed (cache invalidation is non-blocking)
      expect(response.status).toBe(200);
    });
  });

  describe('Security', () => {
    it('should pass reason to KeyManager in emergency rotation', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      const keyManager = env.KEY_MANAGER.get({} as DurableObjectId);

      const reason = 'Security breach detected - immediate action required';
      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      await app.fetch(request, env);

      // Verify KeyManager RPC was called with the reason
      expect(keyManager.emergencyRotateKeysRpc).toHaveBeenCalledWith(reason);
    });

    it('should call getStatusRpc for status endpoint', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      const keyManager = env.KEY_MANAGER.get({} as DurableObjectId);

      const request = new Request('http://localhost/api/admin/signing-keys/status');
      await app.fetch(request, env);

      // Verify KeyManager RPC was called for status
      expect(keyManager.getStatusRpc).toHaveBeenCalled();
    });
  });
  describe('admin step-up on rotation', () => {
    const refusal = () =>
      new Response(JSON.stringify({ error: 'step_up_required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    const post = (path: string, body: unknown, env: Env) =>
      createTestApp().fetch(
        new Request(`http://localhost/api/admin/signing-keys/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        env
      );

    it('rotates only after the gate lets the request through', async () => {
      const env = createMockEnv();
      const response = await post('rotate', {}, env);

      expect(response.status).toBe(200);
      expect(stepUp.gate).toHaveBeenCalledTimes(1);
      expect(stepUp.gate).toHaveBeenCalledWith(expect.anything(), {
        operation: 'signing_key.rotate',
        targetTenantId: 'default',
        params: { mode: 'normal' },
      });
    });

    it('does not rotate when step-up is refused', async () => {
      stepUp.gate.mockResolvedValueOnce(refusal());
      const env = createMockEnv();
      const response = await post('rotate', {}, env);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'step_up_required' });
      expect(env.KEY_MANAGER.get).not.toHaveBeenCalled();
    });

    it('binds the emergency rotation to its reason', async () => {
      const env = createMockEnv();
      const response = await post(
        'emergency-rotate',
        { reason: 'Key compromise detected in audit' },
        env
      );

      expect(response.status).toBe(200);
      expect(stepUp.gate).toHaveBeenCalledWith(expect.anything(), {
        operation: 'signing_key.rotate',
        targetTenantId: 'default',
        params: { mode: 'emergency', reason: 'Key compromise detected in audit' },
      });
    });

    it('does not run an emergency rotation when step-up is refused', async () => {
      stepUp.gate.mockResolvedValueOnce(refusal());
      const env = createMockEnv();
      const response = await post(
        'emergency-rotate',
        { reason: 'Key compromise detected in audit' },
        env
      );

      expect(response.status).toBe(403);
      expect(env.KEY_MANAGER.get).not.toHaveBeenCalled();
    });

    it('does not spend a receipt on an emergency rotation without a valid reason', async () => {
      const env = createMockEnv();
      const response = await post('emergency-rotate', { reason: 'short' }, env);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(stepUp.gate).not.toHaveBeenCalled();
    });
  });
});

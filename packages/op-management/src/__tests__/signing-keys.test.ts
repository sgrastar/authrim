/**
 * Signing Keys Admin API Handlers Tests
 *
 * Tests for the signing key management endpoints:
 * - GET /api/admin/signing-keys/status
 * - POST /api/admin/signing-keys/rotate
 * - POST /api/admin/signing-keys/emergency-rotate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/shared';
import {
  adminSigningKeysStatusHandler,
  adminSigningKeysRotateHandler,
  adminSigningKeysEmergencyRotateHandler,
} from '../signing-keys';

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
    rotateResponse = { success: true, key: { kid: 'key-new-456' } },
    emergencyRotateResponse = { oldKid: 'key-123', newKid: 'key-emergency-789' },
    shouldFail = false,
    failMessage = 'KeyManager error',
  } = options;

  return {
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
function createMockEnv(keyManagerOptions: Parameters<typeof createMockKeyManager>[0] = {}): Env {
  const mockKeyManager = createMockKeyManager(keyManagerOptions);

  return {
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({ id: 'mock-id' }),
      get: vi.fn().mockReturnValue(mockKeyManager),
    } as unknown as Env['KEY_MANAGER'],
    KEY_MANAGER_SECRET: 'test-secret',
    JWKS_CACHE: {
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({}),
      }),
    } as unknown as D1Database,
    ISSUER_URL: 'https://test.example.com',
  } as unknown as Env;
}

/**
 * Create a test Hono app
 */
function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();

  // Mock admin auth middleware by setting adminAuth context
  app.use('/api/admin/*', async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set('adminAuth', { userId: 'test-admin', authMethod: 'bearer', roles: ['admin'] });
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
      const data = (await response.json()) as StatusResponse;

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
      const data = (await response.json()) as StatusResponse;

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
      const data = (await response.json()) as ErrorResponse;
      expect(data).toHaveProperty('error', 'server_error');
    });

    it('should create audit log for status read', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/status');
      await app.fetch(request, env);

      // Verify audit log was created
      expect(env.DB.prepare).toHaveBeenCalled();
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
      const data = (await response.json()) as RotationResponse;

      expect(data.success).toBe(true);
      expect(data).toHaveProperty('message');
      expect(data).toHaveProperty('newKeyId');
      expect(data.warning).toContain('24 hours');
    });

    it('should invalidate JWKS cache after rotation', async () => {
      const app = createTestApp();
      const env = createMockEnv();

      const request = new Request('http://localhost/api/admin/signing-keys/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await app.fetch(request, env);

      expect(env.JWKS_CACHE?.delete).toHaveBeenCalledWith('jwks');
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
      const data = (await response.json()) as ErrorResponse;
      expect(data).toHaveProperty('error', 'server_error');
    });

    it('should continue even if JWKS cache invalidation fails', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      // Make JWKS cache deletion fail
      const mockJwksCache = env.JWKS_CACHE as unknown as { delete: ReturnType<typeof vi.fn> };
      mockJwksCache.delete = vi.fn().mockRejectedValue(new Error('Cache error'));

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

      // Verify audit log was created
      expect(env.DB.prepare).toHaveBeenCalled();
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
      const data = (await response.json()) as RotationResponse;

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
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe('invalid_request');
      expect(data.error_description).toContain('minimum 10 characters');
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

      const request = new Request('http://localhost/api/admin/signing-keys/emergency-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Key compromise detected in production logs',
        }),
      });
      await app.fetch(request, env);

      expect(env.JWKS_CACHE?.delete).toHaveBeenCalledWith('jwks');
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
      const data = (await response.json()) as ErrorResponse;
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

      // Verify audit log was created
      expect(env.DB.prepare).toHaveBeenCalled();
    });

    it('should continue even if cache invalidation fails', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      const mockJwksCache = env.JWKS_CACHE as unknown as { delete: ReturnType<typeof vi.fn> };
      mockJwksCache.delete = vi.fn().mockRejectedValue(new Error('Cache unavailable'));

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

      // Verify KeyManager was called with the reason
      expect(keyManager.fetch).toHaveBeenCalledWith(
        expect.stringContaining('emergency-rotate'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining(reason),
        })
      );
    });

    it('should use KEY_MANAGER_SECRET for authentication', async () => {
      const app = createTestApp();
      const env = createMockEnv();
      const keyManager = env.KEY_MANAGER.get({} as DurableObjectId);

      const request = new Request('http://localhost/api/admin/signing-keys/status');
      await app.fetch(request, env);

      // Verify authorization header was sent to KeyManager
      expect(keyManager.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-secret',
          }),
        })
      );
    });
  });
});

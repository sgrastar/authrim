/**
 * Tests for Version Check Middleware
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types/env';
import { versionCheckMiddleware, clearVersionCache } from '../version-check';

// Test UUIDs
const CURRENT_VERSION = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const OLD_VERSION = 'b2c3d4e5-f6a7-8901-bcde-f01234567890';
const LATEST_VERSION = 'c3d4e5f6-a7b8-9012-cdef-012345678901';

/**
 * Create a mock VERSION_MANAGER Durable Object namespace
 */
function createMockVersionManager(registeredVersion: string | null = null) {
  const mockStub = {
    fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      const versionMatch = path.match(/^\/version\/([a-z0-9-]+)$/);

      if (versionMatch && request.method === 'GET') {
        if (registeredVersion) {
          return new Response(
            JSON.stringify({
              uuid: registeredVersion,
              deployTime: '2025-11-28T10:00:00Z',
              registeredAt: Date.now(),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        } else {
          return new Response(JSON.stringify({ error: 'Version not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response('Not Found', { status: 404 });
    }),
  };

  return {
    idFromName: vi.fn(() => ({ toString: () => 'mock-id' })),
    get: vi.fn(() => mockStub),
  };
}

// Base mock environment
function createMockEnv(
  options: {
    codeVersionUuid?: string;
    versionManager?: ReturnType<typeof createMockVersionManager> | null;
  } = {}
): Env {
  return {
    ISSUER_URL: 'https://id.example.com',
    TOKEN_EXPIRY: '3600',
    CODE_EXPIRY: '120',
    STATE_EXPIRY: '300',
    NONCE_EXPIRY: '300',
    CODE_VERSION_UUID: options.codeVersionUuid,
    VERSION_MANAGER: options.versionManager as unknown as DurableObjectNamespace,
  } as Env;
}

describe('Version Check Middleware', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    // Reset cache before each test
    clearVersionCache();

    // Create fresh app instance
    app = new Hono<{ Bindings: Env }>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Version Validation', () => {
    it('should allow requests when version matches latest', async () => {
      const mockVM = createMockVersionManager(CURRENT_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it('should return 503 when version is outdated', async () => {
      const mockVM = createMockVersionManager(LATEST_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: OLD_VERSION, // Worker has old version
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');

      const data = await res.json();
      expect(data.error).toBe('service_unavailable');
    });

    it('should include Retry-After header in 503 response', async () => {
      const mockVM = createMockVersionManager(LATEST_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: OLD_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
    });
  });

  describe('Skip Conditions', () => {
    it('should skip when CODE_VERSION_UUID is not set', async () => {
      const mockVM = createMockVersionManager(LATEST_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: undefined, // Not set
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
      // VERSION_MANAGER should NOT be called
      expect(mockVM.idFromName).not.toHaveBeenCalled();
    });

    it('should skip when VERSION_MANAGER binding is not available', async () => {
      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: null, // Not available
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
    });

    it('should allow requests when no version is registered in DO', async () => {
      const mockVM = createMockVersionManager(null); // No version registered
      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
    });
  });

  describe('Caching Behavior', () => {
    // Note: CACHE_TTL_MS is set to 0 for immediate version enforcement,
    // so caching is effectively disabled. Each request queries the DO.
    it('should query DO for each request when CACHE_TTL_MS is 0', async () => {
      const mockVM = createMockVersionManager(CURRENT_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      // First request - hits DO
      await app.request('/test', { method: 'GET' }, mockEnv);

      // Second request - also hits DO (no caching with TTL=0)
      await app.request('/test', { method: 'GET' }, mockEnv);

      // Third request - also hits DO (no caching with TTL=0)
      await app.request('/test', { method: 'GET' }, mockEnv);

      // With CACHE_TTL_MS = 0, VERSION_MANAGER is called for every request
      expect(mockVM.get).toHaveBeenCalledTimes(3);
    });

    it('should clear cache when clearVersionCache is called', async () => {
      const mockVM = createMockVersionManager(CURRENT_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      // First request
      await app.request('/test', { method: 'GET' }, mockEnv);

      // Clear cache
      clearVersionCache('op-auth');

      // Second request - should hit DO again
      await app.request('/test', { method: 'GET' }, mockEnv);

      // VERSION_MANAGER should be called twice (once before cache clear, once after)
      expect(mockVM.get).toHaveBeenCalledTimes(2);
    });

    it('should clear all caches when clearVersionCache is called without argument', async () => {
      const mockVM = createMockVersionManager(CURRENT_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: mockVM,
      });

      // Test with different worker names
      const app1 = new Hono<{ Bindings: Env }>();
      app1.use('*', versionCheckMiddleware('op-auth'));
      app1.get('/test', (c) => c.json({ success: true }));

      const app2 = new Hono<{ Bindings: Env }>();
      app2.use('*', versionCheckMiddleware('op-token'));
      app2.get('/test', (c) => c.json({ success: true }));

      // First requests to populate cache
      await app1.request('/test', { method: 'GET' }, mockEnv);
      await app2.request('/test', { method: 'GET' }, mockEnv);

      // Clear all caches
      clearVersionCache();

      // Create fresh mock to reset call count
      const freshMockVM = createMockVersionManager(CURRENT_VERSION);
      const freshMockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: freshMockVM,
      });

      // Requests should hit DO again
      await app1.request('/test', { method: 'GET' }, freshMockEnv);
      await app2.request('/test', { method: 'GET' }, freshMockEnv);

      // Each worker type should have called DO once
      expect(freshMockVM.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('Worker-Specific Versioning', () => {
    it('should use worker-specific version check', async () => {
      const mockStub = {
        fetch: vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          const path = url.pathname;

          // Check which worker is being requested
          if (path === '/version/op-auth') {
            return new Response(
              JSON.stringify({ uuid: 'auth-version-uuid', deployTime: '2025-11-28T10:00:00Z' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          } else if (path === '/version/op-token') {
            return new Response(
              JSON.stringify({ uuid: 'token-version-uuid', deployTime: '2025-11-28T10:00:00Z' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }

          return new Response(JSON.stringify({ error: 'Version not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      };

      const mockVM = {
        idFromName: vi.fn(() => ({ toString: () => 'mock-id' })),
        get: vi.fn(() => mockStub),
      };

      // op-auth with correct version
      const mockEnvAuth = createMockEnv({
        codeVersionUuid: 'auth-version-uuid',
        versionManager: mockVM,
      });

      const appAuth = new Hono<{ Bindings: Env }>();
      appAuth.use('*', versionCheckMiddleware('op-auth'));
      appAuth.get('/test', (c) => c.json({ success: true }));

      const resAuth = await appAuth.request('/test', { method: 'GET' }, mockEnvAuth);
      expect(resAuth.status).toBe(200);

      // Clear cache for next test
      clearVersionCache();

      // op-token with wrong version
      const mockEnvToken = createMockEnv({
        codeVersionUuid: 'wrong-version',
        versionManager: mockVM,
      });

      const appToken = new Hono<{ Bindings: Env }>();
      appToken.use('*', versionCheckMiddleware('op-token'));
      appToken.get('/test', (c) => c.json({ success: true }));

      const resToken = await appToken.request('/test', { method: 'GET' }, mockEnvToken);
      expect(resToken.status).toBe(503);
    });
  });

  describe('Error Handling (Fail-Open)', () => {
    it('should allow requests when DO throws an error', async () => {
      const mockStub = {
        fetch: vi.fn(async () => {
          throw new Error('DO unavailable');
        }),
      };

      const mockVM = {
        idFromName: vi.fn(() => ({ toString: () => 'mock-id' })),
        get: vi.fn(() => mockStub),
      };

      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      // Should fail-open (allow request to proceed)
      expect(res.status).toBe(200);
    });

    it('should allow requests when DO returns non-200 error', async () => {
      const mockStub = {
        fetch: vi.fn(async () => {
          return new Response(JSON.stringify({ error: 'Internal Error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      };

      const mockVM = {
        idFromName: vi.fn(() => ({ toString: () => 'mock-id' })),
        get: vi.fn(() => mockStub),
      };

      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      // Should fail-open (allow request to proceed)
      expect(res.status).toBe(200);
    });
  });

  describe('Security - Version Not Exposed', () => {
    it('should not expose version UUIDs in 503 response', async () => {
      const mockVM = createMockVersionManager(LATEST_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: OLD_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(503);

      const data = await res.json();

      // Response should not contain version UUIDs
      expect(JSON.stringify(data)).not.toContain(OLD_VERSION);
      expect(JSON.stringify(data)).not.toContain(LATEST_VERSION);

      // Should only contain the generic error
      expect(data).toEqual({ error: 'service_unavailable' });
    });
  });

  describe('Multiple Endpoints', () => {
    it('should check version for all endpoints', async () => {
      const mockVM = createMockVersionManager(CURRENT_VERSION);
      const mockEnv = createMockEnv({
        codeVersionUuid: CURRENT_VERSION,
        versionManager: mockVM,
      });

      app.use('*', versionCheckMiddleware('op-auth'));
      app.get('/api/test1', (c) => c.json({ endpoint: 'test1' }));
      app.post('/api/test2', (c) => c.json({ endpoint: 'test2' }));
      app.get('/health', (c) => c.json({ status: 'ok' }));

      // All endpoints should be checked and allowed
      const res1 = await app.request('/api/test1', { method: 'GET' }, mockEnv);
      expect(res1.status).toBe(200);

      const res2 = await app.request('/api/test2', { method: 'POST' }, mockEnv);
      expect(res2.status).toBe(200);

      const res3 = await app.request('/health', { method: 'GET' }, mockEnv);
      expect(res3.status).toBe(200);
    });
  });
});

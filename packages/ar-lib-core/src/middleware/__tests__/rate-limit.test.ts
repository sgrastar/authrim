/**
 * Tests for Rate Limiting Middleware
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types/env';
import {
  clearCloudProviderCache,
  clearRateLimitConfigCache,
  clearRateLimitFastPathCache,
  formatRateLimitProfileOverride,
  getRateLimitProfileAsync,
  parseRateLimitProfileOverride,
  rateLimitMiddleware,
  RateLimitProfiles,
} from '../rate-limit';

// Mock environment
const mockEnv: Env = {
  ISSUER_URL: 'https://id.example.com',
  ACCESS_TOKEN_EXPIRY: '3600',
  AUTH_CODE_EXPIRY: '120',
  STATE_EXPIRY: '300',
  NONCE_EXPIRY: '300',
  PRIVATE_KEY_PEM: 'mock-private-key',
  PUBLIC_JWK_JSON: '{"kty":"RSA"}',
  KEY_ID: 'test-key-id',
  AUTH_CODES: {} as KVNamespace,
  STATE_STORE: {} as KVNamespace,
  NONCE_STORE: {} as KVNamespace,
  CLIENTS: {} as KVNamespace,
  REVOKED_TOKENS: {} as KVNamespace,
};

// Mock KV storage
const mockKVStore = new Map<string, { value: string; expiration: number }>();

// Mock KV namespace with TTL support
const createMockKV = (): KVNamespace => {
  return {
    get: async (key: string) => {
      const item = mockKVStore.get(key);
      if (!item) return null;

      // Check if expired
      if (item.expiration && Date.now() / 1000 > item.expiration) {
        mockKVStore.delete(key);
        return null;
      }

      return item.value;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      const expiration = options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : 0;

      mockKVStore.set(key, { value, expiration });
    },
    delete: async (key: string) => {
      mockKVStore.delete(key);
    },
  } as unknown as KVNamespace;
};

const createMockRateLimiter = (incrementRpc: ReturnType<typeof vi.fn>): Env['RATE_LIMITER'] => {
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ incrementRpc })),
  } as unknown as Env['RATE_LIMITER'];
};

describe('Rate Limiting Middleware', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    // Reset mock KV store
    mockKVStore.clear();

    // Create fresh app instance
    app = new Hono<{ Bindings: Env }>();

    // Setup mock KV namespace
    mockEnv.STATE_STORE = createMockKV();
    delete (mockEnv as Partial<Env>).RATE_LIMITER;
    delete (mockEnv as Partial<Env>).AUTHRIM_CONFIG;
    delete (mockEnv as Partial<Env>).RATE_LIMIT_PROFILE;
    delete (mockEnv as Partial<Env>).AUTHRIM_DIAGNOSTIC_TIMING_ENABLED;
    clearRateLimitFastPathCache();
    clearRateLimitConfigCache();
    clearCloudProviderCache();
    vi.clearAllMocks();
  });

  describe('Basic Rate Limiting', () => {
    it('uses one global IP counter when tenant partitioning would enable capability brute force', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 60;
      const incrementRpc = vi.fn().mockResolvedValue({
        allowed: true,
        current: 1,
        limit: 5,
        resetAt,
        retryAfter: 0,
      });
      mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 5,
          windowSeconds: 60,
          keyScope: 'global',
        })
      );
      app.get('/test', (c) => c.json({ success: true }));

      const response = await app.request(
        '/test',
        { headers: { 'CF-Connecting-IP': '192.168.1.1' } },
        mockEnv
      );

      expect(response.status).toBe(200);
      expect(incrementRpc).toHaveBeenCalledWith('192.168.1.1', {
        maxRequests: 5,
        windowSeconds: 60,
      });
    });

    it('separates public read buckets from other rate-limited actions', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 60;
      const incrementRpc = vi.fn().mockResolvedValue({
        allowed: true,
        current: 1,
        limit: 5,
        resetAt,
        retryAfter: 0,
      });
      mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 5,
          windowSeconds: 60,
          endpointClass: 'publicRead',
        })
      );
      app.get('/test', (c) => c.json({ success: true }));

      const response = await app.request(
        '/test',
        { headers: { 'CF-Connecting-IP': '192.168.1.1' } },
        mockEnv
      );

      expect(response.status).toBe(200);
      expect(incrementRpc).toHaveBeenCalledWith(
        'tenant:default:rate-limit:publicRead:192.168.1.1',
        {
          maxRequests: 5,
          windowSeconds: 60,
        }
      );
    });

    it('includes endpoint class in diagnostic timing logs', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const resetAt = Math.floor(Date.now() / 1000) + 60;
        const incrementRpc = vi.fn().mockResolvedValue({
          allowed: true,
          current: 1,
          limit: 5,
          resetAt,
          retryAfter: 0,
        });
        mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);
        mockEnv.AUTHRIM_DIAGNOSTIC_TIMING_ENABLED = 'true';
        app.use(
          '*',
          rateLimitMiddleware({
            maxRequests: 5,
            windowSeconds: 60,
            endpointClass: 'publicRead',
          })
        );
        app.get('/api/auth/authentication-methods', (c) => c.json({ success: true }));

        const response = await app.request(
          '/api/auth/authentication-methods',
          {
            headers: {
              'CF-Connecting-IP': '192.168.1.1',
              'X-Diagnostic-Session-Id': 'diag-public-read',
            },
          },
          mockEnv
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('Server-Timing')).toContain('rl_total');
        const logEntries = consoleLogSpy.mock.calls.map(([message]) =>
          JSON.parse(message as string)
        ) as Array<Record<string, unknown>>;
        expect(logEntries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: 'Rate limit timing',
              mode: 'sync',
              endpointClass: 'publicRead',
            }),
          ])
        );
      } finally {
        consoleLogSpy.mockRestore();
      }
    });

    it('fails closed when an endpoint requires the atomic limiter and the binding is absent', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 5,
          windowSeconds: 60,
          keyScope: 'global',
          requireAtomic: true,
        })
      );
      app.get('/test', (c) => c.json({ success: true }));

      const response = await app.request(
        '/test',
        { headers: { 'CF-Connecting-IP': '192.168.1.1' } },
        mockEnv
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
      expect(mockKVStore.size).toBe(0);
    });

    it('should allow requests within rate limit', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 5,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      // Make 5 requests (within limit)
      for (let i = 0; i < 5; i++) {
        const res = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.1',
            },
          },
          mockEnv
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
        expect(res.headers.get('X-RateLimit-Remaining')).toBe(String(4 - i));
        expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();
      }
    });

    it('should block requests exceeding rate limit', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 3,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      // Make 3 requests (within limit)
      for (let i = 0; i < 3; i++) {
        const res = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.1',
            },
          },
          mockEnv
        );

        expect(res.status).toBe(200);
      }

      // 4th request should be rate limited
      const res = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res.status).toBe(429);

      const json = await res.json();
      expect(json.error).toBe('rate_limit_exceeded');
      expect(json.error_description).toContain('Too many requests');
      expect(json.retry_after).toBeDefined();

      expect(res.headers.get('Retry-After')).toBeDefined();
    });

    it('rechecks a freshly relaxed global profile before returning a stale-limit denial', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 60;
      const incrementRpc = vi
        .fn()
        .mockResolvedValueOnce({
          allowed: false,
          current: 11,
          limit: 10,
          resetAt,
          retryAfter: 30,
        })
        .mockResolvedValueOnce({
          allowed: true,
          current: 12,
          limit: 10_000,
          resetAt,
          retryAfter: 0,
        });
      const config = createMockKV();
      await config.put('rate_limit_profile_override', 'loadTest');
      mockEnv.AUTHRIM_CONFIG = config;
      mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);
      app.use('*', rateLimitMiddleware(RateLimitProfiles.strict));
      app.get('/test', (c) => c.json({ success: true }));

      const response = await app.request(
        '/test',
        { headers: { 'CF-Connecting-IP': '192.168.1.1' } },
        mockEnv
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('10000');
      expect(incrementRpc).toHaveBeenNthCalledWith(2, 'tenant:default:rate-limit:192.168.1.1', {
        maxRequests: 10_000,
        windowSeconds: 60,
      });
    });

    it('does not relax a denial with a loadTest override past its expiry', async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const resetAt = Math.floor(now / 1000) + 60;
        const denied = { allowed: false, current: 11, limit: 10, resetAt, retryAfter: 30 };
        const allowed = { allowed: true, current: 12, limit: 10_000, resetAt, retryAfter: 0 };
        const incrementRpc = vi
          .fn()
          .mockResolvedValueOnce(denied)
          .mockResolvedValueOnce(allowed)
          .mockResolvedValue(denied);
        const config = createMockKV();
        await config.put(
          'rate_limit_profile_override',
          formatRateLimitProfileOverride('loadTest', now + 500)
        );
        mockEnv.AUTHRIM_CONFIG = config;
        mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);
        app.use('*', rateLimitMiddleware(RateLimitProfiles.strict));
        app.get('/test', (c) => c.json({ success: true }));
        const request = () =>
          app.request('/test', { headers: { 'CF-Connecting-IP': '192.168.1.1' } }, mockEnv);

        expect((await request()).status).toBe(200);
        // Within the denial check's second, but after the override's expiry.
        now += 600;
        expect((await request()).status).toBe(429);
        // No second try under the expired override's limits.
        expect(incrementRpc).toHaveBeenCalledTimes(3);
      } finally {
        clock.mockRestore();
      }
    });

    it('keeps a denial fail closed when no relaxed override is authoritative', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 60;
      const incrementRpc = vi.fn().mockResolvedValue({
        allowed: false,
        current: 11,
        limit: 10,
        resetAt,
        retryAfter: 30,
      });
      const config = createMockKV();
      await config.put('rate_limit_profile_override', 'strict');
      mockEnv.AUTHRIM_CONFIG = config;
      mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);
      app.use('*', rateLimitMiddleware(RateLimitProfiles.strict));
      app.get('/test', (c) => c.json({ success: true }));

      const response = await app.request(
        '/test',
        { headers: { 'CF-Connecting-IP': '192.168.1.1' } },
        mockEnv
      );

      expect(response.status).toBe(429);
      expect(incrementRpc).toHaveBeenCalledTimes(1);
    });

    it('should track different IPs separately', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 2,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      // IP 1: 2 requests (should succeed)
      for (let i = 0; i < 2; i++) {
        const res = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.1',
            },
          },
          mockEnv
        );

        expect(res.status).toBe(200);
      }

      // IP 2: 2 requests (should also succeed)
      for (let i = 0; i < 2; i++) {
        const res = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.2',
            },
          },
          mockEnv
        );

        expect(res.status).toBe(200);
      }

      // IP 1: 3rd request (should be blocked)
      const res1 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res1.status).toBe(429);

      // IP 2: 3rd request (should also be blocked)
      const res2 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.2',
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(429);
    });
  });

  describe('IP Address Detection', () => {
    it('should use CF-Connecting-IP header when available', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      const res1 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
            'X-Forwarded-For': '10.0.0.1',
          },
        },
        mockEnv
      );

      expect(res1.status).toBe(200);

      // Same CF-Connecting-IP should be rate limited
      const res2 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
            'X-Forwarded-For': '10.0.0.2', // Different X-Forwarded-For
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(429);
    });

    it('should fallback to X-Forwarded-For when CF-Connecting-IP not available', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      const res1 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'X-Forwarded-For': '10.0.0.1',
          },
        },
        mockEnv
      );

      expect(res1.status).toBe(200);

      // Same X-Forwarded-For should be rate limited
      const res2 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'X-Forwarded-For': '10.0.0.1',
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(429);
    });

    it('should handle X-Forwarded-For with multiple IPs', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      const res1 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'X-Forwarded-For': '192.168.1.1, 10.0.0.1, 172.16.0.1',
          },
        },
        mockEnv
      );

      expect(res1.status).toBe(200);

      // Same first IP should be rate limited
      const res2 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'X-Forwarded-For': '192.168.1.1, 10.0.0.2',
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(429);
    });

    it('should fallback to X-Real-IP when others not available', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      const res1 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'X-Real-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res1.status).toBe(200);

      // Same X-Real-IP should be rate limited
      const res2 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'X-Real-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(429);
    });
  });

  describe('Endpoint Filtering', () => {
    it('should only apply to specified endpoints', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
          endpoints: ['/api'],
        })
      );

      app.get('/api/test', (c) => c.json({ success: true }));
      app.get('/public/test', (c) => c.json({ success: true }));

      // First request to /api/test (should succeed)
      const res1 = await app.request(
        '/api/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res1.status).toBe(200);

      // Second request to /api/test (should be rate limited)
      const res2 = await app.request(
        '/api/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(429);

      // Multiple requests to /public/test (should all succeed - no rate limit)
      for (let i = 0; i < 5; i++) {
        const res = await app.request(
          '/public/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.1',
            },
          },
          mockEnv
        );

        expect(res.status).toBe(200);
      }
    });

    async function hit(path: string, method = 'GET') {
      return app.request(path, { method, headers: { 'CF-Connecting-IP': '192.168.1.1' } }, mockEnv);
    }

    it('treats a trailing /* as the child routes of the base path', async () => {
      app.use(
        '/api/items/*',
        rateLimitMiddleware({ maxRequests: 1, windowSeconds: 60, endpoints: ['/api/items/*'] })
      );
      app.all('/api/items/:id/download', (c) => c.json({ ok: true }));
      app.all('/api/items-other/:id', (c) => c.json({ ok: true }));

      expect((await hit('/api/items/a/download')).status).toBe(200);
      expect((await hit('/api/items/a/download')).status).toBe(429);
      // A sibling that merely shares the string prefix is not a child route.
      for (let i = 0; i < 3; i++) {
        expect((await hit('/api/items-other/a')).status).toBe(200);
      }
    });

    it('does not count the base path twice when a base entry and a /* entry are both mounted', async () => {
      app.use(
        '/api/items',
        rateLimitMiddleware({ maxRequests: 2, windowSeconds: 60, endpoints: ['/api/items'] })
      );
      app.use(
        '/api/items/*',
        rateLimitMiddleware({ maxRequests: 2, windowSeconds: 60, endpoints: ['/api/items/*'] })
      );
      app.get('/api/items', (c) => c.json({ ok: true }));

      expect((await hit('/api/items')).status).toBe(200);
      expect((await hit('/api/items')).status).toBe(200);
      expect((await hit('/api/items')).status).toBe(429);
    });

    it.each([
      ['/api/user/consents/*', 'DELETE', '/api/user/consents/client-123'],
      ['/api/user/data-export/*', 'GET', '/api/user/data-export/export-1/download'],
      ['/api/admin/tenants/:tenantId/audit/*', 'GET', '/api/admin/tenants/t1/audit/events'],
    ])('limits child routes registered as %s (%s %s)', async (endpoint, method, path) => {
      app.use(
        '*',
        rateLimitMiddleware({ maxRequests: 1, windowSeconds: 60, endpoints: [endpoint] })
      );
      app.all('*', (c) => c.json({ ok: true }));

      expect((await hit(path, method)).status).toBe(200);
      expect((await hit(path, method)).status).toBe(429);
    });

    it('spends the same budget for a percent-encoded spelling of a limited path', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 2,
          windowSeconds: 60,
          endpoints: ['/api/user/consents/*'],
        })
      );
      app.all('/api/user/consents/:id', (c) => c.json({ ok: true }));

      // Hono routes all three spellings to the same handler.
      expect((await hit('/api/user/consents/client-1', 'DELETE')).status).toBe(200);
      expect((await hit('/api/%75ser/consents/client-1', 'DELETE')).status).toBe(200);
      expect((await hit('/api/user/%63onsents/client-1', 'DELETE')).status).toBe(429);
    });

    it('matches :param segments against any single path segment', async () => {
      app.use(
        '/api/users/:id/lock',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
          endpoints: ['/api/users/:id/lock'],
        })
      );
      app.post('/api/users/:id/lock', (c) => c.json({ ok: true }));

      expect((await hit('/api/users/u1/lock', 'POST')).status).toBe(200);
      expect((await hit('/api/users/u1/lock', 'POST')).status).toBe(429);
    });

    it('should apply to all endpoints when endpoints filter not specified', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
        })
      );

      app.get('/api/test', (c) => c.json({ success: true }));
      app.get('/public/test', (c) => c.json({ success: true }));

      // First request to /api/test
      const res1 = await app.request(
        '/api/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res1.status).toBe(200);

      // Second request to /public/test (different endpoint but same IP, should be rate limited)
      const res2 = await app.request(
        '/public/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(429);
    });
  });

  describe('IP Whitelisting', () => {
    it('should skip rate limiting for whitelisted IPs', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 2,
          windowSeconds: 60,
          skipIPs: ['192.168.1.100'],
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      // Whitelisted IP can make many requests
      for (let i = 0; i < 10; i++) {
        const res = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.100',
            },
          },
          mockEnv
        );

        expect(res.status).toBe(200);
      }

      // Non-whitelisted IP is rate limited normally
      const res1 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res1.status).toBe(200);

      const res2 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(200);

      const res3 = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res3.status).toBe(429);
    });

    it('should support multiple whitelisted IPs', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
          skipIPs: ['192.168.1.100', '10.0.0.1'],
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      // Both whitelisted IPs can make unlimited requests
      for (let i = 0; i < 5; i++) {
        const res1 = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.100',
            },
          },
          mockEnv
        );

        expect(res1.status).toBe(200);

        const res2 = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '10.0.0.1',
            },
          },
          mockEnv
        );

        expect(res2.status).toBe(200);
      }
    });
  });

  describe('Non-blocking read fast path', () => {
    it('allows low-volume GET requests without waiting for the RateLimiter DO result', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 60;
      const incrementRpc = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  allowed: true,
                  current: 1,
                  limit: 2,
                  resetAt,
                  retryAfter: 0,
                }),
              25
            );
          })
      );
      mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);

      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 2,
          windowSeconds: 60,
          nonBlockingRead: true,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('2');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('1');
      expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();
      expect(incrementRpc).toHaveBeenCalledWith('tenant:default:rate-limit:192.168.1.1', {
        maxRequests: 2,
        windowSeconds: 60,
      });
    });

    it('falls back to synchronous DO enforcement after the local fast path limit is reached', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 60;
      const incrementRpc = vi
        .fn()
        .mockResolvedValueOnce({
          allowed: true,
          current: 1,
          limit: 1,
          resetAt,
          retryAfter: 0,
        })
        .mockResolvedValueOnce({
          allowed: false,
          current: 2,
          limit: 1,
          resetAt,
          retryAfter: 60,
        });
      mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);

      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
          nonBlockingRead: true,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      const first = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );
      expect(first.status).toBe(200);

      const second = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(second.status).toBe(429);
      expect(second.headers.get('Retry-After')).toBeDefined();
      expect(incrementRpc).toHaveBeenCalledTimes(2);
    });

    it('keeps POST requests on the synchronous enforcement path', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 60;
      const incrementRpc = vi.fn().mockResolvedValue({
        allowed: false,
        current: 2,
        limit: 1,
        resetAt,
        retryAfter: 60,
      });
      mockEnv.RATE_LIMITER = createMockRateLimiter(incrementRpc);

      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
          nonBlockingRead: true,
        })
      );

      app.post('/test', (c) => c.json({ success: true }));

      const res = await app.request(
        '/test',
        {
          method: 'POST',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res.status).toBe(429);
      expect(incrementRpc).toHaveBeenCalledTimes(1);
    });
  });

  describe('Rate Limit Headers', () => {
    it('should return correct rate limit headers', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 5,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      const res = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res.status).toBe(200);

      expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
      expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();

      // Parse reset timestamp
      const resetTime = parseInt(res.headers.get('X-RateLimit-Reset')!);
      const now = Math.floor(Date.now() / 1000);

      // Reset time should be in the future (within 60 seconds)
      expect(resetTime).toBeGreaterThan(now);
      expect(resetTime).toBeLessThanOrEqual(now + 60);
    });

    it('should decrement X-RateLimit-Remaining on each request', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 3,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      for (let i = 0; i < 3; i++) {
        const res = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.1',
            },
          },
          mockEnv
        );

        expect(res.headers.get('X-RateLimit-Remaining')).toBe(String(2 - i));
      }
    });

    it('should include Retry-After header when rate limited', async () => {
      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      // First request (succeeds)
      await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      // Second request (rate limited)
      const res = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res.status).toBe(429);

      const retryAfter = res.headers.get('Retry-After');
      expect(retryAfter).toBeDefined();

      // Retry-After should be a positive number (seconds)
      expect(parseInt(retryAfter!)).toBeGreaterThan(0);
      expect(parseInt(retryAfter!)).toBeLessThanOrEqual(60);
    });
  });

  describe('Pre-configured Profiles', () => {
    it('should have strict profile (10 req/min)', () => {
      expect(RateLimitProfiles.strict.maxRequests).toBe(10);
      expect(RateLimitProfiles.strict.windowSeconds).toBe(60);
    });

    it('should have moderate profile (60 req/min)', () => {
      expect(RateLimitProfiles.moderate.maxRequests).toBe(60);
      expect(RateLimitProfiles.moderate.windowSeconds).toBe(60);
    });

    it('should have lenient profile (300 req/min)', () => {
      expect(RateLimitProfiles.lenient.maxRequests).toBe(300);
      expect(RateLimitProfiles.lenient.windowSeconds).toBe(60);
    });

    it('should have public read and login start profiles for shared-IP bursts', () => {
      expect(RateLimitProfiles.publicRead).toEqual({ maxRequests: 600, windowSeconds: 60 });
      expect(RateLimitProfiles.loginStart).toEqual({ maxRequests: 300, windowSeconds: 60 });
      expect(RateLimitProfiles.sendChallenge).toEqual({ maxRequests: 30, windowSeconds: 60 });
    });

    it('returns built-in defaults before asynchronously refreshing KV overrides', async () => {
      const settingsKV = createMockKV();
      await settingsKV.put(
        'settings:platform:rate-limit',
        JSON.stringify({
          'rate_limit.public_read': 123,
          'rate_limit.public_read_window_seconds': 45,
        })
      );
      mockEnv.SETTINGS = settingsKV;
      const waitUntil = vi.fn();

      await expect(
        getRateLimitProfileAsync(mockEnv, 'publicRead', {
          waitUntil,
        } as unknown as Parameters<typeof getRateLimitProfileAsync>[2])
      ).resolves.toEqual(RateLimitProfiles.publicRead);

      // One refresh for the profile override, one for the profile's limits.
      expect(waitUntil).toHaveBeenCalledTimes(2);
      await Promise.all(waitUntil.mock.calls.map(([refresh]) => refresh));
      await expect(getRateLimitProfileAsync(mockEnv, 'publicRead')).resolves.toEqual({
        maxRequests: 123,
        windowSeconds: 45,
      });
    });

    it('applies the platform Settings API limits over the older per-profile values', async () => {
      const configKV = createMockKV();
      await configKV.put('rate_limit_strict_max_requests', '50');
      await configKV.put('rate_limit_strict_window_seconds', '45');
      const settingsKV = createMockKV();
      await settingsKV.put(
        'settings:platform:rate-limit',
        JSON.stringify({ 'rate_limit.strict': 25, 'rate_limit.strict_window_seconds': 30 })
      );
      mockEnv.AUTHRIM_CONFIG = configKV;
      mockEnv.SETTINGS = settingsKV;
      const waitUntil = vi.fn();

      await getRateLimitProfileAsync(mockEnv, 'strict', {
        waitUntil,
      } as unknown as Parameters<typeof getRateLimitProfileAsync>[2]);
      await Promise.all(waitUntil.mock.calls.map(([refresh]) => refresh));

      await expect(getRateLimitProfileAsync(mockEnv, 'strict')).resolves.toEqual({
        maxRequests: 25,
        windowSeconds: 30,
      });
    });

    it('no longer reads the older per-profile values', async () => {
      const configKV = createMockKV();
      await configKV.put('rate_limit_moderate_max_requests', '80');
      await configKV.put('rate_limit_moderate_window_seconds', '45');
      mockEnv.AUTHRIM_CONFIG = configKV;
      mockEnv.SETTINGS = createMockKV();
      const waitUntil = vi.fn();

      await getRateLimitProfileAsync(mockEnv, 'moderate', {
        waitUntil,
      } as unknown as Parameters<typeof getRateLimitProfileAsync>[2]);
      await Promise.all(waitUntil.mock.calls.map(([refresh]) => refresh));

      await expect(getRateLimitProfileAsync(mockEnv, 'moderate')).resolves.toEqual(
        RateLimitProfiles.moderate
      );
    });

    it('applies the Settings API limits of every profile, not only strict, moderate and lenient', async () => {
      const configKV = createMockKV();
      await configKV.put('rate_limit_send_challenge_max_requests', '50');
      const settingsKV = createMockKV();
      await settingsKV.put(
        'settings:platform:rate-limit',
        JSON.stringify({ 'rate_limit.send_challenge_window_seconds': 120 })
      );
      mockEnv.AUTHRIM_CONFIG = configKV;
      mockEnv.SETTINGS = settingsKV;
      const waitUntil = vi.fn();

      await getRateLimitProfileAsync(mockEnv, 'sendChallenge', {
        waitUntil,
      } as unknown as Parameters<typeof getRateLimitProfileAsync>[2]);
      await Promise.all(waitUntil.mock.calls.map(([refresh]) => refresh));

      // The older value is not read: the default limit with the Settings API window.
      await expect(getRateLimitProfileAsync(mockEnv, 'sendChallenge')).resolves.toEqual({
        maxRequests: RateLimitProfiles.sendChallenge.maxRequests,
        windowSeconds: 120,
      });
    });

    it('keeps the last limits read when a later refresh fails, instead of the defaults', async () => {
      let fail = false;
      const settingsKV = createMockKV();
      await settingsKV.put(
        'settings:platform:rate-limit',
        JSON.stringify({ 'rate_limit.strict': 1 })
      );
      mockEnv.AUTHRIM_CONFIG = createMockKV();
      mockEnv.SETTINGS = {
        get: vi.fn(async (key: string) => {
          if (fail) throw new Error('kv unavailable');
          return settingsKV.get(key);
        }),
      } as unknown as KVNamespace;
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      const refresh = async () => {
        // Past every cache time (rate limit profiles, settings documents).
        now += 10 * 60 * 1000;
        const waitUntil = vi.fn();
        const config = await getRateLimitProfileAsync(mockEnv, 'strict', {
          waitUntil,
        } as unknown as Parameters<typeof getRateLimitProfileAsync>[2]);
        await Promise.all(waitUntil.mock.calls.map(([refresh]) => refresh));
        return config;
      };

      await refresh();
      expect((await refresh()).maxRequests).toBe(1);
      fail = true;
      await refresh();
      expect((await refresh()).maxRequests).toBe(1);
      clock.mockRestore();
    });

    describe('with a profile override and stores that stop answering', () => {
      let now: number;
      let clock: ReturnType<typeof vi.spyOn>;
      const refreshAll = async (profile: keyof typeof RateLimitProfiles) => {
        // Past every cache time (profiles, override, settings documents).
        now += 10 * 60 * 1000;
        const waitUntil = vi.fn();
        await getRateLimitProfileAsync(mockEnv, profile, {
          waitUntil,
        } as unknown as Parameters<typeof getRateLimitProfileAsync>[2]);
        await Promise.all(waitUntil.mock.calls.map(([refresh]) => refresh));
        return waitUntil;
      };

      beforeEach(() => {
        now = Date.now();
        clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      });
      afterEach(() => clock.mockRestore());

      it('keeps the override and its limits when the stores fail', async () => {
        let fail = false;
        const values = new Map<string, string>([
          ['rate_limit_profile_override', 'strict'],
          [
            'settings:platform:rate-limit',
            JSON.stringify({ 'rate_limit.strict': 1, 'rate_limit.strict_window_seconds': 3600 }),
          ],
        ]);
        const store = {
          get: vi.fn(async (key: string) => {
            if (fail) throw new Error('kv unavailable');
            return values.get(key) ?? null;
          }),
        } as unknown as KVNamespace;
        mockEnv.AUTHRIM_CONFIG = store;
        mockEnv.SETTINGS = store;

        await refreshAll('lenient');
        await refreshAll('lenient');
        await expect(getRateLimitProfileAsync(mockEnv, 'lenient')).resolves.toEqual({
          maxRequests: 1,
          windowSeconds: 3600,
        });

        fail = true;
        await refreshAll('lenient');
        await expect(getRateLimitProfileAsync(mockEnv, 'lenient')).resolves.toEqual({
          maxRequests: 1,
          windowSeconds: 3600,
        });
      });

      it('stops a loadTest override at its expiry, also while the stores fail', async () => {
        let fail = false;
        const values = new Map<string, string>([
          [
            'rate_limit_profile_override',
            formatRateLimitProfileOverride('loadTest', now + 60 * 60 * 1000),
          ],
        ]);
        const store = {
          get: vi.fn(async (key: string) => {
            if (fail) throw new Error('kv unavailable');
            return values.get(key) ?? null;
          }),
        } as unknown as KVNamespace;
        mockEnv.AUTHRIM_CONFIG = store;
        mockEnv.SETTINGS = store;

        await refreshAll('lenient');
        await refreshAll('lenient');
        expect((await getRateLimitProfileAsync(mockEnv, 'lenient')).maxRequests).toBe(10000);

        fail = true;
        await refreshAll('lenient');
        expect((await getRateLimitProfileAsync(mockEnv, 'lenient')).maxRequests).toBe(10000);
        for (let i = 0; i < 4; i++) await refreshAll('lenient');
        // Past the expiry: the endpoint's own profile, not the load-test limits.
        expect((await getRateLimitProfileAsync(mockEnv, 'lenient')).maxRequests).toBe(300);
      });

      it("applies the endpoint's own limits, not the defaults, when an override expires", async () => {
        let fail = false;
        const values = new Map<string, string>([
          [
            'rate_limit_profile_override',
            formatRateLimitProfileOverride('loadTest', now + 60 * 60 * 1000),
          ],
          ['settings:platform:rate-limit', JSON.stringify({ 'rate_limit.strict': 1 })],
        ]);
        const store = {
          get: vi.fn(async (key: string) => {
            if (fail) throw new Error('kv unavailable');
            return values.get(key) ?? null;
          }),
        } as unknown as KVNamespace;
        mockEnv.AUTHRIM_CONFIG = store;
        mockEnv.SETTINGS = store;

        await refreshAll('strict');
        await refreshAll('strict');
        expect((await getRateLimitProfileAsync(mockEnv, 'strict')).maxRequests).toBe(10000);

        fail = true;
        for (let i = 0; i < 7; i++) await refreshAll('strict');
        expect((await getRateLimitProfileAsync(mockEnv, 'strict')).maxRequests).toBe(1);
      });

      it('applies the RATE_LIMIT_PROFILE limits, not the defaults, when an override expires', async () => {
        let fail = false;
        const values = new Map<string, string>([
          ['settings:platform:rate-limit', JSON.stringify({ 'rate_limit.send_challenge': 5 })],
        ]);
        const store = {
          get: vi.fn(async (key: string) => {
            if (fail) throw new Error('kv unavailable');
            return values.get(key) ?? null;
          }),
        } as unknown as KVNamespace;
        mockEnv.AUTHRIM_CONFIG = store;
        mockEnv.SETTINGS = store;
        (mockEnv as Env & { RATE_LIMIT_PROFILE?: string }).RATE_LIMIT_PROFILE = 'sendChallenge';
        try {
          await refreshAll('strict');
          expect((await getRateLimitProfileAsync(mockEnv, 'strict')).maxRequests).toBe(5);

          // A load test starts; the RATE_LIMIT_PROFILE limit changes while it runs.
          values.set(
            'rate_limit_profile_override',
            formatRateLimitProfileOverride('loadTest', now + 60 * 60 * 1000)
          );
          await refreshAll('strict');
          await refreshAll('strict');
          expect((await getRateLimitProfileAsync(mockEnv, 'strict')).maxRequests).toBe(10000);
          values.set(
            'settings:platform:rate-limit',
            JSON.stringify({ 'rate_limit.send_challenge': 1 })
          );
          await refreshAll('strict');
          await refreshAll('strict');

          fail = true;
          for (let i = 0; i < 7; i++) await refreshAll('strict');
          expect((await getRateLimitProfileAsync(mockEnv, 'strict')).maxRequests).toBe(1);
        } finally {
          delete (mockEnv as Env & { RATE_LIMIT_PROFILE?: string }).RATE_LIMIT_PROFILE;
        }
      });

      it('applies an older loadTest override saved without its expiry for at most an hour', async () => {
        let fail = false;
        const store = {
          get: vi.fn(async (key: string) => {
            if (fail) throw new Error('kv unavailable');
            return key === 'rate_limit_profile_override' ? 'loadTest' : null;
          }),
        } as unknown as KVNamespace;
        mockEnv.AUTHRIM_CONFIG = store;
        mockEnv.SETTINGS = store;

        await refreshAll('strict');
        await refreshAll('strict');
        expect((await getRateLimitProfileAsync(mockEnv, 'strict')).maxRequests).toBe(10000);

        fail = true;
        for (let i = 0; i < 7; i++) await refreshAll('strict');
        expect((await getRateLimitProfileAsync(mockEnv, 'strict')).maxRequests).toBe(10);
      });

      it('switches to a new override only once its limits are read', async () => {
        let settingsFail = false;
        const values = new Map<string, string>([
          ['rate_limit_profile_override', 'strict'],
          [
            'settings:platform:rate-limit',
            JSON.stringify({ 'rate_limit.strict': 1, 'rate_limit.lenient': 1 }),
          ],
        ]);
        const store = {
          get: vi.fn(async (key: string) => {
            if (settingsFail && key.startsWith('settings:')) throw new Error('kv unavailable');
            return values.get(key) ?? null;
          }),
        } as unknown as KVNamespace;
        mockEnv.AUTHRIM_CONFIG = store;
        mockEnv.SETTINGS = store;

        await refreshAll('moderate');
        await refreshAll('moderate');
        expect((await getRateLimitProfileAsync(mockEnv, 'moderate')).maxRequests).toBe(1);

        values.set('rate_limit_profile_override', 'lenient');
        settingsFail = true;
        await refreshAll('moderate');
        await refreshAll('moderate');
        // Still strict (1): lenient's limits could not be read, so the switch waits.
        expect((await getRateLimitProfileAsync(mockEnv, 'moderate')).maxRequests).toBe(1);

        settingsFail = false;
        await refreshAll('moderate');
        await refreshAll('moderate');
        expect((await getRateLimitProfileAsync(mockEnv, 'moderate')).maxRequests).toBe(1);
      });

      it('shares one refresh of the overriding profile between profiles', async () => {
        const configKV = createMockKV();
        await configKV.put('rate_limit_profile_override', 'loadTest');
        mockEnv.AUTHRIM_CONFIG = configKV;
        mockEnv.SETTINGS = createMockKV();
        await refreshAll('strict');

        now += 10 * 60 * 1000;
        const get = vi.spyOn(configKV, 'get');
        const waitUntil = vi.fn();
        const ctx = { waitUntil } as unknown as Parameters<typeof getRateLimitProfileAsync>[2];
        await Promise.all([
          getRateLimitProfileAsync(mockEnv, 'strict', ctx),
          getRateLimitProfileAsync(mockEnv, 'moderate', ctx),
          getRateLimitProfileAsync(mockEnv, 'lenient', ctx),
        ]);
        await Promise.all(waitUntil.mock.calls.map(([refresh]) => refresh));

        const reads = get.mock.calls.map(([key]) => key);
        expect(reads.filter((key) => key === 'rate_limit_profile_override')).toHaveLength(1);
      });
    });

    it('keeps the limits it has when the settings cannot be read', async () => {
      mockEnv.AUTHRIM_CONFIG = createMockKV();
      mockEnv.SETTINGS = {
        get: vi.fn().mockRejectedValue(new Error('kv unavailable')),
      } as unknown as KVNamespace;
      const waitUntil = vi.fn();

      await getRateLimitProfileAsync(mockEnv, 'strict', {
        waitUntil,
      } as unknown as Parameters<typeof getRateLimitProfileAsync>[2]);
      await Promise.all(waitUntil.mock.calls.map(([refresh]) => refresh));

      await expect(getRateLimitProfileAsync(mockEnv, 'strict')).resolves.toEqual(
        RateLimitProfiles.strict
      );
    });

    it('should work with strict profile', async () => {
      app.use('*', rateLimitMiddleware(RateLimitProfiles.strict));

      app.get('/test', (c) => c.json({ success: true }));

      // Make 10 requests (within strict limit)
      for (let i = 0; i < 10; i++) {
        const res = await app.request(
          '/test',
          {
            method: 'GET',
            headers: {
              'CF-Connecting-IP': '192.168.1.1',
            },
          },
          mockEnv
        );

        expect(res.status).toBe(200);
      }

      // 11th request should be blocked
      const res = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res.status).toBe(429);
    });
  });

  describe('Error Handling', () => {
    it('should fail close on KV errors (deny request with 503)', async () => {
      // Create a KV that throws errors
      const errorKV = {
        get: async () => {
          throw new Error('KV error');
        },
        put: async () => {
          throw new Error('KV error');
        },
        delete: async () => {
          throw new Error('KV error');
        },
      } as unknown as KVNamespace;

      mockEnv.STATE_STORE = errorKV;

      app.use(
        '*',
        rateLimitMiddleware({
          maxRequests: 1,
          windowSeconds: 60,
        })
      );

      app.get('/test', (c) => c.json({ success: true }));

      // Security: Should deny request on KV errors (fail-close)
      // This prevents rate limit bypass attacks via intentional errors
      const res = await app.request(
        '/test',
        {
          method: 'GET',
          headers: {
            'CF-Connecting-IP': '192.168.1.1',
          },
        },
        mockEnv
      );

      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: string; error_description: string };
      // RFC 6749 5.2: 503 responses should use 'temporarily_unavailable' error code
      expect(json.error).toBe('temporarily_unavailable');
      expect(json.error_description).toContain('temporarily unavailable');
      // RFC 6749: Cache-Control header should be set
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
    });
  });
});

describe('parseRateLimitProfileOverride', () => {
  const now = 1_000_000_000_000;

  it('reads the stored override and the names the older API stored', () => {
    expect(parseRateLimitProfileOverride(null, now)).toBeNull();
    expect(parseRateLimitProfileOverride('strict', now)).toEqual({
      profile: 'strict',
      expiresAt: null,
    });
    expect(
      parseRateLimitProfileOverride(formatRateLimitProfileOverride('publicRead', null), now)
    ).toEqual({ profile: 'publicRead', expiresAt: null });
  });

  it('ignores unknown profiles and what cannot be read', () => {
    expect(parseRateLimitProfileOverride('toString', now)).toBeNull();
    expect(parseRateLimitProfileOverride('{', now)).toBeNull();
    expect(parseRateLimitProfileOverride('{"profile":"strict","expires_at":"x"}', now)).toBeNull();
  });

  it('never lets a loadTest override run past its expiry or an hour', () => {
    const in15 = now + 15 * 60 * 1000;
    expect(
      parseRateLimitProfileOverride(formatRateLimitProfileOverride('loadTest', in15), now)
    ).toEqual({ profile: 'loadTest', expiresAt: in15 });
    expect(parseRateLimitProfileOverride('loadTest', now)).toEqual({
      profile: 'loadTest',
      expiresAt: now + 60 * 60 * 1000,
    });
    expect(
      parseRateLimitProfileOverride(
        formatRateLimitProfileOverride('loadTest', now + 5 * 60 * 60 * 1000),
        now
      )?.expiresAt
    ).toBe(now + 60 * 60 * 1000);
    expect(
      parseRateLimitProfileOverride(formatRateLimitProfileOverride('loadTest', now - 1), now)
    ).toBeNull();
  });
});

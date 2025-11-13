/**
 * Tests for Rate Limiting Middleware
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../src/types/env';
import { rateLimitMiddleware, RateLimitProfiles } from '../../src/middleware/rate-limit';

// Mock environment
const mockEnv: Env = {
  ISSUER_URL: 'https://id.example.com',
  TOKEN_EXPIRY: '3600',
  CODE_EXPIRY: '120',
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

describe('Rate Limiting Middleware', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    // Reset mock KV store
    mockKVStore.clear();

    // Create fresh app instance
    app = new Hono<{ Bindings: Env }>();

    // Setup mock KV namespace
    mockEnv.STATE_STORE = createMockKV();
  });

  describe('Basic Rate Limiting', () => {
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
    it('should fail open on KV errors (allow request)', async () => {
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

      // Should succeed despite KV errors (fail open)
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
    });
  });
});

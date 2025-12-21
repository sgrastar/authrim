/**
 * Rate Limiting Middleware Tests
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Tests:
 * - Sliding window rate limiting
 * - Tier-based rate limits (strict, moderate, lenient)
 * - KV configuration overrides
 * - Graceful degradation when KV unavailable
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  checkRateLimit,
  addRateLimitHeaders,
  getRateLimitConfig,
  setRateLimitConfig,
  clearRateLimitConfig,
  DEFAULT_RATE_LIMIT_CONFIG,
  type RateLimitResult,
} from '../rate-limit';
import type { CheckAuthResult } from '../check-auth';

// =============================================================================
// Mock KV Namespace
// =============================================================================

function createMockKV() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();

  return {
    get: vi.fn(async (key: string) => {
      const item = store.get(key);
      return item?.value ?? null;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  };
}

// =============================================================================
// Test Helpers
// =============================================================================

function createAuthResult(overrides: Partial<CheckAuthResult> = {}): CheckAuthResult {
  return {
    authenticated: true,
    method: 'api_key',
    apiKeyId: 'key-123',
    clientId: 'client-123',
    tenantId: 'tenant-123',
    rateLimitTier: 'moderate',
    allowedOperations: ['check', 'batch'],
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Rate Limiting Middleware', () => {
  describe('getRateLimitConfig', () => {
    test('returns default config when KV not provided', async () => {
      const config = await getRateLimitConfig('strict');
      expect(config).toEqual(DEFAULT_RATE_LIMIT_CONFIG.strict);
    });

    test('returns default config when KV returns null', async () => {
      const mockKV = createMockKV();
      mockKV.get.mockResolvedValue(null);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await getRateLimitConfig('moderate', mockKV as any);
      expect(config).toEqual(DEFAULT_RATE_LIMIT_CONFIG.moderate);
    });

    test('returns KV override when available', async () => {
      const mockKV = createMockKV();
      const customConfig = { requests: 200, windowMs: 30000 };
      mockKV.get.mockResolvedValue(JSON.stringify(customConfig));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await getRateLimitConfig('strict', mockKV as any);
      expect(config).toEqual(customConfig);
    });

    test('falls back to default on KV error', async () => {
      const mockKV = createMockKV();
      mockKV.get.mockRejectedValue(new Error('KV error'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await getRateLimitConfig('lenient', mockKV as any);
      expect(config).toEqual(DEFAULT_RATE_LIMIT_CONFIG.lenient);
    });

    test('falls back to default on invalid JSON', async () => {
      const mockKV = createMockKV();
      mockKV.get.mockResolvedValue('invalid json');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await getRateLimitConfig('strict', mockKV as any);
      expect(config).toEqual(DEFAULT_RATE_LIMIT_CONFIG.strict);
    });

    test('falls back to default on invalid config structure', async () => {
      const mockKV = createMockKV();
      mockKV.get.mockResolvedValue(JSON.stringify({ invalid: 'config' }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await getRateLimitConfig('strict', mockKV as any);
      expect(config).toEqual(DEFAULT_RATE_LIMIT_CONFIG.strict);
    });
  });

  describe('setRateLimitConfig / clearRateLimitConfig', () => {
    test('sets and clears config in KV', async () => {
      const mockKV = createMockKV();
      const customConfig = { requests: 300, windowMs: 120000 };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await setRateLimitConfig('moderate', customConfig, mockKV as any);

      expect(mockKV.put).toHaveBeenCalledWith(
        'ratelimit:config:moderate',
        JSON.stringify(customConfig)
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await clearRateLimitConfig('moderate', mockKV as any);
      expect(mockKV.delete).toHaveBeenCalledWith('ratelimit:config:moderate');
    });
  });

  describe('checkRateLimit', () => {
    let mockCache: ReturnType<typeof createMockKV>;

    beforeEach(() => {
      mockCache = createMockKV();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:30.000Z')); // 30 seconds into window
    });

    test('allows first request', async () => {
      const auth = createAuthResult({ rateLimitTier: 'moderate' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await checkRateLimit(auth, { cache: mockCache as any });

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
      expect(result.limit).toBe(500); // moderate tier
      expect(result.remaining).toBe(499);
    });

    test('tracks request count across calls', async () => {
      const auth = createAuthResult({ rateLimitTier: 'strict' }); // 100/min
      const ctx = { cache: mockCache as unknown as Parameters<typeof checkRateLimit>[1]['cache'] };

      // Simulate 50 requests
      for (let i = 0; i < 50; i++) {
        await checkRateLimit(auth, ctx);
      }

      const result = await checkRateLimit(auth, ctx);
      expect(result.current).toBe(51);
      expect(result.remaining).toBe(49);
      expect(result.allowed).toBe(true);
    });

    test('blocks requests when limit exceeded', async () => {
      const auth = createAuthResult({ rateLimitTier: 'strict' }); // 100/min

      // Pre-set counter to limit
      mockCache._store.set(expect.any(String), { value: '100' });
      mockCache.get.mockResolvedValue('100');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await checkRateLimit(auth, { cache: mockCache as any });

      expect(result.allowed).toBe(false);
      expect(result.current).toBe(100);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    test('allows requests when KV unavailable (graceful degradation)', async () => {
      const auth = createAuthResult({ rateLimitTier: 'strict' });
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await checkRateLimit(auth, { cache: undefined });

      expect(result.allowed).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('rate limiting disabled'));

      consoleSpy.mockRestore();
    });

    test('isolates rate limits by tenant', async () => {
      const auth1 = createAuthResult({ tenantId: 'tenant-a', apiKeyId: 'key-1' });
      const auth2 = createAuthResult({ tenantId: 'tenant-b', apiKeyId: 'key-1' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = { cache: mockCache as any };

      await checkRateLimit(auth1, ctx);
      await checkRateLimit(auth1, ctx);
      const result1 = await checkRateLimit(auth1, ctx);

      const result2 = await checkRateLimit(auth2, ctx);

      // Different tenants should have independent counters
      expect(result1.current).toBe(3);
      expect(result2.current).toBe(1);
    });

    test('isolates rate limits by API key', async () => {
      const auth1 = createAuthResult({ apiKeyId: 'key-a' });
      const auth2 = createAuthResult({ apiKeyId: 'key-b' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = { cache: mockCache as any };

      await checkRateLimit(auth1, ctx);
      await checkRateLimit(auth1, ctx);

      const result2 = await checkRateLimit(auth2, ctx);

      // Different API keys should have independent counters
      expect(result2.current).toBe(1);
    });

    test('handles access token auth (client + subject)', async () => {
      const auth = createAuthResult({
        method: 'access_token',
        apiKeyId: undefined,
        clientId: 'client-abc',
        subjectId: 'user-123',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await checkRateLimit(auth, { cache: mockCache as any });

      expect(result.allowed).toBe(true);
      // Key should include client and subject
      expect(mockCache.put).toHaveBeenCalledWith(
        expect.stringContaining('c:client-abc'),
        expect.any(String),
        expect.any(Object)
      );
    });

    test('handles policy_secret auth', async () => {
      const auth = createAuthResult({
        method: 'policy_secret',
        apiKeyId: undefined,
        clientId: undefined,
        rateLimitTier: 'lenient', // 2000/min
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await checkRateLimit(auth, { cache: mockCache as any });

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(2000);
    });

    test('recovers gracefully on KV error', async () => {
      const auth = createAuthResult();
      mockCache.get.mockRejectedValue(new Error('KV error'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await checkRateLimit(auth, { cache: mockCache as any });

      expect(result.allowed).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error checking rate limit'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    test('uses correct TTL for counter expiration', async () => {
      const auth = createAuthResult({ rateLimitTier: 'strict' }); // 60000ms window

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await checkRateLimit(auth, { cache: mockCache as any });

      // TTL should be window duration (60s) + padding (5s) = 65 seconds
      expect(mockCache.put).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
        expirationTtl: 65,
      });
    });
  });

  describe('addRateLimitHeaders', () => {
    test('adds standard rate limit headers', () => {
      const headers = new Headers();
      const result: RateLimitResult = {
        allowed: true,
        current: 50,
        limit: 100,
        remaining: 50,
        resetAt: 1704067260000, // 2024-01-01T00:01:00.000Z
      };

      addRateLimitHeaders(headers, result);

      expect(headers.get('X-RateLimit-Limit')).toBe('100');
      expect(headers.get('X-RateLimit-Remaining')).toBe('50');
      expect(headers.get('X-RateLimit-Reset')).toBe('1704067260');
    });

    test('adds Retry-After header when blocked', () => {
      const headers = new Headers();
      const result: RateLimitResult = {
        allowed: false,
        current: 100,
        limit: 100,
        remaining: 0,
        resetAt: 1704067260000,
        retryAfter: 30,
      };

      addRateLimitHeaders(headers, result);

      expect(headers.get('Retry-After')).toBe('30');
    });

    test('does not add Retry-After when allowed', () => {
      const headers = new Headers();
      const result: RateLimitResult = {
        allowed: true,
        current: 50,
        limit: 100,
        remaining: 50,
        resetAt: 1704067260000,
      };

      addRateLimitHeaders(headers, result);

      expect(headers.get('Retry-After')).toBeNull();
    });
  });

  describe('Tier configurations', () => {
    test('strict tier: 100 requests per minute', () => {
      expect(DEFAULT_RATE_LIMIT_CONFIG.strict).toEqual({
        requests: 100,
        windowMs: 60000,
      });
    });

    test('moderate tier: 500 requests per minute', () => {
      expect(DEFAULT_RATE_LIMIT_CONFIG.moderate).toEqual({
        requests: 500,
        windowMs: 60000,
      });
    });

    test('lenient tier: 2000 requests per minute', () => {
      expect(DEFAULT_RATE_LIMIT_CONFIG.lenient).toEqual({
        requests: 2000,
        windowMs: 60000,
      });
    });
  });
});

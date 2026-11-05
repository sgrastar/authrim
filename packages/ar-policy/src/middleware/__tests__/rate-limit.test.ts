/**
 * Rate Limiting Middleware Tests
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Tests:
 * - Sliding window rate limiting
 * - Tier-based rate limits (strict, moderate, lenient)
 * - Atomic counting in the RATE_LIMITER Durable Object
 * - Fail closed when the limiter is unavailable
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  checkRateLimit,
  addRateLimitHeaders,
  getRateLimitConfig,
  DEFAULT_RATE_LIMIT_CONFIG,
  RateLimiterUnavailableError,
  type RateLimitResult,
} from '../rate-limit';
import { createRateLimiterStub } from '../../__tests__/rate-limiter-stub';
import type { CheckAuthResult } from '../check-auth';

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
    test.each(['strict', 'moderate', 'lenient'] as const)('returns the fixed %s limit', (tier) => {
      expect(getRateLimitConfig(tier)).toEqual(DEFAULT_RATE_LIMIT_CONFIG[tier]);
    });
  });

  describe('checkRateLimit', () => {
    let limiter: ReturnType<typeof createRateLimiterStub>;
    const ctx = () => ({
      limiter: limiter as unknown as Parameters<typeof checkRateLimit>[1]['limiter'],
    });

    beforeEach(() => {
      limiter = createRateLimiterStub();
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:30.000Z'));
    });

    test('allows first request', async () => {
      const auth = createAuthResult({ rateLimitTier: 'moderate' });
      const result = await checkRateLimit(auth, ctx());

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
      expect(result.limit).toBe(500); // moderate tier
      expect(result.remaining).toBe(499);
    });

    test('tracks request count across calls', async () => {
      const auth = createAuthResult({ rateLimitTier: 'strict' }); // 100/min
      for (let i = 0; i < 50; i++) {
        await checkRateLimit(auth, ctx());
      }

      const result = await checkRateLimit(auth, ctx());
      expect(result.current).toBe(51);
      expect(result.remaining).toBe(49);
      expect(result.allowed).toBe(true);
    });

    test('counts concurrent requests atomically', async () => {
      const auth = createAuthResult({ rateLimitTier: 'strict' }); // 100/min
      const results = await Promise.all(
        Array.from({ length: 101 }, () => checkRateLimit(auth, ctx()))
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(100);
    });

    test('blocks requests when limit exceeded', async () => {
      const auth = createAuthResult({ rateLimitTier: 'strict' }); // 100/min
      for (let i = 0; i < 100; i++) {
        await checkRateLimit(auth, ctx());
      }

      const result = await checkRateLimit(auth, ctx());
      expect(result.allowed).toBe(false);
      expect(result.current).toBe(101);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBe(60);
      expect(result.resetAt).toBe(Date.parse('2024-01-01T00:01:30.000Z'));
    });

    test('refuses requests when the limiter is not bound (fail closed)', async () => {
      const auth = createAuthResult({ rateLimitTier: 'strict' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(checkRateLimit(auth, { limiter: undefined })).rejects.toBeInstanceOf(
        RateLimiterUnavailableError
      );

      consoleSpy.mockRestore();
    });

    test('refuses requests when the limiter fails (fail closed)', async () => {
      const auth = createAuthResult();
      const failing = {
        idFromName: (name: string) => name,
        get: () => ({
          incrementRpc: () => Promise.reject(new Error('DO error')),
        }),
      };
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        checkRateLimit(auth, {
          limiter: failing as unknown as Parameters<typeof checkRateLimit>[1]['limiter'],
        })
      ).rejects.toBeInstanceOf(RateLimiterUnavailableError);

      consoleSpy.mockRestore();
    });

    test('isolates rate limits by tenant', async () => {
      const auth1 = createAuthResult({ tenantId: 'tenant-a', apiKeyId: 'key-1' });
      const auth2 = createAuthResult({ tenantId: 'tenant-b', apiKeyId: 'key-1' });

      await checkRateLimit(auth1, ctx());
      await checkRateLimit(auth1, ctx());
      const result1 = await checkRateLimit(auth1, ctx());
      const result2 = await checkRateLimit(auth2, ctx());

      expect(result1.current).toBe(3);
      expect(result2.current).toBe(1);
    });

    test('isolates rate limits by API key', async () => {
      const auth1 = createAuthResult({ apiKeyId: 'key-a' });
      const auth2 = createAuthResult({ apiKeyId: 'key-b' });

      await checkRateLimit(auth1, ctx());
      await checkRateLimit(auth1, ctx());
      const result2 = await checkRateLimit(auth2, ctx());

      expect(result2.current).toBe(1);
    });

    test('handles access token auth (client + subject)', async () => {
      const auth = createAuthResult({
        method: 'access_token',
        apiKeyId: undefined,
        clientId: 'client-abc',
        subjectId: 'user-123',
      });

      const result = await checkRateLimit(auth, ctx());

      expect(result.allowed).toBe(true);
      // Key should include client and subject
      expect([...limiter.records.keys()]).toEqual([
        expect.stringContaining('c:client-abc:s:user-123'),
      ]);
    });

    test('handles policy_secret auth', async () => {
      const auth = createAuthResult({
        method: 'policy_secret',
        apiKeyId: undefined,
        clientId: undefined,
        rateLimitTier: 'lenient', // 2000/min
      });

      const result = await checkRateLimit(auth, ctx());

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(2000);
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

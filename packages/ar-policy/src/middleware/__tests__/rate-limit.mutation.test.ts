/**
 * Rate limit middleware: mutation-hardening tests.
 *
 * Pins the exact limiter key (it names the Durable Object instance, so changing it would reset
 * every client's counter), the default tier, the error shape and the retryAfter contract.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  addRateLimitHeaders,
  checkRateLimit,
  RateLimiterUnavailableError,
  type RateLimitContext,
} from '../rate-limit';
import type { CheckAuthResult } from '../check-auth';

type IncrementResult = {
  allowed: boolean;
  current: number;
  limit: number;
  resetAt: number;
  retryAfter: number;
};

function spyLimiter(result: Partial<IncrementResult> = {}) {
  const incrementRpc = vi.fn(
    async (_key: string, _config: { windowSeconds: number; maxRequests: number }) => ({
      allowed: true,
      current: 1,
      limit: 0,
      resetAt: 1_700_000_060,
      retryAfter: 0,
      ...result,
    })
  );
  const idFromName = vi.fn((name: string) => `id:${name}`);
  const get = vi.fn((_id: string) => ({ incrementRpc }));
  const limiter = { idFromName, get } as unknown as NonNullable<RateLimitContext['limiter']>;
  return { limiter, idFromName, get, incrementRpc };
}

function auth(overrides: Partial<CheckAuthResult> = {}): CheckAuthResult {
  return { authenticated: true, ...overrides };
}

describe('checkRateLimit limiter key', () => {
  it('isolates an API key by tenant and key id, ignoring client and subject', async () => {
    const { limiter, idFromName, get, incrementRpc } = spyLimiter();
    await checkRateLimit(
      auth({
        method: 'api_key',
        tenantId: 'tenant-1',
        apiKeyId: 'key-1',
        clientId: 'client-1',
        subjectId: 'sub-1',
        rateLimitTier: 'strict',
      }),
      { limiter }
    );

    expect(idFromName).toHaveBeenCalledWith('ratelimit:check::t:tenant-1:k:key-1');
    expect(get).toHaveBeenCalledWith('id:ratelimit:check::t:tenant-1:k:key-1');
    expect(incrementRpc).toHaveBeenCalledWith('ratelimit:check::t:tenant-1:k:key-1', {
      windowSeconds: 60,
      maxRequests: 100,
    });
  });

  it('isolates an access token by tenant, client and subject', async () => {
    const { limiter, idFromName } = spyLimiter();
    await checkRateLimit(
      auth({
        method: 'access_token',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        subjectId: 'sub-1',
      }),
      { limiter }
    );
    expect(idFromName).toHaveBeenCalledWith('ratelimit:check::t:tenant-1:c:client-1:s:sub-1');
  });

  it('omits the subject component when the token has none', async () => {
    const { limiter, idFromName } = spyLimiter();
    await checkRateLimit(
      auth({ method: 'access_token', tenantId: 'tenant-1', clientId: 'client-1' }),
      { limiter }
    );
    expect(idFromName).toHaveBeenCalledWith('ratelimit:check::t:tenant-1:c:client-1');
  });

  it('does not add a subject when the client is unknown', async () => {
    const { limiter, idFromName } = spyLimiter();
    await checkRateLimit(auth({ method: 'access_token', subjectId: 'sub-1' }), { limiter });
    expect(idFromName).toHaveBeenCalledWith('ratelimit:check:');
  });

  it('uses the shared internal bucket for the policy secret', async () => {
    const { limiter, idFromName } = spyLimiter();
    await checkRateLimit(auth({ method: 'policy_secret', tenantId: 'tenant-1' }), { limiter });
    expect(idFromName).toHaveBeenCalledWith('ratelimit:check::t:tenant-1:internal');
  });

  it('omits the tenant component when there is no tenant', async () => {
    const { limiter, idFromName } = spyLimiter();
    await checkRateLimit(auth({ method: 'policy_secret' }), { limiter });
    expect(idFromName).toHaveBeenCalledWith('ratelimit:check::internal');
  });

  it('adds no client component for an unidentified non-secret caller', async () => {
    const { limiter, idFromName } = spyLimiter();
    await checkRateLimit(auth({ method: 'api_key' }), { limiter });
    expect(idFromName).toHaveBeenCalledWith('ratelimit:check:');
  });
});

describe('checkRateLimit limits and results', () => {
  it('defaults to the strict tier when the caller has no tier', async () => {
    const { limiter, incrementRpc } = spyLimiter({ current: 3 });
    const result = await checkRateLimit(auth({ apiKeyId: 'k' }), { limiter });

    expect(incrementRpc.mock.calls[0]?.[1]).toEqual({ windowSeconds: 60, maxRequests: 100 });
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(97);
  });

  it('reports an allowed request without retryAfter and with resetAt in milliseconds', async () => {
    const { limiter } = spyLimiter({ allowed: true, current: 2, resetAt: 1_700_000_060 });
    const result = await checkRateLimit(auth({ rateLimitTier: 'lenient' }), { limiter });

    expect(result).toEqual({
      allowed: true,
      current: 2,
      limit: 2000,
      remaining: 1998,
      resetAt: 1_700_000_060_000,
    });
    expect('retryAfter' in result).toBe(false);
  });

  it('reports a refused request with retryAfter of at least one second', async () => {
    const { limiter } = spyLimiter({ allowed: false, current: 101, retryAfter: 0 });
    const refused = await checkRateLimit(auth({ rateLimitTier: 'strict' }), { limiter });
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfter).toBe(1);

    const later = spyLimiter({ allowed: false, current: 101, retryAfter: 17 });
    const waits = await checkRateLimit(auth({ rateLimitTier: 'strict' }), {
      limiter: later.limiter,
    });
    expect(waits.retryAfter).toBe(17);
  });
});

describe('checkRateLimit fails closed', () => {
  it('throws RateLimiterUnavailableError when no limiter is bound', async () => {
    const error = await checkRateLimit(auth(), {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimiterUnavailableError);
    expect((error as Error).name).toBe('RateLimiterUnavailableError');
    expect((error as Error).message).toBe('Check API rate limiter is unavailable');
  });

  it('wraps a limiter failure and keeps the original as the cause', async () => {
    const failure = new Error('do down');
    const { limiter, incrementRpc } = spyLimiter();
    incrementRpc.mockRejectedValueOnce(failure);

    const error = await checkRateLimit(auth(), { limiter }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimiterUnavailableError);
    expect((error as Error).cause).toBe(failure);
  });

  it('has no cause when constructed without options', () => {
    expect(new RateLimiterUnavailableError().cause).toBeUndefined();
  });
});

describe('addRateLimitHeaders', () => {
  const base = { allowed: true, current: 1, limit: 100, remaining: 99, resetAt: 1_700_000_060_999 };

  it('sets limit, remaining and the reset in whole seconds', () => {
    const headers = new Headers();
    addRateLimitHeaders(headers, base);
    expect(headers.get('X-RateLimit-Limit')).toBe('100');
    expect(headers.get('X-RateLimit-Remaining')).toBe('99');
    expect(headers.get('X-RateLimit-Reset')).toBe('1700000060');
    expect(headers.has('Retry-After')).toBe(false);
  });

  it('sets Retry-After only for a refused request', () => {
    const refused = new Headers();
    addRateLimitHeaders(refused, { ...base, allowed: false, retryAfter: 12 });
    expect(refused.get('Retry-After')).toBe('12');

    const allowedWithRetry = new Headers();
    addRateLimitHeaders(allowedWithRetry, { ...base, allowed: true, retryAfter: 12 });
    expect(allowedWithRetry.has('Retry-After')).toBe(false);

    const refusedNoRetry = new Headers();
    addRateLimitHeaders(refusedNoRetry, { ...base, allowed: false });
    expect(refusedNoRetry.has('Retry-After')).toBe(false);
  });
});

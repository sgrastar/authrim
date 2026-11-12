import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { clearRateLimitConfigCache, clearRateLimitFastPathCache } from '@authrim/ar-lib-core';
import app from '../index';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // Tenant registry resolution is covered elsewhere; this suite is about the limiter counters.
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        const tenantId = c.req.header('X-Test-Tenant') ?? 'default';
        c.set('requestId' as never, 'ciba-limit' as never);
        c.set('tenantId' as never, tenantId as never);
        c.set(
          'logger' as never,
          actual.createLogger({ requestId: 'ciba-limit', tenantId }) as never
        );
        c.set('startTime' as never, Date.now() as never);
        await next();
      },
  };
});

/** A counting RateLimiterCounter stand-in. */
function createEnv() {
  const counters = new Map<string, number>();
  const env = {
    ISSUER_URL: 'https://op.example.com',
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        incrementRpc: async (
          _key: string,
          config: { maxRequests: number; windowSeconds: number }
        ) => {
          const current = (counters.get(id) ?? 0) + 1;
          counters.set(id, current);
          return {
            allowed: current <= config.maxRequests,
            current,
            limit: config.maxRequests,
            resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
            retryAfter: 0,
          };
        },
      }),
    },
  } as unknown as Env;
  return { env, counters };
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const post = (env: Env, path: string, extra: Record<string, string> = {}) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '192.0.2.10',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...extra,
      },
      body: 'client_id=client-1&scope=openid',
    },
    env,
    executionCtx
  );

beforeEach(() => {
  clearRateLimitConfigCache();
  clearRateLimitFastPathCache();
});

describe('POST /bc-authorize per-IP limit', () => {
  it('lets 60 requests per minute through on its own counter, then answers the standard 429', async () => {
    const { env, counters } = createEnv();

    for (let index = 0; index < 60; index++) {
      expect((await post(env, '/bc-authorize')).status).not.toBe(429);
    }
    const refused = await post(env, '/bc-authorize');

    expect(refused.status).toBe(429);
    expect(refused.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(refused.headers.get('Retry-After')).not.toBeNull();
    expect(await refused.json()).toMatchObject({
      error: 'rate_limit_exceeded',
      error_description: 'Too many requests. Please try again later.',
    });
    expect([...counters.keys()]).toEqual([
      'tenant:default:rate-limit:ciba_authorization:192.0.2.10',
    ]);
  });

  it('does not spend or use the device authorization budgets', async () => {
    const { env, counters } = createEnv();
    for (let index = 0; index < 61; index++) await post(env, '/bc-authorize');

    const device = await post(env, '/device_authorization');

    expect(device.status).not.toBe(429);
    expect([...counters.keys()].some((key) => key.includes(':device_authorization:'))).toBe(true);
  });

  it('does not share a tenant budget', async () => {
    const { env } = createEnv();
    for (let index = 0; index < 61; index++) await post(env, '/bc-authorize');

    expect((await post(env, '/bc-authorize', { 'X-Test-Tenant': 'tenant-b' })).status).not.toBe(
      429
    );
  });

  it('refuses with 503 when the atomic counter is unavailable, like /device_authorization', async () => {
    const { env } = createEnv();
    (env as unknown as { RATE_LIMITER?: unknown }).RATE_LIMITER = undefined;

    expect((await post(env, '/bc-authorize')).status).toBe(503);
  });
});

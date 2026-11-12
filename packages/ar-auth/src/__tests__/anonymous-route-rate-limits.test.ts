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
        const ctx = c as unknown as { set(key: string, value: unknown): void };
        ctx.set('requestId', 'anonymous-limits');
        ctx.set('tenantId', tenantId);
        ctx.set('logger', actual.createLogger({ requestId: 'anonymous-limits', tenantId }));
        ctx.set('startTime', Date.now());
        await next();
      },
  };
});

/**
 * Drives the auth app (real routing and real rate-limit middleware) with a counting
 * RateLimiterCounter stand-in, to check which counter each anonymous route spends.
 */
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

const headers = { 'CF-Connecting-IP': '192.0.2.10', 'Content-Type': 'application/json' };

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const post = (env: Env, path: string, extra: Record<string, string> = {}) =>
  app.request(
    path,
    { method: 'POST', headers: { ...headers, ...extra }, body: '{}' },
    env,
    executionCtx
  );

/** Send requests until the route answers 429; returns how many were allowed first. */
async function allowedBeforeRefusal(env: Env, path: string, extra: Record<string, string> = {}) {
  for (let count = 0; count < 200; count++) {
    const response = await post(env, path, extra);
    if (response.status === 429) return { allowed: count, response };
  }
  throw new Error(`${path} was never limited`);
}

const ROUTES = [
  // [path, endpointClass, requests allowed per minute]
  ['/api/auth/passkeys/register/options', 'legacy_passkey_register_options', 60],
  ['/api/auth/email-codes/send', 'legacy_email_code_send', 10],
  ['/api/auth/totp/signup/options', 'totp_signup_options', 60],
  ['/api/auth/dids/challenge', 'did_auth_challenge', 60],
  ['/api/flow/init', 'flow_init', 60],
] as const;

beforeEach(() => {
  clearRateLimitConfigCache();
  clearRateLimitFastPathCache();
});

describe('limits on the anonymous entry points that create state', () => {
  it.each(ROUTES)(
    '%s: counts on its own class and answers 429 over the limit',
    async (path, cls, max) => {
      const { env, counters } = createEnv();

      const { allowed, response } = await allowedBeforeRefusal(env, path);

      expect(allowed).toBe(max);
      expect(response.headers.get('X-RateLimit-Limit')).toBe(String(max));
      expect(response.headers.get('Retry-After')).not.toBeNull();
      expect(await response.json()).toMatchObject({
        error: 'rate_limit_exceeded',
        error_description: 'Too many requests. Please try again later.',
      });
      expect([...counters.keys()]).toEqual([`tenant:default:rate-limit:${cls}:192.0.2.10`]);
    }
  );

  it('lets a request through that is under the limit as before', async () => {
    const { env } = createEnv();

    const response = await post(env, '/api/flow/init');

    expect(response.status).not.toBe(429);
    expect(response.status).not.toBe(503);
  });

  it('keeps every route on a counter of its own', async () => {
    const { env } = createEnv();

    // Use up one route, then the next route of the list still has all of its budget.
    await allowedBeforeRefusal(env, ROUTES[0][0]);
    for (const [path] of ROUTES.slice(1)) {
      expect((await post(env, path)).status).not.toBe(429);
    }
  });

  it('is not throttled by an exhausted class-less limiter, nor does it throttle one', async () => {
    const { env } = createEnv();

    // The guest login limiter has no class: it uses the tenant and IP counter shared by such routes.
    await allowedBeforeRefusal(env, '/api/auth/guest/login');
    for (const [path] of ROUTES) {
      expect((await post(env, path)).status).not.toBe(429);
    }

    const { env: second } = createEnv();
    await allowedBeforeRefusal(second, '/api/flow/init');
    expect((await post(second, '/api/auth/guest/login')).status).not.toBe(429);
  });

  it('does not share a tenant budget', async () => {
    const { env } = createEnv();

    await allowedBeforeRefusal(env, '/api/flow/init');

    expect((await post(env, '/api/flow/init', { 'X-Test-Tenant': 'tenant-b' })).status).not.toBe(
      429
    );
  });
});

describe('sign-in starts and ceremonies stay unlimited by these budgets', () => {
  it('does not count the legacy passkey login options or the unauthenticated admin ceremonies', async () => {
    const { env, counters } = createEnv();

    await post(env, '/api/auth/passkeys/login/options');
    await post(env, '/api/admin/setup-token/verify');
    await post(env, '/api/admin/auth/passkey/options');

    expect([...counters.keys()]).toEqual([]);
  });
});

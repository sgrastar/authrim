import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { clearRateLimitConfigCache, clearRateLimitFastPathCache } from '@authrim/ar-lib-core';
import { app } from '../index';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // Tenant registry resolution is covered elsewhere; this suite is about the limiter counters.
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        c.set('requestId' as never, 'rate-limit-classes' as never);
        c.set('tenantId' as never, 'default' as never);
        c.set(
          'logger' as never,
          actual.createLogger({ requestId: 'rate-limit-classes', tenantId: 'default' }) as never
        );
        c.set('startTime' as never, Date.now() as never);
        await next();
      },
  };
});

/**
 * Drives the management app (real routing and real rate-limit middleware) with a counting
 * RateLimiterCounter stand-in, to check which counter each request spends.
 */
function createEnv(options: { failRateLimiter?: boolean } = {}) {
  const counters = new Map<string, number>();
  const keys: string[] = [];
  const env = {
    ISSUER_URL: 'https://op.example.com',
    RATE_LIMITER: {
      idFromName: (name: string) => {
        keys.push(name);
        return name;
      },
      get: (id: string) => ({
        incrementRpc: async (
          _key: string,
          config: { maxRequests: number; windowSeconds: number }
        ) => {
          if (options.failRateLimiter) throw new Error('rate limiter unavailable');
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
  return { env, counters, keys };
}

const ip = { 'CF-Connecting-IP': '192.0.2.10' };

beforeEach(() => {
  clearRateLimitConfigCache();
  clearRateLimitFastPathCache();
  vi.clearAllMocks();
});

describe('management rate-limit counters', () => {
  it('does not rate limit the liveness probe, even when the limiter backend fails', async () => {
    const { env, keys } = createEnv({ failRateLimiter: true });

    const response = await app.request('/health/live', { headers: ip }, env);

    expect(response.status).not.toBe(503);
    expect(keys).toEqual([]);
  });

  it('keeps Account reads and guest-upgrade POSTs on separate counters', async () => {
    const { env, counters } = createEnv();

    // Nine ordinary Account reads, then the first guest-upgrade POST (strict: 10 per minute).
    for (let index = 0; index < 9; index++) {
      await app.request('/api/account/profile', { headers: ip }, env);
    }
    const response = await app.request(
      '/api/account/guest-upgrade/start',
      { method: 'POST', headers: { ...ip, Origin: 'https://op.example.com' } },
      env
    );

    expect(response.status).not.toBe(429);
    const accountCounter = [...counters.entries()].find(([key]) => key.includes(':mgmt_account:'));
    const guestCounter = [...counters.entries()].find(([key]) =>
      key.includes(':mgmt_account_guest_upgrade:')
    );
    expect(accountCounter?.[1]).toBe(10);
    expect(guestCounter?.[1]).toBe(1);
  });

  it('keeps ordinary SCIM calls and Bulk on separate counters', async () => {
    const { env, counters } = createEnv();

    for (let index = 0; index < 10; index++) {
      await app.request('/scim/v2/Users', { headers: ip }, env);
    }
    const response = await app.request('/scim/v2/Bulk', { method: 'POST', headers: ip }, env);

    expect(response.status).not.toBe(429);
    const scimKeys = [...counters.keys()].filter((key) => key.includes(':mgmt_scim'));
    expect(scimKeys.some((key) => key.includes(':mgmt_scim:'))).toBe(true);
    expect(scimKeys.some((key) => key.includes(':mgmt_scim_bulk:'))).toBe(true);
    expect(counters.get(scimKeys.find((key) => key.includes(':mgmt_scim_bulk:'))!)).toBe(1);
  });

  it('treats an encoded /scim/v2/%42ulk as Bulk and /api/%75ser/... as the user API', async () => {
    const { env, counters } = createEnv();

    await app.request('/scim/v2/%42ulk', { method: 'POST', headers: ip }, env);
    const bulkKey = [...counters.keys()].find((key) => key.includes(':mgmt_scim_bulk:'));
    expect(bulkKey).toBeDefined();
    expect([...counters.keys()].some((key) => key.includes(':mgmt_scim:'))).toBe(false);

    let last = 0;
    for (let index = 0; index < 61; index++) {
      const path =
        index % 2 === 0 ? '/api/user/consents/client-1' : '/api/%75ser/consents/client-1';
      last = (
        await app.request(
          path,
          { method: 'DELETE', headers: { ...ip, Authorization: 'Bearer user-token' } },
          env
        )
      ).status;
    }
    expect(last).toBe(429);
  });

  it('returns 429 from the real middleware once a child route exceeds its budget', async () => {
    const { env } = createEnv();
    // User consents: moderate profile (60 per minute) on the DELETE child route.
    let last = 0;
    for (let index = 0; index < 61; index++) {
      const response = await app.request(
        '/api/user/consents/client-1',
        { method: 'DELETE', headers: { ...ip, Authorization: 'Bearer user-token' } },
        env
      );
      last = response.status;
    }

    expect(last).toBe(429);
  });

  it('gives the public client configuration the shared public-read budget', async () => {
    const { env, counters } = createEnv();

    let last = 0;
    for (let index = 0; index < 100; index++) {
      last = (await app.request('/clients/client-1/config', { headers: ip }, env)).status;
    }

    expect(last).not.toBe(429);
    expect([...counters.keys()].every((key) => key.includes(':publicRead:'))).toBe(true);
  });
});

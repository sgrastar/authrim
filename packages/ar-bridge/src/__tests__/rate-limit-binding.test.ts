import { describe, expect, it, vi } from 'vitest';
import type { Context, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import worker from '../index';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requestContextMiddleware:
      () =>
      async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
        c.set('requestId' as never, 'bridge-rate-limit' as never);
        c.set('tenantId' as never, 'default' as never);
        c.set(
          'logger' as never,
          actual.createLogger({ requestId: 'bridge-rate-limit', tenantId: 'default' }) as never
        );
        c.set('startTime' as never, Date.now() as never);
        await next();
      },
  };
});

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

describe('Bridge /api/external/* rate limit', () => {
  function createEnv(withRateLimiter: boolean) {
    const counters = new Map<string, number>();
    const env = {
      ISSUER_URL: 'https://op.example.com',
      ...(withRateLimiter
        ? {
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
          }
        : {}),
    } as unknown as Env;
    return { env, counters };
  }

  const request = () =>
    new Request('https://op.example.com/api/external/providers', {
      headers: { 'CF-Connecting-IP': '192.0.2.20' },
    });

  it('counts in its own RATE_LIMITER bucket and answers 429 past the budget', async () => {
    const { env, counters } = createEnv(true);
    let last = 0;
    for (let index = 0; index < 61; index++) {
      last = (await worker.fetch(request(), env, executionContext)).status;
    }

    expect(last).toBe(429);
    expect([...counters.keys()].every((key) => key.includes(':bridge_external:'))).toBe(true);
  });

  it('leaves the /auth/external/* and /handoff/* sign-in paths unlimited (shared campus addresses)', async () => {
    const { env, counters } = createEnv(true);

    for (const path of ['/auth/external/providers', '/handoff/verify']) {
      await worker.fetch(
        new Request(`https://op.example.com${path}`, {
          method: path.startsWith('/handoff') ? 'POST' : 'GET',
          headers: { 'CF-Connecting-IP': '192.0.2.20' },
        }),
        env,
        executionContext
      );
    }

    expect([...counters.keys()]).toEqual([]);
  });

  it('answers 503 (fail closed) when the Worker has no rate-limit backend at all', async () => {
    const { env } = createEnv(false);

    const response = await worker.fetch(request(), env, executionContext);

    expect(response.status).toBe(503);
  });
});

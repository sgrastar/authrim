import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  createHealthCheckHandlers: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    module: vi.fn(),
  },
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  mocks.logger.module.mockReturnValue(mocks.logger);
  mocks.createHealthCheckHandlers.mockImplementation(() => ({
    liveness: (c: Context) => c.json({ probe: 'live' }),
    readiness: (c: Context) => c.json({ probe: 'ready' }),
  }));
  return {
    ...actual,
    requestContextMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    pluginContextMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    createHealthCheckHandlers: mocks.createHealthCheckHandlers,
    getLogger: () => mocks.logger,
  };
});

vi.mock('../userinfo', () => ({
  userinfoHandler: (c: Context) => c.json({ handler: 'userinfo', method: c.req.method }),
}));

import app from '../index';

const healthOptions: unknown = mocks.createHealthCheckHandlers.mock.calls[0]?.[0];

function env(extra: Record<string, unknown> = {}): Env {
  return { ENABLE_RATE_LIMIT: 'false', ...extra } as unknown as Env;
}

describe('userinfo app wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('builds the health probes for this service and its dependencies', () => {
    expect(healthOptions).toEqual({
      serviceName: 'op-userinfo',
      version: '0.1.0',
      checkDatabase: true,
      checkKV: true,
    });
  });

  it('serves the probes on their own paths', async () => {
    const live = await app.fetch(new Request('https://op.example.com/health/live'), env());
    expect(await live.json()).toEqual({ probe: 'live' });
    const ready = await app.fetch(new Request('https://op.example.com/health/ready'), env());
    expect(await ready.json()).toEqual({ probe: 'ready' });
  });

  it('answers the liveness alias with the service name and a current timestamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
    const response = await app.fetch(new Request('https://op.example.com/api/health'), env());
    const body = await response.json<{ status: string; service: string; timestamp: string }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('op-userinfo');
    expect(body.timestamp).toBe('2026-11-01T00:00:00.000Z');
  });

  it.each(['GET', 'POST'])('routes %s /userinfo to the handler', async (method) => {
    const response = await app.fetch(
      new Request('https://op.example.com/userinfo', { method }),
      env()
    );
    expect(await response.json()).toEqual({ handler: 'userinfo', method });
  });

  it('answers an unknown path with the standard not-found body', async () => {
    const response = await app.fetch(new Request('https://op.example.com/nope'), env());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'not_found',
      message: 'The requested resource was not found',
    });
  });

  it('reports an unexpected failure under the userinfo log module', async () => {
    const failing = {
      get ENABLE_RATE_LIMIT(): string {
        throw new Error('env exploded');
      },
    } as unknown as Env;
    const response = await app.fetch(new Request('https://op.example.com/userinfo'), failing);
    expect(response.status).toBe(500);
    expect(mocks.logger.module).toHaveBeenCalledWith('USERINFO');
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Unhandled error in UserInfo service',
      { error: 'env exploded' },
      expect.any(Error)
    );
  });

  it('allows the methods and headers the protected routes need in a preflight', async () => {
    const response = await app.fetch(
      new Request('https://op.example.com/api/protected/customer-profiles/users/u1', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://rp.example.com',
          'Access-Control-Request-Method': 'PATCH',
          'Access-Control-Request-Headers':
            'Content-Type, Authorization, DPoP, Idempotency-Key, Authrim-Step-Up-Receipt',
        },
      }),
      env()
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PATCH,OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type,Authorization,DPoP,Idempotency-Key,Authrim-Step-Up-Receipt'
    );
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('sends the content security policy of a JSON-only service', async () => {
    const response = await app.fetch(new Request('https://op.example.com/api/health'), env());
    const directives = (response.headers.get('Content-Security-Policy') ?? '')
      .split(';')
      .map((directive) => directive.trim())
      .sort();
    expect(directives).toEqual(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "media-src 'self'",
        "frame-src 'none'",
      ].sort()
    );
  });
});

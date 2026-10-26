import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getRateLimitProfileAsync: vi.fn(),
  rateLimitMiddleware: vi.fn(),
  userinfoHandler: vi.fn(),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    module: vi.fn().mockReturnThis(),
  },
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    requestContextMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    pluginContextMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    getRateLimitProfileAsync: mocks.getRateLimitProfileAsync,
    rateLimitMiddleware: mocks.rateLimitMiddleware,
    createHealthCheckHandlers: () => ({
      liveness: (c: { json: (body: unknown) => Response }) => c.json({ status: 'ok' }),
      readiness: (c: { json: (body: unknown) => Response }) => c.json({ status: 'ok' }),
    }),
    getLogger: () => mocks.logger,
  };
});

vi.mock('../userinfo', () => ({
  userinfoHandler: mocks.userinfoHandler,
}));

vi.mock('../protected-customer-profile', () => ({
  createProtectedCustomerProfileRouter: () => {
    const router = new Hono();
    router.get('/:userId', (c) => c.json({ sub: c.req.param('userId') }));
    return router;
  },
}));

import app from '../index';

describe('userinfo service middleware boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRateLimitProfileAsync.mockResolvedValue({ maxRequests: 10, windowSeconds: 60 });
    mocks.rateLimitMiddleware.mockImplementation(
      () => async (_c: unknown, next: () => Promise<void>) => next()
    );
    mocks.userinfoHandler.mockImplementation((c: Context<{ Bindings: Env }>) =>
      c.json({ sub: 'user-1' })
    );
  });

  it.each(['/userinfo', '/api/protected/customer-profiles/user-1'])(
    'bypasses rate limiting for %s only when explicitly disabled',
    async (path) => {
      const response = await app.request(
        `http://localhost${path}`,
        { headers: { Authorization: 'Bearer token' } },
        { ENABLE_RATE_LIMIT: 'false' } as Env
      );
      expect(response.status).toBe(200);
      expect(mocks.getRateLimitProfileAsync).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['/userinfo', '/userinfo'],
    ['/api/protected/customer-profiles/user-1', '/api/protected/customer-profiles'],
  ])('applies the moderate rate limit to %s', async (path, endpoint) => {
    const response = await app.request(`http://localhost${path}`, {}, {} as Env);
    expect(response.status).toBe(200);
    expect(mocks.getRateLimitProfileAsync).toHaveBeenCalledWith(expect.anything(), 'moderate');
    expect(mocks.rateLimitMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({ endpoints: [endpoint] })
    );
  });

  it('masks unexpected handler errors at the service boundary', async () => {
    mocks.userinfoHandler.mockRejectedValue(new Error('database password leaked'));
    const response = await app.request('http://localhost/userinfo', {}, {
      ENABLE_RATE_LIMIT: 'false',
    } as Env);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    });
    expect(text).not.toContain('database password leaked');
  });
});

describe('userinfo deferred source effects', () => {
  it('retains admission until a handler-owned deferred write completes', async () => {
    let finish!: () => void;
    const write = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const complete = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({ admitted: true }));
    mocks.userinfoHandler.mockImplementation((c: Context<{ Bindings: Env }>) => {
      c.executionCtx.waitUntil(write);
      return c.json({ sub: 'user-1' });
    });
    const pending = app.fetch(
      new Request('https://issuer.example/userinfo'),
      {
        ENABLE_RATE_LIMIT: 'false',
        ENABLE_SAML_DR_EXPORT: 'true',
        SAML_DR_MUTATION_CONTROL: {
          acquireEnvironmentBackupMutationPermit: acquire,
          completeEnvironmentBackupMutationPermit: complete,
        },
      } as unknown as Env,
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
        props: {},
      } as unknown as ExecutionContext
    );
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    expect(complete).not.toHaveBeenCalled();
    finish();
    expect((await pending).status).toBe(200);
    expect(complete).toHaveBeenCalledOnce();
  });
});

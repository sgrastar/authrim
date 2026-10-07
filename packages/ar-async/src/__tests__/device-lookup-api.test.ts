import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DeviceCodeMetadata, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  isMockAuthEnabled: vi.fn(),
  getClient: vi.fn(),
  storeFetch: vi.fn(),
  limiterFetch: vi.fn(),
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    module: vi.fn().mockReturnThis(),
  },
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    isMockAuthEnabled: mocks.isMockAuthEnabled,
    getLogger: () => mocks.logger,
    getClient: mocks.getClient,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
  };
});

vi.mock('../authenticated-session', async () => {
  const actual = await vi.importActual<typeof import('../authenticated-session')>(
    '../authenticated-session'
  );
  return { ...actual, getAuthenticatedAsyncUser: mocks.authenticatedUser };
});

import { deviceLookupApiHandler } from '../device-lookup-api';

function pendingMetadata(overrides: Partial<DeviceCodeMetadata> = {}): DeviceCodeMetadata {
  return {
    tenant_id: 'tenant-a',
    device_code: 'device-1',
    user_code: 'WDJB-MJHT',
    client_id: 'client-1',
    scope: 'openid profile',
    status: 'pending',
    created_at: 1_770_000_000_000,
    expires_at: 1_770_000_600_000,
    poll_count: 0,
    ...overrides,
  };
}

function createEnv(withLimiter = true): Env {
  return {
    DEVICE_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('device-store'),
      get: vi.fn().mockReturnValue({ fetch: mocks.storeFetch }),
    },
    ...(withLimiter
      ? {
          USER_CODE_RATE_LIMITER: {
            idFromName: vi.fn().mockReturnValue('limiter'),
            get: vi.fn().mockReturnValue({ fetch: mocks.limiterFetch }),
          },
        }
      : {}),
  } as unknown as Env;
}

function request(body: unknown, env = createEnv()) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'tenant-a');
    await next();
  });
  app.post('/lookup', deviceLookupApiHandler);
  return app.request(
    'http://localhost/lookup',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify(body),
    },
    env
  );
}

function storePaths(): string[] {
  return mocks.storeFetch.mock.calls.map(([input]) => new URL((input as Request).url).pathname);
}

describe('device code lookup API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticatedUser.mockResolvedValue({
      userId: 'user-1',
      sub: 'subject-1',
      email: 'user@example.com',
    });
    mocks.isMockAuthEnabled.mockResolvedValue(false);
    mocks.getClient.mockResolvedValue({
      client_id: 'client-1',
      client_name: 'Acme TV',
      client_uri: 'https://tv.example.com',
      logo_uri: 'https://tv.example.com/logo.png',
    });
    mocks.storeFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/get-by-user-code') return Response.json(pendingMetadata());
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    mocks.limiterFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/check') return Response.json({ blocked: false });
      return Response.json({ success: true });
    });
  });

  it('shows the signed-in user the application and scopes a pending code asks for', async () => {
    const response = await request({ user_code: 'wdjbmjht' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      client_id: 'client-1',
      client_name: 'Acme TV',
      client_uri: 'https://tv.example.com',
      logo_uri: 'https://tv.example.com/logo.png',
      scopes: ['openid', 'profile'],
      expires_at: 1_770_000_600_000,
    });
    const lookup = mocks.storeFetch.mock.calls[0][0] as Request;
    expect(lookup.headers.get('X-Authrim-Tenant-Id')).toBe('tenant-a');
    await expect(lookup.json()).resolves.toEqual({ user_code: 'WDJB-MJHT' });
    expect(mocks.getClient).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'client-1', {});
  });

  it('decides nothing: it never approves or denies the code', async () => {
    await request({ user_code: 'WDJB-MJHT', approve: true });

    expect(storePaths()).toEqual(['/get-by-user-code']);
  });

  it('falls back to the client id when the client is not registered', async () => {
    mocks.getClient.mockResolvedValue(null);

    const response = await request({ user_code: 'WDJB-MJHT' });

    await expect(response.json()).resolves.toEqual({
      client_id: 'client-1',
      client_name: 'client-1',
      scopes: ['openid', 'profile'],
      expires_at: 1_770_000_600_000,
    });
  });

  it('requires a browser session before reading the code', async () => {
    mocks.authenticatedUser.mockResolvedValue(null);

    const response = await request({ user_code: 'WDJB-MJHT' });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'authentication_required' });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
    expect(mocks.limiterFetch).not.toHaveBeenCalled();
  });

  it('lets a development deployment with mock authentication look a code up', async () => {
    mocks.authenticatedUser.mockResolvedValue(null);
    mocks.isMockAuthEnabled.mockResolvedValue(true);

    // Mock authentication (never on in production) also tolerates a missing rate limiter.
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(false));

    expect(response.status).toBe(200);
  });

  it.each([
    [{}, 'invalid_request', 'user_code is required'],
    [{ user_code: 42 }, 'invalid_request', 'user_code is required'],
    [{ user_code: 'invalid' }, 'invalid_code', 'Invalid user code format'],
  ])('rejects malformed input before store access', async (body, error, description) => {
    const response = await request(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error,
      error_description: expect.stringContaining(description),
    });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('counts a confirmed unknown code against the user code rate limit', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json(null));

    const response = await request({ user_code: 'WDJB-MJHT' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_code' });
    const limiterCalls = mocks.limiterFetch.mock.calls.map(([input]) => input as Request);
    expect(limiterCalls.map((input) => new URL(input.url).pathname)).toEqual([
      '/check',
      '/record-failure',
    ]);
    await expect(limiterCalls[1].json()).resolves.toEqual({ ip: '203.0.113.9' });
  });

  it('refuses to answer when the rate limiter cannot count a failure', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json(null));
    mocks.limiterFetch.mockImplementation(async (input: Request) => {
      if (new URL(input.url).pathname === '/check') return Response.json({ blocked: false });
      throw new Error('limiter unavailable');
    });

    const response = await request({ user_code: 'WDJB-MJHT' });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
  });

  it.each([
    ['answers an error status', () => Response.json({ error: 'internal' }, { status: 500 })],
    [
      'throws',
      () => {
        throw new Error('store unavailable');
      },
    ],
  ])(
    'does not report a code as unknown, nor count a failure, when the store %s',
    async (_label, storeResponse) => {
      mocks.storeFetch.mockImplementation(async () => storeResponse());

      const response = await request({ user_code: 'WDJB-MJHT' });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
      expect(
        mocks.limiterFetch.mock.calls.map(([input]) => new URL((input as Request).url).pathname)
      ).toEqual(['/check']);
    }
  );

  it('refuses a blocked client before reading the code', async () => {
    mocks.limiterFetch.mockResolvedValue(Response.json({ blocked: true, retry_after: 120 }));

    const response = await request({ user_code: 'WDJB-MJHT' });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: 'slow_down',
      error_description: expect.stringContaining('120 seconds'),
    });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['answers an error status', () => new Response('unavailable', { status: 503 })],
    ['answers an unexpected body', () => Response.json({ ok: true })],
  ])('refuses to read codes when the rate limiter check %s', async (_label, limiterResponse) => {
    mocks.limiterFetch.mockImplementation(async () => limiterResponse());

    const response = await request({ user_code: 'WDJB-MJHT' });

    expect(response.status).toBe(503);
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('refuses to read codes without a rate limiter binding', async () => {
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(false));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it.each(['approved', 'denied', 'expired'] as const)(
    'reports a code that was already %s as an invalid code',
    async (status) => {
      mocks.storeFetch.mockResolvedValue(Response.json(pendingMetadata({ status })));

      const response = await request({ user_code: 'WDJB-MJHT' });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'invalid_code',
        error_description: `This code has already been ${status}`,
        code_status: status,
        decided_by_self: false,
      });
      expect(mocks.getClient).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['the signed-in user', { user_id: 'user-1', sub: 'subject-1' }, true],
    ['the signed-in user (by subject)', { user_id: 'legacy', sub: 'subject-1' }, true],
    ['someone else', { user_id: 'user-2', sub: 'subject-2' }, false],
    ['no recorded user', {}, false],
  ])('tells the browser whether %s approved the code', async (_label, approver, expected) => {
    mocks.storeFetch.mockResolvedValue(
      Response.json(pendingMetadata({ status: 'approved', ...approver }))
    );

    const response = await request({ user_code: 'WDJB-MJHT' });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ code_status: 'approved', decided_by_self: expected });
    // The approving user is never named.
    expect(JSON.stringify(body)).not.toContain('user-2');
    expect(JSON.stringify(body)).not.toContain('subject-2');
  });

  it('never attributes a denial or an approval to an unauthenticated development session', async () => {
    mocks.authenticatedUser.mockResolvedValue(null);
    mocks.isMockAuthEnabled.mockResolvedValue(true);
    mocks.storeFetch.mockResolvedValue(
      Response.json(pendingMetadata({ status: 'approved', user_id: 'user-1', sub: 'subject-1' }))
    );

    const response = await request({ user_code: 'WDJB-MJHT' });

    await expect(response.json()).resolves.toMatchObject({ decided_by_self: false });
  });

  it('masks unexpected parser and storage exceptions', async () => {
    mocks.getClient.mockRejectedValue(new Error('D1 exploded with secret detail'));

    const response = await request({ user_code: 'WDJB-MJHT' });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('server_error');
    expect(body).not.toContain('secret detail');
  });
});

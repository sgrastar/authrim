import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DeviceCodeMetadata, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  isMockAuthEnabled: vi.fn(),
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
  };
});

vi.mock('../authenticated-session', async () => {
  const actual = await vi.importActual<typeof import('../authenticated-session')>(
    '../authenticated-session'
  );
  return { ...actual, getAuthenticatedAsyncUser: mocks.authenticatedUser };
});

import { deviceVerifyApiHandler } from '../device-verify-api';

function pendingMetadata(overrides: Partial<DeviceCodeMetadata> = {}): DeviceCodeMetadata {
  return {
    tenant_id: 'tenant-a',
    device_code: 'device-1',
    user_code: 'WDJB-MJHT',
    client_id: 'client-1',
    scope: 'openid',
    status: 'pending',
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    poll_count: 0,
    ...overrides,
  };
}

function createEnv(withLimiter = false): Env {
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

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'tenant-a');
    await next();
  });
  app.post('/verify', deviceVerifyApiHandler);
  return app;
}

function request(body: unknown, env = createEnv(), headers: Record<string, string> = {}) {
  return createApp().request(
    'http://localhost/verify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('device verification API branch security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticatedUser.mockResolvedValue({
      userId: 'user-1',
      sub: 'subject-1',
      email: 'user@example.com',
    });
    mocks.isMockAuthEnabled.mockResolvedValue(false);
    mocks.storeFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/get-by-user-code') return Response.json(pendingMetadata());
      if (path === '/approve' || path === '/deny') return Response.json({ success: true });
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    mocks.limiterFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/check') return Response.json({ blocked: false });
      return Response.json({ success: true });
    });
  });

  it.each([
    [{}, 'user_code is required'],
    [{ user_code: 'invalid' }, 'Invalid user code format'],
  ])('rejects malformed input before store access', async (body, description) => {
    const response = await request(body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_description: expect.stringContaining(description),
    });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('uses the forwarded IP fallback and default retry interval when rate limited', async () => {
    mocks.limiterFetch.mockResolvedValue(Response.json({ blocked: true }));
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(true), {
      'X-Forwarded-For': '203.0.113.7',
    });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: 'slow_down',
      error_description: expect.stringContaining('3600 seconds'),
    });
    const check = mocks.limiterFetch.mock.calls[0][0] as Request;
    await expect(check.json()).resolves.toEqual({ ip: '203.0.113.7' });
  });

  it('continues when the rate limiter check is unavailable', async () => {
    mocks.limiterFetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(true));
    expect(response.status).toBe(200);
  });

  it.each([
    ['store miss', Response.json({ error: 'missing' }, { status: 404 })],
    ['empty store response', Response.json(null)],
  ])('returns a generic invalid-code response for a %s', async (_label, storeResponse) => {
    mocks.storeFetch.mockResolvedValue(storeResponse);
    mocks.limiterFetch.mockImplementation(async (input: Request) => {
      if (new URL(input.url).pathname === '/check') return Response.json({ blocked: false });
      throw new Error('limiter unavailable');
    });
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(true));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_code' });
    expect(mocks.limiterFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a code which has already transitioned state', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json(pendingMetadata({ status: 'approved' })));
    const response = await request({ user_code: 'WDJB-MJHT' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'This code has already been approved',
    });
  });

  it.each([true, false])('requires a session before approve=%s', async (approve) => {
    mocks.authenticatedUser.mockResolvedValue(null);
    const response = await request({ user_code: 'WDJB-MJHT', approve });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'authentication_required' });
    expect(
      mocks.storeFetch.mock.calls.some(([input]) =>
        ['/approve', '/deny'].includes(new URL((input as Request).url).pathname)
      )
    ).toBe(false);
  });

  it('binds approval to the authenticated user and ignores supplied subjects', async () => {
    const response = await request({
      user_code: 'wdjbmjht',
      user_id: 'victim',
      sub: 'victim-sub',
    });
    expect(response.status).toBe(200);
    const approve = mocks.storeFetch.mock.calls
      .map(([input]) => input as Request)
      .find((input) => new URL(input.url).pathname === '/approve');
    await expect(approve?.json()).resolves.toEqual({
      user_code: 'WDJB-MJHT',
      user_id: 'user-1',
      sub: 'subject-1',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Ignoring caller-supplied device approval subject',
      expect.anything()
    );
  });

  it('allows generated development subjects only when mock authentication is enabled', async () => {
    mocks.authenticatedUser.mockResolvedValue(null);
    mocks.isMockAuthEnabled.mockResolvedValue(true);
    const response = await request({ user_code: 'WDJB-MJHT' });
    expect(response.status).toBe(200);
    const approve = mocks.storeFetch.mock.calls
      .map(([input]) => input as Request)
      .find((input) => new URL(input.url).pathname === '/approve');
    const body = (await approve?.json()) as { user_id: string; sub: string };
    expect(body.user_id).toMatch(/^user_\d+$/);
    expect(body.sub).toBe(body.user_id);
  });

  it.each([
    ['/approve', { error_description: 'approval backend rejected' }, 'approval backend rejected'],
    ['/deny', {}, 'Failed to deny device'],
  ])('does not hide a safe store failure for %s', async (failurePath, errorBody, expected) => {
    mocks.storeFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/get-by-user-code') return Response.json(pendingMetadata());
      if (path === failurePath) return Response.json(errorBody, { status: 500 });
      return Response.json({ success: true });
    });
    const response = await request({
      user_code: 'WDJB-MJHT',
      approve: failurePath === '/approve',
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error_description: expected });
  });

  it('resets rate limiting after a successful approval and ignores reset failures', async () => {
    mocks.limiterFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/check') return Response.json({ blocked: false });
      throw new Error('reset failed');
    });
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(true));
    expect(response.status).toBe(200);
    expect(mocks.limiterFetch).toHaveBeenCalledTimes(2);
  });

  it('successfully denies a pending code for the authenticated user', async () => {
    const response = await request({ user_code: 'WDJB-MJHT', approve: false });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Device authorization denied',
    });
  });

  it('masks unexpected parser and storage exceptions', async () => {
    const app = createApp();
    const response = await app.request(
      'http://localhost/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      },
      createEnv()
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'server_error',
      error_description: 'Internal server error',
    });
  });
});

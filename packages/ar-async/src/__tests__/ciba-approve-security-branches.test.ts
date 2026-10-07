import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { CIBARequestMetadata, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  isMockAuthEnabled: vi.fn(),
  checkRateLimit: vi.fn(),
  storeFetch: vi.fn(),
  sendPingNotification: vi.fn(),
  resolveAccount: vi.fn(),
  // The approving user's consent withdrawals for the client, as its account database holds them.
  withdrawalRow: vi.fn(),
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
    checkRateLimit: mocks.checkRateLimit,
    getCloudProvider: vi.fn().mockResolvedValue('cloudflare'),
    getClientIP: vi.fn().mockReturnValue('203.0.113.123'),
    getLogger: () => mocks.logger,
    resolveAccountDataContextFromHono: mocks.resolveAccount,
    createAccountAuthContextFromHono: () => ({
      coreAdapter: {
        query: vi.fn(),
        queryOne: async (sql: string, params: unknown[]) =>
          sql.includes('FROM oauth_client_consent_revocations')
            ? mocks.withdrawalRow(params)
            : null,
        execute: vi.fn(),
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn(),
        getType: () => 'mock',
        close: vi.fn(),
      },
    }),
  };
});

vi.mock('@authrim/ar-lib-core/notifications', () => ({
  sendPingNotification: mocks.sendPingNotification,
}));

vi.mock('../authenticated-session', async () => {
  const actual = await vi.importActual<typeof import('../authenticated-session')>(
    '../authenticated-session'
  );
  return { ...actual, getAuthenticatedAsyncUser: mocks.authenticatedUser };
});

import { cibaApproveHandler } from '../ciba-approve';

function pending(overrides: Partial<CIBARequestMetadata> = {}): CIBARequestMetadata {
  return {
    auth_req_id: 'legacy-request-id',
    client_id: 'client-1',
    scope: 'openid',
    login_hint: 'user@example.com',
    status: 'pending',
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    interval: 5,
    poll_count: 0,
    delivery_mode: 'poll',
    ...overrides,
  } as CIBARequestMetadata;
}

function createEnv(): Env {
  return {
    CIBA_REQUEST_STORE: {
      idFromName: vi.fn().mockReturnValue('store'),
      get: vi.fn().mockReturnValue({ fetch: mocks.storeFetch }),
    },
  } as unknown as Env;
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'tenant-a');
    await next();
  });
  app.post('/approve', cibaApproveHandler);
  return app;
}

function request(body: unknown) {
  return createApp().request(
    'http://localhost/approve',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    createEnv()
  );
}

describe('CIBA approval security branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Math.floor(Date.now() / 1000) + 60,
    });
    mocks.authenticatedUser.mockResolvedValue({
      userId: 'user-1',
      sub: 'subject-1',
      email: 'user@example.com',
    });
    mocks.isMockAuthEnabled.mockResolvedValue(false);
    mocks.sendPingNotification.mockResolvedValue(undefined);
    mocks.resolveAccount.mockResolvedValue({ tenantId: 'tenant-a' });
    mocks.withdrawalRow.mockResolvedValue(null);
    mocks.storeFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/get-by-auth-req-id') return Response.json(pending());
      if (path === '/approve') return Response.json({ success: true });
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
  });

  it('rate limits before parsing or looking up an authorization request', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 30;
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt });
    const response = await request({ auth_req_id: 'legacy-request-id' });
    expect(response.status).toBe(429);
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    await expect(response.json()).resolves.toMatchObject({ error: 'rate_limit_exceeded' });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('rejects a missing request identifier', async () => {
    const response = await request({});
    expect(response.status).toBe(400);
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('does not disclose whether a request exists: a missing one is 404', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json(null));
    const response = await request({ auth_req_id: 'legacy-request-id' });
    expect(response.status).toBe(404);
  });

  it('does not take a store error for a missing request', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json({ error: 'missing' }, { status: 404 }));
    const response = await request({ auth_req_id: 'legacy-request-id' });
    expect(response.status).toBe(503);
  });

  it('rejects a request which is no longer pending', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json(pending({ status: 'denied' })));
    const response = await request({ auth_req_id: 'legacy-request-id' });
    expect(response.status).toBe(400);
  });

  it('requires authentication when mock mode is disabled', async () => {
    mocks.authenticatedUser.mockResolvedValue(null);
    const response = await request({
      auth_req_id: 'legacy-request-id',
      user_id: 'victim',
      sub: 'victim',
    });
    expect(response.status).toBe(401);
    expect(mocks.storeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['resolved subject', { resolved_subject_id: 'victim' }],
    ['login hint', { login_hint: 'victim@example.com' }],
  ])('rejects an authenticated user with a mismatched %s', async (_label, overrides) => {
    mocks.storeFetch.mockResolvedValue(Response.json(pending(overrides)));
    const response = await request({ auth_req_id: 'legacy-request-id' });
    expect(response.status).toBe(403);
  });

  it('uses the session subject and preserves an optional nonce', async () => {
    const response = await request({
      auth_req_id: 'legacy-request-id',
      user_id: 'victim',
      sub: 'victim',
      nonce: 'nonce-1',
    });
    expect(response.status).toBe(200);
    const approve = mocks.storeFetch.mock.calls
      .map(([input]) => input as Request)
      .find((input) => new URL(input.url).pathname === '/approve');
    await expect(approve?.json()).resolves.toEqual({
      auth_req_id: 'legacy-request-id',
      user_id: 'user-1',
      sub: 'subject-1',
      nonce: 'nonce-1',
      consent_generation: 0,
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Ignoring caller-supplied CIBA approval subject',
      expect.anything()
    );
  });

  describe('after the user withdrew the client consent', () => {
    const requestedAt = Date.now() - 10_000;

    function approveCall() {
      return mocks.storeFetch.mock.calls
        .map(([input]) => input as Request)
        .find((input) => new URL(input.url).pathname === '/approve');
    }

    beforeEach(() => {
      mocks.storeFetch.mockImplementation(async (input: Request) => {
        const path = new URL(input.url).pathname;
        if (path === '/get-by-auth-req-id') {
          return Response.json(pending({ created_at: requestedAt }));
        }
        if (path === '/approve') return Response.json({ success: true });
        return Response.json({ error: 'not_found' }, { status: 404 });
      });
    });

    it('refuses to approve a request made before the withdrawal: the client starts again', async () => {
      mocks.withdrawalRow.mockResolvedValue({ generation: 1, revoked_at: requestedAt + 1 });

      const response = await request({ auth_req_id: 'legacy-request-id' });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'consent_withdrawn',
        error_description: expect.stringContaining('Start again'),
      });
      expect(approveCall()).toBeUndefined();
      expect(mocks.withdrawalRow).toHaveBeenCalledWith(['tenant-a', 'subject-1', 'client-1']);
    });

    it('approves a request made after the withdrawal under the current generation', async () => {
      mocks.withdrawalRow.mockResolvedValue({ generation: 2, revoked_at: requestedAt - 1 });

      const response = await request({ auth_req_id: 'legacy-request-id' });

      expect(response.status).toBe(200);
      await expect(approveCall()?.json()).resolves.toMatchObject({ consent_generation: 2 });
    });

    it('leaves the request pending when the withdrawals cannot be read', async () => {
      mocks.withdrawalRow.mockRejectedValue(new Error('account database unavailable'));

      const response = await request({ auth_req_id: 'legacy-request-id' });

      expect(response.status).toBe(503);
      expect(approveCall()).toBeUndefined();
    });
  });

  it('allows explicit test subjects only in mock mode', async () => {
    mocks.authenticatedUser.mockResolvedValue(null);
    mocks.isMockAuthEnabled.mockResolvedValue(true);
    const response = await request({
      auth_req_id: 'legacy-request-id',
      user_id: 'dev-user',
      sub: 'dev-sub',
    });
    expect(response.status).toBe(200);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Mock authentication is enabled. This should NEVER be used in production!'
    );
  });

  it('generates a mock subject when development input is absent', async () => {
    mocks.authenticatedUser.mockResolvedValue(null);
    mocks.isMockAuthEnabled.mockResolvedValue(true);
    const response = await request({ auth_req_id: 'legacy-request-id' });
    expect(response.status).toBe(200);
    const approve = mocks.storeFetch.mock.calls
      .map(([input]) => input as Request)
      .find((input) => new URL(input.url).pathname === '/approve');
    const body = (await approve?.json()) as { user_id: string; sub: string; nonce: null };
    expect(body.user_id).toMatch(/^user_\d+$/);
    expect(body.sub).toBe(body.user_id);
    expect(body.nonce).toBeNull();
  });

  it('fails closed with 503 (outcome unconfirmed) when the state transition is rejected', async () => {
    mocks.storeFetch.mockImplementation(async (input: Request) => {
      if (new URL(input.url).pathname === '/get-by-auth-req-id') {
        return Response.json(pending());
      }
      return Response.json({ error: 'conflict' }, { status: 409 });
    });
    const response = await request({ auth_req_id: 'legacy-request-id' });
    expect(response.status).toBe(503);
  });

  it.each([false, true])('continues after ping notification failure=%s', async (fails) => {
    mocks.storeFetch.mockImplementation(async (input: Request) => {
      if (new URL(input.url).pathname === '/get-by-auth-req-id') {
        return Response.json(
          pending({
            delivery_mode: 'ping',
            client_notification_endpoint: 'https://client.example.com/ciba',
            client_notification_token: 'notification-token',
          })
        );
      }
      return Response.json({ success: true });
    });
    if (fails) mocks.sendPingNotification.mockRejectedValue(new Error('network down'));
    const response = await request({ auth_req_id: 'legacy-request-id' });
    expect(response.status).toBe(200);
    expect(mocks.sendPingNotification).toHaveBeenCalledWith(
      'https://client.example.com/ciba',
      'notification-token',
      'legacy-request-id'
    );
    expect(mocks.logger.error).toHaveBeenCalledTimes(fails ? 1 : 0);
  });

  it('masks unexpected JSON errors', async () => {
    const app = createApp();
    const response = await app.request(
      'http://localhost/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      },
      createEnv()
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: 'server_error' });
  });
});

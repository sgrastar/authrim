import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { CIBARequestMetadata, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  isMockAuthEnabled: vi.fn(),
  getClient: vi.fn(),
  storeFetch: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
    getClient: mocks.getClient,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    getLogger: () => mocks.logger,
  };
});

vi.mock('../authenticated-session', async () => {
  const actual = await vi.importActual<typeof import('../authenticated-session')>(
    '../authenticated-session'
  );
  return {
    ...actual,
    getAuthenticatedAsyncUser: mocks.authenticatedUser,
  };
});

import { cibaDenyHandler } from '../ciba-deny';
import { cibaDetailsHandler } from '../ciba-details';
import { cibaPendingHandler } from '../ciba-pending';

function metadata(overrides: Partial<CIBARequestMetadata> = {}): CIBARequestMetadata {
  const now = Math.floor(Date.now() / 1000);
  return {
    auth_req_id: 'legacy-request-id',
    client_id: 'client-1',
    scope: 'openid profile',
    login_hint: 'user@example.com',
    status: 'pending',
    created_at: now,
    expires_at: now + 300,
    interval: 5,
    delivery_mode: 'poll',
    poll_count: 0,
    ...overrides,
  } as CIBARequestMetadata;
}

function createEnv(): Env {
  return {
    CIBA_REQUEST_STORE: {
      idFromName: vi.fn().mockReturnValue('ciba-store'),
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
  app.get('/pending', cibaPendingHandler);
  app.get('/requests/:auth_req_id', cibaDetailsHandler);
  app.post('/deny', cibaDenyHandler);
  return app;
}

describe('CIBA session authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMockAuthEnabled.mockResolvedValue(false);
    mocks.authenticatedUser.mockResolvedValue(null);
    mocks.getClient.mockResolvedValue({
      client_id: 'client-1',
      client_name: 'Example Client',
      is_trusted: false,
    });
    mocks.storeFetch.mockImplementation(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/get-by-login-hint' || path === '/get-by-auth-req-id') {
        return Response.json(metadata());
      }
      if (path === '/deny') {
        return Response.json({ success: true });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
  });

  it.each([
    ['pending list', '/pending', undefined],
    ['request details', '/requests/legacy-request-id', undefined],
    [
      'request denial',
      '/deny',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_req_id: 'legacy-request-id' }),
      },
    ],
  ])('rejects an unauthenticated %s before reading request state', async (_label, path, init) => {
    const response = await createApp().request(`http://localhost${path}`, init, createEnv());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'login_required' });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('derives the pending lookup from the authenticated session', async () => {
    mocks.authenticatedUser.mockResolvedValue({
      userId: 'user-1',
      sub: 'subject-1',
      email: 'user@example.com',
    });
    const response = await createApp().request('http://localhost/pending', {}, createEnv());
    expect(response.status).toBe(200);
    const lookup = mocks.storeFetch.mock.calls[0][0] as Request;
    await expect(lookup.json()).resolves.toEqual({ login_hint: 'user@example.com' });
    await expect(response.json()).resolves.toMatchObject({
      requests: [{ auth_req_id: 'legacy-request-id', client_name: 'Example Client' }],
    });
  });

  it.each([['/pending?login_hint=victim@example.com'], ['/pending?user_id=victim-user']])(
    'rejects a caller-selected pending identity: %s',
    async (path) => {
      mocks.authenticatedUser.mockResolvedValue({
        userId: 'user-1',
        sub: 'subject-1',
        email: 'user@example.com',
      });
      const response = await createApp().request(`http://localhost${path}`, {}, createEnv());
      expect(response.status).toBe(403);
      expect(mocks.storeFetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['details', '/requests/legacy-request-id', undefined],
    [
      'denial',
      '/deny',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_req_id: 'legacy-request-id' }),
      },
    ],
  ])('rejects %s for a request owned by another user', async (_label, path, init) => {
    mocks.authenticatedUser.mockResolvedValue({
      userId: 'user-1',
      sub: 'subject-1',
      email: 'user@example.com',
    });
    mocks.storeFetch.mockResolvedValue(
      Response.json(metadata({ login_hint: 'victim@example.com' }))
    );
    const response = await createApp().request(`http://localhost${path}`, init, createEnv());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' });
  });

  it('allows the authenticated owner to view and deny a pending request', async () => {
    mocks.authenticatedUser.mockResolvedValue({
      userId: 'user-1',
      sub: 'subject-1',
      email: 'user@example.com',
    });
    const app = createApp();
    const env = createEnv();
    const details = await app.request('http://localhost/requests/legacy-request-id', {}, env);
    expect(details.status).toBe(200);
    await expect(details.json()).resolves.toMatchObject({ auth_req_id: 'legacy-request-id' });

    const denial = await app.request(
      'http://localhost/deny',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_req_id: 'legacy-request-id', reason: 'Not me' }),
      },
      env
    );
    expect(denial.status).toBe(200);
    const denyCall = mocks.storeFetch.mock.calls
      .map(([request]) => request as Request)
      .find((request) => new URL(request.url).pathname === '/deny');
    await expect(denyCall?.json()).resolves.toEqual({
      auth_req_id: 'legacy-request-id',
      reason: 'Not me',
    });
  });

  it('keeps explicit development identity lookup behind mock authentication', async () => {
    mocks.isMockAuthEnabled.mockResolvedValue(true);
    const response = await createApp().request(
      'http://localhost/pending?user_id=dev-user',
      {},
      createEnv()
    );
    expect(response.status).toBe(200);
    const lookup = mocks.storeFetch.mock.calls[0][0] as Request;
    await expect(lookup.json()).resolves.toEqual({ login_hint: 'sub:dev-user' });
  });
});

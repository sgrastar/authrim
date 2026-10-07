import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { CIBARequestMetadata, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  isMockAuthEnabled: vi.fn(),
  checkRateLimit: vi.fn(),
  storeFetch: vi.fn(),
  resolveAccount: vi.fn(),
  getClient: vi.fn(),
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
    getClient: mocks.getClient,
    resolveAccountDataContextFromHono: mocks.resolveAccount,
    createAuthContextFromHono: () => ({ coreAdapter: {} }),
    createAccountAuthContextFromHono: () => ({
      coreAdapter: {
        query: vi.fn(),
        queryOne: async () => null,
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
  sendPingNotification: vi.fn(),
}));

vi.mock('../authenticated-session', async () => {
  const actual = await vi.importActual<typeof import('../authenticated-session')>(
    '../authenticated-session'
  );
  return { ...actual, getAuthenticatedAsyncUser: mocks.authenticatedUser };
});

import { cibaApproveHandler } from '../ciba-approve';
import { cibaDenyHandler } from '../ciba-deny';
import { cibaDetailsHandler } from '../ciba-details';

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
  app.post('/deny', cibaDenyHandler);
  app.get('/requests/:auth_req_id', cibaDetailsHandler);
  return app;
}

function post(path: 'approve' | 'deny') {
  return createApp().request(
    `http://localhost/${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: 'legacy-request-id' }),
    },
    createEnv()
  );
}

function details() {
  return createApp().request('http://localhost/requests/legacy-request-id', {}, createEnv());
}

type StoreStep = (input: Request) => Promise<Response> | Response;

/** The store answers the read with `read` and the decision (/approve, /deny) with `decide`. */
function store(read: StoreStep, decide: StoreStep = () => Response.json({ success: true })) {
  mocks.storeFetch.mockImplementation(async (input: Request) =>
    new URL(input.url).pathname === '/get-by-auth-req-id' ? read(input) : decide(input)
  );
}

function decisionCalls() {
  return mocks.storeFetch.mock.calls
    .map(([input]) => input as Request)
    .filter((input) => new URL(input.url).pathname !== '/get-by-auth-req-id');
}

const unavailableReads: Array<[string, StoreStep]> = [
  ['a 500', () => Response.json({ error: 'server_error' }, { status: 500 })],
  ['a 503', () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })],
  [
    'a thrown error',
    () => {
      throw new Error('Durable Object reset');
    },
  ],
  ['a body that is not JSON', () => new Response('<html>overloaded</html>', { status: 200 })],
];

describe.each([
  ['approve', 'approve' as const],
  ['deny', 'deny' as const],
])('CIBA %s when the store misbehaves', (_name, action) => {
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
    mocks.resolveAccount.mockResolvedValue({ tenantId: 'tenant-a' });
    store(() => Response.json(pending()));
  });

  it.each(unavailableReads)(
    'answers 503, not 404, when reading the request fails with %s',
    async (_label, read) => {
      store(read);

      const response = await post(action);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
      expect(decisionCalls()).toHaveLength(0);
    }
  );

  it('answers 404 only when the store says there is no such request', async () => {
    store(() => Response.json(null));

    const response = await post(action);

    expect(response.status).toBe(404);
    expect(decisionCalls()).toHaveLength(0);
  });

  it('keeps the existing answer for a request already decided', async () => {
    store(() => Response.json(pending({ status: 'denied' })));

    const response = await post(action);

    expect(response.status).toBe(400);
    expect(decisionCalls()).toHaveLength(0);
  });

  it.each([
    ['a non-2xx answer', () => Response.json({ error: 'server_error' }, { status: 500 })],
    [
      'a thrown error',
      () => {
        throw new Error('Durable Object reset');
      },
    ],
  ] as Array<[string, StoreStep]>)(
    'answers 503 when saving the decision fails with %s',
    async (_label, decide) => {
      store(() => Response.json(pending()), decide);

      const response = await post(action);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
      expect(decisionCalls()).toHaveLength(1);
    }
  );

  it('answers 200 once the store saved the decision', async () => {
    const response = await post(action);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
  });
});

describe('CIBA details when the store misbehaves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticatedUser.mockResolvedValue({
      userId: 'user-1',
      sub: 'subject-1',
      email: 'user@example.com',
    });
    mocks.isMockAuthEnabled.mockResolvedValue(false);
    mocks.resolveAccount.mockResolvedValue({ tenantId: 'tenant-a' });
    mocks.getClient.mockResolvedValue(null);
  });

  it.each(unavailableReads)('answers 503, not 500 or 404, for %s', async (_label, read) => {
    store(read);

    const response = await details();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('answers 404 only when the store says there is no such request', async () => {
    store(() => Response.json(null));

    expect((await details()).status).toBe(404);
  });
});

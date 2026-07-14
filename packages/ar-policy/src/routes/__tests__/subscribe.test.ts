import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({
  result: {
    authenticated: true,
    method: 'api_key' as const,
    tenantId: 'tenant-a',
    allowedOperations: ['subscribe'] as const,
    rateLimitTier: 'moderate' as const,
  },
}));

vi.mock('../../middleware/check-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/check-auth')>();
  return {
    ...actual,
    authenticateCheckApiRequest: vi.fn(async () => authMock.result),
  };
});

vi.mock('../../rebac-storage-adapter', () => ({
  getPolicyCoreAdapter: vi.fn(() => ({})),
}));

import { subscribeRoutes } from '../subscribe';

function createHub(options: { statsOk?: boolean; throwOnFetch?: boolean } = {}) {
  const fetch = vi.fn(async (input: string | Request) => {
    if (options.throwOnFetch) throw new Error('hub unavailable');
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/stats')) {
      return new Response(JSON.stringify({ connections: 2 }), {
        status: options.statsOk === false ? 503 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/setup')) return new Response(null, { status: 204 });
    return new Response('upgraded', { status: 200 });
  });

  return {
    fetch,
    namespace: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch })),
    },
  };
}

function env(overrides: Record<string, unknown> = {}) {
  const hub = createHub();
  return {
    POLICY_API_SECRET: 'policy-secret',
    ENABLE_CHECK_API: 'true',
    ENABLE_CHECK_API_WEBSOCKET: 'true',
    PERMISSION_CHANGE_HUB: hub.namespace,
    ...overrides,
  };
}

describe('WebSocket subscription routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.result = {
      authenticated: true,
      method: 'api_key',
      tenantId: 'tenant-a',
      allowedOperations: ['subscribe'],
      rateLimitTier: 'moderate',
    };
  });

  it.each([
    [{ ENABLE_CHECK_API: 'false' }, 403],
    [{ ENABLE_CHECK_API_WEBSOCKET: 'false' }, 403],
    [{ PERMISSION_CHANGE_HUB: undefined }, 500],
  ])(
    'fails closed when required subscription capability is unavailable',
    async (override, status) => {
      const response = await subscribeRoutes.request(
        '/subscribe?token=chk_test',
        { headers: { Upgrade: 'websocket' } },
        env(override)
      );
      expect(response.status).toBe(status);
    }
  );

  it('requires an actual websocket upgrade and a query token', async () => {
    const noUpgrade = await subscribeRoutes.request('/subscribe?token=chk_test', {}, env());
    expect(noUpgrade.status).toBe(400);

    const noToken = await subscribeRoutes.request(
      '/subscribe',
      { headers: { Upgrade: 'websocket' } },
      env()
    );
    expect(noToken.status).toBe(401);
  });

  it('rejects unauthenticated, unauthorized, and cross-tenant subscriptions', async () => {
    authMock.result = { authenticated: false } as typeof authMock.result;
    let response = await subscribeRoutes.request(
      '/subscribe?token=bad',
      { headers: { Upgrade: 'websocket' } },
      env()
    );
    expect(response.status).toBe(401);

    authMock.result = {
      authenticated: true,
      method: 'api_key',
      tenantId: 'tenant-a',
      allowedOperations: [],
      rateLimitTier: 'moderate',
    };
    response = await subscribeRoutes.request(
      '/subscribe?token=chk_test',
      { headers: { Upgrade: 'websocket' } },
      env()
    );
    expect(response.status).toBe(403);

    authMock.result.allowedOperations = ['subscribe'];
    response = await subscribeRoutes.request(
      '/subscribe?token=chk_test&tenant_id=tenant-b',
      { headers: { Upgrade: 'websocket' } },
      env()
    );
    expect(response.status).toBe(403);
  });

  it('sets up the tenant hub before forwarding the upgrade', async () => {
    const hub = createHub();
    const response = await subscribeRoutes.request(
      '/subscribe?token=chk_test&tenant_id=tenant-a',
      { headers: { Upgrade: 'websocket' } },
      env({ PERMISSION_CHANGE_HUB: hub.namespace })
    );

    expect(response.status).toBe(200);
    expect(hub.namespace.idFromName).toHaveBeenCalledWith('tenant-a');
    expect(hub.fetch).toHaveBeenNthCalledWith(
      1,
      'https://internal/setup',
      expect.objectContaining({ method: 'POST' })
    );
    expect(hub.fetch).toHaveBeenNthCalledWith(2, expect.any(Request));
  });

  it('returns an internal error without leaking hub failures', async () => {
    const hub = createHub({ throwOnFetch: true });
    const response = await subscribeRoutes.request(
      '/subscribe?token=chk_test',
      { headers: { Upgrade: 'websocket' } },
      env({ PERMISSION_CHANGE_HUB: hub.namespace })
    );
    expect(response.status).toBe(500);
  });

  it('protects stats and reports hub state', async () => {
    authMock.result = { authenticated: false } as typeof authMock.result;
    expect((await subscribeRoutes.request('/subscribe/stats', {}, env())).status).toBe(401);

    authMock.result = {
      authenticated: true,
      method: 'api_key',
      tenantId: 'tenant-a',
      allowedOperations: ['subscribe'],
      rateLimitTier: 'moderate',
    };
    expect(
      (
        await subscribeRoutes.request(
          '/subscribe/stats',
          {},
          env({ PERMISSION_CHANGE_HUB: undefined })
        )
      ).status
    ).toBe(500);
    expect(
      (await subscribeRoutes.request('/subscribe/stats?tenant_id=tenant-b', {}, env())).status
    ).toBe(403);

    const hub = createHub();
    const response = await subscribeRoutes.request(
      '/subscribe/stats',
      {},
      env({ PERMISSION_CHANGE_HUB: hub.namespace })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenant_id: 'tenant-a',
      websocket_enabled: true,
      connections: 2,
    });
  });

  it('fails closed when the stats hub returns an error or throws', async () => {
    for (const hub of [createHub({ statsOk: false }), createHub({ throwOnFetch: true })]) {
      const response = await subscribeRoutes.request(
        '/subscribe/stats',
        {},
        env({ PERMISSION_CHANGE_HUB: hub.namespace })
      );
      expect(response.status).toBe(500);
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getAdapter: vi.fn(),
  errorResponse: vi.fn(),
  getLogger: vi.fn(),
  moduleName: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  spies.errorResponse.mockImplementation(
    (...args: Parameters<typeof original.createErrorResponse>) =>
      original.createErrorResponse(...args)
  );
  return { ...original, createErrorResponse: spies.errorResponse, getLogger: spies.getLogger };
});
vi.mock('../../middleware/check-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/check-auth')>();
  return { ...actual, authenticateCheckApiRequest: spies.authenticate };
});
vi.mock('../../rebac-storage-adapter', () => ({ getPolicyCoreAdapter: spies.getAdapter }));

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { subscribeRoutes } from '../subscribe';

const adapter = { name: 'core-adapter' };
const WS = { Upgrade: 'websocket' };

const auth = {
  authenticated: true,
  method: 'api_key' as const,
  tenantId: 'tenant-a',
  allowedOperations: ['subscribe' as const],
  rateLimitTier: 'moderate' as const,
};

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function createHub(handler?: (input: string | Request) => Promise<Response>) {
  const fetch = vi.fn(
    handler ??
      (async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.endsWith('/stats'))
          return Response.json({ tenant_id: 'tenant-a', active_connections: 2, subscriptions: 3 });
        if (url.endsWith('/setup')) return new Response(null, { status: 204 });
        return new Response('upgraded', { status: 200 });
      })
  );
  const namespace = {
    idFromName: vi.fn((name: string) => ({ id: `id:${name}` })),
    get: vi.fn(() => ({ fetch })),
  };
  return { fetch, namespace };
}

type Hub = ReturnType<typeof createHub>;

function envWith(hub: Hub | null, overrides: Record<string, unknown> = {}) {
  return {
    POLICY_API_SECRET: 'policy-secret',
    CHECK_CACHE_KV: { name: 'kv' },
    ENABLE_CHECK_API: 'true',
    ENABLE_CHECK_API_WEBSOCKET: 'true',
    PERMISSION_CHANGE_HUB: hub?.namespace,
    ...overrides,
  };
}

function lastErrorCode(): unknown {
  expect(spies.errorResponse).toHaveBeenCalledTimes(1);
  const code: unknown = must(spies.errorResponse.mock.calls.at(-1), 'an error response')[1];
  spies.errorResponse.mockClear();
  return code;
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.authenticate.mockResolvedValue(auth);
  spies.getAdapter.mockReturnValue(adapter);
  spies.getLogger.mockReturnValue({
    module: spies.moduleName.mockReturnValue({ error: spies.logError }),
  });
});

describe('GET /subscribe', () => {
  const upgrade = (
    hub: Hub,
    url = '/subscribe?token=chk_t&tenant_id=tenant-a',
    env = envWith(hub)
  ) => subscribeRoutes.request(url, { headers: WS }, env);

  it('fails with the right error for each missing precondition', async () => {
    const hub = createHub();
    let response = await subscribeRoutes.request(
      '/subscribe?token=t',
      { headers: WS },
      envWith(hub, { ENABLE_CHECK_API: 'yes' })
    );
    expect(response.status).toBe(403);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.POLICY_FEATURE_DISABLED);

    response = await subscribeRoutes.request(
      '/subscribe?token=t',
      { headers: WS },
      envWith(hub, { ENABLE_CHECK_API_WEBSOCKET: 'TRUE' })
    );
    expect(response.status).toBe(403);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.POLICY_FEATURE_DISABLED);

    response = await subscribeRoutes.request('/subscribe?token=t', { headers: WS }, envWith(null));
    expect(response.status).toBe(500);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.INTERNAL_ERROR);

    response = await subscribeRoutes.request('/subscribe?token=t', {}, envWith(hub));
    expect(response.status).toBe(400);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);

    response = await subscribeRoutes.request('/subscribe', { headers: WS }, envWith(hub));
    expect(response.status).toBe(401);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    expect(spies.authenticate).not.toHaveBeenCalled();
  });

  it('wraps the query token as a bearer credential for the route collaborators', async () => {
    const hub = createHub();
    const env = envWith(hub);
    await upgrade(hub, '/subscribe?token=chk_secret', env);
    expect(spies.authenticate).toHaveBeenCalledWith('Bearer chk_secret', {
      db: adapter,
      cache: env.CHECK_CACHE_KV,
      policyApiSecret: 'policy-secret',
    });
  });

  it('answers 401 when the token does not authenticate and 403 when subscribe is not allowed', async () => {
    const hub = createHub();
    spies.authenticate.mockResolvedValue({ authenticated: false });
    let response = await upgrade(hub);
    expect(response.status).toBe(401);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);

    spies.authenticate.mockResolvedValue({ ...auth, allowedOperations: ['check'] });
    response = await upgrade(hub);
    expect(response.status).toBe(403);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    expect(hub.fetch).not.toHaveBeenCalled();
  });

  it('answers 403 for another tenant and for a missing tenant under the system secret', async () => {
    const hub = createHub();
    let response = await upgrade(hub, '/subscribe?token=t&tenant_id=tenant-b');
    expect(response.status).toBe(403);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);

    spies.authenticate.mockResolvedValue({
      authenticated: true,
      method: 'policy_secret',
      allowedOperations: ['subscribe'],
    });
    response = await upgrade(hub, '/subscribe?token=t');
    expect(response.status).toBe(403);
    expect(hub.fetch).not.toHaveBeenCalled();
  });

  it('sets up the tenant hub, then forwards the upgrade to /websocket', async () => {
    const hub = createHub();
    const response = await subscribeRoutes.request(
      '/subscribe?token=chk_t&tenant_id=tenant-a',
      { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Key': 'abc' } },
      envWith(hub)
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('upgraded');
    expect(hub.namespace.idFromName).toHaveBeenCalledWith('tenant-a');
    expect(hub.namespace.get).toHaveBeenCalledWith({ id: 'id:tenant-a' });
    expect(hub.fetch).toHaveBeenCalledTimes(2);

    const [setupUrl, setupInit] = must(hub.fetch.mock.calls[0], 'setup call') as [
      string,
      RequestInit,
    ];
    expect(setupUrl).toBe('https://internal/setup');
    expect(setupInit.method).toBe('POST');
    expect(setupInit.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(setupInit.body as string)).toEqual({ tenant_id: 'tenant-a' });

    const forwarded = must(hub.fetch.mock.calls[1]?.[0], 'forwarded request') as Request;
    const url = new URL(forwarded.url);
    expect(url.pathname).toBe('/websocket');
    expect(url.search).toBe('?token=chk_t&tenant_id=tenant-a');
    expect(forwarded.headers.get('Upgrade')).toBe('websocket');
    expect(forwarded.headers.get('Sec-WebSocket-Key')).toBe('abc');
  });

  it('uses the credential tenant when the query names none', async () => {
    const hub = createHub();
    await upgrade(hub, '/subscribe?token=t');
    expect(hub.namespace.idFromName).toHaveBeenCalledWith('tenant-a');
  });

  it('answers 500 and logs under SUBSCRIBE when the hub fails', async () => {
    const failure = new Error('hub unavailable');
    const hub = createHub(async () => {
      throw failure;
    });
    const response = await upgrade(hub);
    expect(response.status).toBe(500);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
    expect(spies.moduleName).toHaveBeenCalledWith('SUBSCRIBE');
    expect(spies.logError).toHaveBeenCalledWith(
      'WebSocket upgrade error',
      { error: 'Error: hub unavailable' },
      failure
    );
  });
});

describe('GET /subscribe/stats', () => {
  const stats = (hub: Hub | null, url = '/subscribe/stats?tenant_id=tenant-a', env?: object) =>
    subscribeRoutes.request(
      url,
      { headers: { Authorization: 'Bearer chk_stats' } },
      env ?? envWith(hub)
    );

  it('is off unless the Check API is exactly enabled', async () => {
    const hub = createHub();
    const response = await stats(hub, undefined, envWith(hub, { ENABLE_CHECK_API: 'false' }));
    expect(response.status).toBe(403);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
    expect(spies.authenticate).not.toHaveBeenCalled();
  });

  it('authenticates with the Authorization header and the route collaborators', async () => {
    const hub = createHub();
    const env = envWith(hub);
    await stats(hub, undefined, env);
    expect(spies.authenticate).toHaveBeenCalledWith('Bearer chk_stats', {
      db: adapter,
      cache: env.CHECK_CACHE_KV,
      policyApiSecret: 'policy-secret',
    });
  });

  it('answers 401 when unauthenticated, 500 without the hub, 403 for another tenant', async () => {
    const hub = createHub();
    spies.authenticate.mockResolvedValue({ authenticated: false });
    let response = await stats(hub);
    expect(response.status).toBe(401);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);

    spies.authenticate.mockResolvedValue(auth);
    response = await stats(null);
    expect(response.status).toBe(500);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.INTERNAL_ERROR);

    response = await stats(hub, '/subscribe/stats?tenant_id=tenant-b');
    expect(response.status).toBe(403);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    expect(hub.fetch).not.toHaveBeenCalled();
  });

  it('returns the hub stats with the tenant and websocket flag', async () => {
    const hub = createHub();
    const response = await stats(hub);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenant_id: 'tenant-a',
      websocket_enabled: true,
      active_connections: 2,
      subscriptions: 3,
    });
    expect(hub.namespace.idFromName).toHaveBeenCalledWith('tenant-a');
    expect(hub.namespace.get).toHaveBeenCalledWith({ id: 'id:tenant-a' });
    expect(hub.fetch).toHaveBeenCalledWith('https://internal/stats', { method: 'GET' });
  });

  it('reports websocket_enabled false when the flag is not exactly true', async () => {
    const hub = createHub(async () =>
      Response.json({ tenant_id: 'tenant-a', active_connections: 0, subscriptions: 0 })
    );
    const off = envWith(hub, { ENABLE_CHECK_API_WEBSOCKET: 'false' });
    expect(await (await stats(hub, undefined, off)).json()).toEqual({
      tenant_id: 'tenant-a',
      websocket_enabled: false,
      active_connections: 0,
      subscriptions: 0,
    });
  });

  it('answers 500 and logs the status when the hub answers non-2xx', async () => {
    const hub = createHub(async () => new Response('down', { status: 503 }));
    const response = await stats(hub);
    expect(response.status).toBe(500);
    expect(lastErrorCode()).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
    expect(spies.moduleName).toHaveBeenCalledWith('SUBSCRIBE');
    const call = must(spies.logError.mock.calls[0], 'a log call');
    expect(call[0]).toBe('Stats error');
    expect(call[1]).toEqual({ error: 'Error: Hub returned 503' });
    expect((call[2] as Error).message).toBe('Hub returned 503');
  });

  it('answers 500 when the hub request throws', async () => {
    const hub = createHub(async () => {
      throw new Error('unreachable');
    });
    const response = await stats(hub);
    expect(response.status).toBe(500);
    expect(spies.logError.mock.calls[0]?.[0]).toBe('Stats error');
  });
});

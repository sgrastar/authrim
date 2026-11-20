import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  DEFAULT_CLIENT,
  createAuthorizeApp,
  createMockEnv,
  createMockPARRequestStore,
  putSystemSettings,
  putTenantSettings,
  redirectedError,
} from './helpers/mut-authorize-env';

const mockGetClient = vi.hoisted(() =>
  vi.fn<(env: unknown, clientId: string) => Promise<Record<string, unknown> | null>>()
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClient: mockGetClient,
    getClientCached: vi.fn((_c: unknown, env: unknown, clientId: string) =>
      mockGetClient(env, clientId)
    ),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: { DB: unknown }, partition?: string) =>
        (
          actual as unknown as {
            ensureDatabaseAdapter: (db: unknown, partition?: string) => unknown;
          }
        ).ensureDatabaseAdapter(env.DB, partition)
    ),
  };
});

let app: Hono<{ Bindings: Env }>;
let env: Env;

function useClient(overrides: Record<string, unknown> = {}) {
  mockGetClient.mockResolvedValue({ ...DEFAULT_CLIENT, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  useClient();
  app = createAuthorizeApp();
  env = createMockEnv();
});

const PAR_URN = 'urn:ietf:params:oauth:request_uri:';
const LEGACY_URI = `${PAR_URN}legacy-handle`;

function usePar(stored: Record<string, unknown> | null) {
  const store = createMockPARRequestStore(stored ?? {});
  if (stored === null) store._getRequestRpc.mockResolvedValue(null);
  env.PAR_REQUEST_STORE = store as unknown as Env['PAR_REQUEST_STORE'];
  return store;
}

const pushed = {
  client_id: 'test-client',
  response_type: 'code',
  redirect_uri: 'https://example.com/callback',
  scope: 'openid unknown-scope',
  state: 'pushed-state',
};

async function call(query: string) {
  return app.request(`/authorize?${query}`, { method: 'GET' }, env);
}

describe('authorize: PAR request_uri', () => {
  it('answers 500 without PAR storage', async () => {
    (env as { PAR_REQUEST_STORE?: unknown }).PAR_REQUEST_STORE = undefined;
    const response = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'PAR request storage unavailable',
    });
  });

  it('requires client_id for a legacy request_uri', async () => {
    usePar(pushed);
    const response = await call(`request_uri=${encodeURIComponent(LEGACY_URI)}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'client_id required for legacy PAR format',
    });
  });

  it('loads a legacy request from the store named by client_id and applies it', async () => {
    const store = usePar(pushed);
    const response = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client&state=outer-state`
    );
    expect(store.idFromName).toHaveBeenCalledWith('test-client');
    expect(store._getRequestRpc).toHaveBeenCalledWith(LEGACY_URI);
    const { target, params } = redirectedError(response);
    expect(target).toBe('https://example.com/callback');
    expect(params.get('error')).toBe('invalid_scope');
    expect(params.get('state')).toBe('pushed-state');
  });

  it('defaults an empty pushed response_type to code', async () => {
    usePar({ ...pushed, response_type: '' });
    const response = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    expect(redirectedError(response).params.get('error')).toBe('invalid_scope');
  });

  it('applies a pushed max_age (a number) as the request max_age', async () => {
    usePar({ ...pushed, scope: 'openid', max_age: -5 });
    const response = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'max_age must be a non-negative integer',
    });
  });

  it('treats a pushed request as integrity protected (signed request object requirement)', async () => {
    await putTenantSettings(env, 'security', { 'security.require_signed_request_object': true });
    usePar({ ...pushed, scope: 'openid' });
    const response = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    expect(response.headers.get('Location')).toContain('https://login.example.com/login');
  });

  it('keeps the encrypted request object requirement for a pushed request not encrypted', async () => {
    await putTenantSettings(env, 'security', { 'security.require_encrypted_request_object': true });
    usePar({ ...pushed, scope: 'openid' });
    const refusedResponse = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    expect(redirectedError(refusedResponse).params.get('error')).toBe('invalid_request_object');

    usePar({ ...pushed, scope: 'openid', request_object_encrypted: true });
    const accepted = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    expect(accepted.headers.get('Location')).toContain('https://login.example.com/login');
  });

  it.each([
    ['missing', null],
    ['consumed', { ...pushed, consumed: true }],
    ['of another tenant', { ...pushed, tenant_id: 'other' }],
    ['of another client', { ...pushed, client_id: 'other-client' }],
    ['of another authorization server', { ...pushed, authorization_server: 'as-2' }],
  ])(
    'refuses a pushed request that is %s by redirect when the outer request is trusted',
    async (_l, stored) => {
      usePar(stored);
      const response = await call(
        `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client&redirect_uri=${encodeURIComponent('https://example.com/callback')}&state=outer`
      );
      const { target, params } = redirectedError(response);
      expect(target).toBe('https://example.com/callback');
      expect(params.get('error')).toBe('invalid_request_uri');
      expect(params.get('error_description')).toBe('Invalid or expired request_uri');
      expect(params.get('state')).toBe('outer');
    }
  );

  it('refuses as JSON when the store fails or the outer redirect is not trusted', async () => {
    const store = usePar(pushed);
    store._getRequestRpc.mockRejectedValue(new Error('DO down'));
    const noRedirect = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    expect(noRedirect.status).toBe(400);
    expect(await noRedirect.json()).toEqual({
      error: 'invalid_request_uri',
      error_description: 'Invalid or expired request_uri',
    });

    const unregistered = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`
    );
    expect(unregistered.status).toBe(400);

    useClient({ tenant_id: 'other' });
    const otherTenant = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client&redirect_uri=${encodeURIComponent('https://example.com/callback')}`
    );
    expect(otherTenant.status).toBe(400);
    expect(otherTenant.headers.get('Location')).toBeNull();
  });

  it('redirects the invalid request_uri error to a native app loopback', async () => {
    delete (env as { HTTPS_REDIRECT_ONLY?: string }).HTTPS_REDIRECT_ONLY;
    useClient({ application_type: 'native' });
    usePar(null);
    const response = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client&redirect_uri=${encodeURIComponent('http://localhost:3000/callback')}`
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toMatch(
      /^http:\/\/localhost:3000\/callback\?error=invalid_request_uri/
    );
  });
});

describe('authorize: FAPI public clients on a pushed request', () => {
  const pushedFapi = {
    ...pushed,
    scope: 'openid',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
  };

  it.each(['0', 'False'])('reads FAPI_ALLOW_PUBLIC_CLIENTS=%s as disallowing', async (value) => {
    await putSystemSettings(env, { fapi: { enabled: true } });
    env.FAPI_ALLOW_PUBLIC_CLIENTS = value;
    usePar(pushedFapi);
    const response = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    const { params } = redirectedError(response);
    expect(params.get('error')).toBe('invalid_client');
    expect(params.get('error_description')).toBe('Public clients are not allowed in FAPI 2.0 mode');
  });

  it('allows public clients for any other FAPI_ALLOW_PUBLIC_CLIENTS value', async () => {
    await putSystemSettings(env, { fapi: { enabled: true } });
    env.FAPI_ALLOW_PUBLIC_CLIENTS = 'yes';
    usePar(pushedFapi);
    const response = await call(
      `request_uri=${encodeURIComponent(LEGACY_URI)}&client_id=test-client`
    );
    expect(response.headers.get('Location')).not.toContain('error=invalid_client');
  });
});

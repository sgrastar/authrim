import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import {
  DEFAULT_CLIENT,
  authorizeQuery,
  createAuthorizeApp,
  createMockEnv,
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

async function get(path: string, init: RequestInit = {}) {
  return app.request(path, { method: 'GET', ...init }, env);
}

describe('authorize: requests refused before the client is trusted', () => {
  it('refuses request and request_uri together as JSON', async () => {
    const response = await get(
      authorizeQuery({ request: 'a.b.c', request_uri: 'urn:ietf:params:oauth:request_uri:x' })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'request and request_uri must not be used together',
    });
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it('answers a missing response_type with a local error page, not a redirect', async () => {
    const response = await get(authorizeQuery({ response_type: undefined }));
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('<strong>Error:</strong> invalid_request');
    expect(html).toContain('response_type is required');
    expect(html).toContain('<title>Invalid Authorization Request</title>');
  });

  it('answers an unknown response_type with unsupported_response_type on the local page', async () => {
    const response = await get(authorizeQuery({ response_type: 'magic' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    const html = await response.text();
    expect(html).toContain('<strong>Error:</strong> unsupported_response_type');
    expect(html).not.toContain('<strong>Error:</strong> invalid_request');
  });

  it('refuses a missing client_id as JSON invalid_request', async () => {
    const response = await get(authorizeQuery({ client_id: undefined }));
    expect(response.status).toBe(400);
    const body = await response.json<Record<string, string>>();
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toEqual(expect.stringContaining('client_id'));
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it.each(['-1', 'abc', '10abc', '1.5', ' 5'])('refuses max_age=%j', async (maxAge) => {
    const response = await get(authorizeQuery({ max_age: maxAge }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'max_age must be a non-negative integer',
    });
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it.each(['0', '3600'])('accepts max_age=%s and goes on to the login screen', async (maxAge) => {
    const response = await get(authorizeQuery({ max_age: maxAge }));
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('https://login.example.com/login');
  });

  it('shows the Invalid Client page for an unknown client_id', async () => {
    mockGetClient.mockResolvedValue(null);
    const response = await get(authorizeQuery());
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    const html = await response.text();
    expect(html).toContain('<title>Invalid Client</title>');
    expect(html).toContain('client_id is invalid');
  });
});

describe('authorize: client tenant', () => {
  it('refuses a client of another tenant on a non-default tenant', async () => {
    app = createAuthorizeApp('tenant-b');
    useClient({ tenant_id: 'tenant-a' });
    const response = await get(authorizeQuery());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'client_id is invalid for this tenant',
    });
  });

  it('does not refuse a client of its own tenant', async () => {
    app = createAuthorizeApp('tenant-b');
    useClient({ tenant_id: 'tenant-b' });
    const response = await get(authorizeQuery());
    const text = await response.clone().text();
    expect(text).not.toContain('client_id is invalid for this tenant');
  });

  it('does not apply the tenant check on the default tenant (single-tenant compatibility)', async () => {
    useClient({ tenant_id: 'tenant-a' });
    const response = await get(authorizeQuery());
    expect(await response.text()).not.toContain('client_id is invalid for this tenant');
  });

  it('treats an empty tenant_id as unset', async () => {
    app = createAuthorizeApp('tenant-b');
    useClient({ tenant_id: '' });
    const response = await get(authorizeQuery());
    expect(await response.text()).not.toContain('client_id is invalid for this tenant');
  });
});

describe('authorize: redirect_uri', () => {
  it('uses the only registered redirect_uri when the request names none', async () => {
    useClient({ redirect_uris: ['https://only.example.com/cb'] });
    const response = await get(
      authorizeQuery({ redirect_uri: undefined, response_type: 'code', scope: 'bogus-scope!' })
    );
    // An error after redirect_uri validation is returned to the default redirect_uri.
    const { target } = redirectedError(response);
    expect(target).toBe('https://only.example.com/cb');
  });

  it('requires redirect_uri when several are registered', async () => {
    const response = await get(authorizeQuery({ redirect_uri: undefined }));
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    const html = await response.text();
    expect(html).toContain('<title>Missing Redirect URI</title>');
    expect(html).toContain('redirect_uri is required when multiple redirect URIs are registered');
  });

  it('shows the Invalid Redirect URI page with the validation error', async () => {
    const response = await get(authorizeQuery({ redirect_uri: 'javascript:alert(1)' }));
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('<title>Invalid Redirect URI</title>');
    expect(html).toMatch(/<strong>Description:<\/strong> \S+/);
  });

  it('shows the Unregistered Redirect URI page with the URI escaped', async () => {
    const response = await get(
      authorizeQuery({ redirect_uri: 'https://evil.example.com/cb?x=<b>"' })
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    const html = await response.text();
    expect(html).toContain('<title>Unregistered Redirect URI</title>');
    expect(html).toContain('redirect_uri is not registered for this client');
    expect(html).toContain('https://evil.example.com/cb?x=&lt;b&gt;&quot;');
    expect(html).not.toContain('<b>"');
  });

  it('does not default redirect_uri for a client with none registered', async () => {
    useClient({ redirect_uris: [] });
    const response = await get(authorizeQuery({ redirect_uri: undefined }));
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('<title>Invalid Redirect URI</title>');
    expect(html).toContain('<strong>Description:</strong> redirect_uri is required');
  });

  it('refuses an error_uri on another origin with the Invalid Custom Redirect URI page', async () => {
    const response = await get(authorizeQuery({ error_uri: 'https://evil.example.org/err' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    const html = await response.text();
    expect(html).toContain('<title>Invalid Custom Redirect URI</title>');
    expect(html).toContain('error_uri:');
  });

  it('refuses a cancel_uri on another origin', async () => {
    const response = await get(authorizeQuery({ cancel_uri: 'https://evil.example.org/cancel' }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('cancel_uri:');
  });

  it('sends later errors to a same-origin error_uri', async () => {
    const response = await get(
      authorizeQuery({ error_uri: 'https://example.com/error', scope: 'not a valid!scope' })
    );
    expect(response.status).toBe(302);
    const { target, params } = redirectedError(response);
    expect(target).toBe('https://example.com/error');
    expect(params.get('error')).toBe('invalid_scope');
    expect(params.get('state')).toBe('test-state');
  });
});

describe('authorize: settings that refuse the request', () => {
  it('fails closed (503) when the tenant response type policy is invalid', async () => {
    await putTenantSettings(env, 'oauth', { 'oauth.response_types_supported': ['code', 'nope'] });
    const response = await get(authorizeQuery());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'OIDC response type policy is unavailable',
    });
  });

  it('refuses a response_type the tenant has not enabled, by redirect', async () => {
    useClient({ response_types: ['code', 'code id_token'] });
    await putTenantSettings(env, 'oauth', { 'oauth.response_types_supported': ['code'] });
    const response = await get(authorizeQuery({ response_type: 'code id_token', nonce: 'n' }));
    expect(response.status).toBe(302);
    const { target, params } = redirectedError(response);
    expect(target).toBe('https://example.com/callback');
    expect(params.get('error')).toBe('unsupported_response_type');
    expect(params.get('error_description')).toBe(
      "Response type 'code id_token' is not enabled for this tenant"
    );
    expect(params.get('state')).toBe('test-state');
  });

  it('accepts a response_type the tenant has enabled', async () => {
    await putTenantSettings(env, 'oauth', { 'oauth.response_types_supported': ['code'] });
    const response = await get(authorizeQuery());
    expect(response.headers.get('Location')).toContain('https://login.example.com/login');
  });

  it('refuses a response_type the client is not registered for', async () => {
    const response = await get(authorizeQuery({ response_type: 'id_token', nonce: 'n' }));
    expect(response.status).toBe(302);
    const { params } = redirectedError(response);
    expect(params.get('error')).toBe('unsupported_response_type');
    expect(params.get('error_description')).toBe(
      "Response type 'id_token' is not allowed for this client. Allowed: code"
    );
  });

  it('defaults a client without response_types to code only', async () => {
    useClient({ response_types: undefined });
    const refused = await get(authorizeQuery({ response_type: 'code id_token', nonce: 'n' }));
    expect(redirectedError(refused).params.get('error_description')).toBe(
      "Response type 'code id_token' is not allowed for this client. Allowed: code"
    );
    const allowed = await get(authorizeQuery());
    expect(allowed.headers.get('Location')).toContain('https://login.example.com/login');
  });

  it('returns a FAPI error to the registered redirect_uri with the request state', async () => {
    await putSystemSettings(env, { fapi: { enabled: true } });
    const response = await get(authorizeQuery({ state: 'fapi-state' }));
    const { target, params } = redirectedError(response);
    expect(target).toBe('https://example.com/callback');
    expect(params.get('error')).toBe('invalid_request');
    expect(params.get('error_description')).toBe(
      'PAR is required in FAPI 2.0 mode. Use /par endpoint first.'
    );
    expect(params.get('state')).toBe('fapi-state');
  });
});

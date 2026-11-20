import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = await vi.hoisted(async () =>
  (await import('./helpers/mut-admin-agent-oauth-fixture')).createAgentOAuthFixture()
);

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    resolveSelfServiceAgentAccessSnapshot: fx.resolveSnapshot,
    AdminAgentAccessRepository: class {
      findActiveGrantForDelegatorClient = fx.findActiveGrantForDelegatorClient;
      getGrantRecord = fx.getGrantRecord;
      getSystemManagedTaskSetCatalogVersion = fx.getSystemManagedTaskSetCatalogVersion;
      grantConsentPair = fx.grantConsentPair;
      createSelfServiceAuthorization = fx.createSelfServiceAuthorization;
      replaceSelfServiceAuthorization = fx.replaceSelfServiceAuthorization;
      suspendForClientMetadataChange = fx.suspendForClientMetadataChange;
    },
  };
});
vi.mock('@authrim/ar-agent-access/platform/cloudflare/admin-agent-audit-writer', () => ({
  createCloudflareAdminAgentAuditWriter: vi.fn(() => ({})),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getClientCached: fx.getClientCached,
    getPARRequestStoreByUri: fx.getPARRequestStoreByUri,
    getPARRequestStoreForNewRequest: fx.getPARRequestStoreForNewRequest,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    safeFetchJson: fx.safeFetchJson,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: { execute: fx.coreExecute } })),
    ClientRepository: class {
      create = fx.clientCreate;
    },
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    authenticateConfidentialOAuthClient: fx.authenticateConfidentialOAuthClient,
    resolvePlatformSettingsWithSources: fx.resolvePlatformSettingsWithSources,
  };
});
vi.mock('../issuer', () => ({ getRequestIssuer: vi.fn(() => fx.issuer) }));

import { adminAgentAuthorizeHandler, adminAgentParHandler } from '../admin-agent-oauth';
import {
  agentApp,
  CHALLENGE,
  ISSUER,
  REQUEST_URI,
  RESOURCE,
  resetAgentOAuthFixture,
} from './helpers/mut-admin-agent-oauth-fixture';

const app = agentApp(fx, { par: adminAgentParHandler, authorize: adminAgentAuthorizeHandler });

beforeEach(() => resetAgentOAuthFixture(fx));

const enabledEnv = { ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} };

function form(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    client_id: 'mcp-client',
    response_type: 'code',
    redirect_uri: 'https://client.example.com/callback',
    scope: 'agent:read',
    resource: RESOURCE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'opaque-state',
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, value);
  return params;
}

async function par(
  body: URLSearchParams | string = form(),
  env: Record<string, unknown> = enabledEnv,
  headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
) {
  const response = await app.fetch(
    new Request(`${ISSUER}/oauth/admin-agent/par`, { method: 'POST', headers, body }),
    env
  );
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: await response.json<Record<string, unknown>>(),
  };
}

function kv(value: string | null | Error) {
  return {
    get: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

describe('Admin Agent feature flag', () => {
  it.each([
    ['tenant object true', JSON.stringify({ 'agent.mcp.enabled': true }), undefined, 201],
    ['tenant boolean true', 'true', 'false', 201],
    ['tenant object false', JSON.stringify({ 'agent.mcp.enabled': false }), 'true', 404],
    ['tenant array', '[true]', 'true', 404],
    ['no tenant value, env true', null, 'true', 201],
    ['no tenant value, env unset', null, undefined, 404],
  ])('decides %s', async (_label, stored, envValue, status) => {
    const settings = kv(stored);
    const result = await par(form(), {
      PAR_REQUEST_STORE: {},
      SETTINGS: settings,
      ENABLE_AGENT_MCP: envValue,
    });
    expect(result.status).toBe(status);
    expect(settings.get).toHaveBeenCalledWith('settings:tenant:tenant-1:agent-access');
    if (status === 404) expect(result.body).toEqual({ error: 'not_found' });
  });

  it('falls back to AUTHRIM_CONFIG when SETTINGS is absent', async () => {
    const config = kv(JSON.stringify({ 'agent.mcp.enabled': true }));
    expect((await par(form(), { PAR_REQUEST_STORE: {}, AUTHRIM_CONFIG: config })).status).toBe(201);
    expect(config.get).toHaveBeenCalled();
  });

  it.each([[new Error('kv down')], ['{not json']])(
    'reports unavailable configuration (%s)',
    async (value) => {
      const result = await par(form(), { PAR_REQUEST_STORE: {}, SETTINGS: kv(value) });
      expect(result).toMatchObject({
        status: 503,
        body: {
          error: 'temporarily_unavailable',
          error_description: 'Agent access configuration unavailable',
        },
      });
    }
  );
});

describe('Admin Agent PAR validation', () => {
  it('requires a form-encoded body', async () => {
    expect(await par('{}', enabledEnv, { 'content-type': 'application/json' })).toMatchObject({
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
    });
    expect((await par('x', enabledEnv, {})).status).toBe(400);
  });

  it.each([
    [{ request: 'x' }, 'invalid_request', 'Unsupported PAR parameter'],
    [{ client_id: undefined }, 'invalid_request', 'Required PAR parameter is missing'],
    [{ redirect_uri: undefined }, 'invalid_request', 'Required PAR parameter is missing'],
    [{ scope: undefined }, 'invalid_request', 'Required PAR parameter is missing'],
    [{ resource: undefined }, 'invalid_request', 'Required PAR parameter is missing'],
    [{ response_type: undefined }, 'invalid_request', 'Required PAR parameter is missing'],
    [{ code_challenge: undefined }, 'invalid_request', 'Required PAR parameter is missing'],
    [
      { response_type: 'token' },
      'unsupported_response_type',
      'Only response_type=code is supported',
    ],
    [{ resource: `${ISSUER}/other` }, 'invalid_target', 'resource must identify this MCP endpoint'],
    [
      { code_challenge_method: 'plain' },
      'invalid_request',
      'PKCE with a valid S256 challenge is required',
    ],
    [
      { code_challenge_method: undefined },
      'invalid_request',
      'PKCE with a valid S256 challenge is required',
    ],
    [
      { code_challenge: 'a'.repeat(42) },
      'invalid_request',
      'PKCE with a valid S256 challenge is required',
    ],
    [
      { code_challenge: 'a'.repeat(129) },
      'invalid_request',
      'PKCE with a valid S256 challenge is required',
    ],
    [
      { code_challenge: `${'a'.repeat(42)}=` },
      'invalid_request',
      'PKCE with a valid S256 challenge is required',
    ],
    [{ scope: '   ' }, 'invalid_scope', 'Only registered agent:* scopes are supported'],
    [
      { scope: 'agent:read openid' },
      'invalid_scope',
      'Only registered agent:* scopes are supported',
    ],
    [
      { authorization_details: 'not json' },
      'invalid_authorization_details',
      'authorization_details is outside the Admin Agent contract',
    ],
    [
      { authorization_details: '[{"type":"other"}]' },
      'invalid_authorization_details',
      'authorization_details is outside the Admin Agent contract',
    ],
  ])('rejects %j', async (overrides, error, description) => {
    expect(await par(form(overrides))).toEqual({
      status: 400,
      cache: null,
      body: { error, error_description: description },
    });
    expect(fx.getClientCached).not.toHaveBeenCalled();
  });

  it('accepts boundary PKCE challenge lengths', async () => {
    expect((await par(form({ code_challenge: 'A_-9'.repeat(32) }))).status).toBe(201);
    expect((await par(form({ code_challenge: 'b'.repeat(43) }))).status).toBe(201);
  });

  it('rejects an invalid client_id that is not a metadata document URL', async () => {
    const result = await par(form({ client_id: 'bad client id\u0000' }));
    expect(result).toMatchObject({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client authentication failed' },
    });
  });

  it.each([
    ['an unknown client', () => fx.getClientCached.mockResolvedValue(null)],
    [
      'a disabled client',
      () =>
        fx.getClientCached.mockResolvedValue({
          client_id: 'mcp-client',
          enabled: false,
          redirect_uris: [],
        }),
    ],
  ])('rejects %s', async (_label, arrange) => {
    arrange();
    expect(await par()).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    expect(fx.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects a secret presented by a public client', async () => {
    const result = await par(form({ client_secret: 'secret' }));
    expect(result).toMatchObject({
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client authentication failed' },
    });
  });

  it('reports malformed client credentials', async () => {
    const result = await par(form({ client_secret: 'x' }), enabledEnv, {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa('mcp-client:x')}`,
    });
    expect(result).toMatchObject({
      status: 401,
      body: {
        error: 'invalid_client',
        error_description: 'Multiple client authentication methods are not allowed',
      },
    });
  });

  it('authenticates a confidential client against the PAR endpoint', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'client_secret_post',
      requestable_scopes: ['agent:read'],
    });
    fx.authenticateConfidentialOAuthClient.mockResolvedValueOnce({
      ok: false,
      error: 'invalid_client',
      errorDescription: 'bad secret',
    });
    expect(await par(form({ client_secret: 's3cret' }))).toMatchObject({
      status: 401,
      body: { error: 'invalid_client', error_description: 'bad secret' },
    });
    const [client, audience, credentials, options] =
      fx.authenticateConfidentialOAuthClient.mock.calls[0];
    expect(client.client_id).toBe('mcp-client');
    expect(audience).toBe(`${ISSUER}/oauth/admin-agent/par`);
    expect(credentials).toMatchObject({ clientId: 'mcp-client' });
    expect(options).toMatchObject({ replayProtection: { tenantId: 'tenant-1' } });
    expect((await par(form({ client_secret: 's3cret' }))).status).toBe(201);
  });

  it.each([
    [
      { redirect_uri: 'https://client.example.com/other' },
      'invalid_request',
      'redirect_uri is not registered for this client',
    ],
    [
      { redirect_uri: 'javascript:alert(1)' },
      'invalid_request',
      'redirect_uri is not registered for this client',
    ],
    [
      { scope: 'agent:execute' },
      'invalid_scope',
      'Client is not registered for the requested scope',
    ],
  ])('rejects %j after client resolution', async (overrides, error, description) => {
    expect(await par(form(overrides))).toMatchObject({
      status: 400,
      body: { error, error_description: description },
    });
  });

  it('rejects a client without requestable scopes', async () => {
    fx.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect((await par()).body).toEqual({
      error: 'invalid_scope',
      error_description: 'Client is not registered for the requested scope',
    });
  });

  it('requires PAR storage', async () => {
    expect(await par(form(), { ENABLE_AGENT_MCP: 'true' })).toMatchObject({
      status: 500,
      body: { error: 'server_error', error_description: 'PAR request storage unavailable' },
    });
  });

  it('stores the exact request with normalised scope and RAR', async () => {
    const result = await par(
      form({
        scope: 'agent:read  agent:write',
        state: undefined,
        authorization_details: '[{"type":"authrim_admin_agent","max_subjects_per_call":5}]',
      })
    );
    expect(result).toEqual({
      status: 201,
      cache: 'no-store',
      body: { request_uri: REQUEST_URI, expires_in: 60 },
    });
    expect(fx.getPARRequestStoreForNewRequest.mock.calls[0].slice(1, 3)).toEqual([
      'tenant-1',
      'mcp-client',
    ]);
    expect(fx.storeRequestRpc).toHaveBeenCalledWith({
      requestUri: REQUEST_URI,
      ttl: 60,
      data: {
        authorization_server: 'admin_agent',
        tenant_id: 'tenant-1',
        client_id: 'mcp-client',
        redirect_uri: 'https://client.example.com/callback',
        response_type: 'code',
        scope: 'agent:read agent:write',
        state: undefined,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        resource: RESOURCE,
        authorization_details: '[{"type":"authrim_admin_agent","max_subjects_per_call":5}]',
      },
    });
  });

  it('rejects authorization_details above 16 KiB', async () => {
    const details = JSON.stringify([{ type: 'authrim_admin_agent', pad: 'x'.repeat(16 * 1024) }]);
    expect((await par(form({ authorization_details: details }))).body).toMatchObject({
      error: 'invalid_authorization_details',
    });
  });
});

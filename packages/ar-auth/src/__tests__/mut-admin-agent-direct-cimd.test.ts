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

const CIMD = 'https://client.example.com/cimd.json';
const env = { ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} };

function query(overrides: Record<string, string | string[] | undefined> = {}) {
  const values: Record<string, string | string[] | undefined> = {
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
  for (const [key, value] of Object.entries(values)) {
    for (const item of value === undefined ? [] : Array.isArray(value) ? value : [value])
      params.append(key, item);
  }
  return params.toString();
}

async function direct(qs: string, e: Record<string, unknown> = env) {
  const response = await app.fetch(new Request(`${ISSUER}/oauth/admin-agent/authorize?${qs}`), e);
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get('location'),
    cache: response.headers.get('cache-control'),
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

function document(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CIMD,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback'],
    ...overrides,
  };
}

describe('direct authorization request', () => {
  it.each([
    [{ request: 'x' }, 'invalid_request', 'Unsupported authorization parameter'],
    [
      { resource: [RESOURCE, `${ISSUER}/other`] },
      'invalid_target',
      'resource must identify this MCP server',
    ],
    [
      { resource: Array(11).fill(RESOURCE) },
      'invalid_target',
      'resource must identify this MCP server',
    ],
    [{ scope: ['agent:read', 'agent:read'] }, 'invalid_request', 'Duplicate scope parameter'],
    [
      { code_challenge_method: 'plain' },
      'invalid_request',
      'PKCE with a valid S256 challenge is required',
    ],
    [{ client_id: 'bad id\u0000' }, 'invalid_request', 'Invalid client_id'],
    [
      { redirect_uri: 'https://client.example.com/other' },
      'invalid_request',
      'redirect_uri is not registered for this client',
    ],
    [
      { scope: 'agent:execute' },
      'invalid_scope',
      'Client is not registered for the requested scope',
    ],
  ])('rejects %j', async (overrides, error, description) => {
    expect(await direct(query(overrides))).toMatchObject({
      status: 400,
      body: { error, error_description: description },
    });
    expect(fx.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects an unregistered client and missing storage', async () => {
    fx.getClientCached.mockResolvedValueOnce(null);
    expect((await direct(query())).body).toEqual({
      error: 'unauthorized_client',
      error_description: 'Client is not registered',
    });
    expect(await direct(query(), { ENABLE_AGENT_MCP: 'true' })).toMatchObject({
      status: 500,
      body: { error: 'server_error', error_description: 'PAR request storage unavailable' },
    });
  });

  it('accepts repeated identical resources and redirects to the PAR journey', async () => {
    const result = await direct(query({ resource: [RESOURCE, RESOURCE], state: undefined }));
    expect(result.status).toBe(302);
    expect(result.cache).toBe('no-store');
    const location = new URL(result.location!);
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/oauth/admin-agent/authorize`);
    expect(location.searchParams.get('request_uri')).toBe(REQUEST_URI);
    expect(location.searchParams.get('client_id')).toBe('mcp-client');
    expect(fx.storeRequestRpc.mock.calls[0][0]).toMatchObject({
      requestUri: REQUEST_URI,
      ttl: 60,
      data: {
        authorization_server: 'admin_agent',
        tenant_id: 'tenant-1',
        client_id: 'mcp-client',
        scope: 'agent:read',
        state: undefined,
        resource: RESOURCE,
        code_challenge_method: 'S256',
      },
    });
  });
});

describe('client ID metadata documents', () => {
  beforeEach(() => {
    fx.getClientCached.mockResolvedValue(null);
    fx.safeFetchJson.mockResolvedValue(document());
  });

  it('fetches with strict transport limits and registers a native public client', async () => {
    const before = Date.now();
    const result = await direct(
      query({ client_id: CIMD, redirect_uri: 'http://localhost:41234/callback' })
    );
    expect(result.status).toBe(302);
    expect(fx.safeFetchJson).toHaveBeenCalledWith(CIMD, {
      requireHttps: true,
      allowLocalhost: false,
      timeoutMs: 3000,
      maxResponseSize: 64 * 1024,
      redirect: 'error',
    });
    expect(fx.clientCreate).toHaveBeenCalledWith({
      client_id: CIMD,
      client_name: 'Claude Code',
      tenant_id: 'tenant-1',
      redirect_uris: ['http://localhost/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'agent:read agent:user-data:read agent:write',
      requestable_scopes: ['agent:read', 'agent:user-data:read', 'agent:write'],
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      application_type: 'native',
      client_uri: undefined,
      logo_uri: undefined,
      default_resource: RESOURCE,
      is_trusted: false,
      skip_consent: false,
    });
    const [sql, params] = fx.coreExecute.mock.calls[0];
    expect(sql).toContain("agent_access_registration_mode = 'cimd'");
    expect(Number(params[0]) - Number(params[3])).toBe(30 * 24 * 60 * 60 * 1000);
    expect(params[1]).toBe(CIMD);
    expect(params[2]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params[4]).toBe(Math.max(Number(params[3]), 1001));
    expect(params.slice(5)).toEqual(['tenant-1', CIMD, 1000]);
    expect(Number(params[3])).toBeGreaterThanOrEqual(before);
  });

  it('stays unauthorized when the registration update loses a race or creation fails', async () => {
    fx.coreExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    expect((await direct(query({ client_id: CIMD }))).body).toMatchObject({
      error: 'unauthorized_client',
    });
    fx.clientCreate.mockRejectedValueOnce(new Error('dup'));
    expect((await direct(query({ client_id: CIMD }))).body).toMatchObject({
      error: 'unauthorized_client',
    });
  });

  it.each([
    ['a fetch failure', () => fx.safeFetchJson.mockRejectedValue(new Error('x'))],
    ['an array document', () => fx.safeFetchJson.mockResolvedValue([document()])],
    ['a null document', () => fx.safeFetchJson.mockResolvedValue(null)],
    [
      'another client_id',
      () => fx.safeFetchJson.mockResolvedValue(document({ client_id: `${CIMD}?x` })),
    ],
    [
      'a missing name',
      () => fx.safeFetchJson.mockResolvedValue(document({ client_name: undefined })),
    ],
    ['a blank name', () => fx.safeFetchJson.mockResolvedValue(document({ client_name: '  ' }))],
    [
      'a long name',
      () => fx.safeFetchJson.mockResolvedValue(document({ client_name: 'n'.repeat(101) })),
    ],
    [
      'an http client_uri',
      () =>
        fx.safeFetchJson.mockResolvedValue(document({ client_uri: 'http://client.example.com' })),
    ],
    [
      'a client_uri with userinfo',
      () =>
        fx.safeFetchJson.mockResolvedValue(
          document({ client_uri: 'https://u:p@client.example.com' })
        ),
    ],
    [
      'a logo_uri with fragment',
      () =>
        fx.safeFetchJson.mockResolvedValue(
          document({ logo_uri: 'https://client.example.com/l.png#x' })
        ),
    ],
    ['an empty logo_uri', () => fx.safeFetchJson.mockResolvedValue(document({ logo_uri: '' }))],
    [
      'a non-URL client_uri',
      () => fx.safeFetchJson.mockResolvedValue(document({ client_uri: 'not a url' })),
    ],
    [
      'a long client_uri',
      () =>
        fx.safeFetchJson.mockResolvedValue(
          document({ client_uri: `https://c.example.com/${'a'.repeat(2048)}` })
        ),
    ],
    ['no redirect_uris', () => fx.safeFetchJson.mockResolvedValue(document({ redirect_uris: [] }))],
    [
      'string redirect_uris',
      () => fx.safeFetchJson.mockResolvedValue(document({ redirect_uris: 'http://localhost/cb' })),
    ],
    [
      'eleven redirect_uris',
      () =>
        fx.safeFetchJson.mockResolvedValue(
          document({ redirect_uris: Array(11).fill('http://localhost/cb') })
        ),
    ],
    [
      'a non-string redirect',
      () => fx.safeFetchJson.mockResolvedValue(document({ redirect_uris: [7] })),
    ],
    [
      'an unsafe redirect',
      () =>
        fx.safeFetchJson.mockResolvedValue(document({ redirect_uris: ['javascript:alert(1)'] })),
    ],
    [
      'a long redirect',
      () =>
        fx.safeFetchJson.mockResolvedValue(
          document({ redirect_uris: [`https://c.example.com/${'a'.repeat(2048)}`] })
        ),
    ],
    [
      'a confidential auth method',
      () =>
        fx.safeFetchJson.mockResolvedValue(
          document({ token_endpoint_auth_method: 'client_secret_basic' })
        ),
    ],
    [
      'an implicit grant',
      () =>
        fx.safeFetchJson.mockResolvedValue(
          document({ grant_types: ['authorization_code', 'implicit'] })
        ),
    ],
    [
      'a token response type',
      () => fx.safeFetchJson.mockResolvedValue(document({ response_types: ['code', 'token'] })),
    ],
    [
      'an advanced scope',
      () => fx.safeFetchJson.mockResolvedValue(document({ scope: 'agent:read agent:admin' })),
    ],
    [
      'a scope without agent:read',
      () => fx.safeFetchJson.mockResolvedValue(document({ scope: 'agent:write' })),
    ],
  ])('rejects %s', async (_label, arrange) => {
    arrange();
    const result = await direct(query({ client_id: CIMD }));
    expect(result.body).toEqual({
      error: 'unauthorized_client',
      error_description: 'Client is not registered',
    });
    expect(fx.clientCreate).not.toHaveBeenCalled();
  });

  it('does not fetch a client_id that is not a metadata document URL', async () => {
    const result = await direct(query({ client_id: 'https://client.example.com/' }));
    expect(result.status).toBe(400);
    expect(fx.safeFetchJson).not.toHaveBeenCalled();
  });

  it('keeps optional metadata, declared grants and a narrowed scope', async () => {
    fx.safeFetchJson.mockResolvedValue(
      document({
        client_uri: 'https://client.example.com',
        logo_uri: 'https://client.example.com/logo.png',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'agent:read agent:read',
        dpop_bound_access_tokens: true,
      })
    );
    await direct(query({ client_id: CIMD, redirect_uri: 'http://localhost:8080/callback' }));
    expect(fx.clientCreate.mock.calls[0][0]).toMatchObject({
      client_uri: 'https://client.example.com',
      logo_uri: 'https://client.example.com/logo.png',
      grant_types: ['authorization_code'],
      scope: 'agent:read',
      requestable_scopes: ['agent:read'],
    });
  });

  it.each([
    ['another port syntax', 'http://localhost:0/callback'],
    ['a port above 65535', 'http://localhost:65536/callback'],
    ['a six-digit port', 'http://localhost:123456/callback'],
    ['a changed path', 'http://localhost:8080/callback2'],
    ['no port', 'http://localhost:/callback'],
    ['another host', 'http://localhost.evil:8080/callback'],
  ])('refuses %s for a portless CIMD callback', async (_label, redirectUri) => {
    const result = await direct(query({ client_id: CIMD, redirect_uri: redirectUri }));
    expect(result.body).toMatchObject({
      error_description: 'redirect_uri is not registered for this client',
    });
  });

  it.each([
    ['https://localhost/callback', 'https://localhost:8080/callback'],
    ['http://localhost/callback#x', 'http://localhost:8080/callback#x'],
    ['http://localhostx/callback', 'http://localhostx:8080/callback'],
  ])('does not extend registered %s to a port', async (registered, redirectUri) => {
    fx.safeFetchJson.mockResolvedValue(document({ redirect_uris: [registered] }));
    const result = await direct(query({ client_id: CIMD, redirect_uri: redirectUri }));
    expect(result.status).toBe(400);
  });

  it.each([
    ['http://localhost', 'http://localhost:65535'],
    ['http://LOCALHOST?cb=1', 'http://LOCALHOST:9?cb=1'],
  ])('extends registered %s to %s', async (registered, redirectUri) => {
    fx.safeFetchJson.mockResolvedValue(document({ redirect_uris: [registered] }));
    expect((await direct(query({ client_id: CIMD, redirect_uri: redirectUri }))).status).toBe(302);
  });
});

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getClientCached: vi.fn(),
  getPARRequestStoreForNewRequest: vi.fn(),
  getPARRequestStoreByUri: vi.fn(),
  storeRequestRpc: vi.fn(),
  getRequestRpc: vi.fn(),
  consumeRequestRpc: vi.fn(),
  findActiveGrantForDelegatorClient: vi.fn(),
  getGrantRecord: vi.fn(),
  getSystemManagedTaskSetCatalogVersion: vi.fn(),
  grantConsentPair: vi.fn(),
  createSelfServiceAuthorization: vi.fn(),
  replaceSelfServiceAuthorization: vi.fn(),
  suspendForClientMetadataChange: vi.fn(),
  safeFetchJson: vi.fn(),
  clientCreate: vi.fn(),
  coreExecute: vi.fn(),
  storeCodeRpc: vi.fn(),
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AdminAgentAccessRepository: class {
      findActiveGrantForDelegatorClient = mocks.findActiveGrantForDelegatorClient;
      getGrantRecord = mocks.getGrantRecord;
      getSystemManagedTaskSetCatalogVersion = mocks.getSystemManagedTaskSetCatalogVersion;
      grantConsentPair = mocks.grantConsentPair;
      createSelfServiceAuthorization = mocks.createSelfServiceAuthorization;
      replaceSelfServiceAuthorization = mocks.replaceSelfServiceAuthorization;
      suspendForClientMetadataChange = mocks.suspendForClientMetadataChange;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    buildRequestIssuerUrl: vi.fn(() => 'https://tenant.example.com'),
    getClientCached: mocks.getClientCached,
    getPARRequestStoreByUri: mocks.getPARRequestStoreByUri,
    getPARRequestStoreForNewRequest: mocks.getPARRequestStoreForNewRequest,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    safeFetchJson: mocks.safeFetchJson,
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: { execute: mocks.coreExecute },
    })),
    ClientRepository: class {
      create = mocks.clientCreate;
    },
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
  };
});

import { adminAgentAuthorizeHandler, adminAgentParHandler } from '../admin-agent-oauth';
import { canonicalizeJson, sha256Base64Url } from '@authrim/ar-agent-access/core';

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

function createApp(
  env: Partial<Env> & { ENABLE_AGENT_MCP?: string },
  permissions = ['admin:agent_grants:write', 'admin:users:read']
) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { tenantId: string; adminAuth: Record<string, unknown> };
  }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    c.set('adminAuth', {
      userId: 'admin-1',
      authMethod: 'session',
      tenantId: 'tenant-1',
      permissions,
    });
    await next();
  });
  app.post('/oauth/admin-agent/par', adminAgentParHandler);
  app.get('/oauth/admin-agent/authorize', adminAgentAuthorizeHandler);
  app.post('/oauth/admin-agent/authorize', adminAgentAuthorizeHandler);
  return { app, env: env as Env };
}

function body(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    client_id: 'mcp-client',
    response_type: 'code',
    redirect_uri: 'https://client.example.com/callback',
    scope: 'agent:read',
    resource: 'https://tenant.example.com/mcp',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'opaque-state',
    ...overrides,
  });
}

describe('Admin Agent PAR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read'],
    });
    mocks.clientCreate.mockResolvedValue({ client_id: 'created' });
    mocks.coreExecute.mockResolvedValue({ success: true, rows: [], rowsAffected: 1 });
    mocks.getPARRequestStoreForNewRequest.mockResolvedValue({
      stub: { storeRequestRpc: mocks.storeRequestRpc },
      requestUri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
    });
    const par = {
      authorization_server: 'admin_agent',
      tenant_id: 'tenant-1',
      client_id: 'mcp-client',
      redirect_uri: 'https://client.example.com/callback',
      response_type: 'code',
      scope: 'agent:read',
      state: 'opaque-state',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: 'https://tenant.example.com/mcp',
      consumed: false,
    };
    mocks.getRequestRpc.mockResolvedValue(par);
    mocks.consumeRequestRpc.mockResolvedValue(par);
    mocks.getPARRequestStoreByUri.mockReturnValue({
      stub: {
        getRequestRpc: mocks.getRequestRpc,
        consumeRequestRpc: mocks.consumeRequestRpc,
      },
    });
    mocks.findActiveGrantForDelegatorClient.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerCall: 50 },
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
    });
    mocks.getGrantRecord.mockResolvedValue({ purpose: 'managed_test_fixture' });
    mocks.getSystemManagedTaskSetCatalogVersion.mockResolvedValue('admin-agent-access-v9');
  });

  it('stores a journey- and resource-bound single-use request', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      }),
      env
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
      expires_in: 60,
    });
    expect(mocks.storeRequestRpc).toHaveBeenCalledWith({
      requestUri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
      ttl: 60,
      data: expect.objectContaining({
        authorization_server: 'admin_agent',
        tenant_id: 'tenant-1',
        resource: 'https://tenant.example.com/mcp',
        code_challenge_method: 'S256',
      }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed before client or storage access when the feature is disabled', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'false' });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(mocks.getClientCached).not.toHaveBeenCalled();
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects a resource from another tenant before creating PAR state', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body({ resource: 'https://other.example.com/mcp' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_target' });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects parameters outside the dedicated PAR contract', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body({ request: 'unsupported-request-object' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(mocks.getClientCached).not.toHaveBeenCalled();
  });

  it('accepts only the bounded Admin Agent RAR type', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body({
          authorization_details: JSON.stringify([
            { type: 'authrim_admin_agent', max_subjects_per_call: 50 },
          ]),
        }),
      }),
      env
    );

    expect(response.status).toBe(201);
    expect(mocks.storeRequestRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorization_details: JSON.stringify([
            { type: 'authrim_admin_agent', max_subjects_per_call: 50 },
          ]),
        }),
      })
    );
  });

  it('rejects unregistered RAR fields and types', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body({
          authorization_details: JSON.stringify([
            { type: 'authrim_admin_agent', arbitrary_selector: 'admin:*' },
          ]),
        }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_authorization_details' });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects authorization_details larger than the RFC 9396 storage boundary', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body({ authorization_details: ` ${' '.repeat(16 * 1024)}` }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_authorization_details' });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('requires explicit client registration for every requested Agent scope', async () => {
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read'],
    });
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body({ scope: 'agent:read agent:write' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_scope' });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('does not mistake a private_key_jwt client without a secret hash for a public client', async () => {
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [] },
      requestable_scopes: ['agent:read'],
    });
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', PAR_REQUEST_STORE: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/par', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body(),
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  securityRegressionIt(
    '[security regression][AO-17] rejects a residual client secret for a private_key_jwt client before storing Admin Agent PAR state',
    async () => {
      mocks.getClientCached.mockResolvedValue({
        client_id: 'mcp-client',
        redirect_uris: ['https://client.example.com/callback'],
        token_endpoint_auth_method: 'private_key_jwt',
        client_secret_hash: '3269ad7c6e3e2fe0a25f942328a6099e42978ee9c3d4f55bc222f7520a40d044',
        jwks: { keys: [] },
        requestable_scopes: ['agent:read'],
      });
      const { app, env } = createApp({
        ENABLE_AGENT_MCP: 'true',
        PAR_REQUEST_STORE: {} as never,
      });

      const response = await app.fetch(
        new Request('https://tenant.example.com/oauth/admin-agent/par', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body({ client_secret: 'ciba-secret' }),
        }),
        env
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'invalid_client' });
      expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
    }
  );

  securityRegressionIt(
    '[security regression][AO-17] rejects a client secret presented by a public Admin Agent client',
    async () => {
      mocks.getClientCached.mockResolvedValue({
        client_id: 'mcp-client',
        redirect_uris: ['https://client.example.com/callback'],
        token_endpoint_auth_method: 'none',
        requestable_scopes: ['agent:read'],
      });
      const { app, env } = createApp({
        ENABLE_AGENT_MCP: 'true',
        PAR_REQUEST_STORE: {} as never,
      });

      const response = await app.fetch(
        new Request('https://tenant.example.com/oauth/admin-agent/par', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body({ client_secret: 'unexpected-secret' }),
        }),
        env
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'invalid_client' });
      expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
    }
  );

  it('converts a direct PKCE authorization request into the bounded PAR journey', async () => {
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body();
    parameters.append('resource', 'https://tenant.example.com/mcp');
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://tenant.example.com/oauth/admin-agent/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Ag1%3Aapac%3A0%3Apar_test&client_id=mcp-client'
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.storeRequestRpc).toHaveBeenCalledWith({
      requestUri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
      ttl: 60,
      data: expect.objectContaining({
        authorization_server: 'admin_agent',
        client_id: 'mcp-client',
        scope: 'agent:read',
        resource: 'https://tenant.example.com/mcp',
        code_challenge: 'a'.repeat(43),
      }),
    });
  });

  it('accepts the runtime port selected for a registered RFC 8252 loopback callback', async () => {
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['http://127.0.0.1:58483/callback/nonce'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read'],
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ redirect_uri: 'http://127.0.0.1:58848/callback/nonce' });
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.storeRequestRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          redirect_uri: 'http://127.0.0.1:58848/callback/nonce',
        }),
      })
    );
  });

  it('rejects a direct authorization request with a different duplicate resource', async () => {
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body();
    parameters.append('resource', 'https://other.example.com/mcp');
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_target' });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('resolves an HTTPS client_id metadata document before creating the PAR request', async () => {
    const clientId = 'https://client.example.com/.well-known/oauth-client.json';
    mocks.getClientCached.mockResolvedValue(null);
    mocks.safeFetchJson.mockResolvedValue({
      client_id: clientId,
      client_name: 'Metadata client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'agent:read',
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ client_id: clientId });
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.safeFetchJson).toHaveBeenCalledWith(
      clientId,
      expect.objectContaining({ requireHttps: true, maxResponseSize: 64 * 1024 })
    );
    expect(mocks.clientCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: clientId,
        token_endpoint_auth_method: 'none',
        require_pkce: true,
        requestable_scopes: ['agent:read'],
      })
    );
    expect(mocks.coreExecute).toHaveBeenCalledWith(
      expect.stringContaining("agent_access_registration_mode = 'cimd'"),
      expect.arrayContaining([clientId, 'tenant-1'])
    );
  });

  it('accepts the ephemeral localhost port used by Claude Code for a portless CIMD callback', async () => {
    const clientId = 'https://claude.ai/oauth/claude-code-client-metadata';
    mocks.getClientCached.mockResolvedValue(null);
    mocks.safeFetchJson.mockResolvedValue({
      client_id: clientId,
      client_name: 'Claude Code',
      client_uri: 'https://claude.ai',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'agent:read',
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({
      client_id: clientId,
      redirect_uri: 'http://localhost:3118/callback',
    });

    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.storeRequestRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          client_id: clientId,
          redirect_uri: 'http://localhost:3118/callback',
        }),
      })
    );
  });

  it.each([
    'http://localhost:3118/different-callback',
    'http://localhost:3118/callback?unexpected=true',
  ])('rejects a CIMD localhost callback when path or query changes: %s', async (redirectUri) => {
    const clientId = 'https://claude.ai/oauth/claude-code-client-metadata';
    mocks.safeFetchJson.mockResolvedValue({
      client_id: clientId,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'agent:read',
    });
    const normalizedMetadata = {
      client_id: clientId,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'agent:read',
      dpop_bound_access_tokens: false,
    };
    const metadataHash = await sha256Base64Url(canonicalizeJson(normalizedMetadata as never));
    mocks.getClientCached.mockResolvedValue({
      client_id: clientId,
      redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read'],
      agent_access_registration_mode: 'cimd',
      agent_access_expires_at: Date.now() + 60_000,
      client_metadata_hash: metadataHash,
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ client_id: clientId, redirect_uri: redirectUri });

    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'redirect_uri is not registered for this client',
    });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('does not apply the CIMD localhost exception to a pre-registered client', async () => {
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read'],
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ redirect_uri: 'http://localhost:3118/callback' });

    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('rejects CIMD metadata containing an unsafe redirect URI', async () => {
    const clientId = 'https://client.example.com/.well-known/oauth-client.json';
    mocks.getClientCached.mockResolvedValue(null);
    mocks.safeFetchJson.mockResolvedValue({
      client_id: clientId,
      client_name: 'Unsafe metadata client',
      redirect_uris: ['javascript:alert(1)'],
      token_endpoint_auth_method: 'none',
      scope: 'agent:read',
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ client_id: clientId });
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unauthorized_client' });
    expect(mocks.clientCreate).not.toHaveBeenCalled();
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it.each([
    { client_uri: 'javascript:alert(1)' },
    { logo_uri: 'http://client.example.com/logo.png' },
    { client_uri: `https://client.example.com/${'a'.repeat(2049)}` },
  ])('rejects CIMD metadata containing an unsafe presentation URI: %o', async (metadata) => {
    const clientId = 'https://client.example.com/.well-known/oauth-client.json';
    mocks.getClientCached.mockResolvedValue(null);
    mocks.safeFetchJson.mockResolvedValue({
      client_id: clientId,
      client_name: 'Unsafe presentation metadata client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      scope: 'agent:read',
      ...metadata,
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ client_id: clientId });
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unauthorized_client' });
    expect(mocks.clientCreate).not.toHaveBeenCalled();
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it.each([
    'https://client.example.com/a/../oauth-client.json',
    'https://client.example.com/a/%2e%2e/oauth-client.json',
  ])('rejects a CIMD client_id containing a dot segment: %s', async (clientId) => {
    mocks.getClientCached.mockResolvedValue(null);
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ client_id: clientId });
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(mocks.safeFetchJson).not.toHaveBeenCalled();
    expect(mocks.clientCreate).not.toHaveBeenCalled();
  });

  it('rejects CIMD metadata that omits the required agent:read scope', async () => {
    const clientId = 'https://client.example.com/.well-known/oauth-client.json';
    mocks.getClientCached.mockResolvedValue(null);
    mocks.safeFetchJson.mockResolvedValue({
      client_id: clientId,
      client_name: 'Write-only metadata client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      scope: 'agent:write',
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ client_id: clientId, scope: 'agent:write' });
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unauthorized_client' });
    expect(mocks.clientCreate).not.toHaveBeenCalled();
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('reactivates an expired CIMD registration only after unchanged metadata is revalidated', async () => {
    const clientId = 'https://client.example.com/.well-known/oauth-client.json';
    const normalizedMetadata = {
      client_id: clientId,
      client_name: 'Metadata client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'agent:read',
      dpop_bound_access_tokens: false,
    };
    const metadataHash = await sha256Base64Url(canonicalizeJson(normalizedMetadata as never));
    mocks.getClientCached.mockResolvedValue({
      ...normalizedMetadata,
      requestable_scopes: ['agent:read'],
      agent_access_registration_mode: 'cimd',
      agent_access_expires_at: Date.now() - 1,
      client_metadata_hash: metadataHash,
    });
    mocks.safeFetchJson.mockResolvedValue(normalizedMetadata);
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ client_id: clientId });
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.coreExecute).toHaveBeenCalledWith(
      expect.stringContaining("agent_access_registration_mode = 'cimd'"),
      expect.arrayContaining(['tenant-1', clientId, metadataHash])
    );
    expect(mocks.suspendForClientMetadataChange).not.toHaveBeenCalled();
    expect(mocks.storeRequestRpc).toHaveBeenCalled();
  });

  it('suspends the Grant and rejects authorization when CIMD metadata changes', async () => {
    const clientId = 'https://client.example.com/.well-known/oauth-client.json';
    mocks.getClientCached.mockResolvedValue({
      client_id: clientId,
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read'],
      agent_access_registration_mode: 'cimd',
      agent_access_expires_at: Date.now() + 60_000,
      client_metadata_hash: 'old-metadata-hash',
    });
    mocks.safeFetchJson.mockResolvedValue({
      client_id: clientId,
      client_name: 'Changed metadata client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'agent:read',
    });
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      PAR_REQUEST_STORE: {} as never,
    });
    const parameters = body({ client_id: clientId });
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/authorize?${parameters.toString()}`
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unauthorized_client' });
    expect(mocks.suspendForClientMetadataChange).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        clientId,
        oldHash: 'old-metadata-hash',
        newHash: expect.not.stringMatching(/^old-metadata-hash$/u),
      })
    );
    expect(mocks.coreExecute).toHaveBeenCalledWith(
      expect.stringContaining('agent_access_expires_at = 0'),
      expect.arrayContaining(['tenant-1', clientId])
    );
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('renders consent without consuming the PAR request', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} as never });
    const response = await app.fetch(
      new Request(
        'https://tenant.example.com/oauth/admin-agent/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Ag1%3Aapac%3A0%3Apar_test&client_id=mcp-client',
        { headers: { 'accept-language': 'ja-JP, en;q=0.8' } }
      ),
      env
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(response.headers.get('content-language')).toBe('ja');
    expect(response.headers.get('vary')).toContain('Accept-Language');
    const contentSecurityPolicy = response.headers.get('content-security-policy') ?? '';
    const styleNonce = /style-src 'nonce-([A-Za-z0-9_-]+)'/u.exec(contentSecurityPolicy)?.[1];
    expect(styleNonce).toBeTruthy();
    expect(contentSecurityPolicy).not.toContain("'unsafe-inline'");
    expect(html).toContain(`<style nonce="${styleNonce}">`);
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('Agentアクセスの確認');
    expect(html).toContain('1回あたりの対象上限');
    expect(html).toContain('50件');
    expect(html).toContain('アクセスを許可');
    expect(mocks.consumeRequestRpc).not.toHaveBeenCalled();
    expect(mocks.findActiveGrantForDelegatorClient).toHaveBeenCalledWith(
      'tenant-1',
      'admin-1',
      'mcp-client'
    );
  });

  it('renders the Agent consent page in English for an English browser preference', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} as never });
    const response = await app.fetch(
      new Request(
        'https://tenant.example.com/oauth/admin-agent/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Ag1%3Aapac%3A0%3Apar_test&client_id=mcp-client',
        { headers: { 'accept-language': 'fr-FR, en-US;q=0.9, ja;q=0.7' } }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-language')).toBe('en');
    const html = await response.text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Review Agent Access');
    expect(html).toContain('Per-operation limit');
    expect(html).toContain('50 resources');
    expect(html).toContain('Allow access');
    expect(html).not.toContain('Agentアクセスの確認');
  });

  it('fails closed when the delegator no longer holds a Grant permission', async () => {
    mocks.findActiveGrantForDelegatorClient.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:delete'],
      scopes: ['agent:read'],
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
    });
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} as never });
    const response = await app.fetch(
      new Request(
        'https://tenant.example.com/oauth/admin-agent/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Ag1%3Aapac%3A0%3Apar_test&client_id=mcp-client'
      ),
      env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'access_denied' });
    expect(mocks.consumeRequestRpc).not.toHaveBeenCalled();
  });

  it('rechecks, consumes, records both consents, and issues an admin-bound code on approval', async () => {
    const authCodeStore = { storeCodeRpc: mocks.storeCodeRpc };
    const { app, env } = createApp(
      {
        ENABLE_AGENT_MCP: 'true',
        DB_ADMIN: {} as never,
        AUTH_CODE_STORE: {
          idFromName: vi.fn(() => ({}) as never),
          get: vi.fn(() => authCodeStore),
        } as never,
      },
      ['admin:*']
    );
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
          client_id: 'mcp-client',
          decision: 'approve',
        }),
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('https://client.example.com/callback?');
    expect(response.headers.get('location')).toContain('code=aac_');
    expect(response.headers.get('location')).toContain('state=opaque-state');
    expect(new URL(response.headers.get('location')!).searchParams.get('iss')).toBe(
      'https://tenant.example.com/oauth/admin-agent'
    );
    expect(mocks.consumeRequestRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        expected_authorization_server: 'admin_agent',
        expected_resource: 'https://tenant.example.com/mcp',
      })
    );
    expect(mocks.grantConsentPair).toHaveBeenCalledWith(
      expect.objectContaining({
        delegation: expect.objectContaining({ type: 'delegation', consentVersion: 2 }),
        oauthClient: expect.objectContaining({ type: 'oauth_client', consentVersion: 2 }),
        audit: expect.objectContaining({ action: 'agent.consent.granted' }),
      })
    );
    expect(mocks.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin_user:admin-1',
        authorizationServer: 'admin_agent',
        subjectType: 'admin_user',
        resource: 'https://tenant.example.com/mcp',
        agentGrantId: 'grant-1',
        agentGrantGeneration: 3,
        agentConsentVersion: 2,
      })
    );
  });

  it('preserves advanced managed Grant scopes instead of forcing the self-service profile', async () => {
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:execute'],
    });
    const par = {
      authorization_server: 'admin_agent',
      tenant_id: 'tenant-1',
      client_id: 'mcp-client',
      redirect_uri: 'https://client.example.com/callback',
      response_type: 'code',
      scope: 'agent:execute',
      state: 'opaque-state',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: 'https://tenant.example.com/mcp',
      consumed: false,
    };
    mocks.getRequestRpc.mockResolvedValue(par);
    mocks.consumeRequestRpc.mockResolvedValue(par);
    mocks.findActiveGrantForDelegatorClient.mockResolvedValue({
      grantId: 'grant-advanced',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:execute'],
      consentVersion: 4,
      generation: 5,
      status: 'active',
      delegationMode: 'user_consent',
    });
    mocks.getGrantRecord.mockResolvedValue({ purpose: 'managed_advanced' });
    const authCodeStore = { storeCodeRpc: mocks.storeCodeRpc };
    const { app, env } = createApp({
      ENABLE_AGENT_MCP: 'true',
      DB_ADMIN: {} as never,
      AUTH_CODE_STORE: {
        idFromName: vi.fn(() => ({}) as never),
        get: vi.fn(() => authCodeStore),
      } as never,
    });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
          client_id: 'mcp-client',
          decision: 'approve',
        }),
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.grantConsentPair).toHaveBeenCalledWith(
      expect.objectContaining({
        delegation: expect.objectContaining({ scopes: ['agent:execute'], consentVersion: 4 }),
        oauthClient: expect.objectContaining({ scopes: ['agent:execute'], consentVersion: 4 }),
      })
    );
    expect(mocks.replaceSelfServiceAuthorization).not.toHaveBeenCalled();
    expect(mocks.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'agent:execute', agentGrantId: 'grant-advanced' })
    );
  });

  it('creates a system-managed Grant from only the scopes selected by the Admin', async () => {
    mocks.findActiveGrantForDelegatorClient.mockResolvedValue(null);
    mocks.getGrantRecord.mockResolvedValue(null);
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      client_name: 'Codex',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read', 'agent:user-data:read', 'agent:write'],
    });
    const par = {
      authorization_server: 'admin_agent',
      tenant_id: 'tenant-1',
      client_id: 'mcp-client',
      redirect_uri: 'https://client.example.com/callback',
      response_type: 'code',
      scope: 'agent:read agent:user-data:read agent:write',
      state: 'opaque-state',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: 'https://tenant.example.com/mcp',
      authorization_details: JSON.stringify([
        { type: 'authrim_admin_agent', max_subjects_per_call: 1 },
      ]),
      consumed: false,
    };
    mocks.getRequestRpc.mockResolvedValue(par);
    mocks.consumeRequestRpc.mockResolvedValue(par);
    const authCodeStore = { storeCodeRpc: mocks.storeCodeRpc };
    const { app, env } = createApp(
      {
        ENABLE_AGENT_MCP: 'true',
        DB_ADMIN: {} as never,
        AUTH_CODE_STORE: {
          idFromName: vi.fn(() => ({}) as never),
          get: vi.fn(() => authCodeStore),
        } as never,
      },
      ['admin:*']
    );
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
          client_id: 'mcp-client',
          decision: 'approve',
          scope_user_data_read: 'agent:user-data:read',
        }),
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.createSelfServiceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          purpose: 'interactive_self_service',
          delegationMode: 'user_consent',
          scopes: ['agent:read', 'agent:user-data:read'],
          authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 1 }],
          resolvedScopeConstraints: expect.objectContaining({ maxPerCall: 1 }),
        }),
        delegationConsent: expect.objectContaining({
          scopes: ['agent:read', 'agent:user-data:read'],
        }),
        audit: expect.objectContaining({
          metadata: expect.objectContaining({ max_subjects_per_call: 1 }),
        }),
      })
    );
    expect(mocks.storeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'agent:read agent:user-data:read',
        authorizationDetails: JSON.stringify([
          { type: 'authrim_admin_agent', max_subjects_per_call: 1 },
        ]),
      })
    );
  });

  it('replaces an active self-service snapshot when RAR narrows the per-call limit', async () => {
    const currentGrant = {
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'] as const,
      authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 50 }],
      resolvedScopeConstraints: {
        tenantIds: ['tenant-1'],
        piiMode: 'masked' as const,
        maxPerCall: 50,
      },
      consentVersion: 2,
      generation: 3,
      status: 'active' as const,
      delegationMode: 'user_consent' as const,
      expiresAt: Date.now() + 60_000,
    };
    mocks.findActiveGrantForDelegatorClient.mockResolvedValue(currentGrant);
    mocks.getGrantRecord.mockResolvedValue({
      ...currentGrant,
      purpose: 'interactive_self_service',
      managementMode: 'system_managed',
      createdAt: 1,
      updatedAt: 1,
    });
    const par = {
      authorization_server: 'admin_agent',
      tenant_id: 'tenant-1',
      client_id: 'mcp-client',
      redirect_uri: 'https://client.example.com/callback',
      response_type: 'code',
      scope: 'agent:read',
      state: 'opaque-state',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      resource: 'https://tenant.example.com/mcp',
      authorization_details: JSON.stringify([
        { type: 'authrim_admin_agent', max_subjects_per_call: 1 },
      ]),
      consumed: false,
    };
    mocks.getRequestRpc.mockResolvedValue(par);
    mocks.consumeRequestRpc.mockResolvedValue(par);
    const authCodeStore = { storeCodeRpc: mocks.storeCodeRpc };
    const { app, env } = createApp(
      {
        ENABLE_AGENT_MCP: 'true',
        DB_ADMIN: {} as never,
        AUTH_CODE_STORE: {
          idFromName: vi.fn(() => ({}) as never),
          get: vi.fn(() => authCodeStore),
        } as never,
      },
      ['admin:*']
    );

    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
          client_id: 'mcp-client',
          decision: 'approve',
        }),
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.replaceSelfServiceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 3,
        grant: expect.objectContaining({
          generation: 4,
          consentVersion: 3,
          authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 1 }],
          resolvedScopeConstraints: expect.objectContaining({ maxPerCall: 1 }),
        }),
        consentAudit: expect.objectContaining({
          metadata: expect.objectContaining({ max_subjects_per_call: 1 }),
        }),
      })
    );
    expect(mocks.grantConsentPair).not.toHaveBeenCalled();
  });

  it('replaces an otherwise unchanged self-service Grant when its Tool catalog is stale', async () => {
    mocks.findActiveGrantForDelegatorClient.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:agent_grants:read'],
      scopes: ['agent:read'],
      resolvedScopeConstraints: { tenantIds: ['tenant-1'], piiMode: 'masked', maxPerCall: 50 },
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'system_agent_task_set_grant-1',
      taskSetVersion: 1,
      scopePolicyId: 'system_agent_scope_policy_grant-1',
      scopePolicyVersion: 1,
      expiresAt: Date.now() + 60_000,
    });
    mocks.getGrantRecord.mockResolvedValue({
      purpose: 'interactive_self_service',
      managementMode: 'system_managed',
    });
    mocks.getSystemManagedTaskSetCatalogVersion.mockResolvedValue('admin-agent-access-v8');
    const authCodeStore = { storeCodeRpc: mocks.storeCodeRpc };
    const { app, env } = createApp(
      {
        ENABLE_AGENT_MCP: 'true',
        DB_ADMIN: {} as never,
        AUTH_CODE_STORE: {
          idFromName: vi.fn(() => ({}) as never),
          get: vi.fn(() => authCodeStore),
        } as never,
      },
      ['admin:*']
    );

    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
          client_id: 'mcp-client',
          decision: 'approve',
        }),
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.getSystemManagedTaskSetCatalogVersion).toHaveBeenCalledWith(
      'tenant-1',
      'system_agent_task_set_grant-1',
      1
    );
    expect(mocks.replaceSelfServiceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 3,
        grant: expect.objectContaining({
          generation: 4,
          consentVersion: 3,
          resolvedTools: expect.arrayContaining([
            expect.objectContaining({ toolId: 'admin.read.agent-grants.list' }),
            expect.objectContaining({ toolId: 'admin.read.agent-access.explain' }),
          ]),
        }),
        grantAudit: expect.objectContaining({
          metadata: expect.objectContaining({
            previous_catalog_version: 'admin-agent-access-v8',
            catalog_version: 'admin-agent-access-v9',
          }),
        }),
      })
    );
    expect(mocks.grantConsentPair).not.toHaveBeenCalled();

    mocks.replaceSelfServiceAuthorization.mockClear();
    mocks.grantConsentPair.mockClear();
    mocks.getSystemManagedTaskSetCatalogVersion.mockResolvedValue('admin-agent-access-v9');
    const currentResponse = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
          client_id: 'mcp-client',
          decision: 'approve',
        }),
      }),
      env
    );

    expect(currentResponse.status).toBe(302);
    expect(mocks.replaceSelfServiceAuthorization).not.toHaveBeenCalled();
    expect(mocks.grantConsentPair).toHaveBeenCalledTimes(1);
  });

  it('renews an expired self-service Grant even when the selected scopes are unchanged', async () => {
    mocks.findActiveGrantForDelegatorClient.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
      expiresAt: Date.now() - 1,
    });
    mocks.getGrantRecord.mockResolvedValue({ purpose: 'interactive_self_service' });
    const authCodeStore = { storeCodeRpc: mocks.storeCodeRpc };
    const { app, env } = createApp(
      {
        ENABLE_AGENT_MCP: 'true',
        DB_ADMIN: {} as never,
        AUTH_CODE_STORE: {
          idFromName: vi.fn(() => ({}) as never),
          get: vi.fn(() => authCodeStore),
        } as never,
      },
      ['admin:*']
    );
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
          client_id: 'mcp-client',
          decision: 'approve',
        }),
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(mocks.replaceSelfServiceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 3,
        grant: expect.objectContaining({
          generation: 4,
          consentVersion: 3,
          scopes: ['agent:read'],
          managementMode: 'system_managed',
          expiresAt: expect.any(Number),
        }),
      })
    );
    expect(mocks.grantConsentPair).not.toHaveBeenCalled();
  });

  it('consumes a denied request without creating consent or a code', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} as never });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          request_uri: 'urn:ietf:params:oauth:request_uri:g1:apac:0:par_test',
          client_id: 'mcp-client',
          decision: 'deny',
        }),
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=access_denied');
    expect(mocks.consumeRequestRpc).toHaveBeenCalledTimes(1);
    expect(mocks.grantConsentPair).not.toHaveBeenCalled();
    expect(mocks.storeCodeRpc).not.toHaveBeenCalled();
  });
});

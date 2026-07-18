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
  grantConsentPair: vi.fn(),
  storeCodeRpc: vi.fn(),
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AdminAgentAccessRepository: class {
      findActiveGrantForDelegatorClient = mocks.findActiveGrantForDelegatorClient;
      grantConsentPair = mocks.grantConsentPair;
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
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
  };
});

import { adminAgentAuthorizeHandler, adminAgentParHandler } from '../admin-agent-oauth';

function createApp(env: Partial<Env> & { ENABLE_AGENT_MCP?: string }) {
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
      permissions: ['admin:agent_grants:write', 'admin:users:read'],
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
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
    });
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

  it('renders consent without consuming the PAR request', async () => {
    const { app, env } = createApp({ ENABLE_AGENT_MCP: 'true', DB_ADMIN: {} as never });
    const response = await app.fetch(
      new Request(
        'https://tenant.example.com/oauth/admin-agent/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Ag1%3Aapac%3A0%3Apar_test&client_id=mcp-client'
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Agentアクセスの確認');
    expect(mocks.consumeRequestRpc).not.toHaveBeenCalled();
    expect(mocks.findActiveGrantForDelegatorClient).toHaveBeenCalledWith(
      'tenant-1',
      'admin-1',
      'mcp-client'
    );
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

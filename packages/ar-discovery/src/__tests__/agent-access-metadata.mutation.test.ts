import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ALLOWED_DPOP_ALGS, type Env } from '@authrim/ar-lib-core';
import {
  adminAgentAuthorizationServerMetadataHandler,
  agentProtectedResourceMetadataHandler,
} from '../agent-access-metadata';

const ISSUER = 'https://auth.example.com';

function app(tenantId = 'default'): Hono<{ Bindings: Env }> {
  const instance = new Hono<{ Bindings: Env }>();
  instance.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', tenantId);
    await next();
  });
  instance.get('/resource', agentProtectedResourceMetadataHandler);
  instance.get('/server', adminAgentAuthorizationServerMetadataHandler);
  return instance;
}

function kv(read: (key: string) => Promise<string | null>) {
  return { get: vi.fn(read) } as unknown as KVNamespace & { get: ReturnType<typeof vi.fn> };
}

function env(extra: Record<string, unknown> = {}): Env {
  return { ISSUER_URL: ISSUER, ...extra } as unknown as Env;
}

async function get(path: string, environment: Env, tenantId?: string): Promise<Response> {
  return app(tenantId).fetch(new Request(`${ISSUER}${path}`), environment);
}

const UNAVAILABLE = {
  error: 'temporarily_unavailable',
  error_description: 'Agent access configuration unavailable',
};
const NOT_FOUND = { error: 'not_found', message: 'The requested resource was not found' };

describe('agent access metadata: feature flag', () => {
  it('uses the deployment flag alone when no settings store is bound', async () => {
    expect((await get('/resource', env({ ENABLE_AGENT_MCP: 'true' }))).status).toBe(200);
    expect((await get('/resource', env({ ENABLE_AGENT_MCP: 'false' }))).status).toBe(404);
    expect((await get('/resource', env())).status).toBe(404);

    const invalid = await get('/resource', env({ ENABLE_AGENT_MCP: 'yes' }));
    expect(invalid.status).toBe(503);
    await expect(invalid.json()).resolves.toEqual(UNAVAILABLE);
  });

  it('answers 404 with the standard not-found body while the feature is off', async () => {
    const response = await get('/server', env());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(NOT_FOUND);
  });

  it('reads the tenant document from SETTINGS, preferring it to AUTHRIM_CONFIG', async () => {
    const settings = kv(async () => JSON.stringify({ 'agent.mcp.enabled': true }));
    const config = kv(async () => JSON.stringify({ 'agent.mcp.enabled': false }));
    const response = await get(
      '/resource',
      env({ SETTINGS: settings, AUTHRIM_CONFIG: config }),
      'acme'
    );
    expect(response.status).toBe(200);
    expect(settings.get).toHaveBeenCalledWith('settings:tenant:acme:agent-access');
    expect(config.get).not.toHaveBeenCalled();
  });

  it('falls back to AUTHRIM_CONFIG when SETTINGS is not bound', async () => {
    const config = kv(async () => JSON.stringify({ 'agent.mcp.enabled': true }));
    expect((await get('/resource', env({ AUTHRIM_CONFIG: config }), 'acme')).status).toBe(200);
    expect(config.get).toHaveBeenCalledWith('settings:tenant:acme:agent-access');
  });

  it.each([
    ['an object that enables it', JSON.stringify({ 'agent.mcp.enabled': true }), 200],
    ['an object that disables it', JSON.stringify({ 'agent.mcp.enabled': false }), 404],
    ['a bare true', 'true', 200],
    ['a bare false', 'false', 404],
    ['an object with a non-boolean flag', JSON.stringify({ 'agent.mcp.enabled': 'true' }), 503],
    ['an array', '[]', 503],
    ['an array holding the flag', JSON.stringify([{ 'agent.mcp.enabled': true }]), 503],
    ['null', 'null', 503],
    ['a number', '1', 503],
  ])('reads %s from the tenant document', async (_label, document, status) => {
    const response = await get('/resource', env({ SETTINGS: kv(async () => document) }));
    expect(response.status).toBe(status);
  });

  it('lets an object without the flag fall through to the deployment flag', async () => {
    const settings = kv(async () => JSON.stringify({ other: true }));
    expect((await get('/resource', env({ SETTINGS: settings }))).status).toBe(404);
    expect(
      (await get('/resource', env({ SETTINGS: settings, ENABLE_AGENT_MCP: 'true' }))).status
    ).toBe(200);
  });

  it('uses the deployment flag when the tenant has no document', async () => {
    const settings = kv(async () => null);
    expect(
      (await get('/resource', env({ SETTINGS: settings, ENABLE_AGENT_MCP: 'true' }))).status
    ).toBe(200);
    expect((await get('/resource', env({ SETTINGS: settings }))).status).toBe(404);
  });

  it('fails closed when the settings cannot be read, even with the deployment flag on', async () => {
    const settings = kv(async () => {
      throw new Error('kv down');
    });
    const response = await get('/resource', env({ SETTINGS: settings, ENABLE_AGENT_MCP: 'true' }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(UNAVAILABLE);
  });

  it('fails closed when the tenant document is not JSON', async () => {
    const response = await get('/resource', env({ SETTINGS: kv(async () => 'not json') }));
    expect(response.status).toBe(503);
  });
});

describe('agent access metadata: documents', () => {
  const enabled = {
    SETTINGS: kv(async () => JSON.stringify({ 'agent.mcp.enabled': true })),
  };

  it('publishes the protected resource metadata with its cache headers', async () => {
    const response = await get('/resource', env(enabled));
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding, Host');
    await expect(response.json()).resolves.toEqual({
      resource: `${ISSUER}/mcp`,
      resource_name: 'Authrim',
      authorization_servers: [`${ISSUER}/oauth/admin-agent`],
      scopes_supported: ['agent:read', 'agent:user-data:read', 'agent:write'],
      bearer_methods_supported: ['header'],
      dpop_signing_alg_values_supported: ALLOWED_DPOP_ALGS,
      resource_documentation: 'https://authrim.com/docs/agent-access/mcp',
    });
  });

  it('publishes the Admin Agent authorization server metadata with its cache headers', async () => {
    const base = `${ISSUER}/oauth/admin-agent`;
    const response = await get('/server', env(enabled));
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding, Host');
    await expect(response.json()).resolves.toEqual({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      pushed_authorization_request_endpoint: `${base}/par`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      response_modes_supported: ['query', 'jwt'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ],
      subject_token_types_supported: ['urn:authrim:token-type:agent-delegation'],
      actor_token_types_supported: ['urn:ietf:params:oauth:token-type:access_token'],
      agent_delegation_endpoint: `${base}/delegation`,
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['PS256', 'ES256', 'RS256'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['agent:read', 'agent:user-data:read', 'agent:write'],
      authorization_details_types_supported: ['authrim_admin_agent'],
      require_pushed_authorization_requests: false,
      authorization_response_iss_parameter_supported: true,
      dpop_signing_alg_values_supported: ALLOWED_DPOP_ALGS,
      client_id_metadata_document_supported: true,
      registration_endpoint: `${base}/register`,
    });
  });

  it('names the environment in the resource name, and treats production as unnamed', async () => {
    const named = await get('/resource', env({ ...enabled, AUTHRIM_ENVIRONMENT_NAME: 'staging' }));
    expect((await named.json<{ resource_name: string }>()).resource_name).toBe('Authrim (staging)');
    const prod = await get('/resource', env({ ...enabled, AUTHRIM_ENVIRONMENT_NAME: 'prod' }));
    expect((await prod.json<{ resource_name: string }>()).resource_name).toBe('Authrim');
  });

  it('builds every URL from the issuer without a trailing slash', async () => {
    const response = await get('/resource', env({ ...enabled, ISSUER_URL: `${ISSUER}/` }));
    const body = await response.json<{ resource: string; authorization_servers: string[] }>();
    expect(body.resource).toBe(`${ISSUER}/mcp`);
    expect(body.authorization_servers).toEqual([`${ISSUER}/oauth/admin-agent`]);
  });
});

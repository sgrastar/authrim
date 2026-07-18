import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import type { Env, OIDCProviderMetadata } from '@authrim/ar-lib-core';

function createMockEnv(): Env {
  return {
    ISSUER_URL: 'https://auth.example.com',
    DB: {
      prepare: () => {
        throw new Error('DB should not be queried by discovery app route tests');
      },
      batch: async () => [],
    } as unknown as D1Database,
  } as unknown as Env;
}

function createAgentMetadataEnv(flagValue: unknown = true): Env {
  return {
    ...createMockEnv(),
    AUTHRIM_CONFIG: {
      get: vi.fn(async () => JSON.stringify({ 'agent.mcp.enabled': flagValue })),
    } as unknown as KVNamespace,
  } as Env;
}

function createHealthEnv(options: { keyManagerError?: Error } = {}): Env {
  const getAllPublicKeys = options.keyManagerError
    ? vi.fn(async () => {
        throw options.keyManagerError;
      })
    : vi.fn(async () => []);
  return {
    KV: {
      get: vi.fn(async () => null),
    } as unknown as KVNamespace,
    KEY_MANAGER_PUBLIC: { getAllPublicKeys },
  } as unknown as Env;
}

describe('discovery app routes', () => {
  it('serves OAuth authorization server metadata through the full app stack', async () => {
    const response = await app.fetch(
      new Request('https://auth.example.com/.well-known/oauth-authorization-server'),
      createMockEnv()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const metadata = (await response.json()) as OIDCProviderMetadata;
    expect(metadata.issuer).toBe('https://auth.example.com');
    expect(metadata.authorization_endpoint).toBe('https://auth.example.com/authorize');
    expect(metadata.jwks_uri).toBe('https://auth.example.com/.well-known/jwks.json');
  });

  it('serves RFC 9728 path metadata for the MCP protected resource', async () => {
    const response = await app.fetch(
      new Request('https://auth.example.com/.well-known/oauth-protected-resource/mcp'),
      createAgentMetadataEnv()
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: 'https://auth.example.com/mcp',
      authorization_servers: ['https://auth.example.com/oauth/admin-agent'],
      scopes_supported: ['agent:read', 'agent:write', 'agent:execute', 'agent:admin'],
      bearer_methods_supported: ['header'],
    });
  });

  it('serves dedicated Admin Agent authorization server metadata', async () => {
    const response = await app.fetch(
      new Request(
        'https://auth.example.com/.well-known/oauth-authorization-server/oauth/admin-agent'
      ),
      createAgentMetadataEnv()
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issuer: 'https://auth.example.com/oauth/admin-agent',
      authorization_endpoint: 'https://auth.example.com/oauth/admin-agent/authorize',
      token_endpoint: 'https://auth.example.com/oauth/admin-agent/token',
      agent_delegation_endpoint: 'https://auth.example.com/oauth/admin-agent/delegation',
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ],
      pushed_authorization_request_endpoint: 'https://auth.example.com/oauth/admin-agent/par',
      require_pushed_authorization_requests: true,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('does not advertise Agent endpoints while the tenant flag is disabled', async () => {
    const response = await app.fetch(
      new Request('https://auth.example.com/.well-known/oauth-protected-resource/mcp'),
      createAgentMetadataEnv(false)
    );
    expect(response.status).toBe(404);
  });

  it('fails closed when the Agent feature flag has an invalid type', async () => {
    const response = await app.fetch(
      new Request('https://auth.example.com/.well-known/oauth-protected-resource/mcp'),
      createAgentMetadataEnv('true')
    );
    expect(response.status).toBe(503);
  });

  it('returns JSON 404 responses through the full app stack', async () => {
    const response = await app.fetch(
      new Request('https://auth.example.com/.well-known/unknown'),
      createMockEnv()
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      error: 'not_found',
      message: 'The requested resource was not found',
    });
  });

  it('returns liveness without checking downstream dependencies', async () => {
    const response = await app.fetch(
      new Request('https://auth.example.com/health/live'),
      {} as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });

  it('returns readiness when KV and KeyManager checks pass', async () => {
    const env = createHealthEnv();
    const response = await app.fetch(new Request('https://auth.example.com/health/ready'), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      checks: {
        kv: { status: 'ok' },
        keyManager: { status: 'ok' },
      },
    });
    expect((env.KV as KVNamespace).get).toHaveBeenCalledWith('__health_check__');
    expect(env.KEY_MANAGER_PUBLIC?.getAllPublicKeys).toHaveBeenCalledWith('default');
  });

  it('returns not_ready when a readiness dependency fails', async () => {
    const env = createHealthEnv({ keyManagerError: new Error('key manager unavailable') });
    const response = await app.fetch(new Request('https://auth.example.com/health/ready'), env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'not_ready',
      checks: {
        kv: { status: 'ok' },
        keyManager: {
          status: 'error',
          error: 'key manager unavailable',
        },
      },
    });
  });
});

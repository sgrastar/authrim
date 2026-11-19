import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGrantContract } from '../core';
import { createCloudflareAgentAccessTokenAuthenticator } from '../platform/cloudflare/token-authentication';
import {
  failureOf,
  mcpRequest,
  tokenClaims,
  tokenEnvironment,
  tokenGrant,
  tokenRepository,
} from './helpers/mut-worker-token-fixtures';

const state = vi.hoisted(() => ({
  getClient: vi.fn(async (): Promise<{ client_id: string } | null> => ({ client_id: 'client-1' })),
  adapter: { kind: 'client-adapter' },
  resolveAdapter: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  getClient: state.getClient,
  resolveAuthCorePersistenceAdapterFromEnv: state.resolveAdapter.mockImplementation(
    async () => state.adapter
  ),
}));

beforeEach(() => {
  // The hoisted ar-lib-core mocks are shared by every case; keep their implementations but
  // drop call history so each assertion only sees the calls made by its own case.
  state.getClient.mockClear();
  state.resolveAdapter.mockClear();
});

function authenticator(
  tokenClaimsValue: unknown,
  options: {
    repo?: ReturnType<typeof tokenRepository>;
    dpop?: { valid: boolean; jkt?: string };
  } = {}
) {
  const repo = options.repo ?? tokenRepository();
  const verifyJwt = vi.fn().mockResolvedValue(tokenClaimsValue);
  const validateDpop = vi.fn().mockResolvedValue(options.dpop ?? { valid: true });
  const authenticate = createCloudflareAgentAccessTokenAuthenticator({
    now: () => 100,
    verifyJwt,
    validateDpop,
    createRepository: () => repo,
  });
  return { authenticate, repo, verifyJwt, validateDpop };
}

describe('token authentication error responses', () => {
  it('returns the RFC 6750 Bearer challenge with protected-resource metadata', async () => {
    const { authenticate } = authenticator(tokenClaims({ tenant_id: 'tenant-2' }));
    const failure = await failureOf(await authenticate(mcpRequest(), tokenEnvironment()));
    expect(failure).toMatchObject({
      status: 401,
      code: 'AGENT_MCP_TOKEN_INVALID',
      tenantId: 'tenant-1',
      body: { error: 'invalid_token', error_description: 'Access token is invalid' },
    });
    expect(failure.headers.get('cache-control')).toBe('no-store');
    expect(failure.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", resource_metadata="https://auth.example/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it('uses the DPoP challenge scheme for a DPoP authorization header', async () => {
    const { authenticate } = authenticator(null);
    const failure = await failureOf(
      await authenticate(mcpRequest({ authorization: 'DPoP access-token' }), tokenEnvironment())
    );
    expect(failure.headers.get('www-authenticate')).toMatch(/^DPoP error="invalid_token", /u);
  });

  it('verifies the token against the request-origin Admin Agent issuer and MCP audience', async () => {
    const { authenticate, verifyJwt } = authenticator(tokenClaims());
    await authenticate(mcpRequest(), tokenEnvironment());
    expect(verifyJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'access-token',
        tenantId: 'tenant-1',
        issuer: 'https://auth.example/oauth/admin-agent',
        audience: 'https://auth.example/mcp',
      })
    );
  });

  it('treats a verifier exception as an invalid token', async () => {
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt: vi.fn().mockRejectedValue(new Error('bad signature')),
      validateDpop: vi.fn(),
      createRepository: () => tokenRepository(),
    });
    const failure = await failureOf(await authenticate(mcpRequest(), tokenEnvironment()));
    expect(failure.code).toBe('AGENT_MCP_TOKEN_INVALID');
  });

  it('rejects an authorization header with leading text before the scheme', async () => {
    const { authenticate, verifyJwt } = authenticator(tokenClaims());
    const failure = await failureOf(
      await authenticate(mcpRequest({ authorization: 'xBearer access-token' }), tokenEnvironment())
    );
    expect(failure.code).toBe('AGENT_MCP_AUTHORIZATION_HEADER_INVALID');
    expect(verifyJwt).not.toHaveBeenCalled();
  });
});

describe('token authentication client and actor checks', () => {
  it('looks up the issuing client in the tenant persistence adapter', async () => {
    const { authenticate } = authenticator(tokenClaims());
    const env = tokenEnvironment();
    await authenticate(mcpRequest(), env);
    expect(state.resolveAdapter).toHaveBeenCalledTimes(1);
    expect(state.resolveAdapter).toHaveBeenCalledWith(env, 'agent-token-client', {
      tenantId: 'tenant-1',
    });
    expect(state.getClient).toHaveBeenCalledTimes(1);
    expect(state.getClient).toHaveBeenCalledWith(env, 'tenant-1', 'client-1', state.adapter);
  });

  it('reports a disabled client as an invalid token for the tenant', async () => {
    state.getClient.mockResolvedValueOnce(null);
    const { authenticate } = authenticator(tokenClaims());
    const failure = await failureOf(await authenticate(mcpRequest(), tokenEnvironment()));
    expect(failure).toMatchObject({ code: 'AGENT_MCP_TOKEN_INVALID', tenantId: 'tenant-1' });
  });

  it.each([
    ['a non-Admin subject', { sub: 'user:admin-1' }],
    ['an empty Admin subject', { sub: 'admin_user:' }],
    ['a Mode A actor for another client', { act: { sub: 'client:client-2' } }],
  ])('rejects %s as invalid actor claims', async (_name, change) => {
    const { authenticate, repo } = authenticator(tokenClaims(change));
    const failure = await failureOf(await authenticate(mcpRequest(), tokenEnvironment()));
    expect(failure).toMatchObject({
      status: 401,
      code: 'AGENT_MCP_ACTOR_CLAIMS_INVALID',
      tenantId: 'tenant-1',
    });
    expect(repo.getGrant).not.toHaveBeenCalled();
  });
});

describe('token authentication binding checks', () => {
  it.each([
    [
      'a DPoP-bound token presented as Bearer with a proof',
      tokenClaims({ token_binding: 'dpop', cnf: { jkt: 'jkt-1' } }),
      { authorization: 'Bearer access-token', dpop: 'proof' },
    ],
    [
      'a DPoP-bound token without a confirmation thumbprint',
      tokenClaims({ token_binding: 'dpop' }),
      { authorization: 'DPoP access-token', dpop: 'proof' },
    ],
    [
      'a bearer token presented with the DPoP scheme',
      tokenClaims(),
      { authorization: 'DPoP access-token', dpop: 'proof' },
    ],
    [
      'a bearer token carrying a confirmation key',
      tokenClaims({ cnf: { jkt: 'jkt-1' } }),
      { authorization: 'Bearer access-token' },
    ],
  ])('rejects %s', async (_name, claimsValue, headers) => {
    const { authenticate, validateDpop } = authenticator(claimsValue, {
      dpop: { valid: true },
    });
    const failure = await failureOf(await authenticate(mcpRequest(headers), tokenEnvironment()));
    expect(failure).toMatchObject({
      code: 'AGENT_MCP_TOKEN_BINDING_INVALID',
      tenantId: 'tenant-1',
    });
    expect(validateDpop).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid proof with the expected thumbprint', { valid: false, jkt: 'jkt-1' }],
    ['a valid proof for a different key', { valid: true, jkt: 'jkt-2' }],
  ])('rejects %s', async (_name, dpop) => {
    const { authenticate, repo } = authenticator(
      tokenClaims({ token_binding: 'dpop', cnf: { jkt: 'jkt-1' } }),
      { dpop }
    );
    const failure = await failureOf(
      await authenticate(
        mcpRequest({ authorization: 'DPoP access-token', dpop: 'proof' }),
        tokenEnvironment()
      )
    );
    expect(failure).toMatchObject({ code: 'AGENT_MCP_DPOP_PROOF_INVALID', tenantId: 'tenant-1' });
    expect(repo.getGrant).not.toHaveBeenCalled();
  });

  it('returns a no-store 503 body when the DPoP validator is unavailable', async () => {
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt: vi
        .fn()
        .mockResolvedValue(tokenClaims({ token_binding: 'dpop', cnf: { jkt: 'jkt-1' } })),
      validateDpop: vi.fn().mockRejectedValue(new Error('down')),
      createRepository: () => tokenRepository(),
    });
    const failure = await failureOf(
      await authenticate(
        mcpRequest({ authorization: 'DPoP access-token', dpop: 'proof' }),
        tokenEnvironment()
      )
    );
    expect(failure).toMatchObject({
      status: 503,
      code: 'AGENT_MCP_DPOP_VALIDATION_UNAVAILABLE',
      body: {
        error: 'temporarily_unavailable',
        error_description: 'Agent access authorization state is unavailable',
      },
    });
    expect(failure.headers.get('cache-control')).toBe('no-store');
  });

  it('passes the proof, token and client binding to the DPoP validator', async () => {
    const { authenticate, validateDpop } = authenticator(
      tokenClaims({ token_binding: 'dpop', cnf: { jkt: 'jkt-1' } }),
      { dpop: { valid: true, jkt: 'jkt-1' } }
    );
    const request = mcpRequest({ authorization: 'DPoP access-token', dpop: 'proof-1' });
    const result = await authenticate(request, tokenEnvironment());
    expect(result.allowed).toBe(true);
    expect(validateDpop).toHaveBeenCalledWith(
      expect.objectContaining({
        proof: 'proof-1',
        request,
        token: 'access-token',
        tenantId: 'tenant-1',
        clientId: 'client-1',
      })
    );
  });
});

describe('token authentication live Grant checks', () => {
  async function denied(
    claimsChange: Record<string, unknown>,
    grantChange: Partial<AgentGrantContract> = {},
    permissions: string[] = ['admin:users:read']
  ) {
    const repo = tokenRepository({ ...tokenGrant, ...grantChange });
    repo.getActiveDelegatorPermissions.mockResolvedValue(permissions);
    const { authenticate } = authenticator(tokenClaims(claimsChange), { repo });
    return failureOf(await authenticate(mcpRequest(), tokenEnvironment()));
  }

  it('rejects a stale Grant generation', async () => {
    await expect(denied({}, { generation: 4 })).resolves.toMatchObject({
      code: 'AGENT_MCP_GRANT_OR_CONSENT_INVALID',
    });
  });

  it('rejects when any one Grant permission exceeds the live delegator ceiling', async () => {
    await expect(
      denied({}, { permissions: ['admin:users:read', 'admin:users:write'] })
    ).resolves.toMatchObject({ code: 'AGENT_MCP_GRANT_OR_CONSENT_INVALID' });
  });

  it('rejects when any one token scope is unknown even if others are granted', async () => {
    await expect(denied({ scope: 'agent:read agent:unknown' })).resolves.toMatchObject({
      code: 'AGENT_MCP_GRANT_OR_CONSENT_INVALID',
    });
  });

  it('ignores surrounding whitespace in the scope claim', async () => {
    const { authenticate } = authenticator(tokenClaims({ scope: ' agent:read  agent:write ' }));
    const result = await authenticate(mcpRequest(), tokenEnvironment());
    if (!result.allowed) throw new Error('expected admission');
    expect(result.props.context.grant.scopes).toEqual(['agent:read', 'agent:write']);
  });
});

describe('token authentication admitted context', () => {
  async function admitted(claimsChange: Record<string, unknown>, grantChange = {}, headers = {}) {
    const repo = tokenRepository({ ...tokenGrant, ...grantChange });
    const { authenticate } = authenticator(tokenClaims(claimsChange), { repo });
    const result = await authenticate(mcpRequest(headers), tokenEnvironment());
    if (!result.allowed) throw new Error('expected admission');
    return result.props.context;
  }

  it('omits a per-call ceiling when neither the token nor the Grant sets one', async () => {
    const context = await admitted({});
    expect(Object.hasOwn(context.grant.resolvedScopeConstraints, 'maxPerCall')).toBe(false);
    expect(context.actor).not.toHaveProperty('machinePrincipalId');
  });

  it('keeps a Grant ceiling above the self-service default when the token has no RAR', async () => {
    const context = await admitted(
      {},
      { resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerCall: 500 } }
    );
    expect(context.grant.resolvedScopeConstraints.maxPerCall).toBe(500);
  });

  it('uses the token RAR ceiling when the Grant has none', async () => {
    const context = await admitted({
      authorization_details: [{ type: 'authrim_admin_agent', max_subjects_per_call: 7 }],
    });
    expect(context.grant.resolvedScopeConstraints).toEqual({
      tenantIds: ['tenant-1'],
      maxPerCall: 7,
    });
  });

  it('uses the Grant ceiling when it is lower than the token RAR ceiling', async () => {
    const context = await admitted(
      { authorization_details: [{ type: 'authrim_admin_agent', max_subjects_per_call: 9 }] },
      { resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerCall: 4 } }
    );
    expect(context.grant.resolvedScopeConstraints.maxPerCall).toBe(4);
  });

  it('propagates a caller correlation id or generates an mcp_ one', async () => {
    await expect(admitted({}, {}, { 'x-correlation-id': 'corr-1' })).resolves.toMatchObject({
      correlationId: 'corr-1',
      actor: { clientId: 'client-1' },
    });
    const generated = await admitted({});
    expect(generated.correlationId).toMatch(/^mcp_[0-9a-f-]{36}$/u);
  });
});

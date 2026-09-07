import { describe, expect, it, vi } from 'vitest';
import type { AgentGrantContract } from '../../../core';
import { createCloudflareAgentAccessTokenAuthenticator } from '../token-authentication';

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read', 'agent:write'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 2,
  generation: 3,
  status: 'active',
  delegationMode: 'user_consent',
  expiresAt: 1_000,
};

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'admin_user:admin-1',
    jti: 'jti-1',
    scope: 'agent:read',
    client_id: 'client-1',
    tenant_id: 'tenant-1',
    grant_id: 'grant-1',
    grant_generation: 3,
    consent_version: 2,
    actor_mode: 'mode_a',
    actor_assurance: 'public_client_transaction',
    token_binding: 'bearer',
    act: { sub: 'client:client-1' },
    ...overrides,
  };
}

function repository(grantResult: AgentGrantContract | null = grant) {
  return {
    getGrant: vi.fn().mockResolvedValue(grantResult),
    getActiveDelegatorPermissions: vi.fn().mockResolvedValue(['admin:users:read']),
    hasCurrentConsent: vi.fn().mockResolvedValue(true),
  };
}

function request(headers: Record<string, string> = {}) {
  return new Request('https://auth.example/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer access-token', ...headers },
  });
}

function environment(overrides: Record<string, unknown> = {}) {
  return {
    DEFAULT_TENANT_ID: 'tenant-1',
    ENABLE_AGENT_MCP: 'true',
    ...overrides,
  } as never;
}

describe('createCloudflareAgentAccessTokenAuthenticator', () => {
  it('returns only a live, verified Mode A authorization context', async () => {
    const repo = repository();
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      verifyJwt: vi.fn().mockResolvedValue(claims()),
      validateDpop: vi.fn(),
      createRepository: () => repo,
    });

    const result = await authenticate(request(), environment());

    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('expected successful admission');
    expect(result.props.context).toMatchObject({
      actor: {
        mode: 'mode_a',
        sub: 'client:client-1',
        assurance: 'public_client_transaction',
        tokenBinding: 'bearer',
      },
      grant: { grantId: 'grant-1', generation: 3, consentVersion: 2 },
      resource: { tenantId: 'tenant-1' },
      issuerOrigin: 'https://auth.example',
    });
    expect(result.props).not.toHaveProperty('sourceAccessToken');
    expect(result.props.context.grant.scopes).toEqual(['agent:read']);
    expect(repo.getActiveDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', 100);
    expect(repo.hasCurrentConsent).toHaveBeenCalledWith(
      'tenant-1',
      'grant-1',
      'admin-1',
      'client-1',
      2
    );
  });

  it('intersects a token RAR ceiling with the live Grant resource constraints', async () => {
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      verifyJwt: vi.fn().mockResolvedValue(
        claims({
          authorization_details: [{ type: 'authrim_admin_agent', max_subjects_per_call: 2 }],
        })
      ),
      validateDpop: vi.fn(),
      createRepository: () =>
        repository({
          ...grant,
          resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerCall: 10 },
        }),
    });

    const result = await authenticate(request(), environment());

    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('expected successful admission');
    expect(result.props.context.grant.resolvedScopeConstraints.maxPerCall).toBe(2);
  });

  it('rejects a signed token with authorization_details outside the Admin Agent profile', async () => {
    const repo = repository();
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt: vi.fn().mockResolvedValue(
        claims({
          authorization_details: [{ type: 'authrim_admin_agent', max_subjects_per_call: 500 }],
        })
      ),
      validateDpop: vi.fn(),
      createRepository: () => repo,
    });

    const result = await authenticate(request(), environment());

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.response.status).toBe(401);
    expect(repo.getGrant).not.toHaveBeenCalled();
  });

  it('admits only a DPoP-bound Mode B principal matching the linked Grant', async () => {
    const modeBGrant = { ...grant, machinePrincipalId: 'amp-1' };
    const repo = repository(modeBGrant);
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      verifyJwt: vi.fn().mockResolvedValue(
        claims({
          actor_mode: 'mode_b',
          actor_assurance: 'machine_key',
          token_binding: 'dpop',
          act: { sub: 'machine:amp-1' },
          act_principal_id: 'amp-1',
          act_credential_id: 'amk-1',
          cnf: { jkt: 'mode-b-jkt' },
        })
      ),
      validateDpop: vi.fn().mockResolvedValue({ valid: true, jkt: 'mode-b-jkt' }),
      createRepository: () => repo,
    });
    const result = await authenticate(
      request({ authorization: 'DPoP access-token', dpop: 'proof' }),
      environment()
    );

    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error('expected successful Mode B admission');
    expect(result.props.context.actor).toMatchObject({
      mode: 'mode_b',
      sub: 'machine:amp-1',
      assurance: 'machine_key',
      tokenBinding: 'dpop',
      machinePrincipalId: 'amp-1',
      machineCredentialId: 'amk-1',
    });
  });

  it('rejects a cryptographically valid token from a different tenant before DB access', async () => {
    const repo = repository();
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt: vi.fn().mockResolvedValue(claims({ tenant_id: 'tenant-2' })),
      validateDpop: vi.fn(),
      createRepository: () => repo,
    });

    const result = await authenticate(request(), environment());

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(repo.getGrant).not.toHaveBeenCalled();
  });

  it('requires a matching DPoP proof and confirmation thumbprint', async () => {
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt: vi
        .fn()
        .mockResolvedValue(claims({ token_binding: 'dpop', cnf: { jkt: 'expected-jkt' } })),
      validateDpop: vi.fn().mockResolvedValue({ valid: true, jkt: 'different-jkt' }),
      createRepository: () => repository(),
    });

    const result = await authenticate(
      request({ authorization: 'DPoP access-token', dpop: 'proof-jwt' }),
      environment()
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('www-authenticate')).toMatch(/^DPoP /u);
  });

  it('rejects a stale Grant generation even when the JWT is still valid', async () => {
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt: vi.fn().mockResolvedValue(claims()),
      validateDpop: vi.fn(),
      createRepository: () => repository({ ...grant, generation: 4 }),
    });

    const result = await authenticate(request(), environment());
    expect(result.allowed).toBe(false);
  });

  it('fails closed when feature configuration cannot be read', async () => {
    const verifyJwt = vi.fn().mockResolvedValue(claims());
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt,
      validateDpop: vi.fn(),
      createRepository: () => repository(),
    });
    const config = { get: vi.fn().mockRejectedValue(new Error('KV unavailable')) };

    const result = await authenticate(request(), environment({ AUTHRIM_CONFIG: config }));

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.response.status).toBe(404);
    expect(verifyJwt).not.toHaveBeenCalled();
  });
});

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

  it.each([
    ['revoked Grant', { status: 'revoked' }],
    ['another client', { clientId: 'client-2' }],
    ['another delegator', { delegatorId: 'admin-2' }],
    ['stale consent version', { consentVersion: 3 }],
    ['missing expiry', { expiresAt: undefined }],
    ['expired Grant', { expiresAt: 100 }],
  ])('rejects a signed token against a %s', async (_description, changes) => {
    const repo = repository({ ...grant, ...changes } as AgentGrantContract);
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      verifyJwt: vi.fn().mockResolvedValue(claims()),
      validateDpop: vi.fn(),
      createRepository: () => repo,
    });

    const result = await authenticate(request(), environment());

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.auditContext.code).toBe('AGENT_MCP_GRANT_OR_CONSENT_INVALID');
    expect(result).not.toHaveProperty('props');
    expect(repo.getGrant).toHaveBeenCalledExactlyOnceWith('tenant-1', 'grant-1');
  });

  it.each([
    ['no current permissions', null, true],
    ['reduced live permission ceiling', [], true],
    ['withdrawn consent', ['admin:users:read'], false],
  ])(
    'rejects %s even while the token and Grant are valid',
    async (_description, permissions, consent) => {
      const repo = repository();
      repo.getActiveDelegatorPermissions.mockResolvedValue(permissions);
      repo.hasCurrentConsent.mockResolvedValue(consent);
      const authenticate = createCloudflareAgentAccessTokenAuthenticator({
        now: () => 100,
        verifyJwt: vi.fn().mockResolvedValue(claims()),
        validateDpop: vi.fn(),
        createRepository: () => repo,
      });

      const result = await authenticate(request(), environment());

      expect(result.allowed).toBe(false);
      if (result.allowed) throw new Error('expected rejection');
      expect(result.response.status).toBe(401);
      expect(result.auditContext.code).toBe('AGENT_MCP_GRANT_OR_CONSENT_INVALID');
      expect(repo.hasCurrentConsent).toHaveBeenCalledWith(
        'tenant-1',
        'grant-1',
        'admin-1',
        'client-1',
        2
      );
    }
  );

  it.each([
    ['blank scope', '  ', grant.scopes],
    ['scope outside the Grant', 'agent:write', ['agent:read']],
    ['unknown scope', 'agent:unknown', grant.scopes],
  ])('rejects a token with %s', async (_description, scope, grantScopes) => {
    const repo = repository({ ...grant, scopes: grantScopes as AgentGrantContract['scopes'] });
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      verifyJwt: vi.fn().mockResolvedValue(claims({ scope })),
      validateDpop: vi.fn(),
      createRepository: () => repo,
    });

    const result = await authenticate(request(), environment());

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.response.status).toBe(401);
    expect(result.auditContext.code).toBe('AGENT_MCP_GRANT_OR_CONSENT_INVALID');
  });

  it('returns 503 without disclosing a repository failure', async () => {
    const repo = repository();
    repo.getGrant.mockRejectedValue(new Error('private database hostname'));
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      now: () => 100,
      verifyJwt: vi.fn().mockResolvedValue(claims()),
      validateDpop: vi.fn(),
      createRepository: () => repo,
    });

    const result = await authenticate(request(), environment());

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.response.status).toBe(503);
    expect(result.auditContext.code).toBe('AGENT_MCP_AUTHORIZATION_STATE_UNAVAILABLE');
    expect(await result.response.text()).not.toContain('private database hostname');
  });

  it.each([
    ['missing proof', {}, 'AGENT_MCP_DPOP_PROOF_REQUIRED', 401],
    ['invalid proof', { dpop: 'proof' }, 'AGENT_MCP_DPOP_PROOF_INVALID', 401],
    ['unavailable validator', { dpop: 'proof' }, 'AGENT_MCP_DPOP_VALIDATION_UNAVAILABLE', 503],
  ])(
    'does not contact the Grant repository for a DPoP token with %s',
    async (_description, headers, code, status) => {
      const repo = repository();
      const validateDpop = vi.fn();
      if (code === 'AGENT_MCP_DPOP_VALIDATION_UNAVAILABLE') {
        validateDpop.mockRejectedValue(new Error('private verification endpoint'));
      } else {
        validateDpop.mockResolvedValue({ valid: false });
      }
      const authenticate = createCloudflareAgentAccessTokenAuthenticator({
        verifyJwt: vi
          .fn()
          .mockResolvedValue(claims({ token_binding: 'dpop', cnf: { jkt: 'expected-jkt' } })),
        validateDpop,
        createRepository: () => repo,
      });

      const result = await authenticate(
        request({ authorization: 'DPoP access-token', ...headers }),
        environment()
      );

      expect(result.allowed).toBe(false);
      if (result.allowed) throw new Error('expected rejection');
      expect(result.response.status).toBe(status);
      expect(result.auditContext.code).toBe(code);
      expect(await result.response.text()).not.toContain('private verification endpoint');
      expect(repo.getGrant).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'Bearer with a DPoP claim',
      claims({ token_binding: 'dpop', cnf: { jkt: 'jkt' } }),
      'Bearer access-token',
    ],
    ['DPoP with a bearer claim', claims(), 'DPoP access-token'],
    ['bearer claim with confirmation key', claims({ cnf: { jkt: 'jkt' } }), 'Bearer access-token'],
    ['wrong actor subject', claims({ act: { sub: 'client:other' } }), 'Bearer access-token'],
    ['wrong Admin subject', claims({ sub: 'user:admin-1' }), 'Bearer access-token'],
  ])(
    'rejects %s before reading authorization state',
    async (_description, tokenClaims, authorization) => {
      const repo = repository();
      const authenticate = createCloudflareAgentAccessTokenAuthenticator({
        verifyJwt: vi.fn().mockResolvedValue(tokenClaims),
        validateDpop: vi.fn(),
        createRepository: () => repo,
      });

      const result = await authenticate(request({ authorization }), environment());

      expect(result.allowed).toBe(false);
      if (result.allowed) throw new Error('expected rejection');
      expect(result.response.status).toBe(401);
      expect(repo.getGrant).not.toHaveBeenCalled();
    }
  );

  it('does not verify a token with a malformed authorization header', async () => {
    const verifyJwt = vi.fn();
    const authenticate = createCloudflareAgentAccessTokenAuthenticator({
      verifyJwt,
      validateDpop: vi.fn(),
      createRepository: () => repository(),
    });

    const result = await authenticate(
      request({ authorization: 'Bearer access token' }),
      environment()
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected rejection');
    expect(result.response.status).toBe(401);
    expect(result.auditContext.code).toBe('AGENT_MCP_AUTHORIZATION_HEADER_INVALID');
    expect(verifyJwt).not.toHaveBeenCalled();
  });
});

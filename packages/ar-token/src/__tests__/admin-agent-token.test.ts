import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  consumeCodeRpc: vi.fn(),
  getClientCached: vi.fn(),
  createAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  createRefreshTokenFamily: vi.fn(),
  getRefreshTokenRotatorStubByJti: vi.fn(),
  getPublicKeyByKid: vi.fn(),
  verifyToken: vi.fn(),
  parseTokenHeader: vi.fn(),
  getGrant: vi.fn(),
  getActiveDelegatorPermissions: vi.fn(),
  hasCurrentConsent: vi.fn(),
  writeAudit: vi.fn(),
  createPendingTokenFamily: vi.fn(),
  finalizeTokenFamily: vi.fn(),
  consumeModeBDelegationJti: vi.fn(),
  isTokenFamilyUsable: vi.fn(),
  registerIssuedTokensRpc: vi.fn(),
  getFamilyRpc: vi.fn(),
  rotateRpc: vi.fn(),
  revokeFamilyRpc: vi.fn(),
  importPKCS8: vi.fn(),
  validateDPoPProof: vi.fn(),
  isTokenRevoked: vi.fn(),
  findPrincipalById: vi.fn(),
  findCredentialById: vi.fn(),
  getPrincipalPermissions: vi.fn(),
  getCredentialPermissions: vi.fn(),
  getPrincipalTenantScopes: vi.fn(),
  getCredentialTenantScopes: vi.fn(),
  signJwtPayload: vi.fn(),
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AdminAgentAccessRepository: class {
      getGrant = mocks.getGrant;
      getActiveDelegatorPermissions = mocks.getActiveDelegatorPermissions;
      hasCurrentConsent = mocks.hasCurrentConsent;
      writeAudit = mocks.writeAudit;
      createPendingTokenFamily = mocks.createPendingTokenFamily;
      finalizeTokenFamily = mocks.finalizeTokenFamily;
      isTokenFamilyUsable = mocks.isTokenFamilyUsable;
      consumeModeBDelegationJti = mocks.consumeModeBDelegationJti;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    buildRequestIssuerUrl: vi.fn(() => 'https://tenant.example.com'),
    createAccessToken: mocks.createAccessToken,
    createRefreshToken: mocks.createRefreshToken,
    createRefreshTokenFamily: mocks.createRefreshTokenFamily,
    getClientCached: mocks.getClientCached,
    getPublicKeyByKid: mocks.getPublicKeyByKid,
    getRefreshTokenRotatorStubByJti: mocks.getRefreshTokenRotatorStubByJti,
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
    parseTokenHeader: mocks.parseTokenHeader,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    verifyToken: mocks.verifyToken,
    validateDPoPProof: mocks.validateDPoPProof,
    isTokenRevoked: mocks.isTokenRevoked,
    AdminMachineAccessRepository: class {
      findPrincipalById = mocks.findPrincipalById;
      findCredentialById = mocks.findCredentialById;
      getPrincipalPermissions = mocks.getPrincipalPermissions;
      getCredentialPermissions = mocks.getCredentialPermissions;
      getPrincipalTenantScopes = mocks.getPrincipalTenantScopes;
      getCredentialTenantScopes = mocks.getCredentialTenantScopes;
    },
  };
});

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    importPKCS8: mocks.importPKCS8,
    SignJWT: class {
      constructor(payload: Record<string, unknown>) {
        mocks.signJwtPayload(payload);
      }
      setProtectedHeader() {
        return this;
      }
      setIssuer() {
        return this;
      }
      setSubject() {
        return this;
      }
      setAudience() {
        return this;
      }
      setJti() {
        return this;
      }
      setIssuedAt() {
        return this;
      }
      setNotBefore() {
        return this;
      }
      setExpirationTime() {
        return this;
      }
      sign() {
        return Promise.resolve('signed-delegation-token');
      }
    },
  };
});

import { adminAgentDelegationHandler, adminAgentTokenHandler } from '../admin-agent-token';

function createApp(env: Partial<Env> & { ENABLE_AGENT_MCP?: string }) {
  const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    await next();
  });
  app.post('/oauth/admin-agent/token', adminAgentTokenHandler);
  app.post('/oauth/admin-agent/delegation', adminAgentDelegationHandler);
  return { app, env: env as Env };
}

function requestBody(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'aac_valid-code',
    redirect_uri: 'https://client.example.com/callback',
    client_id: 'mcp-client',
    code_verifier: 'v'.repeat(43),
    resource: 'https://tenant.example.com/mcp',
    ...overrides,
  });
}

const invalidAuthorizationCodeRequests: Array<{
  name: string;
  overrides: Record<string, string>;
  status: number;
  error: string;
}> = [
  {
    name: 'an unsupported parameter',
    overrides: { unexpected: 'value' },
    status: 400,
    error: 'invalid_request',
  },
  {
    name: 'an unsupported grant type',
    overrides: { grant_type: 'client_credentials' },
    status: 400,
    error: 'unsupported_grant_type',
  },
  {
    name: 'an invalid client identifier',
    overrides: { client_id: 'bad client' },
    status: 401,
    error: 'invalid_client',
  },
  {
    name: 'a foreign MCP resource',
    overrides: { resource: 'https://other.example/mcp' },
    status: 400,
    error: 'invalid_target',
  },
];

function environment(): Partial<Env> & { ENABLE_AGENT_MCP: string } {
  return {
    ENABLE_AGENT_MCP: 'true',
    DB_ADMIN: {} as never,
    AUTH_CODE_STORE: {
      idFromName: vi.fn(() => ({}) as never),
      get: vi.fn(() => ({
        consumeCodeRpc: mocks.consumeCodeRpc,
        registerIssuedTokensRpc: mocks.registerIssuedTokensRpc,
      })),
    } as never,
    REFRESH_TOKEN_ROTATOR: {} as never,
    KEY_MANAGER: {
      idFromName: vi.fn(() => ({}) as never),
      get: vi.fn(() => ({
        getActiveKeyWithPrivateRpc: vi.fn(async () => ({
          kid: 'kid-1',
          privatePEM: 'private-key',
        })),
        rotateKeysWithPrivateRpc: vi.fn(),
      })),
    } as never,
  };
}

describe('Admin Agent token endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read'],
    });
    mocks.consumeCodeRpc.mockResolvedValue({
      userId: 'admin_user:admin-1',
      scope: 'agent:read',
      redirectUri: 'https://client.example.com/callback',
      authorizationServer: 'admin_agent',
      subjectType: 'admin_user',
      resource: 'https://tenant.example.com/mcp',
      agentGrantId: 'grant-1',
      agentGrantGeneration: 3,
      agentConsentVersion: 2,
    });
    mocks.getGrant.mockResolvedValue({
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
    mocks.getActiveDelegatorPermissions.mockResolvedValue(['admin:users:read']);
    mocks.hasCurrentConsent.mockResolvedValue(true);
    mocks.importPKCS8.mockResolvedValue({});
    mocks.createAccessToken.mockImplementation(async (_claims, _key, _kid, _ttl, providedJti) => ({
      token: 'signed-access-token',
      jti: providedJti,
    }));
    mocks.createRefreshToken.mockResolvedValue({
      token: 'signed-refresh-token',
      jti: 'rt_1_0_initial',
      rtv: 1,
    });
    mocks.createRefreshTokenFamily.mockResolvedValue({
      jti: 'rt_1_0_initial',
      family: {
        version: 1,
        newJti: 'rt_1_0_initial',
        expiresIn: 604800,
        allowedScope: 'agent:read',
      },
      resolution: { instanceName: 'rotator', generation: 1, shardIndex: 0, tenantId: 'tenant-1' },
    });
    mocks.registerIssuedTokensRpc.mockResolvedValue(true);
    mocks.finalizeTokenFamily.mockResolvedValue(true);
    mocks.isTokenFamilyUsable.mockResolvedValue(true);
    mocks.getPublicKeyByKid.mockResolvedValue({});
    mocks.parseTokenHeader.mockReturnValue({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    mocks.isTokenRevoked.mockResolvedValue(false);
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'mode-b-jkt' });
    mocks.findPrincipalById.mockResolvedValue({
      id: 'amp-1',
      clientId: 'mcp-client',
      status: 'active',
    });
    mocks.findCredentialById.mockResolvedValue({
      id: 'amk-1',
      principalId: 'amp-1',
      status: 'active',
    });
    mocks.getPrincipalPermissions.mockResolvedValue(['admin:users:read']);
    mocks.getCredentialPermissions.mockResolvedValue(['admin:users:read']);
    mocks.getPrincipalTenantScopes.mockResolvedValue([
      { scopeMode: 'allow', tenantId: 'tenant-1' },
    ]);
    mocks.getCredentialTenantScopes.mockResolvedValue([
      { scopeMode: 'allow', tenantId: 'tenant-1' },
    ]);
    mocks.consumeModeBDelegationJti.mockResolvedValue(true);
    mocks.getFamilyRpc.mockResolvedValue({
      tenant_id: 'tenant-1',
      version: 1,
      last_jti: 'rt_1_0_initial',
      last_used_at: Date.now(),
      expires_at: Date.now() + 604800000,
      user_id: 'agf-family-1',
      client_id: 'mcp-client',
      allowed_scope: 'agent:read',
    });
    mocks.rotateRpc.mockResolvedValue({
      newVersion: 2,
      newJti: 'rt_1_0_rotated',
      expiresIn: 600000,
      allowedScope: 'agent:read',
      resourceAudience: 'https://tenant.example.com/mcp',
    });
    mocks.getRefreshTokenRotatorStubByJti.mockReturnValue({
      stub: {
        getFamilyRpc: mocks.getFamilyRpc,
        rotateRpc: mocks.rotateRpc,
        revokeFamilyRpc: mocks.revokeFamilyRpc,
      },
      resolution: { instanceName: 'rotator', generation: 1, shardIndex: 0, tenantId: 'tenant-1' },
    });
  });

  it('returns 404 when Admin Agent access is disabled', async () => {
    const { app, env } = createApp({ ...environment(), ENABLE_AGENT_MCP: 'false' });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('returns temporarily_unavailable when Agent settings cannot be loaded', async () => {
    const unavailableSettings = { get: vi.fn().mockRejectedValue(new Error('unavailable')) };
    const { app, env } = createApp({
      ...environment(),
      SETTINGS: unavailableSettings as never,
    });
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Agent access configuration unavailable',
    });
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('rejects a token request with the wrong content type', async () => {
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Content-Type must be application/x-www-form-urlencoded',
    });
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it.each(invalidAuthorizationCodeRequests)(
    'rejects an authorization-code request with $name',
    async ({ overrides, status, error }) => {
      const { app, env } = createApp(environment());
      const response = await app.fetch(
        new Request('https://tenant.example.com/oauth/admin-agent/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: requestBody(overrides),
        }),
        env
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(expect.objectContaining({ error }));
      expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
    }
  );

  it('rejects an authorization-code request for an unknown client', async () => {
    mocks.getClientCached.mockResolvedValueOnce(null);
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(expect.objectContaining({ error: 'invalid_client' }));
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'the proof is invalid without a detailed error',
      result: { valid: false },
      error: 'invalid_dpop_proof',
      description: 'DPoP proof validation failed',
    },
    {
      name: 'the proof has no JWK thumbprint',
      result: { valid: true },
      error: 'invalid_dpop_proof',
      description: 'DPoP proof validation failed',
    },
    {
      name: 'the verifier returns a detailed error',
      result: { valid: false, error: 'use_dpop_nonce', error_description: 'Retry with nonce' },
      error: 'use_dpop_nonce',
      description: 'Retry with nonce',
    },
  ])('rejects a DPoP-bound request when $name', async ({ result, error, description }) => {
    mocks.validateDPoPProof.mockResolvedValueOnce(result);
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: 'invalid-proof',
        },
        body: requestBody(),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error,
      error_description: description,
    });
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('consumes only a dedicated code and emits live-bound Agent claims', async () => {
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: 'signed-access-token',
      refresh_token: 'signed-refresh-token',
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'agent:read',
    });
    expect(mocks.consumeCodeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAuthorizationServer: 'admin_agent',
        expectedSubjectType: 'admin_user',
        expectedResource: 'https://tenant.example.com/mcp',
        accessTokenJti: expect.any(String),
      })
    );
    expect(mocks.createAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        iss: 'https://tenant.example.com/oauth/admin-agent',
        sub: 'admin_user:admin-1',
        aud: 'https://tenant.example.com/mcp',
        grant_id: 'grant-1',
        grant_generation: 3,
        consent_version: 2,
        actor_mode: 'mode_a',
        actor_assurance: 'public_client_transaction',
        act: { sub: 'client:mcp-client' },
      }),
      {},
      'kid-1',
      900,
      expect.any(String)
    );
    expect(mocks.createAccessToken.mock.calls[0][4]).toBe(
      mocks.consumeCodeRpc.mock.calls[0][0].accessTokenJti
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.token.issued', grantId: 'grant-1' })
    );
    expect(mocks.createPendingTokenFamily).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        familyJti: 'rt_1_0_initial',
      })
    );
    expect(mocks.finalizeTokenFamily).toHaveBeenCalledWith(
      expect.objectContaining({ grantGeneration: 3, consentVersion: 2 })
    );
  });

  it('rejects Mode B exchange when the machine actor is not DPoP-bound', async () => {
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: 'delegation-token',
          subject_token_type: 'urn:authrim:token-type:agent-delegation',
          actor_token: 'machine-token',
          actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          resource: 'https://tenant.example.com/mcp',
        }),
      }),
      env
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_actor_token' });
  });

  it('rejects JIT delegation issuance without a DPoP machine authorization token', async () => {
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/delegation', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_id: 'grant-1', scope: 'agent:read' }),
      }),
      env
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_token' });
  });

  it('issues an audited one-time Mode B delegation only after live consent and client scope checks', async () => {
    mocks.getGrant.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      machinePrincipalId: 'amp-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'admin_pre_authorized',
    });
    mocks.verifyToken.mockResolvedValue({
      actor_type: 'machine',
      actor_id: 'amp-1',
      credential_id: 'amk-1',
      client_id: 'mcp-client',
      sender_constrained: true,
      jti: 'machine-jti',
      cnf: { jkt: 'mode-b-jkt' },
    });
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/delegation', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: 'DPoP machine-token',
          dpop: 'dpop-proof',
        },
        body: new URLSearchParams({ grant_id: 'grant-1', scope: 'agent:read' }),
      }),
      env
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      delegation_token: 'signed-delegation-token',
      delegation_token_type: 'urn:authrim:token-type:agent-delegation',
    });
    expect(mocks.signJwtPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        token_use: 'agent_delegation',
        grant_id: 'grant-1',
        may_act: { sub: 'machine:amp-1' },
        cnf: { jkt: 'mode-b-jkt' },
      })
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.delegation_token.issued' })
    );
  });

  it('rejects Mode B delegation when either authorization evidence is no longer current', async () => {
    mocks.hasCurrentConsent.mockResolvedValue(false);
    mocks.getGrant.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      machinePrincipalId: 'amp-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'admin_pre_authorized',
    });
    mocks.verifyToken.mockResolvedValue({
      actor_type: 'machine',
      actor_id: 'amp-1',
      credential_id: 'amk-1',
      client_id: 'mcp-client',
      sender_constrained: true,
      jti: 'machine-jti',
      cnf: { jkt: 'mode-b-jkt' },
    });
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/delegation', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: 'DPoP machine-token',
          dpop: 'dpop-proof',
        },
        body: new URLSearchParams({ grant_id: 'grant-1' }),
      }),
      env
    );
    expect(response.status).toBe(400);
    expect(mocks.signJwtPayload).not.toHaveBeenCalled();
  });

  it('exchanges a one-time delegation and DPoP machine actor into a Mode B MCP token', async () => {
    mocks.getGrant.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      machinePrincipalId: 'amp-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'admin_pre_authorized',
    });
    mocks.verifyToken.mockImplementation(async (token: string) =>
      token === 'machine-token'
        ? {
            actor_type: 'machine',
            actor_id: 'amp-1',
            credential_id: 'amk-1',
            client_id: 'mcp-client',
            sender_constrained: true,
            jti: 'machine-jti',
            cnf: { jkt: 'mode-b-jkt' },
          }
        : {
            token_use: 'agent_delegation',
            iss: 'https://tenant.example.com/oauth/admin-agent',
            sub: 'admin_user:admin-1',
            aud: 'https://tenant.example.com/oauth/admin-agent/token',
            jti: 'adj-1',
            exp: Math.floor(Date.now() / 1000) + 300,
            tenant_id: 'tenant-1',
            client_id: 'mcp-client',
            grant_id: 'grant-1',
            grant_generation: 3,
            consent_version: 2,
            scope: 'agent:read',
            resource: 'https://tenant.example.com/mcp',
            may_act: { sub: 'machine:amp-1' },
            cnf: { jkt: 'mode-b-jkt' },
          }
    );
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          dpop: 'dpop-proof',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: 'delegation-token',
          subject_token_type: 'urn:authrim:token-type:agent-delegation',
          actor_token: 'machine-token',
          actor_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          client_id: 'mcp-client',
          resource: 'https://tenant.example.com/mcp',
        }),
      }),
      env
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: 'signed-access-token',
      token_type: 'DPoP',
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'agent:read',
    });
    expect(mocks.consumeModeBDelegationJti).toHaveBeenCalledWith(
      expect.objectContaining({ jti: 'adj-1', machinePrincipalId: 'amp-1' })
    );
    expect(mocks.createAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_mode: 'mode_b',
        actor_assurance: 'machine_key',
        token_binding: 'dpop',
        act: { sub: 'machine:amp-1' },
        act_credential_id: 'amk-1',
        cnf: { jkt: 'mode-b-jkt' },
      }),
      expect.anything(),
      expect.any(String),
      300,
      expect.any(String)
    );
  });

  it('rejects a normal authorization code without touching its store', async () => {
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody({ code: 'ordinary-code' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('does not issue a token after the delegator loses a Grant permission', async () => {
    mocks.getActiveDelegatorPermissions.mockResolvedValue(['admin:clients:read']);
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('uses a linked Mode A Machine Principal only as a live permission ceiling', async () => {
    mocks.getGrant.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      machinePrincipalId: 'amp-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
    });
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );
    expect(response.status).toBe(200);
    expect(mocks.createAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ actor_mode: 'mode_a', act: { sub: 'client:mcp-client' } }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actClientId: 'mcp-client', actPrincipalId: 'amp-1' })
    );
  });

  it('rejects Mode A issuance when its linked principal is no longer active', async () => {
    mocks.getGrant.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      machinePrincipalId: 'amp-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
    });
    mocks.findPrincipalById.mockResolvedValue({
      id: 'amp-1',
      clientId: 'mcp-client',
      status: 'suspended',
    });
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('requires DPoP when the client registration opts in', async () => {
    mocks.getClientCached.mockResolvedValue({
      client_id: 'mcp-client',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
      requestable_scopes: ['agent:read'],
      dpop_bound_access_tokens: true,
    });
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_dpop_proof' });
    expect(mocks.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('caps the access token with the live tenant Agent setting', async () => {
    const configured = environment();
    configured.SETTINGS = {
      get: vi.fn(async () =>
        JSON.stringify({
          'agent.mcp.enabled': true,
          'agent.mcp.max_token_ttl_seconds': 300,
        })
      ),
    } as never;
    const { app, env } = createApp(configured);
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(mocks.createAccessToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'kid-1',
      300,
      expect.any(String)
    );
    await expect(response.json()).resolves.toMatchObject({ expires_in: 300 });
  });

  it('rejects authorization-code replay without issuing another token', async () => {
    mocks.consumeCodeRpc.mockResolvedValue({
      userId: 'admin_user:admin-1',
      scope: 'agent:read',
      redirectUri: 'https://client.example.com/callback',
      authorizationServer: 'admin_agent',
      subjectType: 'admin_user',
      resource: 'https://tenant.example.com/mcp',
      replayAttack: { accessTokenJti: 'at-old', refreshTokenJti: 'rt-old' },
    });
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: requestBody(),
      }),
      env
    );
    expect(response.status).toBe(400);
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('rotates an Admin Agent refresh token after live Grant and family validation', async () => {
    mocks.verifyToken.mockResolvedValue({
      iss: 'https://tenant.example.com/oauth/admin-agent',
      sub: 'admin_user:admin-1',
      aud: 'mcp-client',
      client_id: 'mcp-client',
      tenant_id: 'tenant-1',
      scope: 'agent:read',
      resource_aud: 'https://tenant.example.com/mcp',
      agent_family_id: 'agf-family-1',
      grant_id: 'grant-1',
      grant_generation: 3,
      consent_version: 2,
      actor_mode: 'mode_a',
      actor_assurance: 'public_client_transaction',
      jti: 'rt_1_0_initial',
      rtv: 1,
    });
    mocks.createRefreshToken.mockResolvedValue({
      token: 'rotated-refresh-token',
      jti: 'rt_1_0_rotated',
      rtv: 2,
    });
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'signed-refresh-token',
          client_id: 'mcp-client',
          resource: 'https://tenant.example.com/mcp',
        }),
      }),
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access_token: 'signed-access-token',
      refresh_token: 'rotated-refresh-token',
      scope: 'agent:read',
    });
    expect(mocks.isTokenFamilyUsable).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'agf-family-1', grantGeneration: 3 })
    );
    expect(mocks.rotateRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'agf-family-1',
        incomingJti: 'rt_1_0_initial',
        incomingVersion: 1,
      })
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.token.refreshed' })
    );
  });

  it('rejects refresh when a linked Mode A principal permission ceiling is revoked', async () => {
    mocks.verifyToken.mockResolvedValue({
      sub: 'admin_user:admin-1',
      aud: 'mcp-client',
      client_id: 'mcp-client',
      tenant_id: 'tenant-1',
      scope: 'agent:read',
      resource_aud: 'https://tenant.example.com/mcp',
      agent_family_id: 'agf-family-1',
      grant_id: 'grant-1',
      grant_generation: 3,
      consent_version: 2,
      jti: 'rt_1_0_initial',
      rtv: 1,
    });
    mocks.getGrant.mockResolvedValue({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'mcp-client',
      machinePrincipalId: 'amp-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      consentVersion: 2,
      generation: 3,
      status: 'active',
      delegationMode: 'user_consent',
    });
    mocks.getPrincipalPermissions.mockResolvedValue([]);
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'signed-refresh-token',
          client_id: 'mcp-client',
          resource: 'https://tenant.example.com/mcp',
        }),
      }),
      env
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    expect(mocks.rotateRpc).not.toHaveBeenCalled();
  });

  it('rejects refresh immediately when the DB family or current Grant is no longer usable', async () => {
    mocks.verifyToken.mockResolvedValue({
      sub: 'admin_user:admin-1',
      aud: 'mcp-client',
      client_id: 'mcp-client',
      tenant_id: 'tenant-1',
      scope: 'agent:read',
      resource_aud: 'https://tenant.example.com/mcp',
      agent_family_id: 'agf-family-1',
      grant_id: 'grant-1',
      grant_generation: 3,
      consent_version: 2,
      jti: 'rt_1_0_initial',
      rtv: 1,
    });
    mocks.isTokenFamilyUsable.mockResolvedValue(false);
    const { app, env } = createApp(environment());
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'signed-refresh-token',
          client_id: 'mcp-client',
        }),
      }),
      env
    );
    expect(response.status).toBe(400);
    expect(mocks.rotateRpc).not.toHaveBeenCalled();
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });
});

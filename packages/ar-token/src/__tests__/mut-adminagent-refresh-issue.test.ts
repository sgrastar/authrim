/**
 * Admin Agent refresh_token grant: DPoP binding and the exact claims, audit record and response
 * of a successful rotation (src/admin-agent-token.ts handleAdminAgentRefresh).
 */
import {
  anyNumber,
  anyString,
  anything,
  callArg,
  confidentialClient,
  environment,
  expectError,
  ISSUER,
  matching,
  MCP,
  mocks,
  post,
  publicClient,
  refreshForm,
  refreshPayload,
  resetDefaults,
  TOKEN_URL,
} from './helpers/mut-adminagent-setup';
import { beforeEach, describe, expect, it } from 'vitest';

const FAILED = 'DPoP proof validation failed';

describe('Admin Agent refresh: DPoP binding', () => {
  beforeEach(() => {
    resetDefaults();
    mocks.verifyToken.mockResolvedValue(refreshPayload());
  });

  it('requires a proof for a DPoP-bound refresh token', async () => {
    mocks.verifyToken.mockResolvedValue(refreshPayload({ cnf: { jkt: 'bound-jkt' } }));
    await expectError(
      await post('token', refreshForm()),
      400,
      'invalid_dpop_proof',
      'DPoP proof is required'
    );
    expect(mocks.validateDPoPProof).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid proof', { valid: false, jkt: 'bound-jkt' }],
    ['a proof without a thumbprint', { valid: true }],
    ['a proof for another key', { valid: true, jkt: 'other-jkt' }],
  ])('rejects %s for a bound refresh token', async (_name, result) => {
    mocks.verifyToken.mockResolvedValue(refreshPayload({ cnf: { jkt: 'bound-jkt' } }));
    mocks.validateDPoPProof.mockResolvedValue(result);
    await expectError(
      await post('token', refreshForm(), { dpop: 'proof' }),
      400,
      'invalid_dpop_proof',
      FAILED
    );
    expect(mocks.getGrant).not.toHaveBeenCalled();
  });

  it('rejects an invalid proof even for an unbound refresh token', async () => {
    mocks.validateDPoPProof.mockResolvedValue({ valid: false, jkt: 'any' });
    await expectError(
      await post('token', refreshForm(), { dpop: 'proof' }),
      400,
      'invalid_dpop_proof',
      FAILED
    );
  });

  it('requires DPoP when the client registration opts in', async () => {
    mocks.getClientCached.mockResolvedValue({ ...publicClient(), dpop_bound_access_tokens: true });
    await expectError(
      await post('token', refreshForm()),
      400,
      'invalid_dpop_proof',
      'DPoP proof is required for this client'
    );
  });

  it('binds rotated tokens to the matching proof key', async () => {
    mocks.verifyToken.mockResolvedValue(refreshPayload({ cnf: { jkt: 'bound-jkt' } }));
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'bound-jkt' });
    const response = await post('token', refreshForm(), { dpop: 'proof' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: 'DPoP' });
    expect(mocks.validateDPoPProof).toHaveBeenCalledWith(
      'proof',
      'POST',
      TOKEN_URL,
      undefined,
      anything(),
      'mcp-client',
      'tenant-1'
    );
    expect(callArg<unknown>(mocks.createAccessToken, 0)).toMatchObject({
      token_binding: 'dpop',
      cnf: { jkt: 'bound-jkt' },
    });
    expect(callArg<unknown>(mocks.createRefreshToken, 0)).toMatchObject({
      cnf: { jkt: 'bound-jkt' },
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ tokenBinding: 'dpop' })
    );
  });

  it('upgrades an unbound refresh token to a DPoP binding when a proof is presented', async () => {
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'new-jkt' });
    const response = await post('token', refreshForm(), { dpop: 'proof' });
    expect(response.status).toBe(200);
    expect(callArg<unknown>(mocks.createRefreshToken, 0)).toMatchObject({
      cnf: { jkt: 'new-jkt' },
    });
  });
});

describe('Admin Agent refresh: issued tokens', () => {
  beforeEach(() => {
    resetDefaults();
    mocks.verifyToken.mockResolvedValue(refreshPayload());
  });

  it('issues bearer tokens with the exact public-client claims, audit and response', async () => {
    const response = await post('token', refreshForm(), { 'x-request-id': 'req-1' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({
      access_token: 'signed-access-token',
      refresh_token: 'signed-refresh-token',
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'agent:read agent:write',
    });
    expect(mocks.createAccessToken).toHaveBeenCalledWith(
      {
        iss: ISSUER,
        sub: 'admin_user:admin-1',
        aud: MCP,
        scope: 'agent:read agent:write',
        client_id: 'mcp-client',
        azp: 'mcp-client',
        tenant_id: 'tenant-1',
        grant_id: 'grant-1',
        grant_generation: 3,
        consent_version: 2,
        actor_mode: 'mode_a',
        actor_assurance: 'public_client_transaction',
        token_binding: 'bearer',
        act: { sub: 'client:mcp-client' },
      },
      {},
      'kid-1',
      900,
      anyString()
    );
    expect(mocks.createRefreshToken).toHaveBeenCalledWith(
      {
        iss: ISSUER,
        sub: 'admin_user:admin-1',
        aud: 'mcp-client',
        scope: 'agent:read agent:write',
        client_id: 'mcp-client',
        tenant_id: 'tenant-1',
        resource_aud: MCP,
        agent_family_id: 'agf-family-1',
        grant_id: 'grant-1',
        grant_generation: 3,
        consent_version: 2,
        actor_mode: 'mode_a',
        actor_assurance: 'public_client_transaction',
      },
      {},
      'kid-1',
      600000,
      'rt_rotated',
      2
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith({
      id: matching(/^audit_/u),
      tenantId: 'tenant-1',
      adminUserId: 'admin-1',
      action: 'agent.token.refreshed',
      resourceType: 'admin_agent_grant',
      resourceId: 'grant-1',
      severity: 'info',
      requestId: 'req-1',
      actorType: 'agent',
      actorSub: 'client:mcp-client',
      actorMode: 'mode_a',
      actorAssurance: 'public_client_transaction',
      tokenBinding: 'bearer',
      actClientId: 'mcp-client',
      actPrincipalId: undefined,
      grantId: 'grant-1',
      metadata: { family_id: 'agf-family-1', grant_generation: 3 },
      createdAt: anyNumber(),
    });
    expect(mocks.coreExecute).not.toHaveBeenCalled();
  });

  it('marks a confidential client rotation with confidential assurance', async () => {
    mocks.getClientCached.mockResolvedValue(confidentialClient());
    const response = await post('token', refreshForm({ client_secret: 's' }));
    expect(response.status).toBe(200);
    expect(callArg<unknown>(mocks.createAccessToken, 0)).toMatchObject({
      actor_assurance: 'confidential_client',
    });
    expect(callArg<unknown>(mocks.createRefreshToken, 0)).toMatchObject({
      actor_assurance: 'confidential_client',
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorAssurance: 'confidential_client' })
    );
  });

  it('rotates the signing key when no active private key exists', async () => {
    const rotate = async () => ({ kid: 'kid-rotated', privatePEM: 'pem' });
    const env = environment({
      KEY_MANAGER: {
        idFromName: () => ({}),
        get: () => ({
          getActiveKeyWithPrivateRpc: async () => null,
          rotateKeysWithPrivateRpc: rotate,
        }),
      } as never,
    });
    const response = await post('token', refreshForm(), {}, env);
    expect(response.status).toBe(200);
    expect(callArg<unknown>(mocks.createAccessToken, 2)).toBe('kid-rotated');
    expect(mocks.importPKCS8).toHaveBeenCalledWith('pem', 'RS256');
  });

  it('fails when the key manager binding is missing', async () => {
    const env = environment({
      KEY_MANAGER: undefined,
    });
    const response = await post('token', refreshForm(), {}, env);
    expect(response.status).toBe(500);
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });
});

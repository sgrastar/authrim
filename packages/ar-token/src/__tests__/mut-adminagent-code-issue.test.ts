/**
 * Admin Agent authorization_code grant: live Grant validation and the exact access token claims,
 * audit record and response (src/admin-agent-token.ts adminAgentTokenHandler).
 */
import {
  anyNumber,
  callArg,
  codeData,
  codeForm,
  confidentialClient,
  expectError,
  ISSUER,
  machineLimit,
  matching,
  MCP,
  mocks,
  modeAGrant,
  post,
  publicClient,
  resetDefaults,
} from './helpers/mut-adminagent-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const GRANT_INVALID = 'Agent Grant is no longer valid';

describe('Admin Agent token endpoint: live Grant validation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetDefaults();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads Grant, permissions and consent for the code binding', async () => {
    expect((await post('token', codeForm())).status).toBe(200);
    expect(mocks.getGrant).toHaveBeenCalledWith('tenant-1', 'grant-1');
    expect(mocks.getActiveDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', NOW);
    expect(mocks.hasCurrentConsent).toHaveBeenCalledWith(
      'tenant-1',
      'grant-1',
      'admin-1',
      'mcp-client',
      2
    );
    expect(mocks.resolveTenantMachineLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing Grant', () => mocks.getGrant.mockResolvedValue(null)],
    [
      'a suspended Grant',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ status: 'suspended' })),
    ],
    [
      'a Grant of another client',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ clientId: 'x' })),
    ],
    [
      'a Grant of another delegator',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ delegatorId: 'admin-2' })),
    ],
    ['a newer generation', () => mocks.getGrant.mockResolvedValue(modeAGrant({ generation: 9 }))],
    ['a newer consent', () => mocks.getGrant.mockResolvedValue(modeAGrant({ consentVersion: 9 }))],
    [
      'a Grant expiring now',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ expiresAt: NOW })),
    ],
    ['an inactive delegator', () => mocks.getActiveDelegatorPermissions.mockResolvedValue(null)],
    [
      'a delegator without a Grant permission',
      () => mocks.getActiveDelegatorPermissions.mockResolvedValue(['admin:clients:read']),
    ],
    [
      'a linked principal that is gone',
      () => {
        mocks.getGrant.mockResolvedValue(modeAGrant({ machinePrincipalId: 'amp-1' }));
        mocks.resolveTenantMachineLimit.mockResolvedValue(null);
      },
    ],
    [
      'a linked principal below the Grant',
      () => {
        mocks.getGrant.mockResolvedValue(modeAGrant({ machinePrincipalId: 'amp-1' }));
        mocks.resolveTenantMachineLimit.mockResolvedValue(machineLimit(['admin:clients:read']));
      },
    ],
    ['withdrawn consent', () => mocks.hasCurrentConsent.mockResolvedValue(false)],
    [
      'a scope outside the Grant',
      () => mocks.consumeCodeRpc.mockResolvedValue(codeData({ scope: 'agent:read agent:admin' })),
    ],
    [
      'a scope the client no longer registers',
      () =>
        mocks.getClientCached.mockResolvedValue({
          ...publicClient(),
          requestable_scopes: undefined,
        }),
    ],
  ])('rejects %s', async (_name, arrange) => {
    arrange();
    await expectError(await post('token', codeForm()), 400, 'invalid_grant', GRANT_INVALID);
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('accepts a future Grant expiry, a covering linked principal and multiple scopes', async () => {
    mocks.getGrant.mockResolvedValue(
      modeAGrant({ expiresAt: NOW + 1, machinePrincipalId: 'amp-1' })
    );
    mocks.consumeCodeRpc.mockResolvedValue(codeData({ scope: 'agent:read  agent:write' }));
    const response = await post('token', codeForm());
    expect(response.status).toBe(200);
    expect(mocks.resolveTenantMachineLimit).toHaveBeenCalledWith('tenant-1', 'amp-1');
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actPrincipalId: 'amp-1' })
    );
  });

  it('rejects authorization_details outside the Admin Agent contract', async () => {
    mocks.consumeCodeRpc.mockResolvedValue(
      codeData({ authorizationDetails: JSON.stringify([{ type: 'payment' }]) })
    );
    await expectError(
      await post('token', codeForm()),
      400,
      'invalid_grant',
      'authorization_details is invalid'
    );
  });
});

describe('Admin Agent token endpoint: issued tokens', () => {
  beforeEach(resetDefaults);

  it('issues the exact Mode A public-client bearer token, audit and response', async () => {
    const response = await post('token', codeForm(), { 'x-request-id': 'req-9' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({
      access_token: 'signed-access-token',
      refresh_token: 'signed-refresh-token',
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'agent:read',
    });
    const accessJti = callArg(mocks.consumeCodeRpc, 0).accessTokenJti;
    expect(mocks.createAccessToken).toHaveBeenCalledWith(
      {
        iss: ISSUER,
        sub: 'admin_user:admin-1',
        aud: MCP,
        scope: 'agent:read',
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
      accessJti
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith({
      id: matching(/^audit_/u),
      tenantId: 'tenant-1',
      adminUserId: 'admin-1',
      action: 'agent.token.issued',
      resourceType: 'admin_agent_grant',
      resourceId: 'grant-1',
      severity: 'info',
      requestId: 'req-9',
      actorType: 'agent',
      actorSub: 'client:mcp-client',
      actorMode: 'mode_a',
      actorAssurance: 'public_client_transaction',
      tokenBinding: 'bearer',
      actClientId: 'mcp-client',
      actPrincipalId: undefined,
      grantId: 'grant-1',
      metadata: { grant_generation: 3, consent_version: 2, access_token_jti: accessJti },
      createdAt: anyNumber(),
    });
    expect(mocks.coreExecute).not.toHaveBeenCalled();
  });

  it('issues DPoP-bound tokens with authorization_details for a confidential client', async () => {
    const details = [{ type: 'authrim_admin_agent', max_subjects_per_call: 4 }];
    mocks.getClientCached.mockResolvedValue(confidentialClient());
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'jkt-1' });
    mocks.consumeCodeRpc.mockResolvedValue(
      codeData({ dpopJkt: 'jkt-1', authorizationDetails: details })
    );
    const response = await post('token', codeForm({ client_secret: 's' }), { dpop: 'proof' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token_type: 'DPoP',
      authorization_details: details,
    });
    expect(callArg<unknown>(mocks.createAccessToken, 0)).toMatchObject({
      actor_assurance: 'confidential_client',
      token_binding: 'dpop',
      cnf: { jkt: 'jkt-1' },
      authorization_details: details,
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorAssurance: 'confidential_client', tokenBinding: 'dpop' })
    );
  });

  it('extends the inactivity window of a self-service client after issuance', async () => {
    mocks.getClientCached.mockResolvedValue({
      ...publicClient(),
      agent_access_registration_mode: 'self_service',
      agent_access_expires_at: Date.now() + 60_000,
    });
    expect((await post('token', codeForm())).status).toBe(200);
    const params = callArg<number[]>(mocks.coreExecute, 1);
    expect(params[1] - params[0]).toBe(30 * 24 * 60 * 60 * 1000);
    expect(params.slice(2) as unknown[]).toEqual(['tenant-1', 'mcp-client']);
  });
});

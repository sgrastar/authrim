/**
 * Mode B token exchange: live Grant / ceiling / scope validation after consumption and the exact
 * issued token, audit and response (src/admin-agent-token.ts handleAdminAgentModeBExchange).
 */
import {
  ACCESS_TYPE,
  anyString,
  callArg,
  delegationPayload,
  environment,
  exchangeForm,
  expectError,
  ISSUER,
  machineActorPayload,
  machineLimit,
  matching,
  MCP,
  mocks,
  modeBGrant,
  post,
  publicClient,
  resetDefaults,
  routeVerifyToken,
} from './helpers/mut-adminagent-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const GRANT_INVALID = 'Agent Grant is no longer valid';
const exchange = (form: Record<string, string> = exchangeForm(), env = environment()) =>
  post('token', form, { dpop: 'dpop-proof', 'x-request-id': 'req-b' }, env);
const withDelegation = (overrides: Record<string, unknown>) =>
  routeVerifyToken(machineActorPayload(), delegationPayload(overrides));

describe('Mode B token exchange: live Grant validation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetDefaults();
    mocks.getGrant.mockResolvedValue(modeBGrant());
    routeVerifyToken(machineActorPayload(), delegationPayload());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips the consent lookup when the Grant is gone', async () => {
    mocks.getGrant.mockResolvedValue(null);
    await expectError(await exchange(), 400, 'invalid_grant', GRANT_INVALID);
    expect(mocks.hasCurrentConsent).not.toHaveBeenCalled();
  });

  it.each([
    ['a revoked Grant', () => mocks.getGrant.mockResolvedValue(modeBGrant({ status: 'revoked' }))],
    [
      'a Grant expiring now',
      () => mocks.getGrant.mockResolvedValue(modeBGrant({ expiresAt: NOW })),
    ],
    [
      'another delegator',
      () => mocks.getGrant.mockResolvedValue(modeBGrant({ delegatorId: 'admin-2' })),
    ],
    ['another client', () => mocks.getGrant.mockResolvedValue(modeBGrant({ clientId: 'other' }))],
    [
      'another principal',
      () => mocks.getGrant.mockResolvedValue(modeBGrant({ machinePrincipalId: 'amp-2' })),
    ],
    ['a newer generation', () => mocks.getGrant.mockResolvedValue(modeBGrant({ generation: 4 }))],
    [
      'a newer consent version',
      () => mocks.getGrant.mockResolvedValue(modeBGrant({ consentVersion: 3 })),
    ],
    ['withdrawn consent', () => mocks.hasCurrentConsent.mockResolvedValue(false)],
    ['a deleted client', () => mocks.getClientCached.mockResolvedValue(null)],
    ['an inactive delegator', () => mocks.getActiveDelegatorPermissions.mockResolvedValue(null)],
    [
      'a delegator below the Grant',
      () => mocks.getActiveDelegatorPermissions.mockResolvedValue(['admin:clients:read']),
    ],
    [
      'a machine below the Grant',
      () => mocks.resolveTenantMachineLimit.mockResolvedValue(machineLimit(['admin:clients:read'])),
    ],
    ['no scope at all', () => withDelegation({ scope: undefined })],
    ['a delegation with an empty scope', () => withDelegation({ scope: '  ' })],
    [
      'a scope beyond the Grant',
      () => mocks.getGrant.mockResolvedValue(modeBGrant({ scopes: ['agent:read'] })),
    ],
    [
      'a scope the client no longer registers',
      () =>
        mocks.getClientCached.mockResolvedValue({
          ...publicClient(),
          requestable_scopes: ['agent:read'],
        }),
    ],
    [
      'a client without registered scopes',
      () =>
        mocks.getClientCached.mockResolvedValue({
          ...publicClient(),
          requestable_scopes: undefined,
        }),
    ],
  ])('rejects %s', async (_name, arrange) => {
    arrange();
    await expectError(await exchange(), 400, 'invalid_grant', GRANT_INVALID);
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('loads the live evidence for the delegator and Grant', async () => {
    expect((await exchange()).status).toBe(200);
    expect(mocks.getGrant).toHaveBeenCalledWith('tenant-1', 'grant-1');
    expect(mocks.getActiveDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', NOW);
    expect(mocks.hasCurrentConsent).toHaveBeenCalledWith(
      'tenant-1',
      'grant-1',
      'admin-1',
      'mcp-client',
      2
    );
  });

  it('accepts a Grant that expires later and narrows to the requested scope', async () => {
    mocks.getGrant.mockResolvedValue(modeBGrant({ expiresAt: NOW + 1 }));
    const response = await exchange(exchangeForm({ scope: 'agent:write' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: 'agent:write' });
  });

  it('rejects a requested scope the delegation did not carry', async () => {
    withDelegation({ scope: 'agent:read' });
    await expectError(
      await exchange(exchangeForm({ scope: 'agent:write' })),
      400,
      'invalid_grant',
      GRANT_INVALID
    );
  });
});

describe('Mode B token exchange: issued token', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetDefaults();
    mocks.getGrant.mockResolvedValue(modeBGrant());
    routeVerifyToken(machineActorPayload(), delegationPayload());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues the exact DPoP-bound Mode B token, audit and response', async () => {
    const response = await exchange();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({
      access_token: 'signed-access-token',
      issued_token_type: ACCESS_TYPE,
      token_type: 'DPoP',
      expires_in: 300,
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
        actor_mode: 'mode_b',
        actor_assurance: 'machine_key',
        token_binding: 'dpop',
        act: { sub: 'machine:amp-1' },
        act_principal_id: 'amp-1',
        act_credential_id: 'amk-1',
        cnf: { jkt: 'mode-b-jkt' },
      },
      {},
      'kid-1',
      300,
      anyString()
    );
    const accessJti = callArg<unknown>(mocks.createAccessToken, 4);
    expect(mocks.writeAudit).toHaveBeenCalledWith({
      id: matching(/^audit_/u),
      tenantId: 'tenant-1',
      adminUserId: 'admin-1',
      action: 'agent.token.issued',
      resourceType: 'admin_agent_grant',
      resourceId: 'grant-1',
      severity: 'info',
      requestId: 'req-b',
      actorType: 'agent',
      actorSub: 'machine:amp-1',
      actorMode: 'mode_b',
      actorAssurance: 'machine_key',
      tokenBinding: 'dpop',
      actClientId: 'mcp-client',
      actPrincipalId: 'amp-1',
      grantId: 'grant-1',
      metadata: { delegation_jti: 'adj-1', access_token_jti: accessJti },
      createdAt: NOW,
    });
  });

  it('uses a tenant token lifetime shorter than the Mode B cap', async () => {
    const settings = {
      get: async () =>
        JSON.stringify({ 'agent.mcp.enabled': true, 'agent.mcp.max_token_ttl_seconds': 120 }),
    };
    const response = await exchange(exchangeForm(), environment({ SETTINGS: settings as never }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ expires_in: 120 });
    expect(callArg<unknown>(mocks.createAccessToken, 3)).toBe(120);
  });
});

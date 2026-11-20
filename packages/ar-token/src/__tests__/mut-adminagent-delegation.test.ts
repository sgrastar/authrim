/**
 * Mode B JIT delegation issuance (src/admin-agent-token.ts adminAgentDelegationHandler).
 */
import {
  anything,
  BASE,
  callArg,
  environment,
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
  signJwtSettings,
  TOKEN_URL,
} from './helpers/mut-adminagent-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const ACTOR = { authorization: 'DPoP machine-token', dpop: 'dpop-proof' };
const NOT_ACTIVE = 'Mode B Grant is not active';
const CEILING = 'Mode B permission ceiling changed';

const delegate = (form: Record<string, string> = { grant_id: 'grant-1' }, h = ACTOR) =>
  post('delegation', form, h);

describe('Mode B delegation endpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetDefaults();
    mocks.getGrant.mockResolvedValue(modeBGrant());
    mocks.verifyToken.mockResolvedValue(machineActorPayload());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is hidden when Agent access is disabled or its settings are unavailable', async () => {
    const disabled = await post(
      'delegation',
      { grant_id: 'grant-1' },
      ACTOR,
      environment({ ENABLE_AGENT_MCP: 'false' })
    );
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({ error: 'not_found' });

    const failing = { get: async () => Promise.reject(new Error('kv down')) };
    const unavailable = await post(
      'delegation',
      { grant_id: 'grant-1' },
      ACTOR,
      environment({ SETTINGS: failing as never })
    );
    expect(unavailable.status).toBe(404);
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it('requires form encoding', async () => {
    const response = await post(
      'delegation',
      { grant_id: 'grant-1' },
      { ...ACTOR, 'content-type': 'application/json' }
    );
    await expectError(response, 400, 'invalid_request', 'Form encoding is required');
  });

  it.each([
    ['an unsupported parameter', { grant_id: 'grant-1', extra: 'x' }],
    ['no grant_id', { scope: 'agent:read' }],
  ])('rejects %s', async (_name, form) => {
    await expectError(
      await delegate(form),
      400,
      'invalid_request',
      'Mode B delegation request is invalid'
    );
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it('rejects a foreign resource and accepts this MCP resource', async () => {
    await expectError(
      await delegate({ grant_id: 'grant-1', resource: 'https://other.example/mcp' }),
      400,
      'invalid_target',
      'resource must identify this MCP endpoint'
    );
    expect(mocks.getGrant).not.toHaveBeenCalled();
    expect((await delegate({ grant_id: 'grant-1', resource: MCP })).status).toBe(200);
  });

  it.each([
    ['a missing Grant', null],
    ['a revoked Grant', modeBGrant({ status: 'revoked' })],
    ['a Grant of another principal', modeBGrant({ machinePrincipalId: 'amp-2' })],
    ['a Grant of another client', modeBGrant({ clientId: 'other-client' })],
    ['a user-consent Grant', modeBGrant({ delegationMode: 'user_consent' })],
    ['a Grant expiring now', modeBGrant({ expiresAt: NOW })],
  ])('rejects %s', async (_name, grant) => {
    mocks.getGrant.mockResolvedValue(grant);
    await expectError(await delegate(), 400, 'invalid_grant', NOT_ACTIVE);
    expect(mocks.getActiveDelegatorPermissions).not.toHaveBeenCalled();
  });

  it.each([
    ['an inactive delegator', () => mocks.getActiveDelegatorPermissions.mockResolvedValue(null)],
    ['withdrawn consent', () => mocks.hasCurrentConsent.mockResolvedValue(false)],
    ['a deleted client', () => mocks.getClientCached.mockResolvedValue(null)],
    [
      'a delegator below the Grant',
      () => mocks.getActiveDelegatorPermissions.mockResolvedValue(['admin:clients:read']),
    ],
    [
      'a machine below the Grant',
      () => mocks.resolveTenantMachineLimit.mockResolvedValue(machineLimit(['admin:clients:read'])),
    ],
  ])('rejects %s', async (_name, arrange) => {
    arrange();
    await expectError(await delegate(), 400, 'invalid_grant', CEILING);
    expect(mocks.signJwtPayload).not.toHaveBeenCalled();
  });

  it.each([
    ['a scope outside the Grant', { scope: 'agent:admin' }, publicClient()],
    [
      'a scope the client does not register',
      { scope: 'agent:write' },
      { ...publicClient(), requestable_scopes: ['agent:read'] },
    ],
    [
      'the Grant scopes for a client without registered scopes',
      {},
      { ...publicClient(), requestable_scopes: undefined },
    ],
  ])('rejects %s', async (_name, extra, client) => {
    mocks.getClientCached.mockResolvedValue(client);
    await expectError(
      await delegate({ grant_id: 'grant-1', ...extra }),
      400,
      'invalid_scope',
      'Requested scope exceeds the Agent Grant'
    );
  });

  it('narrows and de-duplicates requested scopes', async () => {
    const response = await delegate({ grant_id: 'grant-1', scope: ' agent:read  agent:read ' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: 'agent:read' });
    expect(callArg<unknown>(mocks.signJwtPayload, 0)).toMatchObject({ scope: 'agent:read' });
  });

  it('issues the exact one-time delegation token, audit and response', async () => {
    const response = await delegate();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({
      delegation_token: 'signed-delegation-token',
      delegation_token_type: 'urn:authrim:token-type:agent-delegation',
      expires_in: 300,
      scope: 'agent:read agent:write',
    });
    expect(mocks.getActiveDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', NOW);
    expect(mocks.hasCurrentConsent).toHaveBeenCalledWith(
      'tenant-1',
      'grant-1',
      'admin-1',
      'mcp-client',
      2
    );
    expect(mocks.getClientCached).toHaveBeenCalledWith(anything(), anything(), 'mcp-client');
    expect(mocks.signJwtPayload).toHaveBeenCalledWith({
      token_use: 'agent_delegation',
      grant_id: 'grant-1',
      grant_generation: 3,
      consent_version: 2,
      tenant_id: 'tenant-1',
      client_id: 'mcp-client',
      scope: 'agent:read agent:write',
      resource: MCP,
      may_act: { sub: 'machine:amp-1' },
      cnf: { jkt: 'mode-b-jkt' },
    });
    const calls = signJwtSettings();
    expect(calls).toEqual({
      header: { alg: 'RS256', typ: 'JWT', kid: 'kid-1' },
      iss: ISSUER,
      sub: 'admin_user:admin-1',
      aud: TOKEN_URL,
      jti: matching(/^adj_[0-9a-f-]{36}$/u),
      iat: NOW_S,
      nbf: NOW_S,
      exp: NOW_S + 300,
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith({
      id: matching(/^audit_/u),
      tenantId: 'tenant-1',
      adminUserId: 'admin-1',
      action: 'agent.delegation_token.issued',
      resourceType: 'admin_agent_grant',
      resourceId: 'grant-1',
      severity: 'info',
      result: 'success',
      actorType: 'agent',
      actorSub: 'machine:amp-1',
      actorMode: 'mode_b',
      actorAssurance: 'machine_key',
      tokenBinding: 'dpop',
      actClientId: 'mcp-client',
      actPrincipalId: 'amp-1',
      grantId: 'grant-1',
      metadata: { delegation_jti: calls.jti, expires_at: (NOW_S + 300) * 1000 },
      createdAt: NOW,
    });
  });

  it('strips a trailing slash from the issuer', async () => {
    mocks.buildRequestIssuerUrl.mockReturnValue(`${BASE}/`);
    expect((await delegate({ grant_id: 'grant-1', resource: MCP })).status).toBe(200);
    expect(signJwtSettings().iss).toBe(ISSUER);
  });
});

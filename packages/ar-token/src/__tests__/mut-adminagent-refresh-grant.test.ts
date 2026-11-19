/**
 * Admin Agent refresh_token grant: live Grant / permission / family validation and idle expiry
 * (src/admin-agent-token.ts handleAdminAgentRefresh).
 */
import {
  anything,
  confidentialClient,
  expectError,
  machineLimit,
  mocks,
  modeAGrant,
  post,
  refreshForm,
  refreshPayload,
  resetDefaults,
} from './helpers/mut-adminagent-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = 1_800_000_000_000;
const GRANT_INVALID = 'Agent Grant is no longer valid';
const INVALID_REFRESH = 'Refresh token is invalid or expired';

describe('Admin Agent refresh: live Grant validation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetDefaults();
    mocks.verifyToken.mockResolvedValue(refreshPayload());
    mocks.getFamilyRpc.mockResolvedValue({
      tenant_id: 'tenant-1',
      last_used_at: NOW,
      user_id: 'agf-family-1',
      client_id: 'mcp-client',
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the Grant, delegator permissions and family usability for the token binding', async () => {
    expect((await post('token', refreshForm())).status).toBe(200);
    expect(mocks.getGrant).toHaveBeenCalledWith('tenant-1', 'grant-1');
    expect(mocks.getActiveDelegatorPermissions).toHaveBeenCalledWith('tenant-1', 'admin-1', NOW);
    expect(mocks.isTokenFamilyUsable).toHaveBeenCalledWith({
      familyId: 'agf-family-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 3,
      adminUserId: 'admin-1',
      clientId: 'mcp-client',
      consentVersion: 2,
      now: NOW,
    });
    expect(mocks.resolveTenantMachineLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing Grant', () => mocks.getGrant.mockResolvedValue(null)],
    ['an unusable DB family', () => mocks.isTokenFamilyUsable.mockResolvedValue(false)],
    ['a revoked Grant', () => mocks.getGrant.mockResolvedValue(modeAGrant({ status: 'revoked' }))],
    [
      'a Grant expiring now',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ expiresAt: NOW })),
    ],
    [
      'a Grant of another client',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ clientId: 'other' })),
    ],
    [
      'a Grant of another delegator',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ delegatorId: 'admin-2' })),
    ],
    [
      'a newer Grant generation',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ generation: 4 })),
    ],
    [
      'a newer consent version',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ consentVersion: 3 })),
    ],
    ['an inactive delegator', () => mocks.getActiveDelegatorPermissions.mockResolvedValue(null)],
    [
      'a delegator that lost a Grant permission',
      () => mocks.getActiveDelegatorPermissions.mockResolvedValue(['admin:clients:read']),
    ],
    [
      'an inactive linked principal',
      () => {
        mocks.getGrant.mockResolvedValue(modeAGrant({ machinePrincipalId: 'amp-1' }));
        mocks.resolveTenantMachineLimit.mockResolvedValue(null);
      },
    ],
    [
      'a linked principal below the Grant permissions',
      () => {
        mocks.getGrant.mockResolvedValue(modeAGrant({ machinePrincipalId: 'amp-1' }));
        mocks.resolveTenantMachineLimit.mockResolvedValue(machineLimit(['admin:clients:read']));
      },
    ],
    [
      'a scope no longer in the Grant',
      () => mocks.getGrant.mockResolvedValue(modeAGrant({ scopes: ['agent:read'] })),
    ],
    [
      'a scope no longer registered for the client',
      () =>
        mocks.getClientCached.mockResolvedValue({
          client_id: 'mcp-client',
          token_endpoint_auth_method: 'none',
          requestable_scopes: ['agent:read'],
        }),
    ],
    [
      'a client without registered scopes',
      () =>
        mocks.getClientCached.mockResolvedValue({
          client_id: 'mcp-client',
          token_endpoint_auth_method: 'none',
        }),
    ],
  ])('rejects refresh for %s without rotating', async (_name, arrange) => {
    arrange();
    await expectError(await post('token', refreshForm()), 400, 'invalid_grant', GRANT_INVALID);
    expect(mocks.rotateRpc).not.toHaveBeenCalled();
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('accepts a Grant that expires in the future', async () => {
    mocks.getGrant.mockResolvedValue(modeAGrant({ expiresAt: NOW + 1 }));
    expect((await post('token', refreshForm())).status).toBe(200);
  });

  it('accepts a linked principal that still covers the Grant and records it', async () => {
    mocks.getGrant.mockResolvedValue(modeAGrant({ machinePrincipalId: 'amp-1' }));
    mocks.resolveTenantMachineLimit.mockResolvedValue(machineLimit(['admin:users:*']));
    expect((await post('token', refreshForm())).status).toBe(200);
    expect(mocks.resolveTenantMachineLimit).toHaveBeenCalledWith('tenant-1', 'amp-1');
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actPrincipalId: 'amp-1' })
    );
  });

  it('checks only the scopes actually requested against the Grant', async () => {
    mocks.getGrant.mockResolvedValue(modeAGrant({ scopes: ['agent:read'] }));
    const response = await post('token', refreshForm({ scope: 'agent:read' }));
    expect(response.status).toBe(200);
  });
});

describe('Admin Agent refresh: family binding and idle expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    resetDefaults();
    mocks.verifyToken.mockResolvedValue(refreshPayload());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const family = (overrides: Record<string, unknown> = {}) => ({
    tenant_id: 'tenant-1',
    last_used_at: NOW,
    user_id: 'agf-family-1',
    client_id: 'mcp-client',
    ...overrides,
  });

  it('reads the family from the rotator shard of the presented refresh jti', async () => {
    mocks.getFamilyRpc.mockResolvedValue(family());
    expect((await post('token', refreshForm())).status).toBe(200);
    expect(mocks.getRefreshTokenRotatorStubByJti).toHaveBeenCalledWith(
      anything(),
      'mcp-client',
      'rt_1_0_initial',
      'tenant-1'
    );
    expect(mocks.getFamilyRpc).toHaveBeenCalledWith('agf-family-1');
    expect(mocks.revokeFamilyRpc).not.toHaveBeenCalled();
  });

  it('rejects a missing family without revoking anything', async () => {
    mocks.getFamilyRpc.mockResolvedValue(null);
    await expectError(await post('token', refreshForm()), 400, 'invalid_grant', INVALID_REFRESH);
    expect(mocks.revokeFamilyRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['another family user', { user_id: 'agf-other' }],
    ['another tenant', { tenant_id: 'tenant-2' }],
    ['another client', { client_id: 'other-client' }],
    ['a public client idle for exactly 12 hours', { last_used_at: NOW - 12 * 3600 * 1000 }],
  ])('revokes and rejects a family with %s', async (_name, overrides) => {
    mocks.getFamilyRpc.mockResolvedValue(family(overrides));
    await expectError(await post('token', refreshForm()), 400, 'invalid_grant', INVALID_REFRESH);
    expect(mocks.revokeFamilyRpc).toHaveBeenCalledWith('agf-family-1', 'idle_or_binding_expired');
    expect(mocks.rotateRpc).not.toHaveBeenCalled();
  });

  it('keeps a public client family used just inside the 12 hour idle window', async () => {
    mocks.getFamilyRpc.mockResolvedValue(family({ last_used_at: NOW - 12 * 3600 * 1000 + 1 }));
    expect((await post('token', refreshForm())).status).toBe(200);
  });

  it('gives a confidential client a 24 hour idle window', async () => {
    mocks.getClientCached.mockResolvedValue(confidentialClient());
    mocks.getFamilyRpc.mockResolvedValue(family({ last_used_at: NOW - 23 * 3600 * 1000 }));
    expect((await post('token', refreshForm({ client_secret: 's' }))).status).toBe(200);

    mocks.getFamilyRpc.mockResolvedValue(family({ last_used_at: NOW - 24 * 3600 * 1000 }));
    await expectError(
      await post('token', refreshForm({ client_secret: 's' })),
      400,
      'invalid_grant',
      INVALID_REFRESH
    );
  });

  it('reports a rotation failure as possible reuse', async () => {
    mocks.getFamilyRpc.mockResolvedValue(family());
    mocks.rotateRpc.mockRejectedValue(new Error('reuse'));
    await expectError(
      await post('token', refreshForm()),
      400,
      'invalid_grant',
      'Refresh token reuse or rotation failure detected'
    );
    expect(mocks.rotateRpc).toHaveBeenCalledWith({
      incomingVersion: 1,
      incomingJti: 'rt_1_0_initial',
      userId: 'agf-family-1',
      clientId: 'mcp-client',
      tenantId: 'tenant-1',
      requestedScope: 'agent:read agent:write',
    });
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });
});

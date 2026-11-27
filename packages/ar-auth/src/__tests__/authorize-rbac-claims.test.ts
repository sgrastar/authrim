/**
 * Implicit / hybrid issuance carries the same RBAC claims as the token endpoint: the tenant's
 * claim settings, the cache, and authrim_groups under the defaults.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  idClaims: vi.fn(),
  accessClaims: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  getTenantSettingsDocument: m.settings,
  getIDTokenRBACClaims: m.idClaims,
  getAccessTokenRBACClaims: m.accessClaims,
  createAuthContextFromHono: () => ({ coreAdapter: { metadata: true } }),
  createAccountAuthContextFromHono: () => ({ coreAdapter: { account: true } }),
}));

import { resolveDirectIssuanceRBACClaims } from '../authorize-rbac-claims';

const GROUPS = [{ id: 'g-1', key: 'staff', name: 'Staff', kind: 'static' }];
const KV = { kv: true };
const c = { env: { REBAC_CACHE: KV, RBAC_ID_TOKEN_CLAIMS: 'roles' } } as never;
const log = { error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  m.settings.mockResolvedValue({});
  m.idClaims.mockResolvedValue({ authrim_roles: ['member'], authrim_groups: GROUPS });
  m.accessClaims.mockResolvedValue({ authrim_groups: GROUPS });
});

describe('resolveDirectIssuanceRBACClaims', () => {
  it('computes the ID token claims, groups included, for response_type=id_token', async () => {
    const result = await resolveDirectIssuanceRBACClaims(
      c,
      't1',
      'user-1',
      { includesToken: false, includesIdToken: true },
      log
    );
    expect(result.idTokenRBACClaims.authrim_groups).toEqual(GROUPS);
    expect(result.accessTokenRBACClaims).toEqual({});
    expect(m.accessClaims).not.toHaveBeenCalled();
    expect(m.idClaims).toHaveBeenCalledWith(
      { metadata: { metadata: true }, account: { account: true } },
      'user-1',
      // No tenant setting: the environment's value, with the claims cache.
      expect.objectContaining({ cache: KV, claimsConfig: 'roles', tenantId: 't1' })
    );
  });

  it('prefers the tenant settings and computes the access token claims for token responses', async () => {
    m.settings.mockResolvedValue({
      'tokens.rbac_access_token_claims': 'roles,groups',
      'tokens.rbac_id_token_claims': 'groups',
    });
    const result = await resolveDirectIssuanceRBACClaims(
      c,
      't1',
      'user-1',
      { includesToken: true, includesIdToken: true },
      log
    );
    expect(result.accessTokenRBACClaims.authrim_groups).toEqual(GROUPS);
    expect(m.accessClaims).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ claimsConfig: 'roles,groups' })
    );
    expect(m.idClaims).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.objectContaining({ claimsConfig: 'groups' })
    );
  });

  it('never gives the access token a permission claim (no permission embedding runs here)', async () => {
    m.accessClaims.mockResolvedValue({
      authrim_roles: ['member'],
      authrim_permissions: ['reports:write'],
      authrim_scoped_permissions: [
        { permission: 'reports:read', scope_type: 'group', scope_target: 'g' },
      ],
    });
    const result = await resolveDirectIssuanceRBACClaims(
      c,
      't1',
      'user-1',
      { includesToken: true, includesIdToken: false },
      log
    );
    expect(result.accessTokenRBACClaims).toEqual({ authrim_roles: ['member'] });
  });

  it('issues without them when they cannot be read, and for a code-only response', async () => {
    m.idClaims.mockRejectedValue(new Error('db down'));
    const failed = await resolveDirectIssuanceRBACClaims(
      c,
      't1',
      'user-1',
      { includesToken: false, includesIdToken: true },
      log
    );
    expect(failed).toEqual({ accessTokenRBACClaims: {}, idTokenRBACClaims: {} });
    expect(log.error).toHaveBeenCalled();
    m.settings.mockClear();
    await resolveDirectIssuanceRBACClaims(
      c,
      't1',
      'user-1',
      { includesToken: false, includesIdToken: false },
      log
    );
    expect(m.settings).not.toHaveBeenCalled();
  });
});

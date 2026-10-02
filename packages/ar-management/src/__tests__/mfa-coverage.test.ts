import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveEffectiveSettings: vi.fn(),
  resolveStores: vi.fn(),
  ensureDatabaseAdapter: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveEffectiveSettings: mocks.resolveEffectiveSettings,
    resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.resolveStores,
    ensureDatabaseAdapter: mocks.ensureDatabaseAdapter,
  };
});

import { countAdminMfa, countUserMfa, readMfaEnforcement } from '../compliance/mfa-coverage';

describe('MFA coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts sign-in as requiring MFA only when assurance requires AAL2 somewhere', async () => {
    mocks.resolveEffectiveSettings.mockResolvedValueOnce({
      'assurance.enabled': true,
      'assurance.default_aal': 'AAL1',
      'assurance.scope_aal_requirements': JSON.stringify({
        payments: 'AAL2',
        admin: 'AAL3',
        read: 'AAL1',
      }),
    });
    expect(await readMfaEnforcement({} as never, 'tenant-a')).toEqual({
      enforced: true,
      assurance_enabled: true,
      default_aal: 'AAL1',
      scopes_requiring_mfa: ['admin', 'payments'],
    });

    mocks.resolveEffectiveSettings.mockResolvedValueOnce({
      'assurance.enabled': true,
      'assurance.default_aal': 'AAL2',
      'assurance.scope_aal_requirements': '{}',
    });
    expect((await readMfaEnforcement({} as never, 'tenant-a')).enforced).toBe(true);

    // Requirements saved while assurance is off are not enforced.
    mocks.resolveEffectiveSettings.mockResolvedValueOnce({
      'assurance.enabled': false,
      'assurance.default_aal': 'AAL2',
      'assurance.scope_aal_requirements': JSON.stringify({ payments: 'AAL2' }),
    });
    expect(await readMfaEnforcement({} as never, 'tenant-a')).toMatchObject({
      enforced: false,
      scopes_requiring_mfa: [],
    });
  });

  it('reads assurance fresh, not from the runtime cache', async () => {
    mocks.resolveEffectiveSettings.mockResolvedValueOnce({ 'assurance.enabled': false });
    await readMfaEnforcement({} as never, 'tenant-a');
    expect(mocks.resolveEffectiveSettings).toHaveBeenCalledWith(expect.anything(), 'assurance', {
      tenantId: 'tenant-a',
      fresh: true,
    });
  });

  it('counts admins the way admin sign-in grants them access to the tenant', async () => {
    const queryOne = vi.fn().mockResolvedValue({ admins: 4, with_passkey: 3 });
    expect(await countAdminMfa({ queryOne } as never, 'tenant-a', 1000)).toEqual({
      admins: 4,
      with_passkey: 3,
    });
    const [sql, params] = queryOne.mock.calls[0]!;
    // Only the roles admin sign-in accepts give access.
    expect(params).toEqual([
      'super_admin',
      'security_admin',
      'admin',
      'support',
      'viewer',
      'tenant-a',
      'tenant-a',
      1000,
    ]);
    expect(sql).toContain('r.name IN (?, ?, ?, ?, ?)');
    expect(sql).toContain('ra.tenant_id = u.tenant_id');
    expect(sql).toContain("ra.scope_type = 'global'");
    expect(sql).toContain('ra.scope_id IS NULL AND ra.tenant_id = ?');
    expect(sql).toContain('ra.expires_at IS NULL OR ra.expires_at > ?');
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain('FROM admin_passkeys');
    expect(sql).not.toContain('mfa_enabled');
  });

  it('sums users over every store the tenant has, by factor', async () => {
    mocks.resolveStores.mockResolvedValue([
      { source: {}, bindingRef: 'DB' },
      { source: {}, bindingRef: 'DB_SHARD_1' },
    ]);
    const queryOne = vi
      .fn()
      .mockResolvedValueOnce({
        users: 5,
        with_passkey: 3,
        with_totp: 1,
        with_any: 4,
        guests: 2,
        deleting: 1,
      })
      .mockResolvedValueOnce({
        users: 3,
        with_passkey: 0,
        with_totp: 2,
        with_any: 2,
        guests: null,
        deleting: null,
      });
    mocks.ensureDatabaseAdapter.mockReturnValue({ queryOne });

    expect(await countUserMfa({} as never, 'tenant-a', { routed: false })).toEqual({
      users: 8,
      with_passkey: 3,
      with_totp: 3,
      with_any: 6,
      guests: 2,
      deleting: 1,
    });
    expect(mocks.resolveStores).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ dataRole: expect.anything() })
    );
    const [sql, params] = queryOne.mock.calls[0]!;
    expect(params).toEqual(['tenant-a']);
    expect(sql).toContain("t.status = 'active'");
    expect(sql).toContain("a.account_type = 'user'");
    expect(sql).toContain("a.lifecycle_state IN ('active', 'deleting')");
  });

  it("reads a routed tenant's user stores only (its default store is not one of them)", async () => {
    mocks.resolveStores.mockResolvedValue([{ source: {}, bindingRef: 'DB_USERS_0' }]);
    mocks.ensureDatabaseAdapter.mockReturnValue({ queryOne: vi.fn().mockResolvedValue(null) });
    await countUserMfa({} as never, 'tenant-a', { routed: true });
    expect(mocks.resolveStores).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'tenant_core', dataRole: 'tenant_core/users', maxStores: 32 })
    );
  });
});

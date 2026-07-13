import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { AdminUserRepository } from '../admin/admin-user';

function db(): DatabaseAdapter {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => ({ success: true, rowsAffected: 1 })),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'admin-1',
    tenant_id: 'tenant-a',
    email: 'admin@example.com',
    email_verified: 0,
    name: 'Admin',
    password_hash: 'hash',
    is_active: 1,
    status: 'active',
    mfa_enabled: 0,
    mfa_method: null,
    totp_secret_encrypted: null,
    last_login_at: null,
    last_login_ip: null,
    failed_login_count: 0,
    locked_until: null,
    created_by: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('AdminUserRepository account security state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  it('creates default and MFA-enabled admins in an explicit tenant', async () => {
    const adapter = db();
    const repository = new AdminUserRepository(adapter);
    await expect(
      repository.createAdminUser({ tenant_id: 'tenant-a', email: 'admin@example.com' })
    ).resolves.toMatchObject({
      email_verified: false,
      name: null,
      password_hash: null,
      is_active: true,
      status: 'active',
      mfa_enabled: false,
      failed_login_count: 0,
    });
    await expect(
      repository.createAdminUser({
        id: 'admin-2',
        tenant_id: 'tenant-a',
        email: 'secure@example.com',
        name: 'Secure Admin',
        password: 'hash',
        mfa_enabled: true,
        mfa_method: 'totp',
        created_by: 'admin-1',
      })
    ).resolves.toMatchObject({ id: 'admin-2', mfa_enabled: true, mfa_method: 'totp' });
    await expect(
      repository.createAdminUser({ tenant_id: ' ', email: 'invalid@example.com' })
    ).rejects.toThrow('requires tenantId');
  });

  it('updates every mutable account field and returns null for missing users', async () => {
    const adapter = db();
    vi.mocked(adapter.queryOne)
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(
        row({
          email: 'updated@example.com',
          name: null,
          password_hash: 'new-hash',
          is_active: 0,
          status: 'suspended',
          mfa_enabled: 1,
          mfa_method: 'both',
          totp_secret_encrypted: 'secret',
        })
      )
      .mockResolvedValueOnce(null);
    const repository = new AdminUserRepository(adapter);
    await expect(
      repository.updateAdminUser('admin-1', {
        email: 'updated@example.com',
        name: null,
        password: 'new-hash',
        is_active: false,
        status: 'suspended',
        mfa_enabled: true,
        mfa_method: 'both',
        totp_secret_encrypted: 'secret',
      })
    ).resolves.toMatchObject({ email: 'updated@example.com', status: 'suspended' });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('email = ?'),
      expect.arrayContaining(['updated@example.com', 0, 'suspended', 1, 'both', 'secret'])
    );
    await expect(repository.updateAdminUser('missing', { name: 'No one' })).resolves.toBeNull();
  });

  it('returns the existing user for an empty update', async () => {
    const adapter = db();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce(row());
    await expect(
      new AdminUserRepository(adapter).updateAdminUser('admin-1', {})
    ).resolves.toMatchObject({
      id: 'admin-1',
    });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('normalizes email lookup and maps boolean database fields', async () => {
    const adapter = db();
    vi.mocked(adapter.queryOne)
      .mockResolvedValueOnce(row({ email_verified: 1, mfa_enabled: 1 }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ failed_login_count: null }));
    const repository = new AdminUserRepository(adapter);
    await expect(repository.findByEmail('tenant-a', 'ADMIN@EXAMPLE.COM')).resolves.toMatchObject({
      email_verified: true,
      mfa_enabled: true,
    });
    expect(adapter.queryOne).toHaveBeenNthCalledWith(1, expect.stringContaining('tenant_id = ?'), [
      'tenant-a',
      'admin@example.com',
    ]);
    await expect(repository.findByTenantAndId('tenant-a', 'missing')).resolves.toBeNull();
    await expect(repository.getAdminUser('admin-1')).resolves.toMatchObject({
      failed_login_count: 0,
    });
  });

  it('increments failed logins and locks exactly at the configured threshold', async () => {
    const adapter = db();
    vi.mocked(adapter.queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ failed_login_count: 1 })
      .mockResolvedValueOnce({ failed_login_count: 4 });
    const repository = new AdminUserRepository(adapter);
    await expect(repository.recordFailedLogin('missing')).resolves.toBe(0);
    await expect(repository.recordFailedLogin('admin-1', 5)).resolves.toBe(2);
    await expect(repository.recordFailedLogin('admin-1', 5, 60_000)).resolves.toBe(5);
    expect(vi.mocked(adapter.execute).mock.calls[0][0]).not.toContain('locked_until');
    expect(vi.mocked(adapter.execute).mock.calls[1][0]).toContain('locked_until');
    expect(vi.mocked(adapter.execute).mock.calls[1][1]).toEqual([
      5,
      Date.now() + 60_000,
      'locked',
      Date.now(),
      'admin-1',
    ]);
  });

  it.each([
    [null, false, false],
    [{ status: 'active', locked_until: null }, false, false],
    [{ status: 'locked', locked_until: 9_999_999_999_999 }, true, false],
    [{ status: 'locked', locked_until: 1 }, false, true],
  ])('evaluates lock state %#', async (state, locked, autoUnlock) => {
    const adapter = db();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce(state);
    const repository = new AdminUserRepository(adapter);
    await expect(repository.isAccountLocked('admin-1')).resolves.toBe(locked);
    expect(adapter.execute).toHaveBeenCalledTimes(autoUnlock ? 1 : 0);
  });

  it('maps update result booleans for login, lifecycle, verification, and MFA operations', async () => {
    const adapter = db();
    vi.mocked(adapter.execute)
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    const repository = new AdminUserRepository(adapter);
    await expect(repository.recordSuccessfulLogin('admin-1', '192.0.2.1')).resolves.toBe(true);
    await expect(repository.unlockAccount('missing')).resolves.toBe(false);
    await expect(repository.suspendAccount('admin-1')).resolves.toBe(true);
    await expect(repository.activateAccount('missing')).resolves.toBe(false);
    await expect(repository.setEmailVerified('admin-1')).resolves.toBe(true);
    await expect(repository.enableMFA('admin-1', 'totp', 'secret')).resolves.toBe(true);
    await expect(repository.enableMFA('missing', 'webauthn')).resolves.toBe(false);
    await expect(repository.disableMFA('admin-1')).resolves.toBe(true);
  });

  it('returns active admin counts and zero for missing rows', async () => {
    const adapter = db();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce(null);
    const repository = new AdminUserRepository(adapter);
    await expect(repository.getAdminCountByTenant('tenant-a')).resolves.toBe(2);
    await expect(repository.getAdminCountByTenant('tenant-b')).resolves.toBe(0);
  });
});

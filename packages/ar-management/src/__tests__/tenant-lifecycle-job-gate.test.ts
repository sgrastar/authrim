import { describe, expect, it } from 'vitest';
import { isAdminJobAllowedForTenantLifecycle } from '../admin-job-executor';

describe('tenant lifecycle admin job gate', () => {
  it('allows normal jobs only for active tenants', () => {
    expect(isAdminJobAllowedForTenantLifecycle('active', 'users/bulk-update')).toBe(true);
    expect(isAdminJobAllowedForTenantLifecycle('suspended', 'users/bulk-update')).toBe(false);
    expect(isAdminJobAllowedForTenantLifecycle('frozen', 'reports/generate')).toBe(false);
  });

  it('allows recovery validation from safe non-active states', () => {
    for (const state of ['suspended', 'frozen', 'restore_pending', 'restore_validating']) {
      expect(isAdminJobAllowedForTenantLifecycle(state, 'tenants/lifecycle-validation')).toBe(true);
    }
  });

  it('allows backup and validation jobs while suspended or frozen', () => {
    expect(isAdminJobAllowedForTenantLifecycle('suspended', 'tenant-database/export')).toBe(true);
    expect(isAdminJobAllowedForTenantLifecycle('frozen', 'tenant-database/restore-dry-run')).toBe(
      true
    );
  });

  it.each(['provisioning', 'deleting', 'deleted'])(
    'fails closed for terminal/internal state %s',
    (state) => {
      expect(isAdminJobAllowedForTenantLifecycle(state, 'users/bulk-update')).toBe(false);
    }
  );
});

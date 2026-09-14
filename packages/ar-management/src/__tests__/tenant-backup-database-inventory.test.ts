import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { resolveTenantBackupDatabaseInventory } from '../tenant-backup-database-inventory';
const mocks = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fixed: vi.fn<(...args: unknown[]) => unknown>(),
  assert: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));
vi.mock('@authrim/ar-lib-core', () => ({ requireDedicatedAdminDatabaseAdapter: () => ({}) }));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-request', () => ({
  TenantBackupRequestStore: class {
    loadForExecution(...args: unknown[]) {
      return mocks.request(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/execution-inventory', () => ({
  TenantBackupExecutionInventory: class {
    assertDatabaseResources(...args: unknown[]) {
      return mocks.assert(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/database-resources', () => ({
  resolveBackupTenantDatabaseResources: (...args: unknown[]) => mocks.resolve(...args),
  backupDatabaseResourceDescriptor: () => 'tenant-descriptor',
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources', () => ({
  resolveFixedBackupDatabaseResources: (...args: unknown[]) => mocks.fixed(...args),
  fixedBackupDatabaseResourceDescriptor: () => 'fixed-descriptor',
}));
const context = {
  lease: { tenantId: 'a' },
  signal: new AbortController().signal,
} as TenantBackupStepContext;
const env = {} as Env;
const required = { roles: ['tenant_core' as const], fixed: ['DB_ADMIN' as const] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.request.mockResolvedValue({});
  mocks.resolve.mockResolvedValue([{ databaseId: 'core-a' }]);
  mocks.fixed.mockReturnValue([{ binding: 'DB_ADMIN' }]);
});
it('re-resolves required stores and checks both complete descriptor sets before returning handles', async () => {
  expect(await resolveTenantBackupDatabaseInventory(env, context, required)).toEqual({
    tenant: [{ databaseId: 'core-a' }],
    fixed: [{ binding: 'DB_ADMIN' }],
  });
  expect(mocks.resolve).toHaveBeenCalledWith(env, {
    tenantId: 'a',
    roles: required.roles,
    signal: context.signal,
  });
  expect(mocks.assert).toHaveBeenCalledWith([
    { id: 'database:core-a', payload: 'tenant-descriptor' },
    { id: 'fixed-database:DB_ADMIN', payload: 'fixed-descriptor' },
  ]);
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it('rejects changed placement and a lease invalidated during resolution', async () => {
  mocks.assert.mockRejectedValueOnce(new Error('backup_resource_inventory_changed'));
  await expect(resolveTenantBackupDatabaseInventory(env, context, required)).rejects.toThrow(
    'inventory_changed'
  );
  mocks.request.mockReset().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('fenced'));
  await expect(resolveTenantBackupDatabaseInventory(env, context, required)).rejects.toThrow(
    'fenced'
  );
});

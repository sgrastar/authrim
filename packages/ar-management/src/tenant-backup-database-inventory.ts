import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import {
  resolveBackupTenantDatabaseResources,
  backupDatabaseResourceDescriptor,
} from '@authrim/ar-lib-core/services/tenant-portability/database-resources';
import {
  resolveFixedBackupDatabaseResources,
  fixedBackupDatabaseResourceDescriptor,
  type FixedBackupDatabaseBinding,
} from '@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources';
import { TenantBackupExecutionInventory } from '@authrim/ar-lib-core/services/tenant-portability/execution-inventory';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { TenantBackupRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';

export function tenantBackupDatabaseFamily(
  resource: Awaited<ReturnType<typeof resolveBackupTenantDatabaseResources>>[number]
): 'core' | 'pii' {
  const families = new Set(
    resource.assignments.map((assignment) => {
      if (assignment.role === 'tenant_core') return 'core' as const;
      if (assignment.role === 'tenant_pii') return 'pii' as const;
      throw new Error('backup_export_database_adapter_missing');
    })
  );
  if (families.size !== 1) throw new Error('backup_export_database_adapter_missing');
  const family = families.values().next().value;
  if (!family) throw new Error('backup_export_database_adapter_missing');
  return family;
}

/** Installed module planning supplies required roles; uploaded bundles cannot choose bindings. */
export async function resolveTenantBackupDatabaseInventory(
  env: Env,
  context: TenantBackupStepContext,
  required: {
    roles: Parameters<typeof resolveBackupTenantDatabaseResources>[1]['roles'];
    fixed: readonly FixedBackupDatabaseBinding[];
  },
  now: () => number = Date.now
) {
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const requests = new TenantBackupRequestStore(database);
  await requests.loadForExecution(context, now);
  const tenant = required.roles.length
    ? await resolveBackupTenantDatabaseResources(env, {
        tenantId: context.lease.tenantId,
        roles: required.roles,
        signal: context.signal,
      })
    : [];
  const fixed = required.fixed.length
    ? resolveFixedBackupDatabaseResources(env, required.fixed)
    : [];
  context.signal.throwIfAborted();
  const inventory = new TenantBackupExecutionInventory(database, context.lease, now);
  await inventory.assertDatabaseResources([
    ...tenant.map((resource) => ({
      id: `database:${resource.databaseId}`,
      payload: backupDatabaseResourceDescriptor(resource),
    })),
    ...fixed.map((resource) => ({
      id: `fixed-database:${resource.binding}`,
      payload: fixedBackupDatabaseResourceDescriptor(resource),
    })),
  ]);
  await requests.loadForExecution(context, now);
  context.signal.throwIfAborted();
  return { tenant, fixed };
}

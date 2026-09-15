import {
  ensureDatabaseAdapter,
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { resolveBackupTenantDatabaseResources } from '@authrim/ar-lib-core/services/tenant-portability/database-resources';
import { resolveFixedBackupDatabaseResources } from '@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources';
import {
  phase8SqliteRestoreTargetRole,
  type Phase8ValidatedSqliteRestoreDataset,
  type Phase8SqliteRestoreTargetRole,
} from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-targets';
import { readScopedSqliteRestoreSeedFingerprint } from '@authrim/ar-lib-core/services/tenant-portability/scoped-restore-seed';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { TenantBackupSqliteRestorePlanTarget } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-plan-step';

interface TargetResource {
  resourceId: string;
  provisioningId: string;
  database: DatabaseAdapter;
}

function invalid(): never {
  throw new Error('backup_production_restore_target_invalid');
}

function recordedSeedFingerprint(
  value: unknown,
  expected: { targetId: string; resourceId: string; provisioningId: string }
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
      'kind,provisioningId,resourceId,seedFingerprint,targetId,version' ||
    row.version !== 1 ||
    row.kind !== 'sqlite-restore-target' ||
    row.targetId !== expected.targetId ||
    row.resourceId !== expected.resourceId ||
    row.provisioningId !== expected.provisioningId ||
    typeof row.seedFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.seedFingerprint)
  )
    invalid();
  return row.seedFingerprint;
}

/** Resolve setup-provisioned bindings while the tenant is still unavailable to public runtime. */
export function createProductionTenantBackupRestoreTargets(input: { env: Env; tenantKey: string }) {
  const { env, tenantKey } = input;
  const platform = ensureDatabaseAdapter(env.DB, 'tenant-backup-restore-platform');
  const admin = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const resolve = async (context: TenantBackupStepContext) => {
    const resources = await resolveBackupTenantDatabaseResources(env, {
      tenantId: context.lease.tenantId,
      roles: ['tenant_core', 'tenant_pii'],
      signal: context.signal,
    });
    const fixed = resolveFixedBackupDatabaseResources(env, ['DB_ADMIN'])[0] ?? invalid();
    const byRole = new Map<Phase8SqliteRestoreTargetRole, TargetResource>();
    byRole.set('admin', {
      resourceId: fixed.databaseId,
      provisioningId: `setup:admin:${fixed.databaseId}`,
      database: fixed.database,
    });
    for (const resource of resources) {
      for (const assignment of resource.assignments) {
        const role = assignment.dataRole as Phase8SqliteRestoreTargetRole;
        if (!['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(role)) continue;
        if (byRole.has(role)) invalid();
        byRole.set(role, {
          resourceId: resource.databaseId,
          provisioningId: `setup:${assignment.assignmentGeneration}:${resource.databaseId}`,
          database: resource.database,
        });
      }
    }
    return byRole;
  };
  const assertUnpublished = async (context: TenantBackupStepContext) => {
    context.signal.throwIfAborted();
    const platformTenant = await platform.queryOne<{ lifecycle_state: string }>(
      'SELECT lifecycle_state FROM tenants WHERE id=?',
      [context.lease.tenantId]
    );
    if (platformTenant?.lifecycle_state !== 'provisioning') invalid();
    const targets = await resolve(context);
    const core = targets.get('tenant_core/default') ?? invalid();
    const tenant = await core.database.queryOne<{ lifecycle_state: string }>(
      'SELECT lifecycle_state FROM tenants WHERE id=?',
      [context.lease.tenantId]
    );
    if (tenant && tenant.lifecycle_state !== 'provisioning') invalid();
    context.signal.throwIfAborted();
  };
  const plan = async (
    context: TenantBackupStepContext,
    datasets: readonly Phase8ValidatedSqliteRestoreDataset[]
  ): Promise<readonly TenantBackupSqliteRestorePlanTarget[]> => {
    await assertUnpublished(context);
    const resources = await resolve(context);
    const grouped = new Map<
      string,
      {
        resource: TargetResource;
        roles: Phase8SqliteRestoreTargetRole[];
        datasets: Phase8ValidatedSqliteRestoreDataset[];
      }
    >();
    for (const dataset of datasets) {
      const role = phase8SqliteRestoreTargetRole(dataset.policy.dataset);
      const resource = resources.get(role) ?? invalid();
      const current = grouped.get(resource.resourceId) ?? { resource, roles: [], datasets: [] };
      if (!current.roles.includes(role)) current.roles.push(role);
      current.datasets.push(dataset);
      grouped.set(resource.resourceId, current);
    }
    return [...grouped.values()].map(({ resource, roles, datasets: targetDatasets }) => {
      const targetId = `${context.lease.operationId}:${resource.resourceId}`;
      const initialized = () => ({
        targetId,
        ...resource,
        ...(roles.includes('admin')
          ? {
              readSeedFingerprint: (admission: () => Promise<void>) =>
                readScopedSqliteRestoreSeedFingerprint({
                  database: resource.database,
                  policies: targetDatasets.map(({ policy }) => policy),
                  tenantId: context.lease.tenantId,
                  tenantKey,
                  assertAdmission: admission,
                }),
            }
          : {}),
      });
      return {
        targetId,
        resourceId: resource.resourceId,
        provisioningId: resource.provisioningId,
        datasets: targetDatasets,
        initialize: async () => initialized(),
        assertProvisioningOwnership: () => assertUnpublished(context),
      };
    });
  };
  return {
    admin,
    platform,
    plan,
    assertUnpublished,
    async resolveTarget(
      context: TenantBackupStepContext,
      resourceId: string,
      provisioningId: string
    ) {
      const resources = await resolve(context);
      const matches = [...resources.values()].filter(
        (resource) =>
          resource.resourceId === resourceId && resource.provisioningId === provisioningId
      );
      if (matches.length !== 1) invalid();
      const resource = matches[0];
      const targetId = `${context.lease.operationId}:${resourceId}`;
      const adminResource = resources.get('admin');
      return {
        targetId,
        ...resource,
        ...(adminResource?.resourceId === resourceId
          ? {
              readSeedFingerprint: async (admission: () => Promise<void>) => {
                await admission();
                const rows = await admin.query<{ payload_json: string }>(
                  `SELECT i.payload_json FROM tenant_backup_restore_plan_items i
                   JOIN tenant_backup_restore_plan_inventories h
                     ON h.operation_id=i.operation_id AND h.tenant_id=i.tenant_id
                   WHERE i.operation_id=? AND i.tenant_id=? AND h.state='sealed'
                     AND i.item_id=?`,
                  [context.lease.operationId, context.lease.tenantId, `restore-target:${targetId}`]
                );
                if (rows.length !== 1) invalid();
                const seedFingerprint = recordedSeedFingerprint(JSON.parse(rows[0].payload_json), {
                  targetId,
                  resourceId,
                  provisioningId,
                });
                await admission();
                return seedFingerprint;
              },
            }
          : {}),
      };
    },
    async databaseForRole(context: TenantBackupStepContext, role: Phase8SqliteRestoreTargetRole) {
      return (await resolve(context)).get(role)?.database ?? invalid();
    },
  };
}

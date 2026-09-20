import {
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  resolveBackupTenantDatabaseResources,
  type BackupDatabaseResource,
} from '@authrim/ar-lib-core/services/tenant-portability/database-resources';
import { resolveFixedBackupDatabaseResources } from '@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import { TenantBackupRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { planSqliteTenantDatasets } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-plan';
import { readBackupSqliteDatabaseSchema } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-schema-reader';
import { tenantBackupDatabaseFamily } from './tenant-backup-database-inventory';

type Family = 'core' | 'pii' | 'admin';

export interface Phase8SqlitePlanResource {
  resourceId: string;
  family: Family;
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
}

const allSelection = {
  settings: true,
  users: true,
  admin: true,
  artifacts: true,
  logs: { audit: true, other: true, sensitive: true, period: 'all' as const },
};

function invalid(): never {
  throw new Error('backup_phase8_installed_plan_invalid');
}

/** Build every installed policy from complete live schemas; no bundle can supply this metadata. */
export async function planPhase8InstalledSqliteResources(
  resources: readonly Phase8SqlitePlanResource[],
  signal: AbortSignal
): Promise<PlannedInstalledSqliteDataset[]> {
  signal.throwIfAborted();
  if (
    resources.length < 3 ||
    resources.length > 129 ||
    new Set(resources.map(({ resourceId }) => resourceId)).size !== resources.length ||
    !(['core', 'pii', 'admin'] as const).every((family) =>
      resources.some((resource) => resource.family === family)
    ) ||
    resources.filter(({ family }) => family === 'admin').length !== 1 ||
    resources.some(({ resourceId }) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(resourceId))
  )
    invalid();
  const orderedResources = [...resources].sort((left, right) =>
    left.resourceId.localeCompare(right.resourceId)
  );
  const resourcePlans: Array<
    ReturnType<typeof planSqliteTenantDatasets> & {
      resourceId: string;
      family: Family;
      firstOrdinal: number;
    }
  > = await Promise.all(
    orderedResources.map(async (resource, firstOrdinal) => {
      const tables = await readBackupSqliteDatabaseSchema(
        resource.database,
        resource.family,
        signal
      );
      const plan = planSqliteTenantDatasets(resource.family, tables, allSelection);
      return {
        ...plan,
        resourceId: resource.resourceId,
        family: resource.family,
        firstOrdinal,
      };
    })
  );
  const planned = PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(
    (registration, ordinal): PlannedInstalledSqliteDataset => {
      const family = registration.family as Family;
      const partitions = registration.partitions ?? [];
      const matches = resourcePlans
        .filter((plan) => plan.family === family)
        .flatMap((plan) => {
          const entry = plan.entries.find(({ table }) => table === registration.table);
          return entry?.capture ? [{ plan, entry }] : [];
        });
      const canonical = matches[0] ?? invalid();
      if (matches.length !== resourcePlans.filter((plan) => plan.family === family).length)
        invalid();
      const canonicalCapture = canonical.entry.capture ?? invalid();
      for (const { entry } of matches)
        if (
          !entry.capture ||
          JSON.stringify(entry.capture) !== JSON.stringify(canonicalCapture) ||
          (partitions.length
            ? partitions.some((partition) => {
                const plannedPartition = entry.rowPartitions?.find(
                  ({ value }) => value === partition
                );
                return plannedPartition?.kind !== registration.dataset.kind;
              })
            : entry.kind !== registration.dataset.kind)
        )
          invalid();
      return {
        ordinal,
        firstOrdinal: canonical.plan.firstOrdinal,
        resourceId: canonical.plan.resourceId,
        family,
        table: registration.table,
        capture: canonicalCapture,
        dataset: registration.dataset,
        ...(registration.partitions ? { partitions: registration.partitions } : {}),
        sources: matches.map(({ plan }) => ({
          ordinal,
          firstOrdinal: plan.firstOrdinal,
          resourceId: plan.resourceId,
        })),
      };
    }
  );
  signal.throwIfAborted();
  return planned;
}

function tenantResource(resource: BackupDatabaseResource): Phase8SqlitePlanResource {
  return {
    resourceId: resource.databaseId,
    family: tenantBackupDatabaseFamily(resource),
    database: resource.database,
  };
}

/** Resolve the target deployment inventory again on every import-policy load. */
export async function loadPhase8InstalledSqlitePlan(
  env: Env,
  context: TenantBackupStepContext,
  now: () => number = Date.now
): Promise<PlannedInstalledSqliteDataset[]> {
  const admin = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const requests = new TenantBackupRequestStore(admin);
  await requests.loadForExecution(context, now);
  const tenant = await resolveBackupTenantDatabaseResources(env, {
    tenantId: context.lease.tenantId,
    roles: ['tenant_core', 'tenant_pii'],
    signal: context.signal,
  });
  const fixed = resolveFixedBackupDatabaseResources(env, ['DB_ADMIN']);
  const planned = await planPhase8InstalledSqliteResources(
    [
      ...tenant.map(tenantResource),
      ...fixed.map((resource) => ({
        resourceId: resource.databaseId,
        family: resource.family as 'admin',
        database: resource.database,
      })),
    ],
    context.signal
  );
  await requests.loadForExecution(context, now);
  context.signal.throwIfAborted();
  return planned;
}

import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { TenantBackupInstalledImportAdapter } from './tenant-backup-import-dispatcher';
import { tenantDatasetSelectionRule } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';

type ResolveArgs = Parameters<TenantBackupInstalledImportAdapter['resolveRestoreTarget']>;
type LoadArgs = Parameters<TenantBackupInstalledImportAdapter['loadValidatedDataset']>;
type GuardArgs = Parameters<TenantBackupInstalledImportAdapter['assertValidatedUnpublishedPlan']>;

export interface TenantBackupInstalledSqliteImportPorts {
  assertSources(context: TenantBackupStepContext): Promise<void>;
  restoreTargets: TenantBackupInstalledImportAdapter['restoreTargets'];
  resolveRestoreTarget(
    context: ResolveArgs[0],
    resourceId: ResolveArgs[1],
    provisioningId: ResolveArgs[2]
  ): ReturnType<TenantBackupInstalledImportAdapter['resolveRestoreTarget']>;
  loadValidatedDataset(
    context: LoadArgs[0],
    job: LoadArgs[1]
  ): ReturnType<TenantBackupInstalledImportAdapter['loadValidatedDataset']>;
  assertValidatedUnpublishedPlan(
    context: GuardArgs[0],
    digest: GuardArgs[1]
  ): ReturnType<TenantBackupInstalledImportAdapter['assertValidatedUnpublishedPlan']>;
  restoreOtherStores: TenantBackupInstalledImportAdapter['restoreOtherStores'];
  verifyOtherStores: TenantBackupInstalledImportAdapter['verifyOtherStores'];
  prepareActivation: TenantBackupInstalledImportAdapter['prepareActivation'];
  activate: TenantBackupInstalledImportAdapter['activate'];
  verifyActivation: TenantBackupInstalledImportAdapter['verifyActivation'];
}

function clonePolicy(policy: SqliteDatasetInspectionPolicy): SqliteDatasetInspectionPolicy {
  return {
    ...structuredClone({ ...policy, inspectRow: undefined }),
    inspectRow: policy.inspectRow,
  };
}

/**
 * SQL-only installed module adapter. Uploaded metadata can select an installed dataset, but cannot
 * provide its schema, row inspector, source reader, target, or activation callbacks.
 */
export function createTenantBackupInstalledSqliteImportAdapter(input: {
  policies: readonly SqliteDatasetInspectionPolicy[];
  ports: TenantBackupInstalledSqliteImportPorts;
}): TenantBackupInstalledImportAdapter {
  if (
    !input.policies.length ||
    input.policies.length > 256 ||
    new Set(input.policies.map((policy) => policy.dataset.id)).size !== input.policies.length ||
    input.policies.some(
      (policy) =>
        policy.dataset.store !== 'database' ||
        policy.dataset.disposition !== 'include' ||
        policy.dataset.schemaVersion !== 1 ||
        policy.schema.table.length === 0 ||
        (policy.schema.rowPartition
          ? !policy.partitions?.length ||
            policy.partitions.some(
              (partition) => !policy.schema.rowPartition?.values.includes(partition)
            )
          : policy.partitions !== undefined)
    )
  )
    throw new Error('backup_sqlite_import_adapter_invalid');
  const byTable = new Map<string, typeof input.policies>();
  for (const policy of input.policies)
    byTable.set(policy.schema.table, [...(byTable.get(policy.schema.table) ?? []), policy]);
  for (const group of byTable.values()) {
    const schemas = new Set(group.map((policy) => JSON.stringify(policy.schema)));
    const partitions = group.flatMap((policy) => policy.partitions ?? []);
    if (
      schemas.size !== 1 ||
      (group.length > 1 &&
        (group.some((policy) => !policy.partitions?.length) ||
          new Set(partitions).size !== partitions.length))
    )
      throw new Error('backup_sqlite_import_adapter_invalid');
  }
  const policies = input.policies.map(clonePolicy);
  return {
    datasets(selection) {
      const selected = policies
        .filter((policy) => {
          const rule = tenantDatasetSelectionRule(policy.dataset.kind, selection);
          return rule.action === 'selected' || rule.action === 'resolve_references';
        })
        .map((policy) => structuredClone(policy.dataset));
      if (!selected.length) throw new Error('backup_sqlite_import_adapter_dataset');
      return selected;
    },
    async loadPolicy(context, datasetId) {
      await input.ports.assertSources(context);
      const policy = policies.find((candidate) => candidate.dataset.id === datasetId);
      if (!policy) throw new Error('backup_sqlite_import_adapter_dataset');
      return clonePolicy(policy);
    },
    assertSources: (context) => input.ports.assertSources(context),
    restoreTargets: (context) => input.ports.restoreTargets(context),
    resolveRestoreTarget: (context, resourceId, provisioningId) =>
      input.ports.resolveRestoreTarget(context, resourceId, provisioningId),
    loadValidatedDataset: (context, job) => input.ports.loadValidatedDataset(context, job),
    assertValidatedUnpublishedPlan: (context, digest) =>
      input.ports.assertValidatedUnpublishedPlan(context, digest),
    restoreOtherStores: (context, digest, cursor) =>
      input.ports.restoreOtherStores(context, digest, cursor),
    verifyOtherStores: (context, digest, cursor) =>
      input.ports.verifyOtherStores(context, digest, cursor),
    prepareActivation: (context, digest) => input.ports.prepareActivation(context, digest),
    activate: (context, digest) => input.ports.activate(context, digest),
    verifyActivation: (context, digest) => input.ports.verifyActivation(context, digest),
  };
}

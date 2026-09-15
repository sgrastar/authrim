import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { TENANT_BACKUP_MAX_SQLITE_DATASETS } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import {
  cloneSqliteDatasetInspectionPolicy,
  type SqliteDatasetInspectionPolicy,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { TenantBackupInstalledImportAdapter } from './tenant-backup-import-dispatcher';
import { tenantDatasetSelectionRule } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';

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
  previewRestore?: TenantBackupInstalledImportAdapter['previewRestore'];
  assertRestoreApproval?: TenantBackupInstalledImportAdapter['assertRestoreApproval'];
  prepareActivation: TenantBackupInstalledImportAdapter['prepareActivation'];
  activate: TenantBackupInstalledImportAdapter['activate'];
  verifyActivation: TenantBackupInstalledImportAdapter['verifyActivation'];
}

/**
 * SQL-only installed module adapter. Uploaded metadata can select an installed dataset, but cannot
 * provide its schema, row inspector, source reader, target, or activation callbacks.
 */
type StaticPolicyInput = {
  policies: readonly SqliteDatasetInspectionPolicy[];
  datasets?: never;
  loadPolicies?: never;
};

type DynamicPolicyInput = {
  policies?: never;
  datasets: readonly TenantPortableDataset[];
  /** Resolve the complete installed policy set from the operation's pinned physical inventory. */
  loadPolicies(context: TenantBackupStepContext): Promise<readonly SqliteDatasetInspectionPolicy[]>;
};

function validatePolicies(
  policies: readonly SqliteDatasetInspectionPolicy[],
  expectedDatasets?: readonly TenantPortableDataset[]
): void {
  if (
    !policies.length ||
    policies.length > TENANT_BACKUP_MAX_SQLITE_DATASETS ||
    new Set(policies.map((policy) => policy.dataset.id)).size !== policies.length ||
    policies.some(
      (policy) =>
        !['database', 'kv', 'durable_object', 'object'].includes(policy.dataset.store) ||
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
  if (expectedDatasets) {
    const expected = new Map(expectedDatasets.map((dataset) => [dataset.id, dataset]));
    if (
      expected.size !== expectedDatasets.length ||
      policies.length !== expected.size ||
      policies.some((policy) => {
        const dataset = expected.get(policy.dataset.id);
        return !dataset || JSON.stringify(policy.dataset) !== JSON.stringify(dataset);
      })
    )
      throw new Error('backup_sqlite_import_adapter_invalid');
  }
  const byTable = new Map<string, SqliteDatasetInspectionPolicy[]>();
  for (const policy of policies.filter((candidate) => candidate.dataset.store === 'database')) {
    const family = policy.dataset.id.split('.')[0];
    if (!family || !['core', 'pii', 'admin', 'control', 'lookup', 'plugin_runner'].includes(family))
      throw new Error('backup_sqlite_import_adapter_invalid');
    const key = `${family}:${policy.schema.table}`;
    byTable.set(key, [...(byTable.get(key) ?? []), policy]);
  }
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
}

export function createTenantBackupInstalledSqliteImportAdapter(
  input: (StaticPolicyInput | DynamicPolicyInput) & {
    ports: TenantBackupInstalledSqliteImportPorts;
  }
): TenantBackupInstalledImportAdapter {
  const staticPolicies = input.policies
    ? input.policies.map(cloneSqliteDatasetInspectionPolicy)
    : null;
  if (staticPolicies) validatePolicies(staticPolicies);
  const installedDatasets = (
    staticPolicies?.map((policy) => policy.dataset) ??
    input.datasets ??
    []
  ).map((dataset) => structuredClone(dataset));
  if (
    !installedDatasets.length ||
    installedDatasets.length > TENANT_BACKUP_MAX_SQLITE_DATASETS ||
    new Set(installedDatasets.map((dataset) => dataset.id)).size !== installedDatasets.length
  )
    throw new Error('backup_sqlite_import_adapter_invalid');
  const loadPolicies = async (context: TenantBackupStepContext) => {
    if (staticPolicies) return staticPolicies;
    const loaded = (await input.loadPolicies?.(context)) ?? [];
    validatePolicies(loaded, installedDatasets);
    return loaded.map(cloneSqliteDatasetInspectionPolicy);
  };
  const adapter: TenantBackupInstalledImportAdapter = {
    datasets(selection) {
      const selected = installedDatasets
        .filter((dataset) => {
          const rule = tenantDatasetSelectionRule(dataset.kind, selection);
          return rule.action === 'selected' || rule.action === 'resolve_references';
        })
        .map((dataset) => structuredClone(dataset));
      if (!selected.length) throw new Error('backup_sqlite_import_adapter_dataset');
      return selected;
    },
    async loadPolicy(context, datasetId) {
      await input.ports.assertSources(context);
      const policies = await loadPolicies(context);
      const policy = policies.find((candidate) => candidate.dataset.id === datasetId);
      if (!policy) throw new Error('backup_sqlite_import_adapter_dataset');
      return cloneSqliteDatasetInspectionPolicy(policy);
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
  if (input.ports.previewRestore) adapter.previewRestore = input.ports.previewRestore;
  if (input.ports.assertRestoreApproval)
    adapter.assertRestoreApproval = input.ports.assertRestoreApproval;
  return adapter;
}

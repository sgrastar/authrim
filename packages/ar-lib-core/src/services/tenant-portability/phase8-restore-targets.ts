import type { TenantBundleManifest } from './bundle-manifest.js';
import type { TenantPortableDataset } from './module-contract.js';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector.js';

export const PHASE8_SQLITE_RESTORE_TARGET_ROLES = [
  'admin',
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
] as const;

export type Phase8SqliteRestoreTargetRole = (typeof PHASE8_SQLITE_RESTORE_TARGET_ROLES)[number];

export interface Phase8ValidatedSqliteRestoreDataset {
  manifest: TenantBundleManifest;
  policy: SqliteDatasetInspectionPolicy;
  recordCount: number;
  byteCount: number;
}

function invalid(): never {
  throw new Error('backup_phase8_restore_target_invalid');
}

function sameDataset(left: TenantPortableDataset, right: TenantPortableDataset): boolean {
  return (
    left.id === right.id &&
    left.module === right.module &&
    left.kind === right.kind &&
    left.store === right.store &&
    left.schemaVersion === right.schemaVersion &&
    left.disposition === right.disposition
  );
}

/**
 * Map one logical SQL dataset to its target database role. Core user rows are kept on the users
 * shard; every other Core partition belongs to the default shard. Physical source shard identity
 * never controls the target placement.
 */
export function phase8SqliteRestoreTargetRole(
  dataset: TenantPortableDataset
): Phase8SqliteRestoreTargetRole {
  if (dataset.store !== 'database' || dataset.disposition !== 'include') invalid();
  const family = dataset.id.split('.')[0];
  if (family === 'admin') return 'admin';
  if (family === 'pii') return 'tenant_pii';
  if (family === 'core')
    return dataset.kind === 'users' ? 'tenant_core/users' : 'tenant_core/default';
  return invalid();
}

/** Validate the manifest/policy pair and reject ambiguous duplicate ownership across inputs. */
export function groupPhase8SqliteRestoreDatasets(
  datasets: readonly Phase8ValidatedSqliteRestoreDataset[]
): ReadonlyMap<Phase8SqliteRestoreTargetRole, readonly Phase8ValidatedSqliteRestoreDataset[]> {
  if (!datasets.length || datasets.length > 4096) invalid();
  const grouped = new Map<Phase8SqliteRestoreTargetRole, Phase8ValidatedSqliteRestoreDataset[]>();
  const seen = new Set<string>();
  for (const entry of datasets) {
    const dataset = entry.policy.dataset;
    const manifestDataset = entry.manifest.datasets.find(({ id }) => id === dataset.id);
    if (!manifestDataset || !sameDataset(manifestDataset, dataset) || seen.has(dataset.id))
      invalid();
    seen.add(dataset.id);
    const role = phase8SqliteRestoreTargetRole(dataset);
    grouped.set(role, [...(grouped.get(role) ?? []), entry]);
  }
  return new Map(
    PHASE8_SQLITE_RESTORE_TARGET_ROLES.flatMap((role) => {
      const entries = grouped.get(role);
      return entries?.length ? [[role, Object.freeze([...entries])] as const] : [];
    })
  );
}

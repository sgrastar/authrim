import type { InstalledSqliteDatasetRegistration } from './installed-sqlite-datasets.js';
import type { TenantPortabilityModuleId } from './module-contract.js';
import { TENANT_DATASET_POLICIES, type TenantDatasetKind } from './dataset-registry.js';
import { PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from './phase5-sqlite-modules.js';

type Phase8Kind = Extract<
  TenantDatasetKind,
  | 'users'
  | 'admin'
  | 'audit'
  | 'history'
  | 'sensitive_logs'
  | 'delivery_state'
  | 'log_dependencies'
  | 'artifacts'
>;

/**
 * Phase 8 adds tenant-owned operational data. Rebuild, external, ephemeral and tenant-state
 * policies deliberately stay outside this SQL registry and require their dedicated adapters.
 */
export const PHASE8_SQLITE_KINDS: readonly Phase8Kind[] = [
  'users',
  'admin',
  'audit',
  'history',
  'sensitive_logs',
  'delivery_state',
  'log_dependencies',
  'artifacts',
] as const;

function moduleForKind(kind: Phase8Kind): TenantPortabilityModuleId {
  if (kind === 'users') return 'users';
  if (kind === 'admin' || kind === 'delivery_state') return 'admin';
  if (kind === 'artifacts') return 'artifacts';
  return 'logs';
}

const phase5Tables = new Set(
  PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(({ family, table }) => `${family}:${table}`)
);

const userResourcePermissions = {
  family: 'core',
  table: 'resource_permissions',
  dataset: {
    id: 'core.resource_permissions.users',
    module: 'users',
    kind: 'users',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  },
  partitions: ['user'],
} as const satisfies InstalledSqliteDatasetRegistration;

/**
 * Complete Phase 8 SQL dataset set derived from the reviewed, exhaustive table classifier.
 * The registry digest is pinned by tests so a newly classified table still requires review.
 */
export const PHASE8_SQLITE_DATASET_REGISTRATIONS: readonly InstalledSqliteDatasetRegistration[] = [
  ...TENANT_DATASET_POLICIES.filter(
    (policy): policy is typeof policy & { kind: Phase8Kind } =>
      (PHASE8_SQLITE_KINDS as readonly TenantDatasetKind[]).includes(policy.kind) &&
      // Plugin Runner owns its database and exposes a bounded service snapshot. Management must
      // not receive the physical binding merely to implement tenant portability.
      policy.family !== 'plugin_runner' &&
      !phase5Tables.has(`${policy.family}:${policy.table}`)
  ).map(({ family, table, kind }) => ({
    family,
    table,
    dataset: {
      id: `${family}.${table}`,
      module: moduleForKind(kind),
      kind,
      store: 'database' as const,
      schemaVersion: 1,
      disposition: 'include' as const,
    },
  })),
  // resource_permissions is one physical table with independently selected settings and user rows.
  userResourcePermissions,
].sort((left, right) => left.dataset.id.localeCompare(right.dataset.id));

export const PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS = [
  ...PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  ...PHASE8_SQLITE_DATASET_REGISTRATIONS,
] as const;

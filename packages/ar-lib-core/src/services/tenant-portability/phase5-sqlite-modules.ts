import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract.js';
import type { InstalledSqliteDatasetRegistration } from './installed-sqlite-datasets.js';
import type { TenantPortabilityModuleId } from './module-contract.js';
import { PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from './phase4-sqlite-modules.js';

type Phase5Module = Extract<
  TenantPortabilityModuleId,
  'authorization' | 'credentials' | 'flows-ui' | 'integrations'
>;

interface Phase5TableGroup {
  family: Extract<MigrationSchemaFamily, 'core' | 'admin'>;
  module: Phase5Module;
  tables: readonly string[];
}

/**
 * Remaining tenant settings stored in the Core and Admin databases. Physical placement,
 * caches, plugin-runner state and object bodies use explicit Phase 5 record contracts.
 */
export const PHASE5_SQLITE_TABLE_GROUPS: readonly Phase5TableGroup[] = [
  {
    family: 'core',
    module: 'flows-ui',
    tables: ['branding_settings', 'flow_assignments', 'flow_versions', 'flows', 'screens'],
  },
  {
    family: 'core',
    module: 'credentials',
    // profile_registry is shared installed configuration without tenant-owned rows. Tenant
    // settings retain its logical ID and the target resolves that prerequisite separately.
    tables: ['status_lists'],
  },
  {
    family: 'core',
    module: 'integrations',
    tables: [
      'internal_notification_delivery_routes',
      'logging_quota_policies',
      'lookup_retention_policies',
      'webhook_configs',
    ],
  },
  {
    family: 'admin',
    module: 'authorization',
    tables: [
      'admin_ip_allowlist',
      'admin_policies',
      'admin_rebac_definitions',
      'admin_roles',
      'agent_baseline_assignments',
      'agent_baseline_exceptions',
      'agent_baselines',
      'agent_configuration_templates',
      'agent_scope_policies',
      'agent_scope_policy_versions',
      'agent_secret_refs',
      'agent_task_set_versions',
      'agent_task_sets',
      'agent_template_copies',
    ],
  },
  {
    family: 'admin',
    module: 'integrations',
    tables: [
      'admin_destination_capabilities',
      'admin_destinations',
      'admin_logging_critical_policies',
      'admin_logging_sensitive_detail_policies',
      'credential_secret_bodies',
      'credential_secret_metadata',
      'internal_notification_delivery_routes',
      'logging_destination_overrides',
      'logging_fallback_policies',
      'logging_key_material_bodies',
      'logging_key_registry',
      'logging_key_versions',
      'logging_policy_snapshots',
      'logging_quota_policies',
      'storage_destination_assignments',
    ],
  },
];

export const PHASE5_SQLITE_DATASET_REGISTRATIONS: readonly InstalledSqliteDatasetRegistration[] =
  PHASE5_SQLITE_TABLE_GROUPS.flatMap(({ family, module, tables }) =>
    tables.map((table) => ({
      family,
      table,
      dataset: {
        id: `${family}.${table}`,
        module,
        kind: 'settings' as const,
        store: 'database' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
    }))
  );

const tenantRuntimeCacheGenerations = {
  family: 'admin',
  table: 'tenant_runtime_cache_generations',
  dataset: {
    id: 'admin.tenant_runtime_cache_generations',
    module: 'authorization',
    kind: 'tenant_state',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  },
  partitions: undefined,
} as const satisfies InstalledSqliteDatasetRegistration;

/** Tables whose source rows are deliberately regenerated from restored authoritative state. */
export const PHASE5_REBUILT_TABLES = [
  'lookup_directory_job_cursors',
  'lookup_identifiers',
  'lookup_schema_metadata',
  'lookup_tenant_aliases',
] as const;

export const PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS = [
  ...PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  ...PHASE5_SQLITE_DATASET_REGISTRATIONS,
  tenantRuntimeCacheGenerations,
] as const;

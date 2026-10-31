import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract.js';
import type { InstalledSqliteDatasetRegistration } from './installed-sqlite-datasets.js';
import type { TenantPortabilityModuleId } from './module-contract.js';
import { PHASE3_SQLITE_DATASET_REGISTRATIONS } from './phase3-sqlite-modules.js';

type Phase4Module = Extract<TenantPortabilityModuleId, 'federation' | 'credentials'>;

interface Phase4TableGroup {
  family: MigrationSchemaFamily;
  module: Phase4Module;
  tables: readonly string[];
}

/**
 * Phase 4 SQL settings needed to recover protocol, federation, credential and directory
 * configuration. Runtime observations and per-user directory state remain outside this registry.
 */
export const PHASE4_SQLITE_TABLE_GROUPS: readonly Phase4TableGroup[] = [
  {
    family: 'core',
    module: 'federation',
    tables: [
      'directory_auth_retention_policies',
      'directory_auth_tenant_policies',
      'directory_connector_instances',
      'identity_providers',
      'saml_attribute_presets',
      'upstream_providers',
    ],
  },
  {
    family: 'core',
    module: 'credentials',
    tables: ['credential_configurations', 'presentation_definitions', 'trusted_issuers'],
  },
  {
    family: 'admin',
    module: 'federation',
    tables: [
      'federation_entity_statements',
      'federation_metadata_documents',
      'federation_metadata_entity_summaries',
      'federation_saml_runtime_entities',
      'federation_trust_anchors',
      'federation_trust_chains',
      'federation_trust_context_snapshots',
      'federation_trust_scope_bindings',
      'federation_trust_sources',
    ],
  },
  {
    family: 'admin',
    module: 'credentials',
    tables: [
      'credential_profile_versions',
      'credential_profiles',
      'key_material_refs',
      'key_registries',
      'key_versions',
    ],
  },
];

export const PHASE4_SQLITE_DATASET_REGISTRATIONS: readonly InstalledSqliteDatasetRegistration[] =
  PHASE4_SQLITE_TABLE_GROUPS.flatMap(({ family, module, tables }) =>
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

/** Derived database projections that must be regenerated after source documents are revalidated. */
export const PHASE4_REBUILT_SQLITE_TABLES = [] as const;

/** Cumulative SQL registry used by the Phase 4 installed adapter. */
export const PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS = [
  ...PHASE3_SQLITE_DATASET_REGISTRATIONS,
  ...PHASE4_SQLITE_DATASET_REGISTRATIONS,
] as const;

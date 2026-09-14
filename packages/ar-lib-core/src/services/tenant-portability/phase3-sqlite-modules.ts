import type { MigrationSchemaFamily } from '../control-plane/migration-stream-contract.js';
import type { InstalledSqliteDatasetRegistration } from './installed-sqlite-datasets.js';
import type { TenantPortabilityModuleId } from './module-contract.js';

type Phase3Module = Extract<
  TenantPortabilityModuleId,
  'tenant-runtime' | 'applications' | 'authorization' | 'consent' | 'mapping'
>;

interface Phase3TableGroup {
  family: MigrationSchemaFamily;
  module: Phase3Module;
  tables: readonly string[];
}

/**
 * Phase 3 SQL scope. This list is intentionally independent from the physical table classifier:
 * classification alone never makes a table exportable or assigns it to a module.
 */
export const PHASE3_SQLITE_TABLE_GROUPS: readonly Phase3TableGroup[] = [
  {
    family: 'core',
    module: 'tenant-runtime',
    tables: [
      'sign_in_confirmation_policies',
      'tenant_domain_mappings',
      'tenant_vanity_domains',
      'tenants',
    ],
  },
  {
    family: 'core',
    module: 'applications',
    tables: [
      'application_launchers',
      'check_api_keys',
      'client_trust_policies',
      'oauth_clients',
      'web_origin_registry',
    ],
  },
  {
    family: 'core',
    module: 'authorization',
    tables: [
      'custom_claim_schemas',
      'field_usage_bindings',
      'groups',
      'oidc_scopes',
      'org_domain_mappings',
      'organizations',
      'policy_rules',
      'provisioning_assignment_rules',
      'relation_definitions',
      'resource_permissions',
      'role_assignment_rules',
      'roles',
      'scope_mappings',
      'token_claim_rules',
    ],
  },
  {
    family: 'core',
    module: 'consent',
    tables: [
      'client_consent_overrides',
      'consent_policies',
      'consent_policy_items',
      'consent_policy_versions',
      'consent_statement_localizations',
      'consent_statement_versions',
      'consent_statements',
      'tenant_consent_requirements',
    ],
  },
  {
    family: 'admin',
    module: 'mapping',
    tables: [
      'attribute_field_registry',
      'attribute_group_registry',
      'compiled_mapping_snapshots',
      'custom_field_catalog_entries',
      'dependency_graph_snapshots',
      'destination_profile_versions',
      'destination_profiles',
      'external_schema_catalogs',
      'field_catalog_entries',
      'field_catalog_versions',
      'field_catalogs',
      'field_mapping_activations',
      'field_mapping_sets',
      'field_mapping_versions',
      'mapping_conflict_rules',
      'mapping_release_rules',
      'mapping_rule_edges',
      'mapping_rules',
      'mapping_templates',
      'mapping_transform_steps',
      'mapping_validation_rules',
      'persistent_identifier_profiles',
      'protocol_schema_catalogs',
      'source_authority_contracts',
      'source_profile_parse_drafts',
      'source_profile_versions',
      'source_profiles',
    ],
  },
];

export const PHASE3_SQLITE_DATASET_REGISTRATIONS: readonly InstalledSqliteDatasetRegistration[] =
  PHASE3_SQLITE_TABLE_GROUPS.flatMap(({ family, module, tables }) =>
    tables.map((table) => ({
      family,
      table,
      dataset: {
        id: table === 'resource_permissions' ? `${family}.${table}.settings` : `${family}.${table}`,
        module,
        kind: 'settings' as const,
        store: 'database' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
      ...(table === 'resource_permissions' ? { partitions: ['role', 'org'] } : {}),
    }))
  );

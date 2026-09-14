import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector.js';
import type { PlannedInstalledSqliteDataset } from './installed-sqlite-datasets.js';
import type { TenantPortabilityModuleId } from './module-contract.js';
import type {
  TenantPortableDependency,
  TenantPortableRecordIdentity,
} from './reference-contract.js';
import type { PortableSqliteRow } from './sqlite-dataset-inspector.js';
import { PHASE3_SQLITE_DATASET_REGISTRATIONS } from './phase3-sqlite-modules.js';

export interface Phase3SqliteReferenceRule {
  fromDatasetId: string;
  localColumns: readonly string[];
  toDatasetId: string;
  toModule: TenantPortabilityModuleId;
  nullable?: boolean;
  when?: { column: string; equals: string };
  /** Logical references are validated but may be excluded when they would invert storage order. */
  restoreOrdering?: 'required' | 'validation-only';
}

const byTable = new Map(
  PHASE3_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
    `${registration.family}:${registration.table}`,
    registration.dataset,
  ])
);

function dataset(family: 'core' | 'admin', table: string) {
  const value = byTable.get(`${family}:${table}`);
  if (!value) throw new Error(`phase3_reference_dataset_missing:${family}:${table}`);
  return value;
}

function relation(
  fromFamily: 'core' | 'admin',
  fromTable: string,
  localColumns: readonly string[],
  toFamily: 'core' | 'admin',
  toTable: string,
  options: Pick<Phase3SqliteReferenceRule, 'nullable' | 'when' | 'restoreOrdering'> = {}
): Phase3SqliteReferenceRule {
  const from = dataset(fromFamily, fromTable);
  const to = dataset(toFamily, toTable);
  return {
    fromDatasetId: from.id,
    localColumns,
    toDatasetId: to.id,
    toModule: to.module,
    ...options,
  };
}

const tenantReferences = PHASE3_SQLITE_DATASET_REGISTRATIONS.filter(
  ({ family, table }) => (family === 'core' || family === 'admin') && table !== 'tenants'
).map(({ dataset: from }) => ({
  fromDatasetId: from.id,
  localColumns: ['tenant_id'],
  toDatasetId: dataset('core', 'tenants').id,
  toModule: dataset('core', 'tenants').module,
}));

/**
 * Installed scalar reference graph for Phase 3. The column order is the target primary-key order.
 * Structured JSON references remain module-specific and are not inferred from uploaded values.
 */
export const PHASE3_SQLITE_REFERENCE_RULES: readonly Phase3SqliteReferenceRule[] = [
  ...tenantReferences,
  relation('core', 'client_consent_overrides', ['tenant_id', 'client_id'], 'core', 'oauth_clients'),
  relation('core', 'client_consent_overrides', ['statement_id'], 'core', 'consent_statements'),
  relation('core', 'consent_policy_items', ['policy_id'], 'core', 'consent_policies'),
  relation('core', 'consent_policy_items', ['statement_id'], 'core', 'consent_statements'),
  relation('core', 'consent_policy_items', ['version_id'], 'core', 'consent_statement_versions', {
    nullable: true,
  }),
  relation(
    'core',
    'consent_statement_localizations',
    ['version_id'],
    'core',
    'consent_statement_versions'
  ),
  relation('core', 'consent_statement_versions', ['statement_id'], 'core', 'consent_statements'),
  relation('core', 'organizations', ['parent_org_id'], 'core', 'organizations', {
    nullable: true,
  }),
  relation('core', 'roles', ['parent_role_id'], 'core', 'roles', { nullable: true }),
  relation('core', 'tenant_consent_requirements', ['statement_id'], 'core', 'consent_statements'),
  relation('core', 'web_origin_registry', ['tenant_id', 'client_id'], 'core', 'oauth_clients'),
  relation('core', 'org_domain_mappings', ['org_id'], 'core', 'organizations'),
  relation('core', 'org_domain_mappings', ['auto_assign_role_id'], 'core', 'roles', {
    nullable: true,
  }),
  relation('core', 'role_assignment_rules', ['role_id'], 'core', 'roles'),
  relation('core', 'resource_permissions', ['subject_id'], 'core', 'roles', {
    when: { column: 'subject_type', equals: 'role' },
  }),
  relation('core', 'resource_permissions', ['subject_id'], 'core', 'organizations', {
    when: { column: 'subject_type', equals: 'org' },
  }),
  relation(
    'admin',
    'compiled_mapping_snapshots',
    ['field_mapping_version_id'],
    'admin',
    'field_mapping_versions'
  ),
  relation(
    'admin',
    'compiled_mapping_snapshots',
    ['catalog_version_id'],
    'admin',
    'field_catalog_versions'
  ),
  relation(
    'admin',
    'dependency_graph_snapshots',
    ['field_mapping_version_id'],
    'admin',
    'field_mapping_versions'
  ),
  relation(
    'admin',
    'destination_profile_versions',
    ['profile_id'],
    'admin',
    'destination_profiles'
  ),
  relation('admin', 'destination_profiles', ['base_profile_id'], 'admin', 'destination_profiles', {
    nullable: true,
  }),
  relation(
    'admin',
    'destination_profiles',
    ['active_version_id'],
    'admin',
    'destination_profile_versions',
    { nullable: true, restoreOrdering: 'validation-only' }
  ),
  relation(
    'admin',
    'field_catalog_entries',
    ['catalog_version_id'],
    'admin',
    'field_catalog_versions'
  ),
  relation('admin', 'field_catalog_versions', ['catalog_id'], 'admin', 'field_catalogs'),
  relation(
    'admin',
    'field_mapping_activations',
    ['field_mapping_set_id'],
    'admin',
    'field_mapping_sets'
  ),
  relation(
    'admin',
    'field_mapping_activations',
    ['field_mapping_version_id'],
    'admin',
    'field_mapping_versions'
  ),
  relation(
    'admin',
    'field_mapping_versions',
    ['field_mapping_set_id'],
    'admin',
    'field_mapping_sets'
  ),
  relation(
    'admin',
    'mapping_conflict_rules',
    ['field_mapping_version_id'],
    'admin',
    'field_mapping_versions'
  ),
  relation(
    'admin',
    'mapping_release_rules',
    ['field_mapping_version_id'],
    'admin',
    'field_mapping_versions'
  ),
  relation('admin', 'mapping_rule_edges', ['rule_id'], 'admin', 'mapping_rules'),
  relation(
    'admin',
    'mapping_rules',
    ['field_mapping_version_id'],
    'admin',
    'field_mapping_versions'
  ),
  relation('admin', 'mapping_transform_steps', ['edge_id'], 'admin', 'mapping_rule_edges'),
  relation('admin', 'mapping_transform_steps', ['rule_id'], 'admin', 'mapping_rules'),
  relation('admin', 'mapping_validation_rules', ['rule_id'], 'admin', 'mapping_rules'),
  relation('admin', 'source_profile_versions', ['profile_id'], 'admin', 'source_profiles'),
  relation('admin', 'source_profiles', ['active_version_id'], 'admin', 'source_profile_versions', {
    nullable: true,
    restoreOrdering: 'validation-only',
  }),
];

function value(row: PortableSqliteRow, column: string) {
  const result = row[column];
  if (!result) throw new Error('backup_phase3_reference_column');
  return result;
}

function referenceId(row: PortableSqliteRow, rule: Phase3SqliteReferenceRule): string | null {
  const values = rule.localColumns.map((column) => value(row, column));
  const nulls = values.filter(([type]) => type === 'null').length;
  if (nulls === values.length && rule.nullable) return null;
  if (nulls > 0) throw new Error('backup_phase3_reference_null');
  return JSON.stringify(values);
}

export function inspectPhase3SqliteReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): readonly TenantPortableDependency[] {
  const dependencies: TenantPortableDependency[] = [];
  for (const rule of PHASE3_SQLITE_REFERENCE_RULES) {
    if (rule.fromDatasetId !== datasetId) continue;
    if (rule.when) {
      const condition = value(row, rule.when.column);
      if (condition[0] !== 'text') throw new Error('backup_phase3_reference_condition');
      if (condition[1] !== rule.when.equals) continue;
    }
    const id = referenceId(row, rule);
    if (id === null) continue;
    dependencies.push({
      from: identity,
      to: {
        module: rule.toModule,
        collection: rule.toDatasetId,
        id,
        tenantId: identity.tenantId,
        meaning: 'resource',
        requirement: 'required',
      },
    });
  }
  return dependencies;
}

/** Restore prerequisites derived only from the installed reference graph. */
export function phase3SqliteRestoreDependencies(datasetId: string): readonly string[] {
  if (!PHASE3_SQLITE_DATASET_REGISTRATIONS.some(({ dataset }) => dataset.id === datasetId))
    throw new Error('backup_phase3_reference_dataset');
  return [
    ...new Set(
      PHASE3_SQLITE_REFERENCE_RULES.filter(
        (rule) =>
          rule.fromDatasetId === datasetId &&
          rule.toDatasetId !== datasetId &&
          rule.restoreOrdering !== 'validation-only'
      ).map((rule) => rule.toDatasetId)
    ),
  ].sort();
}

/** Nullable self references are linked only after every row in that table has been inserted. */
export function phase3SqliteDeferredColumns(datasetId: string): readonly string[] {
  if (!PHASE3_SQLITE_DATASET_REGISTRATIONS.some(({ dataset }) => dataset.id === datasetId))
    throw new Error('backup_phase3_reference_dataset');
  const rules = PHASE3_SQLITE_REFERENCE_RULES.filter(
    (rule) => rule.fromDatasetId === datasetId && rule.toDatasetId === datasetId
  );
  if (rules.some((rule) => !rule.nullable))
    throw new Error('backup_phase3_reference_deferred_required');
  return [...new Set(rules.flatMap((rule) => rule.localColumns))].sort();
}

/** Target-local projection state must never be copied from the source environment. */
export function phase3SqliteRestoreOverrides(
  datasetId: string
): Readonly<Record<string, readonly [string, string | null]>> | undefined {
  if (!PHASE3_SQLITE_DATASET_REGISTRATIONS.some(({ dataset }) => dataset.id === datasetId))
    throw new Error('backup_phase3_reference_dataset');
  return datasetId === 'admin.tenant_settings_documents'
    ? {
        projection_state: ['text', 'pending'],
        projected_at: ['null', null],
      }
    : undefined;
}

/** Build import inspectors only from the sealed SQL plan and the installed Phase 3 registry. */
export function createPhase3SqliteInspectionPolicies(
  planned: readonly PlannedInstalledSqliteDataset[]
): SqliteDatasetInspectionPolicy[] {
  const registrations = new Map(
    PHASE3_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
      registration.dataset.id,
      registration,
    ])
  );
  if (
    planned.length !== registrations.size ||
    new Set(planned.map(({ dataset }) => dataset.id)).size !== planned.length
  )
    throw new Error('backup_phase3_plan_incomplete');
  return planned.map((entry) => {
    const registration = registrations.get(entry.dataset.id);
    if (
      !registration ||
      registration.family !== entry.family ||
      registration.table !== entry.table ||
      JSON.stringify(registration.dataset) !== JSON.stringify(entry.dataset) ||
      JSON.stringify(registration.partitions ?? []) !== JSON.stringify(entry.partitions ?? [])
    )
      throw new Error('backup_phase3_plan_mismatch');
    const restoreAfter = phase3SqliteRestoreDependencies(entry.dataset.id);
    const deferredColumns = phase3SqliteDeferredColumns(entry.dataset.id);
    const restoreOverrides = phase3SqliteRestoreOverrides(entry.dataset.id);
    return {
      dataset: structuredClone(entry.dataset),
      schema: structuredClone(entry.capture),
      ...(restoreAfter.length ? { restoreAfter } : {}),
      ...(deferredColumns.length ? { deferredColumns } : {}),
      ...(restoreOverrides ? { restoreOverrides } : {}),
      ...(entry.partitions ? { partitions: [...entry.partitions] } : {}),
      inspectRow: async (row, identity) =>
        inspectPhase3SqliteReferences(entry.dataset.id, row, identity),
    };
  });
}

import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector.js';
import type { PlannedInstalledSqliteDataset } from './installed-sqlite-datasets.js';
import type { TenantPortabilityModuleId } from './module-contract.js';
import type {
  TenantPortableDependency,
  TenantPortableRecordIdentity,
} from './reference-contract.js';
import type { PortableSqliteRow } from './sqlite-dataset-inspector.js';
import { PHASE3_SQLITE_DATASET_REGISTRATIONS } from './phase3-sqlite-modules.js';
import { portableOauthClientSecret } from './portable-client-secret.js';

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

function textValue(
  row: PortableSqliteRow,
  column: string,
  options: { nullable?: boolean } = {}
): string | null {
  const field = value(row, column);
  if (field[0] === 'null' && options.nullable) return null;
  if (field[0] !== 'text' || field[1] === null) throw new Error('backup_phase3_structured_value');
  return field[1];
}

function requiredTextValue(row: PortableSqliteRow, column: string): string {
  const result = textValue(row, column);
  if (result === null) throw new Error('backup_phase3_structured_value');
  return result;
}

function jsonObject(row: PortableSqliteRow, column: string): Readonly<Record<string, unknown>> {
  const encoded = requiredTextValue(row, column);
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new Error('backup_phase3_structured_json');
  }
}

function optionalJsonObject(
  row: PortableSqliteRow,
  column: string
): Readonly<Record<string, unknown>> | null {
  if (textValue(row, column, { nullable: true }) === null) return null;
  return jsonObject(row, column);
}

function stringArray(
  row: PortableSqliteRow,
  column: string,
  options: { nullable?: boolean; maxItems?: number } = {}
): readonly string[] {
  const encoded = textValue(row, column, { nullable: options.nullable });
  if (encoded === null) return [];
  try {
    const parsed: unknown = JSON.parse(encoded);
    const maxItems = options.maxItems ?? 1024;
    if (
      !Array.isArray(parsed) ||
      parsed.length > maxItems ||
      parsed.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 1024)
    )
      throw new Error();
    return parsed as string[];
  } catch {
    throw new Error('backup_phase3_structured_json');
  }
}

function recordId(...values: string[]): string {
  return JSON.stringify(values.map((item) => ['text', item] as const));
}

function dependency(
  identity: TenantPortableRecordIdentity,
  target: { family: 'core' | 'admin'; table: string; id: string }
): TenantPortableDependency {
  const installed = dataset(target.family, target.table);
  return {
    from: identity,
    to: {
      module: installed.module,
      collection: installed.id,
      id: target.id,
      tenantId: identity.tenantId,
      meaning: 'resource',
      requirement: 'required',
    },
  };
}

function installedIdDependency(
  identity: TenantPortableRecordIdentity,
  family: 'core' | 'admin',
  table: string,
  id: string
): TenantPortableDependency {
  return dependency(identity, { family, table, id: recordId(id) });
}

function profileReference(
  identity: TenantPortableRecordIdentity,
  ref: Readonly<Record<string, unknown>>
): TenantPortableDependency | null {
  const raw =
    typeof ref.profileId === 'string'
      ? ref.profileId
      : typeof ref.profile_id === 'string'
        ? ref.profile_id
        : null;
  if (!raw) return null;
  if (raw.startsWith('source-profile-')) {
    const id = raw.slice('source-profile-'.length);
    if (!id) throw new Error('backup_phase3_structured_reference');
    return dependency(identity, { family: 'admin', table: 'source_profiles', id: recordId(id) });
  }
  if (raw.startsWith('source_profile_'))
    return dependency(identity, {
      family: 'admin',
      table: 'source_profiles',
      id: recordId(raw),
    });
  if (raw.startsWith('destination-profile-')) {
    const id = raw.slice('destination-profile-'.length);
    if (!id) throw new Error('backup_phase3_structured_reference');
    return dependency(identity, {
      family: 'admin',
      table: 'destination_profiles',
      id: recordId(id),
    });
  }
  if (raw.startsWith('destination_profile_'))
    return dependency(identity, {
      family: 'admin',
      table: 'destination_profiles',
      id: recordId(raw),
    });
  return null;
}

function activationProfileReferences(
  identity: TenantPortableRecordIdentity,
  value: Readonly<Record<string, unknown>>
): readonly TenantPortableDependency[] {
  const references: TenantPortableDependency[] = [];
  const fields = [
    ['sourceProfileId', 'source_profiles'],
    ['destinationProfileId', 'destination_profiles'],
  ] as const;
  for (const [column, table] of fields) {
    const raw = value[column];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024)
      throw new Error('backup_phase3_structured_reference');
    const normalized = raw.replace(/^source-profile-/, '').replace(/^destination-profile-/, '');
    if (!normalized) throw new Error('backup_phase3_structured_reference');
    references.push(
      dependency(identity, {
        family: 'admin',
        table,
        id: recordId(normalized),
      })
    );
  }
  return references;
}

function inspectStructuredReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): readonly TenantPortableDependency[] {
  if (datasetId === 'core.oauth_clients') {
    const tenantId = requiredTextValue(row, 'tenant_id');
    const dependencies = [
      ...new Set(
        stringArray(row, 'allowed_subject_token_clients', { nullable: true, maxItems: 1024 })
      ),
    ].map((clientId) =>
      dependency(identity, {
        family: 'core',
        table: 'oauth_clients',
        id: recordId(tenantId, clientId),
      })
    );
    const selector = optionalJsonObject(row, 'identity_mapping');
    if (!selector) return dependencies;
    const selectors = [
      [selector.fieldMappingSetId ?? selector.policySetId, 'field_mapping_sets'],
      [selector.fieldMappingVersionId ?? selector.policyVersionId, 'field_mapping_versions'],
      [selector.sourceProfileId, 'source_profiles'],
      [selector.destinationProfileId, 'destination_profiles'],
    ] as const;
    for (const [raw, table] of selectors) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024)
        throw new Error('backup_phase3_structured_reference');
      const normalized = raw.replace(/^source-profile-/, '').replace(/^destination-profile-/, '');
      if (!normalized) throw new Error('backup_phase3_structured_reference');
      dependencies.push(installedIdDependency(identity, 'admin', table, normalized));
    }
    return dependencies;
  }

  if (datasetId === 'core.application_launchers') {
    const config = jsonObject(row, 'config_json');
    const id = requiredTextValue(row, 'id');
    if (config.id !== id) throw new Error('backup_phase3_structured_reference');
    const applicationType = config.application_type;
    const applicationId = config.application_id;
    if (
      !['standalone', 'oidc_client', 'saml_sp'].includes(
        typeof applicationType === 'string' ? applicationType : ''
      ) ||
      (applicationType !== 'standalone' &&
        (typeof applicationId !== 'string' || !applicationId || applicationId.length > 1024))
    )
      throw new Error('backup_phase3_structured_reference');
    const dependencies: TenantPortableDependency[] = [];
    if (applicationType === 'oidc_client') {
      const tenantId = requiredTextValue(row, 'tenant_id');
      dependencies.push(
        dependency(identity, {
          family: 'core',
          table: 'oauth_clients',
          id: recordId(tenantId, applicationId as string),
        })
      );
    }
    const visibility = config.visibility;
    if (visibility !== undefined) {
      if (!visibility || typeof visibility !== 'object' || Array.isArray(visibility))
        throw new Error('backup_phase3_structured_reference');
      const groupIds = (visibility as Record<string, unknown>).group_ids;
      if (groupIds !== undefined) {
        if (
          !Array.isArray(groupIds) ||
          groupIds.length > 500 ||
          groupIds.some(
            (groupId) => typeof groupId !== 'string' || !groupId || groupId.length > 200
          )
        )
          throw new Error('backup_phase3_structured_reference');
        for (const groupId of new Set(groupIds as string[]))
          dependencies.push(installedIdDependency(identity, 'core', 'groups', groupId));
      }
    }
    return dependencies;
  }

  if (datasetId === 'admin.attribute_group_registry') {
    stringArray(row, 'field_keys_json', { maxItems: 1024 });
    return [];
  }

  if (datasetId === 'admin.persistent_identifier_profiles') {
    optionalJsonObject(row, 'source_ref_json');
    stringArray(row, 'usage_json', { maxItems: 64 });
    jsonObject(row, 'format_json');
    return [];
  }

  const columns =
    datasetId === 'admin.mapping_rule_edges'
      ? ['source_ref_json', 'target_ref_json']
      : datasetId === 'admin.mapping_release_rules'
        ? ['source_ref_json']
        : datasetId === 'admin.mapping_conflict_rules' ||
            datasetId === 'admin.mapping_validation_rules'
          ? ['target_ref_json']
          : datasetId === 'admin.mapping_transform_steps'
            ? textValue(row, 'target_ref_json', { nullable: true }) === null
              ? []
              : ['target_ref_json']
            : [];
  if (datasetId === 'admin.field_mapping_activations')
    return activationProfileReferences(identity, jsonObject(row, 'activation_scope_json'));
  return columns.flatMap((column) => {
    const reference = profileReference(identity, jsonObject(row, column));
    return reference ? [reference] : [];
  });
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
  if (datasetId === 'core.oauth_clients') portableOauthClientSecret(row);
  const dependencies: TenantPortableDependency[] = [
    ...inspectStructuredReferences(datasetId, row, identity),
  ];
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
    : datasetId === 'core.oauth_clients'
      ? { logout_webhook_secret_encrypted: ['null', null] }
      : undefined;
}

/** Environment-encrypted values are restored and verified through the installed secret sidecar. */
export function phase3SqliteVerificationIgnoredColumns(datasetId: string): readonly string[] {
  if (!PHASE3_SQLITE_DATASET_REGISTRATIONS.some(({ dataset }) => dataset.id === datasetId))
    throw new Error('backup_phase3_reference_dataset');
  return datasetId === 'core.oauth_clients' ? ['logout_webhook_secret_encrypted'] : [];
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
    const verificationIgnoredColumns = phase3SqliteVerificationIgnoredColumns(entry.dataset.id);
    return {
      dataset: structuredClone(entry.dataset),
      schema: structuredClone(entry.capture),
      ...(restoreAfter.length ? { restoreAfter } : {}),
      ...(deferredColumns.length ? { deferredColumns } : {}),
      ...(restoreOverrides ? { restoreOverrides } : {}),
      ...(verificationIgnoredColumns.length ? { verificationIgnoredColumns } : {}),
      ...(entry.partitions ? { partitions: [...entry.partitions] } : {}),
      inspectRow: async (row, identity) =>
        inspectPhase3SqliteReferences(entry.dataset.id, row, identity),
    };
  });
}

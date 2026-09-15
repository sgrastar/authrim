import type { PlannedInstalledSqliteDataset } from './installed-sqlite-datasets.js';
import type { TenantPortabilityModuleId } from './module-contract.js';
import {
  inspectPhase3SqliteReferences,
  phase3SqliteDeferredColumns,
  phase3SqliteRestoreDependencies,
  phase3SqliteRestoreOverrides,
  phase3SqliteVerificationIgnoredColumns,
  type Phase3SqliteReferenceRule,
} from './phase3-sqlite-references.js';
import { PHASE3_SQLITE_DATASET_REGISTRATIONS } from './phase3-sqlite-modules.js';
import {
  PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  PHASE4_SQLITE_DATASET_REGISTRATIONS,
} from './phase4-sqlite-modules.js';
import type {
  TenantPortableDependency,
  TenantPortableRecordIdentity,
} from './reference-contract.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';

const byTable = new Map(
  PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
    `${registration.family}:${registration.table}`,
    registration.dataset,
  ])
);
const phase3Ids = new Set(PHASE3_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id));
const phase4Ids = new Set(PHASE4_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id));

function dataset(family: 'core' | 'admin', table: string) {
  const value = byTable.get(`${family}:${table}`);
  if (!value) throw new Error(`phase4_reference_dataset_missing:${family}:${table}`);
  return value;
}

function relation(
  fromFamily: 'core' | 'admin',
  fromTable: string,
  localColumns: readonly string[],
  toFamily: 'core' | 'admin',
  toTable: string,
  options: Pick<Phase3SqliteReferenceRule, 'nullable' | 'restoreOrdering'> = {}
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

const tenantReferences = PHASE4_SQLITE_DATASET_REGISTRATIONS.map(({ dataset: from }) => ({
  fromDatasetId: from.id,
  localColumns: ['tenant_id'],
  toDatasetId: dataset('core', 'tenants').id,
  toModule: dataset('core', 'tenants').module,
}));

/** Scalar and stable logical references introduced by the Phase 4 SQL scope. */
export const PHASE4_SQLITE_REFERENCE_RULES: readonly Phase3SqliteReferenceRule[] = [
  ...tenantReferences,
  relation(
    'admin',
    'credential_profile_versions',
    ['credential_profile_id'],
    'admin',
    'credential_profiles'
  ),
  relation(
    'admin',
    'credential_profile_versions',
    ['issuance_mapping_set_id'],
    'admin',
    'field_mapping_sets'
  ),
  relation(
    'admin',
    'credential_profile_versions',
    ['issuance_mapping_version_id'],
    'admin',
    'field_mapping_versions',
    { nullable: true }
  ),
  relation(
    'admin',
    'credential_profile_versions',
    ['verification_mapping_set_id'],
    'admin',
    'field_mapping_sets',
    { nullable: true }
  ),
  relation(
    'admin',
    'credential_profile_versions',
    ['verification_mapping_version_id'],
    'admin',
    'field_mapping_versions',
    { nullable: true }
  ),
  relation(
    'admin',
    'credential_profiles',
    ['current_published_version_id'],
    'admin',
    'credential_profile_versions',
    { nullable: true, restoreOrdering: 'validation-only' }
  ),
  relation(
    'admin',
    'federation_metadata_documents',
    ['trust_source_id'],
    'admin',
    'federation_trust_sources'
  ),
  relation(
    'admin',
    'federation_trust_anchors',
    ['trust_source_id'],
    'admin',
    'federation_trust_sources'
  ),
  relation(
    'admin',
    'federation_trust_scope_bindings',
    ['trust_source_id'],
    'admin',
    'federation_trust_sources'
  ),
  relation(
    'admin',
    'federation_trust_sources',
    ['active_metadata_document_id'],
    'admin',
    'federation_metadata_documents',
    { nullable: true, restoreOrdering: 'validation-only' }
  ),
  relation('admin', 'key_material_refs', ['key_version_id'], 'admin', 'key_versions'),
  relation('admin', 'key_versions', ['key_registry_id'], 'admin', 'key_registries'),
  relation('admin', 'key_registries', ['active_version_id'], 'admin', 'key_versions', {
    nullable: true,
    restoreOrdering: 'validation-only',
  }),
];

function value(row: PortableSqliteRow, column: string) {
  const result = row[column];
  if (!result) throw new Error('backup_phase4_reference_column');
  return result;
}

function referenceId(row: PortableSqliteRow, rule: Phase3SqliteReferenceRule): string | null {
  const values = rule.localColumns.map((column) => value(row, column));
  const nulls = values.filter(([type]) => type === 'null').length;
  if (nulls === values.length && rule.nullable) return null;
  if (nulls > 0) throw new Error('backup_phase4_reference_null');
  return JSON.stringify(values);
}

function requiredText(row: PortableSqliteRow, column: string): string {
  const field = value(row, column);
  if (field[0] !== 'text' || field[1] === null || !field[1] || field[1].length > 4096)
    throw new Error('backup_phase4_structured_reference');
  return field[1];
}

function jsonObject(row: PortableSqliteRow, column: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredText(row, column)) as unknown;
  } catch {
    throw new Error('backup_phase4_structured_reference');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('backup_phase4_structured_reference');
  return parsed as Record<string, unknown>;
}

function installedDependency(
  identity: TenantPortableRecordIdentity,
  to: { module: TenantPortabilityModuleId; collection: string; values: readonly string[] }
): TenantPortableDependency {
  return {
    from: identity,
    to: {
      module: to.module,
      collection: to.collection,
      id: JSON.stringify(to.values.map((item) => ['text', item])),
      tenantId: identity.tenantId,
      meaning: 'resource',
      requirement: 'required',
    },
  };
}

function phase4StructuredReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): TenantPortableDependency[] {
  if (datasetId === 'core.application_launchers') {
    const config = jsonObject(row, 'config_json');
    if (config.application_type !== 'saml_sp') return [];
    if (
      typeof config.application_id !== 'string' ||
      !config.application_id ||
      config.application_id.length > 1024
    )
      throw new Error('backup_phase4_structured_reference');
    return [
      installedDependency(identity, {
        module: 'federation',
        collection: 'core.identity_providers',
        values: [config.application_id],
      }),
    ];
  }
  if (datasetId !== 'core.identity_providers') return [];
  const config = jsonObject(row, 'config_json');
  const references: TenantPortableDependency[] = [];
  const mapping = config.identityMapping;
  if (mapping !== undefined) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
      throw new Error('backup_phase4_structured_reference');
    const selectors = [
      [
        (mapping as Record<string, unknown>).fieldMappingSetId,
        'admin.field_mapping_sets',
        'mapping',
      ],
      [
        (mapping as Record<string, unknown>).fieldMappingVersionId,
        'admin.field_mapping_versions',
        'mapping',
      ],
      [(mapping as Record<string, unknown>).sourceProfileId, 'admin.source_profiles', 'mapping'],
      [
        (mapping as Record<string, unknown>).destinationProfileId,
        'admin.destination_profiles',
        'mapping',
      ],
    ] as const;
    for (const [raw, collection, module] of selectors) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string' || !raw || raw.length > 1024)
        throw new Error('backup_phase4_structured_reference');
      const normalized = raw.replace(/^source-profile-/, '').replace(/^destination-profile-/, '');
      if (!normalized) throw new Error('backup_phase4_structured_reference');
      references.push(installedDependency(identity, { module, collection, values: [normalized] }));
    }
  }
  const preset = config.attributePresetId;
  if (typeof preset === 'string' && preset.startsWith('custom:'))
    references.push(
      installedDependency(identity, {
        module: 'federation',
        collection: 'core.saml_attribute_presets',
        values: [preset],
      })
    );
  else if (preset !== undefined && (typeof preset !== 'string' || !preset || preset.length > 1024))
    throw new Error('backup_phase4_structured_reference');
  return references;
}

export function inspectPhase4SqliteReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): readonly TenantPortableDependency[] {
  if (phase3Ids.has(datasetId))
    return [
      ...inspectPhase3SqliteReferences(datasetId, row, identity),
      ...phase4StructuredReferences(datasetId, row, identity),
    ];
  if (!phase4Ids.has(datasetId)) throw new Error('backup_phase4_reference_dataset');
  return [
    ...PHASE4_SQLITE_REFERENCE_RULES.filter((rule) => rule.fromDatasetId === datasetId).flatMap(
      (rule) => {
        const id = referenceId(row, rule);
        return id === null
          ? []
          : [
              {
                from: identity,
                to: {
                  module: rule.toModule,
                  collection: rule.toDatasetId,
                  id,
                  tenantId: identity.tenantId,
                  meaning: 'resource' as const,
                  requirement: 'required' as const,
                },
              },
            ];
      }
    ),
    ...phase4StructuredReferences(datasetId, row, identity),
  ];
}

export function phase4SqliteRestoreDependencies(datasetId: string): readonly string[] {
  if (phase3Ids.has(datasetId)) return phase3SqliteRestoreDependencies(datasetId);
  if (!phase4Ids.has(datasetId)) throw new Error('backup_phase4_reference_dataset');
  return [
    ...new Set(
      PHASE4_SQLITE_REFERENCE_RULES.filter(
        (rule) =>
          rule.fromDatasetId === datasetId &&
          rule.toDatasetId !== datasetId &&
          rule.restoreOrdering !== 'validation-only'
      ).map((rule) => rule.toDatasetId)
    ),
  ].sort();
}

export function phase4SqliteRestoreOverrides(
  datasetId: string
): Readonly<Record<string, readonly [string, string | null]>> | undefined {
  if (phase3Ids.has(datasetId)) return phase3SqliteRestoreOverrides(datasetId);
  if (!phase4Ids.has(datasetId)) throw new Error('backup_phase4_reference_dataset');
  if (datasetId === 'core.upstream_providers')
    return {
      client_secret_encrypted: ['text', ''],
      private_key_jwk_encrypted: ['null', null],
    };
  if (datasetId === 'admin.federation_metadata_documents')
    return { validation_state: ['text', 'pending'], validated_at: ['null', null] };
  return undefined;
}

export function phase4SqliteVerificationIgnoredColumns(datasetId: string): readonly string[] {
  if (phase3Ids.has(datasetId)) return phase3SqliteVerificationIgnoredColumns(datasetId);
  if (!phase4Ids.has(datasetId)) throw new Error('backup_phase4_reference_dataset');
  return datasetId === 'core.upstream_providers'
    ? ['client_secret_encrypted', 'private_key_jwk_encrypted']
    : [];
}

/** Build cumulative Phase 3+4 policies from installed code and a sealed SQL plan. */
export function createPhase4SqliteInspectionPolicies(
  planned: readonly PlannedInstalledSqliteDataset[]
): SqliteDatasetInspectionPolicy[] {
  const registrations = new Map(
    PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
      registration.dataset.id,
      registration,
    ])
  );
  if (
    planned.length !== registrations.size ||
    new Set(planned.map(({ dataset }) => dataset.id)).size !== planned.length
  )
    throw new Error('backup_phase4_plan_incomplete');
  return planned.map((entry) => {
    const registration = registrations.get(entry.dataset.id);
    if (
      !registration ||
      registration.family !== entry.family ||
      registration.table !== entry.table ||
      JSON.stringify(registration.dataset) !== JSON.stringify(entry.dataset) ||
      JSON.stringify(registration.partitions ?? []) !== JSON.stringify(entry.partitions ?? [])
    )
      throw new Error('backup_phase4_plan_mismatch');
    const restoreAfter = phase4SqliteRestoreDependencies(entry.dataset.id);
    const deferredColumns = phase3Ids.has(entry.dataset.id)
      ? phase3SqliteDeferredColumns(entry.dataset.id)
      : [];
    const restoreOverrides = phase4SqliteRestoreOverrides(entry.dataset.id);
    const verificationIgnoredColumns = phase4SqliteVerificationIgnoredColumns(entry.dataset.id);
    return {
      dataset: structuredClone(entry.dataset),
      schema: structuredClone(entry.capture),
      ...(restoreAfter.length ? { restoreAfter } : {}),
      ...(deferredColumns.length ? { deferredColumns } : {}),
      ...(restoreOverrides ? { restoreOverrides } : {}),
      ...(verificationIgnoredColumns.length ? { verificationIgnoredColumns } : {}),
      ...(entry.partitions ? { partitions: [...entry.partitions] } : {}),
      inspectRow: async (row, identity) =>
        inspectPhase4SqliteReferences(entry.dataset.id, row, identity),
    };
  });
}

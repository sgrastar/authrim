import type { PlannedInstalledSqliteDataset } from './installed-sqlite-datasets.js';
import {
  inspectPhase4SqliteReferences,
  phase4SqliteRestoreDependencies,
  phase4SqliteRestoreOverrides,
  phase4SqliteVerificationIgnoredColumns,
} from './phase4-sqlite-references.js';
import { PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from './phase4-sqlite-modules.js';
import {
  PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  PHASE5_SQLITE_DATASET_REGISTRATIONS,
} from './phase5-sqlite-modules.js';
import type {
  TenantPortableDependency,
  TenantPortableRecordIdentity,
} from './reference-contract.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import { portableWebhookSecret } from './portable-webhook-secret.js';

const previousIds = new Set(
  PHASE4_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)
);
const phase5Ids = new Set(PHASE5_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id));
const registrations = new Map(
  PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
    registration.dataset.id,
    registration,
  ])
);
const byTable = new Map(
  PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
    `${registration.family}:${registration.table}`,
    registration.dataset,
  ])
);

interface Rule {
  from: string;
  columns: readonly string[];
  to: string;
  nullable?: boolean;
  validationOnly?: boolean;
}

function id(family: 'core' | 'admin', table: string): string {
  const dataset = byTable.get(`${family}:${table}`);
  if (!dataset) throw new Error('backup_phase5_reference_registry');
  return dataset.id;
}

const RULES: readonly Rule[] = [
  { from: id('core', 'flow_versions'), columns: ['flow_id'], to: id('core', 'flows') },
  { from: id('core', 'flow_assignments'), columns: ['flow_id'], to: id('core', 'flows') },
  {
    from: id('core', 'flows'),
    columns: ['published_version_id'],
    to: id('core', 'flow_versions'),
    nullable: true,
    validationOnly: true,
  },
  {
    from: id('admin', 'credential_profile_versions'),
    columns: ['issuance_flow_id'],
    to: id('core', 'flows'),
  },
  {
    from: id('admin', 'credential_profile_versions'),
    columns: ['issuance_flow_version_id'],
    to: id('core', 'flow_versions'),
    nullable: true,
  },
  {
    from: id('admin', 'credential_profile_versions'),
    columns: ['verification_flow_id'],
    to: id('core', 'flows'),
    nullable: true,
  },
  {
    from: id('admin', 'credential_profile_versions'),
    columns: ['verification_flow_version_id'],
    to: id('core', 'flow_versions'),
    nullable: true,
  },
  {
    from: id('admin', 'credential_secret_metadata'),
    columns: ['destination_id'],
    to: id('admin', 'admin_destinations'),
  },
  {
    from: id('admin', 'credential_secret_bodies'),
    columns: ['credential_ref'],
    to: id('admin', 'credential_secret_metadata'),
  },
  {
    from: id('admin', 'logging_key_versions'),
    columns: ['key_registry_id'],
    to: id('admin', 'logging_key_registry'),
  },
  {
    from: id('admin', 'logging_destination_overrides'),
    columns: ['destination_id'],
    to: id('admin', 'admin_destinations'),
  },
] as const;

function invalid(): never {
  throw new Error('backup_phase5_reference_invalid');
}

function field(row: PortableSqliteRow, column: string): readonly [string, string | null] {
  return row[column] ?? invalid();
}

function reference(
  identity: TenantPortableRecordIdentity,
  collection: string,
  values: readonly (readonly [string, string | null])[]
): TenantPortableDependency {
  const target = registrations.get(collection)?.dataset;
  if (!target) invalid();
  return {
    from: identity,
    to: {
      module: target.module,
      collection,
      id: JSON.stringify(values),
      tenantId: identity.tenantId,
      meaning: 'resource',
      requirement: 'required',
    },
  };
}

function scalarReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): TenantPortableDependency[] {
  return RULES.filter(({ from }) => from === datasetId).flatMap((rule) => {
    const values = rule.columns.map((column) => field(row, column));
    const nulls = values.filter(([type, value]) => type === 'null' && value === null).length;
    if (nulls === values.length && rule.nullable) return [];
    if (nulls) invalid();
    return [reference(identity, rule.to, values)];
  });
}

function parseJsonObject(row: PortableSqliteRow, column: string): Record<string, unknown> | null {
  const value = field(row, column);
  if (value[0] === 'null' && value[1] === null) return null;
  if (value[0] !== 'text' || typeof value[1] !== 'string') invalid();
  if (new TextEncoder().encode(value[1]).length > 4 * 1024 * 1024) invalid();
  try {
    const parsed: unknown = JSON.parse(value[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
    return parsed as Record<string, unknown>;
  } catch {
    return invalid();
  }
}

function collectNamedString(value: unknown, name: string, output: Set<string>, depth = 0): void {
  if (depth > 64 || output.size > 4096) invalid();
  if (Array.isArray(value)) {
    for (const item of value) collectNamedString(item, name, output, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === name) {
      if (typeof item !== 'string' || !item || item.length > 1024) invalid();
      output.add(item);
    }
    collectNamedString(item, name, output, depth + 1);
  }
}

function flowReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): TenantPortableDependency[] {
  const columns =
    datasetId === 'core.flows'
      ? ['graph_definition', 'compiled_plan', 'draft_editor_json', 'draft_runtime_base_json']
      : datasetId === 'core.flow_versions'
        ? ['runtime_snapshot_json', 'editor_snapshot_json']
        : [];
  const screenIds = new Set<string>();
  const authenticationProfileIds = new Set<string>();
  for (const column of columns) {
    const value = parseJsonObject(row, column);
    if (!value) continue;
    collectNamedString(value, 'screen_ref', screenIds);
    // Authentication profiles are an installed Flow runtime contract, not rows in the shared
    // storage/audit/residency profile_registry table. Still parse and bound every reference.
    collectNamedString(value, 'authentication_profile_ref', authenticationProfileIds);
  }
  return [
    ...[...screenIds].map((screenId) => reference(identity, 'core.screens', [['text', screenId]])),
  ];
}

function assignmentTarget(
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): TenantPortableDependency[] {
  const type = field(row, 'target_type');
  const target = field(row, 'target_id');
  if (type[0] !== 'text' || type[1] === null) invalid();
  if (type[1] === 'tenant') {
    if (target[0] !== 'null' || target[1] !== null) invalid();
    return [];
  }
  if (target[0] !== 'text' || !target[1]) invalid();
  if (type[1] === 'oidc_client')
    return [reference(identity, 'core.oauth_clients', [['text', identity.tenantId], target])];
  if (type[1] === 'saml_sp') return [reference(identity, 'core.identity_providers', [target])];
  if (type[1] === 'credential_profile')
    return [reference(identity, 'admin.credential_profiles', [target])];
  return invalid();
}

export function inspectPhase5SqliteReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): readonly TenantPortableDependency[] {
  if (previousIds.has(datasetId))
    return [
      ...inspectPhase4SqliteReferences(datasetId, row, identity),
      ...scalarReferences(datasetId, row, identity),
    ];
  if (!phase5Ids.has(datasetId)) invalid();
  return [
    ...scalarReferences(datasetId, row, identity),
    ...flowReferences(datasetId, row, identity),
    ...(datasetId === 'core.flow_assignments' ? assignmentTarget(row, identity) : []),
  ];
}

export function phase5SqliteRestoreDependencies(datasetId: string): readonly string[] {
  if (previousIds.has(datasetId))
    return [
      ...new Set([
        ...phase4SqliteRestoreDependencies(datasetId),
        // Creating a tenant installs this default row through a trigger. Restore the source value
        // first so the trigger's ON CONFLICT DO NOTHING keeps it without requiring an upsert.
        ...(datasetId === 'core.tenants' ? [id('core', 'lookup_retention_policies')] : []),
        ...RULES.filter(
          (rule) => rule.from === datasetId && rule.to !== datasetId && !rule.validationOnly
        ).map(({ to }) => to),
      ]),
    ].sort();
  if (!phase5Ids.has(datasetId)) invalid();
  return [
    ...new Set(
      RULES.filter(
        (rule) => rule.from === datasetId && rule.to !== datasetId && !rule.validationOnly
      ).map(({ to }) => to)
    ),
  ].sort();
}

export const PHASE5_SENSITIVE_SQLITE_DATASETS = [
  'admin.credential_secret_bodies',
  'admin.logging_key_material_bodies',
  'core.webhook_configs',
] as const;

export function phase5SqliteRestoreOverrides(
  datasetId: string
): Readonly<Record<string, readonly [string, string | null]>> | undefined {
  if (previousIds.has(datasetId)) return phase4SqliteRestoreOverrides(datasetId);
  if (!phase5Ids.has(datasetId)) invalid();
  if (datasetId === 'core.webhook_configs') return { secret_encrypted: ['null', null] };
  if (datasetId === 'admin.credential_secret_bodies') return { envelope_json: ['text', '{}'] };
  if (datasetId === 'admin.logging_key_material_bodies') return { envelope_json: ['text', '{}'] };
  return undefined;
}

export function phase5SqliteVerificationIgnoredColumns(datasetId: string): readonly string[] {
  if (previousIds.has(datasetId)) return phase4SqliteVerificationIgnoredColumns(datasetId);
  if (!phase5Ids.has(datasetId)) invalid();
  if (datasetId === 'core.webhook_configs') return ['secret_encrypted'];
  if (
    datasetId === 'admin.credential_secret_bodies' ||
    datasetId === 'admin.logging_key_material_bodies'
  )
    return ['envelope_json'];
  return [];
}

/** Build the complete settings policy and bind tenant-key rows to their opaque source identity. */
export function createPhase5SqliteInspectionPolicies(
  planned: readonly PlannedInstalledSqliteDataset[],
  input: {
    tenantKey: string;
    validateAdminEnvelope(datasetId: string, row: PortableSqliteRow): Promise<void>;
  }
): SqliteDatasetInspectionPolicy[] {
  if (!input.tenantKey || input.tenantKey.length > 256) invalid();
  if (
    planned.length !== registrations.size ||
    new Set(planned.map(({ dataset }) => dataset.id)).size !== planned.length
  )
    throw new Error('backup_phase5_plan_incomplete');
  return planned.map((entry) => {
    const registration = registrations.get(entry.dataset.id);
    if (
      !registration ||
      registration.family !== entry.family ||
      registration.table !== entry.table ||
      JSON.stringify(registration.dataset) !== JSON.stringify(entry.dataset) ||
      JSON.stringify(registration.partitions ?? []) !== JSON.stringify(entry.partitions ?? [])
    )
      throw new Error('backup_phase5_plan_mismatch');
    const restoreAfter = phase5SqliteRestoreDependencies(entry.dataset.id);
    const deferredColumns = entry.dataset.id === 'core.flows' ? ['published_version_id'] : [];
    const restoreOverrides = phase5SqliteRestoreOverrides(entry.dataset.id);
    const verificationIgnoredColumns = phase5SqliteVerificationIgnoredColumns(entry.dataset.id);
    const parentDataset =
      'parent' in entry.capture
        ? byTable.get(`${entry.family}:${entry.capture.parent.schema.table}`)
        : undefined;
    if ('parent' in entry.capture && !parentDataset) invalid();
    return {
      dataset: structuredClone(entry.dataset),
      schema: structuredClone(entry.capture),
      ...(restoreAfter.length ? { restoreAfter } : {}),
      ...(deferredColumns.length ? { deferredColumns } : {}),
      ...(restoreOverrides ? { restoreOverrides } : {}),
      ...(verificationIgnoredColumns.length ? { verificationIgnoredColumns } : {}),
      ...(entry.capture.tenantIdentity === 'tenantKey' ? { tenantKey: input.tenantKey } : {}),
      ...(parentDataset
        ? { parentDataset: { id: parentDataset.id, module: parentDataset.module } }
        : {}),
      ...(entry.partitions ? { partitions: [...entry.partitions] } : {}),
      inspectRow: async (row, identity) => {
        if (entry.dataset.id === 'core.webhook_configs') portableWebhookSecret(row);
        if (
          entry.dataset.id === 'admin.credential_secret_bodies' ||
          entry.dataset.id === 'admin.logging_key_material_bodies'
        )
          await input.validateAdminEnvelope(entry.dataset.id, row);
        return inspectPhase5SqliteReferences(entry.dataset.id, row, identity);
      },
    };
  });
}

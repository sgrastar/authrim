import type { PlannedInstalledSqliteDataset } from './installed-sqlite-datasets.js';
import {
  createPhase5SqliteInspectionPolicies,
  inspectPhase5SqliteReferences,
  phase5SqliteRestoreDependencies,
} from './phase5-sqlite-references.js';
import { PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from './phase5-sqlite-modules.js';
import { PHASE8_SQLITE_FOREIGN_KEY_RULES } from './phase8-sqlite-foreign-keys.js';
import {
  PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  PHASE8_SQLITE_DATASET_REGISTRATIONS,
} from './phase8-sqlite-modules.js';
import type {
  TenantPortableDependency,
  TenantPortableRecordIdentity,
} from './reference-contract.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { TenantBackupStepContext } from './operation-executor.js';
import {
  PHASE8_RESTORE_HOLD_RULES,
  phase8RestoreHoldReason,
  phase8RestoreHoldRecordId,
} from './phase8-restore-holds.js';
import {
  assertEnvironmentTenantKey,
  assertPortableTenantKeyRow,
  portableTenantKeyColumn,
  PORTABLE_TENANT_KEY,
} from './portable-tenant-key.js';

const phase5Ids = new Set(
  PHASE5_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)
);
const phase8Ids = new Set(PHASE8_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id));
const registrations = new Map(
  PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
    registration.dataset.id,
    registration,
  ])
);
const byTable = new Map(
  PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration) => [
    `${registration.family}:${registration.table}`,
    registration.dataset,
  ])
);

export const PHASE8_SENSITIVE_SQLITE_DATASETS = [
  'admin.admin_users',
  'admin.agent_management_executions',
  'core.notification_delivery_intents',
  'core.operational_logs',
  'core.totp_credentials',
  'pii.identity_identifier_replacement_challenges',
  'pii.linked_identities',
  'pii.pii_log',
] as const;

const sensitiveIds = new Set<string>(PHASE8_SENSITIVE_SQLITE_DATASETS);

export const PHASE8_RESTORED_SENSITIVE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'admin.agent_management_executions': ['result_envelope'],
  'core.notification_delivery_intents': [
    'payload_key_id',
    'payload_envelope_json',
    'recipient_encrypted',
    'recipient_encryption_key_version',
  ],
  'core.operational_logs': ['reason_detail_encrypted', 'encryption_key_version'],
  'core.totp_credentials': ['secret_encrypted', 'secret_key_version'],
  'pii.linked_identities': ['access_token_encrypted', 'refresh_token_encrypted'],
  'pii.pii_log': ['values_encrypted', 'encryption_key_id', 'encryption_iv'],
};

function phase8SensitiveRestoreOverrides(
  datasetId: string
): Readonly<Record<string, readonly [string, string | null]>> | undefined {
  const columns = PHASE8_RESTORED_SENSITIVE_COLUMNS[datasetId];
  if (!columns) return undefined;
  const overrides: Record<string, readonly [string, string | null]> = {};
  for (const column of columns) {
    if (datasetId === 'core.operational_logs' && column === 'encryption_key_version')
      overrides[column] = ['integer', '0'];
    else if (datasetId === 'core.totp_credentials' && column === 'secret_key_version')
      overrides[column] = ['integer', '1'];
    else if (datasetId === 'core.totp_credentials' && column === 'secret_encrypted')
      overrides[column] = ['text', 'backup-pending'];
    else if (datasetId === 'pii.pii_log' && ['encryption_key_id', 'encryption_iv'].includes(column))
      overrides[column] = ['text', 'backup-pending'];
    else overrides[column] = ['null', null];
  }
  return overrides;
}

type AdminReferenceRule =
  | { columns: readonly string[] }
  | { subjectTypeColumn: string; subjectIdColumn: string; adminType: string };

/** Operational Admin references that must point at the explicitly mapped target principal. */
export const PHASE8_ADMIN_REFERENCE_RESTORE_RULES: Readonly<Record<string, AdminReferenceRule>> = {
  'admin.admin_agent_grants': { columns: ['grantor_id', 'delegator_id'] },
  'admin.admin_attribute_values': { columns: ['admin_user_id'] },
  'admin.admin_invitations': { columns: ['admin_user_id'] },
  'admin.admin_role_assignments': { columns: ['admin_user_id'] },
  'admin.agent_consents': { columns: ['user_id'] },
  'admin.operational_notification_states': { columns: ['assigned_to'] },
  'admin.review_tasks': { columns: ['assigned_to'] },
  'admin.approval_requests': {
    subjectTypeColumn: 'requester_subject_type',
    subjectIdColumn: 'requester_subject_id',
    adminType: 'admin_user',
  },
  'admin.approval_request_approvals': {
    subjectTypeColumn: 'subject_type',
    subjectIdColumn: 'subject_id',
    adminType: 'admin_user',
  },
};

/** Active plugin-owned account state must use the installation identity derived for the target. */
export const PHASE8_PLUGIN_REFERENCE_RESTORE_DATASETS = [
  'core.plugin_account_metadata',
  'core.plugin_account_metadata_mutations',
  'core.plugin_account_metadata_audit',
] as const;

const pluginReferenceIds = new Set<string>(PHASE8_PLUGIN_REFERENCE_RESTORE_DATASETS);

function invalid(): never {
  throw new Error('backup_phase8_reference_invalid');
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

function optionalAdminReference(
  identity: TenantPortableRecordIdentity,
  value: readonly [string, string | null] | undefined
): TenantPortableDependency[] {
  if (!value || (value[0] === 'null' && value[1] === null)) return [];
  if (value[0] !== 'text' || value[1] === null || !value[1]) invalid();
  return [reference(identity, 'admin.admin_users', [value])];
}

function inspectMappedAdminReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): TenantPortableDependency[] {
  const rule = PHASE8_ADMIN_REFERENCE_RESTORE_RULES[datasetId];
  if (!rule) return [];
  if ('columns' in rule)
    return rule.columns.flatMap((column) => optionalAdminReference(identity, row[column]));
  const type = field(row, rule.subjectTypeColumn);
  if (type[0] !== 'text' || type[1] === null) invalid();
  return type[1] === rule.adminType
    ? optionalAdminReference(identity, row[rule.subjectIdColumn])
    : [];
}

/** Validate physical foreign keys before any restore target is mutated. */
export function inspectPhase8SqliteReferences(
  datasetId: string,
  row: PortableSqliteRow,
  identity: TenantPortableRecordIdentity
): readonly TenantPortableDependency[] {
  if (phase5Ids.has(datasetId)) return inspectPhase5SqliteReferences(datasetId, row, identity);
  if (!phase8Ids.has(datasetId)) invalid();
  const physical = PHASE8_SQLITE_FOREIGN_KEY_RULES.filter(({ from }) => from === datasetId).flatMap(
    ({ columns, to }) => {
      const values = columns.map((column) => field(row, column));
      // SQLite does not enforce a composite FK when any child column is NULL.
      if (values.some(([type, value]) => type === 'null' && value === null)) return [];
      if (values.some(([type, value]) => type === 'null' || value === null)) invalid();
      return [reference(identity, to, values)];
    }
  );
  const mapped = inspectMappedAdminReferences(datasetId, row, identity);
  return [...physical, ...mapped].filter(
    (dependency, index, values) =>
      values.findIndex(
        (candidate) =>
          candidate.to.collection === dependency.to.collection &&
          candidate.to.id === dependency.to.id &&
          candidate.to.requirement === dependency.to.requirement
      ) === index
  );
}

export function phase8SqliteRestoreDependencies(datasetId: string): readonly string[] {
  if (phase5Ids.has(datasetId)) return phase5SqliteRestoreDependencies(datasetId);
  if (!phase8Ids.has(datasetId)) invalid();
  return [
    ...new Set(
      PHASE8_SQLITE_FOREIGN_KEY_RULES.filter(
        ({ from, to }) => from === datasetId && to !== from
      ).map(({ to }) => to)
    ),
  ].sort();
}

function phase8RestoreOverrides(
  datasetId: string
): Readonly<Record<string, readonly [string, string | null]>> | undefined {
  // Machine principals and their credentials belong to the target environment. A restored
  // tenant grant may retain its mapped human administrators, but never a source machine binding.
  if (datasetId === 'admin.admin_agent_grants') return { machine_principal_id: ['null', null] };
  // A VP request is an authentication transaction and is deliberately not restored. The
  // verification evidence remains valid independently of the nullable request correlation.
  if (datasetId === 'core.attribute_verifications') return { vp_request_id: ['null', null] };
  return undefined;
}

/**
 * Build the complete Phase 8 SQL policy from the sealed installed plan. Earlier settings policies
 * are delegated unchanged, while every added dataset is checked against the pinned registry.
 */
export function createPhase8SqliteInspectionPolicies(
  planned: readonly PlannedInstalledSqliteDataset[],
  input: {
    tenantKey: string;
    validateAdminEnvelope(datasetId: string, row: PortableSqliteRow): Promise<void>;
    validatePhase8Envelope(datasetId: string, row: PortableSqliteRow): Promise<void>;
    resolveAdminReference?(
      context: TenantBackupStepContext,
      sourceAdminId: string
    ): Promise<string>;
    resolvePluginReference?(
      context: TenantBackupStepContext,
      sourceInstallationId: string,
      pluginId: string
    ): Promise<string>;
    restoreHold?: {
      write(
        context: TenantBackupStepContext,
        input: {
          datasetId: string;
          recordId: string;
          reason: string;
          rowJson: string;
        }
      ): Promise<void>;
      verify(
        context: TenantBackupStepContext,
        input: {
          datasetId: string;
          recordId: string;
          reason: string;
          rowJson: string;
        }
      ): Promise<void>;
    };
  }
): SqliteDatasetInspectionPolicy[] {
  assertEnvironmentTenantKey(input.tenantKey);
  if (
    planned.length !== registrations.size ||
    new Set(planned.map(({ dataset }) => dataset.id)).size !== planned.length
  )
    throw new Error('backup_phase8_plan_incomplete');

  const phase5Planned = planned.filter(({ dataset }) => phase5Ids.has(dataset.id));
  const previousPolicies = new Map(
    createPhase5SqliteInspectionPolicies(phase5Planned, {
      ...input,
      tenantKey: PORTABLE_TENANT_KEY,
    }).map((policy) => [policy.dataset.id, policy])
  );

  const withTargetTenantKey = (
    entry: PlannedInstalledSqliteDataset,
    policy: SqliteDatasetInspectionPolicy
  ): SqliteDatasetInspectionPolicy => {
    const column = portableTenantKeyColumn(entry.capture);
    if (!column) return policy;
    const directTenantKey =
      !('parent' in entry.capture) && entry.capture.tenantIdentity === 'tenantKey';
    const required = directTenantKey || entry.dataset.id === 'core.tenants';
    const target = ['text', input.tenantKey] as const;
    const primaryKey = entry.capture.primaryKey.includes(column);
    const existing = primaryKey
      ? policy.restoreIdentityOverrides?.[column]
      : policy.restoreOverrides?.[column];
    if (existing && JSON.stringify(existing) !== JSON.stringify(target)) invalid();
    const inspectRow = policy.inspectRow;
    const keepProvisioning = entry.dataset.id === 'core.tenants';
    return {
      ...policy,
      ...(directTenantKey
        ? { tenantKey: PORTABLE_TENANT_KEY, restoreTenantKey: input.tenantKey }
        : {}),
      ...(primaryKey
        ? {
            restoreIdentityOverrides: {
              ...policy.restoreIdentityOverrides,
              [column]: target,
            },
          }
        : {
            restoreOverrides: {
              ...policy.restoreOverrides,
              [column]: target,
            },
          }),
      ...(keepProvisioning
        ? {
            restoreOverrides: {
              ...policy.restoreOverrides,
              ...(!primaryKey ? { [column]: target } : {}),
              lifecycle_state: ['text', 'provisioning'] as const,
            },
            verificationIgnoredColumns: [
              ...new Set([...(policy.verificationIgnoredColumns ?? []), 'lifecycle_state']),
            ],
          }
        : {}),
      inspectRow: async (row, identity) => {
        assertPortableTenantKeyRow(entry.capture, row, required);
        return inspectRow(row, identity);
      },
    };
  };

  return planned.map((entry) => {
    const previous = previousPolicies.get(entry.dataset.id);
    if (previous) return withTargetTenantKey(entry, previous);
    const registration = registrations.get(entry.dataset.id);
    if (
      !registration ||
      !phase8Ids.has(entry.dataset.id) ||
      registration.family !== entry.family ||
      registration.table !== entry.table ||
      JSON.stringify(registration.dataset) !== JSON.stringify(entry.dataset) ||
      JSON.stringify(registration.partitions ?? []) !== JSON.stringify(entry.partitions ?? [])
    )
      throw new Error('backup_phase8_plan_mismatch');

    const parentDataset =
      'parent' in entry.capture
        ? byTable.get(`${entry.family}:${entry.capture.parent.schema.table}`)
        : undefined;
    if ('parent' in entry.capture && !parentDataset) invalid();
    const restoreAfter = [
      ...new Set([
        ...phase8SqliteRestoreDependencies(entry.dataset.id),
        ...(parentDataset && parentDataset.id !== entry.dataset.id ? [parentDataset.id] : []),
      ]),
    ].sort();
    const sensitiveOverrides = phase8SensitiveRestoreOverrides(entry.dataset.id);
    const restoreOverrides = phase8RestoreOverrides(entry.dataset.id) ?? sensitiveOverrides;
    const adminReferenceRule = PHASE8_ADMIN_REFERENCE_RESTORE_RULES[entry.dataset.id];
    const resolveAdminReference = input.resolveAdminReference?.bind(input);
    if (adminReferenceRule && !resolveAdminReference)
      throw new Error('backup_phase8_admin_mapping_missing');

    const adminRestoreTransform = adminReferenceRule
      ? {
          id: `phase8-restore-v1:${entry.dataset.id}`,
          async transform(
            context: TenantBackupStepContext,
            rowJson: string,
            _mode: 'write' | 'defer' | 'verify'
          ): Promise<string> {
            let transformed = rowJson;
            const parsed = JSON.parse(transformed) as Record<
              string,
              readonly [string, string | null]
            >;
            const map = async (column: string) => {
              const value = parsed[column];
              if (!value || (value[0] === 'null' && value[1] === null)) return;
              if (value[0] !== 'text' || value[1] === null || !value[1]) invalid();
              if (!resolveAdminReference) invalid();
              parsed[column] = ['text', await resolveAdminReference(context, value[1])] as const;
            };
            if ('columns' in adminReferenceRule)
              for (const column of adminReferenceRule.columns) await map(column);
            else {
              const type = parsed[adminReferenceRule.subjectTypeColumn];
              if (type?.[0] !== 'text' || type[1] === null) invalid();
              if (type[1] === adminReferenceRule.adminType)
                await map(adminReferenceRule.subjectIdColumn);
            }
            transformed = JSON.stringify(parsed);
            return transformed;
          },
        }
      : undefined;
    const pluginReferenceRule = pluginReferenceIds.has(entry.dataset.id);
    const resolvePluginReference = input.resolvePluginReference?.bind(input);
    if (pluginReferenceRule && !resolvePluginReference)
      throw new Error('backup_phase8_plugin_mapping_missing');
    const pluginRestoreTransform = pluginReferenceRule
      ? {
          id: `phase8-plugin-restore-v1:${entry.dataset.id}`,
          async transform(
            context: TenantBackupStepContext,
            rowJson: string,
            _mode: 'write' | 'defer' | 'verify'
          ): Promise<string> {
            const parsed = JSON.parse(rowJson) as Record<string, readonly [string, string | null]>;
            const installation = parsed.plugin_installation_id;
            const plugin = parsed.plugin_id;
            if (
              installation?.[0] !== 'text' ||
              installation[1] === null ||
              !installation[1] ||
              plugin?.[0] !== 'text' ||
              plugin[1] === null ||
              !plugin[1] ||
              !resolvePluginReference
            )
              invalid();
            parsed.plugin_installation_id = [
              'text',
              await resolvePluginReference(context, installation[1], plugin[1]),
            ];
            return JSON.stringify(parsed);
          },
        }
      : undefined;
    if (adminRestoreTransform && pluginRestoreTransform) invalid();
    const restoreTransform = adminRestoreTransform ?? pluginRestoreTransform;
    const holdRule = PHASE8_RESTORE_HOLD_RULES[entry.dataset.id];
    if (holdRule && !input.restoreHold) throw new Error('backup_phase8_restore_hold_missing');
    const holdInput = (rowJson: string) => {
      const reason = phase8RestoreHoldReason(entry.dataset.id, rowJson);
      if (!reason) throw new Error('backup_phase8_restore_hold_invalid');
      return {
        datasetId: entry.dataset.id,
        recordId: phase8RestoreHoldRecordId(entry.capture, rowJson),
        reason,
        rowJson,
      };
    };
    const restoreHold = holdRule
      ? {
          id: `phase8-hold-v1:${entry.dataset.id}`,
          async shouldHold(_context: TenantBackupStepContext, rowJson: string) {
            return phase8RestoreHoldReason(entry.dataset.id, rowJson) !== null;
          },
          async write(context: TenantBackupStepContext, rowJson: string) {
            if (!input.restoreHold) invalid();
            await input.restoreHold.write(context, holdInput(rowJson));
          },
          async verify(context: TenantBackupStepContext, rowJson: string) {
            if (!input.restoreHold) invalid();
            await input.restoreHold.verify(context, holdInput(rowJson));
          },
        }
      : undefined;

    return withTargetTenantKey(entry, {
      dataset: structuredClone(entry.dataset),
      schema: structuredClone(entry.capture),
      ...(restoreAfter.length ? { restoreAfter } : {}),
      ...(restoreOverrides ? { restoreOverrides } : {}),
      ...(restoreOverrides ? { verificationIgnoredColumns: Object.keys(restoreOverrides) } : {}),
      ...(entry.dataset.id === 'admin.admin_users'
        ? { restoreDisposition: 'reference_only' as const }
        : {}),
      ...(restoreTransform ? { restoreTransform } : {}),
      ...(restoreHold ? { restoreHold } : {}),
      ...(entry.capture.tenantIdentity === 'tenantKey' ? { tenantKey: PORTABLE_TENANT_KEY } : {}),
      ...(parentDataset
        ? { parentDataset: { id: parentDataset.id, module: parentDataset.module } }
        : {}),
      ...(entry.partitions ? { partitions: [...entry.partitions] } : {}),
      inspectRow: async (row, identity) => {
        if (sensitiveIds.has(entry.dataset.id))
          await input.validatePhase8Envelope(entry.dataset.id, row);
        return inspectPhase8SqliteReferences(entry.dataset.id, row, identity);
      },
    });
  });
}

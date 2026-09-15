import type { PortableSqliteRow } from './sqlite-dataset-inspector.js';
import { tenantBackupLogWindow, type TenantBackupSelection } from './selection-contract.js';

/** Installed event-time columns. A schema change must choose a timestamp explicitly. */
export const PHASE8_LOG_TIMESTAMP_COLUMNS: Readonly<Record<string, string>> = {
  'admin.admin_audit_log': 'created_at',
  'admin.admin_destination_health_events': 'checked_at',
  'admin.admin_login_attempts': 'created_at',
  'admin.federation_metadata_validation_events': 'created_at',
  'admin.federation_selected_entity_import_events': 'created_at',
  'admin.key_access_events': 'created_at',
  'admin.logging_delivery_event_aggregates': 'bucket_start_at',
  'admin.logging_delivery_events': 'created_at',
  'admin.logging_destination_override_history': 'changed_at',
  'admin.mapping_events': 'created_at',
  'core.audit_log': 'created_at',
  'core.consent_history': 'created_at',
  'core.consent_item_history': 'created_at',
  'core.custom_claim_schema_history': 'created_at',
  'core.directory_auth_config_history': 'created_at',
  'core.directory_auth_migration_transaction_events': 'created_at',
  'core.directory_connector_status_episodes': 'started_at',
  'core.event_log': 'created_at',
  'core.external_lifecycle_signal_events': 'source_timestamp',
  'core.flow_audit_events': 'created_at',
  'core.identity_resolution_events': 'created_at',
  'core.legal_hold_events': 'effective_at',
  'core.operational_logs': 'created_at',
  'core.permission_change_audit': 'timestamp',
  'core.permission_check_audit': 'checked_at',
  'core.plugin_account_metadata_audit': 'created_at',
  'core.provisioning_assignment_events': 'created_at',
  'core.provisioning_revocation_events': 'created_at',
  'core.service_group_audit': 'created_at',
  'core.settings_history': 'created_at',
  'core.subject_lifecycle_timeline_events': 'event_at',
  'core.webhook_delivery_logs': 'created_at',
  'pii.audit_log_pii': 'created_at',
  'pii.identity_identifier_replacement_history': 'created_at',
  'pii.pii_log': 'created_at',
  'plugin_runner.plugin_runner_egress_audit': 'created_at',
};

const PHASE8_LOG_DEPENDENCY_DATASETS = new Set([
  'admin.log_chunk_manifests',
  'admin.log_chunk_record_index',
  'admin.log_object_catalog',
  'admin.sensitive_detail_chunk_index',
  'core.log_chunk_manifests',
  'core.log_chunk_record_index',
  'core.log_object_catalog',
  'core.sensitive_detail_chunk_index',
]);

const AUDIT_LOG_TYPES = new Set(['audit', 'admin_audit', 'security']);
const OTHER_LOG_TYPES = new Set(['normal', 'diagnostic', 'job', 'webhook', 'operational']);
const AUDIT_DETAIL_CLASSES = new Set(['admin_audit_detail']);
const OTHER_DETAIL_CLASSES = new Set(['event_log_detail', 'operational_log_detail']);

function invalid(): never {
  throw new Error('backup_phase8_log_timestamp_invalid');
}

export function parsePhase8PortableSqliteRow(rowJson: string): PortableSqliteRow {
  try {
    const row: unknown = JSON.parse(rowJson);
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid();
    return row as PortableSqliteRow;
  } catch {
    return invalid();
  }
}

/** Apply the one pinned bundle boundary to every page; malformed timestamps fail closed. */
export function phase8LogRowInWindow(input: {
  datasetId: string;
  row: PortableSqliteRow;
  period: TenantBackupSelection['logs']['period'];
  boundaryUnixMs: number;
}): boolean {
  const column = PHASE8_LOG_TIMESTAMP_COLUMNS[input.datasetId];
  if (!column) invalid();
  const value = input.row[column];
  if (value?.[0] !== 'integer' || value[1] === null || !/^(0|[1-9][0-9]{0,15})$/.test(value[1]))
    invalid();
  const timestamp = Number(value[1]);
  if (!Number.isSafeInteger(timestamp)) invalid();
  const window = tenantBackupLogWindow(input.period, input.boundaryUnixMs);
  return (
    timestamp <= window.untilInclusiveUnixMs &&
    (window.fromInclusiveUnixMs === null || timestamp >= window.fromInclusiveUnixMs)
  );
}

function text(row: PortableSqliteRow, column: string): string {
  const value = row[column];
  if (value?.[0] !== 'text' || value[1] === null || !value[1]) invalid();
  return value[1];
}

function integer(row: PortableSqliteRow, column: string): number {
  const value = row[column];
  if (value?.[0] !== 'integer' || value[1] === null || !/^(0|[1-9][0-9]{0,15})$/.test(value[1]))
    invalid();
  const result = Number(value[1]);
  if (!Number.isSafeInteger(result)) invalid();
  return result;
}

function logTypeSelected(
  logType: string,
  selection: TenantBackupSelection,
  sensitiveDetail: boolean
): boolean {
  if (AUDIT_LOG_TYPES.has(logType))
    return selection.logs.audit && (!sensitiveDetail || selection.logs.sensitive);
  if (OTHER_LOG_TYPES.has(logType))
    return selection.logs.other && (!sensitiveDetail || selection.logs.sensitive);
  if (logType === 'pii') return selection.logs.sensitive;
  return invalid();
}

function detailClassSelection(
  objectClass: string,
  selection: TenantBackupSelection
): { selected: boolean; timeFiltered: boolean } {
  if (AUDIT_DETAIL_CLASSES.has(objectClass))
    return { selected: selection.logs.audit && selection.logs.sensitive, timeFiltered: true };
  if (OTHER_DETAIL_CLASSES.has(objectClass))
    return { selected: selection.logs.other && selection.logs.sensitive, timeFiltered: true };
  if (objectClass === 'approval_transport_detail')
    return { selected: selection.admin, timeFiltered: false };
  if (objectClass === 'webhook_delivery_payload')
    return { selected: selection.users, timeFiltered: false };
  // PII log R2 values are converted into the encrypted bundle row and restored under target keys.
  if (objectClass === 'pii_log_values') return { selected: false, timeFiltered: false };
  return invalid();
}

/** Filter mixed log catalogs without copying rows from unselected log categories. */
export function phase8LogDependencyRowInSelection(input: {
  datasetId: string;
  row: PortableSqliteRow;
  selection: TenantBackupSelection;
  boundaryUnixMs: number;
}): boolean {
  if (!PHASE8_LOG_DEPENDENCY_DATASETS.has(input.datasetId)) invalid();
  const window = tenantBackupLogWindow(input.selection.logs.period, input.boundaryUnixMs);
  if (input.datasetId.endsWith('.sensitive_detail_chunk_index')) {
    const detail = detailClassSelection(text(input.row, 'object_class'), input.selection);
    if (!detail.selected) return false;
    if (!detail.timeFiltered) return true;
    const createdAt = integer(input.row, 'created_at');
    return (
      createdAt <= window.untilInclusiveUnixMs &&
      (window.fromInclusiveUnixMs === null || createdAt >= window.fromInclusiveUnixMs)
    );
  }
  const selected = logTypeSelected(
    text(input.row, 'log_type'),
    input.selection,
    text(input.row, 'plane') === 'sensitive_detail'
  );
  if (!selected) return false;
  if (input.datasetId.endsWith('.log_chunk_manifests')) {
    const from = integer(input.row, 'bucket_start_at');
    const until = integer(input.row, 'bucket_end_at');
    if (until < from) invalid();
    return (
      from <= window.untilInclusiveUnixMs &&
      (window.fromInclusiveUnixMs === null || until >= window.fromInclusiveUnixMs)
    );
  }
  const timestamp = integer(
    input.row,
    input.datasetId.endsWith('.log_chunk_record_index') ? 'event_at' : 'created_at'
  );
  return (
    timestamp <= window.untilInclusiveUnixMs &&
    (window.fromInclusiveUnixMs === null || timestamp >= window.fromInclusiveUnixMs)
  );
}

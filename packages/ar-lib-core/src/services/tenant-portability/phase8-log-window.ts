import type { PortableSqliteRow } from './sqlite-dataset-inspector.js';
import { tenantBackupLogWindow, type TenantBackupSelection } from './selection-contract.js';

/**
 * How one log table stores its event time: Unix milliseconds, Unix seconds, or ISO 8601 text.
 * The window is computed in milliseconds, so every value is converted before it is compared.
 */
export type Phase8LogTimestampUnit = 'ms' | 's' | 'iso8601';

export interface Phase8LogTimestampColumn {
  readonly column: string;
  readonly unit: Phase8LogTimestampUnit;
}

const ms = (column: string): Phase8LogTimestampColumn => ({ column, unit: 'ms' });
const seconds = (column: string): Phase8LogTimestampColumn => ({ column, unit: 's' });

/**
 * Installed event-time columns and the unit their writers store. A schema change must choose a
 * timestamp and its unit explicitly: comparing seconds with the millisecond window would drop
 * every row of the table from a 7/30/90-day backup.
 */
export const PHASE8_LOG_TIMESTAMP_COLUMNS: Readonly<Record<string, Phase8LogTimestampColumn>> = {
  'admin.admin_audit_log': ms('created_at'),
  'admin.identity_mapping_level_history': ms('created_at'),
  'admin.admin_destination_health_events': ms('checked_at'),
  'admin.admin_login_attempts': ms('created_at'),
  'admin.federation_metadata_validation_events': ms('created_at'),
  'admin.federation_selected_entity_import_events': ms('created_at'),
  'admin.key_access_events': ms('created_at'),
  'admin.logging_delivery_event_aggregates': ms('bucket_start_at'),
  'admin.logging_delivery_events': ms('created_at'),
  'admin.logging_destination_override_history': ms('changed_at'),
  'admin.mapping_events': ms('created_at'),
  // utils/audit-log.ts writes Math.floor(createdAtMs / 1000).
  'core.audit_log': seconds('created_at'),
  'core.consent_history': ms('created_at'),
  'core.consent_item_history': ms('created_at'),
  'core.custom_claim_schema_history': seconds('created_at'),
  'core.directory_auth_config_history': ms('created_at'),
  'core.directory_auth_migration_transaction_events': ms('created_at'),
  'core.directory_connector_status_episodes': ms('started_at'),
  'core.event_log': ms('created_at'),
  // source_timestamp is the sender's optional claim (nullable, unit not enforced); observed_at is
  // when this deployment recorded the signal and is always set.
  'core.external_lifecycle_signal_events': ms('observed_at'),
  'core.flow_audit_events': seconds('created_at'),
  'core.identity_resolution_events': ms('created_at'),
  'core.legal_hold_events': ms('effective_at'),
  'core.operational_logs': seconds('created_at'),
  // This table's created_at is seconds, but `timestamp` (the event time) is milliseconds.
  'core.permission_change_audit': ms('timestamp'),
  'core.permission_check_audit': seconds('checked_at'),
  'core.plugin_account_metadata_audit': seconds('created_at'),
  'core.provisioning_assignment_events': ms('created_at'),
  'core.provisioning_revocation_events': ms('created_at'),
  'core.service_group_audit': ms('created_at'),
  'core.settings_history': seconds('created_at'),
  'core.subject_lifecycle_timeline_events': ms('event_at'),
  // The schema declares created_at TEXT NOT NULL; no current writer remains.
  'core.webhook_delivery_logs': { column: 'created_at', unit: 'iso8601' },
  'pii.audit_log_pii': ms('created_at'),
  'pii.identity_identifier_replacement_history': seconds('created_at'),
  'pii.pii_log': ms('created_at'),
  'plugin_runner.plugin_runner_egress_audit': seconds('created_at'),
};

/**
 * SQLite datetime()/strftime('%f') text or JavaScript toISOString(). Fractions are limited to
 * milliseconds so that no instant past the window's last millisecond rounds into it.
 */
const ISO8601_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):?(\d{2}))?$/u;

/** Parse calendar fields strictly; Date.parse silently rolls 2026-02-30 over to March. */
function iso8601TimestampMs(text: string): number {
  const match = ISO8601_TIMESTAMP.exec(text);
  if (!match) invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millisecond = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    invalid();
  let offsetMinutes = 0;
  // No zone designator: SQLite's datetime() text is UTC.
  if (match[8] && match[8] !== 'Z') {
    const offsetHours = Number(match[10]);
    const offsetRest = Number(match[11]);
    if (offsetHours > 23 || offsetRest > 59) invalid();
    offsetMinutes = (match[9] === '-' ? -1 : 1) * (offsetHours * 60 + offsetRest);
  }
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, millisecond);
  const result = utc.getTime() - offsetMinutes * 60_000;
  if (!Number.isSafeInteger(result) || result < 0) invalid();
  return result;
}

/** Event time of one log row in Unix milliseconds; malformed values fail closed. */
function phase8LogRowTimestampMs(
  row: PortableSqliteRow,
  timestamp: Phase8LogTimestampColumn
): number {
  const value = row[timestamp.column];
  if (timestamp.unit === 'iso8601') {
    if (value?.[0] !== 'text' || value[1] === null) invalid();
    return iso8601TimestampMs(value[1]);
  }
  if (value?.[0] !== 'integer' || value[1] === null || !/^(0|[1-9][0-9]{0,15})$/.test(value[1]))
    invalid();
  const stored = Number(value[1]);
  const result = timestamp.unit === 's' ? stored * 1000 : stored;
  if (!Number.isSafeInteger(stored) || !Number.isSafeInteger(result)) invalid();
  return result;
}

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
  const column = Object.hasOwn(PHASE8_LOG_TIMESTAMP_COLUMNS, input.datasetId)
    ? PHASE8_LOG_TIMESTAMP_COLUMNS[input.datasetId]
    : undefined;
  if (!column) invalid();
  const timestamp = phase8LogRowTimestampMs(input.row, column);
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
  // Log chunks are carried whole when any of their events lies in the window. Their catalog and
  // record index rows follow the chunk through the R2 reference closure, not their own times, so
  // the restored index matches the restored body. Only committed index rows describe the body.
  if (input.datasetId.endsWith('.log_chunk_record_index'))
    return text(input.row, 'status') === 'committed';
  return true;
}

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

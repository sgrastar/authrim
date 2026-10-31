import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import type { LogIcebergRowWrite } from '../log-iceberg-emitter';
import {
  decryptLogIcebergRecord,
  logIcebergCanonicalJson,
  type LogIcebergRecordKeys,
} from '../log-iceberg-record';
import {
  decodeLogIcebergRow,
  decryptProtectedLogIcebergDetail,
  normalizeAdminInlineMetadata,
} from '../log-iceberg-row-codec';
import { assertLogIcebergPiiSubject } from '../log-iceberg-erasure-filter';
import { LOG_ICEBERG_ROW_BODY_SCHEMA } from '../log-iceberg-record';
import type { TenantPortableDataset } from './module-contract';
import { tenantBackupLogWindow, type TenantBackupSelection } from './selection-contract';
import type { PortableSqliteRow, SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';

export const ICEBERG_LOG_RECORDS_DATASETS = [
  {
    id: 'logs.iceberg_audit_records',
    module: 'logs',
    kind: 'audit',
    store: 'object',
    schemaVersion: 1,
    disposition: 'include',
  },
  {
    id: 'logs.iceberg_other_records',
    module: 'logs',
    kind: 'history',
    store: 'object',
    schemaVersion: 1,
    disposition: 'include',
  },
  {
    id: 'logs.iceberg_sensitive_records',
    module: 'logs',
    kind: 'sensitive_logs',
    store: 'object',
    schemaVersion: 1,
    disposition: 'include',
  },
] as const satisfies readonly TenantPortableDataset[];
export type IcebergLogRecordDatasetId = (typeof ICEBERG_LOG_RECORDS_DATASETS)[number]['id'];
export type IcebergLogCategory = 'audit' | 'other' | 'sensitive';
export const ICEBERG_LOG_CATEGORIES = ['audit', 'other', 'sensitive'] as const;
export function icebergLogCategory(
  record: Pick<LogArchiveRecord, 'source_dataset' | 'log_type'>
): IcebergLogCategory {
  if (!SOURCES.has(record.source_dataset)) invalid();
  return ['pii.pii_log', 'pii.audit_log_pii'].includes(record.source_dataset)
    ? 'sensitive'
    : ['audit', 'admin_audit', 'security'].includes(record.log_type)
      ? 'audit'
      : 'other';
}
export function icebergLogDatasetCategory(datasetId: string): IcebergLogCategory {
  const index = ICEBERG_LOG_RECORDS_DATASETS.findIndex((dataset) => dataset.id === datasetId);
  return ICEBERG_LOG_CATEGORIES[index] ?? invalid();
}
export const ICEBERG_LOG_SOURCE_DATASETS = [
  'core.event_log',
  'core.audit_log',
  'core.operational_logs',
  'core.flow_audit_events',
  'core.permission_change_audit',
  'core.permission_check_audit',
  'core.provisioning_assignment_events',
  'core.provisioning_revocation_events',
  'core.service_group_audit',
  'core.directory_auth_migration_transaction_events',
  'admin.admin_audit_log',
  'admin.identity_mapping_level_history',
  'admin.federation_selected_entity_import_events',
  'admin.key_access_events',
  'admin.mapping_events',
  'pii.pii_log',
  'pii.audit_log_pii',
  'diagnostic.diagnostic_log',
  'diagnostic.ingest_events',
  'runtime.admin_job_events',
  'runtime.webhook_delivery_events',
] as const;
const SOURCES: ReadonlySet<string> = new Set(ICEBERG_LOG_SOURCE_DATASETS);
const OVERVIEW = [
  'action',
  'result',
  'severity',
  'reason_code',
  'request_id',
  'subject_id',
  'client_id',
  'resource_id',
] as const;
const FORMAT = 'authrim.log.iceberg-portable.v1';
const MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
function invalid(): never {
  throw new Error('backup_iceberg_log_record_invalid');
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value || encoder.encode(value).byteLength > limit) invalid();
  return value;
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function field(row: PortableSqliteRow, key: string): string {
  const value = row[key];
  if (value?.[0] !== 'text' || typeof value[1] !== 'string') invalid();
  return value[1];
}

/** Matches the existing audit/other/sensitive selection and one immutable T0 window. */
export function icebergLogSelected(
  record: Pick<LogArchiveRecord, 'source_dataset' | 'log_type' | 'event_at' | 'expires_at'>,
  selection: TenantBackupSelection,
  boundaryUnixMs: number
): boolean {
  if (!SOURCES.has(record.source_dataset)) invalid();
  time(boundaryUnixMs);
  const selected = selection.logs[icebergLogCategory(record)];
  const window = tenantBackupLogWindow(selection.logs.period, boundaryUnixMs);
  return (
    selected &&
    record.event_at <= window.untilInclusiveUnixMs &&
    (window.fromInclusiveUnixMs === null || record.event_at >= window.fromInclusiveUnixMs) &&
    (record.expires_at === null || record.expires_at > boundaryUnixMs)
  );
}

/** Called inside the authorized DR exporter. The existing DR container encrypts
 * these logical records independently; shared Parquet files and source keys are never copied. */
export async function encodePortableIcebergLog(input: {
  record: LogArchiveRecord;
  tenantId: string;
  tenantKey: string;
  resolveKeys: (version: number) => Promise<LogIcebergRecordKeys>;
  includeSensitiveDetails: boolean;
}): Promise<Uint8Array> {
  const { record, tenantId, tenantKey } = input;
  if (!SOURCES.has(record.source_dataset)) invalid();
  assertLogIcebergPiiSubject(record.source_dataset, record.subject_id);
  const body = await decryptLogIcebergRecord(
    record,
    { tenantKey, sourceDataset: record.source_dataset },
    input.resolveKeys
  );
  const row = decodeLogIcebergRow(body, tenantId, record.event_id);
  const protectedDetail = input.includeSensitiveDetails
    ? await decryptProtectedLogIcebergDetail({ record, body, resolveKeys: input.resolveKeys })
    : null;
  row.detail_object_catalog_id = null;
  if (record.source_dataset === 'pii.pii_log') row.values_r2_key = null;
  const overview = Object.fromEntries(OVERVIEW.map((key) => [key, record[key]]));
  const portable = {
    format: FORMAT,
    source_dataset: record.source_dataset,
    log_type: record.log_type,
    event_id: record.event_id,
    event_at: record.event_at,
    ingested_at: record.ingested_at,
    expires_at: record.expires_at,
    overview,
    row,
    protected_detail: protectedDetail,
  };
  const encoded: PortableSqliteRow = {
    tenant_id: ['text', tenantId],
    source_dataset: ['text', record.source_dataset],
    event_id: ['text', record.event_id],
    record_json: ['text', logIcebergCanonicalJson(portable)],
  };
  const bytes = encoder.encode(JSON.stringify(encoded) + '\n');
  if (bytes.byteLength > MAX_BYTES) invalid();
  // Validate the same representation the target will receive, including identity scope.
  decodePortableIcebergLog(JSON.stringify(encoded), tenantId);
  return bytes;
}

/** Reconstructs producer input for target encryption, tenant identity and storage generation. */
export function decodePortableIcebergLog(rowJson: string, tenantId: string): LogIcebergRowWrite {
  if (encoder.encode(rowJson).byteLength > MAX_BYTES) invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(rowJson);
  } catch {
    invalid();
  }
  const envelope = keys(raw, ['tenant_id', 'source_dataset', 'event_id', 'record_json']);
  // Validate scalar tuples through the existing row contract before reading them.
  const portableRow: Record<string, readonly [string, string | null]> = {};
  for (const key of Object.keys(envelope)) {
    const value = envelope[key];
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value[0] !== 'text' ||
      typeof value[1] !== 'string'
    )
      invalid();
    portableRow[key] = ['text', value[1]];
  }
  if (field(portableRow, 'tenant_id') !== tenantId) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(field(portableRow, 'record_json'));
  } catch {
    invalid();
  }
  const value = keys(parsed, [
    'format',
    'source_dataset',
    'log_type',
    'event_id',
    'event_at',
    'ingested_at',
    'expires_at',
    'overview',
    'row',
    'protected_detail',
  ]);
  if (value.format !== FORMAT) invalid();
  const sourceDataset = text(value.source_dataset, 128),
    eventId = text(value.event_id, 256),
    logType = text(value.log_type, 128);
  if (
    !SOURCES.has(sourceDataset) ||
    sourceDataset !== field(portableRow, 'source_dataset') ||
    eventId !== field(portableRow, 'event_id')
  )
    invalid();
  const row = decodeLogIcebergRow(
    { format: LOG_ICEBERG_ROW_BODY_SCHEMA, row: value.row },
    tenantId,
    eventId
  );
  const rawOverview = keys(value.overview, OVERVIEW);
  const overview: NonNullable<LogIcebergRowWrite['overview']> = {};
  for (const key of OVERVIEW) {
    const field = rawOverview[key];
    if (field !== null && (typeof field !== 'string' || encoder.encode(field).byteLength > 1024))
      invalid();
    overview[key] = field;
  }
  assertLogIcebergPiiSubject(sourceDataset, overview.subject_id ?? null);
  const detail = value.protected_detail;
  if (detail !== null && !object(detail)) invalid();
  if (
    detail !== null &&
    encoder.encode(logIcebergCanonicalJson(detail)).byteLength > 2 * 1024 * 1024
  )
    invalid();
  let protectedDetail = detail ?? undefined;
  let adminInlineMetadata: Record<string, unknown> | undefined;
  if (sourceDataset === 'admin.admin_audit_log') {
    if (typeof row.metadata_json === 'string') {
      const projection: unknown = JSON.parse(row.metadata_json);
      if (!object(projection)) invalid();
      adminInlineMetadata = normalizeAdminInlineMetadata(projection);
    }
    if (detail !== null) {
      const full = keys(detail, ['before_json', 'after_json', 'metadata_json']);
      for (const name of ['before_json', 'after_json', 'metadata_json']) {
        if (full[name] !== null && typeof full[name] !== 'string') invalid();
        row[name] = full[name];
      }
    } else {
      row.before_json = null;
      row.after_json = null;
      row.metadata_json = null;
    }
    protectedDetail = undefined;
  } else if (sourceDataset === 'pii.pii_log') {
    if (row.values_encrypted !== null && row.values_encrypted !== undefined) invalid();
    if (detail !== null) keys(detail, ['values']);
  } else if (sourceDataset === 'core.operational_logs') {
    if (row.reason_detail_encrypted !== null && row.reason_detail_encrypted !== undefined)
      invalid();
    if (detail !== null) text(keys(detail, ['reason_detail']).reason_detail, 2 * 1024 * 1024);
  } else if (detail !== null) {
    invalid();
  }
  // Physical references are rebuilt by the target encoder and never trusted from the bundle.
  row.detail_object_catalog_id = null;
  if (sourceDataset === 'pii.pii_log') {
    row.values_encrypted = null;
    row.values_r2_key = null;
  }
  if (sourceDataset === 'core.operational_logs') {
    row.reason_detail_encrypted = null;
    row.encryption_key_version = 0;
  }
  return {
    tenantId,
    sourceDataset,
    logType,
    eventAt: time(value.event_at),
    ingestedAt: time(value.ingested_at),
    expiresAt: value.expires_at === null ? null : time(value.expires_at),
    overview,
    row,
    protectedDetail,
    adminInlineMetadata,
  };
}

export function createIcebergLogRecordDatasetPolicy(
  datasetId: IcebergLogRecordDatasetId
): SqliteDatasetInspectionPolicy {
  const category = icebergLogDatasetCategory(datasetId);
  const dataset =
    ICEBERG_LOG_RECORDS_DATASETS.find((dataset) => dataset.id === datasetId) ?? invalid();
  return {
    dataset: structuredClone(dataset),
    schema: {
      table: 'tenant_iceberg_log_backup',
      tenantColumn: 'tenant_id',
      columns: ['tenant_id', 'source_dataset', 'event_id', 'record_json'],
      primaryKey: ['tenant_id', 'source_dataset', 'event_id'],
      uniqueKeys: [],
    },
    async inspectRow(row) {
      const record = decodePortableIcebergLog(JSON.stringify(row), field(row, 'tenant_id'));
      if (
        icebergLogCategory({ source_dataset: record.sourceDataset, log_type: record.logType }) !==
        category
      )
        invalid();
      return [];
    },
  };
}

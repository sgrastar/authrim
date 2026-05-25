import type { LogPlane, LogType } from './registry';

export const ARCHIVE_LOG_RECORD_SCHEMA_V1 = 'authrim.log.archive.v1' as const;

export type ArchiveLogRecordSchema = typeof ARCHIVE_LOG_RECORD_SCHEMA_V1;

export interface ArchiveLogDetailRef {
  object_catalog_id: string;
  artifact_id?: string | null;
  class: string;
}

export interface ArchiveLogRecordV1 {
  schema_version: ArchiveLogRecordSchema;
  record_type: 'log_record';
  id: string;
  tenant_key: string;
  log_type: LogType;
  plane: Extract<LogPlane, 'archive' | 'external_sink'>;
  surface?: string;
  time: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  type: string;
  source: string;
  subject?: string | null;
  correlation?: {
    request_id?: string | null;
    correlation_id?: string | null;
    session_id_hash?: string | null;
  };
  actor?: Record<string, unknown> | null;
  resource?: Record<string, unknown> | null;
  result?: string | null;
  summary: Record<string, unknown>;
  detail_ref?: ArchiveLogDetailRef | null;
  delivery: {
    target_type: string;
    destination_id?: string | null;
    target_ref?: string | null;
  };
  authrim: {
    tenant_key: string;
    log_type: LogType;
    plane: LogPlane;
    surface?: string;
  };
}

export const ARCHIVE_LOG_EXPORT_PROJECTION_SCHEMA_V1 = 'authrim.log.export.projection.v1' as const;

export interface ArchiveLogExportProjectionEvidenceV1 {
  object_catalog_id?: string | null;
  chunk_id?: string | null;
  object_key?: string | null;
  line_number?: number | null;
  record_offset?: number | null;
  record_length?: number | null;
  index_profile?: string | null;
}

export interface ArchiveLogExportProjectionV1 {
  schema_version: typeof ARCHIVE_LOG_EXPORT_PROJECTION_SCHEMA_V1;
  projection_type: 'compliance_export_record';
  source_schema_version: ArchiveLogRecordSchema;
  record_id: string;
  tenant_key: string;
  log_type: LogType;
  plane: Extract<LogPlane, 'archive' | 'external_sink'>;
  surface?: string;
  time: string;
  severity: ArchiveLogRecordV1['severity'];
  type: string;
  source: string;
  subject?: string | null;
  correlation?: ArchiveLogRecordV1['correlation'];
  actor?: Record<string, unknown> | null;
  resource?: Record<string, unknown> | null;
  result?: string | null;
  summary: Record<string, unknown>;
  detail_ref?: ArchiveLogDetailRef | null;
  evidence: ArchiveLogExportProjectionEvidenceV1;
}

export interface BuildArchiveLogRecordV1Input {
  id: string;
  tenantKey: string;
  logType: LogType;
  plane?: Extract<LogPlane, 'archive' | 'external_sink'>;
  surface?: string;
  eventAt: number;
  severity?: ArchiveLogRecordV1['severity'];
  type: string;
  source: string;
  subject?: string | null;
  correlationId?: string | null;
  requestId?: string | null;
  actor?: Record<string, unknown> | null;
  resource?: Record<string, unknown> | null;
  result?: string | null;
  summary?: Record<string, unknown>;
  detailRef?: ArchiveLogDetailRef | null;
  delivery: {
    targetType: string;
    destinationId?: string | null;
    targetRef?: string | null;
  };
}

export function buildArchiveLogRecordV1(input: BuildArchiveLogRecordV1Input): ArchiveLogRecordV1 {
  return {
    schema_version: ARCHIVE_LOG_RECORD_SCHEMA_V1,
    record_type: 'log_record',
    id: input.id,
    tenant_key: input.tenantKey,
    log_type: input.logType,
    plane: input.plane ?? 'archive',
    ...(input.surface ? { surface: input.surface } : {}),
    time: new Date(input.eventAt).toISOString(),
    severity: input.severity ?? 'info',
    type: input.type,
    source: input.source,
    subject: input.subject ?? null,
    correlation: {
      request_id: input.requestId ?? null,
      correlation_id: input.correlationId ?? null,
    },
    actor: input.actor ?? null,
    resource: input.resource ?? null,
    result: input.result ?? null,
    summary: input.summary ?? {},
    detail_ref: input.detailRef ?? null,
    delivery: {
      target_type: input.delivery.targetType,
      destination_id: input.delivery.destinationId ?? null,
      target_ref: input.delivery.targetRef ?? null,
    },
    authrim: {
      tenant_key: input.tenantKey,
      log_type: input.logType,
      plane: input.plane ?? 'archive',
      ...(input.surface ? { surface: input.surface } : {}),
    },
  };
}

export function isArchiveLogRecordV1(value: unknown): value is ArchiveLogRecordV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ArchiveLogRecordV1>;
  return (
    candidate.schema_version === ARCHIVE_LOG_RECORD_SCHEMA_V1 &&
    candidate.record_type === 'log_record' &&
    typeof candidate.id === 'string' &&
    typeof candidate.tenant_key === 'string' &&
    typeof candidate.log_type === 'string' &&
    typeof candidate.plane === 'string' &&
    typeof candidate.time === 'string' &&
    typeof candidate.summary === 'object'
  );
}

export function projectArchiveLogRecordForExportV1(
  record: ArchiveLogRecordV1,
  evidence: ArchiveLogExportProjectionEvidenceV1 = {}
): ArchiveLogExportProjectionV1 {
  return {
    schema_version: ARCHIVE_LOG_EXPORT_PROJECTION_SCHEMA_V1,
    projection_type: 'compliance_export_record',
    source_schema_version: record.schema_version,
    record_id: record.id,
    tenant_key: record.tenant_key,
    log_type: record.log_type,
    plane: record.plane,
    ...(record.surface ? { surface: record.surface } : {}),
    time: record.time,
    severity: record.severity,
    type: record.type,
    source: record.source,
    subject: record.subject ?? null,
    correlation: record.correlation,
    actor: record.actor ?? null,
    resource: record.resource ?? null,
    result: record.result ?? null,
    summary: record.summary,
    detail_ref: record.detail_ref ?? null,
    evidence,
  };
}

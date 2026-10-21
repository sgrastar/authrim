import { isObjectClass } from '@authrim/ar-lib-core';
import { tenantBackupLogWindow } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import { LOG_CHUNK_COMPRESSION, LOG_PLANES, LOG_TYPES } from '@authrim/ar-lib-logging/contract';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import type {
  TenantBackupR2ObjectDescriptor,
  TenantBackupR2CatalogKind,
} from './tenant-backup-r2-object-snapshot-port';
import type {
  PortableR2BucketBinding,
  PortableR2DatasetId,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const AUDIT_LOG_TYPES = new Set(['audit', 'admin_audit', 'security']);
const OTHER_LOG_TYPES = new Set(['normal', 'diagnostic', 'job', 'webhook', 'operational']);
const AUDIT_DETAIL_CLASSES = new Set(['admin_audit_detail']);
const OTHER_DETAIL_CLASSES = new Set(['event_log_detail', 'operational_log_detail']);

export type TenantBackupR2SourceFamily = 'core' | 'admin';
export interface TenantBackupR2Source {
  family: TenantBackupR2SourceFamily;
  databaseId: string;
}
type Source = TenantBackupR2Source;

export interface TenantBackupObjectCatalogRow {
  id: string;
  catalog_id: string;
  object_class: string;
  bucket_binding: string;
  object_key: string;
  key_version: number;
  checksum_sha256: string | null;
  total_bytes: number | null;
  sensitive_catalog_id: string | null;
  sensitive_object_class: string | null;
  content_encoding: string | null;
  line_number: number | null;
  byte_offset: number | null;
  byte_length: number | null;
  sensitive_key_version: number | null;
  sensitive_checksum_sha256: string | null;
  sensitive_created_at: number | null;
}

function sensitiveDetailSelected(
  row: TenantBackupObjectCatalogRow,
  context: AdapterContext
): boolean {
  const objectClass = row.sensitive_object_class ?? invalid();
  const selection =
    objectClass === 'pii_log_values'
      ? { selected: false, timeFiltered: false }
      : AUDIT_DETAIL_CLASSES.has(objectClass)
        ? {
            selected: context.selection.logs.audit && context.selection.logs.sensitive,
            timeFiltered: true,
          }
        : OTHER_DETAIL_CLASSES.has(objectClass)
          ? {
              selected: context.selection.logs.other && context.selection.logs.sensitive,
              timeFiltered: true,
            }
          : objectClass === 'approval_transport_detail'
            ? { selected: context.selection.admin, timeFiltered: false }
            : objectClass === 'webhook_delivery_payload'
              ? { selected: context.selection.users, timeFiltered: false }
              : invalid();
  if (!selection.selected) return false;
  if (!selection.timeFiltered) return true;
  const createdAt = integer(row.sensitive_created_at);
  const window = tenantBackupLogWindow(
    context.selection.logs.period,
    integer(context.boundaryUnixMs)
  );
  return (
    createdAt <= window.untilInclusiveUnixMs &&
    (window.fromInclusiveUnixMs === null || createdAt >= window.fromInclusiveUnixMs)
  );
}

export interface TenantBackupLogObjectRow {
  id: string;
  log_type: string;
  plane: string;
  object_key: string;
  record_count: number;
  byte_count: number;
  checksum_sha256: string | null;
  compression: string | null;
  encryption_scope: string | null;
  key_version: number | null;
  created_at: number;
  index_count: number;
  first_event_at: number | null;
  last_event_at: number | null;
  first_chunk_id: string | null;
  last_chunk_id: string | null;
}

export interface TenantBackupHeldPayloadRow {
  id: string;
  payload_object_ref: string;
  payload_sha256: string | null;
  hold_dataset_id: 'admin.logging_dlq_items' | 'admin.logging_message_jobs';
}

function invalid(code = 'backup_r2_catalog_list_invalid'): never {
  throw new Error(code);
}

function integer(value: unknown, allowZero = true): number {
  if (typeof value !== 'number' && typeof value !== 'string') invalid();
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) invalid();
  return parsed;
}

function objectId(source: Source, rowId: string): string {
  if (!SAFE_ID.test(source.databaseId) || !SAFE_ID.test(rowId)) invalid();
  const value = `${source.family}:${source.databaseId}:${rowId}`;
  if (new TextEncoder().encode(value).length > 512) invalid();
  return value;
}

function heldRecordId(id: string): string {
  if (!SAFE_ID.test(id)) invalid();
  return JSON.stringify([['text', id]]);
}

/** Descriptors of open DLQ items and active message jobs, from their T0 rows. */
export function buildTenantBackupHeldPayloadDescriptors(
  context: AdapterContext,
  source: Source,
  tenantId: string,
  tenantKey: string,
  rows: readonly TenantBackupHeldPayloadRow[]
): TenantBackupR2ObjectDescriptor[] {
  if (source.family !== 'admin' || !context.selection.admin) return [];
  return rows.map((row) => {
    context.context.signal.throwIfAborted();
    if (
      !SAFE_ID.test(row.id) ||
      !row.payload_object_ref ||
      new TextEncoder().encode(row.payload_object_ref).length > 1024 ||
      (row.payload_sha256 !== null && !SHA256.test(row.payload_sha256))
    )
      invalid();
    const sourceRowId = `${
      row.hold_dataset_id === 'admin.logging_dlq_items' ? 'held-dlq' : 'held-message'
    }.${row.id}`;
    return {
      datasetId: 'logs.archive_object_bodies',
      objectId: objectId(source, sourceRowId),
      bucketBinding: 'AUDIT_ARCHIVE',
      objectKey: row.payload_object_ref,
      sourceEncoding: 'object_artifact_v1',
      context: {
        tenantId,
        catalogKind: 'restore_hold_payload',
        sourceDatabaseId: source.databaseId,
        sourceFamily: source.family,
        sourceRowId,
        objectClass: 'operational_log_detail',
        encryptionTenantContext: tenantKey,
        holdDatasetId: row.hold_dataset_id,
        holdRecordId: heldRecordId(row.id),
        sourceField: 'payload_object_ref',
        ...(row.payload_sha256 === null ? {} : { expectedPlaintextSha256: row.payload_sha256 }),
      },
    } as TenantBackupR2ObjectDescriptor;
  });
}

function bucketForPlane(plane: string): PortableR2BucketBinding {
  if (!LOG_PLANES.includes(plane as (typeof LOG_PLANES)[number])) invalid();
  if (plane === 'sensitive_detail') return 'SENSITIVE_DETAILS';
  if (plane === 'diagnostic_detail') return 'DIAGNOSTIC_LOGS';
  return 'AUDIT_ARCHIVE';
}

function logTypeSelected(
  logType: string,
  context: AdapterContext,
  sensitiveDetail: boolean
): boolean {
  if (AUDIT_LOG_TYPES.has(logType))
    return context.selection.logs.audit && (!sensitiveDetail || context.selection.logs.sensitive);
  if (OTHER_LOG_TYPES.has(logType))
    return context.selection.logs.other && (!sensitiveDetail || context.selection.logs.sensitive);
  if (logType === 'pii') return context.selection.logs.sensitive;
  return invalid();
}

/** Descriptors of artifact and sensitive-detail bodies, from joined T0 catalog rows. */
export function buildTenantBackupObjectCatalogDescriptors(
  context: AdapterContext,
  source: Source,
  tenantId: string,
  rows: readonly TenantBackupObjectCatalogRow[]
): TenantBackupR2ObjectDescriptor[] {
  return rows
    .map((row) => {
      context.context.signal.throwIfAborted();
      if (
        !isObjectClass(row.object_class) ||
        !['IMPORT_ARTIFACTS', 'EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS'].includes(
          row.bucket_binding
        ) ||
        !row.object_key ||
        new TextEncoder().encode(row.object_key).length > 1024 ||
        !SHA256.test(row.checksum_sha256 ?? '') ||
        integer(row.key_version, false) < 1 ||
        (row.total_bytes !== null && integer(row.total_bytes) < 0)
      )
        invalid();
      const bucketBinding = row.bucket_binding as PortableR2BucketBinding;
      const catalogKind: TenantBackupR2CatalogKind = 'object_catalog_object';
      if (row.sensitive_catalog_id !== null) {
        if (
          row.sensitive_catalog_id !== row.catalog_id ||
          row.sensitive_object_class !== row.object_class ||
          !isObjectClass(row.object_class) ||
          row.bucket_binding !== 'SENSITIVE_DETAILS' ||
          !['gzip', 'none'].includes(row.content_encoding ?? '') ||
          integer(row.line_number) < 0 ||
          (row.byte_offset !== null && integer(row.byte_offset) < 0) ||
          (row.byte_length !== null && integer(row.byte_length, false) < 1) ||
          integer(row.sensitive_key_version, false) < 1 ||
          !SHA256.test(row.sensitive_checksum_sha256 ?? '') ||
          row.sensitive_checksum_sha256 !== row.checksum_sha256
        )
          invalid();
        if (!sensitiveDetailSelected(row, context)) return null;
        return {
          datasetId: 'artifacts.object_catalog_bodies',
          objectId: objectId(source, row.id),
          bucketBinding: 'SENSITIVE_DETAILS',
          objectKey: row.object_key,
          expectedStoredSha256: row.checksum_sha256,
          sourceEncoding: 'sensitive_detail_record_v1',
          context: {
            tenantId,
            catalogKind,
            sourceFamily: source.family,
            sourceDatabaseId: source.databaseId,
            sourceRowId: row.id,
            catalogId: row.catalog_id,
            objectClass: row.object_class,
            contentEncoding: row.content_encoding,
            lineNumber: integer(row.line_number),
            byteOffset: row.byte_offset === null ? null : integer(row.byte_offset),
            byteLength: row.byte_length === null ? null : integer(row.byte_length, false),
            sourceKeyVersion: integer(row.sensitive_key_version, false),
          },
        } as TenantBackupR2ObjectDescriptor;
      }
      if (!context.selection.artifacts) return null;
      return {
        datasetId: 'artifacts.object_catalog_bodies',
        objectId: objectId(source, row.id),
        bucketBinding,
        objectKey: row.object_key,
        expectedStoredSha256: row.checksum_sha256,
        sourceEncoding:
          bucketBinding === 'IMPORT_ARTIFACTS'
            ? ('plaintext' as const)
            : ('object_artifact_v1' as const),
        context: {
          tenantId,
          catalogKind,
          sourceFamily: source.family,
          sourceDatabaseId: source.databaseId,
          sourceRowId: row.id,
          catalogId: row.catalog_id,
          objectClass: row.object_class,
          sourceKeyVersion: integer(row.key_version, false),
        },
      } as TenantBackupR2ObjectDescriptor;
    })
    .filter((row): row is TenantBackupR2ObjectDescriptor => row !== null);
}

/**
 * Whole-chunk descriptors of committed log chunks, from T0 catalog rows joined with their T0
 * committed record index rows. A chunk whose events overlap the log window is carried whole, so
 * its record index rows keep their offsets on restore.
 */
export function buildTenantBackupLogObjectDescriptors(
  context: AdapterContext,
  source: Source,
  tenantId: string,
  tenantKey: string,
  rows: readonly TenantBackupLogObjectRow[]
): TenantBackupR2ObjectDescriptor[] {
  const boundaryUnixMs = integer(context.boundaryUnixMs);
  const window = tenantBackupLogWindow(context.selection.logs.period, boundaryUnixMs);
  const descriptors: TenantBackupR2ObjectDescriptor[] = [];
  for (const row of rows) {
    context.context.signal.throwIfAborted();
    if (
      !SAFE_ID.test(row.id) ||
      !LOG_TYPES.includes(row.log_type as (typeof LOG_TYPES)[number]) ||
      !LOG_PLANES.includes(row.plane as (typeof LOG_PLANES)[number]) ||
      !row.object_key ||
      !SHA256.test(row.checksum_sha256 ?? '') ||
      !LOG_CHUNK_COMPRESSION.includes(row.compression as (typeof LOG_CHUNK_COMPRESSION)[number]) ||
      integer(row.record_count, false) !== integer(row.index_count, false) ||
      integer(row.byte_count, false) < 1 ||
      row.first_event_at === null ||
      row.last_event_at === null ||
      row.first_chunk_id === null ||
      row.first_chunk_id !== row.last_chunk_id ||
      !SAFE_ID.test(row.first_chunk_id)
    )
      invalid();
    const selected = logTypeSelected(row.log_type, context, row.plane === 'sensitive_detail');
    if (!selected) continue;
    const first = integer(row.first_event_at);
    const last = integer(row.last_event_at);
    if (
      first > window.untilInclusiveUnixMs ||
      (window.fromInclusiveUnixMs !== null && last < window.fromInclusiveUnixMs)
    )
      continue;
    const bucketBinding = bucketForPlane(row.plane);
    const encrypted = row.encryption_scope !== null || row.key_version !== null;
    if (encrypted && (!row.encryption_scope || integer(row.key_version, false) < 1)) invalid();
    descriptors.push({
      datasetId: 'logs.archive_object_bodies',
      objectId: objectId(source, row.id),
      bucketBinding,
      objectKey: row.object_key,
      expectedStoredSha256: row.checksum_sha256,
      sourceEncoding: 'log_chunk_v1',
      context: {
        tenantId,
        catalogKind: 'log_object',
        sourceDatabaseId: source.databaseId,
        sourceFamily: source.family,
        sourceRowId: row.id,
        tenantKey,
        logType: row.log_type,
        plane: row.plane,
        chunkId: row.first_chunk_id,
        compression: row.compression,
        sourceEncrypted: encrypted,
        targetEncryptionScope: row.encryption_scope ?? `tenant-log-${row.plane}`,
        ...(encrypted
          ? { encryptionScope: row.encryption_scope, keyVersion: integer(row.key_version, false) }
          : {}),
      },
    } as TenantBackupR2ObjectDescriptor);
  }
  return descriptors;
}

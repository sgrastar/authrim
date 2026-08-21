import {
  ensureDatabaseAdapter,
  resolveTenantRuntimeProfilesFromEnv,
  type AuditProfile,
  type Env,
  type EventLogEntry,
} from '@authrim/ar-lib-core';
import { isArchiveLogRecordV1, type ArchiveLogRecordV1 } from '@authrim/ar-lib-logging/archive';
import {
  decodeStoredLogChunkRecord,
  deriveLogChunkEncryptionKey,
  type LogChunkRecordIndexRow,
} from '@authrim/ar-lib-logging/chunks';
import {
  deriveTenantKeyFromTenantId,
  type LogChunkCompression,
} from '@authrim/ar-lib-logging/contract';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

const AUDIT_ARCHIVE_OBJECT_READ_MAX_BYTES = 64 * 1024 * 1024;
type ArchiveEventCategory = EventLogEntry['eventCategory'];
type ArchiveEventResult = EventLogEntry['result'];

export type AuditArchiveQueryStatus = 'supported' | 'not_supported' | 'pending_runtime_support';

type TenantKeyResolver = (
  tenantId: string
) => string | null | undefined | Promise<string | null | undefined>;

export interface AuditArchiveQueryContext {
  env: Env;
  bucket: R2Bucket;
  prefix: string;
  auditProfileId: string;
  tenantKeyResolver?: TenantKeyResolver;
}

export interface AuditArchiveQuerySupport {
  supported: boolean;
  status: AuditArchiveQueryStatus;
  auditProfileId: string;
  reason?: string;
  context?: AuditArchiveQueryContext;
}

export interface AuditArchiveListOptions {
  tenantId: string;
  page: number;
  limit: number;
  startTime?: number;
  endTime?: number;
  eventType?: string;
  anonymizedUserId?: string;
  resourceType?: string;
  resourceId?: string;
}

export interface AuditArchiveListResult {
  entries: EventLogEntry[];
  total: number;
  totalPages: number;
}

interface ArchiveRecordIndexRow {
  record_id: string;
  tenant_key: string;
  object_catalog_id: string;
  chunk_id: string;
  object_key: string;
  checksum_sha256: string | null;
  compression: LogChunkCompression;
  encryption_scope: string;
  key_version: number | string;
  line_number: number | string;
  block_offset: number | string | null;
  block_length: number | string | null;
  record_offset: number | string;
  record_length: number | string;
  event_at: number | string;
  index_profile: string;
  indexed_fields: string | null;
  created_at: number | string;
}

function getR2BucketBinding(env: Env, bucketRef: string): R2Bucket | null {
  const binding = env[bucketRef as keyof Env];
  if (!binding || typeof binding !== 'object' || !('get' in binding) || !('list' in binding)) {
    return null;
  }
  return binding as R2Bucket;
}

function normalizeArchivePrefix(prefix: string | undefined): string {
  return (prefix ?? 'audit').replace(/^\/+|\/+$/gu, '') || 'audit';
}

export function getAuditArchiveQuerySupportForProfile(
  env: Env,
  auditProfile: AuditProfile
): AuditArchiveQuerySupport {
  if (auditProfile.primary) {
    return {
      supported: false,
      status: 'not_supported',
      auditProfileId: auditProfile.id,
      reason: 'primary-backed audit profiles should use hot query access instead of archive query',
    };
  }
  if (!auditProfile.archive || auditProfile.archive.type !== 'r2') {
    return {
      supported: false,
      status: 'not_supported',
      auditProfileId: auditProfile.id,
      reason: 'archive-only audit queries require an R2 archive target',
    };
  }
  if (auditProfile.archive.bucketRef !== 'AUDIT_ARCHIVE') {
    return {
      supported: false,
      status: 'pending_runtime_support',
      auditProfileId: auditProfile.id,
      reason: 'archive-only audit queries require the canonical AUDIT_ARCHIVE binding',
    };
  }
  const bucket = getR2BucketBinding(env, auditProfile.archive.bucketRef);
  if (!bucket || !env.DB_ADMIN || !env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return {
      supported: false,
      status: 'pending_runtime_support',
      auditProfileId: auditProfile.id,
      reason: 'encrypted archive bucket, Admin catalog, or encryption key is unavailable',
    };
  }
  return {
    supported: true,
    status: 'supported',
    auditProfileId: auditProfile.id,
    context: {
      env,
      bucket,
      prefix: normalizeArchivePrefix(auditProfile.archive.prefix),
      auditProfileId: auditProfile.id,
      tenantKeyResolver: createLoggingTenantKeyResolverFromSource(
        env.DB,
        'audit-archive-query-tenant-key'
      ),
    },
  };
}

export async function getAuditArchiveQuerySupport(
  env: Env,
  tenantId: string
): Promise<AuditArchiveQuerySupport> {
  const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
  return getAuditArchiveQuerySupportForProfile(env, resolved.auditProfile);
}

function toNumber(value: number | string | null): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '0', 10);
  if (!Number.isSafeInteger(parsed)) throw new Error('audit_archive_index_number_invalid');
  return parsed;
}

function buildRecordIndex(row: ArchiveRecordIndexRow): LogChunkRecordIndexRow {
  return {
    recordId: row.record_id,
    tenantKey: row.tenant_key,
    logType: 'audit',
    plane: 'archive',
    objectCatalogId: row.object_catalog_id,
    chunkId: row.chunk_id,
    lineNumber: toNumber(row.line_number),
    blockOffset: row.block_offset === null ? null : toNumber(row.block_offset),
    blockLength: row.block_length === null ? null : toNumber(row.block_length),
    recordOffset: toNumber(row.record_offset),
    recordLength: toNumber(row.record_length),
    eventAt: toNumber(row.event_at),
    indexProfile: row.index_profile,
    indexedFields: row.indexed_fields ? JSON.parse(row.indexed_fields) : undefined,
    status: 'committed',
    createdAt: toNumber(row.created_at),
  };
}

async function readObjectBytes(object: R2ObjectBody): Promise<Uint8Array> {
  if (object.size > AUDIT_ARCHIVE_OBJECT_READ_MAX_BYTES) {
    throw new Error('audit_archive_object_too_large');
  }
  return new Uint8Array(await object.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function resolveTenantKey(
  context: AuditArchiveQueryContext,
  tenantId: string
): Promise<string> {
  return (
    (await context.tenantKeyResolver?.(tenantId)) ??
    (await deriveTenantKeyFromTenantId(tenantId, context.env.LOGGING_TENANT_KEY_SALT))
  );
}

async function listIndexRows(
  context: AuditArchiveQueryContext,
  tenantKey: string,
  options: AuditArchiveListOptions,
  entryId?: string
): Promise<ArchiveRecordIndexRow[]> {
  if (!context.env.DB_ADMIN) throw new Error('audit_archive_catalog_unavailable');
  const adapter = ensureDatabaseAdapter(context.env.DB_ADMIN, 'audit-archive-query');
  const conditions = [
    'idx.tenant_key = ?',
    "idx.log_type = 'audit'",
    "idx.plane = 'archive'",
    "idx.status = 'committed'",
    "catalog.status = 'committed'",
    'catalog.object_key LIKE ?',
  ];
  const params: unknown[] = [tenantKey, `${context.prefix}/%`];
  if (options.startTime !== undefined) {
    conditions.push('idx.event_at >= ?');
    params.push(options.startTime);
  }
  if (options.endTime !== undefined) {
    conditions.push('idx.event_at < ?');
    params.push(options.endTime);
  }
  if (entryId) {
    conditions.push('idx.record_id = ?');
    params.push(entryId);
  }
  return adapter.query<ArchiveRecordIndexRow>(
    `SELECT idx.record_id, idx.tenant_key, idx.object_catalog_id, idx.chunk_id,
            catalog.object_key, catalog.checksum_sha256, catalog.compression,
            catalog.encryption_scope, catalog.key_version,
            idx.line_number, idx.block_offset, idx.block_length,
            idx.record_offset, idx.record_length, idx.event_at,
            idx.index_profile, idx.indexed_fields, idx.created_at
     FROM log_chunk_record_index idx
     INNER JOIN log_object_catalog catalog ON catalog.id = idx.object_catalog_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY idx.event_at DESC, idx.record_id DESC`,
    params
  );
}

async function decodeArchiveRows(
  context: AuditArchiveQueryContext,
  rows: ArchiveRecordIndexRow[]
): Promise<ArchiveLogRecordV1[]> {
  if (!context.env.OBJECT_ENCRYPTION_ROOT_KEY) {
    throw new Error('audit_archive_encryption_key_unavailable');
  }
  const objectCache = new Map<string, Uint8Array>();
  const records: ArchiveLogRecordV1[] = [];
  for (const row of rows) {
    let storedBody = objectCache.get(row.object_key);
    if (!storedBody) {
      const object = await context.bucket.get(row.object_key);
      if (!object) throw new Error('audit_archive_catalog_object_missing');
      storedBody = await readObjectBytes(object);
      if (row.checksum_sha256 && (await sha256Hex(storedBody)) !== row.checksum_sha256) {
        throw new Error('audit_archive_object_checksum_mismatch');
      }
      objectCache.set(row.object_key, storedBody);
    }
    const keyVersion = toNumber(row.key_version);
    const payload = await decodeStoredLogChunkRecord({
      storedBody,
      compression: row.compression,
      encryption: {
        keyBytes: await deriveLogChunkEncryptionKey({
          rootKeyHex: context.env.OBJECT_ENCRYPTION_ROOT_KEY,
          tenantKey: row.tenant_key,
          logType: 'audit',
          plane: 'archive',
          keyVersion,
        }),
        tenantKey: row.tenant_key,
        logType: 'audit',
        plane: 'archive',
        objectKey: row.object_key,
        chunkId: row.chunk_id,
        expectedEncryptionScope: row.encryption_scope,
        expectedKeyVersion: keyVersion,
      },
      recordIndex: buildRecordIndex(row),
    });
    if (!isArchiveLogRecordV1(payload)) {
      throw new Error('audit_archive_record_invalid');
    }
    records.push(payload);
  }
  return records;
}

const EVENT_CATEGORIES = new Set<ArchiveEventCategory>([
  'auth',
  'token',
  'consent',
  'user',
  'client',
  'admin',
  'security',
  'system',
  'audit',
]);
const EVENT_RESULTS = new Set<ArchiveEventResult>(['success', 'failure', 'partial']);

function archiveRecordToEvent(record: ArchiveLogRecordV1, tenantId: string): EventLogEntry {
  const summary = record.summary;
  const category = summary.event_category;
  const result = record.result;
  return {
    id: record.id,
    tenantId,
    eventType: record.type,
    eventCategory:
      typeof category === 'string' && EVENT_CATEGORIES.has(category as ArchiveEventCategory)
        ? (category as ArchiveEventCategory)
        : 'audit',
    result:
      typeof result === 'string' && EVENT_RESULTS.has(result as ArchiveEventResult)
        ? (result as ArchiveEventResult)
        : 'success',
    severity: record.severity,
    ...(typeof summary.error_code === 'string' ? { errorCode: summary.error_code } : {}),
    ...(typeof summary.error_message === 'string' ? { errorMessage: summary.error_message } : {}),
    ...(typeof summary.anonymized_user_id === 'string'
      ? { anonymizedUserId: summary.anonymized_user_id }
      : {}),
    ...(typeof summary.client_id === 'string' ? { clientId: summary.client_id } : {}),
    ...(record.correlation?.request_id ? { requestId: record.correlation.request_id } : {}),
    ...(typeof summary.duration_ms === 'number' ? { durationMs: summary.duration_ms } : {}),
    ...(record.detail_ref
      ? { detailsR2Key: `sensitive-detail-catalog:${record.detail_ref.object_catalog_id}` }
      : {}),
    detailsJson: JSON.stringify({
      summary: record.summary,
      actor: record.actor ?? null,
      resource: record.resource ?? null,
      delivery: record.delivery,
    }),
    createdAt: Date.parse(record.time),
  };
}

function matchesFilters(entry: EventLogEntry, options: AuditArchiveListOptions): boolean {
  if (options.eventType && entry.eventType !== options.eventType) return false;
  if (options.anonymizedUserId && entry.anonymizedUserId !== options.anonymizedUserId) return false;
  if (!options.resourceType && !options.resourceId) return true;
  const details = entry.detailsJson
    ? (JSON.parse(entry.detailsJson) as Record<string, unknown>)
    : {};
  const resource =
    details.resource && typeof details.resource === 'object'
      ? (details.resource as Record<string, unknown>)
      : {};
  if (options.resourceType && resource.type !== options.resourceType) return false;
  if (options.resourceId && resource.id !== options.resourceId) return false;
  return true;
}

export async function listArchiveAuditEvents(
  context: AuditArchiveQueryContext,
  options: AuditArchiveListOptions
): Promise<AuditArchiveListResult> {
  const tenantKey = await resolveTenantKey(context, options.tenantId);
  const records = await decodeArchiveRows(
    context,
    await listIndexRows(context, tenantKey, options)
  );
  const entries = records
    .map((record) => archiveRecordToEvent(record, options.tenantId))
    .filter((entry) => matchesFilters(entry, options));
  const offset = (options.page - 1) * options.limit;
  return {
    entries: entries.slice(offset, offset + options.limit),
    total: entries.length,
    totalPages: Math.ceil(entries.length / options.limit),
  };
}

export async function getArchiveAuditEventById(
  context: AuditArchiveQueryContext,
  tenantId: string,
  entryId: string
): Promise<EventLogEntry | null> {
  const tenantKey = await resolveTenantKey(context, tenantId);
  const rows = await listIndexRows(context, tenantKey, { tenantId, page: 1, limit: 1 }, entryId);
  const record = (await decodeArchiveRows(context, rows))[0];
  return record ? archiveRecordToEvent(record, tenantId) : null;
}

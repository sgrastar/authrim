import { boundedLogArchiveBytes, decodeLogArchiveBody } from './log-archive-body';
/** Read-only view of complete log rows in D1 and their encrypted R2 archives. */
import type { Context } from 'hono';
import {
  ensureDatabaseAdapter,
  resolvePlatformSettingsWithSources,
  type Env,
} from '@authrim/ar-lib-core';
import {
  decodeStoredLogChunkBody,
  deriveLogChunkEncryptionKey,
} from '@authrim/ar-lib-logging/chunks';
import {
  deriveTenantKeyFromTenantId,
  type LogChunkCompression,
  type LogType,
} from '@authrim/ar-lib-logging/contract';
import { PHASE8_LOG_TIMESTAMP_COLUMNS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-log-window';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

export type LogSqlRow = Record<string, string | number | null>;
export type LogDataset =
  | 'core.event_log'
  | 'core.audit_log'
  | 'core.operational_logs'
  | 'core.permission_check_audit'
  | 'admin.admin_audit_log';

const DATASETS: Record<LogDataset, LogType> = {
  'core.event_log': 'normal',
  'core.audit_log': 'audit',
  'core.operational_logs': 'operational',
  'core.permission_check_audit': 'audit',
  'admin.admin_audit_log': 'admin_audit',
};
const MAX_CHUNKS = 64;
const MAX_STORED_BYTES = 16 * 1024 * 1024;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_QUERY_MS = 10_000;

export class LogQueryIncompleteError extends Error {
  constructor() {
    super('Log results are incomplete. Narrow the time range or retry later.');
    this.name = 'LogQueryIncompleteError';
  }
}

export class LogQueryInvalidRequestError extends Error {}

export function logQueryErrorResponse(c: Context, error: unknown): Response | undefined {
  if (error instanceof LogQueryInvalidRequestError)
    return c.json({ error: 'invalid_request', error_description: error.message }, 400);
  if (!(error instanceof LogQueryIncompleteError)) return;
  return c.json(
    { error: 'log_query_incomplete', error_description: error.message, complete: false },
    503
  );
}

function incomplete(): never {
  throw new LogQueryIncompleteError();
}

interface ArchiveCatalogRow {
  id: string;
  tenant_key: string;
  log_type: LogType;
  object_key: string;
  chunk_id: string;
  source_table: string;
  encryption_scope: string;
  key_version: number;
  compression: LogChunkCompression;
  checksum_sha256: string;
  byte_count: number;
  record_count: number;
  first_event_at: number;
  last_event_at: number;
}

export interface LogReadWindow {
  fromMs?: number;
  toMs?: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeRow(payload: unknown, dataset: LogDataset, tenantId: string): LogSqlRow {
  if (!object(payload) || payload.format !== 'authrim.log.row.v1' || payload.table !== dataset)
    incomplete();
  if (!object(payload.row)) incomplete();
  const row: LogSqlRow = {};
  for (const [column, field] of Object.entries(payload.row)) {
    if (!/^[a-z][a-z0-9_]*$/.test(column) || !Array.isArray(field) || field.length !== 2)
      incomplete();
    const [kind, value] = field as unknown[];
    if (kind === 'null' && value === null) row[column] = null;
    else if (kind === 'text' && typeof value === 'string') row[column] = value;
    else if ((kind === 'integer' || kind === 'real') && typeof value === 'string') {
      const number = Number(value);
      if (
        !value ||
        !Number.isFinite(number) ||
        (kind === 'integer' && !Number.isSafeInteger(number))
      )
        incomplete();
      row[column] = number;
    } else incomplete();
  }
  if (row.tenant_id !== tenantId || typeof row.id !== 'string' || !row.id) incomplete();
  return row;
}

export function logRowTime(dataset: LogDataset, row: LogSqlRow): number {
  const time = PHASE8_LOG_TIMESTAMP_COLUMNS[dataset];
  const value = row[time.column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) incomplete();
  const ms = value * (time.unit === 's' ? 1000 : 1);
  if (!Number.isSafeInteger(ms)) incomplete();
  return ms;
}

export function logRowUnexpired(
  dataset: LogDataset,
  row: LogSqlRow,
  now: number,
  checkRetentionMs?: number
): boolean {
  if (dataset === 'core.event_log') {
    if (row.retention_until == null) return true;
    if (typeof row.retention_until !== 'number' || !Number.isSafeInteger(row.retention_until))
      incomplete();
    return row.retention_until > now;
  }
  if (dataset === 'core.operational_logs') {
    if (typeof row.expires_at !== 'number' || !Number.isSafeInteger(row.expires_at)) incomplete();
    return row.expires_at * 1000 > now;
  }
  if (dataset === 'core.permission_check_audit') {
    if (!checkRetentionMs || !Number.isSafeInteger(checkRetentionMs)) incomplete();
    return logRowTime(dataset, row) + checkRetentionMs > now;
  }
  return true;
}

/** No bucket listing or per-record index: the catalog is the authority for whole-row chunks. */
export async function readArchivedLogRows(input: {
  env: Env;
  tenantId: string;
  dataset: LogDataset;
  window?: LogReadWindow;
  now?: number;
  /** A list may stop once no unread chunk can change its filtered top-N page. */
  canStop?: (rows: readonly LogSqlRow[], nextLastEventAt: number | null) => Promise<boolean>;
}): Promise<LogSqlRow[]> {
  const { env, tenantId, dataset, window = {}, now = Date.now() } = input;
  if (!env.DB_ADMIN) return [];
  const started = Date.now();
  try {
    const catalog = ensureDatabaseAdapter(env.DB_ADMIN, 'log-archive-query');
    const resolver = createLoggingTenantKeyResolverFromSource(
      env.DB,
      'log-archive-query-tenant-key'
    );
    const tenantKey =
      (await resolver?.(tenantId)) ??
      (await deriveTenantKeyFromTenantId(tenantId, env.LOGGING_TENANT_KEY_SALT));
    if (!tenantKey) incomplete();
    const conditions = [
      'tenant_key = ?',
      'source_table = ?',
      "plane = 'archive'",
      "status = 'committed'",
    ];
    const bindings: (string | number)[] = [tenantKey, dataset];
    if (window.fromMs !== undefined) {
      conditions.push('last_event_at >= ?');
      bindings.push(window.fromMs);
    }
    if (window.toMs !== undefined) {
      conditions.push('first_event_at <= ?');
      bindings.push(window.toMs);
    }
    const chunks = await catalog.query<ArchiveCatalogRow>(
      `SELECT id, tenant_key, log_type, object_key, chunk_id, source_table, encryption_scope,
         key_version, compression, checksum_sha256, byte_count, record_count,
         first_event_at, last_event_at
       FROM log_object_catalog WHERE ${conditions.join(' AND ')}
       ORDER BY last_event_at DESC, id DESC LIMIT ?`,
      [...bindings, MAX_CHUNKS + 1]
    );
    if (chunks.length > MAX_CHUNKS && !input.canStop) incomplete();
    if (!chunks.length) return [];
    for (const chunk of chunks)
      if (
        !Number.isSafeInteger(chunk.first_event_at) ||
        !Number.isSafeInteger(chunk.last_event_at) ||
        chunk.first_event_at < 0 ||
        chunk.last_event_at < chunk.first_event_at
      )
        incomplete();
    if (await input.canStop?.([], chunks[0].last_event_at)) return [];
    if (!env.AUDIT_ARCHIVE || !env.OBJECT_ENCRYPTION_ROOT_KEY) incomplete();
    const rows: LogSqlRow[] = [];
    let storedBytes = 0;
    let decodedBytes = 0;
    let checkRetentionMs = 0;
    if (dataset === 'core.permission_check_audit') {
      const settings = await resolvePlatformSettingsWithSources(env, 'check-api-audit');
      const days = settings.values['audit.check_api_retention_days'];
      if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) incomplete();
      checkRetentionMs = days * 86_400_000;
    }
    for (const [index, chunk] of chunks.entries()) {
      if (index >= MAX_CHUNKS) incomplete();
      if (
        Date.now() - started > MAX_QUERY_MS ||
        chunk.tenant_key !== tenantKey ||
        chunk.source_table !== dataset ||
        chunk.log_type !== DATASETS[dataset] ||
        !chunk.chunk_id ||
        !Number.isSafeInteger(chunk.key_version) ||
        chunk.key_version < 1 ||
        !Number.isSafeInteger(chunk.record_count) ||
        chunk.record_count < 1 ||
        chunk.record_count > MAX_ROWS ||
        !Number.isSafeInteger(chunk.byte_count) ||
        chunk.byte_count < 1 ||
        chunk.byte_count > MAX_OBJECT_BYTES ||
        !/^[a-f0-9]{64}$/.test(chunk.checksum_sha256)
      )
        incomplete();
      storedBytes += chunk.byte_count;
      if (storedBytes > MAX_STORED_BYTES) incomplete();
      const body = await env.AUDIT_ARCHIVE.get(chunk.object_key);
      if (!body || body.size !== chunk.byte_count) incomplete();
      const stored = await boundedLogArchiveBytes(body.body, chunk.byte_count);
      if (stored.length !== chunk.byte_count) incomplete();
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', stored)))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      if (checksum !== chunk.checksum_sha256) incomplete();
      const decoded = await decodeStoredLogChunkBody({
        storedBody: stored,
        compression: chunk.compression,
        encryption: {
          keyBytes: await deriveLogChunkEncryptionKey({
            rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
            tenantKey,
            logType: chunk.log_type,
            plane: 'archive',
            keyVersion: chunk.key_version,
          }),
          tenantKey,
          logType: chunk.log_type,
          plane: 'archive',
          objectKey: chunk.object_key,
          chunkId: chunk.chunk_id,
          expectedEncryptionScope: chunk.encryption_scope,
          expectedKeyVersion: chunk.key_version,
        },
      });
      if (
        decoded.compression !== chunk.compression ||
        (decoded.compression !== 'none' && decoded.compression !== 'gzip_block')
      )
        incomplete();
      const bytes = await decodeLogArchiveBody(
        decoded.body,
        decoded.compression,
        MAX_DECODED_BYTES - decodedBytes
      );
      decodedBytes += bytes.length;
      const lines = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(bytes)
        .split('\n');
      if (lines.length !== chunk.record_count || rows.length + lines.length > MAX_ROWS)
        incomplete();
      const seen = new Set<string>();
      for (const line of lines) {
        const row = decodeRow(JSON.parse(line), dataset, tenantId);
        const at = logRowTime(dataset, row);
        if (seen.has(String(row.id)) || at < chunk.first_event_at || at > chunk.last_event_at)
          incomplete();
        seen.add(String(row.id));
        if (
          (window.fromMs !== undefined && at < window.fromMs) ||
          (window.toMs !== undefined && at > window.toMs)
        )
          continue;
        if (!logRowUnexpired(dataset, row, now, checkRetentionMs)) continue;
        rows.push(row);
      }
      if (await input.canStop?.(rows, chunks[index + 1]?.last_event_at ?? null)) return rows;
    }
    return rows;
  } catch {
    return incomplete();
  }
}

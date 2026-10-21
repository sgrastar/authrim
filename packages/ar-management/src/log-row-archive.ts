/**
 * Moves audit and security log rows older than `log-storage.d1_retention_days` from D1 to R2.
 *
 * A batch takes up to 1,000 of a tenant's oldest rows of one table in one database (4 MiB of
 * rows at most) and writes them, whole and in their portable form, to one encrypted R2 chunk.
 * The batch is journalled in log_archive_batches before the chunk is written: a retry writes
 * the same chunk and deletes exactly the journalled rows, once the chunk is committed. The
 * chunk has no per-record index; its catalog row names the source table, the event range and
 * when its last row expires, and it is retired once every row in it has expired.
 */
import {
  ensureDatabaseAdapter,
  resolvePlatformSettingsWithSources,
  SqlLogChunkCatalogStore,
  type DatabaseAdapter,
  type Env,
  type Logger,
} from '@authrim/ar-lib-core';
import { PHASE8_LOG_TIMESTAMP_COLUMNS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-log-window';
import { exportPortableOperationalLogDetailRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-operational-log-detail';
import {
  listCapturingTenantBackupTenantKeys,
  retireDeletedLogObjectGeneration,
} from '@authrim/ar-lib-core/services/tenant-portability/r2-generation-retention';
import {
  packedSqliteRowToJson,
  sqlitePackedRowExpression,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-packed-row';
import {
  deriveLogChunkEncryptionKey,
  writeLogChunkToR2,
  type LogChunkRecord,
} from '@authrim/ar-lib-logging/chunks';
import { deriveTenantKeyFromTenantId, type LogType } from '@authrim/ar-lib-logging/contract';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

const DAY_MS = 86_400_000;
/** Ten-minute schedule of the archiver (setup registers it for ar-management). */
export const LOG_ROW_ARCHIVE_CRON = '*/10 * * * *';
/** Time one run spends moving rows; the next run continues where it stopped. */
export const LOG_ROW_ARCHIVE_BUDGET_MS = 10_000;
export const LOG_ROW_ARCHIVE_BATCH_ROWS = 1000;
/** Packed bytes one batch reads; a row larger than LARGE_ROW_BYTES goes in a batch of its own. */
const BATCH_MAX_BYTES = 4 * 1024 * 1024;
/**
 * A D1 string holds at most 2,000,000 bytes and `hex()` doubles a row, so bodies are read in parts
 * of this size, and at most READ_BYTES of small rows in one query (as the DR snapshot reader does).
 * A row over this size is archived alone, so no row a D1 table can hold stops its table.
 */
const LARGE_ROW_BYTES = 256 * 1024;
const READ_BYTES = 1024 * 1024;
const LEASE_TASK_ID = 'log_row_archive';
/** Batches of a page's round robin kept between runs (each a (scan, tenant) position). */
const MAX_SAVED_WORK = 4096;
const LEASE_MS = 5 * 60 * 1000;
const EXPIRED_PER_RUN = 100;
export const LOG_ROW_ARCHIVE_PREFIX = 'logs/v1';
/** Record format of an archived row: the source dataset and the row in typed portable JSON. */
export const LOG_ROW_ARCHIVE_FORMAT = 'authrim.log.row.v1';

type Expiry =
  | { kind: 'column'; column: string; unit: 'ms' | 's' }
  /** Check API decisions expire `audit.check_api_retention_days` after they were made. */
  | { kind: 'check_api' };

export interface LogRowArchiveTable {
  /** Dataset id, e.g. core.audit_log. */
  datasetId: string;
  family: 'core' | 'admin';
  table: string;
  /** Log type of the chunk, matching the backup selection of the table (audit or other logs). */
  logType: LogType;
  expiry?: Expiry;
}

/** Append-only log tables with writers that no product logic reads back after a week. */
export const LOG_ROW_ARCHIVE_TABLES: readonly LogRowArchiveTable[] = (
  [
    ['core', 'event_log', 'normal', { kind: 'column', column: 'retention_until', unit: 'ms' }],
    ['core', 'audit_log', 'audit'],
    [
      'core',
      'operational_logs',
      'operational',
      { kind: 'column', column: 'expires_at', unit: 's' },
    ],
    ['core', 'flow_audit_events', 'normal'],
    ['core', 'permission_change_audit', 'audit'],
    ['core', 'permission_check_audit', 'audit', { kind: 'check_api' }],
    ['core', 'provisioning_assignment_events', 'normal'],
    ['core', 'provisioning_revocation_events', 'normal'],
    ['core', 'service_group_audit', 'audit'],
    ['core', 'directory_auth_migration_transaction_events', 'normal'],
    ['admin', 'admin_audit_log', 'admin_audit'],
    ['admin', 'federation_selected_entity_import_events', 'normal'],
    ['admin', 'key_access_events', 'audit'],
    ['admin', 'mapping_events', 'normal'],
  ] as const
).map(([family, table, logType, expiry]) => ({
  datasetId: `${family}.${table}`,
  family,
  table,
  logType,
  ...(expiry ? { expiry } : {}),
}));

export interface LogRowArchiveTarget {
  tenantId: string;
  /** The tenant's core stores; core.event_log is read from the audit primary `DB` as well. */
  adapters: Array<{ adapter: DatabaseAdapter; bindingRef: string }>;
}

interface Store {
  adapter: DatabaseAdapter;
  bindingRef: string;
}

interface BatchRow {
  id: string;
  tenant_id: string;
  source_store: string;
  source_table: string;
  object_catalog_id: string;
  chunk_id: string;
  created_at: number;
  row_ids_json: string;
}

function invalid(code = 'log_row_archive_invalid'): never {
  throw new Error(code);
}

function quote(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) invalid();
  return `"${name}"`;
}

/** Event-time column of an archived table; only integer milliseconds or seconds are archived. */
function timestamp(table: LogRowArchiveTable): { column: string; unit: 'ms' | 's' } {
  const entry = PHASE8_LOG_TIMESTAMP_COLUMNS[table.datasetId] ?? invalid();
  const { column, unit } = entry;
  if (unit !== 'ms' && unit !== 's') return invalid();
  quote(column);
  return { column, unit };
}

/** A stable code for logs: error codes as thrown here, the error's name otherwise. */
function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown';
  return /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : error.name;
}

const toMs = (value: number, unit: 'ms' | 's') => (unit === 's' ? value * 1000 : value);

/** Days log rows stay in D1; 0 when archiving is off or the setting cannot be read. */
export async function resolveLogD1RetentionDays(env: Env): Promise<number> {
  if (!env.SETTINGS) return 0;
  const { values } = await resolvePlatformSettingsWithSources(env, 'log-storage');
  const days = values['log-storage.d1_retention_days'];
  return typeof days === 'number' && Number.isSafeInteger(days) && days > 0 ? days : 0;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function rowJson(hex: string, columns: readonly string[]): Promise<string> {
  if (hex.length > BATCH_MAX_BYTES * 2 || hex.length % 2 !== 0 || !/^[0-9A-F]*$/.test(hex))
    invalid('log_row_archive_row_invalid');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  for await (const part of packedSqliteRowToJson(
    (async function* () {
      yield bytes;
    })(),
    columns
  ))
    text += decoder.decode(part, { stream: true });
  return text + decoder.decode();
}

export function createLogRowArchiver(input: { env: Env; log: Logger; now?: () => number }) {
  const { env, log } = input;
  const now = input.now ?? Date.now;
  const admin = () =>
    ensureDatabaseAdapter(
      env.DB_ADMIN ?? invalid('log_row_archive_admin_unavailable'),
      'log-row-archive'
    );
  const columnsCache = new Map<string, Promise<string[]>>();
  const columns = (store: Store, table: LogRowArchiveTable) => {
    const key = `${store.bindingRef}\n${table.datasetId}`;
    let cached = columnsCache.get(key);
    if (!cached) {
      cached = store.adapter
        .query<{
          name: string;
        }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', [table.table])
        .then((rows) => {
          const names = rows.map(({ name }) => name);
          if (
            !names.includes('id') ||
            !names.includes('tenant_id') ||
            !names.includes(timestamp(table).column)
          )
            invalid();
          return names;
        });
      columnsCache.set(key, cached);
    }
    return cached;
  };
  const tenantKeys = new Map<string, Promise<string>>();
  const tenantKey = (tenantId: string) => {
    let cached = tenantKeys.get(tenantId);
    if (!cached) {
      const resolver = createLoggingTenantKeyResolverFromSource(env.DB, 'log-row-archive');
      cached = (async () =>
        (await resolver?.(tenantId)) ??
        (await deriveTenantKeyFromTenantId(tenantId, env.LOGGING_TENANT_KEY_SALT)))();
      tenantKeys.set(tenantId, cached);
    }
    return cached;
  };

  /**
   * Read the rows to move: the oldest before `cutoffMs`, or exactly `ids` when resuming. Their
   * ids and sizes are read first and the bodies only of the rows that fit in one batch, so a run
   * of large rows never loads more than BATCH_MAX_BYTES.
   */
  const readRows = async (
    store: Store,
    table: LogRowArchiveTable,
    tenantId: string,
    select: { cutoffMs: number } | { ids: readonly string[] },
    checkApiRetentionDays: number
  ) => {
    const time = timestamp(table);
    const names = await columns(store, table);
    const expiry = table.expiry?.kind === 'column' ? table.expiry : null;
    if (expiry && !names.includes(expiry.column)) invalid();
    const packed = sqlitePackedRowExpression(names, 'r');
    const where =
      'ids' in select
        ? `tenant_id = ? AND id IN (SELECT value FROM json_each(?))`
        : `tenant_id = ? AND ${quote(time.column)} < ?`;
    const bound =
      'ids' in select
        ? JSON.stringify(select.ids)
        : time.unit === 's'
          ? Math.floor(select.cutoffMs / 1000)
          : select.cutoffMs;
    const heads = await store.adapter.query<{
      id: string;
      event_at: number;
      expires_at: number | null;
      bytes: number;
    }>(
      `SELECT id, ${quote(time.column)} AS event_at, ${expiry ? quote(expiry.column) : 'NULL'} AS expires_at,
         length(${packed}) AS bytes
       FROM ${quote(table.table)} AS r WHERE ${where}
       ORDER BY ${quote(time.column)}, id LIMIT ?`,
      [tenantId, bound, LOG_ROW_ARCHIVE_BATCH_ROWS]
    );
    const chosen: typeof heads = [];
    let bytes = 0;
    for (const head of heads) {
      if (typeof head.id !== 'string' || !head.id || !Number.isSafeInteger(head.event_at))
        invalid();
      if (!Number.isSafeInteger(head.bytes) || head.bytes < 0 || head.bytes > BATCH_MAX_BYTES)
        invalid('log_row_archive_row_too_large');
      const large = head.bytes > LARGE_ROW_BYTES;
      bytes += head.bytes;
      // Resumed batches hold the journalled rows; new ones stop at BATCH_MAX_BYTES and give a
      // large row a batch of its own.
      if (!('ids' in select) && chosen.length && (large || bytes > BATCH_MAX_BYTES)) break;
      chosen.push(head);
      if (!('ids' in select) && large) break;
    }
    const bodies = new Map<string, string>();
    const small = chosen.filter((head) => head.bytes <= LARGE_ROW_BYTES);
    for (let start = 0; start < small.length; ) {
      let end = start;
      for (
        let read = 0;
        end < small.length && (end === start || read + small[end].bytes <= READ_BYTES);
        end++
      )
        read += small[end].bytes;
      for (const { id, row_hex } of await store.adapter.query<{ id: string; row_hex: string }>(
        `SELECT id, hex(${packed}) AS row_hex FROM ${quote(table.table)} AS r
         WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))`,
        [tenantId, JSON.stringify(small.slice(start, end).map(({ id }) => id))]
      ))
        bodies.set(id, row_hex);
      start = end;
    }
    for (const head of chosen.filter((row) => row.bytes > LARGE_ROW_BYTES)) {
      let hex = '';
      for (let offset = 0; offset < head.bytes; offset += LARGE_ROW_BYTES) {
        const part = await store.adapter.queryOne<{ part: string | null }>(
          `SELECT hex(substr(${packed}, ?, ?)) AS part FROM ${quote(table.table)} AS r
           WHERE tenant_id = ? AND id = ?`,
          [offset + 1, LARGE_ROW_BYTES, tenantId, head.id]
        );
        const expected = Math.min(LARGE_ROW_BYTES, head.bytes - offset) * 2;
        if (typeof part?.part !== 'string' || part.part.length !== expected)
          invalid('log_row_archive_row_changed');
        hex += part.part;
      }
      bodies.set(head.id, hex);
    }
    const records: Array<LogChunkRecord & { expiresAt: number | null }> = [];
    for (const head of chosen) {
      let json = await rowJson(bodies.get(head.id) ?? invalid(), names);
      if (table.datasetId === 'core.operational_logs')
        json = await exportPortableOperationalLogDetailRow(json, env.PII_ENCRYPTION_KEY);
      const eventAt = toMs(head.event_at, time.unit);
      const expiresAt =
        table.expiry?.kind === 'check_api'
          ? eventAt + checkApiRetentionDays * DAY_MS
          : expiry && head.expires_at !== null
            ? toMs(Number(head.expires_at), expiry.unit)
            : null;
      records.push({
        id: head.id,
        eventAt,
        expiresAt,
        payload: { format: LOG_ROW_ARCHIVE_FORMAT, table: table.datasetId, row: JSON.parse(json) },
      });
    }
    // More rows wait when the page was full or the size limit cut it short.
    return {
      records,
      more: heads.length === LOG_ROW_ARCHIVE_BATCH_ROWS || chosen.length < heads.length,
    };
  };

  const writeChunk = async (
    batch: BatchRow,
    table: LogRowArchiveTable,
    records: Array<LogChunkRecord & { expiresAt: number | null }>
  ) => {
    if (!env.AUDIT_ARCHIVE) invalid('log_row_archive_bucket_unavailable');
    if (!env.OBJECT_ENCRYPTION_ROOT_KEY) invalid('log_row_archive_encryption_key_unavailable');
    const key = await tenantKey(batch.tenant_id);
    const keyVersionText = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1', 10);
    const keyVersion =
      Number.isSafeInteger(keyVersionText) && keyVersionText > 0 ? keyVersionText : 1;
    await writeLogChunkToR2({
      bucket: env.AUDIT_ARCHIVE,
      tenantKey: key,
      logType: table.logType,
      plane: 'archive',
      prefix: LOG_ROW_ARCHIVE_PREFIX,
      catalogStore: new SqlLogChunkCatalogStore(env.DB_ADMIN ?? invalid()),
      compression: 'gzip_block',
      chunkId: batch.chunk_id,
      objectCatalogId: batch.object_catalog_id,
      now: batch.created_at,
      encryption: {
        keyBytes: await deriveLogChunkEncryptionKey({
          rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
          tenantKey: key,
          logType: table.logType,
          plane: 'archive',
          keyVersion,
        }),
        encryptionScope: `tenant:${key}:${table.logType}:archive`,
        keyVersion,
      },
      records: records.map(({ id, eventAt, payload }) => ({ id, eventAt, payload })),
      rowArchive: {
        sourceTable: table.datasetId,
        firstEventAt: Math.min(...records.map(({ eventAt }) => eventAt)),
        lastEventAt: Math.max(...records.map(({ eventAt }) => eventAt)),
        maxExpiresAt: records.some(({ expiresAt }) => expiresAt === null)
          ? null
          : Math.max(...records.map(({ expiresAt }) => expiresAt as number)),
        neverExpires: records.some(({ expiresAt }) => expiresAt === null),
      },
    });
  };

  /** Delete the journalled rows once their chunk is committed, then close the batch. */
  const finish = async (store: Store, table: LogRowArchiveTable, batch: BatchRow) => {
    const committed = await admin().queryOne<{ status: string }>(
      'SELECT status FROM log_object_catalog WHERE id = ?',
      [batch.object_catalog_id]
    );
    if (committed?.status !== 'committed') invalid('log_row_archive_chunk_not_committed');
    await store.adapter.execute(
      `DELETE FROM ${quote(table.table)} WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))`,
      [batch.tenant_id, batch.row_ids_json]
    );
    await admin().execute(
      `UPDATE log_archive_batches SET state = 'done', updated_at = ? WHERE id = ? AND state = 'pending'`,
      [now(), batch.id]
    );
  };

  /** Move one batch of a tenant's oldest rows; `more` when rows before the cutoff remain. */
  const archiveBatch = async (
    store: Store,
    table: LogRowArchiveTable,
    tenantId: string,
    cutoffMs: number,
    checkApiRetentionDays: number
  ): Promise<{ count: number; more: boolean }> => {
    const { records, more } = await readRows(
      store,
      table,
      tenantId,
      { cutoffMs },
      checkApiRetentionDays
    );
    if (!records.length) return { count: 0, more: false };
    const ids = records.map(({ id }) => id);
    // The journal keeps the chunk of a batch across retries; a batch given up and selected anew
    // gets a new chunk.
    const chunkId = `arc_${crypto.randomUUID().replaceAll('-', '')}`;
    const batch: BatchRow = {
      id: chunkId,
      tenant_id: tenantId,
      source_store: store.bindingRef,
      source_table: table.datasetId,
      object_catalog_id: `obj_${chunkId}`,
      chunk_id: chunkId,
      // The chunk's time partition and catalog time follow its rows, so a retry keeps its key.
      created_at: Math.min(...records.map(({ eventAt }) => eventAt)),
      row_ids_json: JSON.stringify(ids),
    };
    const at = now();
    await admin().execute(
      `INSERT INTO log_archive_batches (id, tenant_id, source_store, source_table, object_catalog_id,
         chunk_id, created_at, row_ids_json, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(id) DO NOTHING`,
      [
        batch.id,
        batch.tenant_id,
        batch.source_store,
        batch.source_table,
        batch.object_catalog_id,
        batch.chunk_id,
        batch.created_at,
        batch.row_ids_json,
        at,
      ]
    );
    await writeChunk(batch, table, records);
    await finish(store, table, batch);
    return { count: records.length, more };
  };

  /** Finish one batch an earlier run journalled but did not close. */
  const resume = async (
    store: Store,
    table: LogRowArchiveTable,
    batch: BatchRow,
    checkApiRetentionDays: number
  ) => {
    const committed = await admin().queryOne<{ status: string }>(
      'SELECT status FROM log_object_catalog WHERE id = ?',
      [batch.object_catalog_id]
    );
    // Expiry never retires a chunk an open batch names, so a deleted one was removed some other
    // way (catalog repair) and may never have been written: its rows stay and are selected anew.
    if (committed?.status === 'deleted') {
      await admin().execute(`DELETE FROM log_archive_batches WHERE id = ? AND state = 'pending'`, [
        batch.id,
      ]);
      return;
    }
    if (committed?.status !== 'committed') {
      const ids = JSON.parse(batch.row_ids_json) as string[];
      const { records } = await readRows(
        store,
        table,
        batch.tenant_id,
        { ids },
        checkApiRetentionDays
      );
      if (records.length !== ids.length) {
        // The rows changed under the journal (e.g. the tenant was deleted); select anew.
        await admin().execute(
          `DELETE FROM log_archive_batches WHERE id = ? AND state = 'pending'`,
          [batch.id]
        );
        return;
      }
      await writeChunk(batch, table, records);
    }
    await finish(store, table, batch);
  };

  /** Retire chunks whose every row has expired; the R2 cleanup removes their bodies later. */
  const retireExpired = async (deadline: number) => {
    // A tenant whose backup export is capturing keeps its catalog rows as they are until it ends.
    const capturing = await listCapturingTenantBackupTenantKeys(admin());
    // A chunk whose rows are still being deleted from D1 is retired after its batch closes.
    const expired = await admin().query<{ id: string; tenant_key: string; object_key: string }>(
      `SELECT id, tenant_key, object_key FROM log_object_catalog
       WHERE source_table IS NOT NULL AND status = 'committed' AND never_expires = 0
         AND max_expires_at < ?
         AND id NOT IN (SELECT object_catalog_id FROM log_archive_batches WHERE state = 'pending')
         AND tenant_key NOT IN (SELECT value FROM json_each(?))
       LIMIT ?`,
      [now(), JSON.stringify([...capturing]), EXPIRED_PER_RUN]
    );
    let retired = 0;
    for (const row of expired) {
      if (now() >= deadline) break;
      await retireDeletedLogObjectGeneration(admin(), {
        retirementId: `log-row-archive-expired:${row.id}`,
        tenantKey: row.tenant_key,
        objectCatalogId: row.id,
        objectKey: row.object_key,
        deletedAt: now(),
        bucketBinding: 'AUDIT_ARCHIVE',
      });
      retired += 1;
    }
    return retired;
  };

  return {
    async run(targets: readonly LogRowArchiveTarget[], budgetMs: number) {
      const days = await resolveLogD1RetentionDays(env);
      if (!days) return { enabled: false, leased: false, complete: false };
      const deadline = now() + budgetMs;
      const token = crypto.randomUUID();
      const leased = await admin().execute(
        `INSERT INTO scheduled_task_leases (task_id, lease_token, lease_until, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET lease_token = excluded.lease_token,
           lease_until = excluded.lease_until, updated_at = excluded.updated_at
         WHERE scheduled_task_leases.lease_until <= excluded.updated_at`,
        [LEASE_TASK_ID, token, now() + LEASE_MS, now()]
      );
      if ((leased.rowsAffected ?? 0) === 0)
        return { enabled: true, leased: false, complete: false };
      let moved = 0;
      let batches = 0;
      let failed = 0;
      let complete = true;
      try {
        const { values } = await resolvePlatformSettingsWithSources(env, 'check-api-audit');
        const checkApiRetentionDays = values['audit.check_api_retention_days'];
        if (
          typeof checkApiRetentionDays !== 'number' ||
          !Number.isSafeInteger(checkApiRetentionDays) ||
          checkApiRetentionDays < 1
        )
          invalid('log_row_archive_check_api_retention_invalid');
        const cutoffMs = now() - days * DAY_MS;
        const tenantIds = targets.map(({ tenantId }) => tenantId);
        const adminStore: Store = { adapter: admin(), bindingRef: 'DB_ADMIN' };
        // Core rows can be in the audit primary `DB` and in each tenant's core stores.
        const coreStores = new Map<string, { store: Store; tenantIds: Set<string> }>();
        const addCore = (store: Store, tenantId: string) => {
          const entry = coreStores.get(store.bindingRef) ?? { store, tenantIds: new Set() };
          entry.tenantIds.add(tenantId);
          coreStores.set(store.bindingRef, entry);
        };
        for (const target of targets) {
          if (env.DB)
            addCore(
              { adapter: ensureDatabaseAdapter(env.DB, 'log-row-archive:DB'), bindingRef: 'DB' },
              target.tenantId
            );
          for (const store of target.adapters) addCore(store, target.tenantId);
        }
        const storeFor = (bindingRef: string) =>
          bindingRef === 'DB_ADMIN' ? adminStore : coreStores.get(bindingRef)?.store;
        const key = (tenantId: string, datasetId: string, bindingRef: string) =>
          `${tenantId}\n${datasetId}\n${bindingRef}`;
        const fail = (scope: string, table: string, bindingRef: string, error: unknown) => {
          // One table that cannot move (e.g. an oversized row) does not stop the others.
          failed += 1;
          complete = false;
          log.warn(`Log row archive ${scope} failed`, {
            table,
            bindingRef,
            errorType: errorCode(error),
          });
        };

        // 1. Batches journalled but not closed are finished first and never overlapped.
        const blocked = new Set<string>();
        const pending = tenantIds.length
          ? await admin().query<BatchRow>(
              `SELECT id, tenant_id, source_store, source_table, object_catalog_id, chunk_id,
                 created_at, row_ids_json FROM log_archive_batches
               WHERE state = 'pending' AND tenant_id IN (SELECT value FROM json_each(?))
               ORDER BY created_at`,
              [JSON.stringify(tenantIds)]
            )
          : [];
        for (const batch of pending) {
          const table = LOG_ROW_ARCHIVE_TABLES.find(
            ({ datasetId }) => datasetId === batch.source_table
          );
          const store = storeFor(batch.source_store);
          if (!table || !store || now() >= deadline) {
            blocked.add(key(batch.tenant_id, batch.source_table, batch.source_store));
            complete = false;
            continue;
          }
          try {
            await resume(store, table, batch, checkApiRetentionDays);
          } catch (error) {
            blocked.add(key(batch.tenant_id, batch.source_table, batch.source_store));
            fail('resume', batch.source_table, batch.source_store, error);
          }
        }

        // 2. Find which tenants of this page have rows to move, one query per table and store,
        //    for at most half the budget, so that slow scans still leave time to move rows.
        const allScans: Array<{ table: LogRowArchiveTable; store: Store; tenantIds: Set<string> }> =
          [];
        for (const table of LOG_ROW_ARCHIVE_TABLES)
          for (const { store, tenantIds: storeTenants } of table.family === 'admin'
            ? [{ store: adminStore, tenantIds: new Set(tenantIds) }]
            : [...coreStores.values()])
            allScans.push({ table, store, tenantIds: storeTenants });
        // Where the last run of this page of tenants stopped: the next scan, and the batches still
        // due in its round robin as (scan, tenant) positions. Each run goes on from there.
        const positionKey = `jobs:log-row-archive:position:${(
          await sha256Hex(tenantIds.join('\n'))
        ).slice(0, 32)}`;
        let saved: { scan?: unknown; work?: unknown } = {};
        try {
          saved = JSON.parse((await env.AUTHRIM_CONFIG?.get(positionKey)) ?? '{}') ?? {};
        } catch {
          saved = {};
        }
        const index = (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
        const offset = allScans.length ? index(saved.scan) % allScans.length : 0;
        const tenantIndex = new Map(tenantIds.map((tenantId, position) => [tenantId, position]));
        let scanned = 0;
        const scanUntil = now() + Math.max(0, deadline - now()) / 2;
        type Work = {
          table: LogRowArchiveTable;
          store: Store;
          tenantId: string;
          /** (scan, tenant) position: the fixed order of the round robin. */
          position: [number, number];
        };
        const found: Work[] = [];
        for (let step = 0; step < allScans.length; step++) {
          if (now() >= scanUntil) {
            complete = false;
            break;
          }
          const scanIndex = (offset + step) % allScans.length;
          const { table, store, tenantIds: storeTenants } = allScans[scanIndex];
          scanned += 1;
          const time = timestamp(table);
          try {
            const rows = await store.adapter.query<{ tenant_id: string }>(
              `SELECT DISTINCT tenant_id FROM ${quote(table.table)}
               WHERE tenant_id IN (SELECT value FROM json_each(?)) AND ${quote(time.column)} < ?`,
              [
                JSON.stringify([...storeTenants]),
                time.unit === 's' ? Math.floor(cutoffMs / 1000) : cutoffMs,
              ]
            );
            for (const { tenant_id: tenantId } of rows)
              if (!blocked.has(key(tenantId, table.datasetId, store.bindingRef)))
                found.push({
                  table,
                  store,
                  tenantId,
                  position: [scanIndex, tenantIndex.get(tenantId) ?? 0],
                });
          } catch (error) {
            fail('scan', table.datasetId, store.bindingRef, error);
          }
        }

        // 3. One batch per table, store and tenant in turn: first the batches the last run left
        //    due, in its order, then the ones found now, so that every one of them is reached.
        const work: Work[] = [];
        const queued = new Set<string>();
        const enqueue = (item: Work) => {
          const id = item.position.join(':');
          if (
            queued.has(id) ||
            blocked.has(key(item.tenantId, item.table.datasetId, item.store.bindingRef))
          )
            return;
          queued.add(id);
          work.push(item);
        };
        if (Array.isArray(saved.work))
          for (const position of saved.work.slice(0, MAX_SAVED_WORK)) {
            if (!Array.isArray(position) || position.length !== 2) continue;
            const scan = allScans[index(position[0])];
            const tenantId = tenantIds[index(position[1])];
            if (!scan || !tenantId || !scan.tenantIds.has(tenantId)) continue;
            enqueue({
              table: scan.table,
              store: scan.store,
              tenantId,
              position: [index(position[0]), index(position[1])],
            });
          }
        for (const item of found) enqueue(item);
        while (work.length && now() < deadline) {
          const step = work.shift() as Work;
          try {
            const { count, more } = await archiveBatch(
              step.store,
              step.table,
              step.tenantId,
              cutoffMs,
              checkApiRetentionDays
            );
            moved += count;
            if (count) batches += 1;
            if (more) work.push(step);
          } catch (error) {
            fail('batch', step.table.datasetId, step.store.bindingRef, error);
          }
        }
        if (work.length) complete = false;
        await env.AUTHRIM_CONFIG?.put(
          positionKey,
          JSON.stringify({
            // Scans go on where this run stopped; a run that scanned every table starts again.
            scan:
              allScans.length && scanned < allScans.length
                ? (offset + scanned) % allScans.length
                : 0,
            work: work.slice(0, MAX_SAVED_WORK).map(({ position }) => position),
          })
        );
        const retired = now() < deadline ? await retireExpired(deadline) : 0;
        return { enabled: true, leased: true, complete, days, moved, batches, failed, retired };
      } finally {
        await admin()
          .execute('DELETE FROM scheduled_task_leases WHERE task_id = ? AND lease_token = ?', [
            LEASE_TASK_ID,
            token,
          ])
          .catch((error: unknown) =>
            log.warn('Log row archive lease release failed', {
              errorType: error instanceof Error ? error.name : 'Unknown',
            })
          );
      }
    },
  };
}

import {
  readSnapshotRecords,
  type IcebergCatalogPort,
  type IcebergObjectStore,
  type LogArchiveRecord,
  type IcebergLoadedTable,
} from '@authrim/ar-lib-logging/iceberg';
import { ensureDatabaseAdapter } from '../db';
import type { DatabaseAdapter } from '../db/adapter';
import {
  assertLogIcebergActivated,
  resolveLogIcebergConfig,
  type LogIcebergConfig,
} from './log-iceberg-config';
import {
  createLogIcebergCatalog,
  createLogIcebergObjectStore,
  validateLogIcebergTable,
  type LogIcebergCatalogEnv,
} from './log-iceberg-catalog';
import { createLogIcebergWritePort } from './log-iceberg-runtime';
import { decryptLogIcebergRecord } from './log-iceberg-record';
import {
  decodeLogIcebergRow,
  decryptProtectedLogIcebergDetail,
  type LogIcebergSqlRow,
} from './log-iceberg-row-codec';
import { SqlLogIcebergRecordStore } from './log-iceberg-store';
import { filterUnErasedLogIcebergRecords } from './log-iceberg-erasure-filter';
import { createLogIcebergKeyResolver } from './log-iceberg-keys';
import { filterPublishedCoreLogRecords } from './log-iceberg-core-publication';

export interface LogIcebergReadScope {
  tenantId: string;
  sourceDataset: string;
  eventId?: string;
  fromMs?: number;
  toMs?: number;
  now?: number;
}
interface ReadWatermark {
  table_uuid: string;
  minimum_sequence_number: number;
  snapshot_id: string;
}

/** A higher sequence after a rollback does not prove coverage. Maintenance
 * advances this anchor to a proven current descendant BEFORE expiring ancestry. */
export function assertLogIcebergWatermarkLineage(
  table: IcebergLoadedTable,
  watermark: ReadWatermark | null
): void {
  if (!watermark) return;
  let id = table.metadata['current-snapshot-id'];
  const seen = new Set<string>();
  while (id !== undefined && id !== null) {
    const key = String(id);
    if (seen.has(key)) break;
    seen.add(key);
    const snapshot = table.metadata.snapshots?.find(
      (entry) => String(entry['snapshot-id']) === key
    );
    if (!snapshot) break;
    if (
      key === watermark.snapshot_id &&
      snapshot['sequence-number'] === watermark.minimum_sequence_number
    )
      return;
    id = snapshot['parent-snapshot-id'];
  }
  throw new Error('log_iceberg_read_watermark_lineage_incomplete');
}
export interface LogIcebergDatasetReadResult {
  rows: LogIcebergSqlRow[];
  hasArchive: boolean;
  /** Pipeline acknowledgement is not an assertion of Parquet/query visibility. */
  consistency: 'eventual' | 'snapshot' | 'local_hot_only';
  pendingDeliveries: number;
}
interface ReadPorts {
  catalog?: IcebergCatalogPort;
  store: (table: Awaited<ReturnType<IcebergCatalogPort['loadTable']>>) => IcebergObjectStore;
  tenantKey: (tenantId: string) => Promise<string>;
  admin: DatabaseAdapter;
}

function validateScope(input: LogIcebergReadScope): number {
  if (
    !input.tenantId ||
    input.tenantId.length > 256 ||
    !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/.test(input.sourceDataset)
  )
    throw new Error('log_iceberg_read_scope_invalid');
  if (input.eventId !== undefined && (!input.eventId || input.eventId.length > 256))
    throw new Error('log_iceberg_read_scope_invalid');
  const now = input.now ?? Date.now();
  for (const value of [now, input.fromMs, input.toMs])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error('log_iceberg_read_window_invalid');
  if (input.fromMs !== undefined && input.toMs !== undefined && input.fromMs > input.toMs)
    throw new Error('log_iceberg_read_window_invalid');
  return now;
}
function mergeRecords(records: readonly LogArchiveRecord[], now: number): LogArchiveRecord[] {
  const unique = new Map<string, LogArchiveRecord>();
  let bytes = 0;
  for (const record of records) {
    const id = JSON.stringify([record.tenant_key, record.source_dataset, record.event_id]);
    const previous = unique.get(id);
    // Compare all semantic values. Nonces, key versions and storage generations
    // may differ after restore; expiry and logical payload may never change.
    if (previous) {
      for (const name of Object.keys(record) as (keyof LogArchiveRecord)[]) {
        if (
          ['detail_ciphertext', 'detail_key_version', 'storage_generation', 'ingested_at'].includes(
            name
          )
        )
          continue;
        if (record[name] !== previous[name]) throw new Error('log_iceberg_event_id_collision');
      }
      continue;
    }
    if (record.expires_at !== null && record.expires_at <= now) continue;
    bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
    if (bytes > 4 * 1024 * 1024 || unique.size >= 10000)
      throw new Error('log_iceberg_read_budget_exceeded');
    unique.set(id, record);
  }
  return [...unique.values()];
}

/** Explicit ports permit deterministic concurrency/failure tests; production
 * only instantiates this behind the required new-mode activation check. */
export function createLogIcebergReadPort(
  env: LogIcebergCatalogEnv,
  config: LogIcebergConfig,
  ports: ReadPorts
) {
  async function records(input: LogIcebergReadScope, eventId?: string) {
    const now = validateScope(input);
    const tenantKey = await ports.tenantKey(input.tenantId);
    // Never reverse these reads: a source can disappear while parts are read.
    // A subsequent primary watermark and fresh Catalog load cover that gap.
    const hot =
      config.mode === 'scheduled'
        ? await new SqlLogIcebergRecordStore(ports.admin).readTenant({
            tenantId: input.tenantId,
            tenantKey,
            sourceDataset: input.sourceDataset,
            now,
            fromMs: input.fromMs,
            toMs: input.toMs,
            eventId,
          })
        : [];
    if (config.localStagingOnly) {
      const eligible = await filterPublishedCoreLogRecords(
        ports.admin,
        input.tenantId,
        await filterUnErasedLogIcebergRecords(ports.admin, input.tenantId, hot)
      );
      return {
        all: mergeRecords(eligible, now).filter(
          (record) => !eventId || record.event_id === eventId
        ),
        now,
        tenantKey,
        hasArchive: false,
      };
    }
    if (!ports.catalog) throw new Error('log_iceberg_catalog_unavailable');
    const watermark = await ports.admin.queryOne<ReadWatermark>(
      'SELECT table_uuid,minimum_sequence_number,snapshot_id FROM log_iceberg_read_watermarks WHERE id=?',
      [config.tableUuid],
      { consistencyClass: 'primary_required' }
    );
    if (
      watermark &&
      (watermark.table_uuid !== config.tableUuid || !/^\d+$/.test(watermark.snapshot_id))
    )
      throw new Error('log_iceberg_read_watermark_invalid');
    const table = await ports.catalog.loadTable();
    await validateLogIcebergTable(config, table);
    assertLogIcebergWatermarkLineage(table, watermark);
    const cold = await readSnapshotRecords({
      table,
      store: ports.store(table),
      tenantKey,
      sourceDatasets: [input.sourceDataset],
      nowMs: now,
      eventAtFrom: input.fromMs,
      eventAtTo:
        input.toMs === undefined || input.toMs === Number.MAX_SAFE_INTEGER
          ? undefined
          : input.toMs + 1,
      ...(eventId ? { eventIds: [eventId] } : {}),
      ...(watermark
        ? {
            watermark: {
              tableUuid: watermark.table_uuid,
              minimumSequenceNumber: watermark.minimum_sequence_number,
            },
          }
        : {}),
    });
    const eligible = await filterPublishedCoreLogRecords(
      ports.admin,
      input.tenantId,
      await filterUnErasedLogIcebergRecords(ports.admin, input.tenantId, [...hot, ...cold.records])
    );
    const all = mergeRecords(eligible, now).filter(
      (record) => !eventId || record.event_id === eventId
    );
    return { all, now, tenantKey, hasArchive: cold.records.length > 0 };
  }
  return {
    async readDataset(input: LogIcebergReadScope): Promise<LogIcebergDatasetReadResult> {
      const resolveKeys = createLogIcebergKeyResolver(env);
      const result = await records(input, input.eventId);
      const rows: LogIcebergSqlRow[] = [];
      let bytes = 0;
      for (const record of result.all) {
        const body = await decryptLogIcebergRecord(
          record,
          { tenantKey: result.tenantKey, sourceDataset: input.sourceDataset },
          async (version) => resolveKeys(version)
        );
        const row = decodeLogIcebergRow(body, input.tenantId, record.event_id);
        bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error('log_iceberg_read_budget_exceeded');
        rows.push(row);
      }
      const pending =
        config.mode === 'pipeline'
          ? await ports.admin.queryOne<{ count: number }>(
              "SELECT COUNT(*) AS count FROM log_iceberg_outbox WHERE tenant_id=? AND storage_generation=? AND state IN('pending','queued')",
              [input.tenantId, config.generation],
              { consistencyClass: 'primary_required' }
            )
          : null;
      const rawCount: unknown = pending?.count;
      if (
        config.mode === 'pipeline' &&
        (pending === null ||
          !(
            typeof rawCount === 'number' ||
            (typeof rawCount === 'string' && /^(0|[1-9][0-9]*)$/.test(rawCount))
          ))
      )
        throw new Error('log_iceberg_delivery_status_invalid');
      const pendingDeliveries = config.mode === 'scheduled' ? 0 : Number(rawCount);
      if (!Number.isSafeInteger(pendingDeliveries) || pendingDeliveries < 0)
        throw new Error('log_iceberg_delivery_status_invalid');
      return {
        rows,
        hasArchive: result.hasArchive,
        consistency: config.localStagingOnly
          ? 'local_hot_only'
          : config.mode === 'pipeline'
            ? 'eventual'
            : 'snapshot',
        pendingDeliveries,
      };
    },
    /** Endpoint must verify its additional before/after/reason permission first. */
    async loadProtectedDetail(
      input: LogIcebergReadScope & { eventId: string }
    ): Promise<Record<string, unknown> | null> {
      const resolveKeys = createLogIcebergKeyResolver(env);
      if (!input.eventId || input.eventId.length > 256)
        throw new Error('log_iceberg_detail_scope_invalid');
      const result = await records(input, input.eventId);
      if (result.all.length === 0) return null;
      const record = result.all[0];
      const body = await decryptLogIcebergRecord(
        record,
        { tenantKey: result.tenantKey, sourceDataset: input.sourceDataset, eventId: input.eventId },
        async (version) => resolveKeys(version)
      );
      decodeLogIcebergRow(body, input.tenantId, input.eventId);
      return decryptProtectedLogIcebergDetail({
        record,
        body,
        resolveKeys: async (version) => resolveKeys(version),
      });
    },
  };
}

function productionPort(env: LogIcebergCatalogEnv) {
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  if (!env.DB_ADMIN) throw new Error('log_iceberg_admin_database_unavailable');
  const writer = env.LOG_ARCHIVE_WRITER ?? createLogIcebergWritePort(env, config);
  return createLogIcebergReadPort(env, config, {
    ...(config.localStagingOnly ? {} : { catalog: createLogIcebergCatalog(env, config) }),
    store: (table) => createLogIcebergObjectStore(env, table),
    tenantKey: (tenantId) => writer.resolveTenantKey(tenantId),
    admin: ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-read'),
  });
}

/** Caller authorizes the dataset/tenant before invoking this server-only API. */
export function readLogIcebergDataset(
  env: LogIcebergCatalogEnv,
  input: LogIcebergReadScope
): Promise<LogIcebergDatasetReadResult> {
  return productionPort(env).readDataset(input);
}
export function loadLogIcebergProtectedDetail(
  env: LogIcebergCatalogEnv,
  input: LogIcebergReadScope & { eventId: string }
): Promise<Record<string, unknown> | null> {
  return productionPort(env).loadProtectedDetail(input);
}

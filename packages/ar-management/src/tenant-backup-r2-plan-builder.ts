import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  plannedInstalledSqliteDatasetSources,
  type PlannedInstalledSqliteDataset,
} from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import type { PortableR2DatasetId } from '@authrim/ar-lib-core/services/tenant-portability/portable-r2-object';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { readSqliteSnapshotChunks } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-source';
import {
  aggregateSqliteSnapshotRows,
  lookupSqliteSnapshotRows,
  SQLITE_SNAPSHOT_LOOKUP_MAX_VALUES,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot-lookup';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import {
  buildTenantBackupHeldPayloadDescriptors,
  buildTenantBackupLogObjectDescriptors,
  buildTenantBackupObjectCatalogDescriptors,
  type TenantBackupHeldPayloadRow,
  type TenantBackupLogObjectRow,
  type TenantBackupObjectCatalogRow,
  type TenantBackupR2Source,
  type TenantBackupR2SourceFamily,
} from './tenant-backup-r2-descriptors';
import {
  encodeTenantBackupR2ObjectPlan,
  type TenantBackupR2ObjectDescriptor,
} from './tenant-backup-r2-object-snapshot-port';
import {
  DEFERRED_PLAN_PAGE_MAX_PLANS,
  type DeferredEncryptedTenantBackupRecordSnapshotPort,
} from './tenant-backup-record-snapshot-port';

/**
 * One slice is the next SLICE_ROWS boundary rows of one source table. Slices depend only on the
 * T0 snapshot, so a slice retried after a crash yields the same page again.
 */
const SLICE_ROWS = DEFERRED_PLAN_PAGE_MAX_PLANS;
/** Slices one preparation call works through; each costs a few D1 queries and two R2 puts. */
const SLICES_PER_CALL = 4;
/**
 * Snapshot page queries one slice may spend. Rows the snapshot omits (other tenants' rows, rows
 * inserted after T0) cost scans but yield nothing; a slice that meets a long run of them ends at
 * the budget and the next call continues from its position.
 */
const SLICE_QUERY_BUDGET = 24;
/**
 * Rows of a lookup table that may change between the boundary and the export preparation. Every
 * lookup reads them in full, so a burst of repairs or deletions during an export stops it here.
 */
const LOOKUP_PREIMAGE_LIMIT = 5000;
const MESSAGE_JOB_HELD_STATES = new Set([
  'queued',
  'claimed',
  'running',
  'retrying',
  'failed',
  'dlq',
  'blocked',
]);

type StreamTable =
  | 'object_catalog_objects'
  | 'log_object_catalog'
  | 'logging_dlq_items'
  | 'logging_message_jobs';

interface WorkItem {
  datasetId: PortableR2DatasetId;
  family: TenantBackupR2SourceFamily;
  table: StreamTable;
  resourceId: string;
}

interface PlanCursor {
  version: 1;
  /** Next work item; equal to the item count once every stream is read. */
  item: number;
  /** Last boundary row key read from the current item ('' before its first slice). */
  after: string;
  /** Pages written per selected R2 dataset, in `datasets` order. */
  pages: number[];
  published: boolean[];
}

export interface TenantBackupR2PlanTarget {
  datasetId: PortableR2DatasetId;
  port: DeferredEncryptedTenantBackupRecordSnapshotPort;
  snapshotId: string;
}

function invalid(code = 'backup_r2_plan_invalid'): never {
  throw new Error(code);
}

function value(row: PortableSqliteRow, column: string): readonly [string, string | null] {
  return row[column] ?? invalid();
}

function text(row: PortableSqliteRow, column: string): string | null {
  const [type, item] = value(row, column);
  if (type === 'null') return null;
  if (type !== 'text' || item === null) invalid();
  return item;
}

function requiredText(row: PortableSqliteRow, column: string): string {
  return text(row, column) ?? invalid();
}

function integer(row: PortableSqliteRow, column: string): number | null {
  const [type, item] = value(row, column);
  if (type === 'null') return null;
  if (type !== 'integer' || item === null || !/^-?(0|[1-9][0-9]{0,15})$/.test(item)) invalid();
  const parsed = Number(item);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

function parseCursor(raw: string | null, datasets: number): PlanCursor {
  if (raw === null)
    return {
      version: 1,
      item: 0,
      after: '',
      pages: Array(datasets).fill(0),
      published: Array(datasets).fill(false),
    };
  let cursor: PlanCursor;
  try {
    cursor = JSON.parse(raw) as PlanCursor;
  } catch {
    return invalid();
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Object.keys(cursor).sort().join(',') !== 'after,item,pages,published,version' ||
    cursor.version !== 1 ||
    !Number.isSafeInteger(cursor.item) ||
    cursor.item < 0 ||
    typeof cursor.after !== 'string' ||
    cursor.after.length > 2048 ||
    !Array.isArray(cursor.pages) ||
    cursor.pages.length !== datasets ||
    cursor.pages.some((pages) => !Number.isSafeInteger(pages) || pages < 0) ||
    !Array.isArray(cursor.published) ||
    cursor.published.length !== datasets ||
    cursor.published.some((published) => typeof published !== 'boolean')
  )
    invalid();
  return cursor;
}

function plannedEntry(
  planned: readonly PlannedInstalledSqliteDataset[],
  family: TenantBackupR2SourceFamily,
  table: string
): PlannedInstalledSqliteDataset {
  const entries = planned.filter((entry) => entry.dataset.id === `${family}.${table}`);
  if (entries.length !== 1) invalid();
  return entries[0];
}

/** Every source table to read, in a fixed order: dataset, table, then physical database. */
function workItems(
  context: AdapterContext,
  planned: readonly PlannedInstalledSqliteDataset[],
  datasets: readonly PortableR2DatasetId[]
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const datasetId of datasets) {
    const tables: { family: TenantBackupR2SourceFamily; table: StreamTable }[] =
      datasetId === 'artifacts.object_catalog_bodies'
        ? [
            { family: 'core', table: 'object_catalog_objects' },
            { family: 'admin', table: 'object_catalog_objects' },
          ]
        : [
            { family: 'core', table: 'log_object_catalog' },
            { family: 'admin', table: 'log_object_catalog' },
            ...(context.selection.admin
              ? [
                  { family: 'admin' as const, table: 'logging_dlq_items' as const },
                  { family: 'admin' as const, table: 'logging_message_jobs' as const },
                ]
              : []),
          ];
    for (const { family, table } of tables)
      for (const source of plannedInstalledSqliteDatasetSources(
        plannedEntry(planned, family, table)
      ))
        items.push({ datasetId, family, table, resourceId: source.resourceId });
  }
  return items;
}

interface SliceSource {
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
  snapshotId: string;
  tenantId: string;
  signal: AbortSignal;
}

/** The next boundary rows of one table after `after`, and the position the slice ends at. */
async function readSlice(
  source: SliceSource,
  entry: PlannedInstalledSqliteDataset,
  after: string,
  queryBudget: number
): Promise<{ rows: PortableSqliteRow[]; end: string; exhausted: boolean }> {
  const rows: PortableSqliteRow[] = [];
  let end = after;
  let queries = 0;
  const counted: SliceSource['database'] = {
    query<T>(sql: string, params?: unknown[]) {
      queries++;
      return source.database.query<T>(sql, params);
    },
    queryOne<T>(sql: string, params?: unknown[]) {
      queries++;
      return source.database.queryOne<T>(sql, params);
    },
  };
  const iterator = readSqliteSnapshotChunks({
    database: counted,
    schema: entry.capture,
    snapshotId: source.snapshotId,
    tenantId: source.tenantId,
    signal: source.signal,
    ...(entry.partitions?.length ? { partitions: entry.partitions } : {}),
    cursor: { after, chunk: 0, order: 'native' },
    // Every row is collected here and omitted from the stream, so only positions are yielded.
    filterRow: async (rowJson) => {
      let row: unknown;
      try {
        row = JSON.parse(rowJson);
      } catch {
        return invalid();
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid();
      rows.push(row as PortableSqliteRow);
      return false;
    },
  })[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) return { rows, end, exhausted: true };
      if (next.value.bytes.length) invalid();
      if (next.value.nextCursor.chunk !== 0) invalid();
      end = next.value.nextCursor.after;
      // A collected row's position follows it; progress-only positions may come in between.
      if (rows.length === SLICE_ROWS || queries >= queryBudget)
        return { rows, end, exhausted: false };
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size)
    result.push(values.slice(offset, offset + size));
  return result;
}

/** Too many rows changed since the boundary; this snapshot will not shrink on retry. */
async function withinLimit<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Error && error.message === 'backup_snapshot_lookup_preimage_limit')
      throw new Error('backup_export_too_large');
    throw error;
  }
}

async function lookup(
  source: SliceSource,
  entry: PlannedInstalledSqliteDataset,
  column: string,
  values: readonly string[]
): Promise<PortableSqliteRow[]> {
  const rows: PortableSqliteRow[] = [];
  for (const batch of chunks([...new Set(values)], SQLITE_SNAPSHOT_LOOKUP_MAX_VALUES))
    for (const { row } of await withinLimit(() =>
      lookupSqliteSnapshotRows({
        database: source.database,
        schema: entry.capture,
        snapshotId: source.snapshotId,
        tenantId: source.tenantId,
        column,
        values: batch,
        ...(entry.partitions?.length ? { partitions: entry.partitions } : {}),
        preimageLimit: LOOKUP_PREIMAGE_LIMIT,
        signal: source.signal,
      })
    ))
      rows.push(row);
  return rows;
}

/** Join T0 log catalog rows with aggregates of their T0 committed record index rows. */
async function logObjectRows(
  source: SliceSource,
  planned: readonly PlannedInstalledSqliteDataset[],
  family: TenantBackupR2SourceFamily,
  tenantKey: string,
  rows: readonly PortableSqliteRow[]
): Promise<TenantBackupLogObjectRow[]> {
  const candidates = rows.filter(
    (row) =>
      text(row, 'status') === 'committed' &&
      text(row, 'object_kind') === 'chunk' &&
      integer(row, 'deleted_at') === null
  );
  for (const row of candidates) if (requiredText(row, 'tenant_key') !== tenantKey) invalid();
  // Committed T0 index rows per (catalog, log type, plane, chunk), aggregated in SQL.
  const indexEntry = plannedEntry(planned, family, 'log_chunk_record_index');
  const byCatalog = new Map<
    string,
    { logType: string; plane: string; chunkId: string; count: number; min: number; max: number }[]
  >();
  for (const batch of chunks(
    candidates.map((row) => requiredText(row, 'id')),
    SQLITE_SNAPSHOT_LOOKUP_MAX_VALUES
  ))
    for (const aggregate of await withinLimit(() =>
      aggregateSqliteSnapshotRows({
        database: source.database,
        schema: indexEntry.capture,
        snapshotId: source.snapshotId,
        tenantId: source.tenantId,
        column: 'object_catalog_id',
        values: batch,
        groupColumns: ['object_catalog_id', 'log_type', 'plane', 'chunk_id'],
        filters: { status: 'committed', tenant_key: tenantKey },
        rangeColumn: 'event_at',
        ...(indexEntry.partitions?.length ? { partitions: indexEntry.partitions } : {}),
        preimageLimit: LOOKUP_PREIMAGE_LIMIT,
        signal: source.signal,
      })
    )) {
      const [catalogId, logType, plane, chunkId] = aggregate.group;
      const entries = byCatalog.get(catalogId) ?? [];
      entries.push({ logType, plane, chunkId, ...aggregate });
      byCatalog.set(catalogId, entries);
    }
  return candidates.map((row) => {
    const id = requiredText(row, 'id');
    const logType = requiredText(row, 'log_type');
    const plane = requiredText(row, 'plane');
    const committed = (byCatalog.get(id) ?? []).filter(
      (entry) => entry.logType === logType && entry.plane === plane
    );
    const chunkIds = committed.map(({ chunkId }) => chunkId).sort();
    const count = committed.reduce((total, entry) => total + entry.count, 0);
    return {
      id,
      log_type: logType,
      plane,
      object_key: requiredText(row, 'object_key'),
      record_count: integer(row, 'record_count') ?? invalid(),
      byte_count: integer(row, 'byte_count') ?? invalid(),
      checksum_sha256: text(row, 'checksum_sha256'),
      compression: text(row, 'compression'),
      encryption_scope: text(row, 'encryption_scope'),
      key_version: integer(row, 'key_version'),
      created_at: integer(row, 'created_at') ?? invalid(),
      index_count: count,
      first_event_at: committed.length ? Math.min(...committed.map(({ min }) => min)) : null,
      last_event_at: committed.length ? Math.max(...committed.map(({ max }) => max)) : null,
      first_chunk_id: chunkIds[0] ?? null,
      last_chunk_id: chunkIds[chunkIds.length - 1] ?? null,
    };
  });
}

/** Join T0 physical objects with their T0 catalog and sensitive-detail rows, as the lister did. */
async function objectCatalogRows(
  source: SliceSource,
  planned: readonly PlannedInstalledSqliteDataset[],
  family: TenantBackupR2SourceFamily,
  rows: readonly PortableSqliteRow[]
): Promise<TenantBackupObjectCatalogRow[]> {
  const objects = rows.filter((row) => integer(row, 'deleted_at') === null);
  const catalogIds = objects.map((row) => requiredText(row, 'catalog_id'));
  const catalogs = new Map<string, PortableSqliteRow>();
  for (const row of await lookup(
    source,
    plannedEntry(planned, family, 'object_catalog'),
    'id',
    catalogIds
  ))
    catalogs.set(requiredText(row, 'id'), row);
  const sensitive = new Map<string, PortableSqliteRow>();
  for (const row of await lookup(
    source,
    plannedEntry(planned, family, 'sensitive_detail_chunk_index'),
    'catalog_id',
    catalogIds
  ))
    if (requiredText(row, 'tenant_id') === source.tenantId && integer(row, 'deleted_at') === null)
      sensitive.set(requiredText(row, 'catalog_id'), row);
  const joined: TenantBackupObjectCatalogRow[] = [];
  for (const row of objects) {
    const catalog = catalogs.get(requiredText(row, 'catalog_id'));
    if (
      !catalog ||
      requiredText(catalog, 'tenant_id') !== source.tenantId ||
      integer(catalog, 'deleted_at') !== null ||
      requiredText(catalog, 'object_class') === 'dr_bundle'
    )
      continue;
    const objectKey = requiredText(row, 'object_key');
    const detail = sensitive.get(requiredText(row, 'catalog_id'));
    const matched = detail && requiredText(detail, 'object_key') === objectKey ? detail : null;
    joined.push({
      id: requiredText(row, 'id'),
      catalog_id: requiredText(row, 'catalog_id'),
      object_class: requiredText(catalog, 'object_class'),
      bucket_binding: requiredText(row, 'bucket_binding'),
      object_key: objectKey,
      key_version: integer(row, 'key_version') ?? invalid(),
      checksum_sha256: text(row, 'checksum_sha256'),
      total_bytes: integer(row, 'total_bytes'),
      sensitive_catalog_id: matched ? requiredText(matched, 'catalog_id') : null,
      sensitive_object_class: matched ? requiredText(matched, 'object_class') : null,
      content_encoding: matched ? requiredText(matched, 'content_encoding') : null,
      line_number: matched ? integer(matched, 'line_number') : null,
      byte_offset: matched ? integer(matched, 'byte_offset') : null,
      byte_length: matched ? integer(matched, 'byte_length') : null,
      sensitive_key_version: matched ? integer(matched, 'key_version') : null,
      sensitive_checksum_sha256: matched ? text(matched, 'checksum_sha256') : null,
      sensitive_created_at: matched ? integer(matched, 'created_at') : null,
    });
  }
  return joined;
}

function heldRows(
  table: StreamTable,
  rows: readonly PortableSqliteRow[]
): TenantBackupHeldPayloadRow[] {
  if (table === 'logging_dlq_items')
    return rows
      .filter((row) => text(row, 'status') === 'open')
      .map((row) => ({
        id: requiredText(row, 'id'),
        payload_object_ref: requiredText(row, 'payload_object_ref'),
        payload_sha256: null,
        hold_dataset_id: 'admin.logging_dlq_items' as const,
      }));
  return rows
    .filter((row) => MESSAGE_JOB_HELD_STATES.has(text(row, 'status') ?? ''))
    .map((row) => ({
      id: requiredText(row, 'id'),
      payload_object_ref: requiredText(row, 'payload_object_ref'),
      payload_sha256: requiredText(row, 'payload_sha256'),
      hold_dataset_id: 'admin.logging_message_jobs' as const,
    }));
}

/**
 * Stage the plans of every selected R2 body dataset from the T0 SQL snapshot, after the write
 * hold. Each call works through a few slices and returns its position; the export preparation
 * persists it and calls again until `done`.
 */
export async function prepareTenantBackupR2Plans(input: {
  context: AdapterContext;
  planned: readonly PlannedInstalledSqliteDataset[];
  targets: readonly TenantBackupR2PlanTarget[];
  tenantKey: string;
  boundaryUnixMs: number;
  cursor: string | null;
  /** Test hook: a smaller per-slice query budget. */
  sliceQueryBudget?: number;
}): Promise<{ cursor: string | null; done: boolean }> {
  const { context } = input;
  const tenantId = context.context.lease.tenantId;
  const datasets = input.targets.map(({ datasetId }) => datasetId);
  if (
    new Set(datasets).size !== datasets.length ||
    datasets.some(
      (datasetId) =>
        !['artifacts.object_catalog_bodies', 'logs.archive_object_bodies'].includes(datasetId)
    ) ||
    !Number.isSafeInteger(input.boundaryUnixMs) ||
    input.boundaryUnixMs < 0
  )
    invalid();
  const cursor = parseCursor(input.cursor, datasets.length);
  const items = workItems(context, input.planned, datasets);
  if (cursor.item > items.length || (cursor.item === items.length && cursor.after !== ''))
    invalid();
  const scoped: AdapterContext = { ...context, boundaryUnixMs: input.boundaryUnixMs };
  const ready = (index: number) => {
    // A dataset is ready once all its work items lie before the cursor.
    const datasetId = input.targets[index].datasetId;
    const last = items.reduce(
      (found, work, ordinal) => (work.datasetId === datasetId ? ordinal : found),
      -1
    );
    return !cursor.published[index] && last < cursor.item;
  };
  // Publication only happens here, from the saved cursor: its page counts are the confirmed ones,
  // and no slice of a published dataset runs again when a later part of this call fails.
  const publishReady = async () => {
    for (const [index, target] of input.targets.entries()) {
      if (!ready(index)) continue;
      await target.port.publishPlans(
        scoped,
        target.snapshotId,
        input.boundaryUnixMs,
        cursor.pages[index]
      );
      cursor.published[index] = true;
    }
  };
  await publishReady();
  for (let slice = 0; slice < SLICES_PER_CALL && cursor.item < items.length; slice++) {
    context.context.signal.throwIfAborted();
    const work = items[cursor.item];
    const entry = plannedEntry(input.planned, work.family, work.table);
    const capture = await context.snapshotResources.loadCapture(
      context.context.lease,
      work.resourceId
    );
    if (capture.resourceId !== work.resourceId) invalid();
    const source: SliceSource = {
      database: await context.resolveSource({ resourceId: work.resourceId, family: work.family }),
      snapshotId: capture.snapshotId,
      tenantId,
      signal: context.context.signal,
    };
    const read = await readSlice(
      source,
      entry,
      cursor.after,
      input.sliceQueryBudget ?? SLICE_QUERY_BUDGET
    );
    const r2Source: TenantBackupR2Source = { family: work.family, databaseId: work.resourceId };
    let descriptors: TenantBackupR2ObjectDescriptor[];
    if (work.table === 'log_object_catalog')
      descriptors = buildTenantBackupLogObjectDescriptors(
        scoped,
        r2Source,
        tenantId,
        input.tenantKey,
        await logObjectRows(source, input.planned, work.family, input.tenantKey, read.rows)
      );
    else if (work.table === 'object_catalog_objects')
      descriptors = buildTenantBackupObjectCatalogDescriptors(
        scoped,
        r2Source,
        tenantId,
        await objectCatalogRows(source, input.planned, work.family, read.rows)
      );
    else
      descriptors = buildTenantBackupHeldPayloadDescriptors(
        scoped,
        r2Source,
        tenantId,
        input.tenantKey,
        heldRows(work.table, read.rows)
      );
    if (descriptors.length > DEFERRED_PLAN_PAGE_MAX_PLANS) invalid();
    const index = datasets.indexOf(work.datasetId);
    const target = input.targets[index] ?? invalid();
    if (descriptors.length) {
      await target.port.writePlanPage(
        scoped,
        target.snapshotId,
        cursor.pages[index],
        descriptors.map((descriptor) => encodeTenantBackupR2ObjectPlan(descriptor, work.datasetId))
      );
      cursor.pages[index]++;
    }
    if (read.exhausted) {
      cursor.item++;
      cursor.after = '';
      // Save the cursor before the next call publishes this dataset.
      if (input.targets.some((_, index) => ready(index))) break;
    } else cursor.after = read.end;
  }
  const done = cursor.item === items.length && cursor.published.every(Boolean);
  return { cursor: done ? null : JSON.stringify(cursor), done };
}

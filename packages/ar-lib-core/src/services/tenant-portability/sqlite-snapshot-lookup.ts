import type { DatabaseAdapter } from '../../db/adapter';
import type { PortableSqliteRow } from './sqlite-dataset-inspector';
import { packedSqliteRowToJson } from './sqlite-packed-row';
import {
  sqliteSnapshotLiveAggregateQuery,
  sqliteSnapshotLiveLookupQuery,
  sqliteSnapshotPreimageCountQuery,
  sqliteSnapshotPreimagePageQuery,
  type CaptureSchema,
} from './sqlite-snapshot';

/** Values bound in one lookup; D1 binds the JSON array as one parameter. */
export const SQLITE_SNAPSHOT_LOOKUP_MAX_VALUES = 256;
const PREIMAGE_PAGE_ROWS = 500;
const MAX_ROW_BYTES = 256 * 1024;

interface EncodedRow {
  record_key: string;
  row_type: string;
  row_hex: string | null;
}

export interface SqliteSnapshotLookupRow {
  recordKey: string;
  row: PortableSqliteRow;
}

function invalid(code = 'backup_snapshot_lookup_invalid'): never {
  throw new Error(code);
}

function hexBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9A-F]*$/.test(hex)) invalid();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function decodeRow(row: EncodedRow, columns: readonly string[]): Promise<PortableSqliteRow> {
  if (typeof row.record_key !== 'string' || !row.record_key || typeof row.row_hex !== 'string')
    invalid();
  if (row.row_hex.length > MAX_ROW_BYTES * 2) invalid('backup_snapshot_lookup_row_too_large');
  const bytes = hexBytes(row.row_hex);
  let text = '';
  if (row.row_type === 'blob') {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for await (const part of packedSqliteRowToJson(
      (async function* () {
        yield bytes;
      })(),
      columns
    ))
      text += decoder.decode(part, { stream: true });
    text += decoder.decode();
  } else if (row.row_type === 'text') {
    // Legacy preimages stored typed JSON text.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } else invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  return parsed as PortableSqliteRow;
}

function textValue(row: PortableSqliteRow, column: string): string | null {
  const value = row[column];
  return value?.[0] === 'text' && typeof value[1] === 'string' ? value[1] : null;
}

async function readPreimages(
  input: {
    database: Pick<DatabaseAdapter, 'query'>;
    schema: CaptureSchema;
    snapshotId: string;
    tenantId: string;
    partitions?: readonly string[];
    preimageLimit: number;
    signal?: AbortSignal;
  },
  visit: (recordKey: string, row: PortableSqliteRow) => void
): Promise<void> {
  const preimageSql = sqliteSnapshotPreimagePageQuery(input.schema, input.partitions);
  let after = '';
  let read = 0;
  while (true) {
    input.signal?.throwIfAborted();
    const page = await input.database.query<EncodedRow>(preimageSql, [
      input.snapshotId,
      input.tenantId,
      after,
      PREIMAGE_PAGE_ROWS,
    ]);
    for (const encoded of page) {
      read++;
      if (read > input.preimageLimit) invalid('backup_snapshot_lookup_preimage_limit');
      if (typeof encoded.record_key !== 'string' || encoded.record_key <= after) invalid();
      after = encoded.record_key;
      visit(encoded.record_key, await decodeRow(encoded, input.schema.columns));
    }
    if (page.length < PREIMAGE_PAGE_ROWS) return;
  }
}

export interface SqliteSnapshotAggregate {
  /** The `groupColumns` values, as text. */
  group: readonly string[];
  count: number;
  min: number;
  max: number;
}

/**
 * Boundary (T0) aggregates of one table's rows whose text `column` equals one of `values` and
 * whose text `filters` match: count and integer range of `rangeColumn` per `groupColumns`. Live
 * rows are aggregated in SQL, so the memory used is bounded by the groups, not the rows; the
 * boundary values of changed rows come from their preimages. A row first changed between the two
 * reads would be counted twice, so the number of present preimages is compared before and after
 * and the lookup is repeated when it moved.
 */
export async function aggregateSqliteSnapshotRows(input: {
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
  schema: CaptureSchema;
  snapshotId: string;
  tenantId: string;
  column: string;
  values: readonly string[];
  groupColumns: readonly string[];
  filters: Readonly<Record<string, string>>;
  rangeColumn: string;
  partitions?: readonly string[];
  preimageLimit: number;
  signal?: AbortSignal;
}): Promise<SqliteSnapshotAggregate[]> {
  const values = [...new Set(input.values)];
  if (!values.length) return [];
  if (
    values.length > SQLITE_SNAPSHOT_LOOKUP_MAX_VALUES ||
    values.some((value) => typeof value !== 'string' || !value) ||
    !Number.isSafeInteger(input.preimageLimit) ||
    input.preimageLimit < 0
  )
    invalid();
  if (!input.groupColumns.includes(input.column)) invalid();
  const filters = Object.entries(input.filters);
  const sql = sqliteSnapshotLiveAggregateQuery(
    input.schema,
    input.column,
    input.groupColumns,
    filters.map(([name]) => name),
    input.rangeColumn,
    input.partitions
  );
  const countSql = sqliteSnapshotPreimageCountQuery(input.schema);
  const preimageCount = async () => {
    const row = await input.database.queryOne<{ preimages: number }>(countSql, [
      input.snapshotId,
      input.tenantId,
    ]);
    if (!row || !Number.isSafeInteger(row.preimages) || row.preimages < 0) invalid();
    return row.preimages;
  };
  const wanted = new Set(values);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await preimageCount();
    const groups = new Map<string, SqliteSnapshotAggregate>();
    const add = (group: string[], count: number, min: number, max: number) => {
      const key = JSON.stringify(group);
      const current = groups.get(key);
      groups.set(
        key,
        current
          ? {
              group,
              count: current.count + count,
              min: Math.min(current.min, min),
              max: Math.max(current.max, max),
            }
          : { group, count, min, max }
      );
    };
    const live = await input.database.query<Record<string, unknown>>(sql, [
      input.snapshotId,
      input.tenantId,
      JSON.stringify(values),
      ...filters.map(([, value]) => value),
    ]);
    for (const row of live) {
      const group = input.groupColumns.map((_, index) => row[`g${index}`]);
      const { row_count: count, min_value: min, max_value: max } = row;
      if (
        group.some((value) => typeof value !== 'string') ||
        !wanted.has(group[input.groupColumns.indexOf(input.column)] as string) ||
        !Number.isSafeInteger(count) ||
        (count as number) < 1 ||
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(max)
      )
        invalid();
      add(group as string[], count as number, min as number, max as number);
    }
    await readPreimages(input, (_recordKey, row) => {
      const value = textValue(row, input.column);
      if (value === null || !wanted.has(value)) return;
      if (filters.some(([name, expected]) => textValue(row, name) !== expected)) return;
      const group = input.groupColumns.map((name) => textValue(row, name));
      if (group.some((item) => item === null)) invalid();
      const range = row[input.rangeColumn];
      if (range?.[0] !== 'integer' || range[1] === null) invalid();
      const at = Number(range[1]);
      if (!Number.isSafeInteger(at)) invalid();
      add(group as string[], 1, at, at);
    });
    if ((await preimageCount()) === before) return [...groups.values()];
  }
  // Rows keep changing under the snapshot; a later transition reads again.
  return invalid('backup_snapshot_lookup_unstable');
}

/**
 * Boundary (T0) rows of one captured table whose text `column` equals one of `values`.
 *
 * Live rows are read first, then the table's preimages. A row is live in T0 form only while no
 * preimage marker exists for it; the trigger writes its first preimage before the change, so a
 * row changed between the two reads is excluded from neither: both carry its T0 value. Rows are
 * deduplicated by record_key, preferring the preimage. Preimages are read in full, so a table
 * whose rows changed more than `preimageLimit` times since the boundary is refused.
 */
export async function lookupSqliteSnapshotRows(input: {
  database: Pick<DatabaseAdapter, 'query'>;
  schema: CaptureSchema;
  snapshotId: string;
  tenantId: string;
  column: string;
  values: readonly string[];
  partitions?: readonly string[];
  preimageLimit: number;
  signal?: AbortSignal;
}): Promise<SqliteSnapshotLookupRow[]> {
  const values = [...new Set(input.values)];
  if (!values.length) return [];
  if (
    values.length > SQLITE_SNAPSHOT_LOOKUP_MAX_VALUES ||
    values.some((value) => typeof value !== 'string' || !value) ||
    !Number.isSafeInteger(input.preimageLimit) ||
    input.preimageLimit < 0
  )
    invalid();
  const wanted = new Set(values);
  const rows = new Map<string, PortableSqliteRow>();
  const live = await input.database.query<EncodedRow>(
    sqliteSnapshotLiveLookupQuery(input.schema, input.column, input.partitions),
    [input.snapshotId, input.tenantId, JSON.stringify(values)]
  );
  for (const encoded of live) {
    input.signal?.throwIfAborted();
    const row = await decodeRow(encoded, input.schema.columns);
    const value = textValue(row, input.column);
    if (value === null || !wanted.has(value)) invalid();
    rows.set(encoded.record_key, row);
  }
  await readPreimages(input, (recordKey, row) => {
    const value = textValue(row, input.column);
    if (value !== null && wanted.has(value)) rows.set(recordKey, row);
    else rows.delete(recordKey);
  });
  return [...rows].map(([recordKey, row]) => ({ recordKey, row }));
}

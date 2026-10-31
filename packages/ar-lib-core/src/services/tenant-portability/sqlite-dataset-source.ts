import type { DatabaseAdapter } from '../../db/adapter';
import {
  sqliteSnapshotPageQuery,
  sqliteSnapshotRowQuery,
  type CaptureSchema,
} from './sqlite-snapshot';
import { packedSqliteRowToJson } from './sqlite-packed-row';

const PAGE_ROWS = 100;
/**
 * Consecutive short pages (mostly omitted rows: post-T0 inserts, rewritten rows, other tenants'
 * rows) double how many keys the next page scans, up to this bound. A run of R omitted rows then
 * costs about
 * log2(R / PAGE_ROWS) + R / MAX_SCAN_ROWS queries instead of R / PAGE_ROWS, which matters
 * because one export step shares a single Worker invocation's subrequest budget.
 */
const MAX_SCAN_ROWS = 128 * PAGE_ROWS;
const FRAGMENT_BYTES = 256 * 1024;
const READ_BATCH_ROWS = 250;
const READ_BATCH_BYTES = 1024 * 1024;
/**
 * D1 queries one readNext call may start before it returns what it has. Omitted rows (post-T0
 * inserts, rows a filter drops) produce no bytes, so without this a call could walk a whole table.
 */
const READ_QUERY_BUDGET = 24;
const NATIVE_KEY_TAGS = new Set(['integer', 'text', 'blob']);

/**
 * Pages order REAL keys by a decimal text form that does not round-trip (for example -Inf), so a
 * position after one could skip rows. No captured table keys on REAL; refuse rather than guess.
 */
function assertNativeRecordKey(recordKey: string): void {
  let terms: unknown;
  try {
    terms = JSON.parse(recordKey);
  } catch {
    throw new Error('backup_snapshot_invalid_row');
  }
  if (
    !Array.isArray(terms) ||
    !terms.length ||
    terms.some((term) => !Array.isArray(term) || typeof term[0] !== 'string')
  )
    throw new Error('backup_snapshot_invalid_row');
  if (terms.some((term) => !NATIVE_KEY_TAGS.has((term as [string])[0])))
    throw new Error('backup_snapshot_unsupported_key_type');
}

export interface SqliteSnapshotSourceCursor {
  /** Last fully emitted row key; source identity is pinned by the operation inventory. */
  after: string;
  /** Deterministic output chunk within the next row. Large rows replay only that row on resume. */
  chunk: number;
  /**
   * Row order the position belongs to. Positions written before native primary key paging
   * followed record_key text order and cannot be resumed under the current order.
   */
  order?: 'native';
}
interface SourceInput {
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
  schema: CaptureSchema;
  snapshotId: string;
  tenantId: string;
  signal: AbortSignal;
  /** Required when the trusted capture schema partitions one physical table. */
  partitions?: readonly string[];
  /** Deterministic installed transformation applied before bytes enter the encrypted bundle. */
  /** Return false to omit one installed-policy row while advancing the trusted source scan. */
  filterRow?: (rowJson: string) => Promise<boolean>;
  transformRow?: (rowJson: string) => Promise<string>;
  /** Operation-local cached proof that this pinned snapshot is still active. */
  assertSnapshotActive?: () => Promise<void>;
}

/**
 * The statements one snapshot read sends. Each must stay under D1's SQL statement length limit
 * (100,000 bytes) for every captured table, including wide tables and long composite keys.
 */
export function sqliteSnapshotReadStatements(
  schema: CaptureSchema,
  partitions?: readonly string[]
): { sql: string; fastSql: string; fragmentSql: string } {
  const pageSql = sqliteSnapshotPageQuery(schema, 'packed', partitions, {
    scanLimit: true,
  });
  // MATERIALIZED: a row body is read by key once, not once per reference to row_json.
  const sql = `WITH candidates AS MATERIALIZED (${pageSql})
    SELECT record_key,typeof(row_json) AS row_type,length(CAST(row_json AS BLOB)) AS total_bytes,
      count(*) OVER () AS page_rows
    FROM candidates ORDER BY page_order`;
  const fastSql = `WITH candidates AS MATERIALIZED (${pageSql}), ranked AS (
    SELECT record_key,typeof(row_json) AS row_type,length(CAST(row_json AS BLOB)) AS total_bytes,
      CAST(row_json AS BLOB) AS row_blob,
      page_order, count(*) OVER () AS page_rows,
      sum(length(CAST(row_json AS BLOB))) OVER (ORDER BY page_order) AS cumulative_bytes,
      max(length(CAST(row_json AS BLOB))) OVER (ORDER BY page_order) AS max_prefix_bytes
    FROM candidates
  ) SELECT record_key,row_type,total_bytes,page_rows,hex(row_blob) AS fragment
    FROM ranked WHERE (cumulative_bytes<=? AND max_prefix_bytes<=?) OR row_blob IS NULL
    ORDER BY page_order`;
  const fragmentSql = `WITH candidate AS (${sqliteSnapshotRowQuery(schema, 'packed', partitions)})
    SELECT record_key,typeof(row_json) AS row_type,length(CAST(row_json AS BLOB)) AS total_bytes,
      hex(substr(CAST(row_json AS BLOB),?,?)) AS fragment
    FROM candidate`;
  return { sql, fastSql, fragmentSql };
}

/**
 * Trusted COW source with durable output positions. Cursor must come from the same operation.
 * A zero-byte item only moves the position past omitted rows.
 */
export async function* readSqliteSnapshotChunks(
  input: SourceInput & {
    cursor?: SqliteSnapshotSourceCursor;
    /**
     * Rows the caller stops after. Without a row filter the last page asks for only the rows
     * still needed, so a caller that drops the iterator does not read rows its next call re-pages.
     */
    rowLimit?: number;
  }
): AsyncGenerator<{ bytes: Uint8Array; nextCursor: SqliteSnapshotSourceCursor }> {
  const { database, snapshotId, tenantId, signal } = input;
  const { sql, fastSql, fragmentSql } = sqliteSnapshotReadStatements(
    input.schema,
    input.partitions
  );
  async function active(): Promise<void> {
    signal.throwIfAborted();
    if (input.assertSnapshotActive) {
      await input.assertSnapshotActive();
      signal.throwIfAborted();
      return;
    }
    const snapshot = await database.queryOne<{ id: string }>(
      "SELECT id FROM tenant_backup_snapshots WHERE id=? AND tenant_id=? AND state='capturing'",
      [snapshotId, tenantId]
    );
    if (!snapshot) throw new Error('backup_snapshot_unavailable');
  }
  interface Row {
    record_key: string;
    /** 'null' marks a progress-only row: the cursor moves past rows the snapshot omits. */
    row_type: 'blob' | 'text' | 'null';
    total_bytes: number;
    /** Rows on the whole page, before the fast read cuts it to the byte budget. */
    page_rows?: number;
    fragment?: string;
  }
  function decodeFragment(fragment: string): Uint8Array {
    if (fragment.length % 2 !== 0 || !/^[0-9A-F]+$/.test(fragment))
      throw new Error('backup_snapshot_invalid_fragment');
    const bytes = new Uint8Array(fragment.length / 2);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = parseInt(fragment.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  async function* fragments(row: Row): AsyncGenerator<Uint8Array> {
    let offset = 0;
    while (offset < row.total_bytes) {
      await active();
      const part = await database.queryOne<Row & { fragment: string }>(fragmentSql, [
        snapshotId,
        tenantId,
        row.record_key,
        offset + 1,
        FRAGMENT_BYTES,
      ]);
      await active();
      if (
        !part ||
        part.record_key !== row.record_key ||
        part.row_type !== row.row_type ||
        part.total_bytes !== row.total_bytes ||
        typeof part.fragment !== 'string' ||
        part.fragment.length !== Math.min(FRAGMENT_BYTES, row.total_bytes - offset) * 2 ||
        !/^[0-9A-F]+$/.test(part.fragment)
      )
        throw new Error('backup_snapshot_invalid_fragment');
      const bytes = decodeFragment(part.fragment);
      yield bytes;
      offset += bytes.length;
    }
    await active();
  }
  async function* coalesce(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    let buffer = new Uint8Array(FRAGMENT_BYTES),
      filled = 0;
    for await (const chunk of source) {
      let offset = 0;
      while (offset < chunk.length) {
        const size = Math.min(FRAGMENT_BYTES - filled, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + size), filled);
        filled += size;
        offset += size;
        if (filled === FRAGMENT_BYTES) {
          yield buffer;
          buffer = new Uint8Array(FRAGMENT_BYTES);
          filled = 0;
        }
      }
    }
    if (filled) yield buffer.slice(0, filled);
  }
  let after = input.cursor?.after ?? '';
  let skip = input.cursor?.chunk ?? 0;
  if (typeof after !== 'string' || !Number.isSafeInteger(skip) || skip < 0)
    throw new Error('backup_snapshot_invalid_cursor');
  // A legacy position names a row in record_key text order; resuming it here would skip or repeat rows.
  if (input.cursor && input.cursor.order !== 'native' && (after !== '' || skip !== 0))
    throw new Error('backup_snapshot_invalid_cursor');
  if (after !== '') assertNativeRecordKey(after);
  let scanRows = PAGE_ROWS;
  let completedRows = 0;
  const rowLimit = input.filterRow ? undefined : input.rowLimit;
  while (true) {
    await active();
    const remaining = rowLimit === undefined ? PAGE_ROWS : rowLimit - completedRows;
    const pageLimit = remaining > 0 && remaining < PAGE_ROWS ? remaining : PAGE_ROWS;
    // A normal page scans as many keys as it returns; only pages after short ones scan wider.
    const pageScanRows = scanRows === PAGE_ROWS ? pageLimit : scanRows;
    let rows =
      skip === 0
        ? await database.query<Row>(fastSql, [
            snapshotId,
            tenantId,
            after,
            pageLimit,
            pageScanRows,
            READ_BATCH_BYTES,
            FRAGMENT_BYTES,
          ])
        : [];
    if (!rows.length)
      rows = await database.query<Row>(sql, [snapshotId, tenantId, after, pageLimit, pageScanRows]);
    await active();
    if (!rows.length) {
      if (skip) throw new Error('backup_snapshot_invalid_cursor');
      return;
    }
    if (rows[0].row_type === 'null') {
      // Every scanned row was omitted. A resumed row is still the next row after the new
      // position, so its skip count carries over.
      const [progress] = rows;
      if (
        rows.length !== 1 ||
        typeof progress.record_key !== 'string' ||
        !progress.record_key ||
        progress.record_key === after
      )
        throw new Error('backup_snapshot_invalid_row');
      assertNativeRecordKey(progress.record_key);
      after = progress.record_key;
      scanRows = Math.min(scanRows * 2, MAX_SCAN_ROWS);
      // A position-only step: the batch it ends carries the new position, so the next read does
      // not walk the same omitted rows again. Mid-row positions stay on the resumed row.
      if (skip === 0)
        yield { bytes: new Uint8Array(0), nextCursor: { after, chunk: 0, order: 'native' } };
      continue;
    }
    // A short page met mostly omitted rows, such as other tenants' rows in a shared table: scan
    // wider. A full page found enough rows: scan one page again, so a dense run is not read
    // MAX_SCAN_ROWS keys at a time.
    const pageRows = rows[0].page_rows;
    if (!Number.isSafeInteger(pageRows) || (pageRows ?? 0) < rows.length)
      throw new Error('backup_snapshot_invalid_row');
    // A page trimmed to the rows this call still needs is short by request, not by omissions.
    scanRows = (pageRows ?? 0) < pageLimit ? Math.min(scanRows * 2, MAX_SCAN_ROWS) : PAGE_ROWS;
    for (const row of rows) {
      signal.throwIfAborted();
      if (
        typeof row.record_key !== 'string' ||
        !row.record_key ||
        row.record_key === after ||
        !['blob', 'text'].includes(row.row_type) ||
        !Number.isSafeInteger(row.total_bytes) ||
        row.total_bytes < 1
      )
        throw new Error('backup_snapshot_invalid_row');
      assertNativeRecordKey(row.record_key);
      async function* rawRowChunks(): AsyncGenerator<Uint8Array> {
        const raw = row.fragment
          ? (async function* () {
              const bytes = decodeFragment(row.fragment ?? '');
              if (bytes.length !== row.total_bytes)
                throw new Error('backup_snapshot_invalid_fragment');
              yield bytes;
            })()
          : fragments(row);
        if (row.row_type === 'blob')
          yield* coalesce(packedSqliteRowToJson(raw, input.schema.columns));
        else {
          yield* raw;
          yield new Uint8Array([10]);
        }
      }
      async function* rowChunks(): AsyncGenerator<Uint8Array> {
        if (!input.transformRow && !input.filterRow) {
          yield* rawRowChunks();
          return;
        }
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        let rowJson = '';
        for await (const part of rawRowChunks()) {
          rowJson += decoder.decode(part, { stream: true });
          if (new TextEncoder().encode(rowJson).length > 256 * 1024)
            throw new Error('backup_snapshot_transform_row_limit');
        }
        rowJson += decoder.decode();
        if (!rowJson.endsWith('\n')) throw new Error('backup_snapshot_transform_row_invalid');
        rowJson = rowJson.slice(0, -1);
        if (input.filterRow && !(await input.filterRow(rowJson))) return;
        const transformed = input.transformRow ? await input.transformRow(rowJson) : rowJson;
        const bytes = new TextEncoder().encode(transformed + '\n');
        if (bytes.length > 256 * 1024) throw new Error('backup_snapshot_transform_row_limit');
        for (let offset = 0; offset < bytes.length; offset += FRAGMENT_BYTES)
          yield bytes.slice(offset, offset + FRAGMENT_BYTES);
      }
      const iterator = rowChunks()[Symbol.asyncIterator]();
      let ordinal = 0;
      try {
        let current = await iterator.next();
        while (!current.done) {
          const next = await iterator.next();
          if (ordinal >= skip)
            yield {
              bytes: current.value,
              nextCursor: next.done
                ? { after: row.record_key, chunk: 0, order: 'native' }
                : { after, chunk: ordinal + 1, order: 'native' },
            };
          ordinal++;
          current = next;
        }
        if ((ordinal === 0 && skip !== 0) || (ordinal > 0 && skip >= ordinal))
          throw new Error('backup_snapshot_invalid_cursor');
      } finally {
        await iterator.return?.(undefined);
      }
      // A filtered row emits nothing; its position still moves the cursor.
      if (ordinal === 0)
        yield {
          bytes: new Uint8Array(0),
          nextCursor: { after: row.record_key, chunk: 0, order: 'native' },
        };
      skip = 0;
      after = row.record_key;
      completedRows++;
    }
  }
}

/** Compatibility streaming API; production resumable writers use readSqliteSnapshotChunks. */
export async function* readSqliteSnapshotDataset(input: SourceInput): AsyncGenerator<Uint8Array> {
  for await (const chunk of readSqliteSnapshotChunks(input))
    if (chunk.bytes.length) yield chunk.bytes;
}

/**
 * Read one resumable chunk and release the iterator before returning to the durable executor.
 * A call that spends its query budget on omitted rows returns zero bytes with the new position;
 * null means the dataset has no more rows.
 */
export async function readNextSqliteSnapshotChunk(
  input: SourceInput,
  cursorJson: string | null
): Promise<{ bytes: Uint8Array; nextCursor: string } | null> {
  let cursor: SqliteSnapshotSourceCursor | undefined;
  if (cursorJson !== null) {
    try {
      cursor = JSON.parse(cursorJson) as SqliteSnapshotSourceCursor;
      if (
        !cursor ||
        typeof cursor.after !== 'string' ||
        !Number.isSafeInteger(cursor.chunk) ||
        cursor.chunk < 0 ||
        (cursor.order !== undefined && cursor.order !== 'native')
      )
        throw new Error('invalid');
    } catch {
      throw new Error('backup_snapshot_invalid_cursor');
    }
  }
  let queries = 0;
  const database: SourceInput['database'] = {
    query<T>(sql: string, params?: unknown[]) {
      queries++;
      return input.database.query<T>(sql, params);
    },
    queryOne<T>(sql: string, params?: unknown[]) {
      queries++;
      return input.database.queryOne<T>(sql, params);
    },
  };
  const iterator = readSqliteSnapshotChunks({
    ...input,
    database,
    cursor,
    rowLimit: READ_BATCH_ROWS,
  });
  try {
    const parts: Uint8Array[] = [];
    let totalBytes = 0;
    let completedRows = 0;
    let nextCursor: SqliteSnapshotSourceCursor | null = null;
    let finished = false;
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        finished = true;
        break;
      }
      if (!next.value.bytes.length) {
        nextCursor = next.value.nextCursor;
        if (queries >= READ_QUERY_BUDGET) break;
        continue;
      }
      if (parts.length > 0 && totalBytes + next.value.bytes.length > READ_BATCH_BYTES) break;
      parts.push(next.value.bytes);
      totalBytes += next.value.bytes.length;
      nextCursor = next.value.nextCursor;
      if (nextCursor.chunk === 0) completedRows++;
      if (
        completedRows >= READ_BATCH_ROWS ||
        totalBytes >= READ_BATCH_BYTES ||
        queries >= READ_QUERY_BUDGET
      )
        break;
    }
    // Positions past omitted rows matter only while rows may follow them.
    if (!nextCursor || (finished && !totalBytes)) return null;
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { bytes, nextCursor: JSON.stringify(nextCursor) };
  } finally {
    await iterator.return(undefined);
  }
}

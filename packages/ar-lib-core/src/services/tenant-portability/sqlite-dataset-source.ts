import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteSnapshotPageQuery, type CaptureSchema } from './sqlite-snapshot';
import { packedSqliteRowToJson } from './sqlite-packed-row';

const PAGE_ROWS = 100;
const FRAGMENT_BYTES = 256 * 1024;

export interface SqliteSnapshotSourceCursor {
  /** Last fully emitted row key; source identity is pinned by the operation inventory. */
  after: string;
  /** Deterministic output chunk within the next row. Large rows replay only that row on resume. */
  chunk: number;
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
  transformRow?: (rowJson: string) => Promise<string>;
}

/** Trusted COW source with durable output positions. Cursor must come from the same operation. */
export async function* readSqliteSnapshotChunks(
  input: SourceInput & { cursor?: SqliteSnapshotSourceCursor }
): AsyncGenerator<{ bytes: Uint8Array; nextCursor: SqliteSnapshotSourceCursor }> {
  const { database, snapshotId, tenantId, signal } = input;
  const pageSql = sqliteSnapshotPageQuery(input.schema, 'packed', input.partitions);
  const sql = `WITH candidates AS (${pageSql})
    SELECT record_key,typeof(row_json) AS row_type,length(CAST(row_json AS BLOB)) AS total_bytes
    FROM candidates ORDER BY record_key`;
  async function active(): Promise<void> {
    signal.throwIfAborted();
    const snapshot = await database.queryOne<{ id: string }>(
      "SELECT id FROM tenant_backup_snapshots WHERE id=? AND tenant_id=? AND state='capturing'",
      [snapshotId, tenantId]
    );
    if (!snapshot) throw new Error('backup_snapshot_unavailable');
  }
  interface Row {
    record_key: string;
    row_type: 'blob' | 'text';
    total_bytes: number;
  }
  const fragmentSql = `WITH candidate AS (${pageSql})
    SELECT record_key,typeof(row_json) AS row_type,length(CAST(row_json AS BLOB)) AS total_bytes,
      hex(substr(CAST(row_json AS BLOB),?,?)) AS fragment
    FROM candidate WHERE record_key=?`;
  async function* fragments(after: string, row: Row): AsyncGenerator<Uint8Array> {
    let offset = 0;
    while (offset < row.total_bytes) {
      await active();
      const part = await database.queryOne<Row & { fragment: string }>(fragmentSql, [
        snapshotId,
        tenantId,
        after,
        1,
        offset + 1,
        FRAGMENT_BYTES,
        row.record_key,
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
      const bytes = new Uint8Array(part.fragment.length / 2);
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(part.fragment.slice(i * 2, i * 2 + 2), 16);
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
  while (true) {
    await active();
    const rows = await database.query<Row>(sql, [snapshotId, tenantId, after, PAGE_ROWS]);
    await active();
    if (!rows.length) {
      if (skip) throw new Error('backup_snapshot_invalid_cursor');
      return;
    }
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
      async function* rawRowChunks(): AsyncGenerator<Uint8Array> {
        if (row.row_type === 'blob')
          yield* coalesce(packedSqliteRowToJson(fragments(after, row), input.schema.columns));
        else {
          yield* fragments(after, row);
          yield new Uint8Array([10]);
        }
      }
      async function* rowChunks(): AsyncGenerator<Uint8Array> {
        if (!input.transformRow) {
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
        const transformed = await input.transformRow(rowJson.slice(0, -1));
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
                ? { after: row.record_key, chunk: 0 }
                : { after, chunk: ordinal + 1 },
            };
          ordinal++;
          current = next;
        }
        if (skip >= ordinal) throw new Error('backup_snapshot_invalid_cursor');
      } finally {
        await iterator.return?.(undefined);
      }
      skip = 0;
      after = row.record_key;
    }
  }
}

/** Compatibility streaming API; production resumable writers use readSqliteSnapshotChunks. */
export async function* readSqliteSnapshotDataset(input: SourceInput): AsyncGenerator<Uint8Array> {
  for await (const chunk of readSqliteSnapshotChunks(input)) yield chunk.bytes;
}

/** Read one resumable chunk and release the iterator before returning to the durable executor. */
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
        cursor.chunk < 0
      )
        throw new Error('invalid');
    } catch {
      throw new Error('backup_snapshot_invalid_cursor');
    }
  }
  const iterator = readSqliteSnapshotChunks({ ...input, cursor });
  try {
    const next = await iterator.next();
    return next.done
      ? null
      : { bytes: next.value.bytes, nextCursor: JSON.stringify(next.value.nextCursor) };
  } finally {
    await iterator.return(undefined);
  }
}

import { inspectLogArchiveTable } from './physical-schema.js';
import { safeReadResolver } from './read-buffer.js';
import { readFlatFileWindow } from './flat-reader.js';
import { IcebergBudgetError, type IcebergLoadedTable, type IcebergObjectStore } from './types.js';

/** A compressed/dictionary file can expand to far more logical input than its
 * object size. Bound selected scalar values before the native full-file writer
 * receives them; never let a constant huge ciphertext multiply into gigabytes. */
export async function assertLogArchiveRewriteBudget(input: {
  table: IcebergLoadedTable;
  store: IcebergObjectStore;
  path: string;
}): Promise<void> {
  const profile = inspectLogArchiveTable(input.table.metadata);
  const resolver = safeReadResolver({
    store: input.store,
    maxFiles: 4,
    maxBytes: 16 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxRows: 1000,
    deadline: Date.now() + 10_000,
    filters: new Map(),
  });
  const file = await resolver.openParquet(input.path);
  const count = Number(file.metadata.num_rows);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000)
    throw new IcebergBudgetError('Archive rewrite row budget exceeded');
  let bytes = 0;
  const encoder = new TextEncoder();
  for (let start = 0; start < count; start += 64) {
    const page = await readFlatFileWindow({
      file,
      profile,
      rowStart: start,
      rowEnd: Math.min(count, start + 64),
    });
    for (const row of page.rows)
      for (const value of Object.values(row.values)) {
        if (typeof value === 'string') {
          if (value.length > 4 * 1024 * 1024 - bytes)
            throw new IcebergBudgetError('Archive rewrite value budget exceeded');
          bytes += encoder.encode(value).byteLength;
        } else bytes += 16;
        if (bytes > 4 * 1024 * 1024)
          throw new IcebergBudgetError('Archive rewrite value budget exceeded');
      }
  }
}

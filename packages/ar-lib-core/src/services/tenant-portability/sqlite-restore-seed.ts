import type { DatabaseAdapter } from '../../db/adapter';
import { sqlitePackedRowExpression } from './sqlite-packed-row';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne'>;
const SCHEMA_PAGE = 128;
// D1 expands table-valued PRAGMAs into many compound SELECT terms internally.
const COLUMN_TABLE_BATCH = 4;
const ROW_TABLE_BATCH = 4;
const MAX_ROWS = 4096;
const MAX_ROW_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const fail = () => new Error('backup_restore_seed_unavailable');
async function digest(value: string): Promise<string> {
  const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hashed), (b) => b.toString(16).padStart(2, '0')).join('');
}
function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail();
  return `"${name}"`;
}
function literal(name: string): string {
  identifier(name);
  return `'${name}'`;
}
function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size)
    result.push(values.slice(offset, offset + size));
  return result;
}

/**
 * Fingerprint a small initialized database under exclusive admission/DDL protection.
 * Expected fingerprints must be captured by trusted provisioning BEFORE the target is used,
 * pinned to its physical identity and never accepted from uploaded bundles or learned at import.
 * Includes all application/runtime tables, indexes, triggers and views, including empty tables.
 * Only Cloudflare's implementation-owned tables and SQLite statistics are excluded.
 * Row values never leave the function; typed packed bytes are hashed, with duplicate counts kept.
 */
export async function readSqliteRestoreSeedFingerprint(
  database: Database,
  assertAdmission: () => Promise<void>
): Promise<string> {
  type ObjectRow = { type: string; name: string; tbl_name: string; sql: string | null };
  async function schema() {
    const objects: ObjectRow[] = [];
    let name = '',
      type = '';
    while (true) {
      const page = await database.query<ObjectRow>(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema
        WHERE tbl_name NOT IN ('_cf_METADATA','_cf_KV') AND tbl_name NOT GLOB 'sqlite_stat*'
        AND (type>? OR (type=? AND name>?)) ORDER BY type,name LIMIT ?`,
        [type, type, name, SCHEMA_PAGE]
      );
      if (!page.length) return objects;
      objects.push(...page);
      if (objects.length > 8192 || JSON.stringify(page).length > MAX_ROW_BYTES) throw fail();
      type = page[page.length - 1].type;
      name = page[page.length - 1].name;
    }
  }
  await assertAdmission();
  const objects = await schema();
  await assertAdmission();
  const schemaDigest = await digest(JSON.stringify(objects));
  const tables = objects.filter((object) => object.type === 'table');
  if (tables.length > 1024) throw fail();
  for (const table of tables) {
    identifier(table.name);
    if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql ?? '')) throw fail();
  }
  const columnsByTable = new Map<string, string[]>();
  for (const batch of batches(tables, COLUMN_TABLE_BATCH)) {
    const selects = batch.map(
      (table) =>
        `SELECT ${literal(table.name)} AS table_name,name,cid FROM pragma_table_xinfo(${literal(table.name)})`
    );
    const columns = await database.query<{ table_name: string; name: string; cid: number }>(
      `SELECT table_name,name,cid FROM (${selects.join(' UNION ALL ')}) ORDER BY table_name,cid`
    );
    for (const column of columns) {
      if (!batch.some((table) => table.name === column.table_name)) throw fail();
      const names = columnsByTable.get(column.table_name) ?? [];
      names.push(column.name);
      columnsByTable.set(column.table_name, names);
    }
  }
  for (const table of tables) {
    const columns = columnsByTable.get(table.name);
    if (!columns?.length || columns.length > 512) throw fail();
  }
  await assertAdmission();
  const tableDigests: { name: string; rows: number; digest: string }[] = [];
  const hashesByTable = new Map<string, string[]>();
  let totalRows = 0,
    totalBytes = 0;
  for (const batch of batches(tables, ROW_TABLE_BATCH)) {
    const selects = batch.map((table) => {
      const columns = columnsByTable.get(table.name);
      if (!columns?.length) throw fail();
      const packed = sqlitePackedRowExpression(columns, 'seed');
      return `SELECT ${literal(table.name)} AS table_name,${packed} AS packed FROM ${identifier(table.name)} AS seed`;
    });
    const rows = await database.query<{
      table_name: string;
      bytes: number;
      encoded: string | null;
    }>(
      `SELECT table_name,length(packed) AS bytes,
      CASE WHEN length(packed)<=? THEN hex(packed) ELSE NULL END AS encoded
      FROM (${selects.join(' UNION ALL ')}) LIMIT ?`,
      [MAX_ROW_BYTES, MAX_ROWS + 1]
    );
    if (rows.length > MAX_ROWS) throw fail();
    for (const row of rows) {
      if (
        !batch.some((table) => table.name === row.table_name) ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 1 ||
        row.bytes > MAX_ROW_BYTES ||
        typeof row.encoded !== 'string' ||
        row.encoded.length !== row.bytes * 2 ||
        !/^[A-F0-9]+$/.test(row.encoded)
      )
        throw fail();
      totalBytes += row.bytes;
      totalRows++;
      if (totalBytes > MAX_TOTAL_BYTES || totalRows > MAX_ROWS) throw fail();
      const hashes = hashesByTable.get(row.table_name) ?? [];
      hashes.push(await digest(row.encoded));
      hashesByTable.set(row.table_name, hashes);
    }
  }
  await assertAdmission();
  for (const table of tables) {
    const hashes = hashesByTable.get(table.name) ?? [];
    // SQL row order and physical layout are not part of a seed's identity.
    hashes.sort();
    tableDigests.push({
      name: table.name,
      rows: hashes.length,
      digest: await digest(JSON.stringify(hashes)),
    });
  }
  await assertAdmission();
  if ((await digest(JSON.stringify(await schema()))) !== schemaDigest) throw fail();
  await assertAdmission();
  return digest(JSON.stringify({ version: 1, schemaDigest, tables: tableDigests }));
}

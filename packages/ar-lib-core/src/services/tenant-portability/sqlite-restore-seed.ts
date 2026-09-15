import type { DatabaseAdapter } from '../../db/adapter';
import { sqlitePackedRowExpression } from './sqlite-packed-row';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne'>;
const PAGE = 16;
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

/**
 * Fingerprint a small initialized database under exclusive admission/DDL protection.
 * Expected fingerprints must be captured by trusted provisioning BEFORE the target is used,
 * pinned to its physical identity and never accepted from uploaded bundles or learned at import.
 * Includes all application/runtime tables, indexes, triggers and views, including empty tables.
 * Only Cloudflare's implementation-owned _cf_METADATA and SQLite statistics are excluded.
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
      await assertAdmission();
      const page = await database.query<ObjectRow>(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema
        WHERE tbl_name!='_cf_METADATA' AND tbl_name NOT GLOB 'sqlite_stat*'
        AND (type>? OR (type=? AND name>?)) ORDER BY type,name LIMIT ?`,
        [type, type, name, PAGE]
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
  const schemaDigest = await digest(JSON.stringify(objects));
  const tables = objects.filter((object) => object.type === 'table');
  if (tables.length > 1024) throw fail();
  const tableDigests: { name: string; rows: number; digest: string }[] = [];
  let totalRows = 0,
    totalBytes = 0;
  for (const table of tables) {
    if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql ?? '')) throw fail();
    await assertAdmission();
    const columns = await database.query<{ name: string }>(
      'SELECT name FROM pragma_table_xinfo(?) ORDER BY cid',
      [table.name]
    );
    if (!columns.length || columns.length > 512) throw fail();
    // sqlite_sequence is the only supported SQLite-owned data table, and its counters matter.
    const packed = sqlitePackedRowExpression(
      columns.map((column) => column.name),
      'seed'
    );
    const hashes: string[] = [];
    let offset = 0;
    while (true) {
      await assertAdmission();
      const rows = await database.query<{ bytes: number; encoded: string | null }>(
        `SELECT length(packed) AS bytes,CASE WHEN length(packed)<=? THEN hex(packed) ELSE NULL END AS encoded
        FROM (SELECT ${packed} AS packed FROM ${identifier(table.name)} AS seed LIMIT ? OFFSET ?)`,
        [MAX_ROW_BYTES, PAGE, offset]
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (
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
        hashes.push(await digest(row.encoded));
      }
      offset += rows.length;
    }
    // SQL row order and physical layout are not part of a seed's identity.
    hashes.sort();
    tableDigests.push({
      name: table.name,
      rows: hashes.length,
      digest: await digest(JSON.stringify(hashes)),
    });
  }
  if ((await digest(JSON.stringify(await schema()))) !== schemaDigest) throw fail();
  await assertAdmission();
  return digest(JSON.stringify({ version: 1, schemaDigest, tables: tableDigests }));
}

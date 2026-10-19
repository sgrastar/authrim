import { createRequire } from 'node:module';
import type { Miniflare as MiniflareRuntime } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { splitMigrationSql } from '../../control-plane/migration-sql';
import { readSqliteSnapshotDataset } from '../sqlite-dataset-source';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';

// D1 bills rows_read, which node:sqlite cannot report. Local Miniflare D1 runs the same engine.
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(
  require.resolve('wrangler/package.json')
)('miniflare') as typeof import('miniflare');

const users: SnapshotTableSchema = {
  table: 'users',
  tenantColumn: 'tenant_id',
  columns: ['id', 'tenant_id', 'label'],
  primaryKey: ['id'],
  uniqueKeys: [],
};
const ledger: SnapshotTableSchema = {
  table: 'ledger',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'id', 'label'],
  primaryKey: ['tenant_id', 'id'],
  uniqueKeys: [],
};

let runtime: MiniflareRuntime;
let db: D1Database;
beforeAll(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {};',
      compatibilityDate: '2026-07-08',
      host: '127.0.0.1',
      d1Databases: ['SNAPSHOT_PAGE_COST'],
    })
  );
  db = (await runtime.getD1Database('SNAPSHOT_PAGE_COST')) as unknown as D1Database;
}, 60_000);
afterAll(async () => {
  await runtime?.dispose();
});

// Writes after T0: a tenth of the rows changed, every row changed, or a new row after every
// T0 row. The last two leave each page's live scan mostly omitted rows.
type AfterT0 = 'some-updated' | 'all-updated' | 'interleaved-inserts';
const afterT0: Record<AfterT0, (table: string) => string> = {
  'some-updated': (table) => `UPDATE ${table} SET label = 'changed' WHERE rowid % 10 = 0;`,
  'all-updated': (table) => `UPDATE ${table} SET label = 'changed';`,
  'interleaved-inserts': (table) =>
    `INSERT INTO ${table} (id, tenant_id, label) SELECT id || '-new', tenant_id, 'new' FROM ${table};`,
};

async function exportRowsRead(schema: SnapshotTableSchema, rows: number, writes: AfterT0) {
  const fixture = `DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS ledger;
    DROP TABLE IF EXISTS tenant_backup_preimages; DROP TABLE IF EXISTS tenant_backup_snapshots;
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, label TEXT);
    CREATE INDEX users_tenant ON users(tenant_id);
    CREATE TABLE ledger (tenant_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT,
      PRIMARY KEY (tenant_id, id));
    ${SQLITE_SNAPSHOT_SCHEMA}
    ${sqliteSnapshotTriggers(schema)}
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
      INSERT INTO ${schema.table} (${schema.columns.join(', ')})
      SELECT ${schema.columns.map((column) => (column === 'id' ? "printf('r%07d', i)" : column === 'tenant_id' ? "'a'" : "'t0'")).join(', ')} FROM n;
    INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('s', 'a', 'capturing');
    ${afterT0[writes](schema.table)}`;
  await db.batch(splitMigrationSql(fixture).map((sql) => db.prepare(sql)));
  let rowsRead = 0;
  const database: Pick<DatabaseAdapter, 'query' | 'queryOne'> = {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all<T>();
      rowsRead += result.meta.rows_read;
      return result.results;
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all<T>();
      rowsRead += result.meta.rows_read;
      return result.results[0] ?? null;
    },
  };
  let exported = 0;
  const decoder = new TextDecoder();
  for await (const chunk of readSqliteSnapshotDataset({
    database,
    schema,
    snapshotId: 's',
    tenantId: 'a',
    signal: new AbortController().signal,
  }))
    exported += decoder.decode(chunk).split('\n').length - 1;
  expect(exported).toBe(rows);
  return rowsRead / rows;
}

it.each(
  [users, ledger].flatMap((schema) =>
    (['some-updated', 'all-updated', 'interleaved-inserts'] as const).map(
      (writes) => [schema.table, schema, writes] as const
    )
  )
)(
  'reads a %s export with %s rows in proportion to the table size',
  async (_table, schema, writes) => {
    const perRow = new Map<number, number>();
    for (const rows of [500, 1000, 2000, 8000])
      perRow.set(rows, await exportRowsRead(schema, rows, writes));
    // ~17-22 rows per exported row at every size, settling near 20.5 by 32000 rows. The
    // previous text-order paging query alone read ~13, 23, 44 and 170, and filtering omitted
    // rows before the page limit grew ~30x for 8x the rows once every row was rewritten.
    const baseline = perRow.get(500) ?? 0;
    for (const value of perRow.values()) {
      expect(value).toBeLessThan(24);
      expect(value).toBeLessThan(baseline * 1.25);
    }
  },
  120_000
);

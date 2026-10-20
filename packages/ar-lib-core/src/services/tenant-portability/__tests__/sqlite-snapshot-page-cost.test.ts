import { createRequire } from 'node:module';
import type { Miniflare as MiniflareRuntime } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { splitMigrationSql } from '../../control-plane/migration-sql';
import { readSqliteSnapshotDataset } from '../sqlite-dataset-source';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
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

// Writes after T0: a tenth of the rows changed, every row changed, a new row after every T0
// row, or every row deleted while another tenant's rows sort after them. The last three leave
// each page's live scan mostly omitted rows; in the last, only preimages are exported.
type AfterT0 =
  | 'some-updated'
  | 'all-updated'
  | 'interleaved-inserts'
  | 'deleted-before-other-tenant';
const afterT0: Record<AfterT0, (table: string) => string> = {
  'some-updated': (table) => `UPDATE ${table} SET label = 'changed' WHERE rowid % 10 = 0;`,
  'all-updated': (table) => `UPDATE ${table} SET label = 'changed';`,
  'interleaved-inserts': (table) =>
    `INSERT INTO ${table} (id, tenant_id, label) SELECT id || '-new', tenant_id, 'new' FROM ${table};`,
  'deleted-before-other-tenant': (table) =>
    `INSERT INTO ${table} (id, tenant_id, label) SELECT replace(id, 'r', 's'), 'b', 'other' FROM ${table};
    DELETE FROM ${table} WHERE tenant_id = 'a';`,
};

function countingDatabase(): {
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
  rowsRead: () => number;
} {
  let rowsRead = 0;
  const run = async <T>(sql: string, params: unknown[]) => {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .all<T>();
    rowsRead += result.meta.rows_read;
    return result.results;
  };
  return {
    database: {
      query: <T>(sql: string, params: unknown[] = []) => run<T>(sql, params),
      queryOne: async <T>(sql: string, params: unknown[] = []) =>
        (await run<T>(sql, params))[0] ?? null,
    },
    rowsRead: () => rowsRead,
  };
}

async function exportedRows(
  database: Pick<DatabaseAdapter, 'query' | 'queryOne'>,
  schema: SnapshotTableSchema
) {
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
  return exported;
}

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
  const { database, rowsRead } = countingDatabase();
  expect(await exportedRows(database, schema)).toBe(rows);
  return rowsRead() / rows;
}

it.each(
  [users, ledger].flatMap((schema) =>
    (
      ['some-updated', 'all-updated', 'interleaved-inserts', 'deleted-before-other-tenant'] as const
    ).map((writes) => [schema.table, schema, writes] as const)
  )
)(
  'reads a %s export with %s rows in proportion to the table size',
  async (_table, schema, writes) => {
    const perRow = new Map<number, number>();
    for (const rows of [500, 1000, 2000, 8000])
      perRow.set(rows, await exportRowsRead(schema, rows, writes));
    // ~21-30 rows per exported row at every size: ~21-26 for live rows, whose bodies are read by
    // key after the merge, and ~29.5 when only preimages remain before another tenant's rows.
    // The previous text-order paging query alone read ~13, 23, 44 and 170. Filtering omitted rows
    // before the page limit grew ~30x for 8x the rows once every row was rewritten, and filtering
    // other tenants' rows grew 22.6 to 97.4 in the last case.
    const baseline = perRow.get(500) ?? 0;
    for (const value of perRow.values()) {
      expect(value).toBeLessThan(32);
      expect(value).toBeLessThan(baseline * 1.25);
    }
  },
  120_000
);

const members: SnapshotTableSchema = {
  table: 'members',
  tenantColumn: 'tenant_id',
  columns: ['id', 'tenant_id', 'status', 'label'],
  primaryKey: ['id'],
  uniqueKeys: [],
};
const orderedMembers: SnapshotTableSchema = {
  ...members,
  tenantOrderIndex: 'members_tenant_order',
};

// One 100-row tenant spread evenly across a table shared with equally sized tenants. Other
// tenant-first indexes and fresh statistics give the planner alternatives to the ordered index.
async function smallTenantFixture(schema: SnapshotTableSchema, tableRows: number) {
  const fixture = `DROP TABLE IF EXISTS members;
    DROP TABLE IF EXISTS tenant_backup_preimages; DROP TABLE IF EXISTS tenant_backup_snapshots;
    CREATE TABLE members (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, status TEXT,
      label TEXT);
    CREATE INDEX members_tenant_status ON members(tenant_id, status);
    CREATE INDEX members_tenant_label ON members(tenant_id, label);
    CREATE INDEX members_tenant_order ON members(tenant_id, id);
    ${SQLITE_SNAPSHOT_SCHEMA}
    ${sqliteSnapshotTriggers(schema)}
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${tableRows})
      INSERT INTO members (id, tenant_id, status, label)
      SELECT printf('r%07d', i),
        CASE WHEN i % ${tableRows / 100} = 0 THEN 'a' ELSE 't' || (i % ${tableRows / 100}) END,
        NULL, 't0' FROM n;
    INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('s', 'a', 'capturing');
    UPDATE members SET label = 'changed' WHERE tenant_id = 'a' AND rowid % 10 = 0;
    ANALYZE;`;
  await db.batch(splitMigrationSql(fixture).map((sql) => db.prepare(sql)));
}

async function smallTenantRowsRead(schema: SnapshotTableSchema, tableRows: number) {
  await smallTenantFixture(schema, tableRows);
  const { database, rowsRead } = countingDatabase();
  expect(await exportedRows(database, schema)).toBe(100);
  return rowsRead();
}

it('pins the live scan of a tenant-ordered table to its index after ANALYZE', async () => {
  await smallTenantFixture(orderedMembers, 20_000);
  const plan = await db
    .prepare(
      `EXPLAIN QUERY PLAN ${sqliteSnapshotPageQuery(orderedMembers, 'packed', undefined, { scanLimit: true })}`
    )
    .bind('s', 'a', '', 100, 100)
    .all<{ detail: string }>();
  const live = plan.results
    .map((row) => row.detail)
    .filter((detail) => /^(SCAN|SEARCH) live\b/.test(detail));
  expect(live).toEqual([
    'SEARCH live USING COVERING INDEX members_tenant_order (tenant_id=?)',
    'SEARCH live USING COVERING INDEX members_tenant_order (tenant_id=? AND id>?)',
    'SEARCH live USING INDEX sqlite_autoindex_members_1 (id=?)',
  ]);
}, 60_000);

it('reads a small tenant of a shared table in proportion to the tenant', async () => {
  const small = await smallTenantRowsRead(orderedMembers, 20_000);
  const large = await smallTenantRowsRead(orderedMembers, 80_000);
  // ~28 reads per exported row (2,842 for 100 rows) at both table sizes.
  expect(small).toBeLessThan(100 * 32);
  expect(large).toBeLessThan(small * 1.1);
  // Without the index the walk covers the table's whole primary key range, other tenants' rows
  // flagged in bounded scans: 653,357 reads, ~8 per table row.
  expect(await smallTenantRowsRead(members, 80_000)).toBeGreaterThan(80_000);
}, 120_000);

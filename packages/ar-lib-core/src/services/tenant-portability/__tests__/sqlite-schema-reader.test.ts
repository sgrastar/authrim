import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { readBackupSqliteSchema } from '../sqlite-schema-reader';
import { assessSnapshotTable } from '../sqlite-schema-assessment';
let db: DatabaseSync;
let database: Pick<DatabaseAdapter, 'query' | 'queryOne'>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  database = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
  };
});
afterEach(() => db.close());
it('reads composite keys, defaults, generated columns, partial indexes and foreign keys', async () => {
  db.exec(`CREATE TABLE parents(id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE items(tenant_id TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT REFERENCES parents(id), value TEXT DEFAULT 'x', derived TEXT GENERATED ALWAYS AS (upper(value)) STORED, PRIMARY KEY(tenant_id,id)) WITHOUT ROWID;
    CREATE UNIQUE INDEX item_value ON items(tenant_id,value DESC) WHERE value IS NOT NULL;`);
  const schema = await readBackupSqliteSchema(database, 'items');
  expect(schema.withoutRowid).toBe(true);
  expect(schema.columns.find((c) => c.name === 'derived')?.generated).toBe(true);
  expect(schema.columns.find((c) => c.name === 'value')?.defaultSql).toBe("'x'");
  expect(schema.foreignKeys[0]).toMatchObject({
    parentTable: 'parents',
    column: 'parent_id',
    parentColumn: 'id',
  });
  expect(schema.indexes.find((i) => i.name === 'item_value')).toMatchObject({
    partial: true,
    unique: true,
  });
  expect(assessSnapshotTable(schema).schema?.primaryKey).toEqual(['tenant_id', 'id']);
});
type PackedRow = { indexes_json: string };
type PackedIndex = { columns: unknown };
/** The same database, with every index's columns forced into one representation. */
function withIndexColumns(shape: (columns: unknown[]) => unknown): typeof database {
  return {
    ...database,
    async query<T>(sql: string, params?: unknown[]) {
      const rows = await database.query<PackedRow>(sql, params);
      return rows.map((row) => ({
        ...row,
        indexes_json: JSON.stringify(
          (JSON.parse(row.indexes_json) as PackedIndex[]).map((index) => ({
            ...index,
            // Whatever this SQLite produced, start from the array.
            columns: shape(
              typeof index.columns === 'string'
                ? (JSON.parse(index.columns) as unknown[])
                : (index.columns as unknown[])
            ),
          }))
        ),
      })) as T[];
    },
  };
}
it('asks SQLite for index columns as an array, whatever its version', async () => {
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL, value TEXT);
    CREATE INDEX item_value ON items(value);`);
  let packed: PackedRow[] = [];
  const spying: typeof database = {
    ...database,
    async query<T>(sql: string, params?: unknown[]) {
      packed = await database.query<PackedRow>(sql, params);
      return packed as T[];
    },
  };
  await readBackupSqliteSchema(spying, 'items');
  const indexes = JSON.parse(packed[0].indexes_json) as PackedIndex[];
  expect(indexes.length).toBeGreaterThan(0);
  for (const index of indexes) expect(Array.isArray(index.columns)).toBe(true);
});
it.each([
  ['an array', (columns: unknown[]) => columns],
  ['JSON text', (columns: unknown[]) => JSON.stringify(columns)],
])('reads index columns nested as %s', async (_name, shape) => {
  db.exec(`CREATE TABLE items(tenant_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT, PRIMARY KEY(tenant_id,id));
    CREATE UNIQUE INDEX item_value ON items(tenant_id,value DESC) WHERE value IS NOT NULL;`);
  const schema = await readBackupSqliteSchema(withIndexColumns(shape), 'items');
  expect(schema.indexes.find((i) => i.name === 'item_value')?.columns).toMatchObject([
    { position: 0, name: 'tenant_id', descending: false, key: true },
    { position: 1, name: 'value', descending: true, key: true },
    { key: false },
  ]);
});
it.each([
  ['an object', () => ({})],
  ['text that is not an array', () => '{}'],
  ['text encoded twice', (columns: unknown[]) => JSON.stringify(JSON.stringify(columns))],
])('refuses index columns nested as %s', async (_name, shape) => {
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL, value TEXT);
    CREATE INDEX item_value ON items(value);`);
  await expect(readBackupSqliteSchema(withIndexColumns(shape), 'items')).rejects.toThrow(
    'backup_schema_invalid_index_columns'
  );
});
it.each([
  ['TEXT PRIMARY KEY', '', ['nullable_primary_key']],
  ['TEXT PRIMARY KEY', ' STRICT', []],
  ['INTEGER PRIMARY KEY', '', ['rowid_allocation']],
])('distinguishes key guarantees for %s %s', async (key, suffix, concerns) => {
  db.exec(`CREATE TABLE items(id ${key}, tenant_id TEXT)${suffix}`);
  expect(assessSnapshotTable(await readBackupSqliteSchema(database, 'items')).concerns).toEqual(
    concerns
  );
});
it('rejects unsupported unique semantics instead of silently omitting indexes', async () => {
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT, value TEXT);
    CREATE UNIQUE INDEX expression_key ON items(lower(value));
    CREATE UNIQUE INDEX folded_key ON items(value COLLATE NOCASE);`);
  expect(assessSnapshotTable(await readBackupSqliteSchema(database, 'items')).concerns).toEqual([
    'expression_unique_index',
    'nonbinary_unique_index',
  ]);
});
it('rejects missing tables, views and untrusted identifiers', async () => {
  db.exec('CREATE VIEW view_data AS SELECT 1 AS id');
  for (const table of [
    'missing',
    'view_data',
    'tenant_backup_snapshots',
    'items; DROP TABLE items',
  ]) {
    await expect(readBackupSqliteSchema(database, table)).rejects.toThrow(/backup_schema_/);
  }
});

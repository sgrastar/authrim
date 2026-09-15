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

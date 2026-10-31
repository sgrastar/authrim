import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';
import { readSqliteSnapshotDataset } from '../sqlite-dataset-source';
import {
  invalidateSqliteBackupSnapshot,
  cleanupSqliteBackupSnapshotPage,
} from '../sqlite-snapshot-cleanup';
let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
const schema: SnapshotTableSchema = {
  table: 'accounts',
  tenantColumn: 'tenant_id',
  columns: ['id', 'tenant_id', 'value'],
  primaryKey: ['id'],
  uniqueKeys: [],
};
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE accounts(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,value TEXT);${SQLITE_SNAPSHOT_SCHEMA}${sqliteSnapshotTriggers(schema)}`
  );
  adapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  db.exec(
    "INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('ours','a','capturing'),('parallel','a','capturing'),('foreign','b','capturing')"
  );
  for (let i = 0; i < 205; i++)
    db.prepare("INSERT INTO accounts VALUES (?, 'a','value')").run(String(i));
  db.exec("INSERT INTO accounts VALUES ('foreign','b','private')");
});
afterEach(() => db.close());
it('invalidates before bounded deletion and preserves concurrent snapshots and live rows', async () => {
  await expect(cleanupSqliteBackupSnapshotPage(adapter, 'ours', 'a')).rejects.toThrow(
    'not_invalid'
  );
  await invalidateSqliteBackupSnapshot(adapter, 'ours', 'a');
  expect(() =>
    db.exec("UPDATE tenant_backup_snapshots SET state='capturing' WHERE id='ours'")
  ).toThrow('state_regression');
  const read = readSqliteSnapshotDataset({
    database: adapter,
    schema,
    snapshotId: 'ours',
    tenantId: 'a',
    signal: new AbortController().signal,
  });
  await expect(read.next()).rejects.toThrow('unavailable');
  expect(await cleanupSqliteBackupSnapshotPage(adapter, 'ours', 'a')).toEqual({
    removed: 100,
    complete: false,
  });
  db.exec("INSERT INTO accounts VALUES ('new','a','new')");
  expect(await cleanupSqliteBackupSnapshotPage(adapter, 'ours', 'a')).toEqual({
    removed: 100,
    complete: false,
  });
  expect(await cleanupSqliteBackupSnapshotPage(adapter, 'ours', 'a')).toEqual({
    removed: 5,
    complete: true,
  });
  expect(await cleanupSqliteBackupSnapshotPage(adapter, 'ours', 'a')).toEqual({
    removed: 0,
    complete: true,
  });
  expect(
    db
      .prepare("SELECT count(*) AS count FROM tenant_backup_preimages WHERE snapshot_id='parallel'")
      .get()?.count
  ).toBe(206);
  expect(
    db
      .prepare("SELECT count(*) AS count FROM tenant_backup_preimages WHERE snapshot_id='foreign'")
      .get()?.count
  ).toBe(1);
  expect(db.prepare('SELECT count(*) AS count FROM accounts').get()?.count).toBe(207);
});
it('cannot invalidate or collect another tenant snapshot', async () => {
  await invalidateSqliteBackupSnapshot(adapter, 'foreign', 'a');
  expect(await cleanupSqliteBackupSnapshotPage(adapter, 'foreign', 'a')).toEqual({
    removed: 0,
    complete: true,
  });
  expect(
    db.prepare("SELECT state FROM tenant_backup_snapshots WHERE id='foreign'").get()?.state
  ).toBe('capturing');
  expect(
    db
      .prepare("SELECT count(*) AS count FROM tenant_backup_preimages WHERE snapshot_id='foreign'")
      .get()?.count
  ).toBe(1);
});
it('allows sealed cleanup but not restarting a sealed capture', async () => {
  db.exec("UPDATE tenant_backup_snapshots SET state='sealed' WHERE id='ours'");
  expect(() =>
    db.exec("UPDATE tenant_backup_snapshots SET state='capturing' WHERE id='ours'")
  ).toThrow('state_regression');
  await invalidateSqliteBackupSnapshot(adapter, 'ours', 'a');
  expect((await cleanupSqliteBackupSnapshotPage(adapter, 'ours', 'a')).removed).toBe(100);
});

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aggregateSqliteSnapshotRows, lookupSqliteSnapshotRows } from '../sqlite-snapshot-lookup';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';

const records: SnapshotTableSchema = {
  table: 'records',
  tenantColumn: 'tenant_key',
  tenantIdentity: 'tenantKey',
  columns: ['record_id', 'tenant_key', 'catalog_id', 'status', 'event_at'],
  primaryKey: ['record_id'],
  uniqueKeys: [],
};

type SqlValue = string | number | null;

describe('T0 lookup of captured rows by a text column', () => {
  let db: DatabaseSync;
  const database = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SqlValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SqlValue[])) as T | undefined) ?? null;
    },
  };
  const aggregate = (values: string[], snapshotId = 'snap') =>
    aggregateSqliteSnapshotRows({
      database,
      schema: records,
      snapshotId,
      tenantId: 'tenant-a',
      column: 'catalog_id',
      values,
      groupColumns: ['catalog_id', 'tenant_key'],
      filters: { status: 'committed' },
      rangeColumn: 'event_at',
      preimageLimit: 100,
    }).then((groups) =>
      groups
        .map(({ group, count, min, max }) => [group[0], count, min, max])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    );
  const lookup = (values: string[], preimageLimit = 100) =>
    lookupSqliteSnapshotRows({
      database,
      schema: records,
      snapshotId: 'snap',
      tenantId: 'tenant-a',
      column: 'catalog_id',
      values,
      preimageLimit,
    });
  const ids = async (values: string[]) =>
    (await lookup(values)).map(({ row }) => [row.record_id[1], row.catalog_id[1], row.status[1]]);

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE records (record_id TEXT PRIMARY KEY NOT NULL, tenant_key TEXT NOT NULL,
        catalog_id TEXT NOT NULL, status TEXT NOT NULL, event_at INTEGER NOT NULL);
      CREATE INDEX records_catalog ON records(catalog_id);
      ${SQLITE_SNAPSHOT_SCHEMA}
      ${sqliteSnapshotTriggers(records)}`);
    const insert = db.prepare('INSERT INTO records VALUES (?,?,?,?,?)');
    insert.run('r1', 'key-a', 'cat-1', 'committed', 10);
    insert.run('r2', 'key-a', 'cat-1', 'committed', 11);
    insert.run('r3', 'key-a', 'cat-2', 'committed', 12);
    insert.run('r4', 'key-b', 'cat-1', 'committed', 13);
    db.prepare(
      "INSERT INTO tenant_backup_snapshots(id,tenant_id,state,tenant_key) VALUES ('snap','tenant-a','capturing','key-a')"
    ).run();
  });
  afterEach(() => db.close());

  it('returns owned rows with one of the values and no row of another tenant', async () => {
    expect(await ids(['cat-1'])).toEqual([
      ['r1', 'cat-1', 'committed'],
      ['r2', 'cat-1', 'committed'],
    ]);
    expect(await ids(['cat-1', 'cat-2', 'missing'])).toHaveLength(3);
    expect(await ids([])).toEqual([]);
  });

  it('returns the boundary value of rows changed or deleted after the boundary', async () => {
    db.prepare(
      "UPDATE records SET catalog_id='cat-2', status='deleted' WHERE record_id='r1'"
    ).run();
    db.prepare("DELETE FROM records WHERE record_id='r2'").run();
    db.prepare("INSERT INTO records VALUES ('r5','key-a','cat-1','committed',20)").run();
    db.prepare("UPDATE records SET status='pending' WHERE record_id='r3'").run();
    // r1 moved away and r5 arrived after the boundary: the lookup still sees T0.
    expect(await ids(['cat-1'])).toEqual([
      ['r1', 'cat-1', 'committed'],
      ['r2', 'cat-1', 'committed'],
    ]);
    expect(await ids(['cat-2'])).toEqual([['r3', 'cat-2', 'committed']]);
  });

  it('reads nothing once the snapshot is no longer capturing', async () => {
    db.prepare("UPDATE records SET status='deleted' WHERE record_id='r1'").run();
    db.prepare("UPDATE tenant_backup_snapshots SET state='invalid' WHERE id='snap'").run();
    expect(await ids(['cat-1'])).toEqual([]);
  });

  it('refuses tables with more changed rows than the preimage limit', async () => {
    db.prepare("UPDATE records SET status='deleted' WHERE tenant_key='key-a'").run();
    await expect(lookup(['cat-1'], 2)).rejects.toThrow('backup_snapshot_lookup_preimage_limit');
    await expect(lookup(['cat-1'], 3)).resolves.toHaveLength(2);
  });

  it('aggregates boundary rows per group without holding them', async () => {
    const insert = db.prepare('INSERT INTO records VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    for (let index = 0; index < 3000; index++)
      insert.run(`bulk-${index}`, 'key-a', 'cat-bulk', 'committed', 100 + index);
    db.exec('COMMIT');
    db.prepare(
      "INSERT INTO tenant_backup_snapshots(id,tenant_id,state,tenant_key) VALUES ('snap-2','tenant-a','capturing','key-a')"
    ).run();
    // Rows inserted after the first snapshot are not part of its boundary.
    expect(await aggregate(['cat-1', 'cat-bulk'])).toEqual([['cat-1', 2, 10, 11]]);
    expect(await aggregate(['cat-1', 'cat-bulk'], 'snap-2')).toEqual([
      ['cat-1', 2, 10, 11],
      ['cat-bulk', 3000, 100, 3099],
    ]);
    // Changed after T0: the deleted row and the moved row still count with their T0 values;
    // a row inserted after T0 and an uncommitted T0 row do not.
    db.prepare("DELETE FROM records WHERE record_id='r1'").run();
    db.prepare("UPDATE records SET catalog_id='cat-2' WHERE record_id='r2'").run();
    db.prepare("INSERT INTO records VALUES ('r9','key-a','cat-1','committed',1)").run();
    db.prepare("UPDATE records SET status='pending' WHERE record_id='bulk-0'").run();
    expect(await aggregate(['cat-1', 'cat-bulk'], 'snap-2')).toEqual([
      ['cat-1', 2, 10, 11],
      ['cat-bulk', 3000, 100, 3099],
    ]);
    expect(await aggregate(['cat-2'], 'snap-2')).toEqual([['cat-2', 1, 12, 12]]);
  });

  it('bounds the values of one lookup', async () => {
    await expect(lookup(Array.from({ length: 257 }, (_, index) => `cat-${index}`))).rejects.toThrow(
      'backup_snapshot_lookup_invalid'
    );
  });
});

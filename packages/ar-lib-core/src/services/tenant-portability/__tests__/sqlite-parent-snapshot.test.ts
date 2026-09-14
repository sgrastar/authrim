import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
  type ParentSnapshotTableSchema,
} from '../sqlite-snapshot';

const parent: SnapshotTableSchema = {
  table: 'catalogs',
  tenantColumn: 'tenant_id',
  columns: ['id', 'tenant_id'],
  primaryKey: ['id'],
  uniqueKeys: [],
};
const child: ParentSnapshotTableSchema = {
  table: 'objects',
  columns: ['id', 'catalog_id', 'value'],
  primaryKey: ['id'],
  uniqueKeys: [],
  parent: { schema: parent, childColumns: ['catalog_id'] },
};

describe('parent-owned rows at the snapshot boundary', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE catalogs (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL);
      CREATE TABLE objects (id TEXT NOT NULL PRIMARY KEY, catalog_id TEXT NOT NULL,
        value TEXT, FOREIGN KEY (catalog_id) REFERENCES catalogs(id) ON DELETE CASCADE ON UPDATE CASCADE);
      INSERT INTO catalogs VALUES ('pa','a'),('pb','b');
      INSERT INTO objects VALUES ('ca','pa','original-a'),('cb','pb','original-b');
      ${SQLITE_SNAPSHOT_SCHEMA}
      ${sqliteSnapshotTriggers(parent)}
      ${sqliteSnapshotTriggers(child)}
      INSERT INTO tenant_backup_snapshots VALUES ('sa','a','capturing'),('sb','b','capturing');`);
  });
  afterEach(() => db.close());
  function values(snapshot = 'sa', tenant = 'a') {
    return db
      .prepare(sqliteSnapshotPageQuery(child))
      .all(snapshot, tenant, '', 100)
      .map((row) => JSON.parse(String(row.row_json)).value[1]);
  }
  function unchanged() {
    expect(values()).toEqual(['original-a']);
    expect(values('sb', 'b')).toEqual(['original-b']);
    expect(values('sa', 'b')).toEqual([]);
  }

  it('looks up each live parent by key instead of scanning the parent table per child', () => {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sqliteSnapshotPageQuery(child)}`)
      .all('sa', 'a', '', 100)
      .map((row) => String(row.detail));
    expect(plan.some((line) => /SEARCH owner_live .*\(id=\?\)/.test(line))).toBe(true);
    expect(plan.some((line) => /SCAN owner_live/.test(line))).toBe(false);
  });

  it('uses original membership after the parent moves to a different tenant', () => {
    db.exec("UPDATE catalogs SET tenant_id='b' WHERE id='pa'");
    unchanged();
    db.exec("UPDATE objects SET value='changed' WHERE id='ca'");
    unchanged();
  });
  it('preserves children deleted by foreign-key cascade and excludes post-boundary replacements', () => {
    db.exec(`DELETE FROM catalogs WHERE id='pa';
      INSERT INTO catalogs VALUES ('pa','b');
      INSERT INTO objects VALUES ('ca','pa','replacement');`);
    unchanged();
  });
  it('preserves child references when parent key changes cascade', () => {
    db.exec("UPDATE catalogs SET id='new-pa' WHERE id='pa'");
    unchanged();
    const row = db.prepare(sqliteSnapshotPageQuery(child)).all('sa', 'a', '', 100)[0];
    expect(JSON.parse(String(row.row_json)).catalog_id).toEqual(['text', 'pa']);
  });
  it('handles child ownership moves and subsequent deletion', () => {
    db.exec("UPDATE objects SET catalog_id='pb', value='moved' WHERE id='ca'");
    unchanged();
    db.exec("DELETE FROM objects WHERE id='ca'");
    unchanged();
  });
  it('excludes new children whether their parent existed at the boundary or not', () => {
    db.exec(`INSERT INTO objects VALUES ('late','pa','late');
      INSERT INTO catalogs VALUES ('new-parent','a');
      INSERT INTO objects VALUES ('new-child','new-parent','new');
      UPDATE objects SET value='changed new' WHERE id IN ('late','new-child');`);
    unchanged();
  });
  it('keeps overlapping snapshots independent after a parent tenant move', () => {
    db.exec(`UPDATE catalogs SET tenant_id='b' WHERE id='pa';
      INSERT INTO tenant_backup_snapshots VALUES ('sb2','b','capturing');
      UPDATE objects SET value='latest' WHERE id='ca';`);
    unchanged();
    expect(values('sb2', 'b')).toEqual(['original-a', 'original-b']);
  });
  it('rejects missing or incomplete parent references', () => {
    for (const childColumns of [[], ['missing'], ['catalog_id', 'catalog_id']]) {
      const bad = { ...child, parent: { schema: parent, childColumns } };
      expect(() => sqliteSnapshotTriggers(bad)).toThrow('snapshot_parent_key_invalid');
      expect(() => sqliteSnapshotPageQuery(bad)).toThrow('snapshot_parent_key_invalid');
    }
  });
});

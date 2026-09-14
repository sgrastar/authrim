import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';

const schema: SnapshotTableSchema = {
  table: 'accounts',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'id', 'name', 'counter', 'secret'],
  primaryKey: ['tenant_id', 'id'],
  uniqueKeys: [],
};

describe('SQLite backup preimages', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE accounts (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT,
        counter INTEGER NOT NULL DEFAULT 0, secret BLOB,
        PRIMARY KEY (tenant_id, id)
      );
      ${SQLITE_SNAPSHOT_SCHEMA}
      ${sqliteSnapshotTriggers(schema)}
      INSERT INTO accounts VALUES ('a', '1', 'before', 9007199254740993, X'00ff');
      INSERT INTO accounts VALUES ('a', '2', 'second', 0, NULL);
      INSERT INTO accounts VALUES ('b', '1', 'other tenant', 0, NULL);`);
  });
  afterEach(() => db.close());

  function start(id = 's1', tenant = 'a') {
    db.prepare("INSERT INTO tenant_backup_snapshots VALUES (?, ?, 'capturing')").run(id, tenant);
  }
  function page(id = 's1', tenant = 'a', cursor = '', limit = 100) {
    return db.prepare(sqliteSnapshotPageQuery(schema)).all(id, tenant, cursor, limit);
  }
  function names(id = 's1', tenant = 'a') {
    return page(id, tenant).map((row) => JSON.parse(String(row.row_json)).name[1]);
  }

  it('uses indexed snapshot selection with accumulated history and isolates active tenants', () => {
    db.exec(`WITH RECURSIVE numbers(n) AS (
      SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < 1000
    ) INSERT INTO tenant_backup_snapshots SELECT 'old-' || n, 'a', 'sealed' FROM numbers;`);
    start();
    start('other-active', 'b');
    const index = db
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'tenant_backup_snapshots_capture'")
      .get();
    expect(index).toBeDefined();
    // Inspect the actual UPDATE trigger programs, not a separately rewritten approximation
    // of the lookup. Historical snapshots must not force a table scan for every user write.
    const program = db
      .prepare("EXPLAIN UPDATE accounts SET name = 'changed' WHERE tenant_id = 'a' AND id = '1'")
      .all();
    expect(program.some((row) => row.opcode === 'OpenRead' && row.p2 === index?.rootpage)).toBe(
      true
    );
    const snapshots = db
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'tenant_backup_snapshots'")
      .get();
    expect(snapshots).toBeDefined();
    expect(program.some((row) => row.opcode === 'OpenRead' && row.p2 === snapshots?.rootpage)).toBe(
      false
    );
    db.exec("UPDATE accounts SET name = 'changed' WHERE tenant_id = 'a' AND id = '1'");
    expect(
      db
        .prepare(
          'SELECT snapshot_id, count(*) AS n FROM tenant_backup_preimages GROUP BY snapshot_id'
        )
        .all()
    ).toEqual([{ snapshot_id: 's1', n: 1 }]);
    expect(names()).toEqual(['before', 'second']);
    expect(names('other-active', 'b')).toEqual(['other tenant']);
  });

  it('keeps the start state while ordinary updates, inserts, and deletes continue', () => {
    start();
    db.exec(`UPDATE accounts SET name = 'after' WHERE tenant_id = 'a' AND id = '1';
      UPDATE accounts SET name = 'later' WHERE tenant_id = 'a' AND id = '1';
      DELETE FROM accounts WHERE tenant_id = 'a' AND id = '2';
      INSERT INTO accounts VALUES ('a', '3', 'new', 0, NULL);`);
    expect(names()).toEqual(['before', 'second']);
    expect(db.prepare("SELECT name FROM accounts WHERE tenant_id = 'a' ORDER BY id").all()).toEqual(
      [{ name: 'later' }, { name: 'new' }]
    );
    const first = JSON.parse(String(page()[0].row_json));
    expect(first.counter).toEqual(['integer', '9007199254740993']);
    expect(first.secret).toEqual(['blob', '00FF']);
  });

  it('preserves the first version across INSERT OR REPLACE with recursive triggers disabled', () => {
    start();
    db.exec(`PRAGMA recursive_triggers = OFF;
      INSERT OR REPLACE INTO accounts VALUES ('a', '1', 'replaced', 0, NULL);
      INSERT OR REPLACE INTO accounts VALUES ('a', '1', 'replaced again', 0, NULL);`);
    expect(names()).toEqual(['before', 'second']);
  });

  it('handles replacement through a secondary unique key without losing the deleted row', () => {
    db.exec(`CREATE TABLE emails (tenant_id TEXT, id TEXT PRIMARY KEY, email TEXT UNIQUE);
      INSERT INTO emails VALUES ('a', 'old-id', 'one@example.test');`);
    const emailSchema = {
      table: 'emails',
      tenantColumn: 'tenant_id',
      columns: ['tenant_id', 'id', 'email'],
      primaryKey: ['id'],
      uniqueKeys: [['email']],
    };
    db.exec(sqliteSnapshotTriggers(emailSchema));
    start();
    db.exec(`INSERT OR REPLACE INTO emails VALUES ('a', 'new-id', 'one@example.test');`);
    const rows = db.prepare(sqliteSnapshotPageQuery(emailSchema)).all('s1', 'a', '', 100);
    expect(rows.map((row) => JSON.parse(String(row.row_json)).id[1])).toEqual(['old-id']);
  });

  it('preserves the snapshot through UPSERT and UPDATE OR REPLACE', () => {
    start();
    db.exec(`INSERT INTO accounts (tenant_id, id, name) VALUES ('a', '1', 'upserted')
      ON CONFLICT (tenant_id, id) DO UPDATE SET name = excluded.name;
      UPDATE OR REPLACE accounts SET id = '2' WHERE tenant_id = 'a' AND id = '1';`);
    expect(names()).toEqual(['before', 'second']);
  });

  it('captures the boundary before a cascading trigger mutates a newly inserted or moved key', () => {
    db.exec(`CREATE TRIGGER normalize_insert AFTER INSERT ON accounts
      BEGIN UPDATE accounts SET name = 'normalized' WHERE tenant_id = NEW.tenant_id AND id = NEW.id; END;
      CREATE TRIGGER normalize_move AFTER UPDATE OF id ON accounts
      BEGIN UPDATE accounts SET name = 'normalized' WHERE tenant_id = NEW.tenant_id AND id = NEW.id; END;`);
    start();
    db.exec(`INSERT INTO accounts VALUES ('a', '3', 'new', 0, NULL);
      UPDATE accounts SET id = '4' WHERE tenant_id = 'a' AND id = '1';`);
    expect(names()).toEqual(['before', 'second']);
  });

  it('retains inserts as absent even after they are updated or deleted', () => {
    start();
    db.exec(`INSERT INTO accounts VALUES ('a', '3', 'new', 0, NULL);
      UPDATE accounts SET name = 'changed' WHERE id = '3';
      DELETE FROM accounts WHERE id = '3';
      INSERT INTO accounts VALUES ('a', '3', 'recreated', 0, NULL);`);
    expect(names()).toEqual(['before', 'second']);
  });

  it('retains a deleted row when its identifier is reused', () => {
    start();
    db.exec(`DELETE FROM accounts WHERE tenant_id = 'a' AND id = '1';
      INSERT INTO accounts VALUES ('a', '1', 'replacement', 0, NULL);`);
    expect(names()).toEqual(['before', 'second']);
  });

  it('captures ownership and primary-key moves without leaking between tenants', () => {
    start();
    start('sb', 'b');
    db.exec("UPDATE accounts SET tenant_id = 'b', id = '3' WHERE tenant_id = 'a' AND id = '1'");
    expect(names()).toEqual(['before', 'second']);
    expect(names('sb', 'b')).toEqual(['other tenant']);
    expect(page('s1', 'b')).toEqual([]);
  });

  it('paginates the same snapshot while live rows change between pages', () => {
    start();
    const first = page('s1', 'a', '', 1);
    db.exec(`DELETE FROM accounts WHERE tenant_id = 'a' AND id = '2';
      INSERT INTO accounts VALUES ('a', '0', 'new earlier key', 0, NULL);`);
    const rest = page('s1', 'a', String(first[0].record_key));
    expect(rest.map((row) => JSON.parse(String(row.row_json)).name[1])).toEqual(['second']);
  });

  it('gives overlapping snapshots independent first preimages', () => {
    start();
    db.exec("UPDATE accounts SET name = 'middle' WHERE tenant_id = 'a' AND id = '1'");
    start('s2');
    db.exec("UPDATE accounts SET name = 'latest' WHERE tenant_id = 'a' AND id = '1'");
    expect(names()).toEqual(['before', 'second']);
    expect(names('s2')).toEqual(['middle', 'second']);
  });

  it('rolls back both the mutation and its preimage on transaction failure', () => {
    start();
    db.exec('BEGIN');
    try {
      db.exec("UPDATE accounts SET name = 'uncommitted' WHERE tenant_id = 'a' AND id = '1'");
      db.exec("INSERT INTO accounts (tenant_id, id) VALUES ('a', '1')");
    } catch {
      db.exec('ROLLBACK');
    }
    expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_preimages').get()).toEqual({ n: 0 });
    expect(names()).toEqual(['before', 'second']);
  });

  it.each(['invalid', 'sealed'])('does not read live data from a %s snapshot', (state) => {
    start();
    db.prepare('UPDATE tenant_backup_snapshots SET state = ?').run(state);
    expect(page()).toEqual([]);
    expect(page('absent')).toEqual([]);
  });

  it('removes only the deleted snapshot history on cleanup', () => {
    start();
    start('s2');
    db.exec("UPDATE accounts SET name = 'new' WHERE tenant_id = 'a' AND id = '1'");
    db.exec("DELETE FROM tenant_backup_snapshots WHERE id = 's1'");
    expect(page()).toEqual([]);
    expect(names('s2')).toEqual(['before', 'second']);
    expect(db.prepare('SELECT DISTINCT snapshot_id FROM tenant_backup_preimages').all()).toEqual([
      { snapshot_id: 's2' },
    ]);
  });

  it('rejects unsafe or incomplete schema definitions before generating SQL', () => {
    for (const invalid of [
      { ...schema, table: 'accounts; DROP TABLE accounts' },
      { ...schema, table: 'tenant_backup_snapshots' },
      { ...schema, primaryKey: [] },
      { ...schema, primaryKey: ['missing'] },
      { ...schema, tenantColumn: 'missing' },
      { ...schema, columns: ['id', 'id'] },
    ]) {
      expect(() => sqliteSnapshotTriggers(invalid)).toThrow();
      expect(() => sqliteSnapshotPageQuery(invalid)).toThrow();
    }
  });
});

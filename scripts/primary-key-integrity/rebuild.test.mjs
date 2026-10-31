import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { inspectSchema } from './schema-inventory.ts';
import { buildPrimaryKeyMigration } from './rebuild.ts';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/src/migrations/sql-portability.ts';

function migrate(db, sql) {
  db.exec('BEGIN');
  try {
    db.exec(renderPortableMigrationSql(sql, 'sqlite'));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

test('rebuild preserves child data, audit triggers, indexes, defaults, generated values and sequences', () => {
  const ddl = `PRAGMA foreign_keys=ON;
    CREATE TABLE parents (id TEXT PRIMARY KEY, label TEXT DEFAULT 'a,b');
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT);
    CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id) ON DELETE CASCADE,
      payload BLOB, bytes INTEGER GENERATED ALWAYS AS (length(payload)) STORED);
    CREATE TABLE leaves (id INTEGER PRIMARY KEY AUTOINCREMENT, child_id TEXT REFERENCES children(id) ON DELETE CASCADE);
    CREATE INDEX children_parent ON children(parent_id);
    CREATE TRIGGER child_hold BEFORE DELETE ON children BEGIN SELECT RAISE(ABORT,'held'); END;
    CREATE TRIGGER child_audit AFTER INSERT ON children BEGIN INSERT INTO events(message) VALUES ('created'); END;
    CREATE VIEW child_view AS SELECT id,bytes FROM children;`;
  const plan = buildPrimaryKeyMigration(inspectSchema([ddl]));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(ddl);
    db.exec(`INSERT INTO parents(id) VALUES ('p'); INSERT INTO children(id,parent_id,payload) VALUES ('c','p',X'00ff');
      INSERT INTO leaves(id,child_id) VALUES (100,'c'); DELETE FROM leaves WHERE id=100;
      INSERT INTO leaves(id,child_id) VALUES (1,'c');`);
    migrate(db, plan.sql);
    assert.deepEqual(
      db
        .prepare('SELECT * FROM parents')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 'p', label: 'a,b' }]
    );
    assert.deepEqual(
      db
        .prepare('SELECT id,parent_id,hex(payload) AS payload,bytes FROM children')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 'c', parent_id: 'p', payload: '00FF', bytes: 2 }]
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM leaves').get().n, 1);
    db.exec("INSERT INTO leaves(child_id) VALUES ('c')");
    assert.equal(db.prepare('SELECT max(id) AS id FROM leaves').get().id, 101);
    assert.throws(() => db.exec('INSERT INTO parents(id) VALUES (NULL)'), /NOT NULL/);
    assert.throws(() => db.exec('UPDATE children SET id=NULL'), /NOT NULL/);
    assert.throws(() => db.exec('DELETE FROM children'), /held/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM pragma_foreign_key_check').get().n, 0);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__authrim_pk_%'").get()
        .n,
      0
    );
    assert.deepEqual(
      db
        .prepare('SELECT * FROM child_view')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 'c', bytes: 2 }]
    );
  } finally {
    db.close();
  }
});

test('NULL data aborts before reconstruction and leaves every original row and schema intact', () => {
  const ddl = 'CREATE TABLE items (a TEXT, b TEXT NOT NULL, PRIMARY KEY(a,b))';
  const plan = buildPrimaryKeyMigration(inspectSchema([ddl]));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(ddl + "; INSERT INTO items VALUES (NULL,'keep'),('valid','keep')");
    const before = db.prepare("SELECT sql FROM sqlite_schema WHERE name='items'").get();
    assert.throws(() => migrate(db, plan.sql), /primary_key_integrity_preflight/);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_schema WHERE name='items'").get(), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 2);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__authrim_pk_%'").get()
        .n,
      0
    );
  } finally {
    db.close();
  }
});

test('rejects operator-added schema changes rather than dropping them', () => {
  const ddl = 'CREATE TABLE items (id TEXT PRIMARY KEY)';
  const plan = buildPrimaryKeyMigration(inspectSchema([ddl]));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(ddl + '; ALTER TABLE items ADD COLUMN custom TEXT');
    assert.throws(() => migrate(db, plan.sql), /primary_key_integrity_preflight/);
    assert.equal(db.prepare('PRAGMA table_info(items)').all().length, 2);
  } finally {
    db.close();
  }
});

test('composite quoted keys, rowid gaps and external unique-index references survive', () => {
  const ddl = `CREATE TABLE z_parent ("first key" TEXT /* comma , */, b TEXT -- key comment
    , UNIQUE("first key",b), PRIMARY KEY("first key",b));
    CREATE TABLE a_child (id TEXT PRIMARY KEY, p TEXT, q TEXT,
      FOREIGN KEY(p,q) REFERENCES z_parent("first key",b));
    CREATE UNIQUE INDEX external_key ON a_child(id,p);
    CREATE TABLE leaf (id TEXT PRIMARY KEY, child TEXT, p TEXT,
      FOREIGN KEY(child,p) REFERENCES a_child(id,p));`;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON;' + ddl);
    db.exec(`INSERT INTO z_parent(rowid,"first key",b) VALUES (900,'p','q');
      INSERT INTO a_child VALUES ('c','p','q'); INSERT INTO leaf VALUES ('l','c','p');`);
    migrate(db, buildPrimaryKeyMigration(inspectSchema([ddl])).sql);
    assert.equal(db.prepare('SELECT rowid FROM z_parent').get().rowid, 900);
    assert.equal(db.prepare('SELECT count(*) AS n FROM leaf').get().n, 1);
    for (const column of ['"first key"', 'b'])
      assert.throws(() => db.exec(`UPDATE z_parent SET ${column}=NULL`), /NOT NULL/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('unknown referencing tables abort without cascading into their rows', () => {
  const ddl = 'CREATE TABLE parent(id TEXT PRIMARY KEY)';
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON; ${ddl};
      CREATE TABLE custom_child(p TEXT REFERENCES parent(id) ON DELETE CASCADE);
      INSERT INTO parent VALUES ('p'); INSERT INTO custom_child VALUES ('p');`);
    assert.throws(
      () => migrate(db, buildPrimaryKeyMigration(inspectSchema([ddl])).sql),
      /primary_key_integrity_preflight/
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM custom_child').get().n, 1);
  } finally {
    db.close();
  }
});

test('unsupported cycles and inaccessible hidden rowids fail during planning', () => {
  assert.throws(
    () =>
      buildPrimaryKeyMigration(
        inspectSchema([
          'CREATE TABLE a(id TEXT PRIMARY KEY, b TEXT REFERENCES b(id)); CREATE TABLE b(id TEXT PRIMARY KEY, a TEXT REFERENCES a(id));',
        ])
      ),
    /cyclic_dependencies/
  );
  assert.throws(
    () =>
      buildPrimaryKeyMigration(
        inspectSchema(['CREATE TABLE a(id TEXT PRIMARY KEY, rowid TEXT, _rowid_ TEXT, oid TEXT);'])
      ),
    /inaccessible_rowid/
  );
});

test('a deferred foreign-key failure rolls back schema and copied rows', () => {
  const ddl =
    'CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));';
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'PRAGMA foreign_keys=OFF;' +
        ddl +
        "; INSERT INTO child VALUES ('c','missing'); PRAGMA foreign_keys=ON;"
    );
    const before = db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
    assert.throws(
      () => migrate(db, buildPrimaryKeyMigration(inspectSchema([ddl])).sql),
      /primary_key_integrity_preflight|FOREIGN KEY/
    );
    assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), before);
    assert.equal(db.prepare('SELECT parent_id FROM child').get().parent_id, 'missing');
  } finally {
    db.close();
  }
});

test('portable timestamp defaults and exact-schema preflight survive rendering together', () => {
  const source =
    'CREATE TABLE clocked(id TEXT PRIMARY KEY, created_at INTEGER DEFAULT __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__)';
  const schema = inspectSchema([source]);
  const plan = buildPrimaryKeyMigration(schema);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(renderPortableMigrationSql(source, 'sqlite'));
    db.exec("INSERT INTO clocked(id,created_at) VALUES ('old',1234)");
    migrate(db, plan.sql);
    db.exec("INSERT INTO clocked(id) VALUES ('new')");
    assert.equal(
      db.prepare("SELECT created_at FROM clocked WHERE id='old'").get().created_at,
      1234
    );
    assert.equal(
      typeof db.prepare("SELECT created_at FROM clocked WHERE id='new'").get().created_at,
      'number'
    );
    assert.ok(plan.sql.includes('__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__'));
    assert.doesNotMatch(plan.sql, /SELECT\s+CASE\s+WHEN/iu);
  } finally {
    db.close();
  }
});

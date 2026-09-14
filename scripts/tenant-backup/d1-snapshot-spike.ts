import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';
import { sqliteSnapshotRowInsert } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-row-codec.js';
import { sqliteSnapshotStartStatement } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-capture-plan.js';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot.js';

// Use the exact Miniflare shipped with the workspace's pinned Wrangler dependency.
// This is a local-only feasibility check; it never reads Wrangler deployment config.
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const runtime = new Miniflare({
  modules: true,
  script: 'export default {};',
  compatibilityDate: '2026-07-08',
  host: '127.0.0.1',
  d1Databases: ['BACKUP_TEST_DB', 'RESTORE_TEST_DB'],
});

try {
  const db = await runtime.getD1Database('BACKUP_TEST_DB');
  const schema = {
    table: 'accounts',
    tenantColumn: 'tenant_id',
    columns: ['tenant_id', 'id', 'name', 'counter', 'secret'],
    primaryKey: ['tenant_id', 'id'],
    uniqueKeys: [['name']],
  };
  const ddl = `CREATE TABLE accounts (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT UNIQUE,
    counter INTEGER, secret BLOB, PRIMARY KEY (tenant_id, id));
    ${SQLITE_SNAPSHOT_SCHEMA}
    ${sqliteSnapshotTriggers(schema)}`;
  for (const sql of splitMigrationSql(ddl)) await db.prepare(sql).run();
  await db
    .prepare(
      `INSERT INTO accounts VALUES
    ('a','1','original',9007199254740993,X'00ff'),('b','1','private',0,NULL)`
    )
    .run();
  const notesSchema = {
    table: 'account_notes',
    columns: ['id', 'owner_tenant', 'account_id', 'note'],
    primaryKey: ['id'],
    uniqueKeys: [],
    parent: { schema, childColumns: ['owner_tenant', 'account_id'] },
  };
  const notesDdl = `CREATE TABLE account_notes (
    id TEXT PRIMARY KEY NOT NULL, owner_tenant TEXT NOT NULL,
    account_id TEXT NOT NULL, note TEXT,
    FOREIGN KEY (owner_tenant, account_id) REFERENCES accounts(tenant_id,id) ON DELETE CASCADE);
    ${sqliteSnapshotTriggers(notesSchema)}`;
  for (const sql of splitMigrationSql(notesDdl)) await db.prepare(sql).run();
  await db
    .prepare("INSERT INTO account_notes VALUES ('note','a','1','before parent deletion')")
    .run();
  const start = sqliteSnapshotStartStatement([notesSchema], 's1', 'a');
  await assert.rejects(
    db.prepare("INSERT INTO account_notes VALUES (NULL,'a','1','invalid identity')").run()
  );
  assert.equal(
    (
      await db
        .prepare(start.sql)
        .bind(...start.params)
        .run()
    ).meta.changes,
    1
  );
  await assert.rejects(
    db.prepare("INSERT INTO account_notes VALUES (NULL,'a','1','invalid write')").run()
  );
  await db.prepare("INSERT OR REPLACE INTO accounts VALUES ('a','2','original',0,NULL)").run();
  const page = await db.prepare(sqliteSnapshotPageQuery(schema)).bind('s1', 'a', '', 100).all();
  assert.equal(page.results.length, 1);
  const row = JSON.parse(String(page.results[0].row_json)) as Record<string, unknown>;
  assert.deepEqual(row.id, ['text', '1']);
  assert.deepEqual(row.counter, ['integer', '9007199254740993']);
  assert.deepEqual(row.secret, ['blob', '00FF']);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM account_notes').first('n'), 0);
  const notes = await db
    .prepare(sqliteSnapshotPageQuery(notesSchema))
    .bind('s1', 'a', '', 100)
    .all();
  assert.equal(notes.results.length, 1);
  assert.deepEqual(
    (JSON.parse(String(notes.results[0].row_json)) as Record<string, unknown>).note,
    ['text', 'before parent deletion']
  );
  const target = await runtime.getD1Database('RESTORE_TEST_DB');
  await target.prepare(splitMigrationSql(ddl)[0]).run();
  const insert = sqliteSnapshotRowInsert(
    schema.table,
    schema.columns,
    String(page.results[0].row_json)
  );
  await target
    .prepare(insert.sql)
    .bind(...insert.params)
    .run();
  assert.deepEqual(
    await target
      .prepare('SELECT id, CAST(counter AS TEXT) AS counter, hex(secret) AS secret FROM accounts')
      .first(),
    { id: '1', counter: '9007199254740993', secret: '00FF' }
  );
  assert.equal(
    (await db.prepare(sqliteSnapshotPageQuery(schema)).bind('s1', 'b', '', 100).all()).results
      .length,
    0
  );
  const before = await db.prepare('SELECT count(*) AS n FROM tenant_backup_preimages').first('n');
  await assert.rejects(
    db.batch([
      db.prepare("INSERT INTO accounts VALUES ('a','3','rolled back',0,NULL)"),
      db.prepare("UPDATE accounts SET name = 'not committed' WHERE tenant_id = 'a'"),
      db.prepare("INSERT INTO accounts (tenant_id,id) VALUES ('a','2')"),
    ])
  );
  assert.equal(
    await db.prepare('SELECT count(*) AS n FROM tenant_backup_preimages').first('n'),
    before
  );
  assert.equal(
    await db.prepare("SELECT name FROM accounts WHERE tenant_id = 'a'").first('name'),
    'original'
  );
  process.stdout.write(
    'Local D1 snapshot spike PASS: preimages, parent cascade, REPLACE, exact-value restore, tenant gate, batch rollback.\n'
  );
} finally {
  await runtime.dispose();
}

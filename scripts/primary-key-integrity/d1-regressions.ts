import assert from 'node:assert/strict';
import { inspectSchema } from './schema-inventory.js';
import { buildPrimaryKeyMigration } from './rebuild.js';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';

/** Only called with an ephemeral, locally created Miniflare database. */
export async function verifyD1Regressions(
  db: Awaited<ReturnType<import('miniflare').Miniflare['getD1Database']>>
): Promise<void> {
  const ddl = `CREATE TABLE parents (a TEXT, b TEXT, PRIMARY KEY(a,b));
    CREATE UNIQUE INDEX parent_key ON parents(a,b);
    CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b TEXT,
      payload BLOB DEFAULT X'00ff', FOREIGN KEY(a,b) REFERENCES parents(a,b) ON DELETE CASCADE);
    CREATE TABLE audit (id INTEGER PRIMARY KEY, message TEXT);
    CREATE TRIGGER child_audit AFTER INSERT ON children BEGIN
      INSERT INTO audit(message) VALUES ('created'); END;
    CREATE VIEW child_view AS SELECT id,hex(payload) AS payload FROM children;`;
  const batch = (sql: string) => db.batch(splitMigrationSql(sql).map((part) => db.prepare(part)));
  await batch(ddl);
  const plan = buildPrimaryKeyMigration(inspectSchema([ddl]));
  await batch(`INSERT INTO parents VALUES (NULL,'bad'),('p','q');
    INSERT INTO children(id,a,b) VALUES (100,'p','q'); DELETE FROM children WHERE id=100;
    INSERT INTO children(id,a,b) VALUES (1,'p','q');`);
  const before = await db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all();
  await assert.rejects(() => batch(plan.sql), /primary_key_integrity_preflight/);
  assert.deepEqual(
    (await db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()).results,
    before.results
  );
  assert.equal(await db.prepare('SELECT count(*) FROM parents').first('count(*)'), 2);
  // Deliberately remove only this synthetic corrupt fixture, never application data.
  await db.prepare('DELETE FROM parents WHERE a IS NULL').run();
  const beforeLateFailure = (
    await db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()
  ).results;
  await assert.rejects(
    () =>
      batch(
        plan.sql +
          '\nCREATE TABLE injected_failure(n INTEGER CHECK(n=0)); INSERT INTO injected_failure VALUES(1);'
      ),
    /CHECK/
  );
  assert.deepEqual(
    (await db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all()).results,
    beforeLateFailure
  );
  assert.equal(await db.prepare('SELECT count(*) AS n FROM children').first('n'), 1);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM audit').first('n'), 2);
  await batch(plan.sql);
  for (const key of ['a', 'b']) {
    await assert.rejects(
      () =>
        db
          .prepare(`INSERT INTO parents(a,b) VALUES (${key === 'a' ? "NULL,'x'" : "'x',NULL"})`)
          .run(),
      /NOT NULL/
    );
    await assert.rejects(() => db.prepare(`UPDATE parents SET ${key}=NULL`).run(), /NOT NULL/);
  }
  assert.deepEqual((await db.prepare('SELECT * FROM child_view').all()).results, [
    { id: 1, payload: '00FF' },
  ]);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM audit').first('n'), 2);
  await db.prepare("INSERT INTO children(a,b) VALUES ('p','q')").run();
  assert.equal(await db.prepare('SELECT max(id) AS id FROM children').first('id'), 101);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM audit').first('n'), 3);
  await db.prepare("INSERT INTO parents VALUES ('valid','write')").run();
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
}

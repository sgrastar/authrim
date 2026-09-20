import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseAdapter } from '../../packages/ar-lib-core/src/db/adapter.js';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';
import { readBackupSqliteSchema } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-schema-reader.js';
import { assessSnapshotTable } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-schema-assessment.js';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot.js';
import {
  sqliteCapturePlan,
  sqliteSnapshotStartStatement,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-capture-plan.js';
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const runtime = new Miniflare({
  modules: true,
  script: 'export default {};',
  compatibilityDate: '2026-07-08',
  host: '127.0.0.1',
  d1Databases: ['FIXTURE'],
});
try {
  const db = await runtime.getD1Database('FIXTURE');
  const sql = `CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,code TEXT,config TEXT);
    CREATE UNIQUE INDEX code_key ON items(tenant_id,COALESCE(code,''));
    CREATE UNIQUE INDEX entity_key ON items(tenant_id,json_extract(config,'$.entityId')) WHERE json_valid(config);`;
  await db.batch(splitMigrationSql(sql + SQLITE_SNAPSHOT_SCHEMA).map((sql) => db.prepare(sql)));
  const reader: Pick<DatabaseAdapter, 'query' | 'queryOne'> = {
    async query<T>(sql: string, params: unknown[] = []) {
      return (
        await db
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results;
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return db
        .prepare(sql)
        .bind(...params)
        .first<T>();
    },
  };
  const assessed = assessSnapshotTable(await readBackupSqliteSchema(reader, 'items'));
  assert.deepEqual(assessed.concerns, []);
  assert(assessed.schema);
  const plan = sqliteCapturePlan([assessed.schema]);
  await db
    .prepare(
      `INSERT INTO items VALUES ('null-code','a',NULL,'{"entityId":"first"}'),('json-key','a','second','{"entityId":"second"}'),('invalid','a','third','malformed'),('private','b',NULL,'{"entityId":"first"}')`
    )
    .run();
  for (const trigger of plan.triggers) await db.prepare(trigger.sql).run();
  const start = sqliteSnapshotStartStatement(plan.schemas, 'snapshot', 'a');
  assert.equal(
    (
      await db
        .prepare(start.sql)
        .bind(...start.params)
        .run()
    ).meta.changes,
    1
  );
  await db
    .prepare(`INSERT OR REPLACE INTO items VALUES ('new-code','a','','{"entityId":"new"}')`)
    .run();
  await db
    .prepare(
      `INSERT OR REPLACE INTO items VALUES ('new-json','a','fourth','{"entityId":"second"}')`
    )
    .run();
  await db.prepare(`UPDATE items SET config='still-malformed' WHERE id='invalid'`).run();
  const rows = await db
    .prepare(sqliteSnapshotPageQuery(assessed.schema))
    .bind('snapshot', 'a', '', 100)
    .all<{ record_key: string }>();
  assert.deepEqual(
    rows.results.map((row) => row.record_key).sort(),
    ['invalid', 'json-key', 'null-code'].map((id) => JSON.stringify([['text', id]])).sort()
  );
  assert.equal(
    (
      await db
        .prepare(
          'SELECT count(*) AS count FROM tenant_backup_preimages WHERE snapshot_id=? AND present=1'
        )
        .bind('snapshot')
        .first<{ count: number }>()
    )?.count,
    3
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS count FROM items WHERE tenant_id='b'")
        .first<{ count: number }>()
    )?.count,
    1
  );
  process.stdout.write(
    JSON.stringify({
      scope: 'local-d1-expression-conflict-capture',
      coalesceReplace: true,
      jsonReplace: true,
      malformedJsonWrite: true,
      tenantIsolation: true,
      productionWriterFencing: false,
    }) + '\n'
  );
} finally {
  await runtime.dispose();
}

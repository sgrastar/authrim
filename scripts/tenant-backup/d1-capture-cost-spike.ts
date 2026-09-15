import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';
import { sqliteSnapshotStartStatement } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-capture-plan.js';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot.js';

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const runtime = new Miniflare({
  modules: true,
  script: 'export default {};',
  compatibilityDate: '2026-07-08',
  host: '127.0.0.1',
  d1Databases: ['COST_FIXTURE'],
});
const schema = {
  table: 'records',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'id', 'revision', 'payload'],
  primaryKey: ['tenant_id', 'id'],
  uniqueKeys: [],
};
const rowCount = 256;
const payload = 'x'.repeat(1024);
const batches: Array<{ phase: string; batchRows: number; wallMs: number }> = [];

try {
  const db = await runtime.getD1Database('COST_FIXTURE');
  await db.batch(
    splitMigrationSql(`CREATE TABLE records (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(tenant_id,id)); ${SQLITE_SNAPSHOT_SCHEMA}`).map((sql) =>
      db.prepare(sql)
    )
  );
  for (let offset = 0; offset < rowCount; offset += 32) {
    await db.batch(
      Array.from({ length: 32 }, (_, index) =>
        db
          .prepare("INSERT INTO records VALUES ('a', ?, 0, ?)")
          .bind(String(offset + index).padStart(4, '0'), payload)
      )
    );
  }
  await db.prepare("INSERT INTO records VALUES ('b', '0000', 0, ?)").bind(payload).run();

  async function updateAll(phase: string): Promise<void> {
    for (let offset = 0; offset < rowCount; offset += 32) {
      const statements = Array.from({ length: 32 }, (_, index) =>
        db
          .prepare("UPDATE records SET revision = revision + 1 WHERE tenant_id = 'a' AND id = ?")
          .bind(String(offset + index).padStart(4, '0'))
      );
      const before = performance.now();
      const result = await db.batch(statements);
      const wallMs = performance.now() - before;
      assert.ok(result.every((item) => item.success && item.meta.changes >= 1));
      batches.push({ phase, batchRows: statements.length, wallMs });
    }
  }
  async function retained(): Promise<{ rows: number; logicalBytes: number }> {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS rows,
      COALESCE(SUM(length(CAST(record_key AS BLOB)) + length(CAST(row_json AS BLOB))),0) AS logicalBytes
      FROM tenant_backup_preimages`
      )
      .first<{ rows: number; logicalBytes: number }>();
    assert.ok(row);
    return row;
  }
  const starts: Array<{ id: string; wallMs: number }> = [];
  async function start(id: string): Promise<void> {
    const statement = sqliteSnapshotStartStatement([schema], id, 'a');
    const before = performance.now();
    const result = await db
      .prepare(statement.sql)
      .bind(...statement.params)
      .run();
    starts.push({ id, wallMs: performance.now() - before });
    assert.equal(result.meta.changes, 1);
  }
  async function verifyPageStream(id: string, revision: number): Promise<void> {
    let cursor = '';
    let count = 0;
    const ids = new Set<string>();
    for (;;) {
      const page = await db
        .prepare(sqliteSnapshotPageQuery(schema, 'json'))
        .bind(id, 'a', cursor, 31)
        .all<{ record_key: string; row_json: string }>();
      if (!page.results.length) break;
      for (const record of page.results) {
        const values = JSON.parse(record.row_json) as Record<string, [string, string]>;
        assert.deepEqual(values.tenant_id, ['text', 'a']);
        assert.deepEqual(values.revision, ['integer', String(revision)]);
        assert.deepEqual(values.payload, ['text', payload]);
        assert.ok(!ids.has(values.id[1]));
        ids.add(values.id[1]);
        cursor = record.record_key;
        count++;
      }
      assert.ok(count <= rowCount, 'pagination must make progress');
      // Continue ordinary mutations BETWEEN pages, including an unrelated tenant. All
      // captured rows must remain at the original boundary despite those concurrent changes.
      await db.prepare("UPDATE records SET revision = revision + 1 WHERE id = '0000'").run();
    }
    assert.equal(count, rowCount);
  }

  await updateAll('no_triggers');
  await db.batch(
    splitMigrationSql(sqliteSnapshotTriggers(schema, 'json')).map((sql) => db.prepare(sql))
  );
  await db
    .prepare(
      `WITH RECURSIVE numbers(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < 1000
  ) INSERT INTO tenant_backup_snapshots (id, tenant_id, state) SELECT 'history-' || n, 'a', 'sealed' FROM numbers`
    )
    .run();
  await updateAll('idle_triggers');
  assert.deepEqual(await retained(), { rows: 0, logicalBytes: 0 });
  await start('first'); // revision 2
  await updateAll('first_capture_first_touch');
  const firstTouch = await retained();
  assert.equal(firstTouch.rows, rowCount);
  await updateAll('first_capture_repeat_touch');
  assert.deepEqual(await retained(), firstTouch, 'repeated writes must not grow old versions');
  await start('second'); // revision 4
  await updateAll('two_captures_first_touch');
  const twoCaptures = await retained();
  assert.equal(twoCaptures.rows, rowCount * 2);
  await verifyPageStream('first', 2);
  await verifyPageStream('second', 4);
  assert.deepEqual(await retained(), twoCaptures, 'page-time mutations must not grow old versions');
  await db.prepare("DELETE FROM tenant_backup_snapshots WHERE id = 'first'").run();
  assert.equal((await retained()).rows, rowCount);
  await db
    .prepare("UPDATE tenant_backup_snapshots SET state = 'invalid' WHERE id = 'second'")
    .run();
  assert.equal(
    (await db.prepare(sqliteSnapshotPageQuery(schema, 'json')).bind('second', 'a', '', 31).all())
      .results.length,
    0
  );
  await db.prepare("DELETE FROM tenant_backup_snapshots WHERE id = 'second'").run();
  await updateAll('after_cleanup');
  assert.deepEqual(await retained(), { rows: 0, logicalBytes: 0 });
  const phases = [...new Set(batches.map((batch) => batch.phase))].map((phase) => {
    const samples = batches
      .filter((batch) => batch.phase === phase)
      .map((batch) => batch.wallMs)
      .sort((a, b) => a - b);
    return {
      phase,
      samples: samples.length,
      batchRows: 32,
      medianBatchWallMs: samples[Math.floor(samples.length / 2)],
      maxBatchWallMs: samples[samples.length - 1],
    };
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        scope: 'local-d1-single-table-capture-cost-fixture',
        productionPerformanceVerified: false,
        rowCount,
        historicalSnapshots: 1000,
        payloadBytesPerRow: payload.length,
        storageMeasurement:
          'UTF-8 record_key and row_json only; excludes indexes, pages and database overhead',
        firstTouch,
        twoCaptures,
        starts,
        phases,
        verified: [
          'bounded preimages per snapshot and identity',
          'continued writes between pages',
          'cross-tenant exclusion',
          'two distinct boundaries',
          'invalid snapshot unreadable',
          'cleanup isolation',
        ],
      },
      null,
      2
    )}\n`
  );
} finally {
  await runtime.dispose();
}

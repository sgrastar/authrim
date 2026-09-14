import { MIGRATION_STREAM_CONTRACTS } from '../../packages/ar-lib-core/src/services/control-plane/migration-stream-contract.js';
import { planSqliteTenantDatasets } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-dataset-plan.js';
import { readBackupSqliteSchema } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-schema-reader.js';
import type { DatabaseAdapter } from '../../packages/ar-lib-core/src/db/adapter.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inventoryBackupSchemas } from './schema-inventory.js';
import { assessSnapshotTable } from './snapshot-applicability.js';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/src/migrations/sql-portability.js';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';
import { SQLITE_SNAPSHOT_SCHEMA } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot.js';
import {
  sqliteCapturePlan,
  sqliteSnapshotStartStatement,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-capture-plan.js';

// Local-only schema feasibility, using Wrangler's existing runtime dependency.
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const root = fileURLToPath(new URL('../../', import.meta.url));
const inventory = inventoryBackupSchemas(root);
const runtime = new Miniflare({
  modules: true,
  script: 'export default {};',
  compatibilityDate: '2026-07-08',
  host: '127.0.0.1',
  d1Databases: inventory.inspectedStreams.map((_, index) => `TEST_DB_${index}`),
});
const results = [];
try {
  for (const [index, stream] of inventory.inspectedStreams.entries()) {
    const db = await runtime.getD1Database(`TEST_DB_${index}`);
    for (const migration of stream.migrations) {
      const statements = splitMigrationSql(
        renderPortableMigrationSql(readFileSync(`${root}${migration.file}`, 'utf8'), 'sqlite')
      );
      // Rebuild migrations require one atomic batch for the complete file.
      await db.batch(statements.map((sql) => db.prepare(sql)));
    }
    // Applying SQL successfully is not sufficient: compare the resulting columns
    // and key flags against the executable inventory from the same manifest.
    for (let offset = 0; offset < stream.tables.length; offset += 32) {
      const tables = stream.tables.slice(offset, offset + 32);
      const shapes = await db.batch<{
        name: string;
        type: string;
        non_null: number;
        dflt_value: string | null;
        pk: number;
        hidden: number;
      }>(
        tables.map((table) =>
          db
            .prepare(
              'SELECT name, type, "notnull" AS non_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid'
            )
            .bind(table.name)
        )
      );
      for (const [tableIndex, table] of tables.entries()) {
        assert.deepEqual(
          shapes[tableIndex].results.map((row) => ({
            name: row.name,
            type: row.type,
            notNull: row.non_null === 1,
            defaultSql: row.dflt_value,
            primaryKeyPosition: row.pk,
            generated: row.hidden !== 0,
          })),
          table.columns,
          `${stream.id}:${table.name}`
        );
      }
    }
    const schemaReader: Pick<DatabaseAdapter, 'query' | 'queryOne'> = {
      async query<T>(sql: string, params: unknown[] = []) {
        const result = await db
          .prepare(sql)
          .bind(...params)
          .all<T>();
        return result.results;
      },
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return db
          .prepare(sql)
          .bind(...params)
          .first<T>();
      },
    };
    const runtimeSchemas = [];
    for (const table of stream.tables) {
      if (table.name.startsWith('tenant_backup_')) continue;
      const runtimeSchema = await readBackupSqliteSchema(schemaReader, table.name);
      assert.deepEqual(runtimeSchema.columns, table.columns, `${stream.id}:${table.name}:runtime`);
      assert.deepEqual(
        assessSnapshotTable(runtimeSchema),
        assessSnapshotTable(table),
        `${stream.id}:${table.name}:assessment`
      );
      runtimeSchemas.push(runtimeSchema);
    }
    for (const sql of splitMigrationSql(SQLITE_SNAPSHOT_SCHEMA)) await db.prepare(sql).run();
    const contract = MIGRATION_STREAM_CONTRACTS.find((candidate) => candidate.id === stream.id);
    if (!contract) throw new Error('missing_stream_contract');
    const datasetPlan = planSqliteTenantDatasets(contract.schemaFamily, runtimeSchemas, {
      settings: true,
      users: true,
      admin: true,
      artifacts: true,
      logs: { audit: true, other: true, sensitive: true, period: 'all' },
    });
    // Feasibility only: exercise supported adapters while reporting every unresolved entry.
    // The product planner itself withholds an executable plan if any required entry is unresolved.
    const selected = datasetPlan.entries.flatMap((entry) => (entry.capture ? [entry.capture] : []));
    if (!selected.length) {
      results.push({
        stream: stream.id,
        totalTables: stream.tables.length,
        verifiedColumnSchemas: stream.tables.length,
        structurallyEligibleTables: 0,
        captureStarted: false,
        datasetPlanConcerns: datasetPlan.entries
          .filter((entry) => entry.concerns.length)
          .map((entry) => ({ table: entry.table, concerns: entry.concerns })),
      });
      continue;
    }
    const plan = sqliteCapturePlan(selected);
    for (const trigger of plan.triggers) await db.prepare(trigger.sql).run();
    const start = sqliteSnapshotStartStatement(
      selected,
      'local-schema-spike',
      'fixture-tenant',
      'fixture-tenant-key'
    );
    const startedAt = performance.now();
    const result = await db
      .prepare(start.sql)
      .bind(...start.params)
      .run();
    const startWallMs = performance.now() - startedAt;
    assert.equal(result.meta.changes, 1, stream.id);
    results.push({
      stream: stream.id,
      totalTables: stream.tables.length,
      datasetPlanConcerns: datasetPlan.entries
        .filter((entry) => entry.concerns.length)
        .map((entry) => ({ table: entry.table, concerns: entry.concerns })),
      verifiedColumnSchemas: stream.tables.length,
      structurallyEligibleTables: selected.length,
      unverifiedTables: stream.tables.length - selected.length,
      triggerCount: plan.triggers.length,
      largestTriggerBytes: Math.max(
        ...plan.triggers.map((trigger) => Buffer.byteLength(trigger.sql))
      ),
      startBindingsBytes: Buffer.byteLength(JSON.stringify(plan.triggers)),
      largestStartBindingBytes: Math.max(...start.params.map((param) => Buffer.byteLength(param))),
      startParameterCount: start.params.length,
      startWallMs,
    });
  }
} finally {
  await runtime.dispose();
}
process.stdout.write(
  `${JSON.stringify(
    {
      scope: 'local-d1-fresh-schema-and-structurally-eligible-capture-only',
      productionPerformanceVerified: false,
      productVersion: inventory.productVersion,
      manifestSha256: inventory.manifestSha256,
      results,
    },
    null,
    2
  )}\n`
);

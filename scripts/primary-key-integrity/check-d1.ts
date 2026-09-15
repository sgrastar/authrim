import assert from 'node:assert/strict';
import { verifyD1Regressions } from './d1-regressions.js';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventorySchemas } from './schema-inventory.js';
import { buildStreamPrimaryKeyMigration, infrastructureDefinitions } from './stream-plan.js';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/src/migrations/sql-portability.js';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.argv[2];
if (!output) throw new Error('An existing evidence directory is required');
const inventory = inventorySchemas(root, true);
const runtime = new Miniflare({
  modules: true,
  script: 'export default {};',
  host: '127.0.0.1',
  compatibilityDate: '2026-07-08',
  d1Databases: ['REGRESSIONS', ...inventory.inspectedStreams.map((_, index) => `CHECK_${index}`)],
});
const results = [];
try {
  await verifyD1Regressions(await runtime.getD1Database('REGRESSIONS'));
  process.stdout.write(
    'D1 rollback, composite NULL rejection, related data, triggers and sequences verified\n'
  );
  for (const [index, stream] of inventory.inspectedStreams.entries()) {
    const db = await runtime.getD1Database(`CHECK_${index}`);
    for (const migration of stream.migrations) {
      const statements = splitMigrationSql(
        renderPortableMigrationSql(readFileSync(resolve(root, migration.file), 'utf8'), 'sqlite')
      );
      for (let offset = 0; offset < statements.length; offset += 32)
        await db.batch(statements.slice(offset, offset + 32).map((sql) => db.prepare(sql)));
    }
    for (const definition of infrastructureDefinitions(stream))
      await db.prepare(definition.replace('TEXT PRIMARY KEY NOT NULL', 'TEXT PRIMARY KEY')).run();
    await db
      .prepare(
        "INSERT INTO authrim_migrations(filename,checksum,applied_at) VALUES ('fixture.sql','fixture',1)"
      )
      .run();
    const plan = buildStreamPrimaryKeyMigration(stream);
    const migrationName = stream.unselectedMigrationFiles.find((file) =>
      file.endsWith('_primary_key_not_null.sql')
    );
    if (!migrationName) throw new Error(`missing_primary_key_migration:${stream.id}`);
    const directory = resolve(root, stream.migrations[0].file, '..');
    assert.equal(
      readFileSync(resolve(directory, migrationName), 'utf8'),
      plan.sql,
      `${stream.id}:checked-in SQL`
    );
    const statements = splitMigrationSql(renderPortableMigrationSql(plan.sql, 'sqlite'));
    const started = performance.now();
    // Match ApiMigrationEngine: the entire file is ONE batch, never segmented.
    try {
      await db.batch(statements.map((sql) => db.prepare(sql)));
    } catch (error) {
      throw new Error(`${stream.id}:atomic-rebuild-failed`, { cause: error });
    }
    const durationMs = performance.now() - started;
    assert.equal(
      await db
        .prepare("SELECT checksum FROM authrim_migrations WHERE filename='fixture.sql'")
        .first('checksum'),
      'fixture'
    );
    for (let offset = 0; offset < plan.tightened.length; offset += 32) {
      const names = plan.tightened.slice(offset, offset + 32);
      const rows = await db.batch<{ name: string; pk: number; notnull: number }>(
        names.map((name) =>
          db.prepare('SELECT name,pk,"notnull" FROM pragma_table_info(?) WHERE pk>0').bind(name)
        )
      );
      for (const [n, result] of rows.entries())
        assert(
          result.results.length > 0 && result.results.every((column) => column.notnull === 1),
          `${stream.id}:${names[n]}`
        );
    }
    assert.equal(
      (await db.prepare('SELECT * FROM pragma_foreign_key_check').all()).results.length,
      0,
      stream.id
    );
    assert.equal(
      (await db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '__authrim_pk_*'").all())
        .results.length,
      0,
      stream.id
    );
    results.push({
      stream: stream.id,
      tightenedTables: plan.tightened.length,
      rebuiltTables: plan.rebuilt.length,
      statements: statements.length,
      durationMs,
    });
    process.stdout.write(`${stream.id}: ${plan.tightened.length} primary keys verified\n`);
  }
} finally {
  await runtime.dispose();
}
writeFileSync(
  resolve(output, 'local-d1-rebuild-evidence.json'),
  JSON.stringify({ manifestSha256: inventory.manifestSha256, results }, null, 2) + '\n'
);

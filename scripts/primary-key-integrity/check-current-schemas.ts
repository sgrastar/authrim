import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventorySchemas } from './schema-inventory.js';
import { buildStreamPrimaryKeyMigration, infrastructureDefinitions } from './stream-plan.js';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/src/migrations/sql-portability.js';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';

interface LocalDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(): Array<Record<string, unknown>> };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => LocalDatabase;
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.argv[2];
if (!output) throw new Error('An existing evidence directory is required');
const inventory = inventorySchemas(root, true);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const results = [];
for (const stream of inventory.inspectedStreams) {
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
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of stream.migrations)
      db.exec(
        renderPortableMigrationSql(readFileSync(resolve(root, migration.file), 'utf8'), 'sqlite')
      );
    for (const definition of infrastructureDefinitions(stream))
      db.exec(definition.replace('TEXT PRIMARY KEY NOT NULL', 'TEXT PRIMARY KEY'));
    db.exec(
      "INSERT INTO authrim_migrations(filename,checksum,applied_at) VALUES ('fixture.sql','fixture',1)"
    );
    db.exec('PRAGMA foreign_keys=ON');
    const rows = (table: (typeof stream.tables)[number]) =>
      db
        .prepare(
          `SELECT ${table.columns.map((column, index) => `quote(${quote(column.name)}) AS c${index}`).join(',')} FROM ${quote(table.name)}`
        )
        .all()
        .map((row) => JSON.stringify(row))
        .sort();
    const before = new Map(stream.tables.map((table) => [table.name, rows(table)]));
    db.exec('BEGIN');
    try {
      for (const [index, statement] of statements.entries()) {
        try {
          db.exec(statement);
        } catch (error) {
          throw new Error(`${stream.id}:statement:${index}:${statement.slice(0, 100)}`, {
            cause: error,
          });
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    assert.equal(
      db.prepare("SELECT checksum FROM authrim_migrations WHERE filename='fixture.sql'").all()[0]
        .checksum,
      'fixture'
    );
    for (const table of stream.tables)
      assert.deepEqual(rows(table), before.get(table.name), `${stream.id}:${table.name}:rows`);
    for (const table of stream.tables.filter((table) => plan.tightened.includes(table.name))) {
      const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
      assert(
        columns.filter((column) => Number(column.pk) > 0).every((column) => column.notnull === 1),
        `${stream.id}:${table.name}:not-null`
      );
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], stream.id);
    const objects = db
      .prepare(
        "SELECT type,name,tbl_name AS 'table',sql FROM sqlite_schema WHERE type != 'table' AND sql IS NOT NULL ORDER BY type,name"
      )
      .all();
    assert.deepEqual(
      objects.map((row) => ({ ...row })),
      stream.objects,
      `${stream.id}:objects`
    );
    writeFileSync(resolve(output, `${stream.id}-candidate.sql`), plan.sql);
    results.push({
      stream: stream.id,
      tightenedTables: plan.tightened.length,
      rebuiltTables: plan.rebuilt.length,
      bytes: Buffer.byteLength(plan.sql),
      statements: statements.length,
      seedRowsPreserved: [...before.values()].reduce((sum, rows) => sum + rows.length, 0),
    });
  } finally {
    db.close();
  }
}
writeFileSync(
  resolve(output, 'sqlite-rebuild-evidence.json'),
  JSON.stringify({ manifestSha256: inventory.manifestSha256, results }, null, 2) + '\n'
);
process.stdout.write(JSON.stringify(results, null, 2) + '\n');

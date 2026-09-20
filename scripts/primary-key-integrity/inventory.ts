import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { inventorySchemas, type SchemaTable } from './schema-inventory.js';
import {
  readReleaseMigrationManifest,
  calculateReleaseMigrationChecksum,
} from '../../packages/setup/src/core/release-migrations.js';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/src/migrations/sql-portability.js';

export function classifyPrimaryKey(table: SchemaTable) {
  const columns = table.columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition);
  const rowidAlias =
    !table.withoutRowid &&
    columns.length === 1 &&
    columns[0].type.toUpperCase() === 'INTEGER' &&
    !table.indexes.some((index) => index.origin === 'pk');
  return {
    table: table.name,
    status: columns.length === 0 ? 'no_primary_key' : 'primary_key',
    columns: columns.map((column) => ({
      name: column.name,
      pragmaNotNull: column.notNull,
      guarantee: rowidAlias
        ? 'integer_rowid_alias'
        : table.withoutRowid
          ? 'without_rowid_primary_key'
          : table.strict
            ? 'strict_primary_key'
            : column.notNull
              ? 'explicit_not_null'
              : 'nullable_primary_key',
    })),
  };
}

export function writeInventory(root: string, outputDirectory: string): void {
  const inventory = inventorySchemas(root);
  const streams = inventory.inspectedStreams.map((stream) => ({
    id: stream.id,
    migrations: stream.migrations,
    tables: stream.tables.map(classifyPrimaryKey),
  }));
  writeFileSync(
    resolve(outputDirectory, 'sqlite-primary-key-inventory.json'),
    JSON.stringify(
      {
        productVersion: inventory.productVersion,
        manifestSha256: inventory.manifestSha256,
        streams,
        dataInspection: 'fresh migration seed data only; existing environments not inspected',
      },
      null,
      2
    ) + '\n'
  );
  const manifest = readReleaseMigrationManifest(
    resolve(root, 'migrations/release-manifest.draft.json')
  );
  for (const family of ['core', 'pii']) {
    const stream = manifest.streams.find((entry) => entry.id === `${family}-postgresql`);
    if (!stream) throw new Error(`missing_postgresql_stream:${family}`);
    const sources = stream.files.map((file) => {
      const path = resolve(root, 'migrations', family, 'postgresql', file.path);
      if (calculateReleaseMigrationChecksum(path, 'postgresql') !== file.checksum)
        throw new Error('postgresql_checksum_mismatch');
      return renderPortableMigrationSql(readFileSync(path, 'utf8'), 'postgres');
    });
    // Each migration is authored for a fresh psql session. pg_dump baselines clear
    // search_path; restore the default target before the next independent file.
    const sql = sources.map((source) => `SET search_path = public;\n${source}`).join('\n');
    writeFileSync(resolve(outputDirectory, `${family}-postgresql-fixture.sql`), sql);
    writeFileSync(
      resolve(outputDirectory, `${family}-postgresql-fixture.sha256`),
      createHash('sha256').update(sql).digest('hex') + '\n'
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output)
    throw new Error(
      'Usage: tsx scripts/primary-key-integrity/inventory.ts <existing output directory>'
    );
  writeInventory(fileURLToPath(new URL('../../', import.meta.url)), resolve(output));
}

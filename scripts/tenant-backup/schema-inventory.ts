import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  MIGRATION_STREAM_CONTRACTS,
  type MigrationStreamId,
} from '../../packages/ar-lib-core/src/services/control-plane/migration-stream-contract.js';
import {
  readReleaseMigrationManifest,
  calculateReleaseMigrationChecksum,
} from '../../packages/setup/src/core/release-migrations.js';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/src/migrations/sql-portability.js';

// The workspace targets Node 22+ but retains Node 20 ambient types. Describe only
// the built-in SQLite API used by this development tool, without changing Worker types.
interface SchemaDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...values: string[]): Array<Record<string, string | number | null>> };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SchemaDatabase;
};

import type { BackupSchemaTable } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-schema-types.js';
export type {
  BackupSchemaColumn,
  BackupSchemaForeignKey,
  BackupSchemaIndex,
  BackupSchemaTable,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-schema-types.js';

export interface BackupSchemaInventory {
  formatVersion: 1;
  productVersion: string;
  manifestSha256: string;
  inspectedStreams: Array<{
    id: MigrationStreamId;
    migrations: Array<{ file: string; sha256: string; executionSha256: string }>;
    unselectedMigrationFiles: string[];
    tables: BackupSchemaTable[];
    objects: Array<{ type: string; name: string; table: string; sql: string }>;
  }>;
  uninspectedStreams: Array<{ id: MigrationStreamId; reason: string }>;
}

/** Execute repository-owned migrations only. This is never an import-bundle SQL executor. */
export function inspectBackupSchema(sqlFiles: readonly string[]): {
  tables: BackupSchemaTable[];
  objects: Array<{ type: string; name: string; table: string; sql: string }>;
} {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of sqlFiles) {
      db.exec('BEGIN');
      try {
        db.exec(renderPortableMigrationSql(sql, 'sqlite'));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    const schema = db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY type, name`
      )
      .all();
    const tables = schema
      .filter((row) => row.type === 'table')
      .map((row) => {
        const name = String(row.name);
        // Table-valued PRAGMAs accept bound names, including quoted identifiers.
        const columns = db.prepare('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid').all(name);
        const foreignKeys = db
          .prepare('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq')
          .all(name);
        const tableFlags = db.prepare('SELECT wr, strict FROM pragma_table_list(?)').all(name)[0];
        const indexes = db.prepare('SELECT * FROM pragma_index_list(?) ORDER BY name').all(name);
        return {
          name,
          withoutRowid: tableFlags.wr === 1,
          strict: tableFlags.strict === 1,
          indexes: indexes.map((index) => ({
            name: String(index.name),
            unique: index.unique === 1,
            origin: String(index.origin),
            partial: index.partial === 1,
            sql:
              (db
                .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
                .all(String(index.name))[0]?.sql as string | null) ?? null,
            columns: db
              .prepare('SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno')
              .all(String(index.name))
              .map((column) => ({
                position: Number(column.seqno),
                name: column.name === null ? null : String(column.name),
                collation: String(column.coll),
                descending: column.desc === 1,
                key: column.key === 1,
              })),
          })),
          sql: String(row.sql),
          columns: columns.map((column) => ({
            name: String(column.name),
            type: String(column.type),
            notNull: column.notnull === 1,
            defaultSql: column.dflt_value === null ? null : String(column.dflt_value),
            primaryKeyPosition: Number(column.pk),
            generated: column.hidden !== 0,
          })),
          triggers: schema
            .filter((object) => object.type === 'trigger' && object.tbl_name === name)
            .map((object) => ({ name: String(object.name), sql: String(object.sql) })),
          foreignKeys: foreignKeys.map((key) => ({
            id: Number(key.id),
            position: Number(key.seq),
            parentTable: String(key.table),
            column: String(key.from),
            parentColumn: key.to === null ? null : String(key.to),
            onUpdate: String(key.on_update),
            onDelete: String(key.on_delete),
          })),
        };
      });
    return {
      tables,
      objects: schema
        .filter((row) => row.type !== 'table')
        .map((row) => ({
          type: String(row.type),
          name: String(row.name),
          table: String(row.tbl_name),
          sql: String(row.sql),
        })),
    };
  } finally {
    db.close();
  }
}

/** Inventory physical SQLite schemas; explicitly report the backends not executed here. */
export function inventoryBackupSchemas(repositoryRoot: string): BackupSchemaInventory {
  const manifestPath = resolve(repositoryRoot, 'migrations/release-manifest.draft.json');
  const manifest = readReleaseMigrationManifest(manifestPath);
  const inspectedStreams: BackupSchemaInventory['inspectedStreams'] = [];
  const uninspectedStreams: BackupSchemaInventory['uninspectedStreams'] = [];
  for (const stream of MIGRATION_STREAM_CONTRACTS) {
    if (stream.dialect !== 'sqlite') {
      uninspectedStreams.push({
        id: stream.id,
        reason: 'requires_native_backend_schema_inspection',
      });
      continue;
    }
    const directory = resolve(repositoryRoot, 'migrations', stream.directory);
    const selected = manifest.streams.find((entry) => entry.id === stream.id);
    if (!selected || selected.files.length === 0)
      throw new Error(`backup_schema_migrations_missing:${stream.id}`);
    const files = selected.files.map((file) => file.path);
    const sources = selected.files.map((file) => {
      const path = resolve(directory, file.path);
      if (calculateReleaseMigrationChecksum(path, stream.dialect) !== file.checksum) {
        throw new Error(`backup_schema_checksum_mismatch:${stream.id}:${file.path}`);
      }
      return readFileSync(path, 'utf8');
    });
    inspectedStreams.push({
      id: stream.id,
      unselectedMigrationFiles: readdirSync(directory)
        .filter((file) => file.endsWith('.sql') && !files.includes(file))
        .sort(),
      migrations: sources.map((source, index) => ({
        file: `migrations/${stream.directory}/${files[index]}`,
        sha256: createHash('sha256').update(source).digest('hex'),
        executionSha256: selected.files[index].checksum,
      })),
      ...inspectBackupSchema(sources),
    });
  }
  return {
    formatVersion: 1,
    productVersion: manifest.productVersion,
    manifestSha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    inspectedStreams,
    uninspectedStreams,
  };
}

import {
  readMigrationSource,
  listMigrationSourceFiles,
} from '../../../../../../test/helpers/migration-source.mjs';
import { DatabaseSync } from 'node:sqlite';

import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { renderPortableMigrationSql } from '../../../migrations/sql-portability';
import { SQLITE_SNAPSHOT_SCHEMA } from '../sqlite-snapshot';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const streams = inventoryBackupSchemas(root)
  .inspectedStreams.filter((stream) =>
    stream.tables.some((table) => table.name === 'tenant_backup_snapshots')
  )
  .map((stream) => {
    const directory = 'migrations/' + stream.id.replace(/-(d1|postgresql)$/u, '/$1');
    return {
      ...stream,
      migrations: listMigrationSourceFiles(root + directory).map((file) => ({
        file: directory + '/' + file,
      })),
    };
  });
function source(file: string): string {
  const index = file.lastIndexOf('/');
  return readMigrationSource(root + file.slice(0, index), file.slice(index + 1));
}
function objects(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name"
    )
    .all();
}
it('installs snapshot storage in each D1 family that supplies captured data', () => {
  expect(streams.map((s) => s.id).sort()).toEqual([
    'admin-d1',
    'control-d1',
    'core-d1',
    'pii-d1',
    'plugin-runner-d1',
  ]);
});
it.each(streams)(
  '$id upgrades without replacing existing objects or application data',
  (stream) => {
    const db = new DatabaseSync(':memory:');
    const reference = new DatabaseSync(':memory:');
    try {
      const additions = stream.migrations.filter((m) =>
        /_tenant_backup_(snapshot_storage|preimage_row_partitions|preimage_native_order)\.sql$/.test(
          m.file
        )
      );
      for (const migration of stream.migrations.filter((m) => !additions.includes(m)))
        db.exec(renderPortableMigrationSql(source(migration.file), 'sqlite'));
      db.exec(
        "CREATE TABLE migration_fixture(id TEXT PRIMARY KEY NOT NULL,value TEXT DEFAULT 'seed'); INSERT INTO migration_fixture(id) VALUES ('preserved'); CREATE INDEX migration_fixture_value ON migration_fixture(value); CREATE TRIGGER migration_fixture_guard BEFORE DELETE ON migration_fixture BEGIN SELECT RAISE(ABORT,'fixture_keep'); END;"
      );
      const before = objects(db);
      db.exec('BEGIN');
      for (const migration of additions) db.exec(source(migration.file));
      db.exec('COMMIT');
      const after = objects(db);
      expect(after.filter((row) => before.some((old) => old.name === row.name))).toEqual(before);
      expect(db.prepare('SELECT * FROM migration_fixture').get()).toEqual({
        id: 'preserved',
        value: 'seed',
      });
      reference.exec(SQLITE_SNAPSHOT_SCHEMA);
      const added = after.filter((row) => !before.some((old) => old.name === row.name));
      expect(added).toEqual(objects(reference));
      // Runtime initialization is now an idempotent check over the migration-installed objects.
      db.exec(SQLITE_SNAPSHOT_SCHEMA);
      expect(objects(db)).toEqual(after);
      expect(() =>
        db.exec(
          "INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES (NULL,'a','capturing')"
        )
      ).toThrow();
      db.exec(
        "INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('s','a','capturing')"
      );
      for (const values of ["NULL,'users','key'", "'s',NULL,'key'", "'s','users',NULL"])
        expect(() =>
          db.exec(
            `INSERT INTO tenant_backup_preimages(snapshot_id,source_table,record_key,present) VALUES (${values},0)`
          )
        ).toThrow();
      db.exec(
        "INSERT INTO tenant_backup_preimages(snapshot_id,source_table,record_key,present) VALUES ('s','users','key',0); UPDATE tenant_backup_snapshots SET state='invalid' WHERE id='s'"
      );
      expect(() =>
        db.exec("UPDATE tenant_backup_snapshots SET state='capturing' WHERE id='s'")
      ).toThrow('state_regression');
      expect(() =>
        db.exec("UPDATE tenant_backup_snapshots SET tenant_id='b' WHERE id='s'")
      ).toThrow('identity_immutable');
    } finally {
      db.close();
      reference.close();
    }
  }
);

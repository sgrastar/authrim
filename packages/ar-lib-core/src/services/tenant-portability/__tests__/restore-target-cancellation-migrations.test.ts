import {
  readMigrationSource,
  listMigrationSourceFiles,
} from '../../../../../../test/helpers/migration-source.mjs';
import { DatabaseSync } from 'node:sqlite';

import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { renderPortableMigrationSql } from '../../../migrations/sql-portability';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const streams = inventoryBackupSchemas(root)
  .inspectedStreams.filter((stream) =>
    stream.tables.some((table) => table.name === 'tenant_backup_restore_targets')
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

it('installs sealed-target cancellation in every D1 restore family', () => {
  expect(streams.map((stream) => stream.id).sort()).toEqual([
    'admin-d1',
    'control-d1',
    'core-d1',
    'pii-d1',
    'plugin-runner-d1',
  ]);
});

it.each(streams)('$id keeps invalid terminal while allowing sealed cancellation', (stream) => {
  const database = new DatabaseSync(':memory:');
  try {
    for (const migration of stream.migrations)
      database.exec(renderPortableMigrationSql(source(migration.file), 'sqlite'));
    database
      .prepare(
        `INSERT INTO tenant_backup_restore_targets
        (id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint,owner,
          fencing_token,lease_expires_at,state) VALUES (?,?,?,?,?,?,?,?,?,'sealed')`
      )
      .run(
        'target',
        'tenant',
        'operation',
        'resource',
        'a'.repeat(64),
        'b'.repeat(64),
        'old',
        1,
        100
      );
    database.exec(
      "UPDATE tenant_backup_restore_targets SET owner='cleaner',fencing_token=2,lease_expires_at=200,state='invalid'"
    );
    expect(
      database.prepare('SELECT owner,fencing_token,state FROM tenant_backup_restore_targets').get()
    ).toEqual({ owner: 'cleaner', fencing_token: 2, state: 'invalid' });
    expect(() => database.exec("UPDATE tenant_backup_restore_targets SET state='sealed'")).toThrow(
      'backup_restore_target_regression'
    );
    expect(() => database.exec('UPDATE tenant_backup_restore_targets SET fencing_token=1')).toThrow(
      'backup_restore_target_regression'
    );
    expect(() => database.exec("UPDATE tenant_backup_restore_targets SET owner='other'")).toThrow(
      'backup_restore_target_regression'
    );
  } finally {
    database.close();
  }
});

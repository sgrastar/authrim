import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { renderPortableMigrationSql } from '../../../migrations/sql-portability';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const streams = inventoryBackupSchemas(root).inspectedStreams.filter((stream) =>
  stream.migrations.some((migration) =>
    migration.file.endsWith('_tenant_backup_restore_target_cancellation.sql')
  )
);

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
      database.exec(
        renderPortableMigrationSql(readFileSync(root + migration.file, 'utf8'), 'sqlite')
      );
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function migration(path: string): string {
  return renderPortableMigrationSql(
    readFileSync(resolve(REPO_ROOT, path), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '1')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '1000'),
    'sqlite'
  );
}

describe('Control migration stream taxonomy baseline', () => {
  it('accepts canonical IDs and preserves managed-target and immutable release guards', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(migration('migrations/control/d1/001_0_4_0_control_baseline.sql'));
    const digest = 'a'.repeat(64);
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, created_at, updated_at
      ) VALUES ('env-1', 'test', 'urn:authrim:control:env-1', 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, requested_by_type,
        release_id, release_stream_id, release_manifest_digest, created_at, updated_at
      ) VALUES (
        'op-1', 'env-1', 'bootstrap', 'bootstrap-1', 'setup',
        '0.4.0', 'core-d1', '${digest}', 1, 1
      );
      INSERT INTO control_migration_release_catalog (
        environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
        state, active_stream_key, registered_by_operation_id, registered_at, activated_at
      ) VALUES (
        'env-1', 'core-d1', '0.4.0', '${digest}',
        'releases/0.4.0/${digest}/manifest.json', 'active', 'active', 'op-1', 1, 1
      );
      INSERT INTO control_operation_release_pins (
        operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
      ) VALUES ('op-1', 'env-1', 'core-d1', '0.4.0', '${digest}', 1);
    `);

    expect(
      database
        .prepare(`SELECT release_stream_id FROM control_operations WHERE operation_id = 'op-1'`)
        .get()
    ).toEqual({ release_stream_id: 'core-d1' });
    expect(
      database
        .prepare(
          `SELECT stream_id FROM control_migration_release_catalog WHERE environment_id = 'env-1'`
        )
        .get()
    ).toEqual({ stream_id: 'core-d1' });
    expect(
      database
        .prepare(`SELECT stream_id FROM control_operation_release_pins WHERE operation_id = 'op-1'`)
        .get()
    ).toEqual({ stream_id: 'core-d1' });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const targetTableSql = database
      .prepare(
        `SELECT sql FROM sqlite_schema
          WHERE type = 'table' AND name = 'control_release_migration_targets'`
      )
      .get() as { sql: string };
    expect(targetTableSql.sql).toContain("stream_id IN ('core-d1', 'pii-d1', 'lookup-d1')");
    expect(targetTableSql.sql).not.toContain("stream_id IN ('d1-core'");
    expect(() =>
      database.exec(
        `UPDATE control_migration_release_catalog
            SET manifest_digest = '${'b'.repeat(64)}'
          WHERE environment_id = 'env-1' AND stream_id = 'core-d1'`
      )
    ).toThrow('control_release_catalog_immutable');
  });
});

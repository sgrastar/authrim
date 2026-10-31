import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import { renderPortableMigrationSql } from '../sql-portability';
import { TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL } from '../../services/control-plane/migration-history-contract';

const directory = new URL('../../../../../migrations/admin/d1/', import.meta.url);
const filename = '055_drop_tenant_database_migration_state.sql';
const source = readMigrationSource(directory, filename);

describe('Admin migration state removal', () => {
  it('checks the forward source before and after release consolidation', () => {
    expect(source).toContain('DROP INDEX IF EXISTS idx_tenant_database_migration_state_status;');
    expect(source).toContain('DROP TABLE IF EXISTS tenant_database_migration_state;');
    for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
      expect(renderPortableMigrationSql(source, dialect)).toBe(source);
    }
  });

  it('drops only the obsolete Admin table and index and permits the engine sentinel', () => {
    const database = new DatabaseSync(':memory:');
    try {
      // The published baseline stays immutable after the owner regenerates the 0.5.0 bridge.
      database.exec(
        renderPortableMigrationSql(
          readMigrationSource(directory, '001_0_4_0_admin_baseline.sql'),
          'sqlite'
        )
      );
      const schema = () =>
        database
          .prepare(
            "SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name"
          )
          .all();
      const before = schema();
      expect(before.some(({ name }) => name === 'tenant_database_migration_state')).toBe(true);
      expect(before.some(({ name }) => name === 'idx_tenant_database_migration_state_status')).toBe(
        true
      );
      database.exec(source);
      database.exec(source);
      expect(schema()).toEqual(
        before.filter(
          ({ name }) =>
            name !== 'tenant_database_migration_state' &&
            name !== 'idx_tenant_database_migration_state_status'
        )
      );
      database.exec(TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL);
      database.exec(`INSERT INTO tenant_database_migration_state
        VALUES ('admin-d1', '0.5.0', '${'a'.repeat(64)}', 0, 'ready', NULL, 1)`);
      expect(
        database.prepare('SELECT stream_id FROM tenant_database_migration_state').get()
      ).toEqual({ stream_id: 'admin-d1' });
    } finally {
      database.close();
    }
  });

  it('keeps the 0.5.0 fresh Admin baseline compatible with an engine-prepared database', () => {
    const baseline = readMigrationSource(directory, '001_0_5_0_admin_baseline.sql');
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL);
      database.exec(renderPortableMigrationSql(baseline, 'sqlite'));
      expect(
        database.prepare('SELECT stream_id FROM tenant_database_migration_state').all()
      ).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('includes the forward drop in the regenerated 0.5.0 Admin bridge', () => {
    const bridge = readMigrationSource(directory, '002_0_5_0_admin_delta.sql');
    expect(bridge.includes('DROP TABLE IF EXISTS tenant_database_migration_state;')).toBe(true);
  });

  it('is safe on an empty database', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(source);
      expect(database.prepare('SELECT name FROM sqlite_schema').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

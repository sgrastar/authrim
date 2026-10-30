import { describe, expect, it } from 'vitest';
import {
  AUTHRIM_MIGRATIONS_TABLE_SQL,
  freshBaselineOwnedMigrationTableNames,
  validateAuthrimMigrationHistoryRows,
} from '../migration-history-contract.js';
import { MIGRATION_STREAM_CONTRACTS } from '../migration-stream-contract.js';

describe('migration history contract', () => {
  it.each(MIGRATION_STREAM_CONTRACTS)(
    'excludes only the setup/engine-owned tables for $id fresh baseline',
    ({ schemaFamily }) => {
      expect(freshBaselineOwnedMigrationTableNames(schemaFamily)).toEqual(
        schemaFamily === 'admin'
          ? ['authrim_migrations']
          : ['authrim_migrations', 'tenant_database_migration_state']
      );
    }
  );

  it('normalizes legacy-compatible rows for setup migration backfill', () => {
    expect(
      validateAuthrimMigrationHistoryRows([{ filename: ' 001_core.sql ', checksum: null }])
    ).toEqual([expect.objectContaining({ filename: '001_core.sql', checksum: null })]);
  });

  it('requires exact checksums, timestamps, and unique filenames for Control execution', () => {
    expect(
      validateAuthrimMigrationHistoryRows(
        [{ filename: '001_core.sql', checksum: 'a'.repeat(64), applied_at: 1 }],
        { requireChecksum: true, requireAppliedAt: true, rejectDuplicates: true }
      )
    ).toHaveLength(1);
    expect(() =>
      validateAuthrimMigrationHistoryRows(
        [
          { filename: '001_core.sql', checksum: 'a'.repeat(64), applied_at: 1 },
          { filename: '001_core.sql', checksum: 'a'.repeat(64), applied_at: 1 },
        ],
        { requireChecksum: true, requireAppliedAt: true, rejectDuplicates: true }
      )
    ).toThrow('migration_history_duplicate_filename');
    expect(() =>
      validateAuthrimMigrationHistoryRows(
        [{ filename: '001_core.sql', checksum: 'A'.repeat(64), applied_at: 1 }],
        { requireChecksum: true, requireAppliedAt: true }
      )
    ).toThrow('migration_history_invalid_checksum');
  });

  it('keeps the shared table contract checksum-bearing and metadata-compatible', () => {
    expect(AUTHRIM_MIGRATIONS_TABLE_SQL).toContain('checksum TEXT NOT NULL');
    expect(AUTHRIM_MIGRATIONS_TABLE_SQL).toContain('tool_version TEXT');
  });
});

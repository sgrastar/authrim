import { describe, expect, it } from 'vitest';
import {
  AUTHRIM_MIGRATIONS_TABLE_SQL,
  validateAuthrimMigrationHistoryRows,
} from '../migration-history-contract.js';

describe('migration history contract', () => {
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

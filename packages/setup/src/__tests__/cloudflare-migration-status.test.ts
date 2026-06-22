import { describe, expect, it } from 'vitest';
import { type D1MigrationFileState, getBlockingChangedMigrationFiles } from '../core/cloudflare.js';

describe('getBlockingChangedMigrationFiles', () => {
  const migrations: D1MigrationFileState[] = [
    {
      filename: '001_core_foundation.sql',
      status: 'applied',
      checksum: 'current-001',
      appliedChecksum: 'current-001',
    },
    {
      filename: '002_core_protocol_and_consent.sql',
      status: 'changed',
      checksum: 'current-002',
      appliedChecksum: 'applied-002',
    },
    {
      filename: '017_consent_statement_version_end_time.sql',
      status: 'pending',
      checksum: 'current-017',
    },
  ];

  it('blocks full migration runs when applied files changed', () => {
    expect(getBlockingChangedMigrationFiles(migrations)).toEqual([
      '002_core_protocol_and_consent.sql',
    ]);
  });

  it('does not block a selected pending migration for unrelated changed files', () => {
    expect(
      getBlockingChangedMigrationFiles(
        migrations,
        new Set(['017_consent_statement_version_end_time.sql'])
      )
    ).toEqual([]);
  });

  it('blocks selected migrations when the selected file itself changed', () => {
    expect(
      getBlockingChangedMigrationFiles(migrations, new Set(['002_core_protocol_and_consent.sql']))
    ).toEqual(['002_core_protocol_and_consent.sql']);
  });
});

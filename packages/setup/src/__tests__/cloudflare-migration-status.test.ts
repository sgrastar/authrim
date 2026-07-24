import { describe, expect, it } from 'vitest';
import {
  type D1MigrationFileState,
  evaluateSupersededMigrationState,
  getBlockingChangedMigrationFiles,
} from '../core/cloudflare.js';

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
      filename: '015_core_consent_screens_scopes.sql',
      status: 'pending',
      checksum: 'current-015',
    },
  ];

  it('blocks full migration runs when applied files changed', () => {
    expect(getBlockingChangedMigrationFiles(migrations)).toEqual([
      '002_core_protocol_and_consent.sql',
    ]);
  });

  it('does not block a selected pending migration for unrelated changed files', () => {
    expect(
      getBlockingChangedMigrationFiles(migrations, new Set(['015_core_consent_screens_scopes.sql']))
    ).toEqual([]);
  });

  it('blocks selected migrations when the selected file itself changed', () => {
    expect(
      getBlockingChangedMigrationFiles(migrations, new Set(['002_core_protocol_and_consent.sql']))
    ).toEqual(['002_core_protocol_and_consent.sql']);
  });
});

describe('evaluateSupersededMigrationState', () => {
  const supersedes = [
    { path: '019_draft_a.sql', checksum: 'a'.repeat(64) },
    { path: '020_draft_b.sql', checksum: 'b'.repeat(64) },
  ];

  it('recognizes a fully applied unpublished migration set', () => {
    expect(
      evaluateSupersededMigrationState(supersedes, [
        {
          filename: '019_draft_a.sql',
          status: 'orphaned',
          appliedChecksum: 'a'.repeat(64),
        },
        {
          filename: '020_draft_b.sql',
          status: 'orphaned',
          appliedChecksum: 'b'.repeat(64),
        },
      ])
    ).toEqual({ state: 'fully_applied' });
  });

  it('fails closed for partial application or a checksum mismatch', () => {
    expect(
      evaluateSupersededMigrationState(supersedes, [
        {
          filename: '019_draft_a.sql',
          status: 'orphaned',
          appliedChecksum: 'a'.repeat(64),
        },
      ]).state
    ).toBe('partially_applied');
    expect(
      evaluateSupersededMigrationState(supersedes, [
        {
          filename: '019_draft_a.sql',
          status: 'orphaned',
          appliedChecksum: 'wrong',
        },
        {
          filename: '020_draft_b.sql',
          status: 'orphaned',
          appliedChecksum: 'b'.repeat(64),
        },
      ]).error
    ).toContain('checksum mismatch');
  });
});

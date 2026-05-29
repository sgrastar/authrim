import { describe, expect, it } from 'vitest';
import { validateTenantDatabaseMigrationTargets } from '../tenant-database-migration-validation';

describe('validateTenantDatabaseMigrationTargets', () => {
  it('passes when schema versions, row counts, and checksum samples match', () => {
    const result = validateTenantDatabaseMigrationTargets(
      [
        {
          role: 'tenant_core',
          sourceSchemaVersion: 42,
          targetSchemaVersion: 42,
          minimumSourceSchemaVersion: 40,
          minimumTargetSchemaVersion: 42,
          sourceRowCount: 100,
          targetRowCount: 100,
          checksumSamplesSource: [
            { table: 'identity_core', sampleKey: 'tenant-a:user-1', checksumSha256: 'abc' },
          ],
          checksumSamplesTarget: [
            { table: 'identity_core', sampleKey: 'tenant-a:user-1', checksumSha256: 'abc' },
          ],
        },
      ],
      new Date('2026-05-16T00:00:00.000Z')
    );

    expect(result).toMatchObject({
      passed: true,
      checkedAt: '2026-05-16T00:00:00.000Z',
      targetsChecked: 1,
      issueCount: 0,
      warningCount: 0,
      issues: [],
    });
  });

  it('fails closed on schema, row count, and checksum mismatches', () => {
    const result = validateTenantDatabaseMigrationTargets([
      {
        role: 'tenant_pii',
        shardGroup: 'eu',
        shardIndex: 1,
        sourceSchemaVersion: 38,
        targetSchemaVersion: 39,
        minimumSourceSchemaVersion: 40,
        minimumTargetSchemaVersion: 42,
        sourceRowCount: 10,
        targetRowCount: 9,
        checksumSamplesSource: [
          { table: 'identity_pii', sampleKey: 'tenant-a:user-1', checksumSha256: 'source' },
        ],
        checksumSamplesTarget: [
          { table: 'identity_pii', sampleKey: 'tenant-a:user-1', checksumSha256: 'target' },
        ],
      },
    ]);

    expect(result.passed).toBe(false);
    expect(result.issueCount).toBe(4);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'source_schema_too_old',
      'target_schema_too_old',
      'row_count_mismatch',
      'checksum_sample_mismatch',
    ]);
    expect(result.issues[0]).toMatchObject({
      role: 'tenant_pii',
      shardGroup: 'eu',
      shardIndex: 1,
      severity: 'error',
    });
  });

  it('requires row counts and symmetric checksum samples', () => {
    const result = validateTenantDatabaseMigrationTargets([
      {
        role: 'tenant_custom',
        sourceSchemaVersion: 10,
        targetSchemaVersion: 10,
        minimumSourceSchemaVersion: 10,
        minimumTargetSchemaVersion: 10,
        sourceRowCount: null,
        targetRowCount: 12,
        checksumSamplesSource: [
          { table: 'user_custom_fields', sampleKey: 'tenant-a:user-1:dept', checksumSha256: 'x' },
        ],
      },
    ]);

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'row_count_missing',
      'checksum_sample_missing',
    ]);
  });
});

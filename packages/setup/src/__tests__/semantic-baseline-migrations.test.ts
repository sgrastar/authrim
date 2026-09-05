import { describe, expect, it } from 'vitest';
import {
  assertSemanticBaselineAllowed,
  mergeSemanticBaselineProvenance,
  semanticBaselinePath,
  verifySemanticMigrationComposition,
} from '../../../../scripts/semantic-baseline-migrations.js';

describe('semantic baseline migration provenance', () => {
  it('expands prior baseline provenance before appending new migration sources', () => {
    expect(
      mergeSemanticBaselineProvenance({
        baselinePath: '001_0_4_0_core_baseline.sql',
        sourceFiles: [
          { path: '001_0_4_0_core_baseline.sql', checksum: 'current-baseline' },
          { path: '002_application_launchers.sql', checksum: 'application-launchers' },
        ],
        priorGeneratedFrom: [
          { path: '001_initial.sql', checksum: 'initial' },
          { path: '052_consent_records.sql', checksum: 'consent-records' },
        ],
      })
    ).toEqual([
      { path: '001_initial.sql', checksum: 'initial' },
      { path: '052_consent_records.sql', checksum: 'consent-records' },
      { path: '002_application_launchers.sql', checksum: 'application-launchers' },
    ]);
  });

  it('rejects conflicting checksums for the same historical source path', () => {
    expect(() =>
      mergeSemanticBaselineProvenance({
        baselinePath: '001_0_4_0_core_baseline.sql',
        sourceFiles: [
          { path: '001_0_4_0_core_baseline.sql', checksum: 'current-baseline' },
          { path: '002_application_launchers.sql', checksum: 'new-checksum' },
        ],
        priorGeneratedFrom: [{ path: '002_application_launchers.sql', checksum: 'old-checksum' }],
      })
    ).toThrow('Conflicting semantic baseline provenance checksum');
  });

  it('preserves prior provenance when the versioned baseline filename changes', () => {
    expect(
      mergeSemanticBaselineProvenance({
        baselinePath: '001_0_4_0_core_baseline.sql',
        priorBaselinePath: '001_pre_1_0_core_baseline.sql',
        sourceFiles: [
          { path: '001_pre_1_0_core_baseline.sql', checksum: 'current-baseline' },
          { path: '002_unique_saml_provider_entity_id.sql', checksum: 'unique-provider' },
        ],
        priorGeneratedFrom: [
          { path: '001_initial.sql', checksum: 'initial' },
          { path: '052_consent_records.sql', checksum: 'consent-records' },
        ],
      })
    ).toEqual([
      { path: '001_initial.sql', checksum: 'initial' },
      { path: '052_consent_records.sql', checksum: 'consent-records' },
      { path: '002_unique_saml_provider_entity_id.sql', checksum: 'unique-provider' },
    ]);
  });
});

describe('semantic baseline filename', () => {
  it('uses the current product version for every stream', () => {
    expect(semanticBaselinePath('0.4.0', 'd1-core')).toBe('001_0_4_0_core_baseline.sql');
    expect(semanticBaselinePath('0.4.0', 'external-postgres-pii')).toBe(
      '002_0_4_0_external_postgres_pii_baseline.sql'
    );
  });

  it('normalizes prerelease product versions into filesystem-safe names', () => {
    expect(semanticBaselinePath('0.5.0-rc.1', 'd1-control')).toBe(
      '001_0_5_0_rc_1_control_baseline.sql'
    );
  });
});

describe('semantic baseline release immutability', () => {
  it('rejects fresh baseline generation for patch releases', () => {
    expect(() =>
      assertSemanticBaselineAllowed({ version: '1.1.1', write: false, published: false })
    ).toThrow('Fresh-install baselines may be generated only at a major or minor boundary');
    expect(() =>
      assertSemanticBaselineAllowed({ version: '1.2.0-rc.1', write: false, published: false })
    ).toThrow('Fresh-install baselines may be generated only at a major or minor boundary');
  });

  it('rejects rewriting an already published pre-1.0 product version', () => {
    expect(() =>
      assertSemanticBaselineAllowed({
        version: '0.4.0',
        write: true,
        published: true,
      })
    ).toThrow('Product version 0.4.0 is already published');
  });

  it('allows verification and a later pre-1.0 version rewrite', () => {
    expect(() =>
      assertSemanticBaselineAllowed({
        version: '0.4.0',
        write: false,
        published: true,
      })
    ).not.toThrow();
    expect(() =>
      assertSemanticBaselineAllowed({
        version: '0.5.0',
        write: true,
        published: false,
      })
    ).not.toThrow();
  });
});

describe('semantic release delta composition', () => {
  it('accepts a consolidated SQLite delta only when it has the same final state', () => {
    expect(
      verifySemanticMigrationComposition({
        streamId: 'd1-core',
        dialect: 'sqlite',
        baseSql: ['CREATE TABLE sample (id TEXT PRIMARY KEY);'],
        sourceSql: [
          'ALTER TABLE sample ADD COLUMN label TEXT;',
          "CREATE INDEX sample_label_idx ON sample(label); INSERT INTO sample (id, label) VALUES ('a', 'A');",
        ],
        consolidatedSql:
          "ALTER TABLE sample ADD COLUMN label TEXT; CREATE INDEX sample_label_idx ON sample(label); INSERT INTO sample (id, label) VALUES ('a', 'A');",
      }).objectCount
    ).toBe(2);
  });

  it('rejects a consolidated SQLite delta that loses schema or seed semantics', () => {
    expect(() =>
      verifySemanticMigrationComposition({
        streamId: 'd1-core',
        dialect: 'sqlite',
        baseSql: ['CREATE TABLE sample (id TEXT PRIMARY KEY);'],
        sourceSql: [
          'ALTER TABLE sample ADD COLUMN label TEXT;',
          "INSERT INTO sample (id, label) VALUES ('a', 'A');",
        ],
        consolidatedSql: 'ALTER TABLE sample ADD COLUMN label TEXT;',
      })
    ).toThrow('SQLite semantic release delta verification failed');
  });
});

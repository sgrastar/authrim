import { describe, expect, it } from 'vitest';
import {
  assertSemanticBaselineAllowed,
  mergeSemanticBaselineProvenance,
  replaceLookupBucketCounterSeedStatements,
  semanticBaselinePath,
  verifySemanticMigrationComposition,
} from '../../../../scripts/semantic-baseline-migrations.js';
import {
  LOOKUP_VIRTUAL_BUCKET_COUNT,
  type LookupBucketCounterSeedRow,
} from '@authrim/ar-lib-core/services/lookup-directory/contract';
import { renderLookupBucketCounterSeed } from '@authrim/ar-lib-core/services/lookup-directory/seed-sql';
import { PORTABLE_SQL_NOW_EPOCH_SECONDS } from '../core/sql-portability.js';

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
    expect(semanticBaselinePath('0.4.0', 'core-d1')).toBe('001_0_4_0_core_baseline.sql');
    expect(semanticBaselinePath('0.4.0', 'pii-postgresql')).toBe('001_0_4_0_pii_baseline.sql');
  });

  it('normalizes prerelease product versions into filesystem-safe names', () => {
    expect(semanticBaselinePath('0.5.0-rc.1', 'control-d1')).toBe(
      '001_0_5_0_rc_1_control_baseline.sql'
    );
  });
});

describe('semantic Lookup bucket seed generation', () => {
  const deterministicNow = 1_700_000_000;
  const table = `CREATE TABLE lookup_bucket_counters (
    virtual_bucket INTEGER PRIMARY KEY,
    estimated_active_identifier_count INTEGER NOT NULL,
    estimated_active_alias_count INTEGER NOT NULL,
    exact_count_checked_at INTEGER,
    reconciliation_cursor TEXT,
    reconciliation_error_code TEXT,
    updated_at INTEGER NOT NULL,
    successful_route_publication_count INTEGER NOT NULL,
    publication_counter_updated_at INTEGER NOT NULL
  );`;
  const canonicalRows = (bucketCount = LOOKUP_VIRTUAL_BUCKET_COUNT) =>
    Array.from(
      { length: bucketCount },
      (_, virtualBucket): LookupBucketCounterSeedRow => ({
        virtual_bucket: virtualBucket,
        estimated_active_identifier_count: 0,
        estimated_active_alias_count: 0,
        exact_count_checked_at: deterministicNow,
        reconciliation_cursor: 'bootstrap',
        reconciliation_error_code: null,
        updated_at: deterministicNow,
        successful_route_publication_count: 0,
        publication_counter_updated_at: deterministicNow,
      })
    );
  const sqliteRows = (bucketCount = LOOKUP_VIRTUAL_BUCKET_COUNT) =>
    Array.from(
      { length: bucketCount },
      (_, bucket) =>
        `INSERT INTO lookup_bucket_counters VALUES(${bucket},0,0,${PORTABLE_SQL_NOW_EPOCH_SECONDS},'bootstrap',NULL,${PORTABLE_SQL_NOW_EPOCH_SECONDS},0,${PORTABLE_SQL_NOW_EPOCH_SECONDS});`
    ).join('\n');

  it('replaces all canonical SQLite rows with one semantically equivalent statement', () => {
    const rows = sqliteRows();
    const compacted = replaceLookupBucketCounterSeedStatements({
      dump: rows,
      dialect: 'sqlite',
      rows: canonicalRows(),
      nowValue: deterministicNow,
      nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
    });
    expect(
      replaceLookupBucketCounterSeedStatements({
        dump: rows,
        dialect: 'sqlite',
        rows: canonicalRows(),
        nowValue: deterministicNow,
        nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
      })
    ).toBe(compacted);
    expect(compacted).toContain('WITH RECURSIVE lookup_bucket_seed');
    expect(compacted).not.toContain('VALUES(4095');
    expect(
      verifySemanticMigrationComposition({
        streamId: 'lookup-sqlite',
        dialect: 'sqlite',
        baseSql: [table],
        sourceSql: [rows],
        consolidatedSql: compacted,
      }).seedChecksum
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects 4,095 rows, duplicate or out-of-range buckets, and noncanonical values', () => {
    expect(() =>
      replaceLookupBucketCounterSeedStatements({
        dump: sqliteRows(LOOKUP_VIRTUAL_BUCKET_COUNT - 1),
        dialect: 'sqlite',
        rows: canonicalRows(LOOKUP_VIRTUAL_BUCKET_COUNT - 1),
        nowValue: deterministicNow,
        nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
      })
    ).toThrow(
      `lookup_bucket_seed_row_count_invalid:expected=${LOOKUP_VIRTUAL_BUCKET_COUNT}:actual=${LOOKUP_VIRTUAL_BUCKET_COUNT - 1}`
    );

    const duplicate = canonicalRows();
    duplicate[LOOKUP_VIRTUAL_BUCKET_COUNT - 1] = {
      ...duplicate[LOOKUP_VIRTUAL_BUCKET_COUNT - 1]!,
      virtual_bucket: LOOKUP_VIRTUAL_BUCKET_COUNT - 2,
    };
    expect(() =>
      replaceLookupBucketCounterSeedStatements({
        dump: sqliteRows(),
        dialect: 'sqlite',
        rows: duplicate,
        nowValue: deterministicNow,
        nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
      })
    ).toThrow('lookup_bucket_seed_virtual_bucket_duplicate');

    const outOfRange = canonicalRows();
    outOfRange[LOOKUP_VIRTUAL_BUCKET_COUNT - 1] = {
      ...outOfRange[LOOKUP_VIRTUAL_BUCKET_COUNT - 1]!,
      virtual_bucket: LOOKUP_VIRTUAL_BUCKET_COUNT,
    };
    expect(() =>
      replaceLookupBucketCounterSeedStatements({
        dump: sqliteRows(),
        dialect: 'sqlite',
        rows: outOfRange,
        nowValue: deterministicNow,
        nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
      })
    ).toThrow('lookup_bucket_seed_virtual_bucket_out_of_range');

    const noncanonical = canonicalRows();
    noncanonical[0] = { ...noncanonical[0]!, estimated_active_identifier_count: 1 };
    expect(() =>
      replaceLookupBucketCounterSeedStatements({
        dump: sqliteRows(),
        dialect: 'sqlite',
        rows: noncanonical,
        nowValue: deterministicNow,
        nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
      })
    ).toThrow('lookup_bucket_seed_initial_value_invalid:0');
  });

  it('fails closed when the verified database and dump statement inventory disagree', () => {
    expect(() =>
      replaceLookupBucketCounterSeedStatements({
        dump: sqliteRows(LOOKUP_VIRTUAL_BUCKET_COUNT - 1),
        dialect: 'sqlite',
        rows: canonicalRows(),
        nowValue: deterministicNow,
        nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
      })
    ).toThrow(
      `lookup_bucket_seed_statement_count_invalid:expected=${LOOKUP_VIRTUAL_BUCKET_COUNT}:actual=${LOOKUP_VIRTUAL_BUCKET_COUNT - 1}`
    );
  });

  it('renders PostgreSQL seed SQL with the same final row set', () => {
    const bucketCount = LOOKUP_VIRTUAL_BUCKET_COUNT;
    const postgresTable = table.replace(
      'CREATE TABLE lookup_bucket_counters',
      'CREATE TABLE public.lookup_bucket_counters'
    );
    const sourceSql = canonicalRows(bucketCount)
      .map(
        (row) =>
          `INSERT INTO public.lookup_bucket_counters VALUES (${row.virtual_bucket},0,0,${PORTABLE_SQL_NOW_EPOCH_SECONDS},'bootstrap',NULL,${PORTABLE_SQL_NOW_EPOCH_SECONDS},0,${PORTABLE_SQL_NOW_EPOCH_SECONDS});`
      )
      .join('\n');
    const rendered = renderLookupBucketCounterSeed({
      dialect: 'postgres',
      bucketCount,
      nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
    });
    const generated = replaceLookupBucketCounterSeedStatements({
      dump: sourceSql,
      dialect: 'postgres',
      rows: canonicalRows(bucketCount),
      nowValue: deterministicNow,
      nowExpression: PORTABLE_SQL_NOW_EPOCH_SECONDS,
      bucketCount,
    });

    expect(generated).toBe(rendered);
    expect(
      verifySemanticMigrationComposition({
        streamId: 'lookup-postgres-contract',
        dialect: 'postgres',
        baseSql: [postgresTable],
        sourceSql: [sourceSql],
        consolidatedSql: generated,
      }).seedChecksum
    ).toMatch(/^[a-f0-9]{64}$/u);
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
        streamId: 'core-d1',
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
        streamId: 'core-d1',
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertSemanticBaselineAllowed,
  generateSqliteBaseline,
  mergeSemanticBaselineProvenance,
  PostgresBaselineContainer,
  renderDeterministicMigrationSql,
  replaceLookupBucketCounterSeedStatements,
  restorePortableSeedExpressions,
  semanticBaselinePath,
  verifySemanticMigrationComposition,
} from '../../../../scripts/semantic-baseline-migrations.js';
import {
  LOOKUP_VIRTUAL_BUCKET_COUNT,
  type LookupBucketCounterSeedRow,
} from '@authrim/ar-lib-core/services/lookup-directory/contract';
import { renderLookupBucketCounterSeed } from '@authrim/ar-lib-core/services/lookup-directory/seed-sql';
import {
  PORTABLE_SQL_NOW_EPOCH_MILLISECONDS,
  PORTABLE_SQL_NOW_EPOCH_SECONDS,
  renderPortableMigrationSql,
} from '../core/sql-portability.js';
import { renderPortableMigrationSql as renderSharedPortableMigrationSql } from '../../../ar-lib-core/src/migrations/sql-portability.js';
import {
  AUTHRIM_MIGRATIONS_TABLE_SQL,
  TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL,
} from '../../../ar-lib-core/src/services/control-plane/migration-history-contract.js';
import {
  migrationStreamContract,
  type MigrationStreamId,
} from '../../../ar-lib-core/src/services/control-plane/migration-stream-contract.js';
import {
  calculateReleaseMigrationChecksum,
  type ReleaseMigrationManifest,
  type ReleaseMigrationStream,
} from '../core/release-migrations.js';
import { buildLocalMigrationScript } from '../core/local/data.js';

describe('precise SQLite baseline portability', () => {
  const preciseToken = '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__';
  const preciseExpression = renderPortableMigrationSql(preciseToken, 'sqlite');
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  function baseline(source: string) {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-precise-baseline-test-'));
    directories.push(directory);
    const path = '001_source.sql';
    writeFileSync(join(directory, path), source);
    const contract = migrationStreamContract('core-d1');
    return generateSqliteBaseline({
      tempDir: directory,
      streamRoot: directory,
      productVersion: '0.5.0',
      stream: {
        ...contract,
        logicalRoles: [...contract.logicalRoles],
        files: [
          { path, checksum: calculateReleaseMigrationChecksum(join(directory, path), 'sqlite') },
        ],
      },
    });
  }

  it('restores every canonical precise SQLite expression to the portable token', () => {
    expect(
      restorePortableSeedExpressions(`SELECT ${preciseExpression}, ${preciseExpression};`, 'sqlite')
    ).toBe(`SELECT ${preciseToken}, ${preciseToken};`);
  });

  it('verifies a portable precise trigger baseline and evaluates both clocks dynamically at runtime', () => {
    const trigger = `CREATE TRIGGER precise_event AFTER INSERT ON sample
BEGIN
  INSERT INTO events VALUES (NEW.id, ${preciseToken}, ${PORTABLE_SQL_NOW_EPOCH_SECONDS}, ${PORTABLE_SQL_NOW_EPOCH_MILLISECONDS});
END;`;
    const generated = baseline(`CREATE TABLE sample (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL, precise_ms INTEGER, legacy_s INTEGER, legacy_ms INTEGER);
${trigger}`);
    expect(generated.sql).not.toContain("strftime('%s', 'now')");
    expect(generated.sql).toContain(preciseToken);
    expect(generated.sql).toContain('unixepoch()');
    expect(generated.sql).not.toContain(PORTABLE_SQL_NOW_EPOCH_SECONDS);
    expect(generated.sql).not.toContain(PORTABLE_SQL_NOW_EPOCH_MILLISECONDS);
    expect(generated.objectCount).toBe(3);
    const database = new DatabaseSync(':memory:');
    try {
      let seconds = 1800000000;
      let fraction = '123';
      database.function('unixepoch', () => seconds);
      database.function('strftime', { varargs: true }, (format) => {
        if (format === '%s') return String(seconds);
        if (format === '%f') return `00.${fraction}`;
        throw new Error('unexpected clock format');
      });
      database.exec(renderPortableMigrationSql(generated.sql, 'sqlite'));
      expect(
        database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'precise_event'").get()
      ).toEqual({ sql: renderPortableMigrationSql(trigger, 'sqlite').slice(0, -1) });
      database.exec("INSERT INTO sample VALUES ('one');");
      seconds += 1;
      fraction = '789';
      database.exec("INSERT INTO sample VALUES ('two');");
      expect(database.prepare('SELECT * FROM events ORDER BY id').all()).toEqual([
        { id: 'one', precise_ms: 1800000000123, legacy_s: 1800000000, legacy_ms: 1800000000000 },
        { id: 'two', precise_ms: 1800000001789, legacy_s: 1800000001, legacy_ms: 1800000001000 },
      ]);
    } finally {
      database.close();
    }
  });

  it('preserves escaped precise SQL stored as literal data without introducing unsafe tokens', () => {
    const savedSql = `SELECT ${preciseExpression}, 'it''s SQL text';`;
    const source = `CREATE TABLE saved_sql (sql TEXT NOT NULL);
INSERT INTO saved_sql VALUES ('${savedSql.replaceAll("'", "''")}');`;
    const generated = baseline(source);
    // The renderer expands tokens globally; putting one into this literal would break its quotes.
    expect(generated.sql).not.toContain(preciseToken);
    expect(generated.sql).toContain(preciseExpression.replaceAll("'", "''"));
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(renderPortableMigrationSql(generated.sql, 'sqlite'));
      expect(database.prepare('SELECT sql FROM saved_sql').all()).toEqual([{ sql: savedSql }]);
    } finally {
      database.close();
    }
  });

  it.each(['sqlite', 'postgres', 'mysql'] as const)(
    'keeps setup and shared clock rendering identical for %s',
    (dialect) => {
      const sql = `SELECT ${preciseToken}, ${PORTABLE_SQL_NOW_EPOCH_SECONDS}, ${PORTABLE_SQL_NOW_EPOCH_MILLISECONDS};`;
      expect(renderPortableMigrationSql(sql, dialect)).toBe(
        renderSharedPortableMigrationSql(sql, dialect)
      );
    }
  );
});

describe('fresh baseline setup ledger isolation', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  function fixture(
    extraSql = '',
    streamId: Extract<MigrationStreamId, `${string}-d1`> = 'core-d1'
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'authrim-baseline-ledger-test-'));
    directories.push(directory);
    const source = `CREATE TABLE application_record (id TEXT PRIMARY KEY NOT NULL, label TEXT);
INSERT INTO application_record VALUES ('kept', 'application seed');
${AUTHRIM_MIGRATIONS_TABLE_SQL.replace('PRIMARY KEY NOT NULL', 'PRIMARY KEY')};
INSERT INTO authrim_migrations (filename, checksum, applied_at) VALUES ('legacy.sql', 'legacy-checksum', 1);
ALTER TABLE authrim_migrations RENAME TO previous_history;
${AUTHRIM_MIGRATIONS_TABLE_SQL};
INSERT INTO authrim_migrations SELECT * FROM previous_history;
DROP TABLE previous_history;
CREATE INDEX setup_history_applied_at_idx ON authrim_migrations(applied_at);
${extraSql}`;
    const sourcePath = '001_source.sql';
    writeFileSync(join(directory, sourcePath), source);
    const contract = migrationStreamContract(streamId);
    const stream: ReleaseMigrationStream = {
      ...contract,
      logicalRoles: [...contract.logicalRoles],
      files: [
        {
          path: sourcePath,
          checksum: calculateReleaseMigrationChecksum(join(directory, sourcePath), 'sqlite'),
        },
      ],
    };
    const baseline = generateSqliteBaseline({
      tempDir: directory,
      streamRoot: directory,
      stream,
      productVersion: '0.5.0',
    });
    return { directory, source, sourcePath, stream, baseline };
  }

  const sentinelSource = `${TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL.replace('PRIMARY KEY NOT NULL', 'PRIMARY KEY')};
INSERT INTO tenant_database_migration_state VALUES ('core-d1', 'old-engine-release', '${'a'.repeat(64)}', 1, 'ready', 'legacy.sql', 1);
ALTER TABLE tenant_database_migration_state RENAME TO previous_sentinel;
${TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL};
INSERT INTO tenant_database_migration_state SELECT * FROM previous_sentinel;
DROP TABLE previous_sentinel;
CREATE INDEX engine_sentinel_release_idx ON tenant_database_migration_state(release_id);`;

  it.each(['core-d1', 'pii-d1', 'admin-d1', 'control-d1', 'plugin-runner-d1'] as const)(
    'omits the rebuilt engine sentinel, seed and index from %s fresh baseline',
    (streamId) => {
      const { directory, source, sourcePath, baseline } = fixture(sentinelSource, streamId);
      expect(baseline.sql).not.toContain('CREATE TABLE tenant_database_migration_state');
      expect(baseline.sql).not.toContain('INSERT INTO tenant_database_migration_state');
      expect(baseline.sql).not.toContain('old-engine-release');
      expect(baseline.sql).not.toContain('engine_sentinel_release_idx');
      expect(baseline.objectCount).toBe(1);
      expect(readFileSync(join(directory, sourcePath), 'utf8')).toBe(source);
    }
  );

  it('applies a fresh baseline after the engine prepares both tables and preserves Control rollout data', () => {
    const { baseline } = fixture(
      `${sentinelSource}
CREATE TABLE control_tenant_database_migration_state (resource_id TEXT PRIMARY KEY NOT NULL);
INSERT INTO control_tenant_database_migration_state VALUES ('resource-one');`,
      'control-d1'
    );
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`${TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL};
${AUTHRIM_MIGRATIONS_TABLE_SQL};
${renderDeterministicMigrationSql(baseline.sql, 'sqlite')}`);
      expect(database.prepare('SELECT * FROM tenant_database_migration_state').all()).toEqual([]);
      expect(database.prepare('SELECT * FROM authrim_migrations').all()).toEqual([]);
      expect(database.prepare('SELECT * FROM application_record').all()).toEqual([
        { id: 'kept', label: 'application seed' },
      ]);
      expect(
        database.prepare('SELECT * FROM control_tenant_database_migration_state').all()
      ).toEqual([{ resource_id: 'resource-one' }]);
    } finally {
      database.close();
    }
  });

  it('omits the rebuilt setup ledger, its seed and index while verifying the application baseline', () => {
    const { directory, source, sourcePath, baseline } = fixture();
    expect(baseline.sql).not.toContain('authrim_migrations');
    expect(baseline.sql).not.toContain('legacy-checksum');
    expect(baseline.sql).not.toContain('setup_history_applied_at_idx');
    expect(baseline.objectCount).toBe(1);
    expect(baseline.schemaChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(baseline.seedChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(join(directory, sourcePath), 'utf8')).toBe(source);
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(renderDeterministicMigrationSql(baseline.sql, 'sqlite'));
      expect(database.prepare('SELECT * FROM application_record').all()).toEqual([
        { id: 'kept', label: 'application seed' },
      ]);
    } finally {
      database.close();
    }
  });

  it('applies the real local fresh-install script after setup creates its ledger first', async () => {
    const { directory, stream, baseline } = fixture();
    const streamRoot = join(directory, 'core/d1');
    mkdirSync(streamRoot, { recursive: true });
    const baselinePath = join(streamRoot, baseline.path);
    writeFileSync(baselinePath, baseline.sql);
    const file = {
      path: baseline.path,
      checksum: calculateReleaseMigrationChecksum(baselinePath, 'sqlite'),
    };
    const manifest: ReleaseMigrationManifest = {
      formatVersion: 2,
      productVersion: '0.5.0',
      streams: [{ ...stream, files: [file] }],
    };
    const script = await buildLocalMigrationScript({
      migrationsRoot: directory,
      manifest,
      streamId: 'core-d1',
      now: 1700000000,
    });
    expect(script.indexOf(AUTHRIM_MIGRATIONS_TABLE_SQL)).toBeLessThan(
      script.indexOf('CREATE TABLE application_record')
    );
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(script);
      expect(database.prepare('SELECT filename, checksum FROM authrim_migrations').all()).toEqual([
        { filename: file.path, checksum: file.checksum },
      ]);
      expect(database.prepare('SELECT id FROM application_record').all()).toEqual([{ id: 'kept' }]);
    } finally {
      database.close();
    }
  });

  it('applies an Admin fresh baseline after the engine creates its sentinel', () => {
    const { baseline } = fixture(sentinelSource, 'admin-d1');
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`${TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL};
${AUTHRIM_MIGRATIONS_TABLE_SQL};
${renderDeterministicMigrationSql(baseline.sql, 'sqlite')}`);
      expect(database.prepare('SELECT * FROM tenant_database_migration_state').all()).toEqual([]);
      expect(database.prepare('SELECT * FROM authrim_migrations').all()).toEqual([]);
      expect(database.prepare('SELECT * FROM application_record').all()).toEqual([
        { id: 'kept', label: 'application seed' },
      ]);
    } finally {
      database.close();
    }
  });

  it('still compares setup ledger contents when verifying a release bridge delta', () => {
    const source = `INSERT INTO authrim_migrations (filename, checksum, applied_at) VALUES ('old.sql', 'expected', 1);`;
    expect(
      verifySemanticMigrationComposition({
        streamId: 'setup-ledger-bridge',
        dialect: 'sqlite',
        baseSql: [`${AUTHRIM_MIGRATIONS_TABLE_SQL};`],
        sourceSql: [source],
        consolidatedSql: source,
      }).objectCount
    ).toBe(1);
    expect(() =>
      verifySemanticMigrationComposition({
        streamId: 'setup-ledger-bridge',
        dialect: 'sqlite',
        baseSql: [`${AUTHRIM_MIGRATIONS_TABLE_SQL};`],
        sourceSql: [source],
        consolidatedSql: source.replace('expected', 'changed'),
      })
    ).toThrow('SQLite semantic release delta verification failed');
  });

  it('still detects sentinel row changes when verifying a release bridge delta', () => {
    const source = `INSERT INTO tenant_database_migration_state VALUES ('core-d1', 'expected', '${'a'.repeat(64)}', 1, 'ready', 'old.sql', 1);`;
    const input = {
      streamId: 'sentinel-bridge',
      dialect: 'sqlite' as const,
      baseSql: [`${TENANT_DATABASE_MIGRATION_STATE_TABLE_SQL};`],
      sourceSql: [source],
    };
    expect(
      verifySemanticMigrationComposition({ ...input, consolidatedSql: source }).objectCount
    ).toBe(1);
    expect(() =>
      verifySemanticMigrationComposition({
        ...input,
        consolidatedSql: source.replace('expected', 'changed'),
      })
    ).toThrow('SQLite semantic release delta verification failed');
  });
});

describe('deterministic SQLite migration literals', () => {
  const hex16 = '00000000000000000000000000000000';
  const hex18 = '000000000000000000000000000000000000';
  const trigger = `CREATE TRIGGER sample_audit AFTER INSERT ON sample
BEGIN
  INSERT INTO events VALUES ('evt_' || lower(hex(randomblob(16))), lower(hex(randomblob(18))), unixepoch(), (unixepoch() * 1000), 'it''s ready');
END`;
  const tables = `CREATE TABLE sample (id TEXT PRIMARY KEY);
CREATE TABLE events (id TEXT PRIMARY KEY, nonce TEXT, occurred_at INTEGER, occurred_at_ms INTEGER, label TEXT);`;
  const guardedMigration = (expectedTrigger = trigger) => `${trigger};
CREATE TABLE schema_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO schema_guard SELECT EXISTS (
  SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'sample_audit'
    AND sql = '${expectedTrigger.replaceAll("'", "''")}'
);
DROP TABLE schema_guard;
INSERT INTO sample VALUES ('one');`;
  const sqlite = (sql: string) =>
    execFileSync('sqlite3', ['-bail', ':memory:'], { input: sql, encoding: 'utf8' });

  it('escapes blob quotes only inside literals, including doubled apostrophes', () => {
    expect(
      renderDeterministicMigrationSql(
        "SELECT randomblob(16), randomblob(18), unixepoch(), (unixepoch() * 1000), 'it''s randomblob(16), randomblob(18), unixepoch(), (unixepoch() * 1000)', randomblob(16);",
        'sqlite'
      )
    ).toBe(
      `SELECT X'${hex16}', X'${hex18}', 1700000000, 1700000000000, 'it''s X''${hex16}'', X''${hex18}'', 1700000000, 1700000000000', X'${hex16}';`
    );
  });

  it('keeps literal boundaries after comments and quoted identifiers containing apostrophes', () => {
    const prefix = `-- Don't treat this comment as a literal.
/* Nor this comment's apostrophe. */
SELECT "owner's", \`owner's\`, [owner's], `;
    expect(
      renderDeterministicMigrationSql(`${prefix}'randomblob(16)', randomblob(18);`, 'sqlite')
    ).toBe(`${prefix}'X''${hex16}''', X'${hex18}';`);
  });

  it('runs a trigger-schema comparison guard against real SQLite', () => {
    // Prove the original migration is valid before checking the deterministic renderer.
    expect(
      sqlite(`${tables}\n${guardedMigration()}
SELECT count(*) FROM events WHERE length(id) = 36 AND length(nonce) = 36
  AND occurred_at > 0 AND occurred_at_ms = occurred_at * 1000 AND label = 'it''s ready';`)
    ).toBe('1\n');
    expect(
      verifySemanticMigrationComposition({
        streamId: 'sqlite-trigger-schema-guard',
        dialect: 'sqlite',
        baseSql: [tables],
        sourceSql: [guardedMigration()],
        consolidatedSql: guardedMigration(),
      }).objectCount
    ).toBe(3);
  });

  it('still rejects a mismatched trigger definition instead of bypassing its guard', () => {
    expect(() =>
      verifySemanticMigrationComposition({
        streamId: 'sqlite-trigger-schema-mismatch',
        dialect: 'sqlite',
        baseSql: [tables],
        sourceSql: [guardedMigration(`${trigger} -- different definition`)],
        consolidatedSql: guardedMigration(),
      })
    ).toThrow('CHECK constraint failed');
  });

  it('restores both executable and literal-escaped deterministic blob expressions', () => {
    expect(
      restorePortableSeedExpressions(
        `SELECT X'${hex16}', X'${hex18}', 'X''${hex16}'', X''${hex18}'', 1700000000';`,
        'sqlite'
      )
    ).toBe(
      `SELECT randomblob(16), randomblob(18), 'randomblob(16), randomblob(18), ${PORTABLE_SQL_NOW_EPOCH_SECONDS}';`
    );
  });

  it('round-trips a real SQLite dump that retains SQL text with escaped blob expressions', () => {
    const source = `CREATE TABLE saved_sql (sql TEXT NOT NULL);
INSERT INTO saved_sql VALUES ('SELECT randomblob(16), randomblob(18), unixepoch(), (unixepoch() * 1000), ''it''''s ready'';');`;
    const dump = sqlite(`${renderDeterministicMigrationSql(source, 'sqlite')}\n.dump\n`);
    expect(dump).toContain(`X''${hex16}''`);
    expect(dump).toContain(`X''${hex18}''`);
    const portable = restorePortableSeedExpressions(dump, 'sqlite');
    expect(portable).not.toContain(hex16);
    expect(portable).toContain('randomblob(16)');
    expect(portable).toContain('randomblob(18)');
    expect(sqlite(`${renderDeterministicMigrationSql(portable, 'sqlite')}\n.dump\n`)).toBe(dump);
  });
});

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
        // Preserve the legacy row-by-row shape while avoiding one durable
        // autocommit per row on slower CI filesystems.
        sourceSql: [`BEGIN TRANSACTION;\n${rows}\nCOMMIT;`],
        consolidatedSql: compacted,
      }).seedChecksum
    ).toMatch(/^[a-f0-9]{64}$/u);
  }, 60_000);

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
        // Keep the legacy statements intact but execute them as one atomic
        // seed operation so PostgreSQL fsync latency cannot dominate the test.
        sourceSql: [`BEGIN;\n${sourceSql}\nCOMMIT;`],
        consolidatedSql: generated,
      }).seedChecksum
    ).toMatch(/^[a-f0-9]{64}$/u);
  }, 60_000);
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

describe('PostgreSQL semantic container lifecycle without Docker', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts with tmpfs for PostgreSQL 17 and removes anonymous volumes', () => {
    const run = vi.fn().mockReturnValue('');
    const container = new PostgresBaselineContainer(run);
    container.start();
    container.stop();
    expect(run.mock.calls[0][0]).toEqual({
      executable: 'docker',
      args: [
        'run',
        '--detach',
        '--rm',
        '--name',
        container.name,
        '--tmpfs',
        '/var/lib/postgresql/data',
        '--env',
        'POSTGRES_PASSWORD=authrim-semantic-baseline-local',
        'postgres:17-alpine',
      ],
    });
    expect(run).toHaveBeenLastCalledWith({
      executable: 'docker',
      args: ['rm', '--force', '--volumes', container.name],
    });
  });

  it('tolerates an already removed container during cleanup', () => {
    const run = vi.fn(() => {
      throw new Error('No such container');
    });
    expect(() => new PostgresBaselineContainer(run).stop()).not.toThrow();
  });

  it.each(['success', 'verification failure', 'execution error', 'startup error'] as const)(
    'always stops the container after %s',
    (outcome) => {
      vi.spyOn(PostgresBaselineContainer.prototype, 'start').mockImplementation(() => {
        if (outcome === 'startup error') throw new Error(outcome);
      });
      const stop = vi
        .spyOn(PostgresBaselineContainer.prototype, 'stop')
        .mockImplementation(() => {});
      vi.spyOn(PostgresBaselineContainer.prototype, 'createDatabase').mockImplementation(() => {});
      vi.spyOn(PostgresBaselineContainer.prototype, 'execute').mockImplementation(() => {
        if (outcome === 'execution error') throw new Error(outcome);
      });
      vi.spyOn(PostgresBaselineContainer.prototype, 'dump')
        .mockReturnValueOnce('same')
        .mockReturnValueOnce(outcome === 'verification failure' ? 'different' : 'same');
      vi.spyOn(PostgresBaselineContainer.prototype, 'evidence').mockReturnValue({
        schemaChecksum: 'schema',
        seedChecksum: 'seed',
        objectCount: 1,
      });
      const verify = () =>
        verifySemanticMigrationComposition({
          streamId: 'postgres-cleanup',
          dialect: 'postgres',
          baseSql: [],
          sourceSql: ['SELECT 1;'],
          consolidatedSql: 'SELECT 1;',
        });
      if (outcome === 'success') expect(verify().objectCount).toBe(1);
      else
        expect(verify).toThrow(
          outcome === 'verification failure'
            ? 'PostgreSQL semantic release delta verification failed'
            : outcome
        );
      expect(stop).toHaveBeenCalledOnce();
    }
  );
});

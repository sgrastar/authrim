#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  RELEASE_MIGRATION_STREAM_DEFINITIONS,
  calculateReleaseMigrationChecksum,
  compareProductVersions,
  generateReleaseMigrationManifest,
  isVersionPublishedOnRemoteMain,
  listReleaseMigrationManifests,
  serializeReleaseMigrationManifest,
  streamDirectory,
  syncDraftReleaseMigrationManifest,
  validateRemoteMainPublishedReleaseMigrationManifests,
  type ReleaseMigrationFile,
  type ReleaseMigrationManifest,
  type ReleaseMigrationStream,
} from '../packages/setup/src/core/release-migrations.js';
import {
  PORTABLE_SQL_NOW_EPOCH_MILLISECONDS,
  PORTABLE_SQL_NOW_EPOCH_SECONDS,
  renderPortableMigrationSql,
  type MigrationSqlDialect,
} from '../packages/setup/src/core/sql-portability.js';

const POSTGRES_IMAGE = 'postgres:17-alpine';
const MAX_SUBPROCESS_BUFFER = 128 * 1024 * 1024;
const DETERMINISTIC_EPOCH_SECONDS = '1700000000';
const DETERMINISTIC_EPOCH_MILLISECONDS = '1700000000000';
const DETERMINISTIC_RANDOM_HEX_16 = '00000000000000000000000000000000';
const DETERMINISTIC_RANDOM_HEX_18 = '000000000000000000000000000000000000';

interface Arguments {
  write: boolean;
  version?: string;
}

interface GeneratedBaseline {
  stream: ReleaseMigrationStream;
  path: string;
  sql: string;
  sourceFiles: ReleaseMigrationFile[];
  schemaChecksum: string;
  seedChecksum: string;
  objectCount: number;
}

export interface SemanticMigrationCompositionEvidence {
  dialect: MigrationSqlDialect;
  streamId: string;
  schemaChecksum: string;
  seedChecksum: string;
  objectCount: number;
}

interface SemanticBaselineEvidence {
  formatVersion: 1;
  productVersion: string;
  compatibility: 'fresh_install_only';
  streams: Array<{
    id: string;
    dialect: MigrationSqlDialect;
    path: string;
    checksum: string;
    schemaChecksum: string;
    seedChecksum: string;
    objectCount: number;
    generatedFrom: ReleaseMigrationFile[];
  }>;
}

const BASELINE_FILENAME_PARTS: Readonly<Record<string, readonly [string, string]>> = {
  'd1-core': ['001', 'core_baseline.sql'],
  'd1-pii': ['001', 'pii_baseline.sql'],
  'd1-admin': ['001', 'admin_baseline.sql'],
  'd1-control': ['001', 'control_baseline.sql'],
  'd1-lookup': ['001', 'lookup_baseline.sql'],
  'd1-plugin-runner': ['001', 'plugin_runner_baseline.sql'],
  'external-postgres-core': ['001', 'external_postgres_core_baseline.sql'],
  'external-postgres-pii': ['002', 'external_postgres_pii_baseline.sql'],
};

export function semanticBaselinePath(productVersion: string, streamId: string): string {
  const parts = BASELINE_FILENAME_PARTS[streamId];
  if (!parts) throw new Error(`Unknown migration stream: ${streamId}`);
  const versionToken = productVersion
    .replaceAll(/[^0-9A-Za-z]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '');
  if (!versionToken) throw new Error(`Invalid semantic baseline version: ${productVersion}`);
  return `${parts[0]}_${versionToken}_${parts[1]}`;
}

function parseArguments(argv: string[]): Arguments {
  const versionIndex = argv.indexOf('--version');
  return {
    write: argv.includes('--write'),
    ...(versionIndex >= 0 ? { version: argv[versionIndex + 1] } : {}),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rootProductVersion(rootDir: string): string {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('Root package.json does not contain a product version');
  }
  return pkg.version;
}

export function assertSemanticBaselineAllowed(input: {
  version: string;
  write: boolean;
  published?: boolean;
}): void {
  const stableBoundary = /^\d+\.\d+\.0$/u.test(input.version);
  const [, , patch] = input.version.split(/[+-]/u, 1)[0]!.split('.').map(Number);
  if (patch !== 0 || !stableBoundary) {
    throw new Error(
      `Fresh-install baselines may be generated only at a major or minor boundary: ${input.version}`
    );
  }
  if (input.write && input.published) {
    throw new Error(
      `Product version ${input.version} is already published; bump root package.json before rewriting the semantic baseline`
    );
  }
}

function baselineHeader(productVersion: string, streamId: string): string {
  return [
    `-- Authrim ${productVersion} semantic fresh-install baseline.`,
    `-- Logical stream: ${streamId}.`,
    '-- Generated from the final database state; do not append historical migration SQL here.',
    '-- Fresh-install baselines must never be applied to upgrade an existing database.',
    '',
  ].join('\n');
}

function run(input: { executable: string; args: string[]; stdin?: string; cwd?: string }): string {
  try {
    return execFileSync(input.executable, input.args, {
      cwd: input.cwd,
      encoding: 'utf8',
      input: input.stdin,
      maxBuffer: MAX_SUBPROCESS_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    const details = [failure.stderr, failure.stdout, failure.message].filter(Boolean).join('\n');
    throw new Error(`${input.executable} ${input.args.join(' ')} failed:\n${details}`);
  }
}

function renderSourceSql(
  streamRoot: string,
  stream: ReleaseMigrationStream,
  file: ReleaseMigrationFile
): string {
  return renderDeterministicMigrationSql(
    readFileSync(join(streamRoot, file.path), 'utf8'),
    stream.dialect
  );
}

function renderDeterministicMigrationSql(sql: string, dialect: MigrationSqlDialect): string {
  let rendered = renderPortableMigrationSql(sql, dialect);
  if (dialect === 'sqlite') {
    rendered = rendered
      .replaceAll('(unixepoch() * 1000)', DETERMINISTIC_EPOCH_MILLISECONDS)
      .replaceAll('unixepoch()', DETERMINISTIC_EPOCH_SECONDS)
      .replaceAll(`randomblob(18)`, `X'${DETERMINISTIC_RANDOM_HEX_18}'`)
      .replaceAll(`randomblob(16)`, `X'${DETERMINISTIC_RANDOM_HEX_16}'`);
  } else if (dialect === 'postgres') {
    rendered = rendered
      .replaceAll(
        'CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS BIGINT)',
        DETERMINISTIC_EPOCH_MILLISECONDS
      )
      .replaceAll(
        'CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) AS BIGINT)',
        DETERMINISTIC_EPOCH_SECONDS
      );
  }
  return rendered;
}

function restorePortableSeedExpressions(dump: string, dialect: MigrationSqlDialect): string {
  let restored = dump
    .replaceAll(DETERMINISTIC_EPOCH_MILLISECONDS, PORTABLE_SQL_NOW_EPOCH_MILLISECONDS)
    .replaceAll(DETERMINISTIC_EPOCH_SECONDS, PORTABLE_SQL_NOW_EPOCH_SECONDS);
  if (dialect === 'sqlite') {
    restored = restored
      .replaceAll(`'t_${DETERMINISTIC_RANDOM_HEX_18}'`, `'t_' || lower(hex(randomblob(18)))`)
      .replaceAll(
        `'lookup-retention-policy:init:${DETERMINISTIC_RANDOM_HEX_16}'`,
        `'lookup-retention-policy:init:' || lower(hex(randomblob(16)))`
      )
      .replaceAll(`X'${DETERMINISTIC_RANDOM_HEX_18}'`, 'randomblob(18)')
      .replaceAll(`X'${DETERMINISTIC_RANDOM_HEX_16}'`, 'randomblob(16)');

    // Seed rows use portable placeholders so Setup can stamp a consistent installation time.
    // Schema objects must retain dynamic SQL expressions: replacing unixepoch() inside a trigger
    // would freeze its comparison at install time.
    restored = restored.replaceAll(/CREATE TRIGGER[\s\S]*?\nEND;/gu, (trigger) =>
      trigger
        .replaceAll(PORTABLE_SQL_NOW_EPOCH_MILLISECONDS, '(unixepoch() * 1000)')
        .replaceAll(PORTABLE_SQL_NOW_EPOCH_SECONDS, 'unixepoch()')
    );
  }
  return restored;
}

export function normalizeSqliteDump(dump: string): string {
  const ignored = new Set(['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;', 'COMMIT;']);
  return dump
    .split(/\r?\n/u)
    .filter((line) => !ignored.has(line.trim()))
    .join('\n')
    .trim()
    .replaceAll(/\n{3,}/gu, '\n\n');
}

export function normalizePostgresDump(dump: string): string {
  return dump
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith('\\restrict ') &&
        !trimmed.startsWith('\\unrestrict ') &&
        !trimmed.startsWith('-- Dumped from database version') &&
        !trimmed.startsWith('-- Dumped by pg_dump version')
      );
    })
    .join('\n')
    .trim()
    .replaceAll(/\n{3,}/gu, '\n\n');
}

function sqliteDump(dbPath: string): string {
  return normalizeSqliteDump(run({ executable: 'sqlite3', args: ['-bail', dbPath, '.dump'] }));
}

function sqliteSchemaAndSeedEvidence(dbPath: string): {
  schemaChecksum: string;
  seedChecksum: string;
  objectCount: number;
} {
  const schema = run({
    executable: 'sqlite3',
    args: [
      '-batch',
      '-noheader',
      dbPath,
      "SELECT type || '|' || name || '|' || coalesce(sql, '') FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;",
    ],
  });
  const objectCount = Number.parseInt(
    run({
      executable: 'sqlite3',
      args: [
        '-batch',
        '-noheader',
        dbPath,
        "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%';",
      ],
    }).trim(),
    10
  );
  return {
    schemaChecksum: sha256(schema),
    seedChecksum: sha256(
      sqliteDump(dbPath)
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('INSERT INTO '))
        .join('\n')
    ),
    objectCount,
  };
}

function generateSqliteBaseline(input: {
  tempDir: string;
  productVersion: string;
  streamRoot: string;
  stream: ReleaseMigrationStream;
}): GeneratedBaseline {
  const sourceDb = join(input.tempDir, `${input.stream.id}-source.sqlite`);
  for (const file of input.stream.files) {
    run({
      executable: 'sqlite3',
      args: ['-bail', sourceDb],
      stdin: renderSourceSql(input.streamRoot, input.stream, file),
    });
  }

  const sourceDump = sqliteDump(sourceDb);
  const body = restorePortableSeedExpressions(sourceDump, input.stream.dialect);
  const sql = `${baselineHeader(input.productVersion, input.stream.id)}PRAGMA foreign_keys = OFF;\n\n${body}\n\nPRAGMA foreign_keys = ON;\n`;
  const verifyDb = join(input.tempDir, `${input.stream.id}-verify.sqlite`);
  run({
    executable: 'sqlite3',
    args: ['-bail', verifyDb],
    stdin: renderDeterministicMigrationSql(sql, input.stream.dialect),
  });
  const verifyDump = sqliteDump(verifyDb);
  if (sourceDump !== verifyDump) {
    throw new Error(`SQLite semantic baseline verification failed for ${input.stream.id}`);
  }
  const evidence = sqliteSchemaAndSeedEvidence(verifyDb);
  return {
    stream: input.stream,
    path: semanticBaselinePath(input.productVersion, input.stream.id),
    sql,
    sourceFiles: input.stream.files,
    ...evidence,
  };
}

class PostgresBaselineContainer {
  readonly name = `authrim-semantic-baseline-${process.pid}`;

  start(): void {
    run({
      executable: 'docker',
      args: [
        'run',
        '--detach',
        '--rm',
        '--name',
        this.name,
        '--env',
        'POSTGRES_PASSWORD=authrim-semantic-baseline-local',
        POSTGRES_IMAGE,
      ],
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        run({
          executable: 'docker',
          args: ['exec', this.name, 'pg_isready', '--username', 'postgres'],
        });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
    throw new Error('PostgreSQL semantic baseline container did not become ready');
  }

  stop(): void {
    try {
      run({ executable: 'docker', args: ['rm', '--force', this.name] });
    } catch {
      // The --rm container may already be gone after an engine failure.
    }
  }

  createDatabase(name: string): void {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        run({
          executable: 'docker',
          args: ['exec', this.name, 'createdb', '--username', 'postgres', name],
        });
        return;
      } catch (error) {
        lastError = error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
    throw lastError;
  }

  execute(database: string, sql: string): void {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        run({
          executable: 'docker',
          args: [
            'exec',
            '--interactive',
            this.name,
            'psql',
            '--no-psqlrc',
            '--set',
            'ON_ERROR_STOP=1',
            '--username',
            'postgres',
            '--dbname',
            database,
          ],
          stdin: sql,
        });
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const connectionWasNotEstablished =
          (message.includes('connection to server on socket') &&
            (message.includes('No such file or directory') ||
              message.includes('Connection refused'))) ||
          message.includes('the database system is starting up');
        if (!connectionWasNotEstablished) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
    throw lastError;
  }

  dump(database: string): string {
    return normalizePostgresDump(
      run({
        executable: 'docker',
        args: [
          'exec',
          this.name,
          'pg_dump',
          '--username',
          'postgres',
          '--dbname',
          database,
          '--no-owner',
          '--no-privileges',
          '--inserts',
          '--restrict-key=AUTHRIMSEMANTICBASELINE',
        ],
      })
    );
  }

  evidence(database: string): {
    schemaChecksum: string;
    seedChecksum: string;
    objectCount: number;
  } {
    const schema = normalizePostgresDump(
      run({
        executable: 'docker',
        args: [
          'exec',
          this.name,
          'pg_dump',
          '--username',
          'postgres',
          '--dbname',
          database,
          '--schema-only',
          '--no-owner',
          '--no-privileges',
          '--restrict-key=AUTHRIMSEMANTICBASELINE',
        ],
      })
    );
    const seed = normalizePostgresDump(
      run({
        executable: 'docker',
        args: [
          'exec',
          this.name,
          'pg_dump',
          '--username',
          'postgres',
          '--dbname',
          database,
          '--data-only',
          '--inserts',
          '--no-owner',
          '--no-privileges',
          '--restrict-key=AUTHRIMSEMANTICBASELINE',
        ],
      })
    );
    const objectCount = Number.parseInt(
      run({
        executable: 'docker',
        args: [
          'exec',
          this.name,
          'psql',
          '--no-psqlrc',
          '--tuples-only',
          '--no-align',
          '--username',
          'postgres',
          '--dbname',
          database,
          '--command',
          "SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p','v','m','S','f');",
        ],
      }).trim(),
      10
    );
    return { schemaChecksum: sha256(schema), seedChecksum: sha256(seed), objectCount };
  }
}

export function verifySemanticMigrationComposition(input: {
  streamId: string;
  dialect: MigrationSqlDialect;
  baseSql: readonly string[];
  sourceSql: readonly string[];
  consolidatedSql: string;
}): SemanticMigrationCompositionEvidence {
  if (input.sourceSql.length === 0) {
    throw new Error(`Semantic migration composition source is empty: ${input.streamId}`);
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'authrim-semantic-delta-'));
  let postgres: PostgresBaselineContainer | undefined;
  try {
    if (input.dialect === 'sqlite') {
      const sourceDb = join(tempDir, 'source.sqlite');
      const consolidatedDb = join(tempDir, 'consolidated.sqlite');
      for (const sql of input.baseSql) {
        const rendered = renderDeterministicMigrationSql(sql, input.dialect);
        run({ executable: 'sqlite3', args: ['-bail', sourceDb], stdin: rendered });
        run({ executable: 'sqlite3', args: ['-bail', consolidatedDb], stdin: rendered });
      }
      for (const sql of input.sourceSql) {
        run({
          executable: 'sqlite3',
          args: ['-bail', sourceDb],
          stdin: renderDeterministicMigrationSql(sql, input.dialect),
        });
      }
      run({
        executable: 'sqlite3',
        args: ['-bail', consolidatedDb],
        stdin: renderDeterministicMigrationSql(input.consolidatedSql, input.dialect),
      });
      if (sqliteDump(sourceDb) !== sqliteDump(consolidatedDb)) {
        throw new Error(`SQLite semantic release delta verification failed for ${input.streamId}`);
      }
      return {
        dialect: input.dialect,
        streamId: input.streamId,
        ...sqliteSchemaAndSeedEvidence(sourceDb),
      };
    }

    if (input.dialect === 'postgres') {
      postgres = new PostgresBaselineContainer();
      postgres.start();
      postgres.createDatabase('authrim_delta_source');
      postgres.createDatabase('authrim_delta_consolidated');
      for (const sql of input.baseSql) {
        const rendered = renderDeterministicMigrationSql(sql, input.dialect);
        postgres.execute('authrim_delta_source', rendered);
        postgres.execute('authrim_delta_consolidated', rendered);
      }
      for (const sql of input.sourceSql) {
        postgres.execute(
          'authrim_delta_source',
          renderDeterministicMigrationSql(sql, input.dialect)
        );
      }
      postgres.execute(
        'authrim_delta_consolidated',
        renderDeterministicMigrationSql(input.consolidatedSql, input.dialect)
      );
      if (postgres.dump('authrim_delta_source') !== postgres.dump('authrim_delta_consolidated')) {
        throw new Error(
          `PostgreSQL semantic release delta verification failed for ${input.streamId}`
        );
      }
      return {
        dialect: input.dialect,
        streamId: input.streamId,
        ...postgres.evidence('authrim_delta_source'),
      };
    }

    throw new Error(`Semantic release delta verification is unavailable for ${input.dialect}`);
  } finally {
    postgres?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function generatePostgresBaseline(input: {
  productVersion: string;
  streamRoot: string;
  stream: ReleaseMigrationStream;
  container: PostgresBaselineContainer;
  index: number;
}): GeneratedBaseline {
  const sourceDatabase = `authrim_source_${input.index}`;
  const verifyDatabase = `authrim_verify_${input.index}`;
  input.container.createDatabase(sourceDatabase);
  for (const file of input.stream.files) {
    input.container.execute(sourceDatabase, renderSourceSql(input.streamRoot, input.stream, file));
  }
  const sourceDump = input.container.dump(sourceDatabase);
  const body = restorePortableSeedExpressions(sourceDump, input.stream.dialect);
  const sql = `${baselineHeader(input.productVersion, input.stream.id)}${body}\n`;
  input.container.createDatabase(verifyDatabase);
  input.container.execute(
    verifyDatabase,
    renderDeterministicMigrationSql(sql, input.stream.dialect)
  );
  if (input.container.dump(verifyDatabase) !== sourceDump) {
    throw new Error(`PostgreSQL semantic baseline verification failed for ${input.stream.id}`);
  }
  const evidence = input.container.evidence(verifyDatabase);
  return {
    stream: input.stream,
    path: semanticBaselinePath(input.productVersion, input.stream.id),
    sql,
    sourceFiles: input.stream.files,
    ...evidence,
  };
}

function writeFileAtomically(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.semantic-${process.pid}`;
  writeFileSync(temporaryPath, contents, 'utf8');
  renameSync(temporaryPath, path);
}

function baselineChecksum(baseline: GeneratedBaseline): string {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'authrim-baseline-checksum-'));
  try {
    const path = join(temporaryDirectory, basename(baseline.path));
    writeFileSync(path, baseline.sql, 'utf8');
    return calculateReleaseMigrationChecksum(path, baseline.stream.dialect);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function existingGeneratedFrom(
  migrationsRoot: string
): ReadonlyMap<string, { path: string; generatedFrom: ReleaseMigrationFile[] }> {
  const evidencePath = join(migrationsRoot, 'semantic-baseline.evidence.json');
  if (!existsSync(evidencePath)) return new Map();
  const parsed = JSON.parse(
    readFileSync(evidencePath, 'utf8')
  ) as Partial<SemanticBaselineEvidence>;
  if (!Array.isArray(parsed.streams)) return new Map();
  return new Map(
    parsed.streams
      .filter(
        (stream) =>
          typeof stream.id === 'string' &&
          typeof stream.path === 'string' &&
          Array.isArray(stream.generatedFrom) &&
          stream.generatedFrom.length > 0
      )
      .map((stream) => [stream.id, { path: stream.path, generatedFrom: stream.generatedFrom }])
  );
}

export function mergeSemanticBaselineProvenance(input: {
  baselinePath: string;
  priorBaselinePath?: string;
  sourceFiles: readonly ReleaseMigrationFile[];
  priorGeneratedFrom?: readonly ReleaseMigrationFile[];
}): ReleaseMigrationFile[] {
  const expanded = input.sourceFiles.flatMap((source) =>
    (source.path === input.baselinePath || source.path === input.priorBaselinePath) &&
    input.priorGeneratedFrom?.length
      ? input.priorGeneratedFrom
      : [source]
  );
  const checksumsByPath = new Map<string, string>();
  const merged: ReleaseMigrationFile[] = [];

  for (const source of expanded) {
    const existingChecksum = checksumsByPath.get(source.path);
    if (existingChecksum && existingChecksum !== source.checksum) {
      throw new Error(`Conflicting semantic baseline provenance checksum: ${source.path}`);
    }
    if (existingChecksum) continue;
    checksumsByPath.set(source.path, source.checksum);
    merged.push(source);
  }

  return merged;
}

function applySemanticRewrite(input: {
  migrationsRoot: string;
  productVersion: string;
  generated: GeneratedBaseline[];
  releaseHistory: readonly ReleaseMigrationManifest[];
  hasPriorRelease: boolean;
}): void {
  const priorProvenance = existingGeneratedFrom(input.migrationsRoot);
  const evidence: SemanticBaselineEvidence = {
    formatVersion: 1,
    productVersion: input.productVersion,
    compatibility: 'fresh_install_only',
    streams: input.generated.map((baseline) => ({
      id: baseline.stream.id,
      dialect: baseline.stream.dialect,
      path: baseline.path,
      checksum: baselineChecksum(baseline),
      schemaChecksum: baseline.schemaChecksum,
      seedChecksum: baseline.seedChecksum,
      objectCount: baseline.objectCount,
      generatedFrom: mergeSemanticBaselineProvenance({
        baselinePath: baseline.path,
        priorBaselinePath: priorProvenance.get(baseline.stream.id)?.path,
        sourceFiles: baseline.sourceFiles,
        priorGeneratedFrom: priorProvenance.get(baseline.stream.id)?.generatedFrom,
      }),
    })),
  };
  for (const baseline of input.generated) {
    const streamRoot = streamDirectory(input.migrationsRoot, baseline.stream.id);
    if (!streamRoot) throw new Error(`Unknown migration stream: ${baseline.stream.id}`);
    const targetPath = join(streamRoot, baseline.path);
    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath, 'utf8');
      if (existing !== baseline.sql) writeFileAtomically(targetPath, baseline.sql);
    } else {
      writeFileAtomically(targetPath, baseline.sql);
    }
  }
  const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileAtomically(
    join(input.migrationsRoot, 'semantic-baseline.evidence.json'),
    serializedEvidence
  );
  writeFileAtomically(
    join(input.migrationsRoot, 'evidence', `${input.productVersion}.json`),
    serializedEvidence
  );

  if (!input.hasPriorRelease) {
    const protectedPaths = new Set<string>();
    for (const manifest of input.releaseHistory) {
      for (const stream of [
        ...manifest.streams,
        ...(manifest.upgradePaths ?? []).flatMap((path) => path.streams),
      ]) {
        for (const file of stream.files) protectedPaths.add(`${stream.id}:${file.path}`);
      }
    }
    for (const baseline of input.generated) {
      const streamRoot = streamDirectory(input.migrationsRoot, baseline.stream.id);
      if (!streamRoot) throw new Error(`Unknown migration stream: ${baseline.stream.id}`);
      for (const source of baseline.sourceFiles) {
        if (
          source.path === baseline.path ||
          protectedPaths.has(`${baseline.stream.id}:${source.path}`)
        ) {
          continue;
        }
        const sourcePath = join(streamRoot, source.path);
        if (!existsSync(sourcePath)) continue;
        if (
          calculateReleaseMigrationChecksum(sourcePath, baseline.stream.dialect) !== source.checksum
        ) {
          throw new Error(
            `Refusing to remove changed semantic baseline source: ${baseline.stream.id}/${source.path}`
          );
        }
        rmSync(sourcePath);
      }
    }
  }

  const draft = syncDraftReleaseMigrationManifest({
    migrationsRoot: input.migrationsRoot,
    productVersion: input.productVersion,
  }).manifest;
  console.log(
    `Updated ${join(input.migrationsRoot, 'release-manifest.draft.json')} (${sha256(serializeReleaseMigrationManifest(draft))})`
  );
}

export function runSemanticBaselineMigrations(input: {
  rootDir: string;
  productVersion: string;
  write: boolean;
}): void {
  const migrationsRoot = join(input.rootDir, 'migrations');
  validateRemoteMainPublishedReleaseMigrationManifests({
    migrationsRoot,
    repositoryRoot: input.rootDir,
  });
  const manifests = listReleaseMigrationManifests(migrationsRoot);
  assertSemanticBaselineAllowed({
    version: input.productVersion,
    write: input.write,
    published: isVersionPublishedOnRemoteMain({
      repositoryRoot: input.rootDir,
      productVersion: input.productVersion,
    }),
  });
  const current = generateReleaseMigrationManifest({
    migrationsRoot,
    productVersion: input.productVersion,
    previousManifests: manifests.map((release) => release.manifest),
    semanticBaselineSource: true,
  });
  const tempDir = mkdtempSync(join(tmpdir(), 'authrim-semantic-baseline-'));
  const generated: GeneratedBaseline[] = [];
  let postgres: PostgresBaselineContainer | undefined;

  try {
    for (const stream of current.streams.filter((candidate) => candidate.dialect === 'sqlite')) {
      const streamRoot = streamDirectory(migrationsRoot, stream.id);
      if (!streamRoot || stream.files.length === 0) {
        throw new Error(`Semantic baseline source stream is empty: ${stream.id}`);
      }
      generated.push(
        generateSqliteBaseline({
          tempDir,
          productVersion: input.productVersion,
          streamRoot,
          stream,
        })
      );
    }

    const postgresStreams = current.streams.filter((candidate) => candidate.dialect === 'postgres');
    if (postgresStreams.length > 0) {
      postgres = new PostgresBaselineContainer();
      postgres.start();
      postgresStreams.forEach((stream, index) => {
        const streamRoot = streamDirectory(migrationsRoot, stream.id);
        if (!streamRoot || stream.files.length === 0) {
          throw new Error(`Semantic baseline source stream is empty: ${stream.id}`);
        }
        generated.push(
          generatePostgresBaseline({
            productVersion: input.productVersion,
            streamRoot,
            stream,
            container: postgres!,
            index,
          })
        );
      });
    }

    for (const baseline of generated) {
      const changed = (() => {
        const streamRoot = streamDirectory(migrationsRoot, baseline.stream.id);
        const currentPath = streamRoot ? join(streamRoot, baseline.path) : '';
        return (
          !currentPath ||
          !existsSync(currentPath) ||
          readFileSync(currentPath, 'utf8') !== baseline.sql
        );
      })();
      console.log(
        `${baseline.stream.id}: ${baseline.sourceFiles.length} source file(s) -> ${baseline.path} ` +
          `(${baseline.objectCount} objects, ${changed ? 'rewrite' : 'unchanged'})`
      );
    }

    if (input.write) {
      applySemanticRewrite({
        migrationsRoot,
        productVersion: input.productVersion,
        generated,
        releaseHistory: manifests.map((release) => release.manifest),
        hasPriorRelease: manifests.some(
          (release) =>
            compareProductVersions(release.manifest.productVersion, input.productVersion) < 0
        ),
      });
      console.log('Semantic fresh-install migration baselines written.');
    } else {
      console.log('Dry run only; pass --write to add the verified fresh-install baselines.');
    }
  } finally {
    postgres?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const rootDir = process.cwd();
  const productVersion = args.version ?? rootProductVersion(rootDir);
  if (productVersion !== rootProductVersion(rootDir)) {
    throw new Error(`Semantic baseline version must match root package.json: ${productVersion}`);
  }
  runSemanticBaselineMigrations({ rootDir, productVersion, write: args.write });
}

if (process.argv[1] && basename(process.argv[1]) === basename(import.meta.filename)) main();

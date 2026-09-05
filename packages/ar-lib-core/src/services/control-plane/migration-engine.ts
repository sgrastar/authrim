import {
  AUTHRIM_MIGRATIONS_TABLE_SQL,
  AUTHRIM_MIGRATION_HISTORY_SQL,
  validateAuthrimMigrationHistoryRows,
} from './migration-history-contract.js';
import type { CloudflareD1QueryResult } from './cloudflare-control-api-client.js';
import { splitMigrationSql } from './migration-sql.js';
import { MigrationReleaseArtifactReader, type MigrationReleasePin } from './release-artifact.js';

export interface MigrationD1Query {
  sql: string;
  params?: unknown[];
}

const MIGRATION_INFRASTRUCTURE_BATCH: readonly MigrationD1Query[] = [
  {
    sql: AUTHRIM_MIGRATIONS_TABLE_SQL,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )`,
  },
] as const;

const MIGRATION_SENTINEL_SQL =
  'SELECT stream_id, release_id, manifest_digest, applied_file_count, state, last_filename FROM tenant_database_migration_state WHERE stream_id = ?';
const MIGRATION_INFRASTRUCTURE_STATE_SQL = `SELECT name
  FROM sqlite_master
 WHERE type = 'table'
   AND name IN ('authrim_migrations', 'tenant_database_migration_state')
 ORDER BY name`;

interface AppliedMigrationRow extends Record<string, unknown> {
  filename: string;
  checksum: string;
  applied_at: number;
}

interface MigrationSentinelRow extends Record<string, unknown> {
  stream_id: string;
  release_id: string;
  manifest_digest: string;
  applied_file_count: number;
  state: string;
  last_filename: string | null;
}

interface MigrationInfrastructureRow extends Record<string, unknown> {
  name: string;
}

export interface MigrationD1Executor {
  queryD1(databaseId: string, sql: string, params?: unknown[]): Promise<CloudflareD1QueryResult[]>;
  queryD1Batch(
    databaseId: string,
    batch: readonly MigrationD1Query[]
  ): Promise<CloudflareD1QueryResult[]>;
}

export interface ApplyMigrationReleaseInput {
  databaseId: string;
  pin: MigrationReleasePin;
}

export interface ApplyMigrationReleaseResult {
  streamId: string;
  releaseId: string;
  manifestDigest: string;
  totalFiles: number;
  appliedFiles: number;
  skippedFiles: number;
  responseLossRecoveries: number;
  lastFilename: string;
}

function assertBatchSucceeded(results: CloudflareD1QueryResult[], expectedCount: number): void {
  if (results.length !== expectedCount || results.some((result) => result.success !== true)) {
    throw new Error('migration_d1_batch_failed');
  }
}

function resultRows<T extends Record<string, unknown>>(results: CloudflareD1QueryResult[]): T[] {
  if (results.length !== 1 || results[0]?.success !== true || !Array.isArray(results[0]?.results)) {
    throw new Error('migration_d1_query_result_invalid');
  }
  return results[0].results.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('migration_d1_query_result_invalid');
    }
    return row as T;
  });
}

function parseHistoryRows(results: CloudflareD1QueryResult[]): Map<string, AppliedMigrationRow> {
  const history = new Map<string, AppliedMigrationRow>();
  let rows;
  try {
    rows = validateAuthrimMigrationHistoryRows(resultRows<Record<string, unknown>>(results), {
      requireChecksum: true,
      requireAppliedAt: true,
      rejectDuplicates: true,
    });
  } catch {
    throw new Error('migration_history_invalid');
  }
  for (const row of rows) {
    if (typeof row.checksum !== 'string' || typeof row.applied_at !== 'number') {
      throw new Error('migration_history_invalid');
    }
    history.set(row.filename, {
      filename: row.filename,
      checksum: row.checksum,
      applied_at: row.applied_at,
    });
  }
  return history;
}

function hasCompleteMigrationInfrastructure(results: CloudflareD1QueryResult[]): boolean {
  const names = resultRows<MigrationInfrastructureRow>(results).map((row) => row.name);
  return (
    names.length === 2 &&
    names[0] === 'authrim_migrations' &&
    names[1] === 'tenant_database_migration_state'
  );
}

function sentinelMatches(input: {
  sentinel: MigrationSentinelRow | undefined;
  pin: MigrationReleasePin;
  fileCount: number;
  lastFilename: string;
}): boolean {
  return (
    input.sentinel?.stream_id === input.pin.streamId &&
    input.sentinel.release_id === input.pin.releaseId &&
    input.sentinel.manifest_digest === input.pin.manifestDigest &&
    input.sentinel.applied_file_count === input.fileCount &&
    input.sentinel.state === 'ready' &&
    input.sentinel.last_filename === input.lastFilename
  );
}

function recordMigrationQuery(input: {
  filename: string;
  checksum: string;
  releaseId: string;
  appliedAt: number;
}): MigrationD1Query {
  return {
    sql: `INSERT INTO authrim_migrations (
      filename, checksum, applied_at, execution_time_ms, setup_version, tool_version
    ) VALUES (?, ?, ?, NULL, ?, NULL)`,
    params: [input.filename, input.checksum, input.appliedAt, input.releaseId],
  };
}

function upsertSentinelQuery(input: {
  pin: MigrationReleasePin;
  appliedFileCount: number;
  lastFilename: string | null;
  now: number;
}): MigrationD1Query {
  return {
    sql: `INSERT INTO tenant_database_migration_state (
      stream_id, release_id, manifest_digest, applied_file_count, state, last_filename, updated_at
    ) VALUES (?, ?, ?, ?, 'ready', ?, ?)
    ON CONFLICT(stream_id) DO UPDATE SET
      release_id = excluded.release_id,
      manifest_digest = excluded.manifest_digest,
      applied_file_count = excluded.applied_file_count,
      state = 'ready',
      last_filename = excluded.last_filename,
      updated_at = excluded.updated_at`,
    params: [
      input.pin.streamId,
      input.pin.releaseId,
      input.pin.manifestDigest,
      input.appliedFileCount,
      input.lastFilename,
      input.now,
    ],
  };
}

export class ApiMigrationEngine {
  constructor(
    private readonly artifactReader: MigrationReleaseArtifactReader,
    private readonly d1: MigrationD1Executor,
    private readonly now: () => number
  ) {}

  async apply(input: ApplyMigrationReleaseInput): Promise<ApplyMigrationReleaseResult> {
    const release = await this.artifactReader.load(input.pin);
    if (release.files.length === 0) throw new Error('migration_release_stream_empty');

    const infrastructureReady = hasCompleteMigrationInfrastructure(
      await this.d1.queryD1(input.databaseId, MIGRATION_INFRASTRUCTURE_STATE_SQL)
    );
    if (!infrastructureReady) {
      assertBatchSucceeded(
        await this.d1.queryD1Batch(input.databaseId, MIGRATION_INFRASTRUCTURE_BATCH),
        MIGRATION_INFRASTRUCTURE_BATCH.length
      );
    }
    const history = parseHistoryRows(
      await this.d1.queryD1(input.databaseId, AUTHRIM_MIGRATION_HISTORY_SQL)
    );
    const expectedFiles = new Map(release.knownHistory.map((file) => [file.path, file]));
    for (const file of release.files) {
      const expected = expectedFiles.get(file.path);
      if (!expected || expected.checksum !== file.checksum) {
        throw new Error('migration_release_history_contract_invalid');
      }
    }
    for (const [filename, applied] of history) {
      const expected = expectedFiles.get(filename);
      if (!expected) throw new Error('migration_history_unexpected_file');
      if (expected.checksum !== applied.checksum) {
        throw new Error('migration_history_checksum_mismatch');
      }
    }

    const adoptFromSupersededHistory = new Set<string>();
    for (const file of release.files) {
      if (history.has(file.path) || !file.supersedes || file.supersedes.length === 0) continue;
      const appliedSources = file.supersedes.filter((source) => history.has(source.path));
      if (appliedSources.length === 0) continue;
      if (appliedSources.length !== file.supersedes.length) {
        throw new Error('migration_history_partial_supersedes');
      }
      adoptFromSupersededHistory.add(file.path);
    }

    const lastFile = release.files.at(-1);
    if (!lastFile) throw new Error('migration_release_stream_empty');
    const lastFilename = lastFile.path;
    if (release.files.every((file) => history.has(file.path))) {
      const [existingSentinel] = resultRows<MigrationSentinelRow>(
        await this.d1.queryD1(input.databaseId, MIGRATION_SENTINEL_SQL, [input.pin.streamId])
      );
      if (
        sentinelMatches({
          sentinel: existingSentinel,
          pin: input.pin,
          fileCount: release.files.length,
          lastFilename,
        })
      ) {
        return {
          streamId: input.pin.streamId,
          releaseId: input.pin.releaseId,
          manifestDigest: input.pin.manifestDigest,
          totalFiles: release.files.length,
          appliedFiles: 0,
          skippedFiles: release.files.length,
          responseLossRecoveries: 0,
          lastFilename,
        };
      }
    }

    let appliedFiles = 0;
    let skippedFiles = 0;
    let responseLossRecoveries = 0;
    for (const file of release.files) {
      if (history.has(file.path)) {
        skippedFiles += 1;
        continue;
      }
      const statements = adoptFromSupersededHistory.has(file.path)
        ? []
        : splitMigrationSql(file.sql).map((sql) => ({ sql }));
      const batch = [
        ...statements,
        recordMigrationQuery({
          filename: file.path,
          checksum: file.checksum,
          releaseId: release.pin.releaseId,
          appliedAt: this.now(),
        }),
      ];
      try {
        assertBatchSucceeded(await this.d1.queryD1Batch(input.databaseId, batch), batch.length);
      } catch (error) {
        let verification: AppliedMigrationRow | undefined;
        try {
          verification = parseHistoryRows(
            await this.d1.queryD1(input.databaseId, AUTHRIM_MIGRATION_HISTORY_SQL)
          ).get(file.path);
        } catch {
          throw new Error('migration_commit_state_unknown');
        }
        if (!verification) throw error;
        if (verification.checksum !== file.checksum) {
          throw new Error('migration_history_checksum_mismatch');
        }
        responseLossRecoveries += 1;
      }
      history.set(file.path, {
        filename: file.path,
        checksum: file.checksum,
        applied_at: this.now(),
      });
      if (adoptFromSupersededHistory.has(file.path)) {
        skippedFiles += 1;
      } else {
        appliedFiles += 1;
      }
    }

    let sentinel: MigrationSentinelRow | undefined;
    try {
      assertBatchSucceeded(
        await this.d1.queryD1Batch(input.databaseId, [
          upsertSentinelQuery({
            pin: input.pin,
            appliedFileCount: release.files.length,
            lastFilename,
            now: this.now(),
          }),
        ]),
        1
      );
    } catch (error) {
      try {
        [sentinel] = resultRows<MigrationSentinelRow>(
          await this.d1.queryD1(input.databaseId, MIGRATION_SENTINEL_SQL, [input.pin.streamId])
        );
      } catch {
        throw new Error('migration_commit_state_unknown');
      }
      if (
        !sentinelMatches({
          sentinel,
          pin: input.pin,
          fileCount: release.files.length,
          lastFilename,
        })
      ) {
        throw error;
      }
      responseLossRecoveries += 1;
    }
    if (!sentinel) {
      [sentinel] = resultRows<MigrationSentinelRow>(
        await this.d1.queryD1(input.databaseId, MIGRATION_SENTINEL_SQL, [input.pin.streamId])
      );
    }
    if (
      !sentinelMatches({
        sentinel,
        pin: input.pin,
        fileCount: release.files.length,
        lastFilename,
      })
    ) {
      throw new Error('migration_sentinel_verification_failed');
    }

    return {
      streamId: input.pin.streamId,
      releaseId: input.pin.releaseId,
      manifestDigest: input.pin.manifestDigest,
      totalFiles: release.files.length,
      appliedFiles,
      skippedFiles,
      responseLossRecoveries,
      lastFilename,
    };
  }
}

export function cloudflareMigrationExecutor(client: MigrationD1Executor): MigrationD1Executor {
  return client;
}

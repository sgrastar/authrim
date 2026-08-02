import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CloudflareD1QueryResult } from '@authrim/ar-lib-core/control-plane';
import {
  ApiMigrationEngine,
  type MigrationD1Executor,
  type MigrationD1Query,
} from '../migration-engine.js';
import {
  MigrationReleaseArtifactReader,
  type MigrationReleasePin,
  type ReleaseArtifactObject,
  type ReleaseArtifactStore,
} from '../release-artifact.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function queryResult(results: unknown[] = []): CloudflareD1QueryResult[] {
  return [{ success: true, results }];
}

class MemoryStore implements ReleaseArtifactStore {
  constructor(private readonly objects: ReadonlyMap<string, string>) {}

  async get(key: string): Promise<ReleaseArtifactObject | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    const bytes = new TextEncoder().encode(value);
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
  }
}

function releaseFixture() {
  const files = [
    { path: '001_foundation.sql', sql: 'CREATE TABLE account (id TEXT PRIMARY KEY);' },
    { path: '002_index.sql', sql: 'CREATE INDEX idx_account_id ON account(id);' },
  ];
  const manifest = `${JSON.stringify({
    formatVersion: 1,
    productVersion: '0.4.0',
    streams: [
      {
        id: 'd1-core',
        dialect: 'sqlite',
        logicalRoles: ['tenant_core'],
        files: files.map((file) => ({ path: file.path, checksum: digest(file.sql) })),
      },
    ],
  })}\n`;
  const pin: MigrationReleasePin = {
    environmentId: 'env-test',
    streamId: 'd1-core',
    releaseId: '0.4.0',
    manifestDigest: digest(manifest),
    manifestObjectKey: `releases/0.4.0/${digest(manifest)}/manifest.json`,
  };
  const objects = new Map<string, string>([[pin.manifestObjectKey, manifest]]);
  const base = pin.manifestObjectKey.slice(0, pin.manifestObjectKey.lastIndexOf('/') + 1);
  for (const file of files) {
    objects.set(`${base}streams/d1-core/${file.path}`, file.sql);
  }
  return { files, manifest, objects, pin };
}

function successfulExecutor(input: {
  history?: Array<{ filename: string; checksum: string; applied_at: number }>;
  failFirstMigrationAfterCommit?: boolean;
  failSentinelAfterCommit?: boolean;
  sentinelOverride?: Record<string, unknown> | null;
  failSentinelRead?: boolean;
  infrastructureReady?: boolean;
}) {
  const fixture = releaseFixture();
  let history = [...(input.history ?? [])];
  let migrationAttempts = 0;
  const queryD1 = vi.fn(
    async (_databaseId: string, sql: string): Promise<CloudflareD1QueryResult[]> => {
      if (sql.includes('FROM sqlite_master')) {
        return queryResult(
          input.infrastructureReady
            ? [{ name: 'authrim_migrations' }, { name: 'tenant_database_migration_state' }]
            : []
        );
      }
      if (sql.startsWith('SELECT filename')) return queryResult(history);
      if (sql.startsWith('SELECT stream_id')) {
        if (input.failSentinelRead) throw new Error('provider_response_lost');
        if (input.sentinelOverride !== undefined) {
          return queryResult(input.sentinelOverride === null ? [] : [input.sentinelOverride]);
        }
        return queryResult([
          {
            stream_id: fixture.pin.streamId,
            release_id: fixture.pin.releaseId,
            manifest_digest: fixture.pin.manifestDigest,
            applied_file_count: fixture.files.length,
            state: 'ready',
            last_filename: fixture.files.at(-1)?.path ?? null,
          },
        ]);
      }
      throw new Error('unexpected_query');
    }
  );
  const queryD1Batch = vi.fn(async (_databaseId: string, batch: readonly MigrationD1Query[]) => {
    const record = batch.find((query) => query.sql.includes('INSERT INTO authrim_migrations'));
    if (record) {
      migrationAttempts += 1;
      history = [
        ...history,
        {
          filename: String(record.params?.[0]),
          checksum: String(record.params?.[1]),
          applied_at: Number(record.params?.[2]),
        },
      ];
      if (input.failFirstMigrationAfterCommit && migrationAttempts === 1) {
        throw new Error('provider_response_lost');
      }
    }
    if (
      input.failSentinelAfterCommit &&
      batch.some((query) => query.sql.includes('INSERT INTO tenant_database_migration_state'))
    ) {
      throw new Error('provider_response_lost');
    }
    return batch.map(() => ({ success: true, results: [] }));
  });
  return {
    fixture,
    d1: { queryD1, queryD1Batch } satisfies MigrationD1Executor,
    queryD1,
    queryD1Batch,
  };
}

describe('ApiMigrationEngine', () => {
  it('applies each file atomically with its tracking row and verifies the sentinel', async () => {
    const { fixture, d1, queryD1Batch } = successfulExecutor({});
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(fixture.objects)),
      d1,
      () => 1_700_000_000_000
    );

    await expect(engine.apply({ databaseId: 'db-id', pin: fixture.pin })).resolves.toEqual({
      streamId: 'd1-core',
      releaseId: '0.4.0',
      manifestDigest: fixture.pin.manifestDigest,
      totalFiles: 2,
      appliedFiles: 2,
      skippedFiles: 0,
      responseLossRecoveries: 0,
      lastFilename: '002_index.sql',
    });
    const migrationBatches = queryD1Batch.mock.calls
      .map((call) => call[1])
      .filter((batch) => batch.some((query) => query.sql.includes('authrim_migrations')))
      .slice(1);
    expect(migrationBatches).toHaveLength(2);
    expect(migrationBatches[0]?.at(-1)?.params?.slice(0, 2)).toEqual([
      '001_foundation.sql',
      digest(fixture.files[0].sql),
    ]);
  });

  it('skips matching history without replaying migration SQL', async () => {
    const fixture = releaseFixture();
    const history = fixture.files.map((file) => ({
      filename: file.path,
      checksum: digest(file.sql),
      applied_at: 1,
    }));
    const { d1, queryD1Batch } = successfulExecutor({ history, infrastructureReady: true });
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(fixture.objects)),
      d1,
      () => 2
    );

    await expect(engine.apply({ databaseId: 'db-id', pin: fixture.pin })).resolves.toMatchObject({
      appliedFiles: 0,
      skippedFiles: 2,
    });
    expect(
      queryD1Batch.mock.calls
        .flatMap((call) => call[1])
        .filter((query) => query.params?.[0] === fixture.files[0].path)
    ).toHaveLength(0);
    expect(queryD1Batch).not.toHaveBeenCalled();
  });

  it('recovers a committed migration after provider response loss', async () => {
    const { fixture, d1 } = successfulExecutor({ failFirstMigrationAfterCommit: true });
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(fixture.objects)),
      d1,
      () => 3
    );

    await expect(engine.apply({ databaseId: 'db-id', pin: fixture.pin })).resolves.toMatchObject({
      appliedFiles: 2,
      responseLossRecoveries: 1,
    });
  });

  it('recovers a committed migration sentinel after provider response loss', async () => {
    const { fixture, d1 } = successfulExecutor({ failSentinelAfterCommit: true });
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(fixture.objects)),
      d1,
      () => 3
    );

    await expect(engine.apply({ databaseId: 'db-id', pin: fixture.pin })).resolves.toMatchObject({
      appliedFiles: 2,
      responseLossRecoveries: 1,
    });
  });

  it('does not adopt a response-lost sentinel without an exact primary recheck', async () => {
    const fixture = releaseFixture();
    const mismatch = successfulExecutor({
      failSentinelAfterCommit: true,
      sentinelOverride: {
        stream_id: fixture.pin.streamId,
        release_id: fixture.pin.releaseId,
        manifest_digest: '0'.repeat(64),
        applied_file_count: fixture.files.length,
        state: 'ready',
        last_filename: fixture.files.at(-1)?.path ?? null,
      },
    });
    const mismatchEngine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(mismatch.fixture.objects)),
      mismatch.d1,
      () => 3
    );
    await expect(
      mismatchEngine.apply({ databaseId: 'db-id', pin: mismatch.fixture.pin })
    ).rejects.toThrow('provider_response_lost');

    const unreadable = successfulExecutor({
      failSentinelAfterCommit: true,
      failSentinelRead: true,
    });
    const unreadableEngine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(unreadable.fixture.objects)),
      unreadable.d1,
      () => 3
    );
    await expect(
      unreadableEngine.apply({ databaseId: 'db-id', pin: unreadable.fixture.pin })
    ).rejects.toThrow('migration_commit_state_unknown');
  });

  it('fails closed on changed or unexpected migration history before applying SQL', async () => {
    const fixture = releaseFixture();
    for (const history of [
      [{ filename: fixture.files[0].path, checksum: 'a'.repeat(64), applied_at: 1 }],
      [{ filename: '999_unknown.sql', checksum: 'b'.repeat(64), applied_at: 1 }],
    ]) {
      const { d1, queryD1Batch } = successfulExecutor({ history });
      const engine = new ApiMigrationEngine(
        new MigrationReleaseArtifactReader(new MemoryStore(fixture.objects)),
        d1,
        () => 4
      );
      await expect(engine.apply({ databaseId: 'db-id', pin: fixture.pin })).rejects.toThrow(
        history[0].filename === fixture.files[0].path
          ? 'migration_history_checksum_mismatch'
          : 'migration_history_unexpected_file'
      );
      expect(
        queryD1Batch.mock.calls
          .flatMap((call) => call[1])
          .some((query) => query.params?.[0] === fixture.files[0].path)
      ).toBe(false);
    }
  });

  it('does not call D1 when exact manifest verification fails', async () => {
    const fixture = releaseFixture();
    const forgedManifestKey = `releases/0.4.0/${'0'.repeat(64)}/manifest.json`;
    const forgedObjects = new Map(fixture.objects);
    forgedObjects.set(forgedManifestKey, fixture.manifest);
    const d1 = {
      queryD1: vi.fn(),
      queryD1Batch: vi.fn(),
    } satisfies MigrationD1Executor;
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(forgedObjects)),
      d1,
      () => 5
    );

    await expect(
      engine.apply({
        databaseId: 'db-id',
        pin: {
          ...fixture.pin,
          manifestDigest: '0'.repeat(64),
          manifestObjectKey: forgedManifestKey,
        },
      })
    ).rejects.toThrow('migration_release_manifest_digest_mismatch');
    expect(d1.queryD1).not.toHaveBeenCalled();
    expect(d1.queryD1Batch).not.toHaveBeenCalled();
  });

  it('requires explicit success from every provider batch result', async () => {
    const fixture = releaseFixture();
    const d1 = {
      queryD1: vi.fn().mockResolvedValue(queryResult()),
      queryD1Batch: vi.fn().mockResolvedValue([{ results: [] }]),
    } satisfies MigrationD1Executor;
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(fixture.objects)),
      d1,
      () => 6
    );

    await expect(engine.apply({ databaseId: 'db-id', pin: fixture.pin })).rejects.toThrow(
      'migration_d1_batch_failed'
    );
    expect(d1.queryD1).toHaveBeenCalledTimes(1);
  });
});

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
    formatVersion: 2,
    productVersion: '0.4.0',
    streams: [
      {
        id: 'core-d1',
        schemaFamily: 'core',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['core', 'tenant_core'],
        files: files.map((file) => ({ path: file.path, checksum: digest(file.sql) })),
      },
    ],
  })}\n`;
  const pin: MigrationReleasePin = {
    environmentId: 'env-test',
    streamId: 'core-d1',
    releaseId: '0.4.0',
    manifestDigest: digest(manifest),
    manifestObjectKey: `releases/0.4.0/${digest(manifest)}/manifest.json`,
  };
  const objects = new Map<string, string>([[pin.manifestObjectKey, manifest]]);
  const base = pin.manifestObjectKey.slice(0, pin.manifestObjectKey.lastIndexOf('/') + 1);
  for (const file of files) {
    objects.set(`${base}streams/core-d1/${file.path}`, file.sql);
  }
  return { files, manifest, objects, pin };
}

function supersededReleaseFixture() {
  const sourceFiles = [
    { path: '002_add_name.sql', checksum: digest('ALTER TABLE account ADD COLUMN name TEXT;') },
    { path: '003_add_index.sql', checksum: digest('CREATE INDEX idx_name ON account(name);') },
  ];
  const bundle = {
    path: '002_0_4_1_core_delta.sql',
    sql: 'ALTER TABLE account ADD COLUMN name TEXT; CREATE INDEX idx_name ON account(name);',
  };
  const manifest = `${JSON.stringify({
    formatVersion: 2,
    productVersion: '0.4.1',
    streams: [
      {
        id: 'core-d1',
        schemaFamily: 'core',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['core', 'tenant_core'],
        files: [],
      },
    ],
    upgradePaths: [
      {
        fromProductVersion: '0.4.0',
        kind: 'delta',
        streams: [
          {
            id: 'core-d1',
            schemaFamily: 'core',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['core', 'tenant_core'],
            files: [
              {
                path: bundle.path,
                checksum: digest(bundle.sql),
                supersedes: sourceFiles,
              },
            ],
          },
        ],
      },
    ],
    acceptedMigrationHistory: [
      {
        id: 'core-d1',
        schemaFamily: 'core',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['core', 'tenant_core'],
        files: [...sourceFiles, { path: bundle.path, checksum: digest(bundle.sql) }],
      },
    ],
  })}\n`;
  const manifestDigest = digest(manifest);
  const base = `releases/0.4.1/${manifestDigest}/`;
  const pin: MigrationReleasePin = {
    environmentId: 'env-test',
    streamId: 'core-d1',
    releaseId: '0.4.1',
    manifestDigest,
    manifestObjectKey: `${base}manifest.json`,
    sourceProductVersion: '0.4.0',
  };
  return {
    bundle,
    sourceFiles,
    pin,
    objects: new Map<string, string>([
      [pin.manifestObjectKey, manifest],
      [`${base}streams/core-d1/${bundle.path}`, bundle.sql],
    ]),
  };
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
      streamId: 'core-d1',
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

  it('adopts a consolidated delta when every superseded source is already applied', async () => {
    const release = supersededReleaseFixture();
    const history = release.sourceFiles.map((file) => ({
      ...file,
      filename: file.path,
      applied_at: 1,
    }));
    const { d1, queryD1Batch } = successfulExecutor({
      history,
      infrastructureReady: true,
      sentinelOverride: {
        stream_id: release.pin.streamId,
        release_id: release.pin.releaseId,
        manifest_digest: release.pin.manifestDigest,
        applied_file_count: 1,
        state: 'ready',
        last_filename: release.bundle.path,
      },
    });
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(release.objects)),
      d1,
      () => 2
    );

    await expect(engine.apply({ databaseId: 'db-id', pin: release.pin })).resolves.toMatchObject({
      appliedFiles: 0,
      skippedFiles: 1,
      lastFilename: release.bundle.path,
    });
    const adoptionBatch = queryD1Batch.mock.calls[0]?.[1];
    expect(adoptionBatch).toHaveLength(1);
    expect(adoptionBatch?.[0]?.sql).toContain('INSERT INTO authrim_migrations');
    expect(adoptionBatch?.[0]?.params?.[0]).toBe(release.bundle.path);
  });

  it('rejects partially applied superseded sources before executing a consolidated delta', async () => {
    const release = supersededReleaseFixture();
    const source = release.sourceFiles[0];
    const { d1, queryD1Batch } = successfulExecutor({
      history: [{ ...source, filename: source.path, applied_at: 1 }],
      infrastructureReady: true,
    });
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(release.objects)),
      d1,
      () => 2
    );

    await expect(engine.apply({ databaseId: 'db-id', pin: release.pin })).rejects.toThrow(
      'migration_history_partial_supersedes'
    );
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

describe('ApiMigrationEngine same-version draft append', () => {
  const baselineSql = 'CREATE TABLE account (id TEXT PRIMARY KEY);';
  const appendedSql = 'ALTER TABLE account ADD COLUMN revoked_at INTEGER;';
  const baseline = { path: '001_0_4_0_core_baseline.sql', checksum: digest(baselineSql) };
  const appended = { path: '002_consent_revocations.sql', checksum: digest(appendedSql) };
  const stream = (files: Array<{ path: string; checksum: string }>) => ({
    id: 'core-d1',
    schemaFamily: 'core',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['core', 'tenant_core'],
    files,
  });

  const middleSql = 'ALTER TABLE account ADD COLUMN display_name TEXT;';
  const middle = { path: '002_display_name.sql', checksum: digest(middleSql) };

  function appendRelease(withMiddle = false) {
    const tail = withMiddle ? [middle, appended] : [appended];
    const manifest = `${JSON.stringify({
      formatVersion: 2,
      productVersion: '0.4.2',
      streams: [stream([baseline, ...tail])],
      upgradePaths: [
        { fromProductVersion: '0.4.2', kind: 'draft_append', streams: [stream(tail)] },
      ],
      acceptedMigrationHistory: [stream([baseline, ...tail])],
    })}\n`;
    const manifestDigest = digest(manifest);
    const releaseId = `0.4.2-draft.${manifestDigest.slice(0, 12)}`;
    const base = `releases/${releaseId}/${manifestDigest}/`;
    const pin: MigrationReleasePin = {
      environmentId: 'env-test',
      streamId: 'core-d1',
      releaseId,
      manifestDigest,
      manifestObjectKey: `${base}manifest.json`,
      sourceProductVersion: '0.4.2',
    };
    return {
      pin,
      objects: new Map<string, string>([
        [pin.manifestObjectKey, manifest],
        [`${base}streams/core-d1/${appended.path}`, appendedSql],
        [`${base}streams/core-d1/${middle.path}`, middleSql],
      ]),
    };
  }

  function executor(
    history: Array<{ filename: string; checksum: string; applied_at: number }>,
    pin: MigrationReleasePin
  ) {
    const executed: string[] = [];
    let sentinelFiles = 0;
    const queryD1 = vi.fn(async (_id: string, sql: string): Promise<CloudflareD1QueryResult[]> => {
      if (sql.includes('FROM sqlite_master')) {
        return queryResult([
          { name: 'authrim_migrations' },
          { name: 'tenant_database_migration_state' },
        ]);
      }
      if (sql.startsWith('SELECT filename')) return queryResult(history);
      if (sql.startsWith('SELECT stream_id')) {
        return queryResult(
          sentinelFiles === 0
            ? []
            : [
                {
                  stream_id: pin.streamId,
                  release_id: pin.releaseId,
                  manifest_digest: pin.manifestDigest,
                  applied_file_count: sentinelFiles,
                  state: 'ready',
                  last_filename: appended.path,
                },
              ]
        );
      }
      throw new Error('unexpected_query');
    });
    const queryD1Batch = vi.fn(async (_id: string, batch: readonly MigrationD1Query[]) => {
      for (const query of batch) {
        executed.push(query.sql);
        if (query.sql.includes('INSERT INTO authrim_migrations')) {
          history.push({
            filename: String(query.params?.[0]),
            checksum: String(query.params?.[1]),
            applied_at: 1,
          });
        }
        if (query.sql.includes('INSERT INTO tenant_database_migration_state')) {
          sentinelFiles = Number(query.params?.[3]);
        }
      }
      return batch.map(() => ({ success: true, results: [] }));
    });
    return { d1: { queryD1, queryD1Batch } satisfies MigrationD1Executor, executed };
  }

  it('applies only the appended file to a database that holds the baseline, then stays idempotent', async () => {
    const { pin, objects } = appendRelease();
    const history = [{ filename: baseline.path, checksum: baseline.checksum, applied_at: 1 }];
    const { d1, executed } = executor(history, pin);
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(objects)),
      d1,
      () => 2
    );

    await expect(engine.apply({ databaseId: 'db-id', pin })).resolves.toMatchObject({
      totalFiles: 1,
      appliedFiles: 1,
      skippedFiles: 0,
      lastFilename: appended.path,
    });
    expect(executed.some((sql) => sql.includes('CREATE TABLE account'))).toBe(false);
    expect(executed.some((sql) => sql.includes('revoked_at'))).toBe(true);

    executed.length = 0;
    await expect(engine.apply({ databaseId: 'db-id', pin })).resolves.toMatchObject({
      appliedFiles: 0,
      skippedFiles: 1,
    });
    expect(executed).toHaveLength(0);
  });

  it('refuses a database whose recorded baseline differs from the accepted history', async () => {
    const { pin, objects } = appendRelease();
    const history = [{ filename: baseline.path, checksum: 'f'.repeat(64), applied_at: 1 }];
    const { d1, executed } = executor(history, pin);
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(objects)),
      d1,
      () => 2
    );

    await expect(engine.apply({ databaseId: 'db-id', pin })).rejects.toThrow(
      'migration_history_checksum_mismatch'
    );
    expect(executed).toHaveLength(0);
  });

  async function applyAgainst(
    history: Array<{ filename: string; checksum: string; applied_at: number }>,
    withMiddle = false
  ) {
    const { pin, objects } = appendRelease(withMiddle);
    const { d1, executed } = executor(history, pin);
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(objects)),
      d1,
      () => 2
    );
    return { result: engine.apply({ databaseId: 'db-id', pin }), executed };
  }

  it('never starts a database without the baseline from empty history', async () => {
    const { result, executed } = await applyAgainst([]);
    await expect(result).rejects.toThrow('migration_history_prefix_missing');
    expect(executed.some((sql) => sql.includes('CREATE TABLE account'))).toBe(false);
    expect(executed.some((sql) => sql.includes('revoked_at'))).toBe(false);
  });

  it('refuses a database that skipped a file inside the prefix it claims to hold', async () => {
    const { result, executed } = await applyAgainst(
      [
        { filename: baseline.path, checksum: baseline.checksum, applied_at: 1 },
        { filename: appended.path, checksum: appended.checksum, applied_at: 1 },
      ],
      true
    );
    await expect(result).rejects.toThrow('migration_history_prefix_gap');
    expect(executed.some((sql) => sql.includes('display_name'))).toBe(false);
  });

  it('refuses a recorded row the draft does not contain', async () => {
    const { result } = await applyAgainst([
      { filename: baseline.path, checksum: baseline.checksum, applied_at: 1 },
      { filename: '009_hand_applied.sql', checksum: 'a'.repeat(64), applied_at: 1 },
    ]);
    await expect(result).rejects.toThrow('migration_history_unexpected_file');
  });

  it('refuses a changed middle file of the recorded prefix', async () => {
    const { result, executed } = await applyAgainst(
      [
        { filename: baseline.path, checksum: baseline.checksum, applied_at: 1 },
        { filename: middle.path, checksum: 'b'.repeat(64), applied_at: 1 },
      ],
      true
    );
    await expect(result).rejects.toThrow('migration_history_checksum_mismatch');
    expect(executed).toHaveLength(0);
  });

  it('requires every baseline of the stream to be recorded, judged by name', async () => {
    const lateBaselineSql = 'CREATE TABLE later_series (id TEXT);';
    const lateBaseline = { path: '009_0_5_0_core_baseline.sql', checksum: digest(lateBaselineSql) };
    const manifest = `${JSON.stringify({
      formatVersion: 2,
      productVersion: '0.4.2',
      streams: [stream([baseline, appended, lateBaseline])],
      upgradePaths: [
        { fromProductVersion: '0.4.2', kind: 'draft_append', streams: [stream([appended])] },
      ],
      acceptedMigrationHistory: [stream([baseline, appended, lateBaseline])],
    })}\n`;
    const manifestDigest = digest(manifest);
    const releaseId = `0.4.2-draft.${manifestDigest.slice(0, 12)}`;
    const base = `releases/${releaseId}/${manifestDigest}/`;
    const pin: MigrationReleasePin = {
      environmentId: 'env-test',
      streamId: 'core-d1',
      releaseId,
      manifestDigest,
      manifestObjectKey: `${base}manifest.json`,
      sourceProductVersion: '0.4.2',
    };
    const objects = new Map<string, string>([
      [pin.manifestObjectKey, manifest],
      [`${base}streams/core-d1/${appended.path}`, appendedSql],
    ]);
    const { d1, executed } = executor(
      [{ filename: baseline.path, checksum: baseline.checksum, applied_at: 1 }],
      pin
    );
    const engine = new ApiMigrationEngine(
      new MigrationReleaseArtifactReader(new MemoryStore(objects)),
      d1,
      () => 2
    );
    await expect(engine.apply({ databaseId: 'db-id', pin })).rejects.toThrow(
      'migration_history_prefix_missing'
    );
    expect(executed).toHaveLength(0);
  });
});

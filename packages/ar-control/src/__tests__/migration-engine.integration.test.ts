import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  migrationStreamContract,
  type CloudflareD1QueryResult,
  type MigrationStreamId,
} from '@authrim/ar-lib-core/control-plane';
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

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS_ROOT = join(ROOT_DIR, 'migrations');
const STREAM_DIRECTORIES = {
  'core-d1': join(MIGRATIONS_ROOT, 'core', 'd1'),
  'pii-d1': join(MIGRATIONS_ROOT, 'pii', 'd1'),
  'lookup-d1': join(MIGRATIONS_ROOT, 'lookup', 'd1'),
  'plugin-runner-d1': join(MIGRATIONS_ROOT, 'plugin-runner', 'd1'),
} as const satisfies Partial<Record<MigrationStreamId, string>>;

type SqlValue = string | number | bigint | null | Uint8Array;

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function renderSql(sql: string): string {
  return sql
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

function asSqlValues(values: readonly unknown[] | undefined): SqlValue[] {
  return (values ?? []).map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError('unsupported SQLite parameter');
  });
}

class ByteStore implements ReleaseArtifactStore {
  constructor(private readonly objects: ReadonlyMap<string, Uint8Array>) {}

  async get(key: string): Promise<ReleaseArtifactObject | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
  }
}

class SqliteD1Executor implements MigrationD1Executor {
  constructor(private readonly database: DatabaseSync) {}

  async queryD1(
    _databaseId: string,
    sql: string,
    params?: unknown[]
  ): Promise<CloudflareD1QueryResult[]> {
    const rows = this.database.prepare(sql).all(...asSqlValues(params)) as unknown[];
    return [{ success: true, results: rows }];
  }

  async queryD1Batch(
    _databaseId: string,
    batch: readonly MigrationD1Query[]
  ): Promise<CloudflareD1QueryResult[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = batch.map((query) => {
        const statement = this.database.prepare(query.sql);
        const params = asSqlValues(query.params);
        const rows = /^\s*(?:SELECT|PRAGMA)\b/iu.test(query.sql)
          ? (statement.all(...params) as unknown[])
          : (statement.run(...params), []);
        return { success: true, results: rows };
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function releaseFixture(streamId: keyof typeof STREAM_DIRECTORIES): {
  pin: MigrationReleasePin;
  store: ByteStore;
  expectedFiles: number;
} {
  const directory = STREAM_DIRECTORIES[streamId];
  const contract = migrationStreamContract(streamId);
  const files = readdirSync(directory)
    .filter((file) => /^\d+_.*\.sql$/u.test(file))
    .sort()
    .map((path) => {
      const sql = renderSql(readFileSync(join(directory, path), 'utf8'));
      return { path, checksum: digest(sql), sql };
    });
  const manifest = `${JSON.stringify({
    formatVersion: 2,
    productVersion: '0.4.0',
    streams: [
      {
        id: contract.id,
        schemaFamily: contract.schemaFamily,
        dialect: contract.dialect,
        targetKind: contract.targetKind,
        logicalRoles: contract.logicalRoles,
        files: files.map(({ path, checksum }) => ({ path, checksum })),
      },
    ],
  })}\n`;
  const manifestBytes = new TextEncoder().encode(manifest);
  const manifestDigest = digest(manifestBytes);
  const manifestObjectKey = `releases/0.4.0/${manifestDigest}/manifest.json`;
  const objects = new Map<string, Uint8Array>([[manifestObjectKey, manifestBytes]]);
  for (const file of files) {
    const bytes = new TextEncoder().encode(file.sql);
    objects.set(`releases/0.4.0/${manifestDigest}/streams/${streamId}/${file.path}`, bytes);
  }
  return {
    pin: {
      environmentId: 'env-test',
      streamId,
      releaseId: '0.4.0',
      manifestDigest,
      manifestObjectKey,
    },
    store: new ByteStore(objects),
    expectedFiles: files.length,
  };
}

describe('ApiMigrationEngine current release integration', () => {
  for (const streamId of ['core-d1', 'pii-d1', 'lookup-d1', 'plugin-runner-d1'] as const) {
    it(`applies and idempotently resumes the complete ${streamId} stream`, async () => {
      const fixture = releaseFixture(streamId);
      const database = new DatabaseSync(':memory:');
      try {
        database.exec('PRAGMA foreign_keys = ON');
        const engine = new ApiMigrationEngine(
          new MigrationReleaseArtifactReader(fixture.store),
          new SqliteD1Executor(database),
          () => 1_700_000_000_000
        );
        const first = await engine.apply({ databaseId: 'db-id', pin: fixture.pin });
        expect(first).toMatchObject({
          totalFiles: fixture.expectedFiles,
          appliedFiles: fixture.expectedFiles,
          skippedFiles: 0,
        });
        const second = await engine.apply({ databaseId: 'db-id', pin: fixture.pin });
        expect(second).toMatchObject({
          totalFiles: fixture.expectedFiles,
          appliedFiles: 0,
          skippedFiles: fixture.expectedFiles,
        });
        expect(database.prepare('SELECT COUNT(*) AS count FROM authrim_migrations').get()).toEqual({
          count: fixture.expectedFiles,
        });
      } finally {
        database.close();
      }
    }, 15_000);
  }
});

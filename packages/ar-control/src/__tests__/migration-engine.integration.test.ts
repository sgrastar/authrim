import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS_ROOT = join(ROOT_DIR, 'migrations');
const STREAM_DIRECTORIES: Readonly<Record<string, string>> = {
  'd1-core': MIGRATIONS_ROOT,
  'd1-pii': join(MIGRATIONS_ROOT, 'pii'),
  'd1-lookup': join(MIGRATIONS_ROOT, 'lookup'),
  'd1-plugin-runner': join(MIGRATIONS_ROOT, 'plugin-runner'),
};

type SqlValue = string | number | bigint | null | Uint8Array;

interface ManifestFile {
  path: string;
  checksum: string;
}

interface ManifestStream {
  id: string;
  dialect: string;
  files: ManifestFile[];
}

interface ManifestFixture {
  productVersion: string;
  streams: ManifestStream[];
}

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
  const manifestBytes = new Uint8Array(
    readFileSync(join(MIGRATIONS_ROOT, 'release-manifest.draft.json'))
  );
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ManifestFixture;
  const stream = manifest.streams.find((candidate) => candidate.id === streamId);
  if (!stream || stream.dialect !== 'sqlite')
    throw new Error(`missing fixture stream: ${streamId}`);
  const manifestDigest = digest(manifestBytes);
  const manifestObjectKey = `releases/${manifest.productVersion}/${manifestDigest}/manifest.json`;
  const objects = new Map<string, Uint8Array>([[manifestObjectKey, manifestBytes]]);
  const directory = STREAM_DIRECTORIES[streamId];
  for (const file of stream.files) {
    const bytes = new TextEncoder().encode(
      renderSql(readFileSync(join(directory, file.path), 'utf8'))
    );
    if (digest(bytes) !== file.checksum) throw new Error(`fixture checksum mismatch: ${file.path}`);
    objects.set(
      `releases/${manifest.productVersion}/${manifestDigest}/streams/${streamId}/${file.path}`,
      bytes
    );
  }
  return {
    pin: {
      environmentId: 'env-test',
      streamId,
      releaseId: manifest.productVersion,
      manifestDigest,
      manifestObjectKey,
    },
    store: new ByteStore(objects),
    expectedFiles: stream.files.length,
  };
}

describe('ApiMigrationEngine current release integration', () => {
  for (const streamId of ['d1-core', 'd1-pii', 'd1-lookup', 'd1-plugin-runner'] as const) {
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

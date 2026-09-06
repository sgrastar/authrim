import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { D1BatchExecutionResult, D1BatchStatement } from '../core/cloudflare.js';
import {
  buildMigrationReleaseArtifactPlan,
  buildMigrationReleaseCatalogPlan,
  publishAndActivateMigrationRelease,
  type MigrationReleaseArtifactPlan,
} from '../core/migration-release-publication.js';
import {
  calculateReleaseManifestChecksum,
  generateReleaseMigrationManifest,
  serializeReleaseMigrationManifest,
  writeReleaseMigrationManifest,
} from '../core/release-migrations.js';

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function temporaryRelease(): { migrationsRoot: string; manifestPath: string } {
  const migrationsRoot = mkdtempSync(join(tmpdir(), 'authrim-release-publication-'));
  temporaryDirectories.push(migrationsRoot);
  for (const directory of [
    'core/d1',
    'core/postgresql',
    'admin/d1',
    'control/d1',
    'lookup/d1',
    'pii/d1',
    'pii/postgresql',
    'plugin-runner/d1',
  ]) {
    mkdirSync(join(migrationsRoot, directory), { recursive: true });
  }
  writeFileSync(
    join(migrationsRoot, 'core/d1/001_core.sql'),
    'CREATE TABLE core_record (created_at INTEGER DEFAULT __AUTHRIM_NOW_EPOCH_SECONDS__);\n'
  );
  writeFileSync(join(migrationsRoot, 'pii/d1/001_pii.sql'), 'CREATE TABLE pii_record (id TEXT);\n');
  writeFileSync(
    join(migrationsRoot, 'core/postgresql/001_external.sql'),
    'CREATE TABLE external_record (id TEXT);\n'
  );
  const manifest = generateReleaseMigrationManifest({
    migrationsRoot,
    productVersion: '0.4.0',
  });
  const manifestPath = join(migrationsRoot, 'release-manifest.draft.json');
  writeReleaseMigrationManifest(manifestPath, manifest);
  return { migrationsRoot, manifestPath };
}

function catalogArtifact(
  input: {
    releaseId?: string;
    digest?: string;
    objectKey?: string;
  } = {}
): MigrationReleaseArtifactPlan {
  const releaseId = input.releaseId ?? '0.4.0';
  const manifestDigest = input.digest ?? 'a'.repeat(64);
  return {
    releaseId,
    manifestDigest,
    manifestObjectKey: input.objectKey ?? `releases/${releaseId}/${manifestDigest}/manifest.json`,
    streamIds: ['core-d1', 'pii-d1'],
    objects: [],
  };
}

type SqlValue = string | number | bigint | null | Uint8Array;

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
    throw new TypeError('unsupported test SQL value');
  });
}

function sqliteBatchExecutor(database: DatabaseSync) {
  return async (
    _databaseId: string,
    batch: readonly D1BatchStatement[]
  ): Promise<D1BatchExecutionResult[]> => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const results = batch.map((statement) => {
        const prepared = database.prepare(statement.sql);
        const params = asSqlValues(statement.params);
        const rows = /^\s*SELECT\b/iu.test(statement.sql)
          ? (prepared.all(...params) as unknown[])
          : (prepared.run(...params), []);
        return { success: true as const, results: rows };
      });
      database.exec('COMMIT');
      return results;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
}

function controlDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(resolve(ROOT_DIR, 'migrations/control/d1/001_0_4_0_control_baseline.sql'), 'utf8')
  );
  database.exec(`INSERT INTO control_environments (
    environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
  ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'creating', 1, 1)`);
  return database;
}

describe('migration release artifact publication', () => {
  it('uses canonical manifest bytes and uploads rendered SQLite streams under a digest key', () => {
    const fixture = temporaryRelease();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    const plan = buildMigrationReleaseArtifactPlan(fixture);

    expect(plan.manifestDigest).toBe(calculateReleaseManifestChecksum(manifest));
    expect(plan.releaseId).toBe(`0.4.0-draft.${plan.manifestDigest.slice(0, 12)}`);
    expect(plan.manifestObjectKey).toBe(
      `releases/${plan.releaseId}/${plan.manifestDigest}/manifest.json`
    );
    expect(plan.streamIds).toEqual(['core-d1', 'pii-d1']);
    expect(plan.objects.map((object) => object.objectKey)).toContainEqual(
      expect.stringContaining('core-postgresql')
    );
    const coreSql = plan.objects.find((object) => object.objectKey.endsWith('/001_core.sql'));
    expect(new TextDecoder().decode(coreSql?.bytes)).toContain('unixepoch()');
    expect(plan.objects.at(-1)?.objectKey).toBe(plan.manifestObjectKey);
    expect(new TextDecoder().decode(plan.objects.at(-1)?.bytes)).toBe(
      serializeReleaseMigrationManifest(manifest)
    );
  });

  it('keeps draft release identity stable across equivalent JSON formatting', () => {
    const fixture = temporaryRelease();
    const canonicalPlan = buildMigrationReleaseArtifactPlan(fixture);
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
    writeFileSync(fixture.manifestPath, JSON.stringify(manifest));

    const compactPlan = buildMigrationReleaseArtifactPlan(fixture);

    expect(compactPlan.manifestDigest).toBe(canonicalPlan.manifestDigest);
    expect(compactPlan.releaseId).toBe(canonicalPlan.releaseId);
    expect(compactPlan.manifestObjectKey).toBe(canonicalPlan.manifestObjectKey);
    expect(new TextDecoder().decode(compactPlan.objects.at(-1)?.bytes)).toBe(
      serializeReleaseMigrationManifest(manifest)
    );
  });

  it('rejects changed SQL before any object can be published', () => {
    const fixture = temporaryRelease();
    writeFileSync(join(fixture.migrationsRoot, 'core/d1/001_core.sql'), 'SELECT 1;\n');
    expect(() => buildMigrationReleaseArtifactPlan(fixture)).toThrow(
      'migration_release_sql_checksum_mismatch:core-d1:001_core.sql'
    );
  });

  it('keeps a published release on the canonical product version identity', () => {
    const fixture = temporaryRelease();
    const publishedPath = join(fixture.migrationsRoot, '0.4.0.json');
    writeFileSync(publishedPath, readFileSync(fixture.manifestPath));
    const plan = buildMigrationReleaseArtifactPlan({
      migrationsRoot: fixture.migrationsRoot,
      manifestPath: publishedPath,
    });
    expect(plan.releaseId).toBe('0.4.0');
    expect(plan.manifestObjectKey).toBe(`releases/0.4.0/${plan.manifestDigest}/manifest.json`);
  });

  it('registers only after every object upload succeeds and verifies active rows', async () => {
    const fixture = temporaryRelease();
    const expectedArtifact = buildMigrationReleaseArtifactPlan(fixture);
    const uploaded: string[] = [];
    const verifyBucketOwnership = vi.fn(async () => undefined);
    let registrationStarted = false;
    const result = await publishAndActivateMigrationRelease({
      ...fixture,
      bucketName: 'test-migration-releases',
      controlDatabaseId: '11111111-1111-1111-1111-111111111111',
      environmentId: 'env-test',
      actorId: 'setup:test',
      now: 100,
      verifyBucketOwnership,
      upload: async ({ objectKey }) => {
        expect(registrationStarted).toBe(false);
        uploaded.push(objectKey);
      },
      executeBatch: async (_databaseId, batch) => {
        registrationStarted = true;
        expect(uploaded.at(-1)).toBe(expectedArtifact.manifestObjectKey);
        return batch.map((statement, index) => ({
          success: true,
          results:
            index === batch.length - 1
              ? expectedArtifact.streamIds.map((streamId) => ({
                  stream_id: streamId,
                  release_id: expectedArtifact.releaseId,
                  manifest_digest: expectedArtifact.manifestDigest,
                  manifest_r2_object_key: expectedArtifact.manifestObjectKey,
                  state: 'active',
                  environment_id: 'env-test',
                  issuer: 'urn:authrim:control:env-test',
                }))
              : [],
        }));
      },
    });
    const resultArtifact = result.artifact;
    expect(registrationStarted).toBe(true);
    expect(uploaded).toHaveLength(resultArtifact.objects.length);
    expect(verifyBucketOwnership).toHaveBeenCalledTimes(resultArtifact.objects.length + 1);
  });

  it('does not register a partially uploaded bundle', async () => {
    const fixture = temporaryRelease();
    let uploaded = 0;
    const executeBatch = async (): Promise<D1BatchExecutionResult[]> => {
      throw new Error('catalog registration must not run');
    };
    await expect(
      publishAndActivateMigrationRelease({
        ...fixture,
        bucketName: 'test-migration-releases',
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        environmentId: 'env-test',
        actorId: 'setup:test',
        upload: async () => {
          uploaded += 1;
          if (uploaded === 2) throw new Error('r2_write_failed');
        },
        executeBatch,
      })
    ).rejects.toThrow('r2_write_failed');
    expect(uploaded).toBe(2);
  });

  it('retries a content-addressed R2 object after a transient Cloudflare 524', async () => {
    const fixture = temporaryRelease();
    const expectedArtifact = buildMigrationReleaseArtifactPlan(fixture);
    const attempts = new Map<string, number>();
    const delays: number[] = [];
    const progress: string[] = [];
    const verifyBucketOwnership = vi.fn(async () => undefined);
    const database = controlDatabase();
    try {
      await expect(
        publishAndActivateMigrationRelease({
          ...fixture,
          bucketName: 'test-migration-releases',
          controlDatabaseId: '11111111-1111-1111-1111-111111111111',
          environmentId: 'env-test',
          actorId: 'setup:test',
          verifyBucketOwnership,
          upload: async ({ objectKey }) => {
            const attempt = (attempts.get(objectKey) ?? 0) + 1;
            attempts.set(objectKey, attempt);
            if (objectKey === expectedArtifact.objects[0]?.objectKey && attempt === 1) {
              throw new Error('Failed to fetch /r2/object - 524: A timeout occurred');
            }
          },
          executeBatch: sqliteBatchExecutor(database),
          sleep: async (milliseconds) => {
            delays.push(milliseconds);
          },
          onProgress: (message) => progress.push(message),
        })
      ).resolves.toMatchObject({ artifact: expectedArtifact });
    } finally {
      database.close();
    }

    expect(attempts.get(expectedArtifact.objects[0]!.objectKey)).toBe(2);
    expect(
      expectedArtifact.objects.slice(1).every((object) => attempts.get(object.objectKey) === 1)
    ).toBe(true);
    expect(delays).toEqual([1_000]);
    expect(verifyBucketOwnership).toHaveBeenCalledTimes(expectedArtifact.objects.length + 2);
    expect(progress).toContain(
      `Retrying migration release object ${expectedArtifact.objects[0]!.objectKey} (2/4)`
    );
  });

  it('does not retry a deterministic R2 permission rejection', async () => {
    const fixture = temporaryRelease();
    let attempts = 0;
    let catalogStarted = false;
    await expect(
      publishAndActivateMigrationRelease({
        ...fixture,
        bucketName: 'test-migration-releases',
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        environmentId: 'env-test',
        actorId: 'setup:test',
        upload: async () => {
          attempts += 1;
          throw new Error('Failed to fetch /r2/object - 403: forbidden');
        },
        executeBatch: async () => {
          catalogStarted = true;
          return [];
        },
        sleep: async () => {
          throw new Error('sleep_must_not_run');
        },
      })
    ).rejects.toThrow('403: forbidden');
    expect(attempts).toBe(1);
    expect(catalogStarted).toBe(false);
  });

  it('retries an idempotent catalog batch after throttling or response loss', async () => {
    const fixture = temporaryRelease();
    const expectedArtifact = buildMigrationReleaseArtifactPlan(fixture);
    const delays: number[] = [];
    let attempts = 0;
    await expect(
      publishAndActivateMigrationRelease({
        ...fixture,
        bucketName: 'test-migration-releases',
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        environmentId: 'env-test',
        actorId: 'setup:test',
        upload: async () => {},
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        executeBatch: async (_databaseId, batch) => {
          attempts += 1;
          if (attempts === 1) throw new Error('cloudflare_d1_batch_failed:429');
          if (attempts === 2) throw new Error('response_lost');
          return batch.map((_statement, index) => ({
            success: true,
            results:
              index === batch.length - 1
                ? expectedArtifact.streamIds.map((streamId) => ({
                    stream_id: streamId,
                    release_id: expectedArtifact.releaseId,
                    manifest_digest: expectedArtifact.manifestDigest,
                    manifest_r2_object_key: expectedArtifact.manifestObjectKey,
                    state: 'active',
                    environment_id: 'env-test',
                    issuer: 'urn:authrim:control:env-test',
                  }))
                : [],
          }));
        },
      })
    ).resolves.toMatchObject({ artifact: expectedArtifact });
    expect(attempts).toBe(3);
    expect(delays).toEqual([1_000, 2_000]);
  });

  it('does not retry a rejected catalog request', async () => {
    const fixture = temporaryRelease();
    let attempts = 0;
    await expect(
      publishAndActivateMigrationRelease({
        ...fixture,
        bucketName: 'test-migration-releases',
        controlDatabaseId: '11111111-1111-1111-1111-111111111111',
        environmentId: 'env-test',
        actorId: 'setup:test',
        upload: async () => {},
        sleep: async () => {
          throw new Error('sleep_must_not_run');
        },
        executeBatch: async () => {
          attempts += 1;
          throw new Error('cloudflare_d1_batch_failed:400');
        },
      })
    ).rejects.toThrow('cloudflare_d1_batch_failed:400');
    expect(attempts).toBe(1);
  });
});

describe('migration release catalog activation', () => {
  it('rejects non-content-addressed catalog input and unsafe stream identifiers', () => {
    expect(() =>
      buildMigrationReleaseCatalogPlan({
        environmentId: 'env-test',
        artifact: {
          ...catalogArtifact(),
          manifestObjectKey: 'releases/0.4.0/manifest.json',
        },
        actorId: 'setup:test',
      })
    ).toThrow('migration_release_object_key_invalid');
    expect(() =>
      buildMigrationReleaseCatalogPlan({
        environmentId: 'env-test',
        artifact: { ...catalogArtifact(), streamIds: ['core-d1', '../pii'] },
        actorId: 'setup:test',
      })
    ).toThrow('migration_release_streams_invalid');
  });

  it('atomically activates every SQLite stream and is idempotent', async () => {
    const database = controlDatabase();
    try {
      const artifact = catalogArtifact();
      const plan = buildMigrationReleaseCatalogPlan({
        environmentId: 'env-test',
        artifact,
        actorId: 'setup:test',
        now: 100,
      });
      const execute = sqliteBatchExecutor(database);
      await execute('database-id', plan.statements);
      await execute('database-id', plan.statements);

      expect(
        database
          .prepare(
            `SELECT stream_id, release_id, manifest_digest, state
             FROM control_migration_release_catalog ORDER BY stream_id`
          )
          .all()
      ).toEqual([
        {
          stream_id: 'core-d1',
          release_id: '0.4.0',
          manifest_digest: 'a'.repeat(64),
          state: 'active',
        },
        {
          stream_id: 'pii-d1',
          release_id: '0.4.0',
          manifest_digest: 'a'.repeat(64),
          state: 'active',
        },
      ]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM control_audit_events').get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
    }
  });

  it('creates the minimum environment row before the first release registration', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(ROOT_DIR, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    try {
      const plan = buildMigrationReleaseCatalogPlan({
        environmentId: 'fresh',
        artifact: catalogArtifact(),
        actorId: 'setup:test',
        now: 100,
      });
      await sqliteBatchExecutor(database)('database-id', plan.statements);
      expect(
        database
          .prepare(
            `SELECT environment_id, environment_name, issuer, lifecycle_state
               FROM control_environments`
          )
          .get()
      ).toEqual({
        environment_id: 'fresh',
        environment_name: 'fresh',
        issuer: 'urn:authrim:control:fresh',
        lifecycle_state: 'creating',
      });
    } finally {
      database.close();
    }
  });

  it('rejects a digest replacement for the same release without retiring the active row', async () => {
    const database = controlDatabase();
    try {
      const execute = sqliteBatchExecutor(database);
      const original = buildMigrationReleaseCatalogPlan({
        environmentId: 'env-test',
        artifact: catalogArtifact(),
        actorId: 'setup:test',
        now: 100,
      });
      await execute('database-id', original.statements);
      const replacement = buildMigrationReleaseCatalogPlan({
        environmentId: 'env-test',
        artifact: catalogArtifact({ digest: 'b'.repeat(64) }),
        actorId: 'setup:test',
        now: 200,
      });

      await expect(execute('database-id', replacement.statements)).rejects.toThrow(
        'control_release_catalog_immutable'
      );
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM control_migration_release_catalog
             WHERE state = 'active' AND manifest_digest = ?`
          )
          .get('a'.repeat(64))
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('retires the previous release when a new release is activated', async () => {
    const database = controlDatabase();
    try {
      const execute = sqliteBatchExecutor(database);
      for (const [artifact, now] of [
        [catalogArtifact(), 100],
        [catalogArtifact({ releaseId: '0.5.0', digest: 'b'.repeat(64) }), 200],
      ] as const) {
        const plan = buildMigrationReleaseCatalogPlan({
          environmentId: 'env-test',
          artifact,
          actorId: 'setup:test',
          now,
        });
        await execute('database-id', plan.statements);
      }
      expect(
        database
          .prepare(
            `SELECT release_id, state, COUNT(*) AS count
             FROM control_migration_release_catalog
             GROUP BY release_id, state ORDER BY release_id`
          )
          .all()
      ).toEqual([
        { release_id: '0.4.0', state: 'retired', count: 2 },
        { release_id: '0.5.0', state: 'active', count: 2 },
      ]);
    } finally {
      database.close();
    }
  });
});

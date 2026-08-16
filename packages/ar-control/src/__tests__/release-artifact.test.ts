import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MigrationReleaseArtifactReader,
  type MigrationReleasePin,
  type ReleaseArtifactObject,
  type ReleaseArtifactStore,
} from '../release-artifact.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

class MemoryArtifactStore implements ReleaseArtifactStore {
  readonly reads: string[] = [];

  constructor(private readonly objects: ReadonlyMap<string, string>) {}

  async get(key: string): Promise<ReleaseArtifactObject | null> {
    this.reads.push(key);
    const value = this.objects.get(key);
    if (value === undefined) return null;
    const bytes = new TextEncoder().encode(value);
    return {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }
}

function fixture(sql = 'CREATE TABLE account (id TEXT PRIMARY KEY);') {
  const manifest = `${JSON.stringify({
    formatVersion: 1,
    productVersion: '0.4.0',
    streams: [
      {
        id: 'd1-core',
        dialect: 'sqlite',
        logicalRoles: ['tenant_core'],
        files: [{ path: '001_core.sql', checksum: digest(sql) }],
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
  return { manifest, pin, sql };
}

describe('MigrationReleaseArtifactReader', () => {
  it('loads only the pinned stream after exact manifest and SQL digest validation', async () => {
    const { manifest, pin, sql } = fixture();
    const base = pin.manifestObjectKey.slice(0, pin.manifestObjectKey.lastIndexOf('/') + 1);
    const store = new MemoryArtifactStore(
      new Map([
        [pin.manifestObjectKey, manifest],
        [`${base}streams/d1-core/001_core.sql`, sql],
      ])
    );

    await expect(new MigrationReleaseArtifactReader(store).load(pin)).resolves.toEqual({
      pin,
      productVersion: '0.4.0',
      rollout: {
        databaseExecution: 'setup_then_control',
        workerActivation: 'after_required_databases',
        adminMutationMode: 'read_only',
      },
      files: [{ path: '001_core.sql', checksum: digest(sql), sql }],
    });
    expect(store.reads).toEqual([pin.manifestObjectKey, `${base}streams/d1-core/001_core.sql`]);
  });

  it('accepts the exact database-only Worker compatibility allow-list', async () => {
    const { pin, sql } = fixture();
    const encoded = JSON.stringify({
      formatVersion: 1,
      productVersion: '0.4.0',
      rollout: {
        databaseExecution: 'setup_then_control',
        workerActivation: 'after_required_databases',
        adminMutationMode: 'read_only',
        databaseOnly: { compatibleWorkerVersions: ['0.3.3'] },
      },
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          logicalRoles: ['tenant_core'],
          files: [{ path: '001_core.sql', checksum: digest(sql) }],
        },
      ],
    });
    const nextPin = {
      ...pin,
      manifestDigest: digest(encoded),
      manifestObjectKey: `releases/${pin.releaseId}/${digest(encoded)}/manifest.json`,
    };
    const base = nextPin.manifestObjectKey.slice(0, nextPin.manifestObjectKey.lastIndexOf('/') + 1);
    const store = new MemoryArtifactStore(
      new Map([
        [nextPin.manifestObjectKey, encoded],
        [`${base}streams/d1-core/001_core.sql`, sql],
      ])
    );

    await expect(new MigrationReleaseArtifactReader(store).load(nextPin)).resolves.toMatchObject({
      rollout: { databaseOnly: { compatibleWorkerVersions: ['0.3.3'] } },
    });
  });

  it('accepts only the content-addressed draft identity for an unpublished manifest', async () => {
    const { manifest, pin, sql } = fixture();
    const releaseId = `0.4.0-draft.${pin.manifestDigest.slice(0, 12)}`;
    const draftPin = {
      ...pin,
      releaseId,
      manifestObjectKey: `releases/${releaseId}/${pin.manifestDigest}/manifest.json`,
    };
    const base = draftPin.manifestObjectKey.slice(
      0,
      draftPin.manifestObjectKey.lastIndexOf('/') + 1
    );
    const store = new MemoryArtifactStore(
      new Map([
        [draftPin.manifestObjectKey, manifest],
        [`${base}streams/d1-core/001_core.sql`, sql],
      ])
    );

    await expect(new MigrationReleaseArtifactReader(store).load(draftPin)).resolves.toMatchObject({
      pin: draftPin,
      productVersion: '0.4.0',
    });
    const wrongReleaseId = '0.4.0-draft.000000000000';
    const wrongManifestKey = `releases/${wrongReleaseId}/${pin.manifestDigest}/manifest.json`;
    const wrongStore = new MemoryArtifactStore(new Map([[wrongManifestKey, manifest]]));
    await expect(
      new MigrationReleaseArtifactReader(wrongStore).load({
        ...draftPin,
        releaseId: wrongReleaseId,
        manifestObjectKey: wrongManifestKey,
      })
    ).rejects.toThrow('migration_release_id_mismatch');
  });

  it('allows unrelated external-database streams but rejects selecting them for D1', async () => {
    const sql = 'CREATE TABLE account (id TEXT PRIMARY KEY);';
    const manifest = JSON.stringify({
      formatVersion: 1,
      productVersion: '0.4.0',
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          files: [{ path: '001_core.sql', checksum: digest(sql) }],
        },
        {
          id: 'external-postgres-core',
          dialect: 'postgres',
          files: [{ path: '001_external.sql', checksum: 'a'.repeat(64) }],
        },
      ],
    });
    const manifestKey = `releases/0.4.0/${digest(manifest)}/manifest.json`;
    const base = manifestKey.slice(0, manifestKey.lastIndexOf('/') + 1);
    const store = new MemoryArtifactStore(
      new Map([
        [manifestKey, manifest],
        [`${base}streams/d1-core/001_core.sql`, sql],
      ])
    );
    const basePin: MigrationReleasePin = {
      environmentId: 'env-test',
      streamId: 'd1-core',
      releaseId: '0.4.0',
      manifestDigest: digest(manifest),
      manifestObjectKey: manifestKey,
    };

    await expect(new MigrationReleaseArtifactReader(store).load(basePin)).resolves.toMatchObject({
      files: [{ path: '001_core.sql' }],
    });
    await expect(
      new MigrationReleaseArtifactReader(store).load({
        ...basePin,
        streamId: 'external-postgres-core',
      })
    ).rejects.toThrow('migration_release_stream_dialect_unsupported');
  });

  it('loads a bounded namespaced plugin stream without weakening path traversal checks', async () => {
    const streamId = 'plugin/example.notifier/state';
    const sql = 'CREATE TABLE plugin_state (id TEXT PRIMARY KEY);';
    const manifest = JSON.stringify({
      formatVersion: 1,
      productVersion: '0.4.0',
      streams: [
        {
          id: streamId,
          dialect: 'sqlite',
          files: [{ path: '001_state.sql', checksum: digest(sql) }],
        },
      ],
    });
    const manifestKey = `releases/0.4.0/${digest(manifest)}/manifest.json`;
    const base = manifestKey.slice(0, manifestKey.lastIndexOf('/') + 1);
    const store = new MemoryArtifactStore(
      new Map([
        [manifestKey, manifest],
        [`${base}streams/${streamId}/001_state.sql`, sql],
      ])
    );
    const pin: MigrationReleasePin = {
      environmentId: 'env-test',
      streamId,
      releaseId: '0.4.0',
      manifestDigest: digest(manifest),
      manifestObjectKey: manifestKey,
    };

    await expect(new MigrationReleaseArtifactReader(store).load(pin)).resolves.toMatchObject({
      files: [{ path: '001_state.sql', sql }],
    });
    for (const unsafeStreamId of [
      'plugin//state',
      'plugin/../state',
      '/plugin/state',
      'plugin/state/',
      'plugin/a/b/c/d',
    ]) {
      await expect(
        new MigrationReleaseArtifactReader(store).load({ ...pin, streamId: unsafeStreamId })
      ).rejects.toThrow('migration_release_stream_invalid');
    }
  });

  it('rejects manifest replacement before reading or executing SQL', async () => {
    const { manifest, pin, sql } = fixture();
    const base = pin.manifestObjectKey.slice(0, pin.manifestObjectKey.lastIndexOf('/') + 1);
    const store = new MemoryArtifactStore(
      new Map([
        [pin.manifestObjectKey, manifest.replace('0.4.0', '0.4.1')],
        [`${base}streams/d1-core/001_core.sql`, sql],
      ])
    );

    await expect(new MigrationReleaseArtifactReader(store).load(pin)).rejects.toThrow(
      'migration_release_manifest_digest_mismatch'
    );
    expect(store.reads).toEqual([pin.manifestObjectKey]);
  });

  it('rejects SQL replacement, missing objects, and unsafe object keys', async () => {
    const { manifest, pin } = fixture();
    const base = pin.manifestObjectKey.slice(0, pin.manifestObjectKey.lastIndexOf('/') + 1);
    const replaced = new MemoryArtifactStore(
      new Map([
        [pin.manifestObjectKey, manifest],
        [`${base}streams/d1-core/001_core.sql`, 'SELECT 1;'],
      ])
    );
    await expect(new MigrationReleaseArtifactReader(replaced).load(pin)).rejects.toThrow(
      'migration_release_sql_checksum_mismatch'
    );

    const missing = new MemoryArtifactStore(new Map([[pin.manifestObjectKey, manifest]]));
    await expect(new MigrationReleaseArtifactReader(missing).load(pin)).rejects.toThrow(
      'migration_release_sql_missing'
    );

    await expect(
      new MigrationReleaseArtifactReader(missing).load({
        ...pin,
        manifestObjectKey: '../manifest.json',
      })
    ).rejects.toThrow('migration_artifact_object_key_invalid');
    await expect(
      new MigrationReleaseArtifactReader(missing).load({
        ...pin,
        manifestObjectKey: `releases/0.4.0/${'0'.repeat(64)}/manifest.json`,
      })
    ).rejects.toThrow('migration_release_manifest_object_key_mismatch');
  });

  it('rejects duplicate streams and path traversal in a digest-valid manifest', async () => {
    const manifest = JSON.stringify({
      formatVersion: 1,
      productVersion: '0.4.0',
      streams: [
        { id: 'd1-core', dialect: 'sqlite', files: [] },
        {
          id: 'd1-core',
          dialect: 'sqlite',
          files: [{ path: '../x.sql', checksum: 'a'.repeat(64) }],
        },
      ],
    });
    const manifestKey = `releases/0.4.0/${digest(manifest)}/manifest.json`;
    const store = new MemoryArtifactStore(new Map([[manifestKey, manifest]]));
    await expect(
      new MigrationReleaseArtifactReader(store).load({
        environmentId: 'env-test',
        streamId: 'd1-core',
        releaseId: '0.4.0',
        manifestDigest: digest(manifest),
        manifestObjectKey: manifestKey,
      })
    ).rejects.toThrow('migration_artifact_manifest_invalid');
  });

  it('caps the total verified SQL bundle size before returning it to the engine', async () => {
    const first = 'SELECT 111111;';
    const second = 'SELECT 222222;';
    const manifest = JSON.stringify({
      formatVersion: 1,
      productVersion: '0.4.0',
      streams: [
        {
          id: 'd1-core',
          dialect: 'sqlite',
          files: [
            { path: '001.sql', checksum: digest(first) },
            { path: '002.sql', checksum: digest(second) },
          ],
        },
      ],
    });
    const pin: MigrationReleasePin = {
      environmentId: 'env-test',
      streamId: 'd1-core',
      releaseId: '0.4.0',
      manifestDigest: digest(manifest),
      manifestObjectKey: `releases/0.4.0/${digest(manifest)}/manifest.json`,
    };
    const base = pin.manifestObjectKey.slice(0, pin.manifestObjectKey.lastIndexOf('/') + 1);
    const store = new MemoryArtifactStore(
      new Map([
        [pin.manifestObjectKey, manifest],
        [`${base}streams/d1-core/001.sql`, first],
        [`${base}streams/d1-core/002.sql`, second],
      ])
    );
    await expect(
      new MigrationReleaseArtifactReader(store, { maxReleaseSqlBytes: first.length + 1 }).load(pin)
    ).rejects.toThrow('migration_release_bundle_too_large');
  });
});

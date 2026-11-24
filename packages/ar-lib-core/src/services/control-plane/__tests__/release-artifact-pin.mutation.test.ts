import { describe, expect, it } from 'vitest';
import {
  MIGRATION_ARTIFACT_LIMITS,
  MigrationReleaseArtifactReader,
  R2ReleaseArtifactStore,
  isFreshInstallBaselinePath,
  type MigrationArtifactReaderLimits,
  type MigrationReleasePin,
} from '../release-artifact.js';
import {
  coreStream,
  encoder,
  fileEntry,
  manifestJson,
  publish,
  sha256Hex,
  storedObject,
} from './release-artifact-fixtures.js';

const SQL = 'CREATE TABLE a (id INTEGER);';

async function simple(): Promise<Awaited<ReturnType<typeof publish>>> {
  const entry = await fileEntry('001_a.sql', SQL);
  return publish(manifestJson([coreStream([entry])]), {
    'streams/core-d1/001_a.sql': SQL,
  });
}

async function loadError(
  built: Awaited<ReturnType<typeof publish>>,
  pin: Partial<MigrationReleasePin> = {},
  limits?: MigrationArtifactReaderLimits
): Promise<string> {
  try {
    await new MigrationReleaseArtifactReader(built.store, limits).load({ ...built.pin, ...pin });
  } catch (error) {
    return (error as Error).message;
  }
  return 'no_error';
}

describe('isFreshInstallBaselinePath', () => {
  it.each([
    ['001_0_1_0_core_baseline.sql', true],
    ['12_10_20_30_x_baseline.sql', true],
    ['001_0_1_0__baseline.sql', true],
    ['001_0_1_0_baseline.sql', false],
    ['001_0_1_baseline.sql', false],
    ['x001_0_1_0_core_baseline.sql', false],
    ['001_0_1_0_core_baseline.sqlx', false],
    ['001_0_1_0_core.sql', false],
    ['001_core_baseline.sql', false],
    ['', false],
    ['001_0_1_0_a\nb_baseline.sql', false],
    ['001_0_1_0_a\rb_baseline.sql', false],
    ['001_0_1_0_a b_baseline.sql', false],
    ['001_0_1_0_a b_baseline.sql', false],
  ])('%j -> %s', (path, expected) => {
    expect(isFreshInstallBaselinePath(path)).toBe(expected);
  });
});

describe('MIGRATION_ARTIFACT_LIMITS', () => {
  it('exposes the exact limits', () => {
    expect(MIGRATION_ARTIFACT_LIMITS).toEqual({
      maxManifestBytes: 1024 * 1024,
      maxSqlObjectBytes: 1024 * 1024,
      maxReleaseSqlBytes: 16 * 1024 * 1024,
      maxStreams: 32,
      maxFilesPerStream: 512,
    });
  });
});

describe('R2ReleaseArtifactStore', () => {
  it('returns bodies and maps missing or body-less objects to null', async () => {
    const withBody = { size: 1, body: {}, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) };
    const headOnly = { size: 1 };
    const keys: string[] = [];
    const objects: Record<string, unknown> = { a: withBody, b: headOnly };
    const store = new R2ReleaseArtifactStore({
      get: ((key: string) => {
        keys.push(key);
        return Promise.resolve(objects[key] ?? null);
      }) as never,
    });
    expect(await store.get('a')).toBe(withBody);
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).toBeNull();
    expect(keys).toEqual(['a', 'b', 'c']);
  });
});

describe('MigrationReleaseArtifactReader pin validation', () => {
  it('loads a valid pin and returns the exact release shape', async () => {
    const built = await simple();
    const release = await new MigrationReleaseArtifactReader(built.store).load(built.pin);
    expect(release.pin).toEqual(built.pin);
    expect(release.pin).not.toBe(built.pin);
    expect(release.productVersion).toBe('1.2.3');
    expect(release.rollout).toEqual({
      databaseExecution: 'setup_then_control',
      workerActivation: 'after_required_databases',
      adminMutationMode: 'read_only',
    });
    expect(release.files).toEqual([
      { path: '001_a.sql', checksum: await sha256Hex(SQL), sql: SQL },
    ]);
    expect(release.knownHistory).toEqual([{ path: '001_a.sql', checksum: await sha256Hex(SQL) }]);
    expect(release).not.toHaveProperty('draftAppendBase');
    expect(built.store.requested).toEqual([
      built.pin.manifestObjectKey,
      `${built.base}streams/core-d1/001_a.sql`,
    ]);
  });

  it.each(['bogus', '', 'plugin/a', 'plugin/Acme/x', 'plugin/a/b/c', 'other/a/b', 'plugin//b'])(
    'rejects stream id %j',
    async (streamId) => {
      const built = await simple();
      expect(await loadError(built, { streamId })).toBe('migration_release_stream_invalid');
      expect(built.store.requested).toEqual([]);
    }
  );

  it('accepts namespaced plugin stream ids with 64 char segments but not 65', async () => {
    const long = 'a'.repeat(64);
    const built = await simple();
    // Passes the stream id check and fails later at stream_missing.
    expect(await loadError(built, { streamId: `plugin/${long}/${long}` })).toBe(
      'migration_release_stream_missing'
    );
    expect(await loadError(built, { streamId: `plugin/${long}a/x` })).toBe(
      'migration_release_stream_invalid'
    );
    expect(await loadError(built, { streamId: 'plugin/-a/x' })).toBe(
      'migration_release_stream_invalid'
    );
    expect(await loadError(built, { streamId: 'plugin/a.b-c/x1' })).toBe(
      'migration_release_stream_missing'
    );
  });

  it.each(['', '-1', 'a b', 'a'.repeat(129), '.1', 'a/b'])('rejects release id %j', async (id) => {
    const built = await simple();
    expect(await loadError(built, { releaseId: id })).toBe('migration_release_id_invalid');
  });

  it.each(['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}g`, ''])(
    'rejects manifest digest %j',
    async (digest) => {
      const built = await simple();
      expect(await loadError(built, { manifestDigest: digest })).toBe(
        'migration_release_manifest_digest_invalid'
      );
    }
  );

  it.each(['1.2', 'v1.2.3', '1.2.3.4', '', '1.2.3-', '1.2.3+'])(
    'rejects source product version %j',
    async (sourceProductVersion) => {
      const built = await simple();
      expect(await loadError(built, { sourceProductVersion })).toBe(
        'migration_release_source_version_invalid'
      );
    }
  );

  it('accepts semver pre-release/build source versions (then reports the missing path)', async () => {
    const built = await simple();
    expect(await loadError(built, { sourceProductVersion: '1.0.0-rc.1+build.5' })).toBe(
      'migration_release_upgrade_path_missing'
    );
  });

  it.each([
    ['', 'empty'],
    ['/releases/x', 'leading slash'],
    ['releases/x/', 'trailing slash'],
    ['releases\\x', 'backslash'],
    ['releases//x', 'empty segment'],
    ['releases/./x', 'dot segment'],
    ['releases/../x', 'dotdot segment'],
    ['releases/\u0001x', 'control 0x01'],
    ['releases/\u001fx', 'control 0x1f'],
    ['releases/\u007fx', 'del'],
    [`r${'a'.repeat(1024)}`, 'too long'],
  ])('rejects unsafe manifest object key %j (%s)', async (manifestObjectKey) => {
    const built = await simple();
    expect(await loadError(built, { manifestObjectKey })).toBe(
      'migration_artifact_object_key_invalid'
    );
  });

  it('treats a safe but non-canonical object key as a mismatch (space, 1024 chars)', async () => {
    const built = await simple();
    expect(await loadError(built, { manifestObjectKey: 'releases/ x' })).toBe(
      'migration_release_manifest_object_key_mismatch'
    );
    expect(await loadError(built, { manifestObjectKey: `r${'a'.repeat(1023)}` })).toBe(
      'migration_release_manifest_object_key_mismatch'
    );
    expect(
      await loadError(built, {
        manifestObjectKey: `releases/1.2.3/${built.digest}/other.json`,
      })
    ).toBe('migration_release_manifest_object_key_mismatch');
  });
});

describe('MigrationReleaseArtifactReader object reading', () => {
  it('reports a missing manifest', async () => {
    const built = await simple();
    built.store.objects.delete(built.pin.manifestObjectKey);
    expect(await loadError(built)).toBe('migration_release_manifest_missing');
  });

  it.each([-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects invalid manifest size %s',
    async (size) => {
      const built = await simple();
      built.store.objects.set(built.pin.manifestObjectKey, storedObject(new Uint8Array(4), size));
      expect(await loadError(built)).toBe('migration_artifact_object_too_large');
    }
  );

  it('enforces maxManifestBytes inclusively on declared size', async () => {
    const built = await simple();
    const length = built.store.objects.get(built.pin.manifestObjectKey)?.size ?? 0;
    expect(await loadError(built, {}, { maxManifestBytes: length })).toBe('no_error');
    expect(await loadError(built, {}, { maxManifestBytes: length - 1 })).toBe(
      'migration_artifact_object_too_large'
    );
  });

  it('uses the default 1 MiB manifest cap', async () => {
    const built = await simple();
    built.store.objects.set(
      built.pin.manifestObjectKey,
      storedObject(new Uint8Array(0), 1024 * 1024 + 1)
    );
    expect(await loadError(built)).toBe('migration_artifact_object_too_large');
  });

  it('rejects a manifest whose body differs in size from the declared size', async () => {
    const built = await simple();
    const original = built.store.objects.get(built.pin.manifestObjectKey);
    const length = original?.size ?? 0;
    built.store.objects.set(
      built.pin.manifestObjectKey,
      storedObject(new Uint8Array(length + 1), length)
    );
    expect(await loadError(built)).toBe('migration_artifact_object_size_mismatch');
    built.store.objects.set(
      built.pin.manifestObjectKey,
      storedObject(new Uint8Array(length - 1), length)
    );
    expect(await loadError(built)).toBe('migration_artifact_object_size_mismatch');
  });

  it('rejects a manifest whose digest does not match the pin', async () => {
    const built = await simple();
    const other = encoder.encode('{}');
    built.store.objects.set(built.pin.manifestObjectKey, storedObject(other));
    expect(await loadError(built)).toBe('migration_release_manifest_digest_mismatch');
  });

  it('keeps release id and manifest productVersion consistent (plain and draft ids)', async () => {
    const entry = await fileEntry('001_a.sql', SQL);
    const manifest = manifestJson([coreStream([entry])], {}, '1.2.4');
    const sql = { 'streams/core-d1/001_a.sql': SQL };
    const mismatch = await publish(manifest, sql, { releaseId: '1.2.3' });
    expect(await loadError(mismatch)).toBe('migration_release_id_mismatch');

    const probe = await publish(manifest, sql);
    const draftId = `1.2.4-draft.${probe.digest.slice(0, 12)}`;
    const draft = await publish(manifest, sql, { releaseId: draftId });
    const loaded = await new MigrationReleaseArtifactReader(draft.store).load(draft.pin);
    expect(loaded.productVersion).toBe('1.2.4');
    expect(loaded.pin.releaseId).toBe(draftId);

    const shortDraft = await publish(manifest, sql, {
      releaseId: `1.2.4-draft.${probe.digest.slice(0, 11)}`,
    });
    expect(await loadError(shortDraft)).toBe('migration_release_id_mismatch');
    const longDraft = await publish(manifest, sql, {
      releaseId: `1.2.4-draft.${probe.digest.slice(0, 13)}`,
    });
    expect(await loadError(longDraft)).toBe('migration_release_id_mismatch');
  });

  it('accepts a 128 char release id', async () => {
    const version = `1${'0'.repeat(127)}`;
    const entry = await fileEntry('001_a.sql', SQL);
    const built = await publish(manifestJson([coreStream([entry])], {}, version), {
      'streams/core-d1/001_a.sql': SQL,
    });
    expect(
      (await new MigrationReleaseArtifactReader(built.store).load(built.pin)).productVersion
    ).toBe(version);
  });
});

describe('MigrationReleaseArtifactReader SQL objects', () => {
  async function twoFiles(): Promise<Awaited<ReturnType<typeof publish>>> {
    const a = 'SELECT 1;';
    const b = 'SELECT 22;';
    return publish(
      manifestJson([
        coreStream([await fileEntry('001_a.sql', a), await fileEntry('002_b.sql', b)]),
      ]),
      { 'streams/core-d1/001_a.sql': a, 'streams/core-d1/002_b.sql': b }
    );
  }

  it('loads files in manifest order with their sql', async () => {
    const built = await twoFiles();
    const release = await new MigrationReleaseArtifactReader(built.store).load(built.pin);
    expect(release.files.map((file) => [file.path, file.sql])).toEqual([
      ['001_a.sql', 'SELECT 1;'],
      ['002_b.sql', 'SELECT 22;'],
    ]);
    expect(built.store.requested.slice(1)).toEqual([
      `${built.base}streams/core-d1/001_a.sql`,
      `${built.base}streams/core-d1/002_b.sql`,
    ]);
  });

  it('reports missing sql objects', async () => {
    const built = await twoFiles();
    built.store.objects.delete(`${built.base}streams/core-d1/002_b.sql`);
    expect(await loadError(built)).toBe('migration_release_sql_missing');
  });

  it('enforces the per-object sql cap inclusively', async () => {
    const built = await twoFiles();
    expect(await loadError(built, {}, { maxSqlObjectBytes: 10 })).toBe('no_error');
    expect(await loadError(built, {}, { maxSqlObjectBytes: 9 })).toBe(
      'migration_artifact_object_too_large'
    );
  });

  it('applies the 1 MiB default per-object sql cap', async () => {
    const built = await twoFiles();
    built.store.objects.set(
      `${built.base}streams/core-d1/001_a.sql`,
      storedObject(new Uint8Array(0), 1024 * 1024 + 1)
    );
    expect(await loadError(built)).toBe('migration_artifact_object_too_large');
  });

  it('enforces the cumulative bundle cap inclusively (9 + 10 bytes)', async () => {
    const built = await twoFiles();
    expect(await loadError(built, {}, { maxReleaseSqlBytes: 19 })).toBe('no_error');
    expect(await loadError(built, {}, { maxReleaseSqlBytes: 18 })).toBe(
      'migration_release_bundle_too_large'
    );
    expect(await loadError(built, {}, { maxReleaseSqlBytes: 9 })).toBe(
      'migration_release_bundle_too_large'
    );
  });

  it('detects checksum mismatches', async () => {
    const built = await twoFiles();
    built.store.objects.set(
      `${built.base}streams/core-d1/002_b.sql`,
      storedObject(encoder.encode('SELECT 23;'))
    );
    expect(await loadError(built)).toBe('migration_release_sql_checksum_mismatch');
  });

  it('rejects sql that is not valid UTF-8 even when the checksum matches', async () => {
    const bad = new Uint8Array([0x53, 0xff, 0xfe]);
    const built = await publish(
      manifestJson([coreStream([{ path: '001_a.sql', checksum: await sha256Hex(bad) }])]),
      { 'streams/core-d1/001_a.sql': bad }
    );
    expect(await loadError(built)).toBe('migration_release_sql_invalid_utf8');
  });

  it('preserves a UTF-8 BOM-less multi-byte payload verbatim', async () => {
    const sql = "INSERT INTO t VALUES ('日本語');";
    const built = await publish(manifestJson([coreStream([await fileEntry('001_a.sql', sql)])]), {
      'streams/core-d1/001_a.sql': sql,
    });
    const release = await new MigrationReleaseArtifactReader(built.store).load(built.pin);
    expect(release.files[0]?.sql).toBe(sql);
  });

  it('keeps nested file paths in the object key', async () => {
    const built = await publish(
      manifestJson([coreStream([await fileEntry('sub/001_a.sql', SQL)])]),
      { 'streams/core-d1/sub/001_a.sql': SQL }
    );
    const release = await new MigrationReleaseArtifactReader(built.store).load(built.pin);
    expect(release.files[0]?.path).toBe('sub/001_a.sql');
  });

  it('loads plugin streams through the namespaced id', async () => {
    const { pluginStream } = await import('./release-artifact-fixtures.js');
    const id = 'plugin/acme/runner';
    const built = await publish(
      manifestJson([pluginStream(id, [await fileEntry('001_a.sql', SQL)])]),
      { [`streams/${id}/001_a.sql`]: SQL },
      { pin: { streamId: id } }
    );
    const release = await new MigrationReleaseArtifactReader(built.store).load(built.pin);
    expect(release.files).toHaveLength(1);
    expect(built.store.requested[1]).toBe(`${built.base}streams/${id}/001_a.sql`);
  });

  it('reports a dialect the control plane cannot execute', async () => {
    const built = await publish(
      manifestJson([
        {
          id: 'core-postgresql',
          schemaFamily: 'core',
          dialect: 'postgresql',
          targetKind: 'postgresql-connection',
          logicalRoles: ['core', 'custom', 'policy'],
          files: [],
        },
      ]),
      {},
      { pin: { streamId: 'core-postgresql' } }
    );
    expect(await loadError(built)).toBe('migration_release_stream_dialect_unsupported');
  });

  it('reports a stream missing from the manifest', async () => {
    const built = await simple();
    expect(await loadError(built, { streamId: 'pii-d1' })).toBe('migration_release_stream_missing');
  });
});

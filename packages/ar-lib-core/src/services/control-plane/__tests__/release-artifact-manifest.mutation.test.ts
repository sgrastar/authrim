import { describe, expect, it } from 'vitest';
import { MigrationReleaseArtifactReader } from '../release-artifact.js';
import {
  coreStream,
  encoder,
  fileEntry,
  manifestJson,
  pluginStream,
  publish,
  sha256Hex,
} from './release-artifact-fixtures.js';

const SQL = 'CREATE TABLE a (id INTEGER);';
const CHECKSUM = 'a'.repeat(64);

async function manifestError(
  manifest: unknown,
  pin: { streamId?: string; sourceProductVersion?: string } = {}
): Promise<string> {
  const built = await publish(manifest, {}, { pin });
  try {
    await new MigrationReleaseArtifactReader(built.store).load(built.pin);
  } catch (error) {
    return (error as Error).message;
  }
  return 'no_error';
}

const INVALID = 'migration_artifact_manifest_invalid';

describe('manifest top level', () => {
  it.each([
    ['not json', encoder.encode('{nope')],
    ['invalid utf8', new Uint8Array([0x7b, 0xff, 0x7d])],
    ['array', []],
    ['null', null],
    ['string', 'x'],
    ['formatVersion 1', { ...manifestJson([]), formatVersion: 1 }],
    ['formatVersion missing', { productVersion: '1.2.3', streams: [] }],
    ['productVersion number', { ...manifestJson([]), productVersion: 123 }],
    ['productVersion bad pattern', { ...manifestJson([]), productVersion: '-1' }],
    ['streams missing', { formatVersion: 2, productVersion: '1.2.3' }],
    ['streams object', { ...manifestJson([]), streams: {} }],
  ])('rejects %s', async (_name, manifest) => {
    // The pin's release id is derived from the manifest where possible.
    const built = await publish(manifest, {}, { releaseId: '1.2.3' });
    await expect(new MigrationReleaseArtifactReader(built.store).load(built.pin)).rejects.toThrow(
      INVALID
    );
  });

  it('accepts a leading UTF-8 BOM (ignoreBOM false strips it)', async () => {
    const entry = await fileEntry('001_a.sql', SQL);
    const json = JSON.stringify(manifestJson([coreStream([entry])]));
    const body = encoder.encode(json);
    const bytes = new Uint8Array(body.byteLength + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(body, 3);
    const built = await publish(
      bytes,
      { 'streams/core-d1/001_a.sql': SQL },
      { releaseId: '1.2.3' }
    );
    const release = await new MigrationReleaseArtifactReader(built.store).load(built.pin);
    expect(release.files).toHaveLength(1);
  });
});

describe('streams', () => {
  it('rejects more than 32 streams before parsing them, accepts 32', async () => {
    const ids = Array.from({ length: 33 }, (_, i) => `plugin/acme/s${i}`);
    expect(await manifestError(manifestJson(ids.map(() => ({}))))).toBe(
      'migration_artifact_manifest_limit_exceeded'
    );
    expect(await manifestError(manifestJson(ids.slice(0, 32).map((id) => pluginStream(id))))).toBe(
      'migration_release_stream_missing'
    );
  });

  it('rejects duplicate stream ids', async () => {
    expect(await manifestError(manifestJson([coreStream([]), coreStream([])]))).toBe(
      'migration_artifact_manifest_duplicate_stream'
    );
  });

  it.each([
    ['non record', 5],
    ['unknown id', { ...coreStream([]), id: 'nope' }],
    ['bad plugin id', { ...coreStream([]), id: 'plugin/a' }],
    ['schemaFamily not enum', coreStream([], { schemaFamily: 'zzz' })],
    ['dialect not enum', coreStream([], { dialect: 'mysql' })],
    ['targetKind not enum', coreStream([], { targetKind: 'zzz' })],
    ['logicalRoles not array', { ...coreStream([]), logicalRoles: 'core' }],
    ['logicalRole not enum', coreStream([], { logicalRoles: ['core', 'zzz'] })],
    ['files not array', { ...coreStream([]), files: {} }],
  ])('rejects stream: %s', async (_name, stream) => {
    expect(await manifestError(manifestJson([stream]))).toBe(INVALID);
  });

  it.each([
    ['schemaFamily', { schemaFamily: 'pii' }],
    ['dialect', { dialect: 'postgresql' }],
    ['targetKind', { targetKind: 'postgresql-connection' }],
    ['logicalRoles shorter', { logicalRoles: ['core'] }],
    ['logicalRoles longer', { logicalRoles: ['core', 'tenant_core', 'pii'] }],
    ['logicalRoles order', { logicalRoles: ['tenant_core', 'core'] }],
    ['logicalRoles value', { logicalRoles: ['core', 'pii'] }],
  ])('rejects contract mismatch on %s', async (_name, overrides) => {
    expect(await manifestError(manifestJson([coreStream([], overrides)]))).toBe(
      'migration_artifact_manifest_stream_contract_mismatch'
    );
  });

  it('applies the plugin runner contract to namespaced streams', async () => {
    const id = 'plugin/acme/runner';
    expect(await manifestError(manifestJson([{ ...pluginStream(id), schemaFamily: 'core' }]))).toBe(
      'migration_artifact_manifest_stream_contract_mismatch'
    );
    expect(
      await manifestError(manifestJson([{ ...pluginStream(id), logicalRoles: ['core'] }]))
    ).toBe('migration_artifact_manifest_stream_contract_mismatch');
    expect(
      await manifestError(
        manifestJson([{ ...pluginStream(id), targetKind: 'postgresql-connection' }])
      )
    ).toBe('migration_artifact_manifest_stream_contract_mismatch');
    expect(
      await manifestError(manifestJson([{ ...pluginStream(id), dialect: 'postgresql' }]))
    ).toBe('migration_artifact_manifest_stream_contract_mismatch');
  });

  it('limits files per stream to 512 and rejects duplicates', async () => {
    const files = Array.from({ length: 513 }, (_, i) => ({
      path: `${String(i).padStart(4, '0')}_f.sql`,
      checksum: CHECKSUM,
    }));
    expect(await manifestError(manifestJson([coreStream(files)]))).toBe(
      'migration_artifact_manifest_limit_exceeded'
    );
    expect(await manifestError(manifestJson([coreStream(files.slice(0, 512))]))).toBe(
      'migration_release_sql_missing'
    );
    const dup = { path: '001_a.sql', checksum: CHECKSUM };
    expect(await manifestError(manifestJson([coreStream([dup, dup])]))).toBe(
      'migration_artifact_manifest_duplicate_file'
    );
  });

  it.each([
    ['non record', 'x'],
    ['array', []],
    ['null', null],
    ['no path', { checksum: CHECKSUM }],
    ['path number', { path: 1, checksum: CHECKSUM }],
    ['path not .sql', { path: '001_a.txt', checksum: CHECKSUM }],
    ['path leading underscore', { path: '_a.sql', checksum: CHECKSUM }],
    ['path leading slash', { path: '/a.sql', checksum: CHECKSUM }],
    ['path double dot', { path: 'a..b.sql', checksum: CHECKSUM }],
    ['path parent', { path: '../a.sql', checksum: CHECKSUM }],
    ['path double slash', { path: 'a//b.sql', checksum: CHECKSUM }],
    ['path space', { path: 'a b.sql', checksum: CHECKSUM }],
    ['no checksum', { path: 'a.sql' }],
    ['checksum number', { path: 'a.sql', checksum: 1 }],
    ['checksum short', { path: 'a.sql', checksum: 'a'.repeat(63) }],
    ['checksum long', { path: 'a.sql', checksum: 'a'.repeat(65) }],
    ['checksum uppercase', { path: 'a.sql', checksum: 'A'.repeat(64) }],
  ])('rejects file entry: %s', async (_name, entry) => {
    expect(await manifestError(manifestJson([coreStream([entry])]))).toBe(INVALID);
  });
});

describe('supersedes', () => {
  async function load(
    file: unknown
  ): Promise<Awaited<ReturnType<MigrationReleaseArtifactReader['load']>>> {
    const built = await publish(manifestJson([coreStream([file])]), {
      'streams/core-d1/003_c.sql': SQL,
    });
    return new MigrationReleaseArtifactReader(built.store).load(built.pin);
  }
  const base = { path: '003_c.sql' };

  it('keeps parsed supersedes identities (and strips extra properties)', async () => {
    const checksum = await sha256Hex(SQL);
    const release = await load({
      ...base,
      checksum,
      supersedes: [
        { path: '001_a.sql', checksum: CHECKSUM, extra: 1 },
        { path: '002_b.sql', checksum: 'b'.repeat(64) },
      ],
    });
    expect(release.files[0]?.supersedes).toEqual([
      { path: '001_a.sql', checksum: CHECKSUM },
      { path: '002_b.sql', checksum: 'b'.repeat(64) },
    ]);
    expect(release.knownHistory[0]?.supersedes).toEqual(release.files[0]?.supersedes);
  });

  it('accepts an empty supersedes list and an exact 512 limit', async () => {
    const checksum = await sha256Hex(SQL);
    expect((await load({ ...base, checksum, supersedes: [] })).files[0]?.supersedes).toEqual([]);
    const many = Array.from({ length: 512 }, (_, i) => ({
      path: `${String(i).padStart(4, '0')}_s.sql`,
      checksum: CHECKSUM,
    }));
    expect((await load({ ...base, checksum, supersedes: many })).files[0]?.supersedes).toHaveLength(
      512
    );
  });

  it('rejects non-array and oversized supersedes', async () => {
    const checksum = await sha256Hex(SQL);
    const many = Array.from({ length: 513 }, (_, i) => ({
      path: `${String(i).padStart(4, '0')}_s.sql`,
      checksum: CHECKSUM,
    }));
    for (const supersedes of ['x', {}, many]) {
      await expect(load({ ...base, checksum, supersedes })).rejects.toThrow(
        'migration_artifact_manifest_limit_exceeded'
      );
    }
  });

  it('rejects invalid, duplicate and self-referencing supersedes entries', async () => {
    const checksum = await sha256Hex(SQL);
    await expect(load({ ...base, checksum, supersedes: [{ path: 'x' }] })).rejects.toThrow(INVALID);
    const a = { path: '001_a.sql', checksum: CHECKSUM };
    await expect(load({ ...base, checksum, supersedes: [a, a] })).rejects.toThrow(
      'migration_artifact_manifest_duplicate_file'
    );
    await expect(
      load({ ...base, checksum, supersedes: [{ path: '003_c.sql', checksum: CHECKSUM }] })
    ).rejects.toThrow('migration_artifact_manifest_duplicate_file');
  });
});

describe('upgradePaths', () => {
  it.each([
    ['not an array', {}],
    ['entry not a record', ['x']],
    ['entry null', [null]],
    ['fromProductVersion missing', [{ kind: 'delta', streams: [] }]],
    ['fromProductVersion number', [{ fromProductVersion: 1, kind: 'delta', streams: [] }]],
    ['fromProductVersion bad', [{ fromProductVersion: '1.0', kind: 'delta', streams: [] }]],
    ['kind unknown', [{ fromProductVersion: '1.0.0', kind: 'zzz', streams: [] }]],
    ['kind missing', [{ fromProductVersion: '1.0.0', streams: [] }]],
    ['streams missing', [{ fromProductVersion: '1.0.0', kind: 'delta' }]],
  ])('rejects upgradePaths: %s', async (_name, upgradePaths) => {
    expect(await manifestError(manifestJson([coreStream([])], { upgradePaths }))).toBe(INVALID);
  });

  it('rejects duplicate fromProductVersion', async () => {
    const path = { fromProductVersion: '1.0.0', kind: 'delta', streams: [] };
    expect(
      await manifestError(manifestJson([coreStream([])], { upgradePaths: [path, path] }))
    ).toBe('migration_artifact_manifest_duplicate_upgrade_path');
  });

  it('validates nested streams of upgrade paths', async () => {
    const path = { fromProductVersion: '1.0.0', kind: 'delta', streams: [{ bad: true }] };
    expect(await manifestError(manifestJson([coreStream([])], { upgradePaths: [path] }))).toBe(
      INVALID
    );
  });

  it('accepts every path kind', async () => {
    for (const kind of ['delta', 'bridge']) {
      const path = { fromProductVersion: '1.0.0', kind, streams: [coreStream([])] };
      expect(
        await manifestError(manifestJson([coreStream([])], { upgradePaths: [path] }), {
          sourceProductVersion: '1.0.0',
        })
      ).toBe('no_error');
    }
  });
});

describe('acceptedMigrationHistory', () => {
  it('rejects non-array and validates nested streams / duplicates', async () => {
    expect(
      await manifestError(manifestJson([coreStream([])], { acceptedMigrationHistory: {} }))
    ).toBe(INVALID);
    expect(
      await manifestError(manifestJson([coreStream([])], { acceptedMigrationHistory: [5] }))
    ).toBe(INVALID);
    expect(
      await manifestError(
        manifestJson([coreStream([])], {
          acceptedMigrationHistory: [coreStream([]), coreStream([])],
        })
      )
    ).toBe('migration_artifact_manifest_duplicate_stream');
  });
});

describe('rollout policy', () => {
  const base = {
    databaseExecution: 'setup_then_control',
    workerActivation: 'after_required_databases',
  };
  async function rolloutResult(rollout: unknown): Promise<unknown> {
    const manifest = manifestJson([coreStream([])], { rollout });
    const built = await publish(manifest);
    try {
      return (await new MigrationReleaseArtifactReader(built.store).load(built.pin)).rollout;
    } catch (error) {
      return (error as Error).message;
    }
  }

  it.each(['available', 'read_only'])('accepts adminMutationMode %s', async (mode) => {
    expect(await rolloutResult({ ...base, adminMutationMode: mode })).toEqual({
      ...base,
      adminMutationMode: mode,
    });
  });

  it('accepts databaseOnly with 1 and 100 unique versions', async () => {
    const one = { compatibleWorkerVersions: ['1.0.0'] };
    expect(
      await rolloutResult({ ...base, adminMutationMode: 'available', databaseOnly: one })
    ).toEqual({
      ...base,
      adminMutationMode: 'available',
      databaseOnly: one,
    });
    const hundred = { compatibleWorkerVersions: Array.from({ length: 100 }, (_, i) => `1.0.${i}`) };
    expect(
      await rolloutResult({ ...base, adminMutationMode: 'available', databaseOnly: hundred })
    ).toMatchObject({ databaseOnly: hundred });
  });

  const ok = { ...base, adminMutationMode: 'available' };
  it.each([
    ['string', 'x'],
    ['array', []],
    ['null', null],
    [
      'too few keys',
      { databaseExecution: base.databaseExecution, workerActivation: base.workerActivation },
    ],
    ['unknown key at 3', { ...base, extra: 1 }],
    ['unknown key at 4', { ...ok, extra: 1 }],
    ['5 keys', { ...ok, databaseOnly: { compatibleWorkerVersions: ['1.0.0'] }, extra: 1 }],
    ['databaseExecution', { ...ok, databaseExecution: 'x' }],
    ['workerActivation', { ...ok, workerActivation: 'x' }],
    ['adminMutationMode', { ...ok, adminMutationMode: 'x' }],
    ['adminMutationMode number', { ...ok, adminMutationMode: 1 }],
    ['databaseOnly null', { ...ok, databaseOnly: null }],
    ['databaseOnly string', { ...ok, databaseOnly: 'x' }],
    ['databaseOnly array', { ...ok, databaseOnly: [] }],
    [
      'databaseOnly extra key',
      { ...ok, databaseOnly: { compatibleWorkerVersions: ['1.0.0'], x: 1 } },
    ],
    ['databaseOnly empty', { ...ok, databaseOnly: {} }],
    ['versions not array', { ...ok, databaseOnly: { compatibleWorkerVersions: '1.0.0' } }],
    ['versions empty', { ...ok, databaseOnly: { compatibleWorkerVersions: [] } }],
    [
      'versions 101',
      {
        ...ok,
        databaseOnly: {
          compatibleWorkerVersions: Array.from({ length: 101 }, (_, i) => `1.0.${i}`),
        },
      },
    ],
    ['version number', { ...ok, databaseOnly: { compatibleWorkerVersions: [1] } }],
    ['version bad', { ...ok, databaseOnly: { compatibleWorkerVersions: ['1.0'] } }],
    [
      'versions duplicate',
      { ...ok, databaseOnly: { compatibleWorkerVersions: ['1.0.0', '1.0.0'] } },
    ],
  ])('rejects rollout: %s', async (_name, rollout) => {
    expect(await rolloutResult(rollout)).toBe(INVALID);
  });
});

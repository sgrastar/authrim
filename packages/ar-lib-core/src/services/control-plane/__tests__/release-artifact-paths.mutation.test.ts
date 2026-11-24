import { describe, expect, it } from 'vitest';
import {
  MigrationReleaseArtifactReader,
  type LoadedMigrationRelease,
} from '../release-artifact.js';
import {
  coreStream,
  fileEntry,
  manifestJson,
  publish,
  sha256Hex,
  type BuiltRelease,
} from './release-artifact-fixtures.js';

const BASELINE = '001_1_2_3_core_baseline.sql';
const SQL_A = 'SELECT 1;';
const SQL_B = 'SELECT 2;';
const SQL_C = 'SELECT 3;';
const SQL_BASELINE = 'CREATE TABLE b (id INTEGER);';

async function tryLoad(built: BuiltRelease): Promise<LoadedMigrationRelease | string> {
  try {
    return await new MigrationReleaseArtifactReader(built.store).load(built.pin);
  } catch (error) {
    return (error as Error).message;
  }
}

function sqlObjects(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, sql]) => [`streams/core-d1/${path}`, sql])
  );
}

describe('upgrade path selection', () => {
  async function build(kind: string, from: string, sourceProductVersion: string | undefined) {
    const a = await fileEntry('002_a.sql', SQL_A);
    const manifest = manifestJson([coreStream([await fileEntry(BASELINE, SQL_BASELINE), a])], {
      upgradePaths: [{ fromProductVersion: from, kind, streams: [coreStream([a])] }],
    });
    return publish(manifest, sqlObjects({ [BASELINE]: SQL_BASELINE, '002_a.sql': SQL_A }), {
      pin: { sourceProductVersion },
    });
  }

  it('uses the manifest streams when no source version is pinned', async () => {
    const built = await build('delta', '1.0.0', undefined);
    const release = await tryLoad(built);
    expect(typeof release === 'string' ? release : release.files.map((f) => f.path)).toEqual([
      BASELINE,
      '002_a.sql',
    ]);
  });

  it('uses the selected upgrade path streams for a delta', async () => {
    const built = await build('delta', '1.0.0', '1.0.0');
    const release = await tryLoad(built);
    expect(typeof release === 'string' ? release : release.files.map((f) => f.path)).toEqual([
      '002_a.sql',
    ]);
    expect(typeof release === 'string' ? release : release.knownHistory.map((f) => f.path)).toEqual(
      [BASELINE, '002_a.sql']
    );
  });

  it('accepts a bridge path below the target version', async () => {
    const release = await tryLoad(await build('bridge', '0.9.0', '0.9.0'));
    expect(typeof release).not.toBe('string');
  });

  it('reports a missing upgrade path when the source version is unknown', async () => {
    expect(await tryLoad(await build('delta', '1.0.0', '0.1.0'))).toBe(
      'migration_release_upgrade_path_missing'
    );
  });

  it('rejects a non-draft path that starts at the manifest version', async () => {
    expect(await tryLoad(await build('delta', '1.2.3', '1.2.3'))).toBe(
      'migration_release_upgrade_path_invalid'
    );
    expect(await tryLoad(await build('bridge', '1.2.3', '1.2.3'))).toBe(
      'migration_release_upgrade_path_invalid'
    );
  });

  it('rejects a draft_append path that starts below the manifest version', async () => {
    expect(await tryLoad(await build('draft_append', '1.0.0', '1.0.0'))).toBe(
      'migration_release_upgrade_path_invalid'
    );
  });

  it('requires a draft release id for draft_append', async () => {
    expect(await tryLoad(await build('draft_append', '1.2.3', '1.2.3'))).toBe(
      'migration_release_draft_append_requires_draft_release'
    );
  });
});

describe('known history assembly', () => {
  async function plain(manifestExtra: Record<string, unknown>, streams: unknown[]) {
    return publish(
      manifestJson(streams, manifestExtra),
      sqlObjects({ '001_a.sql': SQL_A, '002_b.sql': SQL_B })
    );
  }

  it('merges stream and upgrade path files, deduplicating identical entries', async () => {
    const a = await fileEntry('001_a.sql', SQL_A);
    const b = await fileEntry('002_b.sql', SQL_B);
    const c = await fileEntry('003_c.sql', SQL_C);
    const built = await plain(
      {
        upgradePaths: [
          { fromProductVersion: '1.0.0', kind: 'delta', streams: [coreStream([b, c])] },
          { fromProductVersion: '1.1.0', kind: 'delta', streams: [coreStream([c])] },
        ],
      },
      [coreStream([a, b])]
    );
    const release = await tryLoad(built);
    expect(typeof release === 'string' ? release : release.knownHistory).toEqual([a, b, c]);
  });

  it('ignores other streams when collecting history', async () => {
    const a = await fileEntry('001_a.sql', SQL_A);
    const other = { path: '001_a.sql', checksum: 'f'.repeat(64) };
    const built = await plain({}, [
      coreStream([a]),
      {
        id: 'pii-d1',
        schemaFamily: 'pii',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['pii', 'tenant_pii'],
        files: [other],
      },
    ]);
    const release = await tryLoad(built);
    expect(typeof release === 'string' ? release : release.knownHistory).toEqual([a]);
  });

  it('fails when the same path has different checksums across paths', async () => {
    const a = await fileEntry('001_a.sql', SQL_A);
    const built = await plain(
      {
        upgradePaths: [
          {
            fromProductVersion: '1.0.0',
            kind: 'delta',
            streams: [coreStream([{ path: '001_a.sql', checksum: 'e'.repeat(64) }])],
          },
        ],
      },
      [coreStream([a])]
    );
    expect(await tryLoad(built)).toBe('migration_artifact_manifest_history_conflict');
  });

  it('prefers acceptedMigrationHistory for the pinned stream, even when empty', async () => {
    const a = await fileEntry('001_a.sql', SQL_A);
    const old = await fileEntry('000_old.sql', 'SELECT 0;');
    const withAccepted = await plain({ acceptedMigrationHistory: [coreStream([old])] }, [
      coreStream([a]),
    ]);
    const first = await tryLoad(withAccepted);
    expect(typeof first === 'string' ? first : first.knownHistory).toEqual([old]);

    const empty = await plain({ acceptedMigrationHistory: [coreStream([])] }, [coreStream([a])]);
    const second = await tryLoad(empty);
    expect(typeof second === 'string' ? second : second.knownHistory).toEqual([]);
  });

  it('falls back to stream files when acceptedMigrationHistory lacks the pinned stream', async () => {
    const a = await fileEntry('001_a.sql', SQL_A);
    const built = await plain(
      {
        acceptedMigrationHistory: [
          {
            id: 'pii-d1',
            schemaFamily: 'pii',
            dialect: 'sqlite',
            targetKind: 'cloudflare-d1',
            logicalRoles: ['pii', 'tenant_pii'],
            files: [],
          },
        ],
      },
      [coreStream([a])]
    );
    const release = await tryLoad(built);
    expect(typeof release === 'string' ? release : release.knownHistory).toEqual([a]);
  });

  it('does not let a conflict hide inside acceptedMigrationHistory', async () => {
    const a = { path: '001_a.sql', checksum: 'c'.repeat(64) };
    const b = { path: '001_a.sql', checksum: 'd'.repeat(64) };
    // A conflict requires two candidates with the same path; within one stream that is a
    // duplicate-file manifest error before history assembly.
    const built = await plain({ acceptedMigrationHistory: [coreStream([a, b])] }, [coreStream([])]);
    expect(await tryLoad(built)).toBe('migration_artifact_manifest_duplicate_file');
  });
});

describe('draft append releases', () => {
  async function draft(options: {
    baseFiles?: unknown[] | null;
    appendFiles: unknown[];
    objects: Record<string, string>;
  }) {
    const probeManifest = (): Record<string, unknown> =>
      manifestJson(options.baseFiles === null ? [] : [coreStream(options.baseFiles ?? [])], {
        upgradePaths: [
          {
            fromProductVersion: '1.2.3',
            kind: 'draft_append',
            streams: [coreStream(options.appendFiles)],
          },
        ],
      });
    const probe = await publish(probeManifest());
    const releaseId = `1.2.3-draft.${probe.digest.slice(0, 12)}`;
    return publish(probeManifest(), sqlObjects(options.objects), {
      releaseId,
      pin: { sourceProductVersion: '1.2.3' },
    });
  }

  it('returns the manifest stream files as draftAppendBase', async () => {
    const baseline = await fileEntry(BASELINE, SQL_BASELINE);
    const a = await fileEntry('002_a.sql', SQL_A);
    const b = await fileEntry('003_b.sql', SQL_B);
    const built = await draft({
      baseFiles: [baseline, a, b],
      appendFiles: [b],
      objects: { '003_b.sql': SQL_B },
    });
    const release = await tryLoad(built);
    if (typeof release === 'string') throw new Error(release);
    expect(release.draftAppendBase).toEqual([baseline, a, b]);
    expect(release.files.map((file) => file.path)).toEqual(['003_b.sql']);
    expect(release.knownHistory).toEqual([baseline, a, b]);
  });

  it('forbids a fresh-install baseline among the executable files', async () => {
    const baseline = await fileEntry(BASELINE, SQL_BASELINE);
    const built = await draft({
      baseFiles: [baseline],
      appendFiles: [baseline],
      objects: { [BASELINE]: SQL_BASELINE },
    });
    expect(await tryLoad(built)).toBe('migration_release_draft_append_baseline_forbidden');
  });

  it('requires the manifest to carry the pinned stream as the draft base', async () => {
    const a = await fileEntry('002_a.sql', SQL_A);
    const built = await draft({
      baseFiles: null,
      appendFiles: [a],
      objects: { '002_a.sql': SQL_A },
    });
    expect(await tryLoad(built)).toBe('migration_release_draft_append_base_missing');
  });

  it('requires every executable file to match the base checksum', async () => {
    const a = await fileEntry('002_a.sql', SQL_A);
    const differentBase = { path: '002_a.sql', checksum: await sha256Hex('SELECT 99;') };
    const mismatch = await draft({
      baseFiles: [differentBase],
      appendFiles: [a],
      objects: { '002_a.sql': SQL_A },
    });
    // A differing checksum is already caught as a history conflict before the base comparison.
    expect(await tryLoad(mismatch)).toBe('migration_artifact_manifest_history_conflict');

    const absent = await draft({
      baseFiles: [await fileEntry('003_b.sql', SQL_B)],
      appendFiles: [a],
      objects: { '002_a.sql': SQL_A },
    });
    expect(await tryLoad(absent)).toBe('migration_release_draft_append_base_mismatch');
  });

  it('accepts an append that carries no executable file', async () => {
    const a = await fileEntry('002_a.sql', SQL_A);
    const built = await draft({ baseFiles: [a], appendFiles: [], objects: {} });
    const release = await tryLoad(built);
    if (typeof release === 'string') throw new Error(release);
    expect(release.files).toEqual([]);
    expect(release.draftAppendBase).toEqual([a]);
  });
});

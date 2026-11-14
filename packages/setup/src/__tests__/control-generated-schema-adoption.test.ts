import { describe, expect, it, vi } from 'vitest';
import {
  adoptControlGeneratedSchemaTargets,
  controlGeneratedHistoryPrefix,
} from '../core/control-generated-schema-adoption.js';
import type { AuthrimLock } from '../core/lock.js';
import type { ReleaseMigrationManifest } from '../core/release-migrations.js';

const sum = (char: string) => char.repeat(64);
const STREAM = [
  { path: '001_0_5_0_pii_baseline.sql', checksum: sum('a') },
  { path: '003_screen_responses.sql', checksum: sum('b') },
  { path: '004_account_pii_erasure_markers.sql', checksum: sum('c') },
  { path: '005_new.sql', checksum: sum('d') },
];
const manifest = {
  productVersion: '0.5.1',
  streams: [{ id: 'pii-d1', files: STREAM }],
} as unknown as ReleaseMigrationManifest;
const CURRENT = sum('0');
const NEW_TARGET = {
  id: 'd1:new:pii-d1',
  streamId: 'pii-d1',
  driver: 'd1',
  binding: 'TEST_TDB_PII_6692B290_PII',
  databaseName: 'test-authrim-tenant-pii-default-db-6692b290',
} as const;

function lock(): AuthrimLock {
  return {
    productVersion: '0.5.1',
    schemaTargets: {
      'd1:old:pii-d1': {
        productVersion: '0.5.1',
        manifestChecksum: sum('e'),
        streamId: 'pii-d1',
        files: STREAM.slice(0, 3),
        appliedBy: 'automatic',
        updatedAt: '2026-11-14T00:00:00.000Z',
      },
    },
  } as unknown as AuthrimLock;
}
const history = (files = STREAM.slice(0, 3)) =>
  files.map((file) => ({ filename: file.path, checksum: file.checksum }));

describe('controlGeneratedHistoryPrefix', () => {
  it('accepts a history equal to a leading run of the stream, in any row order', () => {
    expect(controlGeneratedHistoryPrefix(STREAM, history().reverse())).toEqual(STREAM.slice(0, 3));
  });
  it.each([
    ['a gap', [STREAM[0]!, STREAM[2]!]],
    ['a changed checksum', [STREAM[0]!, { ...STREAM[1]!, checksum: sum('f') }]],
    ['a file outside the stream', [STREAM[0]!, { path: '999_other.sql', checksum: sum('a') }]],
  ])('refuses a history with %s', (_label, files) => {
    expect(controlGeneratedHistoryPrefix(STREAM, history(files))).toBe('history_not_stream_prefix');
  });
  it('refuses an empty history and duplicate rows', () => {
    expect(controlGeneratedHistoryPrefix(STREAM, [])).toBe('history_empty');
    expect(
      controlGeneratedHistoryPrefix(STREAM, [...history([STREAM[0]!]), ...history([STREAM[0]!])])
    ).toBe('history_not_stream_prefix');
  });
});

describe('adoptControlGeneratedSchemaTargets', () => {
  it('records a Control-created database from its own history with a reference checksum', async () => {
    const readHistory = vi.fn(async () => history());
    const result = await adoptControlGeneratedSchemaTargets({
      lock: lock(),
      targets: [NEW_TARGET],
      manifest,
      manifestChecksum: CURRENT,
      readHistory,
      now: () => new Date('2026-11-14T08:00:00.000Z'),
    });
    expect(readHistory).toHaveBeenCalledWith(NEW_TARGET.databaseName);
    expect(result.adopted).toEqual([
      { targetId: NEW_TARGET.id, binding: NEW_TARGET.binding, fileCount: 3 },
    ]);
    expect(result.lock.schemaTargets?.[NEW_TARGET.id]).toEqual({
      productVersion: '0.5.1',
      manifestChecksum: sum('e'),
      streamId: 'pii-d1',
      files: STREAM.slice(0, 3),
      appliedBy: 'automatic',
      updatedAt: '2026-11-14T08:00:00.000Z',
    });
  });

  it('replaces an entry whose file list is empty, keeping its manifest checksum', async () => {
    const base = lock();
    base.schemaTargets![NEW_TARGET.id] = {
      productVersion: '0.5.1',
      manifestChecksum: sum('9'),
      streamId: 'pii-d1',
      files: [],
      appliedBy: 'automatic',
      updatedAt: '2026-11-14T00:00:00.000Z',
    };
    const result = await adoptControlGeneratedSchemaTargets({
      lock: base,
      targets: [NEW_TARGET],
      manifest,
      manifestChecksum: CURRENT,
      readHistory: async () => history(STREAM),
    });
    expect(result.adopted).toEqual([
      { targetId: NEW_TARGET.id, binding: NEW_TARGET.binding, fileCount: 4 },
    ]);
    // A history covering the whole stream is recorded against the current manifest.
    expect(result.lock.schemaTargets?.[NEW_TARGET.id]).toMatchObject({
      manifestChecksum: CURRENT,
      files: STREAM,
    });
  });

  it('replaces a pending-only list that is not a leading run of the stream', async () => {
    const base = lock();
    base.schemaTargets![NEW_TARGET.id] = {
      productVersion: '0.5.1',
      manifestChecksum: sum('9'),
      streamId: 'pii-d1',
      files: [STREAM[3]!],
      appliedBy: 'automatic',
      updatedAt: '2026-11-14T00:00:00.000Z',
    };
    const result = await adoptControlGeneratedSchemaTargets({
      lock: base,
      targets: [NEW_TARGET],
      manifest,
      manifestChecksum: CURRENT,
      readHistory: async () => history(STREAM),
    });
    expect(result.lock.schemaTargets?.[NEW_TARGET.id]?.files).toEqual(STREAM);
  });

  it('does not borrow the checksum of an entry that is not valid evidence', async () => {
    const base = lock();
    base.schemaTargets!['d1:old:pii-d1']!.files = [];
    const result = await adoptControlGeneratedSchemaTargets({
      lock: base,
      targets: [NEW_TARGET],
      manifest,
      manifestChecksum: CURRENT,
      readHistory: async () => history(),
    });
    expect(result.skipped).toEqual([
      { targetId: NEW_TARGET.id, reason: 'reference_checksum_unavailable' },
    ]);
  });

  it('never records a shorter run against the current manifest checksum', async () => {
    const base = lock();
    base.schemaTargets![NEW_TARGET.id] = {
      productVersion: '0.5.1',
      manifestChecksum: CURRENT,
      streamId: 'pii-d1',
      files: [],
      appliedBy: 'automatic',
      updatedAt: '2026-11-14T00:00:00.000Z',
    };
    const borrowed = await adoptControlGeneratedSchemaTargets({
      lock: base,
      targets: [NEW_TARGET],
      manifest,
      manifestChecksum: CURRENT,
      readHistory: async () => history(),
    });
    expect(borrowed.lock.schemaTargets?.[NEW_TARGET.id]?.manifestChecksum).toBe(sum('e'));
    base.schemaTargets!['d1:old:pii-d1']!.manifestChecksum = CURRENT;
    const none = await adoptControlGeneratedSchemaTargets({
      lock: base,
      targets: [NEW_TARGET],
      manifest,
      manifestChecksum: CURRENT,
      readHistory: async () => history(),
    });
    expect(none.skipped).toEqual([
      { targetId: NEW_TARGET.id, reason: 'reference_checksum_unavailable' },
    ]);
  });

  it('leaves recorded targets alone and never reads their history', async () => {
    const readHistory = vi.fn(async () => history());
    const result = await adoptControlGeneratedSchemaTargets({
      lock: lock(),
      targets: [{ ...NEW_TARGET, id: 'd1:old:pii-d1' }],
      manifest,
      manifestChecksum: CURRENT,
      readHistory,
    });
    expect(readHistory).not.toHaveBeenCalled();
    expect(result.adopted).toEqual([]);
  });

  it.each([
    ['a setup-owned binding', { binding: 'PII_DB' }, 'not_control_generated'],
    ['an unknown stream', { streamId: 'other-d1' }, 'stream_unknown'],
  ] as const)('does not adopt %s', async (_label, override, reason) => {
    const readHistory = vi.fn(async () => history());
    const result = await adoptControlGeneratedSchemaTargets({
      lock: lock(),
      targets: [{ ...NEW_TARGET, ...override } as never],
      manifest,
      manifestChecksum: CURRENT,
      readHistory,
    });
    expect(result.adopted).toEqual([]);
    expect(result.skipped).toEqual([{ targetId: NEW_TARGET.id, reason }]);
    expect(result.lock.schemaTargets?.[NEW_TARGET.id]).toBeUndefined();
  });

  it('does not adopt without a recorded target of the same stream or an unreadable history', async () => {
    const noReference = lock();
    noReference.schemaTargets = {};
    expect(
      (
        await adoptControlGeneratedSchemaTargets({
          lock: noReference,
          targets: [NEW_TARGET],
          manifest,
          manifestChecksum: CURRENT,
          readHistory: async () => history(),
        })
      ).skipped
    ).toEqual([{ targetId: NEW_TARGET.id, reason: 'reference_checksum_unavailable' }]);
    expect(
      (
        await adoptControlGeneratedSchemaTargets({
          lock: lock(),
          targets: [NEW_TARGET],
          manifest,
          manifestChecksum: CURRENT,
          readHistory: async () => {
            throw new Error('no table');
          },
        })
      ).skipped
    ).toEqual([{ targetId: NEW_TARGET.id, reason: 'history_unreadable' }]);
  });

  it('does nothing across a product version change', async () => {
    const readHistory = vi.fn(async () => history());
    const result = await adoptControlGeneratedSchemaTargets({
      lock: lock(),
      targets: [NEW_TARGET],
      manifest: { ...manifest, productVersion: '0.6.0' } as ReleaseMigrationManifest,
      manifestChecksum: CURRENT,
      readHistory,
    });
    expect(readHistory).not.toHaveBeenCalled();
    expect(result.adopted).toEqual([]);
  });
});

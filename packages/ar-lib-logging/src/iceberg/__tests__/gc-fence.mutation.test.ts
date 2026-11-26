import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceIcebergMainForGc } from '../gc-fence.js';
import { IcebergCatalogConflictError, IcebergCommitUnknownError } from '../types.js';
import { sha256Hex } from './digest-helpers.js';
import { MemoryCatalog, MemoryStore, record } from './fixtures.js';
import { readerFixture } from './reader-mutation-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

const OPERATION = 'a'.repeat(64);

function setup(catalog = new MemoryCatalog()) {
  const store = new MemoryStore();
  const fence = vi.fn(async () => undefined);
  return {
    catalog,
    store,
    fence,
    run: (operationId = OPERATION) =>
      advanceIcebergMainForGc({ catalog, store, operationId, assertFence: fence }),
  };
}

const idOf = async (operationId: string): Promise<string> =>
  BigInt(`0x${(await sha256Hex(operationId)).slice(0, 13)}`).toString();

describe('advanceIcebergMainForGc', () => {
  it('refuses an operation id that is not 64 lowercase hex characters', async () => {
    const { run, catalog } = setup();
    for (const bad of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      `g${'a'.repeat(63)}`,
      ` ${'a'.repeat(63)}`,
    ]) {
      await expect(run(bad)).rejects.toThrow('Invalid Iceberg GC fence');
    }
    expect(catalog.commitCount).toBe(0);
    for (const ok of ['0'.repeat(64), 'f'.repeat(64), '0123456789abcdef'.repeat(4)]) {
      await expect(setup().run(ok)).resolves.toBeDefined();
    }
  });

  it('adds one empty snapshot to main, named from the operation, with a bumped sequence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_793_000_123_456);
    const { run, catalog, fence } = setup();
    const result = await run();
    expect(result.snapshotId).toBe(await idOf(OPERATION));
    expect(result.sequenceNumber).toBe(1);
    expect(String(result.table.metadata['current-snapshot-id'])).toBe(result.snapshotId);
    const snapshot = catalog.metadata.snapshots?.[0];
    expect(snapshot?.['timestamp-ms']).toBe(1_793_000_123_456);
    expect(snapshot?.summary).toMatchObject({
      operation: 'append',
      'added-data-files': '0',
      'added-records': '0',
      'added-files-size': '0',
      'authrim.gc-fence-id': OPERATION,
    });
    expect(catalog.metadata.snapshots).toHaveLength(1);
    expect(fence).toHaveBeenCalledTimes(3);
  });

  it('carries the totals of the current snapshot, but not the marks of a batch or a delete', async () => {
    const f = readerFixture();
    await f.append('batch-one', [record()]);
    const current = f.catalog.metadata.snapshots?.[0];
    if (!current) throw new Error('expected a snapshot');
    current.summary = {
      ...current.summary,
      'total-records': '7',
      'authrim.position-delete-id': 'x',
      'authrim.position-delete-plan-digest': 'y',
      'authrim.other': 'kept',
    } as never;
    expect(Object.keys(current.summary).some((key) => key.startsWith('authrim.batch-'))).toBe(true);
    await advanceIcebergMainForGc({
      catalog: f.catalog,
      store: f.store,
      operationId: OPERATION,
      assertFence: async () => undefined,
    });
    const fenced = f.catalog.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === String(f.catalog.metadata['current-snapshot-id'])
    );
    const summary = fenced?.summary as Record<string, string>;
    expect(summary['total-records']).toBe('7');
    expect(summary['authrim.other']).toBe('kept');
    expect(
      Object.keys(summary).filter(
        (key) => key.startsWith('authrim.batch-') || key.startsWith('authrim.position-delete-')
      )
    ).toEqual([]);
    expect(summary['authrim.gc-fence-id']).toBe(OPERATION);
    expect(fenced?.['sequence-number']).toBe(2);
    expect(String(fenced?.['parent-snapshot-id'])).toBe(String(current['snapshot-id']));
  });

  it('copies the summary of the current snapshot, not of the first one', async () => {
    const f = readerFixture();
    await f.append('batch-one', [record({ event_id: 'one' })]);
    await f.append('batch-two', [record({ event_id: 'two' })]);
    const [first, second] = f.catalog.metadata.snapshots ?? [];
    if (!first || !second) throw new Error('expected two snapshots');
    (first.summary as Record<string, string>)['total-records'] = 'from-first';
    (second.summary as Record<string, string>)['total-records'] = 'from-second';
    f.catalog.metadata['current-snapshot-id'] = second['snapshot-id'];
    await advanceIcebergMainForGc({
      catalog: f.catalog,
      store: f.store,
      operationId: OPERATION,
      assertFence: async () => undefined,
    });
    const fenced = f.catalog.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === String(f.catalog.metadata['current-snapshot-id'])
    );
    expect((fenced?.summary as Record<string, string>)['total-records']).toBe('from-second');
  });

  it('names its manifest list after the operation and the snapshot it follows', async () => {
    const empty = setup();
    await empty.run();
    expect(
      [...empty.store.objects.keys()].some((key) => key.includes(`gc-${OPERATION}-0-empty`))
    ).toBe(true);
    const f = readerFixture();
    const receipt = await f.append('batch-one', [record({ event_id: 'one' })]);
    await advanceIcebergMainForGc({
      catalog: f.catalog,
      store: f.store,
      operationId: OPERATION,
      assertFence: async () => undefined,
    });
    expect(
      [...f.store.objects.keys()].some((key) =>
        key.includes(`gc-${OPERATION}-1-${receipt.snapshotId}`)
      )
    ).toBe(true);
  });

  it('returns the fence it already made, once, checking the fence a single time', async () => {
    const { run, catalog, fence } = setup();
    const first = await run();
    fence.mockClear();
    const again = await run();
    expect(again.snapshotId).toBe(first.snapshotId);
    expect(again.sequenceNumber).toBe(1);
    expect(catalog.commitCount).toBe(1);
    expect(fence).toHaveBeenCalledTimes(1);
  });

  it('refuses a snapshot with the id of the fence that belongs to another operation', async () => {
    const { run, catalog } = setup();
    await run();
    const snapshot = catalog.metadata.snapshots?.[0];
    (snapshot?.summary as Record<string, string>)['authrim.gc-fence-id'] = 'b'.repeat(64);
    await expect(run()).rejects.toThrow('Iceberg GC fence collision');
    (snapshot?.summary as Record<string, string | undefined>)['authrim.gc-fence-id'] = undefined;
    await expect(run()).rejects.toThrow('Iceberg GC fence collision');
  });

  it('refuses a table that is not a log archive table', async () => {
    const f = setup();
    f.catalog.metadata.schemas[0].fields.pop();
    await expect(f.run()).rejects.toThrow();
    expect(f.catalog.commitCount).toBe(0);
  });

  it('tries three times against competing commits, then gives up', async () => {
    for (const conflicts of [0, 1, 2]) {
      const { run, catalog } = setup();
      let left = conflicts;
      catalog.beforeCommit = async () => {
        if (left-- > 0) throw new IcebergCatalogConflictError('CAS conflict');
      };
      await expect(run()).resolves.toMatchObject({ sequenceNumber: 1 });
    }
    const { run, catalog } = setup();
    const before = vi.fn(async () => {
      throw new IcebergCatalogConflictError('CAS conflict');
    });
    catalog.beforeCommit = before;
    await expect(run()).rejects.toThrow('Iceberg GC fence changed repeatedly');
    await expect(run()).rejects.toBeInstanceOf(IcebergCatalogConflictError);
    expect(before).toHaveBeenCalledTimes(6);
  });

  it('confirms a commit whose outcome was unknown, and reports one that did not happen', async () => {
    const lost = setup();
    lost.catalog.afterCommit = async () => {
      throw new IcebergCommitUnknownError('response lost');
    };
    await expect(lost.run()).resolves.toMatchObject({ sequenceNumber: 1 });
    expect(lost.catalog.commitCount).toBe(1);

    const never = setup();
    never.catalog.beforeCommit = async () => {
      throw new IcebergCommitUnknownError('disconnected');
    };
    await expect(never.run()).rejects.toThrow('disconnected');
    await expect(never.run()).rejects.toBeInstanceOf(IcebergCommitUnknownError);
  });

  it('passes on any other commit error', async () => {
    const { run, catalog } = setup();
    catalog.beforeCommit = async () => {
      throw new Error('storage exploded');
    };
    await expect(run()).rejects.toThrow('storage exploded');
  });

  it('refuses to report a fence the table does not show afterwards', async () => {
    const { run, catalog } = setup();
    catalog.afterCommit = async () => {
      catalog.metadata.snapshots = [];
    };
    await expect(run()).rejects.toThrow('Iceberg GC fence outcome unavailable');
    await expect(run()).rejects.toBeInstanceOf(IcebergCommitUnknownError);
  });

  it('does not commit when the fence of the caller refuses', async () => {
    const { catalog, store } = setup();
    await expect(
      advanceIcebergMainForGc({
        catalog,
        store,
        operationId: OPERATION,
        assertFence: async () => {
          throw new Error('stale fence');
        },
      })
    ).rejects.toThrow('stale fence');
    expect(catalog.commitCount).toBe(0);
    const late = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fence lost'));
    await expect(
      advanceIcebergMainForGc({ catalog, store, operationId: OPERATION, assertFence: late })
    ).rejects.toThrow('fence lost');
    expect(catalog.commitCount).toBe(0);
  });
});

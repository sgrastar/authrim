import { afterEach, describe, expect, it, vi } from 'vitest';
import { IcebergLifecycle } from '../lifecycle.js';
import { IcebergCommitUnknownError } from '../types.js';
import { ScheduledIcebergWriter } from '../writer.js';
import { LOCATION, MemoryCatalog, MemoryJournal, MemoryStore, record } from './fixtures.js';

function fixture() {
  const catalog = new MemoryCatalog();
  const store = new MemoryStore();
  const journal = new MemoryJournal();
  const writer = new ScheduledIcebergWriter({
    catalog,
    store,
    journal,
    storageGeneration: 'new-generation',
    tableLocation: LOCATION,
  });
  const lifecycle = new IcebergLifecycle({ catalog, store, tableLocation: LOCATION });
  const append = (batchId: string) =>
    writer.appendBatch({
      batchId,
      fence: journal.activeFence,
      records: [record({ event_id: batchId })],
    });
  return { catalog, store, lifecycle, append };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Iceberg snapshot lifecycle boundaries', () => {
  it('advances main for a DR pin, strips batch receipts, and reuses only the same live pin', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const f = fixture();
    const source = await f.append('batch-one');
    const pinned = await f.lifecycle.pinSnapshot('dr-copy', source.snapshotId, 60_000);
    const ref = pinned.metadata.refs?.['dr-copy'];
    const clone = pinned.metadata.snapshots?.find(
      (snapshot) => String(snapshot['snapshot-id']) === String(ref?.['snapshot-id'])
    );
    const main = pinned.metadata.snapshots?.find(
      (snapshot) =>
        String(snapshot['snapshot-id']) === String(pinned.metadata['current-snapshot-id'])
    );
    expect(ref).toMatchObject({ type: 'tag', 'max-ref-age-ms': 60_000 });
    expect(clone?.summary?.['authrim.dr-source-snapshot-id']).toBe(source.snapshotId);
    expect(Object.keys(clone?.summary ?? {}).some((key) => key.startsWith('authrim.batch-'))).toBe(
      false
    );
    expect(Object.keys(main?.summary ?? {}).some((key) => key.startsWith('authrim.batch-'))).toBe(
      false
    );
    expect(String(pinned.metadata['current-snapshot-id'])).not.toBe(source.snapshotId);

    const commits = f.catalog.commitCount;
    expect(await f.lifecycle.pinSnapshot('dr-copy', source.snapshotId, 60_000)).toEqual(pinned);
    expect(f.catalog.commitCount).toBe(commits);
    await expect(
      f.lifecycle.pinSnapshot('dr-copy', String(pinned.metadata['current-snapshot-id']), 60_000)
    ).rejects.toThrow('identity collision');
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_060_000);
    await expect(f.lifecycle.pinSnapshot('dr-copy', source.snapshotId, 60_000)).rejects.toThrow(
      'lease expired'
    );
    expect(f.catalog.commitCount).toBe(commits);
  });

  it('reconciles an accepted DR pin whose commit acknowledgement was lost', async () => {
    const f = fixture();
    const source = await f.append('batch-one');
    const before = f.catalog.commitCount;
    f.catalog.afterCommit = async () => {
      throw new IcebergCommitUnknownError('response lost');
    };

    const result = await f.lifecycle.pinSnapshot('dr-recovery', source.snapshotId);
    expect(result.metadata.refs?.['dr-recovery']?.type).toBe('tag');
    expect(f.catalog.commitCount).toBe(before + 1);
  });

  it('does not report an unaccepted DR pin as committed', async () => {
    const f = fixture();
    const source = await f.append('batch-one');
    const before = f.catalog.commitCount;
    f.catalog.beforeCommit = async () => {
      throw new IcebergCommitUnknownError('request lost');
    };

    await expect(f.lifecycle.pinSnapshot('dr-recovery', source.snapshotId)).rejects.toThrow(
      'request lost'
    );
    expect(f.catalog.metadata.refs?.['dr-recovery']).toBeUndefined();
    expect(f.catalog.commitCount).toBe(before);
  });

  it('rejects a changed pin identity and reconciles a lost release acknowledgement', async () => {
    const f = fixture();
    const source = await f.append('batch-one');
    const pinned = await f.lifecycle.pinSnapshot('dr-release', source.snapshotId);
    const pinId = String(pinned.metadata.refs?.['dr-release']?.['snapshot-id']);
    const before = f.catalog.commitCount;

    await expect(
      f.lifecycle.releaseSnapshotPin('dr-release', pinId, 'another-table')
    ).rejects.toThrow('table identity mismatch');
    await expect(
      f.lifecycle.releaseSnapshotPin('dr-release', source.snapshotId, source.tableUuid)
    ).rejects.toThrow('pin changed');
    expect(f.catalog.commitCount).toBe(before);
    expect(f.catalog.metadata.refs?.['dr-release']).toBeDefined();

    f.catalog.afterCommit = async () => {
      throw new IcebergCommitUnknownError('response lost');
    };
    await f.lifecycle.releaseSnapshotPin('dr-release', pinId, source.tableUuid);
    expect(f.catalog.metadata.refs?.['dr-release']).toBeUndefined();
    expect(f.catalog.commitCount).toBe(before + 1);
    await f.lifecycle.releaseSnapshotPin('dr-release', pinId, source.tableUuid);
    expect(f.catalog.commitCount).toBe(before + 1);
  });

  it('preserves a DR pin when its release commit is not accepted', async () => {
    const f = fixture();
    const source = await f.append('batch-one');
    const pinned = await f.lifecycle.pinSnapshot('dr-release', source.snapshotId);
    const pinId = String(pinned.metadata.refs?.['dr-release']?.['snapshot-id']);
    const before = f.catalog.commitCount;
    f.catalog.beforeCommit = async () => {
      throw new IcebergCommitUnknownError('request lost');
    };

    await expect(
      f.lifecycle.releaseSnapshotPin('dr-release', pinId, source.tableUuid)
    ).rejects.toThrow('request lost');
    expect(f.catalog.metadata.refs?.['dr-release']).toBeDefined();
    expect(f.catalog.commitCount).toBe(before);
  });

  it('requires source deletion evidence before releasing a pending batch pin', async () => {
    const f = fixture();
    const receipt = await f.append('batch-one');
    const before = f.catalog.commitCount;
    await expect(f.lifecycle.releaseBatchPin(receipt, false as true)).rejects.toThrow(
      'Source deletion must precede batch pin release'
    );
    await expect(
      f.lifecycle.releaseBatchPin({ ...receipt, pin: 'dr-not-a-batch-pin' }, true)
    ).rejects.toThrow('Source deletion must precede batch pin release');
    expect(f.catalog.metadata.refs?.[receipt.pin]).toBeDefined();
    expect(f.catalog.commitCount).toBe(before);
  });

  it('removes an expired DR tag without expiring a pending recovery snapshot', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const f = fixture();
    const receipt = await f.append('batch-one');
    f.catalog.metadata.refs ??= {};
    f.catalog.metadata.refs['dr-expired'] = {
      type: 'tag',
      'snapshot-id': Number(receipt.snapshotId),
      'max-ref-age-ms': 1,
    };
    const before = f.catalog.commitCount;
    vi.spyOn(Date, 'now').mockReturnValue(now + 2);

    expect(await f.lifecycle.expireSnapshots(now + 3)).toBe(0);
    expect(f.catalog.metadata.refs?.['dr-expired']).toBeUndefined();
    expect(f.catalog.metadata.refs?.[receipt.pin]).toBeDefined();
    expect(f.catalog.metadata.snapshots?.map((s) => String(s['snapshot-id']))).toContain(
      receipt.snapshotId
    );
    expect(f.catalog.commitCount).toBe(before + 1);
  });

  it('keeps a listed snapshot through expiration and rejects an invalid protection list', async () => {
    const f = fixture();
    const first = await f.append('batch-one');
    const second = await f.append('batch-two');
    await f.lifecycle.releaseBatchPin(first, true);
    await f.lifecycle.releaseBatchPin(second, true);
    const before = f.catalog.commitCount;
    const cutoff = Date.now() + 1;

    await expect(f.lifecycle.expireSnapshots(cutoff, [], 128, ['missing'])).rejects.toThrow(
      'Invalid protected snapshot inventory'
    );
    expect(f.catalog.commitCount).toBe(before);
    expect(await f.lifecycle.expireSnapshots(cutoff, [], 128, [first.snapshotId])).toBe(0);
    expect(f.catalog.metadata.snapshots?.map((s) => String(s['snapshot-id']))).toContain(
      first.snapshotId
    );
    expect(await f.lifecycle.expireSnapshots(cutoff)).toBe(1);
    expect(f.catalog.metadata.snapshots?.map((s) => String(s['snapshot-id']))).not.toContain(
      first.snapshotId
    );
  });
});

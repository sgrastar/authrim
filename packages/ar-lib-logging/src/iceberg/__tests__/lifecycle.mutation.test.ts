import { afterEach, describe, expect, it, vi } from 'vitest';
import { IcebergLifecycle } from '../lifecycle.js';
import { LOG_ARCHIVE_PENDING_PIN_TTL_MS } from '../writer.js';
import { IcebergCatalogConflictError, IcebergCommitUnknownError } from '../types.js';
import { LOCATION, record } from './fixtures.js';
import { NOW_MS, readerFixture } from './reader-mutation-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

const message = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: Error) => error.message
  );

async function ready() {
  const f = readerFixture();
  const receipt = await f.append('batch-one', [record({ event_id: 'one' })]);
  const lifecycle = new IcebergLifecycle({
    catalog: f.catalog,
    store: f.store,
    tableLocation: LOCATION,
  });
  return { ...f, receipt, lifecycle };
}

describe('table access', () => {
  it('refuses a table that is not at the configured location, or not a log archive table', async () => {
    const f = readerFixture();
    const elsewhere = new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: 's3://other/loc',
    });
    expect(await message(elsewhere.expireSnapshots(0))).toBe(
      'Iceberg lifecycle table location changed'
    );
    const broken = new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: LOCATION,
    });
    f.catalog.metadata.schemas[0].fields.pop();
    expect(await message(broken.expireSnapshots(0))).not.toBe('resolved');
  });
});

describe('pinSnapshot: what it refuses', () => {
  it('refuses a pin name that is main, pending, empty, too long or not word characters', async () => {
    const { lifecycle, receipt } = await ready();
    for (const ref of [
      '',
      'main',
      'authrim-pending-abc',
      'bad name',
      'a/b',
      'a.b',
      'x'.repeat(129),
    ]) {
      expect(await message(lifecycle.pinSnapshot(ref, receipt.snapshotId))).toBe(
        'Invalid DR snapshot pin'
      );
    }
    for (const snapshotId of ['', 'abc', '-1', '1.5', '12a', ' 12']) {
      expect(await message(lifecycle.pinSnapshot('dr-ok', snapshotId))).toBe(
        'Invalid DR snapshot pin'
      );
    }
    expect(await message(lifecycle.pinSnapshot('x'.repeat(128), receipt.snapshotId))).toBe(
      'resolved'
    );
    expect(await message(lifecycle.pinSnapshot('authrim-other', receipt.snapshotId))).toBe(
      'resolved'
    );
  });

  it('refuses a lease that is not an integer from one to a day', async () => {
    const { lifecycle, receipt } = await ready();
    for (const maxAgeMs of [0, -1, 1.5, Number.NaN, LOG_ARCHIVE_PENDING_PIN_TTL_MS + 1, 2 ** 53]) {
      expect(await message(lifecycle.pinSnapshot('dr-lease', receipt.snapshotId, maxAgeMs))).toBe(
        'Invalid DR pin lease'
      );
    }
    expect(await message(lifecycle.pinSnapshot('dr-one', receipt.snapshotId, 1))).toBe('resolved');
    expect(
      await message(
        lifecycle.pinSnapshot('dr-day', receipt.snapshotId, LOG_ARCHIVE_PENDING_PIN_TTL_MS)
      )
    ).toBe('resolved');
  });

  it('refuses a snapshot the table does not have', async () => {
    const { lifecycle } = await ready();
    expect(await message(lifecycle.pinSnapshot('dr-x', '999999'))).toBe('DR snapshot missing');
  });

  it('refuses a name that another kind of ref or another snapshot already holds', async () => {
    const { lifecycle, receipt, catalog } = await ready();
    const first = await lifecycle.pinSnapshot('dr-x', receipt.snapshotId);
    expect(first.metadata.refs?.['dr-x']).toBeDefined();
    const other = await ready();
    expect(await message(other.lifecycle.pinSnapshot('dr-y', other.receipt.snapshotId))).toBe(
      'resolved'
    );
    expect(
      await message(lifecycle.pinSnapshot('dr-x', String(first.metadata['current-snapshot-id'])))
    ).toBe('DR pin identity collision');
    const ref = catalog.metadata.refs?.['dr-x'];
    if (ref) ref.type = 'branch';
    expect(await message(lifecycle.pinSnapshot('dr-x', receipt.snapshotId))).toBe(
      'DR pin identity collision'
    );
  });

  it('refuses to reuse a pin whose lease has run out, and reuses one that has not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    const { lifecycle, receipt } = await ready();
    await lifecycle.pinSnapshot('dr-x', receipt.snapshotId, 1000);
    vi.setSystemTime(NOW_MS + 999);
    expect(await message(lifecycle.pinSnapshot('dr-x', receipt.snapshotId, 1000))).toBe('resolved');
    vi.setSystemTime(NOW_MS + 1000);
    expect(await message(lifecycle.pinSnapshot('dr-x', receipt.snapshotId, 1000))).toBe(
      'DR pin lease expired'
    );
  });

  it('refuses when the table has no current snapshot to advance', async () => {
    const { lifecycle, receipt, catalog } = await ready();
    catalog.metadata['current-snapshot-id'] = undefined;
    expect(await message(lifecycle.pinSnapshot('dr-x', receipt.snapshotId))).toBe(
      'DR current snapshot missing'
    );
  });
});

describe('pinSnapshot: what it writes', () => {
  it('adds a copy of the source tagged for DR, and a barrier snapshot after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    const { lifecycle, receipt, catalog } = await ready();
    const before = catalog.metadata['last-sequence-number'];
    const pinned = await lifecycle.pinSnapshot('dr-x', receipt.snapshotId, 5000);
    const ref = pinned.metadata.refs?.['dr-x'];
    const clone = pinned.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === String(ref?.['snapshot-id'])
    );
    expect(ref).toMatchObject({ type: 'tag', 'max-ref-age-ms': 5000 });
    expect(clone).toMatchObject({ 'sequence-number': before + 1, 'timestamp-ms': NOW_MS });
    expect(String(clone?.['parent-snapshot-id'])).toBe(receipt.snapshotId);
    expect(clone?.summary).toMatchObject({
      operation: 'append',
      'added-data-files': '0',
      'added-records': '0',
      'added-files-size': '0',
      'authrim.dr-source-snapshot-id': receipt.snapshotId,
    });
    const main = pinned.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === String(pinned.metadata['current-snapshot-id'])
    );
    expect(main?.['sequence-number']).toBe(before + 2);
    expect(main?.summary).toMatchObject({
      operation: 'append',
      'added-data-files': '0',
      'added-records': '0',
      'added-files-size': '0',
    });
    expect(pinned.metadata['last-sequence-number']).toBe(before + 2);
  });

  it('confirms a commit whose outcome was unknown only if the pin is there', async () => {
    const lost = await ready();
    lost.catalog.afterCommit = async () => {
      throw new IcebergCommitUnknownError('response lost');
    };
    const pinned = await lost.lifecycle.pinSnapshot('dr-x', lost.receipt.snapshotId);
    expect(pinned.metadata.refs?.['dr-x']).toBeDefined();
    const never = await ready();
    never.catalog.beforeCommit = async () => {
      throw new IcebergCommitUnknownError('disconnected');
    };
    expect(await message(never.lifecycle.pinSnapshot('dr-x', never.receipt.snapshotId))).toBe(
      'disconnected'
    );
    const other = await ready();
    other.catalog.beforeCommit = async () => {
      throw new Error('storage exploded');
    };
    expect(await message(other.lifecycle.pinSnapshot('dr-x', other.receipt.snapshotId))).toBe(
      'storage exploded'
    );
  });
});

describe('releaseSnapshotPin', () => {
  it('refuses a name that is main or not word characters', async () => {
    const { lifecycle, receipt } = await ready();
    for (const ref of ['main', '', 'bad name', 'a/b', 'x'.repeat(129)]) {
      expect(
        await message(lifecycle.releaseSnapshotPin(ref, receipt.snapshotId, receipt.tableUuid))
      ).toBe('Invalid snapshot pin release');
    }
  });

  it('refuses another table, does nothing for a pin that is gone, and refuses one that has moved', async () => {
    const { lifecycle, receipt, catalog } = await ready();
    const pinned = await lifecycle.pinSnapshot('dr-x', receipt.snapshotId);
    const pinnedId = String(pinned.metadata.refs?.['dr-x']?.['snapshot-id']);
    expect(await message(lifecycle.releaseSnapshotPin('dr-x', pinnedId, 'another-table'))).toBe(
      'Snapshot pin table identity mismatch'
    );
    expect(
      await message(lifecycle.releaseSnapshotPin('dr-gone', pinnedId, receipt.tableUuid))
    ).toBe('resolved');
    expect(await message(lifecycle.releaseSnapshotPin('dr-x', '12345', receipt.tableUuid))).toBe(
      'Snapshot pin changed'
    );
    const commits = catalog.commitCount;
    expect(await message(lifecycle.releaseSnapshotPin('dr-x', pinnedId, receipt.tableUuid))).toBe(
      'resolved'
    );
    expect(catalog.metadata.refs?.['dr-x']).toBeUndefined();
    expect(catalog.commitCount).toBe(commits + 1);
  });

  it('fences the release against main and the pin, and confirms an unknown outcome', async () => {
    const { lifecycle, receipt, catalog } = await ready();
    const pinned = await lifecycle.pinSnapshot('dr-x', receipt.snapshotId);
    const pinnedId = String(pinned.metadata.refs?.['dr-x']?.['snapshot-id']);
    const spy = vi.spyOn(catalog, 'commit');
    await lifecycle.releaseSnapshotPin('dr-x', pinnedId, receipt.tableUuid);
    const update = spy.mock.calls[0]?.[0];
    expect(update?.requirements).toHaveLength(3);
    expect(update?.requirements[0]).toStrictEqual({
      type: 'assert-table-uuid',
      uuid: receipt.tableUuid,
    });
    expect(update?.requirements[1]).toMatchObject({ type: 'assert-ref-snapshot-id', ref: 'main' });
    expect(update?.requirements[2]).toMatchObject({ type: 'assert-ref-snapshot-id', ref: 'dr-x' });
    expect(String((update?.requirements[2] as { 'snapshot-id': unknown })['snapshot-id'])).toBe(
      pinnedId
    );
    expect(String((update?.requirements[1] as { 'snapshot-id': unknown })['snapshot-id'])).toBe(
      String(catalog.metadata['current-snapshot-id'])
    );
    expect(update?.updates).toEqual([{ action: 'remove-snapshot-ref', 'ref-name': 'dr-x' }]);

    const lost = await ready();
    const lostPin = await lost.lifecycle.pinSnapshot('dr-x', lost.receipt.snapshotId);
    lost.catalog.afterCommit = async () => {
      throw new IcebergCommitUnknownError('response lost');
    };
    await expect(
      lost.lifecycle.releaseSnapshotPin(
        'dr-x',
        String(lostPin.metadata.refs?.['dr-x']?.['snapshot-id']),
        lost.receipt.tableUuid
      )
    ).resolves.toBeUndefined();
    const stuck = await ready();
    const stuckPin = await stuck.lifecycle.pinSnapshot('dr-x', stuck.receipt.snapshotId);
    stuck.catalog.beforeCommit = async () => {
      throw new IcebergCommitUnknownError('disconnected');
    };
    expect(
      await message(
        stuck.lifecycle.releaseSnapshotPin(
          'dr-x',
          String(stuckPin.metadata.refs?.['dr-x']?.['snapshot-id']),
          stuck.receipt.tableUuid
        )
      )
    ).toBe('disconnected');
    const conflict = await ready();
    const conflictPin = await conflict.lifecycle.pinSnapshot('dr-x', conflict.receipt.snapshotId);
    conflict.catalog.beforeCommit = async () => {
      throw new IcebergCatalogConflictError('CAS conflict');
    };
    expect(
      await message(
        conflict.lifecycle.releaseSnapshotPin(
          'dr-x',
          String(conflictPin.metadata.refs?.['dr-x']?.['snapshot-id']),
          conflict.receipt.tableUuid
        )
      )
    ).toBe('CAS conflict');
  });

  it('releases a batch pin only after the source rows were deleted', async () => {
    const { lifecycle, receipt } = await ready();
    expect(await message(lifecycle.releaseBatchPin(receipt, false as never))).toBe(
      'Source deletion must precede batch pin release'
    );
    expect(await message(lifecycle.releaseBatchPin({ ...receipt, pin: 'dr-x' }, true))).toBe(
      'Source deletion must precede batch pin release'
    );
    expect(await message(lifecycle.releaseBatchPin(receipt, true))).toBe('resolved');
  });
});

describe('maintenance budgets', () => {
  it('rewrites one to sixteen distinct files, and refuses other lists', async () => {
    const { lifecycle } = await ready();
    const invalid = 'Invalid rewrite file budget';
    expect(await message(lifecycle.rewriteFiles([]))).toBe(invalid);
    expect(
      await message(lifecycle.rewriteFiles(Array.from({ length: 17 }, (_, i) => `f${i}`)))
    ).toBe(invalid);
    expect(await message(lifecycle.rewriteFiles(['a', 'a']))).toBe(invalid);
    expect(await message(lifecycle.rewriteFiles(['a', 'b', 'a']))).toBe(invalid);
    expect(
      await message(lifecycle.rewriteFiles(Array.from({ length: 16 }, (_, i) => `f${i}`)))
    ).not.toBe(invalid);
    expect(await message(lifecycle.rewriteFiles(['only']))).not.toBe(invalid);
  });

  it('expires snapshots only for an integer cutoff of zero or more and a budget of 1 to 1000', async () => {
    const { lifecycle } = await ready();
    for (const cutoff of [-1, 1.5, Number.NaN, 2 ** 53]) {
      expect(await message(lifecycle.expireSnapshots(cutoff))).toBe(
        'Invalid snapshot expiration cutoff'
      );
    }
    for (const budget of [0, -1, 1001, 1.5, Number.NaN]) {
      expect(await message(lifecycle.expireSnapshots(0, [], budget))).toBe(
        'Invalid snapshot expiry budget'
      );
    }
    for (const budget of [1, 1000]) {
      expect(await message(lifecycle.expireSnapshots(0, [], budget))).toBe('resolved');
    }
    expect(await message(lifecycle.expireSnapshots(0))).toBe('resolved');
  });

  it('refuses more than 128 anchors or 4096 protected snapshot ids, or ids the table does not have', async () => {
    const { lifecycle, receipt } = await ready();
    const anchor = {
      tableUuid: receipt.tableUuid,
      snapshotId: receipt.snapshotId,
      sequenceNumber: 1,
    };
    expect(
      await message(
        lifecycle.expireSnapshots(
          0,
          Array.from({ length: 129 }, () => anchor)
        )
      )
    ).toBe('Iceberg anchor budget exceeded');
    expect(
      await message(
        lifecycle.expireSnapshots(
          0,
          Array.from({ length: 128 }, () => anchor)
        )
      )
    ).toBe('resolved');
    const invalid = 'Invalid protected snapshot inventory';
    expect(await message(lifecycle.expireSnapshots(0, [], 128, ['999']))).toBe(invalid);
    expect(await message(lifecycle.expireSnapshots(0, [], 128, ['abc']))).toBe(invalid);
    expect(
      await message(
        lifecycle.expireSnapshots(
          0,
          [],
          128,
          Array.from({ length: 4097 }, () => receipt.snapshotId)
        )
      )
    ).toBe(invalid);
    expect(await message(lifecycle.expireSnapshots(0, [], 128, [receipt.snapshotId]))).toBe(
      'resolved'
    );
    expect(
      await message(
        lifecycle.expireSnapshots(
          0,
          [],
          128,
          Array.from({ length: 4096 }, () => receipt.snapshotId)
        )
      )
    ).toBe('resolved');
  });

  it('removes only pins past their lease, and expires nothing the table still needs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    const { lifecycle, receipt, catalog, append } = await ready();
    await lifecycle.pinSnapshot('dr-short', receipt.snapshotId, 1000);
    await lifecycle.pinSnapshot('dr-long', receipt.snapshotId, 3_600_000);
    await append('batch-two', [record({ event_id: 'two' })]);
    vi.setSystemTime(NOW_MS + 999);
    await lifecycle.expireSnapshots(0);
    expect(catalog.metadata.refs?.['dr-short']).toBeDefined();
    vi.setSystemTime(NOW_MS + 1000);
    await lifecycle.expireSnapshots(0);
    expect(catalog.metadata.refs?.['dr-short']).toBeUndefined();
    expect(catalog.metadata.refs?.['dr-long']).toBeDefined();
    expect(String(catalog.metadata.refs?.main?.['snapshot-id'])).toBe(
      String(catalog.metadata['current-snapshot-id'])
    );
  });

  it('keeps snapshots newer than the cutoff, the oldest first within the budget', async () => {
    const { lifecycle, receipt, catalog, append } = await ready();
    const released = await append('batch-two', [record({ event_id: 'two' })]);
    const third = await append('batch-three', [record({ event_id: 'three' })]);
    await lifecycle.releaseBatchPin(receipt, true);
    await lifecycle.releaseBatchPin(released, true);
    await lifecycle.releaseBatchPin(third, true);
    const times = (catalog.metadata.snapshots ?? []).map((s) => s['timestamp-ms']);
    expect(times).toHaveLength(3);
    const cutoff = Math.max(...times) + 1;
    expect(await lifecycle.expireSnapshots(Math.min(...times))).toBe(0);
    expect(await lifecycle.expireSnapshots(cutoff, [], 1)).toBe(1);
    expect(await lifecycle.expireSnapshots(cutoff, [], 5)).toBe(1);
    expect(catalog.metadata.snapshots).toHaveLength(1);
    expect(String(catalog.metadata.snapshots?.[0]?.['snapshot-id'])).toBe(
      String(catalog.metadata['current-snapshot-id'])
    );
  });
});

describe('deleteExpiredRows', () => {
  it('deletes nothing when nothing has expired, and says how many it deleted otherwise', async () => {
    const f = readerFixture();
    await f.append('rows', [
      record({ event_id: 'keep' }),
      record({ event_id: 'gone-1', expires_at: NOW_MS - 1 }),
      record({ event_id: 'gone-2', expires_at: 0 }),
    ]);
    const lifecycle = new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: LOCATION,
    });
    const scope = { tenantKey: 'tenant-test', sourceDatasets: ['core.event_log'], nowMs: NOW_MS };
    expect(await lifecycle.deleteExpiredRows({ ...scope, nowMs: -1 })).toBe(0);
    expect(f.catalog.commitCount).toBe(1);
    expect(await lifecycle.deleteExpiredRows(scope)).toBe(2);
    expect(f.catalog.commitCount).toBe(2);
    expect((await f.read()).records.map((row) => row.event_id)).toEqual(['keep']);
    expect(await lifecycle.deleteExpiredRows(scope)).toBe(0);
  });
});

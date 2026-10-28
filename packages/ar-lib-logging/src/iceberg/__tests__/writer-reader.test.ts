import { describe, expect, it, vi } from 'vitest';
import { ScheduledIcebergWriter } from '../writer.js';
import { readSnapshotRecords } from '../reader.js';
import { IcebergLifecycle } from '../lifecycle.js';
import {
  IcebergBatchCollisionError,
  IcebergBudgetError,
  IcebergCommitUnknownError,
} from '../types.js';
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
  const append = (batchId = 'batch-one', rows = [record()]) =>
    writer.appendBatch({ batchId, fence: journal.activeFence, records: rows });
  const read = async (extra: Partial<Parameters<typeof readSnapshotRecords>[0]> = {}) =>
    readSnapshotRecords({
      table: await catalog.loadTable(),
      store,
      tenantKey: 'tenant-test',
      sourceDatasets: ['core.event_log'],
      nowMs: 1793000005000,
      ...extra,
    });
  return {
    catalog,
    store,
    journal,
    writer,
    append,
    read,
    lifecycle: new IcebergLifecycle({ catalog, store, tableLocation: LOCATION }),
  };
}
describe('scheduled Iceberg storage', () => {
  it('writes real Parquet and Avro, then scans the exact committed snapshot', async () => {
    const f = fixture();
    const receipt = await f.append();
    expect(receipt.sequenceNumber).toBe(1);
    expect(f.catalog.metadata.refs?.[receipt.pin]?.type).toBe('tag');
    const parquet = [...f.store.objects].find(([path]) => path.endsWith('.parquet'))?.[1].bytes;
    expect(new TextDecoder().decode(parquet?.subarray(0, 4))).toBe('PAR1');
    expect((await f.read()).records).toEqual([record()]);
  });
  it('does not remove a batch recovery pin if main changes during its release commit', async () => {
    const f = fixture();
    const first = await f.append();
    const second = await f.append('batch-two', [record({ event_id: 'event-two' })]);
    f.catalog.beforeCommit = async () => {
      f.catalog.metadata['current-snapshot-id'] = first.snapshotId;
      if (f.catalog.metadata.refs?.main)
        f.catalog.metadata.refs.main['snapshot-id'] = first.snapshotId;
    };
    await expect(f.lifecycle.releaseBatchPin(second, true)).rejects.toThrow('CAS conflict');
    expect(String(f.catalog.metadata.refs?.[second.pin]?.['snapshot-id'])).toBe(second.snapshotId);
  });
  it('reconciles an accepted commit whose response was lost without a second append', async () => {
    const f = fixture();
    f.catalog.afterCommit = async () => {
      throw new IcebergCommitUnknownError('response lost');
    };
    const receipt = await f.append();
    expect(receipt.sequenceNumber).toBe(1);
    expect(f.catalog.commitCount).toBe(1);
    await f.append();
    expect(f.catalog.commitCount).toBe(1);
    expect((await f.read()).records).toHaveLength(1);
  });
  it('retains a pending journal for an unknown unaccepted commit and reuses fixed artifact keys', async () => {
    const f = fixture();
    f.catalog.beforeCommit = async () => {
      throw new IcebergCommitUnknownError('disconnected');
    };
    await expect(f.append()).rejects.toBeInstanceOf(IcebergCommitUnknownError);
    expect(f.journal.commits).toBe(0);
    const paths = [...f.store.objects.keys()];
    f.catalog.beforeCommit = undefined;
    await f.append();
    expect([...f.store.objects.keys()]).toEqual(paths);
    expect((await f.read()).records).toHaveLength(1);
  });
  it('resumes after a file write failure without replacing the existing data file', async () => {
    const f = fixture();
    f.store.failManifestOnce = true;
    await expect(f.append()).rejects.toThrow('manifest PUT');
    const paths = [...f.store.objects.keys()];
    expect(paths).toHaveLength(1);
    await f.append();
    expect([...f.store.objects.keys()].filter((path) => path.endsWith('.parquet'))).toEqual(paths);
  });
  it('keeps concurrent appends and writes different manifest lists after a CAS conflict', async () => {
    const f = fixture();
    let first = true;
    f.catalog.beforeCommit = async () => {
      if (first) {
        first = false;
        await f.append('concurrent', [record({ event_id: 'event-two' })]);
      }
    };
    await f.append();
    expect(f.catalog.commitCount).toBe(2);
    expect((await f.read()).records.map((r) => r.event_id).sort()).toEqual([
      'event-one',
      'event-two',
    ]);
    const lists = [...f.store.objects.keys()].filter((path) => path.includes('/snap-'));
    expect(lists).toHaveLength(3);
    expect(new Set(lists).size).toBe(3);
  });
  it('rejects a reused batch ID with a different payload and a stale DB fence', async () => {
    const f = fixture();
    await f.append();
    await expect(f.append('batch-one', [record({ action: 'different' })])).rejects.toBeInstanceOf(
      IcebergBatchCollisionError
    );
    await expect(
      f.writer.appendBatch({ batchId: 'new-batch', fence: 'expired', records: [record()] })
    ).rejects.toThrow('stale fence');
    expect(f.catalog.commitCount).toBe(1);
  });
  it('rejects old generations, unknown plaintext columns, and oversized inputs before writing files', async () => {
    const f = fixture();
    await expect(f.append('old', [record({ storage_generation: 'old' })])).rejects.toThrow('scope');
    const unknown = { ...record(), private_email: 'never-export' };
    await expect(f.append('plaintext', [unknown])).rejects.toThrow('fields');
    await expect(
      f.append('large', [record({ detail_ciphertext: 'x'.repeat(4 * 1024 * 1024) })])
    ).rejects.toBeInstanceOf(IcebergBudgetError);
    expect(f.store.objects.size).toBe(0);
  });
  it('deduplicates logical event identity before results and rejects differing payloads', async () => {
    const f = fixture();
    await f.append();
    await f.append('retry-copy');
    expect((await f.read()).records).toHaveLength(1);
    await f.append('collision', [record({ payload_hmac: 'b'.repeat(64) })]);
    await expect(f.read()).rejects.toBeInstanceOf(IcebergBatchCollisionError);
  });
  it('filters tenant/dataset/TTL and rejects stale catalog watermarks without truncation', async () => {
    const f = fixture();
    await f.append('expired', [record({ expires_at: 1793000005000 })]);
    await f.append('other-tenant', [record({ tenant_key: 'other' })]);
    await f.append('retained', [record({ event_id: 'retained' })]);
    expect((await f.read()).records.map((r) => r.event_id)).toEqual(['retained']);
    await expect(
      f.read({
        watermark: { tableUuid: f.catalog.metadata['table-uuid'], minimumSequenceNumber: 4 },
      })
    ).rejects.toThrow('watermark');
    expect((await f.read({ limits: { maxRows: 1 } })).records).toHaveLength(1);
    await f.append('second-retained', [record({ event_id: 'retained-two' })]);
    await expect(f.read({ limits: { maxRows: 1 } })).rejects.toBeInstanceOf(IcebergBudgetError);
  });
  it('deletes expired current rows, rewrites files, and protects pending/DR snapshots', async () => {
    const f = fixture();
    const first = await f.append('expiry', [
      record({ expires_at: 1793000005000 }),
      record({ event_id: 'keep' }),
    ]);
    const captured = await f.lifecycle.pinSnapshot('dr-capture', first.snapshotId);
    const drSnapshotId = String(captured.metadata.refs?.['dr-capture']?.['snapshot-id']);
    expect(
      await f.lifecycle.deleteExpiredRows({
        tenantKey: 'tenant-test',
        sourceDatasets: ['core.event_log'],
        nowMs: 1793000005000,
      })
    ).toBe(1);
    expect((await f.read()).records.map((r) => r.event_id)).toEqual(['keep']);
    const files = [...f.store.objects.keys()].filter(
      (path) => path.endsWith('.parquet') && path.includes('/data/authrim-')
    );
    await f.lifecycle.rewriteFiles(files);
    expect((await f.read()).records.map((r) => r.event_id)).toEqual(['keep']);
    await f.lifecycle.expireSnapshots(Date.now() + 1);
    expect(
      f.catalog.metadata.snapshots?.some((s) => String(s['snapshot-id']) === first.snapshotId)
    ).toBe(true);
    await f.lifecycle.releaseBatchPin(first, true);
    await f.lifecycle.releaseSnapshotPin('dr-capture', drSnapshotId, first.tableUuid);
    await f.lifecycle.expireSnapshots(Date.now() + 1);
    expect(f.catalog.metadata.snapshots).toHaveLength(1);
    expect((await f.read()).records.map((r) => r.event_id)).toEqual(['keep']);
  });
});

it('preserves intermediate ancestors until a pending lost-ack batch can reconcile', async () => {
  const f = fixture();
  const mark = f.journal.markCommitted.bind(f.journal);
  f.journal.markCommitted = async () => {
    throw new Error('journal acknowledgment lost');
  };
  await expect(f.append('pending-a')).rejects.toThrow('acknowledgment lost');
  const checkpoint = f.journal.entries.get('pending-a');
  expect(checkpoint?.state).toBe('planned');
  f.journal.markCommitted = mark;
  const b = await f.append('completed-b', [record({ event_id: 'b' })]);
  const c = await f.append('completed-c', [record({ event_id: 'c' })]);
  await f.lifecycle.releaseBatchPin(b, true);
  await f.lifecycle.releaseBatchPin(c, true);
  expect(await f.lifecycle.expireSnapshots(Date.now() + 1)).toBe(0);
  expect(f.catalog.metadata.snapshots).toHaveLength(3);
  const recovered = await f.append('pending-a');
  expect(recovered.snapshotId).toBe(checkpoint?.snapshotId);
  expect(f.catalog.commitCount).toBe(5); // 3 appends plus 2 pin releases; no duplicate append
  await f.lifecycle.releaseBatchPin(recovered, true);
  expect(await f.lifecycle.expireSnapshots(Date.now() + 1)).toBe(2);
});

it('prunes foreign tenant files from manifest bounds before fetching their Parquet bytes', async () => {
  const f = fixture();
  await f.append('foreign', [record({ tenant_key: 'foreign-tenant' })]);
  const foreignPath = [...f.store.objects.keys()].find((path) => path.endsWith('.parquet'));
  await f.append('ours');
  const read = vi.spyOn(f.store, 'read');
  expect((await f.read()).records).toHaveLength(1);
  expect(read.mock.calls.some(([path]) => path === foreignPath)).toBe(false);
});

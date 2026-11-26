import { afterEach, describe, expect, it, vi } from 'vitest';
import { icebergManifests, splitManifestEntries } from 'icebird/src/manifest.js';
import { LOG_ARCHIVE_PENDING_PIN_TTL_MS, ScheduledIcebergWriter } from '../writer.js';
import { safeParquetFooter } from '../read-safety.js';
import { sha256Hex } from './digest-helpers.js';
import {
  IcebergBatchCollisionError,
  IcebergBudgetError,
  IcebergCatalogConflictError,
  IcebergCommitUnknownError,
} from '../types.js';
import {
  LOCATION,
  MemoryCatalog,
  MemoryJournal,
  MemoryStore,
  pipelineMetadata,
  record,
} from './fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

const NOW = 1_793_000_000_000;

function build(options: { pipeline?: boolean; maxCommitAttempts?: number } = {}) {
  const catalog = new MemoryCatalog();
  if (options.pipeline) catalog.metadata = pipelineMetadata(true);
  const store = new MemoryStore();
  const journal = new MemoryJournal();
  const writer = new ScheduledIcebergWriter({
    catalog,
    store,
    journal,
    storageGeneration: 'new-generation',
    tableLocation: LOCATION,
    limits:
      options.maxCommitAttempts === undefined
        ? undefined
        : { maxCommitAttempts: options.maxCommitAttempts },
  });
  const append = (batchId: string, records = [record()]) =>
    writer.appendBatch({ batchId, fence: journal.activeFence, records });
  return { catalog, store, journal, writer, append };
}

const summaryOf = (f: ReturnType<typeof build>, snapshotId: string) =>
  f.catalog.metadata.snapshots?.find((s) => String(s['snapshot-id']) === snapshotId)?.summary as
    | Record<string, string>
    | undefined;

describe('what a committed batch leaves behind', () => {
  it('returns a receipt naming the batch, its digest, snapshot, pin and lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const f = build();
    const receipt = await f.append('batch-one', [
      record({ event_id: 'a' }),
      record({ event_id: 'b' }),
    ]);
    expect(receipt).toMatchObject({
      batchId: 'batch-one',
      batchDigest: receipt.batchDigest,
      tableUuid: 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
      snapshotId: receipt.snapshotId,
      recordCount: 2,
      sequenceNumber: 1,
      pinExpiresAt: NOW + LOG_ARCHIVE_PENDING_PIN_TTL_MS,
      pin: `authrim-pending-${await sha256Hex('batch-one')}`,
    });
    expect(receipt.batchDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.snapshotId).toMatch(/^[1-9]\d*$/);
    expect(f.journal.entries.get('batch-one')).toMatchObject({
      state: 'committed',
      sequenceNumber: 1,
      batchDigest: receipt.batchDigest,
    });
  });

  it('tags the snapshot with the batch and pins it for a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const f = build();
    const receipt = await f.append('batch-one', [
      record({ event_id: 'a' }),
      record({ event_id: 'b' }),
    ]);
    const summary = summaryOf(f, receipt.snapshotId);
    expect(summary).toMatchObject({
      'authrim.batch-id': 'batch-one',
      'authrim.batch-digest': receipt.batchDigest,
      'authrim.batch-records': '2',
      'added-records': '2',
      'added-data-files': '1',
    });
    const snapshot = f.catalog.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === receipt.snapshotId
    );
    expect(snapshot?.['timestamp-ms']).toBe(NOW);
    const ref = f.catalog.metadata.refs?.[receipt.pin];
    expect(ref).toMatchObject({ type: 'tag', 'max-ref-age-ms': LOG_ARCHIVE_PENDING_PIN_TTL_MS });
    expect(String(ref?.['snapshot-id'])).toBe(receipt.snapshotId);
    expect(f.catalog.metadata['properties']?.['commit.manifest-merge.enabled']).not.toBe('false');
  });

  it('writes one SNAPPY Parquet file and one manifest under the table location', async () => {
    const f = build();
    const receipt = await f.append('batch-one');
    const artifact = await sha256Hex('batch-one');
    const paths = [...f.store.objects.keys()];
    const data = paths.filter((path) => path.endsWith('.parquet'));
    expect(data).toHaveLength(1);
    expect(data[0]).toMatch(
      new RegExp(`^${LOCATION}/data/authrim-${artifact}-[0-9a-f]{64}\\.parquet$`)
    );
    expect(paths).toContain(`${LOCATION}/metadata/authrim-${artifact}-m0.avro`);
    const bytes = Uint8Array.from(f.store.objects.get(String(data[0]))?.bytes ?? []);
    const column = safeParquetFooter(bytes).row_groups[0]?.columns[0]?.meta_data;
    expect(column?.codec).toBe('SNAPPY');
    const summary = summaryOf(f, receipt.snapshotId);
    expect(summary?.['added-files-size']).toBe(String(bytes.byteLength));
    expect(f.store.objects.get(String(data[0]))?.identity).toBe(
      `${receipt.tableUuid}:${receipt.batchDigest}`
    );
  });

  it('keeps bounds for most columns but never for ciphertext and the payload HMAC', async () => {
    const f = build();
    await f.append('batch-one', [record({ event_id: 'a' }), record({ event_id: 'b' })]);
    const resolver = {
      reader: async (path: string) => {
        const bytes = Uint8Array.from(f.store.objects.get(path)?.bytes ?? []);
        return {
          byteLength: bytes.byteLength,
          slice: (start: number, end?: number) =>
            Uint8Array.from(bytes.subarray(start, end)).buffer,
        };
      },
    };
    const groups = await icebergManifests({ metadata: f.catalog.metadata, resolver });
    const entry = splitManifestEntries(groups).dataEntries[0];
    const keys = (map: unknown): number[] =>
      (Array.isArray(map)
        ? map.map((item: { key: number }) => Number(item.key))
        : Object.keys(map as object).map(Number)
      ).sort((x, y) => x - y);
    const lower = keys(entry?.data_file.lower_bounds);
    const upper = keys(entry?.data_file.upper_bounds);
    for (const bounds of [lower, upper]) {
      expect(bounds).toContain(3);
      expect(bounds).toContain(4);
      expect(bounds).not.toContain(18);
      expect(bounds).not.toContain(20);
    }
    expect(entry?.data_file.record_count).toBe(2n);
  });
});

describe('partition groups', () => {
  it('writes a file per day and refuses more than sixteen days in one batch', async () => {
    const day = 86_400_000;
    const rows = (days: number) =>
      Array.from({ length: days }, (_, i) =>
        record({ event_id: `d${i}`, ingested_at: 1_793_000_000_000 + i * day })
      );
    const ok = build({ pipeline: true });
    await ok.append('sixteen', rows(16));
    expect([...ok.store.objects.keys()].filter((path) => path.endsWith('.parquet'))).toHaveLength(
      16
    );
    const over = build({ pipeline: true });
    await expect(over.append('seventeen', rows(17))).rejects.toThrow(
      'Archive partition group budget exceeded'
    );
    await expect(over.append('seventeen', rows(17))).rejects.toBeInstanceOf(IcebergBudgetError);
    expect(over.store.objects.size).toBe(0);
  });

  it('stores the ingestion time in the provider column of a pipeline table', async () => {
    const f = build({ pipeline: true });
    const receipt = await f.append('batch', [record({ ingested_at: NOW })]);
    expect(summaryOf(f, receipt.snapshotId)?.['added-records']).toBe('1');
    expect(f.catalog.metadata.schemas[0].fields.some((field) => field.name === '__ingest_ts')).toBe(
      true
    );
  });
});

describe('batch identity in the table history', () => {
  it('returns the receipt of a batch that is already in the history, at the latest sequence', async () => {
    const f = build();
    const first = await f.append('batch-one');
    await f.append('batch-two', [record({ event_id: 'b' })]);
    const again = await f.append('batch-one');
    expect(again).toMatchObject({ snapshotId: first.snapshotId, sequenceNumber: 2 });
    expect(f.journal.entries.get('batch-one')?.sequenceNumber).toBe(2);
    expect(f.catalog.commitCount).toBe(2);
  });

  it('refuses a batch id that the table holds with another digest or snapshot', async () => {
    const digestClash = build();
    const receipt = await digestClash.append('batch-one');
    const summary = summaryOf(digestClash, receipt.snapshotId);
    if (!summary) throw new Error('expected a summary');
    summary['authrim.batch-digest'] = 'f'.repeat(64);
    await expect(digestClash.append('batch-one')).rejects.toThrow(
      'Iceberg batch identity conflict'
    );
    await expect(digestClash.append('batch-one')).rejects.toBeInstanceOf(
      IcebergBatchCollisionError
    );

    const idClash = build();
    const other = await idClash.append('batch-one');
    const snapshot = idClash.catalog.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === other.snapshotId
    );
    if (!snapshot) throw new Error('expected a snapshot');
    const entry = idClash.journal.entries.get('batch-one');
    if (!entry) throw new Error('expected an entry');
    entry.snapshotId = '12345';
    await expect(idClash.append('batch-one')).rejects.toThrow('Iceberg batch identity conflict');
  });

  it('does not count a batch as present without its live pin, or with a mismatching summary', async () => {
    const reconciliation = 'Committed batch requires reconciliation';
    const variants: Array<(f: ReturnType<typeof build>, snapshotId: string, pin: string) => void> =
      [
        (f, _snapshotId, pin) => {
          delete f.catalog.metadata.refs?.[pin];
        },
        (f, _snapshotId, pin) => {
          const ref = f.catalog.metadata.refs?.[pin];
          if (ref) ref.type = 'branch';
        },
        (f, _snapshotId, pin) => {
          const ref = f.catalog.metadata.refs?.[pin];
          if (ref) delete ref['max-ref-age-ms'];
        },
        (f, _snapshotId, pin) => {
          const ref = f.catalog.metadata.refs?.[pin];
          if (ref) ref['max-ref-age-ms'] = 1;
        },
        (f, snapshotId) => {
          const summary = summaryOf(f, snapshotId);
          if (summary) summary['authrim.batch-records'] = '99';
        },
        (f, _snapshotId, pin) => {
          const ref = f.catalog.metadata.refs?.[pin];
          if (ref) ref['snapshot-id'] = '1';
        },
      ];
    for (const change of variants) {
      const f = build();
      const receipt = await f.append('batch-one');
      change(f, receipt.snapshotId, receipt.pin);
      await expect(f.append('batch-one')).rejects.toThrow(reconciliation);
    }
  });

  it('refuses a table history that loops', async () => {
    const f = build();
    const receipt = await f.append('batch-one');
    const second = await f.append('batch-two', [record({ event_id: 'b' })]);
    const snapshot = f.catalog.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === second.snapshotId
    );
    const first = f.catalog.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === receipt.snapshotId
    );
    if (!snapshot || !first) throw new Error('expected snapshots');
    first['parent-snapshot-id'] = snapshot['snapshot-id'];
    snapshot['parent-snapshot-id'] = first['snapshot-id'];
    f.catalog.metadata.refs = {};
    await expect(f.append('batch-three', [record({ event_id: 'c' })])).rejects.toThrow(
      'Invalid Iceberg snapshot ancestry'
    );
  });
});

describe('commit retries', () => {
  it('gives up after the commit attempt budget on conflicts, committing nothing', async () => {
    for (const attempts of [1, 3]) {
      const f = build({ maxCommitAttempts: attempts });
      const before = vi.fn(async () => {
        throw new IcebergCatalogConflictError('CAS conflict');
      });
      f.catalog.beforeCommit = before;
      await expect(f.append('batch')).rejects.toThrow('Iceberg batch CAS retry budget exhausted');
      await expect(f.append('batch')).rejects.toBeInstanceOf(IcebergCatalogConflictError);
      expect(before).toHaveBeenCalledTimes(attempts * 2);
      expect(f.journal.commits).toBe(0);
    }
  });

  it('retries after a conflict and commits the same snapshot', async () => {
    const f = build();
    let conflicts = 1;
    f.catalog.beforeCommit = async () => {
      if (conflicts-- > 0) throw new IcebergCatalogConflictError('CAS conflict');
    };
    const receipt = await f.append('batch');
    expect(f.catalog.commitCount).toBe(1);
    expect(summaryOf(f, receipt.snapshotId)?.['authrim.batch-id']).toBe('batch');
  });

  it('passes on errors that are neither conflicts nor unknown outcomes', async () => {
    const f = build();
    f.catalog.beforeCommit = async () => {
      throw new Error('storage exploded');
    };
    await expect(f.append('batch')).rejects.toThrow('storage exploded');
    expect(f.journal.commits).toBe(0);
  });

  it('confirms an unknown outcome on a fresh read, or reports it unknown', async () => {
    const lost = build();
    lost.catalog.afterCommit = async () => {
      throw new IcebergCommitUnknownError('response lost');
    };
    const receipt = await lost.append('batch');
    expect(receipt.sequenceNumber).toBe(1);
    expect(lost.journal.commits).toBe(1);

    const unknown = build();
    unknown.catalog.beforeCommit = async () => {
      throw new IcebergCommitUnknownError('disconnected');
    };
    await expect(unknown.append('batch')).rejects.toThrow('disconnected');
    expect(unknown.journal.commits).toBe(0);

    const conflict = build();
    conflict.catalog.afterCommit = async () => {
      throw new IcebergCatalogConflictError('response says conflict');
    };
    expect((await conflict.append('batch')).sequenceNumber).toBe(1);
  });

  it('refuses to report a commit that the table does not show afterwards', async () => {
    const f = build();
    f.catalog.afterCommit = async () => {
      f.catalog.metadata.refs = {};
    };
    await expect(f.append('batch')).rejects.toThrow(
      'Iceberg batch not confirmed in current history'
    );
    await expect(f.append('batch-two', [record({ event_id: 'b' })])).rejects.toBeInstanceOf(
      IcebergCommitUnknownError
    );
    expect(f.journal.commits).toBe(0);
  });

  it('refuses to commit once the pin lease has run out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const f = build();
    let fenceChecks = 0;
    const assertFence = f.journal.assertFence.bind(f.journal);
    f.journal.assertFence = async (batchId, fence) => {
      await assertFence(batchId, fence);
      fenceChecks += 1;
      if (fenceChecks === 3) vi.setSystemTime(NOW + LOG_ARCHIVE_PENDING_PIN_TTL_MS);
    };
    await expect(f.append('batch')).rejects.toThrow('Pending batch pin expired before commit');
    expect(f.catalog.commitCount).toBe(0);
  });

  it('checks the fence before planning, staging and committing', async () => {
    const f = build();
    const assertFence = vi.spyOn(f.journal, 'assertFence');
    await f.append('batch');
    expect(assertFence.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [batchId, fence] of assertFence.mock.calls) {
      expect(batchId).toBe('batch');
      expect(fence).toBe('fence-1');
    }
  });

  it('refuses a table that changed identity while the batch was being committed', async () => {
    const f = build();
    let conflicts = 1;
    f.catalog.beforeCommit = async () => {
      if (conflicts-- > 0) {
        f.catalog.metadata['table-uuid'] = 'another-table';
        throw new IcebergCatalogConflictError('CAS conflict');
      }
    };
    await expect(f.append('batch')).rejects.toThrow('Iceberg table changed during batch');
    await expect(f.append('batch')).rejects.toBeInstanceOf(IcebergBatchCollisionError);
  });
});

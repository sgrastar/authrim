import { describe, expect, it, vi } from 'vitest';
import { IcebergLifecycle } from '../lifecycle.js';
import {
  planSnapshotRowDeletePage,
  scanSnapshotExpiredFilesPage,
  verifySnapshotBatch,
  type SnapshotReadOptions,
  type SnapshotScanCursor,
} from '../reader.js';
import { IcebergBatchCollisionError } from '../types.js';
import { readerFixture, NOW_MS } from './reader-mutation-harness.js';
import { LOCATION, record } from './fixtures.js';

const T = 1793000000000;
const ids = (rows: Array<{ event_id: string }>): string[] => rows.map((row) => row.event_id).sort();

type Fixture = ReturnType<typeof readerFixture>;

function parquetFiles(f: Fixture): string[] {
  return [...f.store.objects.keys()].filter((path) => path.endsWith('.parquet'));
}

async function opened(f: Fixture, run: () => Promise<unknown>): Promise<string[]> {
  const read = vi.spyOn(f.store, 'read');
  try {
    await run();
    return read.mock.calls.map(([path]) => path);
  } finally {
    read.mockRestore();
  }
}

describe('manifest bounds pruning', () => {
  it('does not open files whose subject bounds exclude the requested subjects', async () => {
    const f = readerFixture();
    await f.append('a', [record({ event_id: 'a1', subject_id: 'subject-a' })]);
    const fileA = parquetFiles(f);
    await f.append('z', [record({ event_id: 'z1', subject_id: 'subject-z' })]);
    const fileZ = parquetFiles(f).filter((path) => !fileA.includes(path));

    const found = { ids: [] as string[] };
    const paths = await opened(f, async () => {
      found.ids = ids((await f.read({ subjectIds: ['subject-z'] })).records);
    });
    expect(found.ids).toEqual(['z1']);
    expect(paths.some((path) => fileZ.includes(path))).toBe(true);
    expect(paths.some((path) => fileA.includes(path))).toBe(false);

    const both = await opened(f, async () => {
      found.ids = ids((await f.read({ subjectIds: ['subject-a', 'subject-z'] })).records);
    });
    expect(found.ids).toEqual(['a1', 'z1']);
    expect(both.some((path) => fileA.includes(path))).toBe(true);
    const none = await opened(f, async () => {
      found.ids = ids((await f.read({ subjectIds: ['subject-m'] })).records);
    });
    expect(found.ids).toEqual([]);
    expect(none.some((path) => [...fileA, ...fileZ].includes(path))).toBe(false);
  });

  it('does not open files whose rows have all expired, unless expired rows are wanted', async () => {
    const f = readerFixture();
    await f.append('expired', [
      record({ event_id: 'x1', expires_at: NOW_MS - 10 }),
      record({ event_id: 'x2', expires_at: NOW_MS - 20 }),
    ]);
    const expiredFile = parquetFiles(f);
    await f.append('mixed', [
      record({ event_id: 'm1', expires_at: NOW_MS - 10 }),
      record({ event_id: 'm2', expires_at: null }),
    ]);
    const mixedFile = parquetFiles(f).filter((path) => !expiredFile.includes(path));
    await f.append('live', [record({ event_id: 'l1', expires_at: NOW_MS + 10 })]);
    const liveFile = parquetFiles(f).filter(
      (path) => !expiredFile.includes(path) && !mixedFile.includes(path)
    );

    const got = { ids: [] as string[] };
    const paths = await opened(f, async () => {
      got.ids = ids((await f.read()).records);
    });
    expect(got.ids).toEqual(['l1', 'm2']);
    expect(paths.some((path) => expiredFile.includes(path))).toBe(false);
    expect(paths.some((path) => mixedFile.includes(path))).toBe(true);
    expect(paths.some((path) => liveFile.includes(path))).toBe(true);

    const planned = await opened(f, async () => {
      await scanSnapshotExpiredFilesPage(await f.scope());
    });
    expect(planned.some((path) => expiredFile.includes(path))).toBe(true);

    const stillLive = await opened(f, async () => {
      await f.read({ nowMs: NOW_MS - 11 });
    });
    expect(stillLive.some((path) => expiredFile.includes(path))).toBe(true);
    const atExpiry = await opened(f, async () => {
      await f.read({ nowMs: NOW_MS - 10 });
    });
    expect(atExpiry.some((path) => expiredFile.includes(path))).toBe(false);
    const past = await opened(f, async () => {
      await f.read({ nowMs: NOW_MS - 9 });
    });
    expect(past.some((path) => expiredFile.includes(path))).toBe(false);
  });

  it('does not open day partitions outside the provider ingestion bounds', async () => {
    const f = readerFixture({ pipeline: true });
    const day = 86_400_000;
    await f.append('day-one', [record({ event_id: 'd1', ingested_at: T })]);
    const dayOne = parquetFiles(f);
    await f.append('day-two', [record({ event_id: 'd2', ingested_at: T + 3 * day })]);
    const dayTwo = parquetFiles(f).filter((path) => !dayOne.includes(path));

    const got = { ids: [] as string[] };
    const from = await opened(f, async () => {
      got.ids = ids((await f.read({ providerIngestedAtFrom: T + 2 * day })).records);
    });
    expect(got.ids).toEqual(['d2']);
    expect(from.some((path) => dayOne.includes(path))).toBe(false);
    expect(from.some((path) => dayTwo.includes(path))).toBe(true);
    const to = await opened(f, async () => {
      got.ids = ids((await f.read({ providerIngestedAtTo: T + 2 * day })).records);
    });
    expect(got.ids).toEqual(['d1']);
    expect(to.some((path) => dayTwo.includes(path))).toBe(false);
    const between = await opened(f, async () => {
      got.ids = ids(
        (await f.read({ providerIngestedAtFrom: T + day, providerIngestedAtTo: T + 2 * day }))
          .records
      );
    });
    expect(got.ids).toEqual([]);
    expect(between.some((path) => [...dayOne, ...dayTwo].includes(path))).toBe(false);
    const all = await opened(f, async () => {
      got.ids = ids((await f.read({})).records);
    });
    expect(got.ids).toEqual(['d1', 'd2']);
    expect(all.some((path) => dayOne.includes(path))).toBe(true);
  });
});

describe('pages over rows that are not next to each other', () => {
  it('stops a page after eight separate runs of rows and continues from there', async () => {
    const f = readerFixture();
    const rows = Array.from({ length: 24 }, (_, i) =>
      record({ event_id: `r${String(i).padStart(2, '0')}`, event_at: T + i })
    );
    await f.append('alternating', rows);
    const wanted = rows.filter((_, i) => i % 2 === 0).map((row) => row.event_id);
    const first = await f.page({ pageSize: 128, eventIds: wanted });
    expect(first.records).toHaveLength(8);
    expect(first.complete).toBe(false);
    expect(first.nextCursor?.position).toMatchObject({ manifest: 0, entry: 0, row: 16 });

    const seen: string[] = [];
    let cursor: SnapshotScanCursor | undefined;
    let pages = 0;
    for (; pages < 10; pages += 1) {
      const page = await f.page({ pageSize: 128, eventIds: wanted, cursor });
      seen.push(...ids(page.records));
      if (page.complete) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(wanted);
    expect(pages).toBeLessThan(4);
  });

  it('keeps a run of contiguous rows in one group however long', async () => {
    const f = readerFixture();
    await f.append(
      'contiguous',
      Array.from({ length: 30 }, (_, i) => record({ event_id: `c${String(i).padStart(2, '0')}` }))
    );
    const page = await f.page({ pageSize: 128 });
    expect(page.records).toHaveLength(30);
    expect(page.complete).toBe(false);
    expect(page.nextCursor?.position).toMatchObject({ manifest: 0, entry: 1, row: 0 });
    expect((await f.page({ pageSize: 128, cursor: page.nextCursor })).complete).toBe(true);
  });
});

describe('errors name what went wrong', () => {
  it('names an event written twice with different content, for reads and for proofs', async () => {
    const f = readerFixture();
    await f.append('first', [record({ event_id: 'dup', action: 'one' })]);
    await f.append('second', [record({ event_id: 'dup', action: 'two' })]);
    await expect(f.read()).rejects.toThrow('Archive event identity collision');
    await expect(f.read()).rejects.toBeInstanceOf(IcebergBatchCollisionError);
  });

  it('names a stored record that differs from the expected one', async () => {
    const f = readerFixture();
    const stored = record({ event_id: 'v1' });
    const receipt = await f.append('verify', [stored]);
    const options = async (expected: ReturnType<typeof record>[]) => ({
      ...((await f.scope()) as SnapshotReadOptions),
      snapshotId: receipt.snapshotId,
      expectedRecords: expected,
    });
    await expect(
      verifySnapshotBatch(await options([record({ event_id: 'v1', action: 'other' })]))
    ).rejects.toThrow('Archive verification record differs');
    await expect(
      verifySnapshotBatch(await options([record({ event_id: 'ghost' })]))
    ).rejects.toThrow('Archive verification record missing');
    await expect(
      verifySnapshotBatch(await options([stored, { ...stored, payload_hmac: 'c'.repeat(64) }]))
    ).rejects.toThrow('Verification identity collision');
    await expect(
      verifySnapshotBatch(await options([{ ...stored, schema_version: 2 }]))
    ).rejects.toThrow('Unsupported archive schema');
    await expect(
      verifySnapshotBatch(await options([record({ event_id: 'v1', tenant_key: 'x' })]))
    ).rejects.toThrow('Verification batch scope differs');
    await expect(verifySnapshotBatch(await options([]))).rejects.toThrow(
      'Invalid archive verification batch'
    );
  });
});

describe('physical scans see rows that position deletes hide', () => {
  it('lists expired rows of the snapshot even after they were deleted', async () => {
    const f = readerFixture();
    await f.append('expiry', [
      record({ event_id: 'keep' }),
      record({ event_id: 'gone', expires_at: NOW_MS - 1 }),
    ]);
    const lifecycle = new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: LOCATION,
    });
    const scope = {
      tenantKey: 'tenant-test',
      sourceDatasets: ['core.event_log'],
      nowMs: NOW_MS,
    };
    expect(await lifecycle.deleteExpiredRows(scope)).toBe(1);

    const logical = await planSnapshotRowDeletePage(await f.scope(), 'expired');
    expect(logical.deletes.map((d) => d.eventId)).toEqual([]);
    const physical = await scanSnapshotExpiredFilesPage(await f.scope());
    expect(physical.deletes.map((d) => d.eventId)).toEqual(['gone']);
    expect(ids((await f.read()).records)).toEqual(['keep']);
  });
});

import { describe, expect, it } from 'vitest';
import { readSnapshotPage, readSnapshotRecords } from '../reader.js';
import { readerFixture } from './reader-mutation-harness.js';
import { record } from './fixtures.js';

const repeat = (length: number): string => 'x'.repeat(length);
const many = (count: number, length = 1): string[] =>
  Array.from({ length: count }, (_, i) => `${i}`.padEnd(length, 'x'));

describe('read scope validation', () => {
  it('reads an empty table as no snapshot, at sequence zero', async () => {
    const f = readerFixture();
    expect(await f.read()).toStrictEqual({
      tableUuid: 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
      snapshotId: null,
      sequenceNumber: 0,
      records: [],
    });
    expect(await f.page()).toMatchObject({ snapshotId: null, complete: true, records: [] });
  });

  it('refuses a scope that is empty, too large or not integral', async () => {
    const f = readerFixture();
    const bad: Array<Record<string, unknown>> = [
      { tenantKey: '' },
      { tenantKey: repeat(257) },
      { sourceDatasets: [] },
      { sourceDatasets: many(65) },
      { sourceDatasets: [''] },
      { sourceDatasets: ['ok', ''] },
      { sourceDatasets: [repeat(257)] },
      { sourceDatasets: ['ok', repeat(257)] },
      { nowMs: 1.5 },
      { nowMs: Number.NaN },
      { nowMs: 2 ** 53 },
      { eventAtFrom: 1.5 },
      { eventAtTo: 1.5 },
      { providerIngestedAtFrom: 1.5 },
      { providerIngestedAtTo: 1.5 },
      { dataManifestsAddedFrom: 1.5 },
      { eventAtFrom: Number.NaN },
      { eventIds: [] },
      { eventIds: many(101) },
      { eventIds: [''] },
      { eventIds: ['ok', ''] },
      { eventIds: [repeat(257)] },
      { eventIds: ['ok', repeat(257)] },
      { subjectIds: [] },
      { subjectIds: many(101) },
      { subjectIds: [''] },
      { subjectIds: ['ok', ''] },
      { subjectIds: [repeat(257)] },
      { subjectIds: ['ok', repeat(257)] },
    ];
    for (const override of bad) {
      await expect(f.read(override)).rejects.toThrow('Invalid archive read scope');
      await expect(f.page(override)).rejects.toThrow('Invalid archive read scope');
    }
  });

  it('accepts a scope at its limits', async () => {
    const f = readerFixture();
    const edge: Array<Record<string, unknown>> = [
      { tenantKey: repeat(256) },
      { sourceDatasets: many(64) },
      { sourceDatasets: [repeat(256)] },
      { eventIds: many(100, 256) },
      { subjectIds: many(100, 256) },
      { eventIds: ['one'] },
      { subjectIds: ['one'] },
      { nowMs: 0 },
      { nowMs: -1 },
      { eventAtFrom: 0, eventAtTo: 0, providerIngestedAtFrom: 0, providerIngestedAtTo: 0 },
      { dataManifestsAddedFrom: 0 },
    ];
    for (const override of edge) {
      expect((await f.read(override)).records).toEqual([]);
    }
  });

  it('refuses a budget that is not an integer from 1 up to the default', async () => {
    const f = readerFixture();
    const defaults = {
      maxRows: 10_000,
      maxFiles: 128,
      maxBytes: 32 * 1024 * 1024,
      maxFileBytes: 8 * 1024 * 1024,
      deadlineMs: 10_000,
    };
    for (const [key, max] of Object.entries(defaults)) {
      for (const bad of [0, -1, 1.5, Number.NaN, max + 1, Number.POSITIVE_INFINITY]) {
        await expect(f.read({ limits: { [key]: bad } })).rejects.toThrow(
          'Invalid archive read budget'
        );
      }
      await expect(f.read({ limits: { [key]: max } })).resolves.toBeDefined();
      await expect(f.read({ limits: { [key]: 1 } })).resolves.toBeDefined();
    }
  });

  it('refuses a page size that is not an integer from 1 up to 128 and the row budget', async () => {
    const f = readerFixture();
    for (const pageSize of [0, -1, 1.5, Number.NaN, 129]) {
      await expect(f.page({ pageSize })).rejects.toThrow('Invalid archive page size');
    }
    await expect(f.page({ pageSize: 6, limits: { maxRows: 5 } })).rejects.toThrow(
      'Invalid archive page size'
    );
    await expect(f.page({ pageSize: 5, limits: { maxRows: 5 } })).resolves.toBeDefined();
    await expect(f.page({ pageSize: 128 })).resolves.toBeDefined();
    await expect(f.page({ pageSize: 1 })).resolves.toBeDefined();
    await expect(f.page({ limits: { maxRows: 3 } })).resolves.toBeDefined();
  });

  it('refuses a table that is not a log archive table', async () => {
    const f = readerFixture();
    const table = await f.catalog.loadTable();
    table.metadata.schemas[0].fields.pop();
    await expect(readSnapshotRecords({ ...(await f.scope()), table })).rejects.toThrow();
    await expect(readSnapshotPage({ ...(await f.scope()), table })).rejects.toThrow();
  });
});

describe('snapshot identity and watermark', () => {
  async function withData() {
    const f = readerFixture();
    const receipt = await f.append('one', [record()]);
    return { f, receipt };
  }

  it('reads the current snapshot, or the one asked for', async () => {
    const { f, receipt } = await withData();
    const current = await f.read();
    expect(current).toMatchObject({ snapshotId: receipt.snapshotId, sequenceNumber: 1 });
    expect(current.tableUuid).toBe(f.catalog.metadata['table-uuid']);
    expect((await f.read({ snapshotId: receipt.snapshotId })).records).toEqual([record()]);
  });

  it('reads a table whose current snapshot is unset or negative as empty', async () => {
    const { f } = await withData();
    f.catalog.metadata['current-snapshot-id'] = -1;
    expect(await f.read()).toMatchObject({ snapshotId: null, sequenceNumber: 0, records: [] });
    f.catalog.metadata['current-snapshot-id'] = undefined;
    expect(await f.read()).toMatchObject({ snapshotId: null, records: [] });
  });

  it('refuses a snapshot id that is not digits, or unknown', async () => {
    const { f } = await withData();
    for (const snapshotId of ['', 'abc', '-1', '1.5', '12a', 'a12', ' 12']) {
      await expect(f.read({ snapshotId })).rejects.toThrow('Invalid archive snapshot ID');
    }
    await expect(f.read({ snapshotId: '999999' })).rejects.toThrow('Archive snapshot unavailable');
  });

  it('refuses a watermark of another table, an invalid one, or one ahead of the snapshot', async () => {
    const { f } = await withData();
    const tableUuid = String(f.catalog.metadata['table-uuid']);
    const behind = 'Archive snapshot is behind the committed source watermark';
    await expect(
      f.read({ watermark: { tableUuid: 'other-table', minimumSequenceNumber: 0 } })
    ).rejects.toThrow(behind);
    for (const minimumSequenceNumber of [Number.NaN, 1.5, -1, 2, 2 ** 53]) {
      await expect(f.read({ watermark: { tableUuid, minimumSequenceNumber } })).rejects.toThrow(
        behind
      );
    }
    for (const minimumSequenceNumber of [0, 1]) {
      await expect(
        f.read({ watermark: { tableUuid, minimumSequenceNumber } })
      ).resolves.toBeDefined();
    }
    const empty = readerFixture();
    const emptyUuid = String(empty.catalog.metadata['table-uuid']);
    await expect(
      empty.read({ watermark: { tableUuid: emptyUuid, minimumSequenceNumber: 1 } })
    ).rejects.toThrow(behind);
    await expect(
      empty.read({ watermark: { tableUuid: emptyUuid, minimumSequenceNumber: 0 } })
    ).resolves.toBeDefined();
  });

  it('refuses a cursor of another snapshot than the one asked for', async () => {
    const { f, receipt } = await withData();
    const cursor = {
      version: 1 as const,
      tableUuid: String(f.catalog.metadata['table-uuid']),
      snapshotId: '999999',
      physicalFingerprint: 'x',
      scopeDigest: 'x',
      position: { manifest: 0, entry: 0, row: 0 },
    };
    await expect(f.page({ cursor, snapshotId: receipt.snapshotId })).rejects.toThrow(
      'Archive cursor snapshot differs'
    );
    await expect(f.page({ cursor })).rejects.toThrow('Archive snapshot unavailable');
  });
});

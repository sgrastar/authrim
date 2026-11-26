import { describe, expect, it } from 'vitest';
import {
  planExpiredRowDeletes,
  planSnapshotRowDeletePage,
  scanSnapshotExpiredFilesPage,
  scanSnapshotSubjectFilesPage,
  verifySnapshotBatch,
  type SnapshotPageOptions,
  type SnapshotReadOptions,
} from '../reader.js';
import { IcebergBatchCollisionError } from '../types.js';
import { readerFixture, NOW_MS } from './reader-mutation-harness.js';
import { record } from './fixtures.js';

const T = 1793000000000;
const ids = (rows: Array<{ event_id: string }>): string[] => rows.map((row) => row.event_id).sort();

describe('provider ingestion time bounds', () => {
  async function pipeline() {
    const f = readerFixture({ pipeline: true });
    const ingested = (i: number): number => 1793000000000 + i * 1000;
    await f.append(
      'main',
      [1, 2, 3, 4].map((i) => record({ event_id: `p${i}`, ingested_at: ingested(i) }))
    );
    return { f, ingested };
  }

  it('keeps rows ingested from the lower bound up to, but not including, the upper bound', async () => {
    const { f, ingested } = await pipeline();
    const read = async (extra: {
      providerIngestedAtFrom?: number;
      providerIngestedAtTo?: number;
    }) => ids((await f.read(extra)).records);
    expect(await read({})).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(await read({ providerIngestedAtFrom: ingested(2) })).toEqual(['p2', 'p3', 'p4']);
    expect(await read({ providerIngestedAtFrom: ingested(2) + 1 })).toEqual(['p3', 'p4']);
    expect(await read({ providerIngestedAtTo: ingested(3) })).toEqual(['p1', 'p2']);
    expect(await read({ providerIngestedAtTo: ingested(3) + 1 })).toEqual(['p1', 'p2', 'p3']);
    expect(
      await read({ providerIngestedAtFrom: ingested(2), providerIngestedAtTo: ingested(4) })
    ).toEqual(['p2', 'p3']);
    expect(await read({ providerIngestedAtFrom: ingested(9) })).toEqual([]);
    expect(await read({ providerIngestedAtTo: ingested(1) })).toEqual([]);
  });

  it('applies the same bounds page by page', async () => {
    const { f, ingested } = await pipeline();
    const page = await f.page({
      providerIngestedAtFrom: ingested(2),
      providerIngestedAtTo: ingested(4),
    });
    expect(ids(page.records)).toEqual(['p2', 'p3']);
  });
});

describe('verifySnapshotBatch', () => {
  async function stored(count = 3) {
    const f = readerFixture();
    const rows = Array.from({ length: count }, (_, i) =>
      record({ event_id: `v${String(i).padStart(4, '0')}` })
    );
    const receipt = await f.append('verify', rows);
    const options = async (
      extra: Partial<SnapshotReadOptions & { expectedRecords: typeof rows }> = {}
    ) => ({
      ...((await f.scope()) as SnapshotReadOptions),
      snapshotId: receipt.snapshotId,
      expectedRecords: rows,
      ...extra,
    });
    return { f, rows, receipt, options };
  }

  it('proves the records are in the snapshot and names the snapshot', async () => {
    const { rows, receipt, options } = await stored();
    expect(await verifySnapshotBatch(await options())).toStrictEqual({
      tableUuid: 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
      snapshotId: receipt.snapshotId,
      sequenceNumber: 1,
    });
    expect(
      await verifySnapshotBatch(await options({ expectedRecords: rows.slice(0, 1) }))
    ).toMatchObject({
      snapshotId: receipt.snapshotId,
    });
  });

  it('verifies batches of more than a hundred records in chunks', async () => {
    const { rows, options } = await stored(101);
    expect(rows).toHaveLength(101);
    await expect(verifySnapshotBatch(await options())).resolves.toBeDefined();
    const [first] = rows;
    if (!first) throw new Error('expected rows');
    const missing = [...rows.slice(0, 100), record({ event_id: 'ghost' })];
    await expect(verifySnapshotBatch(await options({ expectedRecords: missing }))).rejects.toThrow(
      'Archive verification record missing'
    );
    const ghostFirst = [record({ event_id: 'ghost' }), ...rows.slice(0, 100)];
    await expect(
      verifySnapshotBatch(await options({ expectedRecords: ghostFirst }))
    ).rejects.toThrow('Archive verification record missing');
  });

  it('refuses a batch that is missing, empty or too large', async () => {
    const { rows, options } = await stored();
    await expect(verifySnapshotBatch(await options({ snapshotId: undefined }))).rejects.toThrow(
      'Invalid archive verification batch'
    );
    await expect(verifySnapshotBatch(await options({ snapshotId: '' }))).rejects.toThrow(
      'Invalid archive verification batch'
    );
    await expect(verifySnapshotBatch(await options({ expectedRecords: [] }))).rejects.toThrow(
      'Invalid archive verification batch'
    );
    const first = rows[0];
    if (!first) throw new Error('expected rows');
    const big = Array.from({ length: 1001 }, (_, i) => ({ ...first, event_id: `b${i}` }));
    await expect(verifySnapshotBatch(await options({ expectedRecords: big }))).rejects.toThrow(
      'Invalid archive verification batch'
    );
  });

  it('refuses expected records of another tenant or dataset, or that are not records', async () => {
    const { rows, options } = await stored();
    await expect(
      verifySnapshotBatch(
        await options({ expectedRecords: [...rows, record({ tenant_key: 'someone-else' })] })
      )
    ).rejects.toThrow('Verification batch scope differs');
    await expect(
      verifySnapshotBatch(
        await options({ expectedRecords: [...rows, record({ source_dataset: 'other.dataset' })] })
      )
    ).rejects.toThrow('Verification batch scope differs');
    await expect(
      verifySnapshotBatch(await options({ expectedRecords: [{ ...record(), event_id: '' }] }))
    ).rejects.toThrow();
  });

  it('refuses expected records that repeat an identity with different content', async () => {
    const { rows, options } = await stored();
    const first = rows[0];
    if (!first) throw new Error('expected rows');
    for (const change of [
      { action: 'other' },
      { result: 'other' },
      { payload_hmac: 'c'.repeat(64) },
      { detail_ciphertext: 'other-body' },
    ]) {
      await expect(
        verifySnapshotBatch(await options({ expectedRecords: [first, { ...first, ...change }] }))
      ).rejects.toBeInstanceOf(IcebergBatchCollisionError);
    }
    await expect(
      verifySnapshotBatch(await options({ expectedRecords: [first, { ...first }] }))
    ).resolves.toBeDefined();
  });

  it('refuses when the stored record differs from the expected one', async () => {
    const { rows, options } = await stored();
    const first = rows[0];
    if (!first) throw new Error('expected rows');
    for (const change of [
      { action: 'other' },
      { payload_hmac: 'c'.repeat(64) },
      { detail_ciphertext: 'other-body' },
      { ingested_at: first.ingested_at + 1 },
      { storage_generation: 'new-generation-2' },
    ]) {
      const failure = await verifySnapshotBatch(
        await options({ expectedRecords: [{ ...first, ...change }] })
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(IcebergBatchCollisionError);
      expect((failure as Error).message).toBe('Archive verification record differs');
    }
  });

  it('verifies an expired record, which public reads hide', async () => {
    const f = readerFixture();
    const expired = record({ event_id: 'old', expires_at: 0 });
    const receipt = await f.append('expired', [expired]);
    const scope = (await f.scope()) as SnapshotReadOptions;
    expect(
      await verifySnapshotBatch({
        ...scope,
        snapshotId: receipt.snapshotId,
        expectedRecords: [expired],
      })
    ).toMatchObject({ snapshotId: receipt.snapshotId });
    expect((await f.read()).records).toEqual([]);
  });
});

describe('row position plans', () => {
  async function planned() {
    const f = readerFixture();
    const rows = [
      record({ event_id: 'keep', expires_at: null, event_at: T }),
      record({ event_id: 'later', expires_at: NOW_MS + 1, event_at: T + 1 }),
      record({ event_id: 'edge', expires_at: NOW_MS, event_at: T + 2 }),
      record({ event_id: 'gone', expires_at: NOW_MS - 1, event_at: T + 3 }),
      record({ event_id: 'zero', expires_at: 0, event_at: T + 4 }),
    ];
    await f.append('plan', rows);
    return f;
  }

  const file = (f: Awaited<ReturnType<typeof planned>>): string =>
    String([...f.store.objects.keys()].find((path) => path.endsWith('.parquet')));

  it('lists the expired rows of the current snapshot with their positions', async () => {
    const f = await planned();
    const plan = await planExpiredRowDeletes(await f.scope());
    expect(plan.snapshotId).toBe(String(f.catalog.metadata['current-snapshot-id']));
    expect(plan.deletes.map((d) => d.pos).sort()).toEqual([2n, 3n, 4n]);
    expect(plan.deletes.every((d) => d.file_path === file(f))).toBe(true);
    const none = await planExpiredRowDeletes(await f.scope({ nowMs: -1 }));
    expect(none.deletes).toEqual([]);
  });

  it('plans expired rows as full descriptions of what to delete', async () => {
    const f = await planned();
    const page = await scanSnapshotExpiredFilesPage(await f.scope());
    expect(page.complete).toBe(false);
    expect(page.deletes.map((d) => d.eventId).sort()).toEqual(['edge', 'gone', 'zero']);
    const gone = page.deletes.find((d) => d.eventId === 'gone');
    expect(gone).toStrictEqual({
      filePath: file(f),
      pos: '3',
      partitionSpecId: 0,
      partition: {},
      eventId: 'gone',
      payloadHmac: 'a'.repeat(64),
      expiresAt: NOW_MS - 1,
    });
    expect(page.physicalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(page).not.toHaveProperty('records');
    const same = await planSnapshotRowDeletePage(await f.scope(), 'expired');
    expect(same.deletes.map((d) => d.eventId).sort()).toEqual(['edge', 'gone', 'zero']);
  });

  it('plans the rows of one erased subject in the personal-data dataset', async () => {
    const f = readerFixture();
    await f.append('pii', [
      record({
        event_id: 'p1',
        source_dataset: 'pii.pii_log',
        subject_id: 'subject-1',
        expires_at: NOW_MS + 100,
      }),
      record({ event_id: 'p2', source_dataset: 'pii.pii_log', subject_id: 'subject-2' }),
      record({
        event_id: 'p3',
        source_dataset: 'pii.pii_log',
        subject_id: 'subject-1',
        expires_at: 0,
      }),
    ]);
    const scope = await f.scope({
      sourceDatasets: ['pii.pii_log'],
      subjectIds: ['subject-1'],
    });
    const planned = await planSnapshotRowDeletePage(scope, 'subject');
    expect(planned.deletes.map((d) => d.eventId).sort()).toEqual(['p1', 'p3']);
    const physical = await scanSnapshotSubjectFilesPage(scope);
    expect(physical.deletes.map((d) => d.eventId).sort()).toEqual(['p1', 'p3']);
    expect(physical.deletes.find((d) => d.eventId === 'p3')?.expiresAt).toBe(0);
    expect(physical.physicalFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a subject plan that is not for exactly one subject in the personal-data dataset', async () => {
    const f = readerFixture();
    const bad: Array<Partial<SnapshotPageOptions>> = [
      { sourceDatasets: ['pii.pii_log'] },
      { sourceDatasets: ['pii.pii_log'], subjectIds: [] },
      { sourceDatasets: ['pii.pii_log'], subjectIds: ['a', 'b'] },
      { sourceDatasets: ['pii.pii_log', 'core.event_log'], subjectIds: ['a'] },
      { sourceDatasets: [], subjectIds: ['a'] },
      { sourceDatasets: ['core.event_log'], subjectIds: ['a'] },
    ];
    for (const extra of bad) {
      const scope = await f.scope(extra);
      await expect(planSnapshotRowDeletePage(scope, 'subject')).rejects.toThrow(
        'Invalid subject deletion scope'
      );
    }
    const strict = [...bad.slice(0, 4), bad[5] ?? {}];
    for (const extra of strict) {
      const scope = await f.scope(extra);
      expect(() => scanSnapshotSubjectFilesPage(scope)).toThrow('Invalid physical subject scope');
    }
    const ok = await f.scope({ sourceDatasets: ['pii.pii_log'], subjectIds: ['a'] });
    await expect(planSnapshotRowDeletePage(ok, 'subject')).resolves.toBeDefined();
    await expect(scanSnapshotSubjectFilesPage(ok)).resolves.toBeDefined();
    await expect(planSnapshotRowDeletePage(await f.scope(), 'expired')).resolves.toBeDefined();
  });
});

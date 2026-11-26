import { describe, expect, it, vi } from 'vitest';
import { IcebergBatchCollisionError, IcebergBudgetError } from '../types.js';
import type { SnapshotPageOptions, SnapshotScanCursor } from '../reader.js';
import { readerFixture, NOW_MS } from './reader-mutation-harness.js';
import { record } from './fixtures.js';

const T = 1793000000000;
const ids = (rows: Array<{ event_id: string }>): string[] => rows.map((row) => row.event_id).sort();

async function populated() {
  const f = readerFixture();
  await f.append(
    'main',
    Array.from({ length: 5 }, (_, i) =>
      record({
        event_id: `e${i + 1}`,
        event_at: T + i * 1000,
        subject_id: i % 2 ? 's-odd' : 's-even',
      })
    )
  );
  return f;
}

async function allPages(
  f: Awaited<ReturnType<typeof populated>>,
  extra: Partial<SnapshotPageOptions> = {}
) {
  const pages = [];
  let cursor: SnapshotScanCursor | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await f.page({ ...extra, cursor });
    pages.push(page);
    if (page.complete) break;
    cursor = page.nextCursor;
  }
  return pages;
}

describe('page cursors', () => {
  it('walks a snapshot page by page and reports each continuation', async () => {
    const f = await populated();
    const first = await f.page({ pageSize: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.complete).toBe(false);
    const cursor = first.nextCursor;
    expect(cursor).toMatchObject({
      version: 1,
      tableUuid: f.catalog.metadata['table-uuid'],
      snapshotId: first.snapshotId,
      position: { manifest: 0, entry: 0, row: 2 },
    });
    expect(cursor?.scopeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(cursor?.physicalFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const pages = await allPages(f, { pageSize: 2 });
    expect(pages.map((page) => page.records.length)).toEqual([2, 2, 1, 0]);
    expect(pages.at(-1)?.complete).toBe(true);
    expect(pages.at(-1)?.nextCursor).toBeUndefined();
    expect(ids(pages.flatMap((page) => page.records))).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('refuses a cursor that was not issued for this table, scope or position', async () => {
    const f = await populated();
    const first = await f.page({ pageSize: 2 });
    const cursor = first.nextCursor;
    if (!cursor) throw new Error('expected a cursor');
    const bad: SnapshotScanCursor[] = [
      { ...cursor, version: 2 as never },
      { ...cursor, tableUuid: 'other' },
      { ...cursor, physicalFingerprint: 'other' },
      { ...cursor, scopeDigest: 'other' },
      { ...cursor, position: { ...cursor.position, manifest: -1 } },
      { ...cursor, position: { ...cursor.position, entry: -1 } },
      { ...cursor, position: { ...cursor.position, row: -1 } },
      { ...cursor, position: { ...cursor.position, manifest: 1.5 } },
      { ...cursor, position: { ...cursor.position, entry: Number.NaN } },
      { ...cursor, position: { ...cursor.position, row: 0.5 } },
    ];
    for (const candidate of bad) {
      await expect(f.page({ pageSize: 2, cursor: candidate })).rejects.toThrow(
        'Invalid archive scan cursor'
      );
    }
    await expect(f.page({ pageSize: 2, cursor })).resolves.toBeDefined();
    await expect(
      f.page({ pageSize: 2, cursor: { ...cursor, position: { manifest: 0, entry: 0, row: 0 } } })
    ).resolves.toBeDefined();
  });

  it('refuses a cursor with more than 21 column positions', async () => {
    const f = await populated();
    const cursor = (await f.page({ pageSize: 2 })).nextCursor;
    if (!cursor) throw new Error('expected a cursor');
    const columns = (count: number) =>
      Array.from({ length: count }, () => ({
        nextRow: 0,
      })) as unknown as SnapshotScanCursor['columns'];
    await expect(
      f.page({ pageSize: 2, cursor: { ...cursor, columns: columns(22) } })
    ).rejects.toThrow('Invalid archive scan cursor');
    const outcome = await f.page({ pageSize: 2, cursor: { ...cursor, columns: columns(21) } }).then(
      () => 'accepted',
      (error: Error) => error.message
    );
    expect(outcome).not.toBe('Invalid archive scan cursor');
  });

  it('ties a cursor to every part of the scope it was issued for', async () => {
    const f = await populated();
    const base: Partial<SnapshotPageOptions> = {
      pageSize: 2,
      sourceDatasets: ['core.event_log', 'other.dataset'],
      eventIds: ['e1', 'e2', 'e3', 'e4', 'e5'],
      subjectIds: undefined,
      eventAtFrom: T - 10_000,
      eventAtTo: T + 10_000,
      providerIngestedAtFrom: 1,
      providerIngestedAtTo: 2 ** 40,
    };
    const first = await f.page(base);
    const cursor = first.nextCursor;
    if (!cursor) throw new Error('expected a cursor');
    const changes: Array<Partial<SnapshotPageOptions>> = [
      { sourceDatasets: ['core.event_log'] },
      { sourceDatasets: ['core.event_log', 'third.dataset'] },
      { eventIds: ['e1', 'e2', 'e3', 'e4'] },
      { eventIds: undefined },
      { subjectIds: ['s-odd'] },
      { eventAtFrom: T - 9_999 },
      { eventAtFrom: undefined },
      { eventAtTo: T + 9_999 },
      { eventAtTo: undefined },
      { providerIngestedAtFrom: 2 },
      { providerIngestedAtFrom: undefined },
      { providerIngestedAtTo: 2 ** 40 + 1 },
      { providerIngestedAtTo: undefined },
      { nowMs: NOW_MS + 1 },
      { tenantKey: 'other-tenant' },
    ];
    for (const change of changes) {
      await expect(f.page({ ...base, ...change, cursor })).rejects.toThrow(
        'Invalid archive scan cursor'
      );
    }
    const same = await f.page({
      ...base,
      cursor,
      sourceDatasets: ['other.dataset', 'core.event_log'],
      eventIds: ['e5', 'e4', 'e3', 'e2', 'e1'],
    });
    expect(same.records.length).toBeGreaterThan(0);
  });

  it('ties a cursor to the subject ids and the manifest commit bound of its scope', async () => {
    const f = await populated();
    const withSubjects: Partial<SnapshotPageOptions> = {
      pageSize: 1,
      subjectIds: ['s-odd', 's-even'],
    };
    const cursor = (await f.page(withSubjects)).nextCursor;
    if (!cursor) throw new Error('expected a cursor');
    await expect(f.page({ pageSize: 1, subjectIds: ['s-odd'], cursor })).rejects.toThrow(
      'Invalid archive scan cursor'
    );
    await expect(f.page({ pageSize: 1, cursor })).rejects.toThrow('Invalid archive scan cursor');
    await expect(
      f.page({ pageSize: 1, subjectIds: ['s-even', 's-odd'], cursor })
    ).resolves.toBeDefined();
  });

  it('refuses to resume a cursor under a manifest commit bound', async () => {
    const f = await populated();
    const cursor = (await f.page({ pageSize: 2 })).nextCursor;
    if (!cursor) throw new Error('expected a cursor');
    await expect(f.page({ pageSize: 2, cursor, dataManifestsAddedFrom: 0 })).rejects.toThrow(
      'Archive manifest commit bound cannot resume a page cursor'
    );
  });
});

describe('what a read returns', () => {
  it('returns the rows of the scope: tenant, dataset, event ids and subjects', async () => {
    const f = await populated();
    await f.append('other-tenant', [record({ event_id: 'o1', tenant_key: 'other-tenant' })]);
    await f.append('other-dataset', [record({ event_id: 'o2', source_dataset: 'other.dataset' })]);
    expect(ids((await f.read()).records)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(ids((await f.read({ sourceDatasets: ['other.dataset'] })).records)).toEqual(['o2']);
    expect(ids((await f.read({ tenantKey: 'other-tenant' })).records)).toEqual(['o1']);
    expect(ids((await f.read({ eventIds: ['e2', 'e4', 'missing'] })).records)).toEqual([
      'e2',
      'e4',
    ]);
    expect(ids((await f.read({ subjectIds: ['s-odd'] })).records)).toEqual(['e2', 'e4']);
    expect(ids((await f.read({ subjectIds: ['s-even'] })).records)).toEqual(['e1', 'e3', 'e5']);
    expect(ids((await f.read({ eventIds: ['e1', 'e2'], subjectIds: ['s-odd'] })).records)).toEqual([
      'e2',
    ]);
  });

  it('bounds event time inclusively from below and exclusively from above', async () => {
    const f = await populated();
    const read = async (extra: { eventAtFrom?: number; eventAtTo?: number }) =>
      ids((await f.read(extra)).records);
    expect(await read({ eventAtFrom: T + 2000 })).toEqual(['e3', 'e4', 'e5']);
    expect(await read({ eventAtFrom: T + 2001 })).toEqual(['e4', 'e5']);
    expect(await read({ eventAtTo: T + 2000 })).toEqual(['e1', 'e2']);
    expect(await read({ eventAtTo: T + 2001 })).toEqual(['e1', 'e2', 'e3']);
    expect(await read({ eventAtFrom: T + 1000, eventAtTo: T + 4000 })).toEqual(['e2', 'e3', 'e4']);
    expect(await read({ eventAtFrom: 0, eventAtTo: 0 })).toEqual([]);
    expect(await read({ eventAtFrom: T + 10_000 })).toEqual([]);
  });

  it('never returns a row at or past its expiry', async () => {
    const f = readerFixture();
    await f.append('expiry', [
      record({ event_id: 'never' }),
      record({ event_id: 'later', expires_at: NOW_MS + 1 }),
      record({ event_id: 'now', expires_at: NOW_MS }),
      record({ event_id: 'past', expires_at: NOW_MS - 1 }),
      record({ event_id: 'zero', expires_at: 0 }),
    ]);
    expect(ids((await f.read()).records)).toEqual(['later', 'never']);
    expect(ids((await f.read({ nowMs: NOW_MS - 1 })).records)).toEqual(['later', 'never', 'now']);
    expect(ids((await f.read({ nowMs: NOW_MS + 1 })).records)).toEqual(['never']);
  });

  it('does not open files whose bounds exclude the scope', async () => {
    const f = readerFixture();
    await f.append('early', [record({ event_id: 'early', event_at: T })]);
    const early = [...f.store.objects.keys()].filter((path) => path.endsWith('.parquet'));
    await f.append('late', [record({ event_id: 'late', event_at: T + 100_000 })]);
    const late = [...f.store.objects.keys()].filter(
      (path) => path.endsWith('.parquet') && !early.includes(path)
    );
    await f.append('other', [
      record({ event_id: 'other', event_at: T + 50_000, source_dataset: 'zz.other' }),
    ]);
    const other = [...f.store.objects.keys()].filter(
      (path) => path.endsWith('.parquet') && !early.includes(path) && !late.includes(path)
    );

    const opened = async (extra: Record<string, unknown>) => {
      const read = vi.spyOn(f.store, 'read');
      const found = await f.read(extra);
      const paths = read.mock.calls.map(([path]) => path);
      read.mockRestore();
      return { ids: ids(found.records), paths };
    };
    const all = await opened({});
    expect(all.ids).toEqual(['early', 'late']);
    expect(all.paths).toEqual(expect.arrayContaining([...early, ...late]));
    expect(all.paths.some((path) => other.includes(path))).toBe(false);

    const from = await opened({ eventAtFrom: T + 50_000 });
    expect(from.ids).toEqual(['late']);
    expect(from.paths.some((path) => early.includes(path))).toBe(false);
    const to = await opened({ eventAtTo: T + 50_000 });
    expect(to.ids).toEqual(['early']);
    expect(to.paths.some((path) => late.includes(path))).toBe(false);
    const edge = await opened({ eventAtFrom: T + 100_000 });
    expect(edge.ids).toEqual(['late']);
    const exclusive = await opened({ eventAtTo: T });
    expect(exclusive.ids).toEqual([]);
    expect(exclusive.paths.some((path) => early.includes(path))).toBe(false);

    const byId = await opened({ eventIds: ['late'] });
    expect(byId.ids).toEqual(['late']);
    expect(byId.paths.some((path) => early.includes(path))).toBe(false);
    const missing = await opened({ eventIds: ['nothing-like-it'] });
    expect(missing.ids).toEqual([]);
    const bySubject = await opened({ subjectIds: ['nobody'] });
    expect(bySubject.ids).toEqual([]);
  });

  it('keeps one copy of an event written twice, whatever its storage details', async () => {
    const f = readerFixture();
    await f.append('first', [record({ event_id: 'dup', detail_ciphertext: 'first-body' })]);
    await f.append('second', [
      record({
        event_id: 'dup',
        detail_ciphertext: 'second-body',
        detail_key_version: '2',
        storage_generation: 'new-generation',
        ingested_at: 1793000009000,
      }),
    ]);
    const found = await f.read();
    expect(found.records).toHaveLength(1);
    expect(found.records[0]?.detail_ciphertext).toBe('first-body');
    const pages = await f.page();
    expect(pages.records).toHaveLength(1);
  });

  it('refuses an event written twice with a different content', async () => {
    for (const change of [
      { action: 'other' },
      { result: 'failure' },
      { log_type: 'security' },
      { event_at: T + 1 },
      { expires_at: NOW_MS + 5 },
      { payload_hmac: 'b'.repeat(64) },
      { subject_id: 'someone' },
    ]) {
      const f = readerFixture();
      await f.append('first', [record({ event_id: 'dup', event_at: T })]);
      await f.append('second', [record({ event_id: 'dup', event_at: T, ...change })]);
      await expect(f.read()).rejects.toBeInstanceOf(IcebergBatchCollisionError);
    }
  });

  it('stops materialising rows past the row budget, and counts only rows kept', async () => {
    const f = readerFixture();
    await f.append(
      'rows',
      Array.from({ length: 3 }, (_, i) => record({ event_id: `r${i}` }))
    );
    expect((await f.read({ limits: { maxRows: 3 } })).records).toHaveLength(3);
    await expect(f.read({ limits: { maxRows: 2 } })).rejects.toBeInstanceOf(IcebergBudgetError);
    await expect(f.read({ limits: { maxRows: 2 } })).rejects.toThrow(
      'Archive materialized row budget exceeded'
    );
    const dupes = readerFixture();
    await dupes.append('a', [record({ event_id: 'same' })]);
    await dupes.append('b', [record({ event_id: 'same' })]);
    expect((await dupes.read({ limits: { maxRows: 1 } })).records).toHaveLength(1);
  });
});

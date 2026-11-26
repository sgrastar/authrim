import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotDeleteIntent, prepareSnapshotRowDelete } from '../position-delete.js';
import { LOG_ARCHIVE_PENDING_PIN_TTL_MS } from '../writer.js';
import type { SnapshotRowDelete, SnapshotRowDeletePage } from '../reader.js';
import { IcebergBatchCollisionError } from '../types.js';
import { OPERATION_ID, deleteFixture, sha256 } from './position-delete-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

type Fixture = Awaited<ReturnType<typeof deleteFixture>>;

/** A plan whose deletes are replaced; the intent is re-signed, so only prepare's own checks apply. */
let counter = 0;
async function withDeletes(
  f: Fixture,
  change: (deletes: SnapshotRowDelete[]) => SnapshotRowDelete[]
) {
  counter += 1;
  const intent = await f.intent(
    (page) => ({ ...page, deletes: change(page.deletes) }),
    await sha256(`operation-${counter}`)
  );
  return f.prepare(intent);
}

const message = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: Error) => error.message
  );

describe('prepareSnapshotRowDelete: the delete it builds', () => {
  it('stages one delete snapshot with its summary, manifests, pin and artifacts', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    const base = f.catalog.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === intent.plan.snapshotId
    );
    if (base) {
      base.summary = {
        ...base.summary,
        'total-records': '10',
        'total-data-files': '2',
        'total-files-size': '1000',
        'total-delete-files': '3',
        'total-position-deletes': '4',
        'total-equality-deletes': '5',
      };
    }
    const mutation = await f.prepare(intent);
    expect(mutation).toMatchObject({ operationId: OPERATION_ID, snapshotId: intent.snapshotId });

    const added = mutation.update.updates.find((u) => u.action === 'add-snapshot');
    if (added?.action !== 'add-snapshot') throw new Error('expected a snapshot');
    const snapshot = added.snapshot;
    const summary = snapshot.summary as Record<string, string>;
    const deleteFile = mutation.artifacts.find((path) => path.endsWith('-deletes.parquet')) ?? '';
    const size = String(f.store.objects.get(deleteFile)?.bytes.byteLength);
    expect(summary).toMatchObject({
      operation: 'delete',
      'added-delete-files': '1',
      'added-position-deletes': '2',
      'added-files-size': size,
      'changed-partition-count': '1',
      'total-records': '10',
      'total-data-files': '2',
      'total-files-size': String(1000 + Number(size)),
      'total-delete-files': '4',
      'total-position-deletes': '6',
      'total-equality-deletes': '5',
      'authrim.position-delete-id': OPERATION_ID,
      'authrim.position-delete-plan-digest': intent.planDigest,
    });
    expect(snapshot['sequence-number']).toBe(intent.plan.sequenceNumber + 1);
    expect(snapshot['timestamp-ms']).toBe(intent.createdAt);
    expect(String(snapshot['parent-snapshot-id'])).toBe(intent.plan.snapshotId);
    expect(String(snapshot['snapshot-id'])).toBe(intent.snapshotId);

    const pin = `authrim-delete-${OPERATION_ID}`;
    const refs = mutation.update.updates.filter((u) => u.action === 'set-snapshot-ref');
    expect(refs).toHaveLength(2);
    expect(refs.find((u) => u['ref-name'] === pin)).toMatchObject({
      type: 'tag',
      'max-ref-age-ms': LOG_ARCHIVE_PENDING_PIN_TTL_MS,
    });
    expect(mutation.update.requirements).toHaveLength(3);
    expect(mutation.update.requirements).toContainEqual({
      type: 'assert-ref-snapshot-id',
      ref: pin,
      'snapshot-id': null,
    });
    expect(mutation.artifacts).toContain(
      `${f.catalog.metadata.location}/metadata/authrim-${OPERATION_ID}-delete-m0.avro`
    );
    expect(deleteFile).toMatch(
      new RegExp(`/data/authrim-${OPERATION_ID}-[0-9a-f]{24}-deletes\\.parquet$`)
    );
    expect(f.store.objects.get(deleteFile)?.identity).toBe(
      `position-delete:${OPERATION_ID}:${intent.plan.physicalFingerprint}`
    );
    expect(new Set(mutation.artifacts).size).toBe(mutation.artifacts.length);
  });

  it('counts missing totals as zero', async () => {
    const f = await deleteFixture();
    const mutation = await f.prepare(await f.intent());
    const added = mutation.update.updates.find((u) => u.action === 'add-snapshot');
    if (added?.action !== 'add-snapshot') throw new Error('expected a snapshot');
    const summary = added.snapshot.summary as Record<string, string>;
    expect(summary['total-equality-deletes']).toBe('0');
    expect(summary['total-position-deletes']).toBe('2');
    expect(summary['total-delete-files']).toBe('1');
  });

  it('writes one delete file per partition and refuses more than the partition budget', async () => {
    const f = await deleteFixture({ pipeline: true });
    const day = (partition: number | null): Record<string, unknown> => ({
      __ingest_ts_day: partition,
    });
    const deletes =
      (count: number): ((rows: SnapshotRowDelete[]) => SnapshotRowDelete[]) =>
      (rows) =>
        Array.from({ length: count }, (_, i) => ({
          ...rows[0],
          pos: String(i),
          partition: day(i),
        }));
    const fifteen = await withDeletes(f, deletes(15));
    expect(fifteen.artifacts.filter((path) => path.endsWith('-deletes.parquet'))).toHaveLength(15);
    expect(await message(withDeletes(f, deletes(17)))).toBe(
      'Snapshot delete partition budget exceeded'
    );
    const same = await withDeletes(f, (rows) =>
      rows.map((row, i) => ({ ...row, pos: String(i), partition: day(5) }))
    );
    expect(same.artifacts.filter((path) => path.endsWith('-deletes.parquet'))).toHaveLength(1);
  });
});

describe('prepareSnapshotRowDelete: what it refuses', () => {
  it('refuses an intent for another table, schema, snapshot or an expired lease', async () => {
    const changed = 'Snapshot delete intent changed or expired';
    const f = await deleteFixture();
    expect(await message(f.prepare(await f.intent((p) => ({ ...p, tableUuid: 'other' }))))).toBe(
      changed
    );
    expect(
      await message(
        f.prepare(await f.intent((p) => ({ ...p, physicalFingerprint: 'b'.repeat(64) })))
      )
    ).toBe(changed);
    expect(await message(f.prepare(await f.intent((p) => ({ ...p, snapshotId: '999' }))))).toBe(
      changed
    );
    const lease = LOG_ARCHIVE_PENDING_PIN_TTL_MS;
    vi.useFakeTimers({ toFake: ['Date'] });
    const nowMs = Date.UTC(2026, 0, 1);
    vi.setSystemTime(nowMs);
    // An intent made at `created` expires at created + lease; the clock is frozen at nowMs.
    const made = (created: number) => f.intent(undefined, OPERATION_ID, created);
    expect(await message(f.prepare(await made(nowMs - lease - 1000)))).toBe(changed);
    expect(await message(f.prepare(await made(nowMs - lease - 1)))).toBe(changed);
    expect(await message(f.prepare(await made(nowMs - lease)))).toBe(changed);
    await expect(f.prepare(await made(nowMs - lease + 1))).resolves.toBeDefined();
    await expect(f.prepare(await f.intent())).resolves.toBeDefined();
  });

  it('refuses to prepare when the snapshot id of the delete is already in the table', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    const existing = f.catalog.metadata.snapshots?.[0];
    if (!existing) throw new Error('expected a snapshot');
    // The intent stays valid; the table alone is made to already hold the snapshot id.
    f.catalog.metadata.snapshots = [
      ...(f.catalog.metadata.snapshots ?? []),
      { ...existing, 'snapshot-id': Number(intent.snapshotId) },
    ];
    expect(await message(f.prepare(intent))).toBe('Snapshot delete ID already exists');
    await expect(f.prepare(intent)).rejects.toBeInstanceOf(IcebergBatchCollisionError);
  });

  it('refuses a base snapshot the table no longer lists', async () => {
    const f = await deleteFixture();
    const intent = await f.intent();
    f.catalog.metadata.snapshots = [];
    expect(await message(f.prepare(intent))).toBe('Snapshot delete base missing');
  });

  it('refuses a delete position that is not a position in a data file of the table', async () => {
    const position = 'Invalid snapshot delete position';
    const f = await deleteFixture();
    const edit = (change: Partial<SnapshotRowDelete>) =>
      message(withDeletes(f, (rows) => rows.slice(0, 1).map((row) => ({ ...row, ...change }))));
    expect(await edit({ filePath: 's3://elsewhere/data/f.parquet' })).toBe(position);
    expect(await edit({ filePath: `${f.catalog.metadata.location}/metadata/f.parquet` })).toBe(
      position
    );
    expect(await edit({ filePath: `${f.catalog.metadata.location}/data` })).toBe(position);
    expect(await edit({ partitionSpecId: 99 })).toBe(position);
    for (const pos of [
      '-1',
      '01',
      '1.5',
      'abc',
      '',
      '10000000000000000000',
      '9223372036854775808',
      ' 1',
    ]) {
      expect(await edit({ pos })).toBe(position);
    }
    expect(await edit({ pos: '0' })).toBe('resolved');
    expect(await edit({ pos: '9223372036854775807' })).toBe('resolved');
    expect(await edit({ pos: '1234567890123456789' })).toBe('resolved');
    expect(await edit({ filePath: `${f.catalog.metadata.location}/data/x/y.parquet` })).toBe(
      'resolved'
    );
  });

  it('refuses a partition that does not match the DAY partition of the table', async () => {
    const day = 'Invalid snapshot delete DAY partition';
    const plain = await deleteFixture();
    const editPlain = (partition: Record<string, unknown>) =>
      message(withDeletes(plain, (rows) => rows.slice(0, 1).map((row) => ({ ...row, partition }))));
    expect(await editPlain({ extra: 1 })).toBe(day);
    expect(await editPlain({})).toBe('resolved');

    const f = await deleteFixture({ pipeline: true });
    const edit = (partition: Record<string, unknown>) =>
      message(withDeletes(f, (rows) => rows.slice(0, 1).map((row) => ({ ...row, partition }))));
    expect(await edit({})).toBe(day);
    expect(await edit({ other: 1 })).toBe(day);
    expect(await edit({ __ingest_ts_day: 1, other: 1 })).toBe(day);
    expect(await edit({ __ingest_ts_day: 1.5 })).toBe(day);
    expect(await edit({ __ingest_ts_day: '5' })).toBe(day);
    expect(await edit({ __ingest_ts_day: -2147483649 })).toBe(day);
    expect(await edit({ __ingest_ts_day: 2147483648 })).toBe(day);
    expect(await edit({ __ingest_ts_day: -2147483648 })).toBe('resolved');
    expect(await edit({ __ingest_ts_day: 2147483647 })).toBe('resolved');
    expect(await edit({ __ingest_ts_day: null })).toBe('resolved');
    expect(await edit({ __ingest_ts_day: 0 })).toBe('resolved');
  });

  it('refuses the same position twice, but not the same position in another file', async () => {
    const f = await deleteFixture();
    expect(
      await message(
        withDeletes(f, (rows) => {
          const first = rows[0];
          return [first, { ...first }];
        })
      )
    ).toBe('Duplicate snapshot delete position');
    expect(
      await message(
        withDeletes(f, (rows) => {
          const first = rows[0];
          return [
            first,
            { ...first, filePath: `${first.filePath}.other` },
            { ...first, pos: '77' },
          ];
        })
      )
    ).toBe('resolved');
  });
});

describe('prepareSnapshotRowDelete and the plan it was given', () => {
  it('works from a plan page and an operation id alone', async () => {
    const f = await deleteFixture();
    const page: SnapshotRowDeletePage = await f.plan();
    const intent = await createSnapshotDeleteIntent(page, OPERATION_ID, Date.now());
    const mutation = await prepareSnapshotRowDelete({
      table: await f.catalog.loadTable(),
      store: f.store,
      intent,
    });
    expect(mutation.plan).toStrictEqual(page);
  });
});

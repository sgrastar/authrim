import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_ARCHIVE_PENDING_PIN_TTL_MS,
  ScheduledIcebergWriter,
  boundedResolver,
  icebergBatchDigest,
  type IcebergBatchCheckpoint,
  type IcebergWriterLimits,
} from '../writer.js';
import {
  IcebergBatchCollisionError,
  IcebergBudgetError,
  IcebergCommitUnknownError,
} from '../types.js';
import { avroFile } from './binary-builders.js';
import { sha256Hex } from './digest-helpers.js';
import { LOCATION, MemoryCatalog, MemoryJournal, MemoryStore, record } from './fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

function build(options: { limits?: Partial<IcebergWriterLimits>; tableLocation?: string } = {}) {
  const catalog = new MemoryCatalog();
  const store = new MemoryStore();
  const journal = new MemoryJournal();
  const writer = new ScheduledIcebergWriter({
    catalog,
    store,
    journal,
    storageGeneration: 'new-generation',
    tableLocation: options.tableLocation ?? LOCATION,
    limits: options.limits,
  });
  const append = (batchId: string, records = [record()]) =>
    writer.appendBatch({ batchId, fence: journal.activeFence, records });
  return { catalog, store, journal, writer, append };
}

describe('icebergBatchDigest', () => {
  it('is the SHA-256 of the canonical rows, one per line, keys in sorted order', async () => {
    const a = record({ event_id: 'a' });
    const b = record({ event_id: 'b' });
    const canonical = (row: Record<string, unknown>): string =>
      JSON.stringify(
        Object.fromEntries(Object.entries(row).sort(([x], [y]) => x.localeCompare(y)))
      );
    expect(await icebergBatchDigest([a, b])).toBe(
      await sha256Hex(`${canonical(a)}\n${canonical(b)}`)
    );
    expect(await icebergBatchDigest([a])).toBe(await sha256Hex(canonical(a)));
    expect(await icebergBatchDigest([a])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order the keys were written in', async () => {
    const row = record();
    const reversed = Object.fromEntries(Object.entries(row).reverse()) as typeof row;
    expect(await icebergBatchDigest([reversed])).toBe(await icebergBatchDigest([row]));
    expect(await icebergBatchDigest([row, record({ event_id: 'b' })])).not.toBe(
      await icebergBatchDigest([record({ event_id: 'b' }), row])
    );
  });

  it('pads hex bytes below 0x10 with a zero', async () => {
    // Digests with a leading zero byte are 64 characters long all the same.
    for (let i = 0; i < 40; i += 1) {
      expect(await icebergBatchDigest([record({ event_id: `pad-${i}` })])).toHaveLength(64);
    }
  });
});

const limitOf = (key: string, value: number): Partial<IcebergWriterLimits> =>
  Object.fromEntries([[key, value]]);

describe('writer limits', () => {
  const defaults: IcebergWriterLimits = {
    maxRows: 1000,
    maxInputBytes: 4 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxReadBytes: 16 * 1024 * 1024,
    maxWriteBytes: 24 * 1024 * 1024,
    maxObjects: 32,
    maxCommitAttempts: 3,
  };

  it('accepts limits from one up to the default and refuses any other', () => {
    for (const [key, max] of Object.entries(defaults) as Array<[string, number]>) {
      for (const bad of [0, -1, 1.5, Number.NaN, max + 1, Number.POSITIVE_INFINITY]) {
        expect(() => build({ limits: limitOf(key, bad) })).toThrow('Invalid Iceberg writer limit');
      }
      expect(() => build({ limits: limitOf(key, max) })).not.toThrow();
      expect(() => build({ limits: limitOf(key, 1) })).not.toThrow();
    }
  });
});

describe('boundedResolver', () => {
  const limits: IcebergWriterLimits = {
    maxRows: 10,
    maxInputBytes: 1000,
    maxFileBytes: 100,
    maxReadBytes: 1000,
    maxWriteBytes: 150,
    maxObjects: 2,
    maxCommitAttempts: 1,
  };

  it('hands out at most the object budget of writers', () => {
    const resolver = boundedResolver(new MemoryStore(), 'id', limits);
    resolver.writer('a');
    resolver.writer('b');
    expect(() => resolver.writer('c')).toThrow('Iceberg object budget exceeded');
    expect(() => resolver.writer('c')).toThrow(IcebergBudgetError);
  });

  it('refuses output past the file limit and writes past the write budget', async () => {
    const store = new MemoryStore();
    const resolver = boundedResolver(store, 'id', { ...limits, maxObjects: 10 });
    const first = resolver.writer('first');
    first.appendBytes(new Uint8Array(100));
    expect(() => first.appendBytes(new Uint8Array(1))).toThrow('Iceberg output exceeds file limit');
    await first.finish();
    expect(store.objects.get('first')?.bytes.byteLength).toBe(100);
    expect(store.objects.get('first')?.identity).toBe('id');

    const second = resolver.writer('second');
    second.appendBytes(new Uint8Array(50));
    await second.finish();
    const third = resolver.writer('third-over');
    expect(() => third.appendBytes(new Uint8Array(101))).toThrow(
      'Iceberg output exceeds file limit'
    );

    const tight = boundedResolver(new MemoryStore(), 'id', { ...limits, maxWriteBytes: 100 });
    const one = tight.writer('one');
    one.appendBytes(new Uint8Array(60));
    await one.finish();
    const two = tight.writer('two');
    two.appendBytes(new Uint8Array(41));
    await expect(two.finish()).rejects.toThrow('Iceberg write budget exceeded');
    const exact = boundedResolver(new MemoryStore(), 'id', { ...limits, maxWriteBytes: 100 });
    const a = exact.writer('a');
    a.appendBytes(new Uint8Array(60));
    await a.finish();
    const b = exact.writer('b');
    b.appendBytes(new Uint8Array(40));
    await expect(b.finish()).resolves.toBeUndefined();
  });

  it('reads through the bounded reader', async () => {
    const store = new MemoryStore();
    const bytes = avroFile({ schema: 'long', header: { 'avro.codec': [110, 117, 108, 108] } });
    store.objects.set('x.avro', { bytes, identity: 'i' });
    const resolver = boundedResolver(store, 'id', {
      ...limits,
      maxFileBytes: 1 << 20,
      maxReadBytes: 1 << 20,
    });
    const reader = await resolver.reader('x.avro');
    expect(reader.byteLength).toBe(bytes.byteLength);
  });
});

describe('appendBatch input validation', () => {
  it('accepts batch ids of word characters and dashes up to 128, and refuses others', async () => {
    const { append } = build();
    for (const batchId of ['a', 'A-b_9', 'x'.repeat(128)]) {
      await expect(append(batchId, [record({ event_id: batchId })])).resolves.toBeDefined();
    }
    for (const batchId of [
      '',
      'x'.repeat(129),
      'has space',
      'dot.dot',
      'slash/slash',
      'é',
      'a\n',
    ]) {
      await expect(append(batchId)).rejects.toThrow('Invalid Iceberg batch size or identity');
    }
  });

  it('refuses an empty batch and one over the row limit', async () => {
    const { append } = build({ limits: { maxRows: 2 } });
    await expect(append('empty', [])).rejects.toThrow('Invalid Iceberg batch size or identity');
    const rows = (count: number) =>
      Array.from({ length: count }, (_, i) => record({ event_id: `e${i}` }));
    await expect(append('three', rows(3))).rejects.toThrow(
      'Invalid Iceberg batch size or identity'
    );
    await expect(append('two', rows(2))).resolves.toMatchObject({ recordCount: 2 });
    await expect(append('one', rows(1))).resolves.toMatchObject({ recordCount: 1 });
  });

  it('refuses rows that are not archive records', async () => {
    const { append } = build();
    await expect(append('bad', [record({ event_id: '' })])).rejects.toThrow();
    await expect(
      append('bad2', [record(), { ...record({ event_id: 'b' }), extra: 1 } as never])
    ).rejects.toThrow();
  });

  it('refuses a batch that mixes generations, tenants or datasets, or repeats an event', async () => {
    const { append } = build();
    const scope = 'Iceberg batch scope mismatch';
    await expect(
      append('g', [record(), record({ event_id: 'b', storage_generation: 'old' })])
    ).rejects.toThrow(scope);
    await expect(append('g1', [record({ storage_generation: 'old' })])).rejects.toThrow(scope);
    await expect(
      append('t', [record(), record({ event_id: 'b', tenant_key: 'other' })])
    ).rejects.toThrow(scope);
    await expect(
      append('d', [record(), record({ event_id: 'b', source_dataset: 'pii.pii_log' })])
    ).rejects.toThrow(scope);
    await expect(append('r', [record(), record()])).rejects.toThrow(
      'Repeated event in Iceberg batch'
    );
    await expect(append('r', [record(), record()])).rejects.toBeInstanceOf(
      IcebergBatchCollisionError
    );
  });

  it('bounds the input bytes, counting a newline per row', async () => {
    const rows = [record({ event_id: 'a' }), record({ event_id: 'b' })];
    const canonical = (row: Record<string, unknown>): number =>
      new TextEncoder().encode(
        JSON.stringify(
          Object.fromEntries(Object.entries(row).sort(([x], [y]) => x.localeCompare(y)))
        )
      ).byteLength + 1;
    const total = rows.reduce((sum, row) => sum + canonical(row), 0);
    await expect(
      build({ limits: { maxInputBytes: total } }).append('exact', rows)
    ).resolves.toBeDefined();
    const over = build({ limits: { maxInputBytes: total - 1 } });
    await expect(over.append('over', rows)).rejects.toThrow('Iceberg input budget exceeded');
    expect(over.store.objects.size).toBe(0);
  });

  it('refuses a table whose location is not the configured one', async () => {
    const { append } = build({ tableLocation: 's3://authrim-test/logs/other' });
    await expect(append('loc')).rejects.toThrow('Iceberg table location changed');
  });

  it('refuses a table that is not a log archive table', async () => {
    const f = build();
    f.catalog.metadata.schemas[0].fields.pop();
    await expect(f.append('bad-table')).rejects.toThrow();
  });
});

describe('checkpoints', () => {
  function build_(mutate: (checkpoint: IcebergBatchCheckpoint) => IcebergBatchCheckpoint) {
    const f = build();
    const original = f.journal.loadOrCreate.bind(f.journal);
    f.journal.loadOrCreate = async (candidate, fence) =>
      mutate({ ...(await original(candidate, fence)) });
    return f;
  }

  it('refuses a persisted checkpoint whose identity differs from the batch', async () => {
    const changes: Array<Partial<IcebergBatchCheckpoint>> = [
      { batchId: 'other' },
      { batchDigest: 'other' },
      { tableUuid: 'other' },
      { recordCount: 99 },
      { schemaId: 9 },
      { physicalFingerprint: 'other' },
      { tenantKey: 'other' },
      { sourceDataset: 'other' },
      { storageGeneration: 'other' },
      { pin: 'other' },
    ];
    for (const change of changes) {
      const f = build_((checkpoint) => ({ ...checkpoint, ...change }));
      await expect(f.append('batch')).rejects.toThrow('Iceberg checkpoint identity conflict');
    }
    const fine = build_((checkpoint) => ({ ...checkpoint, createdAt: checkpoint.createdAt }));
    await expect(fine.append('batch')).resolves.toBeDefined();
  });

  it('refuses a persisted snapshot id that is not a positive safe integer', async () => {
    for (const snapshotId of ['', 'abc', '0', '-5', '1.5', '9007199254740993', '12a']) {
      const f = build_((checkpoint) => ({ ...checkpoint, snapshotId }));
      await expect(f.append('batch')).rejects.toThrow('Invalid persisted Iceberg snapshot ID');
    }
    const f = build_((checkpoint) => ({ ...checkpoint, snapshotId: '1' }));
    await expect(f.append('batch')).resolves.toMatchObject({ snapshotId: '1' });
  });

  it('refuses a pending pin lease that has run out, is not an integer or lasts too long', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_793_000_000_000);
    const lease = 'Pending Iceberg batch pin lease expired; source must be retained';
    const cases: Array<(checkpoint: IcebergBatchCheckpoint) => Partial<IcebergBatchCheckpoint>> = [
      () => ({ pinExpiresAt: 1_793_000_000_000 }),
      () => ({ pinExpiresAt: 1_793_000_000_000 - 1 }),
      () => ({ pinExpiresAt: 1_793_000_100_000.5 }),
      (checkpoint) => ({ createdAt: checkpoint.createdAt - 1 }),
    ];
    for (const change of cases) {
      const f = build_((checkpoint) => ({ ...checkpoint, ...change(checkpoint) }));
      const outcome = await f.append('batch').then(
        () => 'resolved',
        (error: unknown) => error
      );
      expect(outcome).toBeInstanceOf(IcebergCommitUnknownError);
      expect((outcome as Error).message).toBe(lease);
    }
    const edge = build_((checkpoint) => ({ ...checkpoint, pinExpiresAt: 1_793_000_000_001 }));
    await expect(edge.append('batch')).resolves.toBeDefined();
    const kept = build_((checkpoint) => ({
      ...checkpoint,
      createdAt: checkpoint.pinExpiresAt - LOG_ARCHIVE_PENDING_PIN_TTL_MS,
    }));
    await expect(kept.append('batch')).resolves.toBeDefined();
  });

  it('refuses a checkpoint with an invalid creation time or state', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_793_000_000_000);
    const invalid = 'Invalid Iceberg checkpoint state';
    const soon = 1_793_000_000_000 + 1000;
    for (const change of [
      { createdAt: soon - LOG_ARCHIVE_PENDING_PIN_TTL_MS + 0.5, pinExpiresAt: soon },
      { state: 'weird' as never },
      { state: undefined as never },
    ]) {
      const f = build_((checkpoint) => ({ ...checkpoint, ...change }));
      await expect(f.append('batch')).rejects.toThrow(invalid);
    }
    const committedFirst = build_((checkpoint) => ({ ...checkpoint, state: 'committed' }));
    await expect(committedFirst.append('batch')).rejects.toThrow(
      'Committed batch requires reconciliation'
    );
    await expect(committedFirst.append('batch')).rejects.toBeInstanceOf(IcebergCommitUnknownError);
  });
});

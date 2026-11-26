import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BufferedLogChunkFlushWorker,
  bufferedLogChunkGroupKey,
  flushLogChunkAndEnqueueDelivery,
  type BufferedLogChunkFlushGroup,
} from '../flush-worker';
import type { LogChunkRecord } from '../types';

afterEach(() => {
  vi.useRealTimers();
});

const T = 1_700_000_000_000;

function encryption(tenantKey: string, logType = 'normal') {
  return {
    keyBytes: new Uint8Array(32).fill(9),
    encryptionScope: `tenant:${tenantKey}:${logType}:archive`,
    keyVersion: 1,
  };
}

function environment() {
  const put = vi.fn(async () => undefined);
  const send = vi.fn(async (_payload: unknown) => undefined);
  return {
    bucket: { put } as unknown as R2Bucket,
    put,
    send,
    queueBindings: { LOGGING_DELIVERY_QUEUE: { send } },
  };
}

const event = (id: string, eventAt?: number): LogChunkRecord => ({
  id,
  eventAt: eventAt as number,
  payload: { id },
});

function groupOf(
  env: ReturnType<typeof environment>,
  overrides: Partial<BufferedLogChunkFlushGroup> = {}
): BufferedLogChunkFlushGroup {
  return {
    bucket: env.bucket,
    tenantKey: 't_1',
    logType: 'normal',
    plane: 'archive',
    destinations: [{ destinationId: 'dest_1', lane: 'default' }],
    queueBindings: env.queueBindings,
    encryption: encryption('t_1'),
    profile: {
      name: 'default',
      maxRecords: 3,
      maxBytes: 1_000_000,
      maxIntervalMs: 1_000,
      compression: 'none',
    },
    ...overrides,
  };
}

describe('bufferedLogChunkGroupKey', () => {
  const base = {
    bucket: { put: vi.fn() } as unknown as R2Bucket,
    tenantKey: 't_1',
    logType: 'audit',
    plane: 'archive',
    queueBindings: {},
  } as const;

  it('joins the identity of the group with bars, destinations sorted', () => {
    expect(
      bufferedLogChunkGroupKey({
        ...base,
        surface: 'admin',
        prefix: 'pre',
        indexProfile: 'idx',
        compression: 'none',
        destinations: [
          { destinationId: 'b', lane: 'bulk' },
          { destinationId: 'a', lane: 'critical' },
        ],
      })
    ).toBe('t_1|audit|archive|admin|pre|idx|none|a:critical,b:bulk');
  });

  it('leaves the optional parts empty, and a lone destination without a comma', () => {
    expect(
      bufferedLogChunkGroupKey({ ...base, destinations: [{ destinationId: 'a', lane: 'default' }] })
    ).toBe('t_1|audit|archive|||||a:default');
    expect(bufferedLogChunkGroupKey({ ...base, destinations: [] })).toBe('t_1|audit|archive|||||');
  });

  it('reads a null optional part as an empty one', () => {
    const destinations = [{ destinationId: 'a', lane: 'default' }] as const;
    const empty = bufferedLogChunkGroupKey({ ...base, destinations });
    for (const part of ['surface', 'prefix', 'indexProfile', 'compression'] as const) {
      expect(bufferedLogChunkGroupKey({ ...base, destinations, [part]: null as never })).toBe(
        empty
      );
    }
  });

  it('tells groups apart by every part', () => {
    const keys = new Set<string>();
    const destinations = [{ destinationId: 'a', lane: 'default' }] as const;
    for (const change of [
      {},
      { tenantKey: 't_2' },
      { logType: 'security' },
      { plane: 'primary' },
      { surface: 's' },
      { prefix: 'p' },
      { indexProfile: 'i' },
      { compression: 'none' },
    ] as const) {
      keys.add(bufferedLogChunkGroupKey({ ...base, destinations, ...change }));
    }
    expect(keys.size).toBe(8);
  });
});

describe('flushLogChunkAndEnqueueDelivery', () => {
  const input = (env: ReturnType<typeof environment>) => ({
    bucket: env.bucket,
    tenantKey: 't_1',
    logType: 'normal' as const,
    plane: 'archive' as const,
    now: T,
    encryption: encryption('t_1'),
    records: [event('a', T), event('b', T)],
    queueBindings: env.queueBindings,
  });

  it('sends one fan-out payload per destination, with the chunk it just wrote', async () => {
    const env = environment();
    const result = await flushLogChunkAndEnqueueDelivery({
      ...input(env),
      destinations: [
        { destinationId: 'dest_a', lane: 'critical' },
        { destinationId: 'dest_b', lane: 'bulk' },
      ],
    });
    expect(result.chunk.recordCount).toBe(2);
    expect(env.send).toHaveBeenCalledTimes(2);
    const payloads = env.send.mock.calls.map(([payload]) => payload as Record<string, unknown>);
    expect(payloads.map((p) => p.destination_id)).toEqual(['dest_a', 'dest_b']);
    for (const payload of payloads) {
      expect(payload).toMatchObject({
        payload_type: 'delivery_fanout',
        schema_version: 1,
        tenant_key: 't_1',
        created_at: T,
        catalog_id: result.chunk.objectCatalogId,
        object_key: result.chunk.objectKey,
        log_type: 'normal',
        plane: 'archive',
        record_count: 2,
      });
      expect(String(payload.payload_id)).toMatch(/^qpl_/);
    }
    expect(payloads.map((p) => p.lane)).toEqual(['critical', 'bulk']);
    expect(payloads[0]?.payload_id).not.toBe(payloads[1]?.payload_id);
  });

  it('sends nothing when there are no destinations', async () => {
    const env = environment();
    const result = await flushLogChunkAndEnqueueDelivery({ ...input(env), destinations: [] });
    expect(result.delivery).toEqual([]);
    expect(env.send).not.toHaveBeenCalled();
    expect(env.put).toHaveBeenCalledTimes(1);
  });

  it('dates the payloads from the clock when no time is given', async () => {
    const env = environment();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T + 5));
    await flushLogChunkAndEnqueueDelivery({
      ...input(env),
      now: undefined,
      destinations: [{ destinationId: 'dest_a', lane: 'default' }],
    });
    expect(env.send.mock.calls[0]?.[0]).toMatchObject({ created_at: T + 5 });
  });
});

describe('BufferedLogChunkFlushWorker', () => {
  it('counts the groups and records it holds, until they are flushed', async () => {
    const env = environment();
    const worker = new BufferedLogChunkFlushWorker({ now: () => T });
    expect(worker.pendingGroupCount()).toBe(0);
    expect(worker.pendingRecordCount()).toBe(0);
    await worker.add({ group: groupOf(env), record: event('a', T) });
    await worker.add({ group: groupOf(env), record: event('b', T) });
    await worker.add({
      group: groupOf(env, { tenantKey: 't_2', encryption: encryption('t_2') }),
      record: event('c', T),
    });
    expect(worker.pendingGroupCount()).toBe(2);
    expect(worker.pendingRecordCount()).toBe(3);
  });

  it('flushes a group once it holds its record limit, and only that group', async () => {
    const env = environment();
    const worker = new BufferedLogChunkFlushWorker({ now: () => T });
    const other = groupOf(env, { tenantKey: 't_2', encryption: encryption('t_2') });
    await worker.add({ group: other, record: event('x', T) });
    expect(await worker.add({ group: groupOf(env), record: event('a', T) })).toEqual([]);
    expect(await worker.add({ group: groupOf(env), record: event('b', T) })).toEqual([]);
    const flushed = await worker.add({ group: groupOf(env), record: event('c', T) });
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.chunk.recordCount).toBe(3);
    expect(worker.pendingGroupCount()).toBe(1);
    expect(worker.pendingRecordCount()).toBe(1);
  });

  it('flushes by bytes, adding up the estimate of each record', async () => {
    const env = environment();
    const worker = new BufferedLogChunkFlushWorker({ now: () => T });
    const group = groupOf(env, {
      profile: {
        name: 'default',
        maxRecords: 100,
        maxBytes: 100,
        maxIntervalMs: 1e9,
        compression: 'none',
      },
    });
    expect(await worker.add({ group, record: event('a', T), estimatedBytes: 40 })).toEqual([]);
    expect(await worker.add({ group, record: event('b', T), estimatedBytes: 59 })).toEqual([]);
    expect(await worker.add({ group, record: event('c', T), estimatedBytes: 1 })).toHaveLength(1);
  });

  it('estimates a record at the size of its JSON by default, or by the given function', async () => {
    const env = environment();
    const record = event('a', T);
    const size = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    const defaults = new BufferedLogChunkFlushWorker({ now: () => T });
    const tight = (maxBytes: number) =>
      groupOf(env, {
        profile: {
          name: 'default',
          maxRecords: 100,
          maxBytes,
          maxIntervalMs: 1e9,
          compression: 'none',
        },
      });
    expect(await defaults.add({ group: tight(size + 1), record })).toEqual([]);
    expect(await defaults.add({ group: tight(size), record })).toHaveLength(1);
    const custom = new BufferedLogChunkFlushWorker({ now: () => T, estimateRecordBytes: () => 7 });
    expect(await custom.add({ group: tight(8), record })).toEqual([]);
    expect(await custom.add({ group: tight(8), record })).toHaveLength(1);
  });

  it('flushes by the age of the oldest record, from its event time or else the time it was added', async () => {
    const env = environment();
    const worker = new BufferedLogChunkFlushWorker({ now: () => T });
    const group = groupOf(env);
    await worker.add({ group, record: event('a', T) });
    await worker.add({ group, record: event('b', T + 900) });
    expect(await worker.flushDue(T + 999)).toEqual([]);
    expect(await worker.flushDue(T + 1_000)).toHaveLength(1);
    expect(worker.pendingRecordCount()).toBe(0);

    const undated = new BufferedLogChunkFlushWorker({ now: () => T });
    await undated.add({ group, record: event('c'), now: 5_000 });
    expect(await undated.flushDue(5_999)).toEqual([]);
    expect(await undated.flushDue(6_000)).toHaveLength(1);
  });

  it('reads the clock for adding and for flushing when none is given', async () => {
    const env = environment();
    const worker = new BufferedLogChunkFlushWorker({ now: () => 5_000 });
    const group = groupOf(env);
    await worker.add({ group, record: event('a') });
    expect(await worker.flushDue()).toEqual([]);
    let clock = 5_000;
    const later = new BufferedLogChunkFlushWorker({ now: () => clock });
    await later.add({ group, record: event('a', 5_000) });
    clock = 6_000;
    expect(await later.flushDue()).toHaveLength(1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T));
    const real = new BufferedLogChunkFlushWorker();
    await real.add({ group, record: event('a', T - 500) });
    expect(await real.flushDue()).toEqual([]);
    vi.setSystemTime(new Date(T + 500));
    expect(await real.flushDue()).toHaveLength(1);
  });

  it('picks the flush profile from the log type and volume when the group names none', async () => {
    const env = environment();
    const age = async (
      extra: Partial<BufferedLogChunkFlushGroup>,
      ageMs: number
    ): Promise<number> => {
      const worker = new BufferedLogChunkFlushWorker({ now: () => T });
      await worker.add({
        group: groupOf(env, { profile: undefined, ...extra }),
        record: event('a', T),
      });
      return (await worker.flushDue(T + ageMs)).length;
    };
    expect(await age({ logType: 'audit', encryption: encryption('t_1', 'audit') }, 59_999)).toBe(0);
    expect(await age({ logType: 'audit', encryption: encryption('t_1', 'audit') }, 60_000)).toBe(1);
    expect(await age({}, 299_999)).toBe(0);
    expect(await age({}, 300_000)).toBe(1);
    expect(await age({ estimatedRecordsPerMinute: 10 }, 899_999)).toBe(0);
    expect(await age({ estimatedRecordsPerMinute: 10 }, 900_000)).toBe(1);
    expect(await age({ estimatedRecordsPerMinute: 5000 }, 60_000)).toBe(1);
  });

  it('flushAll writes every group, due or not, and returns what it wrote', async () => {
    const env = environment();
    const worker = new BufferedLogChunkFlushWorker({ now: () => T });
    expect(await worker.flushAll()).toEqual([]);
    await worker.add({ group: groupOf(env), record: event('a', T) });
    await worker.add({
      group: groupOf(env, { tenantKey: 't_2', encryption: encryption('t_2') }),
      record: event('b', T),
    });
    const results = await worker.flushAll(T);
    expect(results.map((r) => r.chunk.recordCount)).toEqual([1, 1]);
    expect(worker.pendingGroupCount()).toBe(0);
    expect(env.put).toHaveBeenCalledTimes(2);
  });

  it('flushAll reads the clock by default and puts a failed group back', async () => {
    const env = environment();
    env.put.mockRejectedValueOnce(new Error('r2_down'));
    const worker = new BufferedLogChunkFlushWorker({ now: () => T });
    await worker.add({ group: groupOf(env), record: event('a', T) });
    await expect(worker.flushAll()).rejects.toThrow('r2_down');
    expect(worker.pendingRecordCount()).toBe(1);
    const retried = await worker.flushAll();
    expect(retried[0]?.chunk.createdAt).toBe(T);
  });

  it('addMany adds each record in turn and returns every flush', async () => {
    const env = environment();
    const worker = new BufferedLogChunkFlushWorker({ now: () => T });
    const results = await worker.addMany(
      groupOf(env),
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => event(id, T)),
      { now: T }
    );
    expect(results.map((r) => r.chunk.recordCount)).toEqual([3, 3]);
    expect(worker.pendingRecordCount()).toBe(1);
    expect(await worker.addMany(groupOf(env), [])).toEqual([]);
  });

  it('writes with the compression of the group, or else of the profile', async () => {
    const env = environment();
    const worker = new BufferedLogChunkFlushWorker({ now: () => T });
    const fromProfile = await worker.addMany(
      groupOf(env, {
        profile: {
          name: 'default',
          maxRecords: 1,
          maxBytes: 1e9,
          maxIntervalMs: 1e9,
          compression: 'none',
        },
      }),
      [event('a', T)]
    );
    expect(fromProfile[0]?.chunk.compression).toBe('none');
    const fromGroup = await worker.addMany(
      groupOf(env, {
        compression: 'gzip_block',
        profile: {
          name: 'default',
          maxRecords: 1,
          maxBytes: 1e9,
          maxIntervalMs: 1e9,
          compression: 'none',
        },
      }),
      [event('b', T)]
    );
    expect(fromGroup[0]?.chunk.compression).toBe('gzip_block');
  });
});

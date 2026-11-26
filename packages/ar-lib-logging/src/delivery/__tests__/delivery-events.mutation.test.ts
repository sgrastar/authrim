import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOGGING_DELIVERY_AGGREGATE_BUCKET_INTERVALS_MS,
  LOGGING_DELIVERY_AGGREGATE_SHARD_COUNTS,
  SqlLoggingDeliveryEventStore,
  resolveLoggingDeliveryAggregateBucketIntervalMs,
  resolveLoggingDeliveryAggregateBucketProfile,
  resolveLoggingDeliveryAggregateBucketShard,
} from '../delivery-events';

afterEach(() => {
  vi.useRealTimers();
});

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function harness(results: unknown[] = []) {
  const execute = vi.fn(async (_sql: string, _params: unknown[] = []): Promise<unknown> => {
    return results.length > 0 ? results.shift() : { rowsAffected: 1 };
  });
  return { store: new SqlLoggingDeliveryEventStore({ execute }), execute };
}

const MIB = 1024 * 1024;

describe('aggregate bucket profiles', () => {
  it('names the interval and shard count of each profile', () => {
    expect(LOGGING_DELIVERY_AGGREGATE_BUCKET_INTERVALS_MS).toStrictEqual({
      low: 3_600_000,
      medium: 900_000,
      high: 300_000,
      very_high: 60_000,
    });
    expect(LOGGING_DELIVERY_AGGREGATE_SHARD_COUNTS).toStrictEqual({
      low: 1,
      medium: 4,
      high: 16,
      very_high: 64,
    });
  });

  it('uses a given profile as it is', () => {
    for (const profile of ['low', 'medium', 'high', 'very_high'] as const) {
      expect(
        resolveLoggingDeliveryAggregateBucketProfile({ profile, recordCount: 1e9, byteCount: 1e12 })
      ).toBe(profile);
    }
  });

  it('picks the profile from record and byte counts at each threshold', () => {
    const profile = (recordCount?: number, byteCount?: number) =>
      resolveLoggingDeliveryAggregateBucketProfile({ recordCount, byteCount });
    expect(profile()).toBe('low');
    expect(profile(0, 0)).toBe('low');
    expect(profile(999, MIB - 1)).toBe('low');
    expect(profile(1_000, 0)).toBe('medium');
    expect(profile(0, MIB)).toBe('medium');
    expect(profile(9_999, 16 * MIB - 1)).toBe('medium');
    expect(profile(10_000, 0)).toBe('high');
    expect(profile(0, 16 * MIB)).toBe('high');
    expect(profile(99_999, 128 * MIB - 1)).toBe('high');
    expect(profile(100_000, 0)).toBe('very_high');
    expect(profile(0, 128 * MIB)).toBe('very_high');
  });

  it('resolves the interval of the picked profile', () => {
    const interval = (
      input: Parameters<typeof resolveLoggingDeliveryAggregateBucketIntervalMs>[0]
    ) => resolveLoggingDeliveryAggregateBucketIntervalMs(input);
    expect(interval({})).toBe(3_600_000);
    expect(interval({ recordCount: 1_000 })).toBe(900_000);
    expect(interval({ recordCount: 10_000 })).toBe(300_000);
    expect(interval({ recordCount: 100_000 })).toBe(60_000);
    expect(interval({ profile: 'high' })).toBe(300_000);
  });
});

describe('aggregate bucket shards', () => {
  const base = {
    tenantKey: 'tenant-a',
    destinationId: 'dest-1',
    logType: 'audit',
    plane: 'archive',
    lane: 'default',
    status: 'delivered',
  } as const;

  it('is always s0 for the low profile', () => {
    expect(resolveLoggingDeliveryAggregateBucketShard(base)).toBe('s0');
    expect(resolveLoggingDeliveryAggregateBucketShard({ ...base, profile: 'low' })).toBe('s0');
  });

  it('hashes the identity of the stream into a two-digit shard', () => {
    expect(resolveLoggingDeliveryAggregateBucketShard({ ...base, profile: 'high' })).toBe('s06');
    expect(resolveLoggingDeliveryAggregateBucketShard({ ...base, profile: 'very_high' })).toBe(
      's22'
    );
    expect(resolveLoggingDeliveryAggregateBucketShard({ ...base, profile: 'medium' })).toBe('s02');
    expect(
      resolveLoggingDeliveryAggregateBucketShard({
        ...base,
        destinationId: null,
        profile: 'very_high',
      })
    ).toBe('s32');
    expect(
      resolveLoggingDeliveryAggregateBucketShard({
        ...base,
        tenantKey: 'tenant-b',
        profile: 'high',
      })
    ).toBe('s09');
  });

  it('follows the FNV-1a hash of the fields joined by the unit separator', () => {
    const logTypes = ['audit', 'security', 'pii'] as const;
    const lanes = ['critical', 'default', 'bulk'] as const;
    const statuses = ['queued', 'delivered', 'retrying', 'failed', 'dlq'] as const;
    for (const logType of logTypes) {
      for (const lane of lanes) {
        for (const status of statuses) {
          for (const destinationId of ['d', null, undefined, 'dest-2']) {
            const input = {
              ...base,
              destinationId,
              logType,
              lane,
              status,
              plane: 'external_sink',
              profile: 'very_high',
            } as const;
            const hash = fnv1a(
              ['tenant-a', destinationId ?? '', logType, 'external_sink', lane, status].join(
                '\u001f'
              )
            );
            expect(resolveLoggingDeliveryAggregateBucketShard(input)).toBe(
              `s${String(hash % 64).padStart(2, '0')}`
            );
          }
        }
      }
    }
    expect(
      resolveLoggingDeliveryAggregateBucketShard({
        ...base,
        plane: 'primary',
        profile: 'very_high',
      })
    ).not.toBe(resolveLoggingDeliveryAggregateBucketShard({ ...base, profile: 'very_high' }));
  });

  it('picks the profile from the counts when none is given', () => {
    expect(resolveLoggingDeliveryAggregateBucketShard({ ...base, recordCount: 100_000 })).toBe(
      's22'
    );
    expect(resolveLoggingDeliveryAggregateBucketShard({ ...base, recordCount: 10_000 })).toBe(
      's06'
    );
    expect(resolveLoggingDeliveryAggregateBucketShard({ ...base, recordCount: 1_000 })).toBe('s02');
    expect(resolveLoggingDeliveryAggregateBucketShard({ ...base, byteCount: 1024 })).toBe('s0');
  });
});

describe('insertEvent', () => {
  const input = {
    tenantKey: 'tenant-a',
    logType: 'audit',
    plane: 'archive',
    lane: 'default',
    status: 'retrying',
    now: 5_000_000,
  } as const;

  it('stores a minimal event with defaults, then counts it in the aggregate', async () => {
    const { store, execute } = harness();
    const record = await store.insertEvent({ ...input, id: 'lde_1' });
    expect(record).toStrictEqual({
      id: 'lde_1',
      tenantKey: 'tenant-a',
      destinationId: null,
      logType: 'audit',
      plane: 'archive',
      lane: 'default',
      status: 'retrying',
      attemptCount: 0,
      errorClass: null,
      objectCatalogId: null,
      createdAt: 5_000_000,
      updatedAt: 5_000_000,
      nextRetryAt: null,
      metadata: null,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const [sql, params] = must(execute.mock.calls[0]);
    expect(sql).toContain('INSERT INTO logging_delivery_events');
    expect(sql).toContain('ON CONFLICT(id) DO NOTHING');
    expect(params).toEqual([
      'lde_1',
      'tenant-a',
      null,
      'audit',
      'archive',
      'default',
      'retrying',
      0,
      null,
      null,
      5_000_000,
      5_000_000,
      null,
      null,
    ]);
  });

  it('stores every given field and the metadata as JSON', async () => {
    const { store, execute } = harness();
    const record = await store.insertEvent({
      ...input,
      id: 'lde_2',
      destinationId: 'dest-1',
      attemptCount: 3,
      errorClass: 'timeout',
      objectCatalogId: 'obj-1',
      nextRetryAt: 9_000_000,
      metadata: { record_count: 12, byte_count: 345 },
    });
    expect(record).toMatchObject({
      destinationId: 'dest-1',
      attemptCount: 3,
      errorClass: 'timeout',
      objectCatalogId: 'obj-1',
      nextRetryAt: 9_000_000,
      metadata: { record_count: 12, byte_count: 345 },
    });
    expect(must(execute.mock.calls[0])[1]).toEqual([
      'lde_2',
      'tenant-a',
      'dest-1',
      'audit',
      'archive',
      'default',
      'retrying',
      3,
      'timeout',
      'obj-1',
      5_000_000,
      5_000_000,
      9_000_000,
      '{"record_count":12,"byte_count":345}',
    ]);
    const aggregate = must(execute.mock.calls[1])[1];
    expect(aggregate.slice(1, 6)).toEqual([1, 12, 345, 3, 5_000_000]);
  });

  it('stores empty metadata as null, and names the event at its time', async () => {
    const { store, execute } = harness();
    const record = await store.insertEvent({ ...input, now: 0x0123456789ab, metadata: {} });
    expect(record.id).toMatch(/^lde_01234567-89ab-7/);
    expect(must(execute.mock.calls[0])[1][13]).toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0x0123456789ab));
    const clocked = await store.insertEvent({ ...input, now: undefined });
    expect(clocked.createdAt).toBe(0x0123456789ab);
    expect(clocked.id).toMatch(/^lde_01234567-89ab-7/);
  });

  it('keeps delivered events of non-critical lanes out of the events table', async () => {
    for (const [lane, status, persisted] of [
      ['default', 'delivered', false],
      ['bulk', 'delivered', false],
      ['critical', 'delivered', true],
      ['default', 'failed', true],
      ['bulk', 'dlq', true],
      ['critical', 'queued', true],
    ] as const) {
      const { store, execute } = harness();
      await store.insertEvent({ ...input, lane, status });
      const inserts = execute.mock.calls.filter(([sql]) =>
        sql.includes('INTO logging_delivery_events')
      );
      expect(inserts).toHaveLength(persisted ? 1 : 0);
      expect(
        execute.mock.calls.filter(([sql]) => sql.includes('logging_delivery_event_aggregates'))
          .length
      ).toBeGreaterThan(0);
    }
  });

  it('does not count an event that was already stored, and counts one whose insert reports nothing', async () => {
    const duplicate = harness([{ rowsAffected: 0 }]);
    await duplicate.store.insertEvent(input);
    expect(duplicate.execute).toHaveBeenCalledTimes(1);
    for (const result of [undefined, null, {}, { rowsAffected: 'x' }, { rowsAffected: 1 }]) {
      const counted = harness([result]);
      await counted.store.insertEvent(input);
      expect(counted.execute).toHaveBeenCalledTimes(2);
    }
  });

  it('counts only numeric record and byte counts', async () => {
    const { store, execute } = harness();
    await store.insertEvent({ ...input, metadata: { record_count: '5', byte_count: '6' } });
    expect(must(execute.mock.calls[1])[1].slice(2, 4)).toEqual([0, 0]);
  });
});

describe('upsertAggregate', () => {
  const aggregate = {
    tenantKey: 'tenant-a',
    logType: 'audit',
    plane: 'archive',
    lane: 'default',
    status: 'delivered',
    eventAt: 7_300_000,
  } as const;

  it('updates the bucket of the event time when it exists', async () => {
    const { store, execute } = harness();
    await store.upsertAggregate({ ...aggregate, recordCount: 5, byteCount: 70, attemptCount: 2 });
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = must(execute.mock.calls[0]);
    expect(sql).toContain('UPDATE logging_delivery_event_aggregates');
    expect(sql).toContain('batch_count = batch_count + ?');
    expect(params).toEqual([
      10_800_000,
      1,
      5,
      70,
      2,
      7_300_000,
      7_300_000,
      7_300_000,
      7_300_000,
      7_300_000,
      7_200_000,
      's0',
      'tenant-a',
      '',
      'audit',
      'archive',
      'default',
      'delivered',
    ]);
  });

  it('inserts the bucket when no row was updated', async () => {
    for (const result of [{ rowsAffected: 0 }, undefined, {}, { rowsAffected: 'x' }]) {
      const { store, execute } = harness([result]);
      await store.upsertAggregate({
        ...aggregate,
        destinationId: 'dest-1',
        recordCount: 5,
        byteCount: 70,
        attemptCount: 2,
      });
      expect(execute).toHaveBeenCalledTimes(2);
      const [sql, params] = must(execute.mock.calls[1]);
      expect(sql).toContain('INSERT INTO logging_delivery_event_aggregates');
      expect(params).toEqual([
        7_200_000,
        10_800_000,
        's0',
        'tenant-a',
        'dest-1',
        'audit',
        'archive',
        'default',
        'delivered',
        1,
        5,
        70,
        2,
        7_300_000,
        7_300_000,
        7_300_000,
      ]);
    }
  });

  it('defaults the counts to zero and buckets by the profile of the counts', async () => {
    const { store, execute } = harness([{ rowsAffected: 0 }, { rowsAffected: 1 }]);
    await store.upsertAggregate(aggregate);
    expect(must(execute.mock.calls[1])[1].slice(9, 13)).toEqual([1, 0, 0, 0]);
    const big = harness([{ rowsAffected: 0 }]);
    await big.store.upsertAggregate({ ...aggregate, eventAt: 7_300_000, recordCount: 100_000 });
    expect(must(big.execute.mock.calls[1])[1].slice(0, 3)).toEqual([7_260_000, 7_320_000, 's32']);
  });

  it('uses the given interval, profile and shard', async () => {
    const interval = harness([{ rowsAffected: 0 }]);
    await interval.store.upsertAggregate({ ...aggregate, bucketIntervalMs: 1_000_000 });
    expect(must(interval.execute.mock.calls[1])[1].slice(0, 3)).toEqual([
      7_000_000,
      8_000_000,
      's0',
    ]);
    const profile = harness([{ rowsAffected: 0 }]);
    await profile.store.upsertAggregate({ ...aggregate, bucketProfile: 'high' });
    expect(must(profile.execute.mock.calls[1])[1].slice(0, 3)).toEqual([
      7_200_000,
      7_500_000,
      's00',
    ]);
    const shard = harness([{ rowsAffected: 0 }]);
    await shard.store.upsertAggregate({ ...aggregate, bucketShard: 's77' });
    expect(must(shard.execute.mock.calls[1])[1][2]).toBe('s77');
  });

  it('shards by the same identity the shard resolver uses, with an empty destination', async () => {
    const { store, execute } = harness([{ rowsAffected: 0 }]);
    await store.upsertAggregate({ ...aggregate, bucketProfile: 'very_high', destinationId: null });
    expect(must(execute.mock.calls[1])[1][2]).toBe(
      resolveLoggingDeliveryAggregateBucketShard({
        ...aggregate,
        destinationId: '',
        profile: 'very_high',
      })
    );
  });
});

describe('claims', () => {
  const claim = {
    id: 'lde_claim',
    tenantKey: 'tenant-a',
    logType: 'audit',
    plane: 'external_sink',
    lane: 'critical',
    now: 1_000,
    leaseUntil: 61_000,
  } as const;

  it('claims with an insert carrying the lease, defaults and metadata', async () => {
    const { store, execute } = harness();
    expect(await store.claimEvent({ ...claim, metadata: { a: 1 } })).toBe(true);
    const [sql, params] = must(execute.mock.calls[0]);
    expect(sql).toContain("'retrying', ?, 'delivery_in_progress'");
    expect(params).toEqual([
      'lde_claim',
      'tenant-a',
      null,
      'audit',
      'external_sink',
      'critical',
      0,
      null,
      1_000,
      1_000,
      61_000,
      '{"a":1}',
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('treats an insert that reports nothing as a claim, and one that touched no row as a conflict', async () => {
    for (const result of [undefined, null, {}, { rowsAffected: 'x' }, { rowsAffected: 2 }]) {
      const { store, execute } = harness([result]);
      expect(await store.claimEvent(claim)).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
    }
    const { store, execute } = harness([{ rowsAffected: 0 }, { rowsAffected: 0 }]);
    expect(await store.claimEvent(claim)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reclaims a lapsed lease with the full set of fields', async () => {
    const { store, execute } = harness([{ rowsAffected: 0 }, { rowsAffected: 1 }]);
    expect(
      await store.claimEvent({
        ...claim,
        destinationId: 'dest-1',
        attemptCount: 4,
        objectCatalogId: 'obj-1',
        metadata: { a: 1 },
      })
    ).toBe(true);
    const [sql, params] = must(execute.mock.calls[1]);
    expect(sql).toContain('UPDATE logging_delivery_events');
    expect(sql).toContain('next_retry_at <= ?');
    expect(params).toEqual([
      'tenant-a',
      'dest-1',
      'audit',
      'external_sink',
      'critical',
      4,
      'obj-1',
      1_000,
      61_000,
      '{"a":1}',
      'lde_claim',
      1_000,
    ]);
    for (const result of [undefined, {}, { rowsAffected: 'x' }]) {
      const none = harness([{ rowsAffected: 0 }, result]);
      expect(await none.store.claimEvent(claim)).toBe(false);
    }
    const defaults = harness([{ rowsAffected: 0 }, { rowsAffected: 1 }]);
    await defaults.store.claimEvent({ ...claim, metadata: {} });
    expect(must(defaults.execute.mock.calls[1])[1].slice(1, 2)).toEqual([null]);
    expect(must(defaults.execute.mock.calls[1])[1].slice(9, 10)).toEqual([null]);
  });

  it('reads the clock for a claim made without a time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(4242));
    const { store, execute } = harness();
    await store.claimEvent({ ...claim, now: undefined });
    expect(must(execute.mock.calls[0])[1].slice(8, 10)).toEqual([4242, 4242]);
  });

  it('completes a claim and counts it as delivered', async () => {
    const { store, execute } = harness();
    await store.completeClaim({
      id: 'lde_claim',
      tenantKey: 'tenant-a',
      destinationId: 'dest-1',
      logType: 'audit',
      plane: 'external_sink',
      lane: 'critical',
      status: 'delivered',
      attemptCount: 2,
      objectCatalogId: 'obj-1',
      metadata: { record_count: 9, byte_count: 99 },
      now: 2_000,
    });
    const [sql, params] = must(execute.mock.calls[0]);
    expect(sql).toContain("SET status = 'delivered'");
    expect(sql).toContain("AND error_class = 'delivery_in_progress'");
    expect(params).toEqual([2, 'obj-1', 2_000, '{"record_count":9,"byte_count":99}', 'lde_claim']);
    const aggregate = must(execute.mock.calls[1])[1];
    expect(aggregate.slice(1, 6)).toEqual([1, 9, 99, 2, 2_000]);
    expect(aggregate.slice(12, 16)).toEqual(['tenant-a', 'dest-1', 'audit', 'external_sink']);
    expect(aggregate.slice(16)).toEqual(['critical', 'delivered']);
  });

  it('refuses to complete a claim that is not owned, but not when the count is unknown', async () => {
    const claimed = {
      id: 'lde_claim',
      tenantKey: 'tenant-a',
      logType: 'audit',
      plane: 'external_sink',
      lane: 'critical',
      status: 'delivered',
      now: 2_000,
    } as const;
    const lost = harness([{ rowsAffected: 0 }]);
    await expect(lost.store.completeClaim(claimed)).rejects.toThrow(
      'logging_delivery_claim_not_owned'
    );
    expect(lost.execute).toHaveBeenCalledTimes(1);
    for (const result of [undefined, null, {}, { rowsAffected: 1 }]) {
      const ok = harness([result]);
      await ok.store.completeClaim(claimed);
      expect(ok.execute).toHaveBeenCalledTimes(2);
      expect(must(ok.execute.mock.calls[0])[1]).toEqual([0, null, 2_000, null, 'lde_claim']);
    }
  });

  it('releases and preserves a claim by id', async () => {
    const { store, execute } = harness();
    await store.releaseClaim('lde_claim');
    const [sql, params] = must(execute.mock.calls[0]);
    expect(sql).toContain('DELETE FROM logging_delivery_events');
    expect(sql).toContain("status = 'retrying' AND error_class = 'delivery_in_progress'");
    expect(params).toEqual(['lde_claim']);

    await store.preserveEmittedClaim('lde_claim', 3_000);
    const [preserveSql, preserveParams] = must(execute.mock.calls[1]);
    expect(preserveSql).toContain("SET error_class = 'delivery_emission_uncertain'");
    expect(preserveSql).toContain('next_retry_at = NULL');
    expect(preserveParams).toEqual([3_000, 'lde_claim']);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(4242));
    await store.preserveEmittedClaim('lde_claim');
    expect(must(execute.mock.calls[2])[1]).toEqual([4242, 'lde_claim']);
  });
});

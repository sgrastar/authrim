import { describe, expect, it, vi } from 'vitest';
import {
  resolveLoggingDeliveryAggregateBucketShard,
  resolveLoggingDeliveryAggregateBucketIntervalMs,
  resolveLoggingDeliveryAggregateBucketProfile,
  SqlLoggingDeliveryEventStore,
} from '../delivery-events';

describe('SqlLoggingDeliveryEventStore', () => {
  it('inserts delivery events with generated ids and JSON metadata', async () => {
    const executor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rowsAffected: 1 })
        .mockResolvedValueOnce({ rowsAffected: 0 })
        .mockResolvedValueOnce({ rowsAffected: 1 }),
    };
    const store = new SqlLoggingDeliveryEventStore(executor);

    const record = await store.insertEvent({
      tenantKey: 'tk_abc',
      destinationId: 'dest_http',
      logType: 'audit',
      plane: 'external_sink',
      lane: 'critical',
      status: 'retrying',
      attemptCount: 2,
      errorClass: 'http_status_503',
      nextRetryAt: 1_700_000_060_000,
      metadata: {
        target_type: 'http',
        http_status: 503,
        record_count: 3,
      },
      now: 1_700_000_000_000,
    });

    expect(record.id).toMatch(/^lde_/);
    expect(record.createdAt).toBe(1_700_000_000_000);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining([
        'tk_abc',
        'dest_http',
        'audit',
        'external_sink',
        'critical',
        'retrying',
        2,
        'http_status_503',
        null,
        1_700_000_000_000,
        1_700_000_000_000,
        1_700_000_060_000,
        JSON.stringify({
          target_type: 'http',
          http_status: 503,
          record_count: 3,
        }),
      ])
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_delivery_event_aggregates'),
      expect.arrayContaining([
        1_700_002_800_000,
        1,
        3,
        0,
        2,
        1_700_000_000_000,
        1_700_000_000_000,
        1_700_000_000_000,
        1_700_000_000_000,
        1_700_000_000_000,
        1_699_999_200_000,
        'tk_abc',
        'dest_http',
        'audit',
        'external_sink',
        'critical',
        'retrying',
      ])
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_event_aggregates'),
      expect.arrayContaining([
        1_699_999_200_000,
        1_700_002_800_000,
        'tk_abc',
        'dest_http',
        'audit',
        'external_sink',
        'critical',
        'retrying',
        1,
        3,
        0,
        2,
        1_700_000_000_000,
        1_700_000_000_000,
        1_700_000_000_000,
      ])
    );
  });

  it('aggregates default successful deliveries without inserting individual rows', async () => {
    const executor = {
      execute: vi.fn().mockResolvedValueOnce({ rowsAffected: 0 }).mockResolvedValueOnce({
        rowsAffected: 1,
      }),
    };
    const store = new SqlLoggingDeliveryEventStore(executor);

    await store.insertEvent({
      tenantKey: 'tk_abc',
      destinationId: 'dest_http',
      logType: 'webhook',
      plane: 'external_sink',
      lane: 'default',
      status: 'delivered',
      attemptCount: 1,
      metadata: {
        record_count: 10,
        byte_count: 2048,
      },
      now: 1_700_000_000_000,
    });

    expect(executor.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.anything()
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_event_aggregates'),
      expect.arrayContaining([
        'tk_abc',
        'dest_http',
        'webhook',
        'external_sink',
        'default',
        'delivered',
        1,
        10,
        2048,
        1,
      ])
    );
  });

  it('resolves adaptive aggregate bucket profiles from delivery volume', () => {
    expect(resolveLoggingDeliveryAggregateBucketProfile({ recordCount: 100 })).toBe('low');
    expect(resolveLoggingDeliveryAggregateBucketProfile({ recordCount: 1_000 })).toBe('medium');
    expect(resolveLoggingDeliveryAggregateBucketProfile({ recordCount: 10_000 })).toBe('high');
    expect(resolveLoggingDeliveryAggregateBucketProfile({ recordCount: 100_000 })).toBe(
      'very_high'
    );
    expect(resolveLoggingDeliveryAggregateBucketIntervalMs({ profile: 'medium' })).toBe(
      15 * 60 * 1000
    );
    expect(
      resolveLoggingDeliveryAggregateBucketShard({
        tenantKey: 'tk_abc',
        destinationId: 'dest_http',
        logType: 'audit',
        plane: 'external_sink',
        lane: 'bulk',
        status: 'delivered',
        recordCount: 100,
      })
    ).toBe('s0');
    expect(
      resolveLoggingDeliveryAggregateBucketShard({
        tenantKey: 'tk_abc',
        destinationId: 'dest_http',
        logType: 'audit',
        plane: 'external_sink',
        lane: 'bulk',
        status: 'delivered',
        recordCount: 100_000,
      })
    ).toMatch(/^s\d{2}$/);
  });

  it('uses adaptive aggregate buckets for high-volume deliveries', async () => {
    const executor = {
      execute: vi.fn().mockResolvedValueOnce({ rowsAffected: 0 }).mockResolvedValueOnce({
        rowsAffected: 1,
      }),
    };
    const store = new SqlLoggingDeliveryEventStore(executor);

    await store.upsertAggregate({
      tenantKey: 'tk_abc',
      destinationId: 'dest_http',
      logType: 'audit',
      plane: 'external_sink',
      lane: 'bulk',
      status: 'delivered',
      recordCount: 20_000,
      byteCount: 1024,
      eventAt: 1_700_000_000_000,
    });

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_event_aggregates'),
      expect.arrayContaining([
        1_699_999_800_000,
        1_700_000_100_000,
        'tk_abc',
        'dest_http',
        'audit',
        'external_sink',
        'bulk',
        'delivered',
        1,
        20_000,
        1024,
      ])
    );
  });
});

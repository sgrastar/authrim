import { describe, expect, it, vi } from 'vitest';

import {
  BufferedLogChunkFlushWorker,
  bufferedLogChunkGroupKey,
  flushLogChunkAndEnqueueDelivery,
} from '../flush-worker';
import type { LogChunkCatalogStore } from '../types';

describe('flushLogChunkAndEnqueueDelivery', () => {
  it('commits the R2 chunk before enqueueing delivery payloads by lane priority', async () => {
    const calls: string[] = [];
    const bucket = {
      put: vi.fn(async () => {
        calls.push('put');
      }),
    } as unknown as R2Bucket;
    const catalogStore: LogChunkCatalogStore = {
      createPendingObject: vi.fn(async () => {
        calls.push('pending_object');
      }),
      createPendingRecordIndexes: vi.fn(async () => {
        calls.push('pending_indexes');
      }),
      commitObject: vi.fn(async () => {
        calls.push('commit_object');
      }),
      commitRecordIndexes: vi.fn(async () => {
        calls.push('commit_indexes');
      }),
      markObjectOrphanCandidate: vi.fn(),
    };
    const send = vi.fn(async () => {
      calls.push('send');
    });

    const result = await flushLogChunkAndEnqueueDelivery({
      bucket,
      catalogStore,
      tenantKey: 't_safeopaque',
      logType: 'audit',
      plane: 'archive',
      now: 1_700_000_000_000,
      records: [{ id: 'evt-1', eventAt: 1_700_000_000_000, payload: { id: 'evt-1' } }],
      destinations: [
        { destinationId: 'dest_bulk', lane: 'bulk' },
        { destinationId: 'dest_critical', lane: 'critical' },
      ],
      queueBindings: {
        LOGGING_DELIVERY_QUEUE: { send },
      },
    });

    expect(calls).toEqual([
      'pending_object',
      'pending_indexes',
      'put',
      'commit_object',
      'commit_indexes',
      'send',
      'send',
    ]);
    expect(send.mock.calls.map(([payload]) => payload.destination_id)).toEqual([
      'dest_critical',
      'dest_bulk',
    ]);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      payload_type: 'delivery_fanout',
      schema_version: 1,
      tenant_key: 't_safeopaque',
      catalog_id: result.chunk.objectCatalogId,
      object_key: result.chunk.objectKey,
      log_type: 'audit',
      plane: 'archive',
      record_count: 1,
    });
    expect(result.delivery).toHaveLength(2);
    expect(result.delivery.every((item) => item.queued)).toBe(true);
  });

  it('returns unqueued delivery results when no queue binding is configured', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const result = await flushLogChunkAndEnqueueDelivery({
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'normal',
      plane: 'archive',
      records: [{ id: 'evt-1', eventAt: 1, payload: { id: 'evt-1' } }],
      destinations: [{ destinationId: 'dest_1', lane: 'default' }],
      queueBindings: {},
    });

    expect(result.delivery).toEqual([
      expect.objectContaining({
        queued: false,
        lane: 'default',
        bindingName: null,
        attemptedBindingNames: ['LOGGING_DELIVERY_QUEUE'],
      }),
    ]);
  });

  it('buffers records by group and flushes when the adaptive profile threshold is reached', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = new BufferedLogChunkFlushWorker({
      estimateRecordBytes: () => 10,
      now: () => 1_700_000_000_000,
    });
    const group = {
      bucket,
      tenantKey: 't_buffered',
      logType: 'normal' as const,
      plane: 'archive' as const,
      destinations: [{ destinationId: 'dest_default', lane: 'default' as const }],
      queueBindings: {
        LOGGING_DELIVERY_QUEUE: { send },
      },
      profile: {
        name: 'default' as const,
        maxRecords: 2,
        maxBytes: 10_000,
        maxIntervalMs: 60_000,
        compression: 'gzip_block' as const,
      },
    };

    await expect(
      worker.add({
        group,
        record: { id: 'evt-1', eventAt: 1_700_000_000_000, payload: { id: 'evt-1' } },
      })
    ).resolves.toEqual([]);
    expect(worker.pendingRecordCount()).toBe(1);

    const results = await worker.add({
      group,
      record: { id: 'evt-2', eventAt: 1_700_000_000_001, payload: { id: 'evt-2' } },
      now: 1_700_000_000_002,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.recordCount).toBe(2);
    expect(worker.pendingRecordCount()).toBe(0);
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'delivery_fanout',
        tenant_key: 't_buffered',
        destination_id: 'dest_default',
        record_count: 2,
      })
    );
  });

  it('flushes buffered records by age and keeps the group when a write fails', async () => {
    const bucket = {
      put: vi
        .fn()
        .mockRejectedValueOnce(new Error('r2_unavailable'))
        .mockResolvedValueOnce(undefined),
    } as unknown as R2Bucket;
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = new BufferedLogChunkFlushWorker({
      estimateRecordBytes: () => 10,
      now: () => 1_700_000_000_000,
    });
    const group = {
      bucket,
      tenantKey: 't_retry',
      logType: 'normal' as const,
      plane: 'archive' as const,
      destinations: [{ destinationId: 'dest_default', lane: 'default' as const }],
      queueBindings: {
        LOGGING_DELIVERY_QUEUE: { send },
      },
      profile: {
        name: 'default' as const,
        maxRecords: 10,
        maxBytes: 10_000,
        maxIntervalMs: 1_000,
        compression: 'gzip_block' as const,
      },
    };

    await worker.add({
      group,
      record: { id: 'evt-1', eventAt: 1_700_000_000_000, payload: { id: 'evt-1' } },
    });
    await expect(worker.flushDue(1_700_000_001_500)).rejects.toThrow('r2_unavailable');
    expect(worker.pendingRecordCount()).toBe(1);

    const retried = await worker.flushDue(1_700_000_001_600);

    expect(retried).toHaveLength(1);
    expect(retried[0]?.chunk.recordCount).toBe(1);
    expect(worker.pendingRecordCount()).toBe(0);
  });

  it('uses stable grouping for destinations regardless of destination order', () => {
    const base = {
      bucket: { put: vi.fn() } as unknown as R2Bucket,
      tenantKey: 't_group',
      logType: 'audit' as const,
      plane: 'archive' as const,
      queueBindings: {},
    };

    expect(
      bufferedLogChunkGroupKey({
        ...base,
        destinations: [
          { destinationId: 'dest_b', lane: 'bulk' },
          { destinationId: 'dest_a', lane: 'critical' },
        ],
      })
    ).toBe(
      bufferedLogChunkGroupKey({
        ...base,
        destinations: [
          { destinationId: 'dest_a', lane: 'critical' },
          { destinationId: 'dest_b', lane: 'bulk' },
        ],
      })
    );
  });
});

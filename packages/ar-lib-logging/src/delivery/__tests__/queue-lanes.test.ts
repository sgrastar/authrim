import { describe, expect, it, vi } from 'vitest';

import {
  enqueueLoggingDeliveryPayload,
  enqueueLoggingDeliveryPayloadBatch,
  getLoggingDeliveryLaneProfile,
  orderLoggingDeliveryLanesByPriority,
  resolveLoggingDeliveryQueue,
} from '../index';

describe('logging delivery queue lanes', () => {
  it('defines stable queue bindings for critical, default, and bulk lanes', () => {
    expect(getLoggingDeliveryLaneProfile('critical')).toMatchObject({
      lane: 'critical',
      bindingName: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      fallbackBindingNames: ['LOGGING_DELIVERY_QUEUE'],
      priorityRank: 0,
    });
    expect(getLoggingDeliveryLaneProfile('default')).toMatchObject({
      lane: 'default',
      bindingName: 'LOGGING_DELIVERY_QUEUE',
      fallbackBindingNames: [],
      priorityRank: 1,
    });
    expect(getLoggingDeliveryLaneProfile('bulk')).toMatchObject({
      lane: 'bulk',
      bindingName: 'LOGGING_DELIVERY_BULK_QUEUE',
      fallbackBindingNames: ['LOGGING_DELIVERY_QUEUE'],
      priorityRank: 2,
    });
  });

  it('resolves the lane-specific queue before fallback queues', () => {
    const criticalQueue = { send: vi.fn() };
    const defaultQueue = { send: vi.fn() };

    const resolution = resolveLoggingDeliveryQueue('critical', {
      LOGGING_DELIVERY_CRITICAL_QUEUE: criticalQueue,
      LOGGING_DELIVERY_QUEUE: defaultQueue,
    });

    expect(resolution).toEqual({
      lane: 'critical',
      bindingName: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      queue: criticalQueue,
      fallbackUsed: false,
      attemptedBindingNames: ['LOGGING_DELIVERY_CRITICAL_QUEUE', 'LOGGING_DELIVERY_QUEUE'],
    });
  });

  it('falls back to the default queue for critical and bulk lanes in small deployments', () => {
    const queue = { send: vi.fn() };

    expect(
      resolveLoggingDeliveryQueue('bulk', {
        LOGGING_DELIVERY_QUEUE: queue,
      })
    ).toMatchObject({
      lane: 'bulk',
      bindingName: 'LOGGING_DELIVERY_QUEUE',
      queue,
      fallbackUsed: true,
    });
  });

  it('orders lane processing by priority rank', () => {
    expect(orderLoggingDeliveryLanesByPriority(['bulk', 'default', 'critical'])).toEqual([
      'critical',
      'default',
      'bulk',
    ]);
  });

  it('enqueues payloads to the resolved lane queue with fallback metadata', async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const payload = {
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs',
      log_type: 'operational',
      plane: 'external_sink',
      batch_id: 'batch_1',
      record_count: 1,
    } as const;

    const result = await enqueueLoggingDeliveryPayload(payload, {
      LOGGING_DELIVERY_QUEUE: queue,
    });

    expect(queue.send).toHaveBeenCalledWith(payload);
    expect(result).toMatchObject({
      queued: true,
      lane: 'critical',
      bindingName: 'LOGGING_DELIVERY_QUEUE',
      fallbackUsed: true,
      payloadId: 'qpl_1',
    });
    expect(result.byteCount).toBeGreaterThan(0);
  });

  it('returns an unqueued result when no lane queue binding is available', async () => {
    const payload = {
      payload_type: 'dlq_replay',
      schema_version: 1,
      payload_id: 'qpl_2',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
      dlq_item_id: 'dlq_1',
      requested_by: 'admin-1',
    } as const;

    await expect(enqueueLoggingDeliveryPayload(payload, {})).resolves.toMatchObject({
      queued: false,
      lane: 'default',
      bindingName: null,
      attemptedBindingNames: ['LOGGING_DELIVERY_QUEUE'],
      payloadId: 'qpl_2',
    });
  });

  it('batch enqueues in lane priority order', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await enqueueLoggingDeliveryPayloadBatch(
      [
        {
          payload_type: 'dlq_replay',
          schema_version: 1,
          payload_id: 'bulk_payload',
          tenant_key: 'tk_123',
          lane: 'bulk',
          created_at: 1779148800000,
          dlq_item_id: 'dlq_1',
          requested_by: 'admin-1',
        },
        {
          payload_type: 'dlq_replay',
          schema_version: 1,
          payload_id: 'critical_payload',
          tenant_key: 'tk_123',
          lane: 'critical',
          created_at: 1779148800000,
          dlq_item_id: 'dlq_2',
          requested_by: 'admin-1',
        },
      ],
      { LOGGING_DELIVERY_QUEUE: { send } }
    );

    expect(send.mock.calls.map(([payload]) => payload.payload_id)).toEqual([
      'critical_payload',
      'bulk_payload',
    ]);
  });
});

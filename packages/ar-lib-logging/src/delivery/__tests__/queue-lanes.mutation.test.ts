import { describe, expect, it, vi } from 'vitest';
import {
  LOGGING_DELIVERY_LANE_PROFILES,
  enqueueLoggingDeliveryPayload,
  enqueueLoggingDeliveryPayloadBatch,
  getLoggingDeliveryLaneProfile,
  orderLoggingDeliveryLanesByPriority,
  resolveLoggingDeliveryQueue,
} from '../queue-lanes';
import type { LoggingDeliveryQueuePayload } from '../queue-payload';
import type { LoggingDeliveryLane } from '../types';

const payload = (
  lane: LoggingDeliveryLane,
  extra: Record<string, unknown> = {}
): LoggingDeliveryQueuePayload => ({
  payload_type: 'dlq_replay',
  schema_version: 1,
  payload_id: `qpl_${lane}`,
  tenant_key: 't_1',
  lane,
  created_at: 1,
  dlq_item_id: 'dlq_1',
  requested_by: 'admin_1',
  ...extra,
});

const queue = () => ({ send: vi.fn(async (_message: unknown) => undefined) });

describe('lane profiles', () => {
  it('give each lane its queue, fallback, rank and batch limits', () => {
    expect(LOGGING_DELIVERY_LANE_PROFILES).toStrictEqual({
      critical: {
        lane: 'critical',
        bindingName: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
        fallbackBindingNames: ['LOGGING_DELIVERY_QUEUE'],
        priorityRank: 0,
        maxBatchRecords: 100,
        maxBatchBytes: 262_144,
      },
      default: {
        lane: 'default',
        bindingName: 'LOGGING_DELIVERY_QUEUE',
        fallbackBindingNames: [],
        priorityRank: 1,
        maxBatchRecords: 500,
        maxBatchBytes: 524_288,
      },
      bulk: {
        lane: 'bulk',
        bindingName: 'LOGGING_DELIVERY_BULK_QUEUE',
        fallbackBindingNames: ['LOGGING_DELIVERY_QUEUE'],
        priorityRank: 2,
        maxBatchRecords: 1000,
        maxBatchBytes: 1_048_576,
      },
    });
    expect(getLoggingDeliveryLaneProfile('bulk')).toBe(LOGGING_DELIVERY_LANE_PROFILES.bulk);
  });

  it('order lanes by priority without changing the list given', () => {
    const lanes: LoggingDeliveryLane[] = ['bulk', 'critical', 'default', 'critical'];
    expect(orderLoggingDeliveryLanesByPriority(lanes)).toEqual([
      'critical',
      'critical',
      'default',
      'bulk',
    ]);
    expect(lanes).toEqual(['bulk', 'critical', 'default', 'critical']);
    expect(orderLoggingDeliveryLanesByPriority([])).toEqual([]);
  });
});

describe('resolveLoggingDeliveryQueue', () => {
  it('uses the queue of the lane, then its fallback, naming what it tried', () => {
    const critical = queue();
    const shared = queue();
    expect(
      resolveLoggingDeliveryQueue('critical', {
        LOGGING_DELIVERY_CRITICAL_QUEUE: critical,
        LOGGING_DELIVERY_QUEUE: shared,
      })
    ).toStrictEqual({
      lane: 'critical',
      bindingName: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      queue: critical,
      fallbackUsed: false,
      attemptedBindingNames: ['LOGGING_DELIVERY_CRITICAL_QUEUE', 'LOGGING_DELIVERY_QUEUE'],
    });
    expect(
      resolveLoggingDeliveryQueue('critical', { LOGGING_DELIVERY_QUEUE: shared })
    ).toMatchObject({
      bindingName: 'LOGGING_DELIVERY_QUEUE',
      fallbackUsed: true,
    });
    expect(
      resolveLoggingDeliveryQueue('default', { LOGGING_DELIVERY_QUEUE: shared })
    ).toMatchObject({
      bindingName: 'LOGGING_DELIVERY_QUEUE',
      fallbackUsed: false,
    });
  });

  it('skips bindings that are not queues, and gives none when there is no queue', () => {
    const shared = queue();
    for (const notQueue of [undefined, null, 'queue', 5, {}, { send: 'x' }, []]) {
      expect(
        resolveLoggingDeliveryQueue('bulk', {
          LOGGING_DELIVERY_BULK_QUEUE: notQueue,
          LOGGING_DELIVERY_QUEUE: shared,
        })
      ).toMatchObject({ bindingName: 'LOGGING_DELIVERY_QUEUE', fallbackUsed: true });
      expect(
        resolveLoggingDeliveryQueue('default', { LOGGING_DELIVERY_QUEUE: notQueue })
      ).toBeNull();
    }
    expect(resolveLoggingDeliveryQueue('critical', {})).toBeNull();
    expect(
      resolveLoggingDeliveryQueue('default', { LOGGING_DELIVERY_CRITICAL_QUEUE: shared })
    ).toBeNull();
  });
});

describe('enqueueLoggingDeliveryPayload', () => {
  it('sends the payload to the queue of its lane and says where it went', async () => {
    const critical = queue();
    const item = payload('critical');
    const result = await enqueueLoggingDeliveryPayload(item, {
      LOGGING_DELIVERY_CRITICAL_QUEUE: critical,
    });
    expect(critical.send).toHaveBeenCalledWith(item);
    expect(result).toStrictEqual({
      queued: true,
      lane: 'critical',
      bindingName: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      fallbackUsed: false,
      attemptedBindingNames: ['LOGGING_DELIVERY_CRITICAL_QUEUE', 'LOGGING_DELIVERY_QUEUE'],
      payloadId: 'qpl_critical',
      byteCount: new TextEncoder().encode(JSON.stringify(item)).byteLength,
    });
  });

  it('uses the fallback queue and says so', async () => {
    const shared = queue();
    const result = await enqueueLoggingDeliveryPayload(payload('bulk'), {
      LOGGING_DELIVERY_QUEUE: shared,
    });
    expect(shared.send).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      queued: true,
      bindingName: 'LOGGING_DELIVERY_QUEUE',
      fallbackUsed: true,
    });
  });

  it('reports a payload that could not be queued, with what it tried and no fallback used', async () => {
    const item = payload('critical');
    expect(await enqueueLoggingDeliveryPayload(item, {})).toStrictEqual({
      queued: false,
      lane: 'critical',
      bindingName: null,
      fallbackUsed: false,
      attemptedBindingNames: ['LOGGING_DELIVERY_CRITICAL_QUEUE', 'LOGGING_DELIVERY_QUEUE'],
      payloadId: 'qpl_critical',
      byteCount: new TextEncoder().encode(JSON.stringify(item)).byteLength,
    });
  });

  it('refuses a payload over the byte limit of its lane, exactly', async () => {
    const sized = (lane: LoggingDeliveryLane, bytes: number) => {
      const base = payload(lane, { requested_by: '' });
      const baseBytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
      return payload(lane, { requested_by: 'x'.repeat(bytes - baseBytes) });
    };
    for (const [lane, limit] of [
      ['critical', 256 * 1024],
      ['default', 512 * 1024],
      ['bulk', 1024 * 1024],
    ] as const) {
      const shared = queue();
      const bindings = {
        LOGGING_DELIVERY_CRITICAL_QUEUE: shared,
        LOGGING_DELIVERY_QUEUE: shared,
        LOGGING_DELIVERY_BULK_QUEUE: shared,
      };
      await expect(
        enqueueLoggingDeliveryPayload(sized(lane, limit), bindings)
      ).resolves.toMatchObject({ queued: true, byteCount: limit });
      await expect(enqueueLoggingDeliveryPayload(sized(lane, limit + 1), bindings)).rejects.toThrow(
        `logging_delivery_payload_too_large:${lane}`
      );
    }
  });

  it('measures bytes, not characters', async () => {
    const item = payload('critical', { requested_by: 'あ'.repeat(90_000) });
    const shared = queue();
    await expect(
      enqueueLoggingDeliveryPayload(item, { LOGGING_DELIVERY_CRITICAL_QUEUE: shared })
    ).rejects.toThrow('logging_delivery_payload_too_large:critical');
    expect(shared.send).not.toHaveBeenCalled();
  });
});

describe('enqueueLoggingDeliveryPayloadBatch', () => {
  it('sends payloads by lane priority, keeping the order within a lane', async () => {
    const sent: string[] = [];
    const recorder = {
      send: vi.fn(
        async (message: unknown) => void sent.push((message as { payload_id: string }).payload_id)
      ),
    };
    const bindings = {
      LOGGING_DELIVERY_CRITICAL_QUEUE: recorder,
      LOGGING_DELIVERY_QUEUE: recorder,
      LOGGING_DELIVERY_BULK_QUEUE: recorder,
    };
    const items = [
      payload('bulk', { payload_id: 'b1' }),
      payload('critical', { payload_id: 'c1' }),
      payload('default', { payload_id: 'd1' }),
      payload('critical', { payload_id: 'c2' }),
      payload('bulk', { payload_id: 'b2' }),
    ];
    const results = await enqueueLoggingDeliveryPayloadBatch(items, bindings);
    expect(sent).toEqual(['c1', 'c2', 'd1', 'b1', 'b2']);
    expect(results.map((result) => result.payloadId)).toEqual(['c1', 'c2', 'd1', 'b1', 'b2']);
    expect(items.map((item) => item.payload_id)).toEqual(['b1', 'c1', 'd1', 'c2', 'b2']);
    expect(await enqueueLoggingDeliveryPayloadBatch([], bindings)).toEqual([]);
  });
});

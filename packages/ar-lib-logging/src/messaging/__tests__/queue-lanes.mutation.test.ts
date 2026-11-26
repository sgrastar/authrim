import { describe, expect, it, vi } from 'vitest';
import { enqueueLoggingMessagePayload } from '../queue-lanes';
import type { LoggingMessageQueuePayload } from '../queue-payload';
import type { LoggingDeliveryLane } from '../../delivery/types';

const payload = (
  lane: LoggingDeliveryLane,
  extra: Record<string, unknown> = {}
): LoggingMessageQueuePayload => ({
  payload_type: 'export_build',
  schema_version: 1,
  payload_id: `qpl_${lane}`,
  message_job_id: 'lmj_1',
  lane,
  created_at: 1,
  export_job_id: 'lexp_1',
  phase: 'plan',
  snapshot_cutoff_at: 1,
  requested_by: 'admin_1',
  ...extra,
});

const queue = () => ({ send: vi.fn(async (_message: unknown) => undefined) });

describe('enqueueLoggingMessagePayload', () => {
  it('sends to the queue of the lane and says where it went', async () => {
    const critical = queue();
    const item = payload('critical');
    expect(
      await enqueueLoggingMessagePayload(item, { LOGGING_MESSAGE_CRITICAL_QUEUE: critical })
    ).toStrictEqual({
      queued: true,
      lane: 'critical',
      bindingName: 'LOGGING_MESSAGE_CRITICAL_QUEUE',
      fallbackUsed: false,
      attemptedBindingNames: ['LOGGING_MESSAGE_CRITICAL_QUEUE', 'LOGGING_MESSAGE_QUEUE'],
      payloadId: 'qpl_critical',
      byteCount: new TextEncoder().encode(JSON.stringify(item)).byteLength,
    });
    expect(critical.send).toHaveBeenCalledWith(item);
  });

  it('falls back to the shared queue for critical and bulk, and not for default', async () => {
    const shared = queue();
    for (const lane of ['critical', 'bulk'] as const) {
      const result = await enqueueLoggingMessagePayload(payload(lane), {
        LOGGING_MESSAGE_QUEUE: shared,
      });
      expect(result).toMatchObject({
        queued: true,
        bindingName: 'LOGGING_MESSAGE_QUEUE',
        fallbackUsed: true,
      });
    }
    const direct = await enqueueLoggingMessagePayload(payload('default'), {
      LOGGING_MESSAGE_QUEUE: shared,
    });
    expect(direct).toMatchObject({ bindingName: 'LOGGING_MESSAGE_QUEUE', fallbackUsed: false });
    expect(direct.attemptedBindingNames).toEqual(['LOGGING_MESSAGE_QUEUE']);
    expect(
      (await enqueueLoggingMessagePayload(payload('bulk'), { LOGGING_MESSAGE_QUEUE: shared }))
        .attemptedBindingNames
    ).toEqual(['LOGGING_MESSAGE_BULK_QUEUE', 'LOGGING_MESSAGE_QUEUE']);
  });

  it('skips bindings that are not queues, and reports when none is', async () => {
    const shared = queue();
    for (const notQueue of [undefined, null, 'x', 5, {}, { send: 1 }]) {
      const fallback = await enqueueLoggingMessagePayload(payload('bulk'), {
        LOGGING_MESSAGE_BULK_QUEUE: notQueue,
        LOGGING_MESSAGE_QUEUE: shared,
      });
      expect(fallback).toMatchObject({ queued: true, bindingName: 'LOGGING_MESSAGE_QUEUE' });
      const none = await enqueueLoggingMessagePayload(payload('default'), {
        LOGGING_MESSAGE_QUEUE: notQueue,
      });
      expect(none).toMatchObject({ queued: false, bindingName: null, fallbackUsed: false });
    }
    const item = payload('critical');
    expect(await enqueueLoggingMessagePayload(item, {})).toStrictEqual({
      queued: false,
      lane: 'critical',
      bindingName: null,
      fallbackUsed: false,
      attemptedBindingNames: ['LOGGING_MESSAGE_CRITICAL_QUEUE', 'LOGGING_MESSAGE_QUEUE'],
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
    const shared = queue();
    const bindings = {
      LOGGING_MESSAGE_CRITICAL_QUEUE: shared,
      LOGGING_MESSAGE_QUEUE: shared,
      LOGGING_MESSAGE_BULK_QUEUE: shared,
    };
    for (const [lane, limit] of [
      ['critical', 256 * 1024],
      ['default', 512 * 1024],
      ['bulk', 1024 * 1024],
    ] as const) {
      await expect(
        enqueueLoggingMessagePayload(sized(lane, limit), bindings)
      ).resolves.toMatchObject({
        queued: true,
        byteCount: limit,
      });
      await expect(enqueueLoggingMessagePayload(sized(lane, limit + 1), bindings)).rejects.toThrow(
        `logging_message_payload_too_large:${lane}`
      );
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { enqueueLoggingMessagePayload } from '../queue-lanes';
import type { LoggingMessageQueuePayload } from '../queue-payload';

function payload(lane: 'critical' | 'default' | 'bulk'): LoggingMessageQueuePayload {
  return {
    schema_version: 1,
    payload_type: 'logging_message',
    payload_id: `payload-${lane}`,
    tenant_key: 'tenant-a',
    lane,
    created_at: 1,
    message: { type: 'audit', body: { event: 'login.failed' } },
  } as unknown as LoggingMessageQueuePayload;
}

describe('logging message queue lanes', () => {
  it('prefers the isolated critical queue over the shared fallback', async () => {
    const critical = { send: vi.fn().mockResolvedValue(undefined) };
    const fallback = { send: vi.fn().mockResolvedValue(undefined) };

    await expect(
      enqueueLoggingMessagePayload(payload('critical'), {
        LOGGING_MESSAGE_CRITICAL_QUEUE: critical,
        LOGGING_MESSAGE_QUEUE: fallback,
      })
    ).resolves.toMatchObject({
      queued: true,
      bindingName: 'LOGGING_MESSAGE_CRITICAL_QUEUE',
      fallbackUsed: false,
    });
    expect(critical.send).toHaveBeenCalledOnce();
    expect(fallback.send).not.toHaveBeenCalled();
  });

  it('falls back for bulk traffic and reports missing queues without dropping metadata', async () => {
    const fallback = { send: vi.fn().mockResolvedValue(undefined) };
    await expect(
      enqueueLoggingMessagePayload(payload('bulk'), {
        LOGGING_MESSAGE_QUEUE: fallback,
      })
    ).resolves.toMatchObject({
      queued: true,
      bindingName: 'LOGGING_MESSAGE_QUEUE',
      fallbackUsed: true,
      attemptedBindingNames: ['LOGGING_MESSAGE_BULK_QUEUE', 'LOGGING_MESSAGE_QUEUE'],
    });
    await expect(enqueueLoggingMessagePayload(payload('default'), {})).resolves.toMatchObject({
      queued: false,
      bindingName: null,
      payloadId: 'payload-default',
    });
  });
});

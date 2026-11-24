import { vi } from 'vitest';
import { processLoggingDeliveryQueue } from '../queue-consumer';
import {
  createFakeAdminDb,
  createFakeLogger,
  createMessage,
  fetchResponse,
} from './queue-consumer-mutation-helpers';

let sequence = 0;

/** Deliver one http_sink_batch payload through a destination with the given config. */
export async function deliver(input: {
  destination?: Record<string, unknown>;
  env?: Record<string, unknown>;
  payloadId?: string;
  status?: number;
}) {
  sequence += 1;
  const fetchMock = vi.fn().mockResolvedValue(fetchResponse(input.status ?? 200));
  vi.stubGlobal('fetch', fetchMock);
  const adminDb = createFakeAdminDb({
    destination: {
      provider_config: JSON.stringify({ url: 'https://collector.example/logs' }),
      ...input.destination,
    },
  });
  const logger = createFakeLogger();
  const message = createMessage({
    payload_type: 'http_sink_batch',
    schema_version: 1,
    payload_id: input.payloadId ?? `qpl_cred_${sequence}`,
    tenant_key: 'tk_cred',
    lane: 'critical',
    created_at: 1779148800000,
    destination_id: 'dest_cred',
    endpoint_url: 'https://collector.example/logs',
    log_type: 'operational',
    plane: 'external_sink',
    batch_id: `batch_${input.payloadId ?? sequence}`,
    record_count: 1,
  });
  await processLoggingDeliveryQueue(
    { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
    {
      DB: {} as D1Database,
      DB_PII: {} as D1Database,
      DB_ADMIN: adminDb,
      ...input.env,
    },
    logger
  );
  const headers = (fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined)
    ?.headers;
  return { fetchMock, adminDb, logger, message, headers };
}

export function loggedError(logger: ReturnType<typeof createFakeLogger>): string {
  const call = logger.error.mock.calls.find(
    ([event]) => event === 'logging_delivery_queue_message_failed'
  );
  return String((call?.[1] as { error?: string } | undefined)?.error);
}

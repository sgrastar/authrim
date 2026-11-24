import { vi } from 'vitest';
import {
  createFakeAdminDb,
  createFakeLogger,
  createMessage,
  fetchResponse,
  sqlCalls,
  type FakeAdminDb,
} from './queue-consumer-mutation-helpers';
import { processLoggingDeliveryQueue, type AuditQueueConsumerEnv } from '../queue-consumer';

export const CREATED_AT = 1779148800000;
export const NOW = new Date('2026-04-05T06:07:08.000Z');

export function httpBatch(overrides: Record<string, unknown> = {}) {
  return {
    payload_type: 'http_sink_batch',
    schema_version: 1,
    payload_id: 'qpl_http_1',
    tenant_key: 'tk_http',
    lane: 'critical',
    created_at: CREATED_AT,
    destination_id: 'dest_http',
    endpoint_url: 'https://collector.example/logs',
    log_type: 'operational',
    plane: 'external_sink',
    batch_id: 'batch_http_1',
    record_count: 4,
    ...overrides,
  };
}

export function fanout(overrides: Record<string, unknown> = {}) {
  return {
    payload_type: 'delivery_fanout',
    schema_version: 1,
    payload_id: 'qpl_fan_1',
    tenant_key: 'tk_fan',
    lane: 'critical',
    created_at: CREATED_AT,
    catalog_id: 'cat_fan_1',
    object_key: 'logs/v1/object.json',
    destination_id: 'dest_fan',
    log_type: 'audit',
    plane: 'archive',
    record_count: 3,
    ...overrides,
  };
}

export async function run(input: {
  body: unknown;
  adminDb?: FakeAdminDb | null;
  env?: Record<string, unknown>;
  fetchImpl?: ReturnType<typeof vi.fn>;
  attempts?: number;
}) {
  const fetchMock = input.fetchImpl ?? vi.fn().mockResolvedValue(fetchResponse(200));
  vi.stubGlobal('fetch', fetchMock);
  const adminDb = input.adminDb === undefined ? createFakeAdminDb() : input.adminDb;
  const message = createMessage(input.body, { attempts: input.attempts ?? 1 });
  const logger = createFakeLogger();
  await processLoggingDeliveryQueue(
    { messages: [message] } as unknown as MessageBatch<unknown>,
    {
      DB: {},
      DB_PII: {},
      ...(adminDb ? { DB_ADMIN: adminDb } : {}),
      ...input.env,
    } as unknown as AuditQueueConsumerEnv,
    logger
  );
  return { fetchMock, adminDb, message, logger };
}

export function loggedError(logger: ReturnType<typeof createFakeLogger>): string {
  const call = logger.error.mock.calls.find(
    ([event]) => event === 'logging_delivery_queue_message_failed'
  );
  return String((call?.[1] as { error?: string } | undefined)?.error);
}

export function completionMetadata(db: FakeAdminDb) {
  const [call] = sqlCalls(db, "SET status = 'delivered'");
  const params = call?.[1] as unknown[];
  return { params, metadata: JSON.parse(params[3] as string) as Record<string, unknown> };
}

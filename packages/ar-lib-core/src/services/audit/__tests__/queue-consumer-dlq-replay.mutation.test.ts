import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processLoggingDeliveryQueue, type AuditQueueConsumerEnv } from '../queue-consumer';
import {
  ROOT_KEY,
  createEncryptedPayloadObject,
  createFakeAdminDb,
  createFakeLogger,
  createMessage,
  insertedDeliveryEvents,
  insertedNotifications,
  sqlCalls,
  type FakeAdminDb,
  must,
} from './queue-consumer-mutation-helpers';

const NOW = new Date('2026-05-06T07:08:09.000Z');

describe('logging delivery queue: dlq_replay', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const OBJECT_REF = 'dlq/tenant_key=tk_replay/item.json';

  function replayPayload(overrides: Record<string, unknown> = {}) {
    return {
      payload_type: 'dlq_replay',
      schema_version: 1,
      payload_id: 'qpl_replay',
      tenant_key: 'tk_replay',
      lane: 'critical',
      created_at: 1779148800000,
      dlq_item_id: 'dlq_item_1',
      requested_by: 'admin_7',
      ...overrides,
    };
  }

  async function runReplay(input: {
    item?: Record<string, unknown> | null;
    object?: unknown;
    noObject?: boolean;
    adminDb?: FakeAdminDb | null;
    noBucket?: boolean;
    env?: Record<string, unknown>;
    attempts?: number;
    deleteImpl?: () => Promise<void>;
    snapshot?: boolean;
  }) {
    const adminDb =
      input.adminDb === undefined
        ? createFakeAdminDb({
            dlqItem:
              input.item === null
                ? null
                : {
                    id: 'dlq_item_1',
                    tenant_key: 'tk_replay',
                    payload_object_ref: OBJECT_REF,
                    ...input.item,
                  },
            queryOne: input.snapshot
              ? (sql) => (sql.includes('tenant_backup_snapshots') ? { id: 'snap' } : undefined)
              : undefined,
          })
        : input.adminDb;
    const object = input.noObject
      ? null
      : await createEncryptedPayloadObject(
          OBJECT_REF,
          'tk_replay',
          'object' in input ? input.object : { body: { replayed: true } }
        );
    const bucket = {
      get: vi.fn().mockResolvedValue(object),
      delete: vi.fn().mockImplementation(input.deleteImpl ?? (async () => undefined)),
    };
    const message = createMessage(replayPayload(), { attempts: input.attempts ?? 2 });
    const logger = createFakeLogger();
    await processLoggingDeliveryQueue(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      {
        DB: {},
        DB_PII: {},
        ...(adminDb ? { DB_ADMIN: adminDb } : {}),
        ...(input.noBucket ? {} : { SENSITIVE_DETAILS: bucket }),
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
        ...input.env,
      } as unknown as AuditQueueConsumerEnv,
      logger
    );
    return { adminDb, bucket, message, logger };
  }

  const baseMetadata = {
    payload_id: 'qpl_replay',
    dlq_item_id: 'dlq_item_1',
    requested_by: 'admin_7',
    replay_payload_type: 'audit_queue_message',
    replay_schema_version: 1,
    payload_object_ref: OBJECT_REF,
  };

  it('replays audit messages to AUDIT_QUEUE, marks the item replayed and deletes the payload', async () => {
    const auditQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const { adminDb, bucket, message } = await runReplay({
      env: { AUDIT_QUEUE: auditQueue },
      attempts: 4,
    });
    expect(bucket.get).toHaveBeenCalledWith(OBJECT_REF);
    expect(auditQueue.send).toHaveBeenCalledExactlyOnceWith({ replayed: true });
    const [update] = sqlCalls(must(adminDb), "SET status = 'replayed'");
    expect(update?.[1]).toEqual([NOW.getTime(), 'dlq_item_1']);
    expect(bucket.delete).toHaveBeenCalledExactlyOnceWith(OBJECT_REF);
    expect(insertedDeliveryEvents(must(adminDb))).toEqual([
      expect.objectContaining({
        tenantKey: 'tk_replay',
        destinationId: 'queue:AUDIT_DLQ',
        logType: 'operational',
        plane: 'delivery_event',
        lane: 'critical',
        status: 'delivered',
        attemptCount: 4,
        errorClass: null,
        metadata: {
          ...baseMetadata,
          replay_queue_binding: 'AUDIT_QUEUE',
          replay_queue_fallback_used: false,
        },
      }),
    ]);
    expect(insertedNotifications(must(adminDb))).toEqual([]);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('uses queue:AUDIT_QUEUE as the destination when the item has none', async () => {
    const { adminDb } = await runReplay({
      item: { destination_id: null },
      env: { AUDIT_QUEUE: { send: vi.fn() } },
    });
    expect(insertedDeliveryEvents(must(adminDb))[0]?.destinationId).toBe('queue:AUDIT_QUEUE');
  });

  it('keeps the payload object while a tenant backup snapshot is capturing', async () => {
    const { bucket, message } = await runReplay({
      env: { AUDIT_QUEUE: { send: vi.fn() } },
      snapshot: true,
    });
    expect(bucket.delete).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('only warns when payload cleanup fails', async () => {
    const { logger, message } = await runReplay({
      env: { AUDIT_QUEUE: { send: vi.fn() } },
      deleteImpl: async () => {
        throw new Error('r2 gone');
      },
    });
    expect(logger.warn).toHaveBeenCalledWith('logging_dlq_replay_payload_cleanup_failed', {
      objectRef: OBJECT_REF,
      error: 'Error: r2 gone',
    });
    expect(message.ack).toHaveBeenCalledOnce();
  });

  describe('delivery payload replays', () => {
    const item = { payload_type: 'http_sink_batch', lane: 'critical', schema_version: 1 };

    it('sends to the primary lane queue', async () => {
      const primary = { send: vi.fn().mockResolvedValue(undefined) };
      const fallback = { send: vi.fn() };
      const { adminDb, message } = await runReplay({
        item,
        env: { LOGGING_DELIVERY_CRITICAL_QUEUE: primary, LOGGING_DELIVERY_QUEUE: fallback },
      });
      expect(primary.send).toHaveBeenCalledExactlyOnceWith({ replayed: true });
      expect(fallback.send).not.toHaveBeenCalled();
      expect(insertedDeliveryEvents(must(adminDb))[0]?.metadata).toEqual({
        ...baseMetadata,
        replay_payload_type: 'http_sink_batch',
        replay_queue_binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
        replay_queue_fallback_used: false,
      });
      expect(insertedDeliveryEvents(must(adminDb))[0]?.lane).toBe('critical');
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('falls back to the default queue and reports it', async () => {
      const fallback = { send: vi.fn().mockResolvedValue(undefined) };
      const { adminDb } = await runReplay({ item, env: { LOGGING_DELIVERY_QUEUE: fallback } });
      expect(fallback.send).toHaveBeenCalledOnce();
      expect(insertedDeliveryEvents(must(adminDb))[0]?.metadata).toMatchObject({
        replay_queue_binding: 'LOGGING_DELIVERY_QUEUE',
        replay_queue_fallback_used: true,
      });
    });

    it('fails when no delivery queue is bound', async () => {
      const { message, logger, adminDb } = await runReplay({ item });
      expect(message.retry).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'logging_delivery_queue_message_failed',
        expect.objectContaining({ error: 'Error: logging_dlq_replay_delivery_queue_unavailable' })
      );
      expect(sqlCalls(must(adminDb), "SET status = 'replayed'")).toEqual([]);
    });
  });

  describe('failures', () => {
    it.each([
      ['a missing admin database', { adminDb: null }, 'logging_dlq_replay_admin_db_unavailable'],
      [
        'a missing payload bucket',
        { noBucket: true },
        'logging_dlq_replay_payload_bucket_unavailable',
      ],
    ])('retries without side effects for %s', async (_name, input, expected) => {
      const { message, logger } = await runReplay(input);
      expect(message.retry).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'logging_delivery_queue_message_failed',
        expect.objectContaining({ error: `Error: ${expected}` })
      );
    });

    it('retries when the DLQ item does not exist', async () => {
      const { message, logger, adminDb } = await runReplay({ item: null });
      expect(logger.error).toHaveBeenCalledWith(
        'logging_delivery_queue_message_failed',
        expect.objectContaining({ error: 'Error: logging_dlq_replay_item_not_found' })
      );
      expect(message.retry).toHaveBeenCalledOnce();
      expect(insertedDeliveryEvents(must(adminDb))).toEqual([]);
    });

    it('retries when the DLQ item is not open', async () => {
      const { message, logger, adminDb } = await runReplay({ item: { status: 'replayed' } });
      expect(logger.error).toHaveBeenCalledWith(
        'logging_delivery_queue_message_failed',
        expect.objectContaining({ error: 'Error: logging_dlq_replay_item_not_open' })
      );
      expect(message.retry).toHaveBeenCalledOnce();
      expect(insertedDeliveryEvents(must(adminDb))).toEqual([]);
    });

    it.each([
      [
        'a missing payload object',
        { noObject: true, env: { AUDIT_QUEUE: { send: vi.fn() } } },
        'logging_dlq_replay_payload_object_not_found',
      ],
      [
        'a payload without a body',
        { object: { other: 1 }, env: { AUDIT_QUEUE: { send: vi.fn() } } },
        'logging_dlq_replay_payload_body_missing',
      ],
      [
        'a null payload',
        { object: null, env: { AUDIT_QUEUE: { send: vi.fn() } } },
        'logging_dlq_replay_payload_body_missing',
      ],
      ['an unbound AUDIT_QUEUE', {}, 'logging_dlq_replay_audit_queue_unavailable'],
    ])('records a retrying event and notification for %s', async (_name, input, expected) => {
      const { message, adminDb, logger } = await runReplay({ ...input, attempts: 3 });
      expect(message.retry).toHaveBeenCalledExactlyOnceWith();
      expect(message.ack).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'logging_delivery_queue_message_failed',
        expect.objectContaining({ error: `Error: ${expected}` })
      );
      expect(sqlCalls(must(adminDb), "SET status = 'replayed'")).toEqual([]);
      const [event] = insertedDeliveryEvents(must(adminDb));
      expect(event).toMatchObject({
        tenantKey: 'tk_replay',
        destinationId: 'queue:AUDIT_DLQ',
        logType: 'operational',
        plane: 'delivery_event',
        lane: 'critical',
        status: 'retrying',
        attemptCount: 3,
        errorClass: 'logging_dlq_replay_failed',
      });
      expect(event?.nextRetryAt).toBeNull();
      expect(event?.metadata).toEqual({
        ...baseMetadata,
        error: `Error: ${expected}`,
      });
      expect(insertedNotifications(must(adminDb))[0]).toMatchObject({
        tenantId: 'tk_replay',
        category: 'logging_delivery_failure',
        eventType: 'logging.delivery.retrying',
        severity: 'critical',
      });
    });
  });
});

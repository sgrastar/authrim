import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import {
  processDLQQueue,
  processLoggingDeliveryQueue,
  type AuditQueueConsumerEnv,
} from '../queue-consumer';
import { decryptObjectArtifact } from '../../object-artifact-crypto';
import { type AuditQueueMessage } from '../types';
import {
  ROOT_KEY,
  createFakeAdminDb,
  createFakeLogger,
  createMemoryBucket,
  createMessage,
  parseEnvelope,
  insertedDeliveryEvents,
  insertedNotifications,
  sqlCalls,
  type FakeAdminDb,
  must,
} from './queue-consumer-mutation-helpers';

const NOW = new Date('2026-05-06T07:08:09.000Z');

describe('audit DLQ consumer (exact outputs)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function dlqBody(overrides: Partial<AuditQueueMessage> = {}): AuditQueueMessage {
    return {
      type: 'event_log',
      tenantId: 'tenant-dlq',
      timestamp: 1779148800000,
      entries: [
        { id: 'e1', createdAt: 1 },
        { id: 'e2', createdAt: 2 },
      ],
      ...overrides,
    } as unknown as AuditQueueMessage;
  }

  async function runDlq(input: {
    body?: AuditQueueMessage;
    timestamp?: Date;
    attempts?: number;
    adminDb?: FakeAdminDb | null;
    bucket?: ReturnType<typeof createMemoryBucket> | null;
  }) {
    const adminDb = input.adminDb === undefined ? createFakeAdminDb() : input.adminDb;
    const bucket = input.bucket === undefined ? createMemoryBucket() : input.bucket;
    const message = createMessage(input.body ?? dlqBody(), {
      attempts: input.attempts ?? 5,
      timestamp: input.timestamp,
    });
    const logger = createFakeLogger();
    await processDLQQueue(
      { messages: [message] } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {},
        DB_PII: {},
        ...(adminDb ? { DB_ADMIN: adminDb } : {}),
        ...(bucket ? { SENSITIVE_DETAILS: bucket } : {}),
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
        LOGGING_TENANT_KEY_SALT: 'dlq-salt',
      } as unknown as AuditQueueConsumerEnv,
      logger
    );
    return { adminDb, bucket, message, logger };
  }

  it('stores the encrypted replay payload and records the DLQ item, event and notification', async () => {
    const timestamp = new Date(Date.UTC(2026, 4, 19, 10, 30));
    const { adminDb, bucket, message, logger } = await runDlq({ timestamp });
    const tenantKey = await deriveTenantKeyFromTenantId('tenant-dlq', 'dlq-salt');

    expect(bucket?.put).toHaveBeenCalledOnce();
    const [objectKey, stored, options] = bucket?.put.mock.calls[0] as [
      string,
      string,
      { customMetadata: Record<string, string>; httpMetadata: Record<string, string> },
    ];
    expect(objectKey).toMatch(
      new RegExp(`^dlq/tenant_key=${tenantKey}/yyyy=2026/mm=05/dd=19/dlq_[0-9a-f-]+\\.json$`)
    );
    const dlqItemId = must(objectKey.split('/').pop()).replace('.json', '');
    expect(options.customMetadata).toEqual({
      tenantKey,
      payloadType: 'audit_queue_message',
      schemaVersion: '1',
      dlqItemId,
      logType: 'audit',
      encryption: 'authrim-object-envelope-v1',
      encryptionTenantContext: tenantKey,
      keyVersion: '1',
    });
    expect(options.httpMetadata).toEqual({
      contentType: 'application/vnd.authrim.object-envelope+json',
    });
    const plaintext: unknown = JSON.parse(
      await decryptObjectArtifact(parseEnvelope(stored), {
        rootKeyHex: ROOT_KEY,
        context: { tenantId: tenantKey, objectKey, objectClass: 'operational_log_detail' },
      })
    );
    expect(plaintext).toEqual({
      messageId: message.id,
      receivedAt: timestamp.toISOString(),
      retryCount: 5,
      body: message.body,
    });

    const [dlqInsert] = sqlCalls(adminDb, 'INSERT INTO logging_dlq_items');
    expect(dlqInsert?.[1]).toEqual([
      dlqItemId,
      tenantKey,
      'audit_queue_message',
      1,
      'critical',
      'queue:AUDIT_DLQ',
      objectKey,
      'audit_message_failed_permanently',
      5,
      'open',
      timestamp.getTime(),
      timestamp.getTime(),
    ]);

    const [event] = insertedDeliveryEvents(adminDb);
    expect(event).toMatchObject({
      tenantKey,
      destinationId: 'queue:AUDIT_DLQ',
      logType: 'audit',
      plane: 'delivery_event',
      lane: 'critical',
      status: 'dlq',
      attemptCount: 5,
      errorClass: 'audit_message_failed_permanently',
    });
    expect(event?.id).toMatch(/^lde_/);
    const expectedMetadata = {
      dlq_item_id: dlqItemId,
      payload_object_ref: objectKey,
      payload_type: 'audit_queue_message',
      schema_version: 1,
      record_count: 2,
    };
    expect(event?.metadata).toEqual(expectedMetadata);

    const [notification] = insertedNotifications(adminDb);
    expect(notification).toMatchObject({
      tenantId: 'tenant-dlq',
      category: 'logging_dlq_backlog',
      eventType: 'logging.delivery.dlq',
      severity: 'critical',
      deduplicationKey: [
        'logging_delivery',
        'dlq',
        tenantKey,
        'queue:AUDIT_DLQ',
        'audit',
        'delivery_event',
        'critical',
        'audit_message_failed_permanently',
      ].join(':'),
    });
    expect(notification?.payload).toMatchObject({
      status: 'dlq',
      attempt_count: 5,
      external_notification_eligible: true,
      metadata: expectedMetadata,
    });
    expect(notification?.id).not.toBe(event?.id);

    expect(logger.error).toHaveBeenCalledWith('audit_message_failed_permanently', {
      messageId: message.id,
      tenantId: 'tenant-dlq',
      type: 'event_log',
      entryCount: 2,
      attempts: 5,
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('falls back to the epoch partition when the message has no timestamp', async () => {
    const { bucket, adminDb } = await runDlq({ timestamp: undefined });
    const objectKey = bucket?.put.mock.calls[0]?.[0] as string;
    expect(objectKey).toContain('/yyyy=1970/mm=01/dd=01/');
    const [dlqInsert] = sqlCalls(adminDb, 'INSERT INTO logging_dlq_items');
    expect((dlqInsert?.[1] as unknown[]).slice(10)).toEqual([0, 0]);
  });

  it('labels pii_log messages as pii', async () => {
    const { bucket } = await runDlq({ body: dlqBody({ type: 'pii_log' }) });
    expect(bucket?.put.mock.calls[0]?.[2]).toMatchObject({
      customMetadata: { logType: 'pii' },
    });
  });

  it('still stores and acks without an admin database', async () => {
    const { bucket, message } = await runDlq({ adminDb: null });
    expect(bucket?.put).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('retries when the payload bucket is not bound', async () => {
    const { message, logger, adminDb } = await runDlq({ bucket: null });
    expect(message.retry).toHaveBeenCalledExactlyOnceWith();
    expect(message.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('dlq_save_failed', {
      messageId: message.id,
      error: 'Error: audit_dlq_payload_bucket_unavailable',
    });
    expect(sqlCalls(must(adminDb), 'INSERT INTO logging_dlq_items')).toEqual([]);
  });

  it('delays the retry when the DLQ write hits an active claim', async () => {
    const error = Object.assign(new Error('claim active'), {
      name: 'LogChunkWriteClaimActiveError',
      retryAt: NOW.getTime() + 4200,
    });
    const adminDb = createFakeAdminDb({
      executeResult: (sql) => (sql.includes('INSERT INTO logging_dlq_items') ? error : undefined),
    });
    const { message } = await runDlq({ adminDb });
    expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 5 });
    expect(message.ack).not.toHaveBeenCalled();
  });
});

describe('logging delivery queue: unsupported payload DLQ', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function unsupported(overrides: Record<string, unknown> = {}) {
    return {
      payload_type: 'mystery_payload',
      schema_version: 7,
      payload_id: 'qpl_unsupported',
      tenant_key: 'tk/weird key',
      lane: 'bulk',
      created_at: 1779148800000,
      ...overrides,
    };
  }

  async function runUnsupported(input: {
    body?: unknown;
    timestamp?: Date;
    adminDb?: FakeAdminDb | null;
    bucket?: ReturnType<typeof createMemoryBucket> | null;
    attempts?: number;
  }) {
    const adminDb = input.adminDb === undefined ? createFakeAdminDb() : input.adminDb;
    const bucket = input.bucket === undefined ? createMemoryBucket() : input.bucket;
    const message = createMessage('body' in input ? input.body : unsupported(), {
      attempts: input.attempts ?? 3,
      timestamp: input.timestamp ?? new Date(Date.UTC(2026, 10, 3, 4)),
    });
    const logger = createFakeLogger();
    await processLoggingDeliveryQueue(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      {
        DB: {},
        DB_PII: {},
        ...(adminDb ? { DB_ADMIN: adminDb } : {}),
        ...(bucket ? { SENSITIVE_DETAILS: bucket } : {}),
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      } as unknown as AuditQueueConsumerEnv,
      logger
    );
    return { adminDb, bucket, message, logger };
  }

  it('writes the replay payload, DLQ item, event and notification then acks', async () => {
    const { adminDb, bucket, message, logger } = await runUnsupported({});
    const [objectKey, stored, options] = bucket?.put.mock.calls[0] as [
      string,
      string,
      { customMetadata: Record<string, string> },
    ];
    expect(objectKey).toMatch(
      /^dlq\/tenant_key=tk_weird_key\/yyyy=2026\/mm=11\/dd=03\/unsupported\/dlq_[0-9a-f-]+\.json$/
    );
    const dlqItemId = must(objectKey.split('/').pop()).replace('.json', '');
    expect(options.customMetadata).toMatchObject({
      tenantKey: 'tk/weird key',
      payloadType: 'mystery_payload',
      schemaVersion: '7',
      dlqItemId,
      encryption: 'authrim-object-envelope-v1',
      encryptionTenantContext: 'tk/weird key',
    });
    const plaintext: unknown = JSON.parse(
      await decryptObjectArtifact(parseEnvelope(stored), {
        rootKeyHex: ROOT_KEY,
        context: {
          tenantId: 'tk/weird key',
          objectKey,
          objectClass: 'operational_log_detail',
        },
      })
    );
    expect(plaintext).toEqual({
      messageId: message.id,
      receivedAt: '2026-11-03T04:00:00.000Z',
      retryCount: 3,
      parseResult: {
        ok: false,
        reason: 'unsupported_schema',
        payloadType: 'mystery_payload',
        schemaVersion: 7,
        payloadId: 'qpl_unsupported',
        tenantKey: 'tk/weird key',
        lane: 'bulk',
        createdAt: 1779148800000,
      },
      body: message.body,
      bodyJson: JSON.stringify(message.body),
    });

    const [dlqInsert] = sqlCalls(must(adminDb), 'INSERT INTO logging_dlq_items');
    expect(dlqInsert?.[1]).toEqual([
      dlqItemId,
      'tk/weird key',
      'mystery_payload',
      7,
      'bulk',
      'queue:LOGGING_DELIVERY',
      objectKey,
      'logging_delivery_payload_unsupported_schema',
      3,
      'open',
      Date.UTC(2026, 10, 3, 4),
      Date.UTC(2026, 10, 3, 4),
    ]);

    const [event] = insertedDeliveryEvents(must(adminDb));
    expect(event).toMatchObject({
      tenantKey: 'tk/weird key',
      destinationId: 'queue:LOGGING_DELIVERY',
      logType: 'operational',
      plane: 'delivery_event',
      lane: 'bulk',
      status: 'dlq',
      attemptCount: 3,
      errorClass: 'logging_delivery_payload_unsupported_schema',
    });
    expect(event?.metadata).toEqual({
      dlq_item_id: dlqItemId,
      payload_object_ref: objectKey,
      payload_type: 'mystery_payload',
      schema_version: 7,
      payload_id: 'qpl_unsupported',
      parser_reason: 'unsupported_schema',
    });
    const [notification] = insertedNotifications(must(adminDb));
    expect(notification).toMatchObject({
      tenantId: 'tk/weird key',
      category: 'logging_dlq_backlog',
      eventType: 'logging.delivery.dlq',
      severity: 'critical',
    });
    expect(notification?.id).not.toBe(event?.id);
    expect(notification?.payload).toMatchObject({
      external_notification_eligible: false,
      lane: 'bulk',
    });
    expect(logger.warn).toHaveBeenCalledWith('logging_delivery_payload_unsupported_schema_dlq', {
      messageId: message.id,
      payloadType: 'mystery_payload',
      schemaVersion: 7,
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('stores a placeholder when the body cannot be serialized on first attempt', async () => {
    let calls = 0;
    const body = {
      ...unsupported(),
      toJSON() {
        calls += 1;
        if (calls === 1) throw new Error('not serializable');
        return { payload_type: 'mystery_payload' };
      },
    };
    const { bucket, message } = await runUnsupported({ body });
    const [objectKey, stored] = bucket?.put.mock.calls[0] as [string, string];
    const plaintext: unknown = JSON.parse(
      await decryptObjectArtifact(parseEnvelope(stored), {
        rootKeyHex: ROOT_KEY,
        context: {
          tenantId: 'tk/weird key',
          objectKey,
          objectClass: 'operational_log_detail',
        },
      })
    ) as { bodyJson: string };
    expect(plaintext.bodyJson).toBe('{"unserializable":true}');
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('retries when no payload bucket is available', async () => {
    const { message, logger, adminDb } = await runUnsupported({ bucket: null });
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('logging_delivery_queue_message_failed', {
      messageId: message.id,
      attempts: 3,
      error: 'Error: logging_delivery_unsupported_payload_dlq_bucket_unavailable',
    });
    expect(sqlCalls(must(adminDb), 'INSERT INTO logging_dlq_items')).toEqual([]);
  });

  it('works without an admin database', async () => {
    const { message, bucket } = await runUnsupported({ adminDb: null });
    expect(bucket?.put).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('retries malformed payloads and logs the malformed reason', async () => {
    const { message, logger } = await runUnsupported({ body: { payload_type: 'http_sink_batch' } });
    expect(message.retry).toHaveBeenCalledExactlyOnceWith();
    expect(logger.error).toHaveBeenCalledWith('logging_delivery_queue_message_failed', {
      messageId: message.id,
      attempts: 3,
      error: 'Error: logging_delivery_payload_malformed',
    });
  });

  it.each([null, 'text', 42, [1, 2]])('retries a non-object body %j', async (body) => {
    const { message } = await runUnsupported({ body });
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});

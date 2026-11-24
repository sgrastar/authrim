import { deriveTenantKeyFromTenantId, formatUtcPartition } from '@authrim/ar-lib-logging/contract';
import { describe, expect, it } from 'vitest';
import {
  createFakeAdminDb,
  insertedDeliveryEvents,
  insertedNotifications,
} from './queue-consumer-mutation-helpers';
import { TIMESTAMP, nextTenant, auditBody, run, stdEnv } from './queue-consumer-audit-kit';

describe('audit queue consumer: explicit HTTP destination enqueue', () => {
  it('stores the canonical batch encrypted and enqueues an http_sink_batch payload', async () => {
    const tenantId = nextTenant();
    const { env, bucket, critical, queue, adminDb } = stdEnv();
    const sink = {
      type: 'http',
      destinationId: 'dest-explicit',
      url: 'https://example.com/audit',
      headers: { 'X-One': '1', 'X-Two': '2' },
      authTokenRef: 'SINK_TOKEN',
    };
    const { message } = await run(auditBody(tenantId, [sink]), env, { attempts: 2 });

    expect(message.ack).toHaveBeenCalledOnce();
    expect(queue.send).not.toHaveBeenCalled();
    expect(critical.send).toHaveBeenCalledOnce();
    const payload = critical.send.mock.calls[0]?.[0] as Record<string, unknown>;
    const tenantKey = await deriveTenantKeyFromTenantId(tenantId, undefined);
    const partition = formatUtcPartition(TIMESTAMP);
    expect(payload).toEqual({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: expect.stringMatching(/^qpl_/) as string,
      tenant_key: tenantKey,
      lane: 'critical',
      created_at: TIMESTAMP,
      destination_id: 'dest-explicit',
      endpoint_url: 'https://example.com/audit',
      log_type: 'audit',
      plane: 'external_sink',
      batch_id: expect.stringMatching(/^batch_/) as string,
      record_count: 2,
      body_object_ref: `r2://logging-delivery-payloads/v1/${tenantKey}/${partition.year}/${partition.month}/${partition.day}/${partition.hour}/${String(payload.payload_id)}.json`,
    });

    const objectKey = `logging-delivery-payloads/v1/${tenantKey}/${partition.year}/${partition.month}/${partition.day}/${partition.hour}/${String(payload.payload_id)}.json`;
    expect(bucket.put).toHaveBeenCalledOnce();
    const stored = bucket.objects.get(objectKey);
    expect(stored?.customMetadata).toEqual({
      tenantKey,
      logType: 'audit',
      plane: 'external_sink',
      recordCount: '2',
      payloadId: payload.payload_id,
      batchId: payload.batch_id,
      createdAt: String(TIMESTAMP),
      encryption: 'authrim-object-envelope-v1',
      encryptionTenantContext: tenantKey,
      keyVersion: '1',
    });
    expect(String(stored?.value)).not.toContain('evt-a');

    const events = insertedDeliveryEvents(adminDb);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantKey,
      destinationId: 'dest-explicit',
      logType: 'audit',
      plane: 'external_sink',
      lane: 'critical',
      status: 'queued',
      attemptCount: 2,
      errorClass: null,
    });
    expect(events[0]?.id).toMatch(/^lde_/);
    expect(events[0]?.metadata).toEqual({
      audit_profile_id: 'profile-enqueue',
      target_type: 'http',
      destination_id: 'dest-explicit',
      record_count: 2,
      url_ref: null,
      inline_url: true,
      auth_token_ref_set: true,
      header_count: 2,
      payload_id: payload.payload_id,
      byte_count: new TextEncoder().encode(JSON.stringify(payload)).byteLength,
      delivery_queue_binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      delivery_queue_fallback_used: false,
      delivery_queue_attempted_bindings: [
        'LOGGING_DELIVERY_CRITICAL_QUEUE',
        'LOGGING_DELIVERY_QUEUE',
      ],
    });
    expect(insertedNotifications(adminDb)).toEqual([]);
  });

  it('uses deterministic ids so a redelivered message enqueues the same payload', async () => {
    const tenantId = nextTenant();
    const first = stdEnv();
    const second = stdEnv();
    const sink = { type: 'http', destinationId: 'dest-stable', url: 'https://example.com/a' };
    await run(auditBody(tenantId, [sink]), first.env, { attempts: 1 });
    await run(auditBody(tenantId, [sink]), second.env, { attempts: 4 });
    expect(second.critical.send.mock.calls[0]?.[0]).toEqual(first.critical.send.mock.calls[0]?.[0]);
    expect(insertedDeliveryEvents(second.adminDb)[0]?.id).toBe(
      insertedDeliveryEvents(first.adminDb)[0]?.id
    );
    expect(insertedDeliveryEvents(second.adminDb)[0]?.attemptCount).toBe(4);
  });

  it('derives different ids per destination and per entry set', async () => {
    const tenantId = nextTenant();
    const env = stdEnv();
    await run(
      auditBody(tenantId, [
        { type: 'http', destinationId: 'dest-1', url: 'https://example.com/a' },
        { type: 'http', destinationId: 'dest-2', url: 'https://example.com/a' },
      ]),
      env.env
    );
    const [one, two] = env.critical.send.mock.calls.map(
      ([payload]) => payload as Record<string, string>
    );
    expect(one?.destination_id).toBe('dest-1');
    expect(two?.destination_id).toBe('dest-2');
    expect(one?.payload_id).not.toBe(two?.payload_id);
    expect(one?.batch_id).not.toBe(two?.batch_id);
  });

  it('labels pii_log batches as pii and keeps them on the critical lane', async () => {
    const tenantId = nextTenant();
    const { env, critical, bucket } = stdEnv();
    const body = auditBody(tenantId, [
      { type: 'http', destinationId: 'dest-pii', url: 'https://example.com/pii' },
    ]);
    (body as { type: string }).type = 'pii_log';
    (body.entries as unknown[]) = [
      {
        id: 'pii-1',
        tenantId,
        userId: 'u1',
        anonymizedUserId: 'anon1',
        changeType: 'update',
        affectedFields: '["email"]',
        actorType: 'user',
        createdAt: TIMESTAMP,
      },
    ];
    const { message } = await run(body, env);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(critical.send.mock.calls[0]?.[0]).toMatchObject({
      log_type: 'pii',
      lane: 'critical',
      record_count: 1,
    });
    expect([...bucket.objects.values()][0]?.customMetadata).toMatchObject({
      logType: 'pii',
      recordCount: '1',
    });
  });

  it('resolves the endpoint from urlRef when no inline url is set and reports it in metadata', async () => {
    const tenantId = nextTenant();
    const { env, critical, adminDb } = stdEnv();
    await run(
      auditBody(tenantId, [
        { type: 'http', destinationId: 'dest-ref', urlRef: 'SINK_URL_BINDING' },
      ]),
      { ...env, SINK_URL_BINDING: 'https://bound.example/ingest' }
    );
    expect(critical.send.mock.calls[0]?.[0]).toMatchObject({
      endpoint_url: 'https://bound.example/ingest',
    });
    expect(insertedDeliveryEvents(adminDb)[0]?.metadata).toMatchObject({
      url_ref: 'SINK_URL_BINDING',
      inline_url: false,
      auth_token_ref_set: false,
      header_count: 0,
    });
  });

  it('reports inline_url false when both an inline url and a urlRef are configured', async () => {
    const tenantId = nextTenant();
    const { env, critical, adminDb } = stdEnv();
    await run(
      auditBody(tenantId, [
        {
          type: 'http',
          destinationId: 'dest-both',
          url: 'https://inline.example/ingest',
          urlRef: 'UNUSED_REF',
        },
      ]),
      env
    );
    expect(critical.send.mock.calls[0]?.[0]).toMatchObject({
      endpoint_url: 'https://inline.example/ingest',
    });
    expect(insertedDeliveryEvents(adminDb)[0]?.metadata).toMatchObject({
      url_ref: 'UNUSED_REF',
      inline_url: false,
    });
  });

  it('falls back to the default queue when the critical queue is unbound or not a queue', async () => {
    const tenantId = nextTenant();
    const { env, queue, adminDb } = stdEnv();
    await run(
      auditBody(tenantId, [
        { type: 'http', destinationId: 'dest-fb', url: 'https://example.com/a' },
      ]),
      { ...env, LOGGING_DELIVERY_CRITICAL_QUEUE: { send: 'not-a-function' } }
    );
    expect(queue.send).toHaveBeenCalledOnce();
    expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({ status: 'queued' });
    expect(insertedDeliveryEvents(adminDb)[0]?.metadata).toMatchObject({
      delivery_queue_binding: 'LOGGING_DELIVERY_QUEUE',
      delivery_queue_fallback_used: true,
      delivery_queue_attempted_bindings: [
        'LOGGING_DELIVERY_CRITICAL_QUEUE',
        'LOGGING_DELIVERY_QUEUE',
      ],
    });
  });

  it('copies logging policy details into the delivery metadata', async () => {
    const tenantId = nextTenant();
    const { env, adminDb } = stdEnv();
    await run(
      auditBody(tenantId, [
        {
          type: 'http',
          destinationId: 'dest-policy',
          url: 'https://example.com/a',
          loggingPolicy: {
            selectedDestinationId: 'dest-selected',
            effectiveDestinationId: 'dest-effective',
            fallbackDestinationId: 'dest-fallback',
            fallbackUsed: true,
            fallbackReason: 'selected_unavailable',
            failureMode: 'retry_until_ttl',
            policySource: 'tenant',
            policyWarnings: ['warn-1', 'warn-2'],
          },
        },
      ]),
      env
    );
    expect(insertedDeliveryEvents(adminDb)[0]?.metadata).toMatchObject({
      selected_destination_id: 'dest-selected',
      effective_destination_id: 'dest-effective',
      fallback_destination_id: 'dest-fallback',
      fallback_used: true,
      fallback_reason: 'selected_unavailable',
      failure_mode: 'retry_until_ttl',
      policy_source: 'tenant',
      policy_warnings: ['warn-1', 'warn-2'],
    });
  });

  it('defaults empty logging policy fields', async () => {
    const tenantId = nextTenant();
    const { env, adminDb } = stdEnv();
    await run(
      auditBody(tenantId, [
        {
          type: 'http',
          destinationId: 'dest-policy-empty',
          url: 'https://example.com/a',
          loggingPolicy: {},
        },
      ]),
      env
    );
    const metadata = insertedDeliveryEvents(adminDb)[0]?.metadata;
    expect(metadata).toMatchObject({
      selected_destination_id: null,
      effective_destination_id: 'dest-policy-empty',
      fallback_destination_id: null,
      fallback_used: false,
      fallback_reason: null,
      failure_mode: null,
      policy_source: null,
      policy_warnings: [],
    });
  });

  it('omits logging policy fields when the target has none', async () => {
    const tenantId = nextTenant();
    const { env, adminDb } = stdEnv();
    await run(
      auditBody(tenantId, [
        { type: 'http', destinationId: 'dest-nopolicy', url: 'https://example.com/a' },
      ]),
      env
    );
    expect(insertedDeliveryEvents(adminDb)[0]?.metadata).not.toHaveProperty(
      'selected_destination_id'
    );
  });

  it('honours OBJECT_ENCRYPTION_KEY_VERSION for the stored payload', async () => {
    const tenantId = nextTenant();
    const { env, bucket } = stdEnv();
    await run(
      auditBody(tenantId, [
        { type: 'http', destinationId: 'dest-kv', url: 'https://example.com/a' },
      ]),
      { ...env, OBJECT_ENCRYPTION_KEY_VERSION: '3' }
    );
    expect([...bucket.objects.values()][0]?.customMetadata?.keyVersion).toBe('3');
  });

  it.each(['0', '-2', 'abc', ''])(
    'falls back to key version 1 for OBJECT_ENCRYPTION_KEY_VERSION=%j',
    async (version) => {
      const tenantId = nextTenant();
      const { env, bucket } = stdEnv();
      await run(
        auditBody(tenantId, [
          { type: 'http', destinationId: 'dest-kv1', url: 'https://example.com/a' },
        ]),
        { ...env, OBJECT_ENCRYPTION_KEY_VERSION: version }
      );
      expect([...bucket.objects.values()][0]?.customMetadata?.keyVersion).toBe('1');
    }
  );
});

describe('audit queue consumer: enqueue failures', () => {
  const failureCases: Array<{
    name: string;
    sink: Record<string, unknown>;
    env: (base: Record<string, unknown>) => Record<string, unknown>;
    error: string;
  }> = [
    {
      name: 'an unresolved urlRef',
      sink: { type: 'http', destinationId: 'd', urlRef: 'MISSING_URL_BINDING' },
      env: (base) => base,
      error: 'HTTP sink URL not resolved: MISSING_URL_BINDING',
    },
    {
      name: 'a target with neither url nor urlRef',
      sink: { type: 'http', destinationId: 'd' },
      env: (base) => base,
      error: 'HTTP sink URL not resolved: missing_url',
    },
    {
      name: 'a missing payload bucket',
      sink: { type: 'http', destinationId: 'd', url: 'https://example.com/a' },
      env: (base) => ({ ...base, SENSITIVE_DETAILS: undefined }),
      error: 'logging_delivery_payload_bucket_unavailable',
    },
    {
      name: 'a missing encryption root key',
      sink: { type: 'http', destinationId: 'd', url: 'https://example.com/a' },
      env: (base) => ({ ...base, OBJECT_ENCRYPTION_ROOT_KEY: undefined }),
      error: 'audit_archive_payload_encryption_key_unavailable',
    },
  ];

  it.each(failureCases)('retries the message for $name', async ({ sink, env, error }) => {
    const tenantId = nextTenant();
    const { env: baseEnv, critical } = stdEnv();
    const { message, logger } = await run(auditBody(tenantId, [sink]), env(baseEnv));
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(critical.send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'audit_queue_message_failed',
      expect.objectContaining({ error: `Error: ${error}` })
    );
  });

  it('records a retrying event and a critical notification when no delivery queue is bound (best effort)', async () => {
    const tenantId = nextTenant();
    const { env, adminDb } = stdEnv();
    const unbound = {
      ...env,
      LOGGING_DELIVERY_CRITICAL_QUEUE: undefined,
      LOGGING_DELIVERY_QUEUE: undefined,
    };
    const { message } = await run(
      auditBody(tenantId, [
        { type: 'http', destinationId: 'dest-nq', url: 'https://example.com/a' },
      ]),
      unbound,
      { attempts: 2 }
    );
    const tenantKey = await deriveTenantKeyFromTenantId(tenantId, undefined);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();

    const [event] = insertedDeliveryEvents(adminDb);
    expect(event).toMatchObject({
      status: 'retrying',
      errorClass: 'logging_delivery_queue_unavailable',
      attemptCount: 2,
      lane: 'critical',
    });
    expect(event?.metadata).toMatchObject({
      delivery_queue_binding: null,
      delivery_queue_fallback_used: false,
      delivery_queue_attempted_bindings: [
        'LOGGING_DELIVERY_CRITICAL_QUEUE',
        'LOGGING_DELIVERY_QUEUE',
      ],
    });
    const [notification] = insertedNotifications(adminDb);
    expect(notification).toMatchObject({
      tenantId,
      category: 'logging_delivery_failure',
      eventType: 'logging.delivery.retrying',
      severity: 'critical',
      deduplicationKey: [
        'logging_delivery',
        'retrying',
        tenantKey,
        'dest-nq',
        'audit',
        'external_sink',
        'critical',
        'logging_delivery_queue_unavailable',
      ].join(':'),
    });
    expect(notification?.payload).toMatchObject({
      tenant_key: tenantKey,
      destination_id: 'dest-nq',
      log_type: 'audit',
      plane: 'external_sink',
      lane: 'critical',
      status: 'retrying',
      attempt_count: 2,
      error_class: 'logging_delivery_queue_unavailable',
      external_notification_eligible: false,
    });
  });

  it('retries the message when no delivery queue is bound and the sink retries until ttl', async () => {
    const tenantId = nextTenant();
    const { env, adminDb } = stdEnv();
    const { message, logger } = await run(
      auditBody(
        tenantId,
        [{ type: 'http', destinationId: 'dest-nq2', url: 'https://example.com/a' }],
        {},
        { sinkFailureMode: 'retry_until_ttl' }
      ),
      { ...env, LOGGING_DELIVERY_CRITICAL_QUEUE: undefined, LOGGING_DELIVERY_QUEUE: undefined }
    );
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'audit_queue_message_failed',
      expect.objectContaining({ error: 'Error: logging_delivery_queue_unavailable' })
    );
    expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({ status: 'retrying' });
    expect(insertedNotifications(adminDb)).toHaveLength(1);
  });

  it('swallows event-store failures with a warning and still acks', async () => {
    const tenantId = nextTenant();
    const { env, critical } = stdEnv();
    const failingDb = createFakeAdminDb({
      executeResult: (sql) =>
        sql.includes('INSERT INTO logging_delivery_events') ? new Error('db down') : undefined,
    });
    const { message, logger } = await run(
      auditBody(tenantId, [
        { type: 'http', destinationId: 'dest-dbfail', url: 'https://example.com/a' },
      ]),
      { ...env, DB_ADMIN: failingDb }
    );
    expect(critical.send).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('logging_delivery_event_record_failed', {
      logType: 'audit',
      plane: 'external_sink',
      lane: 'critical',
      status: 'queued',
      error: 'Error: db down',
    });
  });

  it('enqueues without recording events when DB_ADMIN is unavailable', async () => {
    const tenantId = nextTenant();
    const { env, critical } = stdEnv();
    const { message } = await run(
      auditBody(tenantId, [
        { type: 'http', destinationId: 'dest-nodb', url: 'https://example.com/a' },
      ]),
      { ...env, DB_ADMIN: undefined }
    );
    expect(critical.send).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
  });
});

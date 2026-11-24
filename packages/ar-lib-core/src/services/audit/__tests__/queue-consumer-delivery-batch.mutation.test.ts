import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROOT_KEY,
  createEncryptedPayloadObject,
  createFakeAdminDb,
  fetchResponse,
  insertedDeliveryEvents,
  insertedNotifications,
  sqlCalls,
  type FakeAdminDb,
} from './queue-consumer-mutation-helpers';
import {
  CREATED_AT,
  NOW,
  httpBatch,
  run,
  loggedError,
  completionMetadata,
} from './queue-consumer-delivery-kit';

describe('logging delivery queue: http_sink_batch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('body object', () => {
    async function withBody(
      options: {
        contentType?: string;
        ref?: string;
        key?: string;
        bucketMissing?: boolean;
        objectMissing?: boolean;
        adminDb?: FakeAdminDb;
        deleteImpl?: () => Promise<void>;
        attempts?: number;
        extraEnv?: Record<string, unknown>;
        payloadOverrides?: Record<string, unknown>;
      } = {}
    ) {
      const key = options.key ?? 'payloads/batch.json';
      const object = await createEncryptedPayloadObject(key, 'tk_http', '{"records":[1,2]}', {
        contentType: options.contentType,
      });
      const bucket = {
        get: vi.fn().mockResolvedValue(options.objectMissing ? null : object),
        delete: vi.fn().mockImplementation(options.deleteImpl ?? (async () => undefined)),
      };
      const result = await run({
        body: httpBatch({
          body_object_ref: options.ref ?? `r2://${key}`,
          ...options.payloadOverrides,
        }),
        adminDb: options.adminDb,
        env: {
          ...(options.bucketMissing ? {} : { SENSITIVE_DETAILS: bucket }),
          OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
          ...options.extraEnv,
        },
        attempts: options.attempts,
      });
      return { ...result, bucket };
    }

    it('reads, posts and cleans up the stored body, reporting its size and ref', async () => {
      const { fetchMock, adminDb, bucket, message } = await withBody({ attempts: 2 });
      expect(bucket.get).toHaveBeenCalledWith('payloads/batch.json');
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(init.body).toBe('{"records":[1,2]}');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect((init.headers as Record<string, string>)['X-Authrim-Delivery']).toBe('qpl_http_1');
      const { params, metadata } = completionMetadata(adminDb);
      expect(params[0]).toBe(2);
      expect(metadata).toEqual({
        payload_id: 'qpl_http_1',
        batch_id: 'batch_http_1',
        record_count: 4,
        body_object_ref: 'r2://payloads/batch.json',
        byte_count: new TextEncoder().encode('{"records":[1,2]}').byteLength,
        http_status: 200,
        redacted_headers: {},
      });
      expect(bucket.delete).toHaveBeenCalledExactlyOnceWith('payloads/batch.json');
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('uses the stored content type', async () => {
      const { fetchMock } = await withBody({ contentType: 'application/x-ndjson' });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-ndjson');
    });

    it('accepts object refs without the r2:// scheme', async () => {
      const { bucket, message } = await withBody({ ref: 'payloads/batch.json' });
      expect(bucket.get).toHaveBeenCalledWith('payloads/batch.json');
      expect(bucket.delete).toHaveBeenCalledWith('payloads/batch.json');
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('builds a reference body when no object ref is present', async () => {
      const { fetchMock, adminDb, message } = await run({ body: httpBatch() });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({
        payload_type: 'http_sink_batch',
        payload_id: 'qpl_http_1',
        batch_id: 'batch_http_1',
        tenant_key: 'tk_http',
        record_count: 4,
        created_at: CREATED_AT,
      });
      const { metadata } = completionMetadata(adminDb);
      expect(metadata.body_object_ref).toBeNull();
      expect(metadata.byte_count).toBe(new TextEncoder().encode(init.body as string).byteLength);
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('fails when the payload bucket is not bound', async () => {
      const { fetchMock, logger, message, adminDb } = await withBody({ bucketMissing: true });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(loggedError(logger)).toContain('logging_delivery_payload_bucket_unavailable');
      expect(message.retry).toHaveBeenCalledOnce();
      expect(sqlCalls(adminDb, 'DELETE FROM logging_delivery_events')).toHaveLength(1);
    });

    it('fails when the payload object is missing', async () => {
      const { logger, message } = await withBody({ objectMissing: true });
      expect(loggedError(logger)).toContain('logging_delivery_payload_object_not_found');
      expect(message.retry).toHaveBeenCalledOnce();
    });

    it('keeps the object for a retrying delivery', async () => {
      const key = 'payloads/retry.json';
      const bucket = {
        get: vi.fn().mockResolvedValue(await createEncryptedPayloadObject(key, 'tk_http', '{}')),
        delete: vi.fn(),
      };
      const { message } = await run({
        body: httpBatch({ body_object_ref: key }),
        env: { SENSITIVE_DETAILS: bucket, OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY },
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(503, { 'Retry-After': '7' })),
      });
      expect(message.retry).toHaveBeenCalledOnce();
      expect(bucket.delete).not.toHaveBeenCalled();
    });

    it('cleans up the object after a permanent failure', async () => {
      const key = 'payloads/permanent.json';
      const bucket = {
        get: vi.fn().mockResolvedValue(await createEncryptedPayloadObject(key, 'tk_http', '{}')),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const { message } = await run({
        body: httpBatch({ body_object_ref: key }),
        env: { SENSITIVE_DETAILS: bucket, OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY },
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(400)),
      });
      expect(bucket.delete).toHaveBeenCalledExactlyOnceWith(key);
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('does not delete the object while a tenant backup snapshot is capturing', async () => {
      const adminDb = createFakeAdminDb({
        queryOne: (sql) => (sql.includes('tenant_backup_snapshots') ? { id: 'snap_1' } : undefined),
      });
      const { bucket, message, logger } = await withBody({ adminDb });
      expect(bucket.delete).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('only warns when deleting the delivered object fails', async () => {
      const { message, logger } = await withBody({
        deleteImpl: async () => {
          throw new Error('r2 delete failed');
        },
      });
      expect(logger.warn).toHaveBeenCalledWith('logging_delivery_payload_cleanup_failed', {
        objectRef: 'r2://payloads/batch.json',
        error: 'Error: r2 delete failed',
      });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    });
  });

  describe('encrypted payload validation', () => {
    async function readWith(
      object: Partial<{
        customMetadata: Record<string, string> | undefined;
        text: () => Promise<string>;
        size: number;
      }>,
      env: Record<string, unknown> = { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }
    ) {
      const bucket = { get: vi.fn().mockResolvedValue(object), delete: vi.fn() };
      return run({
        body: httpBatch({ body_object_ref: 'r2://payloads/x.json' }),
        env: { SENSITIVE_DETAILS: bucket, ...env },
      });
    }

    it.each([
      [
        'unencrypted payloads',
        { customMetadata: undefined, text: async () => '{}', size: 2 },
        undefined,
        'logging_delivery_payload_object_unencrypted_payload',
      ],
      [
        'objects with another encryption marker',
        { customMetadata: { encryption: 'other' }, text: async () => '{}', size: 2 },
        undefined,
        'logging_delivery_payload_object_unencrypted_payload',
      ],
      [
        'a missing root key',
        {
          customMetadata: { encryption: 'authrim-object-envelope-v1' },
          text: async () => '{}',
          size: 2,
        },
        {},
        'logging_delivery_payload_object_encryption_key_unavailable',
      ],
      [
        'a missing tenant context',
        {
          customMetadata: { encryption: 'authrim-object-envelope-v1' },
          text: async () => '{}',
          size: 2,
        },
        undefined,
        'logging_delivery_payload_object_encryption_context_missing',
      ],
      [
        'oversized objects',
        {
          customMetadata: {
            encryption: 'authrim-object-envelope-v1',
            encryptionTenantContext: 'tk_http',
          },
          text: async () => '{}',
          size: 5 * 1024 * 1024 + 1,
        },
        undefined,
        'logging_delivery_payload_object_too_large',
      ],
      [
        'envelopes from another plane',
        {
          customMetadata: {
            encryption: 'authrim-object-envelope-v1',
            encryptionTenantContext: 'tk_http',
          },
          text: async () => JSON.stringify({ plane: 'ARCHIVE' }),
          size: 20,
        },
        undefined,
        'logging_delivery_payload_object_plane_invalid',
      ],
    ])('rejects %s', async (_name, object, env, expected) => {
      const { fetchMock, message, logger } = await readWith(object, env);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(loggedError(logger)).toContain(expected);
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
    });
  });

  describe('claim and destination handling', () => {
    it('fails with claim_store_unavailable when DB_ADMIN is missing', async () => {
      const { fetchMock, logger, message } = await run({ body: httpBatch(), adminDb: null });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(loggedError(logger)).toContain('logging_delivery_claim_store_unavailable');
      expect(message.retry).toHaveBeenCalledOnce();
    });

    it('acks without posting when the claim is held elsewhere', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) =>
          sql.includes('delivery_in_progress') ? { rowsAffected: 0 } : undefined,
      });
      const { fetchMock, message } = await run({ body: httpBatch(), adminDb });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(insertedDeliveryEvents(adminDb)).toEqual([]);
    });

    it('claims with the payload identity and a 60 second lease', async () => {
      const { adminDb } = await run({ body: httpBatch(), attempts: 3 });
      const [claim] = sqlCalls(adminDb, 'delivery_in_progress').filter(([sql]) =>
        String(sql).trimStart().startsWith('INSERT')
      );
      const params = claim?.[1] as unknown[];
      expect(params[0]).toMatch(/^lde_/);
      expect(params.slice(1, 8)).toEqual([
        'tk_http',
        'dest_http',
        'operational',
        'external_sink',
        'critical',
        3,
        null,
      ]);
      expect(params[8]).toBe(NOW.getTime());
      expect(params[10]).toBe(NOW.getTime() + 60_000);
      expect(JSON.parse(params[11] as string)).toEqual({
        payload_id: 'qpl_http_1',
        batch_id: 'batch_http_1',
        record_count: 4,
        body_object_ref: null,
      });
    });

    it('treats attempts below 1 as the first attempt', async () => {
      const { adminDb } = await run({ body: httpBatch(), attempts: 0 });
      expect(completionCall(adminDb)[0]).toBe(1);
    });

    function completionCall(db: FakeAdminDb) {
      return sqlCalls(db, "SET status = 'delivered'")[0]?.[1] as unknown[];
    }

    it('delivers without credentials when the destination lookup fails', async () => {
      const adminDb = createFakeAdminDb({
        queryOne: (sql) => {
          if (sql.includes('FROM admin_destinations')) throw new Error('lookup failed');
          return undefined;
        },
      });
      const { fetchMock, message } = await run({ body: httpBatch(), adminDb });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it.each([
      ['a missing destination', null],
      ['unparsable provider config', { provider_config: 'not json', credential_ref: null }],
      ['an array provider config', { provider_config: '[1,2]', credential_ref: null }],
      ['a null provider config', { provider_config: null, credential_ref: null }],
    ])('sends unauthenticated requests for %s', async (_name, destination) => {
      const adminDb = createFakeAdminDb({ destination });
      const { fetchMock, message } = await run({ body: httpBatch(), adminDb });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
        'Content-Type',
        'X-Authrim-Delivery',
      ]);
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('rejects non-https endpoints with a specific error class', async () => {
      const { adminDb, fetchMock, message } = await run({
        body: httpBatch({ endpoint_url: 'http://collector.example/logs' }),
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'retrying',
        errorClass: 'http_sink_url_must_use_https',
      });
      expect(message.retry).toHaveBeenCalledOnce();
    });
  });

  describe('delivery outcomes', () => {
    it('preserves an emitted claim and retries when completion fails', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) =>
          sql.includes("SET status = 'delivered'") ? { rowsAffected: 0 } : undefined,
      });
      const { message, logger } = await run({ body: httpBatch(), adminDb });
      expect(sqlCalls(adminDb, 'delivery_emission_uncertain')).toHaveLength(1);
      expect(sqlCalls(adminDb, 'DELETE FROM logging_delivery_events')).toEqual([]);
      expect(loggedError(logger)).toContain('logging_delivery_claim_not_owned');
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'retrying',
        errorClass: 'http_sink_delivery_failed',
      });
      expect(message.retry).toHaveBeenCalledOnce();
    });

    it('warns when claim cleanup fails and still records the retry', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) =>
          sql.includes('DELETE FROM logging_delivery_events')
            ? new Error('cleanup down')
            : undefined,
      });
      const { message, logger } = await run({
        body: httpBatch(),
        adminDb,
        fetchImpl: vi.fn().mockRejectedValue(new Error('boom')),
      });
      expect(logger.warn).toHaveBeenCalledWith('logging_http_delivery_claim_cleanup_failed', {
        payloadId: 'qpl_http_1',
        error: 'Error: cleanup down',
      });
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({ status: 'retrying' });
      expect(message.retry).toHaveBeenCalledOnce();
    });

    it('logs preservation failures separately from delivery errors', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) => {
          if (sql.includes("SET status = 'delivered'")) return { rowsAffected: 0 };
          if (sql.includes('delivery_emission_uncertain')) return new Error('preserve down');
          return undefined;
        },
      });
      const { logger } = await run({ body: httpBatch(), adminDb });
      expect(logger.warn).toHaveBeenCalledWith('logging_http_delivery_claim_cleanup_failed', {
        payloadId: 'qpl_http_1',
        error: 'Error: preserve down',
      });
    });

    it('records the exception retry time from the attempt backoff', async () => {
      const { adminDb } = await run({
        body: httpBatch(),
        attempts: 3,
        fetchImpl: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const [event] = insertedDeliveryEvents(adminDb);
      expect(event).toMatchObject({ status: 'retrying', attemptCount: 3 });
      // attempt 3 => 4s exponential delay with at most +/-20% jitter
      expect(event?.nextRetryAt).toBeGreaterThanOrEqual(NOW.getTime() + 3200);
      expect(event?.nextRetryAt).toBeLessThanOrEqual(NOW.getTime() + 4800);
      expect(event?.metadata).toMatchObject({
        payload_id: 'qpl_http_1',
        batch_id: 'batch_http_1',
        record_count: 4,
        error: 'Error: timeout',
      });
    });

    it('retries with the Retry-After delay on 503 and notifies critical lanes', async () => {
      const { adminDb, message } = await run({
        body: httpBatch(),
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(503, { 'Retry-After': '45' })),
      });
      const [event] = insertedDeliveryEvents(adminDb);
      expect(event).toMatchObject({
        status: 'retrying',
        errorClass: 'http_status_503',
        nextRetryAt: NOW.getTime() + 45_000,
        destinationId: 'dest_http',
      });
      expect(event?.metadata).toMatchObject({ http_status: 503, redacted_headers: {} });
      const [notification] = insertedNotifications(adminDb);
      expect(notification).toMatchObject({
        tenantId: 'tk_http',
        category: 'logging_delivery_failure',
        eventType: 'logging.delivery.retrying',
        severity: 'critical',
        deduplicationKey:
          'logging_delivery:retrying:tk_http:dest_http:operational:external_sink:critical:http_status_503',
      });
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
    });

    it('does not notify for retrying deliveries on non-critical lanes', async () => {
      const { adminDb, message } = await run({
        body: httpBatch({ lane: 'default' }),
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(500, { 'Retry-After': '1' })),
      });
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'retrying',
        lane: 'default',
      });
      expect(insertedNotifications(adminDb)).toEqual([]);
      expect(message.retry).toHaveBeenCalledOnce();
    });

    it.each([
      ['critical', 'critical', true],
      ['default', 'high', false],
      ['bulk', 'medium', false],
    ])(
      'maps a permanent failure on the %s lane to %s severity',
      async (lane, severity, external) => {
        const { adminDb, message } = await run({
          body: httpBatch({ lane }),
          fetchImpl: vi.fn().mockResolvedValue(fetchResponse(404)),
        });
        expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
          status: 'failed',
          errorClass: 'http_status_404',
          nextRetryAt: null,
          lane,
        });
        const [notification] = insertedNotifications(adminDb);
        expect(notification).toMatchObject({
          eventType: 'logging.delivery.failed',
          severity,
        });
        expect(notification?.payload).toMatchObject({
          lane,
          status: 'failed',
          error_class: 'http_status_404',
          external_notification_eligible: external,
        });
        expect(message.ack).toHaveBeenCalledOnce();
        expect(message.retry).not.toHaveBeenCalled();
      }
    );

    it('does not enqueue a notification when DB_ADMIN notifications fail', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) =>
          sql.includes('INSERT INTO internal_notification_events')
            ? new Error('notify down')
            : undefined,
      });
      const { message, logger } = await run({
        body: httpBatch(),
        adminDb,
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(400)),
      });
      expect(logger.warn).toHaveBeenCalledWith('logging_delivery_notification_enqueue_failed', {
        logType: 'operational',
        plane: 'external_sink',
        lane: 'critical',
        status: 'failed',
        error: 'Error: notify down',
      });
      expect(message.ack).toHaveBeenCalledOnce();
    });
  });
});

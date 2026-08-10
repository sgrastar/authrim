import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptLogChunkBody } from '@authrim/ar-lib-logging/chunks';
import type { LogPlane, LogType } from '@authrim/ar-lib-logging/contract';
import { processAuditQueue } from '../queue-consumer';
import type { AuditQueueMessage } from '../types';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createMessage(body: AuditQueueMessage) {
  return {
    id: crypto.randomUUID(),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createAdminDbAdapter() {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function deriveArchiveChunkEncryptionKey(input: {
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  keyVersion: number;
}): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', hexToBytes(ROOT_KEY), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('authrim-log-chunk-archive-encryption'),
      info: new TextEncoder().encode(
        `${input.tenantKey}:${input.logType}:${input.plane}:v${input.keyVersion}`
      ),
    },
    material,
    256
  );
  return new Uint8Array(bits);
}

function chunkIdFromObjectKey(objectKey: string): string {
  const match = /\/(chk_[^/]+)\.jsonl(?:\.gz)?$/u.exec(objectKey);
  if (!match) {
    throw new Error('test_chunk_id_not_found');
  }
  return match[1];
}

async function decodeFirstChunkRecord(input: {
  bytes: Uint8Array;
  objectKey: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
}): Promise<Record<string, unknown>> {
  const keyVersion = 1;
  const decoded = await decryptLogChunkBody({
    storedBody: input.bytes,
    keyBytes: await deriveArchiveChunkEncryptionKey({
      tenantKey: input.tenantKey,
      logType: input.logType,
      plane: input.plane,
      keyVersion,
    }),
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    objectKey: input.objectKey,
    chunkId: chunkIdFromObjectKey(input.objectKey),
    expectedEncryptionScope: `tenant:${input.tenantKey}:${input.logType}:${input.plane}`,
    expectedKeyVersion: keyVersion,
  });
  const body =
    typeof DecompressionStream === 'undefined'
      ? decoded.body
      : new Uint8Array(
          await new Response(
            new Blob([decoded.body]).stream().pipeThrough(new DecompressionStream('gzip'))
          ).arrayBuffer()
        );
  return JSON.parse(new TextDecoder().decode(body).split('\n')[0]) as Record<string, unknown>;
}

describe('audit queue consumer fanout', () => {
  const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => {
    consoleLogSpy.mockClear();
    vi.unstubAllGlobals();
  });

  it('writes archive fanout to R2 and emits logpush structured logs', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
    const coreDb = {
      ...createAdminDbAdapter(),
      queryOne: vi.fn().mockResolvedValue({ tenant_key: 't_registry_archive' }),
    };
    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-registry-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-registry-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          detailsJson: JSON.stringify({ requestHeaders: { authorization: 'Bearer secret' } }),
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-1',
        archives: [{ type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'audit/' }],
        sinks: [{ type: 'logpush', destinationRef: 'workers-logpush', dataset: 'authrim_audit' }],
        archiveFailureMode: 'gate_cleanup',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: coreDb,
        DB_PII: {} as D1Database,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(bucket.put).toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
    const archiveKey = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(archiveKey).toContain('.jsonl.gz');
    expect(archiveKey).toContain('/t_registry_archive/');
    expect(archiveKey).not.toContain('/tenant-registry-a/');
    const archiveBody = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    const archiveRecord = await decodeFirstChunkRecord({
      bytes: archiveBody as Uint8Array,
      objectKey: archiveKey,
      tenantKey: 't_registry_archive',
      logType: 'audit',
      plane: 'archive',
    });
    expect(archiveRecord).toMatchObject({
      schema_version: 'authrim.log.archive.v1',
      record_type: 'log_record',
      tenant_key: 't_registry_archive',
      log_type: 'audit',
      plane: 'archive',
      summary: {
        audit_record_schema: 'authrim.audit.v1',
        audit_log_type: 'event_log',
        has_inline_detail: true,
      },
    });
    expect(JSON.stringify(archiveRecord)).not.toContain('Bearer secret');
    expect(JSON.stringify(archiveRecord)).not.toContain('detailsJson');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('"schema":"authrim.audit.v1"')
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('encrypts audit archive chunks when object encryption root key is configured', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
    const coreDb = {
      ...createAdminDbAdapter(),
      queryOne: vi.fn().mockResolvedValue({ tenant_key: 't_registry_archive' }),
    };
    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-registry-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-encrypted',
          tenantId: 'tenant-registry-a',
          eventType: 'admin.destination.updated',
          eventCategory: 'admin',
          result: 'success',
          severity: 'critical',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-1',
        archives: [{ type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'audit/' }],
        sinks: [],
        archiveFailureMode: 'gate_cleanup',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: coreDb,
        DB_PII: {} as D1Database,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
        OBJECT_ENCRYPTION_KEY_VERSION: '2',
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    const [, storedBody, options] = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const bodyText = new TextDecoder().decode(storedBody as Uint8Array);
    expect(bodyText).toContain('"algorithm":"AES-256-GCM"');
    expect(bodyText).toContain('"encryptionScope":"tenant:t_registry_archive:audit:archive"');
    expect(bodyText).not.toContain('evt-encrypted');
    expect(options).toEqual(
      expect.objectContaining({
        httpMetadata: { contentType: 'application/authrim.log-chunk+encrypted' },
        customMetadata: expect.objectContaining({
          encryptionScope: 'tenant:t_registry_archive:audit:archive',
          keyVersion: '2',
        }),
      })
    );
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('retries when required archive delivery cannot resolve its target binding', async () => {
    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-1',
        archives: [{ type: 'r2', bucketRef: 'MISSING_BUCKET', prefix: 'audit/' }],
        sinks: [],
        archiveFailureMode: 'gate_cleanup',
        sinkFailureMode: 'best_effort',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('delivers generic HTTP sinks through fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);

    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            url: 'https://example.com/audit',
            headers: { 'X-Authrim-Sink': 'enabled' },
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/audit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Authrim-Sink': 'enabled',
        }),
        body: expect.stringContaining('"recordType":"audit_batch"'),
      })
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('adds resolved bearer credentials for generic HTTP sinks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
    });
    vi.stubGlobal('fetch', fetchMock);

    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            url: 'https://example.com/audit',
            authTokenRef: 'AUDIT_HTTP_TOKEN',
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        AUDIT_HTTP_TOKEN: 'sink-secret',
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/audit',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sink-secret',
        }),
      })
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('records delivery events for generic HTTP sink batches', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);
    const adminDb = createAdminDbAdapter();

    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            url: 'https://example.com/audit',
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['audit', 'external_sink', 'critical', 'delivered'])
    );
    const params = adminDb.execute.mock.calls[0]?.[1] as unknown[];
    expect(params[13]).toContain('"http_status":200');
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('enqueues committed archive chunks for explicit admin destinations', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
    const deliveryQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-archive',
        archives: [
          {
            type: 'r2',
            destinationId: 'dest_archive_r2',
            bucketRef: 'AUDIT_ARCHIVE',
            prefix: 'audit/',
          },
        ],
        sinks: [],
        archiveFailureMode: 'gate_cleanup',
        sinkFailureMode: 'best_effort',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
        LOGGING_DELIVERY_QUEUE: deliveryQueue,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(deliveryQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'delivery_fanout',
        schema_version: 1,
        tenant_key: expect.stringMatching(/^t_/),
        destination_id: 'dest_archive_r2',
        log_type: 'audit',
        plane: 'archive',
        record_count: 1,
      })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['dest_archive_r2', 'audit', 'archive', 'critical', 'queued'])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('queues explicit HTTP admin destinations through the logging delivery worker', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const payloadBucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
    const deliveryQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            destinationId: 'dest_http_1',
            url: 'https://collector.example/audit',
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: payloadBucket,
        LOGGING_DELIVERY_QUEUE: deliveryQueue,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(payloadBucket.put).toHaveBeenCalledWith(
      expect.stringContaining('logging-delivery-payloads/v1/'),
      expect.stringContaining('"recordType":"audit_batch"'),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
    const payloadObjectKey = (payloadBucket.put as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(payloadObjectKey).toMatch(
      /^logging-delivery-payloads\/v1\/t_[^/]+\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/qpl_[^/]+\.json$/
    );
    expect(payloadObjectKey).not.toContain('[object Object]');
    expect(deliveryQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'http_sink_batch',
        schema_version: 1,
        destination_id: 'dest_http_1',
        endpoint_url: 'https://collector.example/audit',
        tenant_key: expect.stringMatching(/^t_/),
        lane: 'critical',
        record_count: 1,
        body_object_ref: expect.stringMatching(/^r2:\/\/logging-delivery-payloads\/v1\//),
      })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['dest_http_1', 'audit', 'external_sink', 'critical', 'queued'])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries explicit HTTP admin destinations when no delivery queue is bound', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const payloadBucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    let notificationLookupCount = 0;
    adminDb.queryOne.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('internal_notification_events')) {
        notificationLookupCount += 1;
        if (notificationLookupCount === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: 'notification-queue-unavailable',
          tenant_id: 'tenant-a',
          category: 'logging_delivery_failure',
          event_type: 'logging.delivery.retrying',
          severity: 'critical',
          status: 'pending',
          deduplication_key: params[0] ?? null,
          payload_json: '{}',
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          delivered_at: null,
        });
      }
      return Promise.resolve(null);
    });
    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            destinationId: 'dest_http_1',
            url: 'https://collector.example/audit',
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: payloadBucket,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(payloadBucket.put).toHaveBeenCalledOnce();
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['dest_http_1', 'audit', 'external_sink', 'critical', 'retrying'])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining(['tenant-a', 'logging_delivery_failure', 'logging.delivery.retrying'])
    );
    const notificationInsert = adminDb.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO internal_notification_events')
    );
    const notificationPayload = JSON.parse(String((notificationInsert?.[1] as unknown[])[6]));
    expect(notificationPayload.notification_routing_policy).toEqual({
      providers: ['internal_event'],
      failurePolicy: 'best_effort',
      policyScope: 'deployment',
      allowProviderSuppression: false,
    });
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('retries generic HTTP sinks when configured credentials cannot be resolved', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            url: 'https://example.com/audit',
            authTokenRef: 'MISSING_AUDIT_HTTP_TOKEN',
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('enqueues an internal notification for critical HTTP sink retry conditions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const adminDb = createAdminDbAdapter();
    let notificationLookupCount = 0;
    adminDb.queryOne.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('internal_notification_events')) {
        notificationLookupCount += 1;
        if (notificationLookupCount === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: 'notification-1',
          tenant_id: 'tenant-a',
          category: 'logging_delivery_failure',
          event_type: 'logging.delivery.retrying',
          severity: 'critical',
          status: 'pending',
          deduplication_key: params[0] ?? null,
          payload_json: '{}',
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          delivered_at: null,
        });
      }
      return Promise.resolve(null);
    });

    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            urlRef: 'AUDIT_HTTP_URL',
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_HTTP_URL: 'https://example.com/audit',
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining([
        'http:AUDIT_HTTP_URL',
        'audit',
        'external_sink',
        'critical',
        'retrying',
      ])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining(['tenant-a', 'logging_delivery_failure', 'logging.delivery.retrying'])
    );
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('retries generic HTTP sinks with non-https URLs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const message = createMessage({
      type: 'event_log',
      tenantId: 'tenant-a',
      timestamp: Date.now(),
      entries: [
        {
          id: 'evt-1',
          tenantId: 'tenant-a',
          eventType: 'auth.login',
          eventCategory: 'auth',
          result: 'success',
          severity: 'info',
          createdAt: Date.now(),
        },
      ],
      fanout: {
        auditProfileId: 'audit-profile-http',
        archives: [],
        sinks: [
          {
            type: 'http',
            url: 'http://example.com/audit',
          },
        ],
        archiveFailureMode: 'best_effort',
        sinkFailureMode: 'retry_until_ttl',
      },
    });

    await processAuditQueue(
      { messages: [message], queue: 'AUDIT_QUEUE' } as unknown as MessageBatch<AuditQueueMessage>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
      } as unknown as Parameters<typeof processAuditQueue>[1]
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});

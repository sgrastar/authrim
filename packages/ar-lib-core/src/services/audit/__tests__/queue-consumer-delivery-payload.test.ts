import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processLoggingDeliveryQueue } from '../queue-consumer';
import { decodeStoredLogChunkRecord, writeLogChunkToR2 } from '@authrim/ar-lib-logging/chunks';
import { decryptObjectArtifact, encryptObjectArtifact } from '../../object-artifact-crypto';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

async function createEncryptedArchivePayloadObject(
  objectKey: string,
  tenantContext: string,
  payload: unknown
): Promise<R2ObjectBody> {
  const envelope = await encryptObjectArtifact(JSON.stringify(payload), {
    rootKeyHex: ROOT_KEY,
    plane: 'AUDIT_ARCHIVE',
    keyVersion: 1,
    contentType: 'application/json',
    context: {
      tenantId: tenantContext,
      objectKey,
      objectClass: 'operational_log_detail',
    },
  });
  const stored = JSON.stringify(envelope);
  return {
    size: new TextEncoder().encode(stored).byteLength,
    customMetadata: {
      encryption: 'authrim-object-envelope-v1',
      encryptionTenantContext: tenantContext,
      keyVersion: '1',
    },
    text: vi.fn().mockResolvedValue(stored),
  } as unknown as R2ObjectBody;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function deriveArchiveChunkEncryptionKey(input: {
  rootKeyHex: string;
  tenantKey: string;
  logType: string;
  plane: string;
  keyVersion: number;
}): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    hexToBytes(input.rootKeyHex),
    'HKDF',
    false,
    ['deriveBits']
  );
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

function createMessage(body: unknown) {
  return {
    id: crypto.randomUUID(),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createAdminDbAdapter(
  options: { destination?: Record<string, unknown>; dlqItem?: Record<string, unknown> } = {}
) {
  let notificationLookupCount = 0;
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM admin_destinations')) {
        return Promise.resolve({
          id: params[0] ?? 'dest_1',
          provider: 'http',
          lifecycle_status: 'active',
          provider_config: JSON.stringify({ url: 'https://collector.example/chunks' }),
          credential_ref: null,
          credential_version: null,
          ...options.destination,
        });
      }
      if (sql.includes('FROM logging_dlq_items')) {
        return Promise.resolve({
          id: params[0] ?? 'dlq_1',
          tenant_key: 'tk_123',
          payload_type: 'audit_queue_message',
          schema_version: 1,
          lane: 'critical',
          destination_id: 'queue:AUDIT_DLQ',
          payload_object_ref: 'dlq/tenant_key=tk_123/item.json',
          status: 'open',
          ...options.dlqItem,
        });
      }
      if (sql.includes('internal_notification_events')) {
        notificationLookupCount += 1;
        if (notificationLookupCount === 1) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: 'notification-1',
          tenant_id: 'tk_123',
          category: 'logging_dlq_backlog',
          event_type: 'logging.delivery.dlq',
          severity: 'medium',
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
    }),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function createSensitiveDetailChunkWriteRecord(input: {
  catalogId: string;
  index: number;
  tenantId?: string;
  objectClass?: string;
  surface?: string;
  eventAt: number;
  indexDbBinding?: 'DB' | 'DB_ADMIN' | 'LOGGING_INDEX_DB';
}) {
  const tenantId = input.tenantId ?? 'tenant-a';
  const objectClass = input.objectClass ?? 'webhook_delivery_payload';
  const pendingObjectKey = `pending-sensitive-detail:${input.catalogId}`;
  const envelope = await encryptObjectArtifact(
    JSON.stringify({ metadata: { index: input.index, ok: true } }),
    {
      rootKeyHex: ROOT_KEY,
      plane: 'SENSITIVE_DETAILS',
      keyVersion: 1,
      contentType: 'application/json',
      context: {
        tenantId,
        objectKey: pendingObjectKey,
        objectClass,
      },
    }
  );
  return {
    id: input.catalogId,
    catalog_id: input.catalogId,
    public_artifact_id: `oa_${input.index}`,
    tenant_id: tenantId,
    object_class: objectClass,
    surface: input.surface ?? 'webhook',
    content_type: 'application/json',
    payload_envelope_json: JSON.stringify(envelope),
    pending_object_key: pendingObjectKey,
    key_version: 1,
    event_at: input.eventAt,
    index_db_binding: input.indexDbBinding ?? 'DB',
  };
}

describe('logging delivery queue consumer', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes chunk_write payload records to R2 and commits catalog rows', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: 'qpl_chunk_1',
      tenant_key: 'tk_chunk',
      lane: 'default',
      created_at: 1779148800000,
      log_type: 'operational',
      plane: 'archive',
      records: [
        {
          id: 'evt_chunk_1',
          event_at: 1779148800000,
          payload: { operation: 'job.run', status: 'ok' },
          indexed_fields: { operation: 'job.run', status: 'ok' },
        },
      ],
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringContaining('logs/v1/tk_chunk/archive/operational/'),
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: expect.objectContaining({
          contentType: 'application/authrim.log-chunk+encrypted',
        }),
      })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO log_object_catalog'),
      expect.arrayContaining(['tk_chunk', 'operational', 'archive'])
    );
    expect(adminDb.batch).toHaveBeenCalledWith([
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO log_chunk_record_index'),
        params: expect.arrayContaining(['evt_chunk_1', 'tk_chunk', 'operational', 'archive']),
      }),
    ]);
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_delivery_event_aggregates'),
      expect.arrayContaining([
        'tk_chunk',
        'chunk_writer',
        'operational',
        'archive',
        'default',
        'delivered',
      ])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('loads chunk_write records from an R2 object reference before writing chunks', async () => {
    const objectKey = 'payloads/chunk-records.json';
    const bucket = {
      get: vi.fn().mockResolvedValue(
        await createEncryptedArchivePayloadObject(objectKey, 'tk_chunk_ref', {
          records: [
            {
              id: 'evt_chunk_ref_1',
              eventAt: 1779148800000,
              payload: { operation: 'bulk.flush', status: 'ok' },
              indexedFields: { operation: 'bulk.flush' },
            },
          ],
        })
      ),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: 'qpl_chunk_ref_1',
      tenant_key: 'tk_chunk_ref',
      lane: 'bulk',
      created_at: 1779148800000,
      log_type: 'operational',
      plane: 'archive',
      records: [],
      records_object_ref: `r2://${objectKey}`,
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(bucket.get).toHaveBeenCalledWith('payloads/chunk-records.json');
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringContaining('logs/v1/tk_chunk_ref/archive/operational/'),
      expect.any(Uint8Array),
      expect.any(Object)
    );
    expect(adminDb.batch).toHaveBeenCalledWith([
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO log_chunk_record_index'),
        params: expect.arrayContaining(['evt_chunk_ref_1', 'tk_chunk_ref', 'operational']),
      }),
    ]);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('rejects plaintext R2 payload references instead of using the removed legacy format', async () => {
    const bucket = {
      get: vi.fn().mockResolvedValue({
        size: 14,
        text: vi.fn().mockResolvedValue('{"records":[]}'),
      }),
      put: vi.fn(),
    } as unknown as R2Bucket;
    const message = createMessage({
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: 'qpl_plaintext_ref',
      tenant_key: 'tk_plaintext_ref',
      lane: 'bulk',
      created_at: 1779148800000,
      log_type: 'operational',
      plane: 'archive',
      records: [],
      records_object_ref: 'r2://payloads/plaintext.json',
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: createAdminDbAdapter(),
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(bucket.put).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('rejects oversized chunk_write record objects before reading R2 text', async () => {
    const text = vi.fn().mockResolvedValue('[]');
    const bucket = {
      get: vi.fn().mockResolvedValue({
        size: 6 * 1024 * 1024,
        text,
      }),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: 'qpl_chunk_ref_large',
      tenant_key: 'tk_chunk_ref',
      lane: 'bulk',
      created_at: 1779148800000,
      log_type: 'operational',
      plane: 'archive',
      records: [],
      records_object_ref: 'r2://payloads/chunk-records-large.json',
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(text).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('batches sensitive detail chunk_write messages into one R2 object and writes lookup indexes', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const coreDb = createAdminDbAdapter();
    const adminDb = createAdminDbAdapter();
    const createdAt = 1779148800000;
    const records = await Promise.all(
      ['catalog-sensitive-1', 'catalog-sensitive-2'].map((catalogId, index) =>
        createSensitiveDetailChunkWriteRecord({
          catalogId,
          index,
          eventAt: createdAt + index,
        })
      )
    );
    const messages = records.map((record, index) =>
      createMessage({
        payload_type: 'chunk_write',
        schema_version: 1,
        payload_id: `qpl_sensitive_${index}`,
        tenant_key: 't_sensitive',
        lane: 'critical',
        created_at: createdAt + index,
        log_type: 'webhook',
        plane: 'sensitive_detail',
        surface: 'webhook',
        records: [record],
      })
    );

    await processLoggingDeliveryQueue(
      { messages, queue: 'LOGGING_DELIVERY_CRITICAL_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: coreDb as never,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        SENSITIVE_DETAILS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringContaining('sensitive-details/v1/t_sensitive/sensitive_detail/webhook/webhook/'),
      expect.any(Uint8Array),
      expect.objectContaining({
        customMetadata: expect.objectContaining({
          tenantKey: 't_sensitive',
          logType: 'webhook',
          plane: 'sensitive_detail',
          recordCount: '2',
        }),
      })
    );
    const batchStatements = coreDb.batch.mock.calls.flatMap((call) => call[0]);
    expect(
      batchStatements.filter((statement) =>
        statement.sql.includes('INSERT INTO sensitive_detail_chunk_index')
      )
    ).toHaveLength(2);
    expect(
      batchStatements.filter(
        (statement) =>
          statement.sql.includes('byte_offset') && statement.sql.includes('byte_length')
      )
    ).toHaveLength(2);
    expect(
      batchStatements.filter((statement) =>
        statement.sql.includes('INSERT INTO object_catalog_objects')
      )
    ).toHaveLength(2);
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it('sanitizes tenant key and surface segments in sensitive detail chunk object keys', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const coreDb = createAdminDbAdapter();
    const adminDb = createAdminDbAdapter();
    const createdAt = 1779148800000;
    const record = await createSensitiveDetailChunkWriteRecord({
      catalogId: 'catalog-sensitive-unsafe-key',
      index: 0,
      eventAt: createdAt,
      surface: '../webhook/raw',
    });
    const message = createMessage({
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: 'qpl_sensitive_unsafe',
      tenant_key: 'tenant/../../raw',
      lane: 'critical',
      created_at: createdAt,
      log_type: 'webhook',
      plane: 'sensitive_detail',
      surface: '../webhook/raw',
      records: [record],
    });

    await processLoggingDeliveryQueue(
      {
        messages: [message],
        queue: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      } as unknown as MessageBatch<unknown>,
      {
        DB: coreDb as never,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        SENSITIVE_DETAILS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    const objectKey = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(objectKey).toContain(
      'sensitive-details/v1/tenant_.._.._raw/sensitive_detail/.._webhook_raw/webhook/'
    );
    expect(objectKey).not.toContain('../');
    expect(objectKey).not.toContain('/raw/sensitive_detail/../');
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('uses LOGGING_INDEX_DB for tenant-local sensitive detail indexes when available', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const coreDb = createAdminDbAdapter();
    const logIndexDb = createAdminDbAdapter();
    const adminDb = createAdminDbAdapter();
    const createdAt = 1779148800000;
    const record = await createSensitiveDetailChunkWriteRecord({
      catalogId: 'catalog-sensitive-index-db',
      index: 0,
      eventAt: createdAt,
      indexDbBinding: 'LOGGING_INDEX_DB',
    });
    const message = createMessage({
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: 'qpl_sensitive_index_db',
      tenant_key: 't_sensitive',
      lane: 'critical',
      created_at: createdAt,
      log_type: 'webhook',
      plane: 'sensitive_detail',
      surface: 'webhook',
      records: [record],
    });

    await processLoggingDeliveryQueue(
      {
        messages: [message],
        queue: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      } as unknown as MessageBatch<unknown>,
      {
        DB: coreDb as never,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        LOGGING_INDEX_DB: logIndexDb as never,
        SENSITIVE_DETAILS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(logIndexDb.batch).toHaveBeenCalledOnce();
    expect(coreDb.batch).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('does not fall back to DB when a requested LOGGING_INDEX_DB binding is missing', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const coreDb = createAdminDbAdapter();
    const adminDb = createAdminDbAdapter();
    const createdAt = 1779148800000;
    const record = await createSensitiveDetailChunkWriteRecord({
      catalogId: 'catalog-sensitive-index-db-missing',
      index: 0,
      eventAt: createdAt,
      indexDbBinding: 'LOGGING_INDEX_DB',
    });
    const message = createMessage({
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: 'qpl_sensitive_index_db_missing',
      tenant_key: 't_sensitive',
      lane: 'critical',
      created_at: createdAt,
      log_type: 'webhook',
      plane: 'sensitive_detail',
      surface: 'webhook',
      records: [record],
    });

    await expect(
      processLoggingDeliveryQueue(
        {
          messages: [message],
          queue: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
        } as unknown as MessageBatch<unknown>,
        {
          DB: coreDb as never,
          DB_PII: {} as D1Database,
          DB_ADMIN: adminDb,
          SENSITIVE_DETAILS: bucket,
          OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
        }
      )
    ).rejects.toThrow('sensitive_detail_logging_index_db_unavailable');

    expect(coreDb.batch).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('splits sensitive detail chunks by critical flush interval', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const coreDb = createAdminDbAdapter();
    const adminDb = createAdminDbAdapter();
    const createdAt = 1779148800000;
    const records = await Promise.all([
      createSensitiveDetailChunkWriteRecord({
        catalogId: 'catalog-sensitive-window-1',
        index: 0,
        eventAt: createdAt,
      }),
      createSensitiveDetailChunkWriteRecord({
        catalogId: 'catalog-sensitive-window-2',
        index: 1,
        eventAt: createdAt + 61_000,
      }),
    ]);
    const messages = records.map((record, index) =>
      createMessage({
        payload_type: 'chunk_write',
        schema_version: 1,
        payload_id: `qpl_sensitive_window_${index}`,
        tenant_key: 't_sensitive',
        lane: 'critical',
        created_at: record.event_at,
        log_type: 'webhook',
        plane: 'sensitive_detail',
        surface: 'webhook',
        records: [record],
      })
    );

    await processLoggingDeliveryQueue(
      { messages, queue: 'LOGGING_DELIVERY_CRITICAL_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: coreDb as never,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        SENSITIVE_DETAILS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(bucket.put).toHaveBeenCalledTimes(2);
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it('delivers supported HTTP sink batch payloads and records delivery metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 202,
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const bucket = {
      get: vi.fn().mockResolvedValue(
        await createEncryptedArchivePayloadObject('payloads/batch_1.json', 'tk_123', {
          records: [{ id: 'evt_1' }],
        })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs',
      log_type: 'operational',
      plane: 'external_sink',
      batch_id: 'batch_1',
      record_count: 1,
      body_object_ref: 'r2://payloads/batch_1.json',
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(bucket.get).toHaveBeenCalledWith('payloads/batch_1.json');
    expect(bucket.delete).toHaveBeenCalledWith('payloads/batch_1.json');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://collector.example/logs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
        body: '{"records":[{"id":"evt_1"}]}',
      })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining([
        'tk_123',
        'dest_1',
        'operational',
        'external_sink',
        'critical',
        'delivered',
      ])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('rejects oversized HTTP sink body objects before reading R2 text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 202,
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const text = vi.fn().mockResolvedValue('{}');
    const bucket = {
      get: vi.fn().mockResolvedValue({
        size: 6 * 1024 * 1024,
        text,
      }),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_body_large',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs',
      log_type: 'operational',
      plane: 'external_sink',
      batch_id: 'batch_large',
      record_count: 1,
      body_object_ref: 'r2://payloads/batch_large.json',
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
      }
    );

    expect(text).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('resolves runtime destination credentials for HTTP sink batches', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const adminDb = createAdminDbAdapter({
      destination: {
        provider_config: JSON.stringify({
          url: 'https://collector.example/logs',
          authProfile: 'bearer',
        }),
        credential_ref: 'cfsecret://env/LOGGING_HTTP_TOKEN#v1',
        credential_version: 1,
      },
    });
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_credential_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs',
      log_type: 'operational',
      plane: 'external_sink',
      batch_id: 'batch_credential',
      record_count: 1,
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        LOGGING_HTTP_TOKEN: 'runtime-token',
      } as never
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://collector.example/logs',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer runtime-token',
        }),
      })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['delivered'])
    );
    expect(JSON.stringify(adminDb.execute.mock.calls)).not.toContain('runtime-token');
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('resolves runtime HMAC credentials for HTTP sink batches without persisting secrets', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const adminDb = createAdminDbAdapter({
      destination: {
        provider_config: JSON.stringify({
          url: 'https://collector.example/logs?tenant=tk_123',
          authProfile: 'hmac',
          hmacProfile: {
            name: 'authrim',
            signatureHeader: 'X-Authrim-Signature-256',
            timestampHeader: 'X-Authrim-Timestamp',
            deliveryIdHeader: 'X-Authrim-Delivery',
          },
        }),
        credential_ref: 'cfsecret://env/LOGGING_HMAC_SECRET#v1',
        credential_version: 1,
      },
    });
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_hmac_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs?tenant=tk_123',
      log_type: 'operational',
      plane: 'external_sink',
      batch_id: 'batch_hmac',
      record_count: 1,
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        LOGGING_HMAC_SECRET: JSON.stringify({ secret: 'runtime-hmac-secret' }),
      } as never
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://collector.example/logs?tenant=tk_123',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Authrim-Delivery': 'qpl_hmac_1',
          'X-Authrim-Signature-256': expect.stringMatching(/^sha256=/),
          'X-Authrim-Signature-Version': 'v1',
          'X-Authrim-Timestamp': expect.any(String),
        }),
      })
    );
    expect(JSON.stringify(adminDb.execute.mock.calls)).not.toContain('runtime-hmac-secret');
    const eventInsert = adminDb.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO logging_delivery_events')
    );
    const metadata = JSON.parse((eventInsert?.[1] as unknown[])[13] as string) as {
      redacted_headers: Record<string, string>;
    };
    expect(metadata.redacted_headers['X-Authrim-Signature-256']).toBe('[redacted]');
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('uses destination HTTP sink header profiles for runtime HMAC delivery', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const adminDb = createAdminDbAdapter({
      destination: {
        provider_config: JSON.stringify({
          url: 'https://collector.example/logs',
          authProfile: 'hmac',
          headerProfile: 'webhook_legacy',
          timestampFormat: 'iso8601',
        }),
        credential_ref: 'cfsecret://env/LOGGING_HMAC_SECRET#v1',
        credential_version: 1,
      },
    });
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_webhook_legacy_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs',
      log_type: 'operational',
      plane: 'external_sink',
      batch_id: 'batch_webhook_legacy',
      record_count: 1,
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        LOGGING_HMAC_SECRET: 'runtime-hmac-secret',
      } as never
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://collector.example/logs',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Webhook-Delivery': 'qpl_webhook_legacy_1',
          'X-Webhook-Signature': expect.stringMatching(/^sha256=/),
          'X-Webhook-Timestamp': expect.stringMatching(/T/),
        }),
      })
    );
    const eventInsert = adminDb.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO logging_delivery_events')
    );
    const metadata = JSON.parse((eventInsert?.[1] as unknown[])[13] as string) as {
      redacted_headers: Record<string, string>;
    };
    expect(metadata.redacted_headers['X-Webhook-Signature']).toBe('[redacted]');
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('delivers supported delivery fanout payloads as HTTP chunk references', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: vi.fn().mockReturnValue(null) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'delivery_fanout',
      schema_version: 1,
      payload_id: 'qpl_chunk_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      catalog_id: 'chk_1',
      object_key: 'logs/tk_123/archive/audit/chunk.jsonl',
      destination_id: 'dest_1',
      log_type: 'audit',
      plane: 'external_sink',
      record_count: 10,
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
      }
    );

    expect(adminDb.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM admin_destinations'),
      ['dest_1']
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://collector.example/chunks',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"object_key":"logs/tk_123/archive/audit/chunk.jsonl"'),
      })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining([
        'tk_123',
        'dest_1',
        'audit',
        'external_sink',
        'critical',
        'delivered',
        1,
        null,
        'chk_1',
      ])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acknowledges legacy platform-default R2 fanout without destination lookup or notification', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected HTTP delivery'));
    vi.stubGlobal('fetch', fetchMock);
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'delivery_fanout',
      schema_version: 1,
      payload_id: 'qpl_platform_default_legacy',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      catalog_id: 'obj_platform_default_1',
      object_key: 'logs/v1/tk_123/archive/admin_audit/chunk.jsonl.gz',
      destination_id: 'platform_default_r2_archive',
      log_type: 'admin_audit',
      plane: 'archive',
      record_count: 1,
    });

    await processLoggingDeliveryQueue(
      {
        messages: [message],
        queue: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
      }
    );

    expect(adminDb.queryOne).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM admin_destinations'),
      expect.anything()
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining([
        'tk_123',
        'platform_default_r2_archive',
        'admin_audit',
        'archive',
        'critical',
        'delivered',
      ])
    );
    expect(
      adminDb.execute.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO internal_notification_events')
      )
    ).toBe(false);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries supported HTTP sink batch payloads on retryable status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 503,
      headers: { get: vi.fn().mockReturnValue('5') },
    });
    vi.stubGlobal('fetch', fetchMock);
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_2',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs',
      log_type: 'operational',
      plane: 'external_sink',
      batch_id: 'batch_2',
      record_count: 1,
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
      }
    );

    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining([
        'tk_123',
        'dest_1',
        'operational',
        'external_sink',
        'critical',
        'retrying',
      ])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining(['tk_123', 'logging_delivery_failure', 'logging.delivery.retrying'])
    );
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('records next retry time for transient HTTP sink delivery exceptions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network timeout')));
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_2',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs',
      log_type: 'operational',
      plane: 'external_sink',
      batch_id: 'batch_2',
      record_count: 1,
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
      }
    );

    const eventCall = adminDb.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO logging_delivery_events')
    );
    expect(eventCall?.[1]).toEqual(
      expect.arrayContaining([
        'tk_123',
        'dest_1',
        'operational',
        'external_sink',
        'critical',
        'retrying',
        1,
        'http_sink_delivery_failed',
        expect.any(Number),
      ])
    );
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('replays supported DLQ replay payloads to the audit queue', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const bucket = {
      get: vi.fn().mockResolvedValue(
        await createEncryptedArchivePayloadObject('dlq/tenant_key=tk_123/item.json', 'tk_123', {
          body: {
            type: 'event_log',
            tenantId: 'tenant-a',
            timestamp: 1779148800000,
            entries: [],
          },
        })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'dlq_replay',
      schema_version: 1,
      payload_id: 'qpl_replay_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      dlq_item_id: 'dlq_1',
      requested_by: 'admin-1',
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        AUDIT_QUEUE: { send } as never,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(bucket.get).toHaveBeenCalledWith('dlq/tenant_key=tk_123/item.json');
    expect(bucket.delete).toHaveBeenCalledWith('dlq/tenant_key=tk_123/item.json');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event_log',
        tenantId: 'tenant-a',
      })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'replayed'"),
      expect.arrayContaining(['dlq_1'])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('rejects oversized DLQ replay payload objects before reading R2 text', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const text = vi.fn().mockResolvedValue('{}');
    const bucket = {
      get: vi.fn().mockResolvedValue({
        size: 6 * 1024 * 1024,
        text,
      }),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'dlq_replay',
      schema_version: 1,
      payload_id: 'qpl_replay_large',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      dlq_item_id: 'dlq_1',
      requested_by: 'admin-1',
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        AUDIT_QUEUE: { send } as never,
      }
    );

    expect(text).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('replays logging delivery DLQ payloads to the lane delivery queue', async () => {
    const deliverySend = vi.fn().mockResolvedValue(undefined);
    const replayBody = {
      payload_type: 'http_sink_batch',
      schema_version: 99,
      payload_id: 'qpl_old_schema_1',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
      destination_id: 'dest_1',
    };
    const bucket = {
      get: vi.fn().mockResolvedValue(
        await createEncryptedArchivePayloadObject('dlq/tenant_key=tk_123/item.json', 'tk_123', {
          body: replayBody,
        })
      ),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter({
      dlqItem: {
        payload_type: 'http_sink_batch',
        schema_version: 99,
        lane: 'default',
        destination_id: 'queue:LOGGING_DELIVERY',
      },
    });
    const message = createMessage({
      payload_type: 'dlq_replay',
      schema_version: 1,
      payload_id: 'qpl_replay_delivery_1',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
      dlq_item_id: 'dlq_1',
      requested_by: 'admin-1',
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        AUDIT_QUEUE: { send: vi.fn() } as never,
        LOGGING_DELIVERY_QUEUE: { send: deliverySend } as never,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    expect(deliverySend).toHaveBeenCalledWith(replayBody);
    expect(bucket.delete).toHaveBeenCalledWith('dlq/tenant_key=tk_123/item.json');
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'replayed'"),
      expect.arrayContaining(['dlq_1'])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('rewraps encrypted archive chunks through the delivery queue without exposing payloads', async () => {
    const rootKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const tenantKey = 'tk_123';
    const encryptionScope = `tenant:${tenantKey}:audit:archive`;
    const payload = { id: 'evt_rewrap_1', eventType: 'auth.login', result: 'success' };
    let storedBody: Uint8Array | undefined;
    let rewrappedBody: Uint8Array | undefined;
    const indexRows: Array<Record<string, unknown>> = [];
    const chunkResult = await writeLogChunkToR2({
      bucket: {
        put: vi.fn(async (_key: string, body: Uint8Array) => {
          storedBody = body;
        }),
      } as unknown as R2Bucket,
      tenantKey,
      logType: 'audit',
      plane: 'archive',
      records: [{ id: 'evt_rewrap_1', eventAt: 1779148800000, payload }],
      compression: 'none',
      now: 1779148800000,
      encryption: {
        keyBytes: await deriveArchiveChunkEncryptionKey({
          rootKeyHex,
          tenantKey,
          logType: 'audit',
          plane: 'archive',
          keyVersion: 1,
        }),
        encryptionScope,
        keyVersion: 1,
      },
      catalogStore: {
        createPendingObject: vi.fn(),
        createPendingRecordIndexes: vi.fn(async (rows) => {
          indexRows.push(...(rows as unknown as Array<Record<string, unknown>>));
        }),
        commitObject: vi.fn(),
        commitRecordIndexes: vi.fn(),
        markObjectOrphanCandidate: vi.fn(),
      },
    });
    const recordIndex = indexRows[0]!;
    const bucket = {
      get: vi.fn().mockResolvedValue({
        arrayBuffer: vi.fn().mockResolvedValue(storedBody!.slice().buffer),
      }),
      put: vi.fn(async (_key: string, body: Uint8Array) => {
        rewrappedBody = body;
      }),
    } as unknown as R2Bucket;
    const adminDb = {
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM logging_rewrap_jobs')) {
          return Promise.resolve({
            id: 'lrw_1',
            key_registry_id: 'lkey_1',
            from_version: 1,
            to_version: 2,
            status: 'queued',
            metadata: '{"reason":"critical_archive"}',
          });
        }
        if (sql.includes('FROM log_object_catalog')) {
          return Promise.resolve({
            id: chunkResult.objectCatalogId,
            tenant_key: tenantKey,
            log_type: 'audit',
            plane: 'archive',
            object_key: chunkResult.objectKey,
            chunk_id: chunkResult.chunkId,
            object_kind: 'chunk',
            status: 'committed',
            record_count: 1,
            byte_count: storedBody!.byteLength,
            checksum_sha256: 'old-checksum',
            compression: chunkResult.compression,
            encryption_scope: encryptionScope,
            key_version: 1,
          });
        }
        if (sql.includes('internal_notification_events')) {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      }),
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
      transaction: vi.fn(),
      batch: vi.fn().mockResolvedValue([]),
      isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
      getType: vi.fn().mockReturnValue('mock'),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const message = createMessage({
      payload_type: 'rewrap_chunk',
      schema_version: 1,
      payload_id: 'qpl_rewrap_1',
      tenant_key: tenantKey,
      lane: 'bulk',
      created_at: 1779148800000,
      rewrap_job_id: 'lrw_1',
      object_catalog_id: chunkResult.objectCatalogId,
    });

    await processLoggingDeliveryQueue(
      {
        messages: [message],
        queue: 'LOGGING_DELIVERY_BULK_QUEUE',
      } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: rootKeyHex,
      }
    );

    expect(bucket.get).toHaveBeenCalledWith(chunkResult.objectKey);
    expect(bucket.put).toHaveBeenCalledWith(
      chunkResult.objectKey,
      expect.any(Uint8Array),
      expect.objectContaining({
        customMetadata: expect.objectContaining({
          keyVersion: '2',
          encryptionScope,
        }),
      })
    );
    await expect(
      decodeStoredLogChunkRecord({
        storedBody: rewrappedBody!,
        compression: chunkResult.compression,
        recordIndex: {
          recordId: String(recordIndex.recordId),
          tenantKey,
          logType: 'audit',
          plane: 'archive',
          objectCatalogId: chunkResult.objectCatalogId,
          chunkId: chunkResult.chunkId,
          lineNumber: Number(recordIndex.lineNumber),
          blockOffset: Number(recordIndex.blockOffset),
          blockLength: Number(recordIndex.blockLength),
          recordOffset: Number(recordIndex.recordOffset),
          recordLength: Number(recordIndex.recordLength),
          eventAt: 1779148800000,
          indexProfile: 'audit',
          status: 'committed',
          createdAt: 1779148800000,
        },
        encryption: {
          keyBytes: await deriveArchiveChunkEncryptionKey({
            rootKeyHex,
            tenantKey,
            logType: 'audit',
            plane: 'archive',
            keyVersion: 2,
          }),
          tenantKey,
          logType: 'audit',
          plane: 'archive',
          objectKey: chunkResult.objectKey,
          chunkId: chunkResult.chunkId,
          expectedEncryptionScope: encryptionScope,
          expectedKeyVersion: 2,
        },
      })
    ).resolves.toEqual(payload);
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE log_object_catalog'),
      expect.arrayContaining([2, expect.any(Number), chunkResult.objectCatalogId, 'committed'])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_rewrap_jobs'),
      expect.arrayContaining([
        'succeeded',
        expect.any(Number),
        expect.stringContaining('"to_version":2'),
        'lrw_1',
      ])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_key_versions'),
      expect.arrayContaining(['lkey_1', 1])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_key_versions'),
      expect.arrayContaining([1, 'lkey_1', 2])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acks unsupported schema payloads after writing DLQ metadata and replay payload', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket;
    const adminDb = createAdminDbAdapter();
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 99,
      payload_id: 'qpl_1',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
      destination_id: 'dest_1',
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
        DB_ADMIN: adminDb,
        AUDIT_ARCHIVE: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      }
    );

    const objectKey = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const putOptions = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as {
      customMetadata?: Record<string, string>;
    };
    const objectBody = JSON.parse(
      await decryptObjectArtifact(
        JSON.parse(String((bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1])),
        {
          rootKeyHex: ROOT_KEY,
          context: {
            tenantId: putOptions.customMetadata?.encryptionTenantContext ?? '',
            objectKey: String(objectKey),
            objectClass: 'operational_log_detail',
          },
        }
      )
    ) as { body?: unknown; bodyJson?: string };
    expect(objectKey).toContain('dlq/tenant_key=tk_123/');
    expect(objectKey).toContain('/unsupported/');
    expect(objectBody.body).toEqual(
      expect.objectContaining({
        payload_type: 'http_sink_batch',
        schema_version: 99,
      })
    );
    expect(objectBody.bodyJson).toContain('"payload_type":"http_sink_batch"');
    expect(putOptions.customMetadata).toEqual(
      expect.objectContaining({ encryption: 'authrim-object-envelope-v1' })
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_dlq_items'),
      expect.arrayContaining(['tk_123', 'http_sink_batch', 99, 'default', 'queue:LOGGING_DELIVERY'])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['operational', 'delivery_event', 'default', 'dlq'])
    );
    expect(adminDb.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining(['tk_123', 'logging_dlq_backlog', 'logging.delivery.dlq'])
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries malformed payloads because they may be transient producer errors', async () => {
    const message = createMessage({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'qpl_1',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
    });

    await processLoggingDeliveryQueue(
      { messages: [message], queue: 'LOGGING_DELIVERY_QUEUE' } as unknown as MessageBatch<unknown>,
      {
        DB: {} as D1Database,
        DB_PII: {} as D1Database,
      }
    );

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});

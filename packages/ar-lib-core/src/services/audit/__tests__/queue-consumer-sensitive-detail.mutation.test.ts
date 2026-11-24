import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processLoggingDeliveryQueue, type AuditQueueConsumerEnv } from '../queue-consumer';
import { decryptObjectArtifact, encryptObjectArtifact } from '../../object-artifact-crypto';
import {
  ROOT_KEY,
  createFakeAdminDb,
  createFakeLogger,
  createMemoryBucket,
  createMessage,
  parseEnvelope,
  insertedDeliveryEvents,
  type FakeAdminDb,
  type FakeMessage,
  must,
} from './queue-consumer-mutation-helpers';

const BASE = 1779148800000 - (1779148800000 % 3_600_000);
const NOW = new Date('2026-06-07T08:09:10.000Z');

interface RecordOptions {
  catalogId: string;
  tenantId?: string;
  objectClass?: string;
  surface?: string | null;
  eventAt?: number;
  eventAtKey?: string | null;
  binding?: unknown;
  keyVersion?: unknown;
  keyVersionKey?: string;
  pad?: number;
  plaintext?: string;
  publicArtifactId?: unknown;
  omit?: string;
  override?: Record<string, unknown>;
}

async function sensitiveRecord(options: RecordOptions) {
  const tenantId = options.tenantId ?? 'tenant-a';
  const objectClass = options.objectClass ?? 'webhook_delivery_payload';
  const pendingObjectKey = `pending-sensitive-detail:${options.catalogId}`;
  const envelope = await encryptObjectArtifact(options.plaintext ?? `secret-${options.catalogId}`, {
    rootKeyHex: ROOT_KEY,
    plane: 'SENSITIVE_DETAILS',
    keyVersion: 1,
    contentType: 'application/json',
    context: { tenantId, objectKey: pendingObjectKey, objectClass },
  });
  const record: Record<string, unknown> = {
    catalog_id: options.catalogId,
    tenant_id: tenantId,
    object_class: objectClass,
    content_type: 'application/json',
    payload_envelope_json: JSON.stringify(
      options.pad ? { ...envelope, pad: 'x'.repeat(options.pad) } : envelope
    ),
    pending_object_key: pendingObjectKey,
  };
  if (options.surface !== null) record.surface = options.surface ?? 'webhook';
  if (options.eventAtKey !== null)
    record[options.eventAtKey ?? 'event_at'] = options.eventAt ?? BASE;
  if (options.binding !== undefined) record.index_db_binding = options.binding;
  if (options.keyVersion !== undefined)
    record[options.keyVersionKey ?? 'key_version'] = options.keyVersion;
  if (options.publicArtifactId !== undefined) record.public_artifact_id = options.publicArtifactId;
  if (options.omit) delete record[options.omit];
  return { ...record, ...options.override };
}

function chunkMessage(
  records: unknown[],
  overrides: Record<string, unknown> = {},
  messageOptions: { attempts?: number } = {}
): FakeMessage {
  return createMessage(
    {
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: `qpl_sd_${Math.random().toString(36).slice(2)}`,
      tenant_key: 't_sd',
      lane: 'critical',
      created_at: BASE,
      log_type: 'webhook',
      plane: 'sensitive_detail',
      surface: 'payload_surface',
      records,
      ...overrides,
    },
    messageOptions
  );
}

async function runChunks(
  messages: FakeMessage[],
  env: Record<string, unknown> = {},
  deps: {
    coreDb?: FakeAdminDb;
    adminDb?: FakeAdminDb | null;
    bucket?: ReturnType<typeof createMemoryBucket> | null;
  } = {}
) {
  const coreDb = deps.coreDb ?? createFakeAdminDb();
  const adminDb = deps.adminDb === undefined ? createFakeAdminDb() : deps.adminDb;
  const bucket = deps.bucket === undefined ? createMemoryBucket() : deps.bucket;
  const logger = createFakeLogger();
  await processLoggingDeliveryQueue(
    { messages } as unknown as MessageBatch<unknown>,
    {
      DB: coreDb,
      DB_PII: {},
      ...(adminDb ? { DB_ADMIN: adminDb } : {}),
      ...(bucket ? { SENSITIVE_DETAILS: bucket } : {}),
      OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      ...env,
    } as unknown as AuditQueueConsumerEnv,
    logger
  );
  return { coreDb, adminDb, bucket, logger };
}

function loggedError(logger: ReturnType<typeof createFakeLogger>): string {
  const call = logger.error.mock.calls.find(
    ([event]) => event === 'logging_delivery_queue_message_failed'
  );
  return String((call?.[1] as { error?: string } | undefined)?.error);
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function batchStatements(db: FakeAdminDb) {
  return db.batch.mock.calls.flatMap(
    ([statements]) => statements as Array<{ sql: string; params: unknown[] }>
  );
}

describe('sensitive detail chunk writer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('chunk contents and index', () => {
    it('re-encrypts every record into one gzip ndjson chunk bound to the chunk key', async () => {
      const records = [
        await sensitiveRecord({ catalogId: 'cat-1', eventAt: BASE + 20, keyVersion: 1 }),
        await sensitiveRecord({
          catalogId: 'cat-2',
          eventAt: BASE + 10,
          tenantId: 'tenant-b',
          objectClass: 'webhook_delivery_payload',
        }),
      ];
      const message = chunkMessage(records, {}, { attempts: 3 });
      const { coreDb, bucket, adminDb } = await runChunks([message]);

      expect(bucket?.put).toHaveBeenCalledOnce();
      const [objectKey, body, options] = bucket?.put.mock.calls[0] as [
        string,
        Uint8Array,
        { httpMetadata: Record<string, unknown>; customMetadata: Record<string, string> },
      ];
      expect(objectKey).toContain('sensitive-details/v1/t_sd/sensitive_detail/webhook/webhook/');
      expect(options.httpMetadata).toEqual({
        contentType: 'application/x-ndjson',
        contentEncoding: 'gzip',
      });

      const text = await gunzip(body);
      const lines = text.split('\n');
      expect(lines.pop()).toBe('');
      expect(lines).toHaveLength(2);
      // Sorted by event time: cat-2 (BASE+10) first, then cat-1.
      const plaintexts = await Promise.all(
        lines.map((line, index) =>
          decryptObjectArtifact(parseEnvelope(line), {
            rootKeyHex: ROOT_KEY,
            context: {
              tenantId: index === 0 ? 'tenant-b' : 'tenant-a',
              objectKey,
              objectClass: 'webhook_delivery_payload',
            },
          })
        )
      );
      expect(plaintexts).toEqual(['secret-cat-2', 'secret-cat-1']);

      const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      expect(options.customMetadata).toEqual({
        tenantKey: 't_sd',
        logType: 'webhook',
        plane: 'sensitive_detail',
        surface: 'webhook',
        shard: expect.any(String) as string,
        recordCount: '2',
        checksumSha256: checksum,
        createdAt: String(NOW.getTime()),
        chunkStartAt: String(BASE + 10),
        chunkEndAt: String(BASE + 20),
      });

      const statements = batchStatements(coreDb);
      expect(statements).toHaveLength(6);
      const objectInserts = statements.filter((s) =>
        s.sql.includes('INSERT INTO object_catalog_objects')
      );
      const updates = statements.filter((s) => s.sql.includes('UPDATE object_catalog'));
      const indexInserts = statements.filter((s) =>
        s.sql.includes('INSERT INTO sensitive_detail_chunk_index')
      );
      expect(objectInserts).toHaveLength(2);
      expect(updates).toHaveLength(2);
      expect(indexInserts).toHaveLength(2);

      const lineBytes = lines.map((line) => new TextEncoder().encode(line).byteLength);
      objectInserts.forEach((statement, i) => {
        expect(statement.params[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(statement.params.slice(1)).toEqual([
          i === 0 ? 'cat-2' : 'cat-1',
          'canonical_json',
          'chunk',
          0,
          'SENSITIVE_DETAILS',
          objectKey,
          1,
          checksum,
          body.byteLength,
          NOW.getTime(),
        ]);
      });
      expect(updates.map((s) => s.params)).toEqual([
        [NOW.getTime(), 'cat-2', 'tenant-b'],
        [NOW.getTime(), 'cat-1', 'tenant-a'],
      ]);
      expect(indexInserts.map((s) => s.params)).toEqual([
        [
          'cat-2',
          'tenant-b',
          'webhook_delivery_payload',
          'SENSITIVE_DETAILS',
          objectKey,
          'gzip',
          0,
          0,
          lineBytes[0],
          1,
          checksum,
          BASE + 10,
          null,
        ],
        [
          'cat-1',
          'tenant-a',
          'webhook_delivery_payload',
          'SENSITIVE_DETAILS',
          objectKey,
          'gzip',
          1,
          lineBytes[0] + 1,
          lineBytes[1],
          1,
          checksum,
          BASE + 20,
          null,
        ],
      ]);

      const [event] = insertedDeliveryEvents(must(adminDb));
      expect(event).toMatchObject({
        tenantKey: 't_sd',
        destinationId: 'sensitive_detail_chunk_writer',
        logType: 'webhook',
        plane: 'sensitive_detail',
        lane: 'critical',
        status: 'delivered',
        attemptCount: 3,
        errorClass: null,
      });
      expect(event?.metadata).toEqual({
        object_key: objectKey,
        record_count: 2,
        byte_count: body.byteLength,
        checksum_sha256: checksum,
        flush_profile: 'critical',
      });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    });

    it('stores plain ndjson when CompressionStream is unavailable', async () => {
      vi.stubGlobal('CompressionStream', undefined);
      const record = await sensitiveRecord({ catalogId: 'cat-plain' });
      const { bucket, coreDb } = await runChunks([chunkMessage([record])]);
      const [objectKey, body, options] = bucket?.put.mock.calls[0] as [
        string,
        Uint8Array,
        { httpMetadata: Record<string, unknown> },
      ];
      expect(options.httpMetadata).toEqual({
        contentType: 'application/x-ndjson',
        contentEncoding: undefined,
      });
      const [line] = new TextDecoder().decode(body).split('\n');
      await expect(
        decryptObjectArtifact(parseEnvelope(line), {
          rootKeyHex: ROOT_KEY,
          context: {
            tenantId: 'tenant-a',
            objectKey,
            objectClass: 'webhook_delivery_payload',
          },
        })
      ).resolves.toBe('secret-cat-plain');
      const index = batchStatements(coreDb).find((s) =>
        s.sql.includes('INSERT INTO sensitive_detail_chunk_index')
      );
      expect(index?.params[5]).toBe('none');
    });
  });

  describe('record normalisation', () => {
    async function indexParams(record: Record<string, unknown>, payloadOverrides = {}) {
      const { coreDb, bucket } = await runChunks([chunkMessage([record], payloadOverrides)]);
      const insert = batchStatements(coreDb).find((s) =>
        s.sql.includes('INSERT INTO sensitive_detail_chunk_index')
      );
      const catalog = batchStatements(coreDb).find((s) =>
        s.sql.includes('INSERT INTO object_catalog_objects')
      );
      return { insert, catalog, bucket };
    }

    it.each([
      ['key_version', 4, 4],
      ['keyVersion', 5, 5],
      ['key_version', 0, 1],
      ['key_version', -3, 1],
      ['key_version', 'abc', 1],
      ['key_version', undefined, 1],
    ])('reads key version from %s=%j as %j', async (keyVersionKey, keyVersion, expected) => {
      const record = await sensitiveRecord({
        catalogId: `cat-kv-${String(keyVersion)}`,
        keyVersionKey,
        keyVersion,
      });
      const { insert, catalog } = await indexParams(record);
      expect(insert?.params[9]).toBe(expected);
      expect(catalog?.params[7]).toBe(expected);
    });

    it.each(['event_at', 'eventAt', 'created_at', 'createdAt'])(
      'reads the event time from %s',
      async (eventAtKey) => {
        const record = await sensitiveRecord({
          catalogId: `cat-ev-${eventAtKey}`,
          eventAtKey,
          eventAt: BASE + 777,
        });
        const { insert } = await indexParams(record);
        expect(insert?.params[11]).toBe(BASE + 777);
      }
    );

    it('falls back to the payload creation time when the record has no event time', async () => {
      const record = await sensitiveRecord({ catalogId: 'cat-ev-none', eventAtKey: null });
      const { insert } = await indexParams(record, { created_at: BASE + 4242 });
      expect(insert?.params[11]).toBe(BASE + 4242);
    });

    it('prefers the record surface, then the payload surface, then a default', async () => {
      const own = await indexParams(await sensitiveRecord({ catalogId: 'cat-s1', surface: 'own' }));
      expect(String(own.bucket?.put.mock.calls[0]?.[0])).toContain('/sensitive_detail/own/');

      const inherited = await indexParams(
        await sensitiveRecord({ catalogId: 'cat-s2', surface: null }),
        { surface: 'from_payload' }
      );
      expect(String(inherited.bucket?.put.mock.calls[0]?.[0])).toContain('/from_payload/');

      const emptyOwn = await indexParams(
        await sensitiveRecord({ catalogId: 'cat-s3', surface: '' }),
        { surface: undefined }
      );
      expect(String(emptyOwn.bucket?.put.mock.calls[0]?.[0])).toContain(
        '/sensitive_detail/sensitive_detail/'
      );
      expect(emptyOwn.bucket?.put.mock.calls[0]?.[2]).toMatchObject({
        customMetadata: { surface: 'sensitive_detail' },
      });
    });

    it('writes the chunk index to DB_ADMIN when requested', async () => {
      const coreDb = createFakeAdminDb();
      const adminDb = createFakeAdminDb();
      const record = await sensitiveRecord({ catalogId: 'cat-admin', binding: 'DB_ADMIN' });
      const message = chunkMessage([record]);
      await runChunks([message], {}, { coreDb, adminDb });
      expect(adminDb.batch).toHaveBeenCalledOnce();
      expect(coreDb.batch).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('writes the chunk index to LOGGING_INDEX_DB when requested and bound', async () => {
      const indexDb = createFakeAdminDb();
      const coreDb = createFakeAdminDb();
      const record = await sensitiveRecord({ catalogId: 'cat-index', binding: 'LOGGING_INDEX_DB' });
      const message = chunkMessage([record]);
      await runChunks([message], { LOGGING_INDEX_DB: indexDb }, { coreDb });
      expect(indexDb.batch).toHaveBeenCalledOnce();
      expect(coreDb.batch).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('rejects the whole run when DB_ADMIN is requested but not bound', async () => {
      const record = await sensitiveRecord({ catalogId: 'cat-noadmin', binding: 'DB_ADMIN' });
      const message = chunkMessage([record]);
      await expect(runChunks([message], {}, { adminDb: null })).rejects.toThrow(
        'sensitive_detail_admin_db_unavailable'
      );
      expect(message.ack).not.toHaveBeenCalled();
    });

    it('falls back to the core DB for unknown binding names', async () => {
      const coreDb = createFakeAdminDb();
      const record = await sensitiveRecord({ catalogId: 'cat-unknown', binding: 'SOMETHING_ELSE' });
      await runChunks([chunkMessage([record])], {}, { coreDb });
      expect(coreDb.batch).toHaveBeenCalledOnce();
    });
  });

  describe('record validation', () => {
    it.each([
      'catalog_id',
      'tenant_id',
      'object_class',
      'content_type',
      'payload_envelope_json',
      'pending_object_key',
    ])('retries the message when %s is missing', async (field) => {
      const record = await sensitiveRecord({ catalogId: `cat-miss-${field}`, omit: field });
      const message = chunkMessage([record]);
      const { logger, bucket } = await runChunks([message]);
      expect(loggedError(logger)).toBe(`Error: sensitive_detail_chunk_record_${field}_required`);
      expect(message.retry).toHaveBeenCalledExactlyOnceWith();
      expect(message.ack).not.toHaveBeenCalled();
      expect(bucket?.put).not.toHaveBeenCalled();
    });

    it('treats empty strings as missing', async () => {
      const record = await sensitiveRecord({
        catalogId: 'cat-empty',
        override: { object_class: '' },
      });
      const message = chunkMessage([record]);
      const { logger } = await runChunks([message]);
      expect(loggedError(logger)).toBe(
        'Error: sensitive_detail_chunk_record_object_class_required'
      );
    });

    it.each([null, 'text', 5, [1]])('retries when a record is %j', async (record) => {
      const message = chunkMessage([record]);
      const { logger } = await runChunks([message]);
      expect(loggedError(logger)).toBe('Error: sensitive_detail_chunk_record_malformed');
      expect(message.retry).toHaveBeenCalledOnce();
    });

    it('retries only the invalid message and still writes the valid ones', async () => {
      const good = chunkMessage([await sensitiveRecord({ catalogId: 'cat-good' })]);
      const bad = chunkMessage([{ catalog_id: 'x' }]);
      const { bucket } = await runChunks([bad, good]);
      expect(bad.retry).toHaveBeenCalledOnce();
      expect(good.ack).toHaveBeenCalledOnce();
      expect(bucket?.put).toHaveBeenCalledOnce();
    });
  });

  describe('grouping and flush boundaries', () => {
    it('writes separate chunks per surface and acks the messages', async () => {
      const a = chunkMessage([
        await sensitiveRecord({ catalogId: 'g-a1', surface: 'alpha' }),
        await sensitiveRecord({ catalogId: 'g-a2', surface: 'beta' }),
      ]);
      const b = chunkMessage([await sensitiveRecord({ catalogId: 'g-b1', surface: 'alpha' })]);
      const { bucket } = await runChunks([a, b]);
      expect(bucket?.put).toHaveBeenCalledTimes(2);
      const keys = bucket?.put.mock.calls.map(([key]) => String(key)) ?? [];
      expect(keys.filter((key) => key.includes('/alpha/'))).toHaveLength(1);
      expect(keys.filter((key) => key.includes('/beta/'))).toHaveLength(1);
      expect(a.ack).toHaveBeenCalled();
      expect(b.ack).toHaveBeenCalledOnce();
      expect(a.retry).not.toHaveBeenCalled();
      expect(b.retry).not.toHaveBeenCalled();
    });

    it('separates groups by tenant key and index database binding', async () => {
      const first = chunkMessage([await sensitiveRecord({ catalogId: 'k-1' })], {
        tenant_key: 't_one',
      });
      const second = chunkMessage([await sensitiveRecord({ catalogId: 'k-2' })], {
        tenant_key: 't_two',
      });
      const third = chunkMessage([
        await sensitiveRecord({ catalogId: 'k-3', binding: 'DB_ADMIN' }),
      ]);
      const { bucket } = await runChunks([first, second, third]);
      expect(bucket?.put).toHaveBeenCalledTimes(3);
    });

    async function chunkCount(lane: string, eventTimes: number[]) {
      const records = await Promise.all(
        eventTimes.map((eventAt, i) => sensitiveRecord({ catalogId: `b-${lane}-${i}`, eventAt }))
      );
      const message = chunkMessage(records, { lane });
      const { bucket } = await runChunks([message]);
      return bucket?.put.mock.calls.length ?? 0;
    }

    it.each([
      ['critical', 60_000, 1],
      ['default', 5 * 60_000, 1],
      ['bulk', 15 * 60_000, 1],
    ])('splits %s chunks exactly at the %d ms interval boundary', async (lane, interval) => {
      const start = Math.floor(BASE / interval) * interval;
      expect(await chunkCount(lane, [start, start + interval - 1])).toBe(1);
      expect(await chunkCount(lane, [start + interval - 1, start + interval])).toBe(2);
    });

    it('flushes critical chunks at 1000 records', async () => {
      const record = await sensitiveRecord({ catalogId: 'many' });
      const records = Array.from({ length: 1000 }, (_, i) => ({
        ...record,
        catalog_id: `many-${i}`,
        event_at: BASE,
      }));
      const exact = await runChunks([chunkMessage(records)]);
      expect(exact.bucket?.put).toHaveBeenCalledTimes(1);

      const over = await runChunks([
        chunkMessage([...records, { ...record, catalog_id: 'many-1000' }]),
      ]);
      expect(over.bucket?.put).toHaveBeenCalledTimes(2);
      expect(over.bucket?.put.mock.calls[0]?.[2]).toMatchObject({
        customMetadata: { recordCount: '1000' },
      });
      expect(over.bucket?.put.mock.calls[1]?.[2]).toMatchObject({
        customMetadata: { recordCount: '1' },
      });
    });

    it('flushes by estimated size', async () => {
      const limit = 4 * 1024 * 1024;
      const estimate = (record: Record<string, unknown>) =>
        String(record.payload_envelope_json).length +
        String(record.catalog_id).length +
        String(record.tenant_id).length +
        String(record.object_class).length +
        String(record.surface).length +
        256;
      const first = await sensitiveRecord({ catalogId: 'sz-1', pad: 1_000_000 });
      const firstEstimate = estimate(first);
      // Pad the second record so the combined estimate is exactly the limit, then one byte over.
      const probe = await sensitiveRecord({ catalogId: 'sz-2', pad: 1 });
      const probeEstimate = estimate(probe);
      const padFor = (target: number) => 1 + (target - probeEstimate);
      const fits = await sensitiveRecord({ catalogId: 'sz-2', pad: padFor(limit - firstEstimate) });
      expect(firstEstimate + estimate(fits)).toBe(limit);
      const overflow = await sensitiveRecord({
        catalogId: 'sz-2',
        pad: padFor(limit - firstEstimate + 1),
      });
      expect(firstEstimate + estimate(overflow)).toBe(limit + 1);

      const together = await runChunks([chunkMessage([first, fits])]);
      expect(together.bucket?.put).toHaveBeenCalledTimes(1);
      const apart = await runChunks([chunkMessage([first, overflow])]);
      expect(apart.bucket?.put).toHaveBeenCalledTimes(2);
    });
  });

  describe('failures', () => {
    it.each([
      ['a missing bucket', { bucket: null }, 'sensitive_detail_bucket_unavailable'],
      [
        'a missing root key',
        { env: { OBJECT_ENCRYPTION_ROOT_KEY: undefined } },
        'sensitive_detail_root_key_unavailable',
      ],
    ])('retries with a recorded event for %s', async (_name, input, expected) => {
      const record = await sensitiveRecord({ catalogId: 'f-1' });
      const message = chunkMessage([record], {}, { attempts: 4 });
      const other = chunkMessage(
        [await sensitiveRecord({ catalogId: 'f-2' })],
        {},
        { attempts: 9 }
      );
      const { adminDb } = await runChunks(
        [message, other],
        (input as { env?: Record<string, unknown> }).env,
        { bucket: (input as { bucket?: null }).bucket }
      );
      expect(message.retry).toHaveBeenCalledExactlyOnceWith();
      expect(other.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
      const [event] = insertedDeliveryEvents(must(adminDb));
      expect(event).toMatchObject({
        tenantKey: 't_sd',
        destinationId: 'sensitive_detail_chunk_writer',
        logType: 'webhook',
        plane: 'sensitive_detail',
        lane: 'critical',
        status: 'retrying',
        attemptCount: 9,
        errorClass: 'sensitive_detail_chunk_write_failed',
      });
      expect(event?.metadata).toEqual({ record_count: 2, error: `Error: ${expected}` });
    });

    it('retries a message whose chunk could not be stored and acks messages from stored chunks', async () => {
      const early = await sensitiveRecord({ catalogId: 'p-early', eventAt: BASE });
      const late = await sensitiveRecord({ catalogId: 'p-late', eventAt: BASE + 120_000 });
      const spanning = chunkMessage([early, late]);
      const onlyEarly = chunkMessage([
        await sensitiveRecord({ catalogId: 'p-early-2', eventAt: BASE + 1 }),
      ]);
      const bucket = createMemoryBucket();
      let puts = 0;
      bucket.put.mockImplementation(async () => {
        puts += 1;
        if (puts === 2) throw new Error('r2 put failed');
      });
      const { adminDb } = await runChunks([spanning, onlyEarly], {}, { bucket });
      expect(puts).toBe(2);
      expect(spanning.retry).toHaveBeenCalledOnce();
      expect(spanning.ack).not.toHaveBeenCalled();
      expect(onlyEarly.ack).toHaveBeenCalledOnce();
      expect(onlyEarly.retry).not.toHaveBeenCalled();
      const statuses = insertedDeliveryEvents(must(adminDb)).map((event) => event.status);
      expect(statuses).toEqual(['delivered', 'retrying']);
    });

    it('retries when the index batch fails after the object was written', async () => {
      const coreDb = createFakeAdminDb();
      coreDb.batch.mockRejectedValue(new Error('batch failed'));
      const message = chunkMessage([await sensitiveRecord({ catalogId: 'idx-fail' })]);
      const { adminDb } = await runChunks([message], {}, { coreDb });
      expect(message.retry).toHaveBeenCalledOnce();
      expect(insertedDeliveryEvents(must(adminDb))[0]).toMatchObject({
        status: 'retrying',
        metadata: { record_count: 1, error: 'Error: batch failed' },
      });
    });

    it('uses attempt 1 when messages report zero attempts', async () => {
      const message = chunkMessage(
        [await sensitiveRecord({ catalogId: 'att-0' })],
        {},
        { attempts: 0 }
      );
      const { adminDb } = await runChunks([message]);
      expect(insertedDeliveryEvents(must(adminDb))[0]?.attemptCount).toBe(1);
    });
  });
});

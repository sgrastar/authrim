import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import { emitLogIcebergRow } from '../log-iceberg-emitter';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { buildLogIcebergRecord } from '../log-iceberg-record';
import { logIcebergDigest, logIcebergRecordId } from '../log-iceberg-store';
import { logIcebergRetryMarkerMetadata } from '../log-iceberg-retry-marker';
import type { LogIcebergConfig } from '../log-iceberg-config';
import {
  consumeLogIcebergMessage,
  createLogIcebergWritePort,
  logIcebergOutboxStatement,
  type LogIcebergRuntimeEnv,
  type LogIcebergQueueReference,
} from '../log-iceberg-runtime';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  // Exercise the connected runtime without enabling either unfinished product mode.
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['pipeline', 'scheduled'],
}));

const now = 1_800_000_000_000;
const base: LogIcebergConfig = {
  mode: 'scheduled',
  generation: 'new-generation',
  schemaVersion: 1,
  activatedAt: now,
  accountId: 'a'.repeat(32),
  bucket: 'archive-logs',
  warehouse: `${'a'.repeat(32)}_archive-logs`,
  catalogUri: `https://catalog.cloudflarestorage.com/${'a'.repeat(32)}/archive-logs`,
  namespace: 'authrim',
  table: 'logs_v1',
  tableUuid: 'f644e0fa-a8d7-4976-bcd7-1520bc0f8d9b',
  physicalFingerprint: 'f'.repeat(64),
  dbRetentionDays: 7,
  exportIntervalMinutes: 10,
};
const keys = { rootKeyHex: 'ab'.repeat(32), contentHmacKeyHex: 'cd'.repeat(32), keyVersion: 1 };
const makeRecord = (
  id = 'event-1',
  expiresAt: number | null = now + 1000,
  ingestedAt = now,
  pii = false,
  email = 'private@example.invalid'
) =>
  buildLogIcebergRecord(
    base,
    {
      eventId: id,
      tenantKey: 'key-a',
      sourceDataset: pii ? 'pii.pii_log' : 'core.audit_log',
      logType: pii ? 'pii' : 'audit',
      eventAt: now - 1000,
      ingestedAt,
      expiresAt,
      overview: pii ? { subject_id: '008fdf61-b30f-4b8a-97a5-16b9c5c8bdbd' } : undefined,
      body: { id, tenant_id: 'tenant-a', metadata_json: JSON.stringify({ email }) },
    },
    keys
  );

function bucketFixture() {
  const objects = new Map<string, { text: string; metadata: Record<string, string> }>();
  const put = vi.fn(
    async (key: string, text: string, options: { customMetadata?: Record<string, string> }) => {
      if (objects.has(key)) return null;
      objects.set(key, { text, metadata: options.customMetadata ?? {} });
      return { key };
    }
  );
  const get = vi.fn(async (key: string) => {
    const value = objects.get(key);
    if (!value) return null;
    const bytes = new TextEncoder().encode(value.text);
    return {
      size: bytes.length,
      customMetadata: value.metadata,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  });
  const head = vi.fn(async (key: string) => {
    const value = objects.get(key);
    return value
      ? {
          size: new TextEncoder().encode(value.text).byteLength,
          customMetadata: value.metadata,
          etag: 'fixture-etag',
        }
      : null;
  });
  return { objects, put, get, head, binding: { put, get, head } as unknown as R2Bucket };
}

describe('Iceberg runtime mode isolation and durable delivery', () => {
  let fixture: ReturnType<typeof sqliteAdapter>;
  let bucket: ReturnType<typeof bucketFixture>;
  let env: LogIcebergRuntimeEnv;
  let sent: LogIcebergQueueReference[];
  let queue: ReturnType<typeof vi.fn>;
  let stream: ReturnType<typeof vi.fn<() => Promise<void>>>;
  beforeEach(() => {
    fixture = sqliteAdapter();
    Object.assign(fixture.adapter, {
      transaction: async () => {
        throw new Error('Use atomic batch');
      },
      isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
      getType: () => 'd1',
      close: async () => {},
    });
    fixture.db.exec(
      readMigrationSource(
        new URL('../../../../../migrations/admin/d1/', import.meta.url),
        '053_log_iceberg_storage.sql'
      )
    );
    fixture.db
      .prepare(
        `INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,?,?)`
      )
      .run('tenant-a', 'tenant-a', 'key-a', 'Tenant', now, now);
    bucket = bucketFixture();
    sent = [];
    queue = vi.fn(async (body: LogIcebergQueueReference) => {
      sent.push(body);
    });
    stream = vi.fn(async () => {});
    env = {
      DB: fixture.adapter,
      DB_ADMIN: fixture.adapter,
      LOG_ARCHIVE: bucket.binding,
      LOGGING_DELIVERY_QUEUE: { send: queue } as unknown as NonNullable<
        LogIcebergRuntimeEnv['LOGGING_DELIVERY_QUEUE']
      >,
      LOG_ARCHIVE_STREAM: { send: stream },
      OBJECT_ENCRYPTION_ROOT_KEY: keys.rootKeyHex,
      LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
        schema_version: 1,
        current_version: 1,
        roots: { 1: keys.rootKeyHex },
      }),
      LOG_ARCHIVE_CONTENT_HMAC_KEY: keys.contentHmacKeyHex,
    };
  });
  afterEach(() => {
    fixture.db.close();
  });
  function pipeline() {
    const config = {
      ...base,
      mode: 'pipeline' as const,
      dbRetentionDays: null,
      exportIntervalMinutes: null,
    };
    Object.assign(env, {
      AUTHRIM_LOG_ARCHIVE_MODE: config.mode,
      AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: config.generation,
      AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
      AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: new Date(now).toISOString(),
      AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: config.accountId,
      AUTHRIM_LOG_ARCHIVE_BUCKET: config.bucket,
      AUTHRIM_LOG_ARCHIVE_WAREHOUSE: config.warehouse,
      AUTHRIM_LOG_ARCHIVE_CATALOG_URI: config.catalogUri,
      AUTHRIM_LOG_ARCHIVE_NAMESPACE: config.namespace,
      AUTHRIM_LOG_ARCHIVE_TABLE: config.table,
      AUTHRIM_LOG_ARCHIVE_TABLE_UUID: config.tableUuid,
      AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: config.physicalFingerprint,
    });
    return createLogIcebergWritePort(env, config, () => now);
  }
  const count = (fixture: ReturnType<typeof sqliteAdapter>, table: string) =>
    Number(fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);

  it('writes scheduled records only to DB; no Pipeline, Queue or R2 writes occur', async () => {
    const port = createLogIcebergWritePort(env, base, () => now);
    expect(
      await port.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [await makeRecord()],
      })
    ).toEqual({ stored: 1, queued: 0 });
    expect(count(fixture, 'log_iceberg_records')).toBe(1);
    expect(count(fixture, 'audit_log')).toBe(0);
    expect(count(fixture, 'log_iceberg_outbox')).toBe(0);
    expect(bucket.put).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
  it('durably queues only an encrypted pointer in pipeline mode, with no searchable DB body', async () => {
    const port = pipeline();
    expect(
      await port.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [await makeRecord()],
      })
    ).toEqual({ stored: 0, queued: 1 });
    expect(count(fixture, 'log_iceberg_records')).toBe(0);
    expect(count(fixture, 'audit_log')).toBe(0);
    const outbox = fixture.db.prepare('SELECT * FROM log_iceberg_outbox').get();
    expect(JSON.stringify(outbox)).not.toContain('private@example.invalid');
    expect(JSON.stringify(outbox)).not.toContain('detail_ciphertext');
    expect(JSON.stringify(sent)).not.toContain('detail_ciphertext');
    expect([...bucket.objects.values()][0].text).not.toContain('private@example.invalid');
    expect(stream).not.toHaveBeenCalled();
    expect(await consumeLogIcebergMessage(sent[0], env, now)).toBe(true);
    expect(stream).toHaveBeenCalledOnce();
    expect(count(fixture, 'log_iceberg_records')).toBe(0);
  });
  it('keeps pending delivery state on Queue failure without falling back to a DB log or another format', async () => {
    const port = pipeline();
    queue.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(
      port.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [await makeRecord()],
      })
    ).rejects.toThrow('queue unavailable');
    expect(fixture.db.prepare('SELECT state FROM log_iceberg_outbox').get()?.state).toBe('pending');
    expect(count(fixture, 'log_iceberg_records')).toBe(0);
    expect(stream).not.toHaveBeenCalled();
  });
  it('reuses the original durable pointer after a retry with a fresh encryption nonce', async () => {
    const port = pipeline();
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(count(fixture, 'log_iceberg_outbox')).toBe(1);
  });
  it('persists the retry object before an Admin business batch, but never dispatches a rolled-back operation', async () => {
    const port = pipeline();
    const [ref] = await port.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    expect(bucket.objects.size).toBe(1);
    expect(count(fixture, 'log_iceberg_outbox')).toBe(1);
    expect(fixture.db.prepare('SELECT state FROM log_iceberg_outbox').get()?.state).toBe(
      'preparing'
    );
    await expect(
      fixture.adapter.batch([
        logIcebergOutboxStatement('tenant-a', ref, now),
        { sql: 'INSERT INTO absent_table VALUES (1)' },
      ])
    ).rejects.toThrow();
    await expect(
      port.dispatchPipelineReferences({ tenantId: 'tenant-a', references: [ref] })
    ).rejects.toThrow('log_iceberg_outbox_not_committed');
    expect(queue).not.toHaveBeenCalled();
  });
  it('persists intent before PUT and safely resumes a crash before any object existed', async () => {
    const port = pipeline();
    bucket.put.mockRejectedValueOnce(new Error('before_put_crash'));
    await expect(
      port.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [await makeRecord()],
      })
    ).rejects.toThrow('before_put_crash');
    expect(
      fixture.db.prepare('SELECT state,payload_digest,payload_bytes FROM log_iceberg_outbox').get()
    ).toMatchObject({ state: 'preparing', payload_digest: null, payload_bytes: null });
    expect(bucket.objects.size).toBe(0);
    expect(queue).not.toHaveBeenCalled();
    const retry = await makeRecord('event-1', now + 1000, now + 10);
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [retry],
    });
    expect(
      (JSON.parse([...bucket.objects.values()][0].text) as { ingested_at: number }).ingested_at
    ).toBe(now + 10);
    expect(sent).toHaveLength(1);
  });

  it('reuses the actual first envelope after PUT succeeded but its response was lost', async () => {
    const port = pipeline(),
      original = await makeRecord();
    const normalPut = bucket.put.getMockImplementation();
    if (!normalPut) throw new Error('missing fixture PUT');
    bucket.put.mockImplementationOnce(async (...args) => {
      await normalPut(...args);
      throw new Error('lost_put_reply');
    });
    await expect(
      port.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [original],
      })
    ).rejects.toThrow('lost_put_reply');
    const retry = await makeRecord('event-1', now + 1000, now + 20);
    expect(retry.detail_ciphertext).not.toBe(original.detail_ciphertext);
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [retry],
    });
    expect(sent[0].payload_digest).toBe(await logIcebergDigest(JSON.stringify(original)));
    expect(
      (JSON.parse([...bucket.objects.values()][0].text) as { ingested_at: number }).ingested_at
    ).toBe(now);
    expect(bucket.objects.size).toBe(1);
  });

  it('shares the first nonce when concurrent preparations race for the deterministic key', async () => {
    const port = pipeline(),
      first = await makeRecord(),
      second = await makeRecord('event-1', now + 1000, now + 30);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normalPut = bucket.put.getMockImplementation();
    if (!normalPut) throw new Error('missing fixture PUT');
    bucket.put.mockImplementationOnce(async (...args) => {
      entered();
      await block;
      return normalPut(...args);
    });
    const waiting = port.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [first],
    });
    await started;
    const chosen = await port.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [second],
    });
    release();
    expect(await waiting).toEqual(chosen);
    expect(chosen[0].payload_key).toBe(
      `_authrim_retry/iceberg/v1/${base.generation}/${await logIcebergRecordId(first)}.json`
    );
    expect(chosen[0].payload_digest).toBe(await logIcebergDigest(JSON.stringify(second)));
    expect(bucket.objects.size).toBe(1);
    expect(queue).not.toHaveBeenCalled();
  });

  it('rejects same-ID different content before any second PUT or pointer change', async () => {
    const port = pipeline();
    await port.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    const before = fixture.db.prepare('SELECT * FROM log_iceberg_outbox').get();
    await expect(
      port.preparePipelineReferences({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [await makeRecord('event-1', now + 1000, now, false, 'changed@example.invalid')],
      })
    ).rejects.toThrow();
    expect(bucket.put).toHaveBeenCalledOnce();
    expect(fixture.db.prepare('SELECT * FROM log_iceberg_outbox').get()).toEqual(before);
  });

  it.each([false, true])(
    'blocks a late conditional PUT with the erased same-key marker (object already put: %s)',
    async (putBeforePause) => {
      const port = pipeline(),
        record = await makeRecord('pii-event', now + 1000, now, true);
      const id = await logIcebergRecordId(record),
        key = `_authrim_retry/iceberg/v1/${base.generation}/${id}.json`;
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const block = new Promise<void>((resolve) => {
        release = resolve;
      });
      const normalPut = bucket.put.getMockImplementation();
      if (!normalPut) throw new Error('missing fixture PUT');
      bucket.put.mockImplementationOnce(async (...args) => {
        const created = putBeforePause ? await normalPut(...args) : undefined;
        entered();
        await block;
        return putBeforePause ? (created ?? null) : normalPut(...args);
      });
      const pending = port.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [record],
      });
      await started;
      expect(fixture.db.prepare('SELECT state FROM log_iceberg_outbox').get()?.state).toBe(
        'preparing'
      );
      fixture.db
        .prepare(
          `INSERT INTO log_iceberg_subject_erasures(id,tenant_id,tenant_key,source_dataset,subject_id,state,created_at,updated_at) VALUES(?,'tenant-a','key-a','pii.pii_log',?,'pending',?,?)`
        )
        .run('erase', record.subject_id, now, now);
      fixture.db
        .prepare("UPDATE log_iceberg_outbox SET state='erased',payload_erased_at=? WHERE id=?")
        .run(now, id);
      bucket.objects.set(key, { text: '', metadata: logIcebergRetryMarkerMetadata(id) });
      release();
      await expect(pending).resolves.toEqual({ stored: 0, queued: 0 });
      expect(queue).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(bucket.objects.get(key)?.text).toBe('');
      await port.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [await makeRecord('pii-event', now + 1000, now + 40, true)],
      });
      expect(bucket.objects.get(key)?.text).toBe('');
      expect(bucket.put).toHaveBeenCalledOnce();
    }
  );

  it('fails closed for an unexplained marker or a foreign existing object', async () => {
    const port = pipeline(),
      record = await makeRecord(),
      id = await logIcebergRecordId(record);
    const key = `_authrim_retry/iceberg/v1/${base.generation}/${id}.json`;
    bucket.objects.set(key, { text: '', metadata: logIcebergRetryMarkerMetadata(id) });
    await expect(
      port.preparePipelineReferences({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [record],
      })
    ).rejects.toThrow('marker_without_erasure');
    bucket.objects.set(key, { text: 'foreign', metadata: {} });
    await expect(
      port.preparePipelineReferences({
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [record],
      })
    ).rejects.toThrow('identity_mismatch');
    expect(queue).not.toHaveBeenCalled();
  });

  it('requires the prepared intent and preserves a committed pointer during business promotion', async () => {
    const port = pipeline();
    const [ref] = await port.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    await fixture.adapter.batch([logIcebergOutboxStatement('tenant-a', ref, now)]);
    const before = fixture.db.prepare('SELECT * FROM log_iceberg_outbox').get();
    await expect(
      fixture.adapter.batch([
        logIcebergOutboxStatement('tenant-a', { ...ref, payload_digest: 'ff'.repeat(32) }, now + 1),
      ])
    ).rejects.toThrow();
    expect(fixture.db.prepare('SELECT * FROM log_iceberg_outbox').get()).toEqual(before);
    fixture.db.prepare('DELETE FROM log_iceberg_outbox').run();
    await expect(
      fixture.adapter.batch([logIcebergOutboxStatement('tenant-a', ref, now)])
    ).rejects.toThrow();
    expect(count(fixture, 'log_iceberg_outbox')).toBe(0);
    expect(queue).not.toHaveBeenCalled();
  });

  it('does not submit expired events and does not repeat a confirmed ingestion', async () => {
    const port = pipeline();
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord('expired', now)],
    });
    expect(await consumeLogIcebergMessage(sent[0], env, now)).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect(await consumeLogIcebergMessage(sent[0], env, now + 10000)).toBe(true);
    expect(stream).not.toHaveBeenCalled();
  });
  it('does not mark ingestion complete when Stream acceptance fails', async () => {
    const port = pipeline();
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    stream.mockRejectedValueOnce(new Error('stream unavailable'));
    await expect(consumeLogIcebergMessage(sent[0], env, now)).rejects.toThrow('stream unavailable');
    expect(fixture.db.prepare('SELECT state FROM log_iceberg_outbox').get()?.state).toBe('queued');
    const unknown = fixture.db
      .prepare(
        'SELECT stream_obligation_at,stream_attempt_count,stream_acknowledged_at FROM log_iceberg_outbox'
      )
      .get();
    expect(typeof unknown?.stream_obligation_at).toBe('number');
    expect(unknown?.stream_attempt_count).toBe(1);
    expect(unknown?.stream_acknowledged_at).toBeNull();
    expect(await consumeLogIcebergMessage(sent[0], env, now)).toBe(true);
    const accepted = fixture.db
      .prepare(
        'SELECT stream_obligation_at,stream_attempt_count,stream_acknowledged_at FROM log_iceberg_outbox'
      )
      .get();
    expect(accepted?.stream_obligation_at).toBe(unknown?.stream_obligation_at);
    expect(accepted?.stream_attempt_count).toBe(2);
    expect(typeof accepted?.stream_acknowledged_at).toBe('number');
  });
  it('persists possible Stream acceptance before a concurrent erasure and keeps the witness afterward', async () => {
    const port = pipeline();
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord('pii-race', now + 1000, now, true)],
    });
    stream.mockImplementationOnce(async () => {
      const obligation = fixture.db
        .prepare(
          'SELECT stream_obligation_at,stream_attempt_count,stream_acknowledged_at FROM log_iceberg_outbox'
        )
        .get();
      expect(typeof obligation?.stream_obligation_at).toBe('number');
      expect(obligation?.stream_attempt_count).toBe(1);
      expect(obligation?.stream_acknowledged_at).toBeNull();
      fixture.db.exec("UPDATE log_iceberg_outbox SET state='erased'");
    });
    expect(await consumeLogIcebergMessage(sent[0], env, now)).toBe(true);
    const erased = fixture.db
      .prepare(
        'SELECT state,stream_obligation_at,stream_attempt_count,stream_acknowledged_at FROM log_iceberg_outbox'
      )
      .get();
    expect(erased?.state).toBe('erased');
    expect(erased?.stream_attempt_count).toBe(1);
    expect(typeof erased?.stream_acknowledged_at).toBe('number');
  });
  it('does not send when the erasure deny wins immediately before the obligation CAS', async () => {
    const port = pipeline();
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord('pii-deny', now + 1000, now, true)],
    });
    const execute = fixture.adapter.execute.bind(fixture.adapter);
    fixture.adapter.execute = async (sql, params) => {
      if (sql.includes('SET stream_obligation_at='))
        fixture.db
          .prepare(
            "INSERT INTO log_iceberg_subject_erasures(id,tenant_id,tenant_key,source_dataset,subject_id,state,created_at,updated_at) VALUES('deny','tenant-a','key-a','pii.pii_log','008fdf61-b30f-4b8a-97a5-16b9c5c8bdbd','pending',?,?)"
          )
          .run(now, now);
      return execute(sql, params);
    };
    expect(await consumeLogIcebergMessage(sent[0], env, now)).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect(
      fixture.db.prepare('SELECT stream_attempt_count FROM log_iceberg_outbox').get()
        ?.stream_attempt_count
    ).toBe(0);
  });
  it('validates an already queued old-master payload after actual current-master rotation', async () => {
    const port = pipeline();
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    env.OBJECT_ENCRYPTION_ROOT_KEY = 'ef'.repeat(32);
    env.OBJECT_ENCRYPTION_KEY_VERSION = '2';
    env.LOG_ARCHIVE_ROOT_KEYRING = JSON.stringify({
      schema_version: 1,
      current_version: 2,
      roots: { 1: keys.rootKeyHex, 2: env.OBJECT_ENCRYPTION_ROOT_KEY },
    });
    expect(await consumeLogIcebergMessage(sent[0], env, now)).toBe(true);
    expect(stream).toHaveBeenCalledOnce();
  });
  it('never sends a queued payload with unknown or wrong retained master material', async () => {
    const port = pipeline();
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    env.OBJECT_ENCRYPTION_ROOT_KEY = 'ef'.repeat(32);
    env.OBJECT_ENCRYPTION_KEY_VERSION = '2';
    for (const roots of [
      { 2: env.OBJECT_ENCRYPTION_ROOT_KEY },
      { 1: '00'.repeat(32), 2: env.OBJECT_ENCRYPTION_ROOT_KEY },
    ]) {
      env.LOG_ARCHIVE_ROOT_KEYRING = JSON.stringify({
        schema_version: 1,
        current_version: 2,
        roots,
      });
      await expect(consumeLogIcebergMessage(sent[0], env, now)).rejects.toThrow();
    }
    expect(stream).not.toHaveBeenCalled();
    expect(fixture.db.prepare('SELECT state FROM log_iceberg_outbox').get()?.state).toBe('queued');
  });
  it('restricts platform writes to Management and uses only its existing environment admission', async () => {
    const port = pipeline();
    env.AUTHRIM_ENVIRONMENT_NAME = 'test';
    env.AUTHRIM_WORKER_SCRIPT_NAME = 'test-ar-auth';
    await expect(
      port.writeRecords({
        tenantId: 'platform',
        storageGeneration: base.generation,
        records: [await makeRecord()],
      })
    ).rejects.toThrow('log_iceberg_platform_writer_denied');
    expect(bucket.put).not.toHaveBeenCalled();
    env.AUTHRIM_WORKER_SCRIPT_NAME = 'test-ar-management';
    const acquire = vi.fn(async () => ({ admitted: true })),
      complete = vi.fn(async () => {});
    env.CONTROL = {
      acquireEnvironmentBackupMutationPermit: acquire,
      completeEnvironmentBackupMutationPermit: complete,
    } as unknown as NonNullable<LogIcebergRuntimeEnv['CONTROL']>;
    const binding = vi.fn(async () => {
      throw new Error('Core tenant port must not receive platform data');
    });
    env.LOG_ARCHIVE_WRITER = { ...port, writeRecords: binding };
    await emitLogIcebergRow(env, {
      tenantId: 'platform',
      sourceDataset: 'admin.admin_audit_log',
      logType: 'admin_audit',
      eventAt: now,
      ingestedAt: now,
      expiresAt: null,
      row: { id: 'platform-event', tenant_id: 'platform', action: 'platform.configure' },
    });
    expect(binding).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(
      fixture.db.prepare('SELECT tenant_id,state FROM log_iceberg_outbox').get()
    ).toMatchObject({ tenant_id: 'platform', state: 'queued' });
    expect(
      fixture.db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE id='platform'").get()?.n
    ).toBe(0);
  });

  it('rejects cross-tenant, wrong-generation and altered ciphertext before writing anywhere', async () => {
    const port = pipeline();
    const record = await makeRecord();
    for (const request of [
      { tenantId: 'tenant-b', storageGeneration: base.generation, records: [record] },
      { tenantId: 'tenant-a', storageGeneration: 'other-generation', records: [record] },
      {
        tenantId: 'tenant-a',
        storageGeneration: base.generation,
        records: [{ ...record, detail_ciphertext: 'plaintext' }],
      },
    ])
      await expect(port.writeRecords(request)).rejects.toThrow();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(count(fixture, 'log_iceberg_outbox')).toBe(0);
  });
  it('rejects a tampered retry object and unknown generation without sending to Stream', async () => {
    const port = pipeline();
    await port.writeRecords({
      tenantId: 'tenant-a',
      storageGeneration: base.generation,
      records: [await makeRecord()],
    });
    const saved = bucket.objects.get(sent[0].payload_key);
    if (!saved) throw new Error('missing fixture retry object');
    saved.text = saved.text.replace('event-1', 'event-2');
    await expect(consumeLogIcebergMessage(sent[0], env, now)).rejects.toThrow();
    await expect(
      consumeLogIcebergMessage({ ...sent[0], storage_generation: 'other-generation' }, env, now)
    ).rejects.toThrow();
    expect(stream).not.toHaveBeenCalled();
  });
});

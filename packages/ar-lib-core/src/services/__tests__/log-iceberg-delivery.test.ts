import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchLogIcebergOutboxPage } from '../log-iceberg-delivery';
import {
  createLogIcebergWritePort,
  logIcebergOutboxStatement,
  type LogIcebergRuntimeEnv,
  type LogIcebergQueueReference,
} from '../log-iceberg-runtime';
import { icebergFixture } from './log-iceberg-test-fixture';

describe('metadata-only Pipeline crash recovery (real SQL)', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>;
  beforeEach(async () => {
    f = await icebergFixture();
    Object.assign(f.adapter, {
      transaction: async () => {
        throw new Error('use batch');
      },
      isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
      getType: () => 'd1',
      close: async () => {},
    });
    f.db
      .prepare(
        'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at)VALUES(?,?,?,?,?,?)'
      )
      .run('tenant-a', 'tenant-a', 'key-a', 'Tenant', f.now, f.now);
  });
  afterEach(() => f.db.close());
  const fixture = () => {
    const config = {
      ...f.config,
      mode: 'pipeline' as const,
      dbRetentionDays: null,
      exportIntervalMinutes: null,
    };
    const objects = new Map<string, string>();
    const metadata = new Map<string, Record<string, string>>();
    const put = vi.fn(
      async (key: string, body: string, options: { customMetadata?: Record<string, string> }) => {
        if (objects.has(key)) return null;
        objects.set(key, body);
        metadata.set(key, options.customMetadata ?? {});
        return { key };
      }
    );
    const head = vi.fn(async (key: string) =>
      objects.has(key)
        ? {
            size: new TextEncoder().encode(objects.get(key)).byteLength,
            customMetadata: metadata.get(key),
          }
        : null
    );
    const get = vi.fn(async () => {
      throw new Error('unexpected body read during metadata recovery');
    });
    const queue = vi.fn<(body: unknown) => Promise<void>>().mockResolvedValue(undefined);
    const env: LogIcebergRuntimeEnv = {
      DB: f.adapter,
      DB_ADMIN: f.adapter,
      LOG_ARCHIVE: { put, get, head } as unknown as R2Bucket,
      LOGGING_DELIVERY_QUEUE: { send: queue } as unknown as NonNullable<
        LogIcebergRuntimeEnv['LOGGING_DELIVERY_QUEUE']
      >,
      OBJECT_ENCRYPTION_ROOT_KEY: f.keys.rootKeyHex,
      LOG_ARCHIVE_CONTENT_HMAC_KEY: f.keys.contentHmacKeyHex,
      LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
        schema_version: 1,
        current_version: 1,
        roots: { 1: f.keys.rootKeyHex },
      }),
    };
    const writer = createLogIcebergWritePort(env, config);
    return {
      config,
      objects,
      put,
      get,
      queue,
      writer,
      ports: {
        admin: f.adapter,
        dispatch: (input: { tenantId: string; references: LogIcebergQueueReference[] }) =>
          writer.dispatchPipelineReferences(input),
      },
    };
  };
  it('recovers an atomic business commit that crashed before dispatch without recreating or reading the body', async () => {
    const p = fixture();
    const record = await f.record();
    const references = await p.writer.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: p.config.generation,
      records: [record],
    });
    f.db.exec('CREATE TABLE business_mutation(id TEXT PRIMARY KEY)');
    await f.adapter.batch([
      { sql: 'INSERT INTO business_mutation VALUES(?)', params: ['committed'] },
      ...references.map((ref) => logIcebergOutboxStatement('tenant-a', ref, f.now)),
    ]);
    expect(p.queue).not.toHaveBeenCalled();
    expect(p.objects.size).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM business_mutation').get()?.n).toBe(1);
    expect(await dispatchLogIcebergOutboxPage(p.config, p.ports)).toMatchObject({
      leased: true,
      queued: 1,
      failed: 0,
    });
    expect(p.queue).toHaveBeenCalledWith(references[0]);
    expect(p.put).toHaveBeenCalledTimes(1);
    expect(p.get).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT state FROM log_iceberg_outbox').get()?.state).toBe('queued');
  });
  it('never scans or dispatches preparing intents from an abandoned business operation', async () => {
    const p = fixture();
    const references = await p.writer.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: p.config.generation,
      records: [await f.record()],
    });
    expect(references).toHaveLength(1);
    await expect(
      f.adapter.batch([
        logIcebergOutboxStatement('tenant-a', references[0], f.now),
        { sql: 'INSERT INTO absent_business_table VALUES(1)' },
      ])
    ).rejects.toThrow();
    expect(f.db.prepare('SELECT state FROM log_iceberg_outbox').get()?.state).toBe('preparing');
    expect(await dispatchLogIcebergOutboxPage(p.config, p.ports)).toMatchObject({
      queued: 0,
      failed: 0,
    });
    expect(p.queue).not.toHaveBeenCalled();
  });

  it('recovers queue.send failure using the original durable pointer', async () => {
    const p = fixture();
    p.queue.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(
      p.writer.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: p.config.generation,
        records: [await f.record()],
      })
    ).rejects.toThrow('queue unavailable');
    const saved = f.db
      .prepare('SELECT payload_key,payload_digest,state FROM log_iceberg_outbox')
      .get();
    expect(saved?.state).toBe('pending');
    expect((await dispatchLogIcebergOutboxPage(p.config, p.ports)).queued).toBe(1);
    const after = f.db.prepare('SELECT payload_key,payload_digest FROM log_iceberg_outbox').get();
    expect(after?.payload_key).toBe(saved?.payload_key);
    expect(after?.payload_digest).toBe(saved?.payload_digest);
    expect(p.put).toHaveBeenCalledTimes(1);
    expect(p.get).not.toHaveBeenCalled();
  });
  it('backs off failed retries and excludes terminal erased/ingested pointers', async () => {
    const p = fixture();
    const refs = await p.writer.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: p.config.generation,
      records: [await f.record()],
    });
    await f.adapter.batch(refs.map((ref) => logIcebergOutboxStatement('tenant-a', ref, f.now)));
    p.queue.mockRejectedValueOnce(new Error('queue unavailable'));
    expect((await dispatchLogIcebergOutboxPage(p.config, p.ports)).failed).toBe(1);
    expect(f.db.prepare('SELECT attempt_count FROM log_iceberg_outbox').get()?.attempt_count).toBe(
      1
    );
    expect((await dispatchLogIcebergOutboxPage(p.config, p.ports)).queued).toBe(0);
    expect(p.queue).toHaveBeenCalledTimes(1);
    f.db.exec("UPDATE log_iceberg_outbox SET next_attempt_at=0,state='erased',payload_erased_at=1");
    expect((await dispatchLogIcebergOutboxPage(p.config, p.ports)).queued).toBe(0);
    expect(p.queue).toHaveBeenCalledTimes(1);
  });
  it('does not mutate a frozen tenant or touch scheduled-mode source data', async () => {
    const p = fixture();
    const refs = await p.writer.preparePipelineReferences({
      tenantId: 'tenant-a',
      storageGeneration: p.config.generation,
      records: [await f.record()],
    });
    await f.adapter.batch(refs.map((ref) => logIcebergOutboxStatement('tenant-a', ref, f.now)));
    const before = f.db.prepare('SELECT * FROM log_iceberg_outbox').get();
    const denied = {
      ...p.ports,
      coverTenant: async <T>(_tenant: string, _run: () => Promise<T>): Promise<T> => {
        throw new Error('backup_mutation_unavailable');
      },
    };
    expect((await dispatchLogIcebergOutboxPage(p.config, denied)).failed).toBe(1);
    expect(f.db.prepare('SELECT * FROM log_iceberg_outbox').get()).toEqual(before);
    expect(p.queue).not.toHaveBeenCalled();
    const query = vi.spyOn(f.adapter, 'query');
    expect(await dispatchLogIcebergOutboxPage(f.config, p.ports)).toEqual({
      leased: false,
      queued: 0,
      failed: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });
});

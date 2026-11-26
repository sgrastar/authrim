import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logArchivePhysicalFingerprint } from '@authrim/ar-lib-logging/iceberg';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import { pipelineMetadata } from '../../../../ar-lib-logging/src/iceberg/__tests__/fixtures';
import { icebergFixture } from './log-iceberg-test-fixture';
import {
  LOG_ICEBERG_INTENT_ABANDONED_CODE,
  LOG_ICEBERG_INTENT_ORPHAN_AFTER_MS,
  logIcebergAbandonedIntentSql,
  logIcebergOrphanIntentSql,
  reclaimLogIcebergOrphanIntents,
  type LogIcebergIntentReclaimPorts,
} from '../log-iceberg-intent-reclaim';
import { logIcebergDigest, logIcebergRecordId } from '../log-iceberg-store';
import { logIcebergOutboxIntentStatement } from '../log-iceberg-runtime';
import { isLogIcebergRetryErasureMarker } from '../log-iceberg-retry-marker';

const HOUR = 60 * 60 * 1000;

describe('orphaned outbox intent reclaim', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>;
  let ports: LogIcebergIntentReclaimPorts;
  let objects: Map<string, { bytes: Uint8Array; metadata: Record<string, string>; etag: string }>;
  let abandoned: Parameters<LogIcebergIntentReclaimPorts['reportAbandoned']>[0][];
  let capturing: Set<string>;
  let dbNow: number;
  let etag = 0;

  beforeEach(async () => {
    f = await icebergFixture();
    f.catalog.metadata = pipelineMetadata();
    f.config = {
      ...f.config,
      mode: 'pipeline',
      dbRetentionDays: null,
      exportIntervalMinutes: null,
      physicalFingerprint: await logArchivePhysicalFingerprint(f.catalog.metadata),
    };
    dbNow = Number(f.db.prepare("SELECT CAST(strftime('%s','now') AS INTEGER)*1000 AS n").get()?.n);
    objects = new Map();
    abandoned = [];
    capturing = new Set();
    ports = {
      admin: f.ports.admin,
      objects: {
        async head(key: string) {
          const o = objects.get(key);
          return o
            ? ({ size: o.bytes.length, etag: o.etag, customMetadata: o.metadata } as R2Object)
            : null;
        },
        async put(
          key: string,
          body: Uint8Array,
          options: {
            onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
            customMetadata?: Record<string, string>;
          }
        ) {
          const previous = objects.get(key);
          if (
            options.onlyIf?.etagMatches !== undefined &&
            previous?.etag !== options.onlyIf.etagMatches
          )
            return null;
          if (options.onlyIf?.etagDoesNotMatch === '*' && previous) return null;
          objects.set(key, {
            bytes: body,
            metadata: options.customMetadata ?? {},
            etag: String(++etag),
          });
          return { key } as R2Object;
        },
      } as unknown as Pick<R2Bucket, 'head' | 'put'>,
      resolveTenantKey: async (tenantId) => `key-${tenantId}`,
      capturingTenantKeys: async () => capturing,
      coverTenant: async (_id, run) => run(),
      reportAbandoned: async (row) => {
        abandoned.push(row);
      },
    };
  });
  afterEach(() => {
    f.db.close();
  });

  /** An intent as the writer leaves it before its PUT (no digest) or after it (digest set). */
  async function orphan(
    record: LogArchiveRecord,
    options: {
      ageMs?: number;
      uploaded?: boolean;
      recordedDigest?: boolean;
      publicationId?: string | null;
      tenantId?: string;
      expiresAt?: number | null;
      acknowledged?: boolean;
    } = {}
  ) {
    const id = await logIcebergRecordId(record),
      key = `_authrim_retry/iceberg/v1/${f.config.generation}/${id}.json`;
    const text = JSON.stringify(record),
      digest = await logIcebergDigest(text),
      bytes = new TextEncoder().encode(text);
    if (options.uploaded ?? true)
      objects.set(key, {
        bytes,
        etag: 'original',
        metadata: {
          authrim_record_id: id,
          authrim_storage_generation: f.config.generation,
          authrim_payload_hmac: record.payload_hmac,
          authrim_payload_sha256: digest,
        },
      });
    const at = dbNow - (options.ageMs ?? 2 * HOUR);
    if (options.publicationId)
      f.db
        .prepare(
          `INSERT INTO log_iceberg_publications(id,tenant_id,storage_generation,record_id,source_dataset,payload_hmac,mode,source_json,source_digest,source_token,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'pipeline','{}','${'d'.repeat(64)}','token','prepared',?,?)`
        )
        .run(
          options.publicationId,
          options.tenantId ?? 'tenant-a',
          f.config.generation,
          id,
          record.source_dataset,
          record.payload_hmac,
          at,
          at
        );
    f.db
      .prepare(
        `INSERT INTO log_iceberg_outbox(id,publication_id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,created_at,updated_at,last_error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,'preparing',?,?,?)`
      )
      .run(
        id,
        options.publicationId ?? null,
        options.tenantId ?? 'tenant-a',
        f.config.generation,
        record.source_dataset,
        null,
        record.payload_hmac,
        key,
        options.recordedDigest === false ? null : digest,
        options.recordedDigest === false ? null : bytes.length,
        options.expiresAt === undefined ? record.expires_at : options.expiresAt,
        at,
        at,
        options.acknowledged ? LOG_ICEBERG_INTENT_ABANDONED_CODE : null
      );
    return { id, key, record };
  }
  const state = (id: string) =>
    f.db
      .prepare(
        'SELECT state,payload_digest,payload_erased_at,last_error_code,next_attempt_at FROM log_iceberg_outbox WHERE id=?'
      )
      .get(id) as {
      state: string;
      payload_digest: string | null;
      payload_erased_at: number | null;
      last_error_code: string | null;
      next_attempt_at: number;
    };
  const intentOf = (
    o: { id: string; key: string; record: LogArchiveRecord },
    expiresAt: number | null = o.record.expires_at
  ) =>
    logIcebergOutboxIntentStatement(
      'tenant-a',
      {
        payload_type: 'iceberg_ingest',
        schema_version: 1,
        id: o.id,
        storage_generation: f.config.generation,
        source_dataset: o.record.source_dataset,
        subject_id: null,
        payload_hmac: o.record.payload_hmac,
        payload_key: o.key,
        expires_at: expiresAt,
      },
      dbNow
    );
  const run = (options?: Parameters<typeof reclaimLogIcebergOrphanIntents>[2]) =>
    reclaimLogIcebergOrphanIntents(f.config, ports, options);
  const nothing = { leased: true, abandoned: 0, retired: 0, retained: 0, failed: 0 };

  it('acknowledges an orphan: marked, reported, untouched otherwise', async () => {
    const o = await orphan(await f.record());
    expect(await run()).toEqual({ ...nothing, abandoned: 1 });
    expect(state(o.id)).toMatchObject({
      state: 'preparing',
      payload_erased_at: null,
      last_error_code: LOG_ICEBERG_INTENT_ABANDONED_CODE,
    });
    expect(state(o.id).payload_digest).not.toBeNull();
    expect(objects.get(o.key)?.bytes.length).toBeGreaterThan(0);
    expect(abandoned).toEqual([
      {
        tenantId: 'tenant-a',
        recordId: o.id,
        sourceDataset: o.record.source_dataset,
        createdAt: expect.any(Number) as number,
      },
    ]);
    // Acknowledged once: a second run has nothing to say.
    expect(await run()).toEqual(nothing);
    expect(abandoned).toHaveLength(1);
  });

  it('acknowledges an orphan whose envelope never reached R2 the same way', async () => {
    const o = await orphan(await f.record(), { uploaded: false, recordedDigest: false });
    expect((await run()).abandoned).toBe(1);
    expect(state(o.id)).toMatchObject({ state: 'preparing', payload_digest: null });
  });

  it('leaves young intents, publication-backed intents and other states alone', async () => {
    const young = await orphan(await f.record('young'), { ageMs: 10 * 60 * 1000 });
    const backed = await orphan(await f.record('backed'), { publicationId: 'pub-1' });
    const old = await orphan(await f.record('old'));
    f.db.prepare("UPDATE log_iceberg_outbox SET state='pending' WHERE id=?").run(old.id);
    expect(await run()).toEqual(nothing);
    expect(state(young.id).last_error_code).toBeNull();
    expect(state(backed.id).last_error_code).toBeNull();
    expect(state(old.id).state).toBe('pending');
    expect(LOG_ICEBERG_INTENT_ORPHAN_AFTER_MS).toBe(HOUR);
  });

  it('leaves an intent a writer retried after it was selected', async () => {
    const o = await orphan(await f.record());
    // The writer's retry (its own intent statement) runs between this run's SELECT and UPDATE.
    ports.capturingTenantKeys = async () => {
      const retry = intentOf(o);
      await f.ports.admin.execute(retry.sql, retry.params);
      return capturing;
    };
    expect(await run()).toEqual({ ...nothing, retained: 1 });
    expect(state(o.id).last_error_code).toBeNull();
    // And a retry that landed before the run keeps the row out of the page altogether.
    ports.capturingTenantKeys = async () => capturing;
    f.db.exec('UPDATE log_iceberg_outbox SET next_attempt_at=0');
    expect(await run()).toEqual(nothing);
  });

  it('lets a producer that comes back clear the acknowledgement and continue', async () => {
    const o = await orphan(await f.record());
    expect((await run()).abandoned).toBe(1);
    const retry = intentOf(o);
    await f.ports.admin.execute(retry.sql, retry.params);
    expect(state(o.id)).toMatchObject({
      state: 'preparing',
      last_error_code: null,
      next_attempt_at: 0,
    });
    // Fresh again: not an orphan for another hour.
    expect(await run()).toEqual(nothing);
  });

  it('retires an acknowledged intent once its retention has run out, and not before', async () => {
    const live = await orphan(await f.record('live'), {
      acknowledged: true,
      expiresAt: dbNow + 30 * 24 * HOUR,
    });
    const gone = await orphan(await f.record('gone'), { acknowledged: true, expiresAt: dbNow - 1 });
    expect(await run()).toEqual({ ...nothing, retired: 1 });
    expect(state(live.id)).toMatchObject({ state: 'preparing', payload_erased_at: null });
    expect(state(gone.id)).toMatchObject({ state: 'erased', last_error_code: null });
    expect(typeof state(gone.id).payload_erased_at).toBe('number');
    expect(isLogIcebergRetryErasureMarker(await ports.objects.head(gone.key), gone.id)).toBe(true);
    expect(objects.get(gone.key)?.bytes.length).toBe(0);
    // An erased row is not revived by a returning producer.
    const retry = intentOf(gone, dbNow - 1);
    await f.ports.admin.execute(retry.sql, retry.params);
    expect(state(gone.id).state).toBe('erased');
    expect(abandoned).toEqual([]);
  });

  it('keeps the acknowledgement when the retirement fails, and retries later', async () => {
    const o = await orphan(await f.record(), { acknowledged: true, expiresAt: dbNow - 1 });
    const bucket = ports.objects;
    ports.objects = {
      head: (k: string) => bucket.head(k),
      put: async () => {
        throw new Error('r2_unavailable');
      },
    };
    expect(await run()).toEqual({ ...nothing, failed: 1 });
    // Final for a returning writer, not yet fenced: cleanup's `erased` page or the next run.
    expect(state(o.id)).toMatchObject({
      state: 'erased',
      payload_erased_at: null,
      last_error_code: LOG_ICEBERG_INTENT_ABANDONED_CODE,
    });
    expect(state(o.id).next_attempt_at).toBeGreaterThan(dbNow);
    expect(objects.get(o.key)?.bytes.length).toBeGreaterThan(0);
  });

  it('leaves a capturing tenant alone and moves on to the next tenant in the same run', async () => {
    const a = await orphan(await f.record('a'));
    const b = await orphan(await f.record('b'), { tenantId: 'tenant-b' });
    capturing.add('key-tenant-a');
    expect(await run()).toEqual({ ...nothing, abandoned: 1, retained: 1 });
    expect(state(a.id).last_error_code).toBeNull();
    expect(state(a.id).next_attempt_at).toBeGreaterThan(dbNow);
    expect(state(b.id).last_error_code).toBe(LOG_ICEBERG_INTENT_ABANDONED_CODE);
    // Backed off: the next run does not spend its page on the same row.
    expect(await run()).toEqual(nothing);
  });

  it('restricts a tenant-scoped run to that tenant', async () => {
    const a = await orphan(await f.record('a'));
    const b = await orphan(await f.record('b'), { tenantId: 'tenant-b' });
    expect((await run({ tenantId: 'tenant-b' })).abandoned).toBe(1);
    expect(state(a.id).last_error_code).toBeNull();
    expect(state(b.id).last_error_code).toBe(LOG_ICEBERG_INTENT_ABANDONED_CODE);
  });

  it('does not count or touch an intent a pending restore owns', async () => {
    const o = await orphan(await f.record());
    f.db
      .prepare(
        `INSERT INTO log_iceberg_restore_activations(id,tenant_id,storage_generation,plan_digest,state,created_at) VALUES('op-1','tenant-a',?,'${'a'.repeat(64)}','pending',?)`
      )
      .run(f.config.generation, dbNow);
    f.db
      .prepare(
        `INSERT INTO log_iceberg_restore_holds(id,operation_id,tenant_id,storage_generation,payload_hmac,state,created_at) VALUES(?,'op-1','tenant-a',?,?,'holding',?)`
      )
      .run(o.id, f.config.generation, o.record.payload_hmac, dbNow);
    expect(await run()).toEqual(nothing);
    expect(state(o.id).last_error_code).toBeNull();
  });

  it('has NULL-safe predicates: an ordinary intent is neither orphaned nor abandoned, and NOT says so', async () => {
    const young = await orphan(await f.record('young'), { ageMs: 60_000 });
    const old = await orphan(await f.record('old'));
    const acked = await orphan(await f.record('acked'), { acknowledged: true });
    const rows = (sql: string) =>
      (
        f.db.prepare(`SELECT id FROM log_iceberg_outbox WHERE ${sql} ORDER BY id`).all() as {
          id: string;
        }[]
      ).map((r) => r.id);
    const cutoff = `${dbNow - HOUR}`;
    expect(rows(`NOT ${logIcebergAbandonedIntentSql()}`).sort()).toEqual([young.id, old.id].sort());
    expect(rows(logIcebergAbandonedIntentSql())).toEqual([acked.id]);
    expect(rows(logIcebergOrphanIntentSql('log_iceberg_outbox', cutoff))).toEqual([old.id]);
    expect(rows(`NOT ${logIcebergOrphanIntentSql('log_iceberg_outbox', cutoff)}`).sort()).toEqual(
      [young.id, acked.id].sort()
    );
  });

  it('does nothing outside pipeline mode', async () => {
    await orphan(await f.record());
    f.config = { ...f.config, mode: 'scheduled' };
    expect(await run()).toEqual({ ...nothing, leased: false });
  });
});

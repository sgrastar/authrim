import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { prepareAppend, stageSnapshotForAppend } from 'icebird/src/write/stage.js';
import { logArchivePhysicalFingerprint } from '@authrim/ar-lib-logging/iceberg';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import { pipelineMetadata } from '../../../../ar-lib-logging/src/iceberg/__tests__/fixtures';
import { icebergFixture } from './log-iceberg-test-fixture';
import {
  cleanupLogIcebergRetryPage,
  type LogIcebergRetryCleanupPorts,
} from '../log-iceberg-retry-cleanup';
import { readLogIcebergRetryPayload } from '../log-iceberg-runtime';
import { decryptLogIcebergRecord } from '../log-iceberg-record';
import { logIcebergDigest, logIcebergRecordId } from '../log-iceberg-store';
import { isLogIcebergRetryErasureMarker } from '../log-iceberg-retry-marker';

describe('bounded retry body cleanup', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>;
  let ports: LogIcebergRetryCleanupPorts;
  let objects: Map<string, { bytes: Uint8Array; metadata: Record<string, string>; etag: string }>;
  let bucket: R2Bucket;
  let capturing: Set<string>;
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
    objects = new Map();
    capturing = new Set();
    let etag = 0;
    bucket = {
      async head(key: string) {
        const o = objects.get(key);
        return o ? { size: o.bytes.length, etag: o.etag, customMetadata: o.metadata } : null;
      },
      async get(key: string) {
        const o = objects.get(key);
        return o
          ? {
              size: o.bytes.length,
              etag: o.etag,
              customMetadata: o.metadata,
              body: new ReadableStream({
                start(c) {
                  c.enqueue(o.bytes);
                  c.close();
                },
              }),
            }
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
        return { key };
      },
    } as unknown as R2Bucket;
    ports = {
      ...f.ports,
      objects: bucket,
      resolveTenantKey: async () => 'key-a',
      readPayload: (ref) => readLogIcebergRetryPayload({ LOG_ARCHIVE: bucket }, ref),
      authenticate: async (record, tenantKey) => {
        await decryptLogIcebergRecord(
          record,
          { tenantKey, sourceDataset: record.source_dataset },
          async () => f.keys
        );
      },
      capturingTenantKeys: async () => capturing,
      coverTenant: async (_id, run) => run(),
    };
  });
  afterEach(() => {
    f.db.close();
    vi.restoreAllMocks();
  });
  async function append(record: LogArchiveRecord) {
    const resolver = {
      writer(path: string) {
        const w = new ByteWriter();
        return Object.assign(w, { finish: () => f.store.putImmutable(path, w.getBytes(), path) });
      },
    };
    const prepared = await prepareAppend({
      tableUrl: f.catalog.metadata.location,
      metadata: f.catalog.metadata,
      resolver,
      records: [
        {
          ...record,
          event_at: BigInt(record.event_at),
          ingested_at: BigInt(record.ingested_at),
          expires_at: record.expires_at === null ? null : BigInt(record.expires_at),
          __ingest_ts: new Date(record.ingested_at),
        },
      ],
    });
    await f.catalog.commit(
      await stageSnapshotForAppend({
        tableUrl: f.catalog.metadata.location,
        metadata: f.catalog.metadata,
        resolver,
        prepared,
      })
    );
  }
  async function stage(
    record: LogArchiveRecord,
    state = 'ingested',
    publicationId: string | null = null
  ) {
    const id = await logIcebergRecordId(record),
      key = `_authrim_retry/iceberg/v1/${f.config.generation}/${id}.json`;
    const body = new TextEncoder().encode(JSON.stringify(record)),
      digest = await logIcebergDigest(JSON.stringify(record));
    objects.set(key, {
      bytes: body,
      etag: 'original',
      metadata: {
        authrim_record_id: id,
        authrim_storage_generation: f.config.generation,
        authrim_payload_hmac: record.payload_hmac,
        authrim_payload_sha256: digest,
      },
    });
    f.db
      .prepare(
        `INSERT INTO log_iceberg_outbox(id,publication_id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,created_at,updated_at) VALUES(?,?,'tenant-a',?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        publicationId,
        f.config.generation,
        record.source_dataset,
        null,
        record.payload_hmac,
        key,
        digest,
        body.length,
        record.expires_at,
        state,
        f.now,
        f.now
      );
    return { id, key };
  }
  const run = () => cleanupLogIcebergRetryPage(f.config, ports);
  it('requires exact fixed-snapshot visibility before retiring an unexpired ingested envelope', async () => {
    const record = await f.record();
    const { id, key } = await stage(record);
    await append(record);
    expect(await run()).toEqual({ leased: true, retired: 1, retained: 0, failed: 0 });
    expect(isLogIcebergRetryErasureMarker(await bucket.head(key), id)).toBe(true);
    const saved = f.db
      .prepare('SELECT state,payload_erased_at FROM log_iceberg_outbox WHERE id=?')
      .get(id);
    expect(saved?.state).toBe('erased');
    expect(typeof saved?.payload_erased_at).toBe('number');
    expect((await run()).retired).toBe(0);
  });
  it('retains unexpired bodies when the Stream row is not visible or has a different envelope', async () => {
    const record = await f.record();
    const { id, key } = await stage(record);
    expect((await run()).failed).toBe(1);
    expect(objects.get(key)?.bytes.length).toBeGreaterThan(0);
    expect(f.db.prepare('SELECT state FROM log_iceberg_outbox WHERE id=?').get(id)?.state).toBe(
      'ingested'
    );
    const different = await f.record('event-1', { row: { metadata_json: '{"changed":true}' } });
    await append(different);
    f.db.exec('UPDATE log_iceberg_outbox SET next_attempt_at=0');
    expect((await run()).failed).toBe(1);
    expect(objects.get(key)?.bytes.length).toBeGreaterThan(0);
  });
  it('uses the authenticated original expiry and database clock, including expiry zero, without requiring a never-sent row', async () => {
    const cutoff = Number(
      f.db.prepare("SELECT CAST(strftime('%s','now') AS INTEGER)*1000 AS n").get()?.n
    );
    for (const [id, expiry] of [
      ['zero', 0],
      ['boundary', cutoff],
    ] as const) {
      const record = await f.record(id, { expiresAt: expiry });
      await stage(record);
    }
    ports.catalog = {
      loadTable: async () => {
        throw Error('must not load absent stream');
      },
      commit: async () => {
        throw Error('unused');
      },
    };
    expect(await run()).toEqual({ leased: true, retired: 2, retained: 0, failed: 0 });
    const future = await f.record('future', { expiresAt: cutoff + 86400000 });
    const { key } = await stage(future);
    vi.spyOn(Date, 'now').mockReturnValue(cutoff + 365 * 86400000);
    expect((await run()).failed).toBe(1);
    expect(objects.get(key)?.bytes.length).toBeGreaterThan(0);
  });
  it('rejects a forged changed expiry before deleting the source ciphertext', async () => {
    const record = await f.record();
    const { key } = await stage(record);
    const forged = { ...record, expires_at: 0 };
    const body = new TextEncoder().encode(JSON.stringify(forged)),
      digest = await logIcebergDigest(JSON.stringify(forged));
    const o = objects.get(key);
    if (!o) throw Error('fixture object missing');
    objects.set(key, {
      ...o,
      bytes: body,
      metadata: { ...o.metadata, authrim_payload_sha256: digest },
    });
    f.db
      .prepare('UPDATE log_iceberg_outbox SET expires_at=0,payload_digest=?,payload_bytes=?')
      .run(digest, body.length);
    expect((await run()).failed).toBe(1);
    expect(objects.get(key)?.bytes.length).toBeGreaterThan(0);
  });
  it('keeps capturing backup preimages and fails before a stale lease can mark an object', async () => {
    const record = await f.record('zero', { expiresAt: 0 });
    const { key } = await stage(record);
    capturing.add('key-a');
    expect((await run()).retained).toBe(1);
    expect(objects.get(key)?.bytes.length).toBeGreaterThan(0);
    capturing.clear();
    ports.authenticate = async () => {
      f.db.exec("UPDATE scheduled_task_leases SET lease_token='new-owner'");
    };
    await expect(run()).rejects.toThrow('stale_fence');
    expect(objects.get(key)?.bytes.length).toBeGreaterThan(0);
  });
  it('does not abort preparing work by age and retires only an authoritative aborted publication intent', async () => {
    const record = await f.record('preparing', { expiresAt: 0 });
    const staged = await stage(record, 'preparing');
    f.db.exec('UPDATE log_iceberg_outbox SET created_at=0');
    expect((await run()).retired).toBe(0);
    f.db
      .prepare(
        `INSERT INTO log_iceberg_publications(id,tenant_id,storage_generation,record_id,source_dataset,payload_hmac,mode,source_json,source_digest,source_token,state,created_at,updated_at) VALUES(?,'tenant-a',?,?,?,?,'pipeline','{}',?,'token','aborted',0,0)`
      )
      .run(
        'c'.repeat(64),
        f.config.generation,
        staged.id,
        record.source_dataset,
        record.payload_hmac,
        'd'.repeat(64)
      );
    f.db
      .prepare(
        'UPDATE log_iceberg_outbox SET publication_id=?,payload_digest=NULL,payload_bytes=NULL'
      )
      .run('c'.repeat(64));
    objects.delete(staged.key);
    expect((await run()).retired).toBe(1);
    expect(isLogIcebergRetryErasureMarker(await bucket.head(staged.key), staged.id)).toBe(true);
  });
});

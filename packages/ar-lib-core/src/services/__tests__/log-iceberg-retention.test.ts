import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  IcebergLifecycle,
  ScheduledIcebergWriter,
  type IcebergBatchCheckpoint,
  logArchivePhysicalFingerprint,
  readSnapshotRecords,
  advanceIcebergMainForGc,
  planSnapshotRowDeletePage,
} from '@authrim/ar-lib-logging/iceberg';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { prepareAppend, stageSnapshotForAppend } from 'icebird/src/write/stage.js';
import { icebergFixture } from './log-iceberg-test-fixture';
import {
  MemoryJournal,
  pipelineMetadata,
} from '../../../../ar-lib-logging/src/iceberg/__tests__/fixtures';
import {
  prepareLogIcebergRetentionScope,
  logIcebergRetentionScopeId,
} from '../log-iceberg-retention-scope';
import {
  retainLogIcebergScopePage,
  maintainLogIcebergMetadataPage,
} from '../log-iceberg-retention';
import type { LogIcebergPhysicalErasurePorts } from '../log-iceberg-physical-erasure';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import { logIcebergDigest, logIcebergRecordId } from '../log-iceberg-store';

describe('original log TTL and committed snapshot maintenance', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>, ports: LogIcebergPhysicalErasurePorts;
  let custom: Map<string, Record<string, string>>;
  beforeEach(async () => {
    f = await icebergFixture();
    custom = new Map();
    ports = {
      ...f.ports,
      capturingTenantKeys: async () => new Set(),
      objects: {
        async head(path) {
          const object = f.store.objects.get(path);
          return object
            ? {
                size: object.bytes.length,
                etag: object.identity + ':' + object.bytes.length,
                customMetadata: custom.get(path) ?? { authrim_identity: object.identity },
              }
            : null;
        },
        async delete(path) {
          f.store.objects.delete(path);
          custom.delete(path);
        },
        async markErased(path, etag) {
          const old = f.store.objects.get(path);
          if (etag !== null && (!old || old.identity + ':' + old.bytes.length !== etag)) return;
          if (etag === null && old) return;
          f.store.objects.set(path, { bytes: new Uint8Array(), identity: 'marker' });
          custom.set(path, {
            authrim_iceberg_gc_erased: '1',
            authrim_artifact_digest: await logIcebergDigest(path),
          });
        },
        async list(prefix, cursor) {
          const paths = [...f.store.objects.keys()]
            .filter((p) => p.startsWith(prefix) && (!cursor || p > cursor))
            .sort();
          return { paths: paths.slice(0, 32), ...(paths.length > 32 ? { cursor: paths[31] } : {}) };
        },
      },
    };
  });
  afterEach(() => f.db.close());
  const scope = { tenantId: 'tenant-a', tenantKey: 'key-a', sourceDataset: 'core.audit_log' };
  const lifecycle = () =>
    new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: f.catalog.metadata.location,
    });
  function sourcePath(): string {
    const path = [...f.store.objects.keys()].find((p) => p.endsWith('.parquet'));
    if (!path) throw Error('fixture source missing');
    return path;
  }
  async function append(records: LogArchiveRecord[]) {
    const resolver = {
      async reader(path: string) {
        const data = await f.store.read(path, 8 * 1024 * 1024);
        return {
          byteLength: data.length,
          slice: (start: number, end?: number) => Uint8Array.from(data.subarray(start, end)).buffer,
        };
      },
      writer(path: string) {
        const w = new ByteWriter();
        return Object.assign(w, { finish: () => f.store.putImmutable(path, w.getBytes(), path) });
      },
    };
    const prepared = await prepareAppend({
      tableUrl: f.catalog.metadata.location,
      metadata: f.catalog.metadata,
      resolver,
      records: records.map((r) => ({
        ...r,
        event_at: BigInt(r.event_at),
        ingested_at: BigInt(r.ingested_at),
        expires_at: r.expires_at === null ? null : BigInt(r.expires_at),
        ...(f.config.mode === 'pipeline' ? { __ingest_ts: new Date(r.ingested_at) } : {}),
      })),
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
  async function finish() {
    for (let i = 0; i < 180; i++) {
      const result = await retainLogIcebergScopePage(f.config, ports, scope);
      if (result.complete) return result;
    }
    throw Error(
      'TTL did not finish ' +
        JSON.stringify(
          f.db.prepare('SELECT mutation_receipt_json FROM log_iceberg_retention_jobs').get()
        )
    );
  }
  async function maintenance() {
    for (let i = 0; i < 300; i++) {
      const result = await maintainLogIcebergMetadataPage(f.config, ports);
      if (result.complete) return;
    }
    throw Error(
      'metadata GC did not finish ' +
        JSON.stringify(
          f.db
            .prepare(
              "SELECT mutation_receipt_json FROM log_iceberg_retention_jobs WHERE source_dataset='system.snapshot_gc'"
            )
            .get()
        )
    );
  }
  it.each(['scheduled', 'pipeline'] as const)(
    'expires only the original TTL in %s, preserving infinite and other-tenant rows',
    async (mode) => {
      if (mode === 'pipeline') {
        f.catalog.metadata = pipelineMetadata();
        f.config = {
          ...f.config,
          mode,
          dbRetentionDays: null,
          exportIntervalMinutes: null,
          physicalFingerprint: await logArchivePhysicalFingerprint(f.catalog.metadata),
        };
      }
      const expired = await f.record('expired', { expiresAt: 0 }),
        keep = await f.record('keep'),
        forever = await f.record('forever', { expiresAt: null }),
        foreign = await f.record('foreign', {
          tenantId: 'tenant-b',
          tenantKey: 'key-b',
          expiresAt: 0,
        });
      await append([expired, keep, forever, foreign]);
      const path = sourcePath();
      await finish();
      expect(f.store.objects.get(path)?.bytes.length ?? 0).toBe(0);
      const result = await readSnapshotRecords({
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'key-a',
        sourceDatasets: ['core.audit_log'],
        nowMs: Date.now(),
      });
      expect(result.records.map((r) => r.event_id).sort()).toEqual(['forever', 'keep']);
      const raw = await planSnapshotRowDeletePage(
        {
          table: await f.catalog.loadTable(),
          store: f.store,
          tenantKey: 'key-b',
          sourceDatasets: ['core.audit_log'],
          nowMs: Date.now(),
        },
        'expired'
      );
      expect(raw.deletes.map((r) => r.eventId)).toEqual(['foreign']);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_subject_erasures').get()?.n).toBe(
        0
      );
    }
  );
  it('registers exactly one maintenance scope under the same source business guard', async () => {
    await f.adapter.batch(
      await prepareLogIcebergRetentionScope(f.config, scope, { where: '0', params: [] })
    );
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_retention_jobs').get()?.n).toBe(0);
    const statements = await prepareLogIcebergRetentionScope(f.config, scope, {
      where: '?=1',
      params: [1],
    });
    await f.adapter.batch(statements);
    await f.adapter.batch(statements);
    expect(f.db.prepare('SELECT id,state,cutoff FROM log_iceberg_retention_jobs').all()).toEqual([
      { id: await logIcebergRetentionScopeId(f.config, scope), state: 'completed', cutoff: 0 },
    ]);
    await finish();
  });
  it('deletes expired DB bodies without a cold copy but keeps DB-age-only records and business receipts', async () => {
    const expired = await f.record('expired', { expiresAt: 0 }),
      keep = await f.record('keep', { ingestedAt: f.now - 20 * 86400000 });
    await f.staging.put('tenant-a', expired);
    await f.staging.put('tenant-a', keep);
    for (const record of [expired, keep])
      f.db
        .prepare(
          "INSERT INTO log_iceberg_restore_holds(id,operation_id,tenant_id,payload_hmac,storage_generation,state,expires_at,created_at) VALUES(?,'restore','tenant-a',?,?,'holding',?,0)"
        )
        .run(
          await logIcebergRecordId(record),
          record.payload_hmac,
          record.storage_generation,
          record.expires_at
        );
    f.db
      .prepare(
        "INSERT INTO admin_audit_receipts(id,tenant_id,payload_hmac,recorded_at) VALUES('business','tenant-a',?,0)"
      )
      .run('a'.repeat(64));
    await finish();
    expect(f.db.prepare('SELECT event_id FROM log_iceberg_records').all()).toEqual([
      { event_id: 'keep' },
    ]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM admin_audit_receipts').get()?.n).toBe(1);
  });
  it('records Stream arrival once when TTL removes PII before a subject erasure can observe it', async () => {
    f.catalog.metadata = pipelineMetadata();
    f.config = {
      ...f.config,
      mode: 'pipeline',
      dbRetentionDays: null,
      exportIntervalMinutes: null,
      physicalFingerprint: await logArchivePhysicalFingerprint(f.catalog.metadata),
    };
    const row = await f.record('pii-expired', { sourceDataset: 'pii.pii_log', expiresAt: 0 });
    await append([row]);
    const id = await logIcebergRecordId(row);
    f.db
      .prepare(
        `INSERT INTO log_iceberg_outbox(id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,payload_erased_at,stream_obligation_at,stream_attempt_count,created_at,updated_at) VALUES(?,'tenant-a',?,'pii.pii_log',?,?,?,?,1,0,'erased',0,0,1,?,?)`
      )
      .run(
        id,
        f.config.generation,
        row.subject_id,
        row.payload_hmac,
        `_authrim_retry/iceberg/v1/${f.config.generation}/${id}.json`,
        'a'.repeat(64),
        f.now,
        f.now
      );
    const piiScope = { ...scope, sourceDataset: 'pii.pii_log' };
    for (let cycle = 0; cycle < 2; cycle++)
      for (let step = 0; step < 160; step++) {
        if ((await retainLogIcebergScopePage(f.config, ports, piiScope)).complete) break;
        if (step === 159) throw Error('PII TTL did not finish');
      }
    expect(
      f.db.prepare('SELECT stream_observed_count FROM log_iceberg_outbox WHERE id=?').get(id)
        ?.stream_observed_count
    ).toBe(1);
  });
  it('denies a scheduled body PUT that was admitted before lease loss but is still absent when GC lists its prefix', async () => {
    const row = await f.record('expired-export', { expiresAt: 0 });
    await f.staging.put('tenant-a', row);
    let checkpoint: IcebergBatchCheckpoint | undefined;
    const journal = new MemoryJournal();
    journal.loadOrCreate = async (value) => {
      checkpoint = value;
      throw Error('suspended before PUT');
    };
    const writer = new ScheduledIcebergWriter({
      catalog: f.catalog,
      store: f.store,
      journal,
      storageGeneration: f.config.generation,
      tableLocation: f.catalog.metadata.location,
    });
    await expect(
      writer.appendBatch({ batchId: 'cancelled-export', fence: 'fence-1', records: [row] })
    ).rejects.toThrow('suspended');
    if (!checkpoint) throw Error('checkpoint missing');
    f.db
      .prepare(
        `INSERT INTO log_iceberg_export_batches(id,storage_generation,tenant_id,tenant_key,source_dataset,record_ids_json,checkpoint_json,state,created_at,updated_at) VALUES('cancelled-export',?,'tenant-a','key-a','core.audit_log','[]',?,'selected',?,?)`
      )
      .run(f.config.generation, JSON.stringify(checkpoint), f.now, f.now);
    f.db.exec("UPDATE log_iceberg_records SET batch_id='cancelled-export'");
    const path = `${f.catalog.metadata.location}/data/authrim-${await logIcebergDigest('cancelled-export')}-${await logIcebergDigest('{}')}.parquet`;
    await finish();
    expect((await ports.objects.head(path))?.size).toBe(0);
    await expect(
      f.store.putImmutable(
        path,
        new TextEncoder().encode('late ciphertext'),
        `${f.config.tableUuid}:${checkpoint.batchDigest}`
      )
    ).rejects.toThrow('immutable conflict');
  });
  it('waits for an explicit DR pin before physical TTL removal and resumes after release', async () => {
    const row = await f.record('expired', { expiresAt: 0 });
    await append([row]);
    const pinned = await lifecycle().pinSnapshot(
      'dr-ttl',
      String(f.catalog.metadata['current-snapshot-id'])
    );
    for (let i = 0; i < 40; i++)
      expect((await retainLogIcebergScopePage(f.config, ports, scope)).complete).toBe(false);
    await lifecycle().releaseSnapshotPin(
      'dr-ttl',
      String(pinned.metadata.refs?.['dr-ttl']?.['snapshot-id']),
      f.config.tableUuid
    );
    await finish();
  });
  it('inventories compaction preimages before snapshot expiry even when no rows are currently expired', async () => {
    await append([await f.record('keep')]);
    const source = sourcePath();
    await lifecycle().rewriteFiles([source]);
    for (let i = 0; i < 4; i++)
      await advanceIcebergMainForGc({
        catalog: f.catalog,
        store: f.store,
        operationId: (i + 1).toString(16).repeat(64),
        assertFence: async () => undefined,
      });
    const before = f.catalog.metadata.snapshots?.length ?? 0;
    expect(before).toBeGreaterThan(4);
    const unknown = f.catalog.metadata.location + '/data/provider-unknown.parquet';
    await f.store.putImmutable(unknown, Uint8Array.of(1), 'unknown');
    await maintenance();
    expect(f.catalog.metadata.snapshots?.length).toBeLessThan(before);
    expect(f.store.objects.get(source)?.bytes.length ?? 0).toBe(0);
    expect(f.store.objects.get(unknown)?.bytes).toEqual(Uint8Array.of(1));
    expect(
      (
        await readSnapshotRecords({
          table: await f.catalog.loadTable(),
          store: f.store,
          tenantKey: 'key-a',
          sourceDatasets: ['core.audit_log'],
          nowMs: Date.now(),
        })
      ).records.map((r) => r.event_id)
    ).toEqual(['keep']);
  });
  it('makes physical collection progress while normal new snapshots keep arriving', async () => {
    await append([await f.record('keep')]);
    const source = sourcePath();
    await lifecycle().rewriteFiles([source]);
    let appends = 0;
    for (let step = 0; step < 160; step++) {
      if (step % 5 === 0) {
        await advanceIcebergMainForGc({
          catalog: f.catalog,
          store: f.store,
          operationId: await logIcebergDigest('concurrent-' + step),
          assertFence: async () => undefined,
        });
        appends++;
      }
      await maintainLogIcebergMetadataPage(f.config, ports);
      if ((f.store.objects.get(source)?.bytes.length ?? 0) === 0) break;
      if (step === 159) throw Error('collection starved by appends');
    }
    expect(appends).toBeGreaterThan(1);
    expect(f.store.objects.get(source)?.bytes.length ?? 0).toBe(0);
    await maintenance();
  });
  it('keeps live DR snapshot files in metadata maintenance and only collects them after release', async () => {
    await append([await f.record('keep')]);
    const source = sourcePath();
    const pinned = await lifecycle().pinSnapshot(
      'dr-metadata',
      String(f.catalog.metadata['current-snapshot-id'])
    );
    await lifecycle().rewriteFiles([source]);
    await maintenance();
    expect(f.store.objects.get(source)?.bytes.length).toBeGreaterThan(0);
    await lifecycle().releaseSnapshotPin(
      'dr-metadata',
      String(pinned.metadata.refs?.['dr-metadata']?.['snapshot-id']),
      f.config.tableUuid
    );
    await maintenance();
    expect(f.store.objects.get(source)?.bytes.length ?? 0).toBe(0);
  });
});

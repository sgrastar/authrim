import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { prepareAppend, stageSnapshotForAppend } from 'icebird/src/write/stage.js';
import {
  IcebergLifecycle,
  logArchivePhysicalFingerprint,
  readSnapshotRecords,
  scanSnapshotSubjectFilesPage,
  createSnapshotDeleteIntent,
  prepareSnapshotRowDelete,
  encodeSnapshotDeleteState,
  decodeSnapshotDeleteState,
  planSnapshotRowDeletePage,
  advanceIcebergMainForGc,
} from '@authrim/ar-lib-logging/iceberg';
import { icebergFixture } from './log-iceberg-test-fixture';
import { buildLogIcebergRecord } from '../log-iceberg-record';
import { logIcebergRecordId, logIcebergDigest } from '../log-iceberg-store';
import {
  eraseLogIcebergSubjectPage,
  type LogIcebergSubjectErasurePorts,
} from '../log-iceberg-subject-erasure';
import {
  runLogIcebergPhysicalErasureStep,
  type LogIcebergPhysicalErasurePorts,
} from '../log-iceberg-physical-erasure';
import { pipelineMetadata } from '../../../../ar-lib-logging/src/iceberg/__tests__/fixtures';

const subject = 'd0a48aee-cfee-47f4-b28f-d1891473f2bd';
const other = '2cf55cc4-0fd9-4dc9-af8a-9c49a167ad90';
const input = {
  tenantId: 'tenant-a',
  tenantKey: 'key-a',
  sourceDataset: 'pii.pii_log' as const,
  subjectId: subject,
};
describe('physical PII erasure proof port', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>;
  let gc: LogIcebergPhysicalErasurePorts;
  let deleted: string[];
  let large: string | undefined;
  beforeEach(async () => {
    f = await icebergFixture();
    deleted = [];
    large = undefined;
    const markerMeta = new Map<string, Record<string, string>>();
    gc = {
      ...f.ports,
      capturingTenantKeys: async () => new Set(),
      objects: {
        async head(path) {
          const object = f.store.objects.get(path);
          return object
            ? {
                size: path === large ? 9 * 1024 * 1024 : object.bytes.length,
                etag: object.identity + ':' + object.bytes.length,
                customMetadata: markerMeta.get(path) ?? { authrim_identity: object.identity },
              }
            : null;
        },
        async delete(path) {
          deleted.push(path);
          f.store.objects.delete(path);
          markerMeta.delete(path);
        },
        async markErased(path, etag) {
          const existing = f.store.objects.get(path);
          if (
            etag !== null &&
            (!existing || existing.identity + ':' + existing.bytes.length !== etag)
          )
            return;
          if (etag === null && existing) return;
          f.store.objects.set(path, { bytes: new Uint8Array(), identity: 'gc-marker' });
          markerMeta.set(path, {
            authrim_iceberg_gc_erased: '1',
            authrim_artifact_digest: await import('../log-iceberg-store').then((m) =>
              m.logIcebergDigest(path)
            ),
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
  async function shared(pipeline = false) {
    if (pipeline) {
      f.catalog.metadata = pipelineMetadata();
      f.config = {
        ...f.config,
        mode: 'pipeline',
        dbRetentionDays: null,
        exportIntervalMinutes: null,
        physicalFingerprint: await logArchivePhysicalFingerprint(f.catalog.metadata),
      };
    }
    const make = async (id: string, who: string, tenantKey = 'key-a') =>
      buildLogIcebergRecord(
        f.config,
        {
          eventId: id,
          tenantKey,
          sourceDataset: 'pii.pii_log',
          logType: 'pii',
          eventAt: f.now,
          ingestedAt: f.now,
          expiresAt: who === subject && tenantKey === 'key-a' ? 0 : null,
          overview: { subject_id: who },
          body: { event_id: id, user_id: 'synthetic-real-id', email: 'private@example.invalid' },
        },
        f.keys
      );
    const rows = [
      await make('erase', subject),
      await make('keep', other),
      await make('foreign', subject, 'key-b'),
    ].map((r) => ({
      ...r,
      event_at: BigInt(r.event_at),
      ingested_at: BigInt(r.ingested_at),
      expires_at: r.expires_at === null ? null : BigInt(r.expires_at),
      ...(pipeline ? { __ingest_ts: new Date(r.ingested_at) } : {}),
    }));
    const resolver = {
      writer(path: string) {
        const output = new ByteWriter();
        return Object.assign(output, {
          finish: async () => f.store.putImmutable(path, output.getBytes(), path),
        });
      },
    };
    const prepared = await prepareAppend({
      tableUrl: f.catalog.metadata.location,
      metadata: f.catalog.metadata,
      resolver,
      records: rows,
    });
    await f.catalog.commit(
      await stageSnapshotForAppend({
        tableUrl: f.catalog.metadata.location,
        metadata: f.catalog.metadata,
        resolver,
        prepared,
      })
    );
    return [...f.store.objects.keys()].find((p) => p.endsWith('.parquet')) as string;
  }
  function ports(): LogIcebergSubjectErasurePorts {
    return {
      ...f.ports,
      capturingTenantKeys: async () => new Set(),
      physicalErasure: {
        step: (value, assertFence) =>
          runLogIcebergPhysicalErasureStep(f.config, gc, value, assertFence),
      },
    };
  }
  const run = () => eraseLogIcebergSubjectPage(f.config, ports(), input);
  function state() {
    const row = f.db
      .prepare('SELECT mutation_receipt_json FROM log_iceberg_subject_erasures WHERE subject_id=?')
      .get(subject);
    const receipt = row?.mutation_receipt_json
      ? (JSON.parse(String(row.mutation_receipt_json)) as { gcReceiptJson?: string })
      : {};
    return receipt.gcReceiptJson
      ? (JSON.parse(receipt.gcReceiptJson) as { phase: string; reason?: string })
      : undefined;
  }
  async function finish(limit = 100) {
    for (let i = 0; i < limit; i++) {
      const result = await run();
      if (result.complete) return result;
    }
    throw new Error('GC did not finish ' + JSON.stringify(state()));
  }
  it('removes the exact expired source bytes after rewrite/expiry while preserving other tenants and subjects', async () => {
    for (const pipeline of [false, true]) {
      if (pipeline) {
        f.db.close();
        f = await icebergFixture();
        const original = gc.objects; // Rebind fixture-backed closures through the shared f binding.
        gc = { ...f.ports, objects: original, capturingTenantKeys: async () => new Set() };
      }
      const source = await shared(pipeline);
      expect(await finish()).toEqual({ complete: true, removed: 1 });
      expect(f.store.objects.has(source)).toBe(false);
      expect(deleted).toContain(source);
      const keep = await readSnapshotRecords({
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'key-a',
        sourceDatasets: ['pii.pii_log'],
        nowMs: 0,
      });
      expect(keep.records.map((r) => r.event_id)).toEqual(['keep']);
      const foreign = await readSnapshotRecords({
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'key-b',
        sourceDatasets: ['pii.pii_log'],
        nowMs: 0,
      });
      expect(foreign.records.map((r) => r.event_id)).toEqual(['foreign']);
      expect(
        f.db
          .prepare("SELECT COUNT(*) AS n FROM log_iceberg_erasure_artifacts WHERE state='found'")
          .get()?.n
      ).toBe(0);
    }
  });
  it('keeps source bytes while a live DR pin references the file, then resumes after pin release', async () => {
    const source = await shared();
    const lifecycle = new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: f.catalog.metadata.location,
    });
    const pinned = await lifecycle.pinSnapshot(
      'dr-held',
      String(f.catalog.metadata['current-snapshot-id'])
    );
    for (let i = 0; i < 30 && state()?.reason !== 'live_snapshot_pin'; i++)
      expect((await run()).complete).toBe(false);
    expect(state()?.reason).toBe('live_snapshot_pin');
    expect(f.store.objects.has(source)).toBe(true);
    expect(deleted).toEqual([]);
    await lifecycle.releaseSnapshotPin(
      'dr-held',
      String(pinned.metadata.refs?.['dr-held']?.['snapshot-id']),
      f.config.tableUuid
    );
    expect((await finish()).complete).toBe(true);
  });
  it('waits for provider compaction of a large file and resumes without downloading it for a local rewrite', async () => {
    const source = await shared();
    large = source;
    for (let i = 0; i < 35 && state()?.reason !== 'provider_compaction_pending'; i++)
      expect((await run()).complete).toBe(false);
    expect(state()?.reason).toBe('provider_compaction_pending');
    expect(deleted).toEqual([]);
    await new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: f.catalog.metadata.location,
    }).rewriteFiles([source]);
    large = undefined;
    expect((await finish()).complete).toBe(true);
    expect(f.store.objects.has(source)).toBe(false);
  });
  it('replans a late accepted Stream row and preserves already collected GC evidence', async () => {
    await shared();
    for (let i = 0; i < 30 && state()?.phase !== 'logical'; i++) await run();
    expect(state()?.phase).toBe('logical');
    const row = await buildLogIcebergRecord(
      f.config,
      {
        eventId: 'late-stream',
        tenantKey: 'key-a',
        sourceDataset: 'pii.pii_log',
        logType: 'pii',
        eventAt: f.now,
        ingestedAt: f.now,
        expiresAt: 0,
        overview: { subject_id: subject },
        body: { user_id: 'synthetic-real-id', email: 'late@example.invalid' },
      },
      f.keys
    );
    const records = [
      {
        ...row,
        event_at: BigInt(row.event_at),
        ingested_at: BigInt(row.ingested_at),
        expires_at: 0n,
      },
    ];
    const resolver = {
      async reader(path: string) {
        const data = await f.store.read(path, 8 * 1024 * 1024);
        return {
          byteLength: data.length,
          slice: (start: number, end?: number) => Uint8Array.from(data.subarray(start, end)).buffer,
        };
      },
      writer(path: string) {
        const output = new ByteWriter();
        return Object.assign(output, {
          finish: async () => f.store.putImmutable(path, output.getBytes(), path),
        });
      },
    };
    const prepared = await prepareAppend({
      tableUrl: f.catalog.metadata.location,
      metadata: f.catalog.metadata,
      resolver,
      records,
    });
    await f.catalog.commit(
      await stageSnapshotForAppend({
        tableUrl: f.catalog.metadata.location,
        metadata: f.catalog.metadata,
        resolver,
        prepared,
      })
    );
    expect(await finish(150)).toEqual({ complete: true, removed: 2 });
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM log_iceberg_erasure_artifacts WHERE state='found'")
        .get()?.n
    ).toBe(0);
  });
  it('does not complete before every admitted Stream copy arrives, even after its TTL, and counts a lost Admin reply once', async () => {
    await shared();

    const record = await buildLogIcebergRecord(
      f.config,
      {
        eventId: 'accepted-but-not-visible',
        tenantKey: 'key-a',
        sourceDataset: 'pii.pii_log',
        logType: 'pii',
        eventAt: f.now,
        ingestedAt: f.now,
        expiresAt: 0,
        overview: { subject_id: subject },
        body: { email: 'late@example.invalid' },
      },
      f.keys
    );
    const id = await logIcebergRecordId(record),
      body = JSON.stringify(record);
    f.db
      .prepare(
        `INSERT INTO log_iceberg_outbox(id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,payload_erased_at,stream_obligation_at,stream_attempt_count,created_at,updated_at)
      VALUES(?,'tenant-a',?,'pii.pii_log',?,?,?,?,?,0,'erased',0,0,2,?,?)`
      )
      .run(
        id,
        f.config.generation,
        subject,
        record.payload_hmac,
        `_authrim_retry/iceberg/v1/${f.config.generation}/${id}.json`,
        await logIcebergDigest(body),
        new TextEncoder().encode(body).length,
        f.now,
        f.now
      );
    for (let i = 0; i < 100; i++) expect((await run()).complete).toBe(false);
    expect(
      f.db.prepare('SELECT state FROM log_iceberg_subject_erasures WHERE subject_id=?').get(subject)
        ?.state
    ).toBe('sweeping');
    const append = async () => {
      const resolver = {
        async reader(path: string) {
          const data = await f.store.read(path, 8 * 1024 * 1024);
          return {
            byteLength: data.length,
            slice: (start: number, end?: number) =>
              Uint8Array.from(data.subarray(start, end)).buffer,
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
        records: [
          {
            ...record,
            event_at: BigInt(record.event_at),
            ingested_at: BigInt(record.ingested_at),
            expires_at: 0n,
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
    };
    await append();
    const original = f.adapter.batch.bind(f.adapter);
    let lost = false;
    f.adapter.batch = async (statements) => {
      const result = await original(statements);
      if (!lost && statements.some((s) => s.sql.includes('stream_observed_count'))) {
        lost = true;
        throw Error('lost Admin acknowledgement');
      }
      return result;
    };
    for (let i = 0; i < 120; i++) {
      try {
        expect((await run()).complete).toBe(false);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== 'lost Admin acknowledgement') throw e;
      }
    }
    expect(lost).toBe(true);
    expect(
      f.db.prepare('SELECT stream_observed_count FROM log_iceberg_outbox WHERE id=?').get(id)
        ?.stream_observed_count
    ).toBe(1);
    await append();
    expect((await finish(180)).complete).toBe(true);
    expect(
      f.db.prepare('SELECT stream_observed_count FROM log_iceberg_outbox WHERE id=?').get(id)
        ?.stream_observed_count
    ).toBe(2);
  });
  it('journals failed GC rewrite output before PUT and reclaims only its unreferenced artifacts', async () => {
    await shared();
    for (let i = 0; i < 35 && state()?.phase !== 'rewrite'; i++) await run();
    expect(state()?.phase).toBe('rewrite');
    let once = true;
    f.catalog.beforeCommit = async () => {
      if (once) {
        once = false;
        throw new (await import('@authrim/ar-lib-logging/iceberg')).IcebergCatalogConflictError(
          'provider raced'
        );
      }
    };
    await run();
    f.catalog.beforeCommit = undefined;
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM log_iceberg_erasure_artifacts WHERE operation_id LIKE 'gc-rewrite:%'"
        )
        .get()?.n
    ).toBeGreaterThan(0);
    expect((await finish(160)).complete).toBe(true);
    const rows = f.db
      .prepare(
        "SELECT state,path FROM log_iceberg_erasure_artifacts WHERE operation_id LIKE 'gc-rewrite:%'"
      )
      .all();
    expect(rows.some((r) => r.state === 'removed')).toBe(true);
  });
  it.each(['planned', 'discover'] as const)(
    'preserves another paused erasure %s snapshot until its evidence is durable',
    async (kind) => {
      const source = await shared();
      const base = String(f.catalog.metadata['current-snapshot-id']);
      const plan = await planSnapshotRowDeletePage(
        {
          table: await f.catalog.loadTable(),
          store: f.store,
          tenantKey: 'key-a',
          sourceDatasets: ['pii.pii_log'],
          subjectIds: [other],
          nowMs: 0,
        },
        'subject'
      );
      const intent = await createSnapshotDeleteIntent(plan, 'b'.repeat(64));
      let held = base;
      if (kind === 'discover') {
        const lifecycle = new IcebergLifecycle({
          catalog: f.catalog,
          store: f.store,
          tableLocation: f.catalog.metadata.location,
        });
        const pinned = await lifecycle.pinSnapshot('paused-discovery', base);
        held = String(pinned.metadata.refs?.['paused-discovery']?.['snapshot-id']);
        await lifecycle.releaseSnapshotPin('paused-discovery', held, f.config.tableUuid);
      }
      // An intermediate snapshot is needed to prove a planned commit did not land.
      const middle = await advanceIcebergMainForGc({
        catalog: f.catalog,
        store: f.store,
        operationId: '8'.repeat(64),
        assertFence: async () => undefined,
      });
      await advanceIcebergMainForGc({
        catalog: f.catalog,
        store: f.store,
        operationId: '9'.repeat(64),
        assertFence: async () => undefined,
      });
      const receipt =
        kind === 'planned'
          ? { version: 1, logicalVerified: false, deleteState: encodeSnapshotDeleteState(intent) }
          : {
              version: 1,
              logicalVerified: true,
              gcReceiptJson: JSON.stringify({
                tableUuid: f.config.tableUuid,
                phase: 'discover',
                snapshots: [held],
              }),
            };
      f.db
        .prepare(
          `INSERT INTO log_iceberg_subject_erasures
        (id,tenant_id,tenant_key,source_dataset,subject_id,state,mutation_receipt_json,created_at,updated_at)
        VALUES(?,'tenant-a','key-a','pii.pii_log',?,'sweeping',?,?,?)`
        )
        .run('e'.repeat(64), other, JSON.stringify(receipt), f.now, f.now);
      for (let i = 0; i < 100 && state()?.reason !== 'retained_snapshot_reference'; i++)
        expect((await run()).complete).toBe(false);
      expect(state()?.reason).toBe('retained_snapshot_reference');
      expect(f.catalog.metadata.snapshots?.some((s) => String(s['snapshot-id']) === held)).toBe(
        true
      );
      if (kind === 'planned')
        expect(
          f.catalog.metadata.snapshots?.some((s) => String(s['snapshot-id']) === middle.snapshotId)
        ).toBe(true);
      expect(f.store.objects.has(source)).toBe(true);
      f.db
        .prepare(
          "UPDATE log_iceberg_subject_erasures SET state='completed',mutation_receipt_json=NULL WHERE id=?"
        )
        .run('e'.repeat(64));
      expect((await finish(180)).complete).toBe(true);
      expect(f.store.objects.has(source)).toBe(false);
    }
  );
  it.each([
    ['refIndex', 'invalid'],
    ['artifactDigests', [12]],
    ['scanCursor', { version: 1 }],
    ['refCursor', { version: 1 }],
    ['inventoryCursor', { listed: 'invalid' }],
    ['reason', {}],
  ])('rejects malformed GC optional %s state before object effects', async (field, value) => {
    await shared();
    for (let i = 0; i < 10 && !state(); i++) await run();
    const row = f.db
      .prepare('SELECT mutation_receipt_json FROM log_iceberg_subject_erasures WHERE subject_id=?')
      .get(subject);
    const receipt = JSON.parse(String(row?.mutation_receipt_json)) as { gcReceiptJson: string };
    const proof = JSON.parse(receipt.gcReceiptJson) as Record<string, unknown>;
    proof[String(field)] = value;
    receipt.gcReceiptJson = JSON.stringify(proof);
    f.db
      .prepare('UPDATE log_iceberg_subject_erasures SET mutation_receipt_json=? WHERE subject_id=?')
      .run(JSON.stringify(receipt), subject);
    const count = f.store.objects.size;
    await expect(run()).rejects.toThrow('gc_state_invalid');
    expect(f.store.objects.size).toBe(count);
    expect(deleted).toEqual([]);
  });
  it('does not collect provider-unknown uncommitted files by age or prefix similarity', async () => {
    await shared();
    const unknown = f.catalog.metadata.location + '/data/unknown-provider-orphan.parquet';
    await f.store.putImmutable(unknown, new Uint8Array([1, 2, 3]), 'provider-unknown');
    expect((await finish()).complete).toBe(true);
    expect(f.store.objects.get(unknown)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(deleted).not.toContain(unknown);
  });
  it('keeps capture preimages and rejects stale fence before any physical removal', async () => {
    await shared();
    gc.capturingTenantKeys = async () => new Set(['key-a']);
    for (let i = 0; i < 4; i++) expect((await run()).complete).toBe(false);
    expect(state()?.reason).toBe('backup_capturing');
    expect(deleted).toEqual([]);
    gc.capturingTenantKeys = async () => new Set();
    let stole = false;
    const previous = gc.objects.head.bind(gc.objects);
    gc.objects.head = async (path) => {
      const value = await previous(path);
      if (!stole && state()?.phase === 'remove') {
        stole = true;
        f.db.exec("UPDATE scheduled_task_leases SET lease_token='new-owner'");
      }
      return value;
    };
    await expect(finish()).rejects.toThrow('stale_fence');
    expect(deleted).toEqual([]);
  });
  it('closes old CAS before marking retired uncommitted artifacts and keeps current live rows intact', async () => {
    await shared();
    await eraseLogIcebergSubjectPage(f.config, f.ports, input);
    const saved = f.db
      .prepare('SELECT mutation_receipt_json FROM log_iceberg_subject_erasures')
      .get();
    const recipe = JSON.parse(String(saved?.mutation_receipt_json)) as { deleteState: string };
    const base = decodeSnapshotDeleteState(recipe.deleteState);
    const retired = [];
    for (let i = 0; i < 8; i++) {
      const intent = await createSnapshotDeleteIntent(base.plan, i.toString(16).padStart(64, '0'));
      const prepared = await prepareSnapshotRowDelete({
        table: await f.catalog.loadTable(),
        store: f.store,
        intent,
      });
      retired.push(encodeSnapshotDeleteState(prepared));
    }
    f.db
      .prepare('UPDATE log_iceberg_subject_erasures SET mutation_history_json=?')
      .run(JSON.stringify(retired));
    // A zero-data barrier makes the current plan stale before capacity recovery.
    await new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: f.catalog.metadata.location,
    }).pinSnapshot('advance', String(f.catalog.metadata['current-snapshot-id']));
    // Release the test pin: no DR protection is requested for these temporary files.
    const pin = f.catalog.metadata.refs?.advance;
    await new IcebergLifecycle({
      catalog: f.catalog,
      store: f.store,
      tableLocation: f.catalog.metadata.location,
    }).releaseSnapshotPin('advance', String(pin?.['snapshot-id']), f.config.tableUuid);
    for (let i = 0; i < 160; i++) {
      await run();
      const count = (
        JSON.parse(
          String(
            f.db.prepare('SELECT mutation_history_json FROM log_iceberg_subject_erasures').get()
              ?.mutation_history_json
          )
        ) as unknown[]
      ).length;
      if (count < 8) break;
      if (i === 159) throw new Error('retired capacity stuck ' + JSON.stringify(state()));
    }
    const heads = await Promise.all(
      [...f.store.objects.keys()]
        .filter((p) => p.includes('-deletes.parquet'))
        .map((p) => gc.objects.head(p))
    );
    expect(heads.some((head) => head?.size === 0)).toBe(true);
    const raw = await scanSnapshotSubjectFilesPage({
      table: await f.catalog.loadTable(),
      store: f.store,
      tenantKey: 'key-a',
      sourceDatasets: ['pii.pii_log'],
      subjectIds: [subject],
      nowMs: 0,
    });
    expect(raw.deletes.length).toBe(1);
  });
});

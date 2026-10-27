import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  ScheduledIcebergWriter,
  createSnapshotDeleteIntent,
  encodeSnapshotDeleteState,
  decodeSnapshotDeleteState,
  IcebergCommitUnknownError,
  planSnapshotRowDeletePage,
  scanSnapshotSubjectFilesPage,
} from '@authrim/ar-lib-logging/iceberg';
import {
  eraseLogIcebergSubjectPage,
  type LogIcebergSubjectErasurePorts,
} from '../log-iceberg-subject-erasure';
import { buildLogIcebergRecord } from '../log-iceberg-record';
import { logIcebergRecordId } from '../log-iceberg-store';
import { icebergFixture } from './log-iceberg-test-fixture';
import { MemoryJournal } from '../../../../ar-lib-logging/src/iceberg/__tests__/fixtures';

const subject = 'd0a48aee-cfee-47f4-b28f-d1891473f2bd';
const otherSubject = '2cf55cc4-0fd9-4dc9-af8a-9c49a167ad90';
const input = {
  tenantId: 'tenant-a',
  tenantKey: 'key-a',
  sourceDataset: 'pii.pii_log' as const,
  subjectId: subject,
};
describe('deny-first PII subject erasure', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>;
  beforeEach(async () => {
    f = await icebergFixture();
  });
  afterEach(() => f.db.close());
  const make = (id: string, who = subject, tenantKey = 'key-a') =>
    buildLogIcebergRecord(
      f.config,
      {
        eventId: id,
        tenantKey,
        sourceDataset: 'pii.pii_log',
        logType: 'pii',
        eventAt: f.now - 1_000,
        ingestedAt: f.now - 1_000,
        expiresAt: 0,
        overview: { subject_id: who },
        body: {
          user_id: 'synthetic-real-user-never-in-erasure-ledger',
          change: 'email',
          email: 'synthetic@example.invalid',
        },
      },
      f.keys
    );
  const ports = (): LogIcebergSubjectErasurePorts => ({
    ...f.ports,
    capturingTenantKeys: async () => new Set(),
  });
  const run = (overrides: Partial<LogIcebergSubjectErasurePorts> = {}) =>
    eraseLogIcebergSubjectPage(f.config, { ...ports(), ...overrides }, input);
  const count = () =>
    Number(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n);

  it('keeps the permanent anonymous deny, removes local parts, and counts an event once across retries', async () => {
    const row = await make('pii-source');
    await f.staging.put('tenant-a', row);
    expect(await run()).toEqual({ complete: false, removed: 1 });
    expect(count()).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_record_parts').get()?.n).toBe(0);
    const saved = f.db.prepare('SELECT * FROM log_iceberg_subject_erasures').get();
    expect(saved?.subject_id).toBe(subject);
    expect(JSON.stringify(saved)).not.toContain('synthetic-real');
    expect(JSON.stringify(saved)).not.toContain('@');
    await f.staging.put('tenant-a', row);
    expect(count()).toBe(0);
    expect(await run()).toEqual({ complete: false, removed: 1 });
    expect(f.db.prepare('SELECT state FROM log_iceberg_event_receipts').get()?.state).toBe(
      'erased'
    );
  });
  it('unclaims the non-target records of a mixed export batch and leaves their source intact', async () => {
    const target = await make('target');
    const keep = await make('keep', otherSubject);
    await f.staging.put('tenant-a', target);
    await f.staging.put('tenant-a', keep);
    f.db
      .prepare(
        "INSERT INTO log_iceberg_export_batches(id,storage_generation,tenant_id,tenant_key,source_dataset,record_ids_json,state,created_at,updated_at) VALUES('mixed',?,'tenant-a','key-a','pii.pii_log','[]','selected',?,?)"
      )
      .run(f.config.generation, f.now, f.now);
    f.db.exec("UPDATE log_iceberg_records SET batch_id='mixed'");
    expect((await run()).removed).toBe(1);
    expect(count()).toBe(1);
    expect(f.db.prepare('SELECT event_id,batch_id FROM log_iceberg_records').get()).toEqual({
      event_id: 'keep',
      batch_id: null,
    });
    const batch = f.db
      .prepare('SELECT state,last_error_code FROM log_iceberg_export_batches')
      .get();
    expect(batch?.state).toBe('done');
    expect(String(batch?.last_error_code)).toMatch(/^log_iceberg_erasure_[a-f0-9]{64}$/);
  });
  it('rejects a stale table fence without deleting local source or undoing its durable deny', async () => {
    await f.staging.put('tenant-a', await make('retained'));
    const admin = {
      ...f.adapter,
      batch: async (statements: Parameters<typeof f.adapter.batch>[0]) => {
        f.db.exec("UPDATE scheduled_task_leases SET lease_token='other-owner'");
        return f.adapter.batch(statements);
      },
    };
    await expect(run({ admin })).rejects.toThrow('stale_fence');
    expect(count()).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_subject_erasures').get()?.n).toBe(1);
    expect(f.db.prepare('SELECT state FROM log_iceberg_event_receipts').get()?.state).toBe(
      'staged'
    );
  });
  it('commits row positions after a lost acknowledgement but never calls MOR a completed physical erasure', async () => {
    const row = await make('archived');
    const keep = await make('keep', otherSubject);
    const journal = new MemoryJournal();
    const writer = new ScheduledIcebergWriter({
      catalog: f.catalog,
      store: f.store,
      journal,
      storageGeneration: f.config.generation,
      tableLocation: f.catalog.metadata.location,
    });
    await writer.appendBatch({ batchId: 'archive', fence: 'fence-1', records: [row, keep] });
    expect(await run()).toEqual({ complete: false, removed: 0 });
    let once = true;
    f.catalog.afterCommit = async () => {
      if (once) {
        once = false;
        throw new IcebergCommitUnknownError('lost');
      }
    };
    expect(await run()).toEqual({ complete: false, removed: 1 });
    expect(await run()).toEqual({ complete: false, removed: 1 });
    const options = {
      table: await f.catalog.loadTable(),
      store: f.store,
      tenantKey: 'key-a',
      sourceDatasets: ['pii.pii_log'],
      subjectIds: [subject],
      nowMs: 0,
    };
    expect((await planSnapshotRowDeletePage(options, 'subject')).deletes).toEqual([]);
    // Bytes remain in a shared data file despite the correct position marker.
    expect((await scanSnapshotSubjectFilesPage(options)).deletes.map((r) => r.eventId)).toEqual([
      'archived',
    ]);
    expect(f.db.prepare('SELECT state FROM log_iceberg_subject_erasures').get()?.state).toBe(
      'sweeping'
    );
  });
  it('retires stale compaction plans with bounded ownership history and replans fresh positions', async () => {
    const writer = new ScheduledIcebergWriter({
      catalog: f.catalog,
      store: f.store,
      journal: new MemoryJournal(),
      storageGeneration: f.config.generation,
      tableLocation: f.catalog.metadata.location,
    });
    await writer.appendBatch({
      batchId: 'before-compaction',
      fence: 'fence-1',
      records: [await make('target')],
    });
    await run();
    const before = f.db
      .prepare('SELECT mutation_receipt_json FROM log_iceberg_subject_erasures')
      .get();
    await writer.appendBatch({
      batchId: 'concurrent-maintenance',
      fence: 'fence-1',
      records: [await make('unrelated', otherSubject)],
    });
    expect(await run()).toEqual({ complete: false, removed: 0 });
    const row = f.db
      .prepare(
        'SELECT mutation_receipt_json,mutation_history_json FROM log_iceberg_subject_erasures'
      )
      .get();
    expect(row?.mutation_receipt_json).toBeNull();
    const history: unknown = JSON.parse(String(row?.mutation_history_json));
    expect(Array.isArray(history) && history.length).toBe(1);
    const previous = JSON.parse(String(before?.mutation_receipt_json)) as { deleteState: string };
    expect(history).toEqual([previous.deleteState]);
    await run();
    expect(await run()).toEqual({ complete: false, removed: 1 });
  });
  it('keeps a full retirement history and current intent until exact GC proof frees capacity', async () => {
    const writer = new ScheduledIcebergWriter({
      catalog: f.catalog,
      store: f.store,
      journal: new MemoryJournal(),
      storageGeneration: f.config.generation,
      tableLocation: f.catalog.metadata.location,
    });
    await writer.appendBatch({
      batchId: 'history-base',
      fence: 'fence-1',
      records: [await make('target')],
    });
    await run();
    const row = f.db
      .prepare('SELECT mutation_receipt_json FROM log_iceberg_subject_erasures')
      .get();
    const receipt = JSON.parse(String(row?.mutation_receipt_json)) as { deleteState: string };
    const original = decodeSnapshotDeleteState(receipt.deleteState);
    const history: string[] = [];
    for (let i = 0; i < 8; i++)
      history.push(
        encodeSnapshotDeleteState(
          await createSnapshotDeleteIntent(original.plan, i.toString(16).padStart(64, '0'))
        )
      );
    f.db
      .prepare('UPDATE log_iceberg_subject_erasures SET mutation_history_json=?')
      .run(JSON.stringify(history));
    await writer.appendBatch({
      batchId: 'history-advance',
      fence: 'fence-1',
      records: [await make('keep', otherSubject)],
    });
    expect(await run()).toEqual({ complete: false, removed: 0 });
    expect(
      f.db
        .prepare(
          'SELECT mutation_history_json,mutation_receipt_json FROM log_iceberg_subject_erasures'
        )
        .get()
    ).toEqual({
      mutation_history_json: JSON.stringify(history),
      mutation_receipt_json: row?.mutation_receipt_json,
    });
    const retiredId = decodeSnapshotDeleteState(history[0]).operationId;
    const physicalErasure = {
      async step(
        value: Parameters<NonNullable<LogIcebergSubjectErasurePorts['physicalErasure']>['step']>[0]
      ) {
        expect(value.logicalVerified).toBe(false);
        expect(value.retiredDeleteIntents).toHaveLength(8);
        return {
          complete: false,
          proofJson: JSON.stringify({ exactAbsentArtifacts: retiredId }),
          retiredOperationIds: [retiredId],
        };
      },
    };
    await run({ physicalErasure });
    expect(
      JSON.parse(
        String(
          f.db.prepare('SELECT mutation_history_json FROM log_iceberg_subject_erasures').get()
            ?.mutation_history_json
        )
      )
    ).toHaveLength(7);
    await run();
    expect(
      f.db.prepare('SELECT mutation_receipt_json FROM log_iceberg_subject_erasures').get()
        ?.mutation_receipt_json
    ).toBeNull();
  });

  it('allows completion only with an explicit GC proof and reopens after a later catalog snapshot', async () => {
    await f.staging.put('tenant-a', await make('only-local'));
    const physicalErasure = {
      async step() {
        expect(f.catalog.metadata.snapshots ?? []).toHaveLength(0);
        expect(f.store.objects.size).toBe(0);
        return {
          complete: true,
          proofJson: JSON.stringify({
            tableUuid: f.config.tableUuid,
            noSnapshotsOrArtifacts: true,
          }),
        };
      },
    };
    expect(await run({ physicalErasure })).toEqual({ complete: true, removed: 1 });
    expect(await run({ physicalErasure })).toEqual({ complete: true, removed: 1 });
    const writer = new ScheduledIcebergWriter({
      catalog: f.catalog,
      store: f.store,
      journal: new MemoryJournal(),
      storageGeneration: f.config.generation,
      tableLocation: f.catalog.metadata.location,
    });
    await writer.appendBatch({
      batchId: 'delayed',
      fence: 'fence-1',
      records: [await make('late')],
    });
    expect(await run()).toEqual({ complete: false, removed: 1 });
    expect(f.db.prepare('SELECT state FROM log_iceberg_subject_erasures').get()?.state).toBe(
      'sweeping'
    );
  });
  it('protects capturing retry envelopes and seals deterministic keys against late immutable PUTs', async () => {
    const row = await make('queued');
    const id = await logIcebergRecordId(row);
    const digest = 'f'.repeat(64);
    const key = `_authrim_retry/iceberg/v1/${f.config.generation}/${id}.json`;
    f.db
      .prepare(
        "INSERT INTO log_iceberg_outbox(id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,created_at,updated_at) VALUES(?,'tenant-a',?,'pii.pii_log',?,?,?,?,?,0,'queued',?,?)"
      )
      .run(id, f.config.generation, subject, row.payload_hmac, key, digest, 10, f.now, f.now);
    let head: { size: number; etag: string; customMetadata: Record<string, string> } = {
      size: 10,
      etag: 'cipher',
      customMetadata: {
        authrim_record_id: id,
        authrim_storage_generation: f.config.generation,
        authrim_payload_hmac: row.payload_hmac,
        authrim_payload_sha256: digest,
      },
    };
    const writes: string[] = [];
    const retryObjects = {
      head: async () => head,
      put: async (
        path: string,
        value: Uint8Array,
        options: {
          onlyIf: { etagMatches?: string; etagDoesNotMatch?: string };
          customMetadata: Record<string, string>;
        }
      ) => {
        if (options.onlyIf.etagDoesNotMatch === '*' || options.onlyIf.etagMatches !== head.etag)
          return null;
        writes.push(path);
        head = { size: value.length, etag: 'marker', customMetadata: options.customMetadata };
        return head;
      },
    } as unknown as Pick<R2Bucket, 'head' | 'put'>;
    expect(
      (await run({ retryObjects, capturingTenantKeys: async () => new Set(['key-a']) })).complete
    ).toBe(false);
    expect(writes).toEqual([]);
    expect(
      f.db.prepare('SELECT state,payload_key,payload_erased_at FROM log_iceberg_outbox').get()
    ).toEqual({ state: 'erased', payload_key: key, payload_erased_at: null });
    expect((await run({ retryObjects })).removed).toBe(1);
    expect(writes).toEqual([key]);
    expect(head.size).toBe(0);
    expect(Object.keys(head.customMetadata)).toHaveLength(2);
    expect(
      f.db.prepare('SELECT payload_key,payload_erased_at FROM log_iceberg_outbox').get()
        ?.payload_key
    ).toBe(key);
    expect(
      f.db.prepare('SELECT payload_erased_at FROM log_iceberg_outbox').get()?.payload_erased_at
    ).not.toBeNull();
    // A previously admitted PUT cannot recreate ciphertext after marker commit.
    expect(
      await retryObjects.put(key, new Uint8Array(10), { onlyIf: { etagDoesNotMatch: '*' } })
    ).toBeNull();
    expect(head.size).toBe(0);
  });
  it('seals a preparing intent before its first envelope exists', async () => {
    const row = await make('preparing');
    const id = await logIcebergRecordId(row);
    const key = `_authrim_retry/iceberg/v1/${f.config.generation}/${id}.json`;
    f.db
      .prepare(
        "INSERT INTO log_iceberg_outbox(id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,created_at,updated_at) VALUES(?,'tenant-a',?,'pii.pii_log',?,?,?,NULL,NULL,0,'preparing',?,?)"
      )
      .run(id, f.config.generation, subject, row.payload_hmac, key, f.now, f.now);
    let head: null | { size: number; etag: string; customMetadata: Record<string, string> } = null;
    const retryObjects = {
      head: async () => head,
      put: async (
        _key: string,
        value: Uint8Array,
        options: { onlyIf: { etagDoesNotMatch?: string }; customMetadata: Record<string, string> }
      ) => {
        if (head && options.onlyIf.etagDoesNotMatch === '*') return null;
        head = { size: value.length, etag: 'marker', customMetadata: options.customMetadata };
        return head;
      },
    } as unknown as Pick<R2Bucket, 'head' | 'put'>;
    expect((await run({ retryObjects })).removed).toBe(1);
    expect(
      await retryObjects.put(key, new Uint8Array(100), { onlyIf: { etagDoesNotMatch: '*' } })
    ).toBeNull();
    expect(
      f.db.prepare('SELECT state,payload_erased_at FROM log_iceberg_outbox').get()?.state
    ).toBe('erased');
    expect(
      f.db.prepare('SELECT payload_erased_at FROM log_iceberg_outbox').get()?.payload_erased_at
    ).not.toBeNull();
  });
  it('rejects real identifiers and a changed payload collision', async () => {
    await expect(
      eraseLogIcebergSubjectPage(f.config, ports(), {
        ...input,
        subjectId: 'person@example.invalid',
      })
    ).rejects.toThrow('scope_invalid');
    const row = await make('collision');
    await f.staging.put('tenant-a', row);
    f.db.prepare('UPDATE log_iceberg_event_receipts SET payload_hmac=?').run('f'.repeat(64));
    await expect(run()).rejects.toThrow();
    expect(count()).toBe(1);
    expect(
      f.db.prepare('SELECT removed_count FROM log_iceberg_subject_erasures').get()?.removed_count
    ).toBe(0);
  });
});

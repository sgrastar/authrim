import {
  saveTenantBackupExportManifest,
  loadTenantBackupExportManifest,
} from '../export-manifest-store';
import { runPrepareTenantBackupArtifactStep } from '../prepare-artifact-step';
import { TenantBackupExecutionInventory } from '../execution-inventory';
import { TenantBackupBoundaryReceipts } from '../boundary-receipts';
import { TenantBackupMutationAdmission } from '../mutation-admission';
import { verifyTenantBackupArtifactPart } from '../artifact-verification';
import { runTenantBackupArtifactVerificationStep } from '../verify-artifact-step';
import { runTenantBackupArtifactStep } from '../export-artifact-step';
import { runTenantBackupScheduler } from '../operation-scheduler';
import { readTenantBackupArtifact } from '../artifact-reader';
import {
  writeTenantBackupDatasetSlice,
  writeTenantBackupContentFrame,
  finishTenantBackupContent,
} from '../resumable-bundle-writer';
import type { TenantBundleEncoderCommand } from '../bundle-encoder-state';
import { TenantBackupCipherJournal } from '../cipher-journal';
import { decryptTenantBundleStream } from '../bundle-cipher';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupOperationStore } from '../operation-store';
import { TenantBackupArtifactWriter, writeTenantBackupArtifact } from '../artifact-writer';
import { createTenantBundleKeyEnvelope } from '../bundle-key-envelope';
import { readNextSqliteSnapshotChunk } from '../sqlite-dataset-source';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotTriggers,
  type SnapshotTableSchema,
} from '../sqlite-snapshot';
import { sqliteSnapshotRowInsert } from '../sqlite-row-codec';
import { decodeTenantBundle } from '../bundle-codec';
let db: DatabaseSync;
let operations: TenantBackupOperationStore;
let writer: TenantBackupArtifactWriter;
let adapter: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
let bucket: R2Bucket;
let putHook: (() => Promise<void>) | undefined;
const objects = new Map<
  string,
  { body: Uint8Array; size: number; checksums: { sha256: ArrayBuffer } }
>();
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '008_tenant_backup_retry_state.sql',
    '009_tenant_backup_artifact_parts.sql',
    '012_tenant_backup_cipher_journal.sql',
    '021_tenant_backup_export_manifests.sql',
  ])
    db.exec(
      readFileSync(
        new URL('../../../../../../migrations/admin/d1/' + file, import.meta.url),
        'utf8'
      )
    );
  adapter = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  operations = new TenantBackupOperationStore(adapter);
  await operations.create({
    id: 'operation',
    tenantId: 'tenant-a',
    kind: 'export',
    actorId: 'admin',
    idempotencyKey: 'request',
    requestDigest: 'ab'.repeat(32),
    now: 100,
  });
  const run = await operations.claim('tenant-a', 'operation', 'writer', 101);
  objects.clear();
  putHook = undefined;
  bucket = {
    async put(key: string, value: Uint8Array) {
      if (objects.has(key)) return null;
      const object = {
        body: new Uint8Array(value),
        size: value.length,
        checksums: { sha256: await crypto.subtle.digest('SHA-256', new Uint8Array(value)) },
      };
      objects.set(key, object);
      await putHook?.();
      return object;
    },
    async head(key: string) {
      return objects.get(key) ?? null;
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object.size,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(object.body));
            controller.close();
          },
        }),
      };
    },
  } as unknown as R2Bucket;
  writer = await TenantBackupArtifactWriter.create(
    adapter,
    bucket,
    {
      tenantId: 'tenant-a',
      operationId: 'operation',
      owner: 'writer',
      fencingToken: run!.fencing_token,
    },
    () => 102
  );
});
afterEach(() => db.close());
it('writes product ciphertext in bounded parts and decodes the saved artifact', async () => {
  const session = await createTenantBundleKeyEnvelope('fixture artifact backup password');
  const expected = {
    bundleId: Array.from(session.envelope.subarray(1, 17), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
    datasets: [
      {
        id: 'assets',
        module: 'flows-ui' as const,
        kind: 'settings' as const,
        store: 'object' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
    ],
  };
  const manifest = {
    formatVersion: 1 as const,
    ...expected,
    snapshotId: 'snapshot',
    boundaryUnixMs: 100,
    inventoryDigestSha256: 'ab'.repeat(32),
  };
  async function* chunks() {
    for (let i = 0; i < 6; i++) yield new Uint8Array(1024 * 1024 - 64).fill(i);
  }
  async function* datasets() {
    yield { datasetId: 'assets', chunks: chunks() };
  }
  const saved = await writeTenantBackupArtifact(
    writer,
    manifest,
    datasets(),
    session,
    expected,
    new AbortController().signal
  );
  expect(saved.parts).toBe(2);
  expect([...objects.values()].every((value) => value.size <= 4 * 1024 * 1024)).toBe(true);
  const rows = db
    .prepare('SELECT object_key FROM tenant_backup_artifact_parts ORDER BY ordinal')
    .all() as { object_key: string }[];
  async function* source() {
    for (const row of rows) yield objects.get(row.object_key)!.body;
  }
  let decoded = 0,
    completed = false;
  for await (const event of decodeTenantBundle(source(), session, expected, {
    maxFrames: 20,
    maxTotalBytes: 10 * 1024 * 1024,
  })) {
    if (event.kind === 'chunk') {
      expect(event.bytes.every((byte) => byte === decoded)).toBe(true);
      decoded++;
    }
    if (event.kind === 'complete') completed = true;
  }
  expect(decoded).toBe(6);
  expect(completed).toBe(true);
  expect(db.prepare('SELECT state,part_count FROM tenant_backup_artifact_attempts').get()).toEqual({
    state: 'sealed',
    part_count: 2,
  });
  expect((await operations.get('tenant-a', 'operation'))?.state).toBe('running');
});
it('recovers an uncertain put using the reserved object and rejects changed retry bytes', async () => {
  putHook = async () => {
    putHook = undefined;
    throw new Error('lost response');
  };
  await expect(writer.writePart(0, new Uint8Array([1, 2]))).rejects.toThrow();
  expect(objects.size).toBe(1);
  expect(db.prepare('SELECT uploaded FROM tenant_backup_artifact_parts').get()).toEqual({
    uploaded: 0,
  });
  await writer.writePart(0, new Uint8Array([1, 2]));
  expect(objects.size).toBe(1);
  await expect(writer.writePart(0, new Uint8Array([1, 3]))).rejects.toThrow();
  await writer.seal(1, 2);
  await expect(writer.writePart(1, new Uint8Array([4]))).rejects.toThrow();
});
it('retains the object reservation when cancellation races the receipt and cannot seal', async () => {
  putHook = async () => {
    await operations.requestCancel('tenant-a', 'operation', 102);
  };
  await expect(writer.writePart(0, new Uint8Array([1]))).rejects.toThrow();
  expect(objects.size).toBe(1);
  expect(db.prepare('SELECT uploaded FROM tenant_backup_artifact_parts').get()).toEqual({
    uploaded: 0,
  });
  await expect(writer.seal(1, 1)).rejects.toThrow();
});
it('rejects missing parts, incorrect byte totals and oversized writes', async () => {
  await expect(writer.writePart(0, new Uint8Array(4 * 1024 * 1024 + 1))).rejects.toThrow();
  await writer.writePart(1, new Uint8Array([1]));
  await expect(writer.seal(1, 1)).rejects.toThrow();
  await writer.writePart(0, new Uint8Array([2]));
  await expect(writer.seal(2, 3)).rejects.toThrow();
  await writer.seal(2, 2);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('connects a real SQL snapshot through encrypted storage and typed restoration', async () => {
  const schema: SnapshotTableSchema = {
    table: 'accounts',
    tenantColumn: 'tenant_id',
    columns: ['tenant_id', 'id', 'value', 'amount', 'blob'],
    primaryKey: ['tenant_id', 'id'],
    uniqueKeys: [],
  };
  const ddl =
    'CREATE TABLE accounts(tenant_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT,amount INTEGER,blob BLOB,PRIMARY KEY(tenant_id,id));';
  db.exec(ddl + SQLITE_SNAPSHOT_SCHEMA + sqliteSnapshotTriggers(schema));
  db.exec(
    "INSERT INTO accounts VALUES ('tenant-a','account','before',9007199254740993,X'00ff'); INSERT INTO accounts VALUES ('other','account','foreign',0,NULL); INSERT INTO tenant_backup_snapshots (id, tenant_id, state) VALUES ('snapshot','tenant-a','capturing'); UPDATE accounts SET value='after' WHERE tenant_id='tenant-a';"
  );
  const database = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
  };
  const session = await createTenantBundleKeyEnvelope('fixture SQL artifact backup password');
  const expected = {
    bundleId: Array.from(session.envelope.subarray(1, 17), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: {
      settings: false,
      users: true,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
    datasets: [
      {
        id: 'accounts',
        module: 'users' as const,
        kind: 'users' as const,
        store: 'database' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
    ],
  };
  const signal = new AbortController().signal;
  const manifest = {
    formatVersion: 1 as const,
    ...expected,
    snapshotId: 'snapshot',
    boundaryUnixMs: 100,
    inventoryDigestSha256: 'ab'.repeat(32),
  };
  let completed = false;
  let readTime = 102;
  let readLease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: 1,
  };
  const current = (await operations.get('tenant-a', 'operation'))!;
  const prepared = (await operations.checkpoint(
    readLease,
    current.revision,
    'export_artifact',
    JSON.stringify({ version: 1, attemptId: writer.attemptId }),
    readTime
  ))!;
  await operations.release(readLease, prepared.revision, 'queued', readTime);
  let loseCheckpoint = true;
  const schedulerDatabase = {
    ...adapter,
    query: database.query,
    async queryOne<T>(sql: string, params: unknown[] = []) {
      const result = await adapter.queryOne<T>(sql, params);
      if (loseCheckpoint && sql.includes('SET phase=?')) {
        loseCheckpoint = false;
        throw new Error('checkpoint_response_lost');
      }
      return result;
    },
  };

  for (let slice = 0; slice < 16; slice++) {
    readTime += 2000;
    const result = await runTenantBackupScheduler(
      schedulerDatabase,
      {
        async run(context) {
          if (context.operation.phase === 'verify_artifact')
            return runTenantBackupArtifactVerificationStep(context, {
              database: adapter,
              bucket,
              attemptId: writer.attemptId,
              key: session,
              now: () => readTime,
              expected,
            });
          if (context.operation.phase === 'release_export_resources')
            return {
              phase: 'publish_artifact',
              cursor: context.operation.cursor_json,
              disposition: 'continue',
            } as const;
          await TenantBackupArtifactWriter.resume(
            adapter,
            bucket,
            writer.attemptId,
            context.lease,
            () => readTime
          );
          await saveTenantBackupExportManifest({
            database: adapter,
            lease: context.lease,
            attemptId: writer.attemptId,
            manifest,
            expected,
            now: () => readTime,
          });
          return runTenantBackupArtifactStep(context, {
            database: adapter,
            bucket,
            attemptId: writer.attemptId,
            key: session,
            now: () => readTime,
            manifest,
            expected,
            async assertBoundary() {},
            async readNext(datasetId, cursor, signal) {
              expect(datasetId).toBe('accounts');
              return readNextSqliteSnapshotChunk(
                { database, schema, snapshotId: 'snapshot', tenantId: 'tenant-a', signal },
                cursor
              );
            },
          });
        },
        async cleanup() {
          throw new Error('unexpected_cleanup');
        },
      },
      signal,
      () => readTime
    );
    expect(result).toEqual({
      inspected: 1,
      advanced: slice === 0 ? 0 : 1,
      failures: slice === 0 ? 1 : 0,
    });
    const saved = (await operations.get('tenant-a', 'operation'))!;
    expect(saved.state).toBe('queued');
    if (saved.phase === 'publish_artifact') {
      completed = true;
      break;
    }
    expect(['export_artifact', 'verify_artifact', 'release_export_resources']).toContain(
      saved.phase
    );
  }
  expect(completed).toBe(true);
  const verifier = (await operations.claim('tenant-a', 'operation', 'verifier', ++readTime))!;
  readLease = { ...readLease, owner: 'verifier', fencingToken: verifier.fencing_token };
  const verifierContext = { operation: verifier, lease: readLease, signal };
  const wrongPhaseInput = {
    database: adapter,
    bucket,
    attemptId: writer.attemptId,
    key: session,
    now: () => readTime,
    manifest,
    expected,
    async assertBoundary() {},
    async readNext(): Promise<null> {
      throw new Error('must_not_read');
    },
  };
  await expect(runTenantBackupArtifactStep(verifierContext, wrongPhaseInput)).rejects.toThrow(
    'step_context'
  );
  await expect(
    runTenantBackupArtifactStep(
      {
        ...verifierContext,
        operation: {
          ...verifier,
          phase: 'export_artifact',
          cursor_json: '{"version":1,"attemptId":"other"}',
        },
      },
      wrongPhaseInput
    )
  ).rejects.toThrow('step_cursor');

  function saved() {
    return readTenantBackupArtifact({
      database: adapter,
      bucket,
      lease: readLease,
      attemptId: writer.attemptId,
      signal,
      now: () => readTime,
    });
  }
  let rows = '',
    complete = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const event of decodeTenantBundle(saved(), session, expected, {
    maxFrames: 20,
    maxTotalBytes: 1024 * 1024,
  })) {
    if (event.kind === 'chunk') rows += decoder.decode(event.bytes, { stream: true });
    if (event.kind === 'complete') complete = true;
  }
  rows += decoder.decode();
  expect(complete).toBe(true);
  const restored = new DatabaseSync(':memory:');
  try {
    restored.exec(ddl);
    for (const row of rows.trim().split('\n')) {
      const insert = sqliteSnapshotRowInsert(schema.table, schema.columns, row);
      restored.prepare(insert.sql).run(...insert.params);
    }
    const select = restored.prepare('SELECT * FROM accounts');
    select.setReadBigInts(true);
    expect(select.all()).toEqual([
      {
        tenant_id: 'tenant-a',
        id: 'account',
        value: 'before',
        amount: 9007199254740993n,
        blob: new Uint8Array([0, 255]),
      },
    ]);
  } finally {
    restored.close();
  }
});

it('adopts immutable parts after worker takeover and fences the prior writer', async () => {
  await writer.writePart(0, new Uint8Array([1, 2, 3]));
  const next = (await operations.claim('tenant-a', 'operation', 'next', 40000))!;
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'next',
    fencingToken: next.fencing_token,
  };
  const resumed = await TenantBackupArtifactWriter.resume(
    adapter,
    bucket,
    writer.attemptId,
    lease,
    () => 40001
  );
  expect(await resumed.progress()).toEqual({
    state: 'writing',
    reservedParts: 1,
    uploadedParts: 1,
    uploadedBytes: 3,
  });
  await expect(writer.writePart(1, new Uint8Array([4]))).rejects.toThrow('write_failed');
  await resumed.writePart(0, new Uint8Array([1, 2, 3]));
  await expect(resumed.writePart(0, new Uint8Array([9, 9, 9]))).rejects.toThrow('write_failed');
  await resumed.writePart(1, new Uint8Array([4]));
  expect(objects.size).toBe(2);
  await resumed.seal(2, 4);
  await resumed.seal(2, 4);
  await expect(resumed.seal(2, 5)).rejects.toThrow('write_failed');
  const reopened = await TenantBackupArtifactWriter.resume(
    adapter,
    bucket,
    writer.attemptId,
    lease,
    () => 40001
  );
  expect((await reopened.progress()).state).toBe('sealed');
  await expect(reopened.writePart(2, new Uint8Array([5]))).rejects.toThrow('write_failed');
});

it('does not count an uncertain upload until the new worker verifies the identical bytes', async () => {
  putHook = async () => {
    throw new Error('lost_reply');
  };
  await expect(writer.writePart(0, new Uint8Array([1, 2]))).rejects.toThrow('lost_reply');
  expect(await writer.progress()).toEqual({
    state: 'writing',
    reservedParts: 1,
    uploadedParts: 0,
    uploadedBytes: 0,
  });
  putHook = undefined;
  const next = (await operations.claim('tenant-a', 'operation', 'next', 40000))!;
  const resumed = await TenantBackupArtifactWriter.resume(
    adapter,
    bucket,
    writer.attemptId,
    {
      tenantId: 'tenant-a',
      operationId: 'operation',
      owner: 'next',
      fencingToken: next.fencing_token,
    },
    () => 40001
  );
  await resumed.writePart(0, new Uint8Array([1, 2]));
  expect(objects.size).toBe(1);
  expect((await resumed.progress()).uploadedBytes).toBe(2);
});

it('rejects adoption by a different operation or tenant and after cancellation', async () => {
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: 1,
  };
  for (const invalid of [
    { ...lease, tenantId: 'tenant-b' },
    { ...lease, operationId: 'other' },
    { ...lease, owner: 'other' },
  ])
    await expect(
      TenantBackupArtifactWriter.resume(adapter, bucket, writer.attemptId, invalid, () => 102)
    ).rejects.toThrow('write_failed');
  await operations.requestCancel('tenant-a', 'operation', 103);
  await expect(
    TenantBackupArtifactWriter.resume(adapter, bucket, writer.attemptId, lease, () => 104)
  ).rejects.toThrow('write_failed');
  await expect(writer.progress()).rejects.toThrow('write_failed');
});

it('resumes the same cipher stream under a new lease and decodes with the v1 reader', async () => {
  const session = await createTenantBundleKeyEnvelope('resumable cipher fixture password');
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: 1,
  };
  const journal = await TenantBackupCipherJournal.open(adapter, writer, lease, () => 102, session);
  await journal.write(0, new TextEncoder().encode('first'), ' {"cursor":1}');
  const next = (await operations.claim('tenant-a', 'operation', 'replacement', 40000))!;
  const nextLease = { ...lease, owner: 'replacement', fencingToken: next.fencing_token };
  const resumedWriter = await TenantBackupArtifactWriter.resume(
    adapter,
    bucket,
    writer.attemptId,
    nextLease,
    () => 40001
  );
  const resumed = await TenantBackupCipherJournal.open(
    adapter,
    resumedWriter,
    nextLease,
    () => 40001,
    session
  );
  expect((await resumed.progress()).checkpoint_json).toBe(' {"cursor":1}');
  await resumed.write(0, new TextEncoder().encode('first'), ' {"cursor":1}');
  await expect(
    resumed.write(0, new TextEncoder().encode('other'), ' {"cursor":1}')
  ).rejects.toThrow('journal_failed');
  await resumed.write(1, new TextEncoder().encode('second'), '{"cursor":2}');
  await resumed.finish(2, '{"complete":true}');
  await resumed.finish(2, '{"complete":true}');
  const rows = db
    .prepare('SELECT object_key FROM tenant_backup_artifact_parts ORDER BY ordinal')
    .all() as { object_key: string }[];
  async function* source() {
    for (const row of rows) yield objects.get(row.object_key)!.body;
  }
  const decoded = [];
  for await (const event of decryptTenantBundleStream(source(), session, {
    maxFrames: 20,
    maxTotalBytes: 10000,
  }))
    decoded.push(event.kind === 'chunk' ? new TextDecoder().decode(event.bytes) : 'complete');
  expect(decoded).toEqual(['first', 'second', 'complete']);
  expect((await resumedWriter.progress()).state).toBe('sealed');
});

it('pins plaintext and checkpoint before encryption even when upload acknowledgment is lost', async () => {
  const session = await createTenantBundleKeyEnvelope('resumable cipher fixture password');
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: 1,
  };
  const journal = await TenantBackupCipherJournal.open(adapter, writer, lease, () => 102, session);
  let puts = 0;
  putHook = async () => {
    if (++puts === 2) throw new Error('lost_reply');
  };
  await expect(journal.write(0, new Uint8Array([1, 2]), '{"cursor":1}')).rejects.toThrow(
    'lost_reply'
  );
  expect((await journal.progress()).next_sequence).toBe(0);
  expect((await journal.progress()).checkpoint_json).toBeNull();
  await expect(journal.write(0, new Uint8Array([3, 4]), '{"cursor":1}')).rejects.toThrow(
    'journal_failed'
  );
  await expect(journal.write(0, new Uint8Array([1, 2]), '{"cursor":9}')).rejects.toThrow(
    'journal_failed'
  );
  expect(() =>
    db.exec("UPDATE tenant_backup_cipher_frames SET plain_sha256='" + 'a'.repeat(64) + "'")
  ).toThrow('immutable');
  putHook = undefined;
  const reopened = await TenantBackupCipherJournal.open(adapter, writer, lease, () => 102, session);
  await reopened.write(0, new Uint8Array([1, 2]), '{"cursor":1}');
  expect(objects.size).toBe(2);
  expect((await reopened.progress()).next_sequence).toBe(1);
  expect((await reopened.progress()).plain_bytes).toBe(2);
  await expect(reopened.finish(0, '{}')).rejects.toThrow('journal_failed');
});

it('rejects another envelope, skipped sequence, and cancelled journal writes', async () => {
  const session = await createTenantBundleKeyEnvelope('resumable cipher fixture password');
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: 1,
  };
  const journal = await TenantBackupCipherJournal.open(adapter, writer, lease, () => 102, session);
  const other = await createTenantBundleKeyEnvelope('another fixture password');
  await expect(
    TenantBackupCipherJournal.open(adapter, writer, lease, () => 102, other)
  ).rejects.toThrow('journal_failed');
  await expect(journal.write(1, new Uint8Array([1]), '{}')).rejects.toThrow('journal_failed');
  await operations.requestCancel('tenant-a', 'operation', 103);
  await expect(journal.write(0, new Uint8Array([1]), '{}')).rejects.toThrow('journal_failed');
  expect(objects.size).toBe(0);
});

it('connects content checkpoints to cipher receipts and emits a complete restorable bundle', async () => {
  const session = await createTenantBundleKeyEnvelope('complete resumable fixture password');
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: 1,
  };
  const journal = await TenantBackupCipherJournal.open(adapter, writer, lease, () => 102, session);
  const expected = {
    bundleId: Array.from(session.envelope.subarray(1, 17), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
    datasets: [
      {
        id: 'assets',
        module: 'flows-ui' as const,
        kind: 'settings' as const,
        store: 'object' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
    ],
  };
  const manifest = {
    formatVersion: 1 as const,
    ...expected,
    snapshotId: 'snapshot',
    boundaryUnixMs: 100,
    inventoryDigestSha256: 'a'.repeat(64),
  };
  const input = { journal, manifest, expected };
  await expect(finishTenantBackupContent(input)).rejects.toThrow('checkpoint_failed');
  const commands: TenantBundleEncoderCommand[] = [
    { kind: 'manifest' },
    { kind: 'chunk', datasetId: 'assets', bytes: new TextEncoder().encode('asset bytes') },
    { kind: 'end', datasetId: 'assets' },
  ];
  for (const [sequence, command] of commands.entries()) {
    const reopened = await TenantBackupCipherJournal.open(
      adapter,
      writer,
      lease,
      () => 102,
      session
    );
    await writeTenantBackupContentFrame({
      ...input,
      journal: reopened,
      expectedSequence: sequence,
      command,
      nextSourceCursor: String(sequence + 1),
    });
    await expect(
      writeTenantBackupContentFrame({
        ...input,
        expectedSequence: sequence,
        command,
        nextSourceCursor: String(sequence + 1),
      })
    ).rejects.toThrow('checkpoint_failed');
  }
  await finishTenantBackupContent(input);
  await finishTenantBackupContent(input);
  const rows = db
    .prepare('SELECT object_key FROM tenant_backup_artifact_parts ORDER BY ordinal')
    .all() as { object_key: string }[];
  async function* bytes() {
    for (const row of rows) yield objects.get(row.object_key)!.body;
  }
  const events = [];
  for await (const event of decodeTenantBundle(bytes(), session, expected, {
    maxFrames: 20,
    maxTotalBytes: 10000,
  }))
    events.push(event);
  expect(events.map((e) => e.kind)).toEqual(['manifest', 'chunk', 'dataset_end', 'complete']);
  expect(JSON.parse((await journal.progress()).checkpoint_json!).sourceCursor).toBe('3');
  const verifyInput = {
    database: adapter,
    bucket,
    lease,
    attemptId: writer.attemptId,
    key: session,
    manifest,
    expected,
    signal: new AbortController().signal,
    now: () => 102,
  };
  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    const result = await verifyTenantBackupArtifactPart({ ...verifyInput, ordinal });
    expect(result.complete).toBe(ordinal === rows.length - 1);
  }
  await expect(
    verifyTenantBackupArtifactPart({
      ...verifyInput,
      ordinal: 1,
      manifest: { ...manifest, boundaryUnixMs: 101 },
    })
  ).rejects.toThrow('verification_failed');
  const part = objects.get(rows[1].object_key)!;
  part.body[5] ^= 1;
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(part.body))),
    (b) => b.toString(16).padStart(2, '0')
  ).join('');
  db.prepare('UPDATE tenant_backup_artifact_parts SET sha256=? WHERE ordinal=1').run(digest);
  await expect(verifyTenantBackupArtifactPart({ ...verifyInput, ordinal: 1 })).rejects.toThrow(
    'verification_failed'
  );
});

async function readSavedArtifact() {
  const chunks = [];
  for await (const bytes of readTenantBackupArtifact({
    database: adapter,
    bucket,
    lease: { tenantId: 'tenant-a', operationId: 'operation', owner: 'writer', fencingToken: 1 },
    attemptId: writer.attemptId,
    signal: new AbortController().signal,
    now: () => 102,
  }))
    chunks.push(bytes);
  return chunks;
}
it('readback rejects unsealed, missing, and corrupted ciphertext', async () => {
  await writer.writePart(0, new Uint8Array([1, 2, 3]));
  await expect(readSavedArtifact()).rejects.toThrow('read_failed');
  await writer.seal(1, 3);
  expect(await readSavedArtifact()).toEqual([new Uint8Array([1, 2, 3])]);
  const [key, object] = [...objects.entries()][0];
  object.body[0] = 9;
  await expect(readSavedArtifact()).rejects.toThrow('read_failed');
  objects.delete(key);
  await expect(readSavedArtifact()).rejects.toThrow('read_failed');
});

it('readback rejects missing receipts and declared total mismatch', async () => {
  await writer.writePart(0, new Uint8Array([1]));
  await writer.writePart(1, new Uint8Array([2]));
  await writer.seal(2, 2);
  db.exec('UPDATE tenant_backup_artifact_attempts SET byte_count=3');
  await expect(readSavedArtifact()).rejects.toThrow('read_failed');
  db.exec(
    'UPDATE tenant_backup_artifact_attempts SET byte_count=2; DELETE FROM tenant_backup_artifact_parts WHERE ordinal=1'
  );
  await expect(readSavedArtifact()).rejects.toThrow('read_failed');
});

it('readback exposes no part after cancellation during object fetch', async () => {
  await writer.writePart(0, new Uint8Array([1, 2]));
  await writer.seal(1, 2);
  const get = bucket.get.bind(bucket);
  const reader = readTenantBackupArtifact({
    database: adapter,
    bucket: {
      async get(key: string) {
        await operations.requestCancel('tenant-a', 'operation', 103);
        return get(key);
      },
    },
    lease: { tenantId: 'tenant-a', operationId: 'operation', owner: 'writer', fencingToken: 1 },
    attemptId: writer.attemptId,
    signal: new AbortController().signal,
    now: () => 102,
  });
  await expect(reader.next()).rejects.toThrow('read_failed');
});

it('readback bounds an oversized body and cancels its stream', async () => {
  await writer.writePart(0, new Uint8Array([1, 2]));
  await writer.seal(1, 2);
  let cancelled = false;
  const reader = readTenantBackupArtifact({
    database: adapter,
    bucket: {
      async get() {
        return {
          size: 2,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(3));
            },
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    },
    lease: { tenantId: 'tenant-a', operationId: 'operation', owner: 'writer', fencingToken: 1 },
    attemptId: writer.attemptId,
    signal: new AbortController().signal,
    now: () => 102,
  });
  await expect(reader.next()).rejects.toThrow('read_failed');
  expect(cancelled).toBe(true);
});

it('prepares one encrypted manifest after a released boundary and recovers without duplicate output', async () => {
  for (const [family, file] of [
    ['admin', '010_tenant_backup_execution_inventory.sql'],
    ['control', '005_tenant_backup_mutation_admission.sql'],
    ['control', '006_tenant_backup_mutation_environment_scope.sql'],
    ['control', '007_tenant_backup_boundary_receipts.sql'],
    ['control', '010_tenant_backup_snapshot_timestamp.sql'],
  ])
    db.exec(
      readFileSync(
        new URL(`../../../../../../migrations/${family}/d1/${file}`, import.meta.url),
        'utf8'
      )
    );
  const database = {
    ...adapter,
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
  };
  const operation = (await operations.get('tenant-a', 'operation'))!;
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: operation.fencing_token,
  };
  const inventory = new TenantBackupExecutionInventory(database, lease, () => 110);
  await inventory.create();
  const head = await inventory.head();
  await inventory.seal(head.item_count, head.chain_digest);
  const receipts = new TenantBackupBoundaryReceipts(adapter);
  const admission = new TenantBackupMutationAdmission(adapter, 'env');
  const identity = {
    environmentId: 'env',
    tenantId: 'tenant-a',
    boundaryId: 'cd'.repeat(32),
    operationId: 'operation',
    inventoryDigest: head.chain_digest,
  };
  const participants = [{ resourceId: 'source', snapshotId: 'snapshot' }];
  await admission.begin({
    id: identity.boundaryId,
    tenantId: identity.tenantId,
    operationId: identity.operationId,
    inventoryDigest: head.chain_digest,
    now: 102,
  });
  await receipts.plan(identity, participants, 103);
  await admission.hold('tenant-a', identity.boundaryId, 104);
  await receipts.acknowledge(identity, participants[0], 105);
  await receipts.release(identity, 106);
  const session = await createTenantBundleKeyEnvelope('fixture prepared artifact password');
  const expected = {
    bundleId: Array.from(session.envelope.subarray(1, 17), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    },
    datasets: [
      {
        id: 'assets',
        module: 'flows-ui' as const,
        kind: 'settings' as const,
        store: 'object' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
    ],
  };
  const manifest = {
    formatVersion: 1 as const,
    ...expected,
    snapshotId: identity.boundaryId,
    boundaryUnixMs: 104,
    inventoryDigestSha256: head.chain_digest,
  };
  const args = {
    context: {
      operation: {
        ...operation,
        phase: 'prepare_export_artifact',
        cursor_json: JSON.stringify({
          version: 1,
          boundaryId: identity.boundaryId,
          inventoryDigest: head.chain_digest,
          releasedAt: 104,
          participants,
        }),
      },
      lease,
      signal: new AbortController().signal,
    },
    inventory,
    receipts,
    environmentId: 'env',
    boundaryTenantId: 'tenant-a',
    database: adapter,
    bucket,
    key: session,
    manifest,
    expected,
    now: () => 110,
    async assertSources() {},
  };
  await expect(
    runPrepareTenantBackupArtifactStep({ ...args, manifest: { ...manifest, boundaryUnixMs: 107 } })
  ).rejects.toThrow('preparation_boundary');
  expect(objects.size).toBe(0);
  putHook = async () => {
    throw new Error('lost upload response');
  };
  await expect(runPrepareTenantBackupArtifactStep(args)).rejects.toThrow();
  putHook = undefined;
  const first = await runPrepareTenantBackupArtifactStep(args);
  expect(first.phase).toBe('export_artifact');
  const objectCount = objects.size;
  expect(await runPrepareTenantBackupArtifactStep(args)).toEqual(first);
  expect(objects.size).toBe(objectCount);
  expect(db.prepare('SELECT count(*) n FROM tenant_backup_artifact_attempts').get()?.n).toBe(2); // initial unrelated fixture attempt + one prepared attempt
  const changedExpected = {
    ...expected,
    datasets: [{ ...expected.datasets[0], schemaVersion: 2 }],
  };
  await expect(
    runPrepareTenantBackupArtifactStep({
      ...args,
      expected: changedExpected,
      manifest: { ...manifest, datasets: changedExpected.datasets },
    })
  ).rejects.toThrow();
  expect(objects.size).toBe(objectCount);
  const { attemptId } = JSON.parse(first.cursor!) as { attemptId: string };
  expect(
    await loadTenantBackupExportManifest({
      database: adapter,
      lease,
      attemptId,
      expected,
      now: () => 110,
    })
  ).toEqual(manifest);
  await expect(
    loadTenantBackupExportManifest({
      database: adapter,
      lease: { ...lease, tenantId: 'other' },
      attemptId,
      expected,
      now: () => 110,
    })
  ).rejects.toThrow();
  expect(() =>
    db
      .prepare("UPDATE tenant_backup_export_manifests SET manifest_json='{}' WHERE attempt_id=?")
      .run(attemptId)
  ).toThrow(/immutable/);

  expect(
    db
      .prepare('SELECT next_sequence FROM tenant_backup_cipher_streams WHERE attempt_id=?')
      .get(attemptId)?.next_sequence
  ).toBe(1);
});

it('recovers an uncertain attempt allocation and refuses another tenant or unsafe object identity', async () => {
  const operation = (await operations.get('tenant-a', 'operation'))!;
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation',
    owner: 'writer',
    fencingToken: operation.fencing_token,
  };
  const id = 'cd'.repeat(32);
  let lose = true;
  const uncertain = {
    ...adapter,
    async queryOne<T>(sql: string, params: unknown[] = []) {
      const result = await adapter.queryOne<T>(sql, params);
      if (lose && sql.includes('INSERT INTO tenant_backup_artifact_attempts')) {
        lose = false;
        throw new Error('lost allocation');
      }
      return result;
    },
  };
  await expect(
    TenantBackupArtifactWriter.createOrResume(uncertain, bucket, id, lease, () => 102)
  ).rejects.toThrow('lost allocation');
  expect(
    (await TenantBackupArtifactWriter.createOrResume(adapter, bucket, id, lease, () => 103))
      .attemptId
  ).toBe(id);
  await expect(
    TenantBackupArtifactWriter.createOrResume(
      adapter,
      bucket,
      id,
      { ...lease, tenantId: 'other' },
      () => 104
    )
  ).rejects.toThrow('backup_artifact_write_failed');
  await expect(
    TenantBackupArtifactWriter.createOrResume(adapter, bucket, '../escape', lease, () => 104)
  ).rejects.toThrow('backup_artifact_write_failed');
  expect(
    db.prepare('SELECT count(*) n FROM tenant_backup_artifact_attempts WHERE id=?').get(id)?.n
  ).toBe(1);
});

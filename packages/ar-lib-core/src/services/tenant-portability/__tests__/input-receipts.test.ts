import { runTenantBackupReferenceValidationStep } from '../validate-references-step';
import { runSqliteInputValidationStep } from '../validate-sqlite-input-step';
import { executeTenantBackupSlice } from '../operation-executor';
import { validateTenantBackupReferencePage } from '../validate-reference-page';
import { inspectSqliteInputRow } from '../sqlite-input-inspection';
import { DatabaseTenantBundleReferenceIndex } from '../validation-index';
import { persistTenantBackupInput, runPlannedTenantBackupInputDecodeStep } from '../input-plan';
import { TenantBackupExecutionInventory } from '../execution-inventory';
import { runTenantBackupInputDecodeStep } from '../decode-input-step';
import { readNextSqliteInputRow } from '../sqlite-input-row-source';
import { createTenantBundleKeyEnvelope } from '../bundle-key-envelope';
import { encodeTenantBundle } from '../bundle-codec';
import { decodeTenantBackupInputStep } from '../input-decode-step';
import type { TenantBundleManifestExpectation } from '../bundle-manifest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupOperationStore, type TenantBackupLease } from '../operation-store';
import { TenantBackupInputReceipts } from '../input-receipts';
import type { TenantBackupInputDecodeCheckpoint } from '../input-decode-step';
let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
let store: TenantBackupOperationStore;
let lease: TenantBackupLease;
let receipts: TenantBackupInputReceipts;
let now: number;
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '008_tenant_backup_retry_state.sql',
    '010_tenant_backup_execution_inventory.sql',
    '015_tenant_backup_input_receipts.sql',
    '016_tenant_backup_input_dataset_boundaries.sql',
    '017_tenant_backup_validation_record_sources.sql',
  ])
    db.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${file}`, import.meta.url),
        'utf8'
      )
    );
  adapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  store = new TenantBackupOperationStore(adapter);
  await store.create({
    id: 'op',
    tenantId: 'a',
    kind: 'import',
    idempotencyKey: 'request',
    requestDigest: 'a'.repeat(64),
    actorId: 'admin',
    now: 100,
  });
  const operation = await store.claim('a', 'op', 'worker', 101);
  if (!operation) throw new Error('missing_lease');
  lease = {
    tenantId: 'a',
    operationId: 'op',
    owner: 'worker',
    fencingToken: operation.fencing_token,
  };
  now = 102;
  receipts = new TenantBackupInputReceipts(adapter, lease, () => now);
});
afterEach(() => db.close());

const bundle = 'ab'.repeat(16);
const checkpoint: TenantBackupInputDecodeCheckpoint = {
  version: 1,
  identity: { key: 'owned/input', version: 'v1', etag: 'e1', size: 1000 },
  transport: { offset: 137, frames: 1 },
  headerHex: 'ab'.repeat(125),
  cipher: { version: 1, headerSha256: 'ab'.repeat(32), chunks: 0, bytes: 0, complete: false },
  content: {
    version: 1,
    manifestSha256: 'ab'.repeat(32),
    phase: 'manifest',
    datasetIndex: 0,
    chunks: 0,
    bytes: 0,
    chainSha256: '00'.repeat(32),
  },
  complete: false,
};
const result = { checkpoint, event: { kind: 'header' as const } };
it('persists once after an unknown write response and rejects conflicting retries', async () => {
  let uncertain = true;
  const writer = new TenantBackupInputReceipts(
    {
      async queryOne<T>(sql: string, params?: unknown[]) {
        const row = await adapter.queryOne<T>(sql, params);
        if (uncertain && sql.startsWith('INSERT')) {
          uncertain = false;
          throw new Error('response_lost');
        }
        return row;
      },
    },
    lease,
    () => now
  );
  await expect(writer.append(bundle, 0, null, result)).rejects.toThrow('response_lost');
  await writer.append(bundle, 0, null, result);
  expect((await writer.latest(bundle))?.checkpoint).toEqual(checkpoint);
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_input_receipts').get()?.n).toBe(1);
  await expect(
    writer.append(bundle, 0, null, { ...result, event: { kind: 'footer' } })
  ).rejects.toThrow();
  expect(() => db.exec("UPDATE tenant_backup_input_receipts SET event_sha256='aa'")).toThrow(
    'immutable'
  );
});
it('rejects missing or mismatched predecessors without moving the checkpoint', async () => {
  await receipts.append(bundle, 0, null, result);
  await expect(receipts.append(bundle, 2, checkpoint, result)).rejects.toThrow();
  await expect(
    receipts.append(bundle, 1, { ...checkpoint, headerHex: 'cc'.repeat(125) }, result)
  ).rejects.toThrow();
  expect((await receipts.latest(bundle))?.sequence).toBe(0);
});
it('allows a new lease to read while rejecting old and cross-tenant access', async () => {
  await receipts.append(bundle, 0, null, result);
  now = 40000;
  const claimed = await store.claim('a', 'op', 'successor', now);
  expect(claimed).not.toBeNull();
  const current = new TenantBackupInputReceipts(
    adapter,
    { ...lease, owner: 'successor', fencingToken: claimed!.fencing_token },
    () => now
  );
  expect((await current.latest(bundle))?.sequence).toBe(0);
  await expect(receipts.latest(bundle)).rejects.toThrow();
  await expect(receipts.append(bundle, 0, null, result)).rejects.toThrow();
  await expect(
    new TenantBackupInputReceipts(adapter, { ...lease, tenantId: 'other' }, () => now).latest(
      bundle
    )
  ).rejects.toThrow();
});

it('creates one deterministic validation session across an unknown insert response and takeover', async () => {
  let lose = true;
  const uncertain = {
    ...adapter,
    async queryOne<T>(sql: string, params?: unknown[]) {
      const row = await adapter.queryOne<T>(sql, params);
      if (lose && sql.startsWith('INSERT INTO tenant_backup_validation_sessions')) {
        lose = false;
        throw new Error('response_lost');
      }
      return row;
    },
  };
  await expect(
    DatabaseTenantBundleReferenceIndex.createOrResume(
      uncertain,
      'validation-session',
      lease,
      () => now
    )
  ).rejects.toThrow('response_lost');
  const first = await DatabaseTenantBundleReferenceIndex.createOrResume(
    adapter,
    'validation-session',
    lease,
    () => now
  );
  expect(first.sessionId).toBe('validation-session');
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_validation_sessions').get()?.n).toBe(
    1
  );
  now = 40000;
  const claimed = await store.claim('a', 'op', 'successor', now);
  if (!claimed) throw new Error('missing_successor');
  const nextLease = { ...lease, owner: 'successor', fencingToken: claimed.fencing_token };
  expect(
    (
      await DatabaseTenantBundleReferenceIndex.createOrResume(
        adapter,
        'validation-session',
        nextLease,
        () => now
      )
    ).sessionId
  ).toBe('validation-session');
  await expect(
    DatabaseTenantBundleReferenceIndex.createOrResume(
      adapter,
      'validation-session',
      { ...nextLease, tenantId: 'other' },
      () => now
    )
  ).rejects.toThrow('fenced');
});

it('replays authenticated committed content without writes and rejects missing validation or altered receipts', async () => {
  const session = await createTenantBundleKeyEnvelope('fixture passphrase for input replay');
  const expected: TenantBundleManifestExpectation = {
    bundleId: [...session.envelope.slice(1, 17)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
    source: { tenantId: 'a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
      artifacts: false,
    },
    datasets: [
      {
        id: 'core.clients',
        module: 'applications',
        kind: 'settings',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
    ],
  };
  expected.datasets = [
    ...expected.datasets,
    { ...expected.datasets[0], id: 'core.empty' },
    { ...expected.datasets[0], id: 'core.last' },
  ];
  const manifest = {
    formatVersion: 1 as const,
    bundleId: expected.bundleId,
    source: expected.source,
    snapshotId: 'snapshot',
    boundaryUnixMs: 123,
    inventoryDigestSha256: 'ab'.repeat(32),
    selection: expected.selection,
    datasets: [...expected.datasets],
  };
  async function* source<T>(items: T[]) {
    yield* items;
  }
  const parts: Uint8Array[] = [];
  for await (const part of encodeTenantBundle(
    manifest,
    source([
      {
        datasetId: 'core.clients',
        chunks: source([
          new TextEncoder().encode('{"id":["text","private row"]}\n{"id":["text","second"]}\n'),
        ]),
      },
      { datasetId: 'core.empty', chunks: source<Uint8Array>([]) },
      {
        datasetId: 'core.last',
        chunks: source([new TextEncoder().encode('{"id":["text","last"]}\n')]),
      },
    ]),
    session,
    expected
  ))
    parts.push(part);
  const bytes = new Uint8Array(Buffer.concat(parts));
  const identity = { key: 'owned/input', version: 'v1', etag: 'e1', size: bytes.length };
  const input = {
    identity,
    session,
    manifest,
    expected,
    limits: { maxTotalBytes: 10000, maxFrames: 20 },
    signal: new AbortController().signal,
    assertAuthorized: async () => {},
    bucket: {
      get: async (_key: string, options: { range: { offset: number; length: number } }) => ({
        ...identity,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              bytes.slice(options.range.offset, options.range.offset + options.range.length)
            );
            controller.close();
          },
        }),
      }),
    },
  };
  let saved: TenantBackupInputDecodeCheckpoint | null = null;
  let sequence = 0;
  while (!saved?.complete) {
    const result = await decodeTenantBackupInputStep({ ...input, checkpoint: saved });
    await receipts.append(expected.bundleId, sequence++, saved, result);
    saved = result.checkpoint;
    if (!saved.complete)
      await expect(receipts.replay(expected.bundleId, 0, input)).rejects.toThrow();
  }
  const operation = await store.get('a', 'op');
  if (!operation) throw new Error('missing operation');
  const stepContext = {
    operation: {
      ...operation,
      phase: 'decode_input',
      cursor_json: JSON.stringify({ version: 1, bundleId: expected.bundleId }),
    },
    lease,
    signal: input.signal,
  };
  const stepInput = {
    ...input,
    database: adapter,
    now: () => now,
    assertPinnedInput: async () => {},
  };
  expect((await runTenantBackupInputDecodeStep(stepContext, stepInput)).phase).toBe(
    'validate_input_modules'
  );
  await expect(
    runTenantBackupInputDecodeStep(
      {
        ...stepContext,
        operation: {
          ...stepContext.operation,
          cursor_json: JSON.stringify({ version: 1, bundleId: 'ff'.repeat(16) }),
        },
      },
      stepInput
    )
  ).rejects.toThrow('backup_decode_input_step_invalid');
  await expect(
    runTenantBackupInputDecodeStep(stepContext, {
      ...stepInput,
      assertPinnedInput: async () => {
        throw new Error('input_unpinned');
      },
    })
  ).rejects.toThrow('input_unpinned');
  const inventory = new TenantBackupExecutionInventory(adapter, lease, () => now);
  await inventory.create();
  const uploadPlan = {
    context: stepContext,
    inventory,
    ordinal: 0,
    identity,
    limits: input.limits,
    manifest,
    expected,
    assertUploadOwnership: async () => {},
  };
  await persistTenantBackupInput(uploadPlan);
  const plannedStep = {
    inventory,
    ordinal: 0,
    expected,
    database: adapter,
    bucket: input.bucket,
    session,
    now: () => now,
  };
  await expect(runPlannedTenantBackupInputDecodeStep(stepContext, plannedStep)).rejects.toThrow();
  await expect(
    persistTenantBackupInput({ ...uploadPlan, identity: { ...identity, version: 'changed' } })
  ).rejects.toThrow();
  const planHead = await inventory.head();
  await inventory.seal(planHead.item_count, planHead.chain_digest);
  expect((await runPlannedTenantBackupInputDecodeStep(stepContext, plannedStep)).phase).toBe(
    'validate_input_modules'
  );
  await expect(
    runPlannedTenantBackupInputDecodeStep(stepContext, { ...plannedStep, ordinal: 1 })
  ).rejects.toThrow();
  const readOnly = new TenantBackupInputReceipts(
    {
      async queryOne<T>(sql: string, params?: unknown[]) {
        expect(sql.startsWith('SELECT')).toBe(true);
        return adapter.queryOne<T>(sql, params);
      },
    },
    lease,
    () => now
  );
  const event = await readOnly.replay(expected.bundleId, 2, input);
  expect(event.kind).toBe('chunk');
  if (event.kind === 'chunk')
    expect(new TextDecoder().decode(event.bytes)).toContain('private row');
  expect(
    JSON.stringify(db.prepare('SELECT * FROM tenant_backup_input_receipts').all())
  ).not.toContain('private row');
  const rowInput = {
    receipts: readOnly,
    replayInput: input,
    datasetId: 'core.clients',
    firstSequence: 2,
    sourceCursor: null,
    planDigest: 'ab'.repeat(32),
    assertValidatedPlan: async () => {},
  };
  rowInput.firstSequence = await readOnly.datasetStart(expected.bundleId, 'core.clients', input);
  expect(rowInput.firstSequence).toBe(2);
  const emptyStart = await readOnly.datasetStart(expected.bundleId, 'core.empty', input);
  const lastStart = await readOnly.datasetStart(expected.bundleId, 'core.last', input);
  expect(
    await readNextSqliteInputRow({
      ...rowInput,
      datasetId: 'core.empty',
      firstSequence: emptyStart,
    })
  ).toBeNull();
  expect(
    (
      await readNextSqliteInputRow({
        ...rowInput,
        datasetId: 'core.last',
        firstSequence: lastStart,
      })
    )?.rowJson
  ).toBe('{"id":["text","last"]}');
  await expect(readOnly.datasetStart(expected.bundleId, 'missing', input)).rejects.toThrow();
  const firstRow = await readNextSqliteInputRow(rowInput);
  expect(firstRow?.rowJson).toBe('{"id":["text","private row"]}');
  const secondRow = await readNextSqliteInputRow({
    ...rowInput,
    sourceCursor: firstRow!.nextCursor,
  });
  expect(secondRow?.rowJson).toBe('{"id":["text","second"]}');
  expect(
    await readNextSqliteInputRow({ ...rowInput, sourceCursor: secondRow!.nextCursor })
  ).toBeNull();
  const splitRow = new TextEncoder().encode('{"id":["text","日本語"]}\n');
  const readSplit = {
    ...rowInput,
    receipts: {
      replay: async (_bundleId: string, ordinal: number) => {
        return {
          kind: 'chunk' as const,
          datasetId: 'core.clients',
          ordinal: ordinal - 2,
          bytes: splitRow.slice(ordinal - 2, ordinal - 1),
        };
      },
    },
    replayInput: { ...input, limits: { ...input.limits, maxFrames: 100 } },
  };
  expect((await readNextSqliteInputRow(readSplit))?.rowJson).toBe('{"id":["text","日本語"]}');
  await expect(
    readNextSqliteInputRow({
      ...rowInput,
      sourceCursor: JSON.stringify({
        version: 1,
        bundleId: expected.bundleId,
        datasetId: 'core.clients',
        sequence: 2,
        offset: 1,
      }),
    })
  ).rejects.toThrow();
  await expect(
    readNextSqliteInputRow({
      ...rowInput,
      assertValidatedPlan: async () => {
        throw new Error('validation_revoked');
      },
    })
  ).rejects.toThrow('validation_revoked');
  await expect(readOnly.replay(expected.bundleId, sequence, input)).rejects.toThrow();
  db.exec('DROP TRIGGER tenant_backup_input_receipt_immutable');
  db.prepare('UPDATE tenant_backup_input_receipts SET event_sha256=? WHERE sequence=2').run(
    '00'.repeat(32)
  );
  await expect(readOnly.replay(expected.bundleId, 2, input)).rejects.toThrow();
});

it('resumes reference validation and distinguishes replayed positions from duplicate identities', async () => {
  const index = await DatabaseTenantBundleReferenceIndex.create(adapter, lease, () => now);
  const identity = {
    tenantId: 'a',
    module: 'applications' as const,
    collection: 'core.clients',
    id: 'client',
  };
  const dependency = {
    from: identity,
    to: { ...identity, meaning: 'resource' as const, requirement: 'required' as const },
  };
  expect(await index.recordOnce(bundle, 'dataset:row:0', identity)).toBe(true);
  expect(await index.recordOnce(bundle, 'dataset:row:0', identity)).toBe(true);
  expect(await index.recordOnce(bundle, 'dataset:row:1', identity)).toBe(false);
  expect(await index.recordOnce(bundle, 'dataset:row:0', { ...identity, id: 'changed' })).toBe(
    false
  );
  await index.referenceOnce(bundle, 'dataset:row:0:edge:0', dependency);
  await index.referenceOnce(bundle, 'dataset:row:0:edge:0', dependency);
  await expect(
    index.referenceOnce(bundle, 'dataset:row:0:edge:0', {
      ...dependency,
      to: { ...dependency.to, id: 'different' },
    })
  ).rejects.toThrow('retry_conflict');
  now = 40000;
  const next = await store.claim('a', 'op', 'successor', now);
  if (!next) throw new Error('missing successor');
  const nextLease = { ...lease, owner: 'successor', fencingToken: next.fencing_token };
  const resumed = await DatabaseTenantBundleReferenceIndex.resume(
    adapter,
    index.sessionId,
    nextLease,
    () => now
  );
  expect(await resumed.recordOnce(bundle, 'dataset:row:0', identity)).toBe(true);
  expect(await index.recordOnce(bundle, 'dataset:row:0', identity)).toBe(false);
  await expect(
    DatabaseTenantBundleReferenceIndex.resume(adapter, index.sessionId, lease, () => now)
  ).rejects.toThrow('fenced');
  await expect(
    DatabaseTenantBundleReferenceIndex.resume(
      adapter,
      index.sessionId,
      { ...nextLease, tenantId: 'other' },
      () => now
    )
  ).rejects.toThrow('fenced');
  const references = [];
  for await (const edge of resumed.references()) references.push(edge);
  expect(references).toEqual([{ bundleId: bundle, dependency }]);
  expect(await resumed.hasRecord(identity)).toBe(true);
  expect(await resumed.recordOnce(bundle, 'dataset:row:0', identity)).toBe(false);
});

it('inspects SQL row ownership before recording and retries partially saved references', async () => {
  const index = await DatabaseTenantBundleReferenceIndex.create(adapter, lease, () => now);
  const dataset = {
    id: 'core.clients',
    module: 'applications' as const,
    kind: 'settings' as const,
    store: 'database' as const,
    schemaVersion: 1,
    disposition: 'include' as const,
  };
  const manifest = {
    formatVersion: 1 as const,
    bundleId: bundle,
    source: { tenantId: 'a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
      artifacts: false,
    },
    snapshotId: 's',
    boundaryUnixMs: 1,
    inventoryDigestSha256: 'ab'.repeat(32),
    datasets: [dataset],
  };
  const policy = {
    dataset,
    schema: {
      table: 'clients',
      columns: ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    async inspectRow(
      _row: unknown,
      identity: import('../reference-contract').TenantPortableRecordIdentity
    ) {
      return [
        {
          from: identity,
          to: { ...identity, meaning: 'resource' as const, requirement: 'required' as const },
        },
      ];
    },
  };
  let loseResponse = true;
  const request = {
    policy,
    manifest,
    rowJson: '{"id":["text","c"],"tenant_id":["text","a"]}',
    rowOrdinal: 0,
    assertPinnedInput: async () => {},
    index: {
      recordOnce: index.recordOnce.bind(index),
      async referenceOnce(...args: Parameters<typeof index.referenceOnce>) {
        await index.referenceOnce(...args);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('lost_reference_response');
        }
      },
    },
  };
  await expect(inspectSqliteInputRow(request)).rejects.toThrow('lost_reference_response');
  await inspectSqliteInputRow(request);
  await expect(inspectSqliteInputRow({ ...request, rowOrdinal: 1 })).rejects.toThrow();
  await expect(
    inspectSqliteInputRow({
      ...request,
      rowOrdinal: 2,
      rowJson: '{"id":["text","other"],"tenant_id":["text","b"]}',
    })
  ).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_validation_records').get()?.n).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_validation_references').get()?.n).toBe(
    1
  );
  const operation = await store.get('a', 'op');
  if (!operation) throw new Error('missing operation');
  const checkpoint = await store.checkpoint(
    lease,
    operation.revision,
    'validate_sqlite_dataset',
    JSON.stringify({
      version: 1,
      sessionId: index.sessionId,
      bundleId: bundle,
      datasetId: dataset.id,
      sourceCursor: null,
      rows: 0,
    }),
    now
  );
  if (!checkpoint) throw new Error('missing checkpoint');
  await store.release(lease, checkpoint.revision, 'queued', now);
  for (let slice = 0; slice < 3; slice++) {
    now += slice === 1 ? 40000 : 1;
    const execution = executeTenantBackupSlice(
      store,
      {
        tenantId: 'a',
        operationId: 'op',
        workerId: `validation-${slice}`,
        signal: new AbortController().signal,
      },
      {
        async run(context) {
          const result = await runSqliteInputValidationStep(context, {
            database: adapter,
            now: () => now,
            sessionId: index.sessionId,
            policy,
            manifest,
            assertPinnedInput: async () => {},
            readNextRow: async (cursor) =>
              cursor === null ? { rowJson: request.rowJson, nextCursor: 'row:1' } : null,
          });
          if (slice === 0) throw new Error('lost_validation_cursor_response');
          return result;
        },
        async cleanup() {
          throw new Error('unexpected cleanup');
        },
      },
      () => now
    );
    if (slice === 0) await expect(execution).rejects.toThrow('backup_operation_slice_failed');
    else expect((await execution).outcome).toBe('yielded');
  }
  expect((await store.get('a', 'op'))?.phase).toBe('advance_validation_dataset');
  expect(JSON.parse((await store.get('a', 'op'))!.cursor_json!).rows).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_validation_records').get()?.n).toBe(1);
});

it('resolves references in resumed pages and preserves only historical admin provenance exceptions', async () => {
  const index = await DatabaseTenantBundleReferenceIndex.create(adapter, lease, () => now);
  const identity = {
    tenantId: 'a',
    module: 'applications' as const,
    collection: 'core.clients',
    id: 'client',
  };
  expect(await index.recordOnce(bundle, 'row:0', identity)).toBe(true);
  for (let ordinal = 0; ordinal < 101; ordinal++) {
    await index.referenceOnce(bundle, `edge:${String(ordinal).padStart(3, '0')}`, {
      from: identity,
      to:
        ordinal === 100
          ? { ...identity, id: 'former-admin', meaning: 'admin_actor', requirement: 'provenance' }
          : { ...identity, meaning: 'resource', requirement: 'required' },
    });
  }
  const guard = async () => {};
  const first = await validateTenantBackupReferencePage({
    index,
    after: '',
    assertCompleteInputInspection: guard,
  });
  expect(first).toMatchObject({ examined: 100, done: false, unresolvedProvenance: 0 });
  expect(
    await validateTenantBackupReferencePage({
      index,
      after: '',
      assertCompleteInputInspection: guard,
    })
  ).toEqual(first);
  now = 40000;
  const next = await store.claim('a', 'op', 'successor', now);
  if (!next) throw new Error('missing successor');
  const nextLease = { ...lease, owner: 'successor', fencingToken: next.fencing_token };
  const resumed = await DatabaseTenantBundleReferenceIndex.resume(
    adapter,
    index.sessionId,
    nextLease,
    () => now
  );
  const second = await validateTenantBackupReferencePage({
    index: resumed,
    after: first.nextCursor,
    assertCompleteInputInspection: guard,
  });
  expect(second).toMatchObject({ examined: 1, done: true, unresolvedProvenance: 1 });
  await expect(
    validateTenantBackupReferencePage({
      index,
      after: first.nextCursor,
      assertCompleteInputInspection: guard,
    })
  ).rejects.toThrow();
  for (const missing of ['target', 'source'] as const) {
    const broken = await DatabaseTenantBundleReferenceIndex.create(adapter, nextLease, () => now);
    if (missing === 'target') await broken.recordOnce(bundle, 'row:0', identity);
    await broken.referenceOnce(bundle, 'edge:0', {
      from: identity,
      to: { ...identity, id: 'missing', meaning: 'resource', requirement: 'required' },
    });
    await expect(
      validateTenantBackupReferencePage({
        index: broken,
        after: '',
        assertCompleteInputInspection: guard,
      })
    ).rejects.toThrow(`backup_reference_${missing}_missing`);
  }
  const inputSetDigest = 'ab'.repeat(32);
  const prepared = await store.checkpoint(
    nextLease,
    next.revision,
    'validate_input_references',
    JSON.stringify({
      version: 1,
      sessionId: index.sessionId,
      inputSetDigest,
      after: '',
      examined: 0,
      unresolvedProvenance: 0,
    }),
    now
  );
  if (!prepared) throw new Error('missing reference checkpoint');
  await store.release(nextLease, prepared.revision, 'queued', now);
  for (let slice = 0; slice < 3; slice++) {
    now += slice === 1 ? 40000 : 1;
    const execution = executeTenantBackupSlice(
      store,
      {
        tenantId: 'a',
        operationId: 'op',
        workerId: `references-${slice}`,
        signal: new AbortController().signal,
      },
      {
        async run(context) {
          const result = await runTenantBackupReferenceValidationStep(context, {
            database: adapter,
            now: () => now,
            sessionId: index.sessionId,
            inputSetDigest,
            assertCompleteInputInspection: guard,
          });
          if (slice === 0) throw new Error('lost_reference_page_checkpoint');
          return result;
        },
        async cleanup() {
          throw new Error('unexpected cleanup');
        },
      },
      () => now
    );
    if (slice === 0) await expect(execution).rejects.toThrow('backup_operation_slice_failed');
    else expect((await execution).outcome).toBe('yielded');
  }
  const finished = await store.get('a', 'op');
  expect(finished?.phase).toBe('finalize_input_validation');
  expect(JSON.parse(finished!.cursor_json!)).toMatchObject({
    examined: 101,
    unresolvedProvenance: 1,
  });
});

import { DatabaseTenantBundleReferenceIndex } from '../validation-index';
import {
  persistSqliteRestoreSequence,
  runSqliteRestoreSequenceStep,
} from '../restore-sqlite-sequence';
import {
  runSqliteRestoreDatasetDeferredStep,
  runSqliteRestoreDatasetStep,
  runSqliteRestoreDatasetVerificationStep,
} from '../restore-sqlite-step';
import { runTenantBackupScheduler } from '../operation-scheduler';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TenantBackupOperationStore } from '../operation-store';
import { TenantBackupExecutionInventory } from '../execution-inventory';
import type { TenantBackupStepContext } from '../operation-executor';
import {
  persistInitializedSqliteRestoreTarget,
  openPlannedSqliteRestoreTarget,
} from '../sqlite-restore-plan';
import type { SqliteDatasetInspectionPolicy } from '../sqlite-dataset-inspector';
import type { TenantBundleManifest } from '../bundle-manifest';
let admin: DatabaseSync, target: DatabaseSync, now: number;
function adapter(db: DatabaseSync) {
  return {
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
}
let store: TenantBackupOperationStore,
  context: TenantBackupStepContext,
  inventory: TenantBackupExecutionInventory;
const resource = () => ({
  targetId: 'target',
  resourceId: 'physical',
  provisioningId: 'provision-op',
  database: adapter(target),
});
const policy: SqliteDatasetInspectionPolicy = {
  dataset: {
    id: 'core.tenants',
    module: 'tenant-runtime',
    kind: 'settings',
    store: 'database',
    schemaVersion: 1,
    disposition: 'include',
  },
  schema: {
    table: 'tenants',
    columns: ['id', 'value'],
    primaryKey: ['id'],
    uniqueKeys: [],
    tenantColumn: 'id',
  },
  async inspectRow() {
    return [];
  },
};
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: { tenantId: 'a', issuer: 'https://example.test', productVersion: '0.4.2' },
  selection: {
    settings: true,
    users: false,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' },
  },
  snapshotId: 's',
  boundaryUnixMs: 1,
  inventoryDigestSha256: 'b'.repeat(64),
  datasets: [policy.dataset],
};
const row = '{"id":["text","a"],"value":["text","restored"]}';
beforeEach(async () => {
  admin = new DatabaseSync(':memory:');
  target = new DatabaseSync(':memory:');
  now = 101;
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '008_tenant_backup_retry_state.sql',
    '010_tenant_backup_execution_inventory.sql',
    '019_tenant_backup_input_validations.sql',
  ])
    admin.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${file}`, import.meta.url),
        'utf8'
      )
    );
  target.exec(
    readFileSync(
      new URL(
        '../../../../../../migrations/core/d1/010_tenant_backup_restore_target.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  target.exec('CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT)');
  store = new TenantBackupOperationStore(adapter(admin));
  await store.create({
    id: 'import',
    tenantId: 'a',
    kind: 'import',
    idempotencyKey: 'request',
    requestDigest: 'a'.repeat(64),
    actorId: 'admin',
    now: 100,
  });
  await claim('worker');
  await inventory.create();
});
afterEach(() => {
  admin.close();
  target.close();
});
async function claim(owner: string) {
  const operation = await store.claim('a', 'import', owner, now);
  if (!operation) throw new Error('claim_missing');
  const lease = {
    tenantId: 'a',
    operationId: 'import',
    owner,
    fencingToken: operation.fencing_token,
  };
  context = { operation, lease, signal: new AbortController().signal };
  inventory = new TenantBackupExecutionInventory(adapter(admin), lease, () => now);
}
async function persist() {
  await persistInitializedSqliteRestoreTarget({
    context,
    inventory,
    ordinal: 0,
    resource: resource(),
    async assertProvisioningOwnership() {},
  });
}
async function seal() {
  const head = await inventory.head();
  await inventory.seal(head.item_count, head.chain_digest);
  // These target-unit tests start after input validation. The runtime suite builds the real proof.
  admin
    .prepare(
      "INSERT INTO tenant_backup_validation_sessions(id,tenant_id,operation_id,fencing_token,state,created_at) VALUES('validated-input','a','import',?,'sealed',?)"
    )
    .run(context.lease.fencingToken, now);
  admin
    .prepare(
      "INSERT INTO tenant_backup_input_validations(operation_id,tenant_id,session_id,input_inventory_digest,examined_references,unresolved_provenance) VALUES('import','a','validated-input',?,0,0)"
    )
    .run(head.chain_digest);
}
function openInput() {
  return {
    context,
    inventory,
    ordinal: 0,
    targetId: 'target',
    now: () => now,
    async resolve(resourceId: string, provisioningId: string) {
      expect(resourceId).toBe('physical');
      expect(provisioningId).toBe('provision-op');
      return resource();
    },
    async assertValidatedUnpublishedPlan(digest: string) {
      expect(digest).toBe((await inventory.head()).chain_digest);
    },
  };
}
it('persists initialization once and restores through the same sealed plan across worker takeover', async () => {
  await persist();
  await persist();
  await seal();
  expect((await inventory.head()).item_count).toBe(1);
  const original = await openPlannedSqliteRestoreTarget(openInput());
  await original.writeRow(policy, manifest, row);
  now = 600101;
  await claim('replacement');
  const resumed = await openPlannedSqliteRestoreTarget(openInput());
  await resumed.writeRow(policy, manifest, row);
  await expect(original.writeRow(policy, manifest, row)).rejects.toThrow('fenced');
  const sealer = await openPlannedSqliteRestoreTarget({ ...openInput(), mode: 'seal' });
  await sealer.seal();
  const reader = await openPlannedSqliteRestoreTarget({ ...openInput(), mode: 'verify' });
  await reader.verifyRow(policy, manifest, row);
  await reader.verifyDataset(policy, 1);
  await expect(resumed.writeRow(policy, manifest, row)).rejects.toThrow();

  expect(target.prepare('SELECT * FROM tenants').all()).toEqual([{ id: 'a', value: 'restored' }]);
});
it('does not redefine the seed on retry after target data changes', async () => {
  await persist();
  target.exec("INSERT INTO tenants VALUES ('used','existing')");
  await expect(persist()).rejects.toThrow();
  await seal();
  await expect(openPlannedSqliteRestoreTarget(openInput())).rejects.toThrow('target_rejected');
  expect(target.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()?.n).toBe(
    0
  );
});
it('restores child-first self references through a resumable deferred pass', async () => {
  target.exec(
    'CREATE TABLE roles(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL,parent_role_id TEXT REFERENCES roles(id)); CREATE TABLE role_updates(id TEXT); CREATE TRIGGER role_parent_updated AFTER UPDATE OF parent_role_id ON roles BEGIN INSERT INTO role_updates VALUES(NEW.id); END'
  );
  const rolePolicy: SqliteDatasetInspectionPolicy = {
    dataset: { ...policy.dataset, id: 'core.roles', module: 'authorization' },
    schema: {
      table: 'roles',
      columns: ['id', 'tenant_id', 'parent_role_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    deferredColumns: ['parent_role_id'],
    async inspectRow() {
      return [];
    },
  };
  const roleManifest = { ...manifest, datasets: [rolePolicy.dataset] };
  const child =
    '{"id":["text","child"],"tenant_id":["text","a"],"parent_role_id":["text","parent"]}';
  const parent = '{"id":["text","parent"],"tenant_id":["text","a"],"parent_role_id":["null",null]}';
  const readNextValidatedRow = async ({ sourceCursor }: { sourceCursor: string | null }) =>
    sourceCursor === null
      ? { rowJson: child, nextCursor: 'child' }
      : sourceCursor === 'child'
        ? { rowJson: parent, nextCursor: 'parent' }
        : null;
  await persist();
  await seal();
  let phase = 'apply_sqlite_dataset';
  let cursor = JSON.stringify({
    version: 1,
    targetId: 'target',
    targetOrdinal: 0,
    datasetId: rolePolicy.dataset.id,
    sourceCursor: null,
    rowsWritten: 0,
  });
  const input = {
    ...openInput(),
    policy: rolePolicy,
    manifest: roleManifest,
    readNextValidatedRow,
  };
  while (phase === 'apply_sqlite_dataset') {
    const result = await runSqliteRestoreDatasetStep(
      { ...context, operation: { ...context.operation, phase, cursor_json: cursor } },
      input
    );
    phase = result.phase;
    cursor = result.cursor ?? '';
  }
  expect(phase).toBe('apply_sqlite_dataset_deferred');
  expect(target.prepare("SELECT parent_role_id FROM roles WHERE id='child'").get()).toEqual({
    parent_role_id: null,
  });
  while (phase === 'apply_sqlite_dataset_deferred') {
    const result = await runSqliteRestoreDatasetDeferredStep(
      { ...context, operation: { ...context.operation, phase, cursor_json: cursor } },
      input
    );
    phase = result.phase;
    cursor = result.cursor ?? '';
  }
  expect(phase).toBe('verify_sqlite_dataset');
  expect(target.prepare("SELECT parent_role_id FROM roles WHERE id='child'").get()).toEqual({
    parent_role_id: 'parent',
  });
  expect(target.prepare('SELECT id FROM role_updates').all()).toEqual([{ id: 'child' }]);
  const resumed = await openPlannedSqliteRestoreTarget(openInput());
  await resumed.restoreDeferredRow(rolePolicy, roleManifest, child);
  expect(target.prepare('SELECT id FROM role_updates').all()).toEqual([{ id: 'child' }]);
  expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  while (phase === 'verify_sqlite_dataset') {
    const result = await runSqliteRestoreDatasetVerificationStep(
      { ...context, operation: { ...context.operation, phase, cursor_json: cursor } },
      input
    );
    phase = result.phase;
    cursor = result.cursor ?? '';
  }
  expect(phase).toBe('advance_restore_dataset');
});
it('requires a sealed validated unpublished plan and exact provisioning destination', async () => {
  await persist();
  await expect(openPlannedSqliteRestoreTarget(openInput())).rejects.toThrow('plan_invalid');
  await seal();
  await expect(
    openPlannedSqliteRestoreTarget({
      ...openInput(),
      async assertValidatedUnpublishedPlan() {
        throw new Error('not_validated');
      },
    })
  ).rejects.toThrow('not_validated');
  await expect(
    openPlannedSqliteRestoreTarget({
      ...openInput(),
      async resolve() {
        return { ...resource(), resourceId: 'other' };
      },
    })
  ).rejects.toThrow('plan_invalid');
  await expect(openPlannedSqliteRestoreTarget({ ...openInput(), ordinal: 1 })).rejects.toThrow(
    'plan_invalid'
  );
  expect(target.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()?.n).toBe(
    0
  );
});
it('rejects mismatched context leases, cancellation during resolution and unowned provisioning', async () => {
  await expect(
    persistInitializedSqliteRestoreTarget({
      context,
      inventory,
      ordinal: 0,
      resource: resource(),
      async assertProvisioningOwnership() {
        throw new Error('not_owned');
      },
    })
  ).rejects.toThrow('not_owned');
  expect((await inventory.head()).item_count).toBe(0);
  await persist();
  await seal();
  await expect(
    openPlannedSqliteRestoreTarget({
      ...openInput(),
      context: { ...context, lease: { ...context.lease, owner: 'other' } },
    })
  ).rejects.toThrow('fenced');
  await expect(
    openPlannedSqliteRestoreTarget({
      ...openInput(),
      async resolve() {
        await store.requestCancel('a', 'import', now);
        return resource();
      },
    })
  ).rejects.toThrow('fenced');
  expect(target.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()?.n).toBe(
    0
  );
});

it('runs SQL import through scheduler slices and retries an uncertain write without advancing its cursor', async () => {
  await persist();
  await seal();
  const initial = {
    version: 1,
    targetId: 'target',
    targetOrdinal: 0,
    datasetId: policy.dataset.id,
    sourceCursor: null,
    rowsWritten: 0,
  };
  const saved = await store.checkpoint(
    context.lease,
    context.operation.revision,
    'apply_sqlite_dataset',
    JSON.stringify(initial),
    now
  );
  if (!saved) throw new Error('checkpoint_missing');
  await store.release(context.lease, saved.revision, 'queued', now);
  const cursors: (string | null)[] = [];
  let lost = false;
  const handlers = {
    async run(slice: TenantBackupStepContext) {
      const activeInventory = new TenantBackupExecutionInventory(
        adapter(admin),
        slice.lease,
        () => now
      );
      const run =
        slice.operation.phase === 'verify_sqlite_dataset'
          ? runSqliteRestoreDatasetVerificationStep
          : runSqliteRestoreDatasetStep;
      return run(slice, {
        ...openInput(),
        inventory: activeInventory,
        policy,
        manifest,
        async assertValidatedUnpublishedPlan(digest) {
          expect(digest).toBe((await activeInventory.head()).chain_digest);
        },
        async resolve() {
          const resolved = resource();
          const execute = resolved.database.execute;
          resolved.database.execute = async (sql, params) => {
            const result = await execute(sql, params);
            if (!lost && sql.startsWith('INSERT INTO "tenants"')) {
              lost = true;
              throw new Error('uncertain_write');
            }
            return result;
          };
          return resolved;
        },
        async readNextValidatedRow({ sourceCursor }) {
          cursors.push(sourceCursor);
          return sourceCursor === null ? { rowJson: row, nextCursor: 'row:1' } : null;
        },
      });
    },
    async cleanup() {
      throw new Error('unexpected_cleanup');
    },
  };
  now++;
  expect(
    (await runTenantBackupScheduler(adapter(admin), handlers, context.signal, () => now)).failures
  ).toBe(1);
  expect(JSON.parse((await store.get('a', 'import'))!.cursor_json!).rowsWritten).toBe(0);
  expect(target.prepare('SELECT count(*) AS n FROM tenants').get()?.n).toBe(1);
  now += 1001;
  expect(
    (await runTenantBackupScheduler(adapter(admin), handlers, context.signal, () => now)).advanced
  ).toBe(1);
  now++;
  expect(
    (await runTenantBackupScheduler(adapter(admin), handlers, context.signal, () => now)).advanced
  ).toBe(1);
  const complete = await store.get('a', 'import');
  expect(complete?.phase).toBe('advance_restore_dataset');
  expect(complete?.state).toBe('queued');
  expect(JSON.parse(complete!.cursor_json!).rowsWritten).toBe(1);
  expect(cursors).toEqual([null, 'row:1', null, 'row:1', null, 'row:1']);
  const verified = await store.get('a', 'import');
  expect(verified?.phase).toBe('advance_restore_dataset');
  expect(verified?.state).toBe('queued');
  expect(JSON.parse(verified!.cursor_json!).rowsVerified).toBe(1);

  expect(target.prepare('SELECT * FROM tenants').all()).toEqual([{ id: 'a', value: 'restored' }]);
});

it('rejects wrong dataset cursors and cancellation while reading before target rows are written', async () => {
  await persist();
  await seal();
  let reads = 0;
  const cursor = {
    version: 1,
    targetId: 'target',
    targetOrdinal: 0,
    datasetId: policy.dataset.id,
    sourceCursor: null,
    rowsWritten: 0,
  };
  const active = {
    ...context,
    operation: {
      ...context.operation,
      phase: 'apply_sqlite_dataset',
      cursor_json: JSON.stringify(cursor),
    },
  };
  const argumentsForStep = {
    ...openInput(),
    policy,
    manifest,
    async readNextValidatedRow() {
      reads++;
      await store.requestCancel('a', 'import', now);
      return { rowJson: row, nextCursor: 'row:1' };
    },
  };
  await expect(
    runSqliteRestoreDatasetStep(
      {
        ...active,
        operation: {
          ...active.operation,
          cursor_json: JSON.stringify({ ...cursor, datasetId: 'other' }),
        },
      },
      argumentsForStep
    )
  ).rejects.toThrow('step_invalid');
  expect(reads).toBe(0);
  await expect(runSqliteRestoreDatasetStep(active, argumentsForStep)).rejects.toThrow(
    'step_invalid'
  );
  expect(target.prepare('SELECT count(*) AS n FROM tenants').get()?.n).toBe(0);
});

it('verifies and advances an empty dataset in one slice and rejects a non-advancing cursor', async () => {
  await persist();
  await seal();
  const cursor = {
    version: 1,
    targetId: 'target',
    targetOrdinal: 0,
    datasetId: policy.dataset.id,
    sourceCursor: null,
    rowsWritten: 0,
  };
  const active = {
    ...context,
    operation: {
      ...context.operation,
      phase: 'apply_sqlite_dataset',
      cursor_json: JSON.stringify(cursor),
    },
  };
  const result = await runSqliteRestoreDatasetStep(active, {
    ...openInput(),
    policy,
    manifest,
    async readNextValidatedRow() {
      return null;
    },
  });
  expect(result).toEqual({
    phase: 'advance_restore_dataset',
    cursor: JSON.stringify({ ...cursor, verifySourceCursor: null, rowsVerified: 0 }),
    disposition: 'continue',
  });
  await expect(
    runSqliteRestoreDatasetStep(active, {
      ...openInput(),
      policy,
      manifest,
      async readNextValidatedRow() {
        return { rowJson: row, nextCursor: '' };
      },
    })
  ).rejects.toThrow('step_invalid');
  expect(target.prepare('SELECT count(*) AS n FROM tenants').get()?.n).toBe(0);
});

it('reads a reference-only dataset twice without creating or counting target rows', async () => {
  const referencePolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'admin.admin_users', module: 'admin-auth', kind: 'admin' },
    restoreDisposition: 'reference_only',
  };
  const referenceManifest = { ...manifest, datasets: [referencePolicy.dataset] };
  await persist();
  await seal();
  let phase = 'apply_sqlite_dataset';
  let cursor = JSON.stringify({
    version: 1,
    targetId: 'target',
    targetOrdinal: 0,
    datasetId: referencePolicy.dataset.id,
    sourceCursor: null,
    rowsWritten: 0,
  });
  const reads: (string | null)[] = [];
  const input = {
    ...openInput(),
    policy: referencePolicy,
    manifest: referenceManifest,
    async readNextValidatedRow({ sourceCursor }: { sourceCursor: string | null }) {
      reads.push(sourceCursor);
      return sourceCursor === null ? { rowJson: row, nextCursor: 'row:1' } : null;
    },
  };
  for (let index = 0; phase !== 'advance_restore_dataset' && index < 4; index++) {
    const run =
      phase === 'verify_sqlite_dataset'
        ? runSqliteRestoreDatasetVerificationStep
        : runSqliteRestoreDatasetStep;
    const result = await run(
      { ...context, operation: { ...context.operation, phase, cursor_json: cursor } },
      input
    );
    phase = result.phase;
    cursor = result.cursor ?? '';
  }
  expect(phase).toBe('advance_restore_dataset');
  expect(reads).toEqual([null, 'row:1', null, 'row:1']);
  expect(target.prepare('SELECT count(*) AS n FROM tenants').get()).toEqual({ n: 0 });
  expect(target.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()).toEqual({
    n: 0,
  });
});

it('quarantines held rows and verifies them without inflating the target row count', async () => {
  const heldRow = '{"id":["text","held"],"value":["text","queued"]}';
  const writes: string[] = [];
  const verifies: string[] = [];
  const holdPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreHold: {
      id: 'test-source-work-hold-v1',
      async shouldHold(_context, rowJson) {
        return rowJson === heldRow;
      },
      async write(_context, rowJson) {
        writes.push(rowJson);
      },
      async verify(_context, rowJson) {
        verifies.push(rowJson);
      },
    },
  };
  await persist();
  await seal();
  let phase = 'apply_sqlite_dataset';
  let cursor = JSON.stringify({
    version: 1,
    targetId: 'target',
    targetOrdinal: 0,
    datasetId: policy.dataset.id,
    sourceCursor: null,
    rowsWritten: 0,
  });
  const input = {
    ...openInput(),
    policy: holdPolicy,
    manifest,
    async readNextValidatedRow({ sourceCursor }: { sourceCursor: string | null }) {
      if (sourceCursor === null) return { rowJson: heldRow, nextCursor: 'row:1' };
      if (sourceCursor === 'row:1') return { rowJson: row, nextCursor: 'row:2' };
      return null;
    },
  };
  let steps = 0;
  for (; phase !== 'advance_restore_dataset' && steps < 4; steps++) {
    const run =
      phase === 'verify_sqlite_dataset'
        ? runSqliteRestoreDatasetVerificationStep
        : runSqliteRestoreDatasetStep;
    const result = await run(
      { ...context, operation: { ...context.operation, phase, cursor_json: cursor } },
      input
    );
    phase = result.phase;
    cursor = result.cursor ?? '';
  }
  expect(phase).toBe('advance_restore_dataset');
  expect(steps).toBe(2);
  expect(writes).toEqual([heldRow]);
  expect(verifies).toEqual([heldRow]);
  expect(target.prepare('SELECT id,value FROM tenants').all()).toEqual([
    { id: 'a', value: 'restored' },
  ]);
});

it('advances a materialized dataset when every authenticated source row is held', async () => {
  const heldPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreHold: {
      id: 'test-all-held-v1',
      async shouldHold() {
        return true;
      },
      async write() {},
      async verify() {},
    },
  };
  await persist();
  await persistSqliteRestoreSequence(inventory, 1, [
    {
      targetId: 'target',
      ordinal: 0,
      policy: heldPolicy,
      manifest,
      recordCount: 1,
      byteCount: 1,
    },
  ]);
  await seal();
  const result = await runSqliteRestoreSequenceStep(
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'advance_restore_dataset',
        cursor_json: JSON.stringify({
          version: 1,
          sequenceOrdinal: 1,
          jobIndex: 0,
          datasetCursor: JSON.stringify({
            version: 1,
            targetId: 'target',
            targetOrdinal: 0,
            datasetId: policy.dataset.id,
            sourceCursor: 'row:1',
            rowsWritten: 0,
            verifySourceCursor: 'row:1',
            rowsVerified: 0,
          }),
          completedRows: [],
          emptyPrepared: true,
        }),
      },
    },
    {
      inventory,
      sequenceOrdinal: 1,
      now: () => now,
      async resolve() {
        return resource();
      },
      async assertValidatedUnpublishedPlan() {},
      async loadValidatedDataset() {
        return {
          policy: heldPolicy,
          manifest,
          async readNextValidatedRow() {
            throw new Error('must_not_read');
          },
        };
      },
    }
  );
  expect(result.phase).toBe('restore_other_stores');
  expect(JSON.parse(result.cursor ?? '{}').completedRows).toEqual([0]);
});

it('pins and reapplies an installed row transform during write and verification', async () => {
  const transformed: string[] = [];
  const transformPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreTransform: {
      id: 'test-admin-map-v1',
      async transform(_context, rowJson) {
        transformed.push(rowJson);
        const parsed = JSON.parse(rowJson);
        parsed.value = ['text', 'mapped-target'];
        return JSON.stringify(parsed);
      },
    },
  };
  await persist();
  await seal();
  let phase = 'apply_sqlite_dataset';
  let cursor = JSON.stringify({
    version: 1,
    targetId: 'target',
    targetOrdinal: 0,
    datasetId: policy.dataset.id,
    sourceCursor: null,
    rowsWritten: 0,
  });
  const input = {
    ...openInput(),
    policy: transformPolicy,
    manifest,
    async readNextValidatedRow({ sourceCursor }: { sourceCursor: string | null }) {
      return sourceCursor === null ? { rowJson: row, nextCursor: 'row:1' } : null;
    },
  };
  for (let index = 0; phase !== 'advance_restore_dataset' && index < 4; index++) {
    const run =
      phase === 'verify_sqlite_dataset'
        ? runSqliteRestoreDatasetVerificationStep
        : runSqliteRestoreDatasetStep;
    const result = await run(
      { ...context, operation: { ...context.operation, phase, cursor_json: cursor } },
      input
    );
    phase = result.phase;
    cursor = result.cursor ?? '';
  }
  expect(phase).toBe('advance_restore_dataset');
  expect(transformed).toEqual([row, row]);
  expect(target.prepare("SELECT value FROM tenants WHERE id='a'").get()).toEqual({
    value: 'mapped-target',
  });
});

it('writes transformed datasets for one physical target in a single execution batch', async () => {
  target.exec('CREATE TABLE children(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL)');
  const transformModes: string[] = [];
  const parentPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreTransform: {
      id: 'test-parent-map-v1',
      async transform(_context, rowJson, mode) {
        transformModes.push(`parent:${mode}`);
        const parsed = JSON.parse(rowJson);
        parsed.value = ['text', 'mapped'];
        return JSON.stringify(parsed);
      },
    },
  };
  const childPolicy: SqliteDatasetInspectionPolicy = {
    dataset: { ...policy.dataset, id: 'core.children' },
    restoreAfter: ['core.tenants'],
    schema: {
      table: 'children',
      columns: ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    restoreTransform: {
      id: 'test-child-map-v1',
      async transform(_context, rowJson, mode) {
        transformModes.push(`child:${mode}`);
        return rowJson;
      },
    },
    async inspectRow() {
      return [];
    },
  };
  const sourceManifest = { ...manifest, datasets: [parentPolicy.dataset, childPolicy.dataset] };
  await persist();
  await persistSqliteRestoreSequence(
    inventory,
    1,
    [parentPolicy, childPolicy].map((candidate) => ({
      targetId: 'target',
      ordinal: 0,
      policy: candidate,
      manifest: sourceManifest,
      recordCount: 1,
      byteCount: 1,
    }))
  );
  await seal();
  const result = await runSqliteRestoreSequenceStep(
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'start_sqlite_restore_sequence',
        cursor_json: JSON.stringify({
          version: 1,
          sequenceOrdinal: 1,
          jobIndex: 0,
          datasetCursor: null,
          completedRows: [],
          emptyPrepared: true,
        }),
      },
    },
    {
      inventory,
      sequenceOrdinal: 1,
      now: () => now,
      async resolve() {
        return resource();
      },
      async assertValidatedUnpublishedPlan() {},
      async loadValidatedDataset(job) {
        return {
          policy: job.datasetId === parentPolicy.dataset.id ? parentPolicy : childPolicy,
          manifest: sourceManifest,
          async readNextValidatedRow({ sourceCursor }) {
            if (sourceCursor !== null) return null;
            return {
              rowJson:
                job.datasetId === parentPolicy.dataset.id
                  ? row
                  : '{"id":["text","child"],"tenant_id":["text","a"]}',
              nextCursor: 'row:1',
            };
          },
        };
      },
    }
  );
  expect(result.phase).toBe('restore_other_stores');
  expect(JSON.parse(result.cursor ?? '{}').completedRows).toEqual([1, 1]);
  expect(target.prepare('SELECT id,value FROM tenants').all()).toEqual([
    { id: 'a', value: 'mapped' },
  ]);
  expect(target.prepare('SELECT id,tenant_id FROM children').all()).toEqual([
    { id: 'child', tenant_id: 'a' },
  ]);
  let final = result;
  for (let index = 0; index < 5 && final.phase !== 'verify_other_restore_stores'; index++) {
    final = await runSqliteRestoreSequenceStep(
      {
        ...context,
        operation: {
          ...context.operation,
          phase: final.phase === 'restore_other_stores' ? 'verify_restore_targets' : final.phase,
          cursor_json: final.cursor,
        },
      },
      {
        inventory,
        sequenceOrdinal: 1,
        now: () => now,
        async resolve() {
          return resource();
        },
        async assertValidatedUnpublishedPlan() {},
        async loadValidatedDataset(job) {
          return {
            policy: job.datasetId === parentPolicy.dataset.id ? parentPolicy : childPolicy,
            manifest: sourceManifest,
            async readNextValidatedRow({ sourceCursor }) {
              if (sourceCursor !== null) return null;
              return {
                rowJson:
                  job.datasetId === parentPolicy.dataset.id
                    ? row
                    : '{"id":["text","child"],"tenant_id":["text","a"]}',
                nextCursor: 'row:1',
              };
            },
          };
        },
      }
    );
  }
  expect(final.phase).toBe('verify_other_restore_stores');
  expect(transformModes).toEqual(['parent:write', 'child:write', 'parent:verify', 'child:verify']);
});

it('keeps dependency order while grouping ready datasets by physical target', async () => {
  const secondOnA: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.second_on_a' },
    schema: { ...policy.schema, table: 'second_on_a' },
    restoreAfter: ['core.tenants'],
  };
  const onB: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.on_b' },
    schema: { ...policy.schema, table: 'on_b' },
  };
  const sourceManifest = {
    ...manifest,
    datasets: [policy.dataset, onB.dataset, secondOnA.dataset],
  };
  await persist();
  await persistSqliteRestoreSequence(inventory, 1, [
    {
      targetId: 'target-a',
      ordinal: 0,
      policy,
      manifest: sourceManifest,
      recordCount: 1,
      byteCount: 1,
    },
    {
      targetId: 'target-b',
      ordinal: 0,
      policy: onB,
      manifest: sourceManifest,
      recordCount: 1,
      byteCount: 1,
    },
    {
      targetId: 'target-a',
      ordinal: 0,
      policy: secondOnA,
      manifest: sourceManifest,
      recordCount: 1,
      byteCount: 1,
    },
  ]);
  await seal();
  const saved = await inventory.readPage(1);
  const sequence = JSON.parse(saved[0].payload_json);
  expect(sequence.jobs.map((job: { datasetId: string }) => job.datasetId)).toEqual([
    'core.tenants',
    'core.second_on_a',
    'core.on_b',
  ]);
});

it.each([false, true])(
  'restores and finally rechecks dependent datasets (late mutation: %s)',
  async (changed) => {
    target.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE children(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id))'
    );
    if (changed)
      target.exec(
        "CREATE TRIGGER late_change AFTER INSERT ON children BEGIN UPDATE tenants SET value='late-change'; END"
      );
    const childPolicy: SqliteDatasetInspectionPolicy = {
      dataset: { ...policy.dataset, id: 'core.children' },
      restoreAfter: ['core.tenants'],
      schema: {
        table: 'children',
        columns: ['id', 'tenant_id'],
        primaryKey: ['id'],
        uniqueKeys: [],
        tenantColumn: 'tenant_id',
      },
      async inspectRow() {
        return [];
      },
    };
    const sourceManifest = { ...manifest, datasets: [policy.dataset, childPolicy.dataset] };
    await expect(
      persistSqliteRestoreSequence(inventory, 1, [
        {
          targetId: 'target',
          ordinal: 0,
          policy,
          manifest: sourceManifest,
          recordCount: 1,
          byteCount: 1,
        },
      ])
    ).rejects.toThrow('sequence_invalid');

    await persist();
    await persistSqliteRestoreSequence(
      inventory,
      1,
      [childPolicy, policy].map((p) => ({
        targetId: 'target',
        ordinal: 0,
        policy: p,
        manifest: sourceManifest,
        recordCount: 1,
        byteCount: 1,
      }))
    );
    await seal();
    const saved = await store.checkpoint(
      context.lease,
      context.operation.revision,
      'start_sqlite_restore_sequence',
      JSON.stringify({
        version: 1,
        sequenceOrdinal: 1,
        jobIndex: 0,
        datasetCursor: null,
        completedRows: [],
        emptyPrepared: true,
      }),
      now
    );
    if (!saved) throw new Error('checkpoint_missing');
    await store.release(context.lease, saved.revision, 'queued', now);
    const loaded: string[] = [];
    const handlers = {
      async run(slice: TenantBackupStepContext) {
        if (slice.operation.phase === 'restore_other_stores') {
          return {
            phase: 'verify_restore_targets',
            cursor: slice.operation.cursor_json,
            disposition: 'continue' as const,
          };
        }
        const activeInventory = new TenantBackupExecutionInventory(
          adapter(admin),
          slice.lease,
          () => now
        );
        return runSqliteRestoreSequenceStep(slice, {
          inventory: activeInventory,
          sequenceOrdinal: 1,
          now: () => now,
          async resolve() {
            return resource();
          },
          async assertValidatedUnpublishedPlan(digest) {
            expect(digest).toBe((await activeInventory.head()).chain_digest);
          },
          async loadValidatedDataset(job) {
            loaded.push(job.datasetId);
            return {
              policy: job.datasetId === policy.dataset.id ? policy : childPolicy,
              manifest: sourceManifest,
              async readNextValidatedRow({ sourceCursor }) {
                if (sourceCursor !== null) return null;
                return {
                  rowJson:
                    job.datasetId === policy.dataset.id
                      ? row
                      : '{"id":["text","child"],"tenant_id":["text","a"]}',
                  nextCursor: 'row:1',
                };
              },
            };
          },
        });
      },
      async cleanup() {
        throw new Error('unexpected');
      },
    };
    for (let i = 0; i < 20; i++) {
      now++;
      const result = await runTenantBackupScheduler(
        adapter(admin),
        handlers,
        context.signal,
        () => now
      );
      expect(result.failures).toBe(0);
      expect(result.advanced).toBe(1);
      if ((await store.get('a', 'import'))?.phase === 'restore_other_stores') break;
    }
    expect((await store.get('a', 'import'))?.phase).toBe('restore_other_stores');
    expect((await store.get('a', 'import'))?.state).toBe('queued');
    expect(loaded).toEqual(['core.tenants', 'core.children']);
    expect(target.prepare('SELECT * FROM children').all()).toEqual([
      { id: 'child', tenant_id: 'a' },
    ]);
    expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(JSON.parse((await store.get('a', 'import'))!.cursor_json!).completedRows).toEqual([
      1, 1,
    ]);
    let finalVerificationFailures = 0;
    for (let i = 0; i < 6; i++) {
      now++;
      const result = await runTenantBackupScheduler(
        adapter(admin),
        handlers,
        context.signal,
        () => now
      );
      finalVerificationFailures += result.failures;
      if (result.failures) break;
    }
    expect(finalVerificationFailures).toBe(changed ? 1 : 0);
    expect(loaded).toEqual(['core.tenants', 'core.children', 'core.tenants', 'core.children']);
    expect(target.prepare('SELECT state FROM tenant_backup_restore_targets').get()?.state).toBe(
      'sealed'
    );
    if (changed) {
      expect((await store.get('a', 'import'))?.phase).toBe('verify_sealed_sqlite_datasets');
      expect(target.prepare('SELECT value FROM tenants').get()?.value).toBe('late-change');
      return;
    }
    for (let i = 0; i < 8; i++) {
      if ((await store.get('a', 'import'))?.phase !== 'verify_sealed_sqlite_datasets') break;
      now++;
      expect(
        (await runTenantBackupScheduler(adapter(admin), handlers, context.signal, () => now))
          .advanced
      ).toBe(1);
    }
    expect((await store.get('a', 'import'))?.phase).toBe('verify_other_restore_stores');
    expect((await store.get('a', 'import'))?.state).toBe('queued');
  }
);

it('pins input manifests and module policies and rejects overlapping dataset targets', async () => {
  await persist();
  const job = {
    targetId: 'target',
    ordinal: 0,
    policy,
    manifest,
    recordCount: 1,
    byteCount: 1,
  };
  await expect(persistSqliteRestoreSequence(inventory, 1, [job, job])).rejects.toThrow(
    'sequence_invalid'
  );
  await persistSqliteRestoreSequence(inventory, 1, [job]);
  await expect(
    persistSqliteRestoreSequence(inventory, 1, [
      { ...job, manifest: { ...manifest, boundaryUnixMs: 2 } },
    ])
  ).rejects.toThrow('retry_conflict');
  await seal();
  const start = {
    ...context,
    operation: {
      ...context.operation,
      phase: 'start_sqlite_restore_sequence',
      cursor_json: JSON.stringify({
        version: 1,
        sequenceOrdinal: 1,
        jobIndex: 0,
        datasetCursor: null,
        completedRows: [],
        emptyPrepared: true,
      }),
    },
  };
  const argumentsForStep = {
    inventory,
    sequenceOrdinal: 1,
    now: () => now,
    async resolve() {
      return resource();
    },
    async assertValidatedUnpublishedPlan() {},
    async loadValidatedDataset() {
      return {
        policy,
        manifest: { ...manifest, boundaryUnixMs: 2 },
        async readNextValidatedRow() {
          throw new Error('must_not_read');
        },
      };
    },
  };
  await expect(runSqliteRestoreSequenceStep(start, argumentsForStep)).rejects.toThrow(
    'sequence_invalid'
  );
  expect(target.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()?.n).toBe(
    0
  );
});

it('persists and bulk-confirms a complete 310-empty-dataset Phase 8 SQL sequence', async () => {
  await persist();
  const policies = Array.from(
    { length: 310 },
    (_, index): SqliteDatasetInspectionPolicy => ({
      ...policy,
      dataset: { ...policy.dataset, id: `core.phase8_${index}` },
      schema: { ...policy.schema, table: `phase8_${index}` },
    })
  );
  const phase8Manifest: TenantBundleManifest = {
    ...manifest,
    datasets: policies.map(({ dataset }) => dataset),
  };
  await persistSqliteRestoreSequence(
    inventory,
    1,
    policies.map((installedPolicy) => ({
      targetId: 'target',
      ordinal: 0,
      policy: installedPolicy,
      manifest: phase8Manifest,
      recordCount: 0,
      byteCount: 0,
    }))
  );
  await seal();
  const saved = (await inventory.readPage(1))[0];
  expect(JSON.parse(saved.payload_json).jobs).toHaveLength(310);

  const start = {
    ...context,
    operation: {
      ...context.operation,
      phase: 'start_sqlite_restore_sequence',
      cursor_json: JSON.stringify({
        version: 1,
        sequenceOrdinal: 1,
        jobIndex: 0,
        datasetCursor: null,
        completedRows: [],
        emptyPrepared: false,
      }),
    },
  };
  const input = {
    inventory,
    sequenceOrdinal: 1,
    now: () => now,
    async resolve() {
      return resource();
    },
    async assertValidatedUnpublishedPlan() {},
    async loadValidatedDataset(): Promise<never> {
      throw new Error('empty_datasets_must_not_be_loaded');
    },
  };
  const prepared = await runSqliteRestoreSequenceStep(start, input);
  expect(prepared.phase).toBe('start_sqlite_restore_sequence');
  expect(JSON.parse(prepared.cursor ?? '{}').emptyPrepared).toBe(true);
  expect(
    target.prepare('SELECT count(*) AS total FROM tenant_backup_restore_targets').get()
  ).toEqual({ total: 1 });

  const completed = await runSqliteRestoreSequenceStep(
    {
      ...start,
      operation: { ...start.operation, cursor_json: prepared.cursor ?? null },
    },
    input
  );
  expect(completed.phase).toBe('restore_other_stores');
  expect(JSON.parse(completed.cursor ?? '{}').completedRows).toEqual([]);
});

it('rejects missing and cyclic restore dependencies before persisting a sequence', async () => {
  const childPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.children' },
    schema: { ...policy.schema, table: 'children' },
    restoreAfter: ['core.missing'],
  };
  const sourceManifest = { ...manifest, datasets: [policy.dataset, childPolicy.dataset] };
  await expect(
    persistSqliteRestoreSequence(inventory, 1, [
      {
        targetId: 'target',
        ordinal: 0,
        policy,
        manifest: sourceManifest,
        recordCount: 1,
        byteCount: 1,
      },
      {
        targetId: 'target',
        ordinal: 0,
        policy: childPolicy,
        manifest: sourceManifest,
        recordCount: 1,
        byteCount: 1,
      },
    ])
  ).rejects.toThrow('sequence_invalid');
  expect((await inventory.head()).item_count).toBe(0);

  const cyclicParent = { ...policy, restoreAfter: ['core.children'] };
  const cyclicChild = { ...childPolicy, restoreAfter: ['core.tenants'] };
  await expect(
    persistSqliteRestoreSequence(inventory, 1, [
      {
        targetId: 'target',
        ordinal: 0,
        policy: cyclicParent,
        manifest: sourceManifest,
        recordCount: 1,
        byteCount: 1,
      },
      {
        targetId: 'target',
        ordinal: 0,
        policy: cyclicChild,
        manifest: sourceManifest,
        recordCount: 1,
        byteCount: 1,
      },
    ])
  ).rejects.toThrow('sequence_invalid');
  expect((await inventory.head()).item_count).toBe(0);
});

it('requires completed input validation even when the caller allows target admission', async () => {
  await persist();
  await seal();
  admin.exec("DELETE FROM tenant_backup_input_validations WHERE operation_id='import'");
  await expect(openPlannedSqliteRestoreTarget(openInput())).rejects.toThrow(
    'backup_input_not_validated'
  );
  expect(target.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get()?.n).toBe(
    0
  );
  const head = await inventory.head();
  admin
    .prepare(
      "INSERT INTO tenant_backup_input_validations(operation_id,tenant_id,session_id,input_inventory_digest,examined_references,unresolved_provenance) VALUES('import','a','validated-input',?,0,0)"
    )
    .run('00'.repeat(32));
  await expect(openPlannedSqliteRestoreTarget(openInput())).rejects.toThrow(
    'backup_input_not_validated'
  );
  admin.exec("DELETE FROM tenant_backup_input_validations WHERE operation_id='import'");
  admin
    .prepare(
      "INSERT INTO tenant_backup_input_validations(operation_id,tenant_id,session_id,input_inventory_digest,examined_references,unresolved_provenance) VALUES('import','a','validated-input',?,0,0)"
    )
    .run(head.chain_digest);
  admin.exec(
    "UPDATE tenant_backup_validation_sessions SET state='deleting' WHERE id='validated-input'"
  );
  await expect(openPlannedSqliteRestoreTarget(openInput())).rejects.toThrow(
    'backup_input_not_validated'
  );
});

it('preserves completed input evidence during live restore cleanup after lease takeover', async () => {
  await persist();
  await seal();
  now += 600001;
  await claim('new-worker');
  expect(
    await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(
      adapter(admin),
      context.lease,
      () => now
    )
  ).toEqual({ found: false, done: true });
  await inventory.assertInputValidated(context.lease);
  expect(admin.prepare('SELECT count(*) AS n FROM tenant_backup_input_validations').get()?.n).toBe(
    1
  );
});

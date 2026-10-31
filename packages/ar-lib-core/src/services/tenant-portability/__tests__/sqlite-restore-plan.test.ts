import { readRenderedMigrationSql } from '../../../../../../test/helpers/migration-source.mjs';
import { DatabaseTenantBundleReferenceIndex } from '../validation-index';
import {
  persistSqliteRestoreSequence,
  runSqliteRestoreSequenceStep,
} from '../restore-sqlite-sequence';
import {
  RESTORE_DATASET_STATEMENTS,
  RESTORE_STATEMENT_BUDGET,
  runSqliteRestoreDatasetDeferredStep,
  runSqliteRestoreDatasetStep,
  runSqliteRestoreDatasetVerificationStep,
} from '../restore-sqlite-step';
import { runTenantBackupScheduler } from '../operation-scheduler';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TenantBackupOperationStore } from '../operation-store';
import { TenantBackupExecutionInventory } from '../execution-inventory';
import type { TenantBackupStepContext } from '../operation-executor';
import {
  persistInitializedSqliteRestoreTarget,
  openPlannedSqliteRestoreTarget,
} from '../sqlite-restore-plan';
import {
  TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED,
  type SqliteDatasetInspectionPolicy,
} from '../sqlite-dataset-inspector';
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
  for (const file of ['001_0_5_0_admin_baseline.sql'])
    admin.exec(
      readRenderedMigrationSql(
        new URL(`../../../../../../migrations/admin/d1/`, import.meta.url),
        `${file}`
      )
    );
  target.exec(
    readRenderedMigrationSql(
      new URL('../../../../../../migrations/core/d1/', import.meta.url),
      '010_tenant_backup_restore_target.sql'
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
it('runs one bounded restore authority preflight for 500 rows and fences the actual SQL write', async () => {
  target.exec('CREATE TABLE owners(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL)');
  const rows = Array.from({ length: 500 }, (_, i) =>
    JSON.stringify({ id: ['text', `owner-${i}`], tenant_id: ['text', 'a'] })
  );
  let members = new Set<string>();
  const prepareRows = vi.fn(
    async (_context: TenantBackupStepContext, values: readonly string[]) => {
      members = new Set(values);
    }
  );
  const assertPreparedRows = vi.fn(async () => {
    expect(members.size).toBe(500);
  });
  const transform = vi.fn(async (_context: TenantBackupStepContext, value: string) => {
    expect(members.has(value)).toBe(true);
    return value;
  });
  const guarded: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.owners' },
    schema: {
      table: 'owners',
      columns: ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    restoreTransform: {
      id: 'current-owner-batch-v1',
      statementsPerRow: 0,
      statementsPerBatch: 128,
      prepareRows,
      assertPreparedRows,
      transform,
    },
  };
  await persist();
  await seal();
  const active = {
    ...context,
    operation: {
      ...context.operation,
      phase: 'apply_sqlite_dataset',
      cursor_json: JSON.stringify({
        version: 1,
        targetId: 'target',
        targetOrdinal: 0,
        datasetId: guarded.dataset.id,
        sourceCursor: null,
        rowsWritten: 0,
      }),
    },
  };
  await runSqliteRestoreDatasetStep(active, {
    ...openInput(),
    policy: guarded,
    manifest: { ...manifest, datasets: [guarded.dataset] },
    readNextValidatedRow: async ({ sourceCursor }) => {
      const i = sourceCursor === null ? 0 : Number(sourceCursor);
      return i < rows.length ? { rowJson: rows[i], nextCursor: String(i + 1) } : null;
    },
  });
  expect(prepareRows).toHaveBeenCalledTimes(1);
  expect(transform).toHaveBeenCalledTimes(500);
  expect(assertPreparedRows).toHaveBeenCalledTimes(2);
  expect(target.prepare('SELECT count(*) AS n FROM owners').get()).toEqual({ n: 500 });
});

it('uses the same bulk authority hook in the combined dataset execution path', async () => {
  target.exec('CREATE TABLE owners(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL)');
  const rows = Array.from({ length: 200 }, (_, i) =>
    JSON.stringify({ id: ['text', `owner-${i}`], tenant_id: ['text', 'a'] })
  );
  let members = new Set<string>();
  const prepareRows = vi.fn(
    async (_context: TenantBackupStepContext, values: readonly string[]) => {
      members = new Set(values);
    }
  );
  const assertPreparedRows = vi.fn(async () => {
    expect(members.size).toBe(200);
  });
  const transform = vi.fn(async (_context: TenantBackupStepContext, value: string) => {
    expect(members.has(value)).toBe(true);
    return value;
  });
  const guarded: SqliteDatasetInspectionPolicy = {
    ...policy,
    dataset: { ...policy.dataset, id: 'core.owners' },
    schema: {
      table: 'owners',
      columns: ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    restoreTransform: {
      id: 'current-owner-batch-v1',
      statementsPerRow: 0,
      statementsPerBatch: 128,
      prepareRows,
      assertPreparedRows,
      transform,
    },
  };
  const sourceManifest = { ...manifest, datasets: [guarded.dataset] };
  await persist();
  await persistSqliteRestoreSequence(inventory, 1, [
    {
      targetId: 'target',
      ordinal: 0,
      policy: guarded,
      manifest: sourceManifest,
      recordCount: rows.length,
      byteCount: rows.reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0),
    },
  ]);
  await seal();
  let cursor: string | null = JSON.stringify({
    version: 1,
    sequenceOrdinal: 1,
    jobIndex: 0,
    datasetCursor: null,
    completedRows: [],
    emptyPrepared: false,
  });
  for (let i = 0; i < 4; i++) {
    const result = await runSqliteRestoreSequenceStep(
      {
        ...context,
        operation: {
          ...context.operation,
          phase: 'start_sqlite_restore_sequence',
          cursor_json: cursor,
        },
      },
      {
        ...openInput(),
        sequenceOrdinal: 1,
        loadValidatedDataset: async () => ({
          policy: guarded,
          manifest: sourceManifest,
          readNextValidatedRow: async ({ sourceCursor }: { sourceCursor: string | null }) => {
            const index = sourceCursor === null ? 0 : Number(sourceCursor);
            return index < rows.length
              ? { rowJson: rows[index], nextCursor: String(index + 1) }
              : null;
          },
        }),
      }
    );
    cursor = result.cursor;
    if (result.phase === 'restore_other_stores') break;
  }
  expect(prepareRows).toHaveBeenCalledTimes(1);
  expect(transform).toHaveBeenCalledTimes(200);
  expect(assertPreparedRows.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(target.prepare('SELECT count(*) AS n FROM owners').get()).toEqual({ n: 200 });
});
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

it('keeps the reason of a row the requester may not restore and writes none of its batch', async () => {
  const refusingPolicy: SqliteDatasetInspectionPolicy = {
    ...policy,
    restoreTransform: {
      id: 'test-authority-v1',
      async transform() {
        throw new Error(TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED);
      },
    },
  };
  await persist();
  await seal();
  const cursor = JSON.stringify({
    version: 1,
    targetId: 'target',
    targetOrdinal: 0,
    datasetId: policy.dataset.id,
    sourceCursor: null,
    rowsWritten: 0,
  });
  const input = {
    ...openInput(),
    policy: refusingPolicy,
    manifest,
    async readNextValidatedRow({ sourceCursor }: { sourceCursor: string | null }) {
      return sourceCursor === null ? { rowJson: row, nextCursor: 'row:1' } : null;
    },
  };
  await expect(
    runSqliteRestoreDatasetStep(
      {
        ...context,
        operation: { ...context.operation, phase: 'apply_sqlite_dataset', cursor_json: cursor },
      },
      input
    )
  ).rejects.toThrow(TENANT_BACKUP_RESTORE_AUTHORITY_REQUIRED);
  expect(target.prepare("SELECT count(*) AS n FROM tenants WHERE id='a'").get()?.n).toBe(0);
  // Any other transform failure stays generic.
  await expect(
    runSqliteRestoreDatasetStep(
      {
        ...context,
        operation: { ...context.operation, phase: 'apply_sqlite_dataset', cursor_json: cursor },
      },
      {
        ...input,
        policy: {
          ...policy,
          restoreTransform: {
            id: 'test-broken-v1',
            async transform() {
              throw new Error('something_else');
            },
          },
        },
      }
    )
  ).rejects.toThrow('backup_restore_row_transform_failed');
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

it('persists and bulk-confirms a complete 311-empty-dataset Phase 8 SQL sequence', async () => {
  await persist();
  const policies = Array.from(
    { length: 311 },
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
  expect(JSON.parse(saved.payload_json).jobs).toHaveLength(311);

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

it('splits rows whose transforms issue statements across transitions and resumes after a failure', async () => {
  // Each mapped row costs its write plus two statements (a mapping lookup and an audit entry).
  const sizes = { 'core.grants_a': 100, 'core.grants_b': 100, 'core.grants_c': 400 };
  const transformed: { datasetId: string; mode: string }[] = [];
  let failOnCall: number | null = null;
  const mapped = (id: keyof typeof sizes): SqliteDatasetInspectionPolicy => {
    const table = id.slice('core.'.length);
    target.exec(
      `CREATE TABLE ${table}(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, value TEXT)`
    );
    return {
      dataset: { ...policy.dataset, id },
      restoreAfter: ['core.tenants'],
      schema: {
        table,
        columns: ['id', 'tenant_id', 'value'],
        primaryKey: ['id'],
        uniqueKeys: [],
        tenantColumn: 'tenant_id',
      },
      restoreTransform: {
        id: `test-statement-map-v1:${id}`,
        statementsPerRow: 2,
        async transform(_context, rowJson, mode) {
          transformed.push({ datasetId: id, mode });
          if (transformed.length === failOnCall) throw new Error('transient');
          const parsed = JSON.parse(rowJson);
          parsed.value = ['text', 'mapped'];
          return JSON.stringify(parsed);
        },
      },
      async inspectRow() {
        return [];
      },
    };
  };
  const policies = [
    policy,
    mapped('core.grants_a'),
    mapped('core.grants_b'),
    mapped('core.grants_c'),
  ];
  const rowsOf = (id: string): string[] =>
    id === policy.dataset.id
      ? [row]
      : Array.from({ length: sizes[id as keyof typeof sizes] }, (_, index) =>
          JSON.stringify({
            id: ['text', `${id}:${String(index).padStart(3, '0')}`],
            tenant_id: ['text', 'a'],
            value: ['text', 'source'],
          })
        );
  const sourceManifest = { ...manifest, datasets: policies.map(({ dataset }) => dataset) };
  await persist();
  await persistSqliteRestoreSequence(
    inventory,
    1,
    policies.map((candidate) => ({
      targetId: 'target',
      ordinal: 0,
      policy: candidate,
      manifest: sourceManifest,
      recordCount: rowsOf(candidate.dataset.id).length,
      byteCount: rowsOf(candidate.dataset.id).join('').length,
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
  const perTransition: { statements: number; datasets: Set<string> }[] = [];
  const handlers = {
    async run(slice: TenantBackupStepContext) {
      if (slice.operation.phase === 'restore_other_stores')
        return {
          phase: 'verify_restore_targets',
          cursor: slice.operation.cursor_json,
          disposition: 'continue' as const,
        };
      const before = transformed.length;
      const activeInventory = new TenantBackupExecutionInventory(
        adapter(admin),
        slice.lease,
        () => now
      );
      try {
        return await runSqliteRestoreSequenceStep(slice, {
          inventory: activeInventory,
          sequenceOrdinal: 1,
          now: () => now,
          async resolve() {
            return resource();
          },
          async assertValidatedUnpublishedPlan() {},
          async loadValidatedDataset(job) {
            const rows = rowsOf(job.datasetId);
            return {
              policy: policies.find(({ dataset }) => dataset.id === job.datasetId)!,
              manifest: sourceManifest,
              async readNextValidatedRow({ sourceCursor }) {
                const index = sourceCursor === null ? 0 : Number(sourceCursor.slice(4));
                return index < rows.length
                  ? { rowJson: rows[index], nextCursor: `row:${index + 1}` }
                  : null;
              },
            };
          },
        });
      } finally {
        // Each transformed row costs its own write or read-back and the transform's two statements.
        const calls = transformed.slice(before);
        perTransition.push({
          statements: calls.length * 3,
          datasets: new Set(calls.map(({ datasetId }) => datasetId)),
        });
      }
    },
    async cleanup() {
      throw new Error('unexpected');
    },
  };
  const tick = () => runTenantBackupScheduler(adapter(admin), handlers, context.signal, () => now);
  // Fail inside the second write page of the 400-row dataset (after A's write and B's write and
  // read-back): its first page stays written.
  failOnCall = 100 + 100 + 100 + 166 + 50;
  let failures = 0;
  for (let i = 0; i < 40; i++) {
    const phase = (await store.get('a', 'import'))?.phase;
    if (phase === 'verify_other_restore_stores') break;
    now += failures ? 61_000 : 1;
    const result = await tick();
    failures += result.failures;
  }
  expect(failures).toBe(1);
  expect((await store.get('a', 'import'))?.phase).toBe('verify_other_restore_stores');
  expect(Math.max(...perTransition.map(({ statements }) => statements))).toBeLessThanOrEqual(
    RESTORE_STATEMENT_BUDGET
  );
  // The two 100-row datasets (600 statements together) no longer share one batch.
  expect(perTransition.every(({ datasets }) => datasets.size <= 1)).toBe(true);
  for (const id of Object.keys(sizes) as (keyof typeof sizes)[]) {
    const table = id.slice('core.'.length);
    expect(
      target
        .prepare(`SELECT count(*) AS n, min(value) AS low, max(value) AS high FROM ${table}`)
        .get()
    ).toEqual({ n: sizes[id], low: 'mapped', high: 'mapped' });
  }
  expect(target.prepare('SELECT id,value FROM tenants').all()).toEqual([
    { id: 'a', value: 'restored' },
  ]);
  expect(JSON.parse((await store.get('a', 'import'))!.cursor_json!).completedRows).toEqual([
    1, 100, 100, 400,
  ]);
  // Every mapped row is written once more only where the failed page is retried.
  const writes = transformed.filter(({ mode }) => mode === 'write');
  expect(writes.filter(({ datasetId }) => datasetId === 'core.grants_c').length).toBe(400 + 50);
  expect(writes.length).toBe(600 + 50);
});

/** The D1 calls of each transition, the way the production adapter makes them (a batch is one). */
function countedD1(onCall: (statements: readonly string[]) => void) {
  return (db: DatabaseSync) => {
    const base = adapter(db);
    return {
      async query<T>(sql: string, params: unknown[] = []) {
        onCall([sql]);
        return base.query<T>(sql, params);
      },
      async queryOne<T>(sql: string, params: unknown[] = []) {
        onCall([sql]);
        return base.queryOne<T>(sql, params);
      },
      async execute(sql: string, params: unknown[] = []) {
        onCall([sql]);
        return base.execute(sql, params);
      },
      async batch(statements: { sql: string; params: unknown[] }[]) {
        onCall(statements.map(({ sql }) => sql));
        db.exec('BEGIN');
        try {
          const results = statements.map(({ sql, params }) => ({
            success: true,
            rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
          }));
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };
  };
}

/**
 * Persist a sequence of `policies` on the one test target and drive it through the real scheduler,
 * one transition per run, until the SQL restore is verified. Returns each transition's D1 calls.
 */
async function driveSequence(
  policies: readonly SqliteDatasetInspectionPolicy[],
  rowsOf: (datasetId: string) => readonly string[]
): Promise<{ phase: string; calls: (readonly string[])[] }[]> {
  let calls: (readonly string[])[] = [];
  const counted = countedD1((statements) => calls.push(statements));
  const adminDb = counted(admin);
  const sourceManifest = { ...manifest, datasets: policies.map(({ dataset }) => dataset) };
  await persist();
  await persistSqliteRestoreSequence(
    inventory,
    1,
    policies.map((candidate) => ({
      targetId: 'target',
      ordinal: 0,
      policy: candidate,
      manifest: sourceManifest,
      recordCount: rowsOf(candidate.dataset.id).length,
      byteCount: rowsOf(candidate.dataset.id).join('').length,
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
  const handlers = {
    async run(slice: TenantBackupStepContext) {
      if (slice.operation.phase === 'restore_other_stores')
        return {
          phase: 'verify_restore_targets',
          cursor: slice.operation.cursor_json,
          disposition: 'continue' as const,
        };
      return runSqliteRestoreSequenceStep(slice, {
        inventory: new TenantBackupExecutionInventory(adminDb, slice.lease, () => now),
        sequenceOrdinal: 1,
        now: () => now,
        async resolve() {
          return { ...resource(), database: counted(target) };
        },
        async assertValidatedUnpublishedPlan() {},
        async loadValidatedDataset(job) {
          const rows = rowsOf(job.datasetId);
          return {
            policy: policies.find(({ dataset }) => dataset.id === job.datasetId)!,
            manifest: sourceManifest,
            async readNextValidatedRow({ sourceCursor }) {
              const index = sourceCursor === null ? 0 : Number(sourceCursor.slice(4));
              return index < rows.length
                ? { rowJson: rows[index], nextCursor: `row:${index + 1}` }
                : null;
            },
          };
        },
      });
    },
    async cleanup() {
      throw new Error('unexpected');
    },
  };
  const transitions: { phase: string; calls: (readonly string[])[] }[] = [];
  for (let i = 0; i < 400; i++) {
    const phase = (await store.get('a', 'import'))?.phase ?? '';
    if (phase === 'verify_other_restore_stores') return transitions;
    now++;
    calls = [];
    const result = await runTenantBackupScheduler(adminDb, handlers, context.signal, () => now);
    if (result.failures) throw new Error(`transition_failed:${result.failureCodes.join(',')}`);
    transitions.push({ phase, calls });
  }
  throw new Error('sequence_not_finished');
}

/** Round trips a transition may take: the statement budget plus its fixed lease and plan checks. */
const TRANSITION_CALLS_MAX = RESTORE_STATEMENT_BUDGET + 100;

function oneRowDataset(id: string): SqliteDatasetInspectionPolicy {
  const table = id.slice('core.'.length);
  target.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL)`);
  return {
    dataset: { ...policy.dataset, id },
    restoreAfter: ['core.tenants'],
    schema: {
      table,
      columns: ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    async inspectRow() {
      return [];
    },
  };
}

it('counts each dataset count check against the statement budget of a shared batch', async () => {
  const small = Array.from({ length: 80 }, (_, index) => oneRowDataset(`core.small_${index}`));
  const transitions = await driveSequence([policy, ...small], (id) =>
    id === policy.dataset.id ? [row] : [`{"id":["text","${id}"],"tenant_id":["text","a"]}`]
  );
  const calls = transitions.map(({ calls: made }) => made.length);
  expect(Math.max(...calls)).toBeLessThanOrEqual(TRANSITION_CALLS_MAX);
  // Writing and finally verifying 81 one-row datasets takes more than one shared batch each.
  expect(transitions.filter(({ phase }) => phase === 'verify_sealed_sqlite_datasets').length).toBe(
    2 + Math.ceil(81 / Math.floor(RESTORE_STATEMENT_BUDGET / (2 * RESTORE_DATASET_STATEMENTS)))
  );
  for (const { dataset } of small)
    expect(target.prepare(`SELECT count(*) AS n FROM ${dataset.id.slice(5)}`).get()).toEqual({
      n: 1,
    });
});

it('reconciles generated rows apart from a final shared batch that fills the budget', async () => {
  target.exec(
    'CREATE TABLE outbox(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, value TEXT NOT NULL)'
  );
  target.exec(
    'CREATE TABLE mapped(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, value TEXT NOT NULL)'
  );
  const outbox: SqliteDatasetInspectionPolicy = {
    dataset: { ...policy.dataset, id: 'core.outbox' },
    restoreAfter: ['core.tenants'],
    schema: {
      table: 'outbox',
      columns: ['id', 'tenant_id', 'value'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    restoreReconcilesGeneratedRows: true,
    restoreHold: {
      id: 'test-outbox-hold-v1',
      async shouldHold() {
        return false;
      },
      async write() {},
      async verify() {},
    },
    async inspectRow() {
      return [];
    },
  };
  // 160 rows of three statements each, plus its count check: the whole budget but 8.
  const mapped: SqliteDatasetInspectionPolicy = {
    dataset: { ...policy.dataset, id: 'core.mapped' },
    restoreAfter: ['core.tenants', 'core.outbox'],
    schema: { ...outbox.schema, table: 'mapped' },
    restoreTransform: {
      id: 'test-statement-map-v1',
      statementsPerRow: 2,
      async transform(_context, rowJson) {
        return rowJson;
      },
    },
    async inspectRow() {
      return [];
    },
  };
  const rowsFor = (table: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      JSON.stringify({
        id: ['text', `${table}-${index}`],
        tenant_id: ['text', 'a'],
        value: ['text', 'done'],
      })
    );
  const transitions = await driveSequence([policy, outbox, mapped], (id) =>
    id === policy.dataset.id
      ? [row]
      : id === outbox.dataset.id
        ? rowsFor('outbox', 300)
        : rowsFor('mapped', 160)
  );
  const reconciles = (calls: (readonly string[])[]) =>
    calls.some((statements) => statements.some((sql) => /^DELETE FROM "outbox"/.test(sql)));
  const writesMapped = (calls: (readonly string[])[]) =>
    calls.some((statements) => statements.some((sql) => /INSERT INTO "mapped"/.test(sql)));
  const reconciled = transitions.filter(({ calls }) => reconciles(calls));
  expect(reconciled).toHaveLength(1);
  expect(writesMapped(reconciled[0].calls)).toBe(false);
  expect(target.prepare('SELECT count(*) AS n FROM mapped').get()).toEqual({ n: 160 });
  expect(target.prepare('SELECT count(*) AS n FROM outbox').get()).toEqual({ n: 300 });
});

it('opens many restore targets over several start transitions and resumes where it stopped', async () => {
  const count = 10;
  const databases = Array.from({ length: count }, () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      readRenderedMigrationSql(
        new URL('../../../../../../migrations/core/d1/', import.meta.url),
        '010_tenant_backup_restore_target.sql'
      )
    );
    db.exec('CREATE TABLE empty_rows(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL)');
    return db;
  });
  try {
    const physical = (index: number) => ({
      targetId: `target-${index}`,
      resourceId: `physical-${index}`,
      provisioningId: 'provision-op',
      database: adapter(databases[index]),
    });
    for (let index = 0; index < count; index++)
      await persistInitializedSqliteRestoreTarget({
        context,
        inventory,
        ordinal: index,
        resource: physical(index),
        async assertProvisioningOwnership() {},
      });
    const empty = (index: number): SqliteDatasetInspectionPolicy => ({
      ...policy,
      dataset: { ...policy.dataset, id: `core.empty_${index}` },
      schema: { ...policy.schema, table: 'empty_rows', tenantColumn: 'tenant_id' },
    });
    const sourceManifest = {
      ...manifest,
      datasets: Array.from({ length: count }, (_, index) => empty(index).dataset),
    };
    await persistSqliteRestoreSequence(
      inventory,
      count,
      Array.from({ length: count }, (_, index) => ({
        targetId: `target-${index}`,
        ordinal: index,
        policy: empty(index),
        manifest: sourceManifest,
        recordCount: 0,
        byteCount: 0,
      }))
    );
    await seal();
    const input = {
      inventory,
      sequenceOrdinal: count,
      now: () => now,
      async resolve(resourceId: string) {
        return physical(Number(resourceId.slice('physical-'.length)));
      },
      async assertValidatedUnpublishedPlan() {},
      async loadValidatedDataset(): Promise<never> {
        throw new Error('empty_datasets_must_not_be_loaded');
      },
    };
    const opened = () =>
      databases.filter(
        (db) =>
          (
            db.prepare('SELECT count(*) AS n FROM tenant_backup_restore_targets').get() as {
              n: number;
            }
          ).n > 0
      ).length;
    let cursor: string | null = JSON.stringify({
      version: 1,
      sequenceOrdinal: count,
      jobIndex: 0,
      datasetCursor: null,
      completedRows: [],
      emptyPrepared: false,
    });
    const perTransition = Math.floor(RESTORE_STATEMENT_BUDGET / 80);
    const progress: number[] = [];
    for (let transition = 0; transition < count; transition++) {
      const result = await runSqliteRestoreSequenceStep(
        {
          ...context,
          operation: {
            ...context.operation,
            phase: 'start_sqlite_restore_sequence',
            cursor_json: cursor,
          },
        },
        input
      );
      expect(result.phase).toBe('start_sqlite_restore_sequence');
      cursor = result.cursor;
      progress.push(opened());
      if (JSON.parse(cursor ?? '{}').emptyPrepared) break;
    }
    // Each start transition opens at most what the budget allows, and the next one resumes.
    expect(progress).toEqual([perTransition, count]);
    expect(JSON.parse(cursor ?? '{}')).toEqual({
      version: 1,
      sequenceOrdinal: count,
      jobIndex: 0,
      datasetCursor: null,
      completedRows: [],
      emptyPrepared: true,
    });
    const completed = await runSqliteRestoreSequenceStep(
      {
        ...context,
        operation: {
          ...context.operation,
          phase: 'start_sqlite_restore_sequence',
          cursor_json: cursor,
        },
      },
      input
    );
    expect(completed.phase).toBe('restore_other_stores');
  } finally {
    for (const db of databases) db.close();
  }
});

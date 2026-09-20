import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import {
  runTenantBackupOperationCleanupStep,
  type TenantBackupOperationCleanupAdapter,
} from '../operation-cleanup';
import { executeTenantBackupSlice } from '../operation-executor';
import { TenantBackupOperationStore } from '../operation-store';

let sql: DatabaseSync;
let database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
let store: TenantBackupOperationStore;
let now: number;

beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of [
    '003_tenant_backup_operations',
    '004_tenant_backup_validation_index',
    '008_tenant_backup_retry_state',
    '009_tenant_backup_artifact_parts',
    '011_tenant_backup_snapshot_resources',
    '012_tenant_backup_cipher_journal',
    '018_tenant_backup_dataset_inspections',
    '019_tenant_backup_input_validations',
    '020_tenant_backup_publications',
    '036_tenant_backup_capacity_parts',
    '037_tenant_backup_container_inputs',
  ])
    sql.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${name}.sql`, import.meta.url),
        'utf8'
      )
    );
  database = {
    async query<T>(statement: string, params: unknown[] = []) {
      return sql.prepare(statement).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(statement: string, params: unknown[] = []) {
      return (sql.prepare(statement).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(statement: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(sql.prepare(statement).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  store = new TenantBackupOperationStore(database);
  now = 100;
});

afterEach(() => sql.close());

function installedAdapter(): TenantBackupOperationCleanupAdapter {
  return {
    abortBoundary: vi.fn(async () => undefined),
    resolveSnapshotSource: vi.fn(async () => {
      throw new Error('unexpected snapshot');
    }),
    cleanupStagingPage: vi.fn(async () => ({ done: true })),
    cleanupAdditionalPage: vi.fn(async () => ({ done: true })),
    assertClean: vi.fn(async () => undefined),
  };
}

async function createCancelled(kind: 'export' | 'import') {
  const id = `${kind}-operation`;
  await store.create({
    id,
    tenantId: 'tenant-a',
    kind,
    idempotencyKey: `${kind}-request`,
    requestDigest: 'ab'.repeat(32),
    actorId: 'admin-a',
    now,
  });
  await store.requestCancel('tenant-a', id, ++now);
  return id;
}

it('advances an export through verified cleanup stages before marking it cancelled', async () => {
  const operationId = await createCancelled('export');
  const adapter = installedAdapter();
  for (let slices = 0; slices < 7; slices += 1) {
    now += 1;
    await executeTenantBackupSlice(
      store,
      {
        tenantId: 'tenant-a',
        operationId,
        workerId: `worker-${slices}`,
        signal: new AbortController().signal,
      },
      {
        async run() {
          throw new Error('unexpected run');
        },
        cleanup: (context) =>
          runTenantBackupOperationCleanupStep({ database, context, adapter, now: () => now }),
      },
      () => now
    );
  }
  expect((await store.get('tenant-a', operationId))?.state).toBe('cancelled');
  expect(adapter.abortBoundary).toHaveBeenCalledTimes(1);
  expect(adapter.cleanupStagingPage).toHaveBeenCalledTimes(1);
  expect(adapter.cleanupAdditionalPage).toHaveBeenCalledTimes(1);
  expect(adapter.assertClean).toHaveBeenCalledTimes(1);
});

it('starts import cleanup at validation and waits for adapter-owned staging', async () => {
  const operationId = await createCancelled('import');
  const adapter = installedAdapter();
  vi.mocked(adapter.cleanupStagingPage)
    .mockResolvedValueOnce({ done: false })
    .mockResolvedValueOnce({ done: true });
  for (let slices = 0; slices < 4; slices += 1) {
    now += 1;
    await executeTenantBackupSlice(
      store,
      {
        tenantId: 'tenant-a',
        operationId,
        workerId: `worker-${slices}`,
        signal: new AbortController().signal,
      },
      {
        async run() {
          throw new Error('unexpected run');
        },
        cleanup: (context) =>
          runTenantBackupOperationCleanupStep({ database, context, adapter, now: () => now }),
      },
      () => now
    );
  }
  expect((await store.get('tenant-a', operationId))?.state).toBe('cancelled');
  expect(adapter.abortBoundary).not.toHaveBeenCalled();
  expect(adapter.cleanupStagingPage).toHaveBeenCalledTimes(2);
});

it('fails closed on an unknown cleanup cursor', async () => {
  const operationId = await createCancelled('import');
  sql.prepare("UPDATE tenant_backup_operations SET cursor_json='{}' WHERE id=?").run(operationId);
  now += 1;
  const claimed = await store.claimCancellation('tenant-a', operationId, 'worker', now);
  await expect(
    runTenantBackupOperationCleanupStep({
      database,
      context: {
        operation: claimed!,
        lease: {
          tenantId: 'tenant-a',
          operationId,
          owner: 'worker',
          fencingToken: claimed!.fencing_token,
        },
        signal: new AbortController().signal,
      },
      adapter: installedAdapter(),
      now: () => now,
    })
  ).rejects.toThrow('backup_cleanup_cursor');
});

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import type { TenantBackupStepContext } from '../operation-executor';
import { TenantBackupOperationStore } from '../operation-store';
import { cleanupTenantBackupRestoreTargetPage } from '../restore-target-cleanup';

let sql: DatabaseSync;
let database: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
let context: TenantBackupStepContext;
let now: number;

beforeEach(async () => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const name of [
    '003_tenant_backup_operations',
    '004_tenant_backup_validation_index',
    '008_tenant_backup_retry_state',
    '024_tenant_backup_restore_plan_inventory',
    '026_tenant_backup_restore_cleanup_receipts',
  ])
    sql.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${name}.sql`, import.meta.url),
        'utf8'
      )
    );
  database = {
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
  const store = new TenantBackupOperationStore(database);
  await store.create({
    id: 'import-a',
    tenantId: 'tenant-a',
    kind: 'import',
    idempotencyKey: 'request-a',
    requestDigest: 'ab'.repeat(32),
    actorId: 'admin-a',
    now: 100,
  });
  sql
    .prepare("INSERT INTO tenant_backup_restore_plan_inventories VALUES (?,?,?,'building',0,?,?)")
    .run('import-a', 'tenant-a', 'aa'.repeat(32), '0'.repeat(64), 101);
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const targetId = `target-${ordinal}`;
    const payload = JSON.stringify({
      version: 1,
      kind: 'sqlite-restore-target',
      targetId,
      resourceId: `resource-${ordinal}`,
      provisioningId: `provision-${ordinal}`,
      seedFingerprint: String(ordinal + 1).repeat(64),
    });
    sql
      .prepare('INSERT INTO tenant_backup_restore_plan_inventory_items VALUES (?,?,?,?,?,?,?)')
      .run(
        'import-a',
        'tenant-a',
        ordinal,
        `restore-target:${targetId}`,
        payload,
        String(ordinal + 2).repeat(64),
        String(ordinal + 3).repeat(64)
      );
  }
  sql.prepare("UPDATE tenant_backup_restore_plan_inventories SET state='sealed'").run();
  await store.requestCancel('tenant-a', 'import-a', 102);
  const operation = await store.claimCancellation('tenant-a', 'import-a', 'cleaner', 103);
  now = 104;
  context = {
    operation: operation!,
    lease: {
      tenantId: 'tenant-a',
      operationId: 'import-a',
      owner: 'cleaner',
      fencingToken: operation!.fencing_token,
    },
    signal: new AbortController().signal,
  };
});

afterEach(() => sql.close());

it('records cleanup only after exact physical target deletion and proves an empty retry', async () => {
  const deleted = new Set<string>();
  let lose = true;
  const cleanup = async (target: { targetId: string; planDigest: string }) => {
    expect(target.planDigest).toBe('3'.repeat(64));
    deleted.add(target.targetId);
    if (target.targetId === 'target-1' && lose) {
      lose = false;
      throw new Error('response_lost');
    }
  };
  expect(
    await cleanupTenantBackupRestoreTargetPage({ database, context, cleanup, now: () => now })
  ).toEqual({ done: false });
  await expect(
    cleanupTenantBackupRestoreTargetPage({ database, context, cleanup, now: () => now })
  ).rejects.toThrow('response_lost');
  expect(
    sql.prepare('SELECT count(*) AS n FROM tenant_backup_restore_cleanup_receipts').get()?.n
  ).toBe(1);
  expect(
    await cleanupTenantBackupRestoreTargetPage({ database, context, cleanup, now: () => now })
  ).toEqual({ done: false });
  expect(
    await cleanupTenantBackupRestoreTargetPage({ database, context, cleanup, now: () => now })
  ).toEqual({ done: true });
  expect([...deleted].sort()).toEqual(['target-0', 'target-1']);
  expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('rejects a stale cancellation lease without invoking provider cleanup', async () => {
  now = 40_000;
  let called = false;
  await expect(
    cleanupTenantBackupRestoreTargetPage({
      database,
      context,
      cleanup: async () => {
        called = true;
      },
      now: () => now,
    })
  ).rejects.toThrow('backup_restore_cleanup_fenced');
  expect(called).toBe(false);
});

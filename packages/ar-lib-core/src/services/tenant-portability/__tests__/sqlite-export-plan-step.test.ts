import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupExecutionInventory } from '../execution-inventory';
import type { TenantBackupStepContext } from '../operation-executor';
import { TenantBackupOperationStore } from '../operation-store';
import { runTenantBackupSqliteExportPlanStep } from '../sqlite-export-plan-step';

function adapter(database: DatabaseSync) {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (database.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(database.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
}

let admin: DatabaseSync;
let source: DatabaseSync;
let adminAdapter: ReturnType<typeof adapter>;
let sourceAdapter: ReturnType<typeof adapter>;
let context: TenantBackupStepContext;
let inventory: TenantBackupExecutionInventory;
let now: number;

beforeEach(async () => {
  admin = new DatabaseSync(':memory:');
  source = new DatabaseSync(':memory:');
  admin.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '008_tenant_backup_retry_state.sql',
    '010_tenant_backup_execution_inventory.sql',
  ])
    admin.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${file}`, import.meta.url),
        'utf8'
      )
    );
  source.exec(`CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL);`);
  adminAdapter = adapter(admin);
  sourceAdapter = adapter(source);
  const store = new TenantBackupOperationStore(adminAdapter);
  await store.create({
    id: 'operation',
    tenantId: 'tenant',
    kind: 'export',
    idempotencyKey: 'request',
    requestDigest: 'ab'.repeat(32),
    actorId: 'admin',
    now: 100,
  });
  const operation = await store.claim('tenant', 'operation', 'worker', 101);
  if (!operation) throw new Error('missing_operation');
  now = 102;
  context = {
    operation,
    lease: {
      tenantId: 'tenant',
      operationId: 'operation',
      owner: 'worker',
      fencingToken: operation.fencing_token,
    },
    signal: new AbortController().signal,
  };
  inventory = new TenantBackupExecutionInventory(adminAdapter, context.lease, () => now);
});

afterEach(() => {
  admin.close();
  source.close();
});

const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};

function input(assertSources = async () => {}) {
  return {
    context,
    inventory,
    selection,
    resources: [
      {
        resourceId: 'physical_core',
        family: 'core' as const,
        database: sourceAdapter,
        descriptor: { id: 'database:physical_core', payload: '{"version":1}' },
      },
    ],
    assertSources,
  };
}

it('builds and seals a complete physical plan through bounded resumable slices', async () => {
  const first = await runTenantBackupSqliteExportPlanStep(input());
  expect(first).toMatchObject({ phase: 'prepare', disposition: 'continue' });
  expect((await inventory.head()).item_count).toBe(1);

  // Lost outer checkpoint replays the same descriptor without duplicating it.
  expect(await runTenantBackupSqliteExportPlanStep(input())).toEqual(first);
  context = {
    ...context,
    operation: { ...context.operation, cursor_json: first.cursor },
  };
  const complete = await runTenantBackupSqliteExportPlanStep(input());
  expect(complete).toEqual({
    phase: 'discover_sqlite_resources',
    cursor: null,
    disposition: 'continue',
  });
  const head = await inventory.head();
  expect(head).toMatchObject({ state: 'sealed', item_count: 3 });
  expect((await inventory.readPage()).map((item) => item.item_id)).toEqual([
    'database:physical_core',
    'physical_core:tenants',
    'physical_core:users',
  ]);
});

it('rejects resource changes and changed schema after an uncertain plan append', async () => {
  const first = await runTenantBackupSqliteExportPlanStep(input());
  context = {
    ...context,
    operation: { ...context.operation, cursor_json: first.cursor },
  };
  await expect(
    runTenantBackupSqliteExportPlanStep({
      ...input(),
      resources: [
        {
          ...input().resources[0],
          descriptor: { id: 'database:physical_core', payload: '{"version":2}' },
        },
      ],
    })
  ).rejects.toThrow('step_invalid');
  let checks = 0;
  await expect(
    runTenantBackupSqliteExportPlanStep(
      input(async () => {
        if (++checks === 2) throw new Error('response_lost');
      })
    )
  ).rejects.toThrow('response_lost');
  source.exec('ALTER TABLE tenants ADD COLUMN changed TEXT');
  await expect(runTenantBackupSqliteExportPlanStep(input())).rejects.toThrow('retry_conflict');
  expect((await inventory.head()).state).toBe('building');
});

it('rechecks source authorization before and after durable work', async () => {
  let calls = 0;
  await expect(
    runTenantBackupSqliteExportPlanStep(
      input(async () => {
        if (++calls === 2) throw new Error('source_changed');
      })
    )
  ).rejects.toThrow('source_changed');
  expect(calls).toBe(2);
  expect((await inventory.head()).item_count).toBe(1);
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { ControlService } from '../service';
import { TenantPlacementMigrationReconciler } from '../tenant-placement-migration-reconciler';
import type { TenantMigrationTransferExecutor } from '../tenant-placement-migration-transfer';

const dependencies = vi.hoisted(() => ({
  inspect: vi.fn(),
  classify: vi.fn(),
  readBackfill: vi.fn(),
  applyBackfill: vi.fn(),
  readOutbox: vi.fn(),
  applyOutbox: vi.fn(),
}));

vi.mock('../tenant-placement-migration-inventory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-placement-migration-inventory')>()),
  inspectTenantMigrationSchema: dependencies.inspect,
  classifyTenantMigrationSchema: dependencies.classify,
}));
vi.mock('../tenant-placement-migration-transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenant-placement-migration-transfer')>()),
  readTenantMigrationBackfillPage: dependencies.readBackfill,
  applyTenantMigrationBackfillPage: dependencies.applyBackfill,
  readTenantMigrationOutboxBatch: dependencies.readOutbox,
  applyTenantMigrationOutboxBatch: dependencies.applyOutbox,
}));

type MigrationState =
  | 'planning'
  | 'targets_provisioning'
  | 'inventory_verifying'
  | 'capture_installing'
  | 'backfilling'
  | 'catching_up'
  | 'write_fencing'
  | 'purge_pending';

const operation = (migrationState: MigrationState) => ({
  operation_id: 'migration-a',
  environment_id: 'env-a',
  tenant_id: 'tenant-a',
  migration_state: migrationState,
  source_policy_generation: 1,
  target_policy_generation: 2,
  owner_id: null,
  fencing_token: 7,
  lease_expires_at: null,
});

const shard = (state: string, overrides: Record<string, unknown> = {}) => ({
  operation_id: 'migration-a',
  environment_id: 'env-a',
  tenant_id: 'tenant-a',
  data_role: 'tenant_core/default',
  residency_policy_id: 'default',
  residency_partition: 'jp',
  source_shard_id: 'source-a',
  source_assignment_generation: 1,
  target_shard_id: 'target-a',
  target_assignment_generation: 2,
  shard_state: state,
  table_cursor_json: '{"tableIndex":0,"cursor":null}',
  source_row_count: 0,
  target_row_count: 0,
  last_observed_source_sequence: 0,
  last_applied_source_sequence: 0,
  capture_fencing_token: 8,
  ...overrides,
});

const purgeInventory = {
  table_name: 'tenants',
  ownership_json: '{"kind":"tenant_row","column":"id"}',
  disposition: 'migrate',
  primary_key_json: '["id"]',
  columns_json: '[{"name":"id","primaryKeyPosition":1}]',
  foreign_keys_json: '[]',
};

function harness(
  state: MigrationState,
  options: {
    migrationShard?: ReturnType<typeof shard> | null;
    route?: { source_database_id: string; target_database_id: string | null } | null;
    inventory?: unknown[];
    inventoryCount?: number;
    remainingShards?: number;
    claimChanges?: number;
  } = {}
) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const batched: { sql: string; params: unknown[] }[][] = [];
  const first = vi.fn(async (sql: string) => {
    if (sql.includes('FROM control_tenant_placement_migration_inventory\n')) {
      return { count: options.inventoryCount ?? 0 };
    }
    if (sql.includes('SELECT COUNT(*) AS count')) return { count: options.remainingShards ?? 0 };
    if (sql.includes('FROM control_tenant_placement_migrations\n')) return operation(state);
    if (sql.includes('FROM control_tenant_placement_migration_shards\n')) {
      return options.migrationShard ?? null;
    }
    if (sql.includes('FROM control_tenant_shards source_shard')) return options.route ?? null;
    if (sql.includes('AS next_generation')) return { next_generation: 2 };
    if (sql.includes('AS source_database_id')) return { source_database_id: 'source-a-db' };
    throw new Error(`unexpected_first_query:${sql}`);
  });
  const session = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = { sql, params };
          return {
            ...statement,
            first: async <T>() => (await first(sql)) as T | null,
            all: async <T>() => ({
              success: true,
              results: (options.inventory ?? []) as T[],
              meta: { changes: 0 },
            }),
            run: async () => {
              statements.push(statement);
              return {
                success: true,
                results: [],
                meta: {
                  changes: sql.includes('SET owner_id = ?') && options.claimChanges === 0 ? 0 : 1,
                },
              };
            },
          };
        },
      };
    },
  };
  const database = {
    withSession: () => session,
    batch: vi.fn(async (input: { sql: string; params: unknown[] }[]) => {
      batched.push(input);
      return input.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
    }),
  } as unknown as D1Database;
  const requestTenantShard = vi.fn();
  const control = { requestTenantShard } as unknown as ControlService;
  const queryD1 = vi.fn(async (_databaseId: string, sql: string): Promise<unknown[]> => {
    if (sql.includes('SELECT tenant_key')) {
      return [{ success: true, results: [{ tenant_key: 'tenant-key-a' }] }];
    }
    throw new Error(`unexpected_source_query:${sql}`);
  });
  const queryD1Batch = vi.fn();
  const transfer = { queryD1, queryD1Batch } as unknown as TenantMigrationTransferExecutor;
  const reconciler = new TenantPlacementMigrationReconciler(database, control, transfer, () => 100);
  return { reconciler, statements, batched, requestTenantShard, queryD1, queryD1Batch, first };
}

function blockedCode(statements: { sql: string; params: unknown[] }[]): unknown {
  return statements.find((statement) => statement.sql.includes("migration_state = 'blocked'"))
    ?.params[0];
}

describe('tenant placement reconciler guards', () => {
  beforeEach(() => {
    Object.values(dependencies).forEach((mock) => mock.mockReset());
  });

  it('does not process an operation when another worker wins the lease', async () => {
    const context = harness('planning', { claimChanges: 0 });

    expect(await context.reconciler.reconcile()).toBe(0);
    expect(context.statements).toHaveLength(1);
    expect(context.statements[0].sql).toContain('fencing_token = ?');
    expect(context.statements[0].params.slice(-4)).toEqual(['migration-a', 'env-a', 7, 100]);
    expect(context.batched).toHaveLength(0);
  });

  it('waits for target provisioning and retries with the same tenant-scoped idempotency key', async () => {
    const context = harness('targets_provisioning', {
      migrationShard: shard('target_pending'),
    });
    context.requestTenantShard.mockResolvedValueOnce({ operation: { status: 'running' } });
    context.requestTenantShard.mockResolvedValueOnce({
      operation: { status: 'succeeded' },
      plan: { shardId: 'target-a' },
    });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(context.batched).toHaveLength(0);
    expect(blockedCode(context.statements)).toBeUndefined();

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(context.requestTenantShard).toHaveBeenCalledTimes(2);
    expect(context.requestTenantShard.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      {
        environmentId: 'env-a',
        tenantId: 'tenant-a',
        dataRole: 'tenant_core/default',
        residencyPolicyId: 'default',
        residencyPartition: 'jp',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-a',
        idempotencyKey: 'placement-target:migration-a:source-a',
      },
      {
        environmentId: 'env-a',
        tenantId: 'tenant-a',
        dataRole: 'tenant_core/default',
        residencyPolicyId: 'default',
        residencyPartition: 'jp',
        allocationScope: 'tenant_exclusive',
        ownerTenantId: 'tenant-a',
        idempotencyKey: 'placement-target:migration-a:source-a',
      },
    ]);
    expect(context.batched).toHaveLength(1);
    expect(context.batched[0].map((statement) => statement.params)).toEqual([
      [
        'env-a',
        'tenant-a',
        'tenant_core/default',
        'default',
        'jp',
        'target-a',
        2,
        'migration-a',
        100,
        100,
      ],
      ['target-a', 2, 100, 'migration-a', 'source-a', expect.any(String), 8],
    ]);
  });

  it('blocks a failed target and releases the claimed lease without inserting an assignment', async () => {
    const context = harness('targets_provisioning', {
      migrationShard: shard('target_pending'),
    });
    context.requestTenantShard.mockResolvedValue({
      operation: { status: 'blocked', lastErrorCode: 'provider_capacity_exhausted' },
    });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe('provider_capacity_exhausted');
    expect(context.statements.at(-1)?.sql).toContain('SET owner_id = NULL');
    expect(context.batched).toHaveLength(0);
  });

  it('redacts an unsafe provider error before storing the blocked state', async () => {
    const context = harness('targets_provisioning', {
      migrationShard: shard('target_pending'),
    });
    context.requestTenantShard.mockRejectedValue(new Error('secret=provider-token'));

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe(
      'control_tenant_placement_migration_internal_error'
    );
    expect(JSON.stringify(context.statements)).not.toContain('secret=provider-token');
  });

  it('blocks a missing target route before schema inspection or external writes', async () => {
    const context = harness('inventory_verifying', {
      migrationShard: shard('inventory_pending'),
      route: { source_database_id: 'source-a-db', target_database_id: null },
    });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe(
      'control_tenant_placement_database_route_unavailable'
    );
    expect(context.queryD1).not.toHaveBeenCalled();
    expect(context.queryD1Batch).not.toHaveBeenCalled();
    expect(context.batched).toHaveLength(0);
  });

  it('blocks source and target schema drift before persisting an inventory snapshot', async () => {
    const context = harness('inventory_verifying', {
      migrationShard: shard('inventory_pending'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
    });
    dependencies.inspect.mockResolvedValueOnce({ tables: ['tenants'] });
    dependencies.inspect.mockResolvedValueOnce({ tables: ['other_table'] });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(dependencies.inspect).toHaveBeenCalledTimes(2);
    expect(dependencies.classify).not.toHaveBeenCalled();
    expect(blockedCode(context.statements)).toBe('control_tenant_placement_schema_mismatch');
    expect(context.batched).toHaveLength(0);
  });

  it('persists a verified inventory before marking the shard ready for capture', async () => {
    const context = harness('inventory_verifying', {
      migrationShard: shard('inventory_pending'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventoryCount: 1,
    });
    dependencies.inspect.mockResolvedValue({ tables: ['tenants'] });
    dependencies.classify.mockReturnValue({
      state: 'ready',
      tables: [
        {
          table: 'tenants',
          ownership: { kind: 'tenant_row', column: 'id' },
          disposition: 'migrate',
          primaryKey: ['id'],
          columns: [{ name: 'id', primaryKeyPosition: 1 }],
          foreignKeys: [],
        },
      ],
    });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(dependencies.classify).toHaveBeenCalledWith('tenant_core/default', {
      tables: ['tenants'],
    });
    expect(context.batched).toHaveLength(1);
    expect(context.batched[0][0].sql).toContain(
      'INSERT OR IGNORE INTO control_tenant_placement_migration_inventory'
    );
    expect(context.batched[0][0].params.slice(0, 3)).toEqual([
      'migration-a',
      'source-a',
      'tenants',
    ]);
    expect(
      context.statements
        .find((statement) => statement.sql.includes("shard_state = 'capture_pending'"))
        ?.params.slice(0, 3)
    ).toEqual([1, 100, 100]);
  });

  it('does not mark capture installed when source verification belongs to another tenant', async () => {
    const context = harness('capture_installing', {
      migrationShard: shard('capture_pending'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    context.queryD1Batch.mockImplementation(async (_databaseId: string, queries: unknown[]) =>
      queries.map(() => ({ success: true }))
    );
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([
      {
        success: true,
        results: [
          {
            tenant_id: 'tenant-b',
            source_shard_id: 'source-a',
            migration_generation: 2,
            capture_state: 'capturing',
            fencing_token: 8,
          },
        ],
      },
    ]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe(
      'control_tenant_placement_capture_verification_failed'
    );
    expect(context.queryD1Batch).toHaveBeenCalledOnce();
    expect(
      context.statements.some((statement) => statement.sql.includes("shard_state = 'backfilling'"))
    ).toBe(false);
  });

  it('checkpoints a capture only after the source confirms tenant and fencing token', async () => {
    const context = harness('capture_installing', {
      migrationShard: shard('capture_pending'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    context.queryD1Batch.mockImplementation(async (_databaseId: string, queries: unknown[]) =>
      queries.map(() => ({ success: true }))
    );
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([
      {
        success: true,
        results: [
          {
            tenant_id: 'tenant-a',
            source_shard_id: 'source-a',
            migration_generation: 2,
            capture_state: 'capturing',
            fencing_token: 8,
          },
        ],
      },
    ]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(context.queryD1Batch).toHaveBeenCalledOnce();
    expect(
      context.statements
        .find((statement) => statement.sql.includes("shard_state = 'backfilling'"))
        ?.params.slice(0, 3)
    ).toEqual([8, 100, 100]);
  });

  it('blocks an invalid backfill cursor before reading or writing tenant data', async () => {
    const context = harness('backfilling', {
      migrationShard: shard('backfilling', { table_cursor_json: '{"tableIndex":-1}' }),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
    });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe(
      'control_tenant_placement_backfill_cursor_invalid'
    );
    expect(context.queryD1).toHaveBeenCalledExactlyOnceWith(
      'source-a-db',
      'SELECT tenant_key FROM tenants WHERE id = ? LIMIT 1',
      ['tenant-a']
    );
    expect(context.queryD1Batch).not.toHaveBeenCalled();
  });

  it('checkpoints a backfill page only after applying tenant rows to the target', async () => {
    const context = harness('backfilling', {
      migrationShard: shard('backfilling'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    dependencies.readBackfill.mockResolvedValue({
      rows: [{ id: 'tenant-a' }],
      done: true,
      nextCursor: null,
    });
    dependencies.applyBackfill.mockResolvedValue(undefined);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(dependencies.readBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDatabaseId: 'source-a-db',
        tenantId: 'tenant-a',
        tenantKey: 'tenant-key-a',
      })
    );
    expect(dependencies.applyBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDatabaseId: 'target-a-db',
        tenantId: 'tenant-a',
        rows: [{ id: 'tenant-a' }],
      })
    );
    expect(
      context.statements.find((statement) => statement.sql.includes('source_row_count ='))?.params
    ).toEqual([
      '{"tableIndex":1,"cursor":null}',
      1,
      1,
      100,
      'migration-a',
      'source-a',
      '{"tableIndex":0,"cursor":null}',
    ]);
  });

  it('does not advance the backfill cursor when the target write fails', async () => {
    const context = harness('backfilling', {
      migrationShard: shard('backfilling'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    dependencies.readBackfill.mockResolvedValue({
      rows: [{ id: 'tenant-a' }],
      done: true,
      nextCursor: null,
    });
    dependencies.applyBackfill.mockRejectedValue(new Error('target_d1_write_failed'));

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe('target_d1_write_failed');
    expect(
      context.statements.some((statement) => statement.sql.includes('source_row_count ='))
    ).toBe(false);
  });

  it('requires an installed capture fence before applying outbox changes', async () => {
    const context = harness('catching_up', {
      migrationShard: shard('catching_up', { capture_fencing_token: null }),
    });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe('control_tenant_placement_capture_fence_missing');
    expect(context.queryD1).not.toHaveBeenCalled();
    expect(context.queryD1Batch).not.toHaveBeenCalled();
  });

  it('advances the outbox sequence only after replay is applied to the target', async () => {
    const context = harness('catching_up', {
      migrationShard: shard('catching_up'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    dependencies.readOutbox.mockResolvedValue([{ sourceSequence: 9 }]);
    dependencies.applyOutbox.mockResolvedValue({ lastAppliedSequence: 9 });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(dependencies.readOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDatabaseId: 'source-a-db',
        operationId: 'migration-a',
        tenantId: 'tenant-a',
        fencingToken: 8,
        afterSequence: 0,
      })
    );
    expect(dependencies.applyOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDatabaseId: 'target-a-db',
        tenantId: 'tenant-a',
        records: [{ sourceSequence: 9 }],
      })
    );
    expect(
      context.statements.find((statement) =>
        statement.sql.includes('last_applied_source_sequence = ?')
      )?.params
    ).toEqual([9, 9, 100, 'migration-a', 'source-a', 0]);
  });

  it('keeps the old outbox sequence when replay to the target fails', async () => {
    const context = harness('catching_up', {
      migrationShard: shard('catching_up'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    dependencies.readOutbox.mockResolvedValue([{ sourceSequence: 9 }]);
    dependencies.applyOutbox.mockRejectedValue(new Error('target_outbox_apply_failed'));

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe('target_outbox_apply_failed');
    expect(
      context.statements.some((statement) =>
        statement.sql.includes('last_applied_source_sequence = ?')
      )
    ).toBe(false);
  });

  it('starts verification only when the tenant outbox is fully caught up', async () => {
    const context = harness('catching_up', {
      migrationShard: shard('catching_up'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    dependencies.readOutbox.mockResolvedValue([]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ max_sequence: 0, pending_count: 0 }] },
    ]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(context.queryD1).toHaveBeenNthCalledWith(
      2,
      'source-a-db',
      expect.stringContaining('FROM tenant_placement_migration_outbox'),
      ['migration-a', 'tenant-a', 8]
    );
    expect(
      context.statements.find((statement) => statement.sql.includes("shard_state = 'verifying'"))
        ?.params[1]
    ).toBe(
      JSON.stringify({
        phase: 'preliminary',
        tableIndex: 0,
        cursor: null,
        rowCount: 0,
        checksum: '0'.repeat(64),
        baselineSequence: 0,
      })
    );
  });

  it('refuses a malformed outbox status instead of starting verification', async () => {
    const context = harness('catching_up', {
      migrationShard: shard('catching_up'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    dependencies.readOutbox.mockResolvedValue([]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ max_sequence: '0', pending_count: 0 }] },
    ]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe('control_tenant_placement_outbox_status_invalid');
    expect(
      context.statements.some((statement) => statement.sql.includes("shard_state = 'verifying'"))
    ).toBe(false);
  });

  it('waits while tenant outbox deliveries are pending', async () => {
    const context = harness('catching_up', {
      migrationShard: shard('catching_up'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    dependencies.readOutbox.mockResolvedValue([]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ max_sequence: 1, pending_count: 1 }] },
    ]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(
      context.statements.some(
        (statement) =>
          statement.sql.includes('last_applied_source_sequence = ?') ||
          statement.sql.includes("shard_state = 'verifying'")
      )
    ).toBe(false);
  });

  it('records an observed source sequence before starting verification on a later pass', async () => {
    const context = harness('catching_up', {
      migrationShard: shard('catching_up'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    dependencies.readOutbox.mockResolvedValue([]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ max_sequence: 1, pending_count: 0 }] },
    ]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(
      context.statements.find((statement) =>
        statement.sql.includes('last_applied_source_sequence = ?')
      )?.params
    ).toEqual([1, 1, 100, 'migration-a', 'source-a', 0]);
    expect(
      context.statements.some((statement) => statement.sql.includes("shard_state = 'verifying'"))
    ).toBe(false);
  });

  it('does not accept a write fence with the wrong capture token', async () => {
    const context = harness('write_fencing', {
      migrationShard: shard('verifying'),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([{ success: true, meta: { changes: 1 } }]);
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ capture_state: 'write_fenced', fencing_token: 7 }] },
    ]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe(
      'control_tenant_placement_write_fence_verification_failed'
    );
    expect(context.queryD1).toHaveBeenNthCalledWith(
      2,
      'source-a-db',
      expect.stringContaining("SET capture_state = 'write_fenced'"),
      [100, 100, 'migration-a', 'tenant-a', 'source-a', 8]
    );
    expect(context.batched).toHaveLength(0);
  });

  it('rejects a corrupt purge cursor before deleting source data', async () => {
    const context = harness('purge_pending', {
      migrationShard: shard('quarantined', { table_cursor_json: '{"purgeTableIndex":-1}' }),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
    });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe('control_tenant_placement_purge_cursor_invalid');
    expect(context.queryD1).not.toHaveBeenCalled();
    expect(context.queryD1Batch).not.toHaveBeenCalled();
  });

  it('never purges a source without a valid capture fence', async () => {
    const context = harness('purge_pending', {
      migrationShard: shard('quarantined', {
        table_cursor_json: '{"purgeTableIndex":0}',
        capture_fencing_token: null,
      }),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe('control_tenant_placement_purge_capture_invalid');
    expect(context.queryD1).not.toHaveBeenCalled();
    expect(context.queryD1Batch).not.toHaveBeenCalled();
  });

  it('checkpoints a source purge only after its tenant-scoped delete succeeds', async () => {
    const context = harness('purge_pending', {
      migrationShard: shard('quarantined', { table_cursor_json: '{"purgeTableIndex":0}' }),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    context.queryD1Batch.mockImplementation(async (_databaseId: string, queries: unknown[]) =>
      queries.map(() => ({ success: true }))
    );
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([{ success: true, meta: { changes: 1 } }]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(context.queryD1Batch).toHaveBeenCalledOnce();
    expect(context.queryD1Batch.mock.calls[0][0]).toBe('source-a-db');
    expect(context.queryD1).toHaveBeenNthCalledWith(
      2,
      'source-a-db',
      expect.stringContaining('DELETE FROM "tenants"'),
      ['tenant-a', 100]
    );
    expect(
      context.statements.find((statement) => statement.sql.includes('SET table_cursor_json = ?'))
        ?.params[0]
    ).toBe('{"purgeTableIndex":1}');
  });

  it('does not advance the purge checkpoint if the source rejects the delete', async () => {
    const context = harness('purge_pending', {
      migrationShard: shard('quarantined', { table_cursor_json: '{"purgeTableIndex":0}' }),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    context.queryD1Batch.mockImplementation(async (_databaseId: string, queries: unknown[]) =>
      queries.map(() => ({ success: true }))
    );
    context.queryD1.mockResolvedValueOnce([
      { success: true, results: [{ tenant_key: 'tenant-key-a' }] },
    ]);
    context.queryD1.mockResolvedValueOnce([{ success: false, meta: { changes: 1 } }]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe('control_tenant_placement_source_purge_failed');
    expect(
      context.statements.some((statement) => statement.sql.includes('SET table_cursor_json = ?'))
    ).toBe(false);
    expect(context.batched).toHaveLength(0);
  });

  it('retires a quarantined source only after its outbox is empty', async () => {
    const context = harness('purge_pending', {
      migrationShard: shard('quarantined', { table_cursor_json: '{"purgeTableIndex":1}' }),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    context.queryD1.mockResolvedValueOnce([{ success: true, meta: { changes: 0 } }]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(context.queryD1).toHaveBeenCalledExactlyOnceWith(
      'source-a-db',
      expect.stringContaining('DELETE FROM tenant_placement_migration_outbox'),
      ['migration-a', 'tenant-a', 100]
    );
    expect(context.batched).toHaveLength(1);
    expect(context.batched[0][0].sql).toContain("shard_state = 'purged'");
    expect(context.batched[0][1].sql).toContain("assignment_state = 'retired'");
  });

  it('keeps a source quarantined when its outbox delete fails', async () => {
    const context = harness('purge_pending', {
      migrationShard: shard('quarantined', { table_cursor_json: '{"purgeTableIndex":1}' }),
      route: { source_database_id: 'source-a-db', target_database_id: 'target-a-db' },
      inventory: [purgeInventory],
    });
    context.queryD1.mockResolvedValueOnce([{ success: false, meta: { changes: 0 } }]);

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe(
      'control_tenant_placement_source_outbox_purge_failed'
    );
    expect(context.batched).toHaveLength(0);
  });

  it('does not complete purge while any shard remains unpurged', async () => {
    const context = harness('purge_pending', { remainingShards: 1 });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBe(
      'control_tenant_placement_source_purge_incomplete'
    );
    expect(context.batched).toHaveLength(0);
  });

  it('completes a fully purged operation with an idempotent audit event', async () => {
    const context = harness('purge_pending', { remainingShards: 0 });

    expect(await context.reconciler.reconcile(1)).toBe(1);
    expect(blockedCode(context.statements)).toBeUndefined();
    expect(context.batched).toHaveLength(1);
    expect(context.batched[0][0].sql).toContain("migration_state = 'complete'");
    expect(context.batched[0][1].sql).toContain("status = 'succeeded'");
    expect(context.batched[0][2].sql).toContain('INSERT OR IGNORE INTO control_audit_events');
    expect(context.batched[0][2].params).toEqual([
      'audit:migration-a:source-purge-complete',
      'env-a',
      'migration-a',
      'migration-a',
      100,
    ]);
  });
});

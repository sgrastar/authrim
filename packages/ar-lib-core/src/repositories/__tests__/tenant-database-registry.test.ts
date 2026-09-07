import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import {
  TenantDatabaseRegistryRepository,
  type TenantDatabaseActivePointer,
  type TenantDatabaseRegistryRow,
  type TenantDatabaseStatsRow,
} from '../admin/tenant-database-registry';

function createAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction: vi.fn(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
      fn({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
      })
    ),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
    ...overrides,
  };
}

function createRegistryRow(
  overrides: Partial<TenantDatabaseRegistryRow> = {}
): TenantDatabaseRegistryRow {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    generation: 1,
    shard_group: 'default',
    shard_index: 0,
    provider: 'd1',
    database_id: 'db-core-id',
    database_name: 'authrim-dev-tenant-a-core',
    binding_ref: 'TDB_TENANT_A_1234_CORE',
    connection_ref: null,
    schema_version: 1,
    status: 'requested',
    shard_count: 1,
    shard_key_strategy: 'none',
    worker_shard: null,
    deployment_target: null,
    region_hint: null,
    jurisdiction: null,
    signature: null,
    signature_key_id: null,
    metadata_json: null,
    created_at: '2026-05-16T00:00:00.000Z',
    updated_at: '2026-05-16T00:00:00.000Z',
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

function createStatsRow(overrides: Partial<TenantDatabaseStatsRow> = {}): TenantDatabaseStatsRow {
  return {
    tenant_id: 'tenant-a',
    role: 'tenant_core',
    generation: 1,
    shard_group: 'default',
    shard_index: 0,
    account_count: 700000,
    active_user_count: 650000,
    active_pending_user_count: 675000,
    d1_file_size_bytes: 8_000_000_000,
    d1_file_size_checked_at: '2026-05-16T00:00:00.000Z',
    d1_file_size_status: 'fresh',
    table_size_estimate_json: null,
    row_count_estimate_json: null,
    warning_state: 'warning',
    warning_reasons_json: '["account_count_warning_threshold"]',
    stats_checked_at: '2026-05-16T00:00:00.000Z',
    updated_at: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('TenantDatabaseRegistryRepository', () => {
  it('inserts tenant database registry rows with default shard metadata', async () => {
    const row = createRegistryRow();
    const queryOne = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ queryOne, execute }));

    const saved = await repo.upsertRegistryRow({
      tenant_id: 'tenant-a',
      role: 'tenant_core',
      generation: 1,
      provider: 'd1',
      database_id: 'db-core-id',
      database_name: 'authrim-dev-tenant-a-core',
      binding_ref: 'TDB_TENANT_A_1234_CORE',
    });

    expect(saved).toBe(row);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tenant_database_registry'),
      [
        'tenant-a',
        'tenant_core',
        1,
        'default',
        0,
        'd1',
        'db-core-id',
        'authrim-dev-tenant-a-core',
        'TDB_TENANT_A_1234_CORE',
        null,
        1,
        'requested',
        1,
        'none',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        expect.any(String),
        expect.any(String),
        null,
        null,
      ]
    );
  });

  it('rejects active pointer updates without a matching registry row', async () => {
    const transaction = vi.fn(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
      fn({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValue(null),
        execute: vi.fn(),
      })
    );
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ transaction }));

    await expect(
      repo.setActivePointer({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
      })
    ).rejects.toThrow('tenant_database_active_pointer_missing_registry_row');
  });

  it('updates tenant database registry status for health reconciliation', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ execute }));

    await repo.updateRegistryStatus(
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        shard_group: 'default',
        shard_index: 0,
      },
      'degraded',
      'tenant-db-health'
    );

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenant_database_registry'),
      [
        'degraded',
        expect.any(String),
        'tenant-db-health',
        'tenant-a',
        'tenant_core',
        2,
        'default',
        0,
      ]
    );
  });

  it('bumps runtime generation when moving an existing active pointer', async () => {
    const registry = createRegistryRow({ generation: 2, shard_count: 1 });
    const existing: TenantDatabaseActivePointer = {
      tenant_id: 'tenant-a',
      role: 'tenant_core',
      shard_group: 'default',
      generation: 1,
      shard_count: 1,
      shard_key_strategy: 'none',
      runtime_generation: 4,
      status: 'active',
      updated_at: '2026-05-16T00:00:00.000Z',
      updated_by: null,
      metadata_json: null,
    };
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const transaction = vi.fn(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
      fn({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValueOnce(registry).mockResolvedValueOnce(existing),
        execute,
      })
    );
    const queryOne = vi
      .fn()
      .mockResolvedValue({ ...existing, generation: 2, runtime_generation: 5 });
    const repo = new TenantDatabaseRegistryRepository(
      createAdapter({
        transaction,
        queryOne,
      })
    );

    const pointer = await repo.setActivePointer({
      tenant_id: 'tenant-a',
      role: 'tenant_core',
      generation: 2,
    });

    expect(pointer.runtime_generation).toBe(5);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenant_database_active_pointers'),
      [
        2,
        1,
        'none',
        5,
        'active',
        expect.any(String),
        null,
        null,
        'tenant-a',
        'tenant_core',
        'default',
      ]
    );
  });

  it('upserts tenant database stats for capacity warning jobs', async () => {
    const row = createStatsRow();
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const queryOne = vi.fn().mockResolvedValue(row);
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ execute, queryOne }));

    const saved = await repo.upsertStats({
      tenant_id: 'tenant-a',
      role: 'tenant_core',
      generation: 1,
      account_count: 700000,
      active_user_count: 650000,
      active_pending_user_count: 675000,
      d1_file_size_bytes: 8_000_000_000,
      d1_file_size_checked_at: '2026-05-16T00:00:00.000Z',
      d1_file_size_status: 'fresh',
      warning_state: 'warning',
      warning_reasons_json: '["account_count_warning_threshold"]',
      stats_checked_at: '2026-05-16T00:00:00.000Z',
    });

    expect(saved).toBe(row);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tenant_database_stats'),
      [
        'tenant-a',
        'tenant_core',
        1,
        'default',
        0,
        700000,
        650000,
        675000,
        8_000_000_000,
        '2026-05-16T00:00:00.000Z',
        'fresh',
        null,
        null,
        'warning',
        '["account_count_warning_threshold"]',
        '2026-05-16T00:00:00.000Z',
        expect.any(String),
      ]
    );
  });

  it('lists active registry rows for scheduled tenant stats jobs', async () => {
    const rows = [createRegistryRow({ status: 'active' })];
    const query = vi.fn().mockResolvedValue(rows);
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ query }));

    await expect(repo.listActiveRegistryRowsForRole('tenant_core', 25)).resolves.toBe(rows);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('JOIN tenant_database_registry'), [
      'tenant_core',
      25,
      0,
    ]);
  });

  it('lists active pointers for runtime snapshot publishing', async () => {
    const pointers: TenantDatabaseActivePointer[] = [
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        shard_group: 'default',
        generation: 2,
        shard_count: 1,
        shard_key_strategy: 'none',
        runtime_generation: 4,
        status: 'active',
        updated_at: '2026-05-16T00:00:00.000Z',
        updated_by: null,
        metadata_json: null,
      },
    ];
    const query = vi.fn().mockResolvedValue(pointers);
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ query }));

    await expect(repo.listActivePointersForTenant('tenant-a')).resolves.toBe(pointers);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM tenant_database_active_pointers'),
      ['tenant-a']
    );
  });

  it('upserts runtime cache generations for KV generation distribution', async () => {
    const row = {
      tenant_id: 'tenant-a',
      cache_namespace: 'runtime_registry',
      generation: 4,
      updated_at: '2026-05-16T00:00:00.000Z',
      updated_by: 'system',
      metadata_json: null,
    };
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const queryOne = vi.fn().mockResolvedValue(row);
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ execute, queryOne }));

    await expect(
      repo.upsertRuntimeCacheGeneration({
        tenant_id: 'tenant-a',
        cache_namespace: 'runtime_registry',
        generation: 4,
        updated_by: 'system',
      })
    ).resolves.toBe(row);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tenant_runtime_cache_generations'),
      ['tenant-a', 'runtime_registry', 4, expect.any(String), 'system', null]
    );
  });

  it('reads persisted runtime cache generation state', async () => {
    const row = {
      tenant_id: 'tenant-a',
      cache_namespace: 'runtime_registry',
      generation: 5,
      updated_at: '2026-05-16T00:00:00.000Z',
      updated_by: 'system',
      metadata_json: '{"route_status":"quarantining","quarantine_deny_generation":1}',
    };
    const queryOne = vi.fn().mockResolvedValue(row);
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ queryOne }));

    await expect(repo.getRuntimeCacheGeneration('tenant-a', 'runtime_registry')).resolves.toBe(row);
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM tenant_runtime_cache_generations'),
      ['tenant-a', 'runtime_registry']
    );
  });

  it('commits runtime publication metadata only against the observed state', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ execute }));
    const expected = {
      tenant_id: 'tenant-a',
      cache_namespace: 'runtime_registry' as const,
      generation: 5,
      updated_at: '2026-05-16T00:00:00.000Z',
      updated_by: 'system',
      metadata_json: '{"route_status":"active"}',
    };

    await expect(
      repo.commitRuntimeCacheGenerationPublication(
        {
          tenant_id: 'tenant-a',
          cache_namespace: 'runtime_registry',
          generation: 5,
          metadata_json: '{"route_status":"active","snapshot_key":"snapshot"}',
        },
        expected
      )
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('AND metadata_json IS ?'), [
      5,
      expect.any(String),
      null,
      '{"route_status":"active","snapshot_key":"snapshot"}',
      'tenant-a',
      'runtime_registry',
      5,
      '2026-05-16T00:00:00.000Z',
      '{"route_status":"active"}',
    ]);
  });

  it('upserts runtime registry snapshot metadata', async () => {
    const row = {
      tenant_id: 'tenant-a',
      snapshot_scope: 'tenant',
      deployment_target: 'default',
      runtime_generation: 4,
      backend_provider: 'd1' as const,
      placement_policy: 'tenant_exclusive' as const,
      placement_policy_generation: 3,
      snapshot_version: 3,
      status: 'active',
      object_ref: 'tenant:tenant-a:runtime-registry:snapshot:tenant:default',
      published_at: '2026-05-16T00:00:00.000Z',
      expires_at: '2026-05-16T00:30:00.000Z',
      signature: null,
      signature_key_id: null,
      metadata_json: null,
    };
    const execute = vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 });
    const queryOne = vi.fn().mockResolvedValue(row);
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ execute, queryOne }));

    await expect(
      repo.upsertRuntimeRegistrySnapshot({
        tenant_id: 'tenant-a',
        runtime_generation: 4,
        backend_provider: 'd1',
        placement_policy: 'tenant_exclusive',
        placement_policy_generation: 3,
        object_ref: 'tenant:tenant-a:runtime-registry:snapshot:tenant:default',
        published_at: '2026-05-16T00:00:00.000Z',
        expires_at: '2026-05-16T00:30:00.000Z',
      })
    ).resolves.toBe(row);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tenant_runtime_registry_snapshots'),
      [
        'tenant-a',
        'tenant',
        'default',
        4,
        'd1',
        'tenant_exclusive',
        3,
        3,
        'active',
        'tenant:tenant-a:runtime-registry:snapshot:tenant:default',
        '2026-05-16T00:00:00.000Z',
        '2026-05-16T00:30:00.000Z',
        null,
        null,
        null,
      ]
    );
  });

  it('lists stale tenant database stats by cutoff', async () => {
    const rows = [createStatsRow()];
    const query = vi.fn().mockResolvedValue(rows);
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ query }));

    await expect(repo.listStatsOlderThan('2026-05-15T00:00:00.000Z', 50)).resolves.toBe(rows);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('stats_checked_at < ?'), [
      '2026-05-15T00:00:00.000Z',
      50,
    ]);
  });

  it('summarizes active tenant database stats for Admin status surfaces', async () => {
    const queryOne = vi.fn().mockResolvedValue({
      active_tenant_core_databases: 3,
      stats_rows: 2,
      missing_stats_count: 1,
      stale_stats_count: 1,
      warning_count: 1,
      strong_warning_count: 1,
      stale_file_size_count: 1,
      unavailable_file_size_count: 0,
    });
    const repo = new TenantDatabaseRegistryRepository(createAdapter({ queryOne }));

    await expect(repo.getStatsSummary('2026-05-15T00:00:00.000Z')).resolves.toEqual({
      active_tenant_core_databases: 3,
      stats_rows: 2,
      missing_stats_count: 1,
      stale_stats_count: 1,
      warning_count: 1,
      strong_warning_count: 1,
      stale_file_size_count: 1,
      unavailable_file_size_count: 0,
    });
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('LEFT JOIN tenant_database_stats'),
      ['2026-05-15T00:00:00.000Z']
    );
  });
});

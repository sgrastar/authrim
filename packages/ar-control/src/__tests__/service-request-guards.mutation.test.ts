import { describe, expect, it, vi } from 'vitest';
import { ControlService, writeMigrationMetadata } from '../service';
import type { ControlRepository } from '../repository';
import type { ControlEnv } from '../types';

const NOW = 1_800_000_123;
const READY_ENV = {
  AUTHRIM_AUTOMATIC_PROVISIONING: 'true',
  CLOUDFLARE_D1_API_TOKEN: 'd1',
  CLOUDFLARE_WORKERS_API_TOKEN: 'workers',
} as ControlEnv;
type Repo = Record<string, ReturnType<typeof vi.fn>>;

function build(repo: Repo, env: Partial<ControlEnv> = READY_ENV) {
  return new ControlService({
    repository: repo as unknown as ControlRepository,
    env: env as ControlEnv,
    now: () => NOW,
  });
}

const REQUEST = {
  environmentId: 'env-1',
  dataRole: 'tenant_core/users',
  residencyPolicyId: 'res-1',
  residencyPartition: 'jp',
  idempotencyKey: 'idem-1',
};
const PARTITION = {
  residency_policy_id: 'res-1',
  residency_partition: 'jp',
  lookup_capacity_domain_id: 'lookup:res-1:jp',
  jurisdiction: null,
  location_hint: 'apac',
};
const OPERATION = {
  operationId: 'op-1',
  environmentId: 'env-1',
  operationKind: 'provision_shard',
  status: 'succeeded',
  attemptCount: 1,
  nextAttemptAt: null,
  lastErrorCode: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function shardRepo(overrides: Repo = {}): Repo {
  return {
    getEnvironment: vi
      .fn()
      .mockResolvedValue({ environment_id: 'env-1', environment_name: 'test' }),
    getResidencyPartition: vi.fn().mockResolvedValue(PARTITION),
    getResourcePolicy: vi.fn().mockResolvedValue({ max_d1_resources: 10 }),
    getReadReplicationPolicy: vi.fn().mockResolvedValue(null),
    getTenantPlacementPolicy: vi.fn().mockResolvedValue(null),
    createShardPlan: vi.fn().mockResolvedValue(OPERATION),
    ...overrides,
  };
}

describe('tenant shard request validation', () => {
  const bad = async (input: unknown, code: string, repo: Repo = shardRepo()) => {
    await expect(build(repo).requestTenantShard(input, 'env-1')).rejects.toThrow(
      new RegExp(`^${code}$`, 'u')
    );
    expect(repo.createShardPlan).not.toHaveBeenCalled();
  };

  it.each([[null], [[]], ['x'], [5]])('rejects the non object %j', async (input) => {
    await bad(input, 'invalid_tenant_shard_request');
  });

  it('rejects a body environment that differs from the caller environment', async () => {
    await bad({ ...REQUEST, environmentId: 'env-2' }, 'invalid_environment_id');
  });

  it('rejects unknown, missing and lookup roles for tenant requests', async () => {
    await bad({ ...REQUEST, dataRole: 'other' }, 'invalid_data_role');
    await bad({ ...REQUEST, dataRole: 5 }, 'invalid_data_role');
    await bad({ ...REQUEST, dataRole: undefined }, 'invalid_data_role');
    await bad({ ...REQUEST, dataRole: 'lookup' }, 'invalid_data_role');
  });

  it('rejects unsafe identifiers by field', async () => {
    await bad({ ...REQUEST, residencyPolicyId: '' }, 'invalid_residency_policy_id');
    await bad({ ...REQUEST, residencyPartition: 'JP' }, 'invalid_residency_partition');
    await bad({ ...REQUEST, idempotencyKey: '-x' }, 'invalid_idempotency_key');
    await bad({ ...REQUEST, tenantId: '-x' }, 'invalid_tenant_id');
    await bad({ ...REQUEST, ownerTenantId: '-x' }, 'invalid_owner_tenant_id');
    await bad({ ...REQUEST, lookupCapacityDomainId: '-x' }, 'invalid_lookup_capacity_domain_id');
  });

  it('rejects inconsistent ownership combinations', async () => {
    const code = 'invalid_tenant_shard_owner';
    await bad({ ...REQUEST, allocationScope: 'other' }, code);
    await bad({ ...REQUEST, ownerTenantId: 'tenant-1' }, code);
    await bad({ ...REQUEST, allocationScope: 'tenant_exclusive' }, code);
    await bad({ ...REQUEST, allocationScope: 'tenant_exclusive', tenantId: 'tenant-1' }, code);
    await bad(
      {
        ...REQUEST,
        allocationScope: 'tenant_exclusive',
        tenantId: 'tenant-1',
        ownerTenantId: 'tenant-2',
      },
      code
    );
  });

  it('requires an exclusive placement policy that is not retired for exclusive requests', async () => {
    const exclusive = {
      ...REQUEST,
      allocationScope: 'tenant_exclusive',
      tenantId: 'tenant-1',
      ownerTenantId: 'tenant-1',
    };
    for (const policy of [
      null,
      { isolationPolicy: 'shared_pool', state: 'active' },
      { isolationPolicy: 'tenant_exclusive', state: 'retired' },
    ]) {
      await bad(
        exclusive,
        'control_tenant_placement_policy_missing',
        shardRepo({ getTenantPlacementPolicy: vi.fn().mockResolvedValue(policy) })
      );
    }
    const repo = shardRepo({
      getTenantPlacementPolicy: vi
        .fn()
        .mockResolvedValue({ isolationPolicy: 'tenant_exclusive', state: 'provisioning' }),
    });
    await expect(
      build(repo).requestTenantShard({ ...exclusive, dryRun: true }, 'env-1')
    ).resolves.toMatchObject({
      dryRun: true,
      operation: null,
    });
    expect(repo.getTenantPlacementPolicy).toHaveBeenCalledWith('env-1', 'tenant-1');
  });

  it('reports each missing prerequisite distinctly', async () => {
    await bad(
      REQUEST,
      'control_environment_not_found',
      shardRepo({ getEnvironment: vi.fn().mockResolvedValue(null) })
    );
    await bad(
      REQUEST,
      'control_residency_partition_not_found',
      shardRepo({ getResidencyPartition: vi.fn().mockResolvedValue(null) })
    );
    await bad(
      REQUEST,
      'control_resource_policy_not_found',
      shardRepo({ getResourcePolicy: vi.fn().mockResolvedValue(null) })
    );
  });

  it('rejects a lookup capacity domain on a tenant role or for another domain', async () => {
    await bad(
      { ...REQUEST, lookupCapacityDomainId: 'lookup:res-1:jp' },
      'control_lookup_capacity_domain_mismatch'
    );
    const service = build(shardRepo());
    await expect(
      service.requestLookupScaleOutCapacity(
        {
          residencyPolicyId: 'res-1',
          residencyPartition: 'jp',
          lookupCapacityDomainId: 'lookup:other:jp',
          idempotencyKey: 'idem-1',
        } as never,
        'env-1'
      )
    ).rejects.toThrow(/^control_lookup_capacity_domain_mismatch$/u);
  });
});

describe('tenant shard request persistence', () => {
  it('maps persistence failures to stable codes', async () => {
    const failing = (error: unknown) =>
      shardRepo({ createShardPlan: vi.fn().mockRejectedValue(error) });
    await expect(
      build(failing(new Error('x control_d1_resource_limit y'))).requestTenantShard(
        REQUEST,
        'env-1'
      )
    ).rejects.toThrow(/^control_d1_resource_limit$/u);
    await expect(
      build(failing(new Error('control_operation_idempotency_conflict'))).requestTenantShard(
        REQUEST,
        'env-1'
      )
    ).rejects.toThrow(/^control_operation_idempotency_conflict$/u);
    await expect(
      build(failing(new Error('control_operation_idempotency_conflict!'))).requestTenantShard(
        REQUEST,
        'env-1'
      )
    ).rejects.toThrow(/^control_persistence_failed$/u);
    await expect(build(failing('plain')).requestTenantShard(REQUEST, 'env-1')).rejects.toThrow(
      /^control_persistence_failed$/u
    );
  });

  it('hands queued work to the operator when automatic execution is unavailable', async () => {
    const markOperationAwaitingOperator = vi
      .fn()
      .mockResolvedValue({ ...OPERATION, status: 'blocked' });
    const repo = shardRepo({
      createShardPlan: vi.fn().mockResolvedValue({ ...OPERATION, status: 'queued' }),
      markOperationAwaitingOperator,
      getProvisioningAuthority: vi.fn().mockResolvedValue(null),
    });
    const result = await build(repo).requestTenantShard(REQUEST, 'env-1');
    expect(result.operation).toMatchObject({ status: 'blocked' });
    expect(markOperationAwaitingOperator).toHaveBeenCalledExactlyOnceWith(
      OPERATION.operationId,
      NOW
    );
    const waiting = shardRepo({
      createShardPlan: vi.fn().mockResolvedValue({ ...OPERATION, status: 'waiting_retry' }),
      markOperationAwaitingOperator,
      getProvisioningAuthority: vi.fn().mockResolvedValue(null),
    });
    await build(waiting).requestTenantShard(REQUEST, 'env-1');
    expect(markOperationAwaitingOperator).toHaveBeenCalledTimes(2);
  });

  it('refuses to strand queued work when no operator handoff exists', async () => {
    const repo = shardRepo({
      createShardPlan: vi.fn().mockResolvedValue({ ...OPERATION, status: 'queued' }),
      getProvisioningAuthority: vi.fn().mockResolvedValue(null),
    });
    await expect(build(repo).requestTenantShard(REQUEST, 'env-1')).rejects.toThrow(
      /^control_operator_executor_handoff_unavailable$/u
    );
  });

  it('returns finished and blocked operations without executing them', async () => {
    for (const status of ['succeeded', 'blocked', 'canceled', 'waiting_retry']) {
      const repo = shardRepo({
        createShardPlan: vi.fn().mockResolvedValue({ ...OPERATION, status }),
      });
      const result = await build(repo).requestTenantShard(REQUEST, 'env-1');
      expect(result).toMatchObject({ dryRun: false, operation: { status } });
    }
  });
});

describe('writeMigrationMetadata', () => {
  const plan = {
    bindingRef: 'DB_A',
    dataRole: 'tenant_core/users',
    residencyPartition: 'jp',
    migrationGeneration: 3,
    releaseId: 'rel-1',
    manifestDigest: 'sha256:x',
    databaseId: 'db-1',
  };
  const result = { totalFiles: 4, lastFilename: '0004.sql' };
  const reflected = {
    binding_ref: 'DB_A',
    data_role: 'tenant_core/users',
    residency_partition: 'jp',
    migration_generation: 3,
    release_id: 'rel-1',
    manifest_digest: 'sha256:x',
    expected_file_count: 4,
    last_filename: '0004.sql',
  };
  const ok = (row: unknown) => [{ success: true }, { success: true, results: [row] }];
  const write = (response: unknown, patch: Record<string, unknown> = {}) =>
    writeMigrationMetadata({} as ControlEnv, { ...plan, ...patch } as never, result, NOW, {
      queryD1Batch: vi.fn().mockResolvedValue(response),
    });

  it('accepts an exactly reflected row', async () => {
    await expect(write(ok(reflected))).resolves.toBeUndefined();
  });

  it('sends the upsert and the readback for the database with the exact parameters', async () => {
    const queryD1Batch = vi.fn().mockResolvedValue(ok(reflected));
    await writeMigrationMetadata({} as ControlEnv, plan as never, result, NOW, {
      queryD1Batch,
    });
    const [databaseId, statements] = queryD1Batch.mock.calls[0] as [
      string,
      { sql: string; params?: unknown[] }[],
    ];
    expect(databaseId).toBe('db-1');
    expect(statements).toHaveLength(2);
    expect(statements[0]?.params).toEqual([
      'DB_A',
      'tenant_core/users',
      'jp',
      3,
      'rel-1',
      'sha256:x',
      4,
      '0004.sql',
      NOW,
    ]);
    expect(statements[0]?.sql).toContain('authrim_control_plane_shard_metadata');
    expect(statements[1]?.params).toBeUndefined();
  });

  it.each([
    ['binding', { binding_ref: 'DB_B' }],
    ['role', { data_role: 'tenant_pii' }],
    ['partition', { residency_partition: 'us' }],
    ['generation', { migration_generation: 4 }],
    ['release', { release_id: 'rel-2' }],
    ['digest', { manifest_digest: 'sha256:y' }],
    ['count', { expected_file_count: 5 }],
    ['filename', { last_filename: '0005.sql' }],
    ['extra column', { extra: 1 }],
  ])('rejects a reflected row with a different %s', async (_name, patch) => {
    await expect(write(ok({ ...reflected, ...patch }))).rejects.toThrow(
      /^control_migration_metadata_write_failed$/u
    );
  });

  it('rejects missing, failed and short responses', async () => {
    const code = /^control_migration_metadata_write_failed$/u;
    await expect(write([{ success: true }, { success: true }])).rejects.toThrow(code);
    await expect(
      write([{ success: false }, { success: true, results: [reflected] }])
    ).rejects.toThrow(code);
    await expect(
      write([{ success: true }, { success: false, results: [reflected] }])
    ).rejects.toThrow(code);
    await expect(write([{ success: true }])).rejects.toThrow(code);
    await expect(
      write([{ success: true }, { success: true, results: [reflected] }, { success: true }])
    ).rejects.toThrow(code);
    const { binding_ref: _omitted, ...missing } = reflected;
    await expect(write(ok(missing))).rejects.toThrow(code);
  });

  describe('lookup shards', () => {
    const lookupPlan = { dataRole: 'lookup' };
    const lookupRow = { ...reflected, data_role: 'lookup' };
    const lookupOk = (value: unknown) => [
      { success: true },
      { success: true, results: [{ metadata_value: value }] },
    ];

    it('verifies the JSON metadata value', async () => {
      await expect(write(lookupOk(JSON.stringify(lookupRow)), lookupPlan)).resolves.toBeUndefined();
    });

    it('uses the lookup metadata table', async () => {
      const queryD1Batch = vi.fn().mockResolvedValue(lookupOk(JSON.stringify(lookupRow)));
      await writeMigrationMetadata(
        {} as ControlEnv,
        { ...plan, ...lookupPlan } as never,
        result,
        NOW,
        {
          queryD1Batch,
        }
      );
      const statements = queryD1Batch.mock.calls[0]?.[1] as { sql: string; params?: unknown[] }[];
      expect(statements[0]?.sql).toContain('lookup_schema_metadata');
      expect(statements[0]?.params?.[2]).toBe(NOW);
      expect(JSON.parse(statements[0]?.params?.[1] as string)).toEqual(lookupRow);
      expect(statements[1]?.params).toHaveLength(1);
    });

    it.each([['not json'], [5], [undefined], [JSON.stringify({ ...lookupRow, release_id: 'x' })]])(
      'rejects an unreadable or mismatching value %j',
      async (value) => {
        await expect(write(lookupOk(value), lookupPlan)).rejects.toThrow(
          /^control_migration_metadata_write_failed$/u
        );
      }
    );
  });
});

describe('requestAccountScaleOutCapacity', () => {
  const base = {
    environmentId: 'env-1',
    dataRole: 'tenant_core/users',
    residencyPolicyId: 'res-1',
    residencyPartition: 'jp',
    allocationScope: 'shared_pool',
    ownerTenantId: null,
    idempotencyKey: 'scale-1',
  };
  const call = (
    request: Record<string, unknown>,
    repo: Repo = shardRepo(),
    environment = 'env-1'
  ) => build(repo).requestAccountScaleOutCapacity(request as never, environment);

  it('plans shared capacity as the scheduler without executing it', async () => {
    const repo = shardRepo({
      createShardPlan: vi.fn().mockResolvedValue({ ...OPERATION, status: 'queued' }),
    });
    const result = await call(base, repo);
    expect(result).toMatchObject({ dryRun: false, operation: { status: 'queued' } });
    const [plan, now, requestedBy] = repo.createShardPlan.mock.calls[0] as [
      { allocationScope: string; ownerTenantId: string | null; idempotencyKey: string },
      number,
      string,
    ];
    expect(plan).toMatchObject({
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      idempotencyKey: 'scale-1',
    });
    expect(requestedBy).toBe('scheduler');
    expect(now).toBe(NOW);
    expect(repo.getTenantPlacementPolicy).not.toHaveBeenCalled();
  });

  it('plans exclusive capacity for the owning tenant after checking its policy', async () => {
    const repo = shardRepo({
      getTenantPlacementPolicy: vi
        .fn()
        .mockResolvedValue({ isolationPolicy: 'tenant_exclusive', state: 'active' }),
    });
    await call({ ...base, allocationScope: 'tenant_exclusive', ownerTenantId: 'tenant-1' }, repo);
    expect(repo.getTenantPlacementPolicy).toHaveBeenCalledWith('env-1', 'tenant-1');
    expect(repo.createShardPlan.mock.calls[0]?.[0]).toMatchObject({
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'tenant-1',
    });
  });

  it('refuses a request for another environment before reading anything', async () => {
    const repo = shardRepo();
    await expect(call({ ...base, environmentId: 'env-2' }, repo)).rejects.toThrow(
      /^account_scale_out_environment_mismatch$/u
    );
    expect(repo.getEnvironment).not.toHaveBeenCalled();
  });

  it('refuses an unsafe caller environment', async () => {
    await expect(call(base, shardRepo(), '-env')).rejects.toThrow(/^invalid_environment_id$/u);
  });

  it.each([
    ['shared scope with an owner', { allocationScope: 'shared_pool', ownerTenantId: 'tenant-1' }],
    [
      'exclusive scope without an owner',
      { allocationScope: 'tenant_exclusive', ownerTenantId: null },
    ],
  ])('refuses %s', async (_name, patch) => {
    const repo = shardRepo();
    await expect(call({ ...base, ...patch }, repo)).rejects.toThrow(
      /^account_scale_out_scope_invalid$/u
    );
    expect(repo.createShardPlan).not.toHaveBeenCalled();
  });

  it('refuses an unsafe owner tenant id', async () => {
    await expect(
      call({ ...base, allocationScope: 'tenant_exclusive', ownerTenantId: '-x' })
    ).rejects.toThrow(/^invalid_owner_tenant_id$/u);
  });
});

describe('writeMigrationMetadata response shape', () => {
  const plan = {
    bindingRef: 'DB_A',
    dataRole: 'tenant_core/users',
    residencyPartition: 'jp',
    migrationGeneration: 3,
    releaseId: 'rel-1',
    manifestDigest: 'sha256:x',
    databaseId: 'db-1',
  };
  const result = { totalFiles: 4, lastFilename: '0004.sql' };
  const reflected = {
    binding_ref: 'DB_A',
    data_role: 'tenant_core/users',
    residency_partition: 'jp',
    migration_generation: 3,
    release_id: 'rel-1',
    manifest_digest: 'sha256:x',
    expected_file_count: 4,
    last_filename: '0004.sql',
  };
  const write = (response: unknown, dataRole = 'tenant_core/users') =>
    writeMigrationMetadata({} as ControlEnv, { ...plan, dataRole } as never, result, NOW, {
      queryD1Batch: vi.fn().mockResolvedValue(response),
    });

  it('fails cleanly when a response entry is missing', async () => {
    await expect(write([null, { success: true, results: [reflected] }])).rejects.toThrow(
      /^control_migration_metadata_write_failed$/u
    );
    await expect(write([{ success: true }, null])).rejects.toThrow(
      /^control_migration_metadata_write_failed$/u
    );
  });

  it('rejects a reflected row that swaps a key for an unknown one', async () => {
    const { last_filename: _dropped, ...rest } = reflected;
    await expect(
      write([
        { success: true },
        { success: true, results: [{ ...rest, unknown_column: '0004.sql' }] },
      ])
    ).rejects.toThrow(/^control_migration_metadata_write_failed$/u);
  });

  it('reads the metadata back with the exact statements', async () => {
    const queryD1Batch = vi
      .fn()
      .mockResolvedValue([{ success: true }, { success: true, results: [reflected] }]);
    await writeMigrationMetadata({} as ControlEnv, plan as never, result, NOW, {
      queryD1Batch,
    });
    const statements = queryD1Batch.mock.calls[0]?.[1] as { sql: string }[];
    expect(statements[1]?.sql.replace(/\s+/gu, ' ').trim()).toBe(
      'SELECT binding_ref, data_role, residency_partition, migration_generation, release_id, manifest_digest, expected_file_count, last_filename FROM authrim_control_plane_shard_metadata WHERE singleton_id = 1'
    );
    const lookup = vi.fn().mockResolvedValue([
      { success: true },
      {
        success: true,
        results: [{ metadata_value: JSON.stringify({ ...reflected, data_role: 'lookup' }) }],
      },
    ]);
    await writeMigrationMetadata(
      {} as ControlEnv,
      { ...plan, dataRole: 'lookup' } as never,
      result,
      NOW,
      {
        queryD1Batch: lookup,
      }
    );
    const lookupStatements = lookup.mock.calls[0]?.[1] as { sql: string }[];
    expect(lookupStatements[1]?.sql.replace(/\s+/gu, ' ').trim()).toBe(
      'SELECT metadata_value FROM lookup_schema_metadata WHERE metadata_key = ?'
    );
    expect(lookupStatements[0]?.sql.replace(/\s+/gu, ' ').trim()).toBe(
      'INSERT INTO lookup_schema_metadata (metadata_key, metadata_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(metadata_key) DO UPDATE SET metadata_value = excluded.metadata_value, updated_at = excluded.updated_at'
    );
  });
});

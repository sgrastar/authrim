import { describe, expect, it, vi } from 'vitest';
import { ControlService } from '../service';
import type { ControlRepository } from '../repository';
import type { ControlEnv } from '../types';

const NOW = 1_800_000_123;
type Repo = Record<string, ReturnType<typeof vi.fn>>;
const REQUEST = { tenantId: 'tenant-1', operationId: 'delete-1' };

const shard = (role: string, id: string, binding: string, extra: Record<string, unknown> = {}) => ({
  shardId: id,
  dataRole: role,
  residencyPolicyId: 'res-1',
  residencyPartition: 'jp',
  bindingRef: binding,
  status: 'active',
  allocationScope: 'shared_pool',
  ownerTenantId: null,
  ...extra,
});
const SHARDS = [
  shard('tenant_core/default', 'shard-a', 'DB_A'),
  shard('tenant_core/users', 'shard-b', 'DB_B'),
  shard('tenant_pii', 'shard-c', 'DB_C'),
];
const LOOKUPS = [{ lookupShardId: 'lookup-a', bindingRef: 'LOOKUP_A', status: 'active' }];

function repo(overrides: Repo = {}): Repo {
  return {
    getTenantDeletionFinalization: vi.fn().mockResolvedValue(null),
    getTenantPlacementPolicy: vi
      .fn()
      .mockResolvedValue({ tenantId: 'tenant-1', isolationPolicy: 'shared_pool', state: 'active' }),
    listTenantDeletionLookupShards: vi.fn().mockResolvedValue(LOOKUPS),
    listTenantDeletionShards: vi.fn().mockResolvedValue(SHARDS),
    finalizeTenantDeletionControlState: vi
      .fn()
      .mockResolvedValue({ state: 'finalized', finalizedAt: NOW }),
    ...overrides,
  };
}
const svc = (repository: Repo) =>
  new ControlService({
    repository: repository as unknown as ControlRepository,
    env: {} as ControlEnv,
    now: () => NOW,
  });
const inventory = (repository: Repo, input: unknown = REQUEST) =>
  svc(repository).getTenantDeletionInventory(input, 'env-1');

describe('getTenantDeletionInventory', () => {
  it('returns the ready inventory with the exact lists and queries', async () => {
    const repository = repo();
    await expect(inventory(repository)).resolves.toEqual({
      environmentId: 'env-1',
      tenantId: 'tenant-1',
      operationId: 'delete-1',
      state: 'ready',
      lookupShards: LOOKUPS,
      tenantShards: SHARDS,
    });
    expect(repository.getTenantDeletionFinalization).toHaveBeenCalledExactlyOnceWith({
      environmentId: 'env-1',
      ...REQUEST,
    });
    expect(repository.listTenantDeletionLookupShards).toHaveBeenCalledExactlyOnceWith('env-1');
    expect(repository.listTenantDeletionShards).toHaveBeenCalledExactlyOnceWith({
      environmentId: 'env-1',
      tenantId: 'tenant-1',
    });
  });

  it('reports a finalized deletion without reading shard lists', async () => {
    const repository = repo({
      getTenantDeletionFinalization: vi.fn().mockResolvedValue({ state: 'finalized' }),
    });
    await expect(inventory(repository)).resolves.toEqual({
      environmentId: 'env-1',
      ...REQUEST,
      state: 'finalized',
      lookupShards: [],
      tenantShards: [],
    });
    expect(repository.getTenantPlacementPolicy).not.toHaveBeenCalled();
    expect(repository.listTenantDeletionShards).not.toHaveBeenCalled();
  });

  it.each([['active'], ['migrating']])('accepts a %s placement policy', async (state) => {
    const repository = repo({
      getTenantPlacementPolicy: vi
        .fn()
        .mockResolvedValue({ tenantId: 'tenant-1', isolationPolicy: 'shared_pool', state }),
    });
    await expect(inventory(repository)).resolves.toMatchObject({ state: 'ready' });
  });

  it.each([
    [null],
    [{ isolationPolicy: 'shared_pool', state: 'provisioning' }],
    [{ isolationPolicy: 'shared_pool', state: 'retired' }],
  ])('refuses an unavailable placement policy %j', async (policy) => {
    const repository = repo({ getTenantPlacementPolicy: vi.fn().mockResolvedValue(policy) });
    await expect(inventory(repository)).rejects.toThrow(
      /^control_tenant_deletion_policy_unavailable$/u
    );
    expect(repository.listTenantDeletionShards).not.toHaveBeenCalled();
  });

  it.each([['ready'], ['active'], ['degraded']])('accepts a %s tenant shard', async (status) => {
    const shards = [
      shard('tenant_core/default', 'shard-a', 'DB_A', { status }),
      SHARDS[1],
      SHARDS[2],
    ];
    await expect(
      inventory(repo({ listTenantDeletionShards: vi.fn().mockResolvedValue(shards) }))
    ).resolves.toMatchObject({ state: 'ready' });
  });

  it.each([['ready'], ['active'], ['draining']])('accepts a %s lookup shard', async (status) => {
    const lookups = [{ lookupShardId: 'lookup-a', bindingRef: 'LOOKUP_A', status }];
    await expect(
      inventory(repo({ listTenantDeletionLookupShards: vi.fn().mockResolvedValue(lookups) }))
    ).resolves.toMatchObject({ state: 'ready' });
  });

  const invalidShard = (extra: Record<string, unknown>) => [
    shard('tenant_core/default', 'shard-a', 'DB_A', extra),
    SHARDS[1],
    SHARDS[2],
  ];
  it.each([
    ['a retired shard', invalidShard({ status: 'retired' })],
    ['an unsafe shard id', invalidShard({ shardId: '-a' })],
    ['an unsafe residency policy', invalidShard({ residencyPolicyId: '' })],
    ['an unsafe partition', invalidShard({ residencyPartition: 'JP' })],
    ['an unsafe binding', invalidShard({ bindingRef: 'lower' })],
    ['a duplicate shard id', [SHARDS[0], { ...SHARDS[1], shardId: 'shard-a' }, SHARDS[2]]],
    ['a duplicate binding', [SHARDS[0], { ...SHARDS[1], bindingRef: 'DB_A' }, SHARDS[2]]],
    [
      'an exclusive shard under a shared policy',
      invalidShard({ allocationScope: 'tenant_exclusive', ownerTenantId: 'tenant-1' }),
    ],
    ['an owned shard under a shared policy', invalidShard({ ownerTenantId: 'tenant-1' })],
  ])('rejects %s', async (_name, shards) => {
    await expect(
      inventory(repo({ listTenantDeletionShards: vi.fn().mockResolvedValue(shards) }))
    ).rejects.toThrow(/^control_tenant_deletion_inventory_invalid$/u);
  });

  it('validates exclusive ownership against the deleted tenant', async () => {
    const exclusive = (owner: string | null) =>
      SHARDS.map((entry) => ({
        ...entry,
        allocationScope: 'tenant_exclusive',
        ownerTenantId: owner,
      }));
    const policy = vi.fn().mockResolvedValue({
      tenantId: 'tenant-1',
      isolationPolicy: 'tenant_exclusive',
      state: 'active',
    });
    await expect(
      inventory(
        repo({
          getTenantPlacementPolicy: policy,
          listTenantDeletionShards: vi.fn().mockResolvedValue(exclusive('tenant-1')),
        })
      )
    ).resolves.toMatchObject({ state: 'ready' });
    for (const owner of ['tenant-2', null]) {
      await expect(
        inventory(
          repo({
            getTenantPlacementPolicy: policy,
            listTenantDeletionShards: vi.fn().mockResolvedValue(exclusive(owner)),
          })
        )
      ).rejects.toThrow(/^control_tenant_deletion_inventory_invalid$/u);
    }
  });

  it.each([
    [
      'a retired lookup shard',
      [{ lookupShardId: 'lookup-a', bindingRef: 'LOOKUP_A', status: 'retired' }],
    ],
    ['an unsafe lookup id', [{ lookupShardId: '-', bindingRef: 'LOOKUP_A', status: 'active' }]],
    [
      'an unsafe lookup binding',
      [{ lookupShardId: 'lookup-a', bindingRef: 'lookup_a', status: 'active' }],
    ],
    [
      'a duplicate lookup id',
      [LOOKUPS[0], { lookupShardId: 'lookup-a', bindingRef: 'LOOKUP_B', status: 'active' }],
    ],
    [
      'a duplicate lookup binding',
      [LOOKUPS[0], { lookupShardId: 'lookup-b', bindingRef: 'LOOKUP_A', status: 'active' }],
    ],
    [
      'a lookup binding shared with a tenant shard',
      [{ lookupShardId: 'lookup-a', bindingRef: 'DB_A', status: 'active' }],
    ],
  ])('rejects %s', async (_name, lookups) => {
    await expect(
      inventory(repo({ listTenantDeletionLookupShards: vi.fn().mockResolvedValue(lookups) }))
    ).rejects.toThrow(/^control_tenant_deletion_inventory_invalid$/u);
  });

  it.each([
    ['no lookup shards', { listTenantDeletionLookupShards: vi.fn().mockResolvedValue([]) }],
    ['no tenant shards', { listTenantDeletionShards: vi.fn().mockResolvedValue([]) }],
    [
      'no default shard',
      { listTenantDeletionShards: vi.fn().mockResolvedValue([SHARDS[1], SHARDS[2]]) },
    ],
    [
      'no users shard',
      { listTenantDeletionShards: vi.fn().mockResolvedValue([SHARDS[0], SHARDS[2]]) },
    ],
    [
      'no pii shard',
      { listTenantDeletionShards: vi.fn().mockResolvedValue([SHARDS[0], SHARDS[1]]) },
    ],
  ])('refuses an incomplete inventory with %s', async (_name, overrides) => {
    await expect(inventory(repo(overrides))).rejects.toThrow(
      /^control_tenant_deletion_inventory_incomplete$/u
    );
  });

  it.each([
    [null],
    [[]],
    ['x'],
    [{ tenantId: 'tenant-1' }],
    [{ ...REQUEST, extra: 1 }],
    [{ tenantId: 'tenant-1', other: 'delete-1' }],
  ])('rejects the malformed request %j', async (input) => {
    const repository = repo();
    await expect(inventory(repository, input)).rejects.toThrow(
      /^invalid_tenant_deletion_request$/u
    );
    expect(repository.getTenantDeletionFinalization).not.toHaveBeenCalled();
  });

  it.each([
    [{ tenantId: '-x', operationId: 'delete-1' }, 'invalid_tenant_id'],
    [{ tenantId: 'tenant-1', operationId: '' }, 'invalid_operation_id'],
  ])('rejects an unsafe identifier in %j', async (input, code) => {
    await expect(inventory(repo(), input)).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });

  it('refuses secret material in the result', async () => {
    const repository = repo({
      listTenantDeletionLookupShards: vi
        .fn()
        .mockResolvedValue([
          { lookupShardId: 'lookup-a', bindingRef: 'LOOKUP_A', status: 'active', private_key: 'x' },
        ]),
    });
    await expect(inventory(repository)).rejects.toThrow(/control_plane_sensitive_key_forbidden/u);
  });
});

describe('finalizeTenantDeletionControlState', () => {
  const finalize = (repository: Repo, input: unknown = REQUEST) =>
    svc(repository).finalizeTenantDeletionControlState(input, 'env-1');

  it('finalizes a ready inventory at the current time', async () => {
    const repository = repo();
    await expect(finalize(repository)).resolves.toEqual({ state: 'finalized', finalizedAt: NOW });
    expect(repository.finalizeTenantDeletionControlState).toHaveBeenCalledExactlyOnceWith(
      { environmentId: 'env-1', ...REQUEST },
      NOW
    );
  });

  it('returns an existing finalization without recomputing the inventory', async () => {
    const existing = { state: 'finalized', finalizedAt: 5 };
    const repository = repo({ getTenantDeletionFinalization: vi.fn().mockResolvedValue(existing) });
    await expect(finalize(repository)).resolves.toBe(existing);
    expect(repository.finalizeTenantDeletionControlState).not.toHaveBeenCalled();
    expect(repository.listTenantDeletionShards).not.toHaveBeenCalled();
  });

  it('refuses when the inventory is no longer ready', async () => {
    const repository = repo({
      getTenantDeletionFinalization: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ state: 'finalized' }),
    });
    await expect(finalize(repository)).rejects.toThrow(
      /^control_tenant_deletion_inventory_unavailable$/u
    );
    expect(repository.finalizeTenantDeletionControlState).not.toHaveBeenCalled();
  });

  it('propagates inventory problems before writing', async () => {
    const repository = repo({ listTenantDeletionShards: vi.fn().mockResolvedValue([]) });
    await expect(finalize(repository)).rejects.toThrow(
      /^control_tenant_deletion_inventory_incomplete$/u
    );
    expect(repository.finalizeTenantDeletionControlState).not.toHaveBeenCalled();
    await expect(finalize(repo(), null)).rejects.toThrow(/^invalid_tenant_deletion_request$/u);
  });

  it('refuses a finalization result carrying secret material', async () => {
    const repository = repo({
      finalizeTenantDeletionControlState: vi.fn().mockResolvedValue({ private_key: 'x' }),
    });
    await expect(finalize(repository)).rejects.toThrow(/control_plane_sensitive_key_forbidden/u);
  });
});

describe('getOperation', () => {
  it('reads by operation id with the optional environment', async () => {
    const getOperation = vi.fn().mockResolvedValue({ operationId: 'op-1' });
    const service = svc({ getOperation });
    await service.getOperation('op-1');
    await service.getOperation('op-1', 'env-1');
    expect(getOperation.mock.calls).toEqual([
      ['op-1', undefined],
      ['op-1', 'env-1'],
    ]);
    expect(() => service.getOperation('-bad')).toThrow(/^invalid_operation_id$/u);
    expect(() => service.getOperation('op-1', '-env')).toThrow(/^invalid_environment_id$/u);
    expect(() => service.getOperation(5)).toThrow(/^invalid_operation_id$/u);
  });
});

describe('region shard policy for active placement', () => {
  it('accepts an active placement policy for the provisioning view', async () => {
    const targets = [
      {
        shardId: 'shard-a',
        dataRole: 'tenant_core/default',
        residencyPolicyId: 'res-1',
        residencyPartition: 'jp',
        routeGeneration: 1,
        bindingRef: 'DB_A',
        databaseId: 'a',
        databaseName: 'a',
        allocationScope: 'shared_pool',
        ownerTenantId: null,
        assignmentGeneration: 1,
      },
      {
        shardId: 'shard-b',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'res-1',
        residencyPartition: 'jp',
        routeGeneration: 1,
        bindingRef: 'DB_B',
        databaseId: 'b',
        databaseName: 'b',
        allocationScope: 'shared_pool',
        ownerTenantId: null,
        assignmentGeneration: 1,
      },
      {
        shardId: 'shard-c',
        dataRole: 'tenant_pii',
        residencyPolicyId: 'res-1',
        residencyPartition: 'jp',
        routeGeneration: 1,
        bindingRef: 'DB_C',
        databaseId: 'c',
        databaseName: 'c',
        allocationScope: 'shared_pool',
        ownerTenantId: null,
        assignmentGeneration: 1,
      },
    ];
    const service = svc({
      getTenantPlacementPolicy: vi.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        isolationPolicy: 'shared_pool',
        state: 'active',
        policyGeneration: 6,
      }),
      listActiveTenantShardTargets: vi.fn().mockResolvedValue(targets),
      getResidencyPartition: vi
        .fn()
        .mockResolvedValue({ jurisdiction: null, location_hint: 'apac' }),
    });
    await expect(
      service.getTenantProvisioningRegionShardPolicy(
        { tenantId: 'tenant-1', residencyPolicyId: 'res-1', residencyPartition: 'jp' },
        'env-1'
      )
    ).resolves.toMatchObject({ policyGeneration: 6, allowedRegions: ['apac'] });
  });
});

describe('derived names', () => {
  const planner = (tenantId: string) => ({
    scope: 'tenant_exclusive',
    tenantId,
    currentEnvironmentD1Count: 1,
    environmentD1Limit: 100,
    targets: [
      {
        unitKey: 'unit',
        priority: 1,
        readyUnits: 0,
        inFlightUnits: 0,
        minimumRequiredUnits: 1,
        recommendedTargetUnits: 1,
        hardMaximumUnits: 5,
        resources: [
          {
            resourceClass: 'd1',
            dataRole: 'tenant_core/users',
            residencyPolicyId: 'res-1',
            residencyPartition: 'jp',
            workerScripts: ['w'],
            d1Count: 1,
          },
        ],
      },
    ],
  });
  const slugOf = async (tenantId: string) => {
    const service = svc({
      getCapacityPlannerInput: vi.fn().mockResolvedValue(planner(tenantId)),
      getEnvironment: vi
        .fn()
        .mockResolvedValue({ environment_id: 'env-1', environment_name: 'test' }),
      getResidencyPartition: vi.fn().mockResolvedValue({
        residency_policy_id: 'res-1',
        residency_partition: 'jp',
        lookup_capacity_domain_id: 'x',
        jurisdiction: null,
        location_hint: null,
      }),
      getReadReplicationPolicy: vi.fn().mockResolvedValue(null),
    });
    const preview = await service.previewCapacityProvisioning(
      { profile: 'minimum', scope: 'tenant_exclusive', tenantId },
      'env-1'
    );
    const name = preview.targets[0]?.databaseName ?? '';
    return /-jp-(.*)-db-[0-9a-f]{8}$/u.exec(name)?.[1];
  };

  it.each([
    ['Tenant_One-2', 'tenant-one-2'],
    ['a__b', 'a-b'],
    ['a.b:c', 'a-b-c'],
    ['a--b', 'a--b'],
    ['abc-', 'abc'],
    ['abc_', 'abc'],
    ['abc.', 'abc'],
    ['ABC', 'abc'],
    ['z9', 'z9'],
    ['a0', 'a0'],
    ['0a', '0a'],
    ['9z', '9z'],
    ['x'.repeat(30), 'x'.repeat(24)],
    [`${'x'.repeat(23)}-yy`, 'x'.repeat(23)],
    [`${'x'.repeat(22)}_y_z`, `${'x'.repeat(22)}-y`],
    [`${'x'.repeat(22)}-yy`, `${'x'.repeat(22)}-y`],
  ])('slugifies the tenant %s as %s', async (tenantId, expected) => {
    await expect(slugOf(tenantId)).resolves.toBe(expected);
  });
});

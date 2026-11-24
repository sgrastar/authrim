import { describe, expect, it, vi } from 'vitest';
import { ControlService } from '../service';
import type { ControlRepository } from '../repository';
import type { ControlEnv } from '../types';

const NOW = 1_800_000_123;
type Repo = Record<string, ReturnType<typeof vi.fn>>;

const REQUEST = {
  tenantId: 'tenant-1',
  dataRole: 'tenant_core/users',
  residencyPolicyId: 'res-1',
  residencyPartition: 'jp',
  idempotencyKey: 'idem-1',
};
const SHARED_SCOPE = {
  environmentId: 'env-1',
  tenantId: 'tenant-1',
  dataRole: 'tenant_core/users',
  residencyPolicyId: 'res-1',
  residencyPartition: 'jp',
  allocationScope: 'shared_pool',
  ownerTenantId: null,
};
const TARGET = { shardId: 'shard-a', bindingRef: 'DB_A' };
const OPERATION = {
  operationId: 'op-1',
  environmentId: 'env-1',
  operationKind: 'provision_shard',
  status: 'running',
  attemptCount: 2,
  nextAttemptAt: 99,
  lastErrorCode: 'some_code',
  createdAt: 10,
  updatedAt: 20,
};
const SUMMARY = {
  operationId: 'op-1',
  status: 'running',
  attemptCount: 2,
  nextAttemptAt: 99,
  lastErrorCode: 'some_code',
  createdAt: 10,
  updatedAt: 20,
};

function repo(overrides: Repo = {}): Repo {
  return {
    getTenantPlacementPolicy: vi
      .fn()
      .mockResolvedValue({ tenantId: 'tenant-1', isolationPolicy: 'shared_pool', state: 'active' }),
    findEligibleTenantShard: vi.fn().mockResolvedValue(null),
    hasTenantShardAssignment: vi.fn().mockResolvedValue(false),
    findAssignableTenantShard: vi.fn().mockResolvedValue(null),
    assignTenantShard: vi.fn().mockResolvedValue(TARGET),
    findCapacityProvisioningOperation: vi.fn().mockResolvedValue(null),
    getActiveTenantShardSupplyCount: vi.fn().mockResolvedValue(3),
    getEnvironment: vi
      .fn()
      .mockResolvedValue({ environment_id: 'env-1', environment_name: 'test' }),
    getResidencyPartition: vi.fn().mockResolvedValue({
      residency_policy_id: 'res-1',
      residency_partition: 'jp',
      lookup_capacity_domain_id: 'lookup:res-1:jp',
      jurisdiction: null,
      location_hint: null,
    }),
    getResourcePolicy: vi.fn().mockResolvedValue({ max_d1_resources: 10 }),
    getReadReplicationPolicy: vi.fn().mockResolvedValue(null),
    createShardPlan: vi.fn().mockResolvedValue({ ...OPERATION, status: 'queued' }),
    ...overrides,
  };
}

function ensure(repository: Repo, input: unknown = REQUEST) {
  return new ControlService({
    repository: repository as unknown as ControlRepository,
    env: {} as ControlEnv,
    now: () => NOW,
  }).ensureTenantShardCapacity(input, 'env-1');
}

describe('ensureTenantShardCapacity: existing capacity', () => {
  it('returns an eligible shard without touching anything else', async () => {
    const repository = repo({ findEligibleTenantShard: vi.fn().mockResolvedValue(TARGET) });
    await expect(ensure(repository)).resolves.toEqual({
      state: 'ready',
      target: TARGET,
      operation: null,
    });
    expect(repository.findEligibleTenantShard).toHaveBeenCalledExactlyOnceWith(SHARED_SCOPE);
    expect(repository.getTenantPlacementPolicy).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      'tenant-1'
    );
    expect(repository.assignTenantShard).not.toHaveBeenCalled();
    expect(repository.createShardPlan).not.toHaveBeenCalled();
  });

  it('scopes exclusive tenants to their own shards', async () => {
    const repository = repo({
      getTenantPlacementPolicy: vi.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        isolationPolicy: 'tenant_exclusive',
        state: 'migrating',
      }),
      findEligibleTenantShard: vi.fn().mockResolvedValue(TARGET),
    });
    await ensure(repository);
    expect(repository.findEligibleTenantShard).toHaveBeenCalledWith({
      ...SHARED_SCOPE,
      allocationScope: 'tenant_exclusive',
      ownerTenantId: 'tenant-1',
    });
  });

  it.each([['provisioning'], ['active'], ['migrating']])(
    'accepts a %s placement policy',
    async (state) => {
      const repository = repo({
        getTenantPlacementPolicy: vi
          .fn()
          .mockResolvedValue({ tenantId: 'tenant-1', isolationPolicy: 'shared_pool', state }),
        findEligibleTenantShard: vi.fn().mockResolvedValue(TARGET),
      });
      await expect(ensure(repository)).resolves.toMatchObject({ state: 'ready' });
    }
  );

  it.each([[null], [{ tenantId: 'tenant-1', isolationPolicy: 'shared_pool', state: 'retired' }]])(
    'rejects a missing or retired placement policy %j',
    async (policy) => {
      const repository = repo({ getTenantPlacementPolicy: vi.fn().mockResolvedValue(policy) });
      await expect(ensure(repository)).rejects.toThrow(
        /^control_tenant_placement_policy_missing$/u
      );
      expect(repository.findEligibleTenantShard).not.toHaveBeenCalled();
    }
  );

  it('blocks a default shard request when an assignment already exists', async () => {
    const repository = repo({ hasTenantShardAssignment: vi.fn().mockResolvedValue(true) });
    const input = { ...REQUEST, dataRole: 'tenant_core/default' };
    await expect(ensure(repository, input)).resolves.toEqual({
      state: 'blocked',
      target: null,
      operation: null,
      reasonCode: 'control_tenant_default_assignment_unavailable',
    });
    expect(repository.hasTenantShardAssignment).toHaveBeenCalledExactlyOnceWith({
      ...SHARED_SCOPE,
      dataRole: 'tenant_core/default',
    });
    expect(repository.findAssignableTenantShard).not.toHaveBeenCalled();
  });

  it('only checks existing assignments for the default role', async () => {
    const repository = repo({
      findAssignableTenantShard: vi.fn().mockResolvedValue({ shardId: 'shard-a' }),
    });
    await ensure(repository);
    expect(repository.hasTenantShardAssignment).not.toHaveBeenCalled();
  });

  it('assigns an available shard using the request idempotency key', async () => {
    const repository = repo({
      findAssignableTenantShard: vi.fn().mockResolvedValue({ shardId: 'shard-a' }),
    });
    await expect(ensure(repository)).resolves.toEqual({
      state: 'ready',
      target: TARGET,
      operation: null,
    });
    expect(repository.assignTenantShard).toHaveBeenCalledExactlyOnceWith(
      {
        environmentId: 'env-1',
        tenantId: 'tenant-1',
        dataRole: 'tenant_core/users',
        residencyPolicyId: 'res-1',
        residencyPartition: 'jp',
        shardId: 'shard-a',
        sourceOperationId: 'idem-1',
      },
      NOW
    );
    expect(repository.findAssignableTenantShard).toHaveBeenCalledExactlyOnceWith(SHARED_SCOPE);
    expect(repository.createShardPlan).not.toHaveBeenCalled();
  });
});

describe('ensureTenantShardCapacity: provisioning', () => {
  it('reuses an in-flight operation instead of planning another shard', async () => {
    const repository = repo({
      findCapacityProvisioningOperation: vi.fn().mockResolvedValue(OPERATION),
    });
    await expect(ensure(repository)).resolves.toEqual({
      state: 'provisioning',
      target: null,
      operation: SUMMARY,
    });
    expect(repository.findCapacityProvisioningOperation).toHaveBeenCalledExactlyOnceWith(
      SHARED_SCOPE
    );
    expect(repository.getActiveTenantShardSupplyCount).not.toHaveBeenCalled();
    expect(repository.createShardPlan).not.toHaveBeenCalled();
  });

  it('plans a new shard with a supply count derived idempotency key', async () => {
    const repository = repo({
      createShardPlan: vi.fn().mockResolvedValue({ ...OPERATION, status: 'queued' }),
    });
    const result = await ensure(repository);
    expect(result).toMatchObject({
      state: 'provisioning',
      target: null,
      operation: { status: 'queued' },
    });
    expect(repository.getActiveTenantShardSupplyCount).toHaveBeenCalledExactlyOnceWith(
      SHARED_SCOPE
    );
    const [plan, now, requestedBy] = repository.createShardPlan.mock.calls[0] as [
      { idempotencyKey: string; dataRole: string; environmentId: string },
      number,
      string,
    ];
    expect(plan.idempotencyKey).toMatch(
      /^low-water:shared_pool:tenant-core-users:3:[0-9a-f]{24}$/u
    );
    expect(plan.dataRole).toBe('tenant_core/users');
    expect(now).toBe(NOW);
    expect(requestedBy).toBe('scheduler');
  });

  it('derives different keys for different supply counts and owners but ignores the caller key', async () => {
    const keyFor = async (supply: number, input: unknown = REQUEST, overrides: Repo = {}) => {
      const repository = repo({
        getActiveTenantShardSupplyCount: vi.fn().mockResolvedValue(supply),
        ...overrides,
      });
      await ensure(repository, input);
      return (repository.createShardPlan.mock.calls[0]?.[0] as { idempotencyKey: string })
        .idempotencyKey;
    };
    const three = await keyFor(3);
    expect(await keyFor(3, { ...REQUEST, idempotencyKey: 'other-key' })).toBe(three);
    expect(await keyFor(4)).not.toBe(three);
    expect(three.split(':')[3]).toBe('3');
    const exclusive = await keyFor(3, REQUEST, {
      getTenantPlacementPolicy: vi.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        isolationPolicy: 'tenant_exclusive',
        state: 'active',
      }),
    });
    expect(exclusive).toMatch(/^low-water:tenant_exclusive:tenant-core-users:3:/u);
    expect(exclusive.split(':')[4]).not.toBe(three.split(':')[4]);
    expect(await keyFor(3, { ...REQUEST, dataRole: 'tenant_pii' })).toMatch(
      /^low-water:shared_pool:tenant-pii:3:/u
    );
  });

  it.each([
    ['queued', 'provisioning'],
    ['running', 'provisioning'],
    ['waiting_retry', 'provisioning'],
    ['canceled', 'provisioning'],
  ])('reports a %s operation as %s', async (status, state) => {
    const repository = repo({
      findCapacityProvisioningOperation: vi.fn().mockResolvedValue({ ...OPERATION, status }),
    });
    await expect(ensure(repository)).resolves.toMatchObject({
      state,
      target: null,
      operation: { status },
    });
  });

  it('reports a blocked operation with its error code or a default', async () => {
    for (const [code, expected] of [
      ['control_d1_resource_limit', 'control_d1_resource_limit'],
      [null, 'control_capacity_blocked'],
    ] as const) {
      const repository = repo({
        findCapacityProvisioningOperation: vi
          .fn()
          .mockResolvedValue({ ...OPERATION, status: 'blocked', lastErrorCode: code }),
      });
      await expect(ensure(repository)).resolves.toEqual({
        state: 'blocked',
        target: null,
        operation: { ...SUMMARY, status: 'blocked', lastErrorCode: code },
        reasonCode: expected,
      });
    }
  });

  it('rejects an operation with an unknown status', async () => {
    const repository = repo({
      findCapacityProvisioningOperation: vi
        .fn()
        .mockResolvedValue({ ...OPERATION, status: 'exploded' }),
    });
    await expect(ensure(repository)).rejects.toThrow(/^control_operation_status_invalid$/u);
  });

  it('assigns the shard once the operation has succeeded', async () => {
    const assignable = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ shardId: 'shard-new' });
    const repository = repo({
      findAssignableTenantShard: assignable,
      findCapacityProvisioningOperation: vi
        .fn()
        .mockResolvedValue({ ...OPERATION, status: 'succeeded' }),
    });
    await expect(ensure(repository)).resolves.toEqual({
      state: 'ready',
      target: TARGET,
      operation: { ...SUMMARY, status: 'succeeded' },
    });
    expect(assignable).toHaveBeenCalledTimes(2);
    expect(repository.assignTenantShard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shardId: 'shard-new', sourceOperationId: 'op-1' }),
      NOW
    );
  });

  it('fails when a succeeded operation produced no assignable shard', async () => {
    const repository = repo({
      findCapacityProvisioningOperation: vi
        .fn()
        .mockResolvedValue({ ...OPERATION, status: 'succeeded' }),
    });
    await expect(ensure(repository)).rejects.toThrow(/^control_capacity_reflection_failed$/u);
    expect(repository.assignTenantShard).not.toHaveBeenCalled();
  });
});

describe('ensureTenantShardCapacity: request validation', () => {
  it.each([
    [null],
    [[]],
    ['x'],
    [{ ...REQUEST, extra: 1 }],
    [{ tenantId: 'tenant-1' }],
    [{ ...REQUEST, dataRole: 'lookup' }],
    [{ ...REQUEST, dataRole: 'other' }],
    [{ ...REQUEST, tenantId: '-x' }],
    [{ ...REQUEST, residencyPolicyId: '' }],
    [{ ...REQUEST, residencyPartition: 'JP' }],
    [{ ...REQUEST, idempotencyKey: '' }],
  ])('rejects %j before reading any state', async (input) => {
    const repository = repo();
    await expect(ensure(repository, input)).rejects.toThrow(/^invalid_/u);
    expect(repository.getTenantPlacementPolicy).not.toHaveBeenCalled();
  });
});

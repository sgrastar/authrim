import { describe, expect, it } from 'vitest';
import { D1ControlRepository } from '../repository';

type Row = Record<string, unknown>;

function repositoryReturning(rows: Row[]): D1ControlRepository {
  const statement = {
    bind: () => statement,
    first: async () => rows[0] ?? null,
    all: async () => ({ results: rows, success: true, meta: {} }),
  };
  return new D1ControlRepository({ prepare: () => statement } as unknown as D1Database);
}

const base: Row = {
  shard_id: 'shard-a',
  data_role: 'tenant_core/default',
  residency_policy_id: 'default',
  residency_partition: 'jp',
  generation: 3,
  binding_ref: 'TDB_A',
  provider_resource_id: 'db-a',
  deterministic_name: 'name-a',
  allocation_scope: 'shared_pool',
  owner_tenant_id: null,
  assignment_generation: 5,
};

const eligibleInput = {
  environmentId: 'env-test',
  tenantId: 'tenant-a',
  dataRole: 'tenant_core/default' as const,
  residencyPolicyId: 'default',
  residencyPartition: 'jp',
  allocationScope: 'shared_pool' as const,
  ownerTenantId: null,
};
const listInput = {
  environmentId: 'env-test',
  tenantId: 'tenant-a',
  residencyPolicyId: 'default',
  residencyPartition: 'jp',
};

const expectedTarget = {
  shardId: 'shard-a',
  dataRole: 'tenant_core/default',
  residencyPolicyId: 'default',
  residencyPartition: 'jp',
  routeGeneration: 3,
  bindingRef: 'TDB_A',
  databaseId: 'db-a',
  databaseName: 'name-a',
  allocationScope: 'shared_pool',
  ownerTenantId: null,
};

const BAD_GENERATIONS: [string, unknown][] = [
  ['zero', 0],
  ['negative', -1],
  ['fractional', 1.5],
  ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ['non-numeric text', 'abc'],
  ['missing', null],
];

describe('findEligibleTenantShard row validation', () => {
  it('returns the mapped target with numeric generations from text columns', async () => {
    const repository = repositoryReturning([
      { ...base, generation: '3', assignment_generation: '5' },
    ]);
    await expect(repository.findEligibleTenantShard(eligibleInput)).resolves.toEqual({
      ...expectedTarget,
      assignmentGeneration: 5,
    });
  });

  it('returns null without a candidate', async () => {
    await expect(
      repositoryReturning([]).findEligibleTenantShard(eligibleInput)
    ).resolves.toBeNull();
  });

  it('accepts the smallest valid generations', async () => {
    const repository = repositoryReturning([{ ...base, generation: 1, assignment_generation: 1 }]);
    await expect(repository.findEligibleTenantShard(eligibleInput)).resolves.toMatchObject({
      routeGeneration: 1,
      assignmentGeneration: 1,
    });
  });

  it.each(BAD_GENERATIONS)('rejects a %s route generation', async (_label, value) => {
    await expect(
      repositoryReturning([{ ...base, generation: value }]).findEligibleTenantShard(eligibleInput)
    ).rejects.toThrow('control_tenant_shard_capacity_invalid');
  });

  it.each(BAD_GENERATIONS)('rejects a %s assignment generation', async (_label, value) => {
    await expect(
      repositoryReturning([{ ...base, assignment_generation: value }]).findEligibleTenantShard(
        eligibleInput
      )
    ).rejects.toThrow('control_tenant_shard_capacity_invalid');
  });
});

describe('listActiveTenantShardTargets row validation', () => {
  it('maps every row', async () => {
    const repository = repositoryReturning([
      { ...base, generation: '3', assignment_generation: '5' },
      { ...base, shard_id: 'shard-b', generation: 4, assignment_generation: 6 },
    ]);
    await expect(repository.listActiveTenantShardTargets(listInput)).resolves.toEqual([
      { ...expectedTarget, assignmentGeneration: 5 },
      { ...expectedTarget, shardId: 'shard-b', routeGeneration: 4, assignmentGeneration: 6 },
    ]);
  });

  it('accepts the smallest valid generations', async () => {
    const repository = repositoryReturning([{ ...base, generation: 1, assignment_generation: 1 }]);
    await expect(repository.listActiveTenantShardTargets(listInput)).resolves.toHaveLength(1);
  });

  it.each(BAD_GENERATIONS.filter(([, value]) => value !== null))(
    'rejects a %s route generation',
    async (_label, value) => {
      await expect(
        repositoryReturning([{ ...base, generation: value }]).listActiveTenantShardTargets(
          listInput
        )
      ).rejects.toThrow('control_tenant_shard_assignment_invalid');
    }
  );

  it.each(BAD_GENERATIONS.filter(([, value]) => value !== null))(
    'rejects a %s assignment generation',
    async (_label, value) => {
      await expect(
        repositoryReturning([
          { ...base, assignment_generation: value },
        ]).listActiveTenantShardTargets(listInput)
      ).rejects.toThrow('control_tenant_shard_assignment_invalid');
    }
  );
});

describe('findAssignableTenantShard row validation', () => {
  it('returns the mapped target and rejects invalid generations', async () => {
    await expect(
      repositoryReturning([{ ...base, generation: '3' }]).findAssignableTenantShard(eligibleInput)
    ).resolves.toEqual(expectedTarget);
    await expect(
      repositoryReturning([]).findAssignableTenantShard(eligibleInput)
    ).resolves.toBeNull();
    await expect(
      repositoryReturning([{ ...base, generation: 1 }]).findAssignableTenantShard(eligibleInput)
    ).resolves.toMatchObject({ routeGeneration: 1 });
    for (const [, value] of BAD_GENERATIONS) {
      await expect(
        repositoryReturning([{ ...base, generation: value }]).findAssignableTenantShard(
          eligibleInput
        )
      ).rejects.toThrow('control_tenant_shard_capacity_invalid');
    }
  });
});

import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1ControlRepository } from '../repository';
import { controlDatabase, d1Over, dropTriggers } from './support/sqlite-d1';

let database: DatabaseSync;
let repository: D1ControlRepository;

beforeEach(() => {
  database = controlDatabase();
  dropTriggers(database);
  repository = new D1ControlRepository(d1Over(database));
});

function environment(input: {
  id: string;
  name: string;
  state?: string;
  enabled?: number;
  ownership?: string;
  capability?: string;
}): void {
  database
    .prepare(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at,
         automatic_provisioning_enabled, provisioning_token_ownership,
         provisioning_capability_state
       ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`
    )
    .run(
      input.id,
      input.name,
      `urn:authrim:control:${input.id}`,
      input.state ?? 'active',
      input.enabled ?? 0,
      input.ownership ?? 'none',
      input.capability ?? 'disabled'
    );
}

describe('hasReadyAutomaticProvisioning', () => {
  it('is false without any environment', async () => {
    await expect(repository.hasReadyAutomaticProvisioning()).resolves.toBe(false);
  });

  it.each([
    ['active user ready', 'active', 1, 'user', 'ready', true],
    ['creating account ready', 'creating', 1, 'account', 'ready', true],
    ['quarantining', 'quarantining', 1, 'user', 'ready', false],
    ['quarantined', 'quarantined', 1, 'user', 'ready', false],
    ['disabled lifecycle', 'disabled', 1, 'user', 'ready', false],
    ['automatic off', 'active', 0, 'user', 'ready', false],
    ['no token ownership', 'active', 1, 'none', 'ready', false],
    ['capability pending', 'active', 1, 'user', 'pending', false],
    ['capability blocked', 'active', 1, 'account', 'blocked', false],
    ['capability disabled', 'active', 1, 'account', 'disabled', false],
  ])('%s', async (_name, state, enabled, ownership, capability, expected) => {
    environment({ id: 'env-1', name: 'one', state, enabled, ownership, capability });
    await expect(repository.hasReadyAutomaticProvisioning()).resolves.toBe(expected);
  });

  it('is true when only one of several environments is ready', async () => {
    environment({ id: 'env-1', name: 'one' });
    environment({ id: 'env-2', name: 'two', enabled: 1, ownership: 'user', capability: 'ready' });
    await expect(repository.hasReadyAutomaticProvisioning()).resolves.toBe(true);
  });
});

describe('listActiveEnvironments', () => {
  it('lists creating and active environments, longest name first then alphabetically', async () => {
    environment({ id: 'env-a', name: 'bb' });
    environment({ id: 'env-b', name: 'a', state: 'creating' });
    environment({ id: 'env-c', name: 'ccc' });
    environment({ id: 'env-d', name: 'aa' });
    environment({ id: 'env-e', name: 'zzzz', state: 'quarantined' });
    environment({ id: 'env-f', name: 'yyyyy', state: 'disabled' });
    environment({ id: 'env-g', name: 'xxxxxx', state: 'quarantining' });
    await expect(repository.listActiveEnvironments()).resolves.toEqual([
      { environment_id: 'env-c', environment_name: 'ccc', lifecycle_state: 'active' },
      { environment_id: 'env-d', environment_name: 'aa', lifecycle_state: 'active' },
      { environment_id: 'env-a', environment_name: 'bb', lifecycle_state: 'active' },
      { environment_id: 'env-b', environment_name: 'a', lifecycle_state: 'creating' },
    ]);
  });

  it('is empty without active environments', async () => {
    await expect(repository.listActiveEnvironments()).resolves.toEqual([]);
  });
});

function partition(input: {
  environment?: string;
  policy?: string;
  name: string;
  status?: string;
  domain?: string | null;
  jurisdiction?: string | null;
  hint?: string | null;
}): void {
  database
    .prepare(
      `INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, jurisdiction, location_hint,
         status, created_at, updated_at, lookup_capacity_domain_id
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`
    )
    .run(
      input.environment ?? 'env-1',
      input.policy ?? 'policy-1',
      input.name,
      input.jurisdiction ?? null,
      input.hint ?? null,
      input.status ?? 'active',
      input.domain ?? null
    );
}

describe('getResidencyPartition', () => {
  it('derives the lookup capacity domain when none is stored', async () => {
    partition({ name: 'jp', hint: 'apac' });
    await expect(repository.getResidencyPartition('env-1', 'policy-1', 'jp')).resolves.toEqual({
      residency_policy_id: 'policy-1',
      residency_partition: 'jp',
      lookup_capacity_domain_id: 'lookup:policy-1:jp',
      jurisdiction: null,
      location_hint: 'apac',
    });
  });

  it('prefers the stored lookup capacity domain and reports the jurisdiction', async () => {
    partition({ name: 'eu', domain: 'domain-eu', jurisdiction: 'eu' });
    await expect(
      repository.getResidencyPartition('env-1', 'policy-1', 'eu')
    ).resolves.toMatchObject({
      lookup_capacity_domain_id: 'domain-eu',
      jurisdiction: 'eu',
      location_hint: null,
    });
  });

  it('ignores disabled partitions and other scopes', async () => {
    partition({ name: 'off', status: 'disabled' });
    partition({ name: 'other-env', environment: 'env-2' });
    partition({ name: 'other-policy', policy: 'policy-2' });
    await expect(repository.getResidencyPartition('env-1', 'policy-1', 'off')).resolves.toBeNull();
    await expect(
      repository.getResidencyPartition('env-1', 'policy-1', 'other-env')
    ).resolves.toBeNull();
    await expect(
      repository.getResidencyPartition('env-1', 'policy-1', 'other-policy')
    ).resolves.toBeNull();
    await expect(
      repository.getResidencyPartition('env-1', 'policy-1', 'missing')
    ).resolves.toBeNull();
  });
});

function placementPolicy(tenant: string, state: string): void {
  database
    .prepare(
      `INSERT INTO control_tenant_placement_policies (
         environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
         source_operation_id, idempotency_key, activated_at, created_at, updated_at
       ) VALUES ('env-1', ?, 'shared_pool', 4, ?, 'op', ?, ?, 1, 1)`
    )
    .run(tenant, state, `idem-${tenant}`, state === 'provisioning' ? null : 1);
}

function allocation(tenant: string, partitionName: string, state: string, id: string): void {
  database
    .prepare(
      `INSERT INTO control_tenant_default_allocations (
         allocation_id, environment_id, tenant_id, residency_policy_id, residency_partition,
         selected_shard_id, reservation_state, idempotency_key, route_generation,
         created_at, committed_at, released_at, updated_at
       ) VALUES (?, 'env-1', ?, 'policy-1', ?, 'shard-1', ?, ?, 1, 1, ?, ?, 1)`
    )
    .run(
      id,
      tenant,
      partitionName,
      state,
      `idem-${id}`,
      state === 'committed' ? 1 : null,
      state === 'released' ? 1 : null
    );
}

describe('listTenantActiveResidencies', () => {
  it('returns committed allocations of active policies on active partitions, in key order', async () => {
    partition({ name: 'us', hint: 'enam' });
    partition({ name: 'jp', hint: 'apac' });
    partition({ name: 'off', status: 'disabled' });
    placementPolicy('tenant-1', 'active');
    placementPolicy('tenant-2', 'active');
    placementPolicy('tenant-3', 'provisioning');
    allocation('tenant-1', 'us', 'committed', 'a1');
    allocation('tenant-2', 'us', 'committed', 'a2');
    await expect(repository.listTenantActiveResidencies('env-1', 'tenant-1')).resolves.toEqual([
      {
        residency_policy_id: 'policy-1',
        residency_partition: 'us',
        jurisdiction: null,
        location_hint: 'enam',
        policy_generation: 4,
      },
    ]);
    allocation('tenant-1', 'jp', 'committed', 'a3');
    const both = await repository.listTenantActiveResidencies('env-1', 'tenant-1');
    expect(both.map((row) => row.residency_partition)).toEqual(['jp', 'us']);
  });

  it.each([
    ['reserved', 'active', 'jp'],
    ['released', 'active', 'jp'],
    ['committed', 'provisioning', 'jp'],
    ['committed', 'active', 'off'],
  ])('excludes a %s allocation with a %s policy on partition %s', async (state, policy, name) => {
    partition({ name: 'jp' });
    partition({ name: 'off', status: 'disabled' });
    placementPolicy('tenant-1', policy);
    allocation('tenant-1', name, state, 'a1');
    await expect(repository.listTenantActiveResidencies('env-1', 'tenant-1')).resolves.toEqual([]);
  });

  it('is scoped to the environment', async () => {
    partition({ name: 'jp' });
    placementPolicy('tenant-1', 'active');
    allocation('tenant-1', 'jp', 'committed', 'a1');
    await expect(repository.listTenantActiveResidencies('env-2', 'tenant-1')).resolves.toEqual([]);
  });
});

describe('hasTenantShardAssignment', () => {
  const assign = (input: {
    tenant?: string;
    role?: string;
    partition?: string;
    state: string;
    shard: string;
    generation: number;
    environment?: string;
  }) =>
    database
      .prepare(
        `INSERT INTO control_tenant_shard_assignments (
           environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
           shard_id, assignment_generation, assignment_state, source_operation_id,
           created_at, activated_at, retired_at, updated_at
         ) VALUES (?, ?, ?, 'policy-1', ?, ?, ?, ?, 'op', 1, ?, ?, 1)`
      )
      .run(
        input.environment ?? 'env-1',
        input.tenant ?? 'tenant-1',
        input.role ?? 'tenant_pii',
        input.partition ?? 'jp',
        input.shard,
        input.generation,
        input.state,
        input.state === 'active' ? 1 : null,
        input.state === 'retired' || input.state === 'quarantined' ? 1 : null
      );
  const probe = (patch: Record<string, string> = {}) =>
    repository.hasTenantShardAssignment({
      environmentId: 'env-1',
      tenantId: 'tenant-1',
      dataRole: 'tenant_pii',
      residencyPartition: 'jp',
      ...patch,
    } as never);

  it('is false without assignments', async () => {
    await expect(probe()).resolves.toBe(false);
  });

  it.each([
    ['pending', true],
    ['active', true],
    ['retired', false],
    ['quarantined', false],
  ])('treats a %s assignment as %s', async (state, expected) => {
    assign({ state, shard: 'shard-1', generation: 1 });
    await expect(probe()).resolves.toBe(expected);
  });

  it('matches environment, tenant, role and partition exactly', async () => {
    assign({ state: 'active', shard: 'shard-1', generation: 1 });
    await expect(probe({ environmentId: 'env-2' })).resolves.toBe(false);
    await expect(probe({ tenantId: 'tenant-2' })).resolves.toBe(false);
    await expect(probe({ dataRole: 'tenant_core/users' })).resolves.toBe(false);
    await expect(probe({ residencyPartition: 'us' })).resolves.toBe(false);
  });

  it('finds a live assignment next to retired ones', async () => {
    assign({ state: 'retired', shard: 'shard-1', generation: 1 });
    assign({ state: 'active', shard: 'shard-2', generation: 2 });
    await expect(probe()).resolves.toBe(true);
  });
});

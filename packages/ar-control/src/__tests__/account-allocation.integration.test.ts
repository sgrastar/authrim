import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ControlAccountAllocationService,
  D1AccountAllocationRepository,
} from '../account-allocation';
import { D1ControlRepository } from '../repository';
import { TenantDefaultAllocationService } from '../tenant-default-allocation';

type SqliteValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  executeRun() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch(statements: unknown[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
          return statement.executeRun();
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a',
    accountIdBlindDigest: 'a'.repeat(64),
    residencyPolicyId: 'default-policy',
    residencyPartition: 'default',
    idempotencyKey: 'create-account-a',
    dataRoles: ['tenant_core/users', 'tenant_pii'],
    ...overrides,
  };
}

describe('account route allocation', () => {
  let database: DatabaseSync;
  let service: ControlAccountAllocationService;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/001_pre_1_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
       INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
       ) VALUES ('env-test', 'default-policy', 'default', 'active', 1, 1);
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares,
         max_d1_resources, daily_d1_create_budget, target_account_count,
         created_at, updated_at
       ) VALUES ('env-test', 2, 2, 100, 20, 100000, 1, 1);
       INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES (
         'op-seed', 'env-test', 'provision_shard', 'seed-shards', 'succeeded',
         'setup', 1, 1, 1, 1
       );

       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, provisioning_state,
         origin_operation_id, desired_spec_json, created_at, updated_at
       ) VALUES
         ('resource-users-a', 'env-test', 'd1', 'users-a', 'users-a', 'fp-users-a', 'ready', 'op-seed', '{}', 1, 1),
         ('resource-users-b', 'env-test', 'd1', 'users-b', 'users-b', 'fp-users-b', 'ready', 'op-seed', '{}', 1, 1),
         ('resource-pii-a', 'env-test', 'd1', 'pii-a', 'pii-a', 'fp-pii-a', 'ready', 'op-seed', '{}', 1, 1),
         ('resource-pii-b', 'env-test', 'd1', 'pii-b', 'pii-b', 'fp-pii-b', 'ready', 'op-seed', '{}', 1, 1),
         ('resource-default-a', 'env-test', 'd1', 'default-a', 'default-a', 'fp-default-a', 'ready', 'op-seed', '{}', 1, 1);

       INSERT INTO control_observed_resources (
         observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
         provider_name, resource_kind, ownership_fingerprint, observed_state,
         observed_spec_json, observed_at
       ) VALUES (
         'observed-default-a', 'env-test', 'resource-default-a', 'database-default-a',
         'default-a', 'd1', 'fp-default-a', 'present', '{}', 1
       );
       UPDATE control_desired_resources
          SET observed_resource_id = 'observed-default-a'
        WHERE desired_resource_id = 'resource-default-a';

       INSERT INTO control_tenant_shards (
         shard_id, environment_id, data_role, residency_policy_id, residency_partition,
         generation, logical_shard_id, binding_ref, d1_desired_resource_id,
         status, created_at, updated_at
       ) VALUES
         ('users-a', 'env-test', 'tenant_core/users', 'default-policy', 'default', 3,
          'users-a', 'TDB_USERS_A', 'resource-users-a', 'active', 1, 1),
         ('users-b', 'env-test', 'tenant_core/users', 'default-policy', 'default', 4,
          'users-b', 'TDB_USERS_B', 'resource-users-b', 'active', 1, 1),
         ('pii-a', 'env-test', 'tenant_pii', 'default-policy', 'default', 5,
          'pii-a', 'TDB_PII_A', 'resource-pii-a', 'active', 1, 1),
         ('pii-b', 'env-test', 'tenant_pii', 'default-policy', 'default', 6,
          'pii-b', 'TDB_PII_B', 'resource-pii-b', 'active', 1, 1),
         ('default-a', 'env-test', 'tenant_core/default', 'default-policy', 'default', 7,
          'default-a', 'TDB_DEFAULT_A', 'resource-default-a', 'active', 1, 1);

       INSERT INTO control_shard_capacity (
         shard_id, target_account_count, allocated_account_count,
         health_status, allocation_status, updated_at
       ) VALUES
         ('users-a', 100, 50, 'healthy', 'eligible', 1),
         ('users-b', 100, 10, 'healthy', 'eligible', 1),
         ('pii-a', 10, 1, 'healthy', 'eligible', 1),
         ('pii-b', 100, 20, 'healthy', 'eligible', 1),
         ('default-a', 100, 0, 'healthy', 'eligible', 1);

       INSERT INTO control_tenant_placement_policies (
         environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
         source_operation_id, idempotency_key, activated_at, created_at, updated_at
       ) VALUES
         ('env-test', 'tenant-a', 'shared_pool', 1, 'active',
          'tenant-create-a', 'tenant-placement-a', 1, 1, 1),
         ('env-test', 'tenant-b', 'shared_pool', 1, 'active',
          'tenant-create-b', 'tenant-placement-b', 1, 1, 1);

       INSERT INTO control_tenant_shard_assignments (
         environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
         shard_id, assignment_generation, assignment_state, source_operation_id,
         created_at, activated_at, updated_at
       ) VALUES
         ('env-test', 'tenant-a', 'tenant_core/users', 'default-policy', 'default',
          'users-a', 1, 'active', 'tenant-create-a', 1, 1, 1),
         ('env-test', 'tenant-a', 'tenant_core/users', 'default-policy', 'default',
          'users-b', 2, 'active', 'tenant-expand-a-users', 1, 1, 1),
         ('env-test', 'tenant-a', 'tenant_pii', 'default-policy', 'default',
          'pii-a', 1, 'active', 'tenant-create-a', 1, 1, 1),
         ('env-test', 'tenant-a', 'tenant_pii', 'default-policy', 'default',
          'pii-b', 2, 'active', 'tenant-expand-a-pii', 1, 1, 1),
         ('env-test', 'tenant-a', 'tenant_core/default', 'default-policy', 'default',
          'default-a', 1, 'active', 'tenant-create-a', 1, 1, 1),
         ('env-test', 'tenant-b', 'tenant_core/default', 'default-policy', 'default',
          'default-a', 1, 'active', 'tenant-create-b', 1, 1, 1);`
    );
    service = new ControlAccountAllocationService(
      new D1AccountAllocationRepository(d1(database)),
      () => 100
    );
  });

  afterEach(() => database.close());

  it('selects the least-loaded eligible shard independently per data role', async () => {
    const result = await service.allocate(request(), 'env-test');
    expect(result.targets[0].allocationId).toMatch(/^allocation_[a-f0-9]{32}$/u);
    expect(result.targets[1].allocationId).toMatch(/^allocation_[a-f0-9]{32}$/u);
    expect(result).toEqual({
      tenantId: 'tenant-a',
      residencyPolicyId: 'default-policy',
      targets: [
        {
          allocationId: result.targets[0].allocationId,
          dataRole: 'tenant_core/users',
          residencyPartition: 'default',
          shardId: 'users-b',
          bindingRef: 'TDB_USERS_B',
          routeGeneration: 4,
        },
        {
          allocationId: result.targets[1].allocationId,
          dataRole: 'tenant_pii',
          residencyPartition: 'default',
          shardId: 'pii-a',
          bindingRef: 'TDB_PII_A',
          routeGeneration: 5,
        },
      ],
    });
  });

  it('never selects a less-loaded shard outside the tenant assigned set', async () => {
    database.exec(
      `DELETE FROM control_tenant_shard_assignments
        WHERE environment_id = 'env-test' AND tenant_id = 'tenant-a'
          AND data_role = 'tenant_core/users' AND shard_id = 'users-b'`
    );

    const result = await service.allocate(
      request({
        accountIdBlindDigest: 'c'.repeat(64),
        idempotencyKey: 'create-account-assigned-set',
        dataRoles: ['tenant_core/users'],
      }),
      'env-test'
    );

    expect(result.targets).toEqual([
      expect.objectContaining({
        dataRole: 'tenant_core/users',
        shardId: 'users-a',
        routeGeneration: 3,
      }),
    ]);
  });

  it('coexists with exclusive tenants and rejects wrong-owner assignment', () => {
    database.exec(
      `INSERT INTO control_tenant_placement_policies (
         environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
         source_operation_id, idempotency_key, activated_at, created_at, updated_at
       ) VALUES ('env-test', 'tenant-exclusive', 'tenant_exclusive', 1, 'active',
                 'tenant-create-exclusive', 'tenant-placement-exclusive', 1, 1, 1);
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         resource_scope, tenant_id, deterministic_name, ownership_fingerprint,
         provisioning_state, origin_operation_id, desired_spec_json, created_at, updated_at
       ) VALUES ('resource-exclusive-users', 'env-test', 'd1', 'exclusive-users',
                 'tenant', 'tenant-exclusive', 'exclusive-users', 'fp-exclusive-users',
                 'ready', 'op-seed', '{}', 1, 1);
       INSERT INTO control_tenant_shards (
         shard_id, environment_id, data_role, residency_policy_id, residency_partition,
         generation, logical_shard_id, binding_ref, d1_desired_resource_id,
         allocation_scope, owner_tenant_id, status, created_at, updated_at
       ) VALUES ('exclusive-users', 'env-test', 'tenant_core/users', 'default-policy', 'default',
                 8, 'exclusive-users', 'TDB_EXCLUSIVE_USERS', 'resource-exclusive-users',
                 'tenant_exclusive', 'tenant-exclusive', 'active', 1, 1);
       INSERT INTO control_tenant_shard_assignments (
         environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
         shard_id, assignment_generation, assignment_state, source_operation_id,
         created_at, activated_at, updated_at
       ) VALUES ('env-test', 'tenant-exclusive', 'tenant_core/users', 'default-policy', 'default',
                 'exclusive-users', 1, 'active', 'tenant-create-exclusive', 1, 1, 1);`
    );

    expect(() =>
      database.exec(
        `INSERT INTO control_tenant_shard_assignments (
           environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
           shard_id, assignment_generation, assignment_state, source_operation_id,
           created_at, activated_at, updated_at
         ) VALUES ('env-test', 'tenant-a', 'tenant_core/users', 'default-policy', 'default',
                   'exclusive-users', 3, 'active', 'wrong-owner', 1, 1, 1)`
      )
    ).toThrow('control_tenant_shard_assignment_scope_mismatch');
  });

  it('adopts a response-loss retry without incrementing capacity twice', async () => {
    const first = await service.allocate(request(), 'env-test');
    const second = await service.allocate(request(), 'env-test');
    expect(second).toEqual(first);
    expect(
      database
        .prepare(
          `SELECT shard_id, allocated_account_count FROM control_shard_capacity
            WHERE shard_id IN ('users-b', 'pii-a') ORDER BY shard_id`
        )
        .all()
    ).toEqual([
      { shard_id: 'pii-a', allocated_account_count: 2 },
      { shard_id: 'users-b', allocated_account_count: 11 },
    ]);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_audit_events`).get()).toEqual({
      count: 2,
    });
  });

  it('commits both account route reservations atomically and replays idempotently', async () => {
    const allocated = await service.allocate(request(), 'env-test');
    const committed = await service.commit(request(), 'env-test');
    expect(committed).toEqual(allocated);
    expect(await service.commit(request(), 'env-test')).toEqual(committed);
    expect(
      database
        .prepare(
          `SELECT data_role, reservation_state, committed_at
             FROM control_tenant_shard_allocations
            ORDER BY data_role`
        )
        .all()
    ).toEqual([
      {
        data_role: 'tenant_core/users',
        reservation_state: 'committed',
        committed_at: 100,
      },
      { data_role: 'tenant_pii', reservation_state: 'committed', committed_at: 100 },
    ]);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_audit_events`).get()).toEqual({
      count: 4,
    });
  });

  it('releases both uncommitted reservations atomically and restores capacity once', async () => {
    await service.allocate(request(), 'env-test');

    await service.release(request(), 'env-test');
    await service.release(request(), 'env-test');

    expect(
      database
        .prepare(
          `SELECT data_role, reservation_state, capacity_counted_at
             FROM control_tenant_shard_allocations ORDER BY data_role`
        )
        .all()
    ).toEqual([
      {
        data_role: 'tenant_core/users',
        reservation_state: 'released',
        capacity_counted_at: null,
      },
      { data_role: 'tenant_pii', reservation_state: 'released', capacity_counted_at: null },
    ]);
    expect(
      database
        .prepare(
          `SELECT shard_id, allocated_account_count FROM control_shard_capacity
            WHERE shard_id IN ('users-b', 'pii-a') ORDER BY shard_id`
        )
        .all()
    ).toEqual([
      { shard_id: 'pii-a', allocated_account_count: 1 },
      { shard_id: 'users-b', allocated_account_count: 10 },
    ]);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_audit_events`).get()).toEqual({
      count: 4,
    });
    await expect(service.commit(request(), 'env-test')).rejects.toThrow(
      'control_account_allocation_commit_not_found'
    );
    await expect(service.allocate(request(), 'env-test')).rejects.toThrow(
      'control_account_allocation_idempotency_conflict'
    );
  });

  it('refuses to release committed account routes', async () => {
    await service.allocate(request(), 'env-test');
    await service.commit(request(), 'env-test');

    await expect(service.release(request(), 'env-test')).rejects.toThrow(
      'control_account_allocation_release_committed'
    );
  });

  it('fails closed when an account route commit does not match the reservation idempotency key', async () => {
    await service.allocate(request(), 'env-test');
    await expect(
      service.commit(request({ idempotencyKey: 'different-account-operation' }), 'env-test')
    ).rejects.toThrow('control_account_allocation_commit_not_found');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_tenant_shard_allocations
            WHERE reservation_state = 'committed'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('rejects idempotency reuse for another blind account digest', async () => {
    await service.allocate(request(), 'env-test');
    await expect(
      service.allocate(request({ accountIdBlindDigest: 'b'.repeat(64) }), 'env-test')
    ).rejects.toThrow('control_account_allocation_idempotency_conflict');
  });

  it('fails closed when no active healthy shard has capacity', async () => {
    database.exec(
      `UPDATE control_shard_capacity
          SET allocation_status = 'full'
        WHERE shard_id IN ('users-a', 'users-b')`
    );
    await expect(
      service.allocate(request({ dataRoles: ['tenant_core/users'] }), 'env-test')
    ).rejects.toThrow('control_account_allocation_capacity_unavailable');
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_tenant_shard_allocations`).get()
    ).toEqual({ count: 0 });
  });

  it('rolls back every role when one role has no capacity and retries cleanly', async () => {
    database.exec(
      `UPDATE control_shard_capacity
          SET allocation_status = 'full'
        WHERE shard_id IN ('pii-a', 'pii-b')`
    );

    await expect(service.allocate(request(), 'env-test')).rejects.toThrow(
      'control_account_allocation_capacity_unavailable'
    );
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_tenant_shard_allocations`).get()
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT shard_id, allocated_account_count FROM control_shard_capacity
            WHERE shard_id IN ('users-a', 'users-b') ORDER BY shard_id`
        )
        .all()
    ).toEqual([
      { shard_id: 'users-a', allocated_account_count: 50 },
      { shard_id: 'users-b', allocated_account_count: 10 },
    ]);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM control_audit_events`).get()).toEqual({
      count: 0,
    });

    database.exec(
      `UPDATE control_shard_capacity
          SET allocation_status = 'eligible'
        WHERE shard_id IN ('pii-a', 'pii-b')`
    );
    await expect(service.allocate(request(), 'env-test')).resolves.toMatchObject({
      targets: [
        { dataRole: 'tenant_core/users', shardId: 'users-b' },
        { dataRole: 'tenant_pii', shardId: 'pii-a' },
      ],
    });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_tenant_shard_allocations`).get()
    ).toEqual({ count: 2 });
  });

  it('rejects a second idempotency key for an existing blind account', async () => {
    await service.allocate(request(), 'env-test');

    await expect(
      service.allocate(request({ idempotencyKey: 'different-account-operation' }), 'env-test')
    ).rejects.toThrow('control_account_allocation_idempotency_conflict');
  });

  it('rejects malformed or duplicate role requests without reflecting blind input', async () => {
    await expect(
      service.allocate(request({ accountIdBlindDigest: 'raw-account-id' }), 'env-test')
    ).rejects.toThrow('invalid_account_id_blind_digest');
    await expect(
      service.allocate(
        request({ dataRoles: ['tenant_core/users', 'tenant_core/users'] }),
        'env-test'
      )
    ).rejects.toThrow('invalid_account_route_data_roles');
  });

  it('reserves, commits, and replays one sticky tenant default route', async () => {
    const allocations = new TenantDefaultAllocationService(d1(database), () => 100);
    const request = {
      tenantId: 'tenant-a',
      residencyPolicyId: 'default-policy',
      residencyPartition: 'default',
      idempotencyKey: 'tenant-a-default-route',
    };

    const reserved = await allocations.reserve(request, 'env-test');
    expect(await allocations.reserve(request, 'env-test')).toEqual(reserved);
    expect(reserved).toMatchObject({
      tenantId: 'tenant-a',
      state: 'reserved',
      target: {
        shardId: 'default-a',
        bindingRef: 'TDB_DEFAULT_A',
        databaseId: 'database-default-a',
        routeGeneration: 7,
      },
    });
    expect(
      database
        .prepare(
          `SELECT allocated_account_count FROM control_shard_capacity WHERE shard_id = 'default-a'`
        )
        .get()
    ).toEqual({ allocated_account_count: 1 });

    const committed = await allocations.mutate(
      { allocationId: reserved.allocationId },
      'env-test',
      'commit'
    );
    expect(committed.state).toBe('committed');
    expect(
      await allocations.mutate({ allocationId: reserved.allocationId }, 'env-test', 'release')
    ).toEqual(committed);
  });

  it('releases an uncommitted tenant default reservation and restores capacity once', async () => {
    const allocations = new TenantDefaultAllocationService(d1(database), () => 100);
    const reserved = await allocations.reserve(
      {
        tenantId: 'tenant-b',
        residencyPolicyId: 'default-policy',
        residencyPartition: 'default',
        idempotencyKey: 'tenant-b-default-route',
      },
      'env-test'
    );

    const released = await allocations.mutate(
      { allocationId: reserved.allocationId },
      'env-test',
      'release'
    );
    expect(released.state).toBe('released');
    expect(
      await allocations.mutate({ allocationId: reserved.allocationId }, 'env-test', 'release')
    ).toEqual(released);
    expect(
      database
        .prepare(
          `SELECT allocated_account_count FROM control_shard_capacity WHERE shard_id = 'default-a'`
        )
        .get()
    ).toEqual({ allocated_account_count: 0 });

    const reservedAgain = await allocations.reserve(
      {
        tenantId: 'tenant-b',
        residencyPolicyId: 'default-policy',
        residencyPartition: 'default',
        idempotencyKey: 'tenant-b-default-route-retry',
      },
      'env-test'
    );
    expect(reservedAgain.state).toBe('reserved');
    expect(
      database
        .prepare(
          `SELECT allocated_account_count FROM control_shard_capacity WHERE shard_id = 'default-a'`
        )
        .get()
    ).toEqual({ allocated_account_count: 1 });
  });

  it('lists only active account source shards with bounded keyset pagination', async () => {
    const repository = new D1ControlRepository(d1(database));
    await expect(repository.listAccountDirectorySourceShards('env-test', null, 1)).resolves.toEqual(
      [
        {
          shardId: 'users-a',
          bindingRef: 'TDB_USERS_A',
          residencyPartition: 'default',
          routeGeneration: 3,
        },
      ]
    );
    await expect(
      repository.listAccountDirectorySourceShards('env-test', 'users-a', 10)
    ).resolves.toEqual([
      {
        shardId: 'users-b',
        bindingRef: 'TDB_USERS_B',
        residencyPartition: 'default',
        routeGeneration: 4,
      },
    ]);
    await expect(
      repository.listAccountDirectorySourceShards('env-test', null, 101)
    ).rejects.toThrow('invalid_account_directory_source_limit');

    await expect(
      repository.listAccountRouteSourceShards('env-test', 'tenant_pii', null, 10)
    ).resolves.toEqual([
      {
        dataRole: 'tenant_pii',
        shardId: 'pii-a',
        bindingRef: 'TDB_PII_A',
        residencyPartition: 'default',
        routeGeneration: 5,
      },
      {
        dataRole: 'tenant_pii',
        shardId: 'pii-b',
        bindingRef: 'TDB_PII_B',
        residencyPartition: 'default',
        routeGeneration: 6,
      },
    ]);
    await expect(
      repository.listAccountRouteSourceShards(
        'env-test',
        'tenant_core/default' as 'tenant_core/users',
        null,
        10
      )
    ).rejects.toThrow('invalid_account_route_source_role');
  });
});

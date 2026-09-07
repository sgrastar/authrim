import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getControlStorageTopology } from '../storage-topology';

type SqliteValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[]
  ) {}

  execute() {
    return {
      success: true,
      results: this.statement.all(...this.values),
      meta: { changes: 0 },
    };
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
      return statements.map((statement) => {
        if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
        return statement.execute();
      });
    },
  } as unknown as D1Database;
}

describe('Control storage topology', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
      INSERT INTO control_environment_resource_policies (
        environment_id, max_concurrent_provisioning, max_ready_spares,
        max_d1_resources, daily_d1_create_budget, target_account_count, created_at, updated_at
      ) VALUES ('env-test', 2, 1, 100, 50, 500, 1, 1);
      INSERT INTO control_residency_partitions (
        environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
      ) VALUES ('env-test', 'default-policy', 'default', 'active', 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, started_at, completed_at, updated_at
      ) VALUES
        ('op-users', 'env-test', 'provision_shard', 'users', 'succeeded', 'setup', 1, 10, 11, 20, 20),
        ('op-lookup', 'env-test', 'provision_shard', 'lookup', 'succeeded', 'setup', 1, 12, 13, 21, 21),
        ('op-pending', 'env-test', 'provision_shard', 'pending', 'queued', 'scheduler', 0, 30, NULL, NULL, 30);
      INSERT INTO control_desired_resources (
        desired_resource_id, environment_id, resource_kind, logical_shard_id,
        resource_scope, tenant_id, deterministic_name, ownership_fingerprint,
        desired_state, provisioning_state, origin_operation_id, create_started_at,
        observed_resource_id, provider_create_state, provider_resource_id,
        provider_identity_checkpointed_at, created_at, updated_at
      ) VALUES
        ('desired-users', 'env-test', 'd1', 'users-1', 'platform', NULL,
         'test-authrim-tenant-users-db-a', 'fingerprint', 'present', 'active',
         'op-users', 11, 'observed-users', 'identified', 'provider-users', 20, 10, 20),
        ('desired-lookup', 'env-test', 'd1', 'lookup-1', 'platform', NULL,
         'test-authrim-lookup-db', 'fingerprint', 'present', 'active',
         'op-lookup', 13, 'observed-lookup', 'identified', 'provider-lookup', 21, 12, 21),
        ('desired-pending', 'env-test', 'd1', 'pii-2', 'tenant', 'tenant-b',
         'test-authrim-tenant-pii-db-b', 'fingerprint', 'present', 'requested',
         'op-pending', NULL, NULL, 'not_started', NULL, NULL, 30, 30);
      INSERT INTO control_observed_resources (
        observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
        provider_name, resource_kind, observed_state, observed_spec_json, observed_at
      ) VALUES
        ('observed-users', 'env-test', 'desired-users', 'provider-users',
         'test-authrim-tenant-users-db-a', 'd1', 'present', '{}', 20),
        ('observed-lookup', 'env-test', 'desired-lookup', 'provider-lookup',
         'test-authrim-lookup-db', 'd1', 'present', '{}', 21);
      INSERT INTO control_tenant_placement_policies (
        environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
        source_operation_id, idempotency_key, activated_at, created_at, updated_at
      ) VALUES
        ('env-test', 'tenant-a', 'shared_pool', 1, 'active', 'op-users', 'tenant-a', 20, 10, 20),
        ('env-test', 'tenant-b', 'tenant_exclusive', 1, 'provisioning',
         'op-pending', 'tenant-b', NULL, 30, 30);
      INSERT INTO control_tenant_shards (
        shard_id, environment_id, data_role, residency_policy_id, residency_partition,
        generation, logical_shard_id, binding_ref, d1_desired_resource_id,
        allocation_scope, owner_tenant_id, status, created_at, updated_at
      ) VALUES
        ('shard-users', 'env-test', 'tenant_core/users', 'default-policy', 'default',
         1, 'users-1', 'TEST_USERS_1', 'desired-users', 'shared_pool', NULL, 'active', 10, 20),
        ('shard-pending', 'env-test', 'tenant_pii', 'default-policy', 'default',
         1, 'pii-2', 'TEST_PII_2', 'desired-pending', 'tenant_exclusive', 'tenant-b',
         'ready', 30, 30);
      INSERT INTO control_shard_capacity (
        shard_id, target_account_count, allocated_account_count, observed_account_count,
        health_status, allocation_status, storage_bytes, updated_at
      ) VALUES ('shard-users', 500, 1, 1, 'healthy', 'eligible', 4096, 20);
      INSERT INTO control_tenant_shard_assignments (
        environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
        shard_id, assignment_generation, assignment_state, source_operation_id,
        created_at, activated_at, updated_at
      ) VALUES ('env-test', 'tenant-a', 'tenant_core/users', 'default-policy', 'default',
        'shard-users', 1, 'active', 'op-users', 20, 20, 20);
      INSERT INTO control_tenant_shard_allocations (
        allocation_id, environment_id, tenant_id, account_id_blind_digest, data_role,
        residency_partition, selected_shard_id, reservation_state, idempotency_key,
        capacity_counted_at, created_at, committed_at, updated_at
      ) VALUES ('allocation-a', 'env-test', 'tenant-a', '${'a'.repeat(64)}',
        'tenant_core/users', 'default', 'shard-users', 'committed', 'account-a', 20, 20, 20, 20);
      INSERT INTO control_lookup_physical_shards (
        lookup_shard_id, environment_id, residency_partition, binding_ref,
        d1_desired_resource_id, status, capacity_weight, created_at, updated_at
      ) VALUES ('lookup-a', 'env-test', 'default', 'TEST_LOOKUP_1',
        'desired-lookup', 'active', 1, 12, 21);
      INSERT INTO control_lookup_bucket_assignments (
        environment_id, virtual_bucket, lookup_shard_id, assignment_generation, state, updated_at
      ) VALUES ('env-test', 0, 'lookup-a', 1, 'active', 21);
      INSERT INTO control_d1_create_budget_reservations (
        operation_id, environment_id, budget_day, created_at
      ) VALUES ('op-pending', 'env-test', CAST(unixepoch() / 86400 AS INTEGER), 30);`);
  });

  afterEach(() => database.close());

  it('returns redacted provider, tenant, capacity, spare, and operation aggregates', async () => {
    const topology = await getControlStorageTopology({
      database: d1(database),
      environmentId: 'env-test',
      generatedAt: 40,
      providerDatabases: [
        { uuid: 'provider-users', name: 'test-authrim-tenant-users-db-a', file_size: 4096 },
        { uuid: 'provider-lookup', name: 'test-authrim-lookup-db', file_size: 2048 },
        { uuid: 'platform-fixed', name: 'test-authrim-control-db', file_size: 1024 },
        { uuid: 'unrelated', name: 'other-authrim-control-db', file_size: 1024 },
      ],
    });

    expect(topology.summary).toEqual({
      providerInventoryAvailable: true,
      providerD1Count: 3,
      controlManagedD1Count: 3,
      tenantShardCount: 2,
      lookupShardCount: 1,
      activeTenantShardCount: 1,
      readySpareCount: 1,
      provisioningD1Count: 1,
      failedD1Count: 0,
      accountCount: 1,
      inFlightOperationCount: 1,
      blockedOperationCount: 0,
    });
    expect(topology.policy).toMatchObject({
      dailyD1CreateBudget: 50,
      dailyD1CreateUsed: 1,
      dailyD1CreateRemaining: 49,
    });
    expect(topology.tenants).toEqual([
      expect.objectContaining({ tenantId: 'tenant-a', accountCount: 1, assignedShardCount: 1 }),
      expect.objectContaining({ tenantId: 'tenant-b', accountCount: 0, assignedShardCount: 0 }),
    ]);
    expect(topology.tenantShards[0]).toMatchObject({
      shardId: 'shard-users',
      providerDatabaseId: 'provider-users',
      allocatedAccountCount: 1,
      activeAssignmentCount: 1,
    });
    expect(topology.lookupShards[0]).toMatchObject({
      lookupShardId: 'lookup-a',
      activeBucketCount: 1,
    });
    expect(topology.operations.map((operation) => operation.operationId)).toEqual([
      'op-pending',
      'op-lookup',
      'op-users',
    ]);
    expect(JSON.stringify(topology)).not.toContain('account_id_blind_digest');
    expect(JSON.stringify(topology)).not.toContain('idempotency_key');
  });

  it('keeps Control topology available when provider inventory is unavailable', async () => {
    const topology = await getControlStorageTopology({
      database: d1(database),
      environmentId: 'env-test',
      generatedAt: 40,
      providerDatabases: null,
    });

    expect(topology.summary.providerInventoryAvailable).toBe(false);
    expect(topology.summary.providerD1Count).toBeNull();
    expect(topology.providerDatabases).toEqual([]);
    expect(topology.summary.controlManagedD1Count).toBe(3);
  });

  it('keeps all-operation aggregates accurate when the recent table is capped at 100 rows', async () => {
    database.exec(
      `UPDATE control_environment_resource_policies SET max_d1_resources = 1000
        WHERE environment_id = 'env-test'`
    );
    const insertOperation = database.prepare(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status,
         requested_by_type, attempt_count, created_at, completed_at, updated_at
       ) VALUES (?, 'env-test', 'provision_shard', ?, 'succeeded', 'scheduler', 1, ?, ?, ?)`
    );
    const insertDesired = database.prepare(
      `INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, desired_state, provisioning_state,
         origin_operation_id, provider_create_state, provider_resource_id,
         provider_identity_checkpointed_at, created_at, updated_at
       ) VALUES (?, 'env-test', 'd1', ?, ?, ?, 'present', 'ready', ?,
                 'identified', ?, ?, ?, ?)`
    );
    for (let index = 0; index < 100; index += 1) {
      const operationId = `op-new-${index}`;
      const desiredId = `desired-new-${index}`;
      const timestamp = 100 + index;
      insertOperation.run(operationId, `new-${index}`, timestamp, timestamp, timestamp);
      insertDesired.run(
        desiredId,
        `logical-new-${index}`,
        `test-authrim-new-${index}`,
        `fingerprint-${index}`,
        operationId,
        `database-new-${index}`,
        timestamp,
        timestamp,
        timestamp
      );
    }
    database.exec(
      `UPDATE control_operations
          SET status = 'blocked', last_error_code = 'control_d1_resource_limit',
              completed_at = 30, updated_at = 30
        WHERE operation_id = 'op-pending'`
    );

    const topology = await getControlStorageTopology({
      database: d1(database),
      environmentId: 'env-test',
      generatedAt: 300,
      providerDatabases: null,
    });

    expect(topology.operations).toHaveLength(100);
    expect(topology.operations.some((operation) => operation.operationId === 'op-pending')).toBe(
      false
    );
    expect(topology.summary.blockedOperationCount).toBe(1);
    expect(topology.summary.inFlightOperationCount).toBe(0);
    expect(topology.summary.provisioningD1Count).toBe(0);
  });
});

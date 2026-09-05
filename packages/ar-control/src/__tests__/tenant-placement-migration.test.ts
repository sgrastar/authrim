import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantPlacementMigrationService } from '../tenant-placement-migration';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
type SqliteValue = string | number | null | Uint8Array;

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

  bind(...input: unknown[]): BoundStatement {
    const values = input.map((value) => {
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        value instanceof Uint8Array
      ) {
        return value;
      }
      throw new Error('unsupported_test_sqlite_value');
    });
    return new BoundStatement(this.statement, values);
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
  };
  return {
    ...session,
    withSession: () => session,
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

describe('tenant placement migration operation', () => {
  let database: DatabaseSync;
  let service: TenantPlacementMigrationService;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
      INSERT INTO control_residency_partitions (
        environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
      ) VALUES ('env-test', 'default', 'jp', 'active', 1, 1);
      INSERT INTO control_environment_resource_policies (
        environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
        daily_d1_create_budget, target_account_count, created_at, updated_at
      ) VALUES ('env-test', 10, 10, 100, 100, 100000, 1, 1);
      INSERT INTO control_tenant_placement_policies (
        environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
        source_operation_id, idempotency_key, activated_at, created_at, updated_at
      ) VALUES (
        'env-test', 'tenant-a', 'shared_pool', 1, 'active',
        'tenant-create-a', 'tenant-create-a', 1, 1, 1
      );
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES (
        'fixture-shards', 'env-test', 'tenant_shard_provision', 'fixture-shards',
        'succeeded', 'setup', 1, 1, 1, 1
      );
    `);
    for (const [index, role] of [
      'tenant_core/default',
      'tenant_core/users',
      'tenant_pii',
    ].entries()) {
      const shardId = `shared-${index + 1}`;
      database
        .prepare(
          `INSERT INTO control_desired_resources (
             desired_resource_id, environment_id, resource_kind, logical_shard_id,
             deterministic_name, ownership_fingerprint, provisioning_state,
             origin_operation_id, provider_create_state, provider_resource_id,
             provider_identity_checkpointed_at, created_at, updated_at
           ) VALUES (?, 'env-test', 'd1', ?, ?, ?, 'active', 'fixture-shards',
                     'identified', ?, 1, 1, 1)`
        )
        .run(
          `desired-${index + 1}`,
          `logical-${index + 1}`,
          `database-${index + 1}`,
          `fingerprint-${index + 1}`,
          `provider-database-${index + 1}`
        );
      database
        .prepare(
          `INSERT INTO control_tenant_shards (
             shard_id, environment_id, data_role, residency_policy_id, residency_partition,
             generation, logical_shard_id, binding_ref, d1_desired_resource_id,
             status, created_at, updated_at, allocation_scope, owner_tenant_id
           ) VALUES (?, 'env-test', ?, 'default', 'jp', 1, ?, ?, ?, 'active', 1, 1,
                     'shared_pool', NULL)`
        )
        .run(
          shardId,
          role,
          `logical-${index + 1}`,
          `TDB_SHARED_${index + 1}`,
          `desired-${index + 1}`
        );
      database
        .prepare(
          `INSERT INTO control_tenant_shard_assignments (
             environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
             shard_id, assignment_generation, assignment_state, source_operation_id,
             created_at, activated_at, updated_at
           ) VALUES ('env-test', 'tenant-a', ?, 'default', 'jp', ?, 1, 'active',
                     'tenant-create-a', 1, 1, 1)`
        )
        .run(role, shardId);
    }
    service = new TenantPlacementMigrationService(d1(database), () => 100);
  });

  afterEach(() => database.close());

  const request = {
    tenantId: 'tenant-a',
    targetIsolationPolicy: 'tenant_exclusive' as const,
    idempotencyKey: 'placement-request-a',
    requestedById: 'admin-a',
  };

  it('starts from the complete active shared source set and marks policy migrating', async () => {
    const result = await service.start('env-test', request);

    expect(result).toMatchObject({
      tenantId: 'tenant-a',
      state: 'planning',
      sourceIsolationPolicy: 'shared_pool',
      targetIsolationPolicy: 'tenant_exclusive',
      sourcePolicyGeneration: 1,
      targetPolicyGeneration: 2,
      writeFenceState: 'inactive',
      canCancel: true,
    });
    expect(result.shards).toHaveLength(3);
    expect(result.shards.every((shard) => shard.state === 'target_pending')).toBe(true);
    expect(
      database
        .prepare(
          `SELECT isolation_policy, policy_state, pending_isolation_policy,
                  pending_policy_generation, migration_operation_id
             FROM control_tenant_placement_policies
            WHERE tenant_id = 'tenant-a'`
        )
        .get()
    ).toMatchObject({
      isolation_policy: 'shared_pool',
      policy_state: 'migrating',
      pending_isolation_policy: 'tenant_exclusive',
      pending_policy_generation: 2,
      migration_operation_id: result.operationId,
    });
  });

  it('returns the same operation after idempotent response loss retry', async () => {
    const first = await service.start('env-test', request);
    const second = await service.start('env-test', request);

    expect(second.operationId).toBe(first.operationId);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM control_tenant_placement_migrations').get()
    ).toEqual({ count: 1 });
  });

  it('blocks another migration while the tenant policy already has a pending target', async () => {
    await service.start('env-test', request);

    await expect(
      service.start('env-test', { ...request, idempotencyKey: 'placement-request-b' })
    ).rejects.toThrow('control_tenant_placement_migration_source_invalid');
  });

  it('blocks start when any required data role is absent', async () => {
    database
      .prepare(
        `DELETE FROM control_tenant_shard_assignments
          WHERE tenant_id = 'tenant-a' AND data_role = 'tenant_pii'`
      )
      .run();

    await expect(service.start('env-test', request)).rejects.toThrow(
      'control_tenant_placement_migration_source_incomplete'
    );
  });

  it('cancels before cutover and restores the shared policy atomically', async () => {
    const started = await service.start('env-test', request);
    const canceled = await service.cancel('env-test', {
      operationId: started.operationId,
      requestedById: 'admin-a',
      idempotencyKey: 'cancel-a',
    });

    expect(canceled).toMatchObject({ state: 'canceled', canCancel: false });
    expect(
      database
        .prepare(
          `SELECT isolation_policy, policy_state, pending_isolation_policy,
                  pending_policy_generation, migration_operation_id
             FROM control_tenant_placement_policies
            WHERE tenant_id = 'tenant-a'`
        )
        .get()
    ).toEqual({
      isolation_policy: 'shared_pool',
      policy_state: 'active',
      pending_isolation_policy: null,
      pending_policy_generation: null,
      migration_operation_id: null,
    });
    expect(
      database
        .prepare('SELECT status FROM control_operations WHERE operation_id = ?')
        .get(started.operationId)
    ).toEqual({ status: 'canceled' });
  });
});

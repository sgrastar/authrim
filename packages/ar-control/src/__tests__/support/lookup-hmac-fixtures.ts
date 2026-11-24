import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const KEY_A = {
  generation: 1,
  keyId: 'lookup-key-1',
  slot: 'A' as const,
  fingerprint: 'a'.repeat(64),
};
export const KEY_B = {
  generation: 2,
  keyId: 'lookup-key-2',
  slot: 'B' as const,
  fingerprint: 'b'.repeat(64),
};

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async run() {
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

export function hmacD1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

export function insertAuthoritativeShards(database: DatabaseSync): void {
  database.exec(
    `INSERT INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key, status,
       requested_by_type, attempt_count, created_at, started_at, completed_at, updated_at
     ) VALUES ('bootstrap', 'test', 'bootstrap', 'bootstrap', 'succeeded',
       'setup', 1, 1, 1, 1, 1);
     INSERT INTO control_environment_resource_policies (
       environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
       daily_d1_create_budget, target_account_count, created_at, updated_at
     ) VALUES ('test', 2, 2, 1000, 20, 100000, 1, 1);
     INSERT INTO control_residency_partitions (
       environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
     ) VALUES ('test', 'builtin:residency:default', 'default', 'active', 1, 1);
     INSERT INTO control_desired_resources (
       desired_resource_id, environment_id, resource_kind, logical_shard_id,
       deterministic_name, ownership_fingerprint, provisioning_state,
       origin_operation_id, provider_create_state, provider_resource_id,
       provider_identity_checkpointed_at, created_at, updated_at
     ) VALUES
       ('resource-core', 'test', 'd1', 'users-1', 'test-users-1', 'owner-core',
        'active', 'bootstrap', 'identified', 'database-core', 1, 1, 1),
       ('resource-pii', 'test', 'd1', 'pii-1', 'test-pii-1', 'owner-pii',
        'active', 'bootstrap', 'identified', 'database-pii', 1, 1, 1),
       ('resource-lookup', 'test', 'd1', 'lookup-1', 'test-lookup-1', 'owner-lookup',
        'active', 'bootstrap', 'identified', 'database-lookup', 1, 1, 1);
     INSERT INTO control_tenant_shards (
       shard_id, environment_id, data_role, residency_policy_id, residency_partition,
       generation, logical_shard_id, binding_ref, d1_desired_resource_id,
       status, created_at, updated_at
     ) VALUES
       ('users-1', 'test', 'tenant_core/users', 'builtin:residency:default', 'default',
        1, 'users-1', 'TDB_USERS_1', 'resource-core', 'active', 1, 1),
       ('pii-1', 'test', 'tenant_pii', 'builtin:residency:default', 'default',
        1, 'pii-1', 'TDB_PII_1', 'resource-pii', 'active', 1, 1);`
  );
  database.exec(
    `INSERT INTO control_lookup_physical_shards (
       lookup_shard_id, environment_id, residency_partition, binding_ref,
       d1_desired_resource_id, status, created_at, updated_at
     ) VALUES ('lookup-1', 'test', 'default', 'LOOKUP_DB_1',
       'resource-lookup', 'active', 1, 1)`
  );
}

/** A control database with one environment and the three authoritative shard kinds. */
export function hmacDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'), 'utf8')
  );
  database.exec(
    `INSERT INTO control_environments (
       environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
     ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1)`
  );
  return database;
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1ControlRepository } from '../repository';
import type { TenantShardPlan } from '../types';

type SqliteValue = string | number | null | Uint8Array;

function sqliteValues(values: unknown[]): SqliteValue[] {
  return values.map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      value === null ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_test_sqlite_value');
  });
}

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
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }

  executeRun() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(this.statement, sqliteValues(values));
  }
}

function d1Adapter(database: DatabaseSync): D1Database {
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

function plan(suffix: string): TenantShardPlan {
  return {
    operationId: `op-${suffix}`,
    desiredResourceId: `resource-${suffix}`,
    shardId: `shard-${suffix}`,
    environmentId: 'env-test',
    environmentName: 'test',
    dataRole: 'tenant_core/users',
    residencyPolicyId: 'default',
    residencyPartition: 'jp',
    logicalShardId: `users:jp:${suffix}`,
    databaseName: `authrim-test-users-jp-${suffix}`,
    bindingRef: `TDB_USERS_${suffix.toUpperCase()}`,
    ownershipFingerprint: `fingerprint-${suffix}`,
    locationHint: 'apac',
    readReplicationMode: 'disabled',
    idempotencyKey: `idempotency-${suffix}`,
  };
}

describe('D1ControlRepository lease and budget integration', () => {
  let database: DatabaseSync;
  let repository: D1ControlRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(process.cwd(), '../../migrations/control/001_control_plane.sql'), 'utf8')
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
       INSERT INTO control_environment_resource_policies (
         environment_id, max_concurrent_provisioning, max_ready_spares,
         max_d1_resources, daily_d1_create_budget, target_account_count,
         created_at, updated_at
       ) VALUES ('env-test', 2, 2, 10, 1, 100000, 1, 1);
       INSERT INTO control_residency_partitions (
         environment_id, residency_policy_id, residency_partition, location_hint,
         status, created_at, updated_at
       ) VALUES ('env-test', 'default', 'jp', 'apac', 'active', 1, 1);`
    );
    repository = new D1ControlRepository(d1Adapter(database));
  });

  afterEach(() => database.close());

  it('fences stale owners and records redacted retry audit evidence', async () => {
    const shardPlan = plan('one');
    await repository.createShardPlan(shardPlan, 100, 'admin');
    const firstLease = await repository.tryStartProvisioning(shardPlan.operationId, 'owner-a', 100);
    if (!firstLease) throw new Error('expected_first_lease');
    expect(await repository.tryStartProvisioning(shardPlan.operationId, 'owner-b', 101)).toBeNull();

    const takeover = await repository.tryStartProvisioning(shardPlan.operationId, 'owner-b', 401);
    if (!takeover) throw new Error('expected_takeover_lease');
    expect(takeover.fencingToken).toBe(2);
    await repository.markOperationBlocked(firstLease, 'stale_owner_must_not_win', 402);
    expect((await repository.getOperation(shardPlan.operationId))?.status).toBe('running');

    await repository.markOperationRetry(takeover, 'cloudflare_d1_request_failed', 500, 402);
    const state = await repository.getOperation(shardPlan.operationId);
    expect(state?.status).toBe('waiting');
    expect(state?.lastErrorCode).toBe('cloudflare_d1_request_failed');
    const audit = database
      .prepare(
        `SELECT outcome, redacted_payload_json FROM control_audit_events
          WHERE event_id = 'audit:op-one:2:retry'`
      )
      .get() as { outcome: string; redacted_payload_json: string };
    expect(audit.outcome).toBe('failed');
    expect(audit.redacted_payload_json).not.toContain('stale_owner_must_not_win');
  });

  it('atomically limits daily D1 create reservations across operations', async () => {
    const firstPlan = plan('one');
    const secondPlan = plan('two');
    await repository.createShardPlan(firstPlan, 100, 'scheduler');
    await repository.createShardPlan(secondPlan, 100, 'scheduler');
    const firstLease = await repository.tryStartProvisioning(firstPlan.operationId, 'owner-a', 100);
    const secondLease = await repository.tryStartProvisioning(
      secondPlan.operationId,
      'owner-b',
      100
    );
    if (!firstLease || !secondLease) throw new Error('expected_budget_test_leases');

    expect(await repository.reserveD1CreateBudget(firstLease, 100)).toBe(true);
    expect(await repository.reserveD1CreateBudget(firstLease, 101)).toBe(true);
    expect(await repository.reserveD1CreateBudget(secondLease, 101)).toBe(false);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM control_d1_create_budget_reservations').get()
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT actor_type FROM control_audit_events
            WHERE event_id = 'audit:op-two:requested'`
        )
        .get()
    ).toEqual({ actor_type: 'scheduler' });
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantProvisioningOperationRepository } from '../tenant-provisioning-operation';

type SqliteValue = string | number | bigint | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function values(input: readonly unknown[] = []): SqliteValue[] {
  return input.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError('unsupported SQLite value');
  });
}

class SqliteAdapter implements DatabaseAdapter {
  constructor(private readonly database: DatabaseSync) {}

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    return this.database.prepare(sql).all(...values(params)) as T[];
  }

  async queryOne<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    return (this.database.prepare(sql).get(...values(params)) as T | undefined) ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const result = this.database.prepare(sql).run(...values(params));
    return { success: true, rowsAffected: Number(result.changes) };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn({
        query: (sql, params) => this.query(sql, params),
        queryOne: (sql, params) => this.queryOne(sql, params),
        execute: (sql, params) => this.execute(sql, params),
      });
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return Promise.all(statements.map(({ sql, params }) => this.execute(sql, params)));
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'sqlite-test' };
  }

  getType(): string {
    return 'sqlite-test';
  }

  async close(): Promise<void> {}
}

describe('tenant provisioning operation repository', () => {
  let database: DatabaseSync;
  let repository: TenantProvisioningOperationRepository;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/admin/033_tenant_provisioning_operations.sql'),
        'utf8'
      )
    );
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/admin/034_tenant_placement_policy.sql'), 'utf8')
    );
    repository = new TenantProvisioningOperationRepository(new SqliteAdapter(database));
  });

  afterEach(() => database.close());

  async function create() {
    return repository.create({
      operationId: 'tenant-create-a',
      environmentId: 'test',
      tenantId: 'tenant-a',
      tenantCode: 'acme',
      tenantName: 'Acme',
      tenantDescription: null,
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      isolationPolicy: 'tenant_exclusive',
      requestHash: 'a'.repeat(64),
      idempotencyKey: 'request-a',
      createdBy: 'admin-a',
      now: 100,
    });
  }

  it('defaults an omitted placement policy to tenant-exclusive', () => {
    database
      .prepare(
        `INSERT INTO tenant_provisioning_operations (
           operation_id, environment_id, tenant_id, tenant_code, tenant_name,
           operation_kind, residency_policy_id, residency_partition, request_hash,
           idempotency_key, status, current_step, retry_budget_started_at,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'create', 'builtin:residency:default', 'default', ?, ?,
                   'queued', 'request_accepted', ?, ?, ?, ?)`
      )
      .run(
        'tenant-default-policy',
        'test',
        'tenant-default-policy',
        'tenant-default-policy',
        'Default Policy',
        'b'.repeat(64),
        'tenant-default-policy',
        100,
        'admin-a',
        100,
        100
      );

    expect(
      database
        .prepare(
          'SELECT isolation_policy FROM tenant_provisioning_operations WHERE operation_id = ?'
        )
        .get('tenant-default-policy')
    ).toEqual({ isolation_policy: 'tenant_exclusive' });
  });

  it('completes the current step and advances the operation to the next step', async () => {
    await create();
    const lease = await repository.claimNext('test', 'worker-a', 101);
    expect(lease).not.toBeNull();
    await repository.checkpoint(lease!, {
      step: 'request_accepted',
      nextStep: 'capacity_check',
      stepStatus: 'succeeded',
      operationStatus: 'running',
      now: 102,
    });

    const operation = await repository.get('tenant-create-a', 'test');
    expect(operation?.currentStep).toBe('capacity_check');
    expect(operation?.steps.find((step) => step.stepKey === 'request_accepted')?.status).toBe(
      'succeeded'
    );
    expect(operation?.steps.find((step) => step.stepKey === 'capacity_check')?.status).toBe(
      'queued'
    );
    const leaseRow = database
      .prepare('SELECT lease_expires_at FROM tenant_provisioning_operations WHERE operation_id = ?')
      .get('tenant-create-a') as { lease_expires_at: number };
    expect(leaseRow.lease_expires_at).toBe(162);
  });

  it('rejects a checkpoint from a stale fencing token', async () => {
    await create();
    const first = await repository.claimNext('test', 'worker-a', 101);
    expect(first).not.toBeNull();
    database
      .prepare(
        'UPDATE tenant_provisioning_operations SET lease_expires_at = ? WHERE operation_id = ?'
      )
      .run(101, 'tenant-create-a');
    const second = await repository.claimNext('test', 'worker-b', 102);
    expect(second?.fencingToken).toBe(2);

    await expect(
      repository.checkpoint(first!, {
        step: 'request_accepted',
        nextStep: 'capacity_check',
        stepStatus: 'succeeded',
        operationStatus: 'running',
        now: 103,
      })
    ).rejects.toThrow('tenant_provisioning_operation_stale_lease');
  });

  it('requeues only a blocked operation and clears its redacted error', async () => {
    await create();
    const lease = await repository.claimNext('test', 'worker-a', 101);
    await repository.checkpoint(lease!, {
      step: 'request_accepted',
      nextStep: 'capacity_check',
      stepStatus: 'blocked',
      operationStatus: 'blocked',
      now: 102,
      errorCode: 'control_capacity_blocked',
    });

    const retried = await repository.retryBlocked('tenant-create-a', 'test', 103);
    expect(retried).toMatchObject({
      status: 'waiting_retry',
      currentStep: 'capacity_check',
      retryBudgetStartedAt: 103,
      nextAttemptAt: 103,
      lastErrorCode: null,
    });
    expect(retried?.steps.find((step) => step.stepKey === 'capacity_check')).toMatchObject({
      status: 'waiting_retry',
      lastErrorCode: null,
    });
  });

  it('does not cancel a running operation but cancels a queued operation', async () => {
    await create();
    const lease = await repository.claimNext('test', 'worker-a', 101);
    await expect(repository.cancel('tenant-create-a', 'test', 102)).resolves.toBeNull();
    database
      .prepare(
        'UPDATE tenant_provisioning_operations SET status = ?, lease_owner = NULL WHERE operation_id = ?'
      )
      .run('waiting_retry', 'tenant-create-a');
    const canceled = await repository.cancel('tenant-create-a', 'test', 103);
    expect(canceled).toMatchObject({ status: 'canceled', completedAt: 103 });
    expect(lease?.fencingToken).toBe(1);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter, TransactionContext } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantPlacementMigrationJobRepository } from '../tenant-placement-migration-job';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function adapter(database: DatabaseSync): DatabaseAdapter {
  const result = {
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as never[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (database.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const executed = database.prepare(sql).run(...(params as never[]));
      return { success: true, rowsAffected: Number(executed.changes) };
    },
    async transaction<T>(fn: (tx: TransactionContext) => Promise<T>) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const value = await fn(result as unknown as TransactionContext);
        database.exec('COMMIT');
        return value;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    async batch() {
      throw new Error('not implemented');
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 0, type: 'sqlite-test' };
    },
    getType: () => 'sqlite-test',
    async close() {},
  };
  return result as unknown as DatabaseAdapter;
}

function insertJob(database: DatabaseSync, operationId: string, idempotencyKey: string) {
  database
    .prepare(
      `INSERT INTO tenant_placement_migration_jobs (
         operation_id, environment_id, tenant_id, control_operation_id,
         request_hash, idempotency_key, retry_budget_started_at,
         requested_by, created_at, updated_at
       ) VALUES (?, 'test', 'tenant-a', ?, ?, ?, 1, 'admin-a', 1, 1)`
    )
    .run(operationId, operationId, 'a'.repeat(64), idempotencyKey);
}

describe('tenant placement migration job schema', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/admin/035_tenant_placement_migration_jobs.sql'),
        'utf8'
      )
    );
  });

  afterEach(() => database.close());

  it('enforces ordered steps and one active job per tenant', () => {
    insertJob(database, 'placement-a', 'request-a');
    expect(() =>
      database
        .prepare(
          `UPDATE tenant_placement_migration_jobs
              SET current_step = 'commit_control' WHERE operation_id = 'placement-a'`
        )
        .run()
    ).toThrow('tenant_placement_migration_job_step_transition_invalid');
    expect(() => insertJob(database, 'placement-b', 'request-b')).toThrow(
      'UNIQUE constraint failed'
    );
  });

  it('retains a canceled job while allowing a new active attempt', () => {
    insertJob(database, 'placement-a', 'request-a');
    database
      .prepare(
        `UPDATE tenant_placement_migration_jobs
            SET status = 'canceled', active_job_key = NULL, completed_at = 2, updated_at = 2
          WHERE operation_id = 'placement-a'`
      )
      .run();
    insertJob(database, 'placement-b', 'request-b');

    expect(
      database
        .prepare(
          `SELECT operation_id, status, active_job_key
             FROM tenant_placement_migration_jobs ORDER BY operation_id`
        )
        .all()
    ).toEqual([
      { operation_id: 'placement-a', status: 'canceled', active_job_key: null },
      { operation_id: 'placement-b', status: 'queued', active_job_key: 'active' },
    ]);
  });

  it('claims with fencing and resumes from a persisted bounded Lookup cursor', async () => {
    const repository = new TenantPlacementMigrationJobRepository(adapter(database));
    await repository.create({
      operationId: 'placement-a',
      environmentId: 'test',
      tenantId: 'tenant-a',
      controlOperationId: 'placement-a',
      requestHash: 'a'.repeat(64),
      idempotencyKey: 'request-a',
      requestedBy: 'admin-a',
      now: 1,
    });
    const first = await repository.claimNext('test', 'worker-a', 2);
    expect(first?.fencingToken).toBe(1);
    await repository.checkpoint(first!, {
      currentStep: 'wait_control',
      nextStep: 'begin_route_cutover',
      status: 'running',
      now: 3,
    });
    await repository.checkpoint(first!, {
      currentStep: 'begin_route_cutover',
      nextStep: 'prepare_lookup',
      status: 'running',
      now: 4,
    });
    const lookupCursor = { rangesDigest: 'b'.repeat(64), rangeIndex: 2, rowId: 42 };
    await repository.checkpoint(first!, {
      currentStep: 'prepare_lookup',
      status: 'waiting_retry',
      now: 5,
      nextAttemptAt: 6,
      lookupCursor,
      processedLookupRows: 100,
      lookupCounter: 'prepared',
    });

    const second = await repository.claimNext('test', 'worker-b', 6);
    expect(second?.fencingToken).toBe(2);
    expect(second?.job).toMatchObject({
      currentStep: 'prepare_lookup',
      lookupCursor,
      lookupPreparedRowCount: 100,
    });
    await expect(
      repository.checkpoint(first!, {
        currentStep: 'prepare_lookup',
        status: 'waiting_retry',
        now: 7,
      })
    ).rejects.toThrow('tenant_placement_migration_job_stale_lease');
  });

  it('cancels a claimed pre-cutover job and releases its active slot', async () => {
    const repository = new TenantPlacementMigrationJobRepository(adapter(database));
    const created = await repository.create({
      operationId: 'placement-a',
      environmentId: 'test',
      tenantId: 'tenant-a',
      controlOperationId: 'placement-a',
      requestHash: 'a'.repeat(64),
      idempotencyKey: 'request-a',
      requestedBy: 'admin-a',
      now: 1,
    });
    expect(await repository.getByIdempotencyKey('request-a', 'test')).toEqual(created);
    expect(await repository.getLatestByTenant('tenant-a', 'test')).toEqual(created);

    await repository.claimNext('test', 'worker-a', 2);
    const canceled = await repository.cancel('placement-a', 'test', 3);
    expect(canceled).toMatchObject({
      status: 'canceled',
      completedAt: 3,
    });
    expect(await repository.getActiveByTenant('tenant-a', 'test')).toBeNull();

    await expect(repository.cancel('missing', 'test', 4)).rejects.toThrow(
      'tenant_placement_migration_job_cancel_conflict'
    );
  });
});

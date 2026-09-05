import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { D1BatchExecutionResult, D1BatchStatement } from '../core/cloudflare.js';
import { SetupWorkerDeploymentLeaseCoordinator } from '../core/worker-deployment-lease.js';

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
type SqlValue = string | number | bigint | null | Uint8Array;

function sqlValues(values: readonly unknown[] | undefined): SqlValue[] {
  return (values ?? []).map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError('unsupported test SQL value');
  });
}

function sqliteExecutor(database: DatabaseSync) {
  return async (
    _databaseId: string,
    batch: readonly D1BatchStatement[]
  ): Promise<D1BatchExecutionResult[]> => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const results = batch.map((statement) => {
        const prepared = database.prepare(statement.sql);
        const params = sqlValues(statement.params);
        const rows = /^\s*SELECT\b/iu.test(statement.sql)
          ? (prepared.all(...params) as unknown[])
          : (prepared.run(...params), []);
        return { success: true as const, results: rows };
      });
      database.exec('COMMIT');
      return results;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
}

describe('setup Worker deployment lease coordinator', () => {
  let database: DatabaseSync;
  let now: number;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(ROOT_DIR, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
    database.exec(`INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1)`);
    now = 100;
  });

  afterEach(() => database.close());

  function coordinator(operationId: string) {
    return new SetupWorkerDeploymentLeaseCoordinator({
      databaseId: '11111111-1111-1111-1111-111111111111',
      environmentId: 'env-test',
      actorId: 'setup:test',
      operationId,
      now: () => now,
      ttlSeconds: 60,
      executeBatch: sqliteExecutor(database),
    });
  }

  it('records a fenced deployment operation through mutation and completion', async () => {
    const owner = coordinator('op_setup_deploy_owner');
    const acquired = await owner.acquire({
      workerScriptName: 'test-ar-auth',
      expectedSourceVersionId: 'version-source',
    });
    expect(acquired).toMatchObject({ fencingToken: 1, mutationStarted: false });

    const started = await owner.markMutationStarted(acquired, 'deployment-source');
    expect(started.mutationStarted).toBe(true);
    const renewed = await owner.renew(started);
    expect(renewed.fencingToken).toBe(2);
    await owner.assertCurrent(renewed);
    await owner.release(renewed);
    await owner.complete(true);

    expect(
      database
        .prepare('SELECT status, requested_by_type FROM control_operations WHERE operation_id = ?')
        .get(owner.operationId)
    ).toEqual({ status: 'succeeded', requested_by_type: 'setup' });
    expect(
      database
        .prepare(
          `SELECT event_type, outcome FROM control_audit_events
            WHERE operation_id = ? ORDER BY created_at, event_id`
        )
        .all(owner.operationId)
    ).toEqual([
      { event_type: 'control.worker_deployment.setup.completed', outcome: 'succeeded' },
      { event_type: 'control.worker_deployment.setup.started', outcome: 'attempted' },
    ]);
  });

  it('rejects another owner until expiry and fences the stale owner after takeover', async () => {
    const first = coordinator('op_setup_deploy_first');
    const second = coordinator('op_setup_deploy_second');
    const firstLease = await first.acquire({
      workerScriptName: 'test-ar-token',
      expectedSourceVersionId: 'version-one',
    });
    await expect(
      second.acquire({
        workerScriptName: 'test-ar-token',
        expectedSourceVersionId: 'version-one',
      })
    ).rejects.toThrow('worker_deployment_lease_busy');

    now = 161;
    const takeover = await second.acquire({
      workerScriptName: 'test-ar-token',
      expectedSourceVersionId: 'version-two',
    });
    expect(takeover.fencingToken).toBe(2);
    await expect(first.assertCurrent(firstLease)).rejects.toThrow(
      'worker_deployment_lease_stale_fencing_token'
    );
    await second.release(takeover);
    await second.complete(false, 'deployment_failed');
    expect(
      database
        .prepare('SELECT status, last_error_code FROM control_operations WHERE operation_id = ?')
        .get(second.operationId)
    ).toEqual({ status: 'blocked', last_error_code: 'deployment_failed' });
  });

  it('takes over an unmutated lease after its setup operation is blocked', async () => {
    const failed = coordinator('op_setup_deploy_failed_preflight');
    const successor = coordinator('op_setup_deploy_successor');
    const failedLease = await failed.acquire({
      workerScriptName: 'test-ar-auth',
      expectedSourceVersionId: 'version-one',
    });
    await failed.complete(false, 'deployment_lease_acquire_failed');

    const takeover = await successor.acquire({
      workerScriptName: 'test-ar-auth',
      expectedSourceVersionId: 'version-one',
    });
    expect(takeover.fencingToken).toBe(failedLease.fencingToken + 1);
    await expect(failed.assertCurrent(failedLease)).rejects.toThrow(
      'worker_deployment_lease_stale_fencing_token'
    );
  });

  it('does not block or take over a lease after provider mutation started', async () => {
    const active = coordinator('op_setup_deploy_active_mutation');
    const contender = coordinator('op_setup_deploy_contender');
    const lease = await active.acquire({
      workerScriptName: 'test-ar-auth',
      expectedSourceVersionId: 'version-one',
    });
    await active.markMutationStarted(lease, 'deployment-one');

    await expect(active.complete(false, 'deployment_failed')).rejects.toThrow(
      'worker_deployment_operation_completion_failed'
    );
    await expect(
      contender.acquire({
        workerScriptName: 'test-ar-auth',
        expectedSourceVersionId: 'version-one',
      })
    ).rejects.toThrow('worker_deployment_lease_busy');
  });

  it('does not complete while an owned lease remains', async () => {
    const owner = coordinator('op_setup_deploy_incomplete');
    await owner.acquire({
      workerScriptName: 'test-ar-management',
      expectedSourceVersionId: 'version-source',
    });
    await expect(owner.complete(true)).rejects.toThrow(
      'worker_deployment_operation_completion_failed'
    );
  });

  it('rejects an invalid explicit Cloudflare account before any lease mutation', () => {
    expect(
      () =>
        new SetupWorkerDeploymentLeaseCoordinator({
          databaseId: '11111111-1111-1111-1111-111111111111',
          environmentId: 'env-test',
          actorId: 'setup:test',
          accountId: 'wrong-account',
        })
    ).toThrow('worker_deployment_lease_account_invalid');
  });

  it('recovers an operation initialization after the D1 response is lost', async () => {
    const execute = sqliteExecutor(database);
    let loseFirstResponse = true;
    const owner = new SetupWorkerDeploymentLeaseCoordinator({
      databaseId: '11111111-1111-1111-1111-111111111111',
      environmentId: 'env-test',
      actorId: 'setup:test',
      operationId: 'op_setup_deploy_response_loss',
      now: () => now,
      ttlSeconds: 60,
      executeBatch: async (databaseId, batch) => {
        const result = await execute(databaseId, batch);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error('simulated_response_loss');
        }
        return result;
      },
    });

    await expect(
      owner.acquire({
        workerScriptName: 'test-ar-auth',
        expectedSourceVersionId: 'version-source',
      })
    ).rejects.toThrow('simulated_response_loss');
    const recovered = await owner.acquire({
      workerScriptName: 'test-ar-auth',
      expectedSourceVersionId: 'version-source',
    });

    expect(recovered.fencingToken).toBe(1);
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM control_operations WHERE operation_id = ?')
        .get(owner.operationId)
    ).toEqual({ count: 1 });
  });
});

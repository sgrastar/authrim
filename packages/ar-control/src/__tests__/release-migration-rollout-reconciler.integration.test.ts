import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApplyMigrationReleaseInput } from '@authrim/ar-lib-core/control-plane';
import { ReleaseMigrationRolloutReconciler } from '../release-migration-rollout-reconciler';
import { D1ControlRepository } from '../repository';

type SqliteValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DIGEST = 'a'.repeat(64);
const RELEASE_ID = '0.5.0';
const OBJECT_KEY = `releases/${RELEASE_ID}/${DIGEST}/manifest.json`;
const OPERATION_ID = `op_release_rollout_${'b'.repeat(32)}`;

function applyControlMigrations(database: DatabaseSync): void {
  const directory = resolve(REPO_ROOT, 'migrations/control/d1');
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    database.exec(readFileSync(resolve(directory, file), 'utf8'));
  }
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[],
    private readonly readOnly: boolean
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

  execute() {
    if (this.readOnly) {
      return {
        success: true,
        results: this.statement.all(...this.values),
        meta: { changes: 0 },
      };
    }
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly readOnly: boolean
  ) {}

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
      }),
      this.readOnly
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(
        database.prepare(sql),
        /^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/iu.test(sql)
      );
    },
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
    INSERT INTO control_residency_partitions (
      environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
    ) VALUES ('env-test', 'default', 'jp', 'active', 1, 1);
    INSERT INTO control_environment_resource_policies (
      environment_id, max_concurrent_provisioning, max_ready_spares,
      max_d1_resources, daily_d1_create_budget, target_account_count,
      created_at, updated_at
    ) VALUES ('env-test', 4, 4, 100, 100, 100000, 1, 1);
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, completed_at, updated_at
    ) VALUES
      ('op-release', 'env-test', 'register_migration_release', 'release:${RELEASE_ID}',
       'succeeded', 'setup', 1, 1, 1, 1),
      ('op-origin', 'env-test', 'provision_shard', 'origin',
       'succeeded', 'setup', 1, 1, 1, 1),
      ('${OPERATION_ID}', 'env-test', 'release_migration_rollout',
       'release-rollout:${RELEASE_ID}:${DIGEST}', 'queued', 'setup', 0, 10, NULL, 10);
    INSERT INTO control_migration_release_catalog (
      environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
      state, active_stream_key, registered_by_operation_id, registered_at, activated_at
    ) VALUES
      ('env-test', 'core-d1', '${RELEASE_ID}', '${DIGEST}', '${OBJECT_KEY}',
       'active', 'active', 'op-release', 1, 1),
      ('env-test', 'pii-d1', '${RELEASE_ID}', '${DIGEST}', '${OBJECT_KEY}',
       'active', 'active', 'op-release', 1, 1),
      ('env-test', 'lookup-d1', '${RELEASE_ID}', '${DIGEST}', '${OBJECT_KEY}',
       'active', 'active', 'op-release', 1, 1);
    INSERT INTO control_release_migration_rollouts (
      operation_id, environment_id, source_version, target_version, release_id,
      manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
      admin_mutation_mode, handoff_state, active_environment_key, created_at, updated_at
    ) VALUES (
      '${OPERATION_ID}', 'env-test', '0.4.0', '${RELEASE_ID}', '${RELEASE_ID}',
      '${DIGEST}', '${OBJECT_KEY}', 'setup_then_control', 'after_required_databases',
      'read_only', 'requested', 'env-test', 10, 10
    );
    INSERT INTO control_operation_steps (
      operation_id, step_key, display_order, status, attempt_count, updated_at
    ) VALUES
      ('${OPERATION_ID}', 'apply_managed_migrations', 10, 'queued', 0, 10),
      ('${OPERATION_ID}', 'await_setup', 20, 'queued', 0, 10),
      ('${OPERATION_ID}', 'verify_release', 30, 'queued', 0, 10);
    INSERT INTO control_operation_release_pins (
      operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
    ) VALUES
      ('${OPERATION_ID}', 'env-test', 'core-d1', '${RELEASE_ID}', '${DIGEST}', 10),
      ('${OPERATION_ID}', 'env-test', 'pii-d1', '${RELEASE_ID}', '${DIGEST}', 10),
      ('${OPERATION_ID}', 'env-test', 'lookup-d1', '${RELEASE_ID}', '${DIGEST}', 10);
  `);
  addTenantTarget(database, 'core', 'tenant_core/default', 'CORE_TDB_1', 'db-core');
  addTenantTarget(database, 'pii', 'tenant_pii', 'PII_TDB_1', 'db-pii');
  addLookupTarget(database, 'lookup', 'LOOKUP_TDB_1', 'db-lookup');
}

function addDesiredResource(
  database: DatabaseSync,
  id: string,
  binding: string,
  databaseId: string
): void {
  database.exec(`
    INSERT INTO control_desired_resources (
      desired_resource_id, environment_id, resource_kind, logical_shard_id,
      deterministic_name, ownership_fingerprint, desired_state, provisioning_state,
      origin_operation_id, observed_resource_id, provider_create_state,
      provider_resource_id, provider_identity_checkpointed_at, created_at, updated_at
    ) VALUES (
      'resource-${id}', 'env-test', 'd1', '${id}', '${id}-database', '${'c'.repeat(64)}',
      'present', 'active', 'op-origin', 'observed-${id}', 'identified', '${databaseId}', 1, 1, 1
    );
    INSERT INTO control_observed_resources (
      observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
      provider_name, resource_kind, ownership_fingerprint, observed_state,
      observed_spec_json, observed_at
    ) VALUES (
      'observed-${id}', 'env-test', 'resource-${id}', '${databaseId}', '${id}-database',
      'd1', '${'c'.repeat(64)}', 'present', '{}', 1
    );
  `);
  expect(binding.length).toBeGreaterThan(0);
}

function addTenantTarget(
  database: DatabaseSync,
  id: string,
  dataRole: 'tenant_core/default' | 'tenant_pii',
  binding: string,
  databaseId: string
): void {
  addDesiredResource(database, id, binding, databaseId);
  database.exec(`
    INSERT INTO control_tenant_shards (
      shard_id, environment_id, data_role, residency_policy_id, residency_partition,
      generation, logical_shard_id, binding_ref, d1_desired_resource_id, status,
      created_at, updated_at
    ) VALUES (
      'shard-${id}', 'env-test', '${dataRole}', 'default', 'jp', 1, '${id}', '${binding}',
      'resource-${id}', 'active', 1, 1
    );
  `);
}

function addLookupTarget(
  database: DatabaseSync,
  id: string,
  binding: string,
  databaseId: string
): void {
  addDesiredResource(database, id, binding, databaseId);
  database.exec(`
    INSERT INTO control_lookup_physical_shards (
      lookup_shard_id, environment_id, residency_partition, binding_ref,
      d1_desired_resource_id, status, created_at, updated_at
    ) VALUES (
      'shard-${id}', 'env-test', 'jp', '${binding}', 'resource-${id}', 'active', 1, 1
    );
  `);
}

function addPendingTenantTarget(database: DatabaseSync, id: string): void {
  database.exec(`
    INSERT INTO control_desired_resources (
      desired_resource_id, environment_id, resource_kind, logical_shard_id,
      deterministic_name, ownership_fingerprint, desired_state, provisioning_state,
      origin_operation_id, created_at, updated_at
    ) VALUES (
      'resource-${id}', 'env-test', 'd1', '${id}', '${id}-database', '${'d'.repeat(64)}',
      'present', 'creating', 'op-origin', 1, 1
    );
    INSERT INTO control_tenant_shards (
      shard_id, environment_id, data_role, residency_policy_id, residency_partition,
      generation, logical_shard_id, binding_ref, d1_desired_resource_id, status,
      created_at, updated_at
    ) VALUES (
      'shard-${id}', 'env-test', 'tenant_core/default', 'default', 'jp', 1, '${id}',
      'PENDING_TDB_1', 'resource-${id}', 'provisioning', 1, 1
    );
  `);
}

describe('ReleaseMigrationRolloutReconciler', () => {
  let database: DatabaseSync;
  let currentTime: number;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    applyControlMigrations(database);
    currentTime = 100;
    seed(database);
  });

  afterEach(() => database.close());

  it('snapshots the managed inventory once and migrates targets with bounded parallelism', async () => {
    let active = 0;
    let maximumActive = 0;
    const applied: ApplyMigrationReleaseInput[] = [];
    const engine = {
      async apply(input: ApplyMigrationReleaseInput) {
        applied.push(input);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        active -= 1;
        return {
          streamId: input.pin.streamId,
          releaseId: input.pin.releaseId,
          manifestDigest: input.pin.manifestDigest,
          totalFiles: 2,
          appliedFiles: 1,
          skippedFiles: 1,
          responseLossRecoveries: 0,
          lastFilename: '002.sql',
        };
      },
    };
    const reconciler = new ReleaseMigrationRolloutReconciler(
      d1(database),
      engine,
      () => currentTime,
      { concurrency: 2, maxTargetsPerRun: 10 }
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      snapshots: 1,
      attempted: 3,
      succeeded: 3,
    });
    expect(maximumActive).toBe(2);
    expect(applied.map((entry) => entry.databaseId).sort()).toEqual([
      'db-core',
      'db-lookup',
      'db-pii',
    ]);
    expect(
      database
        .prepare(
          `SELECT handoff_state FROM control_release_migration_rollouts WHERE operation_id = ?`
        )
        .get(OPERATION_ID)
    ).toEqual({ handoff_state: 'awaiting_setup' });
    expect(
      database
        .prepare(
          `SELECT progress_current, progress_total, status FROM control_operation_steps
            WHERE operation_id = ? AND step_key = 'apply_managed_migrations'`
        )
        .get(OPERATION_ID)
    ).toEqual({ progress_current: 3, progress_total: 3, status: 'succeeded' });
    await expect(
      new D1ControlRepository(d1(database)).getReleaseMigrationRolloutStatus('env-test')
    ).resolves.toEqual({
      operationId: OPERATION_ID,
      sourceVersion: '0.4.0',
      targetVersion: RELEASE_ID,
      phase: 'awaiting_setup',
      completedTargets: 3,
      totalTargets: 3,
      blockedTargetCount: 0,
      blockedTargets: [],
      adminMutationMode: 'read_only',
      lastErrorCode: null,
      updatedAt: 100,
    });

    addTenantTarget(database, 'late', 'tenant_core/default', 'CORE_TDB_2', 'db-late');
    currentTime += 60;
    await reconciler.reconcile();
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_release_migration_targets`).get()
    ).toEqual({ count: 3 });
    expect(applied).toHaveLength(3);
  });

  it('retries transient target failures and resumes without reapplying completed targets', async () => {
    const attempts = new Map<string, number>();
    const engine = {
      async apply(input: ApplyMigrationReleaseInput) {
        const attempt = (attempts.get(input.databaseId) ?? 0) + 1;
        attempts.set(input.databaseId, attempt);
        if (input.databaseId === 'db-pii' && attempt === 1) {
          throw new Error('migration_d1_batch_failed');
        }
        return {
          streamId: input.pin.streamId,
          releaseId: input.pin.releaseId,
          manifestDigest: input.pin.manifestDigest,
          totalFiles: 1,
          appliedFiles: 1,
          skippedFiles: 0,
          responseLossRecoveries: 0,
          lastFilename: '001.sql',
        };
      },
    };
    const reconciler = new ReleaseMigrationRolloutReconciler(
      d1(database),
      engine,
      () => currentTime,
      { concurrency: 3, maxTargetsPerRun: 10 }
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ succeeded: 2, retried: 1 });
    const retry = database
      .prepare(
        `SELECT state, next_attempt_at FROM control_release_migration_targets
          WHERE operation_id = ? AND target_id = 'tenant:shard-pii'`
      )
      .get(OPERATION_ID) as { state: string; next_attempt_at: number };
    expect(retry.state).toBe('waiting_retry');
    currentTime = retry.next_attempt_at;

    await expect(reconciler.reconcile()).resolves.toMatchObject({ succeeded: 1 });
    expect(attempts.get('db-core')).toBe(1);
    expect(attempts.get('db-lookup')).toBe(1);
    expect(attempts.get('db-pii')).toBe(2);
    expect(
      database
        .prepare(
          `SELECT handoff_state FROM control_release_migration_rollouts WHERE operation_id = ?`
        )
        .get(OPERATION_ID)
    ).toEqual({ handoff_state: 'awaiting_setup' });
  });

  it('keeps an in-flight database in the frozen snapshot until its provider ID appears', async () => {
    addPendingTenantTarget(database, 'pending');
    const applied: string[] = [];
    const engine = {
      async apply(input: ApplyMigrationReleaseInput) {
        applied.push(input.databaseId);
        return {
          streamId: input.pin.streamId,
          releaseId: input.pin.releaseId,
          manifestDigest: input.pin.manifestDigest,
          totalFiles: 1,
          appliedFiles: 1,
          skippedFiles: 0,
          responseLossRecoveries: 0,
          lastFilename: '001.sql',
        };
      },
    };
    const reconciler = new ReleaseMigrationRolloutReconciler(
      d1(database),
      engine,
      () => currentTime,
      { maxTargetsPerRun: 10 }
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ succeeded: 3 });
    expect(
      database
        .prepare(
          `SELECT state, provider_database_id FROM control_release_migration_targets
            WHERE operation_id = ? AND target_id = 'tenant:shard-pending'`
        )
        .get(OPERATION_ID)
    ).toEqual({ state: 'waiting_retry', provider_database_id: null });
    expect(
      database
        .prepare(
          `SELECT handoff_state FROM control_release_migration_rollouts WHERE operation_id = ?`
        )
        .get(OPERATION_ID)
    ).toEqual({ handoff_state: 'database_rollout' });

    currentTime = 100 + 2 * 60 * 60;
    await reconciler.reconcile();
    expect(
      database
        .prepare(
          `SELECT handoff_state FROM control_release_migration_rollouts WHERE operation_id = ?`
        )
        .get(OPERATION_ID)
    ).toEqual({ handoff_state: 'blocked' });

    database.exec(`
      INSERT INTO control_observed_resources (
        observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
        provider_name, resource_kind, ownership_fingerprint, observed_state,
        observed_spec_json, observed_at
      ) VALUES (
        'observed-pending', 'env-test', 'resource-pending', 'db-pending', 'pending-database',
        'd1', '${'d'.repeat(64)}', 'present', '{}', 7301
      );
      UPDATE control_desired_resources
         SET observed_resource_id = 'observed-pending', provisioning_state = 'ready', updated_at = 7301
       WHERE desired_resource_id = 'resource-pending';
      UPDATE control_tenant_shards SET status = 'ready', updated_at = 7301
       WHERE shard_id = 'shard-pending';
    `);
    currentTime = 7301;
    await expect(reconciler.reconcile()).resolves.toMatchObject({ succeeded: 1 });
    expect(applied).toContain('db-pending');
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_release_migration_targets WHERE operation_id = ?`
        )
        .get(OPERATION_ID)
    ).toEqual({ count: 4 });
    expect(
      database
        .prepare(
          `SELECT handoff_state FROM control_release_migration_rollouts WHERE operation_id = ?`
        )
        .get(OPERATION_ID)
    ).toEqual({ handoff_state: 'awaiting_setup' });
  });

  it('fails closed when the Control migration executor is unavailable and resumes when restored', async () => {
    const unavailable = new ReleaseMigrationRolloutReconciler(
      d1(database),
      null,
      () => currentTime,
      { executorAvailable: false }
    );
    await expect(unavailable.reconcile()).resolves.toMatchObject({ snapshots: 1, blocked: 0 });
    expect(
      database
        .prepare(
          `SELECT handoff_state FROM control_release_migration_rollouts WHERE operation_id = ?`
        )
        .get(OPERATION_ID)
    ).toEqual({ handoff_state: 'blocked' });

    const engine = {
      async apply(input: ApplyMigrationReleaseInput) {
        return {
          streamId: input.pin.streamId,
          releaseId: input.pin.releaseId,
          manifestDigest: input.pin.manifestDigest,
          totalFiles: 1,
          appliedFiles: 1,
          skippedFiles: 0,
          responseLossRecoveries: 0,
          lastFilename: '001.sql',
        };
      },
    };
    currentTime += 1;
    const available = new ReleaseMigrationRolloutReconciler(
      d1(database),
      engine,
      () => currentTime,
      { executorAvailable: true, maxTargetsPerRun: 10 }
    );
    await expect(available.reconcile()).resolves.toMatchObject({ succeeded: 3 });
    expect(
      database
        .prepare(
          `SELECT handoff_state FROM control_release_migration_rollouts WHERE operation_id = ?`
        )
        .get(OPERATION_ID)
    ).toEqual({ handoff_state: 'awaiting_setup' });
  });

  it('audits and requeues exactly one operator-selected blocked release target', async () => {
    const unavailable = new ReleaseMigrationRolloutReconciler(
      d1(database),
      null,
      () => currentTime,
      { executorAvailable: false }
    );
    await unavailable.reconcile();
    database.exec(`
      UPDATE control_release_migration_targets
         SET state = 'blocked', attempt_count = 4,
             last_error_code = 'migration_history_checksum_mismatch', updated_at = 101
       WHERE operation_id = '${OPERATION_ID}' AND target_id = 'tenant:shard-pii';
      UPDATE control_operations
         SET status = 'blocked', last_error_code = 'migration_history_checksum_mismatch',
             updated_at = 101
       WHERE operation_id = '${OPERATION_ID}';
      UPDATE control_operation_steps
         SET status = 'blocked', progress_current = 0, progress_total = 3,
             last_error_code = 'migration_history_checksum_mismatch', updated_at = 101
       WHERE operation_id = '${OPERATION_ID}' AND step_key = 'apply_managed_migrations';
      UPDATE control_release_migration_rollouts
         SET handoff_state = 'blocked', updated_at = 101
       WHERE operation_id = '${OPERATION_ID}';
    `);
    const repository = new D1ControlRepository(d1(database));
    const request = {
      operationId: OPERATION_ID,
      targetId: 'tenant:shard-pii',
      requestedById: 'admin-1',
      reasonCode: 'operator_retry_release_target' as const,
      idempotencyKey: 'retry-pii-1',
    };

    await expect(
      repository.retryReleaseMigrationRolloutTarget(request, 'env-test', 102)
    ).resolves.toMatchObject({
      phase: 'blocked',
      blockedTargetCount: 2,
      adminMutationMode: 'read_only',
    });
    expect(
      database
        .prepare(
          `SELECT state, last_error_code FROM control_release_migration_targets
            WHERE operation_id = ? AND target_id = ?`
        )
        .get(OPERATION_ID, 'tenant:shard-pii')
    ).toEqual({ state: 'queued', last_error_code: null });
    expect(
      database
        .prepare(
          `SELECT event_type, actor_id, resource_id FROM control_audit_events
            WHERE event_id = ?`
        )
        .get('audit:env-test:release-target-retry:retry-pii-1')
    ).toEqual({
      event_type: 'control.release_migration.target_retry',
      actor_id: 'admin-1',
      resource_id: 'tenant:shard-pii',
    });
    await expect(
      repository.retryReleaseMigrationRolloutTarget(request, 'env-test', 103)
    ).resolves.toMatchObject({
      phase: 'blocked',
    });
  });
});

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
  describe('rollouts blocked because an older Control could not parse the manifest format', () => {
    const FORMAT_CODE = 'migration_artifact_manifest_invalid';

    function okEngine(applied: string[] = []) {
      return {
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
    }

    // What the previous Control did: every target hit the unparseable manifest and blocked.
    async function blockByOldControl(): Promise<void> {
      const old = new ReleaseMigrationRolloutReconciler(
        d1(database),
        {
          async apply() {
            throw new Error(FORMAT_CODE);
          },
        },
        () => currentTime,
        { maxTargetsPerRun: 10 }
      );
      await expect(old.reconcile()).resolves.toMatchObject({ snapshots: 1, blocked: 3 });
      expect(
        database
          .prepare(
            `SELECT handoff_state, (SELECT status FROM control_operations WHERE operation_id = ?)
                    AS operation_status,
                    (SELECT last_error_code FROM control_operations WHERE operation_id = ?)
                    AS operation_error
               FROM control_release_migration_rollouts WHERE operation_id = ?`
          )
          .get(OPERATION_ID, OPERATION_ID, OPERATION_ID)
      ).toEqual({
        handoff_state: 'blocked',
        operation_status: 'blocked',
        operation_error: FORMAT_CODE,
      });
    }

    function rolloutRows(): unknown {
      return {
        rollout: database
          .prepare(`SELECT * FROM control_release_migration_rollouts WHERE operation_id = ?`)
          .get(OPERATION_ID),
        operation: database
          .prepare(`SELECT * FROM control_operations WHERE operation_id = ?`)
          .get(OPERATION_ID),
        steps: database
          .prepare(`SELECT * FROM control_operation_steps WHERE operation_id = ? ORDER BY step_key`)
          .all(OPERATION_ID),
        targets: database
          .prepare(
            `SELECT * FROM control_release_migration_targets WHERE operation_id = ? ORDER BY target_id`
          )
          .all(OPERATION_ID),
      };
    }

    function resumeAudits(): number {
      return Number(
        (
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM control_audit_events
                WHERE event_type = 'control.release_migration.rollout_resumed'`
            )
            .get() as { count: number }
        ).count
      );
    }

    it('resumes and executes once this Control can read the same artifact', async () => {
      await blockByOldControl();
      currentTime += 30;
      const applied: string[] = [];
      const probed: Array<{ streamId: string; manifestObjectKey: string; source?: string }> = [];
      const current = new ReleaseMigrationRolloutReconciler(
        d1(database),
        okEngine(applied),
        () => currentTime,
        {
          maxTargetsPerRun: 10,
          artifactProbe: {
            async load(pin) {
              probed.push({
                streamId: pin.streamId,
                manifestObjectKey: pin.manifestObjectKey,
                source: pin.sourceProductVersion,
              });
              return {};
            },
          },
        }
      );

      await expect(current.reconcile()).resolves.toMatchObject({ succeeded: 3, blocked: 0 });

      expect(applied.sort()).toEqual(['db-core', 'db-lookup', 'db-pii']);
      expect(probed.map((entry) => entry.streamId).sort()).toEqual([
        'core-d1',
        'lookup-d1',
        'pii-d1',
      ]);
      expect(probed.every((entry) => entry.manifestObjectKey === OBJECT_KEY)).toBe(true);
      expect(probed.every((entry) => entry.source === '0.4.0')).toBe(true);
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
            `SELECT status, last_error_code FROM control_operation_steps
              WHERE operation_id = ? AND step_key = 'apply_managed_migrations'`
          )
          .get(OPERATION_ID)
      ).toEqual({ status: 'succeeded', last_error_code: null });
      expect(
        database
          .prepare(
            `SELECT DISTINCT retry_budget_started_at AS started FROM control_release_migration_targets
              WHERE operation_id = ?`
          )
          .all(OPERATION_ID)
      ).toEqual([{ started: 130 }]);
      expect(
        database
          .prepare(
            `SELECT actor_type, outcome, redacted_payload_json FROM control_audit_events
              WHERE event_type = 'control.release_migration.rollout_resumed'`
          )
          .all()
      ).toEqual([
        {
          actor_type: 'reconciler',
          outcome: 'succeeded',
          redacted_payload_json: JSON.stringify({
            reason_code: 'artifact_format_supported_after_control_update',
            previous_error_code: FORMAT_CODE,
            target_ids: ['lookup:shard-lookup', 'tenant:shard-core', 'tenant:shard-pii'],
          }),
        },
      ]);

      // Idempotent: a later cron run neither re-probes nor records another resume.
      currentTime += 60;
      await current.reconcile();
      expect(probed).toHaveLength(3);
      expect(resumeAudits()).toBe(1);
    });

    it('leaves the rollout untouched while the artifact still cannot be read', async () => {
      await blockByOldControl();
      const before = rolloutRows();
      currentTime += 30;
      const applied: string[] = [];
      const current = new ReleaseMigrationRolloutReconciler(
        d1(database),
        okEngine(applied),
        () => currentTime,
        {
          artifactProbe: {
            async load() {
              throw new Error(FORMAT_CODE);
            },
          },
        }
      );

      await expect(current.reconcile()).resolves.toMatchObject({ attempted: 0 });
      await expect(current.reconcile()).resolves.toMatchObject({ attempted: 0 });

      expect(applied).toEqual([]);
      expect(rolloutRows()).toEqual(before);
      expect(resumeAudits()).toBe(0);
    });

    it('does not resume when a target is blocked for another reason', async () => {
      await blockByOldControl();
      database.exec(`
        UPDATE control_release_migration_targets
           SET last_error_code = 'migration_history_checksum_mismatch'
         WHERE operation_id = '${OPERATION_ID}' AND target_id = 'tenant:shard-pii';
      `);
      const before = rolloutRows();
      currentTime += 30;
      let probes = 0;
      const current = new ReleaseMigrationRolloutReconciler(
        d1(database),
        okEngine(),
        () => currentTime,
        {
          artifactProbe: {
            async load() {
              probes += 1;
              return {};
            },
          },
        }
      );

      await expect(current.reconcile()).resolves.toMatchObject({ attempted: 0 });

      expect(probes).toBe(0);
      expect(rolloutRows()).toEqual(before);
      expect(resumeAudits()).toBe(0);
    });

    it('does not let permanently unreadable rollouts starve a later one', async () => {
      await blockByOldControl();
      // Two older rollouts (other environments) whose artifacts will never be readable.
      database.exec('PRAGMA foreign_keys = OFF');
      for (const id of ['x1', 'x2']) {
        const digest = (id === 'x1' ? '1' : '2').repeat(64);
        database.exec(`
          INSERT INTO control_operations (
            operation_id, environment_id, operation_kind, idempotency_key, status,
            last_error_code, requested_by_type, attempt_count, created_at, updated_at
          ) VALUES ('op-${id}', 'env-${id}', 'release_migration_rollout', 'key-${id}', 'blocked',
                    '${FORMAT_CODE}', 'setup', 1, 1, 1);
          INSERT INTO control_release_migration_rollouts (
            operation_id, environment_id, source_version, target_version, release_id,
            manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
            admin_mutation_mode, handoff_state, active_environment_key, created_at, updated_at
          ) VALUES ('op-${id}', 'env-${id}', '0.4.0', '${id}', '${id}', '${digest}',
                    'releases/${id}/${digest}/manifest.json', 'setup_then_control',
                    'after_required_databases', 'read_only', 'blocked', 'env-${id}', 1, 1);
          INSERT INTO control_release_migration_targets (
            operation_id, environment_id, target_id, target_kind, shard_id, desired_resource_id,
            provider_database_id, binding_ref, stream_id, release_id, manifest_digest, state,
            attempt_count, retry_budget_started_at, last_error_code, created_at, updated_at
          ) VALUES ('op-${id}', 'env-${id}', 'tenant:${id}', 'tenant_shard', '${id}', 'res-${id}',
                    'db-${id}', 'BIND_${id}', 'core-d1', '${id}', '${digest}', 'blocked', 1, 1,
                    '${FORMAT_CODE}', 1, 1);
        `);
      }
      const probe = {
        async load(pin: { releaseId: string }) {
          if (pin.releaseId.startsWith('x')) throw new Error(FORMAT_CODE);
          return {};
        },
      };
      const current = new ReleaseMigrationRolloutReconciler(
        d1(database),
        okEngine(),
        () => currentTime,
        { maxTargetsPerRun: 10, artifactProbe: probe }
      );

      // Only two candidates are examined per run, so the readable one is reached within a few
      // runs (it is missed by a run only one time in three).
      for (let run = 0; run < 40 && resumeAudits() === 0; run += 1) {
        currentTime += 30;
        await current.reconcile();
      }

      expect(resumeAudits()).toBe(1);
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
            `SELECT handoff_state FROM control_release_migration_rollouts WHERE operation_id = 'op-x1'`
          )
          .get()
      ).toEqual({ handoff_state: 'blocked' });
    });

    it('does not resume without an artifact probe or without a Control migration executor', async () => {
      await blockByOldControl();
      const before = rolloutRows();
      currentTime += 30;
      const probe = {
        async load() {
          return {};
        },
      };

      await new ReleaseMigrationRolloutReconciler(d1(database), okEngine(), () => currentTime)
        .reconcile()
        .catch(() => undefined);
      await new ReleaseMigrationRolloutReconciler(d1(database), null, () => currentTime, {
        executorAvailable: false,
        artifactProbe: probe,
      }).reconcile();

      expect(rolloutRows()).toEqual(before);
      expect(resumeAudits()).toBe(0);
    });
  });
  describe('rollouts bound to the target set Setup verified', () => {
    const MISMATCH_CODE = 'release_target_set_mismatch';
    const VERIFIED = [
      { streamId: 'core-d1', databaseId: 'db-core' },
      { streamId: 'pii-d1', databaseId: 'db-pii' },
      { streamId: 'lookup-d1', databaseId: 'db-lookup' },
    ];

    const IMMUTABLE_TRIGGER = 'trg_control_release_migration_rollout_expected_targets_immutable';

    /** Bind the set as Setup does at creation (the seed row is inserted without one). */
    function bind(expected: unknown): void {
      const trigger = database
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
        .get(IMMUTABLE_TRIGGER) as { sql: string };
      database.exec(`DROP TRIGGER ${IMMUTABLE_TRIGGER}`);
      database
        .prepare(`UPDATE control_release_migration_rollouts SET expected_targets_json = ?`)
        .run(JSON.stringify(expected));
      database.exec(trigger.sql);
    }

    function update(expected: unknown): void {
      database
        .prepare(`UPDATE control_release_migration_rollouts SET expected_targets_json = ?`)
        .run(JSON.stringify(expected));
    }

    function countingEngine(applied: string[] = []) {
      return {
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
    }

    function rolloutState() {
      return database
        .prepare(
          `SELECT rollout.handoff_state, operation.status AS operation_status,
                  operation.last_error_code AS operation_error,
                  operation.lock_owner AS lock_owner,
                  (SELECT status FROM control_operation_steps
                    WHERE operation_id = rollout.operation_id
                      AND step_key = 'apply_managed_migrations') AS step_status,
                  (SELECT COUNT(*) FROM control_release_migration_targets
                    WHERE operation_id = rollout.operation_id) AS target_count
             FROM control_release_migration_rollouts rollout
             JOIN control_operations operation ON operation.operation_id = rollout.operation_id
            WHERE rollout.operation_id = ?`
        )
        .get(OPERATION_ID);
    }

    function mismatchAudits(): { redacted_payload_json: string; outcome: string }[] {
      return database
        .prepare(
          `SELECT redacted_payload_json, outcome FROM control_audit_events
            WHERE operation_id = ? AND event_type = 'control.release_migration.target_set_mismatch'`
        )
        .all(OPERATION_ID) as { redacted_payload_json: string; outcome: string }[];
    }

    const BLOCKED_STATE = {
      handoff_state: 'blocked',
      operation_status: 'blocked',
      operation_error: MISMATCH_CODE,
      lock_owner: null,
      step_status: 'blocked',
      target_count: 0,
    };

    it('executes when the snapshot equals the verified set', async () => {
      bind(VERIFIED);
      const applied: string[] = [];
      const reconciler = new ReleaseMigrationRolloutReconciler(
        d1(database),
        countingEngine(applied),
        () => currentTime
      );

      await expect(reconciler.reconcile()).resolves.toMatchObject({
        snapshots: 1,
        succeeded: 3,
        blocked: 0,
      });
      expect(applied.sort()).toEqual(['db-core', 'db-lookup', 'db-pii']);
      expect(rolloutState()).toMatchObject({
        handoff_state: 'awaiting_setup',
        operation_error: null,
        target_count: 3,
      });
      expect(mismatchAudits()).toEqual([]);
    });

    it('blocks without executing when the snapshot holds a database that was not verified', async () => {
      bind(VERIFIED);
      // Control provisioned this tenant database after Setup's check, before its own snapshot.
      addTenantTarget(database, 'late', 'tenant_core/default', 'CORE_TDB_2', 'db-late');
      const applied: string[] = [];
      const reconciler = new ReleaseMigrationRolloutReconciler(
        d1(database),
        countingEngine(applied),
        () => currentTime
      );

      await expect(reconciler.reconcile()).resolves.toMatchObject({
        snapshots: 0,
        attempted: 0,
        succeeded: 0,
        blocked: 1,
      });

      expect(applied).toEqual([]);
      expect(rolloutState()).toEqual(BLOCKED_STATE);
      const audits = mismatchAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.outcome).toBe('blocked');
      expect(JSON.parse(audits[0].redacted_payload_json)).toEqual({
        reason_code: MISMATCH_CODE,
        expected_count: 3,
        snapshot_count: 4,
        unexpected_targets: [
          { target_id: 'tenant:shard-late', stream_id: 'core-d1', database_id: 'db-late' },
        ],
        missing_targets: [],
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM control_audit_events
              WHERE event_type = 'control.release_migration.targets_snapshotted'`
          )
          .get()
      ).toEqual({ count: 0 });
      await expect(
        new D1ControlRepository(d1(database)).getReleaseMigrationRolloutStatus('env-test')
      ).resolves.toMatchObject({
        phase: 'blocked',
        lastErrorCode: MISMATCH_CODE,
        blockedTargetCount: 0,
      });
    });

    it('blocks when a database Setup verified is missing from the snapshot', async () => {
      bind([...VERIFIED, { streamId: 'core-d1', databaseId: 'db-gone' }]);
      const applied: string[] = [];

      await new ReleaseMigrationRolloutReconciler(
        d1(database),
        countingEngine(applied),
        () => currentTime
      ).reconcile();

      expect(applied).toEqual([]);
      expect(rolloutState()).toEqual(BLOCKED_STATE);
      expect(JSON.parse(mismatchAudits()[0].redacted_payload_json)).toMatchObject({
        unexpected_targets: [],
        missing_targets: [{ stream_id: 'core-d1', database_id: 'db-gone' }],
      });
    });

    it('treats a database whose provider ID is not resolved yet as a difference', async () => {
      bind(VERIFIED);
      addPendingTenantTarget(database, 'pending');
      const applied: string[] = [];

      await new ReleaseMigrationRolloutReconciler(
        d1(database),
        countingEngine(applied),
        () => currentTime
      ).reconcile();

      expect(applied).toEqual([]);
      expect(rolloutState()).toEqual(BLOCKED_STATE);
    });

    it('treats a different database in the same stream as a difference', async () => {
      bind([
        { streamId: 'core-d1', databaseId: 'db-other' },
        { streamId: 'pii-d1', databaseId: 'db-pii' },
        { streamId: 'lookup-d1', databaseId: 'db-lookup' },
      ]);
      const applied: string[] = [];

      await new ReleaseMigrationRolloutReconciler(
        d1(database),
        countingEngine(applied),
        () => currentTime
      ).reconcile();

      expect(applied).toEqual([]);
      expect(rolloutState()).toEqual(BLOCKED_STATE);
    });

    it("keeps today's behavior when no target set is bound", async () => {
      addTenantTarget(database, 'late', 'tenant_core/default', 'CORE_TDB_2', 'db-late');
      const applied: string[] = [];

      await expect(
        new ReleaseMigrationRolloutReconciler(
          d1(database),
          countingEngine(applied),
          () => currentTime
        ).reconcile()
      ).resolves.toMatchObject({ snapshots: 1, succeeded: 4, blocked: 0 });

      expect(applied.sort()).toEqual(['db-core', 'db-late', 'db-lookup', 'db-pii']);
      expect(rolloutState()).toMatchObject({ handoff_state: 'awaiting_setup' });
    });

    it('is never auto-resumed, by any reconcile pass, executor, or artifact probe', async () => {
      bind(VERIFIED);
      addTenantTarget(database, 'late', 'tenant_core/default', 'CORE_TDB_2', 'db-late');
      const applied: string[] = [];
      const engine = countingEngine(applied);
      const probe = {
        async load() {
          return {};
        },
      };
      await new ReleaseMigrationRolloutReconciler(d1(database), engine, () => currentTime, {
        artifactProbe: probe,
      }).reconcile();
      const before = JSON.stringify(rolloutState());

      for (let run = 0; run < 3; run += 1) {
        currentTime += 3 * 60 * 60;
        await new ReleaseMigrationRolloutReconciler(d1(database), engine, () => currentTime, {
          artifactProbe: probe,
        }).reconcile();
        await new ReleaseMigrationRolloutReconciler(d1(database), null, () => currentTime, {
          executorAvailable: false,
        }).reconcile();
      }

      expect(applied).toEqual([]);
      expect(JSON.stringify(rolloutState())).toBe(before);
      expect(mismatchAudits()).toHaveLength(1);
    });

    it('does not let an operator target retry bypass the block', async () => {
      bind(VERIFIED);
      addTenantTarget(database, 'late', 'tenant_core/default', 'CORE_TDB_2', 'db-late');
      await new ReleaseMigrationRolloutReconciler(
        d1(database),
        countingEngine(),
        () => currentTime
      ).reconcile();
      // Even a blocked target row (none is kept, but a stale or hand-made one must not matter).
      database.exec(`
        INSERT INTO control_release_migration_targets (
          operation_id, environment_id, target_id, target_kind, shard_id,
          desired_resource_id, provider_database_id, binding_ref, stream_id,
          release_id, manifest_digest, state, attempt_count, retry_budget_started_at,
          last_error_code, created_at, updated_at
        ) VALUES (
          '${OPERATION_ID}', 'env-test', 'tenant:shard-late', 'tenant_shard', 'shard-late',
          'resource-late', 'db-late', 'CORE_TDB_2', 'core-d1', '${RELEASE_ID}', '${DIGEST}',
          'blocked', 1, 100, 'migration_history_checksum_mismatch', 100, 100
        );
      `);
      const repository = new D1ControlRepository(d1(database));
      const before = rolloutState();

      await expect(
        repository.retryReleaseMigrationRolloutTarget(
          {
            operationId: OPERATION_ID,
            targetId: 'tenant:shard-late',
            requestedById: 'admin-1',
            reasonCode: 'operator_retry_release_target' as const,
            idempotencyKey: 'retry-late-1',
          },
          'env-test',
          200
        )
      ).rejects.toThrow('control_release_rollout_retry_not_retryable');

      expect(rolloutState()).toEqual({ ...(before as object), target_count: 1 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM control_audit_events
              WHERE event_type = 'control.release_migration.target_retry'`
          )
          .get()
      ).toEqual({ count: 0 });
    });

    it('keeps the bound set immutable except for the re-arm of a mismatch block', async () => {
      bind(VERIFIED);
      expect(() => update([])).toThrow('control_release_migration_rollout_immutable');
      expect(() =>
        database
          .prepare(`UPDATE control_release_migration_rollouts SET expected_targets_json = NULL`)
          .run()
      ).toThrow('control_release_migration_rollout_immutable');
      expect(() =>
        database
          .prepare(`UPDATE control_release_migration_rollouts SET expected_targets_json = '{}'`)
          .run()
      ).toThrow(/CHECK constraint failed|immutable/u);

      addTenantTarget(database, 'late', 'tenant_core/default', 'CORE_TDB_2', 'db-late');
      await new ReleaseMigrationRolloutReconciler(
        d1(database),
        countingEngine(),
        () => currentTime
      ).reconcile();
      // Replacing the set without returning the rollout to 'requested' is still refused.
      expect(() => update([])).toThrow('control_release_migration_rollout_immutable');
      database
        .prepare(
          `UPDATE control_release_migration_rollouts
              SET expected_targets_json = ?, handoff_state = 'requested'`
        )
        .run(JSON.stringify([...VERIFIED, { streamId: 'core-d1', databaseId: 'db-late' }]));
    });

    it('decides a blocked snapshot from its own batch even when Setup re-arms right after it', async () => {
      bind(VERIFIED);
      addTenantTarget(database, 'late', 'tenant_core/default', 'CORE_TDB_2', 'db-late');
      const rearm = () =>
        database.exec(`
          UPDATE control_release_migration_rollouts
             SET handoff_state = 'requested', target_snapshot_at = NULL, updated_at = 150
           WHERE operation_id = '${OPERATION_ID}';
          UPDATE control_operations
             SET status = 'running', last_error_code = NULL, next_attempt_at = NULL,
                 lock_owner = 'setup:target-set-rearm', lock_expires_at = 1, updated_at = 150
           WHERE operation_id = '${OPERATION_ID}';
        `);
      const inner = d1(database);
      let pending = true;
      const racing = {
        prepare: (sql: string) => inner.prepare(sql),
        async batch(statements: never[]) {
          const result = await inner.batch(statements);
          // The snapshot batch has committed; Setup's re-arm lands before the reconciler looks again.
          if (pending && statements.length > 8) {
            pending = false;
            rearm();
          }
          return result;
        },
      } as unknown as D1Database;
      const applied: string[] = [];

      await expect(
        new ReleaseMigrationRolloutReconciler(
          racing,
          countingEngine(applied),
          () => currentTime
        ).reconcile()
      ).resolves.toMatchObject({ snapshots: 0, blocked: 1 });

      // The blocked snapshot was not advanced as if it were an empty, finished rollout.
      expect(
        database
          .prepare(
            `SELECT step_key, status FROM control_operation_steps
              WHERE operation_id = ? ORDER BY display_order`
          )
          .all(OPERATION_ID)
      ).toEqual([
        { step_key: 'apply_managed_migrations', status: 'blocked' },
        { step_key: 'await_setup', status: 'queued' },
        { step_key: 'verify_release', status: 'queued' },
      ]);
      expect(applied).toEqual([]);

      // A second mismatching snapshot of the re-armed rollout is reported as the mismatch.
      currentTime += 60;
      await new ReleaseMigrationRolloutReconciler(
        d1(database),
        countingEngine(applied),
        () => currentTime
      ).reconcile();
      expect(rolloutState()).toEqual(BLOCKED_STATE);
      await expect(
        new D1ControlRepository(d1(database)).getReleaseMigrationRolloutStatus('env-test')
      ).resolves.toMatchObject({ phase: 'blocked', lastErrorCode: MISMATCH_CODE });
      expect(applied).toEqual([]);
    });

    it('snapshots again after Setup re-arms the block with a recomputed set', async () => {
      bind(VERIFIED);
      addTenantTarget(database, 'late', 'tenant_core/default', 'CORE_TDB_2', 'db-late');
      const applied: string[] = [];
      const engine = countingEngine(applied);
      await new ReleaseMigrationRolloutReconciler(
        d1(database),
        engine,
        () => currentTime
      ).reconcile();
      expect(rolloutState()).toEqual(BLOCKED_STATE);

      // What Setup's handoff plan does for a fresh run with a recomputed set.
      currentTime += 120;
      database.exec(`
        UPDATE control_release_migration_rollouts
           SET expected_targets_json = '${JSON.stringify([
             ...VERIFIED,
             { streamId: 'core-d1', databaseId: 'db-late' },
           ])}',
               handoff_state = 'requested', target_snapshot_at = NULL, updated_at = ${currentTime}
         WHERE operation_id = '${OPERATION_ID}';
        UPDATE control_operations
           SET status = 'running', last_error_code = NULL, next_attempt_at = NULL,
               lock_owner = 'setup:target-set-rearm', lock_expires_at = 1, updated_at = ${currentTime}
         WHERE operation_id = '${OPERATION_ID}';
      `);
      await expect(
        new D1ControlRepository(d1(database)).getReleaseMigrationRolloutStatus('env-test')
      ).resolves.toMatchObject({ phase: 'database_rollout' });

      await expect(
        new ReleaseMigrationRolloutReconciler(d1(database), engine, () => currentTime).reconcile()
      ).resolves.toMatchObject({ snapshots: 1, succeeded: 4, blocked: 0 });

      expect(applied.sort()).toEqual(['db-core', 'db-late', 'db-lookup', 'db-pii']);
      expect(rolloutState()).toMatchObject({
        handoff_state: 'awaiting_setup',
        operation_error: null,
        step_status: 'succeeded',
        target_count: 4,
      });
      // The first (blocked) attempt left its own audit record; this run only added the snapshot's.
      expect(mismatchAudits()).toHaveLength(1);
    });
  });
});

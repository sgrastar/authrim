import { renderPortableMigrationSql } from '@authrim/ar-lib-core/control-plane';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReleaseArtifactStore } from '@authrim/ar-lib-core/control-plane';
// Control's own reconciler, as its cron runs it in an environment without Control tokens.
import { ReleaseMigrationRolloutReconciler } from '../../../ar-control/src/release-migration-rollout-reconciler';
import type { SetupOperatorD1Client } from '../core/control-operator-executor';
import { executeReleaseRolloutTargetsAsSetup } from '../core/release-rollout-setup-executor';

type SqlValue = string | number | bigint | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RELEASE_ID = '0.5.0';
const SQL = {
  'core-d1': 'CREATE TABLE core_release_marker (id TEXT PRIMARY KEY);',
  'pii-d1': 'CREATE TABLE pii_release_marker (id TEXT PRIMARY KEY);',
  'lookup-d1': 'CREATE TABLE lookup_release_marker (id TEXT PRIMARY KEY);',
} as const;
const MANIFEST = `${JSON.stringify({
  formatVersion: 2,
  productVersion: RELEASE_ID,
  streams: Object.entries(SQL).map(([id, sql]) => ({
    id,
    schemaFamily: id.replace('-d1', ''),
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: {
      'core-d1': ['core', 'tenant_core'],
      'pii-d1': ['pii', 'tenant_pii'],
      'lookup-d1': ['lookup'],
    }[id],
    files: [{ path: '001_marker.sql', checksum: createHash('sha256').update(sql).digest('hex') }],
  })),
})}\n`;
const DIGEST = createHash('sha256').update(MANIFEST).digest('hex');
const OBJECT_KEY = `releases/${RELEASE_ID}/${DIGEST}/manifest.json`;
const OPERATION_ID = `op_release_rollout_${'b'.repeat(32)}`;
const EXECUTOR_UNAVAILABLE = 'release_migration_executor_unavailable';
type ControlD1 = ConstructorParameters<typeof ReleaseMigrationRolloutReconciler>[0];

const artifactStore: ReleaseArtifactStore = {
  get: async (key) => {
    const objects = new Map<string, string>([[OBJECT_KEY, MANIFEST]]);
    for (const [stream, sql] of Object.entries(SQL)) {
      objects.set(`releases/${RELEASE_ID}/${DIGEST}/streams/${stream}/001_marker.sql`, sql);
    }
    const value = objects.get(key);
    if (value === undefined) return null;
    const bytes = new TextEncoder().encode(value);
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
  },
};

function statementResult(database: DatabaseSync, sql: string, params: unknown[] = []) {
  const statement = database.prepare(sql);
  const values = params as SqlValue[];
  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql))
    return { success: true, results: statement.all(...values), meta: { changes: 0 } };
  const run = statement.run(...values);
  return { success: true, results: [], meta: { changes: Number(run.changes) } };
}

function batchOn(database: DatabaseSync, batch: readonly { sql: string; params?: unknown[] }[]) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const results = batch.map(({ sql, params }) => statementResult(database, sql, params));
    database.exec('COMMIT');
    return results;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Control's D1 binding, for its reconciler. */
function controlBinding(
  database: DatabaseSync,
  hooks: { afterFirst?: (sql: string) => void } = {}
): ControlD1 {
  const bound = (statement: StatementSync, sql: string, values: SqlValue[]) => ({
    async first<T>() {
      const row = (statement.get(...values) as T | undefined) ?? null;
      hooks.afterFirst?.(sql);
      return row;
    },
    async all<T>() {
      return { success: true, results: statement.all(...values) as T[], meta: { changes: 0 } };
    },
    async run() {
      const result = statement.run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    },
    execute: () => statementResult(database, sql, values),
  });
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      return { bind: (...values: SqlValue[]) => bound(statement, sql, values) };
    },
    async batch(statements: Array<{ execute(): unknown }>) {
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
  } as unknown as ControlD1;
}

/** Setup's Cloudflare client: the Control database and the three managed databases. */
function setupClient(
  control: DatabaseSync,
  targets: Record<string, DatabaseSync>,
  options: {
    failOnce?: string;
    rejectAlways?: string;
    beforeApply?: () => Promise<void>;
    /** Stop before the first success reaches Control, as a process that dies there. */
    stopBeforeRecording?: boolean;
  } = {}
): SetupOperatorD1Client {
  let failed = false;
  const target = (databaseId: string) => {
    if (databaseId === 'control-db') return control;
    const database = targets[databaseId];
    if (!database) throw new Error(`unexpected_database:${databaseId}`);
    return database;
  };
  const failIfAsked = (databaseId: string) => {
    if (databaseId === options.rejectAlways)
      throw Object.assign(new Error('cloudflare_rejected'), { status: 400 });
    if (databaseId === options.failOnce && !failed) {
      failed = true;
      throw Object.assign(new Error('cloudflare_unavailable'), { status: 503 });
    }
  };
  return {
    async queryD1(databaseId: string, sql: string, params?: unknown[]) {
      failIfAsked(databaseId);
      return [statementResult(target(databaseId), sql, params)];
    },
    async queryD1Batch(databaseId: string, batch: readonly { sql: string; params?: unknown[] }[]) {
      if (databaseId !== 'control-db') await options.beforeApply?.();
      if (options.stopBeforeRecording && batch.some(({ sql }) => sql.includes("'succeeded'")))
        throw new Error('setup_stopped');
      return batchOn(target(databaseId), batch);
    },
  } as unknown as SetupOperatorD1Client;
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
      max_d1_resources, daily_d1_create_budget, target_account_count, created_at, updated_at
    ) VALUES ('env-test', 4, 4, 100, 100, 100000, 1, 1);
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, completed_at, updated_at
    ) VALUES
      ('op-release', 'env-test', 'register_migration_release', 'release:${RELEASE_ID}',
       'succeeded', 'setup', 1, 1, 1, 1),
      ('op-origin', 'env-test', 'provision_shard', 'origin', 'succeeded', 'setup', 1, 1, 1, 1),
      ('${OPERATION_ID}', 'env-test', 'release_migration_rollout',
       'release-rollout:${RELEASE_ID}:${DIGEST}', 'queued', 'setup', 0, 10, NULL, 10);
    INSERT INTO control_migration_release_catalog (
      environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
      state, active_stream_key, registered_by_operation_id, registered_at, activated_at
    ) VALUES
      ('env-test', 'core-d1', '${RELEASE_ID}', '${DIGEST}', '${OBJECT_KEY}', 'active', 'active', 'op-release', 1, 1),
      ('env-test', 'pii-d1', '${RELEASE_ID}', '${DIGEST}', '${OBJECT_KEY}', 'active', 'active', 'op-release', 1, 1),
      ('env-test', 'lookup-d1', '${RELEASE_ID}', '${DIGEST}', '${OBJECT_KEY}', 'active', 'active', 'op-release', 1, 1);
    INSERT INTO control_release_migration_rollouts (
      operation_id, environment_id, source_version, target_version, release_id,
      manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
      admin_mutation_mode, handoff_state, active_environment_key, created_at, updated_at
    ) VALUES (
      '${OPERATION_ID}', 'env-test', NULL, '${RELEASE_ID}', '${RELEASE_ID}',
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
  for (const [id, databaseId] of [
    ['core', 'db-core'],
    ['pii', 'db-pii'],
    ['lookup', 'db-lookup'],
  ] as const) {
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
  }
  database.exec(`
    INSERT INTO control_tenant_shards (
      shard_id, environment_id, data_role, residency_policy_id, residency_partition,
      generation, logical_shard_id, binding_ref, d1_desired_resource_id, status,
      created_at, updated_at
    ) VALUES
      ('shard-core', 'env-test', 'tenant_core/default', 'default', 'jp', 1, 'core',
       'CORE_TDB_1', 'resource-core', 'active', 1, 1),
      ('shard-pii', 'env-test', 'tenant_pii', 'default', 'jp', 1, 'pii',
       'PII_TDB_1', 'resource-pii', 'active', 1, 1);
    INSERT INTO control_lookup_physical_shards (
      lookup_shard_id, environment_id, residency_partition, binding_ref,
      d1_desired_resource_id, status, created_at, updated_at
    ) VALUES ('shard-lookup', 'env-test', 'jp', 'LOOKUP_TDB_1', 'resource-lookup', 'active', 1, 1);
  `);
}

describe('setup as the release migration executor of a Control without one', () => {
  let control: DatabaseSync;
  let targets: Record<string, DatabaseSync>;
  let clock: number;
  let reconciler: ReleaseMigrationRolloutReconciler;

  const rollout = () =>
    control
      .prepare(
        `SELECT rollout.handoff_state, operation.status, operation.last_error_code
           FROM control_release_migration_rollouts rollout
           JOIN control_operations operation ON operation.operation_id = rollout.operation_id
          WHERE rollout.operation_id = ?`
      )
      .get(OPERATION_ID);
  const targetStates = () =>
    control
      .prepare(
        `SELECT target_id, state, last_error_code, lease_owner IS NOT NULL AS leased
           FROM control_release_migration_targets WHERE operation_id = ? ORDER BY target_id`
      )
      .all(OPERATION_ID);
  const execute = (client: SetupOperatorD1Client, onTarget?: (done: number) => void) =>
    executeReleaseRolloutTargetsAsSetup({
      client,
      controlDatabaseId: 'control-db',
      environmentId: 'env-test',
      operationId: OPERATION_ID,
      artifactStore,
      now: () => clock,
      onTarget,
    });

  beforeEach(async () => {
    control = new DatabaseSync(':memory:');
    control.exec('PRAGMA foreign_keys = ON');
    const directory = resolve(REPO_ROOT, 'migrations/control/d1');
    for (const file of ['001_0_5_0_control_baseline.sql']) {
      control.exec(
        renderPortableMigrationSql(readFileSync(resolve(directory, file), 'utf8'), 'sqlite')
      );
    }
    seed(control);
    targets = {
      'db-core': new DatabaseSync(':memory:'),
      'db-pii': new DatabaseSync(':memory:'),
      'db-lookup': new DatabaseSync(':memory:'),
    };
    clock = 100;
    reconciler = new ReleaseMigrationRolloutReconciler(controlBinding(control), null, () => clock, {
      executorAvailable: false,
    });
    await reconciler.reconcile();
  });

  afterEach(() => {
    control.close();
    for (const database of Object.values(targets)) database.close();
  });

  it('applies the targets Control blocked and lets Control hand the rollout to setup', async () => {
    expect(rollout()).toEqual({
      handoff_state: 'blocked',
      status: 'blocked',
      last_error_code: EXECUTOR_UNAVAILABLE,
    });

    const execution = await execute(
      setupClient(control, targets, {
        // Control's cron runs while setup applies: it must neither re-block nor claim.
        beforeApply: async () => {
          await reconciler.reconcile();
        },
      })
    );
    expect(execution).toEqual({
      claimed: 3,
      nextAttemptAt: null,
      succeeded: 3,
      retried: 0,
      blocked: 0,
    });
    for (const [databaseId, table] of [
      ['db-core', 'core_release_marker'],
      ['db-pii', 'pii_release_marker'],
      ['db-lookup', 'lookup_release_marker'],
    ] as const) {
      expect(
        targets[databaseId]!.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?"
        ).get(table)
      ).toEqual({ name: table });
    }

    clock = 160;
    await reconciler.reconcile();
    expect(rollout()).toEqual({
      handoff_state: 'awaiting_setup',
      status: 'running',
      last_error_code: null,
    });
    expect(
      control
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
            WHERE operation_id = ? AND event_type = 'control.release_migration.target_applied'
              AND actor_type = 'setup'`
        )
        .get(OPERATION_ID)
    ).toEqual({ count: 3 });
  });

  it('retries a transient failure through Control blocking it again', async () => {
    const client = setupClient(control, targets, { failOnce: 'db-pii' });
    await expect(execute(client)).resolves.toEqual({
      claimed: 3,
      nextAttemptAt: null,
      succeeded: 2,
      retried: 1,
      blocked: 0,
    });
    const { next_attempt_at: retryAt } = control
      .prepare(
        `SELECT next_attempt_at FROM control_release_migration_targets
          WHERE operation_id = ? AND state = 'waiting_retry'`
      )
      .get(OPERATION_ID) as { next_attempt_at: number };
    expect(retryAt).toBeGreaterThan(clock);
    await reconciler.reconcile();
    expect(rollout()).toMatchObject({
      handoff_state: 'blocked',
      last_error_code: EXECUTOR_UNAVAILABLE,
    });

    // Control keeps the backoff when it blocks the target, and setup waits for it.
    await expect(execute(client)).resolves.toMatchObject({ claimed: 0, nextAttemptAt: retryAt });
    clock = retryAt;
    await expect(execute(client)).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    clock = retryAt + 60;
    await reconciler.reconcile();
    expect(rollout()).toMatchObject({ handoff_state: 'awaiting_setup' });
  });

  it('does not re-block a rollout from counts read before setup took the targets', async () => {
    // A Control run that counted the blocked targets just before setup claimed them.
    control.exec(`
      UPDATE control_operations SET status = 'running', last_error_code = NULL
       WHERE operation_id = '${OPERATION_ID}';
      UPDATE control_release_migration_rollouts SET handoff_state = 'database_rollout'
       WHERE operation_id = '${OPERATION_ID}';
    `);
    const stale = new ReleaseMigrationRolloutReconciler(
      controlBinding(control, {
        afterFirst: (sql) => {
          if (!sql.includes('AS blocked')) return;
          control.exec(`
            UPDATE control_release_migration_targets
               SET state = 'running', lease_owner = 'setup:release-migration:other',
                   lease_expires_at = ${clock + 900}, last_error_code = NULL
             WHERE operation_id = '${OPERATION_ID}';
          `);
        },
      }),
      null,
      () => clock,
      { executorAvailable: false }
    );
    await stale.reconcile();
    expect(rollout()).toEqual({
      handoff_state: 'database_rollout',
      status: 'running',
      last_error_code: null,
    });
  });

  it('reports a permanent failure even after Control re-blocked the rollout meanwhile', async () => {
    // One target still backs off; setup takes the other two.
    control
      .prepare(
        `UPDATE control_release_migration_targets SET next_attempt_at = ?
          WHERE operation_id = ? AND target_id = 'tenant:shard-pii'`
      )
      .run(clock + 3600, OPERATION_ID);
    const execution = await execute(
      setupClient(control, targets, {
        rejectAlways: 'db-core',
        beforeApply: async () => {
          await reconciler.reconcile();
        },
      })
    );
    expect(execution).toMatchObject({ claimed: 2, succeeded: 1, blocked: 1 });
    expect(rollout()).toEqual({
      handoff_state: 'blocked',
      status: 'blocked',
      last_error_code: 'cloudflare_d1_migration_rejected',
    });
  });

  it('takes nothing while another target waits for an operator', async () => {
    control
      .prepare(
        `UPDATE control_release_migration_targets
            SET last_error_code = 'cloudflare_d1_migration_rejected'
          WHERE operation_id = ? AND target_id = (
            SELECT MIN(target_id) FROM control_release_migration_targets WHERE operation_id = ?
          )`
      )
      .run(OPERATION_ID, OPERATION_ID);
    await expect(execute(setupClient(control, targets))).resolves.toMatchObject({ claimed: 0 });
    expect(targetStates()).toSatisfy((rows: Array<{ state: string; leased: number }>) =>
      rows.every((row) => row.state === 'blocked' && row.leased === 0)
    );
  });

  it('leaves targets to recovery when setup stops, and takes them again', async () => {
    const stopping = setupClient(control, targets, { stopBeforeRecording: true });
    await expect(execute(stopping)).rejects.toThrow('setup_stopped');
    expect(targetStates()).toSatisfy((rows: Array<{ state: string }>) =>
      rows.some((row) => row.state === 'running')
    );

    clock = 100 + 16 * 60;
    await reconciler.reconcile();
    expect(rollout()).toMatchObject({
      handoff_state: 'blocked',
      last_error_code: EXECUTOR_UNAVAILABLE,
    });
    // The target applied before the stop is applied again from its migration history.
    await expect(execute(setupClient(control, targets))).resolves.toMatchObject({ succeeded: 3 });
    clock += 60;
    await reconciler.reconcile();
    expect(rollout()).toMatchObject({ handoff_state: 'awaiting_setup' });
  });
});

import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1ControlRepository } from '../repository';
import { controlDatabase, d1Over, dropTriggers } from './support/sqlite-d1';

const DIGEST = 'c'.repeat(64);
type StepStatus = 'queued' | 'running' | 'succeeded' | 'blocked';

interface Shape {
  phase: string;
  operation: string;
  database: StepStatus;
  setup: StepStatus;
  verification: StepStatus;
  progress?: [number | null, number | null];
}

let database: DatabaseSync;
let repository: D1ControlRepository;

beforeEach(() => {
  database = controlDatabase();
  dropTriggers(database);
  repository = new D1ControlRepository(d1Over(database));
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1)`);
});

function seed(shape: Shape, mode = 'read_only', operationError: string | null = null): void {
  database
    .prepare(
      `INSERT INTO control_operations (
         operation_id, environment_id, operation_kind, idempotency_key, status, requested_by_type,
         attempt_count, release_id, release_stream_id, release_manifest_digest, last_error_code,
         created_at, updated_at, completed_at
       ) VALUES ('rollout', 'env-test', 'release_migration_rollout', 'k', ?, 'setup', 1, '0.5.0',
                 'all', ?, ?, 100, 120, ?)`
    )
    .run(shape.operation, DIGEST, operationError, shape.operation === 'succeeded' ? 120 : null);
  database
    .prepare(
      `INSERT INTO control_release_migration_rollouts (
         operation_id, environment_id, source_version, target_version, release_id, manifest_digest,
         manifest_r2_object_key, database_execution, worker_activation, admin_mutation_mode,
         handoff_state, active_environment_key, completed_at, created_at, updated_at
       ) VALUES ('rollout', 'env-test', '0.4.0', '0.5.0', '0.5.0', ?1, 'releases/0.5.0/' || ?1 || '/manifest.json',
                 'setup_then_control', 'after_required_databases', ?2, ?3, ?4, ?5, 100, 120)`
    )
    .run(
      DIGEST,
      mode,
      shape.phase,
      shape.phase === 'completed' ? 'completed:rollout' : 'env-test',
      shape.phase === 'completed' ? 120 : null
    );
  const [current, total] = shape.progress ?? [3, 3];
  const steps: [string, StepStatus, number | null, number | null][] = [
    ['apply_managed_migrations', shape.database, current, total],
    ['await_setup', shape.setup, null, null],
    ['verify_release', shape.verification, null, null],
  ];
  for (const [index, [key, status, done, count]] of steps.entries()) {
    database
      .prepare(
        `INSERT INTO control_operation_steps (
           operation_id, step_key, display_order, status, attempt_count, progress_current,
           progress_total, updated_at
         ) VALUES ('rollout', ?, ?, ?, 1, ?, ?, 120)`
      )
      .run(key, (index + 1) * 10, status, done, count);
  }
}

async function status() {
  return repository.getReleaseMigrationRolloutStatus('env-test');
}

describe('release rollout status consistency', () => {
  const consistent: [Shape, string][] = [
    [
      {
        phase: 'requested',
        operation: 'queued',
        database: 'queued',
        setup: 'queued',
        verification: 'queued',
        progress: [null, null],
      },
      'database_rollout',
    ],
    [
      {
        phase: 'requested',
        operation: 'running',
        database: 'blocked',
        setup: 'queued',
        verification: 'queued',
        progress: [null, null],
      },
      'database_rollout',
    ],
    [
      {
        phase: 'requested',
        operation: 'running',
        database: 'queued',
        setup: 'queued',
        verification: 'queued',
        progress: [0, 4],
      },
      'database_rollout',
    ],
    [
      {
        phase: 'database_rollout',
        operation: 'running',
        database: 'running',
        setup: 'queued',
        verification: 'queued',
        progress: [1, 4],
      },
      'database_rollout',
    ],
    [
      {
        phase: 'blocked',
        operation: 'blocked',
        database: 'blocked',
        setup: 'queued',
        verification: 'queued',
        progress: [1, 4],
      },
      'blocked',
    ],
    [
      {
        phase: 'awaiting_setup',
        operation: 'running',
        database: 'succeeded',
        setup: 'running',
        verification: 'queued',
      },
      'awaiting_setup',
    ],
    [
      {
        phase: 'verifying',
        operation: 'running',
        database: 'succeeded',
        setup: 'succeeded',
        verification: 'running',
      },
      'verifying',
    ],
    [
      {
        phase: 'completed',
        operation: 'succeeded',
        database: 'succeeded',
        setup: 'succeeded',
        verification: 'succeeded',
      },
      'completed',
    ],
  ];

  it.each(consistent)('accepts the consistent %j as %s', async (shape, phase) => {
    seed(shape);
    const result = await status();
    expect(result).toMatchObject({ phase, lastErrorCode: null });
    expect(result.completedTargets).toBe(shape.progress ? (shape.progress[0] ?? 0) : 3);
    expect(result.totalTargets).toBe(shape.progress ? (shape.progress[1] ?? 0) : 3);
    expect(result.adminMutationMode).toBe(phase === 'completed' ? 'available' : 'read_only');
  });

  const perturbed: [string, Shape][] = [];
  for (const [shape] of consistent) {
    const variants: [string, Partial<Shape>][] = [
      [
        'operation',
        { operation: shape.operation === 'waiting_retry' ? 'queued' : 'waiting_retry' },
      ],
      ['database step', { database: shape.database === 'running' ? 'succeeded' : 'running' }],
      ['setup step', { setup: shape.setup === 'succeeded' ? 'blocked' : 'succeeded' }],
      [
        'verification step',
        {
          verification: shape.verification === 'succeeded' ? 'blocked' : 'succeeded',
        },
      ],
    ];
    for (const [label, patch] of variants) {
      perturbed.push([`${shape.phase}/${shape.operation}: ${label}`, { ...shape, ...patch }]);
    }
  }

  it.each(perturbed)('fails closed for %s', async (_label, shape) => {
    seed(shape);
    const result = await status();
    expect(result).toMatchObject({
      phase: 'blocked',
      lastErrorCode: 'release_rollout_state_inconsistent',
    });
  });

  it.each([
    ['a requested rollout with only one progress side null', 'requested', [null, 3]],
    ['a rollout with null progress outside requested', 'database_rollout', [null, null]],
  ] as const)('fails closed for %s', async (_label, phase, progress) => {
    const operation = phase === 'requested' ? 'running' : 'running';
    seed({
      phase,
      operation,
      database: phase === 'requested' ? 'queued' : 'running',
      setup: 'queued',
      verification: 'queued',
      progress: [progress[0], progress[1]],
    });
    expect(await status()).toMatchObject({ phase: 'blocked' });
  });

  it('fails closed for a completed rollout whose progress is incomplete', async () => {
    seed({
      phase: 'completed',
      operation: 'succeeded',
      database: 'succeeded',
      setup: 'succeeded',
      verification: 'succeeded',
      progress: [2, 3],
    });
    expect(await status()).toMatchObject({
      phase: 'blocked',
      lastErrorCode: 'release_rollout_state_inconsistent',
    });
  });

  it('accepts an equal-progress database step at zero total', async () => {
    seed({
      phase: 'database_rollout',
      operation: 'running',
      database: 'running',
      setup: 'queued',
      verification: 'queued',
      progress: [0, 0],
    });
    expect(await status()).toMatchObject({ phase: 'database_rollout', completedTargets: 0 });
  });

  it('fails closed when a required step is missing', async () => {
    seed({
      phase: 'awaiting_setup',
      operation: 'running',
      database: 'succeeded',
      setup: 'running',
      verification: 'queued',
    });
    database.exec("DELETE FROM control_operation_steps WHERE step_key = 'verify_release'");
    expect(await status()).toMatchObject({ phase: 'blocked' });
    database.exec("DELETE FROM control_operation_steps WHERE step_key = 'await_setup'");
    expect(await status()).toMatchObject({ phase: 'blocked' });
    database.exec(
      "DELETE FROM control_operation_steps WHERE step_key = 'apply_managed_migrations'"
    );
    expect(await status()).toMatchObject({
      phase: 'blocked',
      completedTargets: 0,
      totalTargets: 0,
    });
  });

  it('reports a rollout without a handoff row as blocked and read-only', async () => {
    seed({
      phase: 'requested',
      operation: 'running',
      database: 'queued',
      setup: 'queued',
      verification: 'queued',
      progress: [null, null],
    });
    database.exec('DELETE FROM control_release_migration_rollouts');
    expect(await status()).toMatchObject({
      phase: 'blocked',
      sourceVersion: null,
      targetVersion: '0.5.0',
      adminMutationMode: 'read_only',
      lastErrorCode: 'release_rollout_state_inconsistent',
    });
  });

  describe('blocked targets', () => {
    const awaiting: Shape = {
      phase: 'awaiting_setup',
      operation: 'running',
      database: 'succeeded',
      setup: 'running',
      verification: 'queued',
    };

    function target(id: string, state: string, error: string | null, updatedAt: number) {
      database
        .prepare(
          `INSERT INTO control_release_migration_targets (
             operation_id, environment_id, target_id, target_kind, shard_id, desired_resource_id,
             binding_ref, stream_id, release_id, manifest_digest, state, attempt_count,
             retry_budget_started_at, last_error_code, created_at, updated_at
           ) VALUES ('rollout', 'env-test', ?1, 'tenant_shard', ?1, ?1, 'B', 'core-d1', '0.5.0',
                     '${DIGEST}', ?2, 2, 1, ?3, 1, ?4)`
        )
        .run(id, state, error, updatedAt);
    }

    it('turns a consistent rollout blocked and surfaces the first target error', async () => {
      seed(awaiting);
      target('t-b', 'blocked', 'migration_failed_b', 50);
      target('t-a', 'blocked', 'migration_failed_a', 50);
      target('t-old', 'blocked', 'migration_failed_old', 10);
      target('t-null', 'blocked', null, 5);
      target('t-queued', 'queued', 'ignored', 1);
      const result = await status();
      expect(result).toMatchObject({
        phase: 'blocked',
        lastErrorCode: 'migration_failed_old',
        blockedTargetCount: 4,
        adminMutationMode: 'read_only',
      });
      expect(result.blockedTargets).toEqual([
        {
          targetId: 't-old',
          streamId: 'core-d1',
          attemptCount: 2,
          lastErrorCode: 'migration_failed_old',
          updatedAt: 10,
        },
        {
          targetId: 't-a',
          streamId: 'core-d1',
          attemptCount: 2,
          lastErrorCode: 'migration_failed_a',
          updatedAt: 50,
        },
        {
          targetId: 't-b',
          streamId: 'core-d1',
          attemptCount: 2,
          lastErrorCode: 'migration_failed_b',
          updatedAt: 50,
        },
      ]);
    });

    it('prefers the operation error over a target error', async () => {
      seed(awaiting, 'read_only', 'operation_failed');
      target('t-a', 'blocked', 'migration_failed_a', 50);
      expect(await status()).toMatchObject({ lastErrorCode: 'operation_failed' });
    });

    it('limits the listed blocked targets to one hundred but counts all of them', async () => {
      seed(awaiting);
      for (let index = 0; index < 101; index += 1) {
        target(`t-${String(index).padStart(3, '0')}`, 'blocked', 'failed', index);
      }
      const result = await status();
      expect(result.blockedTargets).toHaveLength(100);
      expect(result.blockedTargetCount).toBe(101);
    });
  });

  it('keeps the persisted Admin mutation mode for an unfinished available rollout', async () => {
    seed(
      {
        phase: 'verifying',
        operation: 'running',
        database: 'succeeded',
        setup: 'succeeded',
        verification: 'running',
      },
      'available'
    );
    expect(await status()).toMatchObject({ adminMutationMode: 'available', phase: 'verifying' });
  });
});

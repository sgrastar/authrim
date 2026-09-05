import {
  decideControlProvisioningFailure,
  type ApplyMigrationReleaseInput,
  type ApplyMigrationReleaseResult,
} from '@authrim/ar-lib-core/control-plane';
import type { D1Result } from '@cloudflare/workers-types';

const SNAPSHOT_LEASE_SECONDS = 60;
const TARGET_LEASE_SECONDS = 5 * 60;
const PENDING_PROVIDER_RETRY_SECONDS = 30;
const PENDING_PROVIDER_BUDGET_SECONDS = 2 * 60 * 60;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_TARGETS_PER_RUN = 16;

interface ReleaseMigrationEngine {
  apply(input: ApplyMigrationReleaseInput): Promise<ApplyMigrationReleaseResult>;
}

interface ReconcilerOptions {
  concurrency?: number;
  maxTargetsPerRun?: number;
  executorAvailable?: boolean;
}

interface SnapshotCandidate extends Record<string, unknown> {
  operation_id: string;
  environment_id: string;
}

interface TargetCandidate extends Record<string, unknown> {
  operation_id: string;
  environment_id: string;
  target_id: string;
  provider_database_id: string;
  stream_id: 'd1-core' | 'd1-pii' | 'd1-lookup';
  release_id: string;
  manifest_digest: string;
  manifest_r2_object_key: string;
  source_version: string | null;
  attempt_count: number;
  retry_budget_started_at: number;
  created_at: number;
}

interface ClaimedTarget extends TargetCandidate {
  leaseOwner: string;
  fencingToken: number;
}

export interface ReleaseMigrationRolloutReconcileResult {
  snapshots: number;
  attempted: number;
  succeeded: number;
  retried: number;
  blocked: number;
  awaitingSetup: number;
}

function changes(result: D1Result<unknown>): number {
  const count = result.meta?.changes;
  return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error('release_migration_rollout_reconciler_limit_invalid');
  }
  return value;
}

export class ReleaseMigrationRolloutReconciler {
  private readonly concurrency: number;
  private readonly maxTargetsPerRun: number;
  private readonly executorAvailable: boolean;

  constructor(
    private readonly db: D1Database,
    private readonly engine: ReleaseMigrationEngine | null,
    private readonly now: () => number,
    options: ReconcilerOptions = {}
  ) {
    this.concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY, 16);
    this.maxTargetsPerRun = positiveInteger(
      options.maxTargetsPerRun,
      DEFAULT_MAX_TARGETS_PER_RUN,
      128
    );
    this.executorAvailable = options.executorAvailable ?? engine !== null;
    if (this.executorAvailable && !this.engine) {
      throw new Error('release_migration_rollout_engine_required');
    }
  }

  async reconcile(): Promise<ReleaseMigrationRolloutReconcileResult> {
    const now = this.now();
    await this.recoverExpiredTargetLeases(now);
    await this.refreshPendingProviders(now);
    await this.resumeProviderBlockedRollouts(now);
    if (this.executorAvailable) await this.resumeExecutorBlockedRollouts(now);

    let snapshots = 0;
    const candidates = await this.db
      .prepare(
        `SELECT rollout.operation_id, rollout.environment_id
           FROM control_release_migration_rollouts rollout
           JOIN control_operations operation ON operation.operation_id = rollout.operation_id
          WHERE rollout.handoff_state = 'requested'
            AND (
              operation.status = 'queued' OR
              (operation.status = 'running' AND operation.lock_expires_at IS NOT NULL
                AND operation.lock_expires_at <= ?)
            )
          ORDER BY rollout.created_at, rollout.operation_id
          LIMIT 4`
      )
      .bind(now)
      .all<SnapshotCandidate>();
    for (const candidate of candidates.results) {
      if (await this.snapshotOperation(candidate, now)) snapshots += 1;
    }

    if (!this.executorAvailable) {
      await this.blockExecutorUnavailable(now);
    }

    const runnable = await this.db
      .prepare(
        `SELECT target.operation_id, target.environment_id, target.target_id,
                target.provider_database_id, target.stream_id, target.release_id,
                target.manifest_digest, rollout.manifest_r2_object_key,
                rollout.source_version,
                target.attempt_count, target.retry_budget_started_at, target.created_at
           FROM control_release_migration_targets target
           JOIN control_release_migration_rollouts rollout
             ON rollout.operation_id = target.operation_id
           JOIN control_operations operation ON operation.operation_id = target.operation_id
          WHERE rollout.handoff_state = 'database_rollout' AND operation.status = 'running'
            AND target.provider_database_id IS NOT NULL
            AND (
              target.state = 'queued' OR
              (target.state = 'waiting_retry' AND target.next_attempt_at IS NOT NULL
                AND target.next_attempt_at <= ?)
            )
          ORDER BY target.updated_at, target.operation_id, target.target_id
          LIMIT ?`
      )
      .bind(now, this.maxTargetsPerRun)
      .all<TargetCandidate>();

    let next = 0;
    let succeeded = 0;
    let retried = 0;
    let blocked = 0;
    const workers = Array.from(
      { length: Math.min(this.concurrency, runnable.results.length) },
      async () => {
        while (next < runnable.results.length) {
          const candidate = runnable.results[next++];
          const result = await this.reconcileTarget(candidate);
          if (result === 'succeeded') succeeded += 1;
          else if (result === 'retried') retried += 1;
          else if (result === 'blocked') blocked += 1;
        }
      }
    );
    await Promise.all(workers);

    const awaitingSetup = await this.advanceActiveOperations(this.now());
    return {
      snapshots,
      attempted: succeeded + retried + blocked,
      succeeded,
      retried,
      blocked,
      awaitingSetup,
    };
  }

  private async snapshotOperation(candidate: SnapshotCandidate, now: number): Promise<boolean> {
    const leaseOwner = `release-snapshot:${crypto.randomUUID()}`;
    const claim = await this.db
      .prepare(
        `UPDATE control_operations
            SET status = 'running', attempt_count = attempt_count + 1,
                lock_owner = ?, lock_expires_at = ?, fencing_token = fencing_token + 1,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND environment_id = ?
            AND operation_kind = 'release_migration_rollout'
            AND (
              status = 'queued' OR
              (status = 'running' AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?)
            )
            AND EXISTS (
              SELECT 1 FROM control_release_migration_rollouts rollout
               WHERE rollout.operation_id = control_operations.operation_id
                 AND rollout.handoff_state = 'requested'
            )`
      )
      .bind(
        leaseOwner,
        now + SNAPSHOT_LEASE_SECONDS,
        now,
        now,
        candidate.operation_id,
        candidate.environment_id,
        now
      )
      .run();
    if (changes(claim) !== 1) return false;
    const lease = await this.db
      .prepare(
        `SELECT fencing_token FROM control_operations
          WHERE operation_id = ? AND environment_id = ? AND lock_owner = ?`
      )
      .bind(candidate.operation_id, candidate.environment_id, leaseOwner)
      .first<{ fencing_token: number }>();
    if (!lease) return false;
    const guarded = `EXISTS (
      SELECT 1 FROM control_operations operation
       WHERE operation.operation_id = ? AND operation.environment_id = ?
         AND operation.lock_owner = ? AND operation.fencing_token = ?
    )`;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_release_migration_targets (
             operation_id, environment_id, target_id, target_kind, shard_id,
             desired_resource_id, provider_database_id, binding_ref, stream_id,
             release_id, manifest_digest, state, attempt_count, retry_budget_started_at,
             next_attempt_at, last_error_code, created_at, updated_at
           )
           SELECT rollout.operation_id, rollout.environment_id, 'tenant:' || shard.shard_id,
                  'tenant_shard', shard.shard_id, desired.desired_resource_id,
                  observed.provider_resource_id, shard.binding_ref,
                  CASE WHEN shard.data_role = 'tenant_pii' THEN 'd1-pii' ELSE 'd1-core' END,
                  pin.release_id, pin.manifest_digest,
                  CASE WHEN observed.provider_resource_id IS NULL
                    THEN 'waiting_retry' ELSE 'queued' END,
                  0, ?, CASE WHEN observed.provider_resource_id IS NULL THEN ? ELSE NULL END,
                  CASE WHEN observed.provider_resource_id IS NULL
                    THEN 'release_target_provider_database_pending' ELSE NULL END,
                  ?, ?
             FROM control_release_migration_rollouts rollout
             JOIN control_tenant_shards shard
               ON shard.environment_id = rollout.environment_id
              AND shard.status IN ('requested', 'provisioning', 'ready', 'active', 'degraded')
             JOIN control_desired_resources desired
               ON desired.desired_resource_id = shard.d1_desired_resource_id
              AND desired.environment_id = shard.environment_id
              AND desired.desired_state = 'present'
        LEFT JOIN control_observed_resources observed
               ON observed.observed_resource_id = desired.observed_resource_id
              AND observed.environment_id = desired.environment_id
              AND observed.resource_kind = 'd1' AND observed.observed_state = 'present'
             JOIN control_operation_release_pins pin
               ON pin.operation_id = rollout.operation_id
              AND pin.stream_id = CASE WHEN shard.data_role = 'tenant_pii'
                THEN 'd1-pii' ELSE 'd1-core' END
            WHERE rollout.operation_id = ? AND rollout.environment_id = ? AND ${guarded}`
        )
        .bind(
          now,
          now + PENDING_PROVIDER_RETRY_SECONDS,
          now,
          now,
          candidate.operation_id,
          candidate.environment_id,
          candidate.operation_id,
          candidate.environment_id,
          leaseOwner,
          lease.fencing_token
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_release_migration_targets (
             operation_id, environment_id, target_id, target_kind, shard_id,
             desired_resource_id, provider_database_id, binding_ref, stream_id,
             release_id, manifest_digest, state, attempt_count, retry_budget_started_at,
             next_attempt_at, last_error_code, created_at, updated_at
           )
           SELECT rollout.operation_id, rollout.environment_id,
                  'lookup:' || shard.lookup_shard_id, 'lookup_shard', shard.lookup_shard_id,
                  desired.desired_resource_id, observed.provider_resource_id,
                  shard.binding_ref, 'd1-lookup', pin.release_id, pin.manifest_digest,
                  CASE WHEN observed.provider_resource_id IS NULL
                    THEN 'waiting_retry' ELSE 'queued' END,
                  0, ?, CASE WHEN observed.provider_resource_id IS NULL THEN ? ELSE NULL END,
                  CASE WHEN observed.provider_resource_id IS NULL
                    THEN 'release_target_provider_database_pending' ELSE NULL END,
                  ?, ?
             FROM control_release_migration_rollouts rollout
             JOIN control_lookup_physical_shards shard
               ON shard.environment_id = rollout.environment_id
              AND shard.status IN ('requested', 'provisioning', 'ready', 'active', 'draining')
             JOIN control_desired_resources desired
               ON desired.desired_resource_id = shard.d1_desired_resource_id
              AND desired.environment_id = shard.environment_id
              AND desired.desired_state = 'present'
        LEFT JOIN control_observed_resources observed
               ON observed.observed_resource_id = desired.observed_resource_id
              AND observed.environment_id = desired.environment_id
              AND observed.resource_kind = 'd1' AND observed.observed_state = 'present'
             JOIN control_operation_release_pins pin
               ON pin.operation_id = rollout.operation_id AND pin.stream_id = 'd1-lookup'
            WHERE rollout.operation_id = ? AND rollout.environment_id = ? AND ${guarded}`
        )
        .bind(
          now,
          now + PENDING_PROVIDER_RETRY_SECONDS,
          now,
          now,
          candidate.operation_id,
          candidate.environment_id,
          candidate.operation_id,
          candidate.environment_id,
          leaseOwner,
          lease.fencing_token
        ),
      this.db
        .prepare(
          `UPDATE control_release_migration_rollouts
              SET handoff_state = 'database_rollout', target_snapshot_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND handoff_state = 'requested'
              AND ${guarded}`
        )
        .bind(
          now,
          now,
          candidate.operation_id,
          candidate.environment_id,
          candidate.operation_id,
          candidate.environment_id,
          leaseOwner,
          lease.fencing_token
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  progress_current = 0,
                  progress_total = (SELECT COUNT(*) FROM control_release_migration_targets
                    WHERE operation_id = ?),
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'apply_managed_migrations'
              AND status = 'queued' AND ${guarded}`
        )
        .bind(
          candidate.operation_id,
          now,
          now,
          candidate.operation_id,
          candidate.operation_id,
          candidate.environment_id,
          leaseOwner,
          lease.fencing_token
        ),
      this.db
        .prepare(
          `UPDATE control_operations SET lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND lock_owner = ? AND fencing_token = ?`
        )
        .bind(
          now,
          candidate.operation_id,
          candidate.environment_id,
          leaseOwner,
          lease.fencing_token
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, ?, 'control.release_migration.targets_snapshotted', 'reconciler',
                    'release_migration_rollout', ?, 'succeeded',
                    json_object('target_count', COUNT(*)), ?
               FROM control_release_migration_targets
              WHERE operation_id = ?`
        )
        .bind(
          `audit:${candidate.operation_id}:targets-snapshotted`,
          candidate.environment_id,
          candidate.operation_id,
          candidate.operation_id,
          now,
          candidate.operation_id
        ),
    ]);
    await this.advanceOperation(candidate.operation_id, now);
    return true;
  }

  private async claimTarget(candidate: TargetCandidate): Promise<ClaimedTarget | null> {
    const now = this.now();
    const leaseOwner = `release-migration:${crypto.randomUUID()}`;
    const result = await this.db
      .prepare(
        `UPDATE control_release_migration_targets
            SET state = 'running', attempt_count = attempt_count + 1,
                next_attempt_at = NULL, lease_owner = ?, lease_expires_at = ?,
                fencing_token = fencing_token + 1, last_error_code = NULL,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND target_id = ?
            AND (
              state = 'queued' OR
              (state = 'waiting_retry' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
            )
            AND EXISTS (
              SELECT 1 FROM control_release_migration_rollouts rollout
              JOIN control_operations operation ON operation.operation_id = rollout.operation_id
               WHERE rollout.operation_id = control_release_migration_targets.operation_id
                 AND rollout.handoff_state = 'database_rollout'
                 AND operation.status = 'running'
            )`
      )
      .bind(
        leaseOwner,
        now + TARGET_LEASE_SECONDS,
        now,
        now,
        candidate.operation_id,
        candidate.target_id,
        now
      )
      .run();
    if (changes(result) !== 1) return null;
    const row = await this.db
      .prepare(
        `SELECT fencing_token, attempt_count FROM control_release_migration_targets
          WHERE operation_id = ? AND target_id = ? AND lease_owner = ? AND state = 'running'`
      )
      .bind(candidate.operation_id, candidate.target_id, leaseOwner)
      .first<{ fencing_token: number; attempt_count: number }>();
    return row
      ? {
          ...candidate,
          attempt_count: row.attempt_count,
          leaseOwner,
          fencingToken: row.fencing_token,
        }
      : null;
  }

  private async reconcileTarget(
    candidate: TargetCandidate
  ): Promise<'succeeded' | 'retried' | 'blocked' | 'skipped'> {
    const claimed = await this.claimTarget(candidate);
    if (!claimed) return 'skipped';
    try {
      const engine = this.engine;
      if (!engine) throw new Error('release_migration_rollout_engine_unavailable');
      const result = await engine.apply({
        databaseId: claimed.provider_database_id,
        pin: {
          environmentId: claimed.environment_id,
          streamId: claimed.stream_id,
          releaseId: claimed.release_id,
          manifestDigest: claimed.manifest_digest,
          manifestObjectKey: claimed.manifest_r2_object_key,
          ...(claimed.source_version ? { sourceProductVersion: claimed.source_version } : {}),
        },
      });
      const now = this.now();
      const updated = await this.db
        .prepare(
          `UPDATE control_release_migration_targets
              SET state = 'succeeded', expected_file_count = ?, applied_file_count = ?,
                  skipped_file_count = ?, response_loss_recoveries = ?, last_filename = ?,
                  last_error_code = NULL, lease_owner = NULL, lease_expires_at = NULL,
                  completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND target_id = ? AND state = 'running'
              AND lease_owner = ? AND fencing_token = ?`
        )
        .bind(
          result.totalFiles,
          result.appliedFiles,
          result.skippedFiles,
          result.responseLossRecoveries,
          result.lastFilename,
          now,
          now,
          claimed.operation_id,
          claimed.target_id,
          claimed.leaseOwner,
          claimed.fencingToken
        )
        .run();
      if (changes(updated) !== 1) throw new Error('release_migration_target_lease_lost');
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'control.release_migration.target_applied', 'reconciler',
             'd1', ?, 'succeeded', ?, ?)`
        )
        .bind(
          `audit:${claimed.operation_id}:${claimed.target_id}:${claimed.fencingToken}:succeeded`,
          claimed.environment_id,
          claimed.operation_id,
          claimed.provider_database_id,
          JSON.stringify({
            target_id: claimed.target_id,
            stream_id: claimed.stream_id,
            release_id: claimed.release_id,
            total_files: result.totalFiles,
            applied_files: result.appliedFiles,
            skipped_files: result.skippedFiles,
          }),
          now
        )
        .run();
      return 'succeeded';
    } catch (error) {
      const failedAt = this.now();
      const decision = decideControlProvisioningFailure({
        effect: 'apply_migrations',
        operation: {
          operationId: `${claimed.operation_id}:${claimed.target_id}`,
          attemptCount: claimed.attempt_count,
          retryBudgetStartedAt: claimed.retry_budget_started_at,
          createdAt: claimed.created_at,
        },
        error,
        failedAt,
      });
      const state = decision.disposition === 'retry' ? 'waiting_retry' : 'blocked';
      const updated = await this.db
        .prepare(
          `UPDATE control_release_migration_targets
              SET state = ?, next_attempt_at = ?, last_error_code = ?,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND target_id = ? AND state = 'running'
              AND lease_owner = ? AND fencing_token = ?`
        )
        .bind(
          state,
          decision.nextAttemptAt,
          decision.code,
          failedAt,
          claimed.operation_id,
          claimed.target_id,
          claimed.leaseOwner,
          claimed.fencingToken
        )
        .run();
      if (changes(updated) !== 1) return 'skipped';
      return decision.disposition === 'retry' ? 'retried' : 'blocked';
    } finally {
      await this.advanceOperation(claimed.operation_id, this.now());
    }
  }

  private async recoverExpiredTargetLeases(now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_release_migration_targets
            SET state = 'waiting_retry', next_attempt_at = ?,
                last_error_code = 'release_migration_target_lease_expired',
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
      )
      .bind(now, now, now)
      .run();
  }

  private async refreshPendingProviders(now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_release_migration_targets
            SET provider_database_id = (
                  SELECT observed.provider_resource_id
                    FROM control_desired_resources desired
                    JOIN control_observed_resources observed
                      ON observed.observed_resource_id = desired.observed_resource_id
                     AND observed.environment_id = desired.environment_id
                   WHERE desired.desired_resource_id =
                         control_release_migration_targets.desired_resource_id
                     AND desired.environment_id = control_release_migration_targets.environment_id
                     AND observed.resource_kind = 'd1' AND observed.observed_state = 'present'
                   LIMIT 1
                ),
                state = 'queued', next_attempt_at = NULL, last_error_code = NULL, updated_at = ?
          WHERE provider_database_id IS NULL AND state IN ('waiting_retry', 'blocked')
            AND last_error_code IN (
              'release_target_provider_database_pending',
              'release_target_provider_database_unavailable'
            )
            AND EXISTS (
              SELECT 1
                FROM control_desired_resources desired
                JOIN control_observed_resources observed
                  ON observed.observed_resource_id = desired.observed_resource_id
                 AND observed.environment_id = desired.environment_id
               WHERE desired.desired_resource_id =
                     control_release_migration_targets.desired_resource_id
                 AND desired.environment_id = control_release_migration_targets.environment_id
                 AND observed.resource_kind = 'd1' AND observed.observed_state = 'present'
            )`
      )
      .bind(now)
      .run();
    await this.db
      .prepare(
        `UPDATE control_release_migration_targets
            SET state = 'blocked', next_attempt_at = NULL,
                last_error_code = 'release_target_provider_database_unavailable', updated_at = ?
          WHERE provider_database_id IS NULL AND state = 'waiting_retry'
            AND last_error_code = 'release_target_provider_database_pending'
            AND retry_budget_started_at + ? <= ?`
      )
      .bind(now, PENDING_PROVIDER_BUDGET_SECONDS, now)
      .run();
  }

  private async resumeProviderBlockedRollouts(now: number): Promise<void> {
    const operations = await this.db
      .prepare(
        `SELECT rollout.operation_id
           FROM control_release_migration_rollouts rollout
           JOIN control_operations operation ON operation.operation_id = rollout.operation_id
          WHERE rollout.handoff_state = 'blocked' AND operation.status = 'blocked'
            AND operation.last_error_code = 'release_target_provider_database_unavailable'
            AND NOT EXISTS (
              SELECT 1 FROM control_release_migration_targets target
               WHERE target.operation_id = rollout.operation_id AND target.state = 'blocked'
            )`
      )
      .bind()
      .all<{ operation_id: string }>();
    for (const operation of operations.results) {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET status = 'running', last_error_code = NULL, updated_at = ?
              WHERE operation_id = ? AND step_key = 'apply_managed_migrations'
                AND status = 'blocked'`
          )
          .bind(now, operation.operation_id),
        this.db
          .prepare(
            `UPDATE control_operations
                SET status = 'running', last_error_code = NULL, updated_at = ?
              WHERE operation_id = ? AND status = 'blocked'
                AND last_error_code = 'release_target_provider_database_unavailable'`
          )
          .bind(now, operation.operation_id),
        this.db
          .prepare(
            `UPDATE control_release_migration_rollouts
                SET handoff_state = 'database_rollout', updated_at = ?
              WHERE operation_id = ? AND handoff_state = 'blocked'`
          )
          .bind(now, operation.operation_id),
      ]);
    }
  }

  private async blockExecutorUnavailable(now: number): Promise<void> {
    const operations = await this.db
      .prepare(
        `SELECT DISTINCT rollout.operation_id
           FROM control_release_migration_rollouts rollout
           JOIN control_release_migration_targets target
             ON target.operation_id = rollout.operation_id
          WHERE rollout.handoff_state = 'database_rollout'
            AND target.provider_database_id IS NOT NULL
            AND target.state IN ('queued', 'waiting_retry')`
      )
      .bind()
      .all<{ operation_id: string }>();
    for (const operation of operations.results) {
      await this.db
        .prepare(
          `UPDATE control_release_migration_targets
              SET state = 'blocked', next_attempt_at = NULL,
                  last_error_code = 'release_migration_executor_unavailable', updated_at = ?
            WHERE operation_id = ? AND provider_database_id IS NOT NULL
              AND state IN ('queued', 'waiting_retry')`
        )
        .bind(now, operation.operation_id)
        .run();
      await this.advanceOperation(operation.operation_id, now);
    }
  }

  private async resumeExecutorBlockedRollouts(now: number): Promise<void> {
    const operations = await this.db
      .prepare(
        `SELECT rollout.operation_id
           FROM control_release_migration_rollouts rollout
           JOIN control_operations operation ON operation.operation_id = rollout.operation_id
          WHERE rollout.handoff_state = 'blocked' AND operation.status = 'blocked'
            AND operation.last_error_code = 'release_migration_executor_unavailable'
            AND NOT EXISTS (
              SELECT 1 FROM control_release_migration_targets target
               WHERE target.operation_id = rollout.operation_id
                 AND target.state = 'blocked'
                 AND target.last_error_code <> 'release_migration_executor_unavailable'
            )`
      )
      .bind()
      .all<{ operation_id: string }>();
    for (const operation of operations.results) {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE control_release_migration_targets
                SET state = 'queued', last_error_code = NULL, updated_at = ?
              WHERE operation_id = ? AND state = 'blocked'
                AND last_error_code = 'release_migration_executor_unavailable'`
          )
          .bind(now, operation.operation_id),
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET status = 'running', last_error_code = NULL, updated_at = ?
              WHERE operation_id = ? AND step_key = 'apply_managed_migrations'
                AND status = 'blocked'`
          )
          .bind(now, operation.operation_id),
        this.db
          .prepare(
            `UPDATE control_operations
                SET status = 'running', last_error_code = NULL, updated_at = ?
              WHERE operation_id = ? AND status = 'blocked'
                AND last_error_code = 'release_migration_executor_unavailable'`
          )
          .bind(now, operation.operation_id),
        this.db
          .prepare(
            `UPDATE control_release_migration_rollouts
                SET handoff_state = 'database_rollout', updated_at = ?
              WHERE operation_id = ? AND handoff_state = 'blocked'`
          )
          .bind(now, operation.operation_id),
      ]);
    }
  }

  private async advanceActiveOperations(now: number): Promise<number> {
    const operations = await this.db
      .prepare(
        `SELECT operation_id FROM control_release_migration_rollouts
          WHERE handoff_state = 'database_rollout' ORDER BY created_at, operation_id`
      )
      .bind()
      .all<{ operation_id: string }>();
    let awaitingSetup = 0;
    for (const operation of operations.results) {
      if (await this.advanceOperation(operation.operation_id, now)) awaitingSetup += 1;
    }
    return awaitingSetup;
  }

  private async advanceOperation(operationId: string, now: number): Promise<boolean> {
    const counts = await this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked,
                MIN(CASE WHEN state = 'blocked' THEN last_error_code END) AS error_code
           FROM control_release_migration_targets WHERE operation_id = ?`
      )
      .bind(operationId)
      .first<{
        total: number;
        succeeded: number | null;
        blocked: number | null;
        error_code: string | null;
      }>();
    if (!counts) return false;
    const total = counts.total;
    const succeeded = counts.succeeded ?? 0;
    const blocked = counts.blocked ?? 0;
    await this.db
      .prepare(
        `UPDATE control_operation_steps
            SET progress_current = ?, progress_total = ?, updated_at = ?
          WHERE operation_id = ? AND step_key = 'apply_managed_migrations'
            AND status = 'running'`
      )
      .bind(succeeded, total, now, operationId)
      .run();
    if (blocked > 0) {
      const errorCode = counts.error_code ?? 'release_migration_target_blocked';
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET status = 'blocked', last_error_code = ?, updated_at = ?
              WHERE operation_id = ? AND step_key = 'apply_managed_migrations'
                AND status = 'running'`
          )
          .bind(errorCode, now, operationId),
        this.db
          .prepare(
            `UPDATE control_operations
                SET status = 'blocked', last_error_code = ?,
                    lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
              WHERE operation_id = ? AND status = 'running'`
          )
          .bind(errorCode, now, operationId),
        this.db
          .prepare(
            `UPDATE control_release_migration_rollouts
                SET handoff_state = 'blocked', updated_at = ?
              WHERE operation_id = ? AND handoff_state = 'database_rollout'`
          )
          .bind(now, operationId),
      ]);
      return false;
    }
    if (succeeded !== total) return false;
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', progress_current = ?, progress_total = ?,
                  last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = 'apply_managed_migrations'
              AND status = 'running'`
        )
        .bind(total, total, now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  progress_current = 0, progress_total = 1,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'await_setup' AND status = 'queued'`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_release_migration_rollouts
              SET handoff_state = 'awaiting_setup', updated_at = ?
            WHERE operation_id = ? AND handoff_state = 'database_rollout'
              AND NOT EXISTS (
                SELECT 1 FROM control_release_migration_targets target
                 WHERE target.operation_id = ? AND target.state <> 'succeeded'
              )`
        )
        .bind(now, operationId, operationId),
      this.db
        .prepare(
          `UPDATE control_operations SET last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND status = 'running'`
        )
        .bind(now, operationId),
    ]);
    return changes(result[2]) === 1;
  }
}

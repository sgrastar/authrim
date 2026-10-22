/**
 * Setup as the release migration executor of a Control without one.
 *
 * Control applies release migrations to the databases it manages only when it holds a Cloudflare
 * D1 token. Without one (an environment set up without Control tokens), Control still takes the
 * snapshot of the release targets, then blocks each runnable target with
 * `release_migration_executor_unavailable` and the rollout never reaches `awaiting_setup`.
 *
 * Setup holds the operator credential, so it runs those targets itself, through the same state
 * transitions as ar-control's ReleaseMigrationRolloutReconciler: it claims every executor-blocked
 * target of the rollout under its own lease in one batch (so Control's reconciler sees no blocked
 * target and neither re-blocks the rollout nor claims the targets), applies the pinned release
 * with the migration engine, and records each outcome under that lease. Control's cron then
 * advances the rollout to `awaiting_setup` as it does after its own executor.
 */
import {
  ApiMigrationEngine,
  MigrationReleaseArtifactReader,
  decideControlProvisioningFailure,
  type CloudflareD1QueryResult,
  type ReleaseArtifactStore,
} from '@authrim/ar-lib-core/control-plane';
import type { SetupOperatorD1Client } from './control-operator-executor.js';

export const RELEASE_MIGRATION_EXECUTOR_UNAVAILABLE = 'release_migration_executor_unavailable';
const TARGET_LEASE_SECONDS = 15 * 60;
const CLAIMED_PAGE_SIZE = 100;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface ClaimedTargetRow {
  target_id: string;
  provider_database_id: string;
  stream_id: string;
  release_id: string;
  manifest_digest: string;
  manifest_r2_object_key: string;
  source_version: string | null;
  attempt_count: number;
  fencing_token: number;
  retry_budget_started_at: number;
  created_at: number;
}

export interface SetupReleaseRolloutExecution {
  claimed: number;
  /** When nothing was due: the earliest retry time (seconds) of a target backing off. */
  nextAttemptAt: number | null;
  succeeded: number;
  retried: number;
  blocked: number;
}

function rows<T>(result: CloudflareD1QueryResult | undefined): T[] {
  return Array.isArray(result?.results) ? (result.results as T[]) : [];
}

function changes(result: CloudflareD1QueryResult | undefined): number {
  const value = (result?.meta as { changes?: unknown } | undefined)?.changes;
  return typeof value === 'number' ? value : 0;
}

function assertBatch(results: CloudflareD1QueryResult[], expected: number): void {
  if (results.length !== expected || results.some((result) => result.success !== true)) {
    throw new Error('release_rollout_setup_executor_batch_failed');
  }
}

function parseClaimed(row: ClaimedTargetRow): ClaimedTargetRow {
  if (
    !SAFE_ID.test(row.target_id) ||
    !SAFE_ID.test(row.provider_database_id) ||
    !['core-d1', 'pii-d1', 'lookup-d1'].includes(row.stream_id) ||
    typeof row.release_id !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(row.manifest_digest) ||
    typeof row.manifest_r2_object_key !== 'string' ||
    !row.manifest_r2_object_key ||
    (row.source_version !== null && typeof row.source_version !== 'string') ||
    !Number.isSafeInteger(row.attempt_count) ||
    !Number.isSafeInteger(row.fencing_token) ||
    !Number.isSafeInteger(row.retry_budget_started_at) ||
    !Number.isSafeInteger(row.created_at)
  ) {
    throw new Error('release_rollout_setup_executor_target_invalid');
  }
  return row;
}

/**
 * Claim every due target Control blocked for want of an executor and return the operation to
 * running. Nothing is claimed while another target waits for an operator: Control does not resume
 * such a rollout either (resumeExecutorBlockedRollouts). A target still backing off from an earlier
 * failure keeps its next_attempt_at; the earliest one is returned so the caller can wait for it.
 */
async function claimTargets(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  leaseOwner: string;
  now: number;
}): Promise<{ claimed: number; nextAttemptAt: number | null }> {
  const owned = `EXISTS (
    SELECT 1 FROM control_release_migration_targets owned
     WHERE owned.operation_id = ? AND owned.lease_owner = ? AND owned.state = 'running'
  )`;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_release_migration_targets
               SET state = 'running', attempt_count = attempt_count + 1,
                   next_attempt_at = NULL, lease_owner = ?, lease_expires_at = ?,
                   fencing_token = fencing_token + 1, last_error_code = NULL,
                   started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE operation_id = ? AND environment_id = ?
               AND state = 'blocked' AND last_error_code = ?
               AND provider_database_id IS NOT NULL
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
               AND EXISTS (
                 SELECT 1 FROM control_release_migration_rollouts rollout
                 JOIN control_operations operation ON operation.operation_id = rollout.operation_id
                  WHERE rollout.operation_id = control_release_migration_targets.operation_id
                    AND rollout.handoff_state = 'blocked' AND operation.status = 'blocked'
                    AND operation.last_error_code = ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM control_release_migration_targets other
                  WHERE other.operation_id = control_release_migration_targets.operation_id
                    AND other.state = 'blocked' AND other.last_error_code <> ?
               )`,
      params: [
        input.leaseOwner,
        input.now + TARGET_LEASE_SECONDS,
        input.now,
        input.now,
        input.operationId,
        input.environmentId,
        RELEASE_MIGRATION_EXECUTOR_UNAVAILABLE,
        input.now,
        RELEASE_MIGRATION_EXECUTOR_UNAVAILABLE,
        RELEASE_MIGRATION_EXECUTOR_UNAVAILABLE,
      ],
    },
    {
      sql: `UPDATE control_operation_steps
               SET status = 'running', last_error_code = NULL, updated_at = ?
             WHERE operation_id = ? AND step_key = 'apply_managed_migrations'
               AND status = 'blocked' AND ${owned}`,
      params: [input.now, input.operationId, input.operationId, input.leaseOwner],
    },
    {
      sql: `UPDATE control_operations
               SET status = 'running', last_error_code = NULL, updated_at = ?
             WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'
               AND last_error_code = ? AND ${owned}`,
      params: [
        input.now,
        input.operationId,
        input.environmentId,
        RELEASE_MIGRATION_EXECUTOR_UNAVAILABLE,
        input.operationId,
        input.leaseOwner,
      ],
    },
    {
      sql: `UPDATE control_release_migration_rollouts
               SET handoff_state = 'database_rollout', updated_at = ?
             WHERE operation_id = ? AND handoff_state = 'blocked' AND ${owned}`,
      params: [input.now, input.operationId, input.operationId, input.leaseOwner],
    },
    {
      sql: `SELECT MIN(next_attempt_at) AS next_attempt_at
              FROM control_release_migration_targets
             WHERE operation_id = ? AND state = 'blocked' AND last_error_code = ?
               AND next_attempt_at > ?`,
      params: [input.operationId, RELEASE_MIGRATION_EXECUTOR_UNAVAILABLE, input.now],
    },
  ]);
  assertBatch(results, 5);
  const claimed = changes(results[0]);
  if (claimed > 0 && changes(results[2]) !== 1) {
    throw new Error('release_rollout_setup_executor_claim_reflection_mismatch');
  }
  const next = rows<{ next_attempt_at: number | null }>(results[4])[0]?.next_attempt_at ?? null;
  return { claimed, nextAttemptAt: Number.isSafeInteger(next) ? next : null };
}

/** The claimed targets not yet applied, a page at a time (a D1 response is at most 1 MiB). */
async function readClaimedPage(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operationId: string;
  leaseOwner: string;
}): Promise<ClaimedTargetRow[]> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `SELECT target.target_id, target.provider_database_id, target.stream_id,
                   target.release_id, target.manifest_digest, rollout.manifest_r2_object_key,
                   rollout.source_version, target.attempt_count, target.fencing_token,
                   target.retry_budget_started_at, target.created_at
              FROM control_release_migration_targets target
              JOIN control_release_migration_rollouts rollout
                ON rollout.operation_id = target.operation_id
             WHERE target.operation_id = ? AND target.lease_owner = ? AND target.state = 'running'
             ORDER BY target.target_id
             LIMIT ?`,
      params: [input.operationId, input.leaseOwner, CLAIMED_PAGE_SIZE],
    },
  ]);
  assertBatch(results, 1);
  return rows<ClaimedTargetRow>(results[0]).map(parseClaimed);
}

/**
 * Keep every claimed target under this lease, and confirm the next one is still ours before its
 * migration starts. A migration already running is not stopped by a lost lease (Control's own
 * executor has the same bound); the engine's history keeps a second run from re-applying files.
 */
async function renewLease(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operationId: string;
  leaseOwner: string;
  target: ClaimedTargetRow;
  now: number;
}): Promise<void> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_release_migration_targets
               SET lease_expires_at = ?, updated_at = ?
             WHERE operation_id = ? AND lease_owner = ? AND state = 'running'
               AND lease_expires_at > ?`,
      params: [
        input.now + TARGET_LEASE_SECONDS,
        input.now,
        input.operationId,
        input.leaseOwner,
        input.now,
      ],
    },
    {
      sql: `SELECT 1 AS held FROM control_release_migration_targets
             WHERE operation_id = ? AND target_id = ? AND lease_owner = ?
               AND fencing_token = ? AND state = 'running' AND lease_expires_at > ?`,
      params: [
        input.operationId,
        input.target.target_id,
        input.leaseOwner,
        input.target.fencing_token,
        input.now,
      ],
    },
  ]);
  assertBatch(results, 2);
  if (rows(results[1]).length !== 1) throw new Error('release_migration_target_lease_lost');
}

async function recordSuccess(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  leaseOwner: string;
  target: ClaimedTargetRow;
  result: Awaited<ReturnType<ApiMigrationEngine['apply']>>;
  now: number;
}): Promise<void> {
  const { target, result } = input;
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_release_migration_targets
               SET state = 'succeeded', expected_file_count = ?, applied_file_count = ?,
                   skipped_file_count = ?, response_loss_recoveries = ?, last_filename = ?,
                   last_error_code = NULL, lease_owner = NULL, lease_expires_at = NULL,
                   completed_at = ?, updated_at = ?
             WHERE operation_id = ? AND target_id = ? AND state = 'running'
               AND lease_owner = ? AND fencing_token = ?`,
      params: [
        result.totalFiles,
        result.appliedFiles,
        result.skippedFiles,
        result.responseLossRecoveries,
        result.lastFilename,
        input.now,
        input.now,
        input.operationId,
        target.target_id,
        input.leaseOwner,
        target.fencing_token,
      ],
    },
  ]);
  assertBatch(results, 1);
  if (changes(results[0]) !== 1) throw new Error('release_migration_target_lease_lost');
  const audit = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
              event_id, environment_id, operation_id, event_type, actor_type, actor_id,
              resource_kind, resource_id, outcome, redacted_payload_json, created_at
            ) VALUES (?, ?, ?, 'control.release_migration.target_applied', 'setup', ?,
              'd1', ?, 'succeeded', ?, ?)`,
      params: [
        `audit:${input.operationId}:${target.target_id}:${target.fencing_token}:succeeded`,
        input.environmentId,
        input.operationId,
        input.leaseOwner,
        target.provider_database_id,
        JSON.stringify({
          target_id: target.target_id,
          stream_id: target.stream_id,
          release_id: target.release_id,
          total_files: result.totalFiles,
          applied_files: result.appliedFiles,
          skipped_files: result.skippedFiles,
        }),
        input.now,
      ],
    },
  ]);
  assertBatch(audit, 1);
}

/** Returns false when the lease was already gone, so the failure is not ours to record. */
async function recordFailure(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  operationId: string;
  leaseOwner: string;
  target: ClaimedTargetRow;
  state: 'waiting_retry' | 'blocked';
  nextAttemptAt: number | null;
  code: string;
  now: number;
}): Promise<boolean> {
  const results = await input.client.queryD1Batch(input.controlDatabaseId, [
    {
      sql: `UPDATE control_release_migration_targets
               SET state = ?, next_attempt_at = ?, last_error_code = ?,
                   lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE operation_id = ? AND target_id = ? AND state = 'running'
               AND lease_owner = ? AND fencing_token = ?`,
      params: [
        input.state,
        input.nextAttemptAt,
        input.code,
        input.now,
        input.operationId,
        input.target.target_id,
        input.leaseOwner,
        input.target.fencing_token,
      ],
    },
    // Control may have blocked the rollout again for a target still backing off while this one
    // ran. Its reconciler re-reads only rollouts in database_rollout, so the operation would keep
    // reporting the missing executor instead of this failure; reflect it here.
    ...(['control_operations', 'control_operation_steps'] as const).map((table) => ({
      sql: `UPDATE ${table}
               SET last_error_code = COALESCE((
                     SELECT MIN(target.last_error_code)
                       FROM control_release_migration_targets target
                      WHERE target.operation_id = ? AND target.state = 'blocked'
                        AND target.last_error_code <> ?
                   ), last_error_code),
                   updated_at = ?
             WHERE operation_id = ? AND status = 'blocked' AND last_error_code = ?${
               table === 'control_operation_steps'
                 ? " AND step_key = 'apply_managed_migrations'"
                 : ''
             }`,
      params: [
        input.operationId,
        RELEASE_MIGRATION_EXECUTOR_UNAVAILABLE,
        input.now,
        input.operationId,
        RELEASE_MIGRATION_EXECUTOR_UNAVAILABLE,
      ],
    })),
  ]);
  assertBatch(results, 3);
  return changes(results[0]) === 1;
}

/**
 * Run the release targets Control blocked for want of an executor. Returns how many were claimed;
 * zero means there was nothing setup may take over (Control resumes or an operator is needed).
 */
export async function executeReleaseRolloutTargetsAsSetup(input: {
  client: SetupOperatorD1Client;
  controlDatabaseId: string;
  environmentId: string;
  operationId: string;
  artifactStore: ReleaseArtifactStore;
  executionId?: string;
  /** Seconds, for Control rows. */
  now?: () => number;
  onTarget?: (done: number, total: number) => void;
}): Promise<SetupReleaseRolloutExecution> {
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const leaseOwner = `setup:release-migration:${input.executionId ?? crypto.randomUUID()}`;
  const claim = await claimTargets({
    client: input.client,
    controlDatabaseId: input.controlDatabaseId,
    environmentId: input.environmentId,
    operationId: input.operationId,
    leaseOwner,
    now: now(),
  });
  const execution: SetupReleaseRolloutExecution = {
    claimed: claim.claimed,
    nextAttemptAt: claim.claimed > 0 ? null : claim.nextAttemptAt,
    succeeded: 0,
    retried: 0,
    blocked: 0,
  };
  if (claim.claimed === 0) return execution;
  // Migration history records milliseconds, as Control's own executor does.
  const engine = new ApiMigrationEngine(
    new MigrationReleaseArtifactReader(input.artifactStore),
    input.client,
    () => Date.now()
  );
  let done = 0;
  while (true) {
    const page = await readClaimedPage({
      client: input.client,
      controlDatabaseId: input.controlDatabaseId,
      operationId: input.operationId,
      leaseOwner,
    });
    if (page.length === 0) break;
    for (const target of page) {
      input.onTarget?.(done, claim.claimed);
      await renewLease({
        client: input.client,
        controlDatabaseId: input.controlDatabaseId,
        operationId: input.operationId,
        leaseOwner,
        target,
        now: now(),
      });
      let result: Awaited<ReturnType<ApiMigrationEngine['apply']>>;
      try {
        result = await engine.apply({
          databaseId: target.provider_database_id,
          pin: {
            environmentId: input.environmentId,
            streamId: target.stream_id,
            releaseId: target.release_id,
            manifestDigest: target.manifest_digest,
            manifestObjectKey: target.manifest_r2_object_key,
            ...(target.source_version ? { sourceProductVersion: target.source_version } : {}),
          },
        });
      } catch (error) {
        const failedAt = now();
        const decision = decideControlProvisioningFailure({
          effect: 'apply_migrations',
          operation: {
            operationId: `${input.operationId}:${target.target_id}`,
            attemptCount: target.attempt_count,
            retryBudgetStartedAt: target.retry_budget_started_at,
            createdAt: target.created_at,
          },
          error,
          failedAt,
        });
        const retry = decision.disposition === 'retry';
        const recorded = await recordFailure({
          client: input.client,
          controlDatabaseId: input.controlDatabaseId,
          operationId: input.operationId,
          leaseOwner,
          target,
          state: retry ? 'waiting_retry' : 'blocked',
          nextAttemptAt: decision.nextAttemptAt,
          code: decision.code,
          now: failedAt,
        });
        if (!recorded) throw new Error('release_migration_target_lease_lost');
        if (retry) execution.retried += 1;
        else execution.blocked += 1;
        done += 1;
        continue;
      }
      await recordSuccess({
        client: input.client,
        controlDatabaseId: input.controlDatabaseId,
        environmentId: input.environmentId,
        operationId: input.operationId,
        leaseOwner,
        target,
        result,
        now: now(),
      });
      execution.succeeded += 1;
      done += 1;
    }
  }
  if (done !== claim.claimed) {
    throw new Error('release_rollout_setup_executor_claim_reflection_mismatch');
  }
  input.onTarget?.(done, claim.claimed);
  return execution;
}

import { CONTROL_ENSURE_WORKER_BINDING_TARGETS_SQL } from '@authrim/ar-lib-core/control-plane';
import type { ProvisionedD1DataRole } from './types';

export type WorkerBindingReconciliationState =
  | 'pending'
  | 'settings_patched'
  | 'smoke_verifying'
  | 'stabilizing'
  | 'succeeded'
  | 'rollback_required'
  | 'rolled_back'
  | 'blocked';

export interface WorkerBindingTarget {
  operationId: string;
  environmentId: string;
  environmentName: string;
  workerScriptName: string;
  shardId: string;
  bindingRef: string;
  dataRole: ProvisionedD1DataRole;
  residencyPartition: string;
  migrationGeneration: number;
  databaseId: string;
  state: WorkerBindingReconciliationState;
  expectedSourceVersionId: string | null;
  previousDeploymentId: string | null;
  patchResultVersionId: string | null;
  patchResultDeploymentId: string | null;
  previousRestoreSettingsJson: string | null;
  smokeAttemptCount: number;
  consecutiveSmokeSuccesses: number;
  stabilizationNotBefore: number | null;
  lastErrorCode: string | null;
  manualSettingsRestoreRequested: boolean;
}

export interface WorkerDeploymentLease {
  environmentId: string;
  workerScriptName: string;
  operationId: string;
  fencingToken: number;
  expectedSourceVersionId: string;
  mutationStarted: boolean;
  mutationStartedAt: number | null;
  previousDeploymentId: string | null;
  patchResultVersionId: string | null;
  patchResultDeploymentId: string | null;
}

const WORKER_DEPLOYMENT_LEASE_SECONDS = 15 * 60;
const CLOUDFLARE_DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface WorkerBindingTargetRow {
  operation_id: string;
  environment_id: string;
  environment_name: string;
  worker_script_name: string;
  shard_id: string;
  binding_ref: string;
  data_role: ProvisionedD1DataRole;
  residency_partition: string;
  migration_generation: number;
  provider_database_id: string;
  state: WorkerBindingReconciliationState;
  expected_source_version_id: string | null;
  previous_deployment_id: string | null;
  patch_result_version_id: string | null;
  patch_result_deployment_id: string | null;
  previous_restore_settings_json: string | null;
  smoke_attempt_count: number;
  consecutive_smoke_successes: number;
  stabilization_not_before: number | null;
  last_error_code: string | null;
  manual_settings_restore_requested: number;
}

interface WorkerDeploymentLeaseRow {
  environment_id: string;
  worker_script_name: string;
  owner_operation_id: string;
  fencing_token: number;
  expected_source_version_id: string;
  mutation_started: number;
  mutation_started_at: number | null;
  previous_deployment_id: string | null;
  patch_result_version_id: string | null;
  patch_result_deployment_id: string | null;
}

function targetFromRow(row: WorkerBindingTargetRow): WorkerBindingTarget {
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    workerScriptName: row.worker_script_name,
    shardId: row.shard_id,
    bindingRef: row.binding_ref,
    dataRole: row.data_role,
    residencyPartition: row.residency_partition,
    migrationGeneration: row.migration_generation,
    databaseId: row.provider_database_id,
    state: row.state,
    expectedSourceVersionId: row.expected_source_version_id,
    previousDeploymentId: row.previous_deployment_id,
    patchResultVersionId: row.patch_result_version_id,
    patchResultDeploymentId: row.patch_result_deployment_id,
    previousRestoreSettingsJson: row.previous_restore_settings_json,
    smokeAttemptCount: row.smoke_attempt_count,
    consecutiveSmokeSuccesses: row.consecutive_smoke_successes,
    stabilizationNotBefore: row.stabilization_not_before,
    lastErrorCode: row.last_error_code,
    manualSettingsRestoreRequested: row.manual_settings_restore_requested === 1,
  };
}

function leaseFromRow(row: WorkerDeploymentLeaseRow): WorkerDeploymentLease {
  return {
    environmentId: row.environment_id,
    workerScriptName: row.worker_script_name,
    operationId: row.owner_operation_id,
    fencingToken: row.fencing_token,
    expectedSourceVersionId: row.expected_source_version_id,
    mutationStarted: row.mutation_started === 1,
    mutationStartedAt: row.mutation_started_at,
    previousDeploymentId: row.previous_deployment_id,
    patchResultVersionId: row.patch_result_version_id,
    patchResultDeploymentId: row.patch_result_deployment_id,
  };
}

function safeLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new Error('invalid_worker_binding_reconciliation_limit');
  return Math.max(1, Math.min(Math.floor(limit), 100));
}

export class D1WorkerBindingRepository {
  constructor(private readonly db: D1Database) {}

  async ensurePendingTargets(now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(CONTROL_ENSURE_WORKER_BINDING_TARGETS_SQL).bind(now, now),
      ...(['reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings'] as const).map(
        (stepKey) =>
          this.db
            .prepare(
              `UPDATE control_operation_steps
                  SET progress_total = (
                    SELECT COUNT(*) FROM control_worker_binding_reconciliations r
                     WHERE r.operation_id = control_operation_steps.operation_id
                  ), progress_current = COALESCE(progress_current, 0), updated_at = ?
                WHERE step_key = ? AND operation_id IN (
                  SELECT DISTINCT operation_id FROM control_worker_binding_reconciliations
                   WHERE state <> 'succeeded'
                )`
            )
            .bind(now, stepKey)
      ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?),
                  last_error_code = NULL, last_error_redacted = NULL,
                  next_attempt_at = NULL, updated_at = ?
            WHERE step_key = 'reconcile_worker_bindings' AND status = 'blocked'
              AND last_error_code = 'operator_action_required' AND progress_total > 0
              AND NOT EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations target
                 WHERE target.operation_id = control_operation_steps.operation_id
                   AND target.state NOT IN (
                     'settings_patched', 'smoke_verifying', 'stabilizing', 'succeeded'
                   )
              )`
        )
        .bind(now, now),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET progress_current = progress_total, status = 'succeeded',
                  completed_at = COALESCE(completed_at, ?), last_error_code = NULL,
                  last_error_redacted = NULL, next_attempt_at = NULL, updated_at = ?
            WHERE step_key = 'reconcile_worker_bindings'
              AND status = 'running' AND progress_total > 0
              AND NOT EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations target
                 WHERE target.operation_id = control_operation_steps.operation_id
                   AND target.state NOT IN (
                     'settings_patched', 'smoke_verifying', 'stabilizing', 'succeeded'
                   )
              )`
        )
        .bind(now, now),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?),
                  last_error_code = NULL, last_error_redacted = NULL,
                  next_attempt_at = NULL, updated_at = ?
            WHERE step_key = 'smoke_bindings' AND progress_total > 0
              AND (status = 'queued' OR
                   (status = 'blocked' AND last_error_code = 'operator_action_required'))
              AND EXISTS (
                SELECT 1 FROM control_operation_steps binding_step
                 WHERE binding_step.operation_id = control_operation_steps.operation_id
                   AND binding_step.step_key = 'reconcile_worker_bindings'
                   AND binding_step.status = 'succeeded'
              )`
        )
        .bind(now, now),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET progress_current = (
                    SELECT COUNT(*) FROM control_worker_binding_reconciliations target
                     WHERE target.operation_id = control_operation_steps.operation_id
                       AND target.state IN ('stabilizing', 'succeeded')
                  ),
                  status = CASE
                    WHEN progress_total = (
                      SELECT COUNT(*) FROM control_worker_binding_reconciliations target
                       WHERE target.operation_id = control_operation_steps.operation_id
                         AND target.state IN ('stabilizing', 'succeeded')
                    ) THEN 'succeeded' ELSE 'running' END,
                  completed_at = CASE
                    WHEN progress_total = (
                      SELECT COUNT(*) FROM control_worker_binding_reconciliations target
                       WHERE target.operation_id = control_operation_steps.operation_id
                         AND target.state IN ('stabilizing', 'succeeded')
                    ) THEN COALESCE(completed_at, ?) ELSE completed_at END,
                  last_error_code = NULL, last_error_redacted = NULL,
                  next_attempt_at = NULL, updated_at = ?
            WHERE step_key = 'smoke_bindings' AND progress_total > 0
              AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM control_operation_steps binding_step
                 WHERE binding_step.operation_id = control_operation_steps.operation_id
                   AND binding_step.step_key = 'reconcile_worker_bindings'
                   AND binding_step.status = 'succeeded'
              )`
        )
        .bind(now, now),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?),
                  last_error_code = NULL, last_error_redacted = NULL,
                  next_attempt_at = NULL, updated_at = ?
            WHERE step_key = 'stabilize_bindings' AND progress_total > 0
              AND (status = 'queued' OR
                   (status = 'blocked' AND last_error_code = 'operator_action_required'))
              AND EXISTS (
                SELECT 1 FROM control_operation_steps smoke_step
                 WHERE smoke_step.operation_id = control_operation_steps.operation_id
                   AND smoke_step.step_key = 'smoke_bindings'
                   AND smoke_step.status = 'succeeded'
              )`
        )
        .bind(now, now),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET progress_current = (
                    SELECT COUNT(*) FROM control_worker_binding_reconciliations target
                     WHERE target.operation_id = control_operation_steps.operation_id
                       AND target.state = 'succeeded'
                  ),
                  status = CASE
                    WHEN progress_total = (
                      SELECT COUNT(*) FROM control_worker_binding_reconciliations target
                       WHERE target.operation_id = control_operation_steps.operation_id
                         AND target.state = 'succeeded'
                    ) THEN 'succeeded' ELSE 'running' END,
                  completed_at = CASE
                    WHEN progress_total = (
                      SELECT COUNT(*) FROM control_worker_binding_reconciliations target
                       WHERE target.operation_id = control_operation_steps.operation_id
                         AND target.state = 'succeeded'
                    ) THEN COALESCE(completed_at, ?) ELSE completed_at END,
                  last_error_code = NULL, last_error_redacted = NULL,
                  next_attempt_at = NULL, updated_at = ?
            WHERE step_key = 'stabilize_bindings' AND progress_total > 0
              AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM control_operation_steps smoke_step
                 WHERE smoke_step.operation_id = control_operation_steps.operation_id
                   AND smoke_step.step_key = 'smoke_bindings'
                   AND smoke_step.status = 'succeeded'
              )`
        )
        .bind(now, now),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', last_error_code = 'control_worker_binding_targets_missing',
                  next_attempt_at = NULL, lock_owner = NULL, lock_expires_at = NULL,
                  updated_at = ?
            WHERE operation_kind = 'provision_shard' AND status = 'waiting_retry'
              AND EXISTS (
                SELECT 1 FROM control_tenant_database_migration_state m
                 WHERE m.operation_id = control_operations.operation_id AND m.state = 'ready'
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations r
                 WHERE r.operation_id = control_operations.operation_id
              )`
        )
        .bind(now),
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'failed', updated_at = ?
            WHERE status = 'ready' AND d1_desired_resource_id IN (
              SELECT m.desired_resource_id
                FROM control_tenant_database_migration_state m
                JOIN control_operations o ON o.operation_id = m.operation_id
               WHERE o.status = 'blocked'
                 AND o.last_error_code = 'control_worker_binding_targets_missing'
            )`
        )
        .bind(now),
      this.db
        .prepare(
          `UPDATE control_lookup_physical_shards SET status = 'failed', updated_at = ?
            WHERE status = 'ready' AND d1_desired_resource_id IN (
              SELECT m.desired_resource_id
                FROM control_tenant_database_migration_state m
                JOIN control_operations o ON o.operation_id = m.operation_id
               WHERE o.status = 'blocked'
                 AND o.last_error_code = 'control_worker_binding_targets_missing'
            )`
        )
        .bind(now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT 'audit:' || o.operation_id || ':binding-targets-missing', o.environment_id,
                  o.operation_id, 'control.worker_binding.targets_missing', 'reconciler',
                  'worker_binding', o.operation_id, 'blocked', '{}', ?
             FROM control_operations o
            WHERE o.status = 'blocked'
              AND o.last_error_code = 'control_worker_binding_targets_missing'`
        )
        .bind(now),
      this.db
        .prepare(
          `DELETE FROM control_worker_deployment_leases AS lease
          WHERE EXISTS (
            SELECT 1 FROM control_worker_binding_reconciliations target
             WHERE target.environment_id = lease.environment_id
               AND target.worker_script_name = lease.worker_script_name
               AND target.operation_id = lease.owner_operation_id
               AND target.state = 'succeeded'
               AND target.patch_result_version_id = lease.patch_result_version_id
               AND target.patch_result_deployment_id = lease.patch_result_deployment_id
          )`
        )
        .bind(),
      this.db
        .prepare(
          `DELETE FROM control_worker_deployment_leases AS lease
            WHERE lease.mutation_started = 0
              AND EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = lease.owner_operation_id
                   AND operation.environment_id = lease.environment_id
                   AND operation.status IN ('succeeded', 'canceled')
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations target
                 WHERE target.operation_id = lease.owner_operation_id
                   AND target.environment_id = lease.environment_id
                   AND target.worker_script_name = lease.worker_script_name
                   AND target.state NOT IN ('succeeded', 'blocked', 'rolled_back')
              )`
        )
        .bind(),
    ]);

    const completionCandidates = await this.db
      .prepare(
        `SELECT operation_id
           FROM control_operations operation
          WHERE operation.operation_kind = 'provision_shard'
            AND operation.status IN ('running', 'waiting_retry')
            AND EXISTS (
              SELECT 1 FROM control_worker_binding_reconciliations target
               WHERE target.operation_id = operation.operation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM control_worker_binding_reconciliations target
               WHERE target.operation_id = operation.operation_id
                 AND target.state <> 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM control_operation_steps step
               WHERE step.operation_id = operation.operation_id
                 AND step.status NOT IN ('succeeded', 'skipped')
            )
          ORDER BY operation.updated_at, operation.operation_id
          LIMIT 100`
      )
      .bind()
      .all<{ operation_id: string }>();
    for (const candidate of completionCandidates.results) {
      await this.completeOperationIfReady(candidate.operation_id, now);
    }
  }

  async listDueTargets(limit: number, now: number): Promise<WorkerBindingTarget[]> {
    const result = await this.db
      .prepare(
        `SELECT r.operation_id, r.environment_id, e.environment_name, r.worker_script_name,
                r.shard_id, r.binding_ref, r.data_role, r.residency_partition,
                r.migration_generation, r.provider_database_id,
                r.state, r.expected_source_version_id, r.previous_deployment_id,
                r.patch_result_version_id, r.patch_result_deployment_id,
                r.previous_restore_settings_json, r.smoke_attempt_count,
                r.consecutive_smoke_successes, r.stabilization_not_before, r.last_error_code,
                EXISTS (
                    SELECT 1 FROM control_audit_events audit
                     WHERE audit.operation_id = r.operation_id
                       AND audit.environment_id = r.environment_id
                       AND audit.event_type = 'control.operation.restore_previous_settings'
                       AND audit.actor_type = 'admin'
                       AND audit.resource_kind = 'operation'
                       AND audit.resource_id = r.operation_id
                       AND audit.outcome = 'succeeded'
                  ) AS manual_settings_restore_requested
           FROM control_worker_binding_reconciliations r
           JOIN control_environments e ON e.environment_id = r.environment_id
           JOIN control_operations o
             ON o.operation_id = r.operation_id AND o.environment_id = r.environment_id
          WHERE r.state IN ('pending', 'settings_patched', 'smoke_verifying', 'stabilizing',
                          'rollback_required')
            AND o.status IN ('running', 'waiting_retry')
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
            AND (r.state <> 'stabilizing' OR r.stabilization_not_before <= ?)
          ORDER BY CASE r.state
                     WHEN 'stabilizing' THEN 0
                     WHEN 'smoke_verifying' THEN 1
                     WHEN 'settings_patched' THEN 2
                     WHEN 'rollback_required' THEN 3
                     ELSE 4
                   END,
                   CASE WHEN r.state = 'stabilizing' THEN r.stabilization_not_before
                        ELSE r.updated_at END,
                   r.operation_id, r.worker_script_name, r.binding_ref
          LIMIT ?`
      )
      .bind(now, now, safeLimit(limit))
      .all<WorkerBindingTargetRow>();
    return result.results.map(targetFromRow);
  }

  async acquireDeploymentLease(input: {
    target: WorkerBindingTarget;
    expectedSourceVersionId: string;
    now: number;
    ttlSeconds?: number;
  }): Promise<WorkerDeploymentLease | null> {
    const expiresAt =
      input.now + Math.max(30, Math.min(input.ttlSeconds ?? WORKER_DEPLOYMENT_LEASE_SECONDS, 900));
    const changed = await this.db
      .prepare(
        `INSERT INTO control_worker_deployment_leases (
           environment_id, worker_script_name, owner_operation_id, fencing_token,
           lease_expires_at, expected_source_version_id, mutation_started, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?, 0, ?)
         ON CONFLICT(environment_id, worker_script_name) DO UPDATE SET
           owner_operation_id = excluded.owner_operation_id,
           fencing_token = control_worker_deployment_leases.fencing_token + 1,
           lease_expires_at = excluded.lease_expires_at,
           expected_source_version_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
              AND control_worker_deployment_leases.mutation_started = 1
             THEN control_worker_deployment_leases.expected_source_version_id
             ELSE excluded.expected_source_version_id
           END,
           mutation_started = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.mutation_started
             ELSE 0
           END,
           mutation_started_at = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.mutation_started_at
             ELSE NULL
           END,
           previous_deployment_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.previous_deployment_id
             ELSE NULL
           END,
           patch_result_version_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.patch_result_version_id
             ELSE NULL
           END,
           patch_result_deployment_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.patch_result_deployment_id
             ELSE NULL
           END,
           updated_at = excluded.updated_at
         WHERE control_worker_deployment_leases.lease_expires_at <= excluded.updated_at
            OR control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id`
      )
      .bind(
        input.target.environmentId,
        input.target.workerScriptName,
        input.target.operationId,
        expiresAt,
        input.expectedSourceVersionId,
        input.now
      )
      .run();
    if ((changed.meta.changes ?? 0) !== 1) return null;
    await this.db
      .prepare(
        `UPDATE control_worker_deployment_leases
            SET patch_result_version_id = COALESCE(
                  patch_result_version_id,
                  (SELECT target.patch_result_version_id
                     FROM control_worker_binding_reconciliations target
                    WHERE target.operation_id = ? AND target.environment_id = ?
                      AND target.worker_script_name = ? AND target.binding_ref = ?
                      AND target.state IN ('settings_patched', 'smoke_verifying', 'stabilizing'))
                ),
                patch_result_deployment_id = COALESCE(
                  patch_result_deployment_id,
                  (SELECT target.patch_result_deployment_id
                     FROM control_worker_binding_reconciliations target
                    WHERE target.operation_id = ? AND target.environment_id = ?
                      AND target.worker_script_name = ? AND target.binding_ref = ?
                      AND target.state IN ('settings_patched', 'smoke_verifying', 'stabilizing'))
                ),
                updated_at = ?
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND (patch_result_version_id IS NULL OR patch_result_deployment_id IS NULL)`
      )
      .bind(
        input.target.operationId,
        input.target.environmentId,
        input.target.workerScriptName,
        input.target.bindingRef,
        input.target.operationId,
        input.target.environmentId,
        input.target.workerScriptName,
        input.target.bindingRef,
        input.now,
        input.target.environmentId,
        input.target.workerScriptName,
        input.target.operationId
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT environment_id, worker_script_name, owner_operation_id, fencing_token,
                expected_source_version_id, mutation_started, mutation_started_at,
                previous_deployment_id,
                patch_result_version_id, patch_result_deployment_id
           FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?`
      )
      .bind(input.target.environmentId, input.target.workerScriptName, input.target.operationId)
      .first<WorkerDeploymentLeaseRow>();
    return row ? leaseFromRow(row) : null;
  }

  async leaseIsCurrent(lease: WorkerDeploymentLease, now: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS valid
           FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ? AND lease_expires_at > ?`
      )
      .bind(lease.environmentId, lease.workerScriptName, lease.operationId, lease.fencingToken, now)
      .first<{ valid: number }>();
    return row?.valid === 1;
  }

  async releaseDeploymentLease(lease: WorkerDeploymentLease): Promise<boolean> {
    const changed = await this.db
      .prepare(
        `DELETE FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ?`
      )
      .bind(lease.environmentId, lease.workerScriptName, lease.operationId, lease.fencingToken)
      .run();
    return (changed.meta.changes ?? 0) === 1;
  }

  async recordPatchStarted(input: {
    target: WorkerBindingTarget;
    lease: WorkerDeploymentLease;
    previousDeploymentId: string;
    restoreSettingsJson: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET mutation_started = 1, mutation_started_at = COALESCE(mutation_started_at, ?),
                  previous_deployment_id = ?, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 0`
        )
        .bind(
          input.now,
          input.previousDeploymentId,
          input.now,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.operationId,
          input.lease.fencingToken,
          input.now
        ),
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET expected_source_version_id = ?, previous_deployment_id = ?,
                  previous_restore_settings_json = ?, last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state = 'pending' AND EXISTS (
                SELECT 1 FROM control_worker_deployment_leases
                 WHERE environment_id = ? AND worker_script_name = ?
                   AND owner_operation_id = ? AND fencing_token = ? AND mutation_started = 1
              )`
        )
        .bind(
          input.lease.expectedSourceVersionId,
          input.previousDeploymentId,
          input.restoreSettingsJson,
          input.now,
          input.target.operationId,
          input.target.workerScriptName,
          input.target.bindingRef,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.operationId,
          input.lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
              AND status = 'queued'`
        )
        .bind(input.now, input.now, input.target.operationId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_worker_binding_stale_fencing_token');
    }
  }

  async rearmPatchIntent(input: {
    target: WorkerBindingTarget;
    lease: WorkerDeploymentLease;
    now: number;
  }): Promise<boolean> {
    const changed = await this.db
      .prepare(
        `UPDATE control_worker_deployment_leases
            SET mutation_started = 0, mutation_started_at = NULL,
                previous_deployment_id = NULL, updated_at = ?
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ? AND lease_expires_at > ?
            AND mutation_started = 1 AND patch_result_version_id IS NULL
            AND patch_result_deployment_id IS NULL`
      )
      .bind(
        input.now,
        input.lease.environmentId,
        input.lease.workerScriptName,
        input.lease.operationId,
        input.lease.fencingToken,
        input.now
      )
      .run();
    return (changed.meta.changes ?? 0) === 1;
  }

  async recordAlreadySatisfied(input: {
    target: WorkerBindingTarget;
    lease: WorkerDeploymentLease;
    versionId: string;
    deploymentId: string;
    settingsJson: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'running', last_error_code = NULL, last_error_redacted = NULL,
                  next_attempt_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND (status IN ('waiting_retry', 'running') OR
                   (status = 'blocked' AND last_error_code = 'operator_action_required'))`
        )
        .bind(input.now, input.target.operationId, input.target.environmentId),
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET patch_result_version_id = ?, patch_result_deployment_id = ?, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 0`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.operationId,
          input.lease.fencingToken,
          input.now
        ),
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET state = 'settings_patched', expected_source_version_id = ?,
                  previous_deployment_id = ?, patch_result_version_id = ?,
                  patch_result_deployment_id = ?, previous_restore_settings_json = ?,
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state = 'pending' AND EXISTS (
                SELECT 1 FROM control_worker_deployment_leases lease
                 WHERE lease.environment_id = ? AND lease.worker_script_name = ?
                   AND lease.owner_operation_id = ? AND lease.fencing_token = ?
                   AND lease.lease_expires_at > ? AND lease.mutation_started = 0
              )`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.versionId,
          input.deploymentId,
          input.settingsJson,
          input.now,
          input.target.operationId,
          input.target.workerScriptName,
          input.target.bindingRef,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.operationId,
          input.lease.fencingToken,
          input.now
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = CASE WHEN COALESCE(progress_current, 0) + 1 >= progress_total
                                THEN 'succeeded' ELSE 'running' END,
                  attempt_count = attempt_count + 1,
                  progress_current = MIN(progress_total, COALESCE(progress_current, 0) + 1),
                  started_at = COALESCE(started_at, ?),
                  completed_at = CASE WHEN COALESCE(progress_current, 0) + 1 >= progress_total
                                      THEN ? ELSE completed_at END,
                  last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
              AND status IN ('queued', 'running', 'blocked')`
        )
        .bind(input.now, input.now, input.now, input.target.operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  started_at = COALESCE(started_at, ?), last_error_code = NULL,
                  last_error_redacted = NULL, next_attempt_at = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = 'smoke_bindings'
              AND (status = 'queued' OR
                   (status = 'blocked' AND last_error_code = 'operator_action_required'))
              AND EXISTS (
                SELECT 1 FROM control_operation_steps binding_step
                 WHERE binding_step.operation_id = control_operation_steps.operation_id
                   AND binding_step.step_key = 'reconcile_worker_bindings'
                   AND binding_step.status = 'succeeded'
              )`
        )
        .bind(input.now, input.now, input.target.operationId),
    ]);
    // An already-present binding still needs the same fenced smoke and stabilization sequence.
    // markSucceeded releases the lease after that sequence completes.
    if ((results[1]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_worker_binding_already_satisfied_stale');
    }
  }

  async recordPatchResult(input: {
    target: WorkerBindingTarget;
    lease: WorkerDeploymentLease;
    versionId: string;
    deploymentId: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET patch_result_version_id = ?, patch_result_deployment_id = ?, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ? AND mutation_started = 1`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now,
          input.lease.environmentId,
          input.lease.workerScriptName,
          input.lease.operationId,
          input.lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET state = 'settings_patched', patch_result_version_id = ?,
                  patch_result_deployment_id = ?, updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state = 'pending'`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now,
          input.target.operationId,
          input.target.workerScriptName,
          input.target.bindingRef
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET progress_current = MIN(progress_total, COALESCE(progress_current, 0) + 1),
                  status = CASE
                    WHEN COALESCE(progress_current, 0) + 1 >= progress_total THEN 'succeeded'
                    ELSE status
                  END,
                  completed_at = CASE
                    WHEN COALESCE(progress_current, 0) + 1 >= progress_total THEN ?
                    ELSE completed_at
                  END,
                  updated_at = ?
            WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'
              AND status = 'running'`
        )
        .bind(input.now, input.now, input.target.operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  started_at = COALESCE(started_at, ?), last_error_code = NULL,
                  last_error_redacted = NULL, next_attempt_at = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = 'smoke_bindings'
              AND (status = 'queued' OR
                   (status = 'blocked' AND last_error_code = 'operator_action_required'))
              AND EXISTS (
                SELECT 1 FROM control_operation_steps binding_step
                 WHERE binding_step.operation_id = control_operation_steps.operation_id
                   AND binding_step.step_key = 'reconcile_worker_bindings'
                   AND binding_step.status = 'succeeded'
              )`
        )
        .bind(input.now, input.now, input.target.operationId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_worker_binding_patch_result_stale');
    }
  }

  async recordSmokeProgress(input: {
    target: WorkerBindingTarget;
    successful: boolean;
    attempt: number;
    stabilizationNotBefore?: number;
    completeStabilizationCheck?: boolean;
    errorCode?: string;
    now: number;
  }): Promise<void> {
    const state =
      input.stabilizationNotBefore === undefined && input.completeStabilizationCheck !== true
        ? 'smoke_verifying'
        : 'stabilizing';
    const statements = [
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
            SET state = ?, smoke_attempt_count = ?,
                consecutive_smoke_successes = CASE WHEN ? THEN MIN(3, consecutive_smoke_successes + 1) ELSE 0 END,
                stabilization_not_before = COALESCE(?, stabilization_not_before),
                last_error_code = ?, updated_at = ?
          WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
            AND state IN ('settings_patched', 'smoke_verifying', 'stabilizing')`
        )
        .bind(
          state,
          input.attempt,
          input.successful ? 1 : 0,
          input.stabilizationNotBefore ?? null,
          input.errorCode ?? null,
          input.now,
          input.target.operationId,
          input.target.workerScriptName,
          input.target.bindingRef
        ),
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET lease_expires_at = MAX(lease_expires_at, ?), updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND patch_result_version_id IS NOT NULL
              AND patch_result_deployment_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations target
                 WHERE target.operation_id = control_worker_deployment_leases.owner_operation_id
                   AND target.environment_id = control_worker_deployment_leases.environment_id
                   AND target.worker_script_name = control_worker_deployment_leases.worker_script_name
                   AND target.binding_ref = ?
                   AND target.patch_result_version_id = control_worker_deployment_leases.patch_result_version_id
                   AND target.patch_result_deployment_id = control_worker_deployment_leases.patch_result_deployment_id
              )`
        )
        .bind(
          input.now + WORKER_DEPLOYMENT_LEASE_SECONDS,
          input.now,
          input.target.environmentId,
          input.target.workerScriptName,
          input.target.operationId,
          input.target.bindingRef
        ),
    ];
    if (input.stabilizationNotBefore !== undefined) {
      statements.push(
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET progress_current = MIN(progress_total, COALESCE(progress_current, 0) + 1),
                    status = CASE
                      WHEN COALESCE(progress_current, 0) + 1 >= progress_total THEN 'succeeded'
                      ELSE status
                    END,
                    completed_at = CASE
                      WHEN COALESCE(progress_current, 0) + 1 >= progress_total THEN ?
                      ELSE completed_at
                    END,
                    updated_at = ?
              WHERE operation_id = ? AND step_key = 'smoke_bindings' AND status = 'running'`
          )
          .bind(input.now, input.now, input.target.operationId),
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET status = 'running', attempt_count = attempt_count + 1,
                    started_at = COALESCE(started_at, ?), last_error_code = NULL,
                    last_error_redacted = NULL, next_attempt_at = NULL, updated_at = ?
              WHERE operation_id = ? AND step_key = 'stabilize_bindings'
                AND (status = 'queued' OR
                     (status = 'blocked' AND last_error_code = 'operator_action_required'))
                AND EXISTS (
                  SELECT 1 FROM control_operation_steps smoke_step
                   WHERE smoke_step.operation_id = control_operation_steps.operation_id
                     AND smoke_step.step_key = 'smoke_bindings'
                     AND smoke_step.status = 'succeeded'
                )`
          )
          .bind(input.now, input.now, input.target.operationId)
      );
    }
    const results = await this.db.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_worker_binding_smoke_state_stale');
    }
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_worker_binding_smoke_lease_stale');
    }
  }

  async adoptSupersedingSmokeDeployment(input: {
    target: WorkerBindingTarget;
    lease: WorkerDeploymentLease;
    versionId: string;
    deploymentId: string;
    now: number;
  }): Promise<void> {
    if (
      !CLOUDFLARE_DEPLOYMENT_ID.test(input.versionId) ||
      !CLOUDFLARE_DEPLOYMENT_ID.test(input.deploymentId)
    ) {
      throw new Error('control_worker_superseding_deployment_id_invalid');
    }
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET patch_result_version_id = ?, patch_result_deployment_id = ?,
                  smoke_attempt_count = 0, consecutive_smoke_successes = 0,
                  stabilization_not_before = NULL,
                  last_error_code = 'control_worker_version_superseded', updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND worker_script_name = ?
              AND binding_ref = ? AND state IN ('settings_patched', 'smoke_verifying')
              AND patch_result_version_id = ?
              AND EXISTS (
                SELECT 1 FROM control_worker_deployment_leases lease
                 WHERE lease.environment_id = control_worker_binding_reconciliations.environment_id
                   AND lease.worker_script_name = control_worker_binding_reconciliations.worker_script_name
                   AND lease.owner_operation_id = control_worker_binding_reconciliations.operation_id
                   AND lease.fencing_token = ? AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now,
          input.target.operationId,
          input.target.environmentId,
          input.target.workerScriptName,
          input.target.bindingRef,
          input.target.patchResultVersionId,
          input.lease.fencingToken,
          input.now
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET next_attempt_at = ?,
                  last_error_code = 'control_worker_version_superseded',
                  last_error_redacted = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND status IN ('running', 'waiting_retry')
              AND EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations target
                 WHERE target.operation_id = control_operations.operation_id
                   AND target.environment_id = control_operations.environment_id
                   AND target.worker_script_name = ? AND target.binding_ref = ?
                   AND target.state IN ('settings_patched', 'smoke_verifying')
                   AND target.patch_result_version_id = ?
                   AND target.patch_result_deployment_id = ?
                   AND target.last_error_code = 'control_worker_version_superseded'
              )`
        )
        .bind(
          input.now,
          input.now,
          input.target.operationId,
          input.target.environmentId,
          input.target.workerScriptName,
          input.target.bindingRef,
          input.versionId,
          input.deploymentId
        ),
      this.db
        .prepare(
          `DELETE FROM control_worker_deployment_leases
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ?`
        )
        .bind(
          input.target.environmentId,
          input.target.workerScriptName,
          input.target.operationId,
          input.lease.fencingToken
        ),
      this.db
        .prepare(
          `SELECT target.state, target.last_error_code, operation.status AS operation_status,
                  operation.last_error_code AS operation_error_code,
                  target.patch_result_version_id, target.patch_result_deployment_id,
                  EXISTS (
                    SELECT 1 FROM control_worker_deployment_leases lease
                     WHERE lease.environment_id = target.environment_id
                       AND lease.worker_script_name = target.worker_script_name
                       AND lease.owner_operation_id = target.operation_id
                  ) AS lease_exists
             FROM control_worker_binding_reconciliations target
             JOIN control_operations operation ON operation.operation_id = target.operation_id
            WHERE target.operation_id = ? AND target.environment_id = ?
              AND target.worker_script_name = ? AND target.binding_ref = ?`
        )
        .bind(
          input.target.operationId,
          input.target.environmentId,
          input.target.workerScriptName,
          input.target.bindingRef
        ),
    ]);
    const reflected = results[3]?.results?.[0] as Record<string, unknown> | undefined;
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_worker_superseding_smoke_target_stale');
    }
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_worker_superseding_smoke_operation_stale');
    }
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_worker_superseding_smoke_lease_stale');
    }
    if (!reflected) throw new Error('control_worker_superseding_smoke_reflection_missing');
    if (!['settings_patched', 'smoke_verifying'].includes(String(reflected.state))) {
      throw new Error('control_worker_superseding_smoke_state_invalid');
    }
    if (reflected.last_error_code !== 'control_worker_version_superseded') {
      throw new Error('control_worker_superseding_smoke_target_reflection_failed');
    }
    if (
      !['running', 'waiting_retry'].includes(String(reflected.operation_status)) ||
      reflected.operation_error_code !== 'control_worker_version_superseded'
    ) {
      throw new Error('control_worker_superseding_smoke_operation_reflection_failed');
    }
    if (
      reflected.patch_result_version_id !== input.versionId ||
      reflected.patch_result_deployment_id !== input.deploymentId
    ) {
      throw new Error('control_worker_superseding_smoke_version_reflection_failed');
    }
    if (reflected.lease_exists !== 0) {
      throw new Error('control_worker_superseding_smoke_lease_reflection_failed');
    }
  }

  async markSucceeded(target: WorkerBindingTarget, now: number): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET state = 'succeeded', consecutive_smoke_successes = 3,
                  last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state = 'stabilizing' AND consecutive_smoke_successes = 3
              AND stabilization_not_before <= ?`
        )
        .bind(now, now, target.operationId, target.workerScriptName, target.bindingRef, now),
      this.db
        .prepare(
          `INSERT INTO control_worker_observed_bindings (
             environment_id, worker_script_name, binding_name, binding_kind,
             provider_resource_id, observed_spec_json, observed_version_id,
             observed_deployment_id, observed_at
           )
           SELECT environment_id, worker_script_name, binding_ref, 'd1',
                  provider_database_id,
                  json_object('data_role', data_role,
                              'residency_partition', residency_partition,
                              'migration_generation', migration_generation),
                  patch_result_version_id, patch_result_deployment_id, ?
             FROM control_worker_binding_reconciliations
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state = 'succeeded'
           ON CONFLICT(environment_id, worker_script_name, binding_name) DO UPDATE SET
             binding_kind = excluded.binding_kind,
             provider_resource_id = excluded.provider_resource_id,
             observed_spec_json = excluded.observed_spec_json,
             observed_version_id = excluded.observed_version_id,
             observed_deployment_id = excluded.observed_deployment_id,
             observed_at = excluded.observed_at`
        )
        .bind(now, target.operationId, target.workerScriptName, target.bindingRef),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET progress_current = MIN(progress_total, COALESCE(progress_current, 0) + 1),
                  status = CASE
                    WHEN COALESCE(progress_current, 0) + 1 >= progress_total THEN 'succeeded'
                    ELSE status
                  END,
                  completed_at = CASE
                    WHEN COALESCE(progress_current, 0) + 1 >= progress_total THEN ?
                    ELSE completed_at
                  END,
                  updated_at = ?
            WHERE operation_id = ?
              AND step_key IN ('stabilize_bindings', 'verify_runtime_bindings')
              AND status IN ('running', 'succeeded')`
        )
        .bind(now, now, target.operationId),
      this.db
        .prepare(
          `DELETE FROM control_worker_deployment_leases
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND patch_result_version_id = ? AND patch_result_deployment_id = ?
              AND EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations target
                 WHERE target.operation_id = control_worker_deployment_leases.owner_operation_id
                   AND target.environment_id = control_worker_deployment_leases.environment_id
                   AND target.worker_script_name = control_worker_deployment_leases.worker_script_name
                   AND target.binding_ref = ? AND target.state = 'succeeded'
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations sibling
                 WHERE sibling.operation_id = control_worker_deployment_leases.owner_operation_id
                   AND sibling.environment_id = control_worker_deployment_leases.environment_id
                   AND sibling.worker_script_name = control_worker_deployment_leases.worker_script_name
                   AND sibling.binding_ref <> ?
                   AND sibling.state IN ('settings_patched', 'smoke_verifying', 'stabilizing')
                   AND sibling.patch_result_version_id = control_worker_deployment_leases.patch_result_version_id
                   AND sibling.patch_result_deployment_id = control_worker_deployment_leases.patch_result_deployment_id
              )`
        )
        .bind(
          target.environmentId,
          target.workerScriptName,
          target.operationId,
          target.patchResultVersionId,
          target.patchResultDeploymentId,
          target.bindingRef,
          target.bindingRef
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'control.worker_binding.verified', 'reconciler',
                     'worker_binding', ?, 'succeeded', ?, ?)`
        )
        .bind(
          `audit:${target.operationId}:binding:${target.workerScriptName}:${target.bindingRef}:succeeded`,
          target.environmentId,
          target.operationId,
          `${target.workerScriptName}:${target.bindingRef}`,
          JSON.stringify({
            worker_script_name: target.workerScriptName,
            binding_ref: target.bindingRef,
            migration_generation: target.migrationGeneration,
          }),
          now
        ),
    ]);
    if (results.slice(0, 3).some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error('control_worker_binding_stabilization_incomplete');
    }
  }

  async markRollbackRequired(
    target: WorkerBindingTarget,
    errorCode: string,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_worker_binding_reconciliations
            SET state = 'rollback_required', last_error_code = ?, updated_at = ?
          WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
            AND state NOT IN ('succeeded', 'rolled_back', 'blocked')`
      )
      .bind(errorCode, now, target.operationId, target.workerScriptName, target.bindingRef)
      .run();
  }

  async recordTransientError(
    target: WorkerBindingTarget,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state NOT IN ('succeeded', 'rolled_back', 'blocked')`
        )
        .bind(errorCode, now, target.operationId, target.workerScriptName, target.bindingRef),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('waiting_retry', 'running')`
        )
        .bind(nextAttemptAt, errorCode, now, target.operationId),
    ]);
  }

  async markRolledBack(target: WorkerBindingTarget, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET state = 'rolled_back', updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state = 'rollback_required'`
        )
        .bind(now, target.operationId, target.workerScriptName, target.bindingRef),
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'failed', updated_at = ?
            WHERE shard_id = ? AND status IN ('ready', 'degraded')`
        )
        .bind(now, target.shardId),
      this.db
        .prepare(
          `UPDATE control_lookup_physical_shards SET status = 'failed', updated_at = ?
            WHERE lookup_shard_id = ? AND status IN ('ready', 'draining')`
        )
        .bind(now, target.shardId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', last_error_code = 'control_worker_binding_rolled_back',
                  next_attempt_at = NULL, lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND status IN ('waiting_retry', 'running')`
        )
        .bind(now, target.operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = CASE WHEN status = 'queued' THEN 'blocked' ELSE 'rolled_back' END,
                  last_error_code = 'control_worker_binding_rolled_back', updated_at = ?
            WHERE operation_id = ? AND step_key IN (
              'reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings',
              'verify_runtime_bindings'
            ) AND status IN ('queued', 'running', 'succeeded')`
        )
        .bind(now, target.operationId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'control.worker_binding.rollback', 'reconciler',
                     'worker_binding', ?, 'succeeded', ?, ?)`
        )
        .bind(
          `audit:${target.operationId}:binding:${target.workerScriptName}:${target.bindingRef}:rolled-back`,
          target.environmentId,
          target.operationId,
          `${target.workerScriptName}:${target.bindingRef}`,
          JSON.stringify({
            worker_script_name: target.workerScriptName,
            binding_ref: target.bindingRef,
          }),
          now
        ),
    ]);
  }

  async markBlocked(target: WorkerBindingTarget, errorCode: string, now: number): Promise<void> {
    const authorityStatements =
      errorCode === 'control_workers_capability_rejected'
        ? [
            this.db
              .prepare(
                `UPDATE control_environments
                    SET provisioning_capability_state = 'blocked',
                        provisioning_capability_checked_at = ?, updated_at = ?
                  WHERE environment_id = ?
                    AND automatic_provisioning_enabled = 1
                    AND provisioning_token_ownership IN ('user', 'account')`
              )
              .bind(now, now, target.environmentId),
            this.db
              .prepare(
                `INSERT OR IGNORE INTO control_audit_events (
                   event_id, environment_id, operation_id, event_type, actor_type,
                   resource_kind, resource_id, outcome, redacted_payload_json, created_at
                 ) SELECT ?, ?, ?, 'control.provisioning.authority_blocked', 'reconciler',
                          'provisioning_authority', ?, 'blocked', ?, ?
                    WHERE EXISTS (
                      SELECT 1 FROM control_environments environment
                       WHERE environment.environment_id = ?
                         AND environment.provisioning_capability_state = 'blocked'
                         AND environment.provisioning_capability_checked_at = ?
                    )`
              )
              .bind(
                `audit:${target.operationId}:binding:${target.workerScriptName}:${target.bindingRef}:authority-blocked`,
                target.environmentId,
                target.operationId,
                target.environmentId,
                JSON.stringify({ reason_code: errorCode }),
                now,
                target.environmentId,
                now
              ),
          ]
        : [];
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET state = CASE
                    WHEN expected_source_version_id IS NOT NULL
                     AND previous_restore_settings_json IS NOT NULL
                    THEN 'blocked' ELSE state END,
                  last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state <> 'succeeded'`
        )
        .bind(errorCode, now, target.operationId, target.workerScriptName, target.bindingRef),
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'failed', updated_at = ?
            WHERE shard_id = ? AND status IN ('ready', 'degraded')`
        )
        .bind(now, target.shardId),
      this.db
        .prepare(
          `UPDATE control_lookup_physical_shards SET status = 'failed', updated_at = ?
            WHERE lookup_shard_id = ? AND status IN ('ready', 'draining')`
        )
        .bind(now, target.shardId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', last_error_code = ?, next_attempt_at = NULL,
                  lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND status IN ('waiting_retry', 'running')`
        )
        .bind(errorCode, now, target.operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'blocked', last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND step_key IN (
              'reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings',
              'verify_runtime_bindings'
            ) AND status IN ('queued', 'running')`
        )
        .bind(errorCode, now, target.operationId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'control.worker_binding.blocked', 'reconciler',
                     'worker_binding', ?, 'blocked', ?, ?)`
        )
        .bind(
          `audit:${target.operationId}:binding:${target.workerScriptName}:${target.bindingRef}:blocked`,
          target.environmentId,
          target.operationId,
          `${target.workerScriptName}:${target.bindingRef}`,
          JSON.stringify({
            worker_script_name: target.workerScriptName,
            binding_ref: target.bindingRef,
            error_code: errorCode,
          }),
          now
        ),
      ...authorityStatements,
    ]);
  }

  async completeOperationIfReady(operationId: string, now: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operations
            SET status = 'succeeded', completed_at = ?, next_attempt_at = NULL,
                last_error_code = NULL, lock_owner = NULL, lock_expires_at = NULL,
                updated_at = ?
          WHERE operation_id = ? AND status IN ('waiting_retry', 'running')
            AND EXISTS (
              SELECT 1 FROM control_worker_binding_reconciliations r
               WHERE r.operation_id = control_operations.operation_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM control_worker_binding_reconciliations r
               WHERE r.operation_id = control_operations.operation_id AND r.state <> 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM control_operation_steps step
               WHERE step.operation_id = control_operations.operation_id
                 AND step.status NOT IN ('succeeded', 'skipped')
            )
            AND NOT EXISTS (
              SELECT 1
                FROM control_worker_binding_reconciliations binding
                LEFT JOIN control_tenant_shards shard
                  ON shard.shard_id = binding.shard_id
                 AND shard.environment_id = binding.environment_id
                LEFT JOIN control_lookup_physical_shards lookup_shard
                  ON lookup_shard.lookup_shard_id = binding.shard_id
                 AND lookup_shard.environment_id = binding.environment_id
                LEFT JOIN control_desired_resources desired
                  ON desired.desired_resource_id = COALESCE(
                       shard.d1_desired_resource_id, lookup_shard.d1_desired_resource_id
                     )
                 AND desired.environment_id = binding.environment_id
                LEFT JOIN control_observed_resources observed
                  ON observed.observed_resource_id = desired.observed_resource_id
                 AND observed.desired_resource_id = desired.desired_resource_id
                 AND observed.environment_id = desired.environment_id
                LEFT JOIN control_tenant_database_migration_state migration
                  ON migration.desired_resource_id = desired.desired_resource_id
                 AND migration.environment_id = desired.environment_id
                 AND migration.operation_id = binding.operation_id
                LEFT JOIN control_environment_resource_policies policy
                  ON policy.environment_id = binding.environment_id
               WHERE binding.operation_id = control_operations.operation_id
                 AND (
                   (shard.shard_id IS NULL AND lookup_shard.lookup_shard_id IS NULL) OR
                   COALESCE(shard.status, lookup_shard.status) <> 'ready' OR
                   desired.desired_resource_id IS NULL OR desired.desired_state <> 'present' OR
                   desired.provisioning_state <> 'ready' OR
                   desired.origin_operation_id <> control_operations.operation_id OR
                   observed.observed_resource_id IS NULL OR observed.observed_state <> 'present' OR
                   observed.provider_resource_id <> binding.provider_database_id OR
                   migration.desired_resource_id IS NULL OR migration.state <> 'ready' OR
                   migration.provider_database_id <> binding.provider_database_id OR
                   policy.environment_id IS NULL
                 )
            )`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'active', updated_at = ?
          WHERE shard_id IN (
            SELECT shard_id FROM control_worker_binding_reconciliations WHERE operation_id = ?
          ) AND status = 'ready'
            AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND status = 'succeeded'
            )`
        )
        .bind(now, operationId, operationId),
      this.db
        .prepare(
          `UPDATE control_lookup_physical_shards SET status = 'active', updated_at = ?
          WHERE lookup_shard_id IN (
            SELECT shard_id FROM control_worker_binding_reconciliations WHERE operation_id = ?
          ) AND status = 'ready'
            AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND status = 'succeeded'
            )`
        )
        .bind(now, operationId, operationId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_shard_capacity (
             shard_id, target_account_count, allocated_account_count,
             health_status, allocation_status, checked_at, updated_at
           )
           SELECT shard.shard_id, policy.target_account_count,
                  (SELECT COUNT(*) FROM control_tenant_shard_allocations allocation
                    WHERE allocation.selected_shard_id = shard.shard_id
                      AND allocation.reservation_state IN ('reserved', 'committed')
                      AND allocation.capacity_counted_at IS NOT NULL) +
                  (SELECT COUNT(*) FROM control_tenant_default_allocations allocation
                    WHERE allocation.selected_shard_id = shard.shard_id
                      AND allocation.reservation_state IN ('reserved', 'committed')
                      AND allocation.capacity_counted_at IS NOT NULL),
                  'healthy', 'eligible', ?, ?
             FROM control_tenant_shards shard
             JOIN control_environment_resource_policies policy
               ON policy.environment_id = shard.environment_id
             JOIN control_desired_resources desired
               ON desired.desired_resource_id = shard.d1_desired_resource_id
              AND desired.environment_id = shard.environment_id
            WHERE shard.status = 'active'
              AND desired.origin_operation_id = ?
              AND desired.provisioning_state = 'ready'
              AND EXISTS (
                SELECT 1 FROM control_operations
                 WHERE operation_id = ? AND status = 'succeeded'
              )`
        )
        .bind(now, now, operationId, operationId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_tenant_shard_assignments (
             environment_id, tenant_id, data_role, residency_policy_id,
             residency_partition, shard_id, assignment_generation, assignment_state,
             source_operation_id, created_at, activated_at, updated_at
           )
           SELECT shard.environment_id, placement.tenant_id, shard.data_role,
                  shard.residency_policy_id, shard.residency_partition, shard.shard_id,
                  COALESCE((
                    SELECT MAX(existing.assignment_generation) + 1
                      FROM control_tenant_shard_assignments existing
                     WHERE existing.environment_id = shard.environment_id
                       AND existing.tenant_id = placement.tenant_id
                       AND existing.data_role = shard.data_role
                       AND existing.residency_partition = shard.residency_partition
                  ), 1),
                  'active', ?, ?, ?, ?
             FROM control_tenant_shards shard
             JOIN control_desired_resources desired
               ON desired.desired_resource_id = shard.d1_desired_resource_id
              AND desired.environment_id = shard.environment_id
             JOIN control_tenant_placement_policies placement
               ON placement.environment_id = shard.environment_id
              AND placement.policy_state = 'active'
              AND placement.isolation_policy = shard.allocation_scope
              AND (
                (placement.isolation_policy = 'shared_pool'
                 AND shard.owner_tenant_id IS NULL) OR
                (placement.isolation_policy = 'tenant_exclusive'
                 AND shard.owner_tenant_id = placement.tenant_id)
              )
             JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
            WHERE shard.status = 'active'
              AND shard.data_role IN ('tenant_core/users', 'tenant_pii')
              AND desired.origin_operation_id = ?
              AND desired.provisioning_state = 'ready'
              AND capacity.health_status = 'healthy'
              AND capacity.allocation_status = 'eligible'
              AND (capacity.target_account_count - capacity.allocated_account_count) * 5 >=
                  capacity.target_account_count
              AND EXISTS (
                SELECT 1 FROM control_operations
                 WHERE operation_id = ? AND status = 'succeeded'
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM control_tenant_shard_assignments assigned
                  JOIN control_tenant_shards assigned_shard
                    ON assigned_shard.shard_id = assigned.shard_id
                   AND assigned_shard.environment_id = assigned.environment_id
                  JOIN control_shard_capacity assigned_capacity
                    ON assigned_capacity.shard_id = assigned.shard_id
                 WHERE assigned.environment_id = shard.environment_id
                   AND assigned.tenant_id = placement.tenant_id
                   AND assigned.data_role = shard.data_role
                   AND assigned.residency_policy_id = shard.residency_policy_id
                   AND assigned.residency_partition = shard.residency_partition
                   AND assigned.assignment_state = 'active'
                   AND assigned_shard.status = 'active'
                   AND assigned_shard.allocation_scope = placement.isolation_policy
                   AND (
                     (placement.isolation_policy = 'shared_pool'
                      AND assigned_shard.owner_tenant_id IS NULL) OR
                     (placement.isolation_policy = 'tenant_exclusive'
                      AND assigned_shard.owner_tenant_id = placement.tenant_id)
                   )
                   AND assigned_capacity.health_status = 'healthy'
                   AND assigned_capacity.allocation_status = 'eligible'
                   AND (assigned_capacity.target_account_count -
                        assigned_capacity.allocated_account_count) * 5 >=
                       assigned_capacity.target_account_count
              )`
        )
        .bind(operationId, now, now, now, operationId, operationId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return false;
    const activatedTenantShards = results[1]?.meta.changes ?? 0;
    const activatedLookupShards = results[2]?.meta.changes ?? 0;
    const createdCapacityRows = results[3]?.meta.changes ?? 0;
    if (
      activatedTenantShards + activatedLookupShards < 1 ||
      (activatedTenantShards > 0 && createdCapacityRows < activatedTenantShards) ||
      (activatedLookupShards > 0 && createdCapacityRows !== 0)
    ) {
      throw new Error('control_shard_capacity_activation_incomplete');
    }
    return true;
  }
}

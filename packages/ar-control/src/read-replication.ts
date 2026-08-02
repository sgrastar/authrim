import type {
  CloudflareControlApiClient,
  ControlReadReplicationDesiredMode,
  ControlReadReplicationStartRequest,
  ControlReadReplicationStatusView,
} from '@authrim/ar-lib-core/control-plane';
import type { D1PreparedStatement } from '@cloudflare/workers-types';

type ReadReplicationApi = Pick<CloudflareControlApiClient, 'getD1Database' | 'updateD1Database'>;

interface RolloutRow {
  operation_id: string;
  desired_mode: ControlReadReplicationDesiredMode;
  status: NonNullable<ControlReadReplicationStatusView['operationStatus']>;
  created_at: number;
  updated_at: number;
}

interface PolicySummaryRow {
  policy_count: number;
  enabled_count: number;
  disabled_count: number;
  converged_count: number;
  failed_count: number;
  updated_at: number | null;
}

interface ResourceSummaryRow {
  target_count: number;
  converged_count: number;
  pending_count: number;
  failed_count: number;
  updated_at: number | null;
}

interface ClaimedTargetRow {
  operation_id: string;
  environment_id: string;
  desired_resource_id: string;
  target_kind: 'lookup' | 'tenant';
  shard_id: string;
  data_role: 'lookup' | 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residency_partition: string;
  desired_mode: ControlReadReplicationDesiredMode;
  attempt_count: number;
  retry_budget_expires_at: number;
  lock_owner: string;
  fencing_token: number;
}

interface ProviderResourceRow {
  provider_database_id: string;
}

interface RolloutCountsRow {
  policy_count: number;
  applied_policy_count: number;
  failed_policy_count: number;
  target_count: number;
  completed_target_count: number;
  blocked_target_count: number;
}

interface DriftTargetRow {
  environment_id: string;
  target_kind: 'lookup' | 'tenant';
  shard_id: string;
  data_role: 'lookup' | 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residency_partition: string;
  desired_mode: ControlReadReplicationDesiredMode;
  provider_database_id: string;
}

interface PolicyObservedSummaryRow {
  eligible_count: number;
  converged_count: number;
  failed_count: number;
}

const RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const TARGET_LEASE_SECONDS = 90;
const MAX_RECONCILE_TARGETS = 10;
const HEALTHY_DRIFT_CHECK_INTERVAL_SECONDS = 8 * 60 * 60;
const FAILED_DRIFT_RETRY_SECONDS = 60;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

function providerMode(mode: ControlReadReplicationDesiredMode): 'auto' | 'disabled' {
  return mode === 'enabled' ? 'auto' : 'disabled';
}

function observedState(mode: ControlReadReplicationDesiredMode): 'enabled' | 'disabled' {
  return mode;
}

function validateStartRequest(input: ControlReadReplicationStartRequest): void {
  if (
    !input ||
    (input.desiredMode !== 'enabled' && input.desiredMode !== 'disabled') ||
    typeof input.idempotencyKey !== 'string' ||
    !SAFE_ID.test(input.idempotencyKey) ||
    typeof input.requestedById !== 'string' ||
    !SAFE_ID.test(input.requestedById)
  ) {
    throw new Error('invalid_read_replication_rollout_request');
  }
}

function retryDelay(attemptCount: number): number {
  return Math.min(15 * 60, 30 * 2 ** Math.min(Math.max(0, attemptCount - 1), 5));
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message === 'read_replication_provider_state_missing') {
    return error.message;
  }
  if (error instanceof Error && error.message === 'read_replication_provider_resource_missing') {
    return error.message;
  }
  return 'read_replication_provider_request_failed';
}

export class ReadReplicationService {
  constructor(
    private readonly db: D1Database,
    private readonly api: ReadReplicationApi,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly randomId: () => string = () => crypto.randomUUID()
  ) {}

  async getStatus(environmentId: string): Promise<ControlReadReplicationStatusView> {
    const environment = await this.db
      .prepare(`SELECT environment_id FROM control_environments WHERE environment_id = ?`)
      .bind(environmentId)
      .first<{ environment_id: string }>();
    if (!environment) throw new Error('read_replication_environment_not_found');
    const [latest, policies, resources] = await Promise.all([
      this.db
        .prepare(
          `SELECT operation_id, desired_mode, status, created_at, updated_at
             FROM control_read_replication_rollouts
            WHERE environment_id = ?
            ORDER BY created_at DESC, operation_id DESC
            LIMIT 1`
        )
        .bind(environmentId)
        .first<RolloutRow>(),
      this.db
        .prepare(
          `SELECT COUNT(*) AS policy_count,
                  COALESCE(SUM(CASE WHEN policy.desired_mode = 'enabled' THEN 1 ELSE 0 END), 0) AS enabled_count,
                  COALESCE(SUM(CASE WHEN policy.desired_mode = 'disabled' THEN 1 ELSE 0 END), 0) AS disabled_count,
                  COALESCE(SUM(CASE WHEN policy.operation_status = 'succeeded' THEN 1 ELSE 0 END), 0) AS converged_count,
                  COALESCE(SUM(CASE WHEN policy.operation_status IN ('failed', 'blocked') THEN 1 ELSE 0 END), 0) AS failed_count,
                  MAX(policy.updated_at) AS updated_at
             FROM control_read_replication_policies policy
             JOIN control_residency_partitions partition
               ON partition.environment_id = policy.environment_id
              AND partition.residency_partition = policy.residency_partition
              AND partition.status = 'active'
            WHERE policy.environment_id = ?`
        )
        .bind(environmentId)
        .first<PolicySummaryRow>(),
      this.db
        .prepare(
          `WITH eligible AS (
             SELECT policy.desired_mode, shard.observed_replication_state, shard.updated_at
               FROM control_tenant_shards shard
               JOIN control_read_replication_policies policy
                 ON policy.environment_id = shard.environment_id
                AND policy.data_role = shard.data_role
                AND policy.residency_partition = shard.residency_partition
               JOIN control_residency_partitions partition
                 ON partition.environment_id = shard.environment_id
                AND partition.residency_partition = shard.residency_partition
                AND partition.status = 'active'
              WHERE shard.environment_id = ?
                AND shard.status IN ('requested', 'provisioning', 'ready', 'active', 'degraded')
             UNION ALL
             SELECT policy.desired_mode, shard.observed_replication_state, shard.updated_at
               FROM control_lookup_physical_shards shard
               JOIN control_read_replication_policies policy
                 ON policy.environment_id = shard.environment_id
                AND policy.data_role = 'lookup'
                AND policy.residency_partition = shard.residency_partition
               JOIN control_residency_partitions partition
                 ON partition.environment_id = shard.environment_id
                AND partition.residency_partition = shard.residency_partition
                AND partition.status = 'active'
              WHERE shard.environment_id = ?
                AND shard.status IN ('requested', 'provisioning', 'ready', 'active', 'draining')
           )
           SELECT COUNT(*) AS target_count,
                  COALESCE(SUM(CASE
                    WHEN desired_mode = 'enabled' AND observed_replication_state = 'enabled' THEN 1
                    WHEN desired_mode = 'disabled' AND observed_replication_state = 'disabled' THEN 1
                    ELSE 0 END), 0) AS converged_count,
                  COALESCE(SUM(CASE
                    WHEN observed_replication_state IN ('unknown', 'enabling') OR
                         (desired_mode = 'enabled' AND observed_replication_state = 'disabled') OR
                         (desired_mode = 'disabled' AND observed_replication_state = 'enabled')
                    THEN 1 ELSE 0 END), 0) AS pending_count,
                  COALESCE(SUM(CASE WHEN observed_replication_state = 'failed' THEN 1 ELSE 0 END), 0) AS failed_count,
                  MAX(updated_at) AS updated_at
             FROM eligible`
        )
        .bind(environmentId, environmentId)
        .first<ResourceSummaryRow>(),
    ]);

    const policy = policies ?? {
      policy_count: 0,
      enabled_count: 0,
      disabled_count: 0,
      converged_count: 0,
      failed_count: 0,
      updated_at: null,
    };
    const resource = resources ?? {
      target_count: 0,
      converged_count: 0,
      pending_count: 0,
      failed_count: 0,
      updated_at: null,
    };
    const mixedPolicies = policy.enabled_count > 0 && policy.disabled_count > 0;
    const desiredMode: ControlReadReplicationDesiredMode =
      policy.policy_count > 0 && policy.enabled_count === policy.policy_count
        ? 'enabled'
        : (latest?.desired_mode ?? 'disabled');
    const operationActive =
      latest?.status === 'queued' ||
      latest?.status === 'applying' ||
      latest?.status === 'verifying';
    const attentionRequired =
      mixedPolicies ||
      policy.failed_count > 0 ||
      resource.failed_count > 0 ||
      latest?.status === 'attention_required' ||
      latest?.status === 'blocked';
    const updating = operationActive || resource.pending_count > 0;
    const aggregateStatus = attentionRequired
      ? 'attention_required'
      : updating
        ? 'updating'
        : desiredMode === 'enabled'
          ? 'on'
          : 'off';

    return {
      environmentId,
      desiredMode,
      aggregateStatus,
      operationId: latest?.operation_id ?? null,
      operationStatus: latest?.status ?? null,
      eligiblePolicyCount: policy.policy_count,
      convergedPolicyCount: mixedPolicies ? 0 : policy.converged_count,
      failedPolicyCount: policy.failed_count,
      targetCount: resource.target_count,
      convergedTargetCount: resource.converged_count,
      pendingTargetCount: resource.pending_count,
      failedTargetCount: resource.failed_count,
      updatedAt: Math.max(
        latest?.updated_at ?? 0,
        policy.updated_at ?? 0,
        resource.updated_at ?? 0
      ),
    };
  }

  async start(
    environmentId: string,
    input: ControlReadReplicationStartRequest
  ): Promise<ControlReadReplicationStatusView> {
    validateStartRequest(input);
    const existing = await this.db
      .prepare(
        `SELECT rollout.operation_id, rollout.desired_mode, rollout.status,
                rollout.created_at, rollout.updated_at
           FROM control_operations operation
           JOIN control_read_replication_rollouts rollout
             ON rollout.operation_id = operation.operation_id
          WHERE operation.environment_id = ? AND operation.idempotency_key = ?`
      )
      .bind(environmentId, input.idempotencyKey)
      .first<RolloutRow>();
    if (existing) {
      if (existing.desired_mode !== input.desiredMode) {
        throw new Error('read_replication_rollout_idempotency_conflict');
      }
      return this.getStatus(environmentId);
    }

    const environment = await this.db
      .prepare(
        `SELECT lifecycle_state
           FROM control_environments
          WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<{ lifecycle_state: string }>();
    if (!environment || environment.lifecycle_state !== 'active') {
      throw new Error('read_replication_environment_not_active');
    }
    const activePartition = await this.db
      .prepare(
        `SELECT residency_partition
           FROM control_residency_partitions
          WHERE environment_id = ? AND status = 'active'
          LIMIT 1`
      )
      .bind(environmentId)
      .first<{ residency_partition: string }>();
    if (!activePartition) throw new Error('read_replication_no_eligible_policies');
    const active = await this.db
      .prepare(
        `SELECT operation_id
           FROM control_read_replication_rollouts
          WHERE environment_id = ? AND status IN ('queued', 'applying', 'verifying')
          LIMIT 1`
      )
      .bind(environmentId)
      .first<{ operation_id: string }>();
    if (active) throw new Error('read_replication_rollout_in_progress');

    const now = this.now();
    const operationId = `read-replication:${this.randomId()}`;
    const desiredObservedState = observedState(input.desiredMode);
    const retryBudgetExpiresAt = now + RETRY_BUDGET_SECONDS;
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, attempt_count, started_at, created_at, updated_at
           ) VALUES (?, ?, 'read_replication_rollout', ?, 'running',
             'admin', ?, 1, ?, ?, ?)`
          )
          .bind(
            operationId,
            environmentId,
            input.idempotencyKey,
            input.requestedById,
            now,
            now,
            now
          ),
        this.db
          .prepare(
            `INSERT INTO control_read_replication_rollouts (
             operation_id, environment_id, desired_mode, status, eligible_policy_count,
             created_at, updated_at
           ) SELECT ?, ?, ?, 'applying', COUNT(*) * 4, ?, ?
               FROM control_residency_partitions
              WHERE environment_id = ? AND status = 'active'`
          )
          .bind(operationId, environmentId, input.desiredMode, now, now, environmentId),
        this.db
          .prepare(
            `INSERT INTO control_read_replication_policies (
             environment_id, data_role, residency_partition, desired_mode,
             consistency_policy_version, operation_id, operation_status, updated_at
           )
           SELECT ?, role.data_role, partition.residency_partition, ?, 1, ?, 'applying', ?
             FROM control_residency_partitions partition
             CROSS JOIN (
               SELECT 'lookup' AS data_role
               UNION ALL SELECT 'tenant_core/default'
               UNION ALL SELECT 'tenant_core/users'
               UNION ALL SELECT 'tenant_pii'
             ) role
            WHERE partition.environment_id = ? AND partition.status = 'active'
              AND true
           ON CONFLICT(environment_id, data_role, residency_partition) DO UPDATE SET
             desired_mode = excluded.desired_mode,
             consistency_policy_version = excluded.consistency_policy_version,
             operation_id = excluded.operation_id,
             operation_status = excluded.operation_status,
             updated_at = excluded.updated_at`
          )
          .bind(environmentId, input.desiredMode, operationId, now, environmentId),
        this.db
          .prepare(
            `UPDATE control_tenant_shards
              SET read_replication_mode = ?,
                  observed_replication_state = CASE
                    WHEN observed_replication_state = ? THEN observed_replication_state
                    ELSE 'enabling'
                  END,
                  consistency_policy_version = 1,
                  updated_at = ?
            WHERE environment_id = ?
              AND status IN ('requested', 'provisioning', 'ready', 'active', 'degraded')
              AND EXISTS (
                SELECT 1 FROM control_residency_partitions partition
                 WHERE partition.environment_id = control_tenant_shards.environment_id
                   AND partition.residency_partition = control_tenant_shards.residency_partition
                   AND partition.status = 'active'
              )`
          )
          .bind(input.desiredMode, desiredObservedState, now, environmentId),
        this.db
          .prepare(
            `UPDATE control_lookup_physical_shards
              SET read_replication_mode = ?,
                  observed_replication_state = CASE
                    WHEN observed_replication_state = ? THEN observed_replication_state
                    ELSE 'enabling'
                  END,
                  consistency_policy_version = 1,
                  updated_at = ?
            WHERE environment_id = ?
              AND status IN ('requested', 'provisioning', 'ready', 'active', 'draining')
              AND EXISTS (
                SELECT 1 FROM control_residency_partitions partition
                 WHERE partition.environment_id = control_lookup_physical_shards.environment_id
                   AND partition.residency_partition = control_lookup_physical_shards.residency_partition
                   AND partition.status = 'active'
              )`
          )
          .bind(input.desiredMode, desiredObservedState, now, environmentId),
        this.targetInsertStatement(
          operationId,
          environmentId,
          input.desiredMode,
          retryBudgetExpiresAt,
          now
        ),
        this.db
          .prepare(
            `INSERT INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count,
             progress_current, progress_total, started_at, updated_at
           ) VALUES (?, 'apply-and-verify', 10, 'running', 1, 0,
             (SELECT COUNT(*) FROM control_read_replication_rollout_targets WHERE operation_id = ?),
             ?, ?)`
          )
          .bind(operationId, operationId, now, now),
      ]);
    } catch (error) {
      const raced = await this.db
        .prepare(
          `SELECT operation_id
             FROM control_read_replication_rollouts
            WHERE environment_id = ? AND status IN ('queued', 'applying', 'verifying')
            LIMIT 1`
        )
        .bind(environmentId)
        .first<{ operation_id: string }>();
      if (raced) throw new Error('read_replication_rollout_in_progress');
      throw error;
    }

    await this.refreshRollout(operationId, environmentId);
    return this.getStatus(environmentId);
  }

  async reconcile(limit = MAX_RECONCILE_TARGETS, operationId?: string): Promise<number> {
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_RECONCILE_TARGETS);
    if (operationId) await this.addMissingTargets(operationId);
    let processed = 0;
    const touched = new Map<string, string>();
    while (processed < boundedLimit) {
      const target = await this.claimNext(operationId);
      if (!target) break;
      touched.set(target.operation_id, target.environment_id);
      await this.applyTarget(target);
      processed += 1;
    }
    for (const [touchedOperationId, environmentId] of touched) {
      await this.addMissingTargets(touchedOperationId);
      await this.refreshRollout(touchedOperationId, environmentId);
    }
    if (operationId && !touched.has(operationId)) {
      const rollout = await this.db
        .prepare(
          `SELECT environment_id FROM control_read_replication_rollouts WHERE operation_id = ?`
        )
        .bind(operationId)
        .first<{ environment_id: string }>();
      if (rollout) await this.refreshRollout(operationId, rollout.environment_id);
    }
    return processed;
  }

  async reconcileDrift(limit = 2): Promise<number> {
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), 2);
    let processed = 0;
    while (processed < boundedLimit) {
      const target = await this.nextDriftTarget();
      if (!target) break;
      await this.reconcileDriftTarget(target);
      processed += 1;
    }
    return processed;
  }

  private async nextDriftTarget(): Promise<DriftTargetRow | null> {
    const now = this.now();
    return this.db
      .prepare(
        `WITH eligible AS (
           SELECT shard.environment_id, 'tenant' AS target_kind, shard.shard_id,
                  shard.data_role, shard.residency_partition, policy.desired_mode,
                  observed.provider_resource_id AS provider_database_id,
                  shard.observed_replication_state, shard.replication_checked_at
             FROM control_tenant_shards shard
             JOIN control_read_replication_policies policy
               ON policy.environment_id = shard.environment_id
              AND policy.data_role = shard.data_role
              AND policy.residency_partition = shard.residency_partition
             JOIN control_residency_partitions partition
               ON partition.environment_id = shard.environment_id
              AND partition.residency_partition = shard.residency_partition
              AND partition.status = 'active'
             JOIN control_desired_resources desired
               ON desired.desired_resource_id = shard.d1_desired_resource_id
              AND desired.environment_id = shard.environment_id
             JOIN control_observed_resources observed
               ON observed.observed_resource_id = desired.observed_resource_id
              AND observed.environment_id = desired.environment_id
            WHERE shard.status IN ('ready', 'active', 'degraded')
              AND desired.desired_state = 'present'
              AND observed.observed_state = 'present'
           UNION ALL
           SELECT shard.environment_id, 'lookup', shard.lookup_shard_id,
                  'lookup', shard.residency_partition, policy.desired_mode,
                  observed.provider_resource_id, shard.observed_replication_state,
                  shard.replication_checked_at
             FROM control_lookup_physical_shards shard
             JOIN control_read_replication_policies policy
               ON policy.environment_id = shard.environment_id
              AND policy.data_role = 'lookup'
              AND policy.residency_partition = shard.residency_partition
             JOIN control_residency_partitions partition
               ON partition.environment_id = shard.environment_id
              AND partition.residency_partition = shard.residency_partition
              AND partition.status = 'active'
             JOIN control_desired_resources desired
               ON desired.desired_resource_id = shard.d1_desired_resource_id
              AND desired.environment_id = shard.environment_id
             JOIN control_observed_resources observed
               ON observed.observed_resource_id = desired.observed_resource_id
              AND observed.environment_id = desired.environment_id
            WHERE shard.status IN ('ready', 'active', 'draining')
              AND desired.desired_state = 'present'
              AND observed.observed_state = 'present'
         )
         SELECT environment_id, target_kind, shard_id, data_role, residency_partition,
                desired_mode, provider_database_id
           FROM eligible target
          WHERE NOT EXISTS (
                  SELECT 1 FROM control_read_replication_rollouts rollout
                   WHERE rollout.environment_id = target.environment_id
                     AND rollout.status IN ('queued', 'applying', 'verifying')
                )
            AND (
              replication_checked_at IS NULL OR
              (observed_replication_state = 'failed' AND replication_checked_at <= ?) OR
              replication_checked_at <= ?
            )
          ORDER BY CASE WHEN observed_replication_state = 'failed' THEN 0 ELSE 1 END,
                   COALESCE(replication_checked_at, 0), environment_id, target_kind, shard_id
          LIMIT 1`
      )
      .bind(now - FAILED_DRIFT_RETRY_SECONDS, now - HEALTHY_DRIFT_CHECK_INTERVAL_SECONDS)
      .first<DriftTargetRow>();
  }

  private async reconcileDriftTarget(target: DriftTargetRow): Promise<void> {
    const desiredProviderMode = providerMode(target.desired_mode);
    let drifted = false;
    try {
      const current = await this.api.getD1Database(target.provider_database_id);
      if (current.read_replication?.mode !== desiredProviderMode) {
        drifted = true;
        await this.api.updateD1Database(target.provider_database_id, {
          read_replication: { mode: desiredProviderMode },
        });
      }
      const reflected = drifted
        ? await this.api.getD1Database(target.provider_database_id)
        : current;
      if (reflected.read_replication?.mode !== desiredProviderMode) {
        throw new Error('read_replication_provider_state_missing');
      }
      await this.recordDriftResult(target, {
        state: observedState(target.desired_mode),
        errorCode: null,
        auditOutcome: drifted ? 'succeeded' : null,
      });
    } catch (error) {
      await this.recordDriftResult(target, {
        state: 'failed',
        errorCode: errorCode(error),
        auditOutcome: 'failed',
      });
    }
  }

  private async recordDriftResult(
    target: DriftTargetRow,
    input: {
      state: 'disabled' | 'enabled' | 'failed';
      errorCode: string | null;
      auditOutcome: 'succeeded' | 'failed' | null;
    }
  ): Promise<void> {
    const now = this.now();
    const shardUpdate =
      target.target_kind === 'lookup'
        ? this.db
            .prepare(
              `UPDATE control_lookup_physical_shards
                  SET read_replication_mode = ?, observed_replication_state = ?,
                      replication_checked_at = ?, replication_error_code = ?, updated_at = ?
                WHERE lookup_shard_id = ? AND environment_id = ?`
            )
            .bind(
              target.desired_mode,
              input.state,
              now,
              input.errorCode,
              now,
              target.shard_id,
              target.environment_id
            )
        : this.db
            .prepare(
              `UPDATE control_tenant_shards
                  SET read_replication_mode = ?, observed_replication_state = ?,
                      replication_checked_at = ?, replication_error_code = ?, updated_at = ?
                WHERE shard_id = ? AND environment_id = ?`
            )
            .bind(
              target.desired_mode,
              input.state,
              now,
              input.errorCode,
              now,
              target.shard_id,
              target.environment_id
            );
    const statements: D1PreparedStatement[] = [shardUpdate];
    if (input.auditOutcome) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO control_audit_events (
               event_id, environment_id, event_type, actor_type, actor_id,
               resource_kind, resource_id, outcome, redacted_payload_json, created_at
             ) VALUES (?, ?, 'read_replication.drift_reconcile', 'reconciler', 'ar-control',
               'd1', ?, ?, ?, ?)`
          )
          .bind(
            `audit:read-replication:${this.randomId()}`,
            target.environment_id,
            target.shard_id,
            input.auditOutcome,
            JSON.stringify({
              desired_mode: target.desired_mode,
              error_code: input.errorCode,
            }),
            now
          )
      );
    }
    await this.db.batch(statements);
    await this.refreshPolicyObservedStatus(target, now);
  }

  private async refreshPolicyObservedStatus(target: DriftTargetRow, now: number): Promise<void> {
    const desiredState = observedState(target.desired_mode);
    const summary = await (target.target_kind === 'lookup'
      ? this.db
          .prepare(
            `SELECT COUNT(*) AS eligible_count,
                    COALESCE(SUM(CASE WHEN observed_replication_state = ? THEN 1 ELSE 0 END), 0)
                      AS converged_count,
                    COALESCE(SUM(CASE WHEN observed_replication_state = 'failed' THEN 1 ELSE 0 END), 0)
                      AS failed_count
               FROM control_lookup_physical_shards
              WHERE environment_id = ? AND residency_partition = ?
                AND status IN ('ready', 'active', 'draining')`
          )
          .bind(desiredState, target.environment_id, target.residency_partition)
          .first<PolicyObservedSummaryRow>()
      : this.db
          .prepare(
            `SELECT COUNT(*) AS eligible_count,
                    COALESCE(SUM(CASE WHEN observed_replication_state = ? THEN 1 ELSE 0 END), 0)
                      AS converged_count,
                    COALESCE(SUM(CASE WHEN observed_replication_state = 'failed' THEN 1 ELSE 0 END), 0)
                      AS failed_count
               FROM control_tenant_shards
              WHERE environment_id = ? AND data_role = ? AND residency_partition = ?
                AND status IN ('ready', 'active', 'degraded')`
          )
          .bind(desiredState, target.environment_id, target.data_role, target.residency_partition)
          .first<PolicyObservedSummaryRow>());
    const operationStatus =
      Number(summary?.failed_count ?? 0) > 0
        ? 'failed'
        : Number(summary?.eligible_count ?? 0) > 0 &&
            Number(summary?.converged_count ?? 0) === Number(summary?.eligible_count ?? 0)
          ? 'succeeded'
          : 'verifying';
    await this.db
      .prepare(
        `UPDATE control_read_replication_policies
            SET operation_status = ?, updated_at = ?
          WHERE environment_id = ? AND data_role = ? AND residency_partition = ?`
      )
      .bind(
        operationStatus,
        now,
        target.environment_id,
        target.data_role,
        target.residency_partition
      )
      .run();
  }

  private targetInsertStatement(
    operationId: string,
    environmentId: string,
    desiredMode: ControlReadReplicationDesiredMode,
    retryBudgetExpiresAt: number,
    now: number
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO control_read_replication_rollout_targets (
           operation_id, environment_id, desired_resource_id, target_kind, shard_id,
           data_role, residency_partition, desired_mode, status, retry_budget_expires_at,
           created_at, updated_at
         )
         SELECT ?, shard.environment_id, shard.d1_desired_resource_id, 'tenant', shard.shard_id,
                shard.data_role, shard.residency_partition, ?, 'queued', ?, ?, ?
           FROM control_tenant_shards shard
           JOIN control_residency_partitions partition
             ON partition.environment_id = shard.environment_id
            AND partition.residency_partition = shard.residency_partition
            AND partition.status = 'active'
          WHERE shard.environment_id = ?
            AND shard.status IN ('requested', 'provisioning', 'ready', 'active', 'degraded')
         UNION ALL
         SELECT ?, shard.environment_id, shard.d1_desired_resource_id, 'lookup', shard.lookup_shard_id,
                'lookup', shard.residency_partition, ?, 'queued', ?, ?, ?
           FROM control_lookup_physical_shards shard
           JOIN control_residency_partitions partition
             ON partition.environment_id = shard.environment_id
            AND partition.residency_partition = shard.residency_partition
            AND partition.status = 'active'
          WHERE shard.environment_id = ?
            AND shard.status IN ('requested', 'provisioning', 'ready', 'active', 'draining')`
      )
      .bind(
        operationId,
        desiredMode,
        retryBudgetExpiresAt,
        now,
        now,
        environmentId,
        operationId,
        desiredMode,
        retryBudgetExpiresAt,
        now,
        now,
        environmentId
      );
  }

  private async addMissingTargets(operationId: string): Promise<void> {
    const rollout = await this.db
      .prepare(
        `SELECT environment_id, desired_mode, created_at
           FROM control_read_replication_rollouts
          WHERE operation_id = ? AND status IN ('queued', 'applying', 'verifying')`
      )
      .bind(operationId)
      .first<{
        environment_id: string;
        desired_mode: ControlReadReplicationDesiredMode;
        created_at: number;
      }>();
    if (!rollout) return;
    const now = this.now();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_tenant_shards
              SET read_replication_mode = ?, consistency_policy_version = 1, updated_at = ?
            WHERE environment_id = ?
              AND status IN ('requested', 'provisioning', 'ready', 'active', 'degraded')
              AND EXISTS (
                SELECT 1 FROM control_residency_partitions partition
                 WHERE partition.environment_id = control_tenant_shards.environment_id
                   AND partition.residency_partition = control_tenant_shards.residency_partition
                   AND partition.status = 'active'
              )
              AND read_replication_mode <> ?`
        )
        .bind(rollout.desired_mode, now, rollout.environment_id, rollout.desired_mode),
      this.db
        .prepare(
          `UPDATE control_lookup_physical_shards
              SET read_replication_mode = ?, consistency_policy_version = 1, updated_at = ?
            WHERE environment_id = ?
              AND status IN ('requested', 'provisioning', 'ready', 'active', 'draining')
              AND EXISTS (
                SELECT 1 FROM control_residency_partitions partition
                 WHERE partition.environment_id = control_lookup_physical_shards.environment_id
                   AND partition.residency_partition = control_lookup_physical_shards.residency_partition
                   AND partition.status = 'active'
              )
              AND read_replication_mode <> ?`
        )
        .bind(rollout.desired_mode, now, rollout.environment_id, rollout.desired_mode),
      this.targetInsertStatement(
        operationId,
        rollout.environment_id,
        rollout.desired_mode,
        rollout.created_at + RETRY_BUDGET_SECONDS,
        now
      ),
    ]);
  }

  private async claimNext(operationId?: string): Promise<ClaimedTargetRow | null> {
    const now = this.now();
    const lockOwner = `read-replication:${this.randomId()}`;
    return this.db
      .prepare(
        `UPDATE control_read_replication_rollout_targets
            SET status = 'applying', lock_owner = ?, lock_expires_at = ?,
                fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
                next_attempt_at = NULL, updated_at = ?
          WHERE rowid = (
            SELECT target.rowid
              FROM control_read_replication_rollout_targets target
              JOIN control_read_replication_rollouts rollout
                ON rollout.operation_id = target.operation_id
             WHERE rollout.status IN ('queued', 'applying', 'verifying')
               AND (? IS NULL OR target.operation_id = ?)
               AND (
                 target.status = 'queued' OR
                 (target.status = 'waiting_retry' AND target.next_attempt_at <= ?) OR
                 (target.status IN ('applying', 'verifying') AND target.lock_expires_at <= ?)
               )
             ORDER BY target.updated_at, target.operation_id, target.desired_resource_id
             LIMIT 1
          )
          RETURNING operation_id, environment_id, desired_resource_id, target_kind, shard_id,
                    data_role, residency_partition, desired_mode, attempt_count,
                    retry_budget_expires_at, lock_owner, fencing_token`
      )
      .bind(
        lockOwner,
        now + TARGET_LEASE_SECONDS,
        now,
        operationId ?? null,
        operationId ?? null,
        now,
        now
      )
      .first<ClaimedTargetRow>();
  }

  private async applyTarget(target: ClaimedTargetRow): Promise<void> {
    try {
      const resource = await this.db
        .prepare(
          `SELECT observed.provider_resource_id AS provider_database_id
             FROM control_desired_resources desired
             JOIN control_observed_resources observed
               ON observed.observed_resource_id = desired.observed_resource_id
              AND observed.environment_id = desired.environment_id
            WHERE desired.desired_resource_id = ?
              AND desired.environment_id = ?
              AND desired.resource_kind = 'd1'
              AND desired.desired_state = 'present'
              AND observed.observed_state = 'present'`
        )
        .bind(target.desired_resource_id, target.environment_id)
        .first<ProviderResourceRow>();
      if (!resource) throw new Error('read_replication_provider_resource_missing');

      const desiredProviderMode = providerMode(target.desired_mode);
      const before = await this.api.getD1Database(resource.provider_database_id);
      if (before.read_replication?.mode !== desiredProviderMode) {
        await this.api.updateD1Database(resource.provider_database_id, {
          read_replication: { mode: desiredProviderMode },
        });
      }
      await this.db
        .prepare(
          `UPDATE control_read_replication_rollout_targets
              SET status = 'verifying', provider_database_id = ?, updated_at = ?
            WHERE operation_id = ? AND desired_resource_id = ?
              AND lock_owner = ? AND fencing_token = ? AND status = 'applying'`
        )
        .bind(
          resource.provider_database_id,
          this.now(),
          target.operation_id,
          target.desired_resource_id,
          target.lock_owner,
          target.fencing_token
        )
        .run();
      const reflected = await this.api.getD1Database(resource.provider_database_id);
      if (reflected.read_replication?.mode !== desiredProviderMode) {
        throw new Error('read_replication_provider_state_missing');
      }
      await this.completeTarget(target, resource.provider_database_id, desiredProviderMode);
    } catch (error) {
      await this.failTarget(target, errorCode(error));
    }
  }

  private async completeTarget(
    target: ClaimedTargetRow,
    providerDatabaseId: string,
    reflectedMode: 'auto' | 'disabled'
  ): Promise<void> {
    const now = this.now();
    const targetUpdate = this.db
      .prepare(
        `UPDATE control_read_replication_rollout_targets
            SET status = 'succeeded', provider_database_id = ?, observed_provider_mode = ?,
                completed_at = ?, lock_owner = NULL, lock_expires_at = NULL,
                last_error_code = NULL, updated_at = ?
          WHERE operation_id = ? AND desired_resource_id = ?
            AND lock_owner = ? AND fencing_token = ? AND status = 'verifying'`
      )
      .bind(
        providerDatabaseId,
        reflectedMode,
        now,
        now,
        target.operation_id,
        target.desired_resource_id,
        target.lock_owner,
        target.fencing_token
      );
    const [, result] = await this.db.batch([
      target.target_kind === 'lookup'
        ? this.db
            .prepare(
              `UPDATE control_lookup_physical_shards
                  SET read_replication_mode = ?, observed_replication_state = ?,
                      replication_checked_at = ?, replication_error_code = NULL, updated_at = ?
                WHERE lookup_shard_id = ? AND environment_id = ?
                  AND EXISTS (
                    SELECT 1 FROM control_read_replication_rollout_targets rollout_target
                     WHERE rollout_target.operation_id = ?
                       AND rollout_target.desired_resource_id = ?
                       AND rollout_target.lock_owner = ?
                       AND rollout_target.fencing_token = ?
                       AND rollout_target.status = 'verifying'
                  )`
            )
            .bind(
              target.desired_mode,
              observedState(target.desired_mode),
              now,
              now,
              target.shard_id,
              target.environment_id,
              target.operation_id,
              target.desired_resource_id,
              target.lock_owner,
              target.fencing_token
            )
        : this.db
            .prepare(
              `UPDATE control_tenant_shards
                  SET read_replication_mode = ?, observed_replication_state = ?,
                      replication_checked_at = ?, replication_error_code = NULL, updated_at = ?
                WHERE shard_id = ? AND environment_id = ?
                  AND EXISTS (
                    SELECT 1 FROM control_read_replication_rollout_targets rollout_target
                     WHERE rollout_target.operation_id = ?
                       AND rollout_target.desired_resource_id = ?
                       AND rollout_target.lock_owner = ?
                       AND rollout_target.fencing_token = ?
                       AND rollout_target.status = 'verifying'
                  )`
            )
            .bind(
              target.desired_mode,
              observedState(target.desired_mode),
              now,
              now,
              target.shard_id,
              target.environment_id,
              target.operation_id,
              target.desired_resource_id,
              target.lock_owner,
              target.fencing_token
            ),
      targetUpdate,
    ]);
    if (!result?.success || Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error('read_replication_target_lease_lost');
    }
  }

  private async failTarget(target: ClaimedTargetRow, code: string): Promise<void> {
    const now = this.now();
    const blocked = now >= target.retry_budget_expires_at;
    const nextStatus = blocked ? 'blocked' : 'waiting_retry';
    const nextAttemptAt = blocked ? null : now + retryDelay(target.attempt_count);
    const targetUpdate = this.db
      .prepare(
        `UPDATE control_read_replication_rollout_targets
            SET status = ?, next_attempt_at = ?, last_error_code = ?,
                lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
          WHERE operation_id = ? AND desired_resource_id = ?
            AND lock_owner = ? AND fencing_token = ? AND status IN ('applying', 'verifying')`
      )
      .bind(
        nextStatus,
        nextAttemptAt,
        code,
        now,
        target.operation_id,
        target.desired_resource_id,
        target.lock_owner,
        target.fencing_token
      );
    const shardUpdate =
      target.target_kind === 'lookup'
        ? this.db
            .prepare(
              `UPDATE control_lookup_physical_shards
                  SET observed_replication_state = ?, replication_checked_at = ?,
                      replication_error_code = ?, updated_at = ?
                WHERE lookup_shard_id = ? AND environment_id = ?
                  AND EXISTS (
                    SELECT 1 FROM control_read_replication_rollout_targets rollout_target
                     WHERE rollout_target.operation_id = ?
                       AND rollout_target.desired_resource_id = ?
                       AND rollout_target.lock_owner = ?
                       AND rollout_target.fencing_token = ?
                       AND rollout_target.status IN ('applying', 'verifying')
                  )`
            )
            .bind(
              blocked ? 'failed' : 'enabling',
              now,
              code,
              now,
              target.shard_id,
              target.environment_id,
              target.operation_id,
              target.desired_resource_id,
              target.lock_owner,
              target.fencing_token
            )
        : this.db
            .prepare(
              `UPDATE control_tenant_shards
                  SET observed_replication_state = ?, replication_checked_at = ?,
                      replication_error_code = ?, updated_at = ?
                WHERE shard_id = ? AND environment_id = ?
                  AND EXISTS (
                    SELECT 1 FROM control_read_replication_rollout_targets rollout_target
                     WHERE rollout_target.operation_id = ?
                       AND rollout_target.desired_resource_id = ?
                       AND rollout_target.lock_owner = ?
                       AND rollout_target.fencing_token = ?
                       AND rollout_target.status IN ('applying', 'verifying')
                  )`
            )
            .bind(
              blocked ? 'failed' : 'enabling',
              now,
              code,
              now,
              target.shard_id,
              target.environment_id,
              target.operation_id,
              target.desired_resource_id,
              target.lock_owner,
              target.fencing_token
            );
    await this.db.batch([shardUpdate, targetUpdate]);
  }

  private async refreshRollout(operationId: string, environmentId: string): Promise<void> {
    const now = this.now();
    const counts = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM control_read_replication_policies policy
             WHERE policy.environment_id = ? AND policy.operation_id = ?) AS policy_count,
           (SELECT COUNT(*) FROM control_read_replication_policies policy
             WHERE policy.environment_id = ? AND policy.operation_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM control_read_replication_rollout_targets target
                  WHERE target.operation_id = ?
                    AND target.data_role = policy.data_role
                    AND target.residency_partition = policy.residency_partition
                    AND target.status <> 'succeeded'
               )) AS applied_policy_count,
           (SELECT COUNT(*) FROM control_read_replication_policies policy
             WHERE policy.environment_id = ? AND policy.operation_id = ?
               AND EXISTS (
                 SELECT 1 FROM control_read_replication_rollout_targets target
                  WHERE target.operation_id = ?
                    AND target.data_role = policy.data_role
                    AND target.residency_partition = policy.residency_partition
                    AND target.status = 'blocked'
               )) AS failed_policy_count,
           (SELECT COUNT(*) FROM control_read_replication_rollout_targets WHERE operation_id = ?) AS target_count,
           (SELECT COUNT(*) FROM control_read_replication_rollout_targets
             WHERE operation_id = ? AND status = 'succeeded') AS completed_target_count,
           (SELECT COUNT(*) FROM control_read_replication_rollout_targets
             WHERE operation_id = ? AND status = 'blocked') AS blocked_target_count`
      )
      .bind(
        environmentId,
        operationId,
        environmentId,
        operationId,
        operationId,
        environmentId,
        operationId,
        operationId,
        operationId,
        operationId,
        operationId
      )
      .first<RolloutCountsRow>();
    if (!counts) return;

    const pendingTargets =
      counts.target_count - counts.completed_target_count - counts.blocked_target_count;
    const rolloutStatus =
      counts.blocked_target_count > 0
        ? 'attention_required'
        : pendingTargets > 0
          ? 'verifying'
          : 'succeeded';
    const operationStatus =
      counts.blocked_target_count > 0 ? 'blocked' : pendingTargets > 0 ? 'running' : 'succeeded';
    const stepStatus =
      counts.blocked_target_count > 0 ? 'blocked' : pendingTargets > 0 ? 'running' : 'succeeded';
    const completedAt = pendingTargets === 0 ? now : null;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_read_replication_rollouts
              SET status = ?, eligible_policy_count = ?, applied_policy_count = ?,
                  failed_policy_count = ?, last_error_code = ?, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND status IN ('queued', 'applying', 'verifying', 'attention_required', 'blocked')`
        )
        .bind(
          rolloutStatus,
          counts.policy_count,
          counts.applied_policy_count,
          counts.failed_policy_count,
          counts.blocked_target_count > 0 ? 'read_replication_rollout_target_blocked' : null,
          completedAt,
          now,
          operationId,
          environmentId
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = ?, last_error_code = ?, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND status IN ('queued', 'running', 'waiting_retry', 'blocked')`
        )
        .bind(
          operationStatus,
          counts.blocked_target_count > 0 ? 'read_replication_rollout_target_blocked' : null,
          completedAt,
          now,
          operationId,
          environmentId
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = ?, progress_current = ?, progress_total = ?,
                  last_error_code = ?, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = 'apply-and-verify'
              AND status IN ('queued', 'running', 'waiting_retry', 'blocked')`
        )
        .bind(
          stepStatus,
          counts.completed_target_count,
          counts.target_count,
          counts.blocked_target_count > 0 ? 'read_replication_rollout_target_blocked' : null,
          completedAt,
          now,
          operationId
        ),
      this.db
        .prepare(
          `UPDATE control_read_replication_policies AS policy
              SET operation_status = CASE
                    WHEN EXISTS (
                      SELECT 1 FROM control_read_replication_rollout_targets target
                       WHERE target.operation_id = ?
                         AND target.data_role = policy.data_role
                         AND target.residency_partition = policy.residency_partition
                         AND target.status = 'blocked'
                    ) THEN 'blocked'
                    WHEN NOT EXISTS (
                      SELECT 1 FROM control_read_replication_rollout_targets target
                       WHERE target.operation_id = ?
                         AND target.data_role = policy.data_role
                         AND target.residency_partition = policy.residency_partition
                         AND target.status <> 'succeeded'
                    ) THEN 'succeeded'
                    ELSE 'verifying'
                  END,
                  updated_at = ?
            WHERE environment_id = ? AND operation_id = ?`
        )
        .bind(operationId, operationId, now, environmentId, operationId),
    ]);
  }
}

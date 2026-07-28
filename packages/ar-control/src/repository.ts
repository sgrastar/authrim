import type {
  ControlOperationView,
  LowWatermarkRequest,
  TenantShardDataRole,
  TenantShardPlan,
} from './types';

export interface EnvironmentRow {
  environment_id: string;
  environment_name: string;
  lifecycle_state: 'creating' | 'active';
}

export interface ResidencyPartitionRow {
  residency_policy_id: string;
  residency_partition: string;
  jurisdiction: 'eu' | 'fedramp' | null;
  location_hint: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc' | null;
}

export interface ResourcePolicyRow {
  max_concurrent_provisioning: number;
  max_ready_spares: number;
  max_d1_resources: number;
  daily_d1_create_budget: number;
  target_account_count: number;
}

export interface ReadReplicationPolicyRow {
  desired_mode: 'enabled' | 'disabled';
  consistency_policy_version: number;
}

interface OperationRow {
  operation_id: string;
  environment_id: string;
  operation_kind: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  fencing_token: number;
}

export interface ProvisioningLease {
  operation: ControlOperationView;
  ownerId: string;
  fencingToken: number;
}

interface PendingPlanRow {
  operation_id: string;
  desired_resource_id: string;
  shard_id: string;
  environment_id: string;
  environment_name: string;
  data_role: TenantShardDataRole;
  residency_policy_id: string;
  residency_partition: string;
  logical_shard_id: string;
  deterministic_name: string;
  binding_ref: string;
  ownership_fingerprint: string;
  jurisdiction: 'eu' | 'fedramp' | null;
  location_hint: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc' | null;
  idempotency_key: string;
  read_replication_mode: 'enabled' | 'disabled';
}

interface LowWatermarkRow {
  environment_id: string;
  data_role: TenantShardDataRole;
  residency_policy_id: string;
  residency_partition: string;
  supply_count: number;
}

export interface ControlRepository {
  getEnvironment(environmentId: string): Promise<EnvironmentRow | null>;
  getResidencyPartition(
    environmentId: string,
    residencyPolicyId: string,
    residencyPartition: string
  ): Promise<ResidencyPartitionRow | null>;
  getResourcePolicy(environmentId: string): Promise<ResourcePolicyRow | null>;
  getReadReplicationPolicy(
    environmentId: string,
    dataRole: TenantShardDataRole,
    residencyPartition: string
  ): Promise<ReadReplicationPolicyRow | null>;
  createShardPlan(
    plan: TenantShardPlan,
    now: number,
    requestedByType: 'admin' | 'scheduler'
  ): Promise<ControlOperationView>;
  getOperation(operationId: string): Promise<ControlOperationView | null>;
  listPendingShardPlans(limit: number): Promise<TenantShardPlan[]>;
  listLowWatermarkRequests(limit: number): Promise<LowWatermarkRequest[]>;
  tryStartProvisioning(
    operationId: string,
    ownerId: string,
    now: number
  ): Promise<ProvisioningLease | null>;
  reserveD1CreateBudget(lease: ProvisioningLease, now: number): Promise<boolean>;
  markDatabaseCreated(
    lease: ProvisioningLease,
    plan: TenantShardPlan,
    databaseId: string,
    observedReplicationMode: 'enabled' | 'disabled',
    now: number
  ): Promise<ControlOperationView>;
  markOperationRetry(
    lease: ProvisioningLease,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void>;
  markOperationDeferredIfRunnable(
    operationId: string,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void>;
  markOperationBlocked(lease: ProvisioningLease, errorCode: string, now: number): Promise<void>;
}

function operationView(row: OperationRow): ControlOperationView {
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    operationKind: row.operation_kind,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function planFromPendingRow(row: PendingPlanRow): TenantShardPlan {
  return {
    operationId: row.operation_id,
    desiredResourceId: row.desired_resource_id,
    shardId: row.shard_id,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    dataRole: row.data_role,
    residencyPolicyId: row.residency_policy_id,
    residencyPartition: row.residency_partition,
    logicalShardId: row.logical_shard_id,
    databaseName: row.deterministic_name,
    bindingRef: row.binding_ref,
    ownershipFingerprint: row.ownership_fingerprint,
    jurisdiction: row.jurisdiction ?? undefined,
    locationHint: row.location_hint ?? undefined,
    idempotencyKey: row.idempotency_key,
    readReplicationMode: row.read_replication_mode,
  };
}

export class D1ControlRepository implements ControlRepository {
  constructor(private readonly db: D1Database) {}

  getEnvironment(environmentId: string): Promise<EnvironmentRow | null> {
    return this.db
      .prepare(
        `SELECT environment_id, environment_name, lifecycle_state
           FROM control_environments
          WHERE environment_id = ? AND lifecycle_state IN ('creating', 'active')`
      )
      .bind(environmentId)
      .first<EnvironmentRow>();
  }

  getResidencyPartition(
    environmentId: string,
    residencyPolicyId: string,
    residencyPartition: string
  ): Promise<ResidencyPartitionRow | null> {
    return this.db
      .prepare(
        `SELECT residency_policy_id, residency_partition, jurisdiction, location_hint
           FROM control_residency_partitions
          WHERE environment_id = ?
            AND residency_policy_id = ?
            AND residency_partition = ?
            AND status = 'active'`
      )
      .bind(environmentId, residencyPolicyId, residencyPartition)
      .first<ResidencyPartitionRow>();
  }

  getResourcePolicy(environmentId: string): Promise<ResourcePolicyRow | null> {
    return this.db
      .prepare(
        `SELECT max_concurrent_provisioning, max_ready_spares, max_d1_resources,
                daily_d1_create_budget, target_account_count
           FROM control_environment_resource_policies
          WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<ResourcePolicyRow>();
  }

  getReadReplicationPolicy(
    environmentId: string,
    dataRole: TenantShardDataRole,
    residencyPartition: string
  ): Promise<ReadReplicationPolicyRow | null> {
    return this.db
      .prepare(
        `SELECT desired_mode, consistency_policy_version
           FROM control_read_replication_policies
          WHERE environment_id = ? AND data_role = ? AND residency_partition = ?`
      )
      .bind(environmentId, dataRole, residencyPartition)
      .first<ReadReplicationPolicyRow>();
  }

  async createShardPlan(
    plan: TenantShardPlan,
    now: number,
    requestedByType: 'admin' | 'scheduler'
  ): Promise<ControlOperationView> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, attempt_count, created_at, updated_at
           ) VALUES (?, ?, 'provision_shard', ?, 'pending', ?, 0, ?, ?)`
        )
        .bind(plan.operationId, plan.environmentId, plan.idempotencyKey, requestedByType, now, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'create_d1', 10, 'pending', 0, ?)`
        )
        .bind(plan.operationId, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'apply_migrations', 20, 'pending', 0, ?)`
        )
        .bind(plan.operationId, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_desired_resources (
             desired_resource_id, environment_id, resource_kind, logical_shard_id,
             deterministic_name, ownership_fingerprint, provisioning_state,
             origin_operation_id, desired_spec_json, created_at, updated_at
           ) VALUES (?, ?, 'd1', ?, ?, ?, 'requested', ?, ?, ?, ?)`
        )
        .bind(
          plan.desiredResourceId,
          plan.environmentId,
          plan.logicalShardId,
          plan.databaseName,
          plan.ownershipFingerprint,
          plan.operationId,
          JSON.stringify({
            data_role: plan.dataRole,
            residency_policy_id: plan.residencyPolicyId,
            residency_partition: plan.residencyPartition,
            jurisdiction: plan.jurisdiction,
            location_hint: plan.locationHint,
            read_replication_mode: plan.readReplicationMode,
          }),
          now,
          now
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_tenant_shards (
             shard_id, environment_id, data_role, residency_policy_id, residency_partition,
             generation, logical_shard_id, binding_ref, d1_desired_resource_id,
             jurisdiction, location_hint, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'requested', ?, ?)`
        )
        .bind(
          plan.shardId,
          plan.environmentId,
          plan.dataRole,
          plan.residencyPolicyId,
          plan.residencyPartition,
          plan.logicalShardId,
          plan.bindingRef,
          plan.desiredResourceId,
          plan.jurisdiction ?? null,
          plan.locationHint ?? null,
          now,
          now
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'control.shard.provision.requested', ?,
                     'd1', ?, 'attempted', ?, ?)`
        )
        .bind(
          `audit:${plan.operationId}:requested`,
          plan.environmentId,
          plan.operationId,
          requestedByType,
          plan.desiredResourceId,
          JSON.stringify({
            data_role: plan.dataRole,
            residency_partition: plan.residencyPartition,
          }),
          now
        ),
    ]);
    const operation = await this.getOperationByIdempotency(plan.environmentId, plan.idempotencyKey);
    if (!operation || operation.operationId !== plan.operationId) {
      throw new Error('control_operation_idempotency_conflict');
    }
    return operation;
  }

  async getOperation(operationId: string): Promise<ControlOperationView | null> {
    const row = await this.db
      .prepare(
        `SELECT operation_id, environment_id, operation_kind, status, attempt_count,
                next_attempt_at, last_error_code, created_at, updated_at, fencing_token
           FROM control_operations
          WHERE operation_id = ?`
      )
      .bind(operationId)
      .first<OperationRow>();
    return row ? operationView(row) : null;
  }

  private async getOperationByIdempotency(
    environmentId: string,
    idempotencyKey: string
  ): Promise<ControlOperationView | null> {
    const row = await this.db
      .prepare(
        `SELECT operation_id, environment_id, operation_kind, status, attempt_count,
                next_attempt_at, last_error_code, created_at, updated_at, fencing_token
           FROM control_operations
          WHERE environment_id = ? AND idempotency_key = ?`
      )
      .bind(environmentId, idempotencyKey)
      .first<OperationRow>();
    return row ? operationView(row) : null;
  }

  async listPendingShardPlans(limit: number): Promise<TenantShardPlan[]> {
    const result = await this.db
      .prepare(
        `SELECT o.operation_id, o.environment_id, o.idempotency_key,
                d.desired_resource_id, d.logical_shard_id, d.deterministic_name,
                d.ownership_fingerprint, s.shard_id, s.data_role, s.residency_policy_id,
                s.residency_partition, s.binding_ref, s.jurisdiction, s.location_hint,
                s.read_replication_mode, e.environment_name
           FROM control_operations o
           JOIN control_desired_resources d ON d.origin_operation_id = o.operation_id
           JOIN control_tenant_shards s ON s.d1_desired_resource_id = d.desired_resource_id
           JOIN control_environments e ON e.environment_id = o.environment_id
          WHERE o.operation_kind = 'provision_shard'
            AND o.status IN ('pending', 'running', 'waiting')
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= unixepoch())
            AND d.observed_resource_id IS NULL
          ORDER BY o.created_at
          LIMIT ?`
      )
      .bind(limit)
      .all<PendingPlanRow>();
    return result.results.map(planFromPendingRow);
  }

  async listLowWatermarkRequests(limit: number): Promise<LowWatermarkRequest[]> {
    const result = await this.db
      .prepare(
        `WITH roles(data_role) AS (
           SELECT 'tenant_core/default' UNION ALL
           SELECT 'tenant_core/users' UNION ALL
           SELECT 'tenant_pii'
         ), shard_state AS (
           SELECT s.environment_id, s.data_role, s.residency_policy_id, s.residency_partition,
                  SUM(CASE WHEN s.status IN ('requested', 'provisioning', 'ready') THEN 1 ELSE 0 END)
                    AS supply_count,
                  MAX(CASE
                    WHEN s.status IN ('ready', 'active')
                     AND c.health_status = 'healthy'
                     AND c.allocation_status = 'eligible'
                     AND (c.target_account_count - c.allocated_account_count) * 5 >= c.target_account_count
                    THEN 1 ELSE 0 END) AS has_healthy_capacity
             FROM control_tenant_shards s
             LEFT JOIN control_shard_capacity c ON c.shard_id = s.shard_id
            GROUP BY environment_id, data_role, residency_policy_id, residency_partition
         )
         SELECT p.environment_id, roles.data_role, p.residency_policy_id, p.residency_partition,
                COALESCE(s.supply_count, 0) AS supply_count
           FROM control_residency_partitions p
           JOIN control_environment_resource_policies policy ON policy.environment_id = p.environment_id
           CROSS JOIN roles
           LEFT JOIN shard_state s
             ON s.environment_id = p.environment_id
            AND s.data_role = roles.data_role
            AND s.residency_policy_id = p.residency_policy_id
            AND s.residency_partition = p.residency_partition
          WHERE p.status = 'active'
            AND COALESCE(s.has_healthy_capacity, 0) = 0
            AND COALESCE(s.supply_count, 0) < policy.max_ready_spares
          ORDER BY p.environment_id, p.residency_partition, roles.data_role
          LIMIT ?`
      )
      .bind(limit)
      .all<LowWatermarkRow>();
    return result.results.map((row) => ({
      environmentId: row.environment_id,
      dataRole: row.data_role,
      residencyPolicyId: row.residency_policy_id,
      residencyPartition: row.residency_partition,
      supplyCount: row.supply_count,
    }));
  }

  async tryStartProvisioning(
    operationId: string,
    ownerId: string,
    now: number
  ): Promise<ProvisioningLease | null> {
    const leaseExpiresAt = now + 5 * 60;
    const started = await this.db
      .prepare(
        `UPDATE control_operations AS candidate
            SET status = 'running', attempt_count = attempt_count + 1,
                next_attempt_at = NULL, last_error_code = NULL,
                lock_owner = ?, lock_expires_at = ?, fencing_token = fencing_token + 1,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ?
            AND (
              status IN ('pending', 'waiting') OR
              (status = 'running' AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?)
            )
            AND (
              SELECT COUNT(*) FROM control_operations active
               WHERE active.environment_id = candidate.environment_id
                 AND active.operation_kind = 'provision_shard'
                 AND active.status = 'running'
                 AND active.operation_id <> candidate.operation_id
            ) < COALESCE((
              SELECT policy.max_concurrent_provisioning
                FROM control_environment_resource_policies policy
               WHERE policy.environment_id = candidate.environment_id
            ), 0)`
      )
      .bind(ownerId, leaseExpiresAt, now, now, operationId, now)
      .run();
    if ((started.meta.changes ?? 0) === 0) return null;

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'create_d1'`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_desired_resources
              SET provisioning_state = 'creating', create_started_at = COALESCE(create_started_at, ?), updated_at = ?
            WHERE origin_operation_id = ?`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'provisioning', updated_at = ?
            WHERE d1_desired_resource_id IN (
              SELECT desired_resource_id FROM control_desired_resources WHERE origin_operation_id = ?
            )`
        )
        .bind(now, operationId),
    ]);
    const row = await this.db
      .prepare(
        `SELECT operation_id, environment_id, operation_kind, status, attempt_count,
                next_attempt_at, last_error_code, created_at, updated_at, fencing_token
           FROM control_operations
          WHERE operation_id = ? AND lock_owner = ?`
      )
      .bind(operationId, ownerId)
      .first<OperationRow>();
    return row ? { operation: operationView(row), ownerId, fencingToken: row.fencing_token } : null;
  }

  async reserveD1CreateBudget(lease: ProvisioningLease, now: number): Promise<boolean> {
    const budgetDay = Math.floor(now / 86_400);
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO control_d1_create_budget_reservations (
           operation_id, environment_id, budget_day, created_at
         )
         SELECT o.operation_id, o.environment_id, ?, ?
           FROM control_operations o
           JOIN control_environment_resource_policies p ON p.environment_id = o.environment_id
          WHERE o.operation_id = ? AND o.lock_owner = ? AND o.fencing_token = ?
            AND o.operation_kind = 'provision_shard'
            AND (
              SELECT COUNT(*) FROM control_d1_create_budget_reservations r
               WHERE r.environment_id = o.environment_id AND r.budget_day = ?
            ) < p.daily_d1_create_budget`
      )
      .bind(
        budgetDay,
        now,
        lease.operation.operationId,
        lease.ownerId,
        lease.fencingToken,
        budgetDay
      )
      .run();
    const reservation = await this.db
      .prepare(
        `SELECT operation_id FROM control_d1_create_budget_reservations
          WHERE operation_id = ?`
      )
      .bind(lease.operation.operationId)
      .first<{ operation_id: string }>();
    return reservation !== null;
  }

  async markDatabaseCreated(
    lease: ProvisioningLease,
    plan: TenantShardPlan,
    databaseId: string,
    observedReplicationMode: 'enabled' | 'disabled',
    now: number
  ): Promise<ControlOperationView> {
    const observedId = `observed:${plan.desiredResourceId}`;
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO control_observed_resources (
             observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
             provider_name, resource_kind, ownership_fingerprint, observed_state,
             observed_spec_json, observed_at
           ) SELECT ?, ?, ?, ?, ?, 'd1', ?, 'present', '{}', ?
             WHERE EXISTS (
               SELECT 1 FROM control_operations
                WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
             )
           ON CONFLICT(observed_resource_id) DO UPDATE SET
             provider_resource_id = excluded.provider_resource_id,
             observed_state = 'present', observed_at = excluded.observed_at
           WHERE EXISTS (
             SELECT 1 FROM control_operations
              WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
           )`
        )
        .bind(
          observedId,
          plan.environmentId,
          plan.desiredResourceId,
          databaseId,
          plan.databaseName,
          plan.ownershipFingerprint,
          now,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_tenant_shards
              SET read_replication_mode = ?, observed_replication_state = ?, updated_at = ?
            WHERE shard_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(
          plan.readReplicationMode,
          observedReplicationMode,
          now,
          plan.shardId,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_desired_resources
              SET observed_resource_id = ?, provisioning_state = 'provisioning', updated_at = ?
            WHERE desired_resource_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(
          observedId,
          now,
          plan.desiredResourceId,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', observed_resource_id = ?, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = 'create_d1' AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(
          databaseId,
          now,
          now,
          plan.operationId,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting', next_attempt_at = NULL,
                  lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?`
        )
        .bind(now, plan.operationId, lease.ownerId, lease.fencingToken),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, ?, 'control.d1.create', 'reconciler',
                    'd1', ?, 'succeeded', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM control_operations
                WHERE operation_id = ? AND fencing_token = ? AND status = 'waiting'
             )`
        )
        .bind(
          `audit:${plan.operationId}:${lease.fencingToken}:d1-created`,
          plan.environmentId,
          plan.operationId,
          plan.desiredResourceId,
          JSON.stringify({ provider_resource_id: databaseId }),
          now,
          plan.operationId,
          lease.fencingToken
        ),
    ]);
    const operation = await this.getOperation(plan.operationId);
    if (!operation) throw new Error('control_operation_missing_after_database_create');
    return operation;
  }

  async markOperationRetry(
    lease: ProvisioningLease,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting', next_attempt_at = ?, last_error_code = ?,
                  last_error_redacted = NULL, lock_owner = NULL, lock_expires_at = NULL,
                  updated_at = ?
            WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?`
        )
        .bind(
          nextAttemptAt,
          errorCode,
          now,
          lease.operation.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, environment_id, operation_id, 'control.d1.create', 'reconciler',
                    'd1', NULL, 'failed', ?, ?
               FROM control_operations
              WHERE operation_id = ? AND fencing_token = ? AND status = 'waiting'`
        )
        .bind(
          `audit:${lease.operation.operationId}:${lease.fencingToken}:retry`,
          JSON.stringify({ error_code: errorCode, retry_at: nextAttemptAt }),
          now,
          lease.operation.operationId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'waiting', next_attempt_at = ?, last_error_code = ?,
                  last_error_redacted = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = 'create_d1' AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND fencing_token = ?
            )`
        )
        .bind(
          nextAttemptAt,
          errorCode,
          now,
          lease.operation.operationId,
          lease.operation.operationId,
          lease.fencingToken
        ),
    ]);
  }

  async markOperationDeferredIfRunnable(
    operationId: string,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE control_operations
            SET status = 'waiting', next_attempt_at = ?, last_error_code = ?, updated_at = ?
          WHERE operation_id = ? AND status IN ('pending', 'waiting')`
      )
      .bind(nextAttemptAt, errorCode, now, operationId)
      .run();
  }

  async markOperationBlocked(
    lease: ProvisioningLease,
    errorCode: string,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?,
                  lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?`
        )
        .bind(errorCode, now, lease.operation.operationId, lease.ownerId, lease.fencingToken),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = 'create_d1' AND status <> 'succeeded'
              AND EXISTS (
                SELECT 1 FROM control_operations
                 WHERE operation_id = ? AND fencing_token = ?
              )`
        )
        .bind(
          errorCode,
          now,
          lease.operation.operationId,
          lease.operation.operationId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, environment_id, operation_id, 'control.d1.create', 'reconciler',
                    'd1', NULL, 'blocked', ?, ?
               FROM control_operations
              WHERE operation_id = ? AND fencing_token = ? AND status = 'blocked'`
        )
        .bind(
          `audit:${lease.operation.operationId}:${lease.fencingToken}:blocked`,
          JSON.stringify({ error_code: errorCode }),
          now,
          lease.operation.operationId,
          lease.fencingToken
        ),
    ]);
  }
}

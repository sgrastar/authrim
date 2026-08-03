import type {
  ControlOperationView,
  LowWatermarkRequest,
  PendingMigrationPlan,
  ProvisionedD1DataRole,
  TenantShardDataRole,
  TenantShardPlan,
} from './types';
import type {
  ControlAccountDataRole,
  ControlAccountDirectorySourceShard,
  ControlAccountRouteSourceShard,
  ControlProvisioningOperationDetail,
  ControlProvisioningOperationCancelRequest,
  ControlProvisioningOperationRestoreRequest,
  ControlProvisioningOperationRetryRequest,
  ControlProvisioningOperationStepSummary,
  ControlCapacityPlannerInput,
  ControlCapacityTargetInput,
  ControlTenantShardCapacityTarget,
  ControlTenantDeletionLookupShardTarget,
  ControlTenantDeletionShardTarget,
  ControlTenantDeletionFinalization,
  ControlTenantPlacementPolicy,
  ControlTenantPlacementPolicyActivationRequest,
  ControlTenantPlacementPolicyRegistrationRequest,
  ControlTenantRuntimeRouteObservation,
  ControlTenantShardAllocationScope,
  ControlWorkerInventoryDriftReviewRequest,
} from '@authrim/ar-lib-core/control-plane';

export interface EnvironmentRow {
  environment_id: string;
  environment_name: string;
  lifecycle_state: 'creating' | 'active';
}

export interface ProvisioningAuthorityRow {
  automaticProvisioningEnabled: boolean;
  tokenOwnership: 'none' | 'user' | 'account';
  capabilityState: 'disabled' | 'pending' | 'ready' | 'blocked';
}

export interface ResidencyPartitionRow {
  residency_policy_id: string;
  residency_partition: string;
  jurisdiction: 'eu' | 'fedramp' | null;
  location_hint: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc' | null;
}

export interface TenantActiveResidencyRow extends ResidencyPartitionRow {
  policy_generation: number;
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

export type TenantShardCandidate = Omit<ControlTenantShardCapacityTarget, 'assignmentGeneration'>;

export interface DesiredWorkerInventoryRow {
  environment_id: string;
  worker_script_name: string;
  package_name: string;
  deployment_target: string;
  capability_manifest_digest: string;
  source_kind: 'core_manifest' | 'extension_manifest' | 'plugin_manifest';
  status: 'active';
}

export interface WorkerInventoryDriftFindingRow {
  finding_id: string;
  environment_id: string;
  worker_script_name: string;
  finding_kind: 'actual_only';
  severity: 'warning';
  review_state: 'unreviewed' | 'reviewed' | 'dismissed' | 'resolved';
  notification_state: 'pending' | 'acknowledged' | 'resolved';
  first_observed_at: number;
  last_observed_at: number;
  resolved_at: number | null;
  notified_at: number | null;
}

interface OperationRow {
  operation_id: string;
  environment_id: string;
  operation_kind: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  retry_budget_started_at?: number | null;
  created_at: number;
  updated_at: number;
  fencing_token: number;
}

interface OperatorRetryAuditRow {
  environment_id: string;
  operation_id: string | null;
  actor_id: string | null;
  resource_id: string | null;
  redacted_payload_json: string;
}

type OperatorMutationAuditRow = OperatorRetryAuditRow;

interface OperationStepRow {
  step_key: string;
  display_order: number;
  status: ControlProvisioningOperationStepSummary['status'];
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  observed_resource_id: string | null;
  progress_current: number | null;
  progress_total: number | null;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

interface OperationActionAvailabilityRow {
  retry_create_d1: number;
  retry_apply_migrations: number;
  retry_reconcile_worker_bindings: number;
  restore_previous_settings: number;
  cancel_operation: number;
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
  data_role: ProvisionedD1DataRole;
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
  allocation_scope: ControlTenantShardAllocationScope;
  owner_tenant_id: string | null;
}

interface LowWatermarkRow {
  environment_id: string;
  data_role: TenantShardDataRole;
  residency_policy_id: string;
  residency_partition: string;
  supply_count: number;
}

interface ActiveMigrationReleaseRow {
  stream_id: string;
  release_id: string;
  manifest_digest: string;
  manifest_r2_object_key: string;
}

interface PendingMigrationRow {
  operation_id: string;
  desired_resource_id: string;
  shard_id: string;
  environment_id: string;
  provider_database_id: string;
  stream_id: 'd1-core' | 'd1-pii' | 'd1-lookup';
  release_id: string;
  manifest_digest: string;
  manifest_r2_object_key: string;
  binding_ref: string;
  data_role: ProvisionedD1DataRole;
  residency_partition: string;
  generation: number;
}

export interface ControlRepository {
  getEnvironment(environmentId: string): Promise<EnvironmentRow | null>;
  getProvisioningAuthority?(environmentId: string): Promise<ProvisioningAuthorityRow | null>;
  resumeAutomaticBootstrapOperations?(environmentId: string, now: number): Promise<number>;
  markOperationAwaitingOperator?(operationId: string, now: number): Promise<ControlOperationView>;
  getResidencyPartition(
    environmentId: string,
    residencyPolicyId: string,
    residencyPartition: string
  ): Promise<ResidencyPartitionRow | null>;
  listTenantActiveResidencies?(
    environmentId: string,
    tenantId: string
  ): Promise<TenantActiveResidencyRow[]>;
  getResourcePolicy(environmentId: string): Promise<ResourcePolicyRow | null>;
  getTenantPlacementPolicy(
    environmentId: string,
    tenantId: string
  ): Promise<ControlTenantPlacementPolicy | null>;
  registerTenantPlacementPolicy(
    input: ControlTenantPlacementPolicyRegistrationRequest & { environmentId: string },
    now: number
  ): Promise<ControlTenantPlacementPolicy>;
  activateTenantPlacementPolicy(
    input: ControlTenantPlacementPolicyActivationRequest & { environmentId: string },
    now: number
  ): Promise<ControlTenantPlacementPolicy>;
  getReadReplicationPolicy(
    environmentId: string,
    dataRole: ProvisionedD1DataRole,
    residencyPartition: string
  ): Promise<ReadReplicationPolicyRow | null>;
  getActiveDesiredWorker(
    environmentId: string,
    workerScriptName: string
  ): Promise<DesiredWorkerInventoryRow | null>;
  createShardPlan(
    plan: TenantShardPlan,
    now: number,
    requestedByType: 'admin' | 'scheduler'
  ): Promise<ControlOperationView>;
  getOperation(operationId: string, environmentId?: string): Promise<ControlOperationView | null>;
  getProvisioningOperation?(
    operationId: string,
    environmentId: string
  ): Promise<ControlProvisioningOperationDetail | null>;
  retryProvisioningOperationStep(
    input: ControlProvisioningOperationRetryRequest,
    environmentId: string,
    now: number
  ): Promise<ControlProvisioningOperationDetail>;
  cancelProvisioningOperation(
    input: ControlProvisioningOperationCancelRequest,
    environmentId: string,
    now: number
  ): Promise<ControlProvisioningOperationDetail>;
  restoreProvisioningOperationPreviousSettings(
    input: ControlProvisioningOperationRestoreRequest,
    environmentId: string,
    now: number
  ): Promise<ControlProvisioningOperationDetail>;
  findEligibleTenantShard(input: {
    environmentId: string;
    tenantId: string;
    dataRole: TenantShardDataRole;
    residencyPolicyId: string;
    residencyPartition: string;
    allocationScope: ControlTenantShardAllocationScope;
    ownerTenantId: string | null;
  }): Promise<ControlTenantShardCapacityTarget | null>;
  listActiveTenantShardTargets(input: {
    environmentId: string;
    tenantId: string;
    residencyPolicyId: string;
    residencyPartition: string;
  }): Promise<ControlTenantShardCapacityTarget[]>;
  listTenantDeletionLookupShards(
    environmentId: string
  ): Promise<ControlTenantDeletionLookupShardTarget[]>;
  listTenantDeletionShards(input: {
    environmentId: string;
    tenantId: string;
  }): Promise<ControlTenantDeletionShardTarget[]>;
  getTenantDeletionFinalization(input: {
    environmentId: string;
    tenantId: string;
    operationId: string;
  }): Promise<ControlTenantDeletionFinalization | null>;
  finalizeTenantDeletionControlState(
    input: {
      environmentId: string;
      tenantId: string;
      operationId: string;
    },
    now: number
  ): Promise<ControlTenantDeletionFinalization>;
  findAssignableTenantShard(input: {
    environmentId: string;
    tenantId: string;
    dataRole: TenantShardDataRole;
    residencyPolicyId: string;
    residencyPartition: string;
    allocationScope: ControlTenantShardAllocationScope;
    ownerTenantId: string | null;
  }): Promise<TenantShardCandidate | null>;
  assignTenantShard(
    input: {
      environmentId: string;
      tenantId: string;
      dataRole: TenantShardDataRole;
      residencyPolicyId: string;
      residencyPartition: string;
      shardId: string;
      sourceOperationId: string;
    },
    now: number
  ): Promise<ControlTenantShardCapacityTarget>;
  hasTenantShardAssignment(input: {
    environmentId: string;
    tenantId: string;
    dataRole: TenantShardDataRole;
    residencyPartition: string;
  }): Promise<boolean>;
  findCapacityProvisioningOperation(input: {
    environmentId: string;
    tenantId: string;
    dataRole: TenantShardDataRole;
    residencyPolicyId: string;
    residencyPartition: string;
    allocationScope: ControlTenantShardAllocationScope;
    ownerTenantId: string | null;
  }): Promise<ControlOperationView | null>;
  listPendingShardPlans(limit: number): Promise<TenantShardPlan[]>;
  listPendingMigrationPlans(limit: number): Promise<PendingMigrationPlan[]>;
  listLowWatermarkRequests(limit: number, environmentId?: string): Promise<LowWatermarkRequest[]>;
  getCapacityPlannerInput(
    environmentId: string,
    scope: ControlCapacityPlannerInput['scope'],
    tenantId: string | null
  ): Promise<Omit<ControlCapacityPlannerInput, 'profile'>>;
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
  tryStartMigration(
    operationId: string,
    ownerId: string,
    now: number
  ): Promise<ProvisioningLease | null>;
  markMigrationReady(
    lease: ProvisioningLease,
    plan: PendingMigrationPlan,
    result: {
      totalFiles: number;
      appliedFiles: number;
      skippedFiles: number;
      responseLossRecoveries: number;
      lastFilename: string;
    },
    now: number
  ): Promise<ControlOperationView>;
  markMigrationRetry(
    lease: ProvisioningLease,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void>;
  markMigrationBlocked(lease: ProvisioningLease, errorCode: string, now: number): Promise<void>;
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

async function deterministicOperationId(prefix: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `${prefix}_${hex.slice(0, 32)}`;
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
    retryBudgetStartedAt: row.retry_budget_started_at ?? row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function provisioningAuthorityBlockStatements(
  db: D1Database,
  lease: ProvisioningLease,
  errorCode: string,
  now: number
): Array<ReturnType<D1Database['prepare']>> {
  if (errorCode !== 'cloudflare_d1_capability_rejected') return [];
  return [
    db
      .prepare(
        `UPDATE control_environments
            SET provisioning_capability_state = 'blocked',
                provisioning_capability_checked_at = ?, updated_at = ?
          WHERE environment_id = ?
            AND automatic_provisioning_enabled = 1
            AND provisioning_token_ownership IN ('user', 'account')`
      )
      .bind(now, now, lease.operation.environmentId),
    db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_events (
           event_id, environment_id, operation_id, event_type, actor_type,
           resource_kind, resource_id, outcome, redacted_payload_json, created_at
         ) SELECT ?, environment_id, operation_id,
                  'control.provisioning.authority_blocked', 'reconciler',
                  'provisioning_authority', environment_id, 'blocked', ?, ?
             FROM control_operations
            WHERE operation_id = ? AND environment_id = ? AND fencing_token = ?
              AND EXISTS (
                SELECT 1 FROM control_environments environment
                 WHERE environment.environment_id = control_operations.environment_id
                   AND environment.provisioning_capability_state = 'blocked'
                   AND environment.provisioning_capability_checked_at = ?
              )`
      )
      .bind(
        `audit:${lease.operation.environmentId}:authority-blocked:${lease.fencingToken}`,
        JSON.stringify({ reason_code: errorCode }),
        now,
        lease.operation.operationId,
        lease.operation.environmentId,
        lease.fencingToken,
        now
      ),
  ];
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
    allocationScope: row.allocation_scope,
    ownerTenantId: row.owner_tenant_id,
    jurisdiction: row.jurisdiction ?? undefined,
    locationHint: row.location_hint ?? undefined,
    idempotencyKey: row.idempotency_key,
    readReplicationMode: row.read_replication_mode,
    migrationStreamId:
      row.data_role === 'tenant_pii'
        ? 'd1-pii'
        : row.data_role === 'lookup'
          ? 'd1-lookup'
          : 'd1-core',
  };
}

export class D1ControlRepository implements ControlRepository {
  constructor(private readonly db: D1Database) {}

  async listAccountDirectorySourceShards(
    environmentId: string,
    afterShardId: string | null,
    limit: number
  ): Promise<ControlAccountDirectorySourceShard[]> {
    const rows = await this.listAccountRouteSourceShards(
      environmentId,
      'tenant_core/users',
      afterShardId,
      limit
    );
    return rows.map(({ dataRole: _dataRole, ...row }) => row);
  }

  async listAccountRouteSourceShards(
    environmentId: string,
    dataRole: ControlAccountDataRole,
    afterShardId: string | null,
    limit: number
  ): Promise<ControlAccountRouteSourceShard[]> {
    if (dataRole !== 'tenant_core/users' && dataRole !== 'tenant_pii') {
      throw new Error('invalid_account_route_source_role');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('invalid_account_directory_source_limit');
    }
    const result = await this.db
      .prepare(
        `SELECT shard_id, binding_ref, residency_partition, generation
           FROM control_tenant_shards
          WHERE environment_id = ? AND data_role = ?
            AND status = 'active' AND (? IS NULL OR shard_id > ?)
          ORDER BY shard_id LIMIT ?`
      )
      .bind(environmentId, dataRole, afterShardId, afterShardId, limit)
      .all<{
        shard_id: string;
        binding_ref: string;
        residency_partition: string;
        generation: number;
      }>();
    return result.results.map((row) => ({
      dataRole,
      shardId: row.shard_id,
      bindingRef: row.binding_ref,
      residencyPartition: row.residency_partition,
      routeGeneration: row.generation,
    }));
  }

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

  async getProvisioningAuthority(environmentId: string): Promise<ProvisioningAuthorityRow | null> {
    const row = await this.db
      .prepare(
        `SELECT automatic_provisioning_enabled, provisioning_token_ownership,
                provisioning_capability_state
           FROM control_environments
          WHERE environment_id = ? AND lifecycle_state IN ('creating', 'active')`
      )
      .bind(environmentId)
      .first<{
        automatic_provisioning_enabled: number;
        provisioning_token_ownership: ProvisioningAuthorityRow['tokenOwnership'];
        provisioning_capability_state: ProvisioningAuthorityRow['capabilityState'];
      }>();
    return row
      ? {
          automaticProvisioningEnabled: row.automatic_provisioning_enabled === 1,
          tokenOwnership: row.provisioning_token_ownership,
          capabilityState: row.provisioning_capability_state,
        }
      : null;
  }

  async hasReadyAutomaticProvisioning(): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS ready
           FROM control_environments
          WHERE lifecycle_state IN ('creating', 'active')
            AND automatic_provisioning_enabled = 1
            AND provisioning_token_ownership IN ('user', 'account')
            AND provisioning_capability_state = 'ready'
          LIMIT 1`
      )
      .first<{ ready: number }>();
    return row?.ready === 1;
  }

  async resumeAutomaticBootstrapOperations(environmentId: string, now: number): Promise<number> {
    const rows = await this.db
      .prepare(
        `SELECT operation_id
           FROM control_operations
          WHERE environment_id = ?
            AND operation_id LIKE 'op_bootstrap_%'
            AND operation_kind = 'provision_shard'
            AND requested_by_type = 'setup'
            AND requested_by_id = 'setup:init'
            AND status IN ('blocked', 'waiting_retry')
            AND (
              last_error_code = 'operator_action_required'
              OR status = 'waiting_retry'
            )
            AND EXISTS (
              SELECT 1 FROM control_bootstrap_handoffs handoff
               WHERE handoff.environment_id = control_operations.environment_id
                 AND handoff.state IN ('creating', 'pending_verification')
            )
          ORDER BY operation_id`
      )
      .bind(environmentId)
      .all<{ operation_id: string }>();
    if (rows.results.length === 0) return 0;

    // A Cron tick may have handed initial setup operations to the operator during the short
    // window before bootstrap credentials became ready. Move only those immutable bootstrap
    // operations back into the normal retry path once Automatic provisioning is available.
    await this.db.batch(
      rows.results.flatMap(({ operation_id }) => [
        this.db
          .prepare(
            `UPDATE control_operations
                SET status = 'running', started_at = COALESCE(started_at, ?),
                    completed_at = NULL, next_attempt_at = NULL,
                    last_error_code = NULL, last_error_redacted = NULL,
                    lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
              WHERE operation_id = ? AND environment_id = ?
                AND status = 'blocked' AND last_error_code = 'operator_action_required'`
          )
          .bind(now, now, operation_id, environmentId),
        this.db
          .prepare(
            `UPDATE control_operations
                SET status = 'waiting_retry', started_at = NULL, updated_at = ?
              WHERE operation_id = ? AND environment_id = ? AND status = 'running'`
          )
          .bind(now, operation_id, environmentId),
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET status = 'running', started_at = COALESCE(started_at, ?),
                    completed_at = NULL, next_attempt_at = NULL,
                    last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
              WHERE operation_id = ? AND status = 'blocked'
                AND last_error_code = 'operator_action_required'`
          )
          .bind(now, now, operation_id),
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET status = 'running', started_at = COALESCE(started_at, ?),
                    completed_at = NULL, next_attempt_at = NULL,
                    last_error_code = NULL, last_error_redacted = NULL, updated_at = ?
              WHERE operation_id = ? AND status = 'waiting_retry'`
          )
          .bind(now, now, operation_id),
      ])
    );
    return rows.results.length;
  }

  async markOperationAwaitingOperator(
    operationId: string,
    now: number
  ): Promise<ControlOperationView> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL,
                  last_error_code = 'operator_action_required',
                  last_error_redacted = 'Run setup to execute this provisioning operation.',
                  lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'blocked', next_attempt_at = NULL,
                  last_error_code = 'operator_action_required',
                  last_error_redacted = 'Run setup to execute this provisioning operation.',
                  updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT 'audit:' || operation_id || ':operator-action-required', environment_id,
                    operation_id, 'control.provisioning.operator_action_required', 'reconciler',
                    'provisioning_operation', operation_id, 'blocked',
                    '{"reason_code":"operator_action_required"}', ?
               FROM control_operations WHERE operation_id = ? AND status = 'blocked'`
        )
        .bind(now, operationId),
    ]);
    const operation = await this.getOperation(operationId);
    if (!operation) throw new Error('control_operation_missing_after_operator_handoff');
    return operation;
  }

  async listActiveEnvironments(): Promise<EnvironmentRow[]> {
    const result = await this.db
      .prepare(
        `SELECT environment_id, environment_name, lifecycle_state
           FROM control_environments
          WHERE lifecycle_state IN ('creating', 'active')
          ORDER BY length(environment_name) DESC, environment_name`
      )
      .all<EnvironmentRow>();
    return result.results;
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

  async listTenantActiveResidencies(
    environmentId: string,
    tenantId: string
  ): Promise<TenantActiveResidencyRow[]> {
    const result = await this.db
      .prepare(
        `SELECT allocation.residency_policy_id, allocation.residency_partition,
                partition.jurisdiction, partition.location_hint, policy.policy_generation
           FROM control_tenant_default_allocations allocation
           JOIN control_tenant_placement_policies policy
             ON policy.environment_id = allocation.environment_id
            AND policy.tenant_id = allocation.tenant_id
            AND policy.policy_state = 'active'
           JOIN control_residency_partitions partition
             ON partition.environment_id = allocation.environment_id
            AND partition.residency_policy_id = allocation.residency_policy_id
            AND partition.residency_partition = allocation.residency_partition
            AND partition.status = 'active'
          WHERE allocation.environment_id = ?
            AND allocation.tenant_id = ?
            AND allocation.reservation_state = 'committed'
          ORDER BY allocation.residency_policy_id, allocation.residency_partition`
      )
      .bind(environmentId, tenantId)
      .all<TenantActiveResidencyRow>();
    return result.results;
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

  async getTenantPlacementPolicy(
    environmentId: string,
    tenantId: string
  ): Promise<ControlTenantPlacementPolicy | null> {
    const row = await this.db
      .prepare(
        `SELECT tenant_id, isolation_policy, policy_generation, policy_state,
                pending_isolation_policy, pending_policy_generation, migration_operation_id,
                source_operation_id, created_at, updated_at
           FROM control_tenant_placement_policies
          WHERE environment_id = ? AND tenant_id = ?`
      )
      .bind(environmentId, tenantId)
      .first<{
        tenant_id: string;
        isolation_policy: ControlTenantPlacementPolicy['isolationPolicy'];
        policy_generation: number;
        policy_state: ControlTenantPlacementPolicy['state'];
        pending_isolation_policy: 'tenant_exclusive' | null;
        pending_policy_generation: number | null;
        migration_operation_id: string | null;
        source_operation_id: string;
        created_at: number;
        updated_at: number;
      }>();
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      isolationPolicy: row.isolation_policy,
      policyGeneration: row.policy_generation,
      state: row.policy_state,
      pendingIsolationPolicy: row.pending_isolation_policy,
      pendingPolicyGeneration: row.pending_policy_generation,
      migrationOperationId: row.migration_operation_id,
      sourceOperationId: row.source_operation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async registerTenantPlacementPolicy(
    input: ControlTenantPlacementPolicyRegistrationRequest & { environmentId: string },
    now: number
  ): Promise<ControlTenantPlacementPolicy> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_tenant_placement_policies (
             environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
             source_operation_id, idempotency_key, created_at, updated_at
           ) VALUES (?, ?, ?, 1, 'provisioning', ?, ?, ?, ?)`
        )
        .bind(
          input.environmentId,
          input.tenantId,
          input.isolationPolicy,
          input.sourceOperationId,
          input.idempotencyKey,
          now,
          now
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, event_type, actor_type, resource_kind,
             resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, 'control.tenant_placement.registered', 'ar-management',
                    'tenant_placement_policy', ?, 'succeeded', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM control_tenant_placement_policies
                 WHERE environment_id = ? AND tenant_id = ?
                   AND isolation_policy = ?
                   AND source_operation_id = ? AND idempotency_key = ?
              )`
        )
        .bind(
          `audit:tenant-placement:${input.environmentId}:${input.tenantId}`,
          input.environmentId,
          input.tenantId,
          JSON.stringify({
            isolation_policy: input.isolationPolicy,
          }),
          now,
          input.environmentId,
          input.tenantId,
          input.isolationPolicy,
          input.sourceOperationId,
          input.idempotencyKey
        ),
    ]);
    const row = await this.db
      .prepare(
        `SELECT tenant_id, isolation_policy, policy_generation, policy_state,
                pending_isolation_policy, pending_policy_generation, migration_operation_id,
                source_operation_id, idempotency_key, created_at, updated_at
           FROM control_tenant_placement_policies
          WHERE environment_id = ? AND (tenant_id = ? OR idempotency_key = ?)`
      )
      .bind(input.environmentId, input.tenantId, input.idempotencyKey)
      .first<{
        tenant_id: string;
        isolation_policy: ControlTenantPlacementPolicy['isolationPolicy'];
        policy_generation: number;
        policy_state: ControlTenantPlacementPolicy['state'];
        pending_isolation_policy: 'tenant_exclusive' | null;
        pending_policy_generation: number | null;
        migration_operation_id: string | null;
        source_operation_id: string;
        idempotency_key: string;
        created_at: number;
        updated_at: number;
      }>();
    if (
      !row ||
      row.tenant_id !== input.tenantId ||
      row.isolation_policy !== input.isolationPolicy ||
      row.source_operation_id !== input.sourceOperationId ||
      row.idempotency_key !== input.idempotencyKey
    ) {
      throw new Error('control_tenant_placement_policy_conflict');
    }
    return {
      tenantId: row.tenant_id,
      isolationPolicy: row.isolation_policy,
      policyGeneration: row.policy_generation,
      state: row.policy_state,
      pendingIsolationPolicy: row.pending_isolation_policy,
      pendingPolicyGeneration: row.pending_policy_generation,
      migrationOperationId: row.migration_operation_id,
      sourceOperationId: row.source_operation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async activateTenantPlacementPolicy(
    input: ControlTenantPlacementPolicyActivationRequest & { environmentId: string },
    now: number
  ): Promise<ControlTenantPlacementPolicy> {
    const policyBeforeActivation = await this.getTenantPlacementPolicy(
      input.environmentId,
      input.tenantId
    );
    const assignments = await this.db
      .prepare(
        `SELECT assignment.data_role, assignment.shard_id, assignment.residency_policy_id,
                assignment.residency_partition, shard.binding_ref, shard.generation
           FROM control_tenant_shard_assignments assignment
           JOIN control_tenant_shards shard
             ON shard.environment_id = assignment.environment_id
            AND shard.shard_id = assignment.shard_id
          WHERE assignment.environment_id = ? AND assignment.tenant_id = ?
            AND assignment.assignment_state = 'active'
            AND shard.status IN ('ready', 'active', 'degraded')
          ORDER BY assignment.data_role, assignment.residency_partition, assignment.shard_id`
      )
      .bind(input.environmentId, input.tenantId)
      .all<{
        data_role: ControlTenantRuntimeRouteObservation['targets'][number]['dataRole'];
        shard_id: string;
        residency_policy_id: string;
        residency_partition: string;
        binding_ref: string;
        generation: number;
      }>();
    const expected = assignments.results;
    const observed = [...input.runtimeRoute.targets].sort((left, right) =>
      `${left.dataRole}\0${left.shardId}`.localeCompare(`${right.dataRole}\0${right.shardId}`)
    );
    const residencyPolicies = new Set(expected.map((entry) => entry.residency_policy_id));
    if (
      expected.length < 3 ||
      expected.length !== observed.length ||
      residencyPolicies.size !== 1 ||
      expected.some((entry, index) => {
        const target = observed[index];
        return (
          !target ||
          target.dataRole !== entry.data_role ||
          target.shardId !== entry.shard_id ||
          target.bindingRef !== entry.binding_ref ||
          target.generation !== Number(entry.generation)
        );
      })
    ) {
      throw new Error('control_tenant_runtime_route_observation_mismatch');
    }
    const defaultRoute = await this.db
      .prepare(
        `SELECT route_generation FROM control_tenant_default_allocations
          WHERE environment_id = ? AND tenant_id = ? AND reservation_state = 'committed'
          ORDER BY committed_at DESC LIMIT 1`
      )
      .bind(input.environmentId, input.tenantId)
      .first<{ route_generation: number }>();
    if (
      !defaultRoute ||
      Number(defaultRoute.route_generation) !== input.runtimeRoute.runtimeGeneration
    ) {
      throw new Error('control_tenant_runtime_route_generation_mismatch');
    }
    const routeProjection = JSON.stringify({
      targets: expected.map((entry) => ({
        dataRole: entry.data_role,
        residencyPartition: entry.residency_partition,
        shardId: entry.shard_id,
        bindingRef: entry.binding_ref,
        generation: Number(entry.generation),
      })),
    });
    const residencyPolicyId = expected[0]?.residency_policy_id;
    if (!residencyPolicyId) {
      throw new Error('control_tenant_runtime_route_observation_mismatch');
    }
    const payload = JSON.stringify({
      tenant_id: input.tenantId,
      source_operation_id: input.sourceOperationId,
      runtime_generation: input.runtimeRoute.runtimeGeneration,
      target_count: expected.length,
    });
    const routeObservationOperationId = await deterministicOperationId(
      'op_runtime_route',
      `${input.environmentId}\0${input.tenantId}\0${input.runtimeRoute.runtimeGeneration}`
    );
    const registerObservation = this.db
      .prepare(
        `INSERT OR IGNORE INTO control_operations (
           operation_id, environment_id, operation_kind, idempotency_key, status,
           requested_by_type, requested_by_id, attempt_count, created_at,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, 'tenant_runtime_route_observation', ?, 'succeeded',
                   'admin', 'ar-management', 1, ?, ?, ?, ?)`
      )
      .bind(
        routeObservationOperationId,
        input.environmentId,
        `tenant-runtime-route:${routeObservationOperationId}`,
        now,
        now,
        now,
        now
      );
    const activatePolicy = this.db
      .prepare(
        `UPDATE control_tenant_placement_policies
            SET policy_state = 'active', activated_at = COALESCE(activated_at, ?), updated_at = ?
          WHERE environment_id = ? AND tenant_id = ? AND source_operation_id = ?
            AND policy_state = 'provisioning'`
      )
      .bind(now, now, input.environmentId, input.tenantId, input.sourceOperationId);
    const insertRoute = this.db
      .prepare(
        `INSERT OR IGNORE INTO control_runtime_registry_routes (
           environment_id, tenant_id, route_generation, tenant_lifecycle_generation,
           quarantine_deny_generation, registry_publication_generation,
           tenant_lifecycle_state, route_status, residency_policy_id,
           route_projection_json, source_operation_id, created_at, updated_at
         ) SELECT ?, ?, ?, 1, 0, ?, 'active', 'active', ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM control_tenant_placement_policies
               WHERE environment_id = ? AND tenant_id = ? AND source_operation_id = ?
                 AND policy_state IN ('provisioning', 'active')
            )`
      )
      .bind(
        input.environmentId,
        input.tenantId,
        input.runtimeRoute.runtimeGeneration,
        input.runtimeRoute.registryPublicationGeneration,
        residencyPolicyId,
        routeProjection,
        routeObservationOperationId,
        now,
        now,
        input.environmentId,
        input.tenantId,
        input.sourceOperationId
      );
    const insertAudit = this.db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_events (
           event_id, environment_id, event_type, actor_type, resource_kind,
           resource_id, outcome, redacted_payload_json, created_at
         ) SELECT ?, ?, 'control.tenant_placement.activated', 'ar-management',
                  'tenant_placement_policy', ?, 'succeeded', ?, ?
            WHERE EXISTS (
              SELECT 1 FROM control_tenant_placement_policies
               WHERE environment_id = ? AND tenant_id = ? AND source_operation_id = ?
                 AND policy_state = 'active'
            ) AND EXISTS (
              SELECT 1 FROM control_runtime_registry_routes
               WHERE environment_id = ? AND tenant_id = ?
                 AND source_operation_id = ? AND route_status = 'active'
            )`
      )
      .bind(
        `audit:tenant-placement-activation:${input.environmentId}:${input.idempotencyKey}`,
        input.environmentId,
        input.tenantId,
        payload,
        now,
        input.environmentId,
        input.tenantId,
        input.sourceOperationId,
        input.environmentId,
        input.tenantId,
        routeObservationOperationId
      );
    if (
      policyBeforeActivation?.state === 'active' &&
      policyBeforeActivation.sourceOperationId === input.sourceOperationId
    ) {
      await registerObservation.run();
      await insertRoute.run();
      await insertAudit.run();
    } else {
      await this.db.batch([registerObservation, activatePolicy, insertRoute, insertAudit]);
    }
    const policy = await this.getTenantPlacementPolicy(input.environmentId, input.tenantId);
    if (
      !policy ||
      policy.state !== 'active' ||
      policy.sourceOperationId !== input.sourceOperationId
    ) {
      throw new Error('control_tenant_placement_policy_activation_conflict');
    }
    const route = await this.db
      .prepare(
        `SELECT route.route_generation, route.registry_publication_generation,
                route.tenant_lifecycle_state, route.route_status, route.residency_policy_id,
                route.route_projection_json, route.source_operation_id,
                EXISTS (
                  SELECT 1 FROM control_operations source
                   WHERE source.operation_id = route.source_operation_id
                     AND source.environment_id = route.environment_id
                     AND source.operation_kind = 'tenant_runtime_route_observation'
                     AND source.status = 'succeeded'
                ) AS source_operation_valid
           FROM control_runtime_registry_routes route
          WHERE environment_id = ? AND tenant_id = ?`
      )
      .bind(input.environmentId, input.tenantId)
      .first<{
        route_generation: number;
        registry_publication_generation: number;
        tenant_lifecycle_state: string;
        route_status: string;
        residency_policy_id: string;
        route_projection_json: string;
        source_operation_id: string;
        source_operation_valid: number;
      }>();
    if (
      !route ||
      Number(route.route_generation) !== input.runtimeRoute.runtimeGeneration ||
      Number(route.registry_publication_generation) !==
        input.runtimeRoute.registryPublicationGeneration ||
      route.tenant_lifecycle_state !== input.runtimeRoute.tenantLifecycleState ||
      route.route_status !== input.runtimeRoute.routeStatus ||
      route.residency_policy_id !== residencyPolicyId ||
      route.route_projection_json !== routeProjection ||
      Number(route.source_operation_valid) !== 1
    ) {
      throw new Error('control_tenant_runtime_route_observation_conflict');
    }
    return policy;
  }

  getReadReplicationPolicy(
    environmentId: string,
    dataRole: ProvisionedD1DataRole,
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

  getActiveDesiredWorker(
    environmentId: string,
    workerScriptName: string
  ): Promise<DesiredWorkerInventoryRow | null> {
    return this.db
      .prepare(
        `SELECT environment_id, worker_script_name, package_name, deployment_target,
                capability_manifest_digest, source_kind, status
           FROM control_desired_worker_inventory
          WHERE environment_id = ? AND worker_script_name = ? AND status = 'active'`
      )
      .bind(environmentId, workerScriptName)
      .first<DesiredWorkerInventoryRow>();
  }

  async listActiveDesiredWorkerNames(environmentId: string): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT worker_script_name
           FROM control_desired_worker_inventory
          WHERE environment_id = ? AND status = 'active'
          ORDER BY worker_script_name`
      )
      .bind(environmentId)
      .all<{ worker_script_name: string }>();
    return result.results.map((row) => row.worker_script_name);
  }

  async recordActualOnlyWorkerFindings(
    environmentId: string,
    scriptNames: readonly string[],
    now: number
  ): Promise<void> {
    const uniqueNames = [...new Set(scriptNames)].sort();
    if (uniqueNames.length === 0) return;
    await this.db.batch(
      uniqueNames.flatMap((scriptName) => {
        const findingId = `drift:${environmentId}:actual_only:${scriptName}`;
        return [
          this.db
            .prepare(
              `INSERT OR IGNORE INTO control_audit_events (
                 event_id, environment_id, event_type, actor_type, resource_kind,
                 resource_id, outcome, redacted_payload_json, created_at
               )
               SELECT ?, ?, 'control.worker_inventory.actual_only', 'reconciler',
                      'worker_script', ?, 'blocked', ?, ?
                WHERE NOT EXISTS (
                  SELECT 1
                    FROM control_worker_inventory_drift_findings
                   WHERE environment_id = ? AND worker_script_name = ?
                     AND finding_kind = 'actual_only' AND review_state <> 'resolved'
                )`
            )
            .bind(
              `audit:${findingId}:${now}`,
              environmentId,
              scriptName,
              JSON.stringify({ finding_kind: 'actual_only', severity: 'warning' }),
              now,
              environmentId,
              scriptName
            ),
          this.db
            .prepare(
              `INSERT INTO control_worker_inventory_drift_findings (
                 finding_id, environment_id, worker_script_name, finding_kind, severity,
                 redacted_details_json, review_state, first_observed_at, last_observed_at,
                 notification_state
               ) VALUES (?, ?, ?, 'actual_only', 'warning', ?, 'unreviewed', ?, ?, 'pending')
               ON CONFLICT(environment_id, worker_script_name, finding_kind) DO UPDATE SET
                 severity = 'warning', redacted_details_json = excluded.redacted_details_json,
                 review_state = CASE
                   WHEN control_worker_inventory_drift_findings.review_state = 'resolved'
                     THEN 'unreviewed'
                   ELSE control_worker_inventory_drift_findings.review_state
                 END,
                 first_observed_at = CASE
                   WHEN control_worker_inventory_drift_findings.review_state = 'resolved'
                     THEN excluded.first_observed_at
                   ELSE control_worker_inventory_drift_findings.first_observed_at
                 END,
                 last_observed_at = excluded.last_observed_at,
                 resolved_at = NULL,
                 notification_state = CASE
                   WHEN control_worker_inventory_drift_findings.notification_state = 'resolved'
                     THEN 'pending'
                   ELSE control_worker_inventory_drift_findings.notification_state
                 END,
                 notified_at = CASE
                   WHEN control_worker_inventory_drift_findings.review_state = 'resolved'
                     THEN NULL
                   ELSE control_worker_inventory_drift_findings.notified_at
                 END`
            )
            .bind(
              findingId,
              environmentId,
              scriptName,
              JSON.stringify({ source: 'cloudflare_workers_list' }),
              now,
              now
            ),
        ];
      })
    );
  }

  async resolveMissingActualOnlyWorkerFindings(
    environmentId: string,
    stillActualOnlyScriptNames: readonly string[],
    now: number
  ): Promise<void> {
    const names = [...new Set(stillActualOnlyScriptNames)].sort();
    const placeholders = names.map(() => '?').join(', ');
    const exclusion = names.length > 0 ? `AND worker_script_name NOT IN (${placeholders})` : '';
    await this.db
      .prepare(
        `UPDATE control_worker_inventory_drift_findings
            SET review_state = 'resolved', notification_state = 'resolved', resolved_at = ?
          WHERE environment_id = ? AND finding_kind = 'actual_only'
            AND review_state <> 'resolved' ${exclusion}`
      )
      .bind(now, environmentId, ...names)
      .run();
  }

  async listPendingWorkerInventoryDriftFindings(
    environmentId: string,
    limit: number
  ): Promise<WorkerInventoryDriftFindingRow[]> {
    if (!Number.isFinite(limit)) throw new Error('invalid_worker_inventory_drift_limit');
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const result = await this.db
      .prepare(
        `SELECT finding_id, environment_id, worker_script_name, finding_kind, severity,
                review_state, notification_state, first_observed_at, last_observed_at,
                resolved_at, notified_at
           FROM control_worker_inventory_drift_findings
          WHERE environment_id = ? AND notification_state = 'pending'
          ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, first_observed_at
          LIMIT ?`
      )
      .bind(environmentId, safeLimit)
      .all<WorkerInventoryDriftFindingRow>();
    return result.results;
  }

  async listWorkerInventoryDriftFindings(
    environmentId: string,
    limit: number
  ): Promise<WorkerInventoryDriftFindingRow[]> {
    if (!Number.isFinite(limit)) throw new Error('invalid_worker_inventory_drift_limit');
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const result = await this.db
      .prepare(
        `SELECT finding_id, environment_id, worker_script_name, finding_kind, severity,
                review_state, notification_state, first_observed_at, last_observed_at,
                resolved_at, notified_at
           FROM control_worker_inventory_drift_findings
          WHERE environment_id = ? AND review_state <> 'resolved'
          ORDER BY CASE review_state WHEN 'unreviewed' THEN 0 ELSE 1 END,
                   first_observed_at, finding_id
          LIMIT ?`
      )
      .bind(environmentId, safeLimit)
      .all<WorkerInventoryDriftFindingRow>();
    return result.results;
  }

  async reviewWorkerInventoryDriftFinding(
    environmentId: string,
    input: ControlWorkerInventoryDriftReviewRequest,
    now: number
  ): Promise<WorkerInventoryDriftFindingRow> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_inventory_drift_findings
              SET review_state = ?
            WHERE environment_id = ? AND finding_id = ? AND review_state <> 'resolved'`
        )
        .bind(input.disposition, environmentId, input.findingId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, ?, 'control.worker_inventory.reviewed', 'admin', ?,
                  'worker_script', worker_script_name, 'succeeded', ?, ?
             FROM control_worker_inventory_drift_findings
            WHERE environment_id = ? AND finding_id = ? AND review_state = ?`
        )
        .bind(
          `audit:drift-review:${environmentId}:${input.findingId}:${input.disposition}:${input.idempotencyKey}`,
          environmentId,
          input.reviewedBy,
          JSON.stringify({
            finding_id: input.findingId,
            disposition: input.disposition,
          }),
          now,
          environmentId,
          input.findingId,
          input.disposition
        ),
    ]);
    const row = await this.db
      .prepare(
        `SELECT finding_id, environment_id, worker_script_name, finding_kind, severity,
                review_state, notification_state, first_observed_at, last_observed_at,
                resolved_at, notified_at
           FROM control_worker_inventory_drift_findings
          WHERE environment_id = ? AND finding_id = ? AND review_state = ?`
      )
      .bind(environmentId, input.findingId, input.disposition)
      .first<WorkerInventoryDriftFindingRow>();
    if (!row) throw new Error('control_worker_inventory_drift_review_conflict');
    return row;
  }

  async acknowledgeWorkerInventoryDriftNotifications(
    environmentId: string,
    findingIds: readonly string[],
    now: number
  ): Promise<void> {
    const uniqueIds = [...new Set(findingIds)].sort();
    if (uniqueIds.length === 0) return;
    await this.db.batch(
      uniqueIds.map((findingId) =>
        this.db
          .prepare(
            `UPDATE control_worker_inventory_drift_findings
                SET notification_state = 'acknowledged', notified_at = ?
              WHERE environment_id = ? AND finding_id = ?
                AND review_state <> 'resolved' AND notification_state = 'pending'`
          )
          .bind(now, environmentId, findingId)
      )
    );
  }

  async createShardPlan(
    plan: TenantShardPlan,
    now: number,
    requestedByType: 'admin' | 'scheduler'
  ): Promise<ControlOperationView> {
    const release = await this.db
      .prepare(
        `SELECT stream_id, release_id, manifest_digest, manifest_r2_object_key
           FROM control_migration_release_catalog
          WHERE environment_id = ? AND stream_id = ? AND state = 'active'`
      )
      .bind(plan.environmentId, plan.migrationStreamId)
      .first<ActiveMigrationReleaseRow>();
    if (!release) throw new Error('control_active_migration_release_missing');
    const inventoryInsert =
      plan.dataRole === 'lookup'
        ? this.db
            .prepare(
              `INSERT OR IGNORE INTO control_lookup_physical_shards (
                 lookup_shard_id, environment_id, residency_partition, binding_ref,
                 d1_desired_resource_id, status, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 'requested', ?, ?)`
            )
            .bind(
              plan.shardId,
              plan.environmentId,
              plan.residencyPartition,
              plan.bindingRef,
              plan.desiredResourceId,
              now,
              now
            )
        : this.db
            .prepare(
              `INSERT OR IGNORE INTO control_tenant_shards (
                 shard_id, environment_id, data_role, residency_policy_id, residency_partition,
                 generation, logical_shard_id, binding_ref, d1_desired_resource_id,
                 jurisdiction, location_hint, allocation_scope, owner_tenant_id,
                 status, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`
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
              plan.allocationScope,
              plan.ownerTenantId,
              now,
              now
            );
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, attempt_count, created_at, updated_at,
             release_id, release_stream_id, release_manifest_digest
           ) VALUES (?, ?, 'provision_shard', ?, 'queued', ?, 0, ?, ?, ?, ?, ?)`
        )
        .bind(
          plan.operationId,
          plan.environmentId,
          plan.idempotencyKey,
          requestedByType,
          now,
          now,
          release.release_id,
          release.stream_id,
          release.manifest_digest
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operation_release_pins (
             operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          plan.operationId,
          plan.environmentId,
          release.stream_id,
          release.release_id,
          release.manifest_digest,
          now
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'create_d1', 10, 'queued', 0, ?)`
        )
        .bind(plan.operationId, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'apply_migrations', 20, 'queued', 0, ?)`
        )
        .bind(plan.operationId, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'reconcile_worker_bindings', 30, 'queued', 0, ?)`
        )
        .bind(plan.operationId, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'smoke_bindings', 40, 'queued', 0, ?)`
        )
        .bind(plan.operationId, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_operation_steps (
             operation_id, step_key, display_order, status, attempt_count, updated_at
           ) VALUES (?, 'stabilize_bindings', 50, 'queued', 0, ?)`
        )
        .bind(plan.operationId, now),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_desired_resources (
             desired_resource_id, environment_id, resource_kind, logical_shard_id,
             resource_scope, tenant_id, deterministic_name, ownership_fingerprint, provisioning_state,
             origin_operation_id, desired_spec_json, created_at, updated_at
           ) VALUES (?, ?, 'd1', ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`
        )
        .bind(
          plan.desiredResourceId,
          plan.environmentId,
          plan.logicalShardId,
          plan.allocationScope === 'tenant_exclusive' ? 'tenant' : 'platform',
          plan.ownerTenantId,
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
            allocation_scope: plan.allocationScope,
            owner_tenant_id: plan.ownerTenantId,
          }),
          now,
          now
        ),
      inventoryInsert,
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_tenant_database_migration_state (
             desired_resource_id, environment_id, operation_id, stream_id, release_id,
             manifest_digest, state, applied_file_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'requested', 0, ?)`
        )
        .bind(
          plan.desiredResourceId,
          plan.environmentId,
          plan.operationId,
          release.stream_id,
          release.release_id,
          release.manifest_digest,
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
            allocation_scope: plan.allocationScope,
            owner_tenant_id: plan.ownerTenantId,
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

  async getOperation(
    operationId: string,
    environmentId?: string
  ): Promise<ControlOperationView | null> {
    const statement = environmentId
      ? this.db
          .prepare(
            `SELECT operation_id, environment_id, operation_kind, status, attempt_count,
                    next_attempt_at, last_error_code, created_at, updated_at, fencing_token
               FROM control_operations
              WHERE operation_id = ? AND environment_id = ?`
          )
          .bind(operationId, environmentId)
      : this.db
          .prepare(
            `SELECT operation_id, environment_id, operation_kind, status, attempt_count,
                    next_attempt_at, last_error_code, created_at, updated_at, fencing_token
               FROM control_operations
              WHERE operation_id = ?`
          )
          .bind(operationId);
    const row = await statement.first<OperationRow>();
    return row ? operationView(row) : null;
  }

  async getProvisioningOperation(
    operationId: string,
    environmentId: string
  ): Promise<ControlProvisioningOperationDetail | null> {
    const operation = await this.getOperation(operationId, environmentId);
    if (!operation) return null;
    const [rows, availability] = await Promise.all([
      this.db
        .prepare(
          `SELECT step_key, display_order, status, attempt_count, next_attempt_at,
                last_error_code, observed_resource_id, progress_current, progress_total,
                started_at, completed_at, updated_at
           FROM control_operation_steps
          WHERE operation_id = ?
          ORDER BY display_order, step_key`
        )
        .bind(operationId)
        .all<OperationStepRow>(),
      this.db
        .prepare(
          `SELECT
             EXISTS (
               SELECT 1
                 FROM control_operations operation
                 JOIN control_operation_steps step
                   ON step.operation_id = operation.operation_id
                WHERE operation.operation_id = ? AND operation.environment_id = ?
                  AND operation.operation_kind = 'provision_shard'
                  AND operation.status = 'blocked'
                  AND step.step_key = 'create_d1' AND step.status = 'blocked'
                  AND EXISTS (
                    SELECT 1 FROM control_desired_resources desired
                     WHERE desired.origin_operation_id = operation.operation_id
                       AND desired.observed_resource_id IS NULL
                  )
             ) AS retry_create_d1,
             EXISTS (
               SELECT 1
                 FROM control_operations operation
                 JOIN control_operation_steps step
                   ON step.operation_id = operation.operation_id
                WHERE operation.operation_id = ? AND operation.environment_id = ?
                  AND operation.operation_kind = 'provision_shard'
                  AND operation.status = 'blocked'
                  AND step.step_key = 'apply_migrations' AND step.status = 'blocked'
                  AND EXISTS (
                    SELECT 1 FROM control_tenant_database_migration_state migration
                     WHERE migration.operation_id = operation.operation_id
                       AND migration.provider_database_id IS NOT NULL
                       AND migration.state = 'blocked'
                  )
             ) AS retry_apply_migrations,
             EXISTS (
               SELECT 1
                 FROM control_operations operation
                 JOIN control_operation_steps step
                   ON step.operation_id = operation.operation_id
                WHERE operation.operation_id = ? AND operation.environment_id = ?
                  AND operation.operation_kind = 'provision_shard'
                  AND operation.status = 'blocked'
                  AND step.step_key = 'reconcile_worker_bindings'
                  AND step.status = 'blocked'
                  AND EXISTS (
                    SELECT 1 FROM control_worker_binding_reconciliations binding
                     WHERE binding.operation_id = operation.operation_id
                       AND binding.state = 'blocked'
                       AND binding.last_error_code = 'control_worker_settings_request_rejected'
                       AND binding.expected_source_version_id IS NOT NULL
                       AND binding.previous_restore_settings_json IS NOT NULL
                       AND binding.patch_result_version_id IS NULL
                       AND binding.patch_result_deployment_id IS NULL
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM control_worker_binding_reconciliations conflicting
                     WHERE conflicting.operation_id = operation.operation_id
                       AND conflicting.state = 'blocked'
                       AND (
                         conflicting.last_error_code IS NOT 'control_worker_settings_request_rejected'
                         OR conflicting.patch_result_version_id IS NOT NULL
                         OR conflicting.patch_result_deployment_id IS NOT NULL
                       )
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM control_operation_steps running_step
                     WHERE running_step.operation_id = operation.operation_id
                       AND running_step.status = 'running'
                  )
             ) AS retry_reconcile_worker_bindings,
             EXISTS (
               SELECT 1
                 FROM control_operations operation
                 JOIN control_worker_binding_reconciliations binding
                   ON binding.operation_id = operation.operation_id
                  AND binding.environment_id = operation.environment_id
                WHERE operation.operation_id = ? AND operation.environment_id = ?
                  AND operation.operation_kind = 'provision_shard'
                  AND operation.status = 'blocked'
                  AND binding.state = 'blocked'
                  AND binding.last_error_code = 'control_worker_rollback_failed'
                  AND binding.expected_source_version_id IS NOT NULL
                  AND binding.patch_result_version_id IS NOT NULL
                  AND binding.patch_result_deployment_id IS NOT NULL
                  AND binding.previous_restore_settings_json IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM control_worker_binding_reconciliations conflicting
                     WHERE conflicting.operation_id = operation.operation_id
                       AND conflicting.state = 'blocked'
                       AND (
                         conflicting.last_error_code IS NOT 'control_worker_rollback_failed'
                         OR conflicting.expected_source_version_id IS NULL
                         OR conflicting.patch_result_version_id IS NULL
                         OR conflicting.patch_result_deployment_id IS NULL
                         OR conflicting.previous_restore_settings_json IS NULL
                       )
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM control_worker_binding_reconciliations in_progress
                     WHERE in_progress.operation_id = operation.operation_id
                       AND in_progress.state NOT IN ('succeeded', 'rolled_back', 'blocked')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM control_operation_steps running_step
                     WHERE running_step.operation_id = operation.operation_id
                       AND running_step.status = 'running'
                  )
                  AND EXISTS (
                    SELECT 1 FROM control_operation_steps blocked_step
                     WHERE blocked_step.operation_id = operation.operation_id
                       AND blocked_step.step_key IN (
                         'reconcile_worker_bindings',
                         'smoke_bindings',
                         'stabilize_bindings'
                       )
                       AND blocked_step.status = 'blocked'
                  )
             ) AS restore_previous_settings,
             EXISTS (
               SELECT 1
                 FROM control_operations operation
                WHERE operation.operation_id = ? AND operation.environment_id = ?
                  AND operation.status = 'blocked'
                  AND NOT EXISTS (
                    SELECT 1 FROM control_operation_steps running_step
                     WHERE running_step.operation_id = operation.operation_id
                       AND running_step.status = 'running'
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM control_worker_deployment_leases lease
                     WHERE lease.owner_operation_id = operation.operation_id
                  )
                  AND (
                    (
                      operation.operation_kind = 'provision_plugin_resources'
                      AND EXISTS (
                        SELECT 1 FROM control_plugin_desired_resources resource
                         WHERE resource.operation_id = operation.operation_id
                           AND resource.environment_id = operation.environment_id
                           AND resource.status IN ('pending', 'provisioning', 'ready', 'active', 'failed')
                      )
                    ) OR (
                      operation.operation_kind = 'provision_shard'
                      AND EXISTS (
                        SELECT 1
                          FROM control_desired_resources desired
                          JOIN control_tenant_shards shard
                            ON shard.d1_desired_resource_id = desired.desired_resource_id
                           AND shard.environment_id = operation.environment_id
                         WHERE desired.origin_operation_id = operation.operation_id
                           AND desired.environment_id = operation.environment_id
                           AND shard.status IN ('requested', 'provisioning', 'ready', 'failed')
                           AND NOT EXISTS (
                             SELECT 1 FROM control_worker_binding_reconciliations binding
                              WHERE binding.operation_id = operation.operation_id
                           )
                           AND NOT EXISTS (
                             SELECT 1 FROM control_tenant_shard_allocations allocation
                              WHERE allocation.selected_shard_id = shard.shard_id
                                AND allocation.reservation_state IN ('reserved', 'committed')
                           )
                           AND NOT EXISTS (
                             SELECT 1 FROM control_tenant_default_allocations allocation
                              WHERE allocation.selected_shard_id = shard.shard_id
                                AND allocation.reservation_state IN ('reserved', 'committed')
                           )
                           AND NOT EXISTS (
                             SELECT 1 FROM control_runtime_registry_routes route
                              WHERE route.environment_id = operation.environment_id
                                AND (
                                  json_extract(route.route_projection_json, '$.target.shardId') = shard.shard_id
                                  OR EXISTS (
                                    SELECT 1 FROM json_each(route.route_projection_json, '$.targets') target
                                     WHERE json_extract(target.value, '$.shardId') = shard.shard_id
                                  )
                                )
                           )
                      )
                    )
                  )
             ) AS cancel_operation`
        )
        .bind(
          operationId,
          environmentId,
          operationId,
          environmentId,
          operationId,
          environmentId,
          operationId,
          environmentId,
          operationId,
          environmentId
        )
        .first<OperationActionAvailabilityRow>(),
    ]);
    if (!availability) throw new Error('control_operation_action_status_unavailable');
    const availableActions: ControlProvisioningOperationDetail['availableActions'] = [];
    if (availability.retry_create_d1 === 1) availableActions.push('retry_create_d1');
    if (availability.retry_apply_migrations === 1) availableActions.push('retry_apply_migrations');
    if (availability.retry_reconcile_worker_bindings === 1) {
      availableActions.push('retry_reconcile_worker_bindings');
    }
    if (availability.restore_previous_settings === 1) {
      availableActions.push('restore_previous_settings');
    }
    if (availability.cancel_operation === 1) availableActions.push('cancel');
    return {
      operationId: operation.operationId,
      operationKind: operation.operationKind,
      status: operation.status as ControlProvisioningOperationDetail['status'],
      attemptCount: operation.attemptCount,
      nextAttemptAt: operation.nextAttemptAt,
      lastErrorCode: operation.lastErrorCode,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      availableActions,
      steps: rows.results.map((row) => ({
        stepKey: row.step_key,
        displayOrder: row.display_order,
        status: row.status,
        attemptCount: row.attempt_count,
        nextAttemptAt: row.next_attempt_at,
        lastErrorCode: row.last_error_code,
        observedResourceId: row.observed_resource_id,
        progressCurrent: row.progress_current,
        progressTotal: row.progress_total,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  async retryProvisioningOperationStep(
    input: ControlProvisioningOperationRetryRequest,
    environmentId: string,
    now: number
  ): Promise<ControlProvisioningOperationDetail> {
    const eventId = `audit:${environmentId}:operator-retry:${input.idempotencyKey}`;
    const payload = JSON.stringify({
      step_key: input.stepKey,
      reason_code: input.reasonCode,
      idempotency_key: input.idempotencyKey,
      before: { operation_status: 'blocked', step_status: 'blocked' },
      after: { operation_status: 'running', step_status: 'running' },
    });
    const existing = await this.db
      .prepare(
        `SELECT environment_id, operation_id, actor_id, resource_id, redacted_payload_json
           FROM control_audit_events
          WHERE event_id = ?`
      )
      .bind(eventId)
      .first<OperatorRetryAuditRow>();
    if (existing) {
      if (
        existing.environment_id !== environmentId ||
        existing.operation_id !== input.operationId ||
        existing.actor_id !== input.requestedById ||
        existing.resource_id !== input.stepKey ||
        existing.redacted_payload_json !== payload
      ) {
        throw new Error('control_operation_retry_conflict');
      }
      const replay = await this.getProvisioningOperation(input.operationId, environmentId);
      if (!replay) throw new Error('control_operation_retry_conflict');
      return replay;
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, operation.environment_id, operation.operation_id,
                  'control.operation.retry_step', 'admin', ?, 'operation_step', step.step_key,
                  'succeeded', ?, ?
             FROM control_operations operation
             JOIN control_operation_steps step ON step.operation_id = operation.operation_id
            WHERE operation.operation_id = ? AND operation.environment_id = ?
              AND operation.operation_kind = 'provision_shard'
              AND operation.status = 'blocked' AND step.step_key = ? AND step.status = 'blocked'
              AND (
                (step.step_key = 'create_d1' AND EXISTS (
                  SELECT 1 FROM control_desired_resources desired
                   WHERE desired.origin_operation_id = operation.operation_id
                     AND desired.observed_resource_id IS NULL
                )) OR
                (step.step_key = 'apply_migrations' AND EXISTS (
                  SELECT 1 FROM control_tenant_database_migration_state migration
                   WHERE migration.operation_id = operation.operation_id
                     AND migration.provider_database_id IS NOT NULL
                     AND migration.state = 'blocked'
                )) OR
                (step.step_key = 'reconcile_worker_bindings' AND EXISTS (
                  SELECT 1 FROM control_worker_binding_reconciliations binding
                   WHERE binding.operation_id = operation.operation_id
                     AND binding.state = 'blocked'
                     AND binding.last_error_code = 'control_worker_settings_request_rejected'
                     AND binding.expected_source_version_id IS NOT NULL
                     AND binding.previous_restore_settings_json IS NOT NULL
                     AND binding.patch_result_version_id IS NULL
                     AND binding.patch_result_deployment_id IS NULL
                ) AND NOT EXISTS (
                  SELECT 1 FROM control_worker_binding_reconciliations conflicting
                   WHERE conflicting.operation_id = operation.operation_id
                     AND conflicting.state = 'blocked'
                     AND (
                       conflicting.last_error_code IS NOT 'control_worker_settings_request_rejected'
                       OR conflicting.patch_result_version_id IS NOT NULL
                       OR conflicting.patch_result_deployment_id IS NOT NULL
                     )
                ))
              )`
        )
        .bind(
          eventId,
          input.requestedById,
          payload,
          now,
          input.operationId,
          environmentId,
          input.stepKey
        ),
      this.db
        .prepare(
          `DELETE FROM control_worker_deployment_leases
            WHERE owner_operation_id = ? AND ? = 'reconcile_worker_bindings'
              AND mutation_started = 1
              AND patch_result_version_id IS NULL
              AND patch_result_deployment_id IS NULL
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ?
                   AND audit.operation_id = control_worker_deployment_leases.owner_operation_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.operationId,
          input.stepKey,
          eventId,
          input.requestedById,
          input.stepKey,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET state = 'pending', expected_source_version_id = NULL,
                  previous_deployment_id = NULL, previous_restore_settings_json = NULL,
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND ? = 'reconcile_worker_bindings'
              AND state = 'blocked'
              AND last_error_code = 'control_worker_settings_request_rejected'
              AND patch_result_version_id IS NULL AND patch_result_deployment_id IS NULL
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ?
                   AND audit.operation_id = control_worker_binding_reconciliations.operation_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          now,
          input.operationId,
          input.stepKey,
          eventId,
          input.requestedById,
          input.stepKey,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'running', next_attempt_at = NULL, last_error_code = NULL,
                  last_error_redacted = NULL, lock_owner = NULL, lock_expires_at = ?,
                  retry_budget_started_at = ?, completed_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = control_operations.operation_id
                   AND audit.environment_id = control_operations.environment_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          now,
          now,
          now,
          input.operationId,
          environmentId,
          eventId,
          input.requestedById,
          input.stepKey,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', next_attempt_at = NULL, last_error_code = NULL,
                  last_error_redacted = NULL, completed_at = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = control_operation_steps.operation_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          now,
          input.operationId,
          input.stepKey,
          eventId,
          input.requestedById,
          input.stepKey,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_tenant_database_migration_state
              SET state = 'waiting_retry', last_error_code = NULL, completed_at = NULL,
                  updated_at = ?
            WHERE operation_id = ? AND state = 'blocked' AND ? = 'apply_migrations'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ?
                   AND audit.operation_id = control_tenant_database_migration_state.operation_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          now,
          input.operationId,
          input.stepKey,
          eventId,
          input.requestedById,
          input.stepKey,
          payload
        ),
    ]);

    const recorded = await this.db
      .prepare(
        `SELECT environment_id, operation_id, actor_id, resource_id, redacted_payload_json
           FROM control_audit_events
          WHERE event_id = ?`
      )
      .bind(eventId)
      .first<OperatorRetryAuditRow>();
    if (!recorded) throw new Error('control_operation_retry_not_retryable');
    if (
      recorded.environment_id !== environmentId ||
      recorded.operation_id !== input.operationId ||
      recorded.actor_id !== input.requestedById ||
      recorded.resource_id !== input.stepKey ||
      recorded.redacted_payload_json !== payload
    ) {
      throw new Error('control_operation_retry_conflict');
    }
    const operation = await this.getProvisioningOperation(input.operationId, environmentId);
    if (!operation || operation.status !== 'running') {
      throw new Error('control_operation_retry_conflict');
    }
    return operation;
  }

  async cancelProvisioningOperation(
    input: ControlProvisioningOperationCancelRequest,
    environmentId: string,
    now: number
  ): Promise<ControlProvisioningOperationDetail> {
    const eventId = `audit:${environmentId}:operator-cancel:${input.idempotencyKey}`;
    const payload = JSON.stringify({
      reason_code: input.reasonCode,
      idempotency_key: input.idempotencyKey,
      before: { operation_status: 'blocked' },
      after: { operation_status: 'canceled' },
      retained_resources: true,
    });
    const existing = await this.db
      .prepare(
        `SELECT environment_id, operation_id, actor_id, resource_id, redacted_payload_json
           FROM control_audit_events
          WHERE event_id = ?`
      )
      .bind(eventId)
      .first<OperatorMutationAuditRow>();
    if (existing) {
      if (
        existing.environment_id !== environmentId ||
        existing.operation_id !== input.operationId ||
        existing.actor_id !== input.requestedById ||
        existing.resource_id !== input.operationId ||
        existing.redacted_payload_json !== payload
      ) {
        throw new Error('control_operation_cancel_conflict');
      }
      const replay = await this.getProvisioningOperation(input.operationId, environmentId);
      if (!replay) throw new Error('control_operation_cancel_conflict');
      return replay;
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, operation.environment_id, operation.operation_id,
                  'control.operation.cancel', 'admin', ?, 'operation', operation.operation_id,
                  'succeeded', ?, ?
             FROM control_operations operation
            WHERE operation.operation_id = ? AND operation.environment_id = ?
              AND operation.status = 'blocked'
              AND NOT EXISTS (
                SELECT 1 FROM control_operation_steps running_step
                 WHERE running_step.operation_id = operation.operation_id
                   AND running_step.status = 'running'
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_worker_deployment_leases lease
                 WHERE lease.owner_operation_id = operation.operation_id
              )
              AND (
                (
                  operation.operation_kind = 'provision_plugin_resources'
                  AND EXISTS (
                    SELECT 1 FROM control_plugin_desired_resources resource
                     WHERE resource.operation_id = operation.operation_id
                       AND resource.environment_id = operation.environment_id
                       AND resource.status IN ('pending', 'provisioning', 'ready', 'active', 'failed')
                  )
                ) OR (
                  operation.operation_kind = 'provision_shard'
                  AND EXISTS (
                    SELECT 1
                      FROM control_desired_resources desired
                      JOIN control_tenant_shards shard
                        ON shard.d1_desired_resource_id = desired.desired_resource_id
                       AND shard.environment_id = operation.environment_id
                     WHERE desired.origin_operation_id = operation.operation_id
                       AND desired.environment_id = operation.environment_id
                       AND shard.status IN ('requested', 'provisioning', 'ready', 'failed')
                       AND NOT EXISTS (
                         SELECT 1 FROM control_worker_binding_reconciliations binding
                          WHERE binding.operation_id = operation.operation_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM control_tenant_shard_allocations allocation
                          WHERE allocation.selected_shard_id = shard.shard_id
                            AND allocation.reservation_state IN ('reserved', 'committed')
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM control_tenant_default_allocations allocation
                          WHERE allocation.selected_shard_id = shard.shard_id
                            AND allocation.reservation_state IN ('reserved', 'committed')
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM control_runtime_registry_routes route
                          WHERE route.environment_id = operation.environment_id
                            AND (
                              json_extract(route.route_projection_json, '$.target.shardId') = shard.shard_id
                              OR EXISTS (
                                SELECT 1 FROM json_each(route.route_projection_json, '$.targets') target
                                 WHERE json_extract(target.value, '$.shardId') = shard.shard_id
                              )
                            )
                       )
                  )
                )
              )`
        )
        .bind(eventId, input.requestedById, payload, now, input.operationId, environmentId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'canceled', next_attempt_at = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'waiting_retry', 'blocked')
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = control_operation_steps.operation_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          now,
          now,
          input.operationId,
          eventId,
          input.requestedById,
          input.operationId,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'canceled', next_attempt_at = NULL, lock_owner = NULL,
                  lock_expires_at = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = control_operations.operation_id
                   AND audit.environment_id = control_operations.environment_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          now,
          now,
          input.operationId,
          environmentId,
          eventId,
          input.requestedById,
          input.operationId,
          payload
        ),
    ]);

    const recorded = await this.db
      .prepare(
        `SELECT environment_id, operation_id, actor_id, resource_id, redacted_payload_json
           FROM control_audit_events
          WHERE event_id = ?`
      )
      .bind(eventId)
      .first<OperatorMutationAuditRow>();
    if (!recorded) throw new Error('control_operation_cancel_not_allowed');
    if (
      recorded.environment_id !== environmentId ||
      recorded.operation_id !== input.operationId ||
      recorded.actor_id !== input.requestedById ||
      recorded.resource_id !== input.operationId ||
      recorded.redacted_payload_json !== payload
    ) {
      throw new Error('control_operation_cancel_conflict');
    }
    const operation = await this.getProvisioningOperation(input.operationId, environmentId);
    if (!operation || operation.status !== 'canceled') {
      throw new Error('control_operation_cancel_conflict');
    }
    return operation;
  }

  async restoreProvisioningOperationPreviousSettings(
    input: ControlProvisioningOperationRestoreRequest,
    environmentId: string,
    now: number
  ): Promise<ControlProvisioningOperationDetail> {
    const eventId = `audit:${environmentId}:operator-restore-settings:${input.idempotencyKey}`;
    const payload = JSON.stringify({
      reason_code: input.reasonCode,
      idempotency_key: input.idempotencyKey,
      before: { operation_status: 'blocked', binding_state: 'blocked' },
      after: { operation_status: 'running', binding_state: 'rollback_required' },
      provider_mutation: 'deferred_to_reconciler',
    });
    const existing = await this.db
      .prepare(
        `SELECT environment_id, operation_id, actor_id, resource_id, redacted_payload_json
           FROM control_audit_events
          WHERE event_id = ?`
      )
      .bind(eventId)
      .first<OperatorMutationAuditRow>();
    if (existing) {
      if (
        existing.environment_id !== environmentId ||
        existing.operation_id !== input.operationId ||
        existing.actor_id !== input.requestedById ||
        existing.resource_id !== input.operationId ||
        existing.redacted_payload_json !== payload
      ) {
        throw new Error('control_operation_restore_conflict');
      }
      const replay = await this.getProvisioningOperation(input.operationId, environmentId);
      if (!replay) throw new Error('control_operation_restore_conflict');
      return replay;
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, operation.environment_id, operation.operation_id,
                  'control.operation.restore_previous_settings', 'admin', ?,
                  'operation', operation.operation_id, 'succeeded', ?, ?
             FROM control_operations operation
            WHERE operation.operation_id = ? AND operation.environment_id = ?
              AND operation.operation_kind = 'provision_shard'
              AND operation.status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations binding
                 WHERE binding.operation_id = operation.operation_id
                   AND binding.environment_id = operation.environment_id
                   AND binding.state = 'blocked'
                   AND binding.last_error_code = 'control_worker_rollback_failed'
                   AND binding.expected_source_version_id IS NOT NULL
                   AND binding.patch_result_version_id IS NOT NULL
                   AND binding.patch_result_deployment_id IS NOT NULL
                   AND binding.previous_restore_settings_json IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations conflicting
                 WHERE conflicting.operation_id = operation.operation_id
                   AND conflicting.state = 'blocked'
                   AND (
                     conflicting.last_error_code IS NOT 'control_worker_rollback_failed'
                     OR conflicting.expected_source_version_id IS NULL
                     OR conflicting.patch_result_version_id IS NULL
                     OR conflicting.patch_result_deployment_id IS NULL
                     OR conflicting.previous_restore_settings_json IS NULL
                   )
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_worker_binding_reconciliations in_progress
                 WHERE in_progress.operation_id = operation.operation_id
                   AND in_progress.state NOT IN ('succeeded', 'rolled_back', 'blocked')
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_operation_steps running_step
                 WHERE running_step.operation_id = operation.operation_id
                   AND running_step.status = 'running'
              )
              AND EXISTS (
                SELECT 1 FROM control_operation_steps blocked_step
                 WHERE blocked_step.operation_id = operation.operation_id
                   AND blocked_step.step_key IN (
                     'reconcile_worker_bindings',
                     'smoke_bindings',
                     'stabilize_bindings'
                   )
                   AND blocked_step.status = 'blocked'
              )`
        )
        .bind(eventId, input.requestedById, payload, now, input.operationId, environmentId),
      this.db
        .prepare(
          `UPDATE control_worker_binding_reconciliations
              SET state = 'rollback_required',
                  last_error_code = 'control_worker_manual_restore_requested', updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND state = 'blocked'
              AND last_error_code = 'control_worker_rollback_failed'
              AND expected_source_version_id IS NOT NULL
              AND patch_result_version_id IS NOT NULL
              AND patch_result_deployment_id IS NOT NULL
              AND previous_restore_settings_json IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ?
                   AND audit.operation_id = control_worker_binding_reconciliations.operation_id
                   AND audit.environment_id = control_worker_binding_reconciliations.environment_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          now,
          input.operationId,
          environmentId,
          eventId,
          input.requestedById,
          input.operationId,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', next_attempt_at = NULL, last_error_code = NULL,
                  last_error_redacted = NULL, completed_at = NULL, updated_at = ?
            WHERE operation_id = ?
              AND step_key IN ('reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings')
              AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ?
                   AND audit.operation_id = control_operation_steps.operation_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(now, input.operationId, eventId, input.requestedById, input.operationId, payload),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'running', next_attempt_at = NULL, last_error_code = NULL,
                  last_error_redacted = NULL, lock_owner = NULL, lock_expires_at = NULL,
                  retry_budget_started_at = ?, completed_at = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = control_operations.operation_id
                   AND audit.environment_id = control_operations.environment_id
                   AND audit.actor_id = ? AND audit.resource_id = ?
                   AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          now,
          now,
          input.operationId,
          environmentId,
          eventId,
          input.requestedById,
          input.operationId,
          payload
        ),
    ]);

    const recorded = await this.db
      .prepare(
        `SELECT environment_id, operation_id, actor_id, resource_id, redacted_payload_json
           FROM control_audit_events
          WHERE event_id = ?`
      )
      .bind(eventId)
      .first<OperatorMutationAuditRow>();
    if (!recorded) throw new Error('control_operation_restore_not_allowed');
    if (
      recorded.environment_id !== environmentId ||
      recorded.operation_id !== input.operationId ||
      recorded.actor_id !== input.requestedById ||
      recorded.resource_id !== input.operationId ||
      recorded.redacted_payload_json !== payload
    ) {
      throw new Error('control_operation_restore_conflict');
    }
    const operation = await this.getProvisioningOperation(input.operationId, environmentId);
    if (!operation || operation.status !== 'running') {
      throw new Error('control_operation_restore_conflict');
    }
    return operation;
  }

  async findEligibleTenantShard(input: {
    environmentId: string;
    tenantId: string;
    dataRole: TenantShardDataRole;
    residencyPolicyId: string;
    residencyPartition: string;
    allocationScope: ControlTenantShardAllocationScope;
    ownerTenantId: string | null;
  }): Promise<ControlTenantShardCapacityTarget | null> {
    const row = await this.db
      .prepare(
        `SELECT s.shard_id, s.data_role, s.residency_policy_id, s.residency_partition,
                s.generation, s.binding_ref, observed.provider_resource_id,
                desired.deterministic_name, s.allocation_scope, s.owner_tenant_id,
                assignment.assignment_generation
           FROM control_tenant_shard_assignments assignment
           JOIN control_tenant_shards s
             ON s.shard_id = assignment.shard_id
            AND s.environment_id = assignment.environment_id
           JOIN control_shard_capacity capacity ON capacity.shard_id = s.shard_id
           JOIN control_desired_resources desired
             ON desired.desired_resource_id = s.d1_desired_resource_id
            AND desired.environment_id = s.environment_id
           JOIN control_observed_resources observed
             ON observed.observed_resource_id = desired.observed_resource_id
            AND observed.environment_id = s.environment_id
          WHERE assignment.environment_id = ? AND assignment.tenant_id = ?
            AND assignment.data_role = ? AND assignment.residency_policy_id = ?
            AND assignment.residency_partition = ? AND assignment.assignment_state = 'active'
            AND s.data_role = assignment.data_role
            AND s.residency_policy_id = ? AND s.residency_partition = ?
            AND s.allocation_scope = ?
            AND ((? = 'shared_pool' AND s.owner_tenant_id IS NULL) OR
                 (? = 'tenant_exclusive' AND s.owner_tenant_id = ?))
            AND s.status = 'active' AND capacity.health_status = 'healthy'
            AND capacity.allocation_status = 'eligible'
            AND capacity.allocated_account_count < capacity.target_account_count
            AND desired.desired_state = 'present' AND desired.provisioning_state = 'ready'
            AND observed.observed_state = 'present'
          ORDER BY (1.0 * capacity.allocated_account_count / capacity.target_account_count),
                   capacity.allocated_account_count, s.shard_id
          LIMIT 1`
      )
      .bind(
        input.environmentId,
        input.tenantId,
        input.dataRole,
        input.residencyPolicyId,
        input.residencyPartition,
        input.residencyPolicyId,
        input.residencyPartition,
        input.allocationScope,
        input.allocationScope,
        input.allocationScope,
        input.ownerTenantId
      )
      .first<{
        shard_id: string;
        data_role: TenantShardDataRole;
        residency_policy_id: string;
        residency_partition: string;
        generation: number | string;
        binding_ref: string;
        provider_resource_id: string;
        deterministic_name: string;
        allocation_scope: ControlTenantShardAllocationScope;
        owner_tenant_id: string | null;
        assignment_generation: number | string;
      }>();
    if (!row) return null;
    const routeGeneration =
      typeof row.generation === 'number' ? row.generation : Number(row.generation);
    const assignmentGeneration =
      typeof row.assignment_generation === 'number'
        ? row.assignment_generation
        : Number(row.assignment_generation);
    if (
      !Number.isSafeInteger(routeGeneration) ||
      routeGeneration < 1 ||
      !Number.isSafeInteger(assignmentGeneration) ||
      assignmentGeneration < 1
    ) {
      throw new Error('control_tenant_shard_capacity_invalid');
    }
    return {
      shardId: row.shard_id,
      dataRole: row.data_role,
      residencyPolicyId: row.residency_policy_id,
      residencyPartition: row.residency_partition,
      routeGeneration,
      bindingRef: row.binding_ref,
      databaseId: row.provider_resource_id,
      databaseName: row.deterministic_name,
      allocationScope: row.allocation_scope,
      ownerTenantId: row.owner_tenant_id,
      assignmentGeneration,
    };
  }

  async listActiveTenantShardTargets(input: {
    environmentId: string;
    tenantId: string;
    residencyPolicyId: string;
    residencyPartition: string;
  }): Promise<ControlTenantShardCapacityTarget[]> {
    const rows = await this.db
      .prepare(
        `SELECT shard.shard_id, shard.data_role, shard.residency_policy_id,
                shard.residency_partition, shard.generation, shard.binding_ref,
                observed.provider_resource_id, desired.deterministic_name,
                shard.allocation_scope, shard.owner_tenant_id,
                assignment.assignment_generation
           FROM control_tenant_shard_assignments assignment
           JOIN control_tenant_shards shard
             ON shard.environment_id = assignment.environment_id
            AND shard.shard_id = assignment.shard_id
           JOIN control_desired_resources desired
             ON desired.environment_id = shard.environment_id
            AND desired.desired_resource_id = shard.d1_desired_resource_id
           JOIN control_observed_resources observed
             ON observed.environment_id = desired.environment_id
            AND observed.observed_resource_id = desired.observed_resource_id
          WHERE assignment.environment_id = ? AND assignment.tenant_id = ?
            AND assignment.residency_policy_id = ? AND assignment.residency_partition = ?
            AND assignment.assignment_state = 'active'
            AND shard.residency_policy_id = assignment.residency_policy_id
            AND shard.residency_partition = assignment.residency_partition
            AND shard.data_role = assignment.data_role
            AND shard.status = 'active'
            AND desired.desired_state = 'present' AND desired.provisioning_state = 'ready'
            AND observed.observed_state = 'present'
          ORDER BY shard.data_role, assignment.assignment_generation, shard.shard_id`
      )
      .bind(input.environmentId, input.tenantId, input.residencyPolicyId, input.residencyPartition)
      .all<{
        shard_id: string;
        data_role: TenantShardDataRole;
        residency_policy_id: string;
        residency_partition: string;
        generation: number | string;
        binding_ref: string;
        provider_resource_id: string;
        deterministic_name: string;
        allocation_scope: ControlTenantShardAllocationScope;
        owner_tenant_id: string | null;
        assignment_generation: number | string;
      }>();

    return rows.results.map((row) => {
      const routeGeneration = Number(row.generation);
      const assignmentGeneration = Number(row.assignment_generation);
      if (
        !Number.isSafeInteger(routeGeneration) ||
        routeGeneration < 1 ||
        !Number.isSafeInteger(assignmentGeneration) ||
        assignmentGeneration < 1
      ) {
        throw new Error('control_tenant_shard_assignment_invalid');
      }
      return {
        shardId: row.shard_id,
        dataRole: row.data_role,
        residencyPolicyId: row.residency_policy_id,
        residencyPartition: row.residency_partition,
        routeGeneration,
        bindingRef: row.binding_ref,
        databaseId: row.provider_resource_id,
        databaseName: row.deterministic_name,
        allocationScope: row.allocation_scope,
        ownerTenantId: row.owner_tenant_id,
        assignmentGeneration,
      };
    });
  }

  async listTenantDeletionLookupShards(
    environmentId: string
  ): Promise<ControlTenantDeletionLookupShardTarget[]> {
    const result = await this.db
      .prepare(
        `SELECT lookup_shard_id, binding_ref, status
           FROM control_lookup_physical_shards
          WHERE environment_id = ? AND status IN ('ready', 'active', 'draining')
          ORDER BY lookup_shard_id`
      )
      .bind(environmentId)
      .all<{
        lookup_shard_id: string;
        binding_ref: string;
        status: ControlTenantDeletionLookupShardTarget['status'];
      }>();
    return result.results.map((row) => ({
      lookupShardId: row.lookup_shard_id,
      bindingRef: row.binding_ref,
      status: row.status,
    }));
  }

  async listTenantDeletionShards(input: {
    environmentId: string;
    tenantId: string;
  }): Promise<ControlTenantDeletionShardTarget[]> {
    const result = await this.db
      .prepare(
        `SELECT DISTINCT shard.shard_id, shard.data_role, shard.residency_policy_id,
                shard.residency_partition, shard.binding_ref, shard.status,
                shard.allocation_scope, shard.owner_tenant_id
           FROM control_tenant_shard_assignments assignment
           JOIN control_tenant_shards shard
             ON shard.environment_id = assignment.environment_id
            AND shard.shard_id = assignment.shard_id
          WHERE assignment.environment_id = ? AND assignment.tenant_id = ?
            AND assignment.assignment_state = 'active'
            AND shard.data_role = assignment.data_role
            AND shard.residency_policy_id = assignment.residency_policy_id
            AND shard.residency_partition = assignment.residency_partition
            AND shard.status IN ('ready', 'active', 'degraded')
          ORDER BY shard.data_role, shard.residency_partition, shard.shard_id`
      )
      .bind(input.environmentId, input.tenantId)
      .all<{
        shard_id: string;
        data_role: TenantShardDataRole;
        residency_policy_id: string;
        residency_partition: string;
        binding_ref: string;
        status: ControlTenantDeletionShardTarget['status'];
        allocation_scope: ControlTenantShardAllocationScope;
        owner_tenant_id: string | null;
      }>();
    return result.results.map((row) => ({
      shardId: row.shard_id,
      dataRole: row.data_role,
      residencyPolicyId: row.residency_policy_id,
      residencyPartition: row.residency_partition,
      bindingRef: row.binding_ref,
      status: row.status,
      allocationScope: row.allocation_scope,
      ownerTenantId: row.owner_tenant_id,
    }));
  }

  async getTenantDeletionFinalization(input: {
    environmentId: string;
    tenantId: string;
    operationId: string;
  }): Promise<ControlTenantDeletionFinalization | null> {
    const row = await this.db
      .prepare(
        `SELECT created_at
           FROM control_audit_events
          WHERE event_id = ? AND environment_id = ?
            AND event_type = 'control.tenant_deletion.finalized'
            AND resource_kind = 'tenant' AND resource_id = ? AND outcome = 'succeeded'`
      )
      .bind(
        `audit:tenant-deletion:${input.environmentId}:${input.operationId}`,
        input.environmentId,
        input.tenantId
      )
      .first<{ created_at: number }>();
    return row
      ? {
          environmentId: input.environmentId,
          tenantId: input.tenantId,
          operationId: input.operationId,
          state: 'finalized',
          finalizedAt: row.created_at,
        }
      : null;
  }

  async finalizeTenantDeletionControlState(
    input: {
      environmentId: string;
      tenantId: string;
      operationId: string;
    },
    now: number
  ): Promise<ControlTenantDeletionFinalization> {
    const eventId = `audit:tenant-deletion:${input.environmentId}:${input.operationId}`;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_capacity
              SET allocated_account_count = MAX(
                    0,
                    allocated_account_count -
                    (SELECT COUNT(*) FROM control_tenant_shard_allocations allocation
                      WHERE allocation.selected_shard_id = control_shard_capacity.shard_id
                        AND allocation.environment_id = ? AND allocation.tenant_id = ?
                        AND allocation.reservation_state IN ('reserved', 'committed')
                        AND allocation.capacity_counted_at IS NOT NULL) -
                    (SELECT COUNT(*) FROM control_tenant_default_allocations allocation
                      WHERE allocation.selected_shard_id = control_shard_capacity.shard_id
                        AND allocation.environment_id = ? AND allocation.tenant_id = ?
                        AND allocation.reservation_state IN ('reserved', 'committed')
                        AND allocation.capacity_counted_at IS NOT NULL)
                  ),
                  updated_at = ?
            WHERE shard_id IN (
              SELECT selected_shard_id FROM control_tenant_shard_allocations
               WHERE environment_id = ? AND tenant_id = ?
                 AND reservation_state IN ('reserved', 'committed')
              UNION
              SELECT selected_shard_id FROM control_tenant_default_allocations
               WHERE environment_id = ? AND tenant_id = ?
                 AND reservation_state IN ('reserved', 'committed')
            )`
        )
        .bind(
          input.environmentId,
          input.tenantId,
          input.environmentId,
          input.tenantId,
          now,
          input.environmentId,
          input.tenantId,
          input.environmentId,
          input.tenantId
        ),
      this.db
        .prepare(
          `UPDATE control_tenant_shard_allocations
              SET reservation_state = 'released', capacity_counted_at = NULL, updated_at = ?
            WHERE environment_id = ? AND tenant_id = ?
              AND reservation_state IN ('reserved', 'committed')`
        )
        .bind(now, input.environmentId, input.tenantId),
      this.db
        .prepare(
          `UPDATE control_tenant_default_allocations
              SET reservation_state = 'released', capacity_counted_at = NULL,
                  released_at = COALESCE(released_at, ?), updated_at = ?
            WHERE environment_id = ? AND tenant_id = ?
              AND reservation_state IN ('reserved', 'committed')`
        )
        .bind(now, now, input.environmentId, input.tenantId),
      this.db
        .prepare(
          `UPDATE control_tenant_shard_assignments
              SET assignment_state = 'retired', retired_at = COALESCE(retired_at, ?), updated_at = ?
            WHERE environment_id = ? AND tenant_id = ?
              AND assignment_state IN ('pending', 'active')`
        )
        .bind(now, now, input.environmentId, input.tenantId),
      this.db
        .prepare(
          `UPDATE control_tenant_placement_policies
              SET policy_state = 'retired', pending_isolation_policy = NULL,
                  pending_policy_generation = NULL, migration_operation_id = NULL, updated_at = ?
            WHERE environment_id = ? AND tenant_id = ? AND policy_state <> 'retired'`
        )
        .bind(now, input.environmentId, input.tenantId),
      this.db
        .prepare(
          `UPDATE control_runtime_registry_routes
              SET tenant_lifecycle_state = 'disabled', route_status = 'disabled',
                  quarantine_deny_generation = quarantine_deny_generation + 1,
                  tenant_lifecycle_generation = tenant_lifecycle_generation + 1,
                  route_generation = route_generation + 1, updated_at = ?
            WHERE environment_id = ? AND tenant_id = ?
              AND (tenant_lifecycle_state <> 'disabled' OR route_status <> 'disabled')`
        )
        .bind(now, input.environmentId, input.tenantId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, 'control.tenant_deletion.finalized', 'ar-management', ?,
                    'tenant', ?, 'succeeded', ?, ?
              WHERE EXISTS (
                SELECT 1 FROM control_tenant_placement_policies
                 WHERE environment_id = ? AND tenant_id = ? AND policy_state = 'retired'
              )
                AND NOT EXISTS (
                  SELECT 1 FROM control_tenant_shard_assignments
                   WHERE environment_id = ? AND tenant_id = ?
                     AND assignment_state IN ('pending', 'active')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM control_tenant_shard_allocations
                   WHERE environment_id = ? AND tenant_id = ?
                     AND reservation_state IN ('reserved', 'committed')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM control_tenant_default_allocations
                   WHERE environment_id = ? AND tenant_id = ?
                     AND reservation_state IN ('reserved', 'committed')
                )`
        )
        .bind(
          eventId,
          input.environmentId,
          input.operationId,
          input.tenantId,
          JSON.stringify({ operation_id: input.operationId }),
          now,
          input.environmentId,
          input.tenantId,
          input.environmentId,
          input.tenantId,
          input.environmentId,
          input.tenantId,
          input.environmentId,
          input.tenantId
        ),
    ]);
    const result = await this.getTenantDeletionFinalization(input);
    if (!result) throw new Error('control_tenant_deletion_finalization_not_reflected');
    return result;
  }

  async findAssignableTenantShard(input: {
    environmentId: string;
    tenantId: string;
    dataRole: TenantShardDataRole;
    residencyPolicyId: string;
    residencyPartition: string;
    allocationScope: ControlTenantShardAllocationScope;
    ownerTenantId: string | null;
  }): Promise<TenantShardCandidate | null> {
    const row = await this.db
      .prepare(
        `SELECT s.shard_id, s.data_role, s.residency_policy_id, s.residency_partition,
                s.generation, s.binding_ref, observed.provider_resource_id,
                desired.deterministic_name, s.allocation_scope, s.owner_tenant_id
           FROM control_tenant_shards s
           JOIN control_shard_capacity capacity ON capacity.shard_id = s.shard_id
           JOIN control_desired_resources desired
             ON desired.desired_resource_id = s.d1_desired_resource_id
            AND desired.environment_id = s.environment_id
           JOIN control_observed_resources observed
             ON observed.observed_resource_id = desired.observed_resource_id
            AND observed.environment_id = s.environment_id
          WHERE s.environment_id = ? AND s.data_role = ?
            AND s.residency_policy_id = ? AND s.residency_partition = ?
            AND s.allocation_scope = ?
            AND ((? = 'shared_pool' AND s.owner_tenant_id IS NULL) OR
                 (? = 'tenant_exclusive' AND s.owner_tenant_id = ?))
            AND s.status = 'active' AND capacity.health_status = 'healthy'
            AND capacity.allocation_status = 'eligible'
            AND capacity.allocated_account_count < capacity.target_account_count
            AND desired.desired_state = 'present' AND desired.provisioning_state = 'ready'
            AND observed.observed_state = 'present'
            AND NOT EXISTS (
              SELECT 1 FROM control_tenant_shard_assignments assignment
               WHERE assignment.environment_id = s.environment_id
                 AND assignment.tenant_id = ? AND assignment.data_role = s.data_role
                 AND assignment.residency_partition = s.residency_partition
                 AND assignment.shard_id = s.shard_id
                 AND assignment.assignment_state IN ('pending', 'active')
            )
          ORDER BY (1.0 * capacity.allocated_account_count / capacity.target_account_count),
                   capacity.allocated_account_count, s.shard_id
          LIMIT 1`
      )
      .bind(
        input.environmentId,
        input.dataRole,
        input.residencyPolicyId,
        input.residencyPartition,
        input.allocationScope,
        input.allocationScope,
        input.allocationScope,
        input.ownerTenantId,
        input.tenantId
      )
      .first<{
        shard_id: string;
        data_role: TenantShardDataRole;
        residency_policy_id: string;
        residency_partition: string;
        generation: number | string;
        binding_ref: string;
        provider_resource_id: string;
        deterministic_name: string;
        allocation_scope: ControlTenantShardAllocationScope;
        owner_tenant_id: string | null;
      }>();
    if (!row) return null;
    const routeGeneration =
      typeof row.generation === 'number' ? row.generation : Number(row.generation);
    if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 1) {
      throw new Error('control_tenant_shard_capacity_invalid');
    }
    return {
      shardId: row.shard_id,
      dataRole: row.data_role,
      residencyPolicyId: row.residency_policy_id,
      residencyPartition: row.residency_partition,
      routeGeneration,
      bindingRef: row.binding_ref,
      databaseId: row.provider_resource_id,
      databaseName: row.deterministic_name,
      allocationScope: row.allocation_scope,
      ownerTenantId: row.owner_tenant_id,
    };
  }

  async assignTenantShard(
    input: {
      environmentId: string;
      tenantId: string;
      dataRole: TenantShardDataRole;
      residencyPolicyId: string;
      residencyPartition: string;
      shardId: string;
      sourceOperationId: string;
    },
    now: number
  ): Promise<ControlTenantShardCapacityTarget> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO control_tenant_shard_assignments (
           environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
           shard_id, assignment_generation, assignment_state, source_operation_id,
           created_at, activated_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, shard.shard_id,
                COALESCE((
                  SELECT MAX(existing.assignment_generation) + 1
                    FROM control_tenant_shard_assignments existing
                   WHERE existing.environment_id = ? AND existing.tenant_id = ?
                     AND existing.data_role = ? AND existing.residency_partition = ?
                ), 1),
                'active', ?, ?, ?, ?
           FROM control_tenant_shards shard
           JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
          WHERE shard.environment_id = ? AND shard.shard_id = ?
            AND shard.data_role = ? AND shard.residency_policy_id = ?
            AND shard.residency_partition = ? AND shard.status = 'active'
            AND capacity.health_status = 'healthy' AND capacity.allocation_status = 'eligible'
            AND capacity.allocated_account_count < capacity.target_account_count
            AND NOT EXISTS (
              SELECT 1
                FROM control_tenant_shard_assignments assigned
                JOIN control_tenant_shards assigned_shard
                  ON assigned_shard.shard_id = assigned.shard_id
                 AND assigned_shard.environment_id = assigned.environment_id
                JOIN control_shard_capacity assigned_capacity
                  ON assigned_capacity.shard_id = assigned.shard_id
               WHERE assigned.environment_id = ? AND assigned.tenant_id = ?
                 AND assigned.data_role = ? AND assigned.residency_partition = ?
                 AND assigned.assignment_state = 'active'
                 AND assigned_shard.status = 'active'
                 AND assigned_capacity.health_status = 'healthy'
                 AND assigned_capacity.allocation_status = 'eligible'
                 AND assigned_capacity.allocated_account_count
                       < assigned_capacity.target_account_count
            )`
      )
      .bind(
        input.environmentId,
        input.tenantId,
        input.dataRole,
        input.residencyPolicyId,
        input.residencyPartition,
        input.environmentId,
        input.tenantId,
        input.dataRole,
        input.residencyPartition,
        input.sourceOperationId,
        now,
        now,
        now,
        input.environmentId,
        input.shardId,
        input.dataRole,
        input.residencyPolicyId,
        input.residencyPartition,
        input.environmentId,
        input.tenantId,
        input.dataRole,
        input.residencyPartition
      )
      .run();
    const policy = await this.getTenantPlacementPolicy(input.environmentId, input.tenantId);
    if (!policy) throw new Error('control_tenant_placement_policy_missing');
    const reflected = await this.findEligibleTenantShard({
      environmentId: input.environmentId,
      tenantId: input.tenantId,
      dataRole: input.dataRole,
      residencyPolicyId: input.residencyPolicyId,
      residencyPartition: input.residencyPartition,
      allocationScope: policy.isolationPolicy,
      ownerTenantId: policy.isolationPolicy === 'tenant_exclusive' ? input.tenantId : null,
    });
    if (!reflected) throw new Error('control_tenant_shard_assignment_failed');
    return reflected;
  }

  async hasTenantShardAssignment(input: {
    environmentId: string;
    tenantId: string;
    dataRole: TenantShardDataRole;
    residencyPartition: string;
  }): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT shard_id FROM control_tenant_shard_assignments
          WHERE environment_id = ? AND tenant_id = ? AND data_role = ?
            AND residency_partition = ? AND assignment_state IN ('pending', 'active')
          LIMIT 1`
      )
      .bind(input.environmentId, input.tenantId, input.dataRole, input.residencyPartition)
      .first<{ shard_id: string }>();
    return row !== null;
  }

  async findCapacityProvisioningOperation(input: {
    environmentId: string;
    tenantId: string;
    dataRole: TenantShardDataRole;
    residencyPolicyId: string;
    residencyPartition: string;
    allocationScope: ControlTenantShardAllocationScope;
    ownerTenantId: string | null;
  }): Promise<ControlOperationView | null> {
    const row = await this.db
      .prepare(
        `SELECT operation.operation_id, operation.environment_id, operation.operation_kind,
                operation.status, operation.attempt_count, operation.next_attempt_at,
                operation.last_error_code, operation.created_at, operation.updated_at,
                operation.fencing_token
           FROM control_tenant_shards shard
           JOIN control_desired_resources desired
             ON desired.desired_resource_id = shard.d1_desired_resource_id
            AND desired.environment_id = shard.environment_id
           JOIN control_operations operation
             ON operation.operation_id = desired.origin_operation_id
            AND operation.environment_id = shard.environment_id
          WHERE shard.environment_id = ? AND shard.data_role = ?
            AND shard.residency_policy_id = ? AND shard.residency_partition = ?
            AND shard.allocation_scope = ?
            AND ((? = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
                 (? = 'tenant_exclusive' AND shard.owner_tenant_id = ?))
            AND shard.status IN ('requested', 'provisioning', 'ready')
            AND operation.status IN ('queued', 'running', 'waiting_retry')
          ORDER BY operation.created_at, operation.operation_id
          LIMIT 1`
      )
      .bind(
        input.environmentId,
        input.dataRole,
        input.residencyPolicyId,
        input.residencyPartition,
        input.allocationScope,
        input.allocationScope,
        input.allocationScope,
        input.ownerTenantId
      )
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
                next_attempt_at, last_error_code, retry_budget_started_at, created_at, updated_at,
                fencing_token
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
        `WITH shard_inventory AS (
           SELECT s.d1_desired_resource_id, s.shard_id, s.data_role,
                  s.residency_policy_id, s.residency_partition, s.binding_ref,
                  s.jurisdiction, s.location_hint, s.read_replication_mode,
                  s.allocation_scope, s.owner_tenant_id
             FROM control_tenant_shards s
           UNION ALL
           SELECT l.d1_desired_resource_id, l.lookup_shard_id, 'lookup',
                  json_extract(d.desired_spec_json, '$.residency_policy_id'),
                  l.residency_partition, l.binding_ref,
                  json_extract(d.desired_spec_json, '$.jurisdiction'),
                  json_extract(d.desired_spec_json, '$.location_hint'),
                  COALESCE(json_extract(d.desired_spec_json, '$.read_replication_mode'), 'disabled'),
                  'shared_pool', NULL
             FROM control_lookup_physical_shards l
             JOIN control_desired_resources d
               ON d.desired_resource_id = l.d1_desired_resource_id
              AND d.environment_id = l.environment_id
         )
         SELECT o.operation_id, o.environment_id, o.idempotency_key,
                d.desired_resource_id, d.logical_shard_id, d.deterministic_name,
                d.ownership_fingerprint, s.shard_id, s.data_role, s.residency_policy_id,
                s.residency_partition, s.binding_ref, s.jurisdiction, s.location_hint,
                s.read_replication_mode, s.allocation_scope, s.owner_tenant_id,
                e.environment_name
           FROM control_operations o
           JOIN control_desired_resources d ON d.origin_operation_id = o.operation_id
           JOIN shard_inventory s ON s.d1_desired_resource_id = d.desired_resource_id
           JOIN control_environments e ON e.environment_id = o.environment_id
          WHERE o.operation_kind = 'provision_shard'
            AND o.status IN ('queued', 'running', 'waiting_retry')
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= unixepoch())
            AND d.observed_resource_id IS NULL
          ORDER BY o.created_at
          LIMIT ?`
      )
      .bind(limit)
      .all<PendingPlanRow>();
    return result.results.map(planFromPendingRow);
  }

  async listPendingMigrationPlans(limit: number): Promise<PendingMigrationPlan[]> {
    if (!Number.isFinite(limit)) throw new Error('invalid_pending_migration_limit');
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const result = await this.db
      .prepare(
        `WITH shard_inventory AS (
           SELECT s.d1_desired_resource_id, s.shard_id, s.binding_ref, s.data_role,
                  s.residency_partition, s.generation
             FROM control_tenant_shards s
           UNION ALL
           SELECT l.d1_desired_resource_id, l.lookup_shard_id, l.binding_ref, 'lookup',
                  l.residency_partition, 1
             FROM control_lookup_physical_shards l
         )
         SELECT o.operation_id, m.desired_resource_id, s.shard_id, m.environment_id,
                m.provider_database_id, m.stream_id, m.release_id, m.manifest_digest,
                c.manifest_r2_object_key, s.binding_ref, s.data_role,
                s.residency_partition, s.generation
           FROM control_operations o
           JOIN control_tenant_database_migration_state m ON m.operation_id = o.operation_id
           JOIN shard_inventory s ON s.d1_desired_resource_id = m.desired_resource_id
           JOIN control_migration_release_catalog c
             ON c.environment_id = m.environment_id
            AND c.stream_id = m.stream_id
            AND c.release_id = m.release_id
            AND c.manifest_digest = m.manifest_digest
          WHERE o.operation_kind = 'provision_shard'
            AND o.status IN ('running', 'waiting_retry')
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= unixepoch())
            AND m.state IN ('requested', 'applying', 'waiting_retry')
            AND m.provider_database_id IS NOT NULL
          ORDER BY o.created_at
          LIMIT ?`
      )
      .bind(safeLimit)
      .all<PendingMigrationRow>();
    return result.results.map((row) => ({
      operationId: row.operation_id,
      desiredResourceId: row.desired_resource_id,
      shardId: row.shard_id,
      environmentId: row.environment_id,
      databaseId: row.provider_database_id,
      streamId: row.stream_id,
      releaseId: row.release_id,
      manifestDigest: row.manifest_digest,
      manifestObjectKey: row.manifest_r2_object_key,
      bindingRef: row.binding_ref,
      dataRole: row.data_role,
      residencyPartition: row.residency_partition,
      migrationGeneration: row.generation,
    }));
  }

  async listLowWatermarkRequests(
    limit: number,
    environmentId?: string
  ): Promise<LowWatermarkRequest[]> {
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
            WHERE s.allocation_scope = 'shared_pool' AND s.owner_tenant_id IS NULL
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
            AND (? IS NULL OR p.environment_id = ?)
            AND COALESCE(s.has_healthy_capacity, 0) = 0
            AND COALESCE(s.supply_count, 0) < policy.max_ready_spares
          ORDER BY p.environment_id, p.residency_partition, roles.data_role
          LIMIT ?`
      )
      .bind(environmentId ?? null, environmentId ?? null, limit)
      .all<LowWatermarkRow>();
    return result.results.map((row) => ({
      environmentId: row.environment_id,
      dataRole: row.data_role,
      residencyPolicyId: row.residency_policy_id,
      residencyPartition: row.residency_partition,
      supplyCount: row.supply_count,
    }));
  }

  async getCapacityPlannerInput(
    environmentId: string,
    scope: ControlCapacityPlannerInput['scope'],
    tenantId: string | null
  ): Promise<Omit<ControlCapacityPlannerInput, 'profile'>> {
    if (scope === 'tenant_exclusive') {
      if (!tenantId) throw new Error('control_capacity_scope_owner_invalid');
      const placement = await this.getTenantPlacementPolicy(environmentId, tenantId);
      if (
        !placement ||
        placement.state !== 'active' ||
        placement.isolationPolicy !== 'tenant_exclusive'
      ) {
        throw new Error('control_capacity_tenant_policy_mismatch');
      }
    } else if (tenantId !== null) {
      throw new Error('control_capacity_scope_owner_invalid');
    }
    const policy = await this.getResourcePolicy(environmentId);
    if (!policy) throw new Error('control_capacity_resource_policy_missing');
    const count = await this.db
      .prepare(
        `SELECT COUNT(*) AS d1_count FROM control_desired_resources
          WHERE environment_id = ? AND resource_kind = 'd1' AND desired_state = 'present'`
      )
      .bind(environmentId)
      .first<{ d1_count: number }>();
    const workerRows = await this.db
      .prepare(
        `SELECT role.data_role, inventory.worker_script_name
           FROM control_worker_required_data_roles role
           JOIN control_desired_worker_inventory inventory
             ON inventory.environment_id = role.environment_id
            AND inventory.worker_script_name = role.worker_script_name
            AND inventory.status = 'active'
          WHERE role.environment_id = ?
          ORDER BY role.data_role, inventory.worker_script_name`
      )
      .bind(environmentId)
      .all<{ data_role: ProvisionedD1DataRole; worker_script_name: string }>();
    const workers = new Map<ProvisionedD1DataRole, string[]>();
    for (const row of workerRows.results) {
      const scripts = workers.get(row.data_role) ?? [];
      scripts.push(row.worker_script_name);
      workers.set(row.data_role, scripts);
    }
    const targetRows = await this.db
      .prepare(
        `WITH roles(data_role, priority) AS (
           SELECT 'tenant_core/default', 30 UNION ALL
           SELECT 'tenant_core/users', 20 UNION ALL
           SELECT 'tenant_pii', 10
         )
         SELECT partition.residency_policy_id, partition.residency_partition,
                roles.data_role, roles.priority,
                SUM(CASE WHEN shard.status = 'active' THEN 1 ELSE 0 END) AS ready_units,
                SUM(CASE WHEN shard.status IN ('requested', 'provisioning', 'ready')
                         THEN 1 ELSE 0 END) AS in_flight_units,
                MAX(CASE WHEN shard.status = 'active'
                           AND capacity.health_status = 'healthy'
                           AND capacity.allocation_status = 'eligible'
                           AND capacity.allocated_account_count < capacity.target_account_count
                         THEN 1 ELSE 0 END) AS has_eligible_capacity
           FROM control_residency_partitions partition
           CROSS JOIN roles
           LEFT JOIN control_tenant_shards shard
             ON shard.environment_id = partition.environment_id
            AND shard.residency_policy_id = partition.residency_policy_id
            AND shard.residency_partition = partition.residency_partition
            AND shard.data_role = roles.data_role
            AND shard.allocation_scope = ?
            AND ((? = 'shared_pool' AND shard.owner_tenant_id IS NULL) OR
                 (? = 'tenant_exclusive' AND shard.owner_tenant_id = ?))
           LEFT JOIN control_shard_capacity capacity ON capacity.shard_id = shard.shard_id
          WHERE partition.environment_id = ? AND partition.status = 'active'
          GROUP BY partition.residency_policy_id, partition.residency_partition,
                   roles.data_role, roles.priority
          ORDER BY partition.residency_partition, roles.priority DESC`
      )
      .bind(scope, scope, scope, tenantId, environmentId)
      .all<{
        residency_policy_id: string;
        residency_partition: string;
        data_role: TenantShardDataRole;
        priority: number;
        ready_units: number;
        in_flight_units: number;
        has_eligible_capacity: number;
      }>();
    const currentEnvironmentD1Count = count?.d1_count ?? 0;
    const remainingEnvironmentD1 = Math.max(0, policy.max_d1_resources - currentEnvironmentD1Count);
    const targets: ControlCapacityTargetInput[] = targetRows.results.map((row) => {
      const existing = row.ready_units + row.in_flight_units;
      const minimumRequiredUnits =
        row.has_eligible_capacity === 1 || row.in_flight_units > 0 ? 1 : existing + 1;
      const workerScripts = workers.get(row.data_role) ?? [];
      if (workerScripts.length === 0) {
        throw new Error('control_capacity_worker_inventory_missing');
      }
      return {
        unitKey: `${row.residency_policy_id}:${row.residency_partition}:${row.data_role}`,
        priority: row.priority,
        readyUnits: row.ready_units,
        inFlightUnits: row.in_flight_units,
        minimumRequiredUnits,
        recommendedTargetUnits: minimumRequiredUnits,
        hardMaximumUnits: Math.max(minimumRequiredUnits, existing + remainingEnvironmentD1),
        resources: [
          {
            resourceClass: 'd1' as const,
            dataRole: row.data_role,
            residencyPolicyId: row.residency_policy_id,
            residencyPartition: row.residency_partition,
            workerScripts,
            d1Count: 1,
          },
        ],
      };
    });
    if (scope === 'shared_pool') {
      const lookupRows = await this.db
        .prepare(
          `SELECT partition.residency_policy_id, partition.residency_partition,
                  SUM(CASE WHEN shard.status = 'active' THEN 1 ELSE 0 END) AS ready_units,
                  SUM(CASE WHEN shard.status IN ('requested', 'provisioning', 'ready')
                           THEN 1 ELSE 0 END) AS in_flight_units
             FROM control_residency_partitions partition
             LEFT JOIN control_lookup_physical_shards shard
               ON shard.environment_id = partition.environment_id
              AND shard.residency_partition = partition.residency_partition
            WHERE partition.environment_id = ? AND partition.status = 'active'
            GROUP BY partition.residency_policy_id, partition.residency_partition
            ORDER BY partition.residency_partition`
        )
        .bind(environmentId)
        .all<{
          residency_policy_id: string;
          residency_partition: string;
          ready_units: number;
          in_flight_units: number;
        }>();
      const lookupWorkers = workers.get('lookup') ?? [];
      if (lookupWorkers.length === 0) {
        throw new Error('control_capacity_worker_inventory_missing');
      }
      for (const row of lookupRows.results) {
        const existing = row.ready_units + row.in_flight_units;
        const minimumRequiredUnits = existing > 0 ? 1 : 1;
        targets.push({
          unitKey: `${row.residency_policy_id}:${row.residency_partition}:lookup`,
          priority: 40,
          readyUnits: row.ready_units,
          inFlightUnits: row.in_flight_units,
          minimumRequiredUnits,
          recommendedTargetUnits: minimumRequiredUnits,
          hardMaximumUnits: Math.max(minimumRequiredUnits, existing + remainingEnvironmentD1),
          resources: [
            {
              resourceClass: 'd1',
              dataRole: 'lookup',
              residencyPolicyId: row.residency_policy_id,
              residencyPartition: row.residency_partition,
              workerScripts: lookupWorkers,
              d1Count: 1,
            },
          ],
        });
      }
    }
    return {
      scope,
      tenantId,
      currentEnvironmentD1Count,
      environmentD1Limit: policy.max_d1_resources,
      targets,
    };
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
              status IN ('queued', 'waiting_retry') OR
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

    const row = await this.db
      .prepare(
        `SELECT operation_id, environment_id, operation_kind, status, attempt_count,
                next_attempt_at, last_error_code, retry_budget_started_at, created_at, updated_at,
                fencing_token
           FROM control_operations
          WHERE operation_id = ? AND lock_owner = ?`
      )
      .bind(operationId, ownerId)
      .first<OperationRow>();
    if (!row) return null;

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'create_d1' AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, now, operationId, operationId, ownerId, row.fencing_token),
      this.db
        .prepare(
          `UPDATE control_desired_resources
              SET provisioning_state = 'creating', create_started_at = COALESCE(create_started_at, ?), updated_at = ?
            WHERE origin_operation_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, now, operationId, operationId, ownerId, row.fencing_token),
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'provisioning', updated_at = ?
            WHERE d1_desired_resource_id IN (
              SELECT desired_resource_id FROM control_desired_resources WHERE origin_operation_id = ?
            ) AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, operationId, operationId, ownerId, row.fencing_token),
      this.db
        .prepare(
          `UPDATE control_lookup_physical_shards SET status = 'provisioning', updated_at = ?
            WHERE d1_desired_resource_id IN (
              SELECT desired_resource_id FROM control_desired_resources WHERE origin_operation_id = ?
            ) AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, operationId, operationId, ownerId, row.fencing_token),
    ]);
    return { operation: operationView(row), ownerId, fencingToken: row.fencing_token };
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
          `UPDATE control_tenant_database_migration_state
              SET provider_database_id = ?, state = 'requested', last_error_code = NULL,
                  updated_at = ?
            WHERE desired_resource_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(
          databaseId,
          now,
          plan.desiredResourceId,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_tenant_shards
              SET read_replication_mode = ?, observed_replication_state = ?,
                  replication_checked_at = ?, replication_error_code = NULL, updated_at = ?
            WHERE shard_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(
          plan.readReplicationMode,
          observedReplicationMode,
          now,
          now,
          plan.shardId,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_desired_resources
              SET observed_resource_id = ?, provisioning_state = 'creating', updated_at = ?
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
              SET status = 'succeeded', observed_resource_id = ?, next_attempt_at = NULL,
                  last_error_code = NULL, last_error_redacted = NULL,
                  completed_at = ?, updated_at = ?
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
              SET status = 'waiting_retry', next_attempt_at = NULL,
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
                WHERE operation_id = ? AND fencing_token = ? AND status = 'waiting_retry'
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

  async tryStartMigration(
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
              status = 'waiting_retry' OR
              (status = 'running' AND lock_expires_at IS NOT NULL AND lock_expires_at <= ?)
            )
            AND EXISTS (
              SELECT 1 FROM control_tenant_database_migration_state migration
               WHERE migration.operation_id = candidate.operation_id
                 AND migration.provider_database_id IS NOT NULL
                 AND migration.state IN ('requested', 'applying', 'waiting_retry')
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

    const row = await this.db
      .prepare(
        `SELECT operation_id, environment_id, operation_kind, status, attempt_count,
                next_attempt_at, last_error_code, retry_budget_started_at, created_at, updated_at,
                fencing_token
           FROM control_operations
          WHERE operation_id = ? AND lock_owner = ?`
      )
      .bind(operationId, ownerId)
      .first<OperationRow>();
    if (!row) return null;

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  next_attempt_at = NULL, last_error_code = NULL,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'apply_migrations' AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, now, operationId, operationId, ownerId, row.fencing_token),
      this.db
        .prepare(
          `UPDATE control_tenant_database_migration_state
              SET state = 'applying', last_error_code = NULL,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, now, operationId, operationId, ownerId, row.fencing_token),
    ]);
    return { operation: operationView(row), ownerId, fencingToken: row.fencing_token };
  }

  async markMigrationReady(
    lease: ProvisioningLease,
    plan: PendingMigrationPlan,
    result: {
      totalFiles: number;
      appliedFiles: number;
      skippedFiles: number;
      responseLossRecoveries: number;
      lastFilename: string;
    },
    now: number
  ): Promise<ControlOperationView> {
    const sentinel = JSON.stringify({
      stream_id: plan.streamId,
      release_id: plan.releaseId,
      manifest_digest: plan.manifestDigest,
      applied_file_count: result.totalFiles,
      last_filename: result.lastFilename,
      state: 'ready',
    });
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_tenant_database_migration_state
              SET state = 'ready', expected_file_count = ?, applied_file_count = ?,
                  last_filename = ?, observed_sentinel_json = ?, last_error_code = NULL,
                  completed_at = ?, updated_at = ?
            WHERE desired_resource_id = ? AND operation_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(
          result.totalFiles,
          result.totalFiles,
          result.lastFilename,
          sentinel,
          now,
          now,
          plan.desiredResourceId,
          plan.operationId,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', progress_current = ?, progress_total = ?,
                  last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = 'apply_migrations' AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(
          result.totalFiles,
          result.totalFiles,
          now,
          now,
          plan.operationId,
          plan.operationId,
          lease.ownerId,
          lease.fencingToken
        ),
      this.db
        .prepare(
          `UPDATE control_desired_resources
              SET provisioning_state = 'ready', updated_at = ?
            WHERE desired_resource_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, plan.desiredResourceId, plan.operationId, lease.ownerId, lease.fencingToken),
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'ready', updated_at = ?
            WHERE shard_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, plan.shardId, plan.operationId, lease.ownerId, lease.fencingToken),
      this.db
        .prepare(
          `UPDATE control_lookup_physical_shards SET status = 'ready', updated_at = ?
            WHERE lookup_shard_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?
            )`
        )
        .bind(now, plan.shardId, plan.operationId, lease.ownerId, lease.fencingToken),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting_retry', completed_at = NULL, next_attempt_at = ?,
                  last_error_code = NULL, lock_owner = NULL, lock_expires_at = NULL,
                  updated_at = ?
            WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?`
        )
        .bind(now, now, plan.operationId, lease.ownerId, lease.fencingToken),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) SELECT ?, ?, ?, 'control.d1.migrate', 'reconciler', 'd1', ?, 'succeeded', ?, ?
             WHERE EXISTS (
               SELECT 1 FROM control_operations
                WHERE operation_id = ? AND fencing_token = ? AND status = 'waiting_retry'
             )`
        )
        .bind(
          `audit:${plan.operationId}:${lease.fencingToken}:migration-ready`,
          plan.environmentId,
          plan.operationId,
          plan.desiredResourceId,
          JSON.stringify({
            stream_id: plan.streamId,
            release_id: plan.releaseId,
            total_files: result.totalFiles,
            applied_files: result.appliedFiles,
            skipped_files: result.skippedFiles,
            response_loss_recoveries: result.responseLossRecoveries,
          }),
          now,
          plan.operationId,
          lease.fencingToken
        ),
    ]);
    const operation = await this.getOperation(plan.operationId);
    if (operation?.status !== 'waiting_retry') throw new Error('control_migration_stale_lease');
    return operation;
  }

  async markMigrationRetry(
    lease: ProvisioningLease,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?,
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
          `UPDATE control_operation_steps
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?,
                  last_error_redacted = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = 'apply_migrations' AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND fencing_token = ? AND status = 'waiting_retry'
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
      this.db
        .prepare(
          `UPDATE control_tenant_database_migration_state
              SET state = 'waiting_retry', last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND fencing_token = ? AND status = 'waiting_retry'
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
           ) SELECT ?, operation.environment_id, operation.operation_id,
                    'control.d1.migrate', 'reconciler', 'd1', migration.desired_resource_id,
                    'failed', ?, ?
               FROM control_operations operation
               JOIN control_tenant_database_migration_state migration
                 ON migration.operation_id = operation.operation_id
              WHERE operation.operation_id = ? AND operation.fencing_token = ?
                AND operation.status = 'waiting_retry'`
        )
        .bind(
          `audit:${lease.operation.operationId}:${lease.fencingToken}:migration-retry`,
          JSON.stringify({ error_code: errorCode, retry_at: nextAttemptAt }),
          now,
          lease.operation.operationId,
          lease.fencingToken
        ),
    ]);
  }

  async markMigrationBlocked(
    lease: ProvisioningLease,
    errorCode: string,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?,
                  last_error_redacted = NULL, lock_owner = NULL, lock_expires_at = NULL,
                  updated_at = ?
            WHERE operation_id = ? AND lock_owner = ? AND fencing_token = ?`
        )
        .bind(errorCode, now, lease.operation.operationId, lease.ownerId, lease.fencingToken),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?,
                  last_error_redacted = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = 'apply_migrations' AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND fencing_token = ? AND status = 'blocked'
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
          `UPDATE control_tenant_database_migration_state
              SET state = 'blocked', last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND EXISTS (
              SELECT 1 FROM control_operations
               WHERE operation_id = ? AND fencing_token = ? AND status = 'blocked'
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
           ) SELECT ?, operation.environment_id, operation.operation_id,
                    'control.d1.migrate', 'reconciler', 'd1', migration.desired_resource_id,
                    'blocked', ?, ?
               FROM control_operations operation
               JOIN control_tenant_database_migration_state migration
                 ON migration.operation_id = operation.operation_id
              WHERE operation.operation_id = ? AND operation.fencing_token = ?
                AND operation.status = 'blocked'`
        )
        .bind(
          `audit:${lease.operation.operationId}:${lease.fencingToken}:migration-blocked`,
          JSON.stringify({ error_code: errorCode }),
          now,
          lease.operation.operationId,
          lease.fencingToken
        ),
      ...provisioningAuthorityBlockStatements(this.db, lease, errorCode, now),
    ]);
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
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?,
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
              WHERE operation_id = ? AND fencing_token = ? AND status = 'waiting_retry'`
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
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?,
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
            SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?, updated_at = ?
          WHERE operation_id = ? AND status IN ('queued', 'waiting_retry')`
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
      ...provisioningAuthorityBlockStatements(this.db, lease, errorCode, now),
    ]);
  }
}

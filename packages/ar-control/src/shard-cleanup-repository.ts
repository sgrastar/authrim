import type {
  ControlShardCleanupApprovalRequest,
  ControlShardCleanupRetryRequest,
  ControlShardCleanupView,
  ControlShardQuarantineRequest,
  ControlShardQuarantineRetryRequest,
} from '@authrim/ar-lib-core/control-plane';

const SNAPSHOT_TTL_SECONDS = 30 * 60;
const SAFE_LIMIT_MAX = 100;

interface CleanupViewRow {
  environment_id: string;
  shard_id: string;
  data_role: ControlShardCleanupView['dataRole'];
  residency_partition: string;
  binding_ref: string;
  provider_database_id: string;
  database_name: string;
  shard_status: ControlShardCleanupView['shardStatus'];
  quarantine_operation_id: string | null;
  quarantine_state: ControlShardCleanupView['quarantineState'];
  quarantine_operation_state: ControlShardCleanupView['quarantineOperationState'];
  deny_registry_generation: number | null;
  drain_not_before: number | null;
  registry_verified_at: number | null;
  references_verified_at: number | null;
  cleanup_operation_id: string | null;
  cleanup_state: ControlShardCleanupView['cleanupState'];
  export_mode: ControlShardCleanupView['exportMode'];
  delete_database: number | null;
  quarantine_error_code: string | null;
  cleanup_error_code: string | null;
  created_at: number;
  updated_at: number;
}

interface CleanupBindingRow {
  worker_script_name: string;
  binding_ref: string;
  state: ControlShardCleanupView['bindings'][number]['state'];
  last_error_code: string | null;
  updated_at: number;
}

interface ExistingOperationRow {
  operation_id: string;
  operation_kind: string;
  shard_id: string | null;
  requested_by_id: string;
  quarantine_operation_id: string | null;
  export_mode: 'skipped' | 'manual_verified' | null;
  export_evidence_id: string | null;
  delete_database: number | null;
}

export interface ShardQuarantineTarget {
  operationId: string;
  environmentId: string;
  shardId: string;
  bindingRef: string;
  databaseId: string;
  denyRegistryGeneration: number;
  drainNotBefore: number;
  retryBudgetStartedAt: number;
  tenants: Array<{
    tenantId: string;
    minimumRuntimeGeneration: number;
  }>;
}

export interface ShardCleanupTarget {
  operationId: string;
  environmentId: string;
  shardId: string;
  bindingRef: string;
  databaseId: string;
  databaseName: string;
  state: NonNullable<ControlShardCleanupView['cleanupState']>;
  deleteDatabase: boolean;
  retryBudgetStartedAt: number;
}

export interface ShardCleanupBindingTarget {
  operationId: string;
  environmentId: string;
  workerScriptName: string;
  bindingRef: string;
  databaseId: string;
  state: 'pending' | 'removing' | 'removed' | 'blocked';
  expectedSourceVersionId: string | null;
  previousDeploymentId: string | null;
  patchResultVersionId: string | null;
  patchResultDeploymentId: string | null;
  previousRestoreSettingsJson: string | null;
}

export interface ShardCleanupDeploymentLease {
  environmentId: string;
  workerScriptName: string;
  operationId: string;
  fencingToken: number;
  expectedSourceVersionId: string;
  mutationStarted: boolean;
}

function safeLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new Error('control_shard_cleanup_limit_invalid');
  return Math.max(1, Math.min(Math.floor(limit), SAFE_LIMIT_MAX));
}

function availableActions(
  row: CleanupViewRow,
  destructiveOperationsEnabled: boolean
): ControlShardCleanupView['availableActions'] {
  const actions: ControlShardCleanupView['availableActions'] = [];
  if (
    (row.shard_status === 'retired' || row.shard_status === 'failed') &&
    row.quarantine_state === 'none' &&
    row.quarantine_operation_id === null
  ) {
    actions.push('quarantine');
  }
  if (row.quarantine_operation_state === 'blocked') {
    actions.push('retry_quarantine');
  }
  if (row.quarantine_operation_state === 'ready_for_cleanup' && row.cleanup_operation_id === null) {
    actions.push('approve_cleanup');
  }
  if (row.cleanup_state === 'blocked' && destructiveOperationsEnabled) {
    actions.push('retry_cleanup');
  }
  return actions;
}

export class D1ShardCleanupRepository {
  constructor(private readonly db: D1Database) {}

  private async bindings(operationId: string | null): Promise<ControlShardCleanupView['bindings']> {
    if (!operationId) return [];
    const result = await this.db
      .prepare(
        `SELECT worker_script_name, binding_ref, state, last_error_code, updated_at
           FROM control_shard_cleanup_bindings
          WHERE operation_id = ?
          ORDER BY worker_script_name, binding_ref`
      )
      .bind(operationId)
      .all<CleanupBindingRow>();
    return result.results.map((row) => ({
      workerScriptName: row.worker_script_name,
      bindingRef: row.binding_ref,
      state: row.state,
      lastErrorCode: row.last_error_code,
      updatedAt: row.updated_at,
    }));
  }

  private async rows(environmentId: string, shardId?: string): Promise<CleanupViewRow[]> {
    const result = await this.db
      .prepare(
        `SELECT shard.environment_id, shard.shard_id, shard.data_role, shard.residency_partition,
                shard.binding_ref, observed.provider_resource_id AS provider_database_id,
                desired.deterministic_name AS database_name, shard.status AS shard_status,
                shard.quarantine_operation_id, shard.quarantine_state,
                quarantine.state AS quarantine_operation_state,
                quarantine.deny_registry_generation, quarantine.drain_not_before,
                quarantine.registry_verified_at, quarantine.references_verified_at,
                cleanup.operation_id AS cleanup_operation_id, cleanup.state AS cleanup_state,
                cleanup.export_mode, cleanup.delete_database,
                quarantine.last_error_code AS quarantine_error_code,
                cleanup.last_error_code AS cleanup_error_code,
                shard.created_at,
                MAX(shard.updated_at, COALESCE(quarantine.updated_at, 0),
                    COALESCE(cleanup.updated_at, 0)) AS updated_at
           FROM control_tenant_shards shard
           JOIN control_desired_resources desired
             ON desired.desired_resource_id = shard.d1_desired_resource_id
            AND desired.environment_id = shard.environment_id
           JOIN control_observed_resources observed
             ON observed.desired_resource_id = desired.desired_resource_id
            AND observed.environment_id = desired.environment_id
            AND observed.resource_kind = 'd1'
           LEFT JOIN control_shard_quarantine_operations quarantine
             ON quarantine.operation_id = shard.quarantine_operation_id
            AND quarantine.environment_id = shard.environment_id
           LEFT JOIN control_shard_cleanup_operations cleanup
             ON cleanup.quarantine_operation_id = quarantine.operation_id
            AND cleanup.environment_id = quarantine.environment_id
          WHERE shard.environment_id = ?
            AND shard.status IN ('failed', 'retired', 'deleting', 'deleted')
            AND (? IS NULL OR shard.shard_id = ?)
          ORDER BY shard.updated_at DESC, shard.shard_id
          LIMIT 100`
      )
      .bind(environmentId, shardId ?? null, shardId ?? null)
      .all<CleanupViewRow>();
    return result.results;
  }

  async list(
    environmentId: string,
    destructiveOperationsEnabled: boolean
  ): Promise<ControlShardCleanupView[]> {
    const rows = await this.rows(environmentId);
    return Promise.all(rows.map((row) => this.view(row, destructiveOperationsEnabled)));
  }

  async get(
    environmentId: string,
    shardId: string,
    destructiveOperationsEnabled: boolean
  ): Promise<ControlShardCleanupView | null> {
    const row = (await this.rows(environmentId, shardId))[0];
    return row ? this.view(row, destructiveOperationsEnabled) : null;
  }

  private async view(
    row: CleanupViewRow,
    destructiveOperationsEnabled: boolean
  ): Promise<ControlShardCleanupView> {
    const bindings = await this.bindings(row.cleanup_operation_id);
    return {
      environmentId: row.environment_id,
      shardId: row.shard_id,
      dataRole: row.data_role,
      residencyPartition: row.residency_partition,
      bindingRef: row.binding_ref,
      databaseId: row.provider_database_id,
      databaseName: row.database_name,
      shardStatus: row.shard_status,
      quarantineOperationId: row.quarantine_operation_id,
      quarantineState: row.quarantine_state,
      quarantineOperationState: row.quarantine_operation_state,
      denyRegistryGeneration: row.deny_registry_generation,
      drainNotBefore: row.drain_not_before,
      registryVerifiedAt: row.registry_verified_at,
      referencesVerifiedAt: row.references_verified_at,
      cleanupOperationId: row.cleanup_operation_id,
      cleanupState: row.cleanup_state,
      exportMode: row.export_mode,
      deleteDatabase: row.delete_database === null ? null : row.delete_database === 1,
      destructiveOperationsEnabled,
      availableActions: availableActions(row, destructiveOperationsEnabled),
      bindings,
      lastErrorCode: row.cleanup_error_code ?? row.quarantine_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findExistingOperation(
    environmentId: string,
    idempotencyKey: string
  ): Promise<ExistingOperationRow | null> {
    return this.db
      .prepare(
        `SELECT operation.operation_id, operation.operation_kind,
                COALESCE(quarantine.shard_id, cleanup.shard_id) AS shard_id,
                operation.requested_by_id, cleanup.quarantine_operation_id,
                cleanup.export_mode, cleanup.export_evidence_id, cleanup.delete_database
           FROM control_operations operation
           LEFT JOIN control_shard_quarantine_operations quarantine
             ON quarantine.operation_id = operation.operation_id
           LEFT JOIN control_shard_cleanup_operations cleanup
             ON cleanup.operation_id = operation.operation_id
          WHERE operation.environment_id = ? AND operation.idempotency_key = ?`
      )
      .bind(environmentId, idempotencyKey)
      .first<ExistingOperationRow>();
  }

  async startQuarantine(input: {
    environmentId: string;
    operationId: string;
    request: ControlShardQuarantineRequest;
    now: number;
  }): Promise<void> {
    const routeState = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT assignment.tenant_id) AS tenant_count,
                COUNT(DISTINCT route.tenant_id) AS route_count,
                COALESCE(MAX(route.registry_publication_generation), 0) AS deny_generation
           FROM control_tenant_shard_assignments assignment
           LEFT JOIN control_runtime_registry_routes route
             ON route.environment_id = assignment.environment_id
            AND route.tenant_id = assignment.tenant_id
          WHERE assignment.environment_id = ? AND assignment.shard_id = ?
            AND assignment.assignment_state IN ('retired', 'quarantined')`
      )
      .bind(input.environmentId, input.request.shardId)
      .first<{ tenant_count: number; route_count: number; deny_generation: number }>();
    if (!routeState || routeState.tenant_count !== routeState.route_count) {
      throw new Error('control_shard_quarantine_registry_route_missing');
    }
    const drainNotBefore = input.now + SNAPSHOT_TTL_SECONDS;
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, attempt_count, next_attempt_at,
             retry_budget_started_at, created_at, updated_at
           )
           SELECT ?, ?, 'quarantine_shard', ?, 'running', 'admin', ?, 1, ?, ?, ?, ?
             FROM control_tenant_shards shard
            WHERE shard.environment_id = ? AND shard.shard_id = ?
              AND shard.status IN ('failed', 'retired')
              AND shard.quarantine_state = 'none' AND shard.quarantine_operation_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM control_tenant_shard_assignments assignment
                 WHERE assignment.environment_id = shard.environment_id
                   AND assignment.shard_id = shard.shard_id
                   AND assignment.assignment_state IN ('pending', 'active')
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_tenant_shard_allocations allocation
                 WHERE allocation.environment_id = shard.environment_id
                   AND allocation.selected_shard_id = shard.shard_id
                   AND allocation.reservation_state IN ('reserved', 'committed')
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_tenant_default_allocations allocation
                 WHERE allocation.environment_id = shard.environment_id
                   AND allocation.selected_shard_id = shard.shard_id
                   AND allocation.reservation_state IN ('reserved', 'committed')
              )
              AND NOT EXISTS (
                SELECT 1 FROM control_runtime_registry_routes route
                 WHERE route.environment_id = shard.environment_id
                   AND (
                     json_extract(route.route_projection_json, '$.target.shardId') = shard.shard_id OR
                     EXISTS (
                       SELECT 1 FROM json_each(route.route_projection_json, '$.targets') entry
                        WHERE json_extract(entry.value, '$.shardId') = shard.shard_id
                     )
                   )
              )`
        )
        .bind(
          input.operationId,
          input.environmentId,
          input.request.idempotencyKey,
          input.request.requestedById,
          input.now,
          input.now,
          input.now,
          input.now,
          input.environmentId,
          input.request.shardId
        ),
      this.db
        .prepare(
          `INSERT INTO control_shard_quarantine_operations (
             operation_id, environment_id, shard_id, state, deny_registry_generation,
             drain_not_before, requested_by_id, created_at, updated_at
           )
           SELECT operation_id, environment_id, ?, 'draining', ?, ?, ?, ?, ?
             FROM control_operations WHERE operation_id = ? AND environment_id = ?`
        )
        .bind(
          input.request.shardId,
          routeState.deny_generation,
          drainNotBefore,
          input.request.requestedById,
          input.now,
          input.now,
          input.operationId,
          input.environmentId
        ),
      this.db
        .prepare(
          `UPDATE control_tenant_shards
              SET quarantine_state = 'quarantining', quarantine_operation_id = ?,
                  quarantine_started_at = ?, updated_at = ?
            WHERE environment_id = ? AND shard_id = ? AND status IN ('failed', 'retired')
              AND quarantine_state = 'none' AND quarantine_operation_id IS NULL
              AND EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = ? AND operation.environment_id = ?
              )`
        )
        .bind(
          input.operationId,
          input.now,
          input.now,
          input.environmentId,
          input.request.shardId,
          input.operationId,
          input.environmentId
        ),
      this.db
        .prepare(
          `UPDATE control_shard_capacity SET allocation_status = 'blocked', updated_at = ?
            WHERE shard_id = ? AND allocation_status IN ('draining', 'blocked')
              AND EXISTS (
                SELECT 1 FROM control_tenant_shards shard
                 WHERE shard.shard_id = control_shard_capacity.shard_id
                   AND shard.quarantine_operation_id = ?
              )`
        )
        .bind(input.now, input.request.shardId, input.operationId),
      ...[
        ['disable_allocation', 10, 'succeeded', input.now],
        ['verify_registry_snapshot', 20, 'waiting_retry', null],
        ['wait_snapshot_drain', 30, 'waiting_retry', null],
        ['verify_zero_references', 40, 'queued', null],
        ['ready_for_cleanup', 50, 'queued', null],
      ].map(([stepKey, displayOrder, status, completedAt]) =>
        this.db
          .prepare(
            `INSERT INTO control_operation_steps (
               operation_id, step_key, display_order, status, attempt_count,
               next_attempt_at, started_at, completed_at, updated_at
             )
             SELECT operation_id, ?, ?, ?, ?, ?, ?, ?, ?
               FROM control_operations WHERE operation_id = ?`
          )
          .bind(
            stepKey,
            displayOrder,
            status,
            status === 'succeeded' ? 1 : 0,
            status === 'waiting_retry' ? input.now : null,
            status === 'succeeded' ? input.now : null,
            completedAt,
            input.now,
            input.operationId
          )
      ),
      this.db
        .prepare(
          `INSERT INTO control_shard_quarantine_tenants (
             operation_id, environment_id, tenant_id, minimum_runtime_generation
           )
           SELECT ?, assignment.environment_id, assignment.tenant_id,
                  route.registry_publication_generation
             FROM control_tenant_shard_assignments assignment
             JOIN control_runtime_registry_routes route
               ON route.environment_id = assignment.environment_id
              AND route.tenant_id = assignment.tenant_id
            WHERE assignment.environment_id = ? AND assignment.shard_id = ?
              AND assignment.assignment_state IN ('retired', 'quarantined')
              AND EXISTS (
                SELECT 1 FROM control_operations operation
                 WHERE operation.operation_id = ? AND operation.environment_id = ?
              )
            GROUP BY assignment.environment_id, assignment.tenant_id,
                     route.registry_publication_generation`
        )
        .bind(
          input.operationId,
          input.environmentId,
          input.request.shardId,
          input.operationId,
          input.environmentId
        ),
      this.db
        .prepare(
          `INSERT INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, environment_id, operation_id, 'control.shard.quarantine.requested',
                  'admin', ?, 'd1', ?, 'succeeded', ?, ?
             FROM control_operations WHERE operation_id = ? AND environment_id = ?`
        )
        .bind(
          `audit:${input.operationId}:quarantine-requested`,
          input.request.requestedById,
          input.request.shardId,
          JSON.stringify({
            reason_code: input.request.reasonCode,
            drain_not_before: drainNotBefore,
            deny_registry_generation: routeState.deny_generation,
          }),
          input.now,
          input.operationId,
          input.environmentId
        ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    ) {
      throw new Error('control_shard_quarantine_conflict');
    }
  }

  async listDueQuarantines(limit: number, now: number): Promise<ShardQuarantineTarget[]> {
    const rows = await this.db
      .prepare(
        `SELECT quarantine.operation_id, quarantine.environment_id, quarantine.shard_id,
                shard.binding_ref, observed.provider_resource_id,
                quarantine.deny_registry_generation, quarantine.drain_not_before,
                COALESCE(operation.retry_budget_started_at, operation.created_at) AS retry_budget_started_at
           FROM control_shard_quarantine_operations quarantine
           JOIN control_operations operation ON operation.operation_id = quarantine.operation_id
           JOIN control_tenant_shards shard
             ON shard.shard_id = quarantine.shard_id
            AND shard.environment_id = quarantine.environment_id
           JOIN control_observed_resources observed
             ON observed.desired_resource_id = shard.d1_desired_resource_id
            AND observed.environment_id = shard.environment_id
            AND observed.resource_kind = 'd1'
          WHERE quarantine.state = 'draining'
            AND operation.status IN ('running', 'waiting_retry')
            AND (operation.next_attempt_at IS NULL OR operation.next_attempt_at <= ?)
          ORDER BY operation.updated_at, operation.operation_id
          LIMIT ?`
      )
      .bind(now, safeLimit(limit))
      .all<{
        operation_id: string;
        environment_id: string;
        shard_id: string;
        binding_ref: string;
        provider_resource_id: string;
        deny_registry_generation: number;
        drain_not_before: number;
        retry_budget_started_at: number;
      }>();
    const targets: ShardQuarantineTarget[] = [];
    for (const row of rows.results) {
      const tenants = await this.db
        .prepare(
          `SELECT tenant_id, minimum_runtime_generation
             FROM control_shard_quarantine_tenants
            WHERE operation_id = ? ORDER BY tenant_id`
        )
        .bind(row.operation_id)
        .all<{ tenant_id: string; minimum_runtime_generation: number }>();
      targets.push({
        operationId: row.operation_id,
        environmentId: row.environment_id,
        shardId: row.shard_id,
        bindingRef: row.binding_ref,
        databaseId: row.provider_resource_id,
        denyRegistryGeneration: row.deny_registry_generation,
        drainNotBefore: row.drain_not_before,
        retryBudgetStartedAt: row.retry_budget_started_at,
        tenants: tenants.results.map((tenant) => ({
          tenantId: tenant.tenant_id,
          minimumRuntimeGeneration: tenant.minimum_runtime_generation,
        })),
      });
    }
    return targets;
  }

  async countActiveReferences(target: { environmentId: string; shardId: string }): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM control_tenant_shard_assignments assignment
             WHERE assignment.environment_id = ? AND assignment.shard_id = ?
               AND assignment.assignment_state IN ('pending', 'active')) +
           (SELECT COUNT(*) FROM control_tenant_shard_allocations allocation
             WHERE allocation.environment_id = ? AND allocation.selected_shard_id = ?
               AND allocation.reservation_state IN ('reserved', 'committed')) +
           (SELECT COUNT(*) FROM control_tenant_default_allocations allocation
             WHERE allocation.environment_id = ? AND allocation.selected_shard_id = ?
               AND allocation.reservation_state IN ('reserved', 'committed')) +
           (SELECT COUNT(*) FROM control_runtime_registry_routes route
             WHERE route.environment_id = ? AND (
               json_extract(route.route_projection_json, '$.target.shardId') = ? OR
               EXISTS (
                 SELECT 1 FROM json_each(route.route_projection_json, '$.targets') entry
                  WHERE json_extract(entry.value, '$.shardId') = ?
               )
             )) AS count`
      )
      .bind(
        target.environmentId,
        target.shardId,
        target.environmentId,
        target.shardId,
        target.environmentId,
        target.shardId,
        target.environmentId,
        target.shardId,
        target.shardId
      )
      .first<{ count: number }>();
    if (!row || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error('control_shard_cleanup_reference_count_invalid');
    }
    return row.count;
  }

  async recordQuarantineTenantEvidence(input: {
    operationId: string;
    tenantId: string;
    runtimeGeneration: number;
    quarantineDenyGeneration: number;
    publishedAt: number;
    expiresAt: number;
    now: number;
  }): Promise<void> {
    const changed = await this.db
      .prepare(
        `UPDATE control_shard_quarantine_tenants
            SET observed_runtime_generation = ?, observed_quarantine_deny_generation = ?,
                snapshot_published_at = ?, snapshot_expires_at = ?, verified_at = ?,
                last_error_code = NULL
          WHERE operation_id = ? AND tenant_id = ?
            AND minimum_runtime_generation <= ?`
      )
      .bind(
        input.runtimeGeneration,
        input.quarantineDenyGeneration,
        input.publishedAt,
        input.expiresAt,
        input.now,
        input.operationId,
        input.tenantId,
        input.runtimeGeneration
      )
      .run();
    if ((changed.meta.changes ?? 0) !== 1) {
      throw new Error('control_shard_quarantine_registry_generation_stale');
    }
  }

  async recordQuarantineWaiting(input: {
    operationId: string;
    registryVerified: boolean;
    referencesVerified: boolean;
    nextAttemptAt: number;
    now: number;
  }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_quarantine_operations
              SET registry_verified_at = CASE WHEN ? THEN COALESCE(registry_verified_at, ?)
                                              ELSE registry_verified_at END,
                  references_verified_at = CASE WHEN ? THEN COALESCE(references_verified_at, ?)
                                                ELSE references_verified_at END,
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND state = 'draining'`
        )
        .bind(
          input.registryVerified ? 1 : 0,
          input.now,
          input.referencesVerified ? 1 : 0,
          input.now,
          input.now,
          input.operationId
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = NULL,
                  lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND status IN ('running', 'waiting_retry')`
        )
        .bind(input.nextAttemptAt, input.now, input.operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ?
              AND step_key IN ('verify_registry_snapshot', 'verify_zero_references')
              AND status IN ('queued', 'waiting_retry')`
        )
        .bind(input.now, input.now, input.operationId),
      ...[
        ['verify_registry_snapshot', input.registryVerified],
        ['verify_zero_references', input.referencesVerified],
      ].map(([stepKey, verified]) =>
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET status = CASE WHEN ? THEN 'succeeded' ELSE 'waiting_retry' END,
                    attempt_count = attempt_count + 1,
                    next_attempt_at = CASE WHEN ? THEN NULL ELSE ? END,
                    started_at = COALESCE(started_at, ?),
                    completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE NULL END,
                    updated_at = ?
              WHERE operation_id = ? AND step_key = ?
                AND status IN ('queued', 'waiting_retry', 'running')`
          )
          .bind(
            verified ? 1 : 0,
            verified ? 1 : 0,
            input.nextAttemptAt,
            input.now,
            verified ? 1 : 0,
            input.now,
            input.now,
            input.operationId,
            stepKey
          )
      ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'wait_snapshot_drain'
              AND status IN ('queued', 'waiting_retry')`
        )
        .bind(input.now, input.now, input.operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'waiting_retry', attempt_count = attempt_count + 1,
                  next_attempt_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'wait_snapshot_drain'
              AND status IN ('queued', 'waiting_retry', 'running')`
        )
        .bind(input.nextAttemptAt, input.now, input.now, input.operationId),
    ]);
  }

  async markQuarantineReady(operationId: string, now: number): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_quarantine_operations
              SET state = 'ready_for_cleanup', registry_verified_at = COALESCE(registry_verified_at, ?),
                  references_verified_at = COALESCE(references_verified_at, ?),
                  last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND state = 'draining' AND drain_not_before <= ?
              AND NOT EXISTS (
                SELECT 1 FROM control_shard_quarantine_tenants tenant
                 WHERE tenant.operation_id = control_shard_quarantine_operations.operation_id
                   AND (
                     tenant.verified_at IS NULL OR
                     tenant.observed_runtime_generation < tenant.minimum_runtime_generation OR
                     tenant.snapshot_expires_at IS NULL OR tenant.snapshot_expires_at <= ?
                   )
              )`
        )
        .bind(now, now, now, now, operationId, now, now),
      this.db
        .prepare(
          `UPDATE control_tenant_shards
              SET quarantine_state = 'quarantined', quarantined_at = ?, updated_at = ?
            WHERE quarantine_operation_id = ? AND quarantine_state = 'quarantining'`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'succeeded', next_attempt_at = NULL, last_error_code = NULL,
                  completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('running', 'waiting_retry')`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', next_attempt_at = NULL,
                  started_at = COALESCE(started_at, ?), completed_at = COALESCE(completed_at, ?),
                  attempt_count = MAX(attempt_count, 1), updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(now, now, now, operationId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT 'audit:' || operation_id || ':quarantine-ready', environment_id, operation_id,
                  'control.shard.quarantine.ready', 'reconciler', 'd1', shard_id,
                  'succeeded', json_object('drain_not_before', drain_not_before), ?
             FROM control_shard_quarantine_operations WHERE operation_id = ? AND state = 'ready_for_cleanup'`
        )
        .bind(now, operationId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_shard_quarantine_ready_conflict');
    }
  }

  async markQuarantineBlocked(operationId: string, errorCode: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_quarantine_operations
              SET state = 'blocked', last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND state = 'draining'`
        )
        .bind(errorCode, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?,
                  lock_owner = NULL, lock_expires_at = NULL, updated_at = ?
            WHERE operation_id = ? AND status IN ('running', 'waiting_retry')`
        )
        .bind(errorCode, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(errorCode, now, operationId),
    ]);
  }

  async retryQuarantine(input: {
    environmentId: string;
    request: ControlShardQuarantineRetryRequest;
    now: number;
  }): Promise<string> {
    const eventId = `audit:${input.environmentId}:quarantine-retry:${input.request.idempotencyKey}`;
    const payload = JSON.stringify({
      reason_code: input.request.reasonCode,
      idempotency_key: input.request.idempotencyKey,
    });
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, quarantine.environment_id, quarantine.operation_id,
                  'control.shard.quarantine.retry', 'admin', ?, 'd1', quarantine.shard_id,
                  'succeeded', ?, ?
             FROM control_shard_quarantine_operations quarantine
             JOIN control_operations operation ON operation.operation_id = quarantine.operation_id
            WHERE quarantine.operation_id = ? AND quarantine.environment_id = ?
              AND quarantine.state = 'blocked' AND operation.status = 'blocked'`
        )
        .bind(
          eventId,
          input.request.requestedById,
          payload,
          input.now,
          input.request.quarantineOperationId,
          input.environmentId
        ),
      this.db
        .prepare(
          `UPDATE control_shard_quarantine_operations
              SET state = 'draining', last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND state = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = ?
                   AND audit.actor_id = ? AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.now,
          input.request.quarantineOperationId,
          input.environmentId,
          eventId,
          input.request.quarantineOperationId,
          input.request.requestedById,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'running', next_attempt_at = NULL, last_error_code = NULL,
                  retry_budget_started_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = ?
                   AND audit.actor_id = ? AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.now,
          input.now,
          input.request.quarantineOperationId,
          input.environmentId,
          eventId,
          input.request.quarantineOperationId,
          input.request.requestedById,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', next_attempt_at = NULL,
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = ?
                   AND audit.actor_id = ? AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.now,
          input.request.quarantineOperationId,
          eventId,
          input.request.quarantineOperationId,
          input.request.requestedById,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'waiting_retry', next_attempt_at = ?, updated_at = ?
            WHERE operation_id = ? AND status = 'running'
              AND step_key <> 'ready_for_cleanup'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = ?
                   AND audit.actor_id = ? AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.now,
          input.now,
          input.request.quarantineOperationId,
          eventId,
          input.request.quarantineOperationId,
          input.request.requestedById,
          payload
        ),
    ]);
    const row = await this.db
      .prepare(
        `SELECT shard_id FROM control_shard_quarantine_operations
          WHERE operation_id = ? AND environment_id = ? AND state = 'draining'
            AND EXISTS (
              SELECT 1 FROM control_audit_events audit
               WHERE audit.event_id = ? AND audit.operation_id = ?
                 AND audit.actor_id = ? AND audit.redacted_payload_json = ?
            )`
      )
      .bind(
        input.request.quarantineOperationId,
        input.environmentId,
        eventId,
        input.request.quarantineOperationId,
        input.request.requestedById,
        payload
      )
      .first<{ shard_id: string }>();
    if (!row) throw new Error('control_shard_quarantine_retry_not_allowed');
    return row.shard_id;
  }

  async approveCleanup(input: {
    environmentId: string;
    operationId: string;
    request: ControlShardCleanupApprovalRequest;
    destructiveOperationsEnabled: boolean;
    now: number;
  }): Promise<string> {
    const quarantine = await this.db
      .prepare(
        `SELECT quarantine.shard_id, observed.provider_resource_id
           FROM control_shard_quarantine_operations quarantine
           JOIN control_tenant_shards shard
             ON shard.shard_id = quarantine.shard_id
            AND shard.environment_id = quarantine.environment_id
           JOIN control_observed_resources observed
             ON observed.desired_resource_id = shard.d1_desired_resource_id
            AND observed.environment_id = shard.environment_id
            AND observed.resource_kind = 'd1'
          WHERE quarantine.operation_id = ? AND quarantine.environment_id = ?
            AND quarantine.state = 'ready_for_cleanup'
            AND shard.status IN ('failed', 'retired')
            AND shard.quarantine_state = 'quarantined'`
      )
      .bind(input.request.quarantineOperationId, input.environmentId)
      .first<{ shard_id: string; provider_resource_id: string }>();
    if (!quarantine) throw new Error('control_shard_cleanup_quarantine_required');
    const initialState = input.destructiveOperationsEnabled ? 'approved' : 'blocked';
    const operationStatus = input.destructiveOperationsEnabled ? 'queued' : 'blocked';
    const errorCode = input.destructiveOperationsEnabled
      ? null
      : 'control_destructive_operations_disabled';
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, attempt_count, next_attempt_at,
             last_error_code, retry_budget_started_at, created_at, updated_at
           ) VALUES (?, ?, 'cleanup_shard', ?, ?, 'admin', ?, 0, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.operationId,
          input.environmentId,
          input.request.idempotencyKey,
          operationStatus,
          input.request.requestedById,
          input.destructiveOperationsEnabled ? input.now : null,
          errorCode,
          input.now,
          input.now,
          input.now
        ),
      this.db
        .prepare(
          `INSERT INTO control_shard_cleanup_operations (
             operation_id, environment_id, shard_id, quarantine_operation_id, state,
             export_mode, export_evidence_id, delete_database, approved_by_id,
             approval_idempotency_key, approved_at, destructive_gate_observed_at,
             provider_database_id, last_error_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.operationId,
          input.environmentId,
          quarantine.shard_id,
          input.request.quarantineOperationId,
          initialState,
          input.request.exportMode,
          input.request.exportEvidenceId,
          input.request.deleteDatabase ? 1 : 0,
          input.request.requestedById,
          input.request.idempotencyKey,
          input.now,
          input.destructiveOperationsEnabled ? input.now : null,
          quarantine.provider_resource_id,
          errorCode,
          input.now,
          input.now
        ),
      ...[
        ['remove_worker_bindings', 10],
        ['delete_d1', 20],
        ['verify_provider_absence', 30],
        ['finalize_cleanup', 40],
      ].map(([stepKey, displayOrder]) =>
        this.db
          .prepare(
            `INSERT INTO control_operation_steps (
               operation_id, step_key, display_order, status, attempt_count,
               last_error_code, updated_at
             ) VALUES (?, ?, ?, ?, 0, ?, ?)`
          )
          .bind(input.operationId, stepKey, displayOrder, operationStatus, errorCode, input.now)
      ),
      this.db
        .prepare(
          `INSERT INTO control_shard_cleanup_bindings (
             operation_id, environment_id, worker_script_name, binding_ref,
             provider_database_id, state, created_at, updated_at
           )
           SELECT ?, worker.environment_id, worker.worker_script_name, shard.binding_ref,
                  ?, 'pending', ?, ?
             FROM control_tenant_shards shard
             JOIN control_worker_required_data_roles role
               ON role.environment_id = shard.environment_id
              AND role.data_role = shard.data_role
             JOIN control_desired_worker_inventory worker
               ON worker.environment_id = role.environment_id
              AND worker.worker_script_name = role.worker_script_name
              AND worker.status = 'active'
            WHERE shard.environment_id = ? AND shard.shard_id = ?
            GROUP BY worker.environment_id, worker.worker_script_name, shard.binding_ref`
        )
        .bind(
          input.operationId,
          quarantine.provider_resource_id,
          input.now,
          input.now,
          input.environmentId,
          quarantine.shard_id
        ),
      this.db
        .prepare(
          `INSERT INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'control.shard.cleanup.approved', 'admin', ?,
                     'd1', ?, 'succeeded', ?, ?)`
        )
        .bind(
          `audit:${input.operationId}:cleanup-approved`,
          input.environmentId,
          input.operationId,
          input.request.requestedById,
          quarantine.shard_id,
          JSON.stringify({
            quarantine_operation_id: input.request.quarantineOperationId,
            export_mode: input.request.exportMode,
            export_evidence_id: input.request.exportEvidenceId,
            delete_database: input.request.deleteDatabase,
            destructive_operations_enabled: input.destructiveOperationsEnabled,
          }),
          input.now
        ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_shard_cleanup_approval_conflict');
    }
    return quarantine.shard_id;
  }

  async retryCleanup(input: {
    environmentId: string;
    request: ControlShardCleanupRetryRequest;
    now: number;
  }): Promise<string> {
    const eventId = `audit:${input.environmentId}:cleanup-retry:${input.request.idempotencyKey}`;
    const payload = JSON.stringify({
      reason_code: input.request.reasonCode,
      idempotency_key: input.request.idempotencyKey,
    });
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT ?, cleanup.environment_id, cleanup.operation_id,
                  'control.shard.cleanup.retry', 'admin', ?, 'd1', cleanup.shard_id,
                  'succeeded', ?, ?
             FROM control_shard_cleanup_operations cleanup
             JOIN control_operations operation ON operation.operation_id = cleanup.operation_id
            WHERE cleanup.operation_id = ? AND cleanup.environment_id = ?
              AND cleanup.state = 'blocked' AND operation.status = 'blocked'`
        )
        .bind(
          eventId,
          input.request.requestedById,
          payload,
          input.now,
          input.request.cleanupOperationId,
          input.environmentId
        ),
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_bindings
              SET state = CASE WHEN state = 'blocked' THEN 'pending' ELSE state END,
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND EXISTS (
              SELECT 1 FROM control_audit_events audit
               WHERE audit.event_id = ? AND audit.operation_id = ?
                 AND audit.actor_id = ? AND audit.redacted_payload_json = ?
            )`
        )
        .bind(
          input.now,
          input.request.cleanupOperationId,
          eventId,
          input.request.cleanupOperationId,
          input.request.requestedById,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_operations
              SET state = CASE
                    WHEN EXISTS (SELECT 1 FROM control_shard_cleanup_bindings binding
                                  WHERE binding.operation_id = control_shard_cleanup_operations.operation_id
                                    AND binding.state <> 'removed') THEN 'approved'
                    WHEN EXISTS (SELECT 1 FROM control_tenant_shards shard
                                  WHERE shard.shard_id = control_shard_cleanup_operations.shard_id
                                    AND shard.status = 'deleting') THEN 'verifying_absence'
                    ELSE 'deleting_database'
                  END,
                  last_error_code = NULL, destructive_gate_observed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND state = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = ?
                   AND audit.actor_id = ? AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.now,
          input.now,
          input.request.cleanupOperationId,
          input.environmentId,
          eventId,
          input.request.cleanupOperationId,
          input.request.requestedById,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'running', next_attempt_at = NULL, last_error_code = NULL,
                  retry_budget_started_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = ?
                   AND audit.actor_id = ? AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.now,
          input.now,
          input.request.cleanupOperationId,
          input.environmentId,
          eventId,
          input.request.cleanupOperationId,
          input.request.requestedById,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', next_attempt_at = NULL,
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = ?
                   AND audit.actor_id = ? AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.now,
          input.request.cleanupOperationId,
          eventId,
          input.request.cleanupOperationId,
          input.request.requestedById,
          payload
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'waiting_retry', next_attempt_at = ?, updated_at = ?
            WHERE operation_id = ? AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM control_audit_events audit
                 WHERE audit.event_id = ? AND audit.operation_id = ?
                   AND audit.actor_id = ? AND audit.redacted_payload_json = ?
              )`
        )
        .bind(
          input.now,
          input.now,
          input.request.cleanupOperationId,
          eventId,
          input.request.cleanupOperationId,
          input.request.requestedById,
          payload
        ),
    ]);
    const row = await this.db
      .prepare(
        `SELECT shard_id FROM control_shard_cleanup_operations
          WHERE operation_id = ? AND environment_id = ? AND state <> 'blocked'
            AND EXISTS (
              SELECT 1 FROM control_audit_events audit
               WHERE audit.event_id = ? AND audit.operation_id = ?
                 AND audit.actor_id = ? AND audit.redacted_payload_json = ?
            )`
      )
      .bind(
        input.request.cleanupOperationId,
        input.environmentId,
        eventId,
        input.request.cleanupOperationId,
        input.request.requestedById,
        payload
      )
      .first<{ shard_id: string }>();
    if (!row) throw new Error('control_shard_cleanup_retry_not_allowed');
    return row.shard_id;
  }

  async listDueCleanups(limit: number, now: number): Promise<ShardCleanupTarget[]> {
    const result = await this.db
      .prepare(
        `SELECT cleanup.operation_id, cleanup.environment_id, cleanup.shard_id,
                shard.binding_ref, cleanup.provider_database_id,
                desired.deterministic_name, cleanup.state, cleanup.delete_database,
                COALESCE(operation.retry_budget_started_at, operation.created_at) AS retry_budget_started_at
           FROM control_shard_cleanup_operations cleanup
           JOIN control_operations operation ON operation.operation_id = cleanup.operation_id
           JOIN control_tenant_shards shard
             ON shard.shard_id = cleanup.shard_id AND shard.environment_id = cleanup.environment_id
           JOIN control_desired_resources desired
             ON desired.desired_resource_id = shard.d1_desired_resource_id
            AND desired.environment_id = shard.environment_id
          WHERE cleanup.state IN ('approved', 'removing_bindings', 'deleting_database', 'verifying_absence')
            AND operation.status IN ('queued', 'running', 'waiting_retry')
            AND (operation.next_attempt_at IS NULL OR operation.next_attempt_at <= ?)
          ORDER BY operation.updated_at, operation.operation_id LIMIT ?`
      )
      .bind(now, safeLimit(limit))
      .all<{
        operation_id: string;
        environment_id: string;
        shard_id: string;
        binding_ref: string;
        provider_database_id: string;
        deterministic_name: string;
        state: ShardCleanupTarget['state'];
        delete_database: number;
        retry_budget_started_at: number;
      }>();
    return result.results.map((row) => ({
      operationId: row.operation_id,
      environmentId: row.environment_id,
      shardId: row.shard_id,
      bindingRef: row.binding_ref,
      databaseId: row.provider_database_id,
      databaseName: row.deterministic_name,
      state: row.state,
      deleteDatabase: row.delete_database === 1,
      retryBudgetStartedAt: row.retry_budget_started_at,
    }));
  }

  async getQuarantineTargetForCleanup(operationId: string): Promise<ShardQuarantineTarget> {
    const row = await this.db
      .prepare(
        `SELECT quarantine.operation_id, quarantine.environment_id, quarantine.shard_id,
                shard.binding_ref, cleanup.provider_database_id,
                quarantine.deny_registry_generation, quarantine.drain_not_before,
                COALESCE(operation.retry_budget_started_at, operation.created_at)
                  AS retry_budget_started_at
           FROM control_shard_cleanup_operations cleanup
           JOIN control_shard_quarantine_operations quarantine
             ON quarantine.operation_id = cleanup.quarantine_operation_id
            AND quarantine.environment_id = cleanup.environment_id
           JOIN control_operations operation ON operation.operation_id = quarantine.operation_id
           JOIN control_tenant_shards shard
             ON shard.shard_id = cleanup.shard_id AND shard.environment_id = cleanup.environment_id
          WHERE cleanup.operation_id = ? AND quarantine.state = 'ready_for_cleanup'
            AND shard.quarantine_state = 'quarantined'`
      )
      .bind(operationId)
      .first<{
        operation_id: string;
        environment_id: string;
        shard_id: string;
        binding_ref: string;
        provider_database_id: string;
        deny_registry_generation: number;
        drain_not_before: number;
        retry_budget_started_at: number;
      }>();
    if (!row) throw new Error('control_shard_cleanup_quarantine_required');
    const tenants = await this.db
      .prepare(
        `SELECT tenant_id, minimum_runtime_generation
           FROM control_shard_quarantine_tenants
          WHERE operation_id = ? ORDER BY tenant_id`
      )
      .bind(row.operation_id)
      .all<{ tenant_id: string; minimum_runtime_generation: number }>();
    return {
      operationId: row.operation_id,
      environmentId: row.environment_id,
      shardId: row.shard_id,
      bindingRef: row.binding_ref,
      databaseId: row.provider_database_id,
      denyRegistryGeneration: row.deny_registry_generation,
      drainNotBefore: row.drain_not_before,
      retryBudgetStartedAt: row.retry_budget_started_at,
      tenants: tenants.results.map((tenant) => ({
        tenantId: tenant.tenant_id,
        minimumRuntimeGeneration: tenant.minimum_runtime_generation,
      })),
    };
  }

  async listPendingBindings(operationId: string): Promise<ShardCleanupBindingTarget[]> {
    const result = await this.db
      .prepare(
        `SELECT operation_id, environment_id, worker_script_name, binding_ref,
                provider_database_id, state, expected_source_version_id,
                previous_deployment_id, patch_result_version_id,
                patch_result_deployment_id, previous_restore_settings_json
           FROM control_shard_cleanup_bindings
          WHERE operation_id = ? AND state <> 'removed'
          ORDER BY worker_script_name, binding_ref`
      )
      .bind(operationId)
      .all<{
        operation_id: string;
        environment_id: string;
        worker_script_name: string;
        binding_ref: string;
        provider_database_id: string;
        state: ShardCleanupBindingTarget['state'];
        expected_source_version_id: string | null;
        previous_deployment_id: string | null;
        patch_result_version_id: string | null;
        patch_result_deployment_id: string | null;
        previous_restore_settings_json: string | null;
      }>();
    return result.results.map((row) => ({
      operationId: row.operation_id,
      environmentId: row.environment_id,
      workerScriptName: row.worker_script_name,
      bindingRef: row.binding_ref,
      databaseId: row.provider_database_id,
      state: row.state,
      expectedSourceVersionId: row.expected_source_version_id,
      previousDeploymentId: row.previous_deployment_id,
      patchResultVersionId: row.patch_result_version_id,
      patchResultDeploymentId: row.patch_result_deployment_id,
      previousRestoreSettingsJson: row.previous_restore_settings_json,
    }));
  }

  async markCleanupRunning(operationId: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_operations SET status = 'running', next_attempt_at = NULL, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_operations
              SET state = CASE
                    WHEN EXISTS (SELECT 1 FROM control_shard_cleanup_bindings binding
                                  WHERE binding.operation_id = ? AND binding.state <> 'removed')
                    THEN 'removing_bindings' ELSE 'deleting_database' END,
                  destructive_gate_observed_at = COALESCE(destructive_gate_observed_at, ?),
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND state IN ('approved', 'removing_bindings')`
        )
        .bind(operationId, now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?),
                  attempt_count = attempt_count + 1, updated_at = ?
            WHERE operation_id = ? AND step_key = 'remove_worker_bindings'
              AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, now, operationId),
    ]);
  }

  async acquireDeploymentLease(input: {
    target: ShardCleanupBindingTarget;
    expectedSourceVersionId: string;
    now: number;
  }): Promise<ShardCleanupDeploymentLease | null> {
    const expiresAt = input.now + 300;
    const changed = await this.db
      .prepare(
        `INSERT INTO control_worker_deployment_leases (
           environment_id, worker_script_name, owner_operation_id, fencing_token,
           lease_expires_at, expected_source_version_id, mutation_started, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
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
             THEN control_worker_deployment_leases.mutation_started ELSE 0 END,
           previous_deployment_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.previous_deployment_id ELSE NULL END,
           patch_result_version_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.patch_result_version_id ELSE NULL END,
           patch_result_deployment_id = CASE
             WHEN control_worker_deployment_leases.owner_operation_id = excluded.owner_operation_id
             THEN control_worker_deployment_leases.patch_result_deployment_id ELSE NULL END,
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
        input.target.state === 'removing' ? 1 : 0,
        input.now
      )
      .run();
    if ((changed.meta.changes ?? 0) !== 1) return null;
    const row = await this.db
      .prepare(
        `SELECT environment_id, worker_script_name, owner_operation_id, fencing_token,
                expected_source_version_id, mutation_started
           FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?`
      )
      .bind(input.target.environmentId, input.target.workerScriptName, input.target.operationId)
      .first<{
        environment_id: string;
        worker_script_name: string;
        owner_operation_id: string;
        fencing_token: number;
        expected_source_version_id: string;
        mutation_started: number;
      }>();
    return row
      ? {
          environmentId: row.environment_id,
          workerScriptName: row.worker_script_name,
          operationId: row.owner_operation_id,
          fencingToken: row.fencing_token,
          expectedSourceVersionId: row.expected_source_version_id,
          mutationStarted: row.mutation_started === 1,
        }
      : null;
  }

  async leaseIsCurrent(lease: ShardCleanupDeploymentLease, now: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS valid FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ? AND lease_expires_at > ?`
      )
      .bind(lease.environmentId, lease.workerScriptName, lease.operationId, lease.fencingToken, now)
      .first<{ valid: number }>();
    return row?.valid === 1;
  }

  async releaseDeploymentLease(lease: ShardCleanupDeploymentLease): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM control_worker_deployment_leases
          WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
            AND fencing_token = ?`
      )
      .bind(lease.environmentId, lease.workerScriptName, lease.operationId, lease.fencingToken)
      .run();
  }

  async recordBindingRemovalStarted(input: {
    target: ShardCleanupBindingTarget;
    lease: ShardCleanupDeploymentLease;
    sourceVersionId: string;
    previousDeploymentId: string;
    previousSettingsJson: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_worker_deployment_leases
              SET mutation_started = 1, previous_deployment_id = ?, updated_at = ?
            WHERE environment_id = ? AND worker_script_name = ? AND owner_operation_id = ?
              AND fencing_token = ? AND lease_expires_at > ? AND mutation_started = 0`
        )
        .bind(
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
          `UPDATE control_shard_cleanup_bindings
            SET state = 'removing', expected_source_version_id = ?, previous_deployment_id = ?,
                previous_restore_settings_json = ?, last_error_code = NULL, updated_at = ?
          WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
            AND state = 'pending' AND EXISTS (
              SELECT 1 FROM control_worker_deployment_leases lease
               WHERE lease.environment_id = control_shard_cleanup_bindings.environment_id
                 AND lease.worker_script_name = control_shard_cleanup_bindings.worker_script_name
                 AND lease.owner_operation_id = control_shard_cleanup_bindings.operation_id
                 AND lease.fencing_token = ? AND lease.mutation_started = 1
            )`
        )
        .bind(
          input.sourceVersionId,
          input.previousDeploymentId,
          input.previousSettingsJson,
          input.now,
          input.target.operationId,
          input.target.workerScriptName,
          input.target.bindingRef,
          input.lease.fencingToken
        ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_shard_cleanup_binding_state_stale');
    }
  }

  async markBindingAlreadyAbsent(input: {
    target: ShardCleanupBindingTarget;
    lease: ShardCleanupDeploymentLease;
    versionId: string;
    deploymentId: string;
    currentSettingsJson: string;
    now: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_bindings
              SET state = 'removed', expected_source_version_id = ?, previous_deployment_id = ?,
                  patch_result_version_id = ?, patch_result_deployment_id = ?,
                  previous_restore_settings_json = ?, completed_at = ?,
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state = 'pending' AND EXISTS (
                SELECT 1 FROM control_worker_deployment_leases lease
                 WHERE lease.environment_id = control_shard_cleanup_bindings.environment_id
                   AND lease.worker_script_name = control_shard_cleanup_bindings.worker_script_name
                   AND lease.owner_operation_id = control_shard_cleanup_bindings.operation_id
                   AND lease.fencing_token = ? AND lease.expected_source_version_id = ?
                   AND lease.mutation_started = 0 AND lease.lease_expires_at > ?
              )`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.versionId,
          input.deploymentId,
          input.currentSettingsJson,
          input.now,
          input.now,
          input.target.operationId,
          input.target.workerScriptName,
          input.target.bindingRef,
          input.lease.fencingToken,
          input.versionId,
          input.now
        ),
      this.db
        .prepare(
          `DELETE FROM control_worker_observed_bindings
            WHERE environment_id = ? AND worker_script_name = ? AND binding_name = ?
              AND provider_resource_id = ?`
        )
        .bind(
          input.target.environmentId,
          input.target.workerScriptName,
          input.target.bindingRef,
          input.target.databaseId
        ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_shard_cleanup_binding_state_stale');
    }
  }

  async markBindingRemoved(input: {
    target: ShardCleanupBindingTarget;
    lease: ShardCleanupDeploymentLease;
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
          `UPDATE control_shard_cleanup_bindings
              SET state = 'removed', patch_result_version_id = ?,
                  patch_result_deployment_id = ?, completed_at = ?,
                  last_error_code = NULL, updated_at = ?
            WHERE operation_id = ? AND worker_script_name = ? AND binding_ref = ?
              AND state = 'removing'`
        )
        .bind(
          input.versionId,
          input.deploymentId,
          input.now,
          input.now,
          input.target.operationId,
          input.target.workerScriptName,
          input.target.bindingRef
        ),
      this.db
        .prepare(
          `DELETE FROM control_worker_observed_bindings
            WHERE environment_id = ? AND worker_script_name = ? AND binding_name = ?
              AND provider_resource_id = ?`
        )
        .bind(
          input.target.environmentId,
          input.target.workerScriptName,
          input.target.bindingRef,
          input.target.databaseId
        ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_shard_cleanup_binding_state_stale');
    }
  }

  async markBindingsComplete(operationId: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_operations
              SET state = 'deleting_database', updated_at = ?
            WHERE operation_id = ? AND state = 'removing_bindings'
              AND NOT EXISTS (
                SELECT 1 FROM control_shard_cleanup_bindings binding
                 WHERE binding.operation_id = ? AND binding.state <> 'removed'
              )`
        )
        .bind(now, operationId, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', completed_at = ?, next_attempt_at = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = 'remove_worker_bindings'
              AND status IN ('queued', 'running', 'waiting_retry')
              AND NOT EXISTS (
                SELECT 1 FROM control_shard_cleanup_bindings binding
                 WHERE binding.operation_id = ? AND binding.state <> 'removed'
              )`
        )
        .bind(now, now, operationId, operationId),
    ]);
  }

  async markDatabaseDeletionStarted(operationId: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'deleting', updated_at = ?
            WHERE shard_id = (SELECT shard_id FROM control_shard_cleanup_operations WHERE operation_id = ?)
              AND status IN ('failed', 'retired')`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `UPDATE control_desired_resources
              SET desired_state = 'absent', provisioning_state = 'deleting', updated_at = ?
            WHERE desired_resource_id = (
              SELECT shard.d1_desired_resource_id
                FROM control_tenant_shards shard
                JOIN control_shard_cleanup_operations cleanup ON cleanup.shard_id = shard.shard_id
               WHERE cleanup.operation_id = ?
            )`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?),
                  attempt_count = attempt_count + 1, updated_at = ?
            WHERE operation_id = ? AND step_key = 'delete_d1'
              AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, now, operationId),
    ]);
  }

  async markDatabaseDeleteRequested(operationId: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_operations
              SET state = 'verifying_absence', updated_at = ?
            WHERE operation_id = ? AND state = 'deleting_database'`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', completed_at = ?, next_attempt_at = NULL, updated_at = ?
            WHERE operation_id = ? AND step_key = 'delete_d1' AND status = 'running'`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?),
                  attempt_count = attempt_count + 1, updated_at = ?
            WHERE operation_id = ? AND step_key = 'verify_provider_absence'
              AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, now, operationId),
    ]);
  }

  async markCleanupSucceeded(operationId: string, now: number): Promise<void> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_operations
              SET state = 'succeeded', last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND state = 'verifying_absence'`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_tenant_shards SET status = 'deleted', updated_at = ?
            WHERE shard_id = (SELECT shard_id FROM control_shard_cleanup_operations WHERE operation_id = ?)
              AND status = 'deleting'`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `UPDATE control_desired_resources SET provisioning_state = 'deleted', updated_at = ?
            WHERE desired_resource_id = (
              SELECT shard.d1_desired_resource_id
                FROM control_tenant_shards shard
                JOIN control_shard_cleanup_operations cleanup ON cleanup.shard_id = shard.shard_id
               WHERE cleanup.operation_id = ?
            ) AND desired_state = 'absent' AND provisioning_state = 'deleting'`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `UPDATE control_observed_resources SET observed_state = 'missing', observed_at = ?
            WHERE desired_resource_id = (
              SELECT shard.d1_desired_resource_id
                FROM control_tenant_shards shard
                JOIN control_shard_cleanup_operations cleanup ON cleanup.shard_id = shard.shard_id
               WHERE cleanup.operation_id = ?
            )`
        )
        .bind(now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'waiting_retry')`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded', next_attempt_at = NULL,
                  started_at = COALESCE(started_at, ?), completed_at = COALESCE(completed_at, ?),
                  attempt_count = MAX(attempt_count, 1), updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(now, now, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'succeeded', next_attempt_at = NULL, last_error_code = NULL,
                  completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('running', 'waiting_retry')`
        )
        .bind(now, now, operationId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           )
           SELECT 'audit:' || operation_id || ':cleanup-succeeded', environment_id, operation_id,
                  'control.shard.cleanup.succeeded', 'reconciler', 'd1', shard_id,
                  'succeeded', json_object('bindings_removed', (
                    SELECT COUNT(*) FROM control_shard_cleanup_bindings binding
                     WHERE binding.operation_id = control_shard_cleanup_operations.operation_id
                       AND binding.state = 'removed'
                  )), ?
             FROM control_shard_cleanup_operations WHERE operation_id = ? AND state = 'succeeded'`
        )
        .bind(now, operationId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error('control_shard_cleanup_completion_conflict');
    }
  }

  async markCleanupWaiting(
    operationId: string,
    errorCode: string,
    nextAttemptAt: number,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_operations SET last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND state <> 'succeeded'`
        )
        .bind(errorCode, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'waiting_retry', next_attempt_at = ?, last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('running', 'waiting_retry')`
        )
        .bind(nextAttemptAt, errorCode, now, operationId),
    ]);
  }

  async markCleanupBlocked(operationId: string, errorCode: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_operations
              SET state = 'blocked', last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND state <> 'succeeded'`
        )
        .bind(errorCode, now, operationId),
      this.db
        .prepare(
          `UPDATE control_shard_cleanup_bindings SET state = 'blocked', last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND state IN ('pending', 'removing')`
        )
        .bind(errorCode, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', next_attempt_at = NULL, last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(errorCode, now, operationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps SET status = 'blocked', next_attempt_at = NULL,
                  last_error_code = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'running', 'waiting_retry')`
        )
        .bind(errorCode, now, operationId),
    ]);
  }
}

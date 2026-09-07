import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import type {
  CloudflareD1QueryResult,
  ControlTenantPlacementMigrationMutationRequest,
  ControlTenantPlacementMigrationStartRequest,
  ControlTenantPlacementMigrationState,
  ControlTenantPlacementMigrationView,
} from '@authrim/ar-lib-core/control-plane';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_BINDING_REF = /^[A-Z][A-Z0-9_]{0,127}$/u;
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const ROUTE_CUTOVER_LEASE_SECONDS = 120;

interface TenantPlacementMigrationDependencies {
  sourceD1?: {
    queryD1(
      databaseId: string,
      sql: string,
      params?: unknown[]
    ): Promise<CloudflareD1QueryResult[]>;
  };
}

interface PlacementPolicyRow {
  tenant_id: string;
  isolation_policy: string;
  policy_generation: number;
  policy_state: string;
  pending_isolation_policy: string | null;
  migration_operation_id: string | null;
}

interface SourceAssignmentRow {
  data_role: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residency_policy_id: string;
  residency_partition: string;
  shard_id: string;
  assignment_generation: number;
}

interface MigrationRow {
  operation_id: string;
  tenant_id: string;
  source_policy_generation: number;
  target_policy_generation: number;
  source_isolation_policy: 'shared_pool';
  target_isolation_policy: 'tenant_exclusive';
  migration_state: ControlTenantPlacementMigrationState;
  write_fence_state: 'inactive' | 'requested' | 'active' | 'released';
  route_cutover_started: number;
  source_retention_expires_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
}

interface MigrationShardRow {
  data_role: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residency_policy_id: string;
  residency_partition: string;
  source_shard_id: string;
  source_assignment_generation: number;
  target_shard_id: string | null;
  target_assignment_generation: number | null;
  target_route_generation: number | null;
  target_binding_ref: string | null;
  target_database_id: string | null;
  target_database_name: string | null;
  shard_state:
    | 'target_pending'
    | 'inventory_pending'
    | 'capture_pending'
    | 'backfilling'
    | 'catching_up'
    | 'verifying'
    | 'verified'
    | 'write_fenced'
    | 'cutover_committed'
    | 'quarantined'
    | 'purged'
    | 'blocked';
  inventory_table_count: number | null;
  source_row_count: number | null;
  target_row_count: number | null;
  last_observed_source_sequence: number;
  last_applied_source_sequence: number;
  last_error_code: string | null;
  updated_at: number;
}

interface CaptureSourceRow {
  source_shard_id: string;
  provider_resource_id: string;
}

function primary(database: D1Database): D1DatabaseSession {
  if (typeof database.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return database.withSession('first-primary');
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

async function migrationOperationId(
  environmentId: string,
  tenantId: string,
  idempotencyKey: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${environmentId}\0${tenantId}\0${idempotencyKey}`)
  );
  const hex = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0')
  ).join('');
  return `tenant-placement:${hex}`;
}

function canCancel(
  state: ControlTenantPlacementMigrationState,
  routeCutoverStarted: boolean
): boolean {
  if (routeCutoverStarted) return false;
  return ![
    'cutover_committed',
    'source_quarantined',
    'purge_pending',
    'complete',
    'canceled',
  ].includes(state);
}

function targetView(
  shard: MigrationShardRow
): ControlTenantPlacementMigrationView['shards'][number]['target'] {
  if (shard.target_shard_id === null) return null;
  const assignmentGeneration = Number(shard.target_assignment_generation);
  const routeGeneration = Number(shard.target_route_generation);
  if (
    !Number.isSafeInteger(assignmentGeneration) ||
    assignmentGeneration < 1 ||
    !Number.isSafeInteger(routeGeneration) ||
    routeGeneration < 1 ||
    !shard.target_binding_ref ||
    !SAFE_BINDING_REF.test(shard.target_binding_ref) ||
    !shard.target_database_name
  ) {
    throw new Error('control_tenant_placement_migration_target_metadata_invalid');
  }
  return {
    shardId: shard.target_shard_id,
    assignmentGeneration,
    routeGeneration,
    bindingRef: shard.target_binding_ref,
    databaseId: shard.target_database_id,
    databaseName: shard.target_database_name,
  };
}

function view(
  row: MigrationRow,
  shards: MigrationShardRow[],
  now: number
): ControlTenantPlacementMigrationView {
  return {
    operationId: row.operation_id,
    tenantId: row.tenant_id,
    state: row.migration_state,
    sourceIsolationPolicy: row.source_isolation_policy,
    targetIsolationPolicy: row.target_isolation_policy,
    sourcePolicyGeneration: Number(row.source_policy_generation),
    targetPolicyGeneration: Number(row.target_policy_generation),
    writeFenceState: row.write_fence_state,
    routeCutoverStarted: Number(row.route_cutover_started) === 1,
    canCancel: canCancel(row.migration_state, Number(row.route_cutover_started) === 1),
    canApprovePurge:
      row.migration_state === 'source_quarantined' &&
      row.source_retention_expires_at !== null &&
      row.source_retention_expires_at <= now,
    sourceRetentionExpiresAt: row.source_retention_expires_at,
    lastErrorCode: row.last_error_code,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    shards: shards.map((shard) => ({
      dataRole: shard.data_role,
      residencyPolicyId: shard.residency_policy_id,
      residencyPartition: shard.residency_partition,
      sourceShardId: shard.source_shard_id,
      sourceAssignmentGeneration: Number(shard.source_assignment_generation),
      targetShardId: shard.target_shard_id,
      target: targetView(shard),
      state: shard.shard_state,
      inventoryTableCount: shard.inventory_table_count,
      sourceRowCount: shard.source_row_count,
      targetRowCount: shard.target_row_count,
      lastObservedSourceSequence: Number(shard.last_observed_source_sequence),
      lastAppliedSourceSequence: Number(shard.last_applied_source_sequence),
      lastErrorCode: shard.last_error_code,
      updatedAt: Number(shard.updated_at),
    })),
  };
}

function validateSourceAssignments(rows: SourceAssignmentRow[]): void {
  if (rows.length < 3 || rows.length > 256) {
    throw new Error('control_tenant_placement_migration_source_incomplete');
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.data_role, (counts.get(row.data_role) ?? 0) + 1);
  if (
    counts.get('tenant_core/default') !== 1 ||
    !counts.get('tenant_core/users') ||
    !counts.get('tenant_pii')
  ) {
    throw new Error('control_tenant_placement_migration_source_incomplete');
  }
}

export class TenantPlacementMigrationService {
  constructor(
    private readonly database: D1Database,
    private readonly now: () => number,
    private readonly dependencies: TenantPlacementMigrationDependencies = {}
  ) {}

  async start(
    environmentId: string,
    input: ControlTenantPlacementMigrationStartRequest
  ): Promise<ControlTenantPlacementMigrationView> {
    safeId(environmentId, 'invalid_tenant_placement_migration_environment');
    const tenantId = safeId(input.tenantId, 'invalid_tenant_placement_migration_tenant');
    const idempotencyKey = safeId(
      input.idempotencyKey,
      'invalid_tenant_placement_migration_idempotency_key'
    );
    const requestedById = safeId(input.requestedById, 'invalid_tenant_placement_migration_actor');
    if (input.targetIsolationPolicy !== 'tenant_exclusive') {
      throw new Error('invalid_tenant_placement_migration_target');
    }
    const operationId = await migrationOperationId(environmentId, tenantId, idempotencyKey);
    const session = primary(this.database);
    const existing = await session
      .prepare(
        `SELECT operation_id
           FROM control_tenant_placement_migrations
          WHERE environment_id = ? AND idempotency_key = ?`
      )
      .bind(environmentId, idempotencyKey)
      .first<{ operation_id: string }>();
    if (existing) {
      if (existing.operation_id !== operationId) {
        throw new Error('control_tenant_placement_migration_idempotency_conflict');
      }
      const result = await this.get(environmentId, operationId);
      if (!result || result.tenantId !== tenantId) {
        throw new Error('control_tenant_placement_migration_idempotency_conflict');
      }
      return result;
    }

    const policy = await session
      .prepare(
        `SELECT tenant_id, isolation_policy, policy_generation, policy_state,
                pending_isolation_policy, migration_operation_id
           FROM control_tenant_placement_policies
          WHERE environment_id = ? AND tenant_id = ?`
      )
      .bind(environmentId, tenantId)
      .first<PlacementPolicyRow>();
    if (
      !policy ||
      policy.isolation_policy !== 'shared_pool' ||
      policy.policy_state !== 'active' ||
      policy.pending_isolation_policy !== null ||
      policy.migration_operation_id !== null
    ) {
      throw new Error('control_tenant_placement_migration_source_invalid');
    }
    const assignments = await session
      .prepare(
        `SELECT assignment.data_role, assignment.residency_policy_id,
                assignment.residency_partition, assignment.shard_id,
                assignment.assignment_generation
           FROM control_tenant_shard_assignments assignment
           JOIN control_tenant_shards shard
             ON shard.environment_id = assignment.environment_id
            AND shard.shard_id = assignment.shard_id
          WHERE assignment.environment_id = ? AND assignment.tenant_id = ?
            AND assignment.assignment_state = 'active'
            AND shard.allocation_scope = 'shared_pool' AND shard.owner_tenant_id IS NULL
            AND shard.status IN ('ready', 'active')
          ORDER BY assignment.data_role, assignment.residency_partition, assignment.shard_id`
      )
      .bind(environmentId, tenantId)
      .all<SourceAssignmentRow>();
    validateSourceAssignments(assignments.results);
    const now = this.now();
    const targetGeneration = Number(policy.policy_generation) + 1;
    const statements = [
      session
        .prepare(
          `INSERT INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, attempt_count, created_at, started_at, updated_at
           ) VALUES (?, ?, 'tenant_placement_migration', ?, 'running', 'admin', ?, 1, ?, ?, ?)`
        )
        .bind(operationId, environmentId, idempotencyKey, requestedById, now, now, now),
      session
        .prepare(
          `INSERT INTO control_tenant_placement_migrations (
             operation_id, environment_id, tenant_id, source_policy_generation,
             target_policy_generation, source_isolation_policy, target_isolation_policy,
             migration_state, active_operation_key, idempotency_key, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'shared_pool', 'tenant_exclusive', 'planning',
                     'active', ?, ?, ?, ?)`
        )
        .bind(
          operationId,
          environmentId,
          tenantId,
          policy.policy_generation,
          targetGeneration,
          idempotencyKey,
          requestedById,
          now,
          now
        ),
      ...assignments.results.map((assignment) =>
        session
          .prepare(
            `INSERT INTO control_tenant_placement_migration_shards (
               operation_id, environment_id, tenant_id, data_role, residency_policy_id,
               residency_partition, source_shard_id, source_assignment_generation,
               shard_state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'target_pending', ?, ?)`
          )
          .bind(
            operationId,
            environmentId,
            tenantId,
            assignment.data_role,
            assignment.residency_policy_id,
            assignment.residency_partition,
            assignment.shard_id,
            assignment.assignment_generation,
            now,
            now
          )
      ),
      session
        .prepare(
          `UPDATE control_tenant_placement_policies
              SET policy_state = 'migrating', pending_isolation_policy = 'tenant_exclusive',
                  pending_policy_generation = ?, migration_operation_id = ?, updated_at = ?
            WHERE environment_id = ? AND tenant_id = ? AND isolation_policy = 'shared_pool'
              AND policy_generation = ? AND policy_state = 'active'
              AND pending_isolation_policy IS NULL AND migration_operation_id IS NULL`
        )
        .bind(
          targetGeneration,
          operationId,
          now,
          environmentId,
          tenantId,
          policy.policy_generation
        ),
    ];
    const results = await this.database.batch(statements);
    if (results.length !== statements.length || results.some((result) => result.success !== true)) {
      throw new Error('control_tenant_placement_migration_start_failed');
    }
    const started = await this.get(environmentId, operationId);
    if (!started) throw new Error('control_tenant_placement_migration_start_failed');
    return started;
  }

  async get(
    environmentId: string,
    operationId: string
  ): Promise<ControlTenantPlacementMigrationView | null> {
    safeId(environmentId, 'invalid_tenant_placement_migration_environment');
    safeId(operationId, 'invalid_tenant_placement_migration_operation');
    const session = primary(this.database);
    const row = await session
      .prepare(
        `SELECT operation_id, tenant_id, source_policy_generation, target_policy_generation,
                source_isolation_policy, target_isolation_policy, migration_state,
                write_fence_state,
                EXISTS (
                  SELECT 1 FROM control_directory_rewrite_leases route_lease
                   WHERE route_lease.environment_id = control_tenant_placement_migrations.environment_id
                     AND route_lease.operation_id = control_tenant_placement_migrations.operation_id
                     AND route_lease.operation_kind = 'tenant_placement_migration'
                     AND route_lease.mutation_started = 1
                ) AS route_cutover_started,
                source_retention_expires_at, last_error_code,
                created_at, updated_at
           FROM control_tenant_placement_migrations
          WHERE environment_id = ? AND operation_id = ?`
      )
      .bind(environmentId, operationId)
      .first<MigrationRow>();
    if (!row) return null;
    const shards = await session
      .prepare(
        `SELECT migration_shard.data_role, migration_shard.residency_policy_id,
                migration_shard.residency_partition,
                migration_shard.source_shard_id,
                migration_shard.source_assignment_generation,
                migration_shard.target_shard_id,
                migration_shard.target_assignment_generation,
                target.generation AS target_route_generation,
                target.binding_ref AS target_binding_ref,
                desired.deterministic_name AS target_database_name,
                (
                  SELECT observed.provider_resource_id
                    FROM control_observed_resources observed
                   WHERE observed.environment_id = migration_shard.environment_id
                     AND observed.desired_resource_id = target.d1_desired_resource_id
                     AND observed.resource_kind = 'd1'
                     AND observed.observed_state = 'present'
                   ORDER BY observed.observed_at DESC, observed.observed_resource_id DESC
                   LIMIT 1
                ) AS target_database_id,
                migration_shard.shard_state, migration_shard.inventory_table_count,
                migration_shard.source_row_count, migration_shard.target_row_count,
                last_observed_source_sequence, last_applied_source_sequence,
                migration_shard.last_error_code, migration_shard.updated_at
           FROM control_tenant_placement_migration_shards migration_shard
           LEFT JOIN control_tenant_shards target
             ON target.environment_id = migration_shard.environment_id
            AND target.shard_id = migration_shard.target_shard_id
           LEFT JOIN control_desired_resources desired
             ON desired.environment_id = target.environment_id
            AND desired.desired_resource_id = target.d1_desired_resource_id
          WHERE migration_shard.operation_id = ?
          ORDER BY migration_shard.data_role, migration_shard.residency_partition,
                   migration_shard.source_shard_id`
      )
      .bind(operationId)
      .all<MigrationShardRow>();
    return view(row, shards.results, this.now());
  }

  async cancel(
    environmentId: string,
    input: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView> {
    safeId(environmentId, 'invalid_tenant_placement_migration_environment');
    const operationId = safeId(input.operationId, 'invalid_tenant_placement_migration_operation');
    const requestedById = safeId(input.requestedById, 'invalid_tenant_placement_migration_actor');
    const idempotencyKey = safeId(
      input.idempotencyKey,
      'invalid_tenant_placement_migration_idempotency_key'
    );
    const current = await this.get(environmentId, operationId);
    if (!current) throw new Error('control_tenant_placement_migration_not_found');
    if (current.state === 'canceled') return current;
    if (!current.canCancel)
      throw new Error('control_tenant_placement_migration_cancel_not_allowed');
    const session = primary(this.database);
    const sources = await session
      .prepare(
        `SELECT migration_shard.source_shard_id, observed.provider_resource_id
           FROM control_tenant_placement_migration_shards migration_shard
           JOIN control_tenant_shards shard
             ON shard.environment_id = migration_shard.environment_id
            AND shard.shard_id = migration_shard.source_shard_id
           JOIN control_desired_resources desired
             ON desired.environment_id = shard.environment_id
            AND desired.desired_resource_id = shard.d1_desired_resource_id
           JOIN control_observed_resources observed
             ON observed.environment_id = desired.environment_id
            AND observed.desired_resource_id = desired.desired_resource_id
            AND observed.resource_kind = 'd1' AND observed.observed_state = 'present'
          WHERE migration_shard.operation_id = ?
            AND migration_shard.capture_installed_at IS NOT NULL
          ORDER BY migration_shard.source_shard_id`
      )
      .bind(operationId)
      .all<CaptureSourceRow>();
    if (sources.results.length > 0 && !this.dependencies.sourceD1) {
      throw new Error('control_tenant_placement_migration_cancel_cleanup_unavailable');
    }
    const now = this.now();
    for (const source of sources.results) {
      const sourceD1 = this.dependencies.sourceD1;
      if (!sourceD1) {
        throw new Error('control_tenant_placement_migration_cancel_cleanup_unavailable');
      }
      const result = await sourceD1.queryD1(
        source.provider_resource_id,
        `UPDATE tenant_placement_migration_captures
            SET capture_state = 'canceled', canceled_at = ?, updated_at = ?
          WHERE operation_id = ? AND tenant_id = ?
            AND capture_state IN ('capturing', 'write_fenced')`,
        [now, now, operationId, current.tenantId]
      );
      if (result.length !== 1 || result[0]?.success !== true) {
        throw new Error('control_tenant_placement_migration_cancel_cleanup_failed');
      }
    }
    const eventId = await migrationOperationId(environmentId, operationId, idempotencyKey);
    const statements = [
      session
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'tenant_placement_migration.cancel', 'admin', ?,
                     'tenant_placement_migration', ?, 'succeeded', '{}', ?)`
        )
        .bind(eventId, environmentId, operationId, requestedById, operationId, now),
      session
        .prepare(
          `UPDATE control_operations
              SET status = 'blocked', last_error_code = 'operator_cancel', updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status = 'running'`
        )
        .bind(now, operationId, environmentId),
      session
        .prepare(
          `UPDATE control_operations
              SET status = 'canceled', completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ? AND status IN ('blocked', 'waiting_retry')`
        )
        .bind(now, now, operationId, environmentId),
      session
        .prepare(
          `UPDATE control_tenant_shard_assignments
              SET assignment_state = 'retired', retired_at = ?, updated_at = ?
            WHERE source_operation_id = ? AND assignment_state = 'pending'`
        )
        .bind(now, now, operationId),
      session
        .prepare(
          `UPDATE control_tenant_placement_policies
              SET policy_state = 'active', pending_isolation_policy = NULL,
                  pending_policy_generation = NULL, migration_operation_id = NULL, updated_at = ?
            WHERE environment_id = ? AND tenant_id = ?
              AND isolation_policy = 'shared_pool' AND migration_operation_id = ?`
        )
        .bind(now, environmentId, current.tenantId, operationId),
      session
        .prepare(
          `UPDATE control_tenant_placement_migrations
              SET migration_state = 'canceled', active_operation_key = NULL,
                  write_fence_state = CASE
                    WHEN write_fence_state IN ('requested', 'active') THEN 'released'
                    ELSE write_fence_state
                  END,
                  write_fence_released_at = CASE
                    WHEN write_fence_state IN ('requested', 'active') THEN ?
                    ELSE write_fence_released_at
                  END,
                  cancel_requested_at = COALESCE(cancel_requested_at, ?), canceled_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND migration_state NOT IN (
                'cutover_committed', 'source_quarantined', 'purge_pending', 'complete', 'canceled'
              )`
        )
        .bind(now, now, now, now, operationId, environmentId),
    ];
    const results = await this.database.batch(statements);
    if (results.length !== statements.length || results.some((result) => result.success !== true)) {
      throw new Error('control_tenant_placement_migration_cancel_failed');
    }
    const canceled = await this.get(environmentId, operationId);
    if (!canceled || canceled.state !== 'canceled') {
      throw new Error('control_tenant_placement_migration_cancel_failed');
    }
    return canceled;
  }

  async beginRouteCutover(
    environmentId: string,
    input: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView> {
    safeId(environmentId, 'invalid_tenant_placement_migration_environment');
    const operationId = safeId(input.operationId, 'invalid_tenant_placement_migration_operation');
    const requestedById = safeId(input.requestedById, 'invalid_tenant_placement_migration_actor');
    const idempotencyKey = safeId(
      input.idempotencyKey,
      'invalid_tenant_placement_migration_idempotency_key'
    );
    const current = await this.get(environmentId, operationId);
    if (!current) throw new Error('control_tenant_placement_migration_not_found');
    if (current.state !== 'cutover_ready' || current.writeFenceState !== 'active') {
      throw new Error('control_tenant_placement_migration_cutover_not_ready');
    }

    const now = this.now();
    const session = primary(this.database);
    const existing = await session
      .prepare(
        `SELECT operation_id, operation_kind, fencing_token, lease_expires_at, mutation_started
           FROM control_directory_rewrite_leases WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<{
        operation_id: string;
        operation_kind: string;
        fencing_token: number;
        lease_expires_at: number;
        mutation_started: number;
      }>();
    const leaseExpiresAt = now + ROUTE_CUTOVER_LEASE_SECONDS;
    if (!existing) {
      await session
        .prepare(
          `INSERT INTO control_directory_rewrite_leases (
             environment_id, operation_id, operation_kind, owner_id, fencing_token,
             checkpoint_json, lease_expires_at, mutation_started, updated_at
           ) VALUES (?, ?, 'tenant_placement_migration', 'tenant-placement-cutover', 1,
                     '{}', ?, 1, ?)`
        )
        .bind(environmentId, operationId, leaseExpiresAt, now)
        .run();
    } else if (
      existing.operation_id === operationId &&
      existing.operation_kind === 'tenant_placement_migration'
    ) {
      const renewed = await session
        .prepare(
          `UPDATE control_directory_rewrite_leases
              SET lease_expires_at = ?, mutation_started = 1, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND operation_kind = 'tenant_placement_migration'`
        )
        .bind(leaseExpiresAt, now, environmentId, operationId)
        .run();
      if (!renewed.success || renewed.meta.changes !== 1) {
        throw new Error('control_tenant_placement_migration_route_lease_conflict');
      }
    } else {
      throw new Error('control_tenant_placement_migration_route_lease_conflict');
    }

    const eventId = await migrationOperationId(environmentId, operationId, idempotencyKey);
    const audit = await session
      .prepare(
        `INSERT OR IGNORE INTO control_audit_events (
           event_id, environment_id, operation_id, event_type, actor_type, actor_id,
           resource_kind, resource_id, outcome, redacted_payload_json, created_at
         ) VALUES (?, ?, ?, 'tenant_placement_migration.route_cutover_started', 'admin', ?,
                   'tenant_placement_migration', ?, 'succeeded', '{}', ?)`
      )
      .bind(eventId, environmentId, operationId, requestedById, operationId, now)
      .run();
    if (!audit.success) {
      throw new Error('control_tenant_placement_migration_route_lease_failed');
    }

    const started = await this.get(environmentId, operationId);
    if (!started || !started.routeCutoverStarted || started.canCancel) {
      throw new Error('control_tenant_placement_migration_route_lease_failed');
    }
    return started;
  }

  async commitCutover(
    environmentId: string,
    input: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView> {
    safeId(environmentId, 'invalid_tenant_placement_migration_environment');
    const operationId = safeId(input.operationId, 'invalid_tenant_placement_migration_operation');
    const requestedById = safeId(input.requestedById, 'invalid_tenant_placement_migration_actor');
    const idempotencyKey = safeId(
      input.idempotencyKey,
      'invalid_tenant_placement_migration_idempotency_key'
    );
    const current = await this.get(environmentId, operationId);
    if (!current) throw new Error('control_tenant_placement_migration_not_found');
    if (
      ['cutover_committed', 'source_quarantined', 'purge_pending', 'complete'].includes(
        current.state
      )
    ) {
      return current;
    }
    if (current.state !== 'cutover_ready' || current.writeFenceState !== 'active') {
      throw new Error('control_tenant_placement_migration_cutover_not_ready');
    }
    const session = primary(this.database);
    const routeLease = await session
      .prepare(
        `SELECT operation_id
           FROM control_directory_rewrite_leases
          WHERE environment_id = ? AND operation_id = ?
            AND operation_kind = 'tenant_placement_migration'
            AND mutation_started = 1 AND lease_expires_at > ?`
      )
      .bind(environmentId, operationId, this.now())
      .first<{ operation_id: string }>();
    if (!routeLease) {
      throw new Error('control_tenant_placement_migration_route_lease_required');
    }
    const unmappedAccountAllocations = await session
      .prepare(
        `SELECT COUNT(*) AS count
           FROM control_tenant_shard_allocations allocation
          WHERE allocation.environment_id = ? AND allocation.tenant_id = ?
            AND allocation.reservation_state IN ('reserved', 'committed')
            AND NOT EXISTS (
              SELECT 1 FROM control_tenant_placement_migration_shards migration_shard
               WHERE migration_shard.operation_id = ?
                 AND migration_shard.data_role = allocation.data_role
                 AND migration_shard.residency_partition = allocation.residency_partition
                 AND migration_shard.source_shard_id = allocation.selected_shard_id
                 AND migration_shard.shard_state = 'write_fenced'
                 AND migration_shard.target_shard_id IS NOT NULL
            )`
      )
      .bind(environmentId, current.tenantId, operationId)
      .first<{ count: number }>();
    const unmappedDefaultAllocations = await session
      .prepare(
        `SELECT COUNT(*) AS count
           FROM control_tenant_default_allocations allocation
          WHERE allocation.environment_id = ? AND allocation.tenant_id = ?
            AND allocation.reservation_state IN ('reserved', 'committed')
            AND NOT EXISTS (
              SELECT 1 FROM control_tenant_placement_migration_shards migration_shard
               WHERE migration_shard.operation_id = ?
                 AND migration_shard.data_role = 'tenant_core/default'
                 AND migration_shard.residency_partition = allocation.residency_partition
                 AND migration_shard.source_shard_id = allocation.selected_shard_id
                 AND migration_shard.shard_state = 'write_fenced'
                 AND migration_shard.target_shard_id IS NOT NULL
            )`
      )
      .bind(environmentId, current.tenantId, operationId)
      .first<{ count: number }>();
    if (
      !unmappedAccountAllocations ||
      !unmappedDefaultAllocations ||
      Number(unmappedAccountAllocations.count) !== 0 ||
      Number(unmappedDefaultAllocations.count) !== 0
    ) {
      throw new Error('control_tenant_placement_migration_allocation_unmapped');
    }

    const now = this.now();
    const eventId = await migrationOperationId(environmentId, operationId, idempotencyKey);
    const quarantineSourceAssignments = session
      .prepare(
        `UPDATE control_tenant_shard_assignments
            SET assignment_state = 'quarantined', retired_at = ?, updated_at = ?
          WHERE environment_id = ? AND tenant_id = ? AND assignment_state = 'active'
            AND EXISTS (
              SELECT 1 FROM control_tenant_placement_migration_shards migration_shard
               WHERE migration_shard.operation_id = ?
                 AND migration_shard.source_shard_id = control_tenant_shard_assignments.shard_id
                 AND migration_shard.source_assignment_generation =
                     control_tenant_shard_assignments.assignment_generation
            )`
      )
      .bind(now, now, environmentId, current.tenantId, operationId);
    const statements = [
      session
        .prepare(
          `UPDATE control_tenant_placement_policies
              SET isolation_policy = 'tenant_exclusive', policy_generation = ?,
                  policy_state = 'active', pending_isolation_policy = NULL,
                  pending_policy_generation = NULL, migration_operation_id = NULL, updated_at = ?
            WHERE environment_id = ? AND tenant_id = ?
              AND isolation_policy = 'shared_pool' AND policy_generation = ?
              AND policy_state = 'migrating' AND migration_operation_id = ?`
        )
        .bind(
          current.targetPolicyGeneration,
          now,
          environmentId,
          current.tenantId,
          current.sourcePolicyGeneration,
          operationId
        ),
      quarantineSourceAssignments,
      session
        .prepare(
          `UPDATE control_tenant_shard_assignments
              SET assignment_state = 'active', activated_at = COALESCE(activated_at, ?),
                  updated_at = ?
            WHERE environment_id = ? AND tenant_id = ? AND source_operation_id = ?
              AND assignment_state = 'pending'
              AND EXISTS (
                SELECT 1 FROM control_tenant_placement_migration_shards migration_shard
                 WHERE migration_shard.operation_id = ?
                   AND migration_shard.target_shard_id = control_tenant_shard_assignments.shard_id
                   AND migration_shard.target_assignment_generation =
                       control_tenant_shard_assignments.assignment_generation
                   AND migration_shard.shard_state = 'write_fenced'
              )`
        )
        .bind(now, now, environmentId, current.tenantId, operationId, operationId),
      session
        .prepare(
          `UPDATE control_tenant_default_allocations
              SET selected_shard_id = (
                    SELECT migration_shard.target_shard_id
                      FROM control_tenant_placement_migration_shards migration_shard
                     WHERE migration_shard.operation_id = ?
                       AND migration_shard.data_role = 'tenant_core/default'
                       AND migration_shard.residency_partition =
                           control_tenant_default_allocations.residency_partition
                       AND migration_shard.source_shard_id =
                           control_tenant_default_allocations.selected_shard_id
                  ),
                  route_generation = (
                    SELECT target.generation
                      FROM control_tenant_placement_migration_shards migration_shard
                      JOIN control_tenant_shards target
                        ON target.environment_id = migration_shard.environment_id
                       AND target.shard_id = migration_shard.target_shard_id
                     WHERE migration_shard.operation_id = ?
                       AND migration_shard.data_role = 'tenant_core/default'
                       AND migration_shard.residency_partition =
                           control_tenant_default_allocations.residency_partition
                       AND migration_shard.source_shard_id =
                           control_tenant_default_allocations.selected_shard_id
                  ),
                  updated_at = ?
            WHERE environment_id = ? AND tenant_id = ?
              AND reservation_state IN ('reserved', 'committed')
              AND EXISTS (
                SELECT 1 FROM control_tenant_placement_migration_shards migration_shard
                 WHERE migration_shard.operation_id = ?
                   AND migration_shard.data_role = 'tenant_core/default'
                   AND migration_shard.residency_partition =
                       control_tenant_default_allocations.residency_partition
                   AND migration_shard.source_shard_id =
                       control_tenant_default_allocations.selected_shard_id
              )`
        )
        .bind(operationId, operationId, now, environmentId, current.tenantId, operationId),
      session
        .prepare(
          `UPDATE control_tenant_shard_allocations
              SET selected_shard_id = (
                    SELECT migration_shard.target_shard_id
                      FROM control_tenant_placement_migration_shards migration_shard
                     WHERE migration_shard.operation_id = ?
                       AND migration_shard.data_role = control_tenant_shard_allocations.data_role
                       AND migration_shard.residency_partition =
                           control_tenant_shard_allocations.residency_partition
                       AND migration_shard.source_shard_id =
                           control_tenant_shard_allocations.selected_shard_id
                  ),
                  route_generation = (
                    SELECT target.generation
                      FROM control_tenant_placement_migration_shards migration_shard
                      JOIN control_tenant_shards target
                        ON target.environment_id = migration_shard.environment_id
                       AND target.shard_id = migration_shard.target_shard_id
                     WHERE migration_shard.operation_id = ?
                       AND migration_shard.data_role = control_tenant_shard_allocations.data_role
                       AND migration_shard.residency_partition =
                           control_tenant_shard_allocations.residency_partition
                       AND migration_shard.source_shard_id =
                           control_tenant_shard_allocations.selected_shard_id
                  ),
                  updated_at = ?
            WHERE environment_id = ? AND tenant_id = ?
              AND reservation_state IN ('reserved', 'committed')
              AND EXISTS (
                SELECT 1 FROM control_tenant_placement_migration_shards migration_shard
                 WHERE migration_shard.operation_id = ?
                   AND migration_shard.data_role = control_tenant_shard_allocations.data_role
                   AND migration_shard.residency_partition =
                       control_tenant_shard_allocations.residency_partition
                   AND migration_shard.source_shard_id =
                       control_tenant_shard_allocations.selected_shard_id
              )`
        )
        .bind(operationId, operationId, now, environmentId, current.tenantId, operationId),
      session
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET shard_state = 'cutover_committed', cutover_committed_at = ?, updated_at = ?
            WHERE operation_id = ? AND shard_state = 'write_fenced'`
        )
        .bind(now, now, operationId),
      session
        .prepare(
          `UPDATE control_tenant_placement_migrations
              SET migration_state = 'cutover_committed', cutover_committed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND migration_state = 'cutover_ready' AND write_fence_state = 'active'`
        )
        .bind(now, now, operationId, environmentId),
      session
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'tenant_placement_migration.cutover_commit', 'admin', ?,
                     'tenant_placement_migration', ?, 'succeeded', '{}', ?)`
        )
        .bind(eventId, environmentId, operationId, requestedById, operationId, now),
    ];
    const results = await this.database.batch(statements);
    const expectedShardChanges = current.shards.length;
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true) ||
      Number(results[0]?.meta?.changes ?? 0) !== 1 ||
      Number(results[1]?.meta?.changes ?? 0) !== expectedShardChanges ||
      Number(results[2]?.meta?.changes ?? 0) !== expectedShardChanges ||
      Number(results[5]?.meta?.changes ?? 0) !== expectedShardChanges ||
      Number(results[6]?.meta?.changes ?? 0) !== 1
    ) {
      throw new Error('control_tenant_placement_migration_cutover_failed');
    }
    const committed = await this.get(environmentId, operationId);
    if (!committed || committed.state !== 'cutover_committed' || committed.canCancel) {
      throw new Error('control_tenant_placement_migration_cutover_failed');
    }
    return committed;
  }

  async approvePurge(
    environmentId: string,
    input: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView> {
    safeId(environmentId, 'invalid_tenant_placement_migration_environment');
    const operationId = safeId(input.operationId, 'invalid_tenant_placement_migration_operation');
    const requestedById = safeId(input.requestedById, 'invalid_tenant_placement_migration_actor');
    const idempotencyKey = safeId(
      input.idempotencyKey,
      'invalid_tenant_placement_migration_idempotency_key'
    );
    const current = await this.get(environmentId, operationId);
    if (!current) throw new Error('control_tenant_placement_migration_not_found');
    if (['purge_pending', 'complete'].includes(current.state)) return current;
    if (!current.canApprovePurge) {
      throw new Error('control_tenant_placement_migration_purge_not_allowed');
    }
    const now = this.now();
    const session = primary(this.database);
    const eventId = await migrationOperationId(environmentId, operationId, idempotencyKey);
    const statements = [
      session
        .prepare(
          `UPDATE control_tenant_placement_migrations
              SET migration_state = 'purge_pending', purge_approved_by = ?,
                  purge_approved_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND migration_state = 'source_quarantined'
              AND source_retention_expires_at <= ?`
        )
        .bind(requestedById, now, now, environmentId, operationId, now),
      session
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET table_cursor_json = '{"purgeTableIndex":0}', updated_at = ?
            WHERE operation_id = ? AND shard_state = 'quarantined'`
        )
        .bind(now, operationId),
      session
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'tenant_placement_migration.source_purge_approved', 'admin', ?,
                     'tenant_placement_migration', ?, 'succeeded', '{}', ?)`
        )
        .bind(eventId, environmentId, operationId, requestedById, operationId, now),
    ];
    const results = await this.database.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true) ||
      Number(results[0]?.meta?.changes ?? 0) !== 1 ||
      Number(results[1]?.meta?.changes ?? 0) !== current.shards.length
    ) {
      throw new Error('control_tenant_placement_migration_purge_not_allowed');
    }
    const result = await this.get(environmentId, operationId);
    if (!result || result.state !== 'purge_pending') {
      throw new Error('control_tenant_placement_migration_purge_not_allowed');
    }
    return result;
  }

  async finalizeCutover(
    environmentId: string,
    input: ControlTenantPlacementMigrationMutationRequest
  ): Promise<ControlTenantPlacementMigrationView> {
    safeId(environmentId, 'invalid_tenant_placement_migration_environment');
    const operationId = safeId(input.operationId, 'invalid_tenant_placement_migration_operation');
    const requestedById = safeId(input.requestedById, 'invalid_tenant_placement_migration_actor');
    const idempotencyKey = safeId(
      input.idempotencyKey,
      'invalid_tenant_placement_migration_idempotency_key'
    );
    const current = await this.get(environmentId, operationId);
    if (!current) throw new Error('control_tenant_placement_migration_not_found');
    if (['source_quarantined', 'purge_pending', 'complete'].includes(current.state)) return current;
    if (current.state !== 'cutover_committed' || current.writeFenceState !== 'active') {
      throw new Error('control_tenant_placement_migration_finalize_not_ready');
    }

    const session = primary(this.database);
    const routeLease = await session
      .prepare(
        `SELECT operation_id
           FROM control_directory_rewrite_leases
          WHERE environment_id = ? AND operation_id = ?
            AND operation_kind = 'tenant_placement_migration' AND mutation_started = 1`
      )
      .bind(environmentId, operationId)
      .first<{ operation_id: string }>();
    if (!routeLease) {
      throw new Error('control_tenant_placement_migration_route_lease_required');
    }
    if (!this.dependencies.sourceD1) {
      throw new Error('control_tenant_placement_migration_finalize_cleanup_unavailable');
    }

    const sources = await session
      .prepare(
        `SELECT migration_shard.source_shard_id,
                (
                  SELECT observed.provider_resource_id
                    FROM control_tenant_shards source
                    JOIN control_observed_resources observed
                      ON observed.environment_id = source.environment_id
                     AND observed.desired_resource_id = source.d1_desired_resource_id
                     AND observed.resource_kind = 'd1'
                     AND observed.observed_state = 'present'
                   WHERE source.environment_id = migration_shard.environment_id
                     AND source.shard_id = migration_shard.source_shard_id
                   ORDER BY observed.observed_at DESC, observed.observed_resource_id DESC
                   LIMIT 1
                ) AS provider_resource_id
           FROM control_tenant_placement_migration_shards migration_shard
          WHERE migration_shard.operation_id = ?
          ORDER BY migration_shard.source_shard_id`
      )
      .bind(operationId)
      .all<CaptureSourceRow>();
    if (
      sources.results.length !== current.shards.length ||
      sources.results.some((source) => !source.provider_resource_id)
    ) {
      throw new Error('control_tenant_placement_migration_source_incomplete');
    }

    const now = this.now();
    for (const source of sources.results) {
      const update = await this.dependencies.sourceD1.queryD1(
        source.provider_resource_id,
        `UPDATE tenant_placement_migration_captures
            SET capture_state = 'cutover_committed', cutover_committed_at = ?, updated_at = ?
          WHERE operation_id = ? AND tenant_id = ?
            AND capture_state IN ('write_fenced', 'cutover_committed')`,
        [now, now, operationId, current.tenantId]
      );
      const reflected = await this.dependencies.sourceD1.queryD1(
        source.provider_resource_id,
        `SELECT capture_state, cutover_committed_at
           FROM tenant_placement_migration_captures
          WHERE operation_id = ? AND tenant_id = ?`,
        [operationId, current.tenantId]
      );
      const capture = reflected[0]?.results?.[0] as
        | { capture_state?: unknown; cutover_committed_at?: unknown }
        | undefined;
      if (
        update.length !== 1 ||
        update[0]?.success !== true ||
        reflected.length !== 1 ||
        reflected[0]?.success !== true ||
        capture?.capture_state !== 'cutover_committed' ||
        !Number.isSafeInteger(Number(capture.cutover_committed_at))
      ) {
        throw new Error('control_tenant_placement_migration_finalize_cleanup_failed');
      }
    }

    const eventId = await migrationOperationId(environmentId, operationId, idempotencyKey);
    const statements = [
      session
        .prepare(
          `UPDATE control_tenant_placement_migration_shards
              SET shard_state = 'quarantined', quarantined_at = ?, updated_at = ?
            WHERE operation_id = ? AND shard_state = 'cutover_committed'`
        )
        .bind(now, now, operationId),
      session
        .prepare(
          `UPDATE control_tenant_placement_migrations
              SET migration_state = 'source_quarantined', source_quarantined_at = ?,
                  source_retention_expires_at = ?, write_fence_state = 'released',
                  write_fence_released_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND migration_state = 'cutover_committed' AND write_fence_state = 'active'`
        )
        .bind(now, now + RETENTION_SECONDS, now, now, environmentId, operationId),
      session
        .prepare(
          `INSERT OR IGNORE INTO control_audit_events (
             event_id, environment_id, operation_id, event_type, actor_type, actor_id,
             resource_kind, resource_id, outcome, redacted_payload_json, created_at
           ) VALUES (?, ?, ?, 'tenant_placement_migration.source_quarantine', 'admin', ?,
                     'tenant_placement_migration', ?, 'succeeded', '{}', ?)`
        )
        .bind(eventId, environmentId, operationId, requestedById, operationId, now),
      session
        .prepare(
          `DELETE FROM control_directory_rewrite_leases
            WHERE environment_id = ? AND operation_id = ?
              AND operation_kind = 'tenant_placement_migration' AND mutation_started = 1`
        )
        .bind(environmentId, operationId),
    ];
    const results = await this.database.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true) ||
      Number(results[0]?.meta?.changes ?? 0) !== current.shards.length ||
      Number(results[1]?.meta?.changes ?? 0) !== 1 ||
      Number(results[3]?.meta?.changes ?? 0) !== 1
    ) {
      throw new Error('control_tenant_placement_migration_finalize_failed');
    }
    const result = await this.get(environmentId, operationId);
    if (
      !result ||
      result.state !== 'source_quarantined' ||
      result.writeFenceState !== 'released' ||
      result.routeCutoverStarted
    ) {
      throw new Error('control_tenant_placement_migration_finalize_failed');
    }
    return result;
  }
}

export const TENANT_PLACEMENT_SOURCE_RETENTION_SECONDS = RETENTION_SECONDS;

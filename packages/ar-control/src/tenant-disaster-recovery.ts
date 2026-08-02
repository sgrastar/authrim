import type { D1Database } from '@cloudflare/workers-types';
import type {
  ControlTenantDisasterRecoveryCancelRequest,
  ControlTenantDisasterRecoveryDenyObservationRequest,
  ControlTenantDisasterRecoveryLookupCheckpointRequest,
  ControlTenantDisasterRecoveryLookupClaimRequest,
  ControlTenantDisasterRecoveryLookupClaimNextRequest,
  ControlTenantDisasterRecoveryLookupCompleteRequest,
  ControlTenantDisasterRecoveryLookupStage,
  ControlTenantDisasterRecoveryLookupWork,
  ControlTenantDisasterRecoveryReactivationObservationRequest,
  ControlTenantDisasterRecoveryReactivationRequest,
  ControlTenantDisasterRecoveryRestoreConfirmationRequest,
  ControlTenantDisasterRecoveryStartRequest,
  ControlTenantDisasterRecoveryState,
  ControlTenantDisasterRecoveryTarget,
  ControlTenantDisasterRecoveryVerificationRequest,
  ControlTenantDisasterRecoveryView,
} from '@authrim/ar-lib-core/control-plane';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DRAIN_SECONDS = 1800;
const LOOKUP_LEASE_SECONDS = 120;
const LOOKUP_STAGES: readonly ControlTenantDisasterRecoveryLookupStage[] = [
  'cleanup',
  'account_id',
  'email_exact',
  'external_core',
  'external_pii',
  'verify',
];

interface RecoveryRow {
  operation_id: string;
  environment_id: string;
  tenant_id: string;
  recovery_state: ControlTenantDisasterRecoveryState;
  pinned_route_generation: number;
  deny_runtime_generation: number | null;
  deny_registry_generation: number | null;
  deny_observed_at: number | null;
  drain_not_before: number | null;
  restore_reference_digest: string | null;
  restored_at: number | null;
  migration_verified_at: number | null;
  lookup_reprojected_at: number | null;
  lookup_reprojection_registry_digest: string | null;
  lookup_reprojection_shard_count: number | null;
  lookup_reprojection_stage: ControlTenantDisasterRecoveryLookupStage;
  lookup_reprojection_target_index: number;
  lookup_reprojection_after_created_at: number;
  lookup_reprojection_after_id: string;
  lookup_reprojection_after_row_id: number;
  lookup_reprojection_projected_rows: number;
  lookup_reprojection_verified_rows: number;
  lookup_reprojection_lease_owner: string | null;
  lookup_reprojection_fencing_token: number;
  lookup_reprojection_lease_expires_at: number | null;
  binding_smoke_verified_at: number | null;
  reactivated_runtime_generation: number | null;
  reactivated_at: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
}

interface TargetRow {
  shard_id: string;
  data_role: ControlTenantDisasterRecoveryTarget['dataRole'];
  residency_partition: string;
  assignment_generation: number;
  shard_generation: number;
  binding_ref: string;
  provider_database_id: string;
  migration_stream_id: 'd1-core' | 'd1-pii';
  release_id: string;
  manifest_digest: string;
  restore_confirmed_at: number | null;
  migration_verified_at: number | null;
  lookup_reprojected_at: number | null;
  binding_smoke_verified_at: number | null;
}

interface StartTargetRow extends TargetRow {
  tenant_id: string;
  route_generation: number;
  route_projection_json: string;
}

interface RecoveryBindingTargetRow {
  worker_script_name: string;
  shard_id: string;
  binding_ref: string;
  data_role: ControlTenantDisasterRecoveryTarget['dataRole'];
  residency_partition: string;
  migration_generation: number;
  provider_database_id: string;
  state?: string;
}

interface RecoveryCommandIdempotencyRow {
  recovery_state: ControlTenantDisasterRecoveryState;
  restore_reference_digest: string | null;
  restored_at: number | null;
  restore_confirmed_by: string | null;
  restore_idempotency_key: string | null;
  reactivation_requested_by: string | null;
  reactivation_idempotency_key: string | null;
  cancel_requested_by: string | null;
  cancel_idempotency_key: string | null;
}

function id(value: unknown, code = 'invalid_tenant_disaster_recovery_request'): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
}

async function operationId(
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
  return `tenant-dr:${hex}`;
}

function target(row: TargetRow): ControlTenantDisasterRecoveryTarget {
  if (!SAFE_BINDING.test(row.binding_ref) || !SHA256.test(row.manifest_digest)) {
    throw new Error('control_tenant_dr_target_metadata_invalid');
  }
  return {
    shardId: row.shard_id,
    dataRole: row.data_role,
    residencyPartition: row.residency_partition,
    assignmentGeneration: Number(row.assignment_generation),
    shardGeneration: Number(row.shard_generation),
    bindingRef: row.binding_ref,
    providerDatabaseId: row.provider_database_id,
    migrationStreamId: row.migration_stream_id,
    releaseId: row.release_id,
    manifestDigest: row.manifest_digest,
    restoreConfirmedAt: row.restore_confirmed_at,
    migrationVerifiedAt: row.migration_verified_at,
    lookupReprojectedAt: row.lookup_reprojected_at,
    bindingSmokeVerifiedAt: row.binding_smoke_verified_at,
  };
}

function view(
  row: RecoveryRow,
  targets: TargetRow[],
  now: number
): ControlTenantDisasterRecoveryView {
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    tenantId: row.tenant_id,
    state: row.recovery_state,
    pinnedRouteGeneration: Number(row.pinned_route_generation),
    denyRuntimeGeneration: row.deny_runtime_generation,
    denyRegistryGeneration: row.deny_registry_generation,
    denyObservedAt: row.deny_observed_at,
    drainNotBefore: row.drain_not_before,
    restoreReferenceRecorded: row.restore_reference_digest !== null,
    restoredAt: row.restored_at,
    migrationVerifiedAt: row.migration_verified_at,
    lookupReprojectedAt: row.lookup_reprojected_at,
    lookupReprojection: {
      stage: row.lookup_reprojection_stage,
      targetIndex: Number(row.lookup_reprojection_target_index),
      afterCreatedAt: Number(row.lookup_reprojection_after_created_at),
      afterId: row.lookup_reprojection_after_id,
      afterRowId: Number(row.lookup_reprojection_after_row_id),
      projectedRows: Number(row.lookup_reprojection_projected_rows),
      verifiedRows: Number(row.lookup_reprojection_verified_rows),
      registryDigestPinned: row.lookup_reprojection_registry_digest !== null,
      leaseActive:
        row.lookup_reprojection_lease_owner !== null &&
        row.lookup_reprojection_lease_expires_at !== null &&
        row.lookup_reprojection_lease_expires_at > now,
    },
    bindingSmokeVerifiedAt: row.binding_smoke_verified_at,
    reactivatedRuntimeGeneration: row.reactivated_runtime_generation,
    reactivatedAt: row.reactivated_at,
    lastErrorCode: row.last_error_code,
    canCancel: row.recovery_state === 'publishing_deny' && row.deny_observed_at === null,
    canConfirmRestore:
      row.recovery_state === 'operator_restore_required' &&
      row.drain_not_before !== null &&
      now >= row.drain_not_before,
    canVerify: row.recovery_state === 'verifying_restore',
    canReactivate: row.recovery_state === 'ready_for_reactivation',
    targets: targets.map(target),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function exactTargetEvidence(
  request: ControlTenantDisasterRecoveryVerificationRequest,
  expected: ControlTenantDisasterRecoveryTarget[]
): void {
  if (request.targets.length !== expected.length) {
    throw new Error('control_tenant_dr_verification_target_mismatch');
  }
  const actual = [...request.targets].sort((a, b) => a.shardId.localeCompare(b.shardId));
  const pinned = [...expected].sort((a, b) => a.shardId.localeCompare(b.shardId));
  for (let index = 0; index < pinned.length; index += 1) {
    const left = actual[index];
    const right = pinned[index];
    if (
      !left ||
      !right ||
      left.shardId !== right.shardId ||
      left.providerDatabaseId !== right.providerDatabaseId ||
      left.shardGeneration !== right.shardGeneration ||
      left.bindingRef !== right.bindingRef ||
      left.releaseId !== right.releaseId ||
      left.manifestDigest !== right.manifestDigest
    ) {
      throw new Error('control_tenant_dr_verification_target_mismatch');
    }
  }
}

function projectionShardIds(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) projectionShardIds(entry, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const record = value as Record<string, unknown>;
  if (typeof record.shardId === 'string') found.add(record.shardId);
  for (const child of Object.values(record)) projectionShardIds(child, found);
  return found;
}

function nonNegativeInteger(value: unknown, code: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(code);
  }
  return Number(value);
}

function lookupStage(value: unknown): ControlTenantDisasterRecoveryLookupStage {
  if (!LOOKUP_STAGES.includes(value as ControlTenantDisasterRecoveryLookupStage)) {
    throw new Error('control_tenant_dr_lookup_stage_invalid');
  }
  return value as ControlTenantDisasterRecoveryLookupStage;
}

function validLookupStageTransition(
  current: ControlTenantDisasterRecoveryLookupStage,
  next: ControlTenantDisasterRecoveryLookupStage
): boolean {
  const currentIndex = LOOKUP_STAGES.indexOf(current);
  const nextIndex = LOOKUP_STAGES.indexOf(next);
  return nextIndex === currentIndex || nextIndex === currentIndex + 1;
}

function lookupCursorId(value: unknown): string {
  if (value === '') return '';
  return id(value, 'control_tenant_dr_lookup_cursor_invalid');
}

export class TenantDisasterRecoveryService {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  async get(environmentIdInput: unknown, operationIdInput: unknown) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(operationIdInput);
    const row = await this.db
      .prepare(
        `SELECT * FROM control_tenant_disaster_recovery_operations
          WHERE environment_id = ? AND operation_id = ?`
      )
      .bind(environmentId, recoveryOperationId)
      .first<RecoveryRow>();
    if (!row) return null;
    const targets = await this.targets(environmentId, recoveryOperationId);
    return view(row, targets, this.now());
  }

  async start(environmentIdInput: unknown, request: ControlTenantDisasterRecoveryStartRequest) {
    const environmentId = id(environmentIdInput);
    const tenantId = id(request.tenantId);
    const requestedById = id(request.requestedById);
    const idempotencyKey = id(request.idempotencyKey);
    if (request.reasonCode !== 'operator_disaster_recovery') {
      throw new Error('invalid_tenant_disaster_recovery_request');
    }
    const recoveryOperationId = await operationId(environmentId, tenantId, idempotencyKey);
    const existing = await this.get(environmentId, recoveryOperationId);
    if (existing) return existing;

    const topologyConflict = await this.db
      .prepare(
        `SELECT
           EXISTS (
             SELECT 1 FROM control_lookup_bucket_migrations
              WHERE environment_id = ? AND state NOT IN ('complete', 'blocked')
           ) AS bucket_migration,
           EXISTS (
             SELECT 1 FROM control_hmac_rotation_operations
              WHERE environment_id = ? AND state NOT IN ('complete', 'blocked')
           ) AS hmac_rotation,
           EXISTS (
             SELECT 1 FROM control_route_projection_migrations
              WHERE environment_id = ? AND state NOT IN ('complete', 'blocked')
           ) AS route_projection_migration`
      )
      .bind(environmentId, environmentId, environmentId)
      .first<{
        bucket_migration: number;
        hmac_rotation: number;
        route_projection_migration: number;
      }>();
    if (
      !topologyConflict ||
      Number(topologyConflict.bucket_migration) !== 0 ||
      Number(topologyConflict.hmac_rotation) !== 0 ||
      Number(topologyConflict.route_projection_migration) !== 0
    ) {
      throw new Error('control_tenant_dr_lookup_topology_busy');
    }

    const result = await this.db
      .prepare(
        `SELECT assignment.tenant_id, assignment.shard_id, assignment.data_role,
                assignment.residency_partition, assignment.assignment_generation,
                shard.generation AS shard_generation, shard.binding_ref,
                observed.provider_resource_id AS provider_database_id, route.route_generation,
                route.route_projection_json,
                CASE WHEN assignment.data_role = 'tenant_pii' THEN 'd1-pii' ELSE 'd1-core' END
                  AS migration_stream_id,
                release.release_id, release.manifest_digest,
                NULL AS restore_confirmed_at, NULL AS migration_verified_at,
                NULL AS lookup_reprojected_at, NULL AS binding_smoke_verified_at
           FROM control_tenant_shard_assignments assignment
           JOIN control_tenant_placement_policies policy
             ON policy.environment_id = assignment.environment_id
            AND policy.tenant_id = assignment.tenant_id
            AND policy.policy_state = 'active'
           JOIN control_tenant_shards shard
             ON shard.environment_id = assignment.environment_id
            AND shard.shard_id = assignment.shard_id
            AND shard.status IN ('ready', 'active', 'degraded')
           JOIN control_observed_resources observed
             ON observed.environment_id = shard.environment_id
            AND observed.desired_resource_id = shard.d1_desired_resource_id
            AND observed.resource_kind = 'd1'
            AND observed.observed_state = 'present'
           JOIN control_runtime_registry_routes route
             ON route.environment_id = assignment.environment_id
            AND route.tenant_id = assignment.tenant_id
            AND route.route_status = 'active'
            AND route.tenant_lifecycle_state = 'active'
           JOIN control_migration_release_catalog release
             ON release.environment_id = assignment.environment_id
            AND release.stream_id = CASE
              WHEN assignment.data_role = 'tenant_pii' THEN 'd1-pii' ELSE 'd1-core' END
            AND release.state = 'active'
          WHERE assignment.environment_id = ? AND assignment.tenant_id = ?
            AND assignment.assignment_state = 'active'
          ORDER BY assignment.data_role, assignment.residency_partition, assignment.shard_id`
      )
      .bind(environmentId, tenantId)
      .all<StartTargetRow>();
    const targets = result.results;
    if (targets.length === 0) throw new Error('control_tenant_dr_active_route_missing');
    const routeGeneration = positiveInteger(
      targets[0]?.route_generation,
      'control_tenant_dr_route_generation_invalid'
    );
    if (targets.some((entry) => Number(entry.route_generation) !== routeGeneration)) {
      throw new Error('control_tenant_dr_route_generation_mismatch');
    }
    for (const entry of targets) {
      for (const [key, value] of Object.entries({
        shard_id: entry.shard_id,
        data_role: entry.data_role,
        residency_partition: entry.residency_partition,
        assignment_generation: entry.assignment_generation,
        shard_generation: entry.shard_generation,
        binding_ref: entry.binding_ref,
        provider_database_id: entry.provider_database_id,
        migration_stream_id: entry.migration_stream_id,
        release_id: entry.release_id,
        manifest_digest: entry.manifest_digest,
      })) {
        if (value === undefined || value === null) {
          throw new Error(`control_tenant_dr_target_${key}_missing`);
        }
      }
    }
    let projection: unknown;
    try {
      projection = JSON.parse(targets[0]?.route_projection_json ?? '{}') as unknown;
    } catch {
      throw new Error('control_tenant_dr_route_projection_invalid');
    }
    const projectedShardIds = projectionShardIds(projection);
    const assignedShardIds = new Set(targets.map((entry) => entry.shard_id));
    if (
      targets.some((entry) => !projectedShardIds.has(entry.shard_id)) ||
      [...projectedShardIds].some((shardId) => !assignedShardIds.has(shardId))
    ) {
      throw new Error('control_tenant_dr_route_projection_mismatch');
    }

    const now = this.now();
    const steps = [
      { key: 'publish_signed_deny', order: 10 },
      { key: 'drain_runtime_snapshots', order: 20 },
      { key: 'operator_restore', order: 30 },
      { key: 'verify_migrations', order: 40 },
      { key: 'reproject_lookup', order: 50 },
      { key: 'verify_runtime_bindings', order: 60 },
      { key: 'reconcile_worker_bindings', order: 61 },
      { key: 'smoke_bindings', order: 62 },
      { key: 'stabilize_bindings', order: 63 },
      { key: 'reactivate_route', order: 70 },
    ];
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO control_operations (
             operation_id, environment_id, operation_kind, idempotency_key, status,
             requested_by_type, requested_by_id, attempt_count, created_at, started_at, updated_at
           ) VALUES (?, ?, 'tenant_disaster_recovery', ?, 'running', 'admin', ?, 1, ?, ?, ?)`
        )
        .bind(recoveryOperationId, environmentId, idempotencyKey, requestedById, now, now, now),
      this.db
        .prepare(
          `INSERT INTO control_tenant_disaster_recovery_operations (
             operation_id, environment_id, tenant_id, recovery_state, active_operation_key,
             pinned_route_generation, idempotency_key, requested_by_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'publishing_deny', 'active', ?, ?, ?, ?, ?)`
        )
        .bind(
          recoveryOperationId,
          environmentId,
          tenantId,
          routeGeneration,
          idempotencyKey,
          requestedById,
          now,
          now
        ),
      ...steps.map((step, index) =>
        this.db
          .prepare(
            `INSERT INTO control_operation_steps (
               operation_id, step_key, display_order, status, attempt_count, updated_at
             ) VALUES (?, ?, ?, ?, 0, ?)`
          )
          .bind(recoveryOperationId, step.key, step.order, index === 0 ? 'running' : 'queued', now)
      ),
      ...targets.map((entry) =>
        this.db
          .prepare(
            `INSERT INTO control_tenant_disaster_recovery_targets (
               operation_id, environment_id, tenant_id, shard_id, data_role,
               residency_partition, assignment_generation, shard_generation, binding_ref,
               provider_database_id, migration_stream_id, release_id, manifest_digest,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            recoveryOperationId,
            environmentId,
            tenantId,
            entry.shard_id,
            entry.data_role,
            entry.residency_partition,
            entry.assignment_generation,
            entry.shard_generation,
            entry.binding_ref,
            entry.provider_database_id,
            entry.migration_stream_id,
            entry.release_id,
            entry.manifest_digest,
            now,
            now
          )
      ),
      this.audit(
        recoveryOperationId,
        environmentId,
        'control.tenant_dr.requested',
        requestedById,
        tenantId,
        'succeeded',
        { targetCount: targets.length, pinnedRouteGeneration: routeGeneration },
        now
      ),
    ]);
    return this.required(environmentId, recoveryOperationId);
  }

  async observeDeny(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryDenyObservationRequest
  ) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const runtimeGeneration = positiveInteger(
      request.runtimeGeneration,
      'control_tenant_dr_deny_generation_invalid'
    );
    const denyRegistryGeneration = positiveInteger(
      request.denyRegistryGeneration,
      'control_tenant_dr_deny_generation_invalid'
    );
    const current = await this.required(environmentId, recoveryOperationId);
    if (current.state !== 'publishing_deny') {
      if (
        current.denyRuntimeGeneration === runtimeGeneration &&
        current.denyRegistryGeneration === denyRegistryGeneration
      ) {
        return current;
      }
      throw new Error('control_tenant_dr_deny_observation_conflict');
    }
    const now = this.now();
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_tenant_disaster_recovery_operations
              SET recovery_state = 'draining', deny_runtime_generation = ?,
                  deny_registry_generation = ?, deny_observed_at = ?, drain_not_before = ?,
                  updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND recovery_state = 'publishing_deny' AND deny_observed_at IS NULL`
        )
        .bind(
          runtimeGeneration,
          denyRegistryGeneration,
          now,
          now + DRAIN_SECONDS,
          now,
          environmentId,
          recoveryOperationId
        ),
      this.completeStep(recoveryOperationId, 'publish_signed_deny', now),
      this.startStep(recoveryOperationId, 'drain_runtime_snapshots', now),
    ]);
    if (result[0]?.meta.changes !== 1) {
      const existing = await this.required(environmentId, recoveryOperationId);
      if (
        existing.denyRuntimeGeneration !== runtimeGeneration ||
        existing.denyRegistryGeneration !== denyRegistryGeneration
      ) {
        throw new Error('control_tenant_dr_deny_observation_conflict');
      }
      return existing;
    }
    return this.required(environmentId, recoveryOperationId);
  }

  async reconcileDrain(environmentIdInput?: unknown) {
    const now = this.now();
    const environmentId =
      environmentIdInput === undefined ? null : id(environmentIdInput, 'invalid_environment_id');
    const query = environmentId
      ? this.db
          .prepare(
            `SELECT operation_id, environment_id FROM control_tenant_disaster_recovery_operations
              WHERE recovery_state = 'draining' AND drain_not_before <= ? AND environment_id = ?
              ORDER BY drain_not_before LIMIT 25`
          )
          .bind(now, environmentId)
      : this.db
          .prepare(
            `SELECT operation_id, environment_id FROM control_tenant_disaster_recovery_operations
              WHERE recovery_state = 'draining' AND drain_not_before <= ?
              ORDER BY drain_not_before LIMIT 25`
          )
          .bind(now);
    const due = await query.all<{ operation_id: string; environment_id: string }>();
    for (const row of due.results) {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE control_tenant_disaster_recovery_operations
                SET recovery_state = 'operator_restore_required', updated_at = ?
              WHERE operation_id = ? AND environment_id = ? AND recovery_state = 'draining'
                AND drain_not_before <= ?`
          )
          .bind(now, row.operation_id, row.environment_id, now),
        this.completeStep(row.operation_id, 'drain_runtime_snapshots', now),
        this.startStep(row.operation_id, 'operator_restore', now),
      ]);
    }
    return { advanced: due.results.length };
  }

  async confirmRestore(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryRestoreConfirmationRequest
  ) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const requestedById = id(request.requestedById);
    const idempotencyKey = id(request.idempotencyKey);
    if (!SHA256.test(request.restoreReferenceDigest)) {
      throw new Error('control_tenant_dr_restore_reference_invalid');
    }
    const restoredAt = positiveInteger(request.restoredAt, 'control_tenant_dr_restored_at_invalid');
    const now = this.now();
    if (restoredAt > now + 300) throw new Error('control_tenant_dr_restored_at_invalid');
    const current = await this.required(environmentId, recoveryOperationId);
    const command = await this.commandIdempotency(environmentId, recoveryOperationId);
    if (!current.canConfirmRestore) {
      if (
        command.restore_idempotency_key === idempotencyKey &&
        command.restore_reference_digest === request.restoreReferenceDigest &&
        Number(command.restored_at) === restoredAt &&
        command.restore_confirmed_by === requestedById
      ) {
        return current;
      }
      throw new Error(
        command.restore_idempotency_key === null
          ? 'control_tenant_dr_restore_not_allowed'
          : 'control_tenant_dr_restore_idempotency_conflict'
      );
    }
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_tenant_disaster_recovery_operations
              SET recovery_state = 'verifying_restore', restore_reference_digest = ?,
                  restored_at = ?, restore_confirmed_by = ?, restore_idempotency_key = ?,
                  updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND recovery_state = 'operator_restore_required' AND drain_not_before <= ?
              AND restore_idempotency_key IS NULL`
        )
        .bind(
          request.restoreReferenceDigest,
          restoredAt,
          requestedById,
          idempotencyKey,
          now,
          environmentId,
          recoveryOperationId,
          now
        ),
      this.db
        .prepare(
          `UPDATE control_tenant_disaster_recovery_targets
              SET restore_confirmed_at = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?
              AND EXISTS (
                SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
                 WHERE recovery.operation_id = ? AND recovery.environment_id = ?
                   AND recovery.restore_idempotency_key = ?
                   AND recovery.restore_confirmed_by = ?
              )`
        )
        .bind(
          now,
          now,
          recoveryOperationId,
          environmentId,
          recoveryOperationId,
          environmentId,
          idempotencyKey,
          requestedById
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'succeeded',
                  progress_current = CASE
                    WHEN progress_total IS NULL THEN progress_current ELSE progress_total
                  END,
                  completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND step_key = 'operator_restore' AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
                 WHERE recovery.operation_id = ? AND recovery.environment_id = ?
                   AND recovery.restore_idempotency_key = ?
                   AND recovery.restore_confirmed_by = ?
              )`
        )
        .bind(
          now,
          now,
          recoveryOperationId,
          recoveryOperationId,
          environmentId,
          idempotencyKey,
          requestedById
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'verify_migrations'
              AND status IN ('queued', 'waiting_retry', 'blocked')
              AND EXISTS (
                SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
                 WHERE recovery.operation_id = ? AND recovery.environment_id = ?
                   AND recovery.restore_idempotency_key = ?
                   AND recovery.restore_confirmed_by = ?
              )`
        )
        .bind(
          now,
          now,
          recoveryOperationId,
          recoveryOperationId,
          environmentId,
          idempotencyKey,
          requestedById
        ),
      this.audit(
        recoveryOperationId,
        environmentId,
        'control.tenant_dr.restore_confirmed',
        requestedById,
        current.tenantId,
        'succeeded',
        { restoreReferenceRecorded: true, restoredAt },
        now
      ),
    ]);
    if (result[0]?.meta.changes !== 1) throw new Error('control_tenant_dr_restore_conflict');
    return this.required(environmentId, recoveryOperationId);
  }

  async claimLookupReprojection(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryLookupClaimRequest
  ): Promise<ControlTenantDisasterRecoveryLookupWork> {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const ownerId = id(request.ownerId, 'control_tenant_dr_lookup_owner_invalid');
    if (!SHA256.test(request.registryDigest)) {
      throw new Error('control_tenant_dr_lookup_registry_digest_invalid');
    }
    const lookupShardCount = positiveInteger(
      request.lookupShardCount,
      'control_tenant_dr_lookup_shard_count_invalid'
    );
    if (lookupShardCount > 4096) {
      throw new Error('control_tenant_dr_lookup_shard_count_invalid');
    }
    const now = this.now();
    const result = await this.db
      .prepare(
        `UPDATE control_tenant_disaster_recovery_operations
            SET lookup_reprojection_registry_digest = COALESCE(
                  lookup_reprojection_registry_digest, ?
                ),
                lookup_reprojection_shard_count = COALESCE(
                  lookup_reprojection_shard_count, ?
                ),
                lookup_reprojection_lease_owner = ?,
                lookup_reprojection_fencing_token = lookup_reprojection_fencing_token + 1,
                lookup_reprojection_lease_expires_at = ?, updated_at = ?
          WHERE environment_id = ? AND operation_id = ?
            AND recovery_state = 'reprojecting_lookup'
            AND (lookup_reprojection_registry_digest IS NULL OR
                 lookup_reprojection_registry_digest = ?)
            AND (lookup_reprojection_shard_count IS NULL OR
                 lookup_reprojection_shard_count = ?)
            AND (lookup_reprojection_lease_owner IS NULL OR
                 lookup_reprojection_lease_expires_at <= ? OR
                 lookup_reprojection_lease_owner = ?)`
      )
      .bind(
        request.registryDigest,
        lookupShardCount,
        ownerId,
        now + LOOKUP_LEASE_SECONDS,
        now,
        environmentId,
        recoveryOperationId,
        request.registryDigest,
        lookupShardCount,
        now,
        ownerId
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error('control_tenant_dr_lookup_claim_conflict');
    }
    return this.lookupWork(environmentId, recoveryOperationId);
  }

  async claimNextLookupReprojection(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryLookupClaimNextRequest
  ): Promise<ControlTenantDisasterRecoveryLookupWork | null> {
    const environmentId = id(environmentIdInput);
    const row = await this.db
      .prepare(
        `SELECT operation_id FROM control_tenant_disaster_recovery_operations
          WHERE environment_id = ? AND recovery_state = 'reprojecting_lookup'
            AND (lookup_reprojection_lease_owner IS NULL OR
                 lookup_reprojection_lease_expires_at <= ? OR
                 lookup_reprojection_lease_owner = ?)
          ORDER BY updated_at, operation_id LIMIT 1`
      )
      .bind(environmentId, this.now(), request.ownerId)
      .first<{ operation_id: string }>();
    if (!row) return null;
    return this.claimLookupReprojection(environmentId, {
      ...request,
      operationId: row.operation_id,
    });
  }

  async checkpointLookupReprojection(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryLookupCheckpointRequest
  ) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const ownerId = id(request.ownerId, 'control_tenant_dr_lookup_owner_invalid');
    if (!SHA256.test(request.registryDigest)) {
      throw new Error('control_tenant_dr_lookup_registry_digest_invalid');
    }
    const fencingToken = positiveInteger(
      request.fencingToken,
      'control_tenant_dr_lookup_fencing_invalid'
    );
    const lookupShardCount = positiveInteger(
      request.lookupShardCount,
      'control_tenant_dr_lookup_shard_count_invalid'
    );
    const stage = lookupStage(request.stage);
    const nextStage = lookupStage(request.nextStage);
    if (!validLookupStageTransition(stage, nextStage)) {
      throw new Error('control_tenant_dr_lookup_stage_transition_invalid');
    }
    const targetIndex = nonNegativeInteger(
      request.targetIndex,
      'control_tenant_dr_lookup_cursor_invalid',
      4096
    );
    const afterCreatedAt = nonNegativeInteger(
      request.afterCreatedAt,
      'control_tenant_dr_lookup_cursor_invalid'
    );
    const afterId = lookupCursorId(request.afterId);
    const afterRowId = nonNegativeInteger(
      request.afterRowId,
      'control_tenant_dr_lookup_cursor_invalid'
    );
    const projectedRowsDelta = nonNegativeInteger(
      request.projectedRowsDelta,
      'control_tenant_dr_lookup_count_invalid',
      1000
    );
    const verifiedRowsDelta = nonNegativeInteger(
      request.verifiedRowsDelta,
      'control_tenant_dr_lookup_count_invalid',
      250
    );
    const current = await this.lookupWork(environmentId, recoveryOperationId);
    if (
      current.ownerId !== ownerId ||
      current.fencingToken !== fencingToken ||
      current.registryDigest !== request.registryDigest ||
      current.lookupShardCount !== lookupShardCount ||
      current.progress.stage !== stage ||
      current.leaseExpiresAt <= this.now()
    ) {
      throw new Error('control_tenant_dr_lookup_stale_lease');
    }
    if (stage !== nextStage) {
      if (targetIndex !== 0 || afterCreatedAt !== 0 || afterId !== '' || afterRowId !== 0) {
        throw new Error('control_tenant_dr_lookup_cursor_invalid');
      }
    } else {
      const progress = current.progress;
      const sameTarget = targetIndex === progress.targetIndex;
      const nextTarget = targetIndex === progress.targetIndex + 1;
      if (
        (!sameTarget && !nextTarget) ||
        (nextTarget && (afterCreatedAt !== 0 || afterId !== '' || afterRowId !== 0)) ||
        (sameTarget &&
          (afterCreatedAt < progress.afterCreatedAt ||
            (afterCreatedAt === progress.afterCreatedAt && afterId < progress.afterId) ||
            afterRowId < progress.afterRowId))
      ) {
        throw new Error('control_tenant_dr_lookup_cursor_invalid');
      }
    }
    const now = this.now();
    const result = await this.db
      .prepare(
        `UPDATE control_tenant_disaster_recovery_operations
            SET lookup_reprojection_stage = ?, lookup_reprojection_target_index = ?,
                lookup_reprojection_after_created_at = ?, lookup_reprojection_after_id = ?,
                lookup_reprojection_after_row_id = ?,
                lookup_reprojection_projected_rows =
                  lookup_reprojection_projected_rows + ?,
                lookup_reprojection_verified_rows =
                  lookup_reprojection_verified_rows + ?,
                lookup_reprojection_lease_owner = NULL,
                lookup_reprojection_lease_expires_at = NULL, updated_at = ?
          WHERE environment_id = ? AND operation_id = ?
            AND recovery_state = 'reprojecting_lookup'
            AND lookup_reprojection_registry_digest = ?
            AND lookup_reprojection_shard_count = ?
            AND lookup_reprojection_stage = ?
            AND lookup_reprojection_lease_owner = ?
            AND lookup_reprojection_fencing_token = ?
            AND lookup_reprojection_lease_expires_at > ?`
      )
      .bind(
        nextStage,
        targetIndex,
        afterCreatedAt,
        afterId,
        afterRowId,
        projectedRowsDelta,
        verifiedRowsDelta,
        now,
        environmentId,
        recoveryOperationId,
        request.registryDigest,
        lookupShardCount,
        stage,
        ownerId,
        fencingToken,
        now
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Error('control_tenant_dr_lookup_stale_lease');
    }
    return this.required(environmentId, recoveryOperationId);
  }

  async completeLookupReprojection(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryLookupCompleteRequest
  ) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const ownerId = id(request.ownerId, 'control_tenant_dr_lookup_owner_invalid');
    const fencingToken = positiveInteger(
      request.fencingToken,
      'control_tenant_dr_lookup_fencing_invalid'
    );
    if (!SHA256.test(request.registryDigest)) {
      throw new Error('control_tenant_dr_lookup_registry_digest_invalid');
    }
    const work = await this.lookupWork(environmentId, recoveryOperationId);
    if (
      work.ownerId !== ownerId ||
      work.fencingToken !== fencingToken ||
      work.registryDigest !== request.registryDigest ||
      work.progress.stage !== 'verify' ||
      work.progress.targetIndex !== work.lookupShardCount ||
      work.progress.afterRowId !== 0 ||
      work.progress.projectedRows !== work.progress.verifiedRows ||
      work.leaseExpiresAt <= this.now()
    ) {
      throw new Error('control_tenant_dr_lookup_completion_invalid');
    }
    const now = this.now();
    const released = await this.db
      .prepare(
        `UPDATE control_tenant_disaster_recovery_operations
            SET lookup_reprojection_lease_owner = NULL,
                lookup_reprojection_lease_expires_at = NULL, updated_at = ?
          WHERE environment_id = ? AND operation_id = ?
            AND recovery_state = 'reprojecting_lookup'
            AND lookup_reprojection_lease_owner = ?
            AND lookup_reprojection_fencing_token = ?
            AND lookup_reprojection_lease_expires_at > ?`
      )
      .bind(now, environmentId, recoveryOperationId, ownerId, fencingToken, now)
      .run();
    if ((released.meta.changes ?? 0) !== 1) {
      throw new Error('control_tenant_dr_lookup_stale_lease');
    }
    return this.recordVerification(environmentId, {
      operationId: recoveryOperationId,
      stage: 'lookup_reprojection',
      pinnedRouteGeneration: work.pinnedRouteGeneration,
      targets: work.targets.map((entry) => ({
        shardId: entry.shardId,
        providerDatabaseId: entry.providerDatabaseId,
        shardGeneration: entry.shardGeneration,
        bindingRef: entry.bindingRef,
        releaseId: entry.releaseId,
        manifestDigest: entry.manifestDigest,
      })),
    });
  }

  async recordVerification(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryVerificationRequest
  ) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const current = await this.required(environmentId, recoveryOperationId);
    if (request.pinnedRouteGeneration !== current.pinnedRouteGeneration) {
      throw new Error('control_tenant_dr_stale_route_generation');
    }
    exactTargetEvidence(request, current.targets);
    const expected = {
      migration: {
        state: 'verifying_restore',
        next: 'reprojecting_lookup',
        column: 'migration_verified_at',
        step: 'verify_migrations',
        nextStep: 'reproject_lookup',
      },
      lookup_reprojection: {
        state: 'reprojecting_lookup',
        next: 'smoke_verifying',
        column: 'lookup_reprojected_at',
        step: 'reproject_lookup',
        nextStep: 'verify_runtime_bindings',
      },
      binding_smoke: {
        state: 'smoke_verifying',
        next: 'ready_for_reactivation',
        column: 'binding_smoke_verified_at',
        step: 'verify_runtime_bindings',
        nextStep: null,
      },
    } as const;
    const transition = expected[request.stage];
    if (!transition || current.state !== transition.state) {
      throw new Error('control_tenant_dr_verification_stage_invalid');
    }
    const expectedBindings =
      request.stage === 'lookup_reprojection' || request.stage === 'binding_smoke'
        ? await this.expectedBindingTargets(environmentId, recoveryOperationId)
        : [];
    if (request.stage === 'lookup_reprojection') {
      if (
        expectedBindings.length === 0 ||
        current.targets.some(
          (recoveryTarget) =>
            !expectedBindings.some(
              (bindingTarget) => bindingTarget.shard_id === recoveryTarget.shardId
            )
        )
      ) {
        throw new Error('control_tenant_dr_binding_targets_missing');
      }
    }
    if (request.stage === 'binding_smoke') {
      await this.assertBindingSmokeComplete(environmentId, recoveryOperationId, expectedBindings);
    }
    const now = this.now();
    const statements = [
      this.db
        .prepare(
          `UPDATE control_tenant_disaster_recovery_operations
              SET recovery_state = ?, ${transition.column} = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND recovery_state = ?`
        )
        .bind(transition.next, now, now, environmentId, recoveryOperationId, transition.state),
      this.db
        .prepare(
          `UPDATE control_tenant_disaster_recovery_targets
              SET ${transition.column} = ?, updated_at = ?
            WHERE operation_id = ? AND environment_id = ?`
        )
        .bind(now, now, recoveryOperationId, environmentId),
      this.completeStep(recoveryOperationId, transition.step, now),
      ...(transition.nextStep
        ? [this.startStep(recoveryOperationId, transition.nextStep, now)]
        : []),
      ...(request.stage === 'lookup_reprojection'
        ? [
            ...expectedBindings.map((bindingTarget) =>
              this.db
                .prepare(
                  `INSERT OR IGNORE INTO control_worker_binding_reconciliations (
                     operation_id, environment_id, worker_script_name, shard_id, binding_ref,
                     data_role, residency_partition, migration_generation, provider_database_id,
                     state, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
                )
                .bind(
                  recoveryOperationId,
                  environmentId,
                  bindingTarget.worker_script_name,
                  bindingTarget.shard_id,
                  bindingTarget.binding_ref,
                  bindingTarget.data_role,
                  bindingTarget.residency_partition,
                  bindingTarget.migration_generation,
                  bindingTarget.provider_database_id,
                  now,
                  now
                )
            ),
            this.db
              .prepare(
                `UPDATE control_operation_steps
                    SET progress_total = ?, progress_current = 0, updated_at = ?
                  WHERE operation_id = ? AND step_key = 'verify_runtime_bindings'
                    AND status = 'running'`
              )
              .bind(expectedBindings.length, now, recoveryOperationId),
          ]
        : []),
      ...(request.stage === 'binding_smoke'
        ? [
            this.db
              .prepare(
                `UPDATE control_operations
                    SET status = 'running', next_attempt_at = NULL, last_error_code = NULL,
                        last_error_redacted = NULL, updated_at = ?
                  WHERE operation_id = ? AND environment_id = ?
                    AND status IN ('running', 'waiting_retry')`
              )
              .bind(now, recoveryOperationId, environmentId),
          ]
        : []),
    ];
    const result = await this.db.batch(statements);
    if (result[0]?.meta.changes !== 1) throw new Error('control_tenant_dr_verification_conflict');
    return this.required(environmentId, recoveryOperationId);
  }

  async reconcileBindingSmoke(environmentIdInput?: unknown): Promise<{ completed: number }> {
    const environmentId = environmentIdInput === undefined ? null : id(environmentIdInput);
    const result = await this.db
      .prepare(
        `SELECT recovery.operation_id, recovery.environment_id
           FROM control_tenant_disaster_recovery_operations recovery
           JOIN control_operations operation
             ON operation.operation_id = recovery.operation_id
            AND operation.environment_id = recovery.environment_id
          WHERE recovery.recovery_state = 'smoke_verifying'
            AND (? IS NULL OR recovery.environment_id = ?)
            AND operation.status IN ('running', 'waiting_retry')
          ORDER BY recovery.updated_at, recovery.operation_id
          LIMIT 20`
      )
      .bind(environmentId, environmentId)
      .all<{ operation_id: string; environment_id: string }>();
    let completed = 0;
    for (const row of result.results) {
      const current = await this.required(row.environment_id, row.operation_id);
      const expectedBindings = await this.expectedBindingTargets(
        row.environment_id,
        row.operation_id
      );
      try {
        await this.assertBindingSmokeComplete(
          row.environment_id,
          row.operation_id,
          expectedBindings
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'control_tenant_dr_binding_smoke_incomplete'
        ) {
          continue;
        }
        throw error;
      }
      await this.recordVerification(row.environment_id, {
        operationId: row.operation_id,
        stage: 'binding_smoke',
        pinnedRouteGeneration: current.pinnedRouteGeneration,
        targets: current.targets.map((entry) => ({
          shardId: entry.shardId,
          providerDatabaseId: entry.providerDatabaseId,
          shardGeneration: entry.shardGeneration,
          bindingRef: entry.bindingRef,
          releaseId: entry.releaseId,
          manifestDigest: entry.manifestDigest,
        })),
      });
      completed += 1;
    }
    return { completed };
  }

  async handoffBindingSmokeToSetup(environmentIdInput?: unknown): Promise<{ handedOff: number }> {
    const environmentId = environmentIdInput === undefined ? null : id(environmentIdInput);
    const now = this.now();
    const candidates = await this.db
      .prepare(
        `SELECT recovery.operation_id, recovery.environment_id
           FROM control_tenant_disaster_recovery_operations recovery
           JOIN control_operations operation
             ON operation.operation_id = recovery.operation_id
            AND operation.environment_id = recovery.environment_id
          WHERE recovery.recovery_state = 'smoke_verifying'
            AND (? IS NULL OR recovery.environment_id = ?)
            AND operation.status IN ('running', 'waiting_retry')
            AND EXISTS (
              SELECT 1 FROM control_worker_binding_reconciliations target
               WHERE target.operation_id = recovery.operation_id
                 AND target.environment_id = recovery.environment_id
                 AND target.state = 'pending'
            )
          ORDER BY recovery.updated_at, recovery.operation_id
          LIMIT 20`
      )
      .bind(environmentId, environmentId)
      .all<{ operation_id: string; environment_id: string }>();
    let handedOff = 0;
    for (const candidate of candidates.results) {
      const results = await this.db.batch([
        this.db
          .prepare(
            `UPDATE control_operations
                SET status = 'blocked', last_error_code = 'operator_action_required',
                    last_error_redacted = 'Continue this operation with setup.',
                    next_attempt_at = NULL, lock_owner = NULL, lock_expires_at = NULL,
                    updated_at = ?
              WHERE operation_id = ? AND environment_id = ?
                AND status IN ('running', 'waiting_retry')`
          )
          .bind(now, candidate.operation_id, candidate.environment_id),
        this.db
          .prepare(
            `UPDATE control_operation_steps
                SET status = 'blocked', last_error_code = 'operator_action_required',
                    last_error_redacted = 'Continue this operation with setup.',
                    next_attempt_at = NULL, updated_at = ?
              WHERE operation_id = ? AND step_key IN (
                'verify_runtime_bindings', 'reconcile_worker_bindings'
              ) AND status IN ('queued', 'running')`
          )
          .bind(now, candidate.operation_id),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO control_audit_events (
               event_id, environment_id, operation_id, event_type, actor_type,
               resource_kind, resource_id, outcome, redacted_payload_json, created_at
             ) VALUES (?, ?, ?, 'control.tenant_dr.operator_handoff', 'reconciler',
                       'tenant_disaster_recovery', ?, 'blocked',
                       '{"reason_code":"operator_action_required"}', ?)`
          )
          .bind(
            `audit:${candidate.operation_id}:binding-operator-handoff`,
            candidate.environment_id,
            candidate.operation_id,
            candidate.operation_id,
            now
          ),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 1) handedOff += 1;
    }
    return { handedOff };
  }

  async requestReactivation(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryReactivationRequest
  ) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const requestedById = id(request.requestedById);
    const idempotencyKey = id(request.idempotencyKey);
    if (request.reasonCode !== 'operator_reactivate_recovered_tenant') {
      throw new Error('invalid_tenant_disaster_recovery_request');
    }
    const current = await this.required(environmentId, recoveryOperationId);
    const command = await this.commandIdempotency(environmentId, recoveryOperationId);
    if (current.state === 'reactivating' || current.state === 'succeeded') {
      if (
        command.reactivation_idempotency_key === idempotencyKey &&
        command.reactivation_requested_by === requestedById
      ) {
        return current;
      }
      throw new Error('control_tenant_dr_reactivation_idempotency_conflict');
    }
    if (!current.canReactivate) throw new Error('control_tenant_dr_reactivation_not_allowed');
    const now = this.now();
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_tenant_disaster_recovery_operations
              SET recovery_state = 'reactivating', reactivation_requested_by = ?,
                  reactivation_idempotency_key = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND recovery_state = 'ready_for_reactivation'
              AND migration_verified_at IS NOT NULL AND lookup_reprojected_at IS NOT NULL
              AND binding_smoke_verified_at IS NOT NULL
              AND reactivation_idempotency_key IS NULL`
        )
        .bind(requestedById, idempotencyKey, now, environmentId, recoveryOperationId),
      this.db
        .prepare(
          `UPDATE control_operation_steps
              SET status = 'running', attempt_count = attempt_count + 1,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE operation_id = ? AND step_key = 'reactivate_route'
              AND status IN ('queued', 'waiting_retry', 'blocked')
              AND EXISTS (
                SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
                 WHERE recovery.operation_id = ? AND recovery.environment_id = ?
                   AND recovery.reactivation_idempotency_key = ?
                   AND recovery.reactivation_requested_by = ?
              )`
        )
        .bind(
          now,
          now,
          recoveryOperationId,
          recoveryOperationId,
          environmentId,
          idempotencyKey,
          requestedById
        ),
    ]);
    if (result[0]?.meta.changes !== 1)
      throw new Error('control_tenant_dr_reactivation_not_allowed');
    return this.required(environmentId, recoveryOperationId);
  }

  async completeReactivation(
    environmentIdInput: unknown,
    request: ControlTenantDisasterRecoveryReactivationObservationRequest
  ) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const runtimeGeneration = positiveInteger(
      request.runtimeGeneration,
      'control_tenant_dr_reactivation_generation_invalid'
    );
    const current = await this.required(environmentId, recoveryOperationId);
    if (
      current.state !== 'reactivating' ||
      request.pinnedRouteGeneration !== current.pinnedRouteGeneration ||
      runtimeGeneration <= (current.denyRuntimeGeneration ?? 0)
    ) {
      throw new Error('control_tenant_dr_reactivation_observation_invalid');
    }
    const now = this.now();
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_tenant_disaster_recovery_operations
              SET recovery_state = 'succeeded', active_operation_key = NULL,
                  reactivated_runtime_generation = ?, reactivated_at = ?, completed_at = ?,
                  updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND recovery_state = 'reactivating'`
        )
        .bind(runtimeGeneration, now, now, now, environmentId, recoveryOperationId),
      this.db
        .prepare(
          `UPDATE control_operations SET status = 'succeeded', completed_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND status = 'running'`
        )
        .bind(now, now, environmentId, recoveryOperationId),
      this.completeStep(recoveryOperationId, 'reactivate_route', now),
    ]);
    if (result[0]?.meta.changes !== 1) throw new Error('control_tenant_dr_reactivation_conflict');
    return this.required(environmentId, recoveryOperationId);
  }

  async cancel(environmentIdInput: unknown, request: ControlTenantDisasterRecoveryCancelRequest) {
    const environmentId = id(environmentIdInput);
    const recoveryOperationId = id(request.operationId);
    const requestedById = id(request.requestedById);
    const idempotencyKey = id(request.idempotencyKey);
    if (request.reasonCode !== 'operator_cancel_before_deny') {
      throw new Error('invalid_tenant_disaster_recovery_request');
    }
    const current = await this.required(environmentId, recoveryOperationId);
    const command = await this.commandIdempotency(environmentId, recoveryOperationId);
    if (current.state === 'canceled') {
      if (
        command.cancel_idempotency_key === idempotencyKey &&
        command.cancel_requested_by === requestedById
      )
        return current;
      throw new Error('control_tenant_dr_cancel_idempotency_conflict');
    }
    if (!current.canCancel) throw new Error('control_tenant_dr_cancel_not_allowed');
    const now = this.now();
    const result = await this.db.batch([
      this.db
        .prepare(
          `UPDATE control_tenant_disaster_recovery_operations
              SET recovery_state = 'canceled', active_operation_key = NULL,
                  cancel_idempotency_key = ?, cancel_requested_by = ?,
                  completed_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ?
              AND recovery_state = 'publishing_deny' AND deny_observed_at IS NULL
              AND cancel_idempotency_key IS NULL`
        )
        .bind(idempotencyKey, requestedById, now, now, environmentId, recoveryOperationId),
      this.db
        .prepare(
          `UPDATE control_operations SET status = 'blocked', updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
                 WHERE recovery.operation_id = ? AND recovery.environment_id = ?
                   AND recovery.cancel_idempotency_key = ?
                   AND recovery.cancel_requested_by = ?
              )`
        )
        .bind(
          now,
          environmentId,
          recoveryOperationId,
          recoveryOperationId,
          environmentId,
          idempotencyKey,
          requestedById
        ),
      this.db
        .prepare(
          `UPDATE control_operations SET status = 'canceled', completed_at = ?, updated_at = ?
            WHERE environment_id = ? AND operation_id = ? AND status = 'blocked'
              AND EXISTS (
                SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
                 WHERE recovery.operation_id = ? AND recovery.environment_id = ?
                   AND recovery.cancel_idempotency_key = ?
                   AND recovery.cancel_requested_by = ?
              )`
        )
        .bind(
          now,
          now,
          environmentId,
          recoveryOperationId,
          recoveryOperationId,
          environmentId,
          idempotencyKey,
          requestedById
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps SET status = 'blocked', updated_at = ?
            WHERE operation_id = ? AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
                 WHERE recovery.operation_id = ? AND recovery.environment_id = ?
                   AND recovery.cancel_idempotency_key = ?
                   AND recovery.cancel_requested_by = ?
              )`
        )
        .bind(
          now,
          recoveryOperationId,
          recoveryOperationId,
          environmentId,
          idempotencyKey,
          requestedById
        ),
      this.db
        .prepare(
          `UPDATE control_operation_steps SET status = 'canceled', completed_at = ?, updated_at = ?
            WHERE operation_id = ? AND status IN ('queued', 'waiting_retry', 'blocked')
              AND EXISTS (
                SELECT 1 FROM control_tenant_disaster_recovery_operations recovery
                 WHERE recovery.operation_id = ? AND recovery.environment_id = ?
                   AND recovery.cancel_idempotency_key = ?
                   AND recovery.cancel_requested_by = ?
              )`
        )
        .bind(
          now,
          now,
          recoveryOperationId,
          recoveryOperationId,
          environmentId,
          idempotencyKey,
          requestedById
        ),
      this.audit(
        recoveryOperationId,
        environmentId,
        'control.tenant_dr.canceled_before_deny',
        requestedById,
        recoveryOperationId,
        'succeeded',
        {},
        now
      ),
    ]);
    if (result[0]?.meta.changes !== 1) throw new Error('control_tenant_dr_cancel_not_allowed');
    return this.required(environmentId, recoveryOperationId);
  }

  private async lookupWork(
    environmentId: string,
    recoveryOperationId: string
  ): Promise<ControlTenantDisasterRecoveryLookupWork> {
    const row = await this.db
      .prepare(
        `SELECT * FROM control_tenant_disaster_recovery_operations
          WHERE environment_id = ? AND operation_id = ?`
      )
      .bind(environmentId, recoveryOperationId)
      .first<RecoveryRow>();
    if (
      !row ||
      row.recovery_state !== 'reprojecting_lookup' ||
      !row.lookup_reprojection_registry_digest ||
      !SHA256.test(row.lookup_reprojection_registry_digest) ||
      !row.lookup_reprojection_shard_count ||
      row.lookup_reprojection_shard_count < 1 ||
      !row.lookup_reprojection_lease_owner ||
      !row.lookup_reprojection_lease_expires_at
    ) {
      throw new Error('control_tenant_dr_lookup_work_unavailable');
    }
    const targets = (await this.targets(environmentId, recoveryOperationId)).map(target);
    return {
      operationId: row.operation_id,
      environmentId: row.environment_id,
      tenantId: row.tenant_id,
      pinnedRouteGeneration: Number(row.pinned_route_generation),
      registryDigest: row.lookup_reprojection_registry_digest,
      lookupShardCount: Number(row.lookup_reprojection_shard_count),
      ownerId: row.lookup_reprojection_lease_owner,
      fencingToken: Number(row.lookup_reprojection_fencing_token),
      leaseExpiresAt: Number(row.lookup_reprojection_lease_expires_at),
      progress: {
        stage: row.lookup_reprojection_stage,
        targetIndex: Number(row.lookup_reprojection_target_index),
        afterCreatedAt: Number(row.lookup_reprojection_after_created_at),
        afterId: row.lookup_reprojection_after_id,
        afterRowId: Number(row.lookup_reprojection_after_row_id),
        projectedRows: Number(row.lookup_reprojection_projected_rows),
        verifiedRows: Number(row.lookup_reprojection_verified_rows),
        registryDigestPinned: true,
      },
      targets,
    };
  }

  private async required(environmentId: string, recoveryOperationId: string) {
    const result = await this.get(environmentId, recoveryOperationId);
    if (!result) throw new Error('control_tenant_dr_operation_not_found');
    return result;
  }

  private async commandIdempotency(environmentId: string, recoveryOperationId: string) {
    const row = await this.db
      .prepare(
        `SELECT recovery_state, restore_reference_digest, restored_at, restore_confirmed_by,
                restore_idempotency_key, reactivation_requested_by,
                reactivation_idempotency_key, cancel_requested_by, cancel_idempotency_key
           FROM control_tenant_disaster_recovery_operations
          WHERE environment_id = ? AND operation_id = ?`
      )
      .bind(environmentId, recoveryOperationId)
      .first<RecoveryCommandIdempotencyRow>();
    if (!row) throw new Error('control_tenant_dr_operation_not_found');
    return row;
  }

  private async targets(environmentId: string, recoveryOperationId: string) {
    const result = await this.db
      .prepare(
        `SELECT shard_id, data_role, residency_partition, assignment_generation,
                shard_generation, binding_ref, provider_database_id, migration_stream_id,
                release_id, manifest_digest, restore_confirmed_at, migration_verified_at,
                lookup_reprojected_at, binding_smoke_verified_at
           FROM control_tenant_disaster_recovery_targets
          WHERE environment_id = ? AND operation_id = ?
          ORDER BY data_role, residency_partition, shard_id`
      )
      .bind(environmentId, recoveryOperationId)
      .all<TargetRow>();
    return result.results;
  }

  private async expectedBindingTargets(
    environmentId: string,
    recoveryOperationId: string
  ): Promise<RecoveryBindingTargetRow[]> {
    const result = await this.db
      .prepare(
        `SELECT inventory.worker_script_name, target.shard_id, target.binding_ref,
                target.data_role, target.residency_partition,
                target.shard_generation AS migration_generation,
                target.provider_database_id
           FROM control_tenant_disaster_recovery_targets target
           JOIN control_worker_required_data_roles required
             ON required.environment_id = target.environment_id
            AND required.data_role = target.data_role
           JOIN control_desired_worker_inventory inventory
             ON inventory.environment_id = required.environment_id
            AND inventory.worker_script_name = required.worker_script_name
            AND inventory.status = 'active'
          WHERE target.environment_id = ? AND target.operation_id = ?
          ORDER BY inventory.worker_script_name, target.binding_ref`
      )
      .bind(environmentId, recoveryOperationId)
      .all<RecoveryBindingTargetRow>();
    return result.results;
  }

  private async assertBindingSmokeComplete(
    environmentId: string,
    recoveryOperationId: string,
    expected: RecoveryBindingTargetRow[]
  ): Promise<void> {
    if (expected.length === 0) throw new Error('control_tenant_dr_binding_targets_missing');
    const actual = await this.db
      .prepare(
        `SELECT worker_script_name, shard_id, binding_ref, data_role, residency_partition,
                migration_generation, provider_database_id, state
           FROM control_worker_binding_reconciliations
          WHERE environment_id = ? AND operation_id = ?
          ORDER BY worker_script_name, binding_ref`
      )
      .bind(environmentId, recoveryOperationId)
      .all<RecoveryBindingTargetRow>();
    if (actual.results.length !== expected.length) {
      throw new Error('control_tenant_dr_binding_smoke_incomplete');
    }
    for (let index = 0; index < expected.length; index += 1) {
      const left = actual.results[index];
      const right = expected[index];
      if (
        !left ||
        !right ||
        left.worker_script_name !== right.worker_script_name ||
        left.shard_id !== right.shard_id ||
        left.binding_ref !== right.binding_ref ||
        left.data_role !== right.data_role ||
        left.residency_partition !== right.residency_partition ||
        Number(left.migration_generation) !== Number(right.migration_generation) ||
        left.provider_database_id !== right.provider_database_id
      ) {
        throw new Error('control_tenant_dr_binding_target_mismatch');
      }
      if (left.state !== 'succeeded') {
        throw new Error('control_tenant_dr_binding_smoke_incomplete');
      }
    }
    const steps = await this.db
      .prepare(
        `SELECT step_key, status
           FROM control_operation_steps
          WHERE operation_id = ? AND step_key IN (
            'reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings'
          )
          ORDER BY step_key`
      )
      .bind(recoveryOperationId)
      .all<{ step_key: string; status: string }>();
    if (steps.results.length !== 3 || steps.results.some((step) => step.status !== 'succeeded')) {
      throw new Error('control_tenant_dr_binding_smoke_incomplete');
    }
  }

  private startStep(recoveryOperationId: string, stepKey: string, now: number) {
    return this.db
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND step_key = ? AND status IN ('queued', 'waiting_retry', 'blocked')`
      )
      .bind(now, now, recoveryOperationId, stepKey);
  }

  private completeStep(recoveryOperationId: string, stepKey: string, now: number) {
    return this.db
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'succeeded',
                progress_current = CASE
                  WHEN progress_total IS NULL THEN progress_current ELSE progress_total
                END,
                completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND step_key = ? AND status = 'running'`
      )
      .bind(now, now, recoveryOperationId, stepKey);
  }

  private audit(
    recoveryOperationId: string,
    environmentId: string,
    eventType: string,
    actorId: string,
    resourceId: string,
    outcome: 'succeeded' | 'blocked',
    payload: Record<string, unknown>,
    now: number
  ) {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_events (
           event_id, environment_id, operation_id, event_type, actor_type, actor_id,
           resource_kind, resource_id, outcome, redacted_payload_json, created_at
         ) VALUES (?, ?, ?, ?, 'admin', ?, 'tenant', ?, ?, ?, ?)`
      )
      .bind(
        `audit:${recoveryOperationId}:${eventType}`,
        environmentId,
        recoveryOperationId,
        eventType,
        actorId,
        resourceId,
        outcome,
        JSON.stringify(payload),
        now
      );
  }
}

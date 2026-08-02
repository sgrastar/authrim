import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { TenantPlacementLookupCutoverCursor } from './tenant-placement-lookup-cutover';

export const TENANT_PLACEMENT_MIGRATION_STEPS = [
  'wait_control',
  'begin_route_cutover',
  'prepare_lookup',
  'prepare_alias',
  'commit_control',
  'publish_registry',
  'activate_alias',
  'activate_lookup',
  'verify_routes',
  'finalize_source',
  'complete',
] as const;

export type TenantPlacementMigrationStep = (typeof TENANT_PLACEMENT_MIGRATION_STEPS)[number];
export type TenantPlacementMigrationJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'blocked'
  | 'succeeded'
  | 'canceled';

const LEASE_SECONDS = 60;

interface JobRow {
  operation_id: string;
  environment_id: string;
  tenant_id: string;
  control_operation_id: string;
  target_isolation_policy: 'tenant_exclusive';
  status: TenantPlacementMigrationJobStatus;
  current_step: TenantPlacementMigrationStep;
  lookup_cursor_json: string | null;
  lookup_prepared_row_count: number;
  lookup_activated_row_count: number;
  lookup_verified_row_count: number;
  request_hash: string;
  idempotency_key: string;
  attempt_count: number;
  retry_budget_started_at: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  fencing_token: number;
  requested_by: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

export interface TenantPlacementMigrationJobView {
  operationId: string;
  environmentId: string;
  tenantId: string;
  controlOperationId: string;
  targetIsolationPolicy: 'tenant_exclusive';
  status: TenantPlacementMigrationJobStatus;
  currentStep: TenantPlacementMigrationStep;
  lookupCursor: TenantPlacementLookupCutoverCursor | null;
  lookupPreparedRowCount: number;
  lookupActivatedRowCount: number;
  lookupVerifiedRowCount: number;
  requestHash: string;
  idempotencyKey: string;
  attemptCount: number;
  retryBudgetStartedAt: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  fencingToken: number;
  requestedBy: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface TenantPlacementMigrationJobLease {
  job: TenantPlacementMigrationJobView;
  ownerId: string;
  fencingToken: number;
}

function cursor(value: string | null): TenantPlacementLookupCutoverCursor | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('tenant_placement_migration_job_cursor_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tenant_placement_migration_job_cursor_invalid');
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    typeof candidate.rangesDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate.rangesDigest) ||
    !Number.isSafeInteger(candidate.rangeIndex) ||
    Number(candidate.rangeIndex) < 0 ||
    !Number.isSafeInteger(candidate.rowId) ||
    Number(candidate.rowId) < 0
  ) {
    throw new Error('tenant_placement_migration_job_cursor_invalid');
  }
  return candidate as unknown as TenantPlacementLookupCutoverCursor;
}

function view(row: JobRow): TenantPlacementMigrationJobView {
  return {
    operationId: row.operation_id,
    environmentId: row.environment_id,
    tenantId: row.tenant_id,
    controlOperationId: row.control_operation_id,
    targetIsolationPolicy: row.target_isolation_policy,
    status: row.status,
    currentStep: row.current_step,
    lookupCursor: cursor(row.lookup_cursor_json),
    lookupPreparedRowCount: Number(row.lookup_prepared_row_count),
    lookupActivatedRowCount: Number(row.lookup_activated_row_count),
    lookupVerifiedRowCount: Number(row.lookup_verified_row_count),
    requestHash: row.request_hash,
    idempotencyKey: row.idempotency_key,
    attemptCount: Number(row.attempt_count),
    retryBudgetStartedAt: Number(row.retry_budget_started_at),
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    fencingToken: Number(row.fencing_token),
    requestedBy: row.requested_by,
    createdAt: Number(row.created_at),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: Number(row.updated_at),
  };
}

export class TenantPlacementMigrationJobRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async get(
    operationId: string,
    environmentId: string
  ): Promise<TenantPlacementMigrationJobView | null> {
    const row = await this.db.queryOne<JobRow>(
      `SELECT * FROM tenant_placement_migration_jobs
        WHERE operation_id = ? AND environment_id = ?`,
      [operationId, environmentId]
    );
    return row ? view(row) : null;
  }

  async getActiveByTenant(
    tenantId: string,
    environmentId: string
  ): Promise<TenantPlacementMigrationJobView | null> {
    const row = await this.db.queryOne<JobRow>(
      `SELECT * FROM tenant_placement_migration_jobs
        WHERE tenant_id = ? AND environment_id = ? AND active_job_key = 'active'`,
      [tenantId, environmentId]
    );
    return row ? view(row) : null;
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
    environmentId: string
  ): Promise<TenantPlacementMigrationJobView | null> {
    const row = await this.db.queryOne<JobRow>(
      `SELECT * FROM tenant_placement_migration_jobs
        WHERE idempotency_key = ? AND environment_id = ?`,
      [idempotencyKey, environmentId]
    );
    return row ? view(row) : null;
  }

  async getLatestByTenant(
    tenantId: string,
    environmentId: string
  ): Promise<TenantPlacementMigrationJobView | null> {
    const row = await this.db.queryOne<JobRow>(
      `SELECT * FROM tenant_placement_migration_jobs
        WHERE tenant_id = ? AND environment_id = ?
        ORDER BY created_at DESC, operation_id DESC LIMIT 1`,
      [tenantId, environmentId]
    );
    return row ? view(row) : null;
  }

  async create(input: {
    operationId: string;
    environmentId: string;
    tenantId: string;
    controlOperationId: string;
    requestHash: string;
    idempotencyKey: string;
    requestedBy: string;
    now: number;
  }): Promise<TenantPlacementMigrationJobView> {
    await this.db.execute(
      `INSERT INTO tenant_placement_migration_jobs (
         operation_id, environment_id, tenant_id, control_operation_id,
         target_isolation_policy, status, current_step, request_hash, idempotency_key,
         retry_budget_started_at, requested_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'tenant_exclusive', 'queued', 'wait_control', ?, ?, ?, ?, ?, ?)`,
      [
        input.operationId,
        input.environmentId,
        input.tenantId,
        input.controlOperationId,
        input.requestHash,
        input.idempotencyKey,
        input.now,
        input.requestedBy,
        input.now,
        input.now,
      ]
    );
    const created = await this.get(input.operationId, input.environmentId);
    if (!created) throw new Error('tenant_placement_migration_job_create_failed');
    return created;
  }

  async claimNext(
    environmentId: string,
    ownerId: string,
    now: number
  ): Promise<TenantPlacementMigrationJobLease | null> {
    const candidate = await this.db.queryOne<{ operation_id: string }>(
      `SELECT operation_id FROM tenant_placement_migration_jobs
        WHERE environment_id = ? AND status IN ('queued', 'waiting_retry', 'running')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY created_at, operation_id LIMIT 1`,
      [environmentId, now, now]
    );
    if (!candidate) return null;
    const claimed = await this.db.execute(
      `UPDATE tenant_placement_migration_jobs
          SET status = 'running', attempt_count = attempt_count + 1,
              next_attempt_at = NULL, last_error_code = NULL,
              lease_owner = ?, lease_expires_at = ?, fencing_token = fencing_token + 1,
              started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE operation_id = ? AND environment_id = ?
          AND status IN ('queued', 'waiting_retry', 'running')
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      [ownerId, now + LEASE_SECONDS, now, now, candidate.operation_id, environmentId, now]
    );
    if (claimed.rowsAffected !== 1) return null;
    const job = await this.get(candidate.operation_id, environmentId);
    return job ? { job, ownerId, fencingToken: job.fencingToken } : null;
  }

  async cancel(
    operationId: string,
    environmentId: string,
    now: number
  ): Promise<TenantPlacementMigrationJobView> {
    const result = await this.db.execute(
      `UPDATE tenant_placement_migration_jobs
          SET status = 'canceled', active_job_key = NULL, next_attempt_at = NULL,
              lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
        WHERE operation_id = ? AND environment_id = ?
          AND status IN ('queued', 'running', 'waiting_retry', 'blocked')`,
      [now, now, operationId, environmentId]
    );
    const job = await this.get(operationId, environmentId);
    if (!job || (result.rowsAffected !== 1 && job.status !== 'canceled')) {
      throw new Error('tenant_placement_migration_job_cancel_conflict');
    }
    return job;
  }

  async checkpoint(
    lease: TenantPlacementMigrationJobLease,
    input: {
      currentStep: TenantPlacementMigrationStep;
      nextStep?: TenantPlacementMigrationStep;
      status: TenantPlacementMigrationJobStatus;
      now: number;
      nextAttemptAt?: number | null;
      errorCode?: string | null;
      lookupCursor?: TenantPlacementLookupCutoverCursor | null;
      processedLookupRows?: number;
      lookupCounter?: 'prepared' | 'activated' | 'verified';
    }
  ): Promise<void> {
    const terminal = input.status === 'succeeded' || input.status === 'canceled';
    const result = await this.db.execute(
      `UPDATE tenant_placement_migration_jobs
          SET status = ?, current_step = ?, next_attempt_at = ?, last_error_code = ?,
              lookup_cursor_json = CASE WHEN ? = 1 THEN ? ELSE lookup_cursor_json END,
              lookup_prepared_row_count = lookup_prepared_row_count + ?,
              lookup_activated_row_count = lookup_activated_row_count + ?,
              lookup_verified_row_count = lookup_verified_row_count + ?,
              lease_owner = CASE WHEN ? = 'running' THEN lease_owner ELSE NULL END,
              lease_expires_at = CASE WHEN ? = 'running' THEN ? ELSE NULL END,
              active_job_key = CASE WHEN ? THEN NULL ELSE active_job_key END,
              completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
              updated_at = ?
        WHERE operation_id = ? AND environment_id = ?
          AND current_step = ? AND lease_owner = ? AND fencing_token = ?`,
      [
        input.status,
        input.nextStep ?? input.currentStep,
        input.nextAttemptAt ?? null,
        input.errorCode ?? null,
        input.lookupCursor !== undefined ? 1 : 0,
        input.lookupCursor ? JSON.stringify(input.lookupCursor) : null,
        input.lookupCounter === 'prepared' ? (input.processedLookupRows ?? 0) : 0,
        input.lookupCounter === 'activated' ? (input.processedLookupRows ?? 0) : 0,
        input.lookupCounter === 'verified' ? (input.processedLookupRows ?? 0) : 0,
        input.status,
        input.status,
        input.now + LEASE_SECONDS,
        terminal ? 1 : 0,
        terminal ? 1 : 0,
        input.now,
        input.now,
        lease.job.operationId,
        lease.job.environmentId,
        input.currentStep,
        lease.ownerId,
        lease.fencingToken,
      ]
    );
    if (result.rowsAffected !== 1) {
      throw new Error('tenant_placement_migration_job_stale_lease');
    }
  }
}

import type { DatabaseAdapter } from '../../db/adapter';

export type TenantBackupOperationState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled';
export interface TenantBackupOperation {
  id: string;
  tenant_id: string;
  kind: 'export' | 'import';
  idempotency_key: string;
  request_digest: string;
  state: TenantBackupOperationState;
  phase: string;
  cursor_json: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  revision: number;
  fencing_token: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  failure_count: number;
  last_error_code: string | null;
  /**
   * The permanent failure that stopped the operation. Cleanup then finishes it as 'failed'; an
   * import past its last cleanable phase keeps retrying and only shows the reason.
   */
  failure_reason?: TenantBackupPermanentFailure | null;
}

/**
 * Step errors that retrying cannot fix. Where cleanup can undo the work so far (see
 * canCleanUpTenantBackupFailure), the scheduler cleans such an operation up like a cancellation
 * instead of retrying it, and keeps the code as the failure reason.
 */
export const TENANT_BACKUP_PERMANENT_FAILURES = [
  'backup_export_too_large',
  'backup_artifact_too_large',
  'backup_sqlite_row_too_large',
] as const;
export type TenantBackupPermanentFailure = (typeof TENANT_BACKUP_PERMANENT_FAILURES)[number];

export function isTenantBackupPermanentFailure(code: string): code is TenantBackupPermanentFailure {
  return (TENANT_BACKUP_PERMANENT_FAILURES as readonly string[]).includes(code);
}

/** Import phases before anything is written to a restore target. */
export const TENANT_BACKUP_IMPORT_PRE_WRITE_PHASES = [
  'prepare',
  'decode_input',
  'validate_input_modules',
  'validate_sqlite_dataset',
  'advance_validation_dataset',
  'validate_input_references',
  'finalize_input_validation',
] as const;

/**
 * Import phases that cleanup can undo: until the SQL restore ends it has written only to its SQL
 * restore targets, which cleanup discards with the restored tenant. From `restore_other_stores` on
 * it also writes KV, R2, Durable Objects and keys, and later activates the tenant; an import there
 * can be neither cancelled nor cleaned up after a permanent failure.
 */
export const TENANT_BACKUP_IMPORT_CLEANABLE_PHASES = [
  ...TENANT_BACKUP_IMPORT_PRE_WRITE_PHASES,
  'prepare_restore_plan',
  'await_restore_approval',
  'start_sqlite_restore_sequence',
  'apply_sqlite_dataset',
  'apply_sqlite_dataset_deferred',
  'verify_sqlite_dataset',
  'advance_restore_dataset',
] as const;

/** Whether a permanent failure in this operation's current phase can be cleaned up. */
export function canCleanUpTenantBackupFailure(
  operation: Pick<TenantBackupOperation, 'kind' | 'phase'>
): boolean {
  return (
    operation.kind === 'export' ||
    (TENANT_BACKUP_IMPORT_CLEANABLE_PHASES as readonly string[]).includes(operation.phase)
  );
}
const CLEANABLE_PHASES_SQL = TENANT_BACKUP_IMPORT_CLEANABLE_PHASES.map(
  (phase) => `'${phase}'`
).join(',');
export interface TenantBackupLease {
  tenantId: string;
  operationId: string;
  owner: string;
  fencingToken: number;
}
// Snapshot admission validates every installed dataset and starts every physical database.
// Large tenants can legitimately need more than 30 seconds for that single fenced slice.
const LEASE_MS = 180_000;
function identifier(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value))
    throw new Error('invalid_backup_operation_identifier');
}
function time(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - LEASE_MS)
    throw new Error('invalid_backup_operation_time');
}
function leaseValues(lease: TenantBackupLease): void {
  identifier(lease.tenantId);
  identifier(lease.operationId);
  identifier(lease.owner);
  if (!Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 1)
    throw new Error('invalid_backup_operation_fence');
}

/** Atomic coordination only; callers still enforce authorization and actual store write fences. */
export class TenantBackupOperationStore {
  constructor(private readonly database: Pick<DatabaseAdapter, 'queryOne' | 'execute'>) {}

  async create(input: {
    id: string;
    tenantId: string;
    kind: 'export' | 'import';
    idempotencyKey: string;
    requestDigest: string;
    actorId: string;
    now: number;
  }): Promise<TenantBackupOperation> {
    for (const value of [input.id, input.tenantId, input.idempotencyKey, input.actorId])
      identifier(value);
    time(input.now);
    if (!['export', 'import'].includes(input.kind) || !/^[0-9a-f]{64}$/.test(input.requestDigest))
      throw new Error('invalid_backup_operation_request');
    await this.database.execute(
      `INSERT INTO tenant_backup_operations
      (id,tenant_id,kind,idempotency_key,request_digest,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
      [
        input.id,
        input.tenantId,
        input.kind,
        input.idempotencyKey,
        input.requestDigest,
        input.actorId,
        input.now,
        input.now,
      ]
    );
    const operation = await this.database.queryOne<TenantBackupOperation>(
      'SELECT * FROM tenant_backup_operations WHERE tenant_id=? AND idempotency_key=?',
      [input.tenantId, input.idempotencyKey]
    );
    if (
      !operation ||
      operation.kind !== input.kind ||
      operation.request_digest !== input.requestDigest ||
      operation.created_by !== input.actorId
    )
      throw new Error('backup_operation_idempotency_conflict');
    return operation;
  }

  async get(tenantId: string, operationId: string): Promise<TenantBackupOperation | null> {
    identifier(tenantId);
    identifier(operationId);
    return this.database.queryOne(
      'SELECT * FROM tenant_backup_operations WHERE tenant_id=? AND id=?',
      [tenantId, operationId]
    );
  }

  async claim(
    tenantId: string,
    operationId: string,
    owner: string,
    now: number
  ): Promise<TenantBackupOperation | null> {
    identifier(tenantId);
    identifier(operationId);
    identifier(owner);
    time(now);
    return this.database.queryOne(
      `UPDATE tenant_backup_operations
      SET state='running', lease_owner=?, lease_expires_at=?, fencing_token=fencing_token+1, revision=revision+1, updated_at=?
      WHERE tenant_id=? AND id=? AND updated_at<=? AND next_attempt_at<=? AND
        (state='queued' OR (state='running' AND lease_expires_at<=?)) RETURNING *`,
      [owner, now + LEASE_MS, now, tenantId, operationId, now, now, now]
    );
  }

  /** Persist retry delay without advancing the last successful cursor. */
  /**
   * `reason` records a permanent failure that could not be cleaned up, so it stays visible while
   * the operation retries. A cleanup retry keeps the reason it is cleaning up for.
   */
  async retryFailure(
    lease: TenantBackupLease,
    revision: number,
    now: number,
    reason: TenantBackupPermanentFailure | null = null
  ): Promise<TenantBackupOperation | null> {
    leaseValues(lease);
    time(now);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      now > Number.MAX_SAFE_INTEGER - 60_000 ||
      (reason !== null && !isTenantBackupPermanentFailure(reason))
    )
      throw new Error('invalid_backup_operation_retry');
    return this.database.queryOne(
      `UPDATE tenant_backup_operations
      SET state=CASE WHEN state='cancelling' THEN 'cancelling' WHEN failure_count>=7 THEN 'waiting' ELSE 'queued' END,
      next_attempt_at=?+MIN(60000,1000*(1 << MIN(failure_count,6))),failure_count=failure_count+1,
      last_error_code='backup_operation_slice_failed',
      failure_reason=CASE WHEN state='cancelling' THEN failure_reason ELSE coalesce(?, failure_reason) END,
      lease_owner=NULL,lease_expires_at=NULL,
      revision=revision+1,fencing_token=fencing_token+1,updated_at=?
      WHERE tenant_id=? AND id=? AND state IN ('running','cancelling') AND lease_owner=?
      AND fencing_token=? AND revision=? AND lease_expires_at>? AND updated_at<=? RETURNING *`,
      [
        now,
        reason,
        now,
        lease.tenantId,
        lease.operationId,
        lease.owner,
        lease.fencingToken,
        revision,
        now,
        now,
      ]
    );
  }

  async checkpoint(
    lease: TenantBackupLease,
    revision: number,
    phase: string,
    cursor: string | null,
    now: number
  ): Promise<TenantBackupOperation | null> {
    return this.writeCheckpoint(lease, revision, phase, cursor, now, 'running');
  }

  async checkpointCancellation(
    lease: TenantBackupLease,
    revision: number,
    cursor: string | null,
    now: number
  ): Promise<TenantBackupOperation | null> {
    return this.writeCheckpoint(lease, revision, 'cleanup', cursor, now, 'cancelling');
  }

  private async writeCheckpoint(
    lease: TenantBackupLease,
    revision: number,
    phase: string,
    cursor: string | null,
    now: number,
    state: 'running' | 'cancelling'
  ): Promise<TenantBackupOperation | null> {
    leaseValues(lease);
    time(now);
    identifier(phase);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      (cursor !== null && (typeof cursor !== 'string' || cursor.length > 16384))
    )
      throw new Error('invalid_backup_operation_checkpoint');
    if (cursor !== null) {
      try {
        JSON.parse(cursor);
      } catch {
        throw new Error('invalid_backup_operation_checkpoint');
      }
    }
    return this.database.queryOne(
      `UPDATE tenant_backup_operations SET phase=?,cursor_json=?,revision=revision+1,updated_at=?,lease_expires_at=?,failure_count=0,last_error_code=NULL,next_attempt_at=0,
      failure_reason=CASE WHEN state='cancelling' THEN failure_reason ELSE NULL END
      WHERE tenant_id=? AND id=? AND state=? AND lease_owner=? AND fencing_token=? AND revision=? AND lease_expires_at>? AND updated_at<=? RETURNING *`,
      [
        phase,
        cursor,
        now,
        now + LEASE_MS,
        lease.tenantId,
        lease.operationId,
        state,
        lease.owner,
        lease.fencingToken,
        revision,
        now,
        now,
      ]
    );
  }

  /** Cleanup has its own claim path and can never return to ordinary capture/apply work. */
  async claimCancellation(
    tenantId: string,
    operationId: string,
    owner: string,
    now: number
  ): Promise<TenantBackupOperation | null> {
    identifier(tenantId);
    identifier(operationId);
    identifier(owner);
    time(now);
    return this.database.queryOne(
      `UPDATE tenant_backup_operations
      SET lease_owner=?,lease_expires_at=?,fencing_token=fencing_token+1,revision=revision+1,updated_at=?
      WHERE tenant_id=? AND id=? AND state='cancelling' AND updated_at<=? AND next_attempt_at<=?
        AND (lease_owner IS NULL OR lease_expires_at<=?) RETURNING *`,
      [owner, now + LEASE_MS, now, tenantId, operationId, now, now, now]
    );
  }

  /**
   * The executor calls this only after verifying that every owned resource was cleaned up. A
   * permanently failed operation ends as 'failed' (its reason kept), any other as 'cancelled'.
   */
  async finishCancellation(
    lease: TenantBackupLease,
    revision: number,
    now: number
  ): Promise<TenantBackupOperation | null> {
    leaseValues(lease);
    time(now);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid_backup_operation_revision');
    return this.database.queryOne(
      `UPDATE tenant_backup_operations
      SET state=CASE WHEN failure_reason IS NULL THEN 'cancelled' ELSE 'failed' END,
      lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,revision=revision+1,updated_at=?
      WHERE tenant_id=? AND id=? AND state='cancelling' AND lease_owner=? AND fencing_token=? AND revision=? AND lease_expires_at>? AND updated_at<=? RETURNING *`,
      [now, lease.tenantId, lease.operationId, lease.owner, lease.fencingToken, revision, now, now]
    );
  }

  /**
   * Give up on a running operation that can never succeed: record why and hand it to the same
   * cleanup a cancellation gets, so partial artifacts, spills and staging are removed. Only an
   * export or an import in a cleanable phase qualifies.
   */
  async failPermanently(
    lease: TenantBackupLease,
    revision: number,
    reason: TenantBackupPermanentFailure,
    now: number
  ): Promise<TenantBackupOperation | null> {
    leaseValues(lease);
    time(now);
    if (!Number.isSafeInteger(revision) || revision < 0 || !isTenantBackupPermanentFailure(reason))
      throw new Error('invalid_backup_operation_failure');
    return this.database.queryOne(
      `UPDATE tenant_backup_operations
      SET state='cancelling',phase='cleanup',cursor_json=NULL,failure_reason=?,failure_count=0,
      last_error_code=NULL,next_attempt_at=0,lease_owner=NULL,lease_expires_at=NULL,
      fencing_token=fencing_token+1,revision=revision+1,updated_at=?
      WHERE tenant_id=? AND id=? AND state='running' AND (kind='export' OR phase IN (${CLEANABLE_PHASES_SQL}))
      AND lease_owner=? AND fencing_token=? AND revision=? AND lease_expires_at>? AND updated_at<=? RETURNING *`,
      [
        reason,
        now,
        lease.tenantId,
        lease.operationId,
        lease.owner,
        lease.fencingToken,
        revision,
        now,
        now,
      ]
    );
  }

  async yieldCancellation(
    lease: TenantBackupLease,
    revision: number,
    now: number
  ): Promise<TenantBackupOperation | null> {
    return this.releaseLease(lease, revision, 'cancelling', 'cancelling', now);
  }

  /** Persists a pause/plan/failure; never marks a restore completed or activates a tenant. */
  async release(
    lease: TenantBackupLease,
    revision: number,
    state: 'queued' | 'waiting' | 'ready' | 'failed',
    now: number
  ): Promise<TenantBackupOperation | null> {
    if (!['queued', 'waiting', 'ready', 'failed'].includes(state))
      throw new Error('invalid_backup_operation_transition');
    return this.releaseLease(lease, revision, 'running', state, now);
  }

  private async releaseLease(
    lease: TenantBackupLease,
    revision: number,
    from: 'running' | 'cancelling',
    to: 'queued' | 'waiting' | 'ready' | 'failed' | 'cancelling' | 'cancelled',
    now: number
  ): Promise<TenantBackupOperation | null> {
    leaseValues(lease);
    time(now);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('invalid_backup_operation_revision');
    return this.database.queryOne(
      `UPDATE tenant_backup_operations
      SET state=?,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,revision=revision+1,updated_at=?
      WHERE tenant_id=? AND id=? AND state=? AND lease_owner=? AND fencing_token=? AND revision=? AND lease_expires_at>? AND updated_at<=? RETURNING *`,
      [
        to,
        now,
        lease.tenantId,
        lease.operationId,
        from,
        lease.owner,
        lease.fencingToken,
        revision,
        now,
        now,
      ]
    );
  }

  /** Only explicit authorized input can resume a waiting operation; a scheduler cannot claim it. */
  async resumeWaiting(
    tenantId: string,
    operationId: string,
    revision: number,
    requestDigest: string,
    now: number
  ): Promise<TenantBackupOperation | null> {
    identifier(tenantId);
    identifier(operationId);
    time(now);
    if (!Number.isSafeInteger(revision) || revision < 0 || !/^[0-9a-f]{64}$/.test(requestDigest))
      throw new Error('invalid_backup_operation_resume');
    return this.database.queryOne(
      `UPDATE tenant_backup_operations SET state='queued',revision=revision+1,updated_at=?,failure_count=0,last_error_code=NULL,failure_reason=NULL,next_attempt_at=0
      WHERE tenant_id=? AND id=? AND state='waiting' AND revision=? AND request_digest=? AND updated_at<=? RETURNING *`,
      [now, tenantId, operationId, revision, requestDigest, now]
    );
  }

  /**
   * Persist cancellation and invalidate the old worker immediately. Cleanup gets a later lease. An
   * import is cancellable only in a cleanable phase and before it is ready.
   */
  async requestCancel(
    tenantId: string,
    operationId: string,
    now: number
  ): Promise<TenantBackupOperation | null> {
    identifier(tenantId);
    identifier(operationId);
    time(now);
    return this.database.queryOne(
      `UPDATE tenant_backup_operations
      SET next_attempt_at=0,failure_count=0,last_error_code=NULL,failure_reason=NULL,state='cancelling',phase='cleanup',cursor_json=NULL,lease_owner=NULL,lease_expires_at=NULL,fencing_token=fencing_token+1,revision=revision+1,updated_at=?
      WHERE tenant_id=? AND id=? AND state IN ('queued','running','waiting','ready')
      AND (kind='export' OR (state<>'ready' AND phase IN (${CLEANABLE_PHASES_SQL})))
      AND updated_at<=? RETURNING *`,
      [now, tenantId, operationId, now]
    );
  }
}

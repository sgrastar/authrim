import type { DatabaseAdapter } from '../db/adapter';
import {
  parseGuestDeletionReceiptV2,
  parseGuestPhysicalPinV2,
  guestErasureBoundaryId,
  guestDirectoryRemovalOperationPrefix,
  sameGuestRouteProjection,
} from '../services/guest-deletion-receipt';
export * from '../services/guest-deletion-receipt';
export * from '../services/guest-deletion-progress';
export * from '../services/guest-erasure-backend';
export * from '../services/guest-core-erasure-admission';
import { createGuestCoreErasureAdmissionGuard } from '../services/guest-core-erasure-admission';
import { assertGuestErasureBackend } from '../services/guest-erasure-backend';
import {
  parseGuestDeletionProgress,
  guestDeletionReceiptDigest,
  GUEST_DELETION_STAGES,
} from '../services/guest-deletion-progress';
import {
  validateAccountDirectoryRemovalPublication,
  accountDirectoryRemovalOutboxId,
  type AccountDirectoryRemovalPublication,
} from '../services/lookup-directory/publication';
import type { PreparedStatement } from '../db/adapter';
import { getGuestDeletionDueAt, type GuestLifecyclePhase } from '../services/guest-lifecycle';

export interface GuestLifecycleRow {
  tenant_id: string;
  user_id: string;
  client_id: string;
  phase: GuestLifecyclePhase;
  created_at: number;
  deletion_due_at: number | null;
  policy_version: string;
  retention_application_id: string | null;
  upgrade_hold_until: number | null;
  upgrade_operation_id: string | null;
  upgrade_admission_floor: number;
  upgraded_at: number | null;
  upgrade_finalized_at: number | null;
  deletion_operation_id: string | null;
  deletion_route_json: string | null;
  deletion_started_at_ms: number | null;
  deleted_at: number | null;
  revision: number;
  updated_at: number;
}

function lifecycleInteger(value: unknown, minimum = 0): number {
  const parsed = typeof value === 'string' && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error('guest_lifecycle_storage_invalid');
  return parsed;
}
function normalizedLifecycle(row: GuestLifecycleRow): GuestLifecycleRow {
  const nullable = (value: unknown): number | null =>
    value === null ? null : lifecycleInteger(value);
  return {
    ...row,
    created_at: lifecycleInteger(row.created_at),
    deletion_due_at: nullable(row.deletion_due_at),
    upgrade_hold_until: nullable(row.upgrade_hold_until),
    upgrade_admission_floor: lifecycleInteger(row.upgrade_admission_floor),
    upgraded_at: nullable(row.upgraded_at),
    upgrade_finalized_at: nullable(row.upgrade_finalized_at),
    deletion_started_at_ms: nullable(row.deletion_started_at_ms),
    deleted_at: nullable(row.deleted_at),
    revision: lifecycleInteger(row.revision, 1),
    updated_at: lifecycleInteger(row.updated_at),
  };
}

/** Each mutation is a single conditional statement, valid on D1 and PostgreSQL. */
export class GuestLifecycleRepository {
  private readonly assertErasureAdmission: () => Promise<void>;
  static parseDeletionRouteV2 = parseGuestDeletionReceiptV2;
  static parsePhysicalPinV2 = parseGuestPhysicalPinV2;
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly tenantId: string
  ) {
    this.assertErasureAdmission = createGuestCoreErasureAdmissionGuard(db);
  }

  async get(userId: string): Promise<GuestLifecycleRow | null> {
    const row = await this.db.queryOne<GuestLifecycleRow>(
      'SELECT * FROM guest_account_lifecycle WHERE tenant_id = ? AND user_id = ?',
      [this.tenantId, userId],
      { consistencyClass: 'primary_required' }
    );
    return row ? normalizedLifecycle(row) : null;
  }

  async enroll(input: {
    userId: string;
    clientId: string;
    createdAt: number;
    deletionAfterDays: number | null;
    policyVersion: string;
  }): Promise<GuestLifecycleRow> {
    const dueAt = getGuestDeletionDueAt(input.createdAt, input.deletionAfterDays);
    // Existing enrollment is immutable here: login and policy edits never extend retention.
    await this.db.execute(
      `INSERT INTO guest_account_lifecycle
        (tenant_id, user_id, client_id, created_at, deletion_due_at, policy_version, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
        (SELECT 1 FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?
         AND account_type = 'user' AND registration_state = 'guest' AND deleted_at IS NULL)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [
        this.tenantId,
        input.userId,
        input.clientId,
        input.createdAt,
        dueAt,
        input.policyVersion,
        input.createdAt,
        this.tenantId,
        input.userId,
      ]
    );
    const row = await this.get(input.userId);
    if (!row) throw new Error('guest_account_enrollment_failed');
    return row;
  }

  async acquireHold(
    userId: string,
    now: number,
    minutes: number
  ): Promise<GuestLifecycleRow | null> {
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60)
      throw new Error('invalid_guest_hold_minutes');
    await this.db.execute(
      `UPDATE guest_account_lifecycle SET upgrade_hold_until = ?, revision = revision + 1, updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND phase = 'active' AND upgrade_hold_until IS NULL`,
      [now + minutes * 60, now, this.tenantId, userId]
    );
    const row = await this.get(userId);
    return row?.phase === 'active' ? row : null;
  }

  async beginUpgrade(
    userId: string,
    operationId: string,
    now: number,
    proofExpiresAt: number
  ): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE guest_account_lifecycle SET phase = 'upgrading', upgrade_operation_id = ?,
        revision = revision + 1, updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND phase = 'active'
       AND upgrade_admission_floor < ? AND ? > ?`,
      [operationId, now, this.tenantId, userId, proofExpiresAt, proofExpiresAt, now]
    );
    return result.rowsAffected === 1;
  }

  /** Permanently excludes an expired proof before its PII is erased, racing admission in core. */
  async fenceExpiredProof(
    userId: string,
    operationId: string,
    expiresAt: number,
    now: number
  ): Promise<boolean> {
    if (expiresAt > now) return false;
    await this.db.execute(
      `UPDATE guest_account_lifecycle SET upgrade_admission_floor = CASE
         WHEN upgrade_admission_floor < ? THEN ? ELSE upgrade_admission_floor END
       WHERE tenant_id = ? AND user_id = ? AND phase = 'active'`,
      [expiresAt, expiresAt, this.tenantId, userId]
    );
    const row = await this.get(userId);
    if (!row) return false;
    if (row.phase === 'active') return row.upgrade_admission_floor >= expiresAt;
    return (
      row.upgrade_operation_id !== operationId ||
      (row.phase === 'registered' && row.upgrade_finalized_at !== null)
    );
  }

  listProofCleanupCandidates(limit = 10): Promise<GuestLifecycleRow[]> {
    return this.db
      .query<GuestLifecycleRow>(
        `SELECT * FROM guest_account_lifecycle WHERE tenant_id = ? AND phase IN ('active', 'registered')
       ORDER BY updated_at, user_id LIMIT ?`,
        [this.tenantId, limit],
        { consistencyClass: 'primary_required' }
      )
      .then((rows) => rows.map(normalizedLifecycle));
  }

  async completeUpgrade(userId: string, operationId: string, now: number): Promise<boolean> {
    const results = await this.db.batch([
      {
        sql: `UPDATE identity_accounts SET registration_state = 'registered', updated_at = ?
          WHERE tenant_id = ? AND legacy_user_id = ? AND registration_state = 'guest'
          AND EXISTS (SELECT 1 FROM guest_account_lifecycle
            WHERE tenant_id = ? AND user_id = ? AND phase = 'upgrading'
              AND upgrade_operation_id = ?)`,
        params: [now, this.tenantId, userId, this.tenantId, userId, operationId],
      },
      {
        sql: `UPDATE guest_account_lifecycle SET phase = 'registered', deletion_due_at = NULL,
          upgraded_at = ?, revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND user_id = ? AND phase = 'upgrading' AND upgrade_operation_id = ?
          AND EXISTS (SELECT 1 FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?
            AND registration_state = 'registered')`,
        params: [now, now, this.tenantId, userId, operationId, this.tenantId, userId],
      },
    ]);
    return results[1].rowsAffected === 1;
  }

  async acknowledgeUpgrade(userId: string, operationId: string, now: number): Promise<void> {
    await this.db.execute(
      `UPDATE guest_account_lifecycle SET upgrade_finalized_at = ?, updated_at = ?
      WHERE tenant_id = ? AND user_id = ? AND phase = 'registered' AND upgrade_operation_id = ? AND upgrade_finalized_at IS NULL`,
      [now, now, this.tenantId, userId, operationId]
    );
  }

  listUpgradeCandidates(limit = 20): Promise<GuestLifecycleRow[]> {
    return this.db
      .query<GuestLifecycleRow>(
        `SELECT * FROM guest_account_lifecycle WHERE tenant_id = ?
      AND (phase = 'upgrading' OR (phase = 'registered' AND upgrade_finalized_at IS NULL))
      ORDER BY updated_at, user_id LIMIT ?`,
        [this.tenantId, limit],
        { consistencyClass: 'primary_required' }
      )
      .then((rows) => rows.map(normalizedLifecycle));
  }

  async recordMaintenanceAttempt(userId: string, now: number): Promise<void> {
    await this.db.execute(
      `UPDATE guest_account_lifecycle SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
       WHERE tenant_id = ? AND user_id = ?`,
      [now, now, this.tenantId, userId]
    );
  }

  async admitDeletion(input: {
    userId: string;
    accountId: string;
    operationId: string;
    routeJson: string;
    expectedRevision: number;
    accountRouteGeneration: number;
    now: number;
    startedAtMs: number;
    origin: 'admin' | 'retention';
    task: {
      auditId: string;
      actorUserId: string;
      ipAddress: string;
      userAgent: string;
      metadataJson: string;
      createdAt: number;
    };
  }): Promise<GuestLifecycleRow | null> {
    assertGuestErasureBackend(this.db);
    await this.assertErasureAdmission();
    const receipt = parseGuestDeletionReceiptV2(input.routeJson, {
      tenantId: this.tenantId,
      userId: input.userId,
      accountId: input.accountId,
      operationId: input.operationId,
      acceptedOnly: true,
    });
    if (
      receipt.accountRouteGeneration !== input.accountRouteGeneration ||
      receipt.origin !== input.origin ||
      receipt.completionAuditId !== input.task.auditId ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !Number.isSafeInteger(input.startedAtMs) ||
      input.startedAtMs < 1 ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1 ||
      input.task.createdAt !== input.now ||
      !input.task.actorUserId ||
      input.task.actorUserId.length > 256 ||
      input.task.ipAddress.length > 512 ||
      input.task.userAgent.length > 1024 ||
      new TextEncoder().encode(input.task.metadataJson).length > 4096
    )
      throw new Error('guest_deletion_admission_invalid');
    let writeFailure: unknown;
    try {
      await this.db.batch([
        {
          sql: `UPDATE guest_account_lifecycle
            SET phase='deleting', deletion_operation_id=?, deletion_route_json=?,
                deletion_started_at_ms=?, revision=revision+1, updated_at=?
            WHERE tenant_id=? AND user_id=? AND phase='active' AND revision=?
              ${
                input.origin === 'retention'
                  ? `AND deletion_due_at IS NOT NULL AND deletion_due_at <= ?
                AND (upgrade_hold_until IS NULL OR upgrade_hold_until <= ?)`
                  : ''
              }
              AND EXISTS (SELECT 1 FROM identity_accounts account
                WHERE account.tenant_id=? AND account.id=? AND account.legacy_user_id=?
                  AND account.account_type='user' AND account.registration_state='guest'
                  AND account.deleted_at IS NULL AND account.lifecycle_state='active' AND account.account_route_generation=?)
              AND EXISTS (SELECT 1 FROM account_legal_hold_states authority WHERE authority.tenant_id=guest_account_lifecycle.tenant_id AND authority.account_id=? AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL)
              AND NOT EXISTS (SELECT 1 FROM legal_holds hold
                WHERE hold.tenant_id=? AND hold.subject_type='account'
                  AND hold.subject_id=? AND hold.state='active')`,
          params: [
            input.operationId,
            input.routeJson,
            input.startedAtMs,
            input.now,
            this.tenantId,
            input.userId,
            input.expectedRevision,
            ...(input.origin === 'retention' ? [input.now, input.now] : []),
            this.tenantId,
            input.accountId,
            input.userId,
            input.accountRouteGeneration,
            input.accountId,
            this.tenantId,
            input.accountId,
          ],
        },
        {
          sql: `INSERT INTO guest_deletion_audit_outbox (
            audit_id,tenant_id,user_id,operation_id,actor_user_id,ip_address,user_agent,
            metadata_json,status,attempt_count,next_attempt_at,created_at,updated_at
          ) SELECT ?,?,?,?,?,?,?,?,'pending',0,?,?,?
            WHERE EXISTS (SELECT 1 FROM guest_account_lifecycle
              WHERE tenant_id=? AND user_id=? AND phase='deleting'
                AND deletion_operation_id=? AND deletion_route_json=?
                AND deletion_started_at_ms=?)
            ON CONFLICT (audit_id) DO NOTHING`,
          params: [
            input.task.auditId,
            this.tenantId,
            input.userId,
            input.operationId,
            input.task.actorUserId,
            input.task.ipAddress,
            input.task.userAgent,
            input.task.metadataJson,
            input.task.createdAt,
            input.task.createdAt,
            input.task.createdAt,
            this.tenantId,
            input.userId,
            input.operationId,
            input.routeJson,
            input.startedAtMs,
          ],
        },
      ]);
    } catch (error) {
      writeFailure = error;
    }
    const row = await this.get(input.userId);
    if (
      !row ||
      row.phase !== 'deleting' ||
      row.deletion_operation_id !== input.operationId ||
      row.deletion_started_at_ms !== input.startedAtMs
    ) {
      if (writeFailure)
        throw new Error('guest_deletion_admission_unknown', { cause: writeFailure });
      return null;
    }
    const reflected = parseGuestDeletionReceiptV2(row.deletion_route_json, {
      tenantId: this.tenantId,
      userId: input.userId,
      accountId: input.accountId,
      operationId: input.operationId,
    });
    if (
      JSON.stringify({ ...reflected, execution: undefined }) !==
      JSON.stringify({ ...receipt, execution: undefined })
    )
      throw new Error('guest_deletion_admission_unknown');
    const task = await this.db.queryOne<{
      operation_id: string;
      user_id: string;
      actor_user_id: string;
      ip_address: string;
      user_agent: string;
      metadata_json: string;
      created_at: number;
    }>(
      'SELECT operation_id,user_id,actor_user_id,ip_address,user_agent,metadata_json,created_at FROM guest_deletion_audit_outbox WHERE tenant_id=? AND audit_id=?',
      [this.tenantId, input.task.auditId],
      { consistencyClass: 'primary_required' }
    );
    if (
      !task ||
      task.operation_id !== input.operationId ||
      task.user_id !== input.userId ||
      task.actor_user_id !== input.task.actorUserId ||
      task.ip_address !== input.task.ipAddress ||
      task.user_agent !== input.task.userAgent ||
      task.metadata_json !== input.task.metadataJson ||
      Number(task.created_at) !== input.task.createdAt
    ) {
      throw new Error('guest_deletion_admission_unknown', { cause: writeFailure });
    }
    return row;
  }

  /** Same-Core irreversible boundary, serialized with native hold creation's authority write. */
  async confirmErasureStart(input: {
    userId: string;
    accountId: string;
    operationId: string;
    expectedRevision: number;
    acceptedRouteJson: string;
    erasureStartedRouteJson: string;
    accountRouteGeneration: number;
    now: number;
  }): Promise<GuestLifecycleRow> {
    assertGuestErasureBackend(this.db);
    await this.assertErasureAdmission();
    const expected = {
      tenantId: this.tenantId,
      userId: input.userId,
      accountId: input.accountId,
      operationId: input.operationId,
    };
    const accepted = parseGuestDeletionReceiptV2(input.acceptedRouteJson, {
      ...expected,
      acceptedOnly: true,
    });
    const started = parseGuestDeletionReceiptV2(input.erasureStartedRouteJson, expected);
    if (
      started.execution.phase !== 'erasure_started' ||
      started.execution.boundaryId !== (await guestErasureBoundaryId(input.operationId)) ||
      accepted.accountRouteGeneration !== input.accountRouteGeneration ||
      JSON.stringify({ ...accepted, execution: undefined }) !==
        JSON.stringify({ ...started, execution: undefined }) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    )
      throw new Error('guest_deletion_boundary_invalid');
    let writeFailure: unknown;
    const taskPredicate = `EXISTS (SELECT 1 FROM guest_deletion_audit_outbox task WHERE task.tenant_id=guest_account_lifecycle.tenant_id AND task.user_id=guest_account_lifecycle.user_id AND task.operation_id=guest_account_lifecycle.deletion_operation_id AND task.audit_id=? AND task.status IN ('pending','retry'))`;
    try {
      await this.db.batch([
        {
          sql: `UPDATE account_legal_hold_states SET updated_at=CASE WHEN updated_at>=? THEN updated_at+1 ELSE ? END
            WHERE tenant_id=? AND account_id=? AND projection_state='inactive' AND active_hold_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=? AND hold.subject_id=? AND hold.subject_type='account' AND hold.state='active')`,
          params: [
            input.now,
            input.now,
            this.tenantId,
            input.accountId,
            this.tenantId,
            input.accountId,
          ],
        },
        {
          sql: `UPDATE guest_account_lifecycle SET deletion_route_json=?,revision=revision+1,updated_at=?
            WHERE tenant_id=? AND user_id=? AND phase='deleting' AND deletion_operation_id=? AND revision=? AND deletion_route_json=?
            AND ${taskPredicate}
            AND EXISTS (SELECT 1 FROM identity_accounts account JOIN account_legal_hold_states authority ON authority.tenant_id=account.tenant_id AND authority.account_id=account.id
              WHERE account.tenant_id=? AND account.id=? AND account.legacy_user_id=? AND account.account_type='user' AND account.registration_state='guest'
                AND account.lifecycle_state='active' AND account.deleted_at IS NULL AND account.account_route_generation=?
                AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=? AND hold.subject_id=? AND hold.subject_type='account' AND hold.state='active')`,
          params: [
            input.erasureStartedRouteJson,
            input.now,
            this.tenantId,
            input.userId,
            input.operationId,
            input.expectedRevision,
            input.acceptedRouteJson,
            accepted.completionAuditId,
            this.tenantId,
            input.accountId,
            input.userId,
            input.accountRouteGeneration,
            this.tenantId,
            input.accountId,
          ],
        },
        {
          sql: `UPDATE identity_accounts SET lifecycle_state='deleting',directory_publication_state='disabled',deleted_at=COALESCE(deleted_at,?),updated_at=?
            WHERE tenant_id=? AND id=? AND legacy_user_id=? AND account_type='user' AND registration_state='guest' AND account_route_generation=?
            AND lifecycle_state='active' AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM guest_account_lifecycle guest WHERE guest.tenant_id=identity_accounts.tenant_id AND guest.user_id=identity_accounts.legacy_user_id
              AND guest.phase='deleting' AND guest.deletion_operation_id=? AND guest.deletion_route_json=?)
            AND EXISTS (SELECT 1 FROM account_legal_hold_states authority WHERE authority.tenant_id=identity_accounts.tenant_id AND authority.account_id=identity_accounts.id AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL)
            AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=identity_accounts.tenant_id AND hold.subject_id=identity_accounts.id AND hold.subject_type='account' AND hold.state='active')`,
          params: [
            started.execution.erasureStartedAtMs,
            input.now,
            this.tenantId,
            input.accountId,
            input.userId,
            input.accountRouteGeneration,
            input.operationId,
            input.erasureStartedRouteJson,
          ],
        },
      ]);
    } catch (error) {
      writeFailure = error;
    }
    const row = await this.get(input.userId);
    if (!row || row.phase !== 'deleting' || row.deletion_operation_id !== input.operationId)
      throw new Error('guest_deletion_boundary_unknown', { cause: writeFailure });
    const reflected = parseGuestDeletionReceiptV2(row.deletion_route_json, expected);
    if (
      JSON.stringify({ ...reflected, execution: undefined }) !==
      JSON.stringify({ ...accepted, execution: undefined })
    )
      throw new Error('guest_deletion_boundary_unknown');
    // An unchanged accepted row authorizes no external effect, even after a successful-shaped response.
    if (reflected.execution.phase === 'accepted') return row;
    if (reflected.execution.boundaryId !== (await guestErasureBoundaryId(input.operationId)))
      throw new Error('guest_deletion_boundary_unknown');
    const owner = await this.db.queryOne<{ id: string }>(
      `SELECT account.id FROM identity_accounts account JOIN account_legal_hold_states authority ON authority.tenant_id=account.tenant_id AND authority.account_id=account.id
       WHERE account.tenant_id=? AND account.id=? AND account.legacy_user_id=? AND account.account_route_generation=? AND account.account_type='user' AND account.registration_state='guest'
       AND account.lifecycle_state='deleting' AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=account.tenant_id AND hold.subject_id=account.id AND hold.subject_type='account' AND hold.state='active')`,
      [this.tenantId, input.accountId, input.userId, input.accountRouteGeneration],
      { consistencyClass: 'primary_required' }
    );
    const task = await this.db.queryOne<{ audit_id: string }>(
      `SELECT audit_id FROM guest_deletion_audit_outbox WHERE tenant_id=? AND audit_id=? AND user_id=? AND operation_id=? AND status IN ('pending','retry')`,
      [this.tenantId, accepted.completionAuditId, input.userId, input.operationId],
      { consistencyClass: 'primary_required' }
    );
    if (
      !owner ||
      !task ||
      !reflected.execution.erasureStartedAtMs ||
      reflected.execution.erasureStartedAtMs <
        (row.deletion_started_at_ms ?? Number.MAX_SAFE_INTEGER)
    )
      throw new Error('guest_deletion_boundary_unknown', { cause: writeFailure });
    return row;
  }

  /** Nullable progress is execution state, never an independent authorization. */
  async readExecutionProgress(routeJson: string, userId: string): Promise<string | null> {
    const route = parseGuestDeletionReceiptV2(routeJson, { tenantId: this.tenantId, userId });
    const task = await this.db.queryOne<{ execution_progress_json: string | null }>(
      `SELECT execution_progress_json FROM guest_deletion_audit_outbox WHERE tenant_id=? AND audit_id=? AND user_id=? AND operation_id=? AND status IN ('pending','retry')`,
      [this.tenantId, route.completionAuditId, userId, route.operationId],
      { consistencyClass: 'primary_required' }
    );
    if (!task) throw new Error('guest_deletion_source_unverified');
    if (task.execution_progress_json !== null) {
      const progress = parseGuestDeletionProgress(task.execution_progress_json);
      if (
        progress.corePermit !== null ||
        progress.receiptDigest !== (await guestDeletionReceiptDigest(route))
      )
        throw new Error('guest_deletion_progress_unverified');
    }
    return task.execution_progress_json;
  }

  private async executionCas(
    input: {
      routeJson: string;
      userId: string;
      expectedProgressJson: string | null;
      nextProgressJson: string;
    },
    transient = false
  ): Promise<PreparedStatement> {
    assertGuestErasureBackend(this.db);
    await this.assertErasureAdmission();
    const route = parseGuestDeletionReceiptV2(input.routeJson, {
      tenantId: this.tenantId,
      userId: input.userId,
    });
    if (
      route.execution.phase !== 'erasure_started' ||
      route.execution.boundaryId !== (await guestErasureBoundaryId(route.operationId))
    )
      throw new Error('guest_deletion_source_unverified');
    const next = parseGuestDeletionProgress(input.nextProgressJson),
      old =
        input.expectedProgressJson === null
          ? null
          : parseGuestDeletionProgress(input.expectedProgressJson);
    if (
      next.receiptDigest !== (await guestDeletionReceiptDigest(route)) ||
      (!transient && next.corePermit !== null) ||
      (!old &&
        (next.revision !== 1 ||
          next.stage !== 'capture_email' ||
          next.sourceOrdinal !== 0 ||
          next.cursor !== null ||
          next.highWater !== null ||
          next.preparedCount !== 0 ||
          next.confirmedCount !== 0)) ||
      (old &&
        (next.revision !== old.revision + 1 ||
          old.receiptDigest !== next.receiptDigest ||
          GUEST_DELETION_STAGES.indexOf(next.stage) < GUEST_DELETION_STAGES.indexOf(old.stage) ||
          GUEST_DELETION_STAGES.indexOf(next.stage) > GUEST_DELETION_STAGES.indexOf(old.stage) + 1))
    )
      throw new Error('guest_deletion_progress_invalid');
    return {
      sql: `UPDATE guest_deletion_audit_outbox SET execution_progress_json=? WHERE tenant_id=? AND audit_id=? AND user_id=? AND operation_id=? AND status IN ('pending','retry') AND execution_progress_json ${this.db.getType() === 'postgres' ? 'IS NOT DISTINCT FROM' : 'IS'} ?
        AND EXISTS (SELECT 1 FROM guest_account_lifecycle guest JOIN identity_accounts account ON account.tenant_id=guest.tenant_id AND account.legacy_user_id=guest.user_id
          WHERE guest.tenant_id=guest_deletion_audit_outbox.tenant_id AND guest.user_id=guest_deletion_audit_outbox.user_id AND guest.phase IN ('deleting','deleted')
          AND guest.deletion_operation_id=guest_deletion_audit_outbox.operation_id AND guest.deletion_route_json=? AND account.id=? AND account.account_route_generation=? AND account.account_type='user' AND account.registration_state='guest' AND account.lifecycle_state IN ('deleting','deleted'))
        AND EXISTS (SELECT 1 FROM account_legal_hold_states authority WHERE authority.tenant_id=? AND authority.account_id=? AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=? AND hold.subject_id=? AND hold.subject_type='account' AND hold.state='active')`,
      params: [
        input.nextProgressJson,
        this.tenantId,
        route.completionAuditId,
        input.userId,
        route.operationId,
        input.expectedProgressJson,
        input.routeJson,
        route.accountId,
        route.accountRouteGeneration,
        this.tenantId,
        route.accountId,
        this.tenantId,
        route.accountId,
      ],
    };
  }

  private progressAssertion(
    routeJson: string,
    userId: string,
    nextProgressJson: string
  ): PreparedStatement {
    const route = parseGuestDeletionReceiptV2(routeJson, { tenantId: this.tenantId, userId });
    const condition = `EXISTS (SELECT 1 FROM guest_deletion_audit_outbox task WHERE task.tenant_id=? AND task.audit_id=? AND task.user_id=? AND task.operation_id=? AND task.execution_progress_json=?)`;
    return {
      sql:
        this.db.getType() === 'postgres'
          ? `SELECT CAST(CASE WHEN ${condition} THEN '1' ELSE 'guest_deletion_atomic_page_incomplete' END AS INTEGER) AS admitted`
          : `SELECT json_extract(CASE WHEN ${condition} THEN '{"admitted":1}' ELSE 'guest_deletion_atomic_page_incomplete' END,'$.admitted') AS admitted`,
      params: [
        route.tenantId,
        route.completionAuditId,
        userId,
        route.operationId,
        nextProgressJson,
      ],
    };
  }

  /** Positive primary readback, including an acknowledged-or-lost committed CAS. */
  async compareAndSwapExecutionProgress(input: {
    routeJson: string;
    userId: string;
    expectedProgressJson: string | null;
    nextProgressJson: string;
  }): Promise<boolean> {
    if (
      input.expectedProgressJson !== null &&
      parseGuestDeletionProgress(input.expectedProgressJson).corePermit !== null
    )
      throw new Error('guest_deletion_progress_invalid');
    const statement = await this.executionCas(input);
    let failure: unknown;
    try {
      await this.db.execute(statement.sql, statement.params);
    } catch (error) {
      failure = error;
    }
    const reflected = await this.readExecutionProgress(input.routeJson, input.userId);
    if (reflected === input.nextProgressJson) return true;
    if (failure && reflected === input.expectedProgressJson)
      throw new Error('guest_deletion_progress_unknown', { cause: failure });
    return false;
  }

  /** Every insert keeps the old progress predicate until the final CAS in this atomic batch. */
  async prepareDirectoryRemovalPage(input: {
    routeJson: string;
    userId: string;
    expectedProgressJson: string;
    nextProgressJson: string;
    publications: readonly AccountDirectoryRemovalPublication[];
    now: number;
  }): Promise<boolean> {
    if (this.db.getType() === 'postgres') throw new Error('guest_deletion_backend_unsupported');
    const route = parseGuestDeletionReceiptV2(input.routeJson, {
      tenantId: this.tenantId,
      userId: input.userId,
    });
    const old = parseGuestDeletionProgress(input.expectedProgressJson),
      next = parseGuestDeletionProgress(input.nextProgressJson);
    if (
      !['capture_email', 'capture_linked', 'capture_passkeys', 'capture_resume'].includes(
        old.stage
      ) ||
      old.corePermit !== null ||
      input.publications.length < 1 ||
      input.publications.length > 8 ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1 ||
      next.preparedCount !== old.preparedCount + input.publications.length
    )
      throw new Error('guest_directory_page_invalid');
    const prefix = await guestDirectoryRemovalOperationPrefix(route);
    const publications: AccountDirectoryRemovalPublication[] = [];
    for (const value of input.publications) {
      const publication = await validateAccountDirectoryRemovalPublication(value);
      if (
        publication.tenantId !== route.tenantId ||
        publication.accountId !== route.accountId ||
        publication.scope !== 'account' ||
        !publication.operationId.startsWith(prefix) ||
        !/^[a-f0-9]{32}$/u.test(publication.operationId.slice(prefix.length)) ||
        publication.idempotencyKey !== publication.operationId ||
        !sameGuestRouteProjection(publication.routeProjection, route.routeProjection) ||
        new TextEncoder().encode(JSON.stringify(publication)).length > 4096
      )
        throw new Error('guest_directory_page_invalid');
      if (publications.some((prior) => prior.operationId === publication.operationId))
        throw new Error('guest_directory_page_invalid');
      publications.push(publication);
    }
    const last = await this.executionCas(input);
    const statements: PreparedStatement[] = publications.map((publication) => ({
      sql: `INSERT INTO account_routing_outbox(outbox_id,tenant_id,account_id,event_kind,route_generation,route_schema_version,hmac_key_generation,payload_json,status,attempt_count,created_at,updated_at)
        SELECT ?,?,?,'account_deleted',?,?,?,?,'prepared',0,?,? WHERE EXISTS (
          SELECT 1 FROM guest_deletion_audit_outbox task JOIN guest_account_lifecycle guest ON guest.tenant_id=task.tenant_id AND guest.user_id=task.user_id
          JOIN identity_accounts account ON account.tenant_id=guest.tenant_id AND account.legacy_user_id=guest.user_id
          JOIN account_legal_hold_states authority ON authority.tenant_id=account.tenant_id AND authority.account_id=account.id
          WHERE task.tenant_id=? AND task.audit_id=? AND task.user_id=? AND task.operation_id=? AND task.execution_progress_json ${this.db.getType() === 'postgres' ? 'IS NOT DISTINCT FROM' : 'IS'} ?
          AND guest.deletion_operation_id=task.operation_id AND guest.deletion_route_json=? AND guest.phase='deleting'
          AND account.id=? AND account.account_route_generation=? AND account.lifecycle_state='deleting'
          AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM legal_holds hold WHERE hold.tenant_id=account.tenant_id AND hold.subject_id=account.id AND hold.subject_type='account' AND hold.state='active'))
        ON CONFLICT(outbox_id) DO NOTHING`,
      params: [
        accountDirectoryRemovalOutboxId(publication.operationId),
        route.tenantId,
        route.accountId,
        route.accountRouteGeneration,
        route.routeProjection.schemaVersion,
        Math.max(...publication.indexes.map((index) => index.hmacKeyGeneration)),
        JSON.stringify(publication),
        input.now,
        input.now,
        route.tenantId,
        route.completionAuditId,
        route.userId,
        route.operationId,
        input.expectedProgressJson,
        input.routeJson,
        route.accountId,
        route.accountRouteGeneration,
      ],
    }));
    for (const publication of publications) {
      last.sql += ` AND EXISTS (SELECT 1 FROM account_routing_outbox publication WHERE publication.outbox_id=? AND publication.tenant_id=? AND publication.account_id=? AND publication.payload_json=? AND publication.event_kind='account_deleted')`;
      last.params = [
        ...(last.params ?? []),
        accountDirectoryRemovalOutboxId(publication.operationId),
        route.tenantId,
        route.accountId,
        JSON.stringify(publication),
      ];
    }
    let failure: unknown;
    try {
      await this.db.batch([
        ...statements,
        last,
        this.progressAssertion(input.routeJson, input.userId, input.nextProgressJson),
      ]);
    } catch (error) {
      failure = error;
    }
    const reflected = await this.readExecutionProgress(input.routeJson, input.userId);
    if (reflected !== input.nextProgressJson) {
      if (failure && reflected === input.expectedProgressJson)
        throw new Error('guest_directory_page_unknown', { cause: failure });
      return false;
    }
    const expected = new Map(
      publications.map((publication) => [
        accountDirectoryRemovalOutboxId(publication.operationId),
        JSON.stringify(publication),
      ])
    );
    const ids = [...expected.keys()];
    const rows = await this.db.query<{ outbox_id: string; payload_json: string }>(
      `SELECT outbox_id,payload_json FROM account_routing_outbox WHERE tenant_id=? AND account_id=? AND outbox_id IN (${ids.map(() => '?').join(',')})`,
      [route.tenantId, route.accountId, ...ids],
      { consistencyClass: 'primary_required' }
    );
    if (
      rows.length !== expected.size ||
      rows.some((row) => expected.get(row.outbox_id) !== row.payload_json)
    )
      throw new Error('guest_directory_page_unknown');
    return true;
  }

  /** A transient same-task permit is installed and cleared inside one D1 atomic batch. */
  async drainCorePage(input: {
    routeJson: string;
    userId: string;
    expectedProgressJson: string;
    nextProgressJson: string;
    table: 'passkeys' | 'guest_devices' | 'totp_backup_codes' | 'totp_credentials';
    ids: string[];
  }): Promise<boolean> {
    if (
      input.table !== 'passkeys' &&
      input.table !== 'guest_devices' &&
      input.table !== 'totp_backup_codes' &&
      input.table !== 'totp_credentials'
    )
      throw new Error('guest_deletion_page_invalid');
    if (
      this.db.getType() === 'postgres' &&
      (input.table === 'totp_credentials' || input.table === 'totp_backup_codes')
    )
      throw new Error('guest_deletion_backend_unsupported');
    const route = parseGuestDeletionReceiptV2(input.routeJson, {
      tenantId: this.tenantId,
      userId: input.userId,
    });
    const old = parseGuestDeletionProgress(input.expectedProgressJson),
      next = parseGuestDeletionProgress(input.nextProgressJson);
    if (
      old.stage !== `drain_${input.table}` ||
      old.corePermit !== null ||
      next.corePermit !== null ||
      next.revision !== old.revision + 2
    )
      throw new Error('guest_deletion_progress_invalid');
    const permitted = parseGuestDeletionProgress(
      JSON.stringify({
        ...old,
        revision: old.revision + 1,
        corePermit: { table: input.table, ids: input.ids },
      })
    );
    const permitJson = JSON.stringify(permitted);
    const first = await this.executionCas({ ...input, nextProgressJson: permitJson }, true);
    const last = await this.executionCas({ ...input, expectedProgressJson: permitJson });
    const marks = input.ids.map(() => '?').join(',');
    const effect: PreparedStatement = {
      sql: `DELETE FROM ${input.table} WHERE tenant_id=? AND user_id=? AND id IN (${marks}) AND EXISTS (SELECT 1 FROM guest_deletion_audit_outbox task WHERE task.tenant_id=? AND task.audit_id=? AND task.user_id=? AND task.operation_id=? AND task.execution_progress_json=?)`,
      params: [
        this.tenantId,
        input.userId,
        ...input.ids,
        this.tenantId,
        route.completionAuditId,
        input.userId,
        route.operationId,
        permitJson,
      ],
    };
    let failure: unknown;
    try {
      await this.db.batch([
        first,
        effect,
        last,
        this.progressAssertion(input.routeJson, input.userId, input.nextProgressJson),
      ]);
    } catch (error) {
      failure = error;
    }
    const reflected = await this.readExecutionProgress(input.routeJson, input.userId);
    if (reflected !== input.nextProgressJson) {
      if (failure && reflected === input.expectedProgressJson)
        throw new Error('guest_deletion_page_unknown', { cause: failure });
      return false;
    }
    const remaining = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM ${input.table} WHERE tenant_id=? AND user_id=? AND id IN (${marks}) LIMIT 1`,
      [this.tenantId, input.userId, ...input.ids],
      { consistencyClass: 'primary_required' }
    );
    if (remaining) throw new Error('guest_deletion_page_unknown');
    return true;
  }

  async markDirectoryRemovalPageReady(input: {
    routeJson: string;
    userId: string;
    expectedProgressJson: string;
    nextProgressJson: string;
    ids: string[];
    now: number;
  }): Promise<boolean> {
    if (this.db.getType() === 'postgres') throw new Error('guest_deletion_backend_unsupported');
    const route = parseGuestDeletionReceiptV2(input.routeJson, {
      tenantId: this.tenantId,
      userId: input.userId,
    });
    const old = parseGuestDeletionProgress(input.expectedProgressJson);
    const prefix = `account-routing-removal:${await guestDirectoryRemovalOperationPrefix(route)}`;
    if (
      old.stage !== 'directory_ready' ||
      parseGuestDeletionProgress(input.nextProgressJson).confirmedCount !==
        old.confirmedCount + input.ids.length ||
      old.corePermit !== null ||
      input.ids.length < 1 ||
      input.ids.length > 8 ||
      new Set(input.ids).size !== input.ids.length ||
      input.ids.some(
        (id) => !id.startsWith(prefix) || !/^[a-f0-9]{32}$/u.test(id.slice(prefix.length))
      )
    )
      throw new Error('guest_directory_page_invalid');
    const last = await this.executionCas(input);
    const marks = input.ids.map(() => '?').join(',');
    const effect: PreparedStatement = {
      sql: `UPDATE account_routing_outbox SET status='pending',next_attempt_at=?,updated_at=? WHERE tenant_id=? AND account_id=? AND outbox_id IN (${marks}) AND event_kind='account_deleted' AND status='prepared'
        AND EXISTS (SELECT 1 FROM guest_deletion_audit_outbox task JOIN guest_account_lifecycle guest ON guest.tenant_id=task.tenant_id AND guest.user_id=task.user_id
          WHERE task.tenant_id=? AND task.audit_id=? AND task.user_id=? AND task.operation_id=? AND task.execution_progress_json ${this.db.getType() === 'postgres' ? 'IS NOT DISTINCT FROM' : 'IS'} ?
          AND guest.phase='deleted' AND guest.deletion_operation_id=task.operation_id AND guest.deletion_route_json=?)`,
      params: [
        input.now,
        input.now,
        route.tenantId,
        route.accountId,
        ...input.ids,
        route.tenantId,
        route.completionAuditId,
        route.userId,
        route.operationId,
        input.expectedProgressJson,
        input.routeJson,
      ],
    };
    last.sql += ` AND (SELECT COUNT(*) FROM account_routing_outbox publication WHERE publication.tenant_id=? AND publication.account_id=? AND publication.outbox_id IN (${marks}) AND publication.event_kind='account_deleted' AND publication.status IN ('pending','leased','retry','succeeded'))=?`;
    last.params = [
      ...(last.params ?? []),
      route.tenantId,
      route.accountId,
      ...input.ids,
      input.ids.length,
    ];
    let failure: unknown;
    try {
      await this.db.batch([
        effect,
        last,
        this.progressAssertion(input.routeJson, input.userId, input.nextProgressJson),
      ]);
    } catch (error) {
      failure = error;
    }
    const reflected = await this.readExecutionProgress(input.routeJson, input.userId);
    if (reflected === input.nextProgressJson) return true;
    if (failure && reflected === input.expectedProgressJson)
      throw new Error('guest_directory_page_unknown', { cause: failure });
    return false;
  }

  /** One account/subject terminal transition; PII was drained separately and is never bulk-updated here. */
  async finishCoreErasure(input: {
    routeJson: string;
    userId: string;
    expectedProgressJson: string;
    nextProgressJson: string;
    now: number;
  }): Promise<boolean> {
    const route = parseGuestDeletionReceiptV2(input.routeJson, {
      tenantId: this.tenantId,
      userId: input.userId,
    });
    const old = parseGuestDeletionProgress(input.expectedProgressJson),
      next = parseGuestDeletionProgress(input.nextProgressJson);
    if (
      old.stage !== 'final_core' ||
      next.stage !== 'directory_ready' ||
      old.corePermit !== null ||
      next.corePermit !== null ||
      next.revision !== old.revision + 2 ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1
    )
      throw new Error('guest_deletion_terminal_invalid');
    const permitted = parseGuestDeletionProgress(
      JSON.stringify({
        ...old,
        revision: old.revision + 1,
        corePermit: { table: 'identity_accounts', ids: [route.accountId] },
      })
    );
    const permitJson = JSON.stringify(permitted);
    const first = await this.executionCas({ ...input, nextProgressJson: permitJson }, true);
    const last = await this.executionCas({ ...input, expectedProgressJson: permitJson });
    const fence = `EXISTS (SELECT 1 FROM guest_deletion_audit_outbox task WHERE task.tenant_id=? AND task.audit_id=? AND task.user_id=? AND task.operation_id=? AND task.execution_progress_json=?)`;
    const fenceParams = [
      route.tenantId,
      route.completionAuditId,
      route.userId,
      route.operationId,
      permitJson,
    ];
    // The existing closed PostgreSQL Core profile has no TOTP authority tables.
    const coreTables =
      this.db.getType() === 'postgres'
        ? (['guest_devices', 'passkeys'] as const)
        : (['guest_devices', 'passkeys', 'totp_backup_codes', 'totp_credentials'] as const);
    const emptyCore = coreTables
      .map((table) => `NOT EXISTS (SELECT 1 FROM ${table} WHERE tenant_id=? AND user_id=?)`)
      .join(' AND ');
    const emptyParams = coreTables.flatMap(() => [route.tenantId, route.userId]);
    const statements: PreparedStatement[] = [
      first,
      {
        sql: `UPDATE identity_accounts SET lifecycle_state='deleted',display_label=NULL,metadata_json=NULL,updated_at=CASE WHEN updated_at>? THEN updated_at ELSE ? END
        WHERE tenant_id=? AND id=? AND legacy_user_id=? AND account_route_generation=? AND lifecycle_state='deleting' AND ${fence} AND ${emptyCore}`,
        params: [
          input.now,
          input.now,
          route.tenantId,
          route.accountId,
          route.userId,
          route.accountRouteGeneration,
          ...fenceParams,
          ...emptyParams,
        ],
      },
      {
        sql: `UPDATE identity_subjects SET lifecycle_state='deleted',updated_at=CASE WHEN updated_at>? THEN updated_at ELSE ? END,deleted_at=COALESCE(deleted_at,?)
        WHERE tenant_id=? AND id IN (SELECT primary_subject_id FROM identity_accounts WHERE tenant_id=? AND id=? AND legacy_user_id=? AND lifecycle_state='deleted') AND NOT EXISTS (SELECT 1 FROM identity_accounts other WHERE other.tenant_id=identity_subjects.tenant_id AND other.primary_subject_id=identity_subjects.id AND other.id<>? AND other.lifecycle_state<>'deleted') AND ${fence}`,
        params: [
          input.now,
          input.now,
          input.now,
          route.tenantId,
          route.tenantId,
          route.accountId,
          route.userId,
          route.accountId,
          ...fenceParams,
        ],
      },
      {
        sql: `UPDATE guest_account_lifecycle SET phase='deleted',deleted_at=COALESCE(deleted_at,?),revision=revision+1,updated_at=?
        WHERE tenant_id=? AND user_id=? AND phase='deleting' AND deletion_operation_id=? AND deletion_route_json=? AND ${fence} AND ${emptyCore}
        AND EXISTS (SELECT 1 FROM identity_accounts WHERE tenant_id=? AND id=? AND legacy_user_id=? AND account_route_generation=? AND lifecycle_state='deleted')`,
        params: [
          input.now,
          input.now,
          route.tenantId,
          route.userId,
          route.operationId,
          input.routeJson,
          ...fenceParams,
          ...emptyParams,
          route.tenantId,
          route.accountId,
          route.userId,
          route.accountRouteGeneration,
        ],
      },
    ];
    last.sql += ` AND EXISTS (SELECT 1 FROM guest_account_lifecycle terminal WHERE terminal.tenant_id=? AND terminal.user_id=? AND terminal.phase='deleted' AND terminal.deletion_operation_id=? AND terminal.deletion_route_json=?)`;
    last.params = [
      ...(last.params ?? []),
      route.tenantId,
      route.userId,
      route.operationId,
      input.routeJson,
    ];
    last.sql += ` AND EXISTS (SELECT 1 FROM identity_accounts owner WHERE owner.tenant_id=? AND owner.id=? AND owner.lifecycle_state='deleted' AND (owner.primary_subject_id IS NULL OR EXISTS (SELECT 1 FROM identity_subjects subject WHERE subject.tenant_id=owner.tenant_id AND subject.id=owner.primary_subject_id AND subject.lifecycle_state='deleted') OR EXISTS (SELECT 1 FROM identity_subjects retained JOIN identity_accounts other ON other.tenant_id=retained.tenant_id AND other.primary_subject_id=retained.id WHERE retained.tenant_id=owner.tenant_id AND retained.id=owner.primary_subject_id AND other.id<>owner.id AND other.lifecycle_state<>'deleted')))`;
    last.params.push(route.tenantId, route.accountId);

    let failure: unknown;
    try {
      await this.db.batch([
        ...statements,
        last,
        this.progressAssertion(input.routeJson, input.userId, input.nextProgressJson),
      ]);
    } catch (error) {
      failure = error;
    }
    const reflected = await this.readExecutionProgress(input.routeJson, input.userId);
    if (reflected !== input.nextProgressJson) {
      if (failure && reflected === input.expectedProgressJson)
        throw new Error('guest_deletion_terminal_unknown', { cause: failure });
      return false;
    }
    const row = await this.get(input.userId);
    const owner = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM identity_accounts WHERE tenant_id=? AND id=? AND legacy_user_id=? AND account_route_generation=? AND lifecycle_state='deleted'`,
      [route.tenantId, route.accountId, route.userId, route.accountRouteGeneration],
      { consistencyClass: 'primary_required' }
    );
    if (
      !row ||
      row.phase !== 'deleted' ||
      row.deletion_operation_id !== route.operationId ||
      row.deletion_route_json !== input.routeJson ||
      !row.deleted_at ||
      !owner
    )
      throw new Error('guest_deletion_terminal_unknown');
    return true;
  }

  async beginDeletion(
    userId: string,
    operationId: string,
    now: number,
    routeJson: string | null = null,
    startedAtMs = now * 1000
  ): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE guest_account_lifecycle SET phase = 'deleting', deletion_operation_id = ?, deletion_route_json = ?, deletion_started_at_ms = ?,
        revision = revision + 1, updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND phase = 'active'
        AND deletion_due_at IS NOT NULL AND deletion_due_at <= ?
        AND (upgrade_hold_until IS NULL OR upgrade_hold_until <= ?)`,
      [operationId, routeJson, startedAtMs, now, this.tenantId, userId, now, now]
    );
    return result.rowsAffected === 1;
  }

  /**
   * Claim an explicit administrator deletion without applying the retention deadline.
   * The caller must perform its legal-hold check before invoking this transition.
   */
  async beginAdministrativeDeletion(
    userId: string,
    operationId: string,
    now: number,
    routeJson: string,
    startedAtMs = now * 1000
  ): Promise<boolean> {
    if (!routeJson) throw new Error('guest_administrative_deletion_route_required');
    const result = await this.db.execute(
      `UPDATE guest_account_lifecycle SET phase = 'deleting', deletion_operation_id = ?,
        deletion_route_json = ?, deletion_started_at_ms = ?, revision = revision + 1,
        updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND phase = 'active'
       AND EXISTS (SELECT 1 FROM identity_accounts
         WHERE tenant_id = ? AND legacy_user_id = ? AND account_type = 'user'
           AND registration_state = 'guest' AND deleted_at IS NULL)`,
      [operationId, routeJson, startedAtMs, now, this.tenantId, userId, this.tenantId, userId]
    );
    return result.rowsAffected === 1;
  }

  async completeDeletion(userId: string, operationId: string, now: number): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE guest_account_lifecycle SET phase = 'deleted', deleted_at = ?,
        revision = revision + 1, updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND phase = 'deleting' AND deletion_operation_id = ?`,
      [now, now, this.tenantId, userId, operationId]
    );
    return result.rowsAffected === 1;
  }

  listDeletionCandidates(now: number, limit = 50): Promise<GuestLifecycleRow[]> {
    return this.db
      .query<GuestLifecycleRow>(
        `SELECT * FROM guest_account_lifecycle WHERE tenant_id = ? AND
        (phase = 'deleting' OR (phase='deleted' AND EXISTS (SELECT 1 FROM guest_deletion_audit_outbox task WHERE task.tenant_id=guest_account_lifecycle.tenant_id AND task.user_id=guest_account_lifecycle.user_id AND task.operation_id=guest_account_lifecycle.deletion_operation_id AND task.status IN ('pending','retry'))) OR (phase = 'active' AND deletion_due_at <= ?
         AND (upgrade_hold_until IS NULL OR upgrade_hold_until <= ?)))
       ORDER BY updated_at, user_id LIMIT ?`,
        [this.tenantId, now, now, limit],
        { consistencyClass: 'primary_required' }
      )
      .then((rows) => rows.map(normalizedLifecycle));
  }

  /** A preview records revisions; changed, promoted, or deleting accounts are skipped. */
  async applyRetention(
    userId: string,
    expectedRevision: number,
    days: number | null,
    policyVersion: string,
    now: number,
    applicationId: string | null = null
  ): Promise<boolean> {
    // Validate without trusting input to determine a SQL expression.
    getGuestDeletionDueAt(0, days);
    const result = await this.db.execute(
      `UPDATE guest_account_lifecycle SET deletion_due_at = ${days === null ? 'NULL' : 'created_at + ?'},
        policy_version = ?, retention_application_id = ?, revision = revision + 1, updated_at = ?
       WHERE tenant_id = ? AND user_id = ? AND phase = 'active' AND revision = ?`,
      [
        ...(days === null ? [] : [days * 86400]),
        policyVersion,
        applicationId,
        now,
        this.tenantId,
        userId,
        expectedRevision,
      ]
    );
    return result.rowsAffected === 1;
  }
}

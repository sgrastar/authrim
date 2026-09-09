import type { DatabaseAdapter } from '../db/adapter';
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

/** Each mutation is a single conditional statement, valid on D1 and PostgreSQL. */
export class GuestLifecycleRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly tenantId: string
  ) {}

  get(userId: string): Promise<GuestLifecycleRow | null> {
    return this.db.queryOne<GuestLifecycleRow>(
      'SELECT * FROM guest_account_lifecycle WHERE tenant_id = ? AND user_id = ?',
      [this.tenantId, userId],
      { consistencyClass: 'primary_required' }
    );
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
    return this.db.query<GuestLifecycleRow>(
      `SELECT * FROM guest_account_lifecycle WHERE tenant_id = ? AND phase IN ('active', 'registered')
       ORDER BY updated_at, user_id LIMIT ?`,
      [this.tenantId, limit],
      { consistencyClass: 'primary_required' }
    );
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
    return this.db.query<GuestLifecycleRow>(
      `SELECT * FROM guest_account_lifecycle WHERE tenant_id = ?
      AND (phase = 'upgrading' OR (phase = 'registered' AND upgrade_finalized_at IS NULL))
      ORDER BY updated_at, user_id LIMIT ?`,
      [this.tenantId, limit],
      { consistencyClass: 'primary_required' }
    );
  }

  async recordMaintenanceAttempt(userId: string, now: number): Promise<void> {
    await this.db.execute(
      `UPDATE guest_account_lifecycle SET updated_at = ? WHERE tenant_id = ? AND user_id = ?`,
      [now, this.tenantId, userId]
    );
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
    return this.db.query<GuestLifecycleRow>(
      `SELECT * FROM guest_account_lifecycle WHERE tenant_id = ? AND
        (phase = 'deleting' OR (phase = 'active' AND deletion_due_at <= ?
         AND (upgrade_hold_until IS NULL OR upgrade_hold_until <= ?)))
       ORDER BY updated_at, user_id LIMIT ?`,
      [this.tenantId, now, now, limit],
      { consistencyClass: 'primary_required' }
    );
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

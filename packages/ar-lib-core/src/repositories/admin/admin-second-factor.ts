/**
 * Admin Second Factor Repository
 *
 * Second factors an admin registered for step-up (L2), in DB_ADMIN. They are separate from the
 * sign-in passkeys: a credential ID is never in both tables, which each insert checks in the same
 * statement. The conditions that must hold under concurrent requests (first enrollment only while
 * none is active, never revoking below the minimum) are part of the write itself.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';

export type AdminSecondFactorKind = 'webauthn_credential' | 'keyring_holder_key';

/** Active factors that must remain; a removal that would go below this is refused. */
export const ADMIN_SECOND_FACTOR_MINIMUM = 1;

/**
 * How long after an admin's window starts (account creation, or the migration for accounts that
 * already existed) a first second factor can be registered with a fresh passkey alone.
 */
export const ADMIN_SECOND_FACTOR_ENROLLMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminSecondFactor {
  id: string;
  admin_user_id: string;
  kind: AdminSecondFactorKind;
  credential_id: string | null;
  holder_jkt: string | null;
  public_key: string | null;
  counter: number;
  transports: string[] | null;
  aaguid: string | null;
  backup_eligible: boolean | null;
  backup_state: boolean | null;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface AdminWebAuthnSecondFactorInput {
  admin_user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports?: string[];
  aaguid?: string | null;
  backup_eligible: boolean;
  backup_state: boolean;
  label?: string | null;
}

export type AdminSecondFactorInsertResult =
  | { inserted: true; factor: AdminSecondFactor }
  | {
      inserted: false;
      reason:
        | 'already_enrolled'
        | 'enrollment_closed'
        | 'credential_in_use'
        | 'approval_revoked'
        | 'session_ended';
    };

export type AdminSecondFactorRevokeResult =
  | { revoked: true }
  | { revoked: false; reason: 'not_found' | 'minimum_reached' };

const ACTIVE_COUNT_SQL = `(SELECT COUNT(*) FROM admin_second_factors
  WHERE admin_user_id = ? AND revoked_at IS NULL)`;

/**
 * The condition for a first registration without L2 (`firstOnly`). Either the one-time window
 * after the account was created, while the admin has never had a factor (a revoked one counts),
 * or the re-enrolment window the last-resort recovery opened, while no factor is active (the
 * revoked ones stay). Params: firstOnly flag, admin, admin, grace length, now, admin, admin, now.
 */
const FIRST_ONLY_SQL = `(? = 0 OR (
  (NOT EXISTS (SELECT 1 FROM admin_second_factors WHERE admin_user_id = ?)
    AND EXISTS (
      SELECT 1 FROM admin_users
       WHERE id = ? AND COALESCE(second_factor_grace_started_at, created_at) + ? > ?
    ))
  OR (NOT EXISTS (
      SELECT 1 FROM admin_second_factors WHERE admin_user_id = ? AND revoked_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM admin_users WHERE id = ? AND second_factor_reenroll_until > ?
    ))
))`;

function firstOnlyParams(firstOnly: boolean, adminUserId: string, now: number): unknown[] {
  return [
    firstOnly ? 1 : 0,
    adminUserId,
    adminUserId,
    ADMIN_SECOND_FACTOR_ENROLLMENT_GRACE_MS,
    now,
    adminUserId,
    adminUserId,
    now,
  ];
}

/** When a session is named, it must still be the admin's and unexpired. */
const SESSION_ALIVE_SQL = `(? IS NULL OR EXISTS (
  SELECT 1 FROM admin_sessions WHERE id = ? AND admin_user_id = ? AND expires_at > ?
))`;

function sessionAliveParams(
  sessionId: string | undefined,
  adminUserId: string,
  now: number
): unknown[] {
  return [sessionId ?? null, sessionId ?? null, adminUserId, now];
}

/**
 * Close the re-enrolment window once a factor was written (the INSERT before it in the same
 * batch): the window serves one registration. Params: admin, new factor id.
 */
const CONSUME_REENROLL_WINDOW_SQL = `UPDATE admin_users SET second_factor_reenroll_until = NULL
  WHERE id = ? AND second_factor_reenroll_until IS NOT NULL
    AND EXISTS (SELECT 1 FROM admin_second_factors WHERE id = ?)`;

/** What the last-resort recovery did to the admin's account. */
export interface AdminSecondFactorLastResortResult {
  revokedFactorIds: string[];
  endedSessions: number;
  cancelledRecoveryIds: string[];
  reenrollUntil: number;
}

export class AdminSecondFactorRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  /** When the admin's one-time first-enrollment window closes, or null for an unknown admin. */
  async getEnrollmentGraceEndsAt(adminUserId: string): Promise<number | null> {
    const row = await this.adapter.queryOne<{
      created_at: number;
      second_factor_grace_started_at: number | null;
    }>('SELECT created_at, second_factor_grace_started_at FROM admin_users WHERE id = ?', [
      adminUserId,
    ]);
    if (!row) return null;
    const startedAt = row.second_factor_grace_started_at ?? row.created_at;
    return Number(startedAt) + ADMIN_SECOND_FACTOR_ENROLLMENT_GRACE_MS;
  }

  /**
   * Until when (ms) the re-enrolment window the last-resort recovery opened lasts, or null when
   * none is open (never opened, used, or for an unknown admin).
   */
  async getReenrollWindowEndsAt(adminUserId: string, now: number): Promise<number | null> {
    const row = await this.adapter.queryOne<{ second_factor_reenroll_until: number | null }>(
      'SELECT second_factor_reenroll_until FROM admin_users WHERE id = ?',
      [adminUserId]
    );
    const until = row?.second_factor_reenroll_until;
    return typeof until === 'number' && until > now ? until : null;
  }

  async listByUser(adminUserId: string): Promise<AdminSecondFactor[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT * FROM admin_second_factors WHERE admin_user_id = ? ORDER BY created_at DESC',
      [adminUserId]
    );
    return rows.map((row) => this.rowToFactor(row));
  }

  async listActiveByUser(adminUserId: string): Promise<AdminSecondFactor[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_second_factors
        WHERE admin_user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      [adminUserId]
    );
    return rows.map((row) => this.rowToFactor(row));
  }

  async findActiveByCredentialId(credentialId: string): Promise<AdminSecondFactor | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_second_factors WHERE credential_id = ? AND revoked_at IS NULL',
      [credentialId]
    );
    return row ? this.rowToFactor(row) : null;
  }

  /** Whether the admin has ever registered a second factor (revoked ones included). */
  async hasEverEnrolled(adminUserId: string): Promise<boolean> {
    const row = await this.adapter.queryOne<{ found: number }>(
      'SELECT 1 AS found FROM admin_second_factors WHERE admin_user_id = ? LIMIT 1',
      [adminUserId]
    );
    return row !== null;
  }

  async isActive(adminUserId: string, id: string): Promise<boolean> {
    const row = await this.adapter.queryOne<{ id: string }>(
      `SELECT id FROM admin_second_factors
        WHERE id = ? AND admin_user_id = ? AND revoked_at IS NULL`,
      [id, adminUserId]
    );
    return row !== null;
  }

  /**
   * Register a WebAuthn credential as a second factor. With `firstOnly`, the row is written only
   * while the admin has never had a factor (a revoked one counts: once another administrator
   * revokes the last key, a new one comes through recovery, not as a first enrollment again) and
   * their first-enrollment window is still open, or while none is active inside the re-enrolment
   * window the last-resort recovery opened. So two concurrent first enrollments register one and
   * a challenge issued before the window closed cannot be used after it. Any registration closes
   * the re-enrolment window in the same batch. A credential already registered as a sign-in passkey, or as any
   * second factor (revoked ones included), is refused.
   */
  async insertWebAuthn(
    input: AdminWebAuthnSecondFactorInput,
    options: {
      firstOnly: boolean;
      /** As for insertKeyringHolderKey: the approval is checked in the INSERT itself. */
      approvedBy?: { factorId: string; sessionId: string };
      /** As for insertKeyringHolderKey: the registering session must still be the admin's. */
      sessionId?: string;
      now?: number;
    }
  ): Promise<AdminSecondFactorInsertResult> {
    const id = generateId();
    const now = options.now ?? getCurrentTimestamp();
    const approval = options.approvedBy ?? null;
    const result = await this.insertConsumingWindow(
      input.admin_user_id,
      id,
      `INSERT INTO admin_second_factors (
         id, admin_user_id, kind, credential_id, public_key, counter, transports_json, aaguid,
         backup_eligible, backup_state, label, created_at
       )
       SELECT ?, ?, 'webauthn_credential', ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM admin_passkeys WHERE credential_id = ?)
         AND NOT EXISTS (SELECT 1 FROM admin_second_factors WHERE credential_id = ?)
         AND (? IS NULL OR (EXISTS (
           SELECT 1 FROM admin_second_factors WHERE id = ? AND admin_user_id = ? AND revoked_at IS NULL
         ) AND EXISTS (
           SELECT 1 FROM admin_sessions WHERE id = ? AND admin_user_id = ? AND second_factor_id = ?
         )))
         AND ${FIRST_ONLY_SQL}
         AND ${SESSION_ALIVE_SQL}`,
      [
        id,
        input.admin_user_id,
        input.credential_id,
        input.public_key,
        input.counter,
        input.transports && input.transports.length > 0 ? JSON.stringify(input.transports) : null,
        input.aaguid ?? null,
        input.backup_eligible ? 1 : 0,
        input.backup_state ? 1 : 0,
        input.label ?? null,
        now,
        input.credential_id,
        input.credential_id,
        approval ? approval.factorId : null,
        approval?.factorId ?? null,
        input.admin_user_id,
        approval?.sessionId ?? null,
        input.admin_user_id,
        approval?.factorId ?? null,
        ...firstOnlyParams(options.firstOnly, input.admin_user_id, now),
        ...sessionAliveParams(options.sessionId, input.admin_user_id, now),
      ]
    );
    if (result.rowsAffected === 0) {
      const inUse = await this.adapter.queryOne<{ found: number }>(
        `SELECT 1 AS found FROM admin_passkeys WHERE credential_id = ?
         UNION ALL SELECT 1 FROM admin_second_factors WHERE credential_id = ? LIMIT 1`,
        [input.credential_id, input.credential_id]
      );
      if (inUse) return { inserted: false, reason: 'credential_in_use' };
      if (approval) return { inserted: false, reason: 'approval_revoked' };
      if (
        options.sessionId &&
        !(await this.sessionAlive(input.admin_user_id, options.sessionId, now))
      )
        return { inserted: false, reason: 'session_ended' };
      const active = await this.listActiveByUser(input.admin_user_id);
      return {
        inserted: false,
        reason: active.length > 0 ? 'already_enrolled' : 'enrollment_closed',
      };
    }
    return {
      inserted: true,
      factor: {
        id,
        admin_user_id: input.admin_user_id,
        kind: 'webauthn_credential',
        credential_id: input.credential_id,
        holder_jkt: null,
        public_key: input.public_key,
        counter: input.counter,
        transports: input.transports && input.transports.length > 0 ? input.transports : null,
        aaguid: input.aaguid ?? null,
        backup_eligible: input.backup_eligible,
        backup_state: input.backup_state,
        label: input.label ?? null,
        created_at: now,
        last_used_at: null,
        revoked_at: null,
      },
    };
  }

  /**
   * Register the holder key of the admin's Keyring credential as a second factor, after a
   * presentation proved possession of it. `firstOnly` follows the same rules as for WebAuthn
   * keys. A holder key registered before (revoked ones included) is refused: revoked factors are
   * never brought back.
   */
  async insertKeyringHolderKey(
    input: { admin_user_id: string; holder_jkt: string; label?: string | null },
    options: {
      firstOnly: boolean;
      /**
       * The factor that approved the registration (the receipt's second factor) and the session
       * that verified it: the row is written only while that factor is still active and still
       * the session's evidence, in the same statement, so a revocation in between wins.
       */
      approvedBy?: { factorId: string; sessionId: string };
      /**
       * The session registering the key: the row is written only while it is still the admin's
       * and unexpired, so a registration in flight when the last-resort recovery ended every
       * session cannot use the window it opened.
       */
      sessionId?: string;
      now?: number;
    }
  ): Promise<AdminSecondFactorInsertResult> {
    const id = generateId();
    const now = options.now ?? getCurrentTimestamp();
    const approval = options.approvedBy ?? null;
    const result = await this.insertConsumingWindow(
      input.admin_user_id,
      id,
      `INSERT INTO admin_second_factors (id, admin_user_id, kind, holder_jkt, label, created_at)
       SELECT ?, ?, 'keyring_holder_key', ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM admin_second_factors WHERE holder_jkt = ?)
         AND (? IS NULL OR (EXISTS (
           SELECT 1 FROM admin_second_factors WHERE id = ? AND admin_user_id = ? AND revoked_at IS NULL
         ) AND EXISTS (
           SELECT 1 FROM admin_sessions WHERE id = ? AND admin_user_id = ? AND second_factor_id = ?
         )))
         AND ${FIRST_ONLY_SQL}
         AND ${SESSION_ALIVE_SQL}`,
      [
        id,
        input.admin_user_id,
        input.holder_jkt,
        input.label ?? null,
        now,
        input.holder_jkt,
        approval ? approval.factorId : null,
        approval?.factorId ?? null,
        input.admin_user_id,
        approval?.sessionId ?? null,
        input.admin_user_id,
        approval?.factorId ?? null,
        ...firstOnlyParams(options.firstOnly, input.admin_user_id, now),
        ...sessionAliveParams(options.sessionId, input.admin_user_id, now),
      ]
    );
    if (result.rowsAffected === 0) {
      const inUse = await this.adapter.queryOne<{ found: number }>(
        'SELECT 1 AS found FROM admin_second_factors WHERE holder_jkt = ? LIMIT 1',
        [input.holder_jkt]
      );
      if (inUse) return { inserted: false, reason: 'credential_in_use' };
      if (approval) return { inserted: false, reason: 'approval_revoked' };
      if (
        options.sessionId &&
        !(await this.sessionAlive(input.admin_user_id, options.sessionId, now))
      )
        return { inserted: false, reason: 'session_ended' };
      const active = await this.listActiveByUser(input.admin_user_id);
      return {
        inserted: false,
        reason: active.length > 0 ? 'already_enrolled' : 'enrollment_closed',
      };
    }
    return {
      inserted: true,
      factor: {
        id,
        admin_user_id: input.admin_user_id,
        kind: 'keyring_holder_key',
        credential_id: null,
        holder_jkt: input.holder_jkt,
        public_key: null,
        counter: 0,
        transports: null,
        aaguid: null,
        backup_eligible: null,
        backup_state: null,
        label: input.label ?? null,
        created_at: now,
        last_used_at: null,
        revoked_at: null,
      },
    };
  }

  /** The admin's active Keyring factor with this holder key, or null. */
  async findActiveKeyringFactor(
    adminUserId: string,
    holderJkt: string
  ): Promise<AdminSecondFactor | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT * FROM admin_second_factors
        WHERE admin_user_id = ? AND holder_jkt = ? AND kind = 'keyring_holder_key'
          AND revoked_at IS NULL`,
      [adminUserId, holderJkt]
    );
    return row ? this.rowToFactor(row) : null;
  }

  /**
   * Revoke the admin's Keyring factor with this holder key, when its credential was revoked: the
   * key can no longer be presented, and evidence it gave sessions (and receipts resting on it)
   * must stop counting at once. Not bound by the minimum, like an administrator's revocation.
   */
  async revokeKeyringHolderKey(adminUserId: string, holderJkt: string): Promise<boolean> {
    const factor = await this.findActiveKeyringFactor(adminUserId, holderJkt);
    if (!factor) return false;
    return this.revokeByAdmin(adminUserId, factor.id);
  }

  /**
   * The last-resort recovery (Cloudflare authority, through the setup tool): revoke every active
   * factor of the admin (the rows stay, so none can be registered again), end all their sessions
   * (with them every step-up requirement, receipt and Keyring presentation bound to a session),
   * cancel any open recovery request (it would otherwise replace the factor registered next), and
   * open the re-enrolment window until `reenrollUntil`. One batch: all of it or none.
   */
  async revokeAllForLastResort(
    adminUserId: string,
    input: { reenrollUntil: number; actorId: string; now?: number }
  ): Promise<AdminSecondFactorLastResortResult> {
    const now = input.now ?? getCurrentTimestamp();
    const [, , sessions] = await this.adapter.batch([
      {
        sql: 'UPDATE admin_users SET second_factor_reenroll_until = ?, updated_at = ? WHERE id = ?',
        params: [input.reenrollUntil, now, adminUserId],
      },
      {
        sql: `UPDATE admin_second_factors SET revoked_at = ?
          WHERE admin_user_id = ? AND revoked_at IS NULL`,
        params: [now, adminUserId],
      },
      {
        sql: 'DELETE FROM admin_sessions WHERE admin_user_id = ?',
        params: [adminUserId],
      },
      {
        sql: `UPDATE admin_second_factor_recoveries
          SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = 'last_resort'
          WHERE admin_user_id = ? AND status = 'pending'`,
        params: [now, input.actorId, adminUserId],
      },
    ]);
    const revoked = await this.adapter.query<{ id: string }>(
      'SELECT id FROM admin_second_factors WHERE admin_user_id = ? AND revoked_at = ? ORDER BY id',
      [adminUserId, now]
    );
    const cancelled = await this.adapter.query<{ id: string }>(
      `SELECT id FROM admin_second_factor_recoveries
        WHERE admin_user_id = ? AND status = 'cancelled' AND cancel_reason = 'last_resort'
          AND cancelled_at = ? ORDER BY id`,
      [adminUserId, now]
    );
    return {
      revokedFactorIds: revoked.map((row) => String(row.id)),
      endedSessions: sessions?.rowsAffected ?? 0,
      cancelledRecoveryIds: cancelled.map((row) => String(row.id)),
      reenrollUntil: input.reenrollUntil,
    };
  }

  /** Mark a factor used now (Keyring factors have no counter). */
  async touch(id: string, usedAt: number): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE admin_second_factors SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL',
      [usedAt, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Record a verified use: the new signature counter, the backup state and the time. The row is
   * updated only if its counter is still the one the assertion was verified against and the
   * factor is still active, so two concurrent uses cannot move the counter backwards.
   *
   * @returns False when another use or a revocation got there first
   */
  async recordUse(
    id: string,
    use: { expectedCounter: number; counter: number; backupState: boolean; usedAt: number }
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE admin_second_factors SET counter = ?, backup_state = ?, last_used_at = ?
        WHERE id = ? AND revoked_at IS NULL AND counter = ?`,
      [use.counter, use.backupState ? 1 : 0, use.usedAt, id, use.expectedCounter]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Revoke one of the admin's factors unless that would leave fewer than the minimum active.
   * The count is checked in the same statement, so concurrent removals cannot both pass it.
   * Sessions that verified the factor lose that evidence in the same batch.
   */
  async revoke(adminUserId: string, id: string): Promise<AdminSecondFactorRevokeResult> {
    const now = getCurrentTimestamp();
    const [revoke] = await this.adapter.batch([
      {
        sql: `UPDATE admin_second_factors SET revoked_at = ?
          WHERE id = ? AND admin_user_id = ? AND revoked_at IS NULL
            AND ${ACTIVE_COUNT_SQL} > ?`,
        params: [now, id, adminUserId, adminUserId, ADMIN_SECOND_FACTOR_MINIMUM],
      },
      {
        // Narrowed by admin so the admin_user_id index is used rather than a table scan.
        sql: `UPDATE admin_sessions SET second_factor_id = NULL, second_factor_verified_at = NULL
          WHERE admin_user_id = ? AND second_factor_id = ?
            AND EXISTS (SELECT 1 FROM admin_second_factors WHERE id = ? AND revoked_at IS NOT NULL)`,
        params: [adminUserId, id, id],
      },
    ]);
    if (revoke && revoke.rowsAffected > 0) {
      return { revoked: true };
    }
    const active = await this.isActive(adminUserId, id);
    return { revoked: false, reason: active ? 'minimum_reached' : 'not_found' };
  }

  /**
   * Revoke one of an admin's factors on another administrator's decision (a lost or compromised
   * key). Not held to the minimum: an admin left with none recovers through the waiting period.
   * Sessions that verified the factor lose that evidence in the same batch.
   *
   * @returns False when the factor is not the admin's or was revoked already
   */
  async revokeByAdmin(adminUserId: string, id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const [revoke] = await this.adapter.batch([
      {
        sql: `UPDATE admin_second_factors SET revoked_at = ?
          WHERE id = ? AND admin_user_id = ? AND revoked_at IS NULL`,
        params: [now, id, adminUserId],
      },
      {
        sql: `UPDATE admin_sessions SET second_factor_id = NULL, second_factor_verified_at = NULL
          WHERE admin_user_id = ? AND second_factor_id = ?
            AND EXISTS (SELECT 1 FROM admin_second_factors WHERE id = ? AND revoked_at IS NOT NULL)`,
        params: [adminUserId, id, id],
      },
    ]);
    return (revoke?.rowsAffected ?? 0) > 0;
  }

  /**
   * Run a factor INSERT and, in the same batch, close the admin's re-enrolment window if the row
   * was written: whichever way a factor is registered, the window does not outlive it.
   */
  private async insertConsumingWindow(
    adminUserId: string,
    factorId: string,
    sql: string,
    params: unknown[]
  ): Promise<{ rowsAffected: number }> {
    const [insert] = await this.adapter.batch([
      { sql, params },
      { sql: CONSUME_REENROLL_WINDOW_SQL, params: [adminUserId, factorId] },
    ]);
    return { rowsAffected: insert?.rowsAffected ?? 0 };
  }

  private async sessionAlive(adminUserId: string, sessionId: string, now: number) {
    const row = await this.adapter.queryOne<{ id: string }>(
      'SELECT id FROM admin_sessions WHERE id = ? AND admin_user_id = ? AND expires_at > ?',
      [sessionId, adminUserId, now]
    );
    return row !== null;
  }

  private rowToFactor(row: Record<string, unknown>): AdminSecondFactor {
    const flag = (value: unknown): boolean | null =>
      value === null || value === undefined ? null : Number(value) === 1;
    let transports: string[] | null = null;
    if (typeof row.transports_json === 'string') {
      try {
        const parsed: unknown = JSON.parse(row.transports_json);
        transports = Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === 'string')
          : null;
      } catch {
        transports = null;
      }
    }
    return {
      id: String(row.id),
      admin_user_id: String(row.admin_user_id),
      kind: row.kind === 'keyring_holder_key' ? 'keyring_holder_key' : 'webauthn_credential',
      credential_id: typeof row.credential_id === 'string' ? row.credential_id : null,
      holder_jkt: typeof row.holder_jkt === 'string' ? row.holder_jkt : null,
      public_key: typeof row.public_key === 'string' ? row.public_key : null,
      counter: Number(row.counter ?? 0),
      transports,
      aaguid: typeof row.aaguid === 'string' ? row.aaguid : null,
      backup_eligible: flag(row.backup_eligible),
      backup_state: flag(row.backup_state),
      label: typeof row.label === 'string' ? row.label : null,
      created_at: Number(row.created_at),
      last_used_at: typeof row.last_used_at === 'number' ? row.last_used_at : null,
      revoked_at: typeof row.revoked_at === 'number' ? row.revoked_at : null,
    };
  }
}

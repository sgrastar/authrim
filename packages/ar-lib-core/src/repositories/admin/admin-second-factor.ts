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
  | { inserted: false; reason: 'already_enrolled' | 'enrollment_closed' | 'credential_in_use' };

export type AdminSecondFactorRevokeResult =
  | { revoked: true }
  | { revoked: false; reason: 'not_found' | 'minimum_reached' };

const ACTIVE_COUNT_SQL = `(SELECT COUNT(*) FROM admin_second_factors
  WHERE admin_user_id = ? AND revoked_at IS NULL)`;

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
   * their first-enrollment window is still open, so two
   * concurrent first enrollments register one and a challenge issued before the window closed
   * cannot be used after it. A credential already registered as a sign-in passkey, or as any
   * second factor (revoked ones included), is refused.
   */
  async insertWebAuthn(
    input: AdminWebAuthnSecondFactorInput,
    options: { firstOnly: boolean; now?: number }
  ): Promise<AdminSecondFactorInsertResult> {
    const id = generateId();
    const now = options.now ?? getCurrentTimestamp();
    const result = await this.adapter.execute(
      `INSERT INTO admin_second_factors (
         id, admin_user_id, kind, credential_id, public_key, counter, transports_json, aaguid,
         backup_eligible, backup_state, label, created_at
       )
       SELECT ?, ?, 'webauthn_credential', ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM admin_passkeys WHERE credential_id = ?)
         AND NOT EXISTS (SELECT 1 FROM admin_second_factors WHERE credential_id = ?)
         AND (? = 0 OR (NOT EXISTS (
           SELECT 1 FROM admin_second_factors WHERE admin_user_id = ?
         ) AND EXISTS (
           SELECT 1 FROM admin_users
            WHERE id = ? AND COALESCE(second_factor_grace_started_at, created_at) + ? > ?
         )))`,
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
        options.firstOnly ? 1 : 0,
        input.admin_user_id,
        input.admin_user_id,
        ADMIN_SECOND_FACTOR_ENROLLMENT_GRACE_MS,
        now,
      ]
    );
    if (result.rowsAffected === 0) {
      const inUse = await this.adapter.queryOne<{ found: number }>(
        `SELECT 1 AS found FROM admin_passkeys WHERE credential_id = ?
         UNION ALL SELECT 1 FROM admin_second_factors WHERE credential_id = ? LIMIT 1`,
        [input.credential_id, input.credential_id]
      );
      if (inUse) return { inserted: false, reason: 'credential_in_use' };
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

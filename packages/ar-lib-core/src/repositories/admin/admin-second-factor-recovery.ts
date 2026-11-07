/**
 * Admin Second Factor Recovery Repository
 *
 * An admin who lost their step-up second factors asks to replace them. The request carries the
 * new, already verified credential; after the waiting period the admin completes it with a fresh
 * passkey, which revokes every old factor, activates the new one and ends the admin's other
 * sessions in one batch. Until then the admin or another admin of the tenant can cancel it.
 *
 * Every state change is a conditional write: one pending request per admin, completion only from
 * pending inside its window, cancellation only from pending.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';

/** How long a request waits before it can be completed. */
export const ADMIN_SECOND_FACTOR_RECOVERY_WAIT_MS = 24 * 60 * 60 * 1000;
/** How long after the wait a pending request stays completable. */
export const ADMIN_SECOND_FACTOR_RECOVERY_COMPLETION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type AdminSecondFactorRecoveryStatus = 'pending' | 'completed' | 'cancelled' | 'expired';
export type AdminSecondFactorRecoveryCancelReason =
  | 'requester'
  | 'admin'
  | 'notification_failed'
  // Cancelled by the last-resort recovery, which revoked every factor and opened re-enrolment
  | 'last_resort';

export interface AdminSecondFactorRecovery {
  id: string;
  admin_user_id: string;
  tenant_id: string;
  status: AdminSecondFactorRecoveryStatus;
  /** What the request will make the admin's second factor. */
  kind: AdminSecondFactorRecoveryKind;
  /** WebAuthn: the new credential. */
  credential_id: string | null;
  /** Keyring: the holder key, and the admin credential it was presented with. */
  holder_jkt: string | null;
  admin_credential_id: string | null;
  aaguid: string | null;
  label: string | null;
  requested_session_id: string;
  requested_at: number;
  /** When every notice was handed to delivery; only a notified request can be completed. */
  notified_at: number | null;
  not_before: number;
  expires_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: AdminSecondFactorRecoveryCancelReason | null;
}

export type AdminSecondFactorRecoveryKind = 'webauthn_credential' | 'keyring_holder_key';

interface AdminSecondFactorRecoveryInputBase {
  admin_user_id: string;
  tenant_id: string;
  label?: string | null;
  requested_session_id: string;
}

/** A new WebAuthn credential, verified when the request is filed. */
export interface AdminSecondFactorRecoveryWebAuthnInput extends AdminSecondFactorRecoveryInputBase {
  kind?: 'webauthn_credential';
  credential_id: string;
  public_key: string;
  counter: number;
  transports?: string[];
  aaguid?: string | null;
}

/** A Keyring holder key, presented with the admin's own admin credential. */
export interface AdminSecondFactorRecoveryKeyringInput extends AdminSecondFactorRecoveryInputBase {
  kind: 'keyring_holder_key';
  holder_jkt: string;
  admin_credential_id: string;
}

export type AdminSecondFactorRecoveryInput =
  | AdminSecondFactorRecoveryWebAuthnInput
  | AdminSecondFactorRecoveryKeyringInput;

export type AdminSecondFactorRecoveryCreateResult =
  | { created: true; recovery: AdminSecondFactorRecovery }
  | { created: false; reason: 'already_pending' | 'credential_in_use' | 'session_ended' };

export type AdminSecondFactorRecoveryCompleteResult =
  | { completed: true; secondFactorId: string; recovery: AdminSecondFactorRecovery }
  | { completed: false; reason: 'not_found' | 'too_early' | 'expired' };

const PENDING_SQL = `status = 'pending'`;

export class AdminSecondFactorRecoveryRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  /**
   * The admin's open request: pending, notified and inside its window. A request whose notices
   * did not all go out is inert; the next request closes it.
   */
  async findOpenByUser(
    adminUserId: string,
    now: number
  ): Promise<AdminSecondFactorRecovery | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT * FROM admin_second_factor_recoveries
        WHERE admin_user_id = ? AND ${PENDING_SQL} AND notified_at IS NOT NULL AND expires_at > ?`,
      [adminUserId, now]
    );
    return row ? this.rowToRecovery(row) : null;
  }

  async findById(id: string): Promise<AdminSecondFactorRecovery | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_second_factor_recoveries WHERE id = ?',
      [id]
    );
    return row ? this.rowToRecovery(row) : null;
  }

  /** Pending requests of the tenant's admins, newest first. */
  async listOpenByTenant(tenantId: string, now: number): Promise<AdminSecondFactorRecovery[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_second_factor_recoveries
        WHERE tenant_id = ? AND ${PENDING_SQL} AND notified_at IS NOT NULL AND expires_at > ?
        ORDER BY requested_at DESC LIMIT 100`,
      [tenantId, now]
    );
    return rows.map((row) => this.rowToRecovery(row));
  }

  /**
   * File a request. A pending request past its window is closed first; another open one makes
   * this fail. The credential must not already be a passkey or a second factor; a holder key must
   * never have been a second factor (revoked ones included, as for an enrolment).
   */
  async create(
    input: AdminSecondFactorRecoveryInput,
    now: number = getCurrentTimestamp()
  ): Promise<AdminSecondFactorRecoveryCreateResult> {
    const id = generateId();
    const notBefore = now + ADMIN_SECOND_FACTOR_RECOVERY_WAIT_MS;
    const expiresAt = notBefore + ADMIN_SECOND_FACTOR_RECOVERY_COMPLETION_WINDOW_MS;
    const keyring = input.kind === 'keyring_holder_key' ? input : null;
    const webauthn = input.kind === 'keyring_holder_key' ? null : input;
    const transports =
      webauthn?.transports && webauthn.transports.length > 0
        ? JSON.stringify(webauthn.transports)
        : null;
    const credentialId = webauthn?.credential_id ?? null;
    const holderJkt = keyring?.holder_jkt ?? null;
    const [, insert] = await this.adapter.batch([
      {
        // A request past its window, or one whose notices never all went out, is closed first.
        sql: `UPDATE admin_second_factor_recoveries SET status = 'expired'
          WHERE admin_user_id = ? AND ${PENDING_SQL}
            AND (expires_at <= ? OR notified_at IS NULL)`,
        params: [input.admin_user_id, now],
      },
      {
        sql: `INSERT INTO admin_second_factor_recoveries (
            id, admin_user_id, tenant_id, status, kind, credential_id, public_key, counter,
            transports_json, aaguid, label, holder_jkt, admin_credential_id,
            requested_session_id, requested_at, not_before, expires_at
          )
          SELECT ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
              SELECT 1 FROM admin_second_factor_recoveries
               WHERE admin_user_id = ? AND ${PENDING_SQL}
            )
            AND NOT EXISTS (SELECT 1 FROM admin_passkeys WHERE credential_id = ?)
            AND NOT EXISTS (SELECT 1 FROM admin_second_factors WHERE credential_id = ?)
            AND NOT EXISTS (SELECT 1 FROM admin_second_factors WHERE holder_jkt = ?)
            -- The session that asked must still be the admin's: the last-resort recovery ends
            -- every session and cancels open requests, and a request in flight then must not
            -- land after it.
            AND EXISTS (
              SELECT 1 FROM admin_sessions WHERE id = ? AND admin_user_id = ? AND expires_at > ?
            )`,
        params: [
          id,
          input.admin_user_id,
          input.tenant_id,
          keyring ? 'keyring_holder_key' : 'webauthn_credential',
          credentialId,
          webauthn?.public_key ?? null,
          webauthn?.counter ?? 0,
          transports,
          webauthn?.aaguid ?? null,
          input.label ?? null,
          holderJkt,
          keyring?.admin_credential_id ?? null,
          input.requested_session_id,
          now,
          notBefore,
          expiresAt,
          input.admin_user_id,
          credentialId,
          credentialId,
          holderJkt,
          input.requested_session_id,
          input.admin_user_id,
          now,
        ],
      },
    ]);
    if (!insert || insert.rowsAffected === 0) {
      const pending = await this.adapter.queryOne<{ id: string }>(
        `SELECT id FROM admin_second_factor_recoveries WHERE admin_user_id = ? AND ${PENDING_SQL}`,
        [input.admin_user_id]
      );
      if (pending) return { created: false, reason: 'already_pending' };
      const session = await this.adapter.queryOne<{ id: string }>(
        'SELECT id FROM admin_sessions WHERE id = ? AND admin_user_id = ? AND expires_at > ?',
        [input.requested_session_id, input.admin_user_id, now]
      );
      return { created: false, reason: session ? 'credential_in_use' : 'session_ended' };
    }
    return {
      created: true,
      recovery: {
        id,
        admin_user_id: input.admin_user_id,
        tenant_id: input.tenant_id,
        status: 'pending',
        kind: keyring ? 'keyring_holder_key' : 'webauthn_credential',
        credential_id: credentialId,
        holder_jkt: holderJkt,
        admin_credential_id: keyring?.admin_credential_id ?? null,
        aaguid: webauthn?.aaguid ?? null,
        label: input.label ?? null,
        requested_session_id: input.requested_session_id,
        requested_at: now,
        notified_at: null,
        not_before: notBefore,
        expires_at: expiresAt,
        completed_at: null,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
      },
    };
  }

  /** Record that every notice of a pending request was handed to delivery. */
  async markNotified(id: string, now: number = getCurrentTimestamp()): Promise<boolean> {
    const result = await this.adapter.execute(
      `UPDATE admin_second_factor_recoveries SET notified_at = ?
        WHERE id = ? AND ${PENDING_SQL} AND notified_at IS NULL`,
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Cancel a pending request. `tenantId` limits it to requests of that tenant's admins (another
   * admin cancelling); `adminUserId` to the requester's own.
   */
  async cancel(
    id: string,
    scope: { tenantId: string } | { adminUserId: string },
    by: { adminUserId: string; reason: AdminSecondFactorRecoveryCancelReason },
    now: number = getCurrentTimestamp()
  ): Promise<boolean> {
    const [column, value] =
      'tenantId' in scope ? ['tenant_id', scope.tenantId] : ['admin_user_id', scope.adminUserId];
    const result = await this.adapter.execute(
      `UPDATE admin_second_factor_recoveries
          SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
        WHERE id = ? AND ${column} = ? AND ${PENDING_SQL} AND expires_at > ?`,
      [now, by.adminUserId, by.reason, id, value, now]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Complete the admin's pending request inside its window. In one batch: the request becomes
   * completed, every active second factor of the admin is revoked, the request's credential (or
   * holder key) becomes the admin's only second factor, the admin's other sessions end and the current
   * session loses any second-factor evidence. Each follow-up statement runs only if this call
   * completed the request (matched on the completion time it wrote).
   */
  async complete(
    adminUserId: string,
    currentSessionId: string,
    now: number = getCurrentTimestamp()
  ): Promise<AdminSecondFactorRecoveryCompleteResult> {
    const open = await this.findOpenByUser(adminUserId, now);
    if (!open || open.notified_at === null) return { completed: false, reason: 'not_found' };
    if (now < open.not_before) return { completed: false, reason: 'too_early' };

    const factorId = generateId();
    const completedHere = `EXISTS (
      SELECT 1 FROM admin_second_factor_recoveries
       WHERE id = ? AND status = 'completed' AND completed_at = ?
    )`;
    const [completed] = await this.adapter.batch([
      {
        sql: `UPDATE admin_second_factor_recoveries SET status = 'completed', completed_at = ?
          WHERE id = ? AND admin_user_id = ? AND ${PENDING_SQL} AND notified_at IS NOT NULL
            AND not_before <= ? AND expires_at > ?`,
        params: [now, open.id, adminUserId, now, now],
      },
      {
        sql: `UPDATE admin_second_factors SET revoked_at = ?
          WHERE admin_user_id = ? AND revoked_at IS NULL AND ${completedHere}`,
        params: [now, adminUserId, open.id, now],
      },
      {
        sql: `INSERT INTO admin_second_factors (
            id, admin_user_id, kind, credential_id, holder_jkt, public_key, counter,
            transports_json, aaguid, backup_eligible, backup_state, label, created_at
          )
          SELECT ?, admin_user_id, kind, credential_id, holder_jkt, public_key, counter,
                 transports_json, aaguid,
                 CASE kind WHEN 'webauthn_credential' THEN 0 END,
                 CASE kind WHEN 'webauthn_credential' THEN 0 END,
                 label, ?
            FROM admin_second_factor_recoveries
           WHERE id = ? AND status = 'completed' AND completed_at = ?`,
        params: [factorId, now, open.id, now],
      },
      {
        sql: `DELETE FROM admin_sessions
          WHERE admin_user_id = ? AND id <> ? AND ${completedHere}`,
        params: [adminUserId, currentSessionId, open.id, now],
      },
      {
        sql: `UPDATE admin_sessions SET second_factor_id = NULL, second_factor_verified_at = NULL
          WHERE admin_user_id = ? AND id = ? AND ${completedHere}`,
        params: [adminUserId, currentSessionId, open.id, now],
      },
      {
        // A factor is registered: a re-enrolment window the last-resort recovery opened is used
        // up too, as when a factor is registered through it.
        sql: `UPDATE admin_users SET second_factor_reenroll_until = NULL
          WHERE id = ? AND second_factor_reenroll_until IS NOT NULL AND ${completedHere}`,
        params: [adminUserId, open.id, now],
      },
    ]);
    if (!completed || completed.rowsAffected === 0) {
      const again = await this.findOpenByUser(adminUserId, now);
      return {
        completed: false,
        reason: !again ? 'not_found' : now < again.not_before ? 'too_early' : 'expired',
      };
    }
    return {
      completed: true,
      secondFactorId: factorId,
      recovery: { ...open, status: 'completed', completed_at: now },
    };
  }

  private rowToRecovery(row: Record<string, unknown>): AdminSecondFactorRecovery {
    const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
    const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const status = String(row.status);
    const reason = str(row.cancel_reason);
    return {
      id: String(row.id),
      admin_user_id: String(row.admin_user_id),
      tenant_id: String(row.tenant_id),
      status:
        status === 'completed' || status === 'cancelled' || status === 'expired'
          ? status
          : 'pending',
      kind: row.kind === 'keyring_holder_key' ? 'keyring_holder_key' : 'webauthn_credential',
      credential_id: str(row.credential_id),
      holder_jkt: str(row.holder_jkt),
      admin_credential_id: str(row.admin_credential_id),
      aaguid: str(row.aaguid),
      label: str(row.label),
      requested_session_id: String(row.requested_session_id),
      requested_at: Number(row.requested_at),
      notified_at: num(row.notified_at),
      not_before: Number(row.not_before),
      expires_at: Number(row.expires_at),
      completed_at: num(row.completed_at),
      cancelled_at: num(row.cancelled_at),
      cancelled_by: str(row.cancelled_by),
      cancel_reason:
        reason === 'requester' ||
        reason === 'admin' ||
        reason === 'notification_failed' ||
        reason === 'last_resort'
          ? reason
          : null,
    };
  }
}

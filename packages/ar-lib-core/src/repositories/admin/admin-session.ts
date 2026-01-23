/**
 * Admin Session Repository
 *
 * Repository for Admin session data stored in DB_ADMIN.
 * Admin sessions are stored in D1 instead of Durable Objects for:
 * - Simpler management (fewer admin users)
 * - Direct SQL queries for security monitoring
 * - Easy invalidation of all sessions for a user
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';
import type { AdminSession, AdminSessionCreateInput } from '../../types/admin-user';

/**
 * Admin session entity (extends BaseEntity for repository compatibility)
 */
interface AdminSessionEntity extends BaseEntity {
  tenant_id: string;
  admin_user_id: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: number;
  last_activity_at: number | null;
  mfa_verified: boolean;
  mfa_verified_at: number | null;
}

/**
 * Admin Session Repository
 */
export class AdminSessionRepository extends BaseRepository<AdminSessionEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_sessions',
      primaryKey: 'id',
      softDelete: false, // Sessions are hard deleted
      allowedFields: [
        'tenant_id',
        'admin_user_id',
        'ip_address',
        'user_agent',
        'expires_at',
        'last_activity_at',
        'mfa_verified',
        'mfa_verified_at',
      ],
    });
  }

  /**
   * Create a new Admin session
   *
   * @param input - Session creation input
   * @returns Created session
   */
  async createSession(input: AdminSessionCreateInput): Promise<AdminSession> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const session: AdminSessionEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      admin_user_id: input.admin_user_id,
      ip_address: input.ip_address ?? null,
      user_agent: input.user_agent ?? null,
      created_at: now,
      expires_at: input.expires_at,
      last_activity_at: now,
      updated_at: now,
      mfa_verified: input.mfa_verified ?? false,
      mfa_verified_at: input.mfa_verified ? now : null,
    };

    const sql = `
      INSERT INTO admin_sessions (
        id, tenant_id, admin_user_id, ip_address, user_agent,
        created_at, expires_at, last_activity_at, mfa_verified, mfa_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      session.id,
      session.tenant_id,
      session.admin_user_id,
      session.ip_address,
      session.user_agent,
      session.created_at,
      session.expires_at,
      session.last_activity_at,
      session.mfa_verified ? 1 : 0,
      session.mfa_verified_at,
    ]);

    return this.entityToSession(session);
  }

  /**
   * Get session by ID
   *
   * @param id - Session ID
   * @returns Session or null (excludes expired sessions)
   */
  async getSession(id: string): Promise<AdminSession | null> {
    const now = getCurrentTimestamp();
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_sessions WHERE id = ? AND expires_at > ?',
      [id, now]
    );
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Get session by ID (including expired)
   *
   * @param id - Session ID
   * @returns Session or null
   */
  async getSessionIncludingExpired(id: string): Promise<AdminSession | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_sessions WHERE id = ?',
      [id]
    );
    return row ? this.rowToSession(row) : null;
  }

  /**
   * Update session activity timestamp
   *
   * @param id - Session ID
   * @returns True if updated
   */
  async updateActivity(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'UPDATE admin_sessions SET last_activity_at = ? WHERE id = ?',
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Mark session as MFA verified
   *
   * @param id - Session ID
   * @returns True if updated
   */
  async setMfaVerified(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'UPDATE admin_sessions SET mfa_verified = 1, mfa_verified_at = ? WHERE id = ?',
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Extend session expiration
   *
   * @param id - Session ID
   * @param newExpiresAt - New expiration timestamp
   * @returns True if updated
   */
  async extendSession(id: string, newExpiresAt: number): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'UPDATE admin_sessions SET expires_at = ?, last_activity_at = ? WHERE id = ?',
      [newExpiresAt, now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Delete/revoke a session
   *
   * @param id - Session ID
   * @returns True if deleted
   */
  async deleteSession(id: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM admin_sessions WHERE id = ?', [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete all sessions for an Admin user
   *
   * @param adminUserId - Admin user ID
   * @returns Number of deleted sessions
   */
  async deleteAllByUser(adminUserId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_sessions WHERE admin_user_id = ?',
      [adminUserId]
    );
    return result.rowsAffected;
  }

  /**
   * Delete all sessions for an Admin user except one
   *
   * @param adminUserId - Admin user ID
   * @param exceptSessionId - Session ID to keep
   * @returns Number of deleted sessions
   */
  async deleteAllByUserExcept(adminUserId: string, exceptSessionId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_sessions WHERE admin_user_id = ? AND id != ?',
      [adminUserId, exceptSessionId]
    );
    return result.rowsAffected;
  }

  /**
   * Get all active sessions for an Admin user
   *
   * @param adminUserId - Admin user ID
   * @returns List of active sessions
   */
  async getSessionsByUser(adminUserId: string): Promise<AdminSession[]> {
    const now = getCurrentTimestamp();
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT * FROM admin_sessions WHERE admin_user_id = ? AND expires_at > ? ORDER BY created_at DESC',
      [adminUserId, now]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  /**
   * Count active sessions for an Admin user
   *
   * @param adminUserId - Admin user ID
   * @returns Number of active sessions
   */
  async countSessionsByUser(adminUserId: string): Promise<number> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_sessions WHERE admin_user_id = ? AND expires_at > ?',
      [adminUserId, now]
    );
    return result?.count ?? 0;
  }

  /**
   * Delete all expired sessions
   *
   * @returns Number of deleted sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute('DELETE FROM admin_sessions WHERE expires_at <= ?', [
      now,
    ]);
    return result.rowsAffected;
  }

  /**
   * Get sessions by IP address (for security monitoring)
   *
   * @param ipAddress - IP address
   * @param limit - Maximum results
   * @returns List of sessions
   */
  async getSessionsByIp(ipAddress: string, limit: number = 100): Promise<AdminSession[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      'SELECT * FROM admin_sessions WHERE ip_address = ? ORDER BY created_at DESC LIMIT ?',
      [ipAddress, limit]
    );
    return rows.map((row) => this.rowToSession(row));
  }

  /**
   * Map database row to AdminSession
   */
  private rowToSession(row: Record<string, unknown>): AdminSession {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      admin_user_id: row.admin_user_id as string,
      ip_address: row.ip_address as string | null,
      user_agent: row.user_agent as string | null,
      created_at: row.created_at as number,
      expires_at: row.expires_at as number,
      last_activity_at: row.last_activity_at as number | null,
      mfa_verified: Boolean(row.mfa_verified),
      mfa_verified_at: row.mfa_verified_at as number | null,
    };
  }

  /**
   * Convert entity to AdminSession type
   */
  private entityToSession(entity: AdminSessionEntity): AdminSession {
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      admin_user_id: entity.admin_user_id,
      ip_address: entity.ip_address,
      user_agent: entity.user_agent,
      created_at: entity.created_at,
      expires_at: entity.expires_at,
      last_activity_at: entity.last_activity_at,
      mfa_verified: entity.mfa_verified,
      mfa_verified_at: entity.mfa_verified_at,
    };
  }
}

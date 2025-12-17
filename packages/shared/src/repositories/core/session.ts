/**
 * Session Repository
 *
 * Repository for user sessions stored in D1_CORE database.
 * Handles session lifecycle: creation, validation, expiration, and cleanup.
 *
 * Key features:
 * - Session creation with configurable TTL
 * - Expiration checking and cleanup
 * - External provider mapping for OIDC backchannel logout
 * - Bulk operations for user logout (terminate all sessions)
 *
 * Note: Does not extend BaseRepository because sessions table
 * doesn't have updated_at field (by design - sessions are immutable after creation).
 *
 * Table: sessions
 * Schema:
 *   - id: TEXT PRIMARY KEY (UUID)
 *   - user_id: TEXT NOT NULL (FK to users)
 *   - expires_at: INTEGER NOT NULL (timestamp)
 *   - created_at: INTEGER NOT NULL (timestamp)
 *   - external_provider_id: TEXT (for backchannel logout)
 *   - external_provider_sub: TEXT (external IdP subject)
 */

import { generateId, getCurrentTimestamp } from '../base';
import type { DatabaseAdapter } from '../../db/adapter';

/**
 * Session entity representing a user session
 */
export interface Session {
  /** Unique session ID (UUID) */
  id: string;
  /** User ID this session belongs to */
  user_id: string;
  /** Session expiration timestamp (Unix ms) */
  expires_at: number;
  /** Session creation timestamp (Unix ms) */
  created_at: number;
  /** External IdP provider ID (for backchannel logout) */
  external_provider_id: string | null;
  /** External IdP subject identifier (for backchannel logout) */
  external_provider_sub: string | null;
}

/**
 * Input for creating a new session
 */
export interface CreateSessionInput {
  /** Optional session ID (auto-generated if not provided) */
  id?: string;
  /** User ID this session belongs to */
  user_id: string;
  /** Session TTL in milliseconds (default: 24 hours) */
  ttl_ms?: number;
  /** External IdP provider ID (for backchannel logout) */
  external_provider_id?: string;
  /** External IdP subject identifier (for backchannel logout) */
  external_provider_sub?: string;
}

/**
 * Input for updating a session
 */
export interface UpdateSessionInput {
  /** New expiration timestamp (Unix ms) */
  expires_at?: number;
  /** External IdP provider ID */
  external_provider_id?: string;
  /** External IdP subject identifier */
  external_provider_sub?: string;
}

/**
 * Filter options for session queries
 */
export interface SessionFilterOptions {
  /** Filter by user ID */
  user_id?: string;
  /** Filter by external provider ID */
  external_provider_id?: string;
  /** Filter by external provider subject */
  external_provider_sub?: string;
  /** Include only valid (non-expired) sessions */
  valid_only?: boolean;
  /** Include only expired sessions */
  expired_only?: boolean;
}

/**
 * Database row type for sessions table
 */
interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
  external_provider_id: string | null;
  external_provider_sub: string | null;
}

/** Default session TTL: 24 hours in milliseconds */
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum allowed TTL: 1 minute in milliseconds */
const MIN_SESSION_TTL_MS = 60 * 1000;

/** Maximum allowed TTL: 30 days in milliseconds */
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Session Repository
 *
 * Provides CRUD operations for user sessions with:
 * - Automatic expiration handling
 * - External IdP mapping for OIDC backchannel logout
 * - Bulk session termination
 */
export class SessionRepository {
  protected readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  /**
   * Validate and normalize TTL value
   * @param ttl - TTL in milliseconds (must be positive)
   * @param defaultValue - Default value if TTL is invalid
   * @returns Validated TTL clamped to [MIN_SESSION_TTL_MS, MAX_SESSION_TTL_MS]
   */
  private validateTtl(ttl: number | undefined, defaultValue: number): number {
    if (ttl === undefined) {
      return defaultValue;
    }

    // Reject non-positive or non-finite values
    if (!Number.isFinite(ttl) || ttl <= 0) {
      return defaultValue;
    }

    // Clamp to bounds
    return Math.min(Math.max(ttl, MIN_SESSION_TTL_MS), MAX_SESSION_TTL_MS);
  }

  /**
   * Create a new session
   *
   * @param input - Session creation input
   * @returns Created session
   */
  async create(input: CreateSessionInput): Promise<Session> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();
    // Validate TTL to prevent sessions that expire in the past or too far in the future
    const ttl = this.validateTtl(input.ttl_ms, DEFAULT_SESSION_TTL_MS);
    const expiresAt = now + ttl;

    const sql = `
      INSERT INTO sessions (id, user_id, expires_at, created_at, external_provider_id, external_provider_sub)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      id,
      input.user_id,
      expiresAt,
      now,
      input.external_provider_id ?? null,
      input.external_provider_sub ?? null,
    ]);

    return {
      id,
      user_id: input.user_id,
      expires_at: expiresAt,
      created_at: now,
      external_provider_id: input.external_provider_id ?? null,
      external_provider_sub: input.external_provider_sub ?? null,
    };
  }

  /**
   * Find session by ID
   *
   * @param id - Session ID
   * @returns Session or null if not found
   */
  async findById(id: string): Promise<Session | null> {
    const sql = 'SELECT * FROM sessions WHERE id = ?';
    const row = await this.adapter.queryOne<SessionRow>(sql, [id]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find valid (non-expired) session by ID
   *
   * @param id - Session ID
   * @returns Valid session or null if not found or expired
   */
  async findValidById(id: string): Promise<Session | null> {
    const now = getCurrentTimestamp();
    const sql = 'SELECT * FROM sessions WHERE id = ? AND expires_at > ?';
    const row = await this.adapter.queryOne<SessionRow>(sql, [id, now]);
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Find all sessions for a user
   *
   * @param userId - User ID
   * @param validOnly - If true, return only non-expired sessions
   * @returns Array of sessions
   */
  async findByUserId(userId: string, validOnly = false): Promise<Session[]> {
    let sql = 'SELECT * FROM sessions WHERE user_id = ?';
    const params: unknown[] = [userId];

    if (validOnly) {
      const now = getCurrentTimestamp();
      sql += ' AND expires_at > ?';
      params.push(now);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = await this.adapter.query<SessionRow>(sql, params);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Find sessions by external provider (for backchannel logout)
   *
   * @param providerId - External IdP provider ID
   * @param providerSub - External IdP subject identifier
   * @returns Array of matching sessions
   */
  async findByExternalProvider(providerId: string, providerSub: string): Promise<Session[]> {
    const sql = `
      SELECT * FROM sessions
      WHERE external_provider_id = ? AND external_provider_sub = ?
      ORDER BY created_at DESC
    `;

    const rows = await this.adapter.query<SessionRow>(sql, [providerId, providerSub]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Find valid sessions by external provider (for backchannel logout)
   *
   * @param providerId - External IdP provider ID
   * @param providerSub - External IdP subject identifier
   * @returns Array of valid (non-expired) sessions
   */
  async findValidByExternalProvider(providerId: string, providerSub: string): Promise<Session[]> {
    const now = getCurrentTimestamp();
    const sql = `
      SELECT * FROM sessions
      WHERE external_provider_id = ? AND external_provider_sub = ? AND expires_at > ?
      ORDER BY created_at DESC
    `;

    const rows = await this.adapter.query<SessionRow>(sql, [providerId, providerSub, now]);
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Validate expires_at to ensure it's within acceptable bounds
   * @param expiresAt - Proposed expiration timestamp
   * @returns Validated expires_at or null if invalid
   */
  private validateExpiresAt(expiresAt: number): number | null {
    const now = getCurrentTimestamp();

    // Must be a valid finite number
    if (!Number.isFinite(expiresAt)) {
      return null;
    }

    // Must not be in the past
    if (expiresAt <= now) {
      return null;
    }

    // Must not exceed MAX_SESSION_TTL_MS from now
    const maxExpiresAt = now + MAX_SESSION_TTL_MS;
    if (expiresAt > maxExpiresAt) {
      return maxExpiresAt; // Cap to maximum
    }

    return expiresAt;
  }

  /**
   * Update a session
   *
   * @param id - Session ID
   * @param input - Update input
   * @returns Updated session or null if not found or invalid input
   */
  async update(id: string, input: UpdateSessionInput): Promise<Session | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (input.expires_at !== undefined) {
      // Validate expires_at to prevent past or excessively future timestamps
      const validExpiresAt = this.validateExpiresAt(input.expires_at);
      if (validExpiresAt === null) {
        return null; // Invalid expires_at
      }
      updates.push('expires_at = ?');
      params.push(validExpiresAt);
    }

    if (input.external_provider_id !== undefined) {
      updates.push('external_provider_id = ?');
      params.push(input.external_provider_id);
    }

    if (input.external_provider_sub !== undefined) {
      updates.push('external_provider_sub = ?');
      params.push(input.external_provider_sub);
    }

    if (updates.length === 0) {
      return existing;
    }

    const sql = `UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`;
    params.push(id);

    await this.adapter.execute(sql, params);
    return this.findById(id);
  }

  /**
   * Extend session expiration (refresh session)
   *
   * @param id - Session ID
   * @param additionalTtlMs - Additional TTL in milliseconds (must be positive, max 30 days)
   * @returns Updated session or null if not found or invalid TTL
   */
  async extendExpiration(id: string, additionalTtlMs: number): Promise<Session | null> {
    // Validate additionalTtlMs to prevent negative extensions or overflow
    if (!Number.isFinite(additionalTtlMs) || additionalTtlMs <= 0) {
      return null; // Invalid extension request
    }

    // Cap the extension to MAX_SESSION_TTL_MS
    const validExtension = Math.min(additionalTtlMs, MAX_SESSION_TTL_MS);

    const session = await this.findById(id);
    if (!session) {
      return null;
    }

    const now = getCurrentTimestamp();
    const newExpiresAt = Math.max(session.expires_at, now) + validExtension;

    return this.update(id, { expires_at: newExpiresAt });
  }

  /**
   * Delete a session (logout)
   *
   * @param id - Session ID
   * @returns True if deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    const sql = 'DELETE FROM sessions WHERE id = ?';
    const result = await this.adapter.execute(sql, [id]);
    return result.rowsAffected > 0;
  }

  /**
   * Delete all sessions for a user (full logout)
   *
   * @param userId - User ID
   * @returns Number of deleted sessions
   */
  async deleteByUserId(userId: string): Promise<number> {
    const sql = 'DELETE FROM sessions WHERE user_id = ?';
    const result = await this.adapter.execute(sql, [userId]);
    return result.rowsAffected;
  }

  /**
   * Delete sessions by external provider (backchannel logout)
   *
   * @param providerId - External IdP provider ID
   * @param providerSub - External IdP subject identifier
   * @returns Number of deleted sessions
   */
  async deleteByExternalProvider(providerId: string, providerSub: string): Promise<number> {
    const sql = `
      DELETE FROM sessions
      WHERE external_provider_id = ? AND external_provider_sub = ?
    `;
    const result = await this.adapter.execute(sql, [providerId, providerSub]);
    return result.rowsAffected;
  }

  /**
   * Check if session is valid (exists and not expired)
   *
   * @param id - Session ID
   * @returns True if valid, false otherwise
   */
  async isValid(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const sql = 'SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?';
    const result = await this.adapter.queryOne<{ 1: number }>(sql, [id, now]);
    return result !== null;
  }

  /**
   * Count sessions for a user
   *
   * @param userId - User ID
   * @param validOnly - If true, count only non-expired sessions
   * @returns Number of sessions
   */
  async countByUserId(userId: string, validOnly = false): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM sessions WHERE user_id = ?';
    const params: unknown[] = [userId];

    if (validOnly) {
      const now = getCurrentTimestamp();
      sql += ' AND expires_at > ?';
      params.push(now);
    }

    const result = await this.adapter.queryOne<{ count: number }>(sql, params);
    return result?.count ?? 0;
  }

  /**
   * Cleanup expired sessions
   *
   * @returns Number of deleted expired sessions
   */
  async cleanupExpired(): Promise<number> {
    const now = getCurrentTimestamp();
    const sql = 'DELETE FROM sessions WHERE expires_at <= ?';
    const result = await this.adapter.execute(sql, [now]);
    return result.rowsAffected;
  }

  /**
   * Cleanup expired sessions older than a certain age
   *
   * @param maxAgeMs - Maximum age in milliseconds (sessions expired longer than this will be deleted)
   * @returns Number of deleted sessions
   */
  async cleanupExpiredOlderThan(maxAgeMs: number): Promise<number> {
    const cutoff = getCurrentTimestamp() - maxAgeMs;
    const sql = 'DELETE FROM sessions WHERE expires_at <= ?';
    const result = await this.adapter.execute(sql, [cutoff]);
    return result.rowsAffected;
  }

  /**
   * Get session statistics for a user
   *
   * @param userId - User ID
   * @returns Session statistics
   */
  async getStatsForUser(userId: string): Promise<{
    total: number;
    active: number;
    expired: number;
  }> {
    const now = getCurrentTimestamp();
    const sql = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) as expired
      FROM sessions WHERE user_id = ?
    `;

    const result = await this.adapter.queryOne<{
      total: number;
      active: number;
      expired: number;
    }>(sql, [now, now, userId]);

    return {
      total: result?.total ?? 0,
      active: result?.active ?? 0,
      expired: result?.expired ?? 0,
    };
  }

  /**
   * Convert database row to Session entity
   */
  private rowToEntity(row: SessionRow): Session {
    return {
      id: row.id,
      user_id: row.user_id,
      expires_at: row.expires_at,
      created_at: row.created_at,
      external_provider_id: row.external_provider_id,
      external_provider_sub: row.external_provider_sub,
    };
  }
}

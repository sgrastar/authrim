/**
 * Tombstone Repository
 *
 * Repository for tracking PII deletions for GDPR Art.17 compliance.
 * Stores deletion facts (not PII) to:
 * - Prevent re-registration of deleted accounts during retention period
 * - Provide audit trail for compliance
 * - Support "right to be forgotten" implementation
 *
 * Design decisions:
 * - NO PII stored (only email_blind_index for duplicate prevention)
 * - Auto-expires after retention_until
 * - Tracks who/when/why deleted
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';

/**
 * Tombstone entity
 */
export interface Tombstone extends BaseEntity {
  tenant_id: string;
  email_blind_index: string | null;
  deleted_at: number;
  deleted_by: string | null;
  deletion_reason: string | null;
  retention_until: number;
  deletion_metadata: string | null; // JSON
}

/**
 * Deletion reason types
 */
export type DeletionReason =
  | 'user_request' // GDPR Art.17 request
  | 'admin_action' // Admin initiated
  | 'inactivity' // Automated cleanup
  | 'account_abuse' // Policy violation
  | 'data_breach_response' // Security incident
  | 'other';

/**
 * Tombstone create input
 */
export interface CreateTombstoneInput {
  id: string; // Same as original user ID
  tenant_id?: string;
  email_blind_index?: string | null;
  deleted_by?: string | null;
  deletion_reason?: DeletionReason | string | null;
  retention_days?: number; // Default: 90
  metadata?: Record<string, unknown>;
}

/**
 * Tombstone Repository
 */
export class TombstoneRepository extends BaseRepository<Tombstone> {
  /** Default retention period in days */
  static readonly DEFAULT_RETENTION_DAYS = 90;

  /** Maximum allowed limit for queries */
  private static readonly MAX_QUERY_LIMIT = 1000;

  /**
   * Validate and normalize limit parameter
   * @param limit - Requested limit
   * @returns Validated limit (1-1000)
   */
  private validateLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) {
      return 100; // Safe default
    }
    return Math.min(limit, TombstoneRepository.MAX_QUERY_LIMIT);
  }

  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'users_pii_tombstone',
      primaryKey: 'id',
      softDelete: false, // Tombstones are never soft-deleted
      allowedFields: [
        'tenant_id',
        'email_blind_index',
        'deleted_at',
        'deleted_by',
        'deletion_reason',
        'retention_until',
        'deletion_metadata',
      ],
    });
  }

  /**
   * Create tombstone record
   *
   * @param input - Tombstone data
   * @param adapter - Optional partition-specific adapter
   * @returns Created tombstone
   */
  async createTombstone(
    input: CreateTombstoneInput,
    adapter?: DatabaseAdapter
  ): Promise<Tombstone> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();
    const retentionDays = input.retention_days ?? TombstoneRepository.DEFAULT_RETENTION_DAYS;
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    const tombstone: Tombstone = {
      id: input.id,
      tenant_id: input.tenant_id ?? 'default',
      email_blind_index: input.email_blind_index ?? null,
      deleted_at: now,
      deleted_by: input.deleted_by ?? null,
      deletion_reason: input.deletion_reason ?? null,
      retention_until: now + retentionMs,
      deletion_metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO users_pii_tombstone (
        id, tenant_id, email_blind_index, deleted_at, deleted_by,
        deletion_reason, retention_until, deletion_metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await db.execute(sql, [
      tombstone.id,
      tombstone.tenant_id,
      tombstone.email_blind_index,
      tombstone.deleted_at,
      tombstone.deleted_by,
      tombstone.deletion_reason,
      tombstone.retention_until,
      tombstone.deletion_metadata,
      tombstone.created_at,
      tombstone.updated_at,
    ]);

    return tombstone;
  }

  /**
   * Find tombstone by original user ID
   *
   * @param userId - Original user ID
   * @param adapter - Optional partition-specific adapter
   * @returns Tombstone or null
   */
  async findByUserId(userId: string, adapter?: DatabaseAdapter): Promise<Tombstone | null> {
    const db = adapter ?? this.adapter;
    return db.queryOne<Tombstone>('SELECT * FROM users_pii_tombstone WHERE id = ?', [userId]);
  }

  /**
   * Check if email is in tombstone (prevents re-registration)
   *
   * @param emailBlindIndex - Email blind index
   * @param tenantId - Tenant ID
   * @param adapter - Optional partition-specific adapter
   * @returns True if email is tombstoned and retention not expired
   */
  async isEmailTombstoned(
    emailBlindIndex: string,
    tenantId: string,
    adapter?: DatabaseAdapter
  ): Promise<boolean> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();

    const result = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM users_pii_tombstone
       WHERE email_blind_index = ? AND tenant_id = ? AND retention_until > ?`,
      [emailBlindIndex, tenantId, now]
    );

    return (result?.count ?? 0) > 0;
  }

  /**
   * Get tombstone for email (if exists and not expired)
   *
   * @param emailBlindIndex - Email blind index
   * @param tenantId - Tenant ID
   * @param adapter - Optional partition-specific adapter
   * @returns Tombstone or null
   */
  async findByEmailBlindIndex(
    emailBlindIndex: string,
    tenantId: string,
    adapter?: DatabaseAdapter
  ): Promise<Tombstone | null> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();

    return db.queryOne<Tombstone>(
      `SELECT * FROM users_pii_tombstone
       WHERE email_blind_index = ? AND tenant_id = ? AND retention_until > ?`,
      [emailBlindIndex, tenantId, now]
    );
  }

  /**
   * Find expired tombstones for cleanup
   *
   * @param limit - Maximum number to return (1-1000, default 1000)
   * @param adapter - Optional partition-specific adapter
   * @returns Expired tombstones
   */
  async findExpired(limit: number = 1000, adapter?: DatabaseAdapter): Promise<Tombstone[]> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();
    const validLimit = this.validateLimit(limit);

    return db.query<Tombstone>(
      'SELECT * FROM users_pii_tombstone WHERE retention_until < ? LIMIT ?',
      [now, validLimit]
    );
  }

  /**
   * Delete expired tombstones
   *
   * @param adapter - Optional partition-specific adapter
   * @returns Number of deleted tombstones
   */
  async cleanupExpired(adapter?: DatabaseAdapter): Promise<number> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();

    const result = await db.execute('DELETE FROM users_pii_tombstone WHERE retention_until < ?', [
      now,
    ]);

    return result.rowsAffected;
  }

  /**
   * Get tombstone statistics
   *
   * @param tenantId - Optional tenant filter
   * @param adapter - Optional partition-specific adapter
   * @returns Statistics
   */
  async getStats(
    tenantId?: string,
    adapter?: DatabaseAdapter
  ): Promise<{
    total: number;
    expired: number;
    active: number;
    byReason: Map<string, number>;
  }> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();

    // Total count
    const totalSql = tenantId
      ? 'SELECT COUNT(*) as count FROM users_pii_tombstone WHERE tenant_id = ?'
      : 'SELECT COUNT(*) as count FROM users_pii_tombstone';
    const totalResult = await db.queryOne<{ count: number }>(totalSql, tenantId ? [tenantId] : []);
    const total = totalResult?.count ?? 0;

    // Expired count
    const expiredSql = tenantId
      ? 'SELECT COUNT(*) as count FROM users_pii_tombstone WHERE tenant_id = ? AND retention_until < ?'
      : 'SELECT COUNT(*) as count FROM users_pii_tombstone WHERE retention_until < ?';
    const expiredResult = await db.queryOne<{ count: number }>(
      expiredSql,
      tenantId ? [tenantId, now] : [now]
    );
    const expired = expiredResult?.count ?? 0;

    // By reason
    const reasonSql = tenantId
      ? 'SELECT deletion_reason, COUNT(*) as count FROM users_pii_tombstone WHERE tenant_id = ? GROUP BY deletion_reason'
      : 'SELECT deletion_reason, COUNT(*) as count FROM users_pii_tombstone GROUP BY deletion_reason';
    const reasonResults = await db.query<{ deletion_reason: string | null; count: number }>(
      reasonSql,
      tenantId ? [tenantId] : []
    );

    const byReason = new Map<string, number>();
    for (const row of reasonResults) {
      byReason.set(row.deletion_reason ?? 'unknown', row.count);
    }

    return {
      total,
      expired,
      active: total - expired,
      byReason,
    };
  }

  /**
   * List recent tombstones
   *
   * @param tenantId - Optional tenant filter
   * @param limit - Maximum number to return (1-1000, default 100)
   * @param adapter - Optional partition-specific adapter
   * @returns Recent tombstones
   */
  async listRecent(
    tenantId?: string,
    limit: number = 100,
    adapter?: DatabaseAdapter
  ): Promise<Tombstone[]> {
    const db = adapter ?? this.adapter;
    const validLimit = this.validateLimit(limit);

    if (tenantId) {
      return db.query<Tombstone>(
        'SELECT * FROM users_pii_tombstone WHERE tenant_id = ? ORDER BY deleted_at DESC LIMIT ?',
        [tenantId, validLimit]
      );
    }

    return db.query<Tombstone>(
      'SELECT * FROM users_pii_tombstone ORDER BY deleted_at DESC LIMIT ?',
      [validLimit]
    );
  }
}

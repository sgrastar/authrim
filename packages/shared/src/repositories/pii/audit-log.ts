/**
 * PII Audit Log Repository
 *
 * Repository for PII access audit logs stored in D1_PII.
 *
 * Purpose:
 * - Compliance auditing: Track all PII access
 * - GDPR/CCPA evidence: "Who accessed what, when"
 * - Security monitoring: Detect unauthorized access patterns
 *
 * Note: This D1 table serves as a "recent buffer".
 * Audit logs should be periodically exported to R2/Logpush/SIEM
 * for long-term retention (1-7 years).
 *
 * Fields:
 * - id: Record ID (UUID)
 * - tenant_id: Tenant ID
 * - user_id: Actor who accessed PII
 * - action: Action performed
 * - target_user_id: Whose PII was accessed
 * - details: Action details (JSON)
 * - ip_address: Request IP
 * - user_agent: Request user agent
 * - created_at: Timestamp
 * - exported_at: Export timestamp (NULL = not exported)
 */

import type { DatabaseAdapter } from '../../db/adapter';
import {
  BaseRepository,
  type BaseEntity,
  type PaginationOptions,
  type PaginationResult,
  generateId,
  getCurrentTimestamp,
} from '../base';

/**
 * PII Audit Action types
 */
export type PIIAuditAction =
  | 'pii_accessed'
  | 'pii_created'
  | 'pii_updated'
  | 'pii_deleted'
  | 'pii_exported'
  | 'pii_viewed'
  | 'pii_searched';

/**
 * PII Audit Log entity
 */
export interface PIIAuditLog extends BaseEntity {
  tenant_id: string;
  user_id: string | null;
  action: PIIAuditAction;
  target_user_id: string | null;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
  exported_at: number | null;
}

/**
 * PII Audit Log create input
 */
export interface CreatePIIAuditLogInput {
  id?: string;
  tenant_id?: string;
  user_id?: string | null;
  action: PIIAuditAction;
  target_user_id?: string | null;
  details?: Record<string, unknown> | null;
  ip_address?: string | null;
  user_agent?: string | null;
}

/**
 * PII Audit Log filter options
 */
export interface PIIAuditLogFilterOptions {
  tenant_id?: string;
  user_id?: string;
  target_user_id?: string;
  action?: PIIAuditAction;
  from_date?: number;
  to_date?: number;
  exported?: boolean;
}

/**
 * Maximum IDs per batch for markExported
 * Prevents SQL query from becoming too long
 */
const MARK_EXPORTED_BATCH_SIZE = 500;

/**
 * Maximum allowed limit for queries
 */
const MAX_QUERY_LIMIT = 10000; // Higher for audit logs due to export batching

/**
 * PII Audit Log Repository
 */
export class PIIAuditLogRepository extends BaseRepository<PIIAuditLog> {
  /**
   * Validate and normalize limit parameter
   * @param limit - Requested limit
   * @returns Validated limit (1-10000)
   */
  private validateLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) {
      return 1000; // Safe default
    }
    return Math.min(limit, MAX_QUERY_LIMIT);
  }

  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'audit_log_pii',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'user_id',
        'action',
        'target_user_id',
        'details',
        'ip_address',
        'user_agent',
        'exported_at',
      ],
    });
  }

  /**
   * Create an audit log entry
   *
   * @param input - Audit log data
   * @param adapter - Optional partition-specific adapter
   * @returns Created audit log
   */
  async createAuditLog(
    input: CreatePIIAuditLogInput,
    adapter?: DatabaseAdapter
  ): Promise<PIIAuditLog> {
    const db = adapter ?? this.adapter;
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const auditLog: PIIAuditLog = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      user_id: input.user_id ?? null,
      action: input.action,
      target_user_id: input.target_user_id ?? null,
      details: input.details ? JSON.stringify(input.details) : null,
      ip_address: input.ip_address ?? null,
      user_agent: input.user_agent ?? null,
      created_at: now,
      updated_at: now,
      exported_at: null,
    };

    const sql = `
      INSERT INTO audit_log_pii (
        id, tenant_id, user_id, action, target_user_id,
        details, ip_address, user_agent, created_at, exported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await db.execute(sql, [
      auditLog.id,
      auditLog.tenant_id,
      auditLog.user_id,
      auditLog.action,
      auditLog.target_user_id,
      auditLog.details,
      auditLog.ip_address,
      auditLog.user_agent,
      auditLog.created_at,
      auditLog.exported_at,
    ]);

    return auditLog;
  }

  /**
   * Log PII access
   *
   * Convenience method for common PII access logging.
   *
   * @param userId - Actor user ID
   * @param targetUserId - Target user ID
   * @param action - Action performed
   * @param details - Additional details
   * @param context - Request context (IP, user agent)
   * @param adapter - Optional partition-specific adapter
   * @returns Created audit log
   */
  async logAccess(
    userId: string | null,
    targetUserId: string,
    action: PIIAuditAction,
    details?: Record<string, unknown>,
    context?: { ip_address?: string; user_agent?: string; tenant_id?: string },
    adapter?: DatabaseAdapter
  ): Promise<PIIAuditLog> {
    return this.createAuditLog(
      {
        user_id: userId,
        target_user_id: targetUserId,
        action,
        details,
        ip_address: context?.ip_address,
        user_agent: context?.user_agent,
        tenant_id: context?.tenant_id,
      },
      adapter
    );
  }

  /**
   * Find audit logs by actor user
   *
   * @param userId - Actor user ID
   * @param options - Pagination options
   * @param adapter - Optional partition-specific adapter
   * @returns Paginated audit logs
   */
  async findByUser(
    userId: string,
    options?: PaginationOptions,
    adapter?: DatabaseAdapter
  ): Promise<PaginationResult<PIIAuditLog>> {
    const db = adapter ?? this.adapter;
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const offset = (page - 1) * limit;

    const countResult = await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM audit_log_pii WHERE user_id = ?',
      [userId]
    );
    const total = countResult?.count ?? 0;

    const items = await db.query<PIIAuditLog>(
      'SELECT * FROM audit_log_pii WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [userId, limit, offset]
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Find audit logs by target user
   *
   * @param targetUserId - Target user ID
   * @param options - Pagination options
   * @param adapter - Optional partition-specific adapter
   * @returns Paginated audit logs
   */
  async findByTargetUser(
    targetUserId: string,
    options?: PaginationOptions,
    adapter?: DatabaseAdapter
  ): Promise<PaginationResult<PIIAuditLog>> {
    const db = adapter ?? this.adapter;
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const offset = (page - 1) * limit;

    const countResult = await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM audit_log_pii WHERE target_user_id = ?',
      [targetUserId]
    );
    const total = countResult?.count ?? 0;

    const items = await db.query<PIIAuditLog>(
      'SELECT * FROM audit_log_pii WHERE target_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [targetUserId, limit, offset]
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Find audit logs by action type
   *
   * @param action - Action type
   * @param options - Pagination options
   * @param adapter - Optional partition-specific adapter
   * @returns Paginated audit logs
   */
  async findByAction(
    action: PIIAuditAction,
    options?: PaginationOptions,
    adapter?: DatabaseAdapter
  ): Promise<PaginationResult<PIIAuditLog>> {
    const db = adapter ?? this.adapter;
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const offset = (page - 1) * limit;

    const countResult = await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM audit_log_pii WHERE action = ?',
      [action]
    );
    const total = countResult?.count ?? 0;

    const items = await db.query<PIIAuditLog>(
      'SELECT * FROM audit_log_pii WHERE action = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [action, limit, offset]
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Find unexported audit logs
   *
   * Used by export job to find records to export.
   *
   * @param limit - Maximum records to return (1-10000, default 1000)
   * @param adapter - Optional partition-specific adapter
   * @returns Unexported audit logs
   */
  async findUnexported(limit: number = 1000, adapter?: DatabaseAdapter): Promise<PIIAuditLog[]> {
    const db = adapter ?? this.adapter;
    const validLimit = this.validateLimit(limit);
    return db.query<PIIAuditLog>(
      'SELECT * FROM audit_log_pii WHERE exported_at IS NULL ORDER BY created_at ASC LIMIT ?',
      [validLimit]
    );
  }

  /**
   * Mark audit logs as exported
   *
   * Processes in batches to prevent SQL query from becoming too long.
   * Uses sequential processing to avoid D1 connection limits.
   *
   * @param ids - Audit log IDs to mark
   * @param adapter - Optional partition-specific adapter
   * @returns Number of marked records
   */
  async markExported(ids: string[], adapter?: DatabaseAdapter): Promise<number> {
    if (ids.length === 0) return 0;

    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();
    let totalAffected = 0;

    // Process in batches to prevent SQL from becoming too long
    for (let i = 0; i < ids.length; i += MARK_EXPORTED_BATCH_SIZE) {
      const batch = ids.slice(i, i + MARK_EXPORTED_BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      const result = await db.execute(
        `UPDATE audit_log_pii SET exported_at = ? WHERE id IN (${placeholders})`,
        [now, ...batch]
      );
      totalAffected += result.rowsAffected;
    }

    return totalAffected;
  }

  /**
   * Delete old exported audit logs
   *
   * Used for cleanup after successful export to long-term storage.
   *
   * @param beforeDate - Delete records exported before this timestamp
   * @param adapter - Optional partition-specific adapter
   * @returns Number of deleted records
   */
  async deleteExported(beforeDate: number, adapter?: DatabaseAdapter): Promise<number> {
    const db = adapter ?? this.adapter;
    const result = await db.execute(
      'DELETE FROM audit_log_pii WHERE exported_at IS NOT NULL AND exported_at < ?',
      [beforeDate]
    );
    return result.rowsAffected;
  }

  /**
   * Get action statistics
   *
   * @param tenantId - Optional tenant filter
   * @param adapter - Optional partition-specific adapter
   * @returns Map of action → count
   */
  async getActionStats(
    tenantId?: string,
    adapter?: DatabaseAdapter
  ): Promise<Map<PIIAuditAction, number>> {
    const db = adapter ?? this.adapter;
    const sql = tenantId
      ? 'SELECT action, COUNT(*) as count FROM audit_log_pii WHERE tenant_id = ? GROUP BY action'
      : 'SELECT action, COUNT(*) as count FROM audit_log_pii GROUP BY action';

    const params = tenantId ? [tenantId] : [];
    const results = await db.query<{ action: PIIAuditAction; count: number }>(sql, params);

    const stats = new Map<PIIAuditAction, number>();
    for (const row of results) {
      stats.set(row.action, row.count);
    }
    return stats;
  }

  /**
   * Get export statistics
   *
   * @param adapter - Optional partition-specific adapter
   * @returns Export statistics
   */
  async getExportStats(adapter?: DatabaseAdapter): Promise<{
    totalRecords: number;
    exportedRecords: number;
    pendingRecords: number;
  }> {
    const db = adapter ?? this.adapter;

    const totalResult = await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM audit_log_pii'
    );
    const exportedResult = await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM audit_log_pii WHERE exported_at IS NOT NULL'
    );

    const total = totalResult?.count ?? 0;
    const exported = exportedResult?.count ?? 0;

    return {
      totalRecords: total,
      exportedRecords: exported,
      pendingRecords: total - exported,
    };
  }

  /**
   * Get parsed details
   *
   * @param auditLog - Audit log with details
   * @returns Parsed details or null
   */
  getDetails(auditLog: PIIAuditLog): Record<string, unknown> | null {
    if (!auditLog.details) {
      return null;
    }
    try {
      return JSON.parse(auditLog.details) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

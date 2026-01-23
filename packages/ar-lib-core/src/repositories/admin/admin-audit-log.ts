/**
 * Admin Audit Log Repository
 *
 * Repository for Admin audit log data stored in DB_ADMIN.
 * Provides complete audit trail for Admin operations.
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
import type {
  AdminAuditLogEntry,
  AdminAuditLogCreateInput,
  AdminAuditLogSeverity,
  AdminAuditLogResult,
} from '../../types/admin-user';

/**
 * Admin audit log entity (extends BaseEntity for repository compatibility)
 */
interface AdminAuditLogEntity extends BaseEntity {
  tenant_id: string;
  admin_user_id: string | null;
  admin_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  result: AdminAuditLogResult;
  error_code: string | null;
  error_message: string | null;
  severity: AdminAuditLogSeverity;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  session_id: string | null;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string | null;
}

/**
 * Admin audit log filter options
 */
export interface AdminAuditLogFilterOptions {
  tenant_id?: string;
  admin_user_id?: string;
  action?: string;
  action_prefix?: string;
  resource_type?: string;
  resource_id?: string;
  result?: AdminAuditLogResult;
  severity?: AdminAuditLogSeverity;
  ip_address?: string;
  from_timestamp?: number;
  to_timestamp?: number;
}

/**
 * Admin Audit Log Repository
 */
export class AdminAuditLogRepository extends BaseRepository<AdminAuditLogEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_audit_log',
      primaryKey: 'id',
      softDelete: false, // Audit logs are never soft deleted
      allowedFields: [
        'tenant_id',
        'admin_user_id',
        'admin_email',
        'action',
        'resource_type',
        'resource_id',
        'result',
        'error_code',
        'error_message',
        'severity',
        'ip_address',
        'user_agent',
        'request_id',
        'session_id',
        'before_json',
        'after_json',
        'metadata_json',
      ],
    });
  }

  /**
   * Create a new audit log entry
   *
   * @param input - Audit log creation input
   * @returns Created audit log entry
   */
  async createAuditLog(input: AdminAuditLogCreateInput): Promise<AdminAuditLogEntry> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const entry: AdminAuditLogEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      admin_user_id: input.admin_user_id ?? null,
      admin_email: input.admin_email ?? null,
      action: input.action,
      resource_type: input.resource_type ?? null,
      resource_id: input.resource_id ?? null,
      result: input.result,
      error_code: input.error_code ?? null,
      error_message: input.error_message ?? null,
      severity: input.severity ?? 'info',
      ip_address: input.ip_address ?? null,
      user_agent: input.user_agent ?? null,
      request_id: input.request_id ?? null,
      session_id: input.session_id ?? null,
      before_json: input.before ? JSON.stringify(input.before) : null,
      after_json: input.after ? JSON.stringify(input.after) : null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_audit_log (
        id, tenant_id, admin_user_id, admin_email, action,
        resource_type, resource_id, result, error_code, error_message,
        severity, ip_address, user_agent, request_id, session_id,
        before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      entry.id,
      entry.tenant_id,
      entry.admin_user_id,
      entry.admin_email,
      entry.action,
      entry.resource_type,
      entry.resource_id,
      entry.result,
      entry.error_code,
      entry.error_message,
      entry.severity,
      entry.ip_address,
      entry.user_agent,
      entry.request_id,
      entry.session_id,
      entry.before_json,
      entry.after_json,
      entry.metadata_json,
      entry.created_at,
    ]);

    return this.entityToAuditLog(entry);
  }

  /**
   * Get audit log entry by ID
   *
   * @param id - Audit log ID
   * @returns Audit log entry or null
   */
  async getAuditLog(id: string): Promise<AdminAuditLogEntry | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_audit_log WHERE id = ?',
      [id]
    );
    return row ? this.rowToAuditLog(row) : null;
  }

  /**
   * Search audit logs with filters
   *
   * @param filters - Filter options
   * @param options - Pagination options
   * @returns Paginated audit log entries
   */
  async searchAuditLogs(
    filters: AdminAuditLogFilterOptions,
    options?: PaginationOptions
  ): Promise<PaginationResult<AdminAuditLogEntry>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.tenant_id) {
      conditions.push('tenant_id = ?');
      params.push(filters.tenant_id);
    }
    if (filters.admin_user_id) {
      conditions.push('admin_user_id = ?');
      params.push(filters.admin_user_id);
    }
    if (filters.action) {
      conditions.push('action = ?');
      params.push(filters.action);
    }
    if (filters.action_prefix) {
      conditions.push('action LIKE ?');
      params.push(`${filters.action_prefix}%`);
    }
    if (filters.resource_type) {
      conditions.push('resource_type = ?');
      params.push(filters.resource_type);
    }
    if (filters.resource_id) {
      conditions.push('resource_id = ?');
      params.push(filters.resource_id);
    }
    if (filters.result) {
      conditions.push('result = ?');
      params.push(filters.result);
    }
    if (filters.severity) {
      conditions.push('severity = ?');
      params.push(filters.severity);
    }
    if (filters.ip_address) {
      conditions.push('ip_address = ?');
      params.push(filters.ip_address);
    }
    if (filters.from_timestamp) {
      conditions.push('created_at >= ?');
      params.push(filters.from_timestamp);
    }
    if (filters.to_timestamp) {
      conditions.push('created_at <= ?');
      params.push(filters.to_timestamp);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Pagination
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const offset = (page - 1) * limit;

    // Count query
    const countSql = `SELECT COUNT(*) as count FROM admin_audit_log ${whereClause}`;
    const countResult = await this.adapter.queryOne<{ count: number }>(countSql, params);
    const total = countResult?.count ?? 0;

    // Data query (always order by created_at DESC for audit logs)
    const dataSql = `SELECT * FROM admin_audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows = await this.adapter.query<Record<string, unknown>>(dataSql, [
      ...params,
      limit,
      offset,
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      items: rows.map((row) => this.rowToAuditLog(row)),
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Get audit logs for a specific resource
   *
   * @param resourceType - Resource type
   * @param resourceId - Resource ID
   * @param limit - Maximum results
   * @returns List of audit log entries
   */
  async getAuditLogsByResource(
    resourceType: string,
    resourceId: string,
    limit: number = 50
  ): Promise<AdminAuditLogEntry[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_audit_log
       WHERE resource_type = ? AND resource_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [resourceType, resourceId, limit]
    );
    return rows.map((row) => this.rowToAuditLog(row));
  }

  /**
   * Get recent audit logs for an Admin user
   *
   * @param adminUserId - Admin user ID
   * @param limit - Maximum results
   * @returns List of audit log entries
   */
  async getRecentByUser(adminUserId: string, limit: number = 50): Promise<AdminAuditLogEntry[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_audit_log
       WHERE admin_user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [adminUserId, limit]
    );
    return rows.map((row) => this.rowToAuditLog(row));
  }

  /**
   * Get failed actions (for security monitoring)
   *
   * @param tenantId - Tenant ID
   * @param since - Timestamp to start from
   * @param limit - Maximum results
   * @returns List of failed audit log entries
   */
  async getFailedActions(
    tenantId: string,
    since: number,
    limit: number = 100
  ): Promise<AdminAuditLogEntry[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_audit_log
       WHERE tenant_id = ? AND result = 'failure' AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`,
      [tenantId, since, limit]
    );
    return rows.map((row) => this.rowToAuditLog(row));
  }

  /**
   * Get high severity entries (for alerts)
   *
   * @param tenantId - Tenant ID
   * @param since - Timestamp to start from
   * @param severities - List of severities to include
   * @param limit - Maximum results
   * @returns List of audit log entries
   */
  async getHighSeverity(
    tenantId: string,
    since: number,
    severities: AdminAuditLogSeverity[] = ['error', 'critical'],
    limit: number = 100
  ): Promise<AdminAuditLogEntry[]> {
    const placeholders = severities.map(() => '?').join(', ');
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_audit_log
       WHERE tenant_id = ? AND severity IN (${placeholders}) AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?`,
      [tenantId, ...severities, since, limit]
    );
    return rows.map((row) => this.rowToAuditLog(row));
  }

  /**
   * Get action counts by type (for analytics)
   *
   * @param tenantId - Tenant ID
   * @param since - Timestamp to start from
   * @returns Map of action to count
   */
  async getActionCounts(tenantId: string, since: number): Promise<Map<string, number>> {
    const rows = await this.adapter.query<{ action: string; count: number }>(
      `SELECT action, COUNT(*) as count FROM admin_audit_log
       WHERE tenant_id = ? AND created_at >= ?
       GROUP BY action ORDER BY count DESC`,
      [tenantId, since]
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.action, row.count);
    }
    return counts;
  }

  /**
   * Delete old audit logs (for retention policy)
   * Note: This should be called by a scheduled job, not directly from API
   *
   * @param beforeTimestamp - Delete logs before this timestamp
   * @returns Number of deleted logs
   */
  async deleteOldLogs(beforeTimestamp: number): Promise<number> {
    const result = await this.adapter.execute('DELETE FROM admin_audit_log WHERE created_at < ?', [
      beforeTimestamp,
    ]);
    return result.rowsAffected;
  }

  /**
   * Map database row to AdminAuditLogEntry
   */
  private rowToAuditLog(row: Record<string, unknown>): AdminAuditLogEntry {
    let before: Record<string, unknown> | null = null;
    let after: Record<string, unknown> | null = null;
    let metadata: Record<string, unknown> | null = null;

    if (row.before_json) {
      try {
        before = JSON.parse(row.before_json as string);
      } catch {
        before = null;
      }
    }
    if (row.after_json) {
      try {
        after = JSON.parse(row.after_json as string);
      } catch {
        after = null;
      }
    }
    if (row.metadata_json) {
      try {
        metadata = JSON.parse(row.metadata_json as string);
      } catch {
        metadata = null;
      }
    }

    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      admin_user_id: row.admin_user_id as string | null,
      admin_email: row.admin_email as string | null,
      action: row.action as string,
      resource_type: row.resource_type as string | null,
      resource_id: row.resource_id as string | null,
      result: row.result as AdminAuditLogResult,
      error_code: row.error_code as string | null,
      error_message: row.error_message as string | null,
      severity: row.severity as AdminAuditLogSeverity,
      ip_address: row.ip_address as string | null,
      user_agent: row.user_agent as string | null,
      request_id: row.request_id as string | null,
      session_id: row.session_id as string | null,
      before,
      after,
      metadata,
      created_at: row.created_at as number,
    };
  }

  /**
   * Convert entity to AdminAuditLogEntry type
   */
  private entityToAuditLog(entity: AdminAuditLogEntity): AdminAuditLogEntry {
    let before: Record<string, unknown> | null = null;
    let after: Record<string, unknown> | null = null;
    let metadata: Record<string, unknown> | null = null;

    if (entity.before_json) {
      try {
        before = JSON.parse(entity.before_json);
      } catch {
        before = null;
      }
    }
    if (entity.after_json) {
      try {
        after = JSON.parse(entity.after_json);
      } catch {
        after = null;
      }
    }
    if (entity.metadata_json) {
      try {
        metadata = JSON.parse(entity.metadata_json);
      } catch {
        metadata = null;
      }
    }

    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      admin_user_id: entity.admin_user_id,
      admin_email: entity.admin_email,
      action: entity.action,
      resource_type: entity.resource_type,
      resource_id: entity.resource_id,
      result: entity.result,
      error_code: entity.error_code,
      error_message: entity.error_message,
      severity: entity.severity,
      ip_address: entity.ip_address,
      user_agent: entity.user_agent,
      request_id: entity.request_id,
      session_id: entity.session_id,
      before,
      after,
      metadata,
      created_at: entity.created_at,
    };
  }
}

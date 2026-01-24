/**
 * Admin Login Attempt Repository
 *
 * Repository for tracking admin login attempts stored in DB_ADMIN.
 * Used for rate limiting, security monitoring, and brute force protection.
 *
 * Features:
 * - Record successful and failed login attempts
 * - Query attempts by email or IP for rate limiting
 * - Count failed attempts within time windows
 * - Cleanup old records for data hygiene
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { BaseRepository, type BaseEntity, generateId, getCurrentTimestamp } from '../base';
import type { AdminLoginAttempt } from '../../types/admin-user';

/**
 * Admin login attempt entity (extends BaseEntity for repository compatibility)
 */
interface AdminLoginAttemptEntity extends BaseEntity {
  tenant_id: string;
  email: string;
  ip_address: string;
  user_agent: string | null;
  success: boolean;
  failure_reason: string | null;
}

/**
 * Input for creating a login attempt record
 */
export interface AdminLoginAttemptCreateInput {
  tenant_id?: string;
  email: string;
  ip_address: string;
  user_agent?: string | null;
  success: boolean;
  failure_reason?: string | null;
}

/**
 * Filter options for querying login attempts
 */
export interface AdminLoginAttemptFilterOptions {
  tenant_id?: string;
  email?: string;
  ip_address?: string;
  success?: boolean;
  from_timestamp?: number;
  to_timestamp?: number;
}

/**
 * Admin Login Attempt Repository
 */
export class AdminLoginAttemptRepository extends BaseRepository<AdminLoginAttemptEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_login_attempts',
      primaryKey: 'id',
      softDelete: false, // Login attempts are hard deleted during cleanup
      allowedFields: [
        'tenant_id',
        'email',
        'ip_address',
        'user_agent',
        'success',
        'failure_reason',
      ],
    });
  }

  /**
   * Record a login attempt
   *
   * @param input - Attempt details
   * @returns Created attempt record
   */
  async recordAttempt(input: AdminLoginAttemptCreateInput): Promise<AdminLoginAttempt> {
    const id = generateId();
    const now = getCurrentTimestamp();

    const entity: AdminLoginAttemptEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      email: input.email.toLowerCase(), // Normalize email
      ip_address: input.ip_address,
      user_agent: input.user_agent ?? null,
      success: input.success,
      failure_reason: input.failure_reason ?? null,
      created_at: now,
      updated_at: now, // Not used but required by BaseEntity
    };

    const sql = `
      INSERT INTO admin_login_attempts (
        id, tenant_id, email, ip_address, user_agent,
        success, failure_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      entity.id,
      entity.tenant_id,
      entity.email,
      entity.ip_address,
      entity.user_agent,
      entity.success ? 1 : 0,
      entity.failure_reason,
      entity.created_at,
    ]);

    return this.entityToAttempt(entity);
  }

  /**
   * Get recent attempts by email
   *
   * @param tenantId - Tenant ID
   * @param email - Email address
   * @param withinMs - Time window in milliseconds (default: 15 minutes)
   * @param limit - Maximum records to return (default: 100)
   * @returns List of attempts
   */
  async getRecentAttemptsByEmail(
    tenantId: string,
    email: string,
    withinMs: number = 15 * 60 * 1000,
    limit: number = 100
  ): Promise<AdminLoginAttempt[]> {
    const cutoffTime = getCurrentTimestamp() - withinMs;

    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_login_attempts
       WHERE tenant_id = ? AND email = ? AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [tenantId, email.toLowerCase(), cutoffTime, limit]
    );

    return rows.map((row) => this.rowToAttempt(row));
  }

  /**
   * Get recent attempts by IP address
   *
   * @param ipAddress - IP address
   * @param withinMs - Time window in milliseconds (default: 15 minutes)
   * @param limit - Maximum records to return (default: 100)
   * @returns List of attempts
   */
  async getRecentAttemptsByIp(
    ipAddress: string,
    withinMs: number = 15 * 60 * 1000,
    limit: number = 100
  ): Promise<AdminLoginAttempt[]> {
    const cutoffTime = getCurrentTimestamp() - withinMs;

    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_login_attempts
       WHERE ip_address = ? AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [ipAddress, cutoffTime, limit]
    );

    return rows.map((row) => this.rowToAttempt(row));
  }

  /**
   * Count failed attempts by email within a time window
   *
   * @param tenantId - Tenant ID
   * @param email - Email address
   * @param withinMs - Time window in milliseconds (default: 15 minutes)
   * @returns Number of failed attempts
   */
  async countFailedAttemptsByEmail(
    tenantId: string,
    email: string,
    withinMs: number = 15 * 60 * 1000
  ): Promise<number> {
    const cutoffTime = getCurrentTimestamp() - withinMs;

    const result = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM admin_login_attempts
       WHERE tenant_id = ? AND email = ? AND success = 0 AND created_at >= ?`,
      [tenantId, email.toLowerCase(), cutoffTime]
    );

    return result?.count ?? 0;
  }

  /**
   * Count failed attempts by IP within a time window
   *
   * @param ipAddress - IP address
   * @param withinMs - Time window in milliseconds (default: 15 minutes)
   * @returns Number of failed attempts
   */
  async countFailedAttemptsByIp(
    ipAddress: string,
    withinMs: number = 15 * 60 * 1000
  ): Promise<number> {
    const cutoffTime = getCurrentTimestamp() - withinMs;

    const result = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM admin_login_attempts
       WHERE ip_address = ? AND success = 0 AND created_at >= ?`,
      [ipAddress, cutoffTime]
    );

    return result?.count ?? 0;
  }

  /**
   * Check if email is rate limited (too many failed attempts)
   *
   * @param tenantId - Tenant ID
   * @param email - Email address
   * @param maxAttempts - Maximum allowed failed attempts (default: 5)
   * @param withinMs - Time window in milliseconds (default: 15 minutes)
   * @returns True if rate limited
   */
  async isEmailRateLimited(
    tenantId: string,
    email: string,
    maxAttempts: number = 5,
    withinMs: number = 15 * 60 * 1000
  ): Promise<boolean> {
    const failedCount = await this.countFailedAttemptsByEmail(tenantId, email, withinMs);
    return failedCount >= maxAttempts;
  }

  /**
   * Check if IP is rate limited (too many failed attempts)
   *
   * @param ipAddress - IP address
   * @param maxAttempts - Maximum allowed failed attempts (default: 10)
   * @param withinMs - Time window in milliseconds (default: 15 minutes)
   * @returns True if rate limited
   */
  async isIpRateLimited(
    ipAddress: string,
    maxAttempts: number = 10,
    withinMs: number = 15 * 60 * 1000
  ): Promise<boolean> {
    const failedCount = await this.countFailedAttemptsByIp(ipAddress, withinMs);
    return failedCount >= maxAttempts;
  }

  /**
   * Get the last successful login for an email
   *
   * @param tenantId - Tenant ID
   * @param email - Email address
   * @returns Last successful attempt or null
   */
  async getLastSuccessfulLogin(tenantId: string, email: string): Promise<AdminLoginAttempt | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT * FROM admin_login_attempts
       WHERE tenant_id = ? AND email = ? AND success = 1
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, email.toLowerCase()]
    );

    return row ? this.rowToAttempt(row) : null;
  }

  /**
   * Get login statistics for a tenant
   *
   * @param tenantId - Tenant ID
   * @param withinMs - Time window in milliseconds (default: 24 hours)
   * @returns Statistics object
   */
  async getStatistics(
    tenantId: string,
    withinMs: number = 24 * 60 * 60 * 1000
  ): Promise<{
    total: number;
    successful: number;
    failed: number;
    uniqueEmails: number;
    uniqueIps: number;
  }> {
    const cutoffTime = getCurrentTimestamp() - withinMs;

    const stats = await this.adapter.queryOne<{
      total: number;
      successful: number;
      failed: number;
      unique_emails: number;
      unique_ips: number;
    }>(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed,
         COUNT(DISTINCT email) as unique_emails,
         COUNT(DISTINCT ip_address) as unique_ips
       FROM admin_login_attempts
       WHERE tenant_id = ? AND created_at >= ?`,
      [tenantId, cutoffTime]
    );

    return {
      total: stats?.total ?? 0,
      successful: stats?.successful ?? 0,
      failed: stats?.failed ?? 0,
      uniqueEmails: stats?.unique_emails ?? 0,
      uniqueIps: stats?.unique_ips ?? 0,
    };
  }

  /**
   * Cleanup old login attempt records
   *
   * @param olderThanMs - Delete records older than this (default: 30 days)
   * @returns Number of deleted records
   */
  async cleanup(olderThanMs: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoffTime = getCurrentTimestamp() - olderThanMs;

    const result = await this.adapter.execute(
      'DELETE FROM admin_login_attempts WHERE created_at < ?',
      [cutoffTime]
    );

    return result.rowsAffected;
  }

  /**
   * Cleanup old records for a specific tenant
   *
   * @param tenantId - Tenant ID
   * @param olderThanMs - Delete records older than this (default: 30 days)
   * @returns Number of deleted records
   */
  async cleanupByTenant(
    tenantId: string,
    olderThanMs: number = 30 * 24 * 60 * 60 * 1000
  ): Promise<number> {
    const cutoffTime = getCurrentTimestamp() - olderThanMs;

    const result = await this.adapter.execute(
      'DELETE FROM admin_login_attempts WHERE tenant_id = ? AND created_at < ?',
      [tenantId, cutoffTime]
    );

    return result.rowsAffected;
  }

  /**
   * Delete all attempts for a specific email (for GDPR erasure)
   *
   * @param tenantId - Tenant ID
   * @param email - Email address
   * @returns Number of deleted records
   */
  async deleteByEmail(tenantId: string, email: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM admin_login_attempts WHERE tenant_id = ? AND email = ?',
      [tenantId, email.toLowerCase()]
    );

    return result.rowsAffected;
  }

  /**
   * List attempts with filters and pagination
   *
   * @param filters - Filter options
   * @param limit - Maximum records (default: 50)
   * @param offset - Offset for pagination (default: 0)
   * @returns List of attempts
   */
  async listAttempts(
    filters: AdminLoginAttemptFilterOptions,
    limit: number = 50,
    offset: number = 0
  ): Promise<{ attempts: AdminLoginAttempt[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.tenant_id) {
      conditions.push('tenant_id = ?');
      params.push(filters.tenant_id);
    }
    if (filters.email) {
      conditions.push('email = ?');
      params.push(filters.email.toLowerCase());
    }
    if (filters.ip_address) {
      conditions.push('ip_address = ?');
      params.push(filters.ip_address);
    }
    if (filters.success !== undefined) {
      conditions.push('success = ?');
      params.push(filters.success ? 1 : 0);
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

    // Get total count
    const countResult = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM admin_login_attempts ${whereClause}`,
      params
    );
    const total = countResult?.count ?? 0;

    // Get paginated results
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM admin_login_attempts ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      attempts: rows.map((row) => this.rowToAttempt(row)),
      total,
    };
  }

  /**
   * Map database row to AdminLoginAttempt
   */
  private rowToAttempt(row: Record<string, unknown>): AdminLoginAttempt {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      email: row.email as string,
      ip_address: row.ip_address as string,
      user_agent: row.user_agent as string | null,
      success: Boolean(row.success),
      failure_reason: row.failure_reason as string | null,
      created_at: row.created_at as number,
    };
  }

  /**
   * Convert entity to AdminLoginAttempt type
   */
  private entityToAttempt(entity: AdminLoginAttemptEntity): AdminLoginAttempt {
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      email: entity.email,
      ip_address: entity.ip_address,
      user_agent: entity.user_agent,
      success: entity.success,
      failure_reason: entity.failure_reason,
      created_at: entity.created_at,
    };
  }
}

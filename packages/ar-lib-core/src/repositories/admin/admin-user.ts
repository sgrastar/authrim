/**
 * Admin User Repository
 *
 * Repository for Admin user data stored in DB_ADMIN.
 * Completely separate from EndUser data in DB_CORE.
 *
 * This repository handles:
 * - Admin user CRUD operations
 * - Login tracking (last_login_at, failed_login_count)
 * - Account status management (active/suspended/locked)
 * - MFA settings
 */

import type { DatabaseAdapter } from '../../db/adapter';
import {
  BaseRepository,
  type BaseEntity,
  type FilterCondition,
  type PaginationOptions,
  type PaginationResult,
  generateId,
  getCurrentTimestamp,
} from '../base';
import type {
  AdminUser,
  AdminUserCreateInput,
  AdminUserUpdateInput,
  AdminUserStatus,
  AdminMfaMethod,
} from '../../types/admin-user';

/**
 * Admin user entity (extends BaseEntity for repository compatibility)
 */
interface AdminUserEntity extends BaseEntity {
  tenant_id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  password_hash: string | null;
  is_active: boolean;
  status: AdminUserStatus;
  mfa_enabled: boolean;
  mfa_method: AdminMfaMethod | null;
  totp_secret_encrypted: string | null;
  last_login_at: number | null;
  last_login_ip: string | null;
  failed_login_count: number;
  locked_until: number | null;
  created_by: string | null;
}

/**
 * Admin user filter options
 */
export interface AdminUserFilterOptions {
  tenant_id?: string;
  email?: string;
  status?: AdminUserStatus;
  is_active?: boolean;
  mfa_enabled?: boolean;
}

/**
 * Admin User Repository
 */
export class AdminUserRepository extends BaseRepository<AdminUserEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'admin_users',
      primaryKey: 'id',
      softDelete: true,
      softDeleteField: 'is_active',
      allowedFields: [
        'tenant_id',
        'email',
        'email_verified',
        'name',
        'password_hash',
        'is_active',
        'status',
        'mfa_enabled',
        'mfa_method',
        'totp_secret_encrypted',
        'last_login_at',
        'last_login_ip',
        'failed_login_count',
        'locked_until',
        'created_by',
      ],
    });
  }

  /**
   * Create a new Admin user
   *
   * @param input - Admin user creation input
   * @returns Created Admin user
   */
  async createAdminUser(input: AdminUserCreateInput): Promise<AdminUser> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const adminUser: AdminUserEntity = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      email: input.email,
      email_verified: false,
      name: input.name ?? null,
      password_hash: input.password ?? null, // Note: Should be hashed before calling this
      is_active: true,
      status: 'active',
      mfa_enabled: input.mfa_enabled ?? false,
      mfa_method: input.mfa_method ?? null,
      totp_secret_encrypted: null,
      last_login_at: null,
      last_login_ip: null,
      failed_login_count: 0,
      locked_until: null,
      created_by: input.created_by ?? null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO admin_users (
        id, tenant_id, email, email_verified, name, password_hash,
        is_active, status, mfa_enabled, mfa_method, totp_secret_encrypted,
        last_login_at, last_login_ip, failed_login_count, locked_until,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      adminUser.id,
      adminUser.tenant_id,
      adminUser.email,
      adminUser.email_verified ? 1 : 0,
      adminUser.name,
      adminUser.password_hash,
      adminUser.is_active ? 1 : 0,
      adminUser.status,
      adminUser.mfa_enabled ? 1 : 0,
      adminUser.mfa_method,
      adminUser.totp_secret_encrypted,
      adminUser.last_login_at,
      adminUser.last_login_ip,
      adminUser.failed_login_count,
      adminUser.locked_until,
      adminUser.created_by,
      adminUser.created_at,
      adminUser.updated_at,
    ]);

    return this.entityToAdminUser(adminUser);
  }

  /**
   * Update an Admin user
   *
   * @param id - Admin user ID
   * @param input - Update input
   * @returns Updated Admin user or null if not found
   */
  async updateAdminUser(id: string, input: AdminUserUpdateInput): Promise<AdminUser | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.email !== undefined) {
      updates.push('email = ?');
      values.push(input.email);
    }
    if (input.name !== undefined) {
      updates.push('name = ?');
      values.push(input.name);
    }
    if (input.password !== undefined) {
      updates.push('password_hash = ?');
      values.push(input.password); // Note: Should be hashed before calling this
    }
    if (input.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(input.is_active ? 1 : 0);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      values.push(input.status);
    }
    if (input.mfa_enabled !== undefined) {
      updates.push('mfa_enabled = ?');
      values.push(input.mfa_enabled ? 1 : 0);
    }
    if (input.mfa_method !== undefined) {
      updates.push('mfa_method = ?');
      values.push(input.mfa_method);
    }
    if (input.totp_secret_encrypted !== undefined) {
      updates.push('totp_secret_encrypted = ?');
      values.push(input.totp_secret_encrypted);
    }

    if (updates.length === 0) {
      return this.entityToAdminUser(existing);
    }

    updates.push('updated_at = ?');
    values.push(getCurrentTimestamp());
    values.push(id);

    const sql = `UPDATE admin_users SET ${updates.join(', ')} WHERE id = ?`;
    await this.adapter.execute(sql, values);

    const updated = await this.findById(id);
    return updated ? this.entityToAdminUser(updated) : null;
  }

  /**
   * Find Admin user by email (for authentication)
   *
   * @param tenantId - Tenant ID
   * @param email - Email address
   * @returns Admin user or null
   */
  async findByEmail(tenantId: string, email: string): Promise<AdminUser | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_users WHERE tenant_id = ? AND email = ? AND is_active = 1',
      [tenantId, email.toLowerCase()]
    );
    return row ? this.rowToAdminUser(row) : null;
  }

  /**
   * Find Admin user by ID and tenant
   *
   * @param tenantId - Tenant ID
   * @param id - Admin user ID
   * @returns Admin user or null
   */
  async findByTenantAndId(tenantId: string, id: string): Promise<AdminUser | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_users WHERE tenant_id = ? AND id = ? AND is_active = 1',
      [tenantId, id]
    );
    return row ? this.rowToAdminUser(row) : null;
  }

  /**
   * Search Admin users with filters
   *
   * @param filters - Filter options
   * @param options - Pagination options
   * @returns Paginated Admin users
   */
  async searchAdminUsers(
    filters: AdminUserFilterOptions,
    options?: PaginationOptions
  ): Promise<PaginationResult<AdminUser>> {
    const conditions: FilterCondition[] = [];

    if (filters.tenant_id) {
      conditions.push({ field: 'tenant_id', operator: 'eq', value: filters.tenant_id });
    }
    if (filters.email) {
      conditions.push({ field: 'email', operator: 'like', value: filters.email });
    }
    if (filters.status) {
      conditions.push({ field: 'status', operator: 'eq', value: filters.status });
    }
    if (filters.is_active !== undefined) {
      conditions.push({ field: 'is_active', operator: 'eq', value: filters.is_active ? 1 : 0 });
    }
    if (filters.mfa_enabled !== undefined) {
      conditions.push({ field: 'mfa_enabled', operator: 'eq', value: filters.mfa_enabled ? 1 : 0 });
    }

    const result = await this.findAll(conditions, options);
    return {
      ...result,
      items: result.items.map((entity) => this.entityToAdminUser(entity)),
    };
  }

  /**
   * Record successful login
   *
   * @param id - Admin user ID
   * @param ip - Client IP address
   * @returns True if updated
   */
  async recordSuccessfulLogin(id: string, ip: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE admin_users SET
        last_login_at = ?,
        last_login_ip = ?,
        failed_login_count = 0,
        locked_until = NULL,
        status = CASE WHEN status = 'locked' THEN 'active' ELSE status END,
        updated_at = ?
      WHERE id = ?`,
      [now, ip, now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Record failed login attempt
   *
   * @param id - Admin user ID
   * @param maxAttempts - Maximum allowed attempts before lockout
   * @param lockoutDuration - Lockout duration in milliseconds
   * @returns Updated failed login count
   */
  async recordFailedLogin(
    id: string,
    maxAttempts: number = 5,
    lockoutDuration: number = 15 * 60 * 1000 // 15 minutes
  ): Promise<number> {
    const now = getCurrentTimestamp();

    // First, get current count
    const user = await this.adapter.queryOne<{ failed_login_count: number }>(
      'SELECT failed_login_count FROM admin_users WHERE id = ?',
      [id]
    );

    if (!user) {
      return 0;
    }

    const newCount = user.failed_login_count + 1;
    const shouldLock = newCount >= maxAttempts;
    const lockedUntil = shouldLock ? now + lockoutDuration : null;
    const newStatus = shouldLock ? 'locked' : null;

    if (shouldLock) {
      await this.adapter.execute(
        `UPDATE admin_users SET
          failed_login_count = ?,
          locked_until = ?,
          status = ?,
          updated_at = ?
        WHERE id = ?`,
        [newCount, lockedUntil, newStatus, now, id]
      );
    } else {
      await this.adapter.execute(
        `UPDATE admin_users SET
          failed_login_count = ?,
          updated_at = ?
        WHERE id = ?`,
        [newCount, now, id]
      );
    }

    return newCount;
  }

  /**
   * Check if account is locked
   *
   * @param id - Admin user ID
   * @returns True if locked and not yet expired
   */
  async isAccountLocked(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const user = await this.adapter.queryOne<{ status: string; locked_until: number | null }>(
      'SELECT status, locked_until FROM admin_users WHERE id = ?',
      [id]
    );

    if (!user) {
      return false;
    }

    if (user.status !== 'locked') {
      return false;
    }

    // If locked_until is set and has passed, auto-unlock
    if (user.locked_until && user.locked_until < now) {
      await this.unlockAccount(id);
      return false;
    }

    return true;
  }

  /**
   * Unlock an Admin account
   *
   * @param id - Admin user ID
   * @returns True if unlocked
   */
  async unlockAccount(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE admin_users SET
        failed_login_count = 0,
        locked_until = NULL,
        status = 'active',
        updated_at = ?
      WHERE id = ? AND status = 'locked'`,
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Suspend an Admin account
   *
   * @param id - Admin user ID
   * @returns True if suspended
   */
  async suspendAccount(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE admin_users SET status = 'suspended', updated_at = ? WHERE id = ?`,
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Activate an Admin account
   *
   * @param id - Admin user ID
   * @returns True if activated
   */
  async activateAccount(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE admin_users SET status = 'active', failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Set email as verified
   *
   * @param id - Admin user ID
   * @returns True if updated
   */
  async setEmailVerified(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE admin_users SET email_verified = 1, updated_at = ? WHERE id = ?`,
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Enable MFA for an Admin user
   *
   * @param id - Admin user ID
   * @param method - MFA method
   * @param totpSecret - Encrypted TOTP secret (if method is 'totp' or 'both')
   * @returns True if updated
   */
  async enableMFA(id: string, method: AdminMfaMethod, totpSecret?: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE admin_users SET
        mfa_enabled = 1,
        mfa_method = ?,
        totp_secret_encrypted = ?,
        updated_at = ?
      WHERE id = ?`,
      [method, totpSecret ?? null, now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Disable MFA for an Admin user
   *
   * @param id - Admin user ID
   * @returns True if updated
   */
  async disableMFA(id: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE admin_users SET
        mfa_enabled = 0,
        mfa_method = NULL,
        totp_secret_encrypted = NULL,
        updated_at = ?
      WHERE id = ?`,
      [now, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Get Admin user count by tenant
   *
   * @param tenantId - Tenant ID
   * @returns Count of active Admin users
   */
  async getAdminCountByTenant(tenantId: string): Promise<number> {
    const result = await this.adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_users WHERE tenant_id = ? AND is_active = 1',
      [tenantId]
    );
    return result?.count ?? 0;
  }

  /**
   * Override findById to return AdminUser type
   */
  override async findById(id: string): Promise<AdminUserEntity | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM admin_users WHERE id = ? AND is_active = 1',
      [id]
    );
    return row ? this.rowToEntity(row) : null;
  }

  /**
   * Get Admin user by ID (public interface returning AdminUser type)
   */
  async getAdminUser(id: string): Promise<AdminUser | null> {
    const entity = await this.findById(id);
    return entity ? this.entityToAdminUser(entity) : null;
  }

  /**
   * Map database row to entity
   */
  private rowToEntity(row: Record<string, unknown>): AdminUserEntity {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      email: row.email as string,
      email_verified: Boolean(row.email_verified),
      name: row.name as string | null,
      password_hash: row.password_hash as string | null,
      is_active: Boolean(row.is_active),
      status: row.status as AdminUserStatus,
      mfa_enabled: Boolean(row.mfa_enabled),
      mfa_method: row.mfa_method as AdminMfaMethod | null,
      totp_secret_encrypted: row.totp_secret_encrypted as string | null,
      last_login_at: row.last_login_at as number | null,
      last_login_ip: row.last_login_ip as string | null,
      failed_login_count: (row.failed_login_count as number) ?? 0,
      locked_until: row.locked_until as number | null,
      created_by: row.created_by as string | null,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  /**
   * Map database row to AdminUser
   */
  private rowToAdminUser(row: Record<string, unknown>): AdminUser {
    return this.entityToAdminUser(this.rowToEntity(row));
  }

  /**
   * Convert entity to AdminUser type
   */
  private entityToAdminUser(entity: AdminUserEntity): AdminUser {
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      email: entity.email,
      email_verified: entity.email_verified,
      name: entity.name,
      password_hash: entity.password_hash,
      is_active: entity.is_active,
      status: entity.status,
      mfa_enabled: entity.mfa_enabled,
      mfa_method: entity.mfa_method,
      totp_secret_encrypted: entity.totp_secret_encrypted,
      last_login_at: entity.last_login_at,
      last_login_ip: entity.last_login_ip,
      failed_login_count: entity.failed_login_count,
      locked_until: entity.locked_until,
      created_by: entity.created_by,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}

/**
 * User Core Repository
 *
 * Repository for non-PII user data stored in D1_CORE.
 * Contains authentication-related data without personal information.
 *
 * Fields stored in Core DB:
 * - id: User ID (UUID)
 * - tenant_id: Tenant ID for multi-tenant support
 * - email_verified: Whether email is verified
 * - phone_number_verified: Whether phone is verified
 * - email_domain_hash: Blind index for domain-based rules (Phase 8)
 * - password_hash: Hashed password
 * - is_active: Soft delete flag
 * - user_type: 'end_user' | 'admin' | 'm2m'
 * - pii_partition: Which PII DB contains user's PII
 * - pii_status: PII write status (none/pending/active/failed/deleted)
 * - created_at, updated_at, last_login_at: Timestamps
 */

import type { DatabaseAdapter, PIIStatus } from '../../db/adapter';
import {
  BaseRepository,
  type BaseEntity,
  type FilterCondition,
  type PaginationOptions,
  type PaginationResult,
  generateId,
  getCurrentTimestamp,
} from '../base';

/**
 * Core user type enumeration
 *
 * Note: Named CoreUserType to avoid conflict with UserType in types/rbac.ts
 */
export type CoreUserType = 'end_user' | 'admin' | 'm2m';

/**
 * User Core entity (Non-PII)
 */
export interface UserCore extends BaseEntity {
  tenant_id: string;
  email_verified: boolean;
  phone_number_verified: boolean;
  email_domain_hash: string | null;
  password_hash: string | null;
  is_active: boolean;
  user_type: CoreUserType;
  pii_partition: string;
  pii_status: PIIStatus;
  last_login_at: number | null;
}

/**
 * User Core create input
 */
export interface CreateUserCoreInput {
  id?: string;
  tenant_id?: string;
  email_verified?: boolean;
  phone_number_verified?: boolean;
  email_domain_hash?: string | null;
  password_hash?: string | null;
  is_active?: boolean;
  user_type?: CoreUserType;
  pii_partition?: string;
  pii_status?: PIIStatus;
}

/**
 * User Core update input
 */
export interface UpdateUserCoreInput {
  email_verified?: boolean;
  phone_number_verified?: boolean;
  email_domain_hash?: string | null;
  password_hash?: string | null;
  is_active?: boolean;
  user_type?: CoreUserType;
  pii_partition?: string;
  pii_status?: PIIStatus;
  last_login_at?: number | null;
}

/**
 * User Core filter options
 */
export interface UserCoreFilterOptions {
  tenant_id?: string;
  user_type?: CoreUserType;
  pii_status?: PIIStatus;
  is_active?: boolean;
  email_verified?: boolean;
  pii_partition?: string;
}

/**
 * User Core Repository
 */
export class UserCoreRepository extends BaseRepository<UserCore> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'users_core',
      primaryKey: 'id',
      softDelete: true,
      softDeleteField: 'is_active',
      allowedFields: [
        'tenant_id',
        'email_verified',
        'phone_number_verified',
        'email_domain_hash',
        'password_hash',
        'is_active',
        'user_type',
        'pii_partition',
        'pii_status',
        'last_login_at',
      ],
    });
  }

  /**
   * Create a new user in Core DB
   *
   * @param input - User creation input
   * @returns Created user
   */
  async createUser(input: CreateUserCoreInput): Promise<UserCore> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const user: UserCore = {
      id,
      tenant_id: input.tenant_id ?? 'default',
      email_verified: input.email_verified ?? false,
      phone_number_verified: input.phone_number_verified ?? false,
      email_domain_hash: input.email_domain_hash ?? null,
      password_hash: input.password_hash ?? null,
      is_active: input.is_active ?? true,
      user_type: input.user_type ?? 'end_user',
      pii_partition: input.pii_partition ?? 'default',
      pii_status: input.pii_status ?? 'pending',
      created_at: now,
      updated_at: now,
      last_login_at: null,
    };

    const sql = `
      INSERT INTO users_core (
        id, tenant_id, email_verified, phone_number_verified,
        email_domain_hash, password_hash, is_active, user_type,
        pii_partition, pii_status, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      user.id,
      user.tenant_id,
      user.email_verified ? 1 : 0,
      user.phone_number_verified ? 1 : 0,
      user.email_domain_hash,
      user.password_hash,
      user.is_active ? 1 : 0,
      user.user_type,
      user.pii_partition,
      user.pii_status,
      user.created_at,
      user.updated_at,
      user.last_login_at,
    ]);

    return user;
  }

  /**
   * Update PII status
   *
   * Used for tracking distributed PII write state:
   * - 'pending' → 'active': PII write succeeded
   * - 'pending' → 'failed': PII write failed
   * - 'active' → 'deleted': GDPR deletion completed
   *
   * @param userId - User ID
   * @param status - New PII status
   * @returns True if updated
   */
  async updatePIIStatus(userId: string, status: PIIStatus): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE users_core SET pii_status = ?, updated_at = ? WHERE id = ?',
      [status, getCurrentTimestamp(), userId]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Update last login timestamp
   *
   * @param userId - User ID
   * @returns True if updated
   */
  async updateLastLogin(userId: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'UPDATE users_core SET last_login_at = ?, updated_at = ? WHERE id = ?',
      [now, now, userId]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Find user by tenant and ID
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @returns User or null
   */
  async findByTenantAndId(tenantId: string, userId: string): Promise<UserCore | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM users_core WHERE tenant_id = ? AND id = ? AND is_active = 1',
      [tenantId, userId]
    );
    return row ? this.mapRowToEntity(row) : null;
  }

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
    return Math.min(limit, UserCoreRepository.MAX_QUERY_LIMIT);
  }

  /**
   * Find users by PII status
   *
   * Used to find users with failed PII writes for retry.
   *
   * @param status - PII status to filter by
   * @param tenantId - Optional tenant filter
   * @param limit - Maximum number of results (1-1000, default 100)
   * @returns Users with matching PII status
   */
  async findByPIIStatus(
    status: PIIStatus,
    tenantId?: string,
    limit: number = 100
  ): Promise<UserCore[]> {
    const validLimit = this.validateLimit(limit);
    let rows: Record<string, unknown>[];
    if (tenantId) {
      rows = await this.adapter.query<Record<string, unknown>>(
        'SELECT * FROM users_core WHERE pii_status = ? AND tenant_id = ? AND is_active = 1 LIMIT ?',
        [status, tenantId, validLimit]
      );
    } else {
      rows = await this.adapter.query<Record<string, unknown>>(
        'SELECT * FROM users_core WHERE pii_status = ? AND is_active = 1 LIMIT ?',
        [status, validLimit]
      );
    }
    return rows.map((row) => this.mapRowToEntity(row));
  }

  /**
   * Find users by PII partition
   *
   * @param partition - PII partition name
   * @param options - Pagination options
   * @returns Paginated users
   */
  async findByPartition(
    partition: string,
    options?: PaginationOptions
  ): Promise<PaginationResult<UserCore>> {
    return this.findAll([{ field: 'pii_partition', operator: 'eq', value: partition }], options);
  }

  /**
   * Find users by email domain hash
   *
   * Used for domain-based role assignment (Phase 8).
   *
   * @param domainHash - Email domain blind index
   * @param tenantId - Optional tenant filter
   * @returns Users with matching domain
   */
  async findByEmailDomainHash(domainHash: string, tenantId?: string): Promise<UserCore[]> {
    let rows: Record<string, unknown>[];
    if (tenantId) {
      rows = await this.adapter.query<Record<string, unknown>>(
        'SELECT * FROM users_core WHERE email_domain_hash = ? AND tenant_id = ? AND is_active = 1',
        [domainHash, tenantId]
      );
    } else {
      rows = await this.adapter.query<Record<string, unknown>>(
        'SELECT * FROM users_core WHERE email_domain_hash = ? AND is_active = 1',
        [domainHash]
      );
    }
    return rows.map((row) => this.mapRowToEntity(row));
  }

  /**
   * Search users with filters
   *
   * @param filters - Filter options
   * @param options - Pagination options
   * @returns Paginated users
   */
  async searchUsers(
    filters: UserCoreFilterOptions,
    options?: PaginationOptions
  ): Promise<PaginationResult<UserCore>> {
    const conditions: FilterCondition[] = [];

    if (filters.tenant_id) {
      conditions.push({ field: 'tenant_id', operator: 'eq', value: filters.tenant_id });
    }
    if (filters.user_type) {
      conditions.push({ field: 'user_type', operator: 'eq', value: filters.user_type });
    }
    if (filters.pii_status) {
      conditions.push({ field: 'pii_status', operator: 'eq', value: filters.pii_status });
    }
    if (filters.is_active !== undefined) {
      conditions.push({ field: 'is_active', operator: 'eq', value: filters.is_active ? 1 : 0 });
    }
    if (filters.email_verified !== undefined) {
      conditions.push({
        field: 'email_verified',
        operator: 'eq',
        value: filters.email_verified ? 1 : 0,
      });
    }
    if (filters.pii_partition) {
      conditions.push({ field: 'pii_partition', operator: 'eq', value: filters.pii_partition });
    }

    return this.findAll(conditions, options);
  }

  /**
   * Get partition statistics
   *
   * Returns count of users per PII partition.
   *
   * @param tenantId - Optional tenant filter
   * @returns Map of partition name to user count
   */
  async getPartitionStats(tenantId?: string): Promise<Map<string, number>> {
    const sql = tenantId
      ? 'SELECT pii_partition, COUNT(*) as count FROM users_core WHERE tenant_id = ? AND is_active = 1 GROUP BY pii_partition'
      : 'SELECT pii_partition, COUNT(*) as count FROM users_core WHERE is_active = 1 GROUP BY pii_partition';

    const params = tenantId ? [tenantId] : [];
    const results = await this.adapter.query<{ pii_partition: string; count: number }>(sql, params);

    const stats = new Map<string, number>();
    for (const row of results) {
      stats.set(row.pii_partition, row.count);
    }
    return stats;
  }

  /**
   * Get PII status statistics
   *
   * Returns count of users per PII status.
   *
   * @param tenantId - Optional tenant filter
   * @returns Map of status to user count
   */
  async getPIIStatusStats(tenantId?: string): Promise<Map<PIIStatus, number>> {
    const sql = tenantId
      ? 'SELECT pii_status, COUNT(*) as count FROM users_core WHERE tenant_id = ? GROUP BY pii_status'
      : 'SELECT pii_status, COUNT(*) as count FROM users_core GROUP BY pii_status';

    const params = tenantId ? [tenantId] : [];
    const results = await this.adapter.query<{ pii_status: PIIStatus; count: number }>(sql, params);

    const stats = new Map<PIIStatus, number>();
    for (const row of results) {
      stats.set(row.pii_status, row.count);
    }
    return stats;
  }

  /**
   * Override findById to convert boolean fields
   */
  override async findById(id: string): Promise<UserCore | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM users_core WHERE id = ? AND is_active = 1',
      [id]
    );
    return row ? this.mapRowToEntity(row) : null;
  }

  /**
   * Map database row to entity (convert integers to booleans)
   */
  private mapRowToEntity(row: Record<string, unknown>): UserCore {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      email_verified: Boolean(row.email_verified),
      phone_number_verified: Boolean(row.phone_number_verified),
      email_domain_hash: row.email_domain_hash as string | null,
      password_hash: row.password_hash as string | null,
      is_active: Boolean(row.is_active),
      user_type: row.user_type as CoreUserType,
      pii_partition: row.pii_partition as string,
      pii_status: row.pii_status as PIIStatus,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
      last_login_at: row.last_login_at as number | null,
    };
  }
}

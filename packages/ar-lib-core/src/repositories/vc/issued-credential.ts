/**
 * Issued Credential Repository
 *
 * Repository for tracking credentials issued by Authrim.
 * Note: Raw credential content is NOT stored - only metadata.
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
 * Credential status
 */
export type CredentialStatus = 'active' | 'revoked' | 'suspended' | 'deferred';

/**
 * Issued Credential entity
 */
export interface IssuedCredential extends BaseEntity {
  internal_id: string;
  tenant_id: string;
  user_id: string;
  credential_type: string;
  format: string;
  claims: string; // JSON - metadata only, not raw claims
  status: CredentialStatus;
  status_list_id: string | null;
  status_list_internal_id: string | null;
  status_list_index: number | null;
  holder_binding: string | null; // JSON - holder public key
  expires_at: number | null;
}

/**
 * Input for creating an issued credential record
 */
export interface CreateIssuedCredentialInput {
  id?: string;
  internal_id?: string;
  tenant_id: string;
  user_id: string;
  credential_type: string;
  format: string;
  claims?: Record<string, unknown>;
  status?: CredentialStatus;
  status_list_id?: string | null;
  status_list_internal_id?: string | null;
  status_list_index?: number | null;
  holder_binding?: object | null;
  expires_at?: number | null;
}

/**
 * Input for updating an issued credential
 */
export interface UpdateIssuedCredentialInput {
  status?: CredentialStatus;
  claims?: Record<string, unknown>;
}

/**
 * Filter options for issued credentials
 */
export interface IssuedCredentialFilterOptions {
  tenant_id?: string;
  user_id?: string;
  credential_type?: string;
  status?: CredentialStatus;
}

/**
 * Issued Credential Repository
 */
export class IssuedCredentialRepository extends BaseRepository<IssuedCredential> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'issued_credentials',
      primaryKey: 'internal_id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'public_id',
        'user_id',
        'credential_type',
        'format',
        'claims',
        'status',
        'status_list_id',
        'status_list_internal_id',
        'status_list_index',
        'holder_binding',
        'expires_at',
      ],
    });
  }

  private selectColumns(): string {
    return `internal_id, public_id AS id, tenant_id, user_id, credential_type, format, claims,
            status, status_list_id, status_list_internal_id, status_list_index, holder_binding,
            expires_at, created_at, updated_at`;
  }

  /**
   * Create a new issued credential record
   */
  async createCredential(input: CreateIssuedCredentialInput): Promise<IssuedCredential> {
    const internalId = input.internal_id ?? generateId();
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const credential: IssuedCredential = {
      id,
      internal_id: internalId,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      credential_type: input.credential_type,
      format: input.format,
      claims: input.claims ? JSON.stringify(input.claims) : '{}',
      status: input.status ?? 'active',
      status_list_id: input.status_list_id ?? null,
      status_list_internal_id: input.status_list_internal_id ?? null,
      status_list_index: input.status_list_index ?? null,
      holder_binding: input.holder_binding ? JSON.stringify(input.holder_binding) : null,
      expires_at: input.expires_at ?? null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO issued_credentials (
        internal_id, public_id, tenant_id, user_id, credential_type, format, claims,
        status, status_list_id, status_list_internal_id, status_list_index, holder_binding, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      credential.internal_id,
      credential.id,
      credential.tenant_id,
      credential.user_id,
      credential.credential_type,
      credential.format,
      credential.claims,
      credential.status,
      credential.status_list_id,
      credential.status_list_internal_id,
      credential.status_list_index,
      credential.holder_binding,
      credential.expires_at,
      credential.created_at,
      credential.updated_at,
    ]);

    return credential;
  }

  /**
   * Find credential by ID and user (ownership verification)
   */
  async findByIdForTenant(tenantId: string, id: string): Promise<IssuedCredential | null> {
    return this.adapter.queryOne<IssuedCredential>(
      `SELECT ${this.selectColumns()} FROM issued_credentials WHERE tenant_id = ? AND public_id = ?`,
      [tenantId, id]
    );
  }

  /**
   * Find credential by tenant, ID, and user (ownership verification)
   */
  async findByIdAndUser(
    tenantId: string,
    id: string,
    userId: string
  ): Promise<IssuedCredential | null> {
    return this.adapter.queryOne<IssuedCredential>(
      `SELECT ${this.selectColumns()} FROM issued_credentials WHERE tenant_id = ? AND public_id = ? AND user_id = ?`,
      [tenantId, id, userId]
    );
  }

  /**
   * Find deferred credential by transaction ID and user
   */
  async findDeferredByIdAndUser(
    tenantId: string,
    transactionId: string,
    userId: string
  ): Promise<IssuedCredential | null> {
    return this.adapter.queryOne<IssuedCredential>(
      `SELECT ${this.selectColumns()} FROM issued_credentials
       WHERE tenant_id = ? AND public_id = ? AND status = 'deferred' AND user_id = ?`,
      [tenantId, transactionId, userId]
    );
  }

  /**
   * Find credentials by user
   */
  async findByUser(
    tenantId: string,
    userId: string,
    options?: PaginationOptions
  ): Promise<PaginationResult<IssuedCredential>> {
    return this.searchCredentials({ tenant_id: tenantId, user_id: userId }, options);
  }

  /**
   * Update credential status
   */
  async updateStatus(tenantId: string, id: string, status: CredentialStatus): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE issued_credentials SET status = ?, updated_at = ? WHERE tenant_id = ? AND public_id = ?',
      [status, getCurrentTimestamp(), tenantId, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Update credential claims (for deferred issuance)
   */
  async updateClaims(
    tenantId: string,
    id: string,
    claims: Record<string, unknown>
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE issued_credentials SET claims = ?, updated_at = ? WHERE tenant_id = ? AND public_id = ?',
      [JSON.stringify(claims), getCurrentTimestamp(), tenantId, id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Revoke a credential
   */
  async revoke(tenantId: string, id: string): Promise<boolean> {
    return this.updateStatus(tenantId, id, 'revoked');
  }

  /**
   * Search credentials with filters
   */
  async searchCredentials(
    filters: IssuedCredentialFilterOptions,
    options?: PaginationOptions
  ): Promise<PaginationResult<IssuedCredential>> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filters.tenant_id) {
      conditions.push('tenant_id = ?');
      values.push(filters.tenant_id);
    }
    if (filters.user_id) {
      conditions.push('user_id = ?');
      values.push(filters.user_id);
    }
    if (filters.credential_type) {
      conditions.push('credential_type = ?');
      values.push(filters.credential_type);
    }
    if (filters.status) {
      conditions.push('status = ?');
      values.push(filters.status);
    }

    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const offset = (page - 1) * limit;
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await this.adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM issued_credentials ${whereSql}`,
      values
    );
    const total = countResult?.count ?? 0;
    const items = await this.adapter.query<IssuedCredential>(
      `SELECT ${this.selectColumns()}
       FROM issued_credentials
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
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
   * Get credential statistics for a tenant
   */
  async getStats(tenantId: string): Promise<{
    total: number;
    active: number;
    revoked: number;
    suspended: number;
    deferred: number;
  }> {
    const results = await this.adapter.query<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count
       FROM issued_credentials
       WHERE tenant_id = ?
       GROUP BY status`,
      [tenantId]
    );

    const stats = { total: 0, active: 0, revoked: 0, suspended: 0, deferred: 0 };
    for (const row of results) {
      const count = row.count;
      stats.total += count;
      if (row.status === 'active') stats.active = count;
      else if (row.status === 'revoked') stats.revoked = count;
      else if (row.status === 'suspended') stats.suspended = count;
      else if (row.status === 'deferred') stats.deferred = count;
    }
    return stats;
  }

  /**
   * Find credentials by status list index (for status list updates)
   */
  async findByStatusListIndex(
    tenantId: string,
    statusListId: string,
    index: number
  ): Promise<IssuedCredential | null> {
    return this.adapter.queryOne<IssuedCredential>(
      `SELECT ${this.selectColumns()}
       FROM issued_credentials
       WHERE tenant_id = ? AND status_list_id = ? AND status_list_index = ?`,
      [tenantId, statusListId, index]
    );
  }

  /**
   * Get next available status list index
   */
  async getNextStatusListIndex(tenantId: string): Promise<number> {
    const result = await this.adapter.queryOne<{ max_index: number | null }>(
      'SELECT MAX(status_list_index) as max_index FROM issued_credentials WHERE tenant_id = ?',
      [tenantId]
    );
    return (result?.max_index ?? -1) + 1;
  }

  /**
   * Parse claims JSON
   */
  parseClaims(credential: IssuedCredential): Record<string, unknown> {
    try {
      return JSON.parse(credential.claims) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Parse holder binding JSON
   */
  parseHolderBinding(credential: IssuedCredential): object | null {
    if (!credential.holder_binding) {
      return null;
    }
    try {
      return JSON.parse(credential.holder_binding) as object;
    } catch {
      return null;
    }
  }
}

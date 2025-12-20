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
  type FilterCondition,
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
  tenant_id: string;
  user_id: string;
  credential_type: string;
  format: string;
  claims: string; // JSON - metadata only, not raw claims
  status: CredentialStatus;
  status_list_id: string | null;
  status_list_index: number | null;
  holder_binding: string | null; // JSON - holder public key
  expires_at: number | null;
}

/**
 * Input for creating an issued credential record
 */
export interface CreateIssuedCredentialInput {
  id?: string;
  tenant_id: string;
  user_id: string;
  credential_type: string;
  format: string;
  claims?: Record<string, unknown>;
  status?: CredentialStatus;
  status_list_id?: string | null;
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
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'user_id',
        'credential_type',
        'format',
        'claims',
        'status',
        'status_list_index',
        'holder_binding',
        'expires_at',
      ],
    });
  }

  /**
   * Create a new issued credential record
   */
  async createCredential(input: CreateIssuedCredentialInput): Promise<IssuedCredential> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const credential: IssuedCredential = {
      id,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      credential_type: input.credential_type,
      format: input.format,
      claims: input.claims ? JSON.stringify(input.claims) : '{}',
      status: input.status ?? 'active',
      status_list_id: input.status_list_id ?? null,
      status_list_index: input.status_list_index ?? null,
      holder_binding: input.holder_binding ? JSON.stringify(input.holder_binding) : null,
      expires_at: input.expires_at ?? null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO issued_credentials (
        id, tenant_id, user_id, credential_type, format, claims,
        status, status_list_id, status_list_index, holder_binding, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      credential.id,
      credential.tenant_id,
      credential.user_id,
      credential.credential_type,
      credential.format,
      credential.claims,
      credential.status,
      credential.status_list_id,
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
  async findByIdAndUser(id: string, userId: string): Promise<IssuedCredential | null> {
    return this.adapter.queryOne<IssuedCredential>(
      'SELECT * FROM issued_credentials WHERE id = ? AND user_id = ?',
      [id, userId]
    );
  }

  /**
   * Find deferred credential by transaction ID and user
   */
  async findDeferredByIdAndUser(
    transactionId: string,
    userId: string
  ): Promise<IssuedCredential | null> {
    return this.adapter.queryOne<IssuedCredential>(
      `SELECT * FROM issued_credentials
       WHERE id = ? AND status = 'deferred' AND user_id = ?`,
      [transactionId, userId]
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
    return this.findAll(
      [
        { field: 'tenant_id', operator: 'eq', value: tenantId },
        { field: 'user_id', operator: 'eq', value: userId },
      ],
      options
    );
  }

  /**
   * Update credential status
   */
  async updateStatus(id: string, status: CredentialStatus): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE issued_credentials SET status = ?, updated_at = ? WHERE id = ?',
      [status, getCurrentTimestamp(), id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Update credential claims (for deferred issuance)
   */
  async updateClaims(id: string, claims: Record<string, unknown>): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE issued_credentials SET claims = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(claims), getCurrentTimestamp(), id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Revoke a credential
   */
  async revoke(id: string): Promise<boolean> {
    return this.updateStatus(id, 'revoked');
  }

  /**
   * Search credentials with filters
   */
  async searchCredentials(
    filters: IssuedCredentialFilterOptions,
    options?: PaginationOptions
  ): Promise<PaginationResult<IssuedCredential>> {
    const conditions: FilterCondition[] = [];

    if (filters.tenant_id) {
      conditions.push({ field: 'tenant_id', operator: 'eq', value: filters.tenant_id });
    }
    if (filters.user_id) {
      conditions.push({ field: 'user_id', operator: 'eq', value: filters.user_id });
    }
    if (filters.credential_type) {
      conditions.push({ field: 'credential_type', operator: 'eq', value: filters.credential_type });
    }
    if (filters.status) {
      conditions.push({ field: 'status', operator: 'eq', value: filters.status });
    }

    return this.findAll(conditions, options);
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
  async findByStatusListIndex(index: number): Promise<IssuedCredential | null> {
    return this.adapter.queryOne<IssuedCredential>(
      'SELECT * FROM issued_credentials WHERE status_list_index = ?',
      [index]
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

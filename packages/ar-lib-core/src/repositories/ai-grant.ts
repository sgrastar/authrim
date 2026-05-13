/**
 * AI Grant Repository
 *
 * Repository for managing AI Grants in the database.
 * AI Grants authorize AI principals (agents, tools, services) to act
 * on behalf of users or systems.
 *
 * Part of the Human Auth / AI Ephemeral Auth Two-Layer Model.
 */

import { BaseRepository, type FilterCondition, type PaginationOptions } from './base';
import type { DatabaseAdapter } from '../db/adapter';

/**
 * AI Grant entity interface
 */
export interface AIGrant {
  id: string;
  tenant_id: string;
  client_id: string;
  ai_principal: string;
  scopes: string;
  scope_targets: string | null;
  is_active: number;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

/**
 * AI Grant create input
 */
export interface AIGrantCreateInput {
  tenant_id: string;
  client_id: string;
  ai_principal: string;
  scopes: string;
  scope_targets?: string | null;
  expires_at?: number | null;
  created_by?: string | null;
}

/**
 * AI Grant update input
 */
export interface AIGrantUpdateInput {
  scopes?: string;
  scope_targets?: string | null;
  expires_at?: number | null;
  is_active?: number;
}

/**
 * AI Grant Repository
 *
 * Extends BaseRepository with AI Grant specific functionality:
 * - Tenant-scoped queries
 * - Unique constraint on (tenant_id, client_id, ai_principal)
 * - Revocation tracking
 */
export class AIGrantRepository extends BaseRepository<AIGrant> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'ai_grants',
      primaryKey: 'id',
      softDelete: true,
      softDeleteField: 'is_active',
      allowedFields: [
        'id',
        'tenant_id',
        'client_id',
        'ai_principal',
        'scopes',
        'scope_targets',
        'is_active',
        'expires_at',
        'created_by',
        'created_at',
        'updated_at',
        'revoked_at',
        'revoked_by',
      ],
    });
  }

  /**
   * Find grant by ID within a tenant
   *
   * @param id - Grant ID
   * @param tenantId - Tenant ID
   * @returns Grant or null
   */
  async findByIdInTenant(id: string, tenantId: string): Promise<AIGrant | null> {
    return this.adapter.queryOne<AIGrant>(
      'SELECT * FROM ai_grants WHERE id = ? AND tenant_id = ? AND is_active = 1',
      [id, tenantId]
    );
  }

  /**
   * Find all grants for a client
   *
   * @param clientId - Client ID
   * @param tenantId - Tenant ID
   * @returns List of grants
   */
  async findByClientId(clientId: string, tenantId: string): Promise<AIGrant[]> {
    return this.adapter.query<AIGrant>(
      'SELECT * FROM ai_grants WHERE tenant_id = ? AND client_id = ? AND is_active = 1 ORDER BY created_at DESC',
      [tenantId, clientId]
    );
  }

  /**
   * Find all grants for an AI principal
   *
   * @param aiPrincipal - AI principal identifier
   * @param tenantId - Tenant ID
   * @returns List of grants
   */
  async findByPrincipal(aiPrincipal: string, tenantId: string): Promise<AIGrant[]> {
    return this.adapter.query<AIGrant>(
      'SELECT * FROM ai_grants WHERE ai_principal = ? AND tenant_id = ? AND is_active = 1 ORDER BY created_at DESC',
      [aiPrincipal, tenantId]
    );
  }

  /**
   * Find grant by client and principal (unique constraint)
   *
   * @param clientId - Client ID
   * @param aiPrincipal - AI principal identifier
   * @param tenantId - Tenant ID
   * @returns Grant or null
   */
  async findByClientAndPrincipal(
    clientId: string,
    aiPrincipal: string,
    tenantId: string
  ): Promise<AIGrant | null> {
    return this.adapter.queryOne<AIGrant>(
      'SELECT * FROM ai_grants WHERE client_id = ? AND ai_principal = ? AND tenant_id = ?',
      [clientId, aiPrincipal, tenantId]
    );
  }

  /**
   * Find all grants in a tenant with pagination
   *
   * @param tenantId - Tenant ID
   * @param options - Pagination and filter options
   * @returns Paginated grants
   */
  async findAllInTenant(
    tenantId: string,
    options?: PaginationOptions & {
      clientId?: string;
      aiPrincipal?: string;
      isActive?: boolean;
    }
  ) {
    const conditions: FilterCondition[] = [{ field: 'tenant_id', operator: 'eq', value: tenantId }];

    if (options?.clientId) {
      conditions.push({ field: 'client_id', operator: 'eq', value: options.clientId });
    }

    if (options?.aiPrincipal) {
      conditions.push({ field: 'ai_principal', operator: 'like', value: options.aiPrincipal });
    }

    if (options?.isActive !== undefined) {
      conditions.push({ field: 'is_active', operator: 'eq', value: options.isActive ? 1 : 0 });
    }

    return this.findAll(conditions, options);
  }

  /**
   * Create a new AI grant
   *
   * @param input - Grant creation input
   * @returns Created grant
   */
  async createGrant(input: AIGrantCreateInput): Promise<AIGrant> {
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();

    await this.adapter.execute(
      `INSERT INTO ai_grants (
        id, tenant_id, client_id, ai_principal, scopes, scope_targets,
        is_active, expires_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        id,
        input.tenant_id,
        input.client_id,
        input.ai_principal,
        input.scopes,
        input.scope_targets ?? null,
        input.expires_at ?? null,
        input.created_by ?? null,
        now,
        now,
      ]
    );

    const grant = await this.findById(id);
    if (!grant) {
      throw new Error('Failed to create AI grant');
    }
    return grant;
  }

  /**
   * Update an AI grant
   *
   * @param id - Grant ID
   * @param tenantId - Tenant ID
   * @param input - Update input
   * @returns Updated grant or null
   */
  async updateGrant(
    id: string,
    tenantId: string,
    input: AIGrantUpdateInput
  ): Promise<AIGrant | null> {
    const existing = await this.findByIdInTenant(id, tenantId);
    if (!existing) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const updates: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (input.scopes !== undefined) {
      updates.push('scopes = ?');
      values.push(input.scopes);
    }

    if (input.scope_targets !== undefined) {
      updates.push('scope_targets = ?');
      values.push(input.scope_targets);
    }

    if (input.expires_at !== undefined) {
      updates.push('expires_at = ?');
      values.push(input.expires_at);
    }

    if (input.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(input.is_active);
    }

    await this.adapter.execute(
      `UPDATE ai_grants SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      [...values, id, tenantId]
    );

    return this.findByIdInTenant(id, tenantId);
  }

  /**
   * Revoke an AI grant (soft delete with revocation tracking)
   *
   * @param id - Grant ID
   * @param tenantId - Tenant ID
   * @param revokedBy - User ID who revoked the grant
   * @returns True if revoked, false if not found
   */
  async revokeGrant(id: string, tenantId: string, revokedBy?: string): Promise<boolean> {
    const existing = await this.findByIdInTenant(id, tenantId);
    if (!existing) {
      return false;
    }

    if (existing.revoked_at) {
      // Already revoked
      return false;
    }

    const now = Math.floor(Date.now() / 1000);

    const result = await this.adapter.execute(
      'UPDATE ai_grants SET is_active = 0, revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [now, revokedBy ?? null, now, id, tenantId]
    );

    return result.rowsAffected > 0;
  }

  /**
   * Find active, non-expired grants for a client and principal
   * Used for token issuance validation
   *
   * @param clientId - Client ID
   * @param aiPrincipal - AI principal identifier
   * @param tenantId - Tenant ID
   * @returns Active grant or null
   */
  async findActiveGrant(
    clientId: string,
    aiPrincipal: string,
    tenantId: string
  ): Promise<AIGrant | null> {
    const now = Math.floor(Date.now() / 1000);

    return this.adapter.queryOne<AIGrant>(
      `SELECT * FROM ai_grants
       WHERE client_id = ? AND ai_principal = ? AND tenant_id = ?
       AND is_active = 1
       AND (expires_at IS NULL OR expires_at > ?)`,
      [clientId, aiPrincipal, tenantId, now]
    );
  }

  /**
   * Delete expired grants for a tenant-owned cleanup job.
   *
   * @param tenantId - Tenant ID
   * @returns Number of deleted grants
   */
  async deleteExpiredGrants(tenantId: string): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) {
      throw new Error('AIGrantRepository.deleteExpiredGrants requires tenantId');
    }

    const result = await this.adapter.execute(
      'DELETE FROM ai_grants WHERE expires_at IS NOT NULL AND expires_at < ? AND tenant_id = ?',
      [now, normalizedTenantId]
    );
    return result.rowsAffected;
  }

  /**
   * Delete expired grants across all tenants.
   *
   * This is a system maintenance operation and should not be used from tenant request paths.
   *
   * @returns Number of deleted grants
   */
  async deleteExpiredGrantsGlobal(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.adapter.execute(
      'DELETE FROM ai_grants WHERE expires_at IS NOT NULL AND expires_at < ?',
      [now]
    );
    return result.rowsAffected;
  }
}

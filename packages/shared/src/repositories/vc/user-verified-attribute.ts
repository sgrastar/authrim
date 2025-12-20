/**
 * User Verified Attribute Repository
 *
 * Repository for storing normalized, verified attributes from VCs.
 * Implements data minimization - raw VC claims are discarded,
 * only normalized boolean/enum values are stored.
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
 * Source type for attributes
 */
export type AttributeSourceType = 'vc' | 'saml' | 'manual';

/**
 * User Verified Attribute entity
 */
export interface UserVerifiedAttribute extends BaseEntity {
  tenant_id: string;
  user_id: string;
  attribute_name: string;
  attribute_value: string;
  source_type: AttributeSourceType;
  issuer_did: string | null;
  verification_id: string | null;
  verified_at: number;
  expires_at: number | null;
}

/**
 * Input for creating/upserting a verified attribute
 */
export interface CreateUserVerifiedAttributeInput {
  id?: string;
  tenant_id: string;
  user_id: string;
  attribute_name: string;
  attribute_value: string;
  source_type: AttributeSourceType;
  issuer_did?: string | null;
  verification_id?: string | null;
  expires_at?: number | null;
}

/**
 * Filter options for user verified attributes
 */
export interface UserVerifiedAttributeFilterOptions {
  tenant_id?: string;
  user_id?: string;
  attribute_name?: string;
  source_type?: AttributeSourceType;
}

/**
 * User Verified Attribute Repository
 */
export class UserVerifiedAttributeRepository extends BaseRepository<UserVerifiedAttribute> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'user_verified_attributes',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'user_id',
        'attribute_name',
        'attribute_value',
        'source_type',
        'issuer_did',
        'verification_id',
        'verified_at',
        'expires_at',
      ],
    });
  }

  /**
   * Upsert a verified attribute
   *
   * If attribute exists (same tenant, user, name), update it.
   * Otherwise, insert a new record.
   */
  async upsertAttribute(input: CreateUserVerifiedAttributeInput): Promise<UserVerifiedAttribute> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const attribute: UserVerifiedAttribute = {
      id,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      attribute_name: input.attribute_name,
      attribute_value: input.attribute_value,
      source_type: input.source_type,
      issuer_did: input.issuer_did ?? null,
      verification_id: input.verification_id ?? null,
      verified_at: now,
      expires_at: input.expires_at ?? null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO user_verified_attributes (
        id, tenant_id, user_id, attribute_name, attribute_value,
        source_type, issuer_did, verification_id, verified_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, user_id, attribute_name) DO UPDATE SET
        attribute_value = excluded.attribute_value,
        issuer_did = excluded.issuer_did,
        verification_id = excluded.verification_id,
        verified_at = excluded.verified_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `;

    await this.adapter.execute(sql, [
      attribute.id,
      attribute.tenant_id,
      attribute.user_id,
      attribute.attribute_name,
      attribute.attribute_value,
      attribute.source_type,
      attribute.issuer_did,
      attribute.verification_id,
      attribute.verified_at,
      attribute.expires_at,
      attribute.created_at,
      attribute.updated_at,
    ]);

    return attribute;
  }

  /**
   * Get all valid (non-expired) attributes for a user
   */
  async getValidAttributesForUser(
    tenantId: string,
    userId: string
  ): Promise<Record<string, string>> {
    const now = getCurrentTimestamp();
    const rows = await this.adapter.query<UserVerifiedAttribute>(
      `SELECT attribute_name, attribute_value
       FROM user_verified_attributes
       WHERE tenant_id = ? AND user_id = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, userId, now]
    );

    const attributes: Record<string, string> = {};
    for (const row of rows) {
      attributes[row.attribute_name] = row.attribute_value;
    }
    return attributes;
  }

  /**
   * Check if a user has a specific verified attribute
   */
  async hasAttribute(
    tenantId: string,
    userId: string,
    attributeName: string,
    expectedValue?: string
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const row = await this.adapter.queryOne<UserVerifiedAttribute>(
      `SELECT attribute_value
       FROM user_verified_attributes
       WHERE tenant_id = ? AND user_id = ? AND attribute_name = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, userId, attributeName, now]
    );

    if (!row) {
      return false;
    }

    if (expectedValue !== undefined) {
      return row.attribute_value === expectedValue;
    }

    return true;
  }

  /**
   * Get a specific attribute for a user
   */
  async getAttribute(
    tenantId: string,
    userId: string,
    attributeName: string
  ): Promise<UserVerifiedAttribute | null> {
    const now = getCurrentTimestamp();
    return this.adapter.queryOne<UserVerifiedAttribute>(
      `SELECT * FROM user_verified_attributes
       WHERE tenant_id = ? AND user_id = ? AND attribute_name = ?
         AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, userId, attributeName, now]
    );
  }

  /**
   * Delete a specific attribute (GDPR: right to be forgotten)
   */
  async deleteAttribute(tenantId: string, userId: string, attributeName: string): Promise<boolean> {
    const result = await this.adapter.execute(
      `DELETE FROM user_verified_attributes
       WHERE tenant_id = ? AND user_id = ? AND attribute_name = ?`,
      [tenantId, userId, attributeName]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Delete all attributes for a user (account deletion)
   */
  async deleteAllForUser(tenantId: string, userId: string): Promise<number> {
    const result = await this.adapter.execute(
      `DELETE FROM user_verified_attributes
       WHERE tenant_id = ? AND user_id = ?`,
      [tenantId, userId]
    );
    return result.rowsAffected;
  }

  /**
   * Find attributes by verification ID
   */
  async findByVerificationId(verificationId: string): Promise<UserVerifiedAttribute[]> {
    return this.adapter.query<UserVerifiedAttribute>(
      'SELECT * FROM user_verified_attributes WHERE verification_id = ?',
      [verificationId]
    );
  }

  /**
   * Search attributes with filters
   */
  async searchAttributes(
    filters: UserVerifiedAttributeFilterOptions,
    options?: PaginationOptions
  ): Promise<PaginationResult<UserVerifiedAttribute>> {
    const conditions: FilterCondition[] = [];

    if (filters.tenant_id) {
      conditions.push({ field: 'tenant_id', operator: 'eq', value: filters.tenant_id });
    }
    if (filters.user_id) {
      conditions.push({ field: 'user_id', operator: 'eq', value: filters.user_id });
    }
    if (filters.attribute_name) {
      conditions.push({ field: 'attribute_name', operator: 'eq', value: filters.attribute_name });
    }
    if (filters.source_type) {
      conditions.push({ field: 'source_type', operator: 'eq', value: filters.source_type });
    }

    return this.findAll(conditions, options);
  }

  /**
   * Delete expired attributes (cleanup job)
   */
  async deleteExpired(): Promise<number> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'DELETE FROM user_verified_attributes WHERE expires_at IS NOT NULL AND expires_at < ?',
      [now]
    );
    return result.rowsAffected;
  }
}

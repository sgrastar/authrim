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
  revalidate_after?: number | null;
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
  revalidate_after?: number | null;
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

interface ExistingUserVerifiedAttribute {
  id: string;
  created_at: number;
}

function isUniqueConstraintError(error: unknown): boolean {
  return String(error).includes('UNIQUE constraint');
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
        'revalidate_after',
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
    const now = getCurrentTimestamp();
    const existing = await this.adapter.queryOne<ExistingUserVerifiedAttribute>(
      `SELECT id, created_at
       FROM user_verified_attributes
       WHERE tenant_id = ? AND user_id = ? AND attribute_name = ?`,
      [input.tenant_id, input.user_id, input.attribute_name]
    );

    if (existing) {
      await this.adapter.execute(
        `UPDATE user_verified_attributes
         SET attribute_value = ?,
             source_type = ?,
             issuer_did = ?,
             verification_id = ?,
             verified_at = ?,
             expires_at = ?,
             revalidate_after = ?,
             updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
        [
          input.attribute_value,
          input.source_type,
          input.issuer_did ?? null,
          input.verification_id ?? null,
          now,
          input.expires_at ?? null,
          input.revalidate_after ?? null,
          now,
          input.tenant_id,
          existing.id,
        ]
      );

      return {
        id: existing.id,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        attribute_name: input.attribute_name,
        attribute_value: input.attribute_value,
        source_type: input.source_type,
        issuer_did: input.issuer_did ?? null,
        verification_id: input.verification_id ?? null,
        verified_at: now,
        expires_at: input.expires_at ?? null,
        revalidate_after: input.revalidate_after ?? null,
        created_at: existing.created_at,
        updated_at: now,
      };
    }

    const createdAttribute: UserVerifiedAttribute = {
      id: input.id ?? generateId(),
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      attribute_name: input.attribute_name,
      attribute_value: input.attribute_value,
      source_type: input.source_type,
      issuer_did: input.issuer_did ?? null,
      verification_id: input.verification_id ?? null,
      verified_at: now,
      expires_at: input.expires_at ?? null,
      revalidate_after: input.revalidate_after ?? null,
      created_at: now,
      updated_at: now,
    };

    try {
      await this.adapter.execute(
        `INSERT INTO user_verified_attributes (
          id, tenant_id, user_id, attribute_name, attribute_value,
          source_type, issuer_did, verification_id, verified_at, expires_at, revalidate_after,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createdAttribute.id,
          createdAttribute.tenant_id,
          createdAttribute.user_id,
          createdAttribute.attribute_name,
          createdAttribute.attribute_value,
          createdAttribute.source_type,
          createdAttribute.issuer_did,
          createdAttribute.verification_id,
          createdAttribute.verified_at,
          createdAttribute.expires_at,
          createdAttribute.revalidate_after,
          createdAttribute.created_at,
          createdAttribute.updated_at,
        ]
      );

      return createdAttribute;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    const raced = await this.adapter.queryOne<ExistingUserVerifiedAttribute>(
      `SELECT id, created_at
       FROM user_verified_attributes
       WHERE tenant_id = ? AND user_id = ? AND attribute_name = ?`,
      [input.tenant_id, input.user_id, input.attribute_name]
    );

    if (!raced) {
      throw new Error('Failed to resolve raced user verified attribute');
    }

    await this.adapter.execute(
      `UPDATE user_verified_attributes
       SET attribute_value = ?,
           source_type = ?,
           issuer_did = ?,
           verification_id = ?,
           verified_at = ?,
           expires_at = ?,
           revalidate_after = ?,
           updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      [
        input.attribute_value,
        input.source_type,
        input.issuer_did ?? null,
        input.verification_id ?? null,
        now,
        input.expires_at ?? null,
        input.revalidate_after ?? null,
        now,
        input.tenant_id,
        raced.id,
      ]
    );

    return {
      ...createdAttribute,
      id: raced.id,
      created_at: raced.created_at,
    };
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
      `SELECT a.attribute_name, a.attribute_value
       FROM user_verified_attributes a
       LEFT JOIN attribute_verifications v
         ON v.id = a.verification_id AND v.tenant_id = a.tenant_id
       LEFT JOIN trusted_issuers ti
         ON ti.tenant_id = v.tenant_id AND ti.issuer_did = v.issuer_did
       WHERE a.tenant_id = ? AND a.user_id = ?
         AND (a.expires_at IS NULL OR a.expires_at > ?)
         AND (a.revalidate_after IS NULL OR a.revalidate_after > ?)
         AND (a.source_type <> 'vc' OR (
           v.verification_result = 'verified' AND v.holder_binding_verified = 1
           AND v.issuer_trusted = 1 AND v.status_valid = 1 AND v.invalidated_at IS NULL
           AND ti.status = 'active'
           AND (v.expires_at IS NULL OR v.expires_at > ?)
           AND (v.revalidate_after IS NULL OR v.revalidate_after > ?)
           AND (v.status_fresh_until IS NULL OR v.status_fresh_until > ?)
         ))`,
      [tenantId, userId, now, now, now, now, now]
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
      `SELECT a.attribute_value
       FROM user_verified_attributes a
       LEFT JOIN attribute_verifications v
         ON v.id = a.verification_id AND v.tenant_id = a.tenant_id
       LEFT JOIN trusted_issuers ti
         ON ti.tenant_id = v.tenant_id AND ti.issuer_did = v.issuer_did
       WHERE a.tenant_id = ? AND a.user_id = ? AND a.attribute_name = ?
         AND (a.expires_at IS NULL OR a.expires_at > ?)
         AND (a.revalidate_after IS NULL OR a.revalidate_after > ?)
         AND (a.source_type <> 'vc' OR (
           v.verification_result = 'verified' AND v.holder_binding_verified = 1
           AND v.issuer_trusted = 1 AND v.status_valid = 1 AND v.invalidated_at IS NULL
           AND ti.status = 'active'
           AND (v.expires_at IS NULL OR v.expires_at > ?)
           AND (v.revalidate_after IS NULL OR v.revalidate_after > ?)
           AND (v.status_fresh_until IS NULL OR v.status_fresh_until > ?)
         ))`,
      [tenantId, userId, attributeName, now, now, now, now, now]
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
      `SELECT a.* FROM user_verified_attributes a
       LEFT JOIN attribute_verifications v
         ON v.id = a.verification_id AND v.tenant_id = a.tenant_id
       LEFT JOIN trusted_issuers ti
         ON ti.tenant_id = v.tenant_id AND ti.issuer_did = v.issuer_did
       WHERE a.tenant_id = ? AND a.user_id = ? AND a.attribute_name = ?
         AND (a.expires_at IS NULL OR a.expires_at > ?)
         AND (a.revalidate_after IS NULL OR a.revalidate_after > ?)
         AND (a.source_type <> 'vc' OR (
           v.verification_result = 'verified' AND v.holder_binding_verified = 1
           AND v.issuer_trusted = 1 AND v.status_valid = 1 AND v.invalidated_at IS NULL
           AND ti.status = 'active'
           AND (v.expires_at IS NULL OR v.expires_at > ?)
           AND (v.revalidate_after IS NULL OR v.revalidate_after > ?)
           AND (v.status_fresh_until IS NULL OR v.status_fresh_until > ?)
         ))`,
      [tenantId, userId, attributeName, now, now, now, now, now]
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

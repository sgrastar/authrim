/**
 * Attribute Verification Repository
 *
 * Repository for storing VC verification records.
 * Implements data minimization - raw VCs are NOT stored,
 * only verification results (boolean/enum) are persisted.
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
 * Verification result status
 */
export type VerificationResultStatus = 'verified' | 'failed' | 'expired';

/**
 * Attribute Verification entity
 */
export interface AttributeVerification extends BaseEntity {
  tenant_id: string;
  user_id: string | null;
  vp_request_id: string | null;
  issuer_did: string;
  credential_type: string;
  format: string;
  verification_result: VerificationResultStatus;
  holder_binding_verified: boolean;
  issuer_trusted: boolean;
  status_valid: boolean;
  mapped_attribute_ids: string | null; // JSON array
  verified_at: number;
  expires_at: number | null;
  credential_profile_id: string | null;
  credential_profile_version_id: string | null;
  mapping_version_id: string | null;
  mapping_snapshot_hash: string | null;
  policy_version: string | null;
  evidence_fingerprint: string | null;
  status_checked_at: number | null;
  status_fresh_until: number | null;
  revalidate_after: number | null;
  invalidated_at: number | null;
  invalidation_reason: string | null;
}

/**
 * Input for creating an attribute verification
 */
export interface CreateAttributeVerificationInput {
  id?: string;
  tenant_id: string;
  user_id?: string | null;
  vp_request_id?: string | null;
  issuer_did: string;
  credential_type: string;
  format: string;
  verification_result: VerificationResultStatus;
  holder_binding_verified: boolean;
  issuer_trusted: boolean;
  status_valid: boolean;
  mapped_attribute_ids?: string[];
  expires_at?: number | null;
  credential_profile_id?: string | null;
  credential_profile_version_id?: string | null;
  mapping_version_id?: string | null;
  mapping_snapshot_hash?: string | null;
  policy_version?: string | null;
  evidence_fingerprint?: string | null;
  status_checked_at?: number | null;
  status_fresh_until?: number | null;
  revalidate_after?: number | null;
}

/**
 * Filter options for attribute verifications
 */
export interface AttributeVerificationFilterOptions {
  tenant_id?: string;
  user_id?: string;
  vp_request_id?: string;
  verification_result?: VerificationResultStatus;
  issuer_did?: string;
}

/**
 * Attribute Verification Repository
 */
export class AttributeVerificationRepository extends BaseRepository<AttributeVerification> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'attribute_verifications',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'tenant_id',
        'user_id',
        'vp_request_id',
        'issuer_did',
        'credential_type',
        'format',
        'verification_result',
        'holder_binding_verified',
        'issuer_trusted',
        'status_valid',
        'mapped_attribute_ids',
        'verified_at',
        'expires_at',
        'credential_profile_id',
        'credential_profile_version_id',
        'mapping_version_id',
        'mapping_snapshot_hash',
        'policy_version',
        'evidence_fingerprint',
        'status_checked_at',
        'status_fresh_until',
        'revalidate_after',
        'invalidated_at',
        'invalidation_reason',
      ],
    });
  }

  /**
   * Create a new attribute verification record
   */
  async createVerification(
    input: CreateAttributeVerificationInput
  ): Promise<AttributeVerification> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const verification: AttributeVerification = {
      id,
      tenant_id: input.tenant_id,
      user_id: input.user_id ?? null,
      vp_request_id: input.vp_request_id ?? null,
      issuer_did: input.issuer_did,
      credential_type: input.credential_type,
      format: input.format,
      verification_result: input.verification_result,
      holder_binding_verified: input.holder_binding_verified,
      issuer_trusted: input.issuer_trusted,
      status_valid: input.status_valid,
      mapped_attribute_ids: input.mapped_attribute_ids
        ? JSON.stringify(input.mapped_attribute_ids)
        : null,
      verified_at: now,
      expires_at: input.expires_at ?? null,
      credential_profile_id: input.credential_profile_id ?? null,
      credential_profile_version_id: input.credential_profile_version_id ?? null,
      mapping_version_id: input.mapping_version_id ?? null,
      mapping_snapshot_hash: input.mapping_snapshot_hash ?? null,
      policy_version: input.policy_version ?? null,
      evidence_fingerprint: input.evidence_fingerprint ?? null,
      status_checked_at: input.status_checked_at ?? null,
      status_fresh_until: input.status_fresh_until ?? null,
      revalidate_after: input.revalidate_after ?? null,
      invalidated_at: null,
      invalidation_reason: null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO attribute_verifications (
        id, tenant_id, user_id, vp_request_id, issuer_did, credential_type,
        format, verification_result, holder_binding_verified, issuer_trusted,
        status_valid, mapped_attribute_ids, verified_at, expires_at,
        credential_profile_id, credential_profile_version_id, mapping_version_id,
        mapping_snapshot_hash, policy_version, evidence_fingerprint, status_checked_at,
        status_fresh_until, revalidate_after, invalidated_at, invalidation_reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      verification.id,
      verification.tenant_id,
      verification.user_id,
      verification.vp_request_id,
      verification.issuer_did,
      verification.credential_type,
      verification.format,
      verification.verification_result,
      verification.holder_binding_verified ? 1 : 0,
      verification.issuer_trusted ? 1 : 0,
      verification.status_valid ? 1 : 0,
      verification.mapped_attribute_ids,
      verification.verified_at,
      verification.expires_at,
      verification.credential_profile_id,
      verification.credential_profile_version_id,
      verification.mapping_version_id,
      verification.mapping_snapshot_hash,
      verification.policy_version,
      verification.evidence_fingerprint,
      verification.status_checked_at,
      verification.status_fresh_until,
      verification.revalidate_after,
      verification.invalidated_at,
      verification.invalidation_reason,
      verification.created_at,
      verification.updated_at,
    ]);

    return verification;
  }

  async invalidateVerification(
    tenantId: string,
    verificationId: string,
    reason: string
  ): Promise<boolean> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      `UPDATE attribute_verifications
          SET invalidated_at = ?, invalidation_reason = ?, status_valid = 0, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND invalidated_at IS NULL`,
      [now, reason.slice(0, 200), now, tenantId, verificationId]
    );
    return result.rowsAffected > 0;
  }

  async invalidateStaleForUser(tenantId: string, userId: string, now: number): Promise<number> {
    const result = await this.adapter.execute(
      `UPDATE attribute_verifications
          SET invalidated_at = ?, invalidation_reason = 'evidence_stale',
              status_valid = 0, updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND invalidated_at IS NULL
          AND (verification_result <> 'verified' OR holder_binding_verified <> 1
            OR issuer_trusted <> 1 OR status_valid <> 1
            OR (expires_at IS NOT NULL AND expires_at <= ?)
            OR (revalidate_after IS NOT NULL AND revalidate_after <= ?)
            OR (status_fresh_until IS NOT NULL AND status_fresh_until <= ?))`,
      [now, now, tenantId, userId, now, now, now]
    );
    return result.rowsAffected;
  }

  async invalidateUntrustedForUser(tenantId: string, userId: string, now: number): Promise<number> {
    const result = await this.adapter.execute(
      `UPDATE attribute_verifications
          SET invalidated_at = ?, invalidation_reason = 'issuer_trust_changed',
              issuer_trusted = 0, updated_at = ?
        WHERE tenant_id = ? AND user_id = ? AND invalidated_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM trusted_issuers ti
             WHERE ti.tenant_id = attribute_verifications.tenant_id
               AND ti.issuer_did = attribute_verifications.issuer_did
               AND ti.status = 'active'
          )`,
      [now, now, tenantId, userId]
    );
    return result.rowsAffected;
  }

  /**
   * Find verifications by user
   */
  async findByUser(
    tenantId: string,
    userId: string,
    options?: PaginationOptions
  ): Promise<PaginationResult<AttributeVerification>> {
    return this.findAll(
      [
        { field: 'tenant_id', operator: 'eq', value: tenantId },
        { field: 'user_id', operator: 'eq', value: userId },
      ],
      options
    );
  }

  /**
   * Find verification by VP request ID
   */
  async findByVPRequestId(
    tenantId: string,
    vpRequestId: string
  ): Promise<AttributeVerification | null> {
    return this.adapter.queryOne<AttributeVerification>(
      'SELECT * FROM attribute_verifications WHERE tenant_id = ? AND vp_request_id = ?',
      [tenantId, vpRequestId]
    );
  }

  /**
   * Link verification to a user (called after user login association)
   */
  async linkToUser(tenantId: string, verificationId: string, userId: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE attribute_verifications SET user_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
      [userId, getCurrentTimestamp(), tenantId, verificationId]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Update mapped attribute IDs
   */
  async updateMappedAttributeIds(
    tenantId: string,
    verificationId: string,
    attributeIds: string[]
  ): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE attribute_verifications SET mapped_attribute_ids = ?, updated_at = ? WHERE tenant_id = ? AND id = ?',
      [JSON.stringify(attributeIds), getCurrentTimestamp(), tenantId, verificationId]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Search verifications with filters
   */
  async searchVerifications(
    filters: AttributeVerificationFilterOptions,
    options?: PaginationOptions
  ): Promise<PaginationResult<AttributeVerification>> {
    const conditions: FilterCondition[] = [];

    if (filters.tenant_id) {
      conditions.push({ field: 'tenant_id', operator: 'eq', value: filters.tenant_id });
    }
    if (filters.user_id) {
      conditions.push({ field: 'user_id', operator: 'eq', value: filters.user_id });
    }
    if (filters.vp_request_id) {
      conditions.push({ field: 'vp_request_id', operator: 'eq', value: filters.vp_request_id });
    }
    if (filters.verification_result) {
      conditions.push({
        field: 'verification_result',
        operator: 'eq',
        value: filters.verification_result,
      });
    }
    if (filters.issuer_did) {
      conditions.push({ field: 'issuer_did', operator: 'eq', value: filters.issuer_did });
    }

    return this.findAll(conditions, options);
  }

  /**
   * Get verification statistics for a tenant
   */
  async getStats(tenantId: string): Promise<{
    total: number;
    verified: number;
    failed: number;
    expired: number;
  }> {
    const results = await this.adapter.query<{ verification_result: string; count: number }>(
      `SELECT verification_result, COUNT(*) as count
       FROM attribute_verifications
       WHERE tenant_id = ?
       GROUP BY verification_result`,
      [tenantId]
    );

    const stats = { total: 0, verified: 0, failed: 0, expired: 0 };
    for (const row of results) {
      const count = row.count;
      stats.total += count;
      if (row.verification_result === 'verified') stats.verified = count;
      else if (row.verification_result === 'failed') stats.failed = count;
      else if (row.verification_result === 'expired') stats.expired = count;
    }
    return stats;
  }

  /**
   * Delete all verifications for a user (account deletion)
   */
  async deleteAllForUser(tenantId: string, userId: string): Promise<number> {
    const result = await this.adapter.execute(
      'DELETE FROM attribute_verifications WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );
    return result.rowsAffected;
  }

  /**
   * Parse mapped attribute IDs JSON
   */
  parseMappedAttributeIds(verification: AttributeVerification): string[] {
    if (!verification.mapped_attribute_ids) {
      return [];
    }
    try {
      return JSON.parse(verification.mapped_attribute_ids) as string[];
    } catch {
      return [];
    }
  }
}

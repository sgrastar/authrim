/**
 * User Anonymization Service
 *
 * Provides anonymized user ID management for audit logging.
 * Uses random UUID + mapping table (NOT HMAC) for true anonymization.
 *
 * Key design decisions:
 * - Random UUID: When mapping is deleted, event logs become truly anonymous
 * - HMAC (used in Logger.userIdHash only): Can be reversed with the key, so it's "pseudonymization"
 * - Conflict handling: SELECT → INSERT → unique-race retry → re-SELECT pattern
 */

import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../../db';
import type { UserAnonymizationMap } from './types';

function isUniqueConstraintError(error: unknown): boolean {
  return String(error).includes('UNIQUE constraint');
}

/**
 * Anonymization service interface.
 */
export interface IAnonymizationService {
  /**
   * Get or create anonymized user ID for the given real user ID.
   * Uses conflict-safe upsert pattern.
   *
   * @param tenantId - Tenant identifier
   * @param userId - Real user ID
   * @returns Anonymized user ID (random UUID)
   */
  getAnonymizedUserId(tenantId: string, userId: string): Promise<string>;

  /**
   * Delete anonymization mapping for a user (GDPR "right to be forgotten").
   * After deletion, event logs become truly anonymous.
   *
   * @param tenantId - Tenant identifier
   * @param userId - Real user ID
   * @returns True if mapping was deleted, false if not found
   */
  deleteMapping(tenantId: string, userId: string): Promise<boolean>;

  /**
   * Get real user ID from anonymized ID (admin use only).
   * Returns null if mapping doesn't exist (user was deleted).
   *
   * @param tenantId - Tenant identifier
   * @param anonymizedUserId - Anonymized user ID
   * @returns Real user ID or null if not found
   */
  getRealUserId(tenantId: string, anonymizedUserId: string): Promise<string | null>;
}

/**
 * Adapter-backed anonymization service.
 */
export class AnonymizationService implements IAnonymizationService {
  private readonly piiAdapter: DatabaseAdapter;

  constructor(piiDb: DatabaseSource) {
    this.piiAdapter = ensureDatabaseAdapter(piiDb, 'audit-pii-anonymization');
  }

  /**
   * Get or create anonymized user ID.
   *
   * Uses conflict-safe pattern:
   * 1. SELECT existing mapping
   * 2. If not found, INSERT
   * 3. If a concurrent request wins first, treat UNIQUE as expected race
   * 3. Re-SELECT to get the actual value (handles race conditions)
   */
  async getAnonymizedUserId(tenantId: string, userId: string): Promise<string> {
    // Step 1: Check for existing mapping
    const existing = await this.piiAdapter.queryOne<{ anonymized_user_id: string }>(
      'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    if (existing) {
      return existing.anonymized_user_id;
    }

    // Step 2: Generate new anonymized ID and try to insert
    const anonymizedId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const createdAt = Date.now();

    try {
      await this.piiAdapter.execute(
        `INSERT INTO user_anonymization_map (id, tenant_id, user_id, anonymized_user_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, tenantId, userId, anonymizedId, createdAt]
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    // Step 3: Re-SELECT to get the actual value (handles race conditions)
    const inserted = await this.piiAdapter.queryOne<{ anonymized_user_id: string }>(
      'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    if (!inserted) {
      throw new Error(
        `Failed to get or create anonymized user ID for tenant=${tenantId}, user=${userId.substring(0, 8)}...`
      );
    }

    return inserted.anonymized_user_id;
  }

  /**
   * Delete anonymization mapping (GDPR "right to be forgotten").
   */
  async deleteMapping(tenantId: string, userId: string): Promise<boolean> {
    const result = await this.piiAdapter.execute(
      'DELETE FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    return result.rowsAffected > 0;
  }

  /**
   * Get real user ID from anonymized ID (admin use only).
   */
  async getRealUserId(tenantId: string, anonymizedUserId: string): Promise<string | null> {
    const mapping = await this.piiAdapter.queryOne<{ user_id: string }>(
      'SELECT user_id FROM user_anonymization_map WHERE tenant_id = ? AND anonymized_user_id = ?',
      [tenantId, anonymizedUserId]
    );

    return mapping?.user_id ?? null;
  }
}

/**
 * Create an anonymization service instance.
 *
 * @param piiDb - Database source for the PII audit plane
 * @returns Anonymization service
 */
export function createAnonymizationService(piiDb: DatabaseSource): IAnonymizationService {
  return new AnonymizationService(piiDb);
}

// =============================================================================
// Batch Operations (for migration and admin tools)
// =============================================================================

/**
 * Batch get anonymized user IDs.
 * Efficient for bulk operations.
 *
 * @param piiDb - Database source for the PII audit plane
 * @param tenantId - Tenant identifier
 * @param userIds - List of real user IDs
 * @returns Map of userId -> anonymizedUserId
 */
export async function batchGetAnonymizedUserIds(
  piiDb: DatabaseSource,
  tenantId: string,
  userIds: string[]
): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const service = new AnonymizationService(piiDb);
  const result = new Map<string, string>();

  // Process in parallel with concurrency limit
  const BATCH_SIZE = 50;
  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (userId) => {
      const anonymizedId = await service.getAnonymizedUserId(tenantId, userId);
      result.set(userId, anonymizedId);
    });
    await Promise.all(promises);
  }

  return result;
}

/**
 * List all anonymization mappings for a tenant (admin use only).
 *
 * @param piiDb - Database source for the PII audit plane
 * @param tenantId - Tenant identifier
 * @param limit - Max number of results (default: 100)
 * @param offset - Offset for pagination (default: 0)
 * @returns List of anonymization mappings
 */
export async function listAnonymizationMappings(
  piiDb: DatabaseSource,
  tenantId: string,
  limit: number = 100,
  offset: number = 0
): Promise<UserAnonymizationMap[]> {
  const adapter = ensureDatabaseAdapter(piiDb, 'audit-pii-anonymization');
  const results = await adapter.query<{
    id: string;
    tenant_id: string;
    user_id: string;
    anonymized_user_id: string;
    created_at: number;
  }>(
    `SELECT id, tenant_id, user_id, anonymized_user_id, created_at
     FROM user_anonymization_map
     WHERE tenant_id = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [tenantId, limit, offset]
  );

  return results.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    anonymizedUserId: row.anonymized_user_id,
    createdAt: row.created_at,
  }));
}

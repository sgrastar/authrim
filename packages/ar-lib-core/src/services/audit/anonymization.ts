/**
 * User Anonymization Service
 *
 * Provides anonymized user ID management for audit logging.
 * Uses random UUID + mapping table (NOT HMAC) for true anonymization.
 *
 * Key design decisions:
 * - Random UUID: When mapping is deleted, event logs become truly anonymous
 * - HMAC (used in Logger.userIdHash only): Can be reversed with the key, so it's "pseudonymization"
 * - Conflict handling: SELECT → INSERT ON CONFLICT → re-SELECT pattern
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { UserAnonymizationMap } from './types';

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
 * D1-backed anonymization service.
 */
export class AnonymizationService implements IAnonymizationService {
  constructor(private readonly piiDb: D1Database) {}

  /**
   * Get or create anonymized user ID.
   *
   * Uses conflict-safe pattern:
   * 1. SELECT existing mapping
   * 2. If not found, INSERT with ON CONFLICT DO NOTHING
   * 3. Re-SELECT to get the actual value (handles race conditions)
   */
  async getAnonymizedUserId(tenantId: string, userId: string): Promise<string> {
    // Step 1: Check for existing mapping
    const existing = await this.piiDb
      .prepare(
        'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?'
      )
      .bind(tenantId, userId)
      .first<{ anonymized_user_id: string }>();

    if (existing) {
      return existing.anonymized_user_id;
    }

    // Step 2: Generate new anonymized ID and try to insert
    const anonymizedId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const createdAt = Date.now();

    try {
      await this.piiDb
        .prepare(
          `INSERT INTO user_anonymization_map (id, tenant_id, user_id, anonymized_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, user_id) DO NOTHING`
        )
        .bind(id, tenantId, userId, anonymizedId, createdAt)
        .run();
    } catch (error) {
      // Handle D1 versions that may not support ON CONFLICT
      const errorMessage = String(error);
      if (!errorMessage.includes('UNIQUE constraint')) {
        throw error;
      }
      // UNIQUE constraint means another request won the race - that's fine
    }

    // Step 3: Re-SELECT to get the actual value (handles race conditions)
    const inserted = await this.piiDb
      .prepare(
        'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?'
      )
      .bind(tenantId, userId)
      .first<{ anonymized_user_id: string }>();

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
    const result = await this.piiDb
      .prepare('DELETE FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?')
      .bind(tenantId, userId)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Get real user ID from anonymized ID (admin use only).
   */
  async getRealUserId(tenantId: string, anonymizedUserId: string): Promise<string | null> {
    const mapping = await this.piiDb
      .prepare(
        'SELECT user_id FROM user_anonymization_map WHERE tenant_id = ? AND anonymized_user_id = ?'
      )
      .bind(tenantId, anonymizedUserId)
      .first<{ user_id: string }>();

    return mapping?.user_id ?? null;
  }
}

/**
 * Create an anonymization service instance.
 *
 * @param piiDb - D1 database instance (PII database)
 * @returns Anonymization service
 */
export function createAnonymizationService(piiDb: D1Database): IAnonymizationService {
  return new AnonymizationService(piiDb);
}

// =============================================================================
// Batch Operations (for migration and admin tools)
// =============================================================================

/**
 * Batch get anonymized user IDs.
 * Efficient for bulk operations.
 *
 * @param piiDb - D1 database instance
 * @param tenantId - Tenant identifier
 * @param userIds - List of real user IDs
 * @returns Map of userId -> anonymizedUserId
 */
export async function batchGetAnonymizedUserIds(
  piiDb: D1Database,
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
 * @param piiDb - D1 database instance
 * @param tenantId - Tenant identifier
 * @param limit - Max number of results (default: 100)
 * @param offset - Offset for pagination (default: 0)
 * @returns List of anonymization mappings
 */
export async function listAnonymizationMappings(
  piiDb: D1Database,
  tenantId: string,
  limit: number = 100,
  offset: number = 0
): Promise<UserAnonymizationMap[]> {
  const results = await piiDb
    .prepare(
      `SELECT id, tenant_id, user_id, anonymized_user_id, created_at
       FROM user_anonymization_map
       WHERE tenant_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(tenantId, limit, offset)
    .all<{
      id: string;
      tenant_id: string;
      user_id: string;
      anonymized_user_id: string;
      created_at: number;
    }>();

  return (results.results ?? []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    anonymizedUserId: row.anonymized_user_id,
    createdAt: row.created_at,
  }));
}

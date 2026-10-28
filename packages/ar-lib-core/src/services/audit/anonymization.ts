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
import { forgetCachedAnonymizedUserId } from './anonymized-user-id-cache';

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

export interface PendingPIILogPurge {
  id: string;
  tenant_id: string;
  user_id: string;
  old_anonymized_user_id: string;
  new_anonymized_user_id: string | null;
  created_at: number;
}

/**
 * Adapter-backed anonymization service.
 */
export class AnonymizationService implements IAnonymizationService {
  private readonly piiAdapter: DatabaseAdapter;

  constructor(piiDb: DatabaseSource) {
    this.piiAdapter = ensureDatabaseAdapter(piiDb, 'audit-pii-anonymization');
  }

  async findAnonymizedUserId(tenantId: string, userId: string): Promise<string | null> {
    const found = await this.piiAdapter.queryOne<{ anonymized_user_id: string }>(
      'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );
    return found?.anonymized_user_id ?? null;
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
   * Get or create the anonymized user ID, but never create one for a user the store records as
   * deleted or anonymized (a `users_pii_tombstone` row, written before the account's PII is
   * erased). An existing mapping is returned as is; null when there is none and the user is gone.
   * The tombstone check and the insert are one statement, so a late caller (an audit written
   * after the response) cannot put the real user ID back into the store after the erasure.
   */
  async getAnonymizedUserIdUnlessErased(tenantId: string, userId: string): Promise<string | null> {
    const select = () =>
      this.piiAdapter.queryOne<{ anonymized_user_id: string }>(
        'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
        [tenantId, userId]
      );
    const existing = await select();
    if (existing) {
      return existing.anonymized_user_id;
    }

    try {
      await this.piiAdapter.execute(
        `INSERT INTO user_anonymization_map (id, tenant_id, user_id, anonymized_user_id, created_at)
         SELECT ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM users_pii_tombstone WHERE tenant_id = ? AND id = ?
          )`,
        [crypto.randomUUID(), tenantId, userId, crypto.randomUUID(), Date.now(), tenantId, userId]
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    return (await select())?.anonymized_user_id ?? null;
  }

  /** Rotate the live mapping and retain the old subject in a restartable business operation. */
  async preparePIILogPurge(tenantId: string, userId: string): Promise<PendingPIILogPurge> {
    const load = () =>
      this.piiAdapter.queryOne<PendingPIILogPurge>(
        'SELECT * FROM pii_log_purge_operations WHERE tenant_id = ? AND user_id = ?',
        [tenantId, userId]
      );
    const existing = await load();
    if (existing) return existing;
    const id = crypto.randomUUID(),
      next = crypto.randomUUID(),
      now = Date.now();
    try {
      await this.piiAdapter.batch([
        {
          sql: `INSERT INTO pii_log_purge_operations
            (id, tenant_id, user_id, old_anonymized_user_id, new_anonymized_user_id, created_at)
          SELECT ?, m.tenant_id, m.user_id, m.anonymized_user_id,
            CASE WHEN EXISTS (SELECT 1 FROM users_pii_tombstone t WHERE t.tenant_id = m.tenant_id AND t.id = m.user_id)
              THEN NULL ELSE ? END, ?
          FROM user_anonymization_map m WHERE m.tenant_id = ? AND m.user_id = ?
            AND NOT EXISTS (SELECT 1 FROM pii_log_purge_operations p WHERE p.tenant_id = m.tenant_id AND p.user_id = m.user_id)`,
          params: [id, next, now, tenantId, userId],
        },
        {
          sql: `UPDATE user_anonymization_map SET anonymized_user_id = ?, created_at = ?
          WHERE tenant_id = ? AND user_id = ?
            AND NOT EXISTS (SELECT 1 FROM users_pii_tombstone t WHERE t.tenant_id = ? AND t.id = ?)
            AND EXISTS (SELECT 1 FROM pii_log_purge_operations p WHERE p.id = ?
              AND p.tenant_id = ? AND p.user_id = ? AND p.new_anonymized_user_id = ?
              AND p.old_anonymized_user_id = user_anonymization_map.anonymized_user_id)`,
          params: [next, now, tenantId, userId, tenantId, userId, id, tenantId, userId, next],
        },
      ]);
    } catch (error) {
      if (
        !isUniqueConstraintError(error) &&
        !(error instanceof Error && /duplicate key/iu.test(error.message))
      )
        throw error;
    }
    const operation = await load();
    if (!operation) throw new Error('pii_purge_subject_mapping_missing');
    forgetCachedAnonymizedUserId(tenantId, userId);
    return operation;
  }

  /** Read only the already-authorized intent. Missing is a skip, never a new rotation. */
  async loadPendingPIILogPurge(
    tenantId: string,
    userId: string,
    expectedOperationId: string
  ): Promise<PendingPIILogPurge | null> {
    return this.piiAdapter.queryOne<PendingPIILogPurge>(
      'SELECT * FROM pii_log_purge_operations WHERE tenant_id=? AND user_id=? AND id=?',
      [tenantId, userId, expectedOperationId],
      { consistencyClass: 'primary_required' }
    );
  }

  /** Completion removes the temporary real-user link, preserving the replacement live mapping. */
  async completePIILogPurge(tenantId: string, userId: string, operationId: string): Promise<void> {
    await this.piiAdapter.execute(
      'DELETE FROM pii_log_purge_operations WHERE tenant_id = ? AND user_id = ? AND id = ?',
      [tenantId, userId, operationId]
    );
    forgetCachedAnonymizedUserId(tenantId, userId);
  }

  /**
   * Delete anonymization mapping (GDPR "right to be forgotten").
   */
  async deleteMapping(tenantId: string, userId: string): Promise<boolean> {
    const result = await this.piiAdapter.execute(
      'DELETE FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );
    forgetCachedAnonymizedUserId(tenantId, userId);

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
 * The statement that deletes a user's mapping, for an erasure that runs its statements as one
 * batch. After the batch commits, call forgetCachedAnonymizedUserId for this isolate's cache.
 * Write the user's users_pii_tombstone first: getAnonymizedUserIdUnlessErased then never
 * creates the mapping again, so the user's events stay unlinked from the user.
 */
export function deleteAnonymizationMappingStatement(
  tenantId: string,
  userId: string
): { sql: string; params: unknown[] } {
  return {
    sql: 'DELETE FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
    params: [tenantId, userId],
  };
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

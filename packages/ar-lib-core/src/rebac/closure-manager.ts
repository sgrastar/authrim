/**
 * Closure Manager Implementation
 *
 * Manages the relationship_closure table for efficient listObjects/listUsers queries.
 *
 * The closure holds the direct subject tuples only (depth 1): the relationship check follows no
 * path that no relation definition declares, and the declared ones (`tuple_to_userset`) are not
 * expanded here, so a longer path in the closure would list what the check denies. Group usersets
 * are not expanded either (memberships are read from group_memberships at check time).
 *
 * When to use:
 * - listObjects(user, relation, objectType): "Which documents can user X view?"
 * - listUsers(object, relation): "Who can edit document Y?"
 *
 * When NOT to use:
 * - check(): evaluates tuples, usersets and definitions instead (rebac-service.ts)
 *
 * Update strategy:
 * - On relationship create: Add closure entries for new paths
 * - On relationship delete: Remove affected closure entries and recompute
 * - Batch recompute: For bulk updates or initial population
 */

import type { IClosureManager } from './interfaces';
import type { ClosureEntry, ClosureEntryRow } from './types';
import type { IStorageAdapter } from '../storage/interfaces';
import { DEFAULT_MAX_DEPTH, DEFAULT_CLOSURE_BATCH_SIZE } from './types';

/**
 * Convert D1 row to ClosureEntry
 */
function rowToClosureEntry(row: ClosureEntryRow): ClosureEntry {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    ancestor_type: row.ancestor_type,
    ancestor_id: row.ancestor_id,
    descendant_type: row.descendant_type,
    descendant_id: row.descendant_id,
    relation: row.relation,
    depth: row.depth,
    path: row.path_json ? JSON.parse(row.path_json) : undefined,
    effective_permission: row.effective_permission ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * ClosureManager - Manages pre-computed transitive relationships
 */
export class ClosureManager implements IClosureManager {
  private adapter: IStorageAdapter;
  private maxDepth: number;
  private batchSize: number;

  constructor(
    adapter: IStorageAdapter,
    maxDepth: number = DEFAULT_MAX_DEPTH,
    batchSize: number = DEFAULT_CLOSURE_BATCH_SIZE
  ) {
    this.adapter = adapter;
    this.maxDepth = maxDepth;
    this.batchSize = batchSize;
  }

  /**
   * Get all objects a user has access to: closure rows with a live, unexpired direct tuple behind
   * them (a row left from before a recompute, or an expired tuple, lists nothing)
   */
  async getObjectsForUser(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{ objectIds: string[]; nextCursor?: string }> {
    const limit = options?.limit ?? 100;
    const offset = options?.cursor ? parseInt(options.cursor, 10) : 0;

    const results = await this.adapter.query<{ descendant_id: string }>(
      `SELECT DISTINCT descendant_id
       FROM relationship_closure
       WHERE tenant_id = ?
         AND ancestor_type = 'subject'
         AND ancestor_id = ?
         AND descendant_type = ?
         AND relation = ?
         AND EXISTS (
           SELECT 1 FROM relationships r
            WHERE r.tenant_id = relationship_closure.tenant_id
              AND r.from_type = 'subject'
              AND r.from_id = relationship_closure.ancestor_id
              AND r.to_type = relationship_closure.descendant_type
              AND r.to_id = relationship_closure.descendant_id
              AND r.relationship_type = relationship_closure.relation
              AND (r.expires_at IS NULL OR r.expires_at > ?)
         )
       ORDER BY descendant_id
       LIMIT ? OFFSET ?`,
      [tenantId, userId, objectType, relation, Math.floor(Date.now() / 1000), limit + 1, offset]
    );

    const objectIds = results.slice(0, limit).map((r) => r.descendant_id);
    const hasMore = results.length > limit;

    return {
      objectIds,
      nextCursor: hasMore ? String(offset + limit) : undefined,
    };
  }

  /**
   * Get all users who have access to an object
   */
  async getUsersForObject(
    tenantId: string,
    objectType: string,
    objectId: string,
    relation: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{ userIds: string[]; nextCursor?: string }> {
    const limit = options?.limit ?? 100;
    const offset = options?.cursor ? parseInt(options.cursor, 10) : 0;

    const results = await this.adapter.query<{ ancestor_id: string }>(
      `SELECT DISTINCT ancestor_id
       FROM relationship_closure
       WHERE tenant_id = ?
         AND ancestor_type = 'subject'
         AND descendant_type = ?
         AND descendant_id = ?
         AND relation = ?
         AND EXISTS (
           SELECT 1 FROM relationships r
            WHERE r.tenant_id = relationship_closure.tenant_id
              AND r.from_type = 'subject'
              AND r.from_id = relationship_closure.ancestor_id
              AND r.to_type = relationship_closure.descendant_type
              AND r.to_id = relationship_closure.descendant_id
              AND r.relationship_type = relationship_closure.relation
              AND (r.expires_at IS NULL OR r.expires_at > ?)
         )
       ORDER BY ancestor_id
       LIMIT ? OFFSET ?`,
      [tenantId, objectType, objectId, relation, Math.floor(Date.now() / 1000), limit + 1, offset]
    );

    const userIds = results.slice(0, limit).map((r) => r.ancestor_id);
    const hasMore = results.length > limit;

    return {
      userIds,
      nextCursor: hasMore ? String(offset + limit) : undefined,
    };
  }

  /**
   * Recompute closure entries for a specific object
   */
  async recomputeForObject(tenantId: string, objectType: string, objectId: string): Promise<void> {
    // Delete existing closure entries for this object
    await this.deleteForObject(tenantId, objectType, objectId);

    // Recompute closure using recursive CTE
    await this.computeAndStoreClosureForObject(tenantId, objectType, objectId);
  }

  /**
   * Recompute closure entries for a specific user
   */
  async recomputeForUser(tenantId: string, userId: string): Promise<void> {
    // Delete existing closure entries for this user
    await this.deleteForUser(tenantId, userId);

    // Recompute closure using recursive CTE
    await this.computeAndStoreClosureForUser(tenantId, userId);
  }

  /**
   * Batch recompute closure entries
   */
  async batchRecompute(
    tenantId: string,
    entries: Array<{ type: 'user' | 'object'; entityType: string; entityId: string }>
  ): Promise<void> {
    // Process in batches
    for (let i = 0; i < entries.length; i += this.batchSize) {
      const batch = entries.slice(i, i + this.batchSize);

      await Promise.all(
        batch.map(async (entry) => {
          if (entry.type === 'user') {
            await this.recomputeForUser(tenantId, entry.entityId);
          } else {
            await this.recomputeForObject(tenantId, entry.entityType, entry.entityId);
          }
        })
      );
    }
  }

  /**
   * Delete closure entries for an object
   */
  async deleteForObject(tenantId: string, objectType: string, objectId: string): Promise<void> {
    await this.adapter.execute(
      `DELETE FROM relationship_closure
       WHERE tenant_id = ?
         AND descendant_type = ?
         AND descendant_id = ?`,
      [tenantId, objectType, objectId]
    );
  }

  /**
   * Delete closure entries for a user
   */
  async deleteForUser(tenantId: string, userId: string): Promise<void> {
    await this.adapter.execute(
      `DELETE FROM relationship_closure
       WHERE tenant_id = ?
         AND ancestor_type = 'subject'
         AND ancestor_id = ?`,
      [tenantId, userId]
    );
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Compute and store closure entries for an object
   */
  private async computeAndStoreClosureForObject(
    tenantId: string,
    objectType: string,
    objectId: string
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // The direct subject tuples to this object (see the module comment)
    const results = await this.adapter.query<{
      user_id: string;
      relation: string;
      depth: number;
      path: string;
      permission: string | null;
    }>(
      `SELECT
        r.from_id as user_id,
        r.relationship_type as relation,
        1 as depth,
        MIN(r.id) as path,
        MIN(r.permission_level) as permission
      FROM relationships r
      WHERE r.tenant_id = ?
        AND r.from_type = 'subject'
        AND r.to_type = ?
        AND r.to_id = ?
        AND (r.expires_at IS NULL OR r.expires_at > ?)
      GROUP BY r.from_id, r.relationship_type`,
      [tenantId, objectType, objectId, now]
    );

    // Insert closure entries
    for (const result of results) {
      const id = `closure_${crypto.randomUUID().replace(/-/g, '')}`;

      await this.adapter.execute(
        `INSERT INTO relationship_closure (
          id, tenant_id, ancestor_type, ancestor_id,
          descendant_type, descendant_id, relation,
          depth, path_json, effective_permission,
          created_at, updated_at
        ) VALUES (?, ?, 'subject', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          result.user_id,
          objectType,
          objectId,
          result.relation,
          result.depth,
          JSON.stringify(result.path.split(',')),
          result.permission,
          now,
          now,
        ]
      );
    }
  }

  /**
   * Compute and store closure entries for a user
   */
  private async computeAndStoreClosureForUser(tenantId: string, userId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // The user's direct tuples (see the module comment)
    const results = await this.adapter.query<{
      object_type: string;
      object_id: string;
      relation: string;
      depth: number;
      path: string;
      permission: string | null;
    }>(
      `SELECT
        r.to_type as object_type,
        r.to_id as object_id,
        r.relationship_type as relation,
        1 as depth,
        MIN(r.id) as path,
        MIN(r.permission_level) as permission
      FROM relationships r
      WHERE r.tenant_id = ?
        AND r.from_type = 'subject'
        AND r.from_id = ?
        AND (r.expires_at IS NULL OR r.expires_at > ?)
      GROUP BY r.to_type, r.to_id, r.relationship_type`,
      [tenantId, userId, now]
    );

    // Insert closure entries
    for (const result of results) {
      const id = `closure_${crypto.randomUUID().replace(/-/g, '')}`;

      await this.adapter.execute(
        `INSERT INTO relationship_closure (
          id, tenant_id, ancestor_type, ancestor_id,
          descendant_type, descendant_id, relation,
          depth, path_json, effective_permission,
          created_at, updated_at
        ) VALUES (?, ?, 'subject', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          userId,
          result.object_type,
          result.object_id,
          result.relation,
          result.depth,
          JSON.stringify(result.path.split(',')),
          result.permission,
          now,
          now,
        ]
      );
    }
  }

  /**
   * Add a single closure entry (called when a relationship is created)
   */
  async addClosureEntry(
    entry: Omit<ClosureEntry, 'id' | 'created_at' | 'updated_at'>
  ): Promise<void> {
    const id = `closure_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Math.floor(Date.now() / 1000);

    await this.adapter.execute(
      `INSERT INTO relationship_closure (
        id, tenant_id, ancestor_type, ancestor_id,
        descendant_type, descendant_id, relation,
        depth, path_json, effective_permission,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.tenant_id,
        entry.ancestor_type,
        entry.ancestor_id,
        entry.descendant_type,
        entry.descendant_id,
        entry.relation,
        entry.depth,
        entry.path ? JSON.stringify(entry.path) : null,
        entry.effective_permission ?? null,
        now,
        now,
      ]
    );
  }

  /**
   * Get closure entries (for debugging/inspection)
   */
  async getClosureEntries(
    tenantId: string,
    options?: {
      ancestorType?: string;
      ancestorId?: string;
      descendantType?: string;
      descendantId?: string;
      relation?: string;
      limit?: number;
    }
  ): Promise<ClosureEntry[]> {
    let sql = 'SELECT * FROM relationship_closure WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (options?.ancestorType) {
      sql += ' AND ancestor_type = ?';
      params.push(options.ancestorType);
    }
    if (options?.ancestorId) {
      sql += ' AND ancestor_id = ?';
      params.push(options.ancestorId);
    }
    if (options?.descendantType) {
      sql += ' AND descendant_type = ?';
      params.push(options.descendantType);
    }
    if (options?.descendantId) {
      sql += ' AND descendant_id = ?';
      params.push(options.descendantId);
    }
    if (options?.relation) {
      sql += ' AND relation = ?';
      params.push(options.relation);
    }

    sql += ' ORDER BY depth ASC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = await this.adapter.query<ClosureEntryRow>(sql, params);
    return rows.map(rowToClosureEntry);
  }
}

/**
 * Create a ClosureManager instance
 */
export function createClosureManager(
  adapter: IStorageAdapter,
  maxDepth?: number,
  batchSize?: number
): ClosureManager {
  return new ClosureManager(adapter, maxDepth, batchSize);
}

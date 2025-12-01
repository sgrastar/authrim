/**
 * Closure Manager Implementation
 *
 * Manages the relationship_closure table for efficient listObjects/listUsers queries.
 * The closure table stores pre-computed transitive relationships.
 *
 * When to use:
 * - listObjects(user, relation, objectType): "Which documents can user X view?"
 * - listUsers(object, relation): "Who can edit document Y?"
 *
 * When NOT to use:
 * - check(): Uses recursive CTE + KV cache instead (more flexible)
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
   * Get all objects a user has access to
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
       ORDER BY descendant_id
       LIMIT ? OFFSET ?`,
      [tenantId, userId, objectType, relation, limit + 1, offset]
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
       ORDER BY ancestor_id
       LIMIT ? OFFSET ?`,
      [tenantId, objectType, objectId, relation, limit + 1, offset]
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

    // Find all users who can reach this object through relationships
    // Using a recursive CTE to traverse the relationship graph backwards
    const results = await this.adapter.query<{
      user_id: string;
      relation: string;
      depth: number;
      path: string;
      permission: string | null;
    }>(
      `WITH RECURSIVE reachable AS (
        -- Base case: Direct relationships to this object
        SELECT
          r.from_type as source_type,
          r.from_id as source_id,
          r.relationship_type as relation,
          r.permission_level as permission,
          1 as depth,
          r.id as path
        FROM relationships r
        WHERE r.tenant_id = ?
          AND r.to_type = ?
          AND r.to_id = ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)

        UNION ALL

        -- Recursive case: Follow relationships backwards
        SELECT
          r.from_type as source_type,
          r.from_id as source_id,
          rch.relation as relation,
          CASE
            WHEN r.permission_level = 'read_only' OR rch.permission = 'read_only' THEN 'read_only'
            WHEN r.permission_level = 'limited' OR rch.permission = 'limited' THEN 'limited'
            ELSE 'full'
          END as permission,
          rch.depth + 1 as depth,
          rch.path || ',' || r.id as path
        FROM relationships r
        INNER JOIN reachable rch
          ON r.to_type = rch.source_type
          AND r.to_id = rch.source_id
        WHERE r.tenant_id = ?
          AND rch.depth < ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)
      )
      SELECT DISTINCT
        source_id as user_id,
        relation,
        MIN(depth) as depth,
        path,
        permission
      FROM reachable
      WHERE source_type = 'subject'
      GROUP BY source_id, relation`,
      [
        tenantId,
        objectType,
        objectId,
        now, // Base case
        tenantId,
        this.maxDepth,
        now, // Recursive case
      ]
    );

    // Insert closure entries
    for (const result of results) {
      const id = `closure_${crypto.randomUUID().replace(/-/g, '')}`;

      await this.adapter.execute(
        `INSERT OR REPLACE INTO relationship_closure (
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

    // Find all objects this user can reach through relationships
    // Using a recursive CTE to traverse the relationship graph forward
    const results = await this.adapter.query<{
      object_type: string;
      object_id: string;
      relation: string;
      depth: number;
      path: string;
      permission: string | null;
    }>(
      `WITH RECURSIVE reachable AS (
        -- Base case: Direct relationships from this user
        SELECT
          r.to_type as target_type,
          r.to_id as target_id,
          r.relationship_type as relation,
          r.permission_level as permission,
          1 as depth,
          r.id as path
        FROM relationships r
        WHERE r.tenant_id = ?
          AND r.from_type = 'subject'
          AND r.from_id = ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)

        UNION ALL

        -- Recursive case: Follow relationships forward
        SELECT
          r.to_type as target_type,
          r.to_id as target_id,
          rch.relation as relation,
          CASE
            WHEN r.permission_level = 'read_only' OR rch.permission = 'read_only' THEN 'read_only'
            WHEN r.permission_level = 'limited' OR rch.permission = 'limited' THEN 'limited'
            ELSE 'full'
          END as permission,
          rch.depth + 1 as depth,
          rch.path || ',' || r.id as path
        FROM relationships r
        INNER JOIN reachable rch
          ON r.from_type = rch.target_type
          AND r.from_id = rch.target_id
        WHERE r.tenant_id = ?
          AND rch.depth < ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)
      )
      SELECT DISTINCT
        target_type as object_type,
        target_id as object_id,
        relation,
        MIN(depth) as depth,
        path,
        permission
      FROM reachable
      GROUP BY target_type, target_id, relation`,
      [
        tenantId,
        userId,
        now, // Base case
        tenantId,
        this.maxDepth,
        now, // Recursive case
      ]
    );

    // Insert closure entries
    for (const result of results) {
      const id = `closure_${crypto.randomUUID().replace(/-/g, '')}`;

      await this.adapter.execute(
        `INSERT OR REPLACE INTO relationship_closure (
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

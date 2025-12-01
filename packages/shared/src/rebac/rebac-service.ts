/**
 * ReBAC Service Implementation
 *
 * Main service for Relationship-Based Access Control.
 * Implements Zanzibar-lite check() API with:
 * - Recursive CTE for transitive relationship resolution
 * - KV caching with configurable TTL
 * - Request-scoped deduplication
 * - Relation DSL evaluation (union, tuple-to-userset)
 *
 * Phase 3 constraints:
 * - Allow only (no Deny effect)
 * - MVP DSL (union, tuple-to-userset only)
 * - No RelationGraphDO (uses recursive CTE instead)
 */

import type {
  IReBACService,
  IReBACCacheManager,
  IRelationDefinitionStore,
  IClosureManager,
  IRelationParser,
} from './interfaces';
import type {
  CheckRequest,
  CheckResponse,
  BatchCheckRequest,
  BatchCheckResponse,
  ListObjectsRequest,
  ListObjectsResponse,
  ListUsersRequest,
  ListUsersResponse,
  ReBACConfig,
  RelationDefinition,
} from './types';
import type { IStorageAdapter } from '../storage/interfaces';
import { ReBACCacheManager, RequestScopedCache } from './cache-manager';
import { RelationParser, createEvaluationContext, parseObjectString } from './relation-parser';
import { DEFAULT_CACHE_TTL, DEFAULT_MAX_DEPTH } from './types';

/**
 * ReBACService - Main ReBAC service implementation
 */
export class ReBACService implements IReBACService {
  private adapter: IStorageAdapter;
  private cacheManager: IReBACCacheManager;
  private relationParser: IRelationParser;
  private closureManager: IClosureManager | null;
  private config: Required<ReBACConfig>;

  constructor(
    adapter: IStorageAdapter,
    config?: ReBACConfig,
    cacheManager?: IReBACCacheManager,
    closureManager?: IClosureManager | null,
    relationParser?: IRelationParser
  ) {
    this.adapter = adapter;
    this.config = {
      cache_namespace: config?.cache_namespace ?? (null as unknown as KVNamespace),
      cache_ttl: config?.cache_ttl ?? DEFAULT_CACHE_TTL,
      max_depth: config?.max_depth ?? DEFAULT_MAX_DEPTH,
      enable_closure_table: config?.enable_closure_table ?? true,
      closure_batch_size: config?.closure_batch_size ?? 100,
    };

    this.cacheManager =
      cacheManager ??
      new ReBACCacheManager(this.config.cache_namespace ?? undefined, this.config.cache_ttl);
    this.relationParser = relationParser ?? new RelationParser();
    this.closureManager = closureManager ?? null;
  }

  /**
   * Check if a user has a specific relation to an object
   */
  async check(request: CheckRequest): Promise<CheckResponse> {
    // Parse object string
    const { type: objectType, id: objectId } = request.object_type
      ? { type: request.object_type, id: request.object }
      : parseObjectString(request.object);

    // Parse user string (may contain type prefix)
    const userId = request.user_id.includes(':') ? request.user_id.split(':')[1] : request.user_id;

    // Layer 1: Check KV cache
    const cachedResult = await this.cacheManager.get(
      request.tenant_id,
      userId,
      request.relation,
      objectType,
      objectId
    );

    if (cachedResult) {
      return cachedResult;
    }

    // Layer 2: Compute using recursive CTE + relation definitions
    const result = await this.computeCheck(
      request.tenant_id,
      userId,
      request.relation,
      objectType,
      objectId
    );

    // Cache the result
    await this.cacheManager.set(
      request.tenant_id,
      userId,
      request.relation,
      objectType,
      objectId,
      result,
      this.config.cache_ttl
    );

    return result;
  }

  /**
   * Batch check multiple authorization requests
   */
  async batchCheck(request: BatchCheckRequest): Promise<BatchCheckResponse> {
    // Use request-scoped cache for deduplication
    const requestCache = new RequestScopedCache();

    const results = await Promise.all(
      request.checks.map(async (checkRequest) => {
        const { type: objectType, id: objectId } = checkRequest.object_type
          ? { type: checkRequest.object_type, id: checkRequest.object }
          : parseObjectString(checkRequest.object);

        const userId = checkRequest.user_id.includes(':')
          ? checkRequest.user_id.split(':')[1]
          : checkRequest.user_id;

        // Check request-scoped cache first
        const requestCached = requestCache.get(
          checkRequest.tenant_id,
          userId,
          checkRequest.relation,
          objectType,
          objectId
        );
        if (requestCached) {
          return requestCached;
        }

        // Perform the check
        const result = await this.check(checkRequest);

        // Add to request-scoped cache
        requestCache.set(
          checkRequest.tenant_id,
          userId,
          checkRequest.relation,
          objectType,
          objectId,
          result
        );

        return result;
      })
    );

    return { results };
  }

  /**
   * List all objects a user has a specific relation to
   */
  async listObjects(request: ListObjectsRequest): Promise<ListObjectsResponse> {
    // If closure manager is available, use it
    if (this.closureManager) {
      const result = await this.closureManager.getObjectsForUser(
        request.tenant_id,
        request.user_id,
        request.relation,
        request.object_type,
        { limit: request.limit, cursor: request.cursor }
      );
      return {
        object_ids: result.objectIds,
        next_cursor: result.nextCursor,
      };
    }

    // Fallback: Use recursive CTE (less efficient for large datasets)
    return this.listObjectsViaCTE(request);
  }

  /**
   * List all users who have a specific relation to an object
   */
  async listUsers(request: ListUsersRequest): Promise<ListUsersResponse> {
    // Parse object
    const { type: objectType, id: objectId } = request.object_type
      ? { type: request.object_type, id: request.object }
      : parseObjectString(request.object);

    // If closure manager is available, use it
    if (this.closureManager) {
      const result = await this.closureManager.getUsersForObject(
        request.tenant_id,
        objectType,
        objectId,
        request.relation,
        { limit: request.limit, cursor: request.cursor }
      );
      return {
        user_ids: result.userIds,
        next_cursor: result.nextCursor,
      };
    }

    // Fallback: Use recursive CTE
    return this.listUsersViaCTE(
      request.tenant_id,
      objectType,
      objectId,
      request.relation,
      request.limit
    );
  }

  /**
   * Invalidate cache for a specific object
   */
  async invalidateCache(
    tenantId: string,
    objectType: string,
    objectId: string,
    relation?: string
  ): Promise<void> {
    await this.cacheManager.invalidateObject(tenantId, objectType, objectId);

    // Also update closure table if enabled
    if (this.closureManager) {
      await this.closureManager.recomputeForObject(tenantId, objectType, objectId);
    }
  }

  /**
   * Invalidate all cache entries for a user
   */
  async invalidateUserCache(tenantId: string, userId: string): Promise<void> {
    await this.cacheManager.invalidateUser(tenantId, userId);

    // Also update closure table if enabled
    if (this.closureManager) {
      await this.closureManager.recomputeForUser(tenantId, userId);
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Compute check result using recursive CTE and relation definitions
   */
  private async computeCheck(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<CheckResponse> {
    // Step 1: Check for direct relationship
    const directCheck = await this.checkDirectRelationship(
      tenantId,
      userId,
      relation,
      objectType,
      objectId
    );

    if (directCheck.allowed) {
      return directCheck;
    }

    // Step 2: Get relation definition for this object type and relation
    const definition = await this.getRelationDefinition(tenantId, objectType, relation);

    if (definition) {
      // Evaluate the relation expression
      const context = createEvaluationContext(
        tenantId,
        userId,
        objectType,
        objectId,
        this.config.max_depth
      );

      const allowed = await this.relationParser.evaluate(
        definition.definition,
        context,
        this.adapter
      );

      return {
        allowed,
        resolved_via: 'computed',
        path: allowed ? Array.from(context.visited) : undefined,
      };
    }

    // Step 3: Use recursive CTE for transitive relationships
    const transitiveCheck = await this.checkTransitiveRelationship(
      tenantId,
      userId,
      relation,
      objectType,
      objectId
    );

    return transitiveCheck;
  }

  /**
   * Check for a direct relationship tuple
   */
  private async checkDirectRelationship(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<CheckResponse> {
    const now = Math.floor(Date.now() / 1000);

    const results = await this.adapter.query<{ id: string }>(
      `SELECT id FROM relationships
       WHERE tenant_id = ?
         AND from_type = 'subject'
         AND from_id = ?
         AND to_type = ?
         AND to_id = ?
         AND relationship_type = ?
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`,
      [tenantId, userId, objectType, objectId, relation, now]
    );

    return {
      allowed: results.length > 0,
      resolved_via: 'direct',
    };
  }

  /**
   * Check for transitive relationships using recursive CTE
   */
  private async checkTransitiveRelationship(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<CheckResponse> {
    const now = Math.floor(Date.now() / 1000);
    const maxDepth = this.config.max_depth;

    // Recursive CTE to find transitive relationships
    // Starting from the user, traverse relationships to find the target object
    const results = await this.adapter.query<{
      target_type: string;
      target_id: string;
      depth: number;
      path: string;
    }>(
      `WITH RECURSIVE reachable AS (
        -- Base case: Direct relationships from the user
        SELECT
          r.to_type as target_type,
          r.to_id as target_id,
          r.relationship_type as relation,
          1 as depth,
          r.id as path
        FROM relationships r
        WHERE r.tenant_id = ?
          AND r.from_type = 'subject'
          AND r.from_id = ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)

        UNION ALL

        -- Recursive case: Follow relationships from reached objects
        SELECT
          r.to_type as target_type,
          r.to_id as target_id,
          r.relationship_type as relation,
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
      SELECT target_type, target_id, depth, path
      FROM reachable
      WHERE target_type = ?
        AND target_id = ?
        AND relation = ?
      LIMIT 1`,
      [
        tenantId,
        userId,
        now, // Base case params
        tenantId,
        maxDepth,
        now, // Recursive case params
        objectType,
        objectId,
        relation, // Filter params
      ]
    );

    if (results.length > 0) {
      return {
        allowed: true,
        resolved_via: 'computed',
        path: results[0].path.split(','),
      };
    }

    return {
      allowed: false,
      resolved_via: 'computed',
    };
  }

  /**
   * Get relation definition from database
   */
  private async getRelationDefinition(
    tenantId: string,
    objectType: string,
    relationName: string
  ): Promise<RelationDefinition | null> {
    const results = await this.adapter.query<{
      id: string;
      tenant_id: string;
      object_type: string;
      relation_name: string;
      definition_json: string;
      description: string | null;
      priority: number;
      is_active: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT * FROM relation_definitions
       WHERE tenant_id = ?
         AND object_type = ?
         AND relation_name = ?
         AND is_active = 1
       ORDER BY priority DESC
       LIMIT 1`,
      [tenantId, objectType, relationName]
    );

    if (results.length === 0) {
      // Try default tenant
      const defaultResults = await this.adapter.query<{
        id: string;
        tenant_id: string;
        object_type: string;
        relation_name: string;
        definition_json: string;
        description: string | null;
        priority: number;
        is_active: number;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT * FROM relation_definitions
         WHERE tenant_id = 'default'
           AND object_type = ?
           AND relation_name = ?
           AND is_active = 1
         ORDER BY priority DESC
         LIMIT 1`,
        [objectType, relationName]
      );

      if (defaultResults.length === 0) {
        return null;
      }

      const row = defaultResults[0];
      return {
        id: row.id,
        tenant_id: row.tenant_id,
        object_type: row.object_type,
        relation_name: row.relation_name,
        definition: this.relationParser.parse(row.definition_json),
        description: row.description ?? undefined,
        priority: row.priority,
        is_active: row.is_active === 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }

    const row = results[0];
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      object_type: row.object_type,
      relation_name: row.relation_name,
      definition: this.relationParser.parse(row.definition_json),
      description: row.description ?? undefined,
      priority: row.priority,
      is_active: row.is_active === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * List objects via recursive CTE (fallback when closure manager is not available)
   */
  private async listObjectsViaCTE(request: ListObjectsRequest): Promise<ListObjectsResponse> {
    const now = Math.floor(Date.now() / 1000);
    const maxDepth = this.config.max_depth;
    const limit = request.limit ?? 100;
    const offset = request.cursor ? parseInt(request.cursor, 10) : 0;

    const userId = request.user_id.includes(':') ? request.user_id.split(':')[1] : request.user_id;

    // Use recursive CTE to find all objects the user has access to
    const results = await this.adapter.query<{ object_id: string }>(
      `WITH RECURSIVE reachable AS (
        -- Base case: Direct relationships from the user
        SELECT
          r.to_type as target_type,
          r.to_id as target_id,
          r.relationship_type as relation,
          1 as depth
        FROM relationships r
        WHERE r.tenant_id = ?
          AND r.from_type = 'subject'
          AND r.from_id = ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)

        UNION ALL

        -- Recursive case: Follow relationships
        SELECT
          r.to_type as target_type,
          r.to_id as target_id,
          r.relationship_type as relation,
          rch.depth + 1 as depth
        FROM relationships r
        INNER JOIN reachable rch
          ON r.from_type = rch.target_type
          AND r.from_id = rch.target_id
        WHERE r.tenant_id = ?
          AND rch.depth < ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)
      )
      SELECT DISTINCT target_id as object_id
      FROM reachable
      WHERE target_type = ?
        AND relation = ?
      LIMIT ? OFFSET ?`,
      [
        request.tenant_id,
        userId,
        now,
        request.tenant_id,
        maxDepth,
        now,
        request.object_type,
        request.relation,
        limit + 1,
        offset, // Fetch one extra to check for more
      ]
    );

    const objectIds = results.slice(0, limit).map((r) => r.object_id);
    const hasMore = results.length > limit;

    return {
      object_ids: objectIds,
      next_cursor: hasMore ? String(offset + limit) : undefined,
    };
  }

  /**
   * List users via recursive CTE (fallback when closure manager is not available)
   */
  private async listUsersViaCTE(
    tenantId: string,
    objectType: string,
    objectId: string,
    relation: string,
    limit?: number
  ): Promise<ListUsersResponse> {
    const now = Math.floor(Date.now() / 1000);
    const maxDepth = this.config.max_depth;
    const queryLimit = limit ?? 100;

    // Reverse traversal: from object, find all users who can reach it
    const results = await this.adapter.query<{ user_id: string }>(
      `WITH RECURSIVE reachable AS (
        -- Base case: Direct relationships to the object
        SELECT
          r.from_type as source_type,
          r.from_id as source_id,
          r.relationship_type as relation,
          1 as depth
        FROM relationships r
        WHERE r.tenant_id = ?
          AND r.to_type = ?
          AND r.to_id = ?
          AND r.relationship_type = ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)

        UNION ALL

        -- Recursive case: Follow relationships backwards
        SELECT
          r.from_type as source_type,
          r.from_id as source_id,
          r.relationship_type as relation,
          rch.depth + 1 as depth
        FROM relationships r
        INNER JOIN reachable rch
          ON r.to_type = rch.source_type
          AND r.to_id = rch.source_id
        WHERE r.tenant_id = ?
          AND rch.depth < ?
          AND (r.expires_at IS NULL OR r.expires_at > ?)
      )
      SELECT DISTINCT source_id as user_id
      FROM reachable
      WHERE source_type = 'subject'
      LIMIT ?`,
      [tenantId, objectType, objectId, relation, now, tenantId, maxDepth, now, queryLimit]
    );

    return {
      user_ids: results.map((r) => r.user_id),
    };
  }
}

/**
 * Create a ReBACService instance
 */
export function createReBACService(adapter: IStorageAdapter, config?: ReBACConfig): ReBACService {
  return new ReBACService(adapter, config);
}

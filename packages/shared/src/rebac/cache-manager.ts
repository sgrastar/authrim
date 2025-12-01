/**
 * ReBAC Cache Manager Implementation
 *
 * Manages KV caching for check() operations.
 * Cache key format: rebac:check:{tenant_id}:{user_id}:{relation}:{object_type}:{object_id}
 *
 * Cache strategy:
 * - TTL: 60 seconds (configurable)
 * - Invalidation: On relationship changes
 * - Pattern invalidation: For bulk invalidation scenarios
 */

import type { IReBACCacheManager } from './interfaces';
import type { CheckResponse } from './types';
import { REBAC_CACHE_PREFIX, DEFAULT_CACHE_TTL } from './types';

/**
 * Build cache key from components
 */
function buildCacheKey(
  tenantId: string,
  userId: string,
  relation: string,
  objectType: string,
  objectId: string
): string {
  return `${REBAC_CACHE_PREFIX}${tenantId}:${userId}:${relation}:${objectType}:${objectId}`;
}

/**
 * Build pattern for object invalidation
 */
function buildObjectPattern(tenantId: string, objectType: string, objectId: string): string {
  return `${REBAC_CACHE_PREFIX}${tenantId}:*:*:${objectType}:${objectId}`;
}

/**
 * Build pattern for user invalidation
 */
function buildUserPattern(tenantId: string, userId: string): string {
  return `${REBAC_CACHE_PREFIX}${tenantId}:${userId}:*:*:*`;
}

/**
 * Cached data structure stored in KV
 */
interface CachedData {
  result: CheckResponse;
  cached_at: number;
}

/**
 * ReBACCacheManager - KV-based cache for check() results
 */
export class ReBACCacheManager implements IReBACCacheManager {
  private kv: KVNamespace | null;
  private defaultTtl: number;
  /** In-memory fallback for environments without KV */
  private memoryCache: Map<string, { data: CachedData; expiresAt: number }>;

  constructor(kv?: KVNamespace, defaultTtl: number = DEFAULT_CACHE_TTL) {
    this.kv = kv ?? null;
    this.defaultTtl = defaultTtl;
    this.memoryCache = new Map();
  }

  async get(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<CheckResponse | null> {
    const key = buildCacheKey(tenantId, userId, relation, objectType, objectId);

    if (this.kv) {
      // KV-based cache
      const cached = await this.kv.get(key, 'json');
      if (cached) {
        const data = cached as CachedData;
        return {
          ...data.result,
          resolved_via: 'cache',
          cached_until: data.cached_at + this.defaultTtl * 1000,
        };
      }
    } else {
      // In-memory fallback
      const cached = this.memoryCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          ...cached.data.result,
          resolved_via: 'cache',
          cached_until: cached.expiresAt,
        };
      } else if (cached) {
        // Expired, clean up
        this.memoryCache.delete(key);
      }
    }

    return null;
  }

  async set(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string,
    result: CheckResponse,
    ttl: number = this.defaultTtl
  ): Promise<void> {
    const key = buildCacheKey(tenantId, userId, relation, objectType, objectId);
    const now = Date.now();

    const data: CachedData = {
      result: {
        allowed: result.allowed,
        resolved_via: result.resolved_via,
        path: result.path,
      },
      cached_at: now,
    };

    if (this.kv) {
      // KV-based cache
      await this.kv.put(key, JSON.stringify(data), {
        expirationTtl: ttl,
      });
    } else {
      // In-memory fallback
      this.memoryCache.set(key, {
        data,
        expiresAt: now + ttl * 1000,
      });
    }
  }

  async invalidate(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): Promise<void> {
    const key = buildCacheKey(tenantId, userId, relation, objectType, objectId);

    if (this.kv) {
      await this.kv.delete(key);
    } else {
      this.memoryCache.delete(key);
    }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    // KV doesn't support pattern-based deletion, so this is a no-op for KV
    // In production, this would require:
    // 1. Storing keys in a secondary index, or
    // 2. Using a different caching strategy

    if (!this.kv) {
      // In-memory: we can do pattern matching
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const keysToDelete: string[] = [];

      for (const key of this.memoryCache.keys()) {
        if (regex.test(key)) {
          keysToDelete.push(key);
        }
      }

      for (const key of keysToDelete) {
        this.memoryCache.delete(key);
      }
    }

    // For KV: Log warning that pattern invalidation is limited
    // In a real implementation, you'd want to:
    // 1. Store object→cache key mappings
    // 2. Use a cache tag system
    // 3. Or accept eventual consistency
  }

  async invalidateObject(tenantId: string, objectType: string, objectId: string): Promise<void> {
    const pattern = buildObjectPattern(tenantId, objectType, objectId);
    await this.invalidatePattern(pattern);

    // For KV environments, we need a different approach
    // This implementation stores object→key mappings for efficient invalidation
    if (this.kv) {
      // Get list of keys for this object from a secondary index
      const indexKey = `rebac:index:object:${tenantId}:${objectType}:${objectId}`;
      const keysJson = await this.kv.get(indexKey);

      if (keysJson) {
        const keys = JSON.parse(keysJson) as string[];
        // Delete all cached entries
        await Promise.all(keys.map((key) => this.kv!.delete(key)));
        // Delete the index
        await this.kv.delete(indexKey);
      }
    }
  }

  async invalidateUser(tenantId: string, userId: string): Promise<void> {
    const pattern = buildUserPattern(tenantId, userId);
    await this.invalidatePattern(pattern);

    // For KV environments, use secondary index
    if (this.kv) {
      const indexKey = `rebac:index:user:${tenantId}:${userId}`;
      const keysJson = await this.kv.get(indexKey);

      if (keysJson) {
        const keys = JSON.parse(keysJson) as string[];
        await Promise.all(keys.map((key) => this.kv!.delete(key)));
        await this.kv.delete(indexKey);
      }
    }
  }

  /**
   * Add key to secondary indexes for efficient invalidation
   * Called internally when caching a result
   */
  private async addToIndexes(
    key: string,
    tenantId: string,
    userId: string,
    objectType: string,
    objectId: string
  ): Promise<void> {
    if (!this.kv) return;

    // Add to object index
    const objectIndexKey = `rebac:index:object:${tenantId}:${objectType}:${objectId}`;
    const existingObjectKeys = await this.kv.get(objectIndexKey);
    const objectKeys: string[] = existingObjectKeys ? JSON.parse(existingObjectKeys) : [];
    if (!objectKeys.includes(key)) {
      objectKeys.push(key);
      await this.kv.put(objectIndexKey, JSON.stringify(objectKeys), {
        expirationTtl: this.defaultTtl * 2, // Index lives longer than cache entries
      });
    }

    // Add to user index
    const userIndexKey = `rebac:index:user:${tenantId}:${userId}`;
    const existingUserKeys = await this.kv.get(userIndexKey);
    const userKeys: string[] = existingUserKeys ? JSON.parse(existingUserKeys) : [];
    if (!userKeys.includes(key)) {
      userKeys.push(key);
      await this.kv.put(userIndexKey, JSON.stringify(userKeys), {
        expirationTtl: this.defaultTtl * 2,
      });
    }
  }

  /**
   * Enhanced set with index tracking
   */
  async setWithIndexes(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string,
    result: CheckResponse,
    ttl: number = this.defaultTtl
  ): Promise<void> {
    const key = buildCacheKey(tenantId, userId, relation, objectType, objectId);

    // Set the cache entry
    await this.set(tenantId, userId, relation, objectType, objectId, result, ttl);

    // Update indexes for efficient invalidation
    await this.addToIndexes(key, tenantId, userId, objectType, objectId);
  }

  /**
   * Clear all cache (useful for testing or emergency reset)
   */
  async clearAll(): Promise<void> {
    if (!this.kv) {
      this.memoryCache.clear();
    }
    // For KV: This would require listing all keys with prefix and deleting them
    // Not implemented here as it's potentially expensive
  }

  /**
   * Get cache statistics (for monitoring)
   */
  getStats(): { memorySize: number; kvEnabled: boolean } {
    return {
      memorySize: this.memoryCache.size,
      kvEnabled: this.kv !== null,
    };
  }
}

/**
 * Request-scoped cache for deduplication within a single request
 *
 * This prevents duplicate database queries when the same check
 * is performed multiple times in a single request (e.g., from
 * multiple policy conditions).
 */
export class RequestScopedCache {
  private cache: Map<string, CheckResponse>;

  constructor() {
    this.cache = new Map();
  }

  /**
   * Get cached result for a check
   */
  get(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): CheckResponse | undefined {
    const key = buildCacheKey(tenantId, userId, relation, objectType, objectId);
    return this.cache.get(key);
  }

  /**
   * Set cached result for a check
   */
  set(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string,
    result: CheckResponse
  ): void {
    const key = buildCacheKey(tenantId, userId, relation, objectType, objectId);
    this.cache.set(key, result);
  }

  /**
   * Check if a result is cached
   */
  has(
    tenantId: string,
    userId: string,
    relation: string,
    objectType: string,
    objectId: string
  ): boolean {
    const key = buildCacheKey(tenantId, userId, relation, objectType, objectId);
    return this.cache.has(key);
  }

  /**
   * Get all cached keys (for debugging)
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * ReBAC Cache Manager Implementation
 *
 * Manages KV caching for check() operations.
 * Cache key format: rebac:check:v3:["{tenant_id}@{version}","{user_id}","{relation}","{object_type}","{object_id}"]
 *
 * Cache strategy:
 * - TTL: 60 seconds (configurable)
 * - Invalidation: On relationship changes
 * - Pattern invalidation: For bulk invalidation scenarios
 */

import type { IReBACCacheManager } from './interfaces';
import type { CheckResponse } from './types';
import { REBAC_CACHE_PREFIX, DEFAULT_CACHE_TTL } from './types';

/** The KV key of a tenant's ReBAC version. */
function reBACTenantVersionKey(tenantId: string): string {
  return `rebac:v2:tenant-version:${tenantId}`;
}

/**
 * A tenant's ReBAC version: cached check results are keyed by it, so a bump retires every cached
 * result of the tenant at once ('0' before the first bump).
 */
export async function getReBACTenantVersion(kv: KVNamespace, tenantId: string): Promise<string> {
  return (await kv.get(reBACTenantVersionKey(tenantId))) ?? '0';
}

/** Bumps a tenant's ReBAC version: after every tuple and relation definition write or delete. */
export async function bumpReBACTenantVersion(kv: KVNamespace, tenantId: string): Promise<void> {
  await kv.put(reBACTenantVersionKey(tenantId), crypto.randomUUID());
}

/**
 * Build cache key from components (the tenant part carries the tenant's ReBAC version). The
 * components are a JSON array, so the key is injective: ids may contain `:`.
 */
function buildCacheKey(
  tenantId: string,
  userId: string,
  relation: string,
  objectType: string,
  objectId: string
): string {
  return `${REBAC_CACHE_PREFIX}${JSON.stringify([tenantId, userId, relation, objectType, objectId])}`;
}

/** The components of a key built by buildCacheKey, or null for another key. */
function parseCacheKey(key: string): string[] | null {
  if (!key.startsWith(REBAC_CACHE_PREFIX)) return null;
  try {
    const parts: unknown = JSON.parse(key.slice(REBAC_CACHE_PREFIX.length));
    return Array.isArray(parts) && parts.length === 5 && parts.every((p) => typeof p === 'string')
      ? parts
      : null;
  } catch {
    return null;
  }
}

/** The KV key of a secondary index (JSON components, injective as the cache keys). */
function indexKey(kind: 'object' | 'user', parts: string[]): string {
  return `rebac:index:v3:${kind}:${JSON.stringify(parts)}`;
}

/**
 * The KV form of a key: a fixed-length SHA-256 digest of it (hex), so ids of any length stay
 * within KV's key limit; the in-memory cache keeps the JSON key.
 */
async function kvKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${key.startsWith(REBAC_CACHE_PREFIX) ? REBAC_CACHE_PREFIX : 'rebac:index:v3:'}${hex.join('')}`;
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
      const cached = await this.kv.get(await kvKey(key), 'json');
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
      await this.kv.put(await kvKey(key), JSON.stringify(data), {
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
      await this.kv.delete(await kvKey(key));
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

  /** Drops the in-memory entries whose components match. */
  private invalidateMemory(matches: (parts: string[]) => boolean): void {
    for (const key of [...this.memoryCache.keys()]) {
      const parts = parseCacheKey(key);
      if (parts && matches(parts)) this.memoryCache.delete(key);
    }
  }

  async invalidateObject(tenantId: string, objectType: string, objectId: string): Promise<void> {
    this.invalidateMemory(
      ([tenant, , , type, id]) => tenant === tenantId && type === objectType && id === objectId
    );

    // For KV environments, we need a different approach
    // This implementation stores object→key mappings for efficient invalidation
    if (this.kv) {
      // Get list of keys for this object from a secondary index
      const objectIndexKey = await kvKey(indexKey('object', [tenantId, objectType, objectId]));
      const keysJson = await this.kv.get(objectIndexKey);

      if (keysJson) {
        const keys = JSON.parse(keysJson) as string[];
        // Delete all cached entries
        await Promise.all(keys.map((key) => this.kv!.delete(key)));
        // Delete the index
        await this.kv.delete(objectIndexKey);
      }
    }
  }

  async invalidateUser(tenantId: string, userId: string): Promise<void> {
    this.invalidateMemory(([tenant, user]) => tenant === tenantId && user === userId);

    // For KV environments, use secondary index
    if (this.kv) {
      const userIndexKey = await kvKey(indexKey('user', [tenantId, userId]));
      const keysJson = await this.kv.get(userIndexKey);

      if (keysJson) {
        const keys = JSON.parse(keysJson) as string[];
        await Promise.all(keys.map((key) => this.kv!.delete(key)));
        await this.kv.delete(userIndexKey);
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
    const objectIndexKey = await kvKey(indexKey('object', [tenantId, objectType, objectId]));
    const existingObjectKeys = await this.kv.get(objectIndexKey);
    const objectKeys: string[] = existingObjectKeys ? JSON.parse(existingObjectKeys) : [];
    if (!objectKeys.includes(key)) {
      objectKeys.push(key);
      await this.kv.put(objectIndexKey, JSON.stringify(objectKeys), {
        expirationTtl: this.defaultTtl * 2, // Index lives longer than cache entries
      });
    }

    // Add to user index
    const userIndexKey = await kvKey(indexKey('user', [tenantId, userId]));
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

    // Update indexes for efficient invalidation (they hold the KV keys)
    await this.addToIndexes(await kvKey(key), tenantId, userId, objectType, objectId);
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

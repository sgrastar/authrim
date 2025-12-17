/**
 * Cache Repository
 *
 * KV-based caching layer for cross-request data caching.
 * Provides type-safe access to cached user and client data.
 *
 * Architecture:
 * - Uses Cloudflare KV for persistence
 * - TTL-based expiration
 * - Optional in-memory caching for ultra-hot paths
 *
 * KV Keys:
 * - user:{userId} - Cached user data
 * - client:{clientId} - Cached client data
 * - pii:{userId} - Cached PII data (shorter TTL)
 *
 * Usage:
 * ```typescript
 * const cache = new CacheRepository(env.USER_CACHE, env.CLIENTS_CACHE);
 *
 * // Get or fetch user
 * const user = await cache.getOrFetchUser(userId, async () => {
 *   return await userRepo.findById(userId);
 * });
 *
 * // Invalidate on update
 * await cache.invalidateUser(userId);
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Cache configuration options
 */
export interface CacheConfig {
  /** Default TTL in seconds */
  defaultTtlSeconds: number;
  /** TTL for PII data (typically shorter) */
  piiTtlSeconds: number;
  /** Whether to use in-memory caching */
  useInMemoryCache: boolean;
  /** In-memory cache TTL in milliseconds */
  inMemoryCacheTtlMs: number;
}

/**
 * Cached user core data
 */
export interface CachedUserCore {
  id: string;
  tenant_id: string;
  email_verified: boolean;
  phone_number_verified: boolean;
  is_active: boolean;
  user_type: string;
  pii_partition: string;
  pii_status: string;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

/**
 * Cached client data
 */
export interface CachedClient {
  id: string;
  client_id: string;
  client_name: string;
  client_type: string;
  redirect_uris: string[];
  grant_types: string[];
  is_active: boolean;
  require_pkce: boolean;
  token_endpoint_auth_method: string;
  created_at: number;
  updated_at: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  errors: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default cache configuration */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  defaultTtlSeconds: 300, // 5 minutes
  piiTtlSeconds: 60, // 1 minute (shorter for PII)
  useInMemoryCache: true,
  inMemoryCacheTtlMs: 10_000, // 10 seconds
};

/** Cache key prefixes */
export const CACHE_KEY_PREFIX = {
  USER_CORE: 'user:',
  USER_PII: 'pii:',
  CLIENT: 'client:',
  SESSION: 'session:',
} as const;

// =============================================================================
// In-Memory Cache
// =============================================================================

/**
 * Simple in-memory cache entry
 */
interface InMemoryCacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Probability of running cleanup on each set operation (10%) */
const CLEANUP_PROBABILITY = 0.1;

/**
 * In-memory cache for ultra-hot paths
 */
class InMemoryCache {
  private cache = new Map<string, InMemoryCacheEntry<unknown>>();
  private maxSize: number;
  private lastCleanupTime: number = 0;
  /** Minimum interval between forced cleanups (in milliseconds) */
  private readonly cleanupIntervalMs: number = 30_000; // 30 seconds

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Probabilistic cleanup or forced cleanup if cache is getting large
    this.maybeCleanup();

    // Simple LRU: delete oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  /**
   * Remove all expired entries from the cache
   * @returns Number of entries removed
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
        removed++;
      }
    }

    this.lastCleanupTime = now;
    return removed;
  }

  /**
   * Probabilistically run cleanup to avoid memory leaks
   * Runs cleanup if:
   * 1. Cache size > 80% of maxSize (forced cleanup)
   * 2. Random chance based on CLEANUP_PROBABILITY
   * 3. Enough time has passed since last cleanup
   */
  private maybeCleanup(): void {
    const now = Date.now();

    // Force cleanup if cache is getting too large
    if (this.cache.size > this.maxSize * 0.8) {
      this.cleanup();
      return;
    }

    // Skip if cleaned up recently
    if (now - this.lastCleanupTime < this.cleanupIntervalMs) {
      return;
    }

    // Probabilistic cleanup
    if (Math.random() < CLEANUP_PROBABILITY) {
      this.cleanup();
    }
  }

  /**
   * Get the number of expired entries without removing them
   * Useful for monitoring
   */
  getExpiredCount(): number {
    const now = Date.now();
    let count = 0;

    for (const entry of this.cache.values()) {
      if (entry.expiresAt < now) {
        count++;
      }
    }

    return count;
  }
}

// =============================================================================
// Cache Repository
// =============================================================================

/**
 * Cache Repository
 *
 * Provides type-safe caching for user and client data.
 */
export class CacheRepository {
  private userCacheKV: KVNamespace | null;
  private clientCacheKV: KVNamespace | null;
  private config: CacheConfig;
  private inMemoryCache: InMemoryCache;
  private stats: CacheStats;

  /**
   * Create a new CacheRepository
   *
   * @param userCacheKV - KV namespace for user cache (optional)
   * @param clientCacheKV - KV namespace for client cache (optional)
   * @param config - Cache configuration
   */
  constructor(
    userCacheKV?: KVNamespace,
    clientCacheKV?: KVNamespace,
    config: Partial<CacheConfig> = {}
  ) {
    this.userCacheKV = userCacheKV ?? null;
    this.clientCacheKV = clientCacheKV ?? null;
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    this.inMemoryCache = new InMemoryCache();
    this.stats = { hits: 0, misses: 0, invalidations: 0, errors: 0 };
  }

  // ===========================================================================
  // User Cache Methods
  // ===========================================================================

  /**
   * Get cached user core data or fetch from source
   *
   * @param userId - User ID
   * @param fetchFn - Function to fetch user if not cached
   * @returns User data or null
   */
  async getOrFetchUserCore<T extends CachedUserCore>(
    userId: string,
    fetchFn: () => Promise<T | null>
  ): Promise<T | null> {
    const key = `${CACHE_KEY_PREFIX.USER_CORE}${userId}`;

    // 1. Check in-memory cache
    if (this.config.useInMemoryCache) {
      const inMemory = this.inMemoryCache.get<T>(key);
      if (inMemory !== undefined) {
        this.stats.hits++;
        return inMemory;
      }
    }

    // 2. Check KV cache
    if (this.userCacheKV) {
      try {
        const cached = await this.userCacheKV.get(key, { type: 'json' });
        if (cached) {
          this.stats.hits++;

          // Populate in-memory cache
          if (this.config.useInMemoryCache) {
            this.inMemoryCache.set(key, cached, this.config.inMemoryCacheTtlMs);
          }

          return cached as T;
        }
      } catch (error) {
        this.stats.errors++;
        // Fall through to fetch
      }
    }

    // 3. Cache miss - fetch from source
    this.stats.misses++;
    const data = await fetchFn();

    if (data) {
      await this.setUserCore(userId, data);
    }

    return data;
  }

  /**
   * Set user core data in cache
   *
   * @param userId - User ID
   * @param data - User data to cache
   */
  async setUserCore<T extends CachedUserCore>(userId: string, data: T): Promise<void> {
    const key = `${CACHE_KEY_PREFIX.USER_CORE}${userId}`;

    // Set in-memory cache
    if (this.config.useInMemoryCache) {
      this.inMemoryCache.set(key, data, this.config.inMemoryCacheTtlMs);
    }

    // Set KV cache
    if (this.userCacheKV) {
      try {
        await this.userCacheKV.put(key, JSON.stringify(data), {
          expirationTtl: this.config.defaultTtlSeconds,
        });
      } catch (error) {
        this.stats.errors++;
      }
    }
  }

  /**
   * Invalidate user cache
   *
   * @param userId - User ID
   */
  async invalidateUser(userId: string): Promise<void> {
    const coreKey = `${CACHE_KEY_PREFIX.USER_CORE}${userId}`;
    const piiKey = `${CACHE_KEY_PREFIX.USER_PII}${userId}`;

    this.stats.invalidations++;

    // Clear in-memory cache
    this.inMemoryCache.delete(coreKey);
    this.inMemoryCache.delete(piiKey);

    // Clear KV cache
    if (this.userCacheKV) {
      try {
        await Promise.all([this.userCacheKV.delete(coreKey), this.userCacheKV.delete(piiKey)]);
      } catch (error) {
        this.stats.errors++;
      }
    }
  }

  // ===========================================================================
  // Client Cache Methods
  // ===========================================================================

  /**
   * Get cached client data or fetch from source
   *
   * @param clientId - Client ID
   * @param fetchFn - Function to fetch client if not cached
   * @returns Client data or null
   */
  async getOrFetchClient<T extends CachedClient>(
    clientId: string,
    fetchFn: () => Promise<T | null>
  ): Promise<T | null> {
    const key = `${CACHE_KEY_PREFIX.CLIENT}${clientId}`;

    // 1. Check in-memory cache
    if (this.config.useInMemoryCache) {
      const inMemory = this.inMemoryCache.get<T>(key);
      if (inMemory !== undefined) {
        this.stats.hits++;
        return inMemory;
      }
    }

    // 2. Check KV cache
    if (this.clientCacheKV) {
      try {
        const cached = await this.clientCacheKV.get(key, { type: 'json' });
        if (cached) {
          this.stats.hits++;

          // Populate in-memory cache
          if (this.config.useInMemoryCache) {
            this.inMemoryCache.set(key, cached, this.config.inMemoryCacheTtlMs);
          }

          return cached as T;
        }
      } catch (error) {
        this.stats.errors++;
        // Fall through to fetch
      }
    }

    // 3. Cache miss - fetch from source
    this.stats.misses++;
    const data = await fetchFn();

    if (data) {
      await this.setClient(clientId, data);
    }

    return data;
  }

  /**
   * Set client data in cache
   *
   * @param clientId - Client ID
   * @param data - Client data to cache
   */
  async setClient<T extends CachedClient>(clientId: string, data: T): Promise<void> {
    const key = `${CACHE_KEY_PREFIX.CLIENT}${clientId}`;

    // Set in-memory cache
    if (this.config.useInMemoryCache) {
      this.inMemoryCache.set(key, data, this.config.inMemoryCacheTtlMs);
    }

    // Set KV cache
    if (this.clientCacheKV) {
      try {
        await this.clientCacheKV.put(key, JSON.stringify(data), {
          expirationTtl: this.config.defaultTtlSeconds,
        });
      } catch (error) {
        this.stats.errors++;
      }
    }
  }

  /**
   * Invalidate client cache
   *
   * @param clientId - Client ID
   */
  async invalidateClient(clientId: string): Promise<void> {
    const key = `${CACHE_KEY_PREFIX.CLIENT}${clientId}`;

    this.stats.invalidations++;

    // Clear in-memory cache
    this.inMemoryCache.delete(key);

    // Clear KV cache
    if (this.clientCacheKV) {
      try {
        await this.clientCacheKV.delete(key);
      } catch (error) {
        this.stats.errors++;
      }
    }
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0, invalidations: 0, errors: 0 };
  }

  /**
   * Clear all in-memory cache
   */
  clearInMemoryCache(): void {
    this.inMemoryCache.clear();
  }

  /**
   * Get in-memory cache size
   */
  getInMemoryCacheSize(): number {
    return this.inMemoryCache.size();
  }

  /**
   * Calculate hit rate
   */
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? this.stats.hits / total : 0;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a CacheRepository with standard configuration
 *
 * @param userCacheKV - KV namespace for user cache
 * @param clientCacheKV - KV namespace for client cache
 * @param config - Optional configuration overrides
 * @returns CacheRepository instance
 */
export function createCacheRepository(
  userCacheKV?: KVNamespace,
  clientCacheKV?: KVNamespace,
  config?: Partial<CacheConfig>
): CacheRepository {
  return new CacheRepository(userCacheKV, clientCacheKV, config);
}

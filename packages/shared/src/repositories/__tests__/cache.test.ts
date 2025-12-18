/**
 * CacheRepository Unit Tests
 *
 * Tests KV-based caching with in-memory cache layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CacheRepository,
  createCacheRepository,
  DEFAULT_CACHE_CONFIG,
  CACHE_KEY_PREFIX,
  type CachedUserCore,
  type CachedClient,
} from '../cache';

// =============================================================================
// Mock KVNamespace
// =============================================================================

function createMockKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();

  return {
    _store: store,
    get: vi.fn(async (key: string, options?: { type?: string }) => {
      const value = store.get(key);
      if (!value) return null;
      if (options?.type === 'json') {
        return JSON.parse(value);
      }
      return value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

// =============================================================================
// Test Data
// =============================================================================

const mockUserCore: CachedUserCore = {
  id: 'user-123',
  tenant_id: 'default',
  email_verified: true,
  phone_number_verified: false,
  is_active: true,
  user_type: 'end_user',
  pii_partition: 'default',
  pii_status: 'active',
  created_at: Date.now() - 86400000,
  updated_at: Date.now(),
  last_login_at: Date.now(),
};

const mockClient: CachedClient = {
  id: 'client-456',
  client_id: 'test-client',
  client_name: 'Test Application',
  client_type: 'confidential',
  redirect_uris: ['https://example.com/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  is_active: true,
  require_pkce: true,
  token_endpoint_auth_method: 'client_secret_basic',
  created_at: Date.now() - 86400000,
  updated_at: Date.now(),
};

// =============================================================================
// Tests
// =============================================================================

describe('CacheRepository', () => {
  describe('constructor', () => {
    it('should create instance with default config', () => {
      const cache = new CacheRepository();

      expect(cache).toBeInstanceOf(CacheRepository);
      expect(cache.getStats()).toEqual({
        hits: 0,
        misses: 0,
        invalidations: 0,
        errors: 0,
      });
    });

    it('should create instance with custom config', () => {
      const cache = new CacheRepository(undefined, undefined, {
        defaultTtlSeconds: 600,
        useInMemoryCache: false,
      });

      expect(cache).toBeInstanceOf(CacheRepository);
    });
  });

  describe('User Cache', () => {
    let userCacheKV: ReturnType<typeof createMockKV>;
    let cache: CacheRepository;

    beforeEach(() => {
      userCacheKV = createMockKV();
      cache = new CacheRepository(userCacheKV, undefined, {
        useInMemoryCache: true,
        inMemoryCacheTtlMs: 1000,
      });
    });

    it('should cache user on first fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      const result = await cache.getOrFetchUserCore('user-123', fetchFn);

      expect(result).toEqual(mockUserCore);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cache.getStats().misses).toBe(1);
      expect(userCacheKV.put).toHaveBeenCalled();
    });

    it('should return cached user from KV on second fetch', async () => {
      // First fetch - populates cache
      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);
      await cache.getOrFetchUserCore('user-123', fetchFn);

      // Clear in-memory cache to force KV lookup
      cache.clearInMemoryCache();

      // Second fetch - should hit KV cache
      const result = await cache.getOrFetchUserCore('user-123', fetchFn);

      expect(result).toEqual(mockUserCore);
      expect(fetchFn).toHaveBeenCalledTimes(1); // Not called again
      expect(cache.getStats().hits).toBe(1);
    });

    it('should return cached user from in-memory cache', async () => {
      // First fetch - populates both caches
      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);
      await cache.getOrFetchUserCore('user-123', fetchFn);

      // Second fetch - should hit in-memory cache
      const result = await cache.getOrFetchUserCore('user-123', fetchFn);

      expect(result).toEqual(mockUserCore);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cache.getStats().hits).toBe(1);
    });

    it('should return null for non-existent user', async () => {
      const fetchFn = vi.fn().mockResolvedValue(null);

      const result = await cache.getOrFetchUserCore('nonexistent', fetchFn);

      expect(result).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(userCacheKV.put).not.toHaveBeenCalled(); // Don't cache null
    });

    it('should invalidate user cache', async () => {
      // Populate cache
      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);
      await cache.getOrFetchUserCore('user-123', fetchFn);

      // Invalidate
      await cache.invalidateUser('user-123');

      expect(cache.getStats().invalidations).toBe(1);
      expect(userCacheKV.delete).toHaveBeenCalledTimes(2); // Core + PII keys
    });

    it('should handle KV errors gracefully', async () => {
      const errorKV = createMockKV();
      (errorKV.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('KV error'));

      const cacheWithError = new CacheRepository(errorKV);
      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      const result = await cacheWithError.getOrFetchUserCore('user-123', fetchFn);

      expect(result).toEqual(mockUserCore);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cacheWithError.getStats().errors).toBe(1);
    });
  });

  describe('Client Cache', () => {
    let clientCacheKV: ReturnType<typeof createMockKV>;
    let cache: CacheRepository;

    beforeEach(() => {
      clientCacheKV = createMockKV();
      cache = new CacheRepository(undefined, clientCacheKV, {
        useInMemoryCache: true,
        inMemoryCacheTtlMs: 1000,
      });
    });

    it('should cache client on first fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue(mockClient);

      const result = await cache.getOrFetchClient('test-client', fetchFn);

      expect(result).toEqual(mockClient);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cache.getStats().misses).toBe(1);
      expect(clientCacheKV.put).toHaveBeenCalled();
    });

    it('should return cached client from KV', async () => {
      // First fetch
      const fetchFn = vi.fn().mockResolvedValue(mockClient);
      await cache.getOrFetchClient('test-client', fetchFn);

      // Clear in-memory cache
      cache.clearInMemoryCache();

      // Second fetch
      const result = await cache.getOrFetchClient('test-client', fetchFn);

      expect(result).toEqual(mockClient);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cache.getStats().hits).toBe(1);
    });

    it('should invalidate client cache', async () => {
      // Populate cache
      const fetchFn = vi.fn().mockResolvedValue(mockClient);
      await cache.getOrFetchClient('test-client', fetchFn);

      // Invalidate
      await cache.invalidateClient('test-client');

      expect(cache.getStats().invalidations).toBe(1);
      expect(clientCacheKV.delete).toHaveBeenCalled();
    });

    it('should return null for non-existent client', async () => {
      const fetchFn = vi.fn().mockResolvedValue(null);

      const result = await cache.getOrFetchClient('nonexistent', fetchFn);

      expect(result).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Statistics', () => {
    it('should track cache statistics', async () => {
      const userCacheKV = createMockKV();
      const cache = new CacheRepository(userCacheKV);

      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      // First fetch - miss
      await cache.getOrFetchUserCore('user-123', fetchFn);

      // Second fetch - hit (in-memory)
      await cache.getOrFetchUserCore('user-123', fetchFn);

      // Invalidation
      await cache.invalidateUser('user-123');

      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(1);
      expect(stats.invalidations).toBe(1);
    });

    it('should reset statistics', async () => {
      const cache = new CacheRepository();
      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      await cache.getOrFetchUserCore('user-123', fetchFn);

      cache.resetStats();

      expect(cache.getStats()).toEqual({
        hits: 0,
        misses: 0,
        invalidations: 0,
        errors: 0,
      });
    });

    it('should calculate hit rate', async () => {
      const userCacheKV = createMockKV();
      const cache = new CacheRepository(userCacheKV);

      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      // 1 miss
      await cache.getOrFetchUserCore('user-123', fetchFn);
      // 3 hits
      await cache.getOrFetchUserCore('user-123', fetchFn);
      await cache.getOrFetchUserCore('user-123', fetchFn);
      await cache.getOrFetchUserCore('user-123', fetchFn);

      expect(cache.getHitRate()).toBe(0.75); // 3/4
    });
  });

  describe('In-Memory Cache', () => {
    it('should track in-memory cache size', async () => {
      const cache = new CacheRepository(undefined, undefined, {
        useInMemoryCache: true,
      });

      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      await cache.getOrFetchUserCore('user-1', fetchFn);
      await cache.getOrFetchUserCore('user-2', fetchFn);
      await cache.getOrFetchUserCore('user-3', fetchFn);

      expect(cache.getInMemoryCacheSize()).toBe(3);
    });

    it('should clear in-memory cache', async () => {
      const cache = new CacheRepository(undefined, undefined, {
        useInMemoryCache: true,
      });

      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      await cache.getOrFetchUserCore('user-1', fetchFn);
      await cache.getOrFetchUserCore('user-2', fetchFn);

      cache.clearInMemoryCache();

      expect(cache.getInMemoryCacheSize()).toBe(0);
    });

    it('should expire entries based on TTL', async () => {
      const cache = new CacheRepository(undefined, undefined, {
        useInMemoryCache: true,
        inMemoryCacheTtlMs: 50, // 50ms TTL
      });

      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      // First fetch
      await cache.getOrFetchUserCore('user-123', fetchFn);
      expect(cache.getStats().misses).toBe(1);

      // Immediate second fetch - should hit
      await cache.getOrFetchUserCore('user-123', fetchFn);
      expect(cache.getStats().hits).toBe(1);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Third fetch - should miss (expired)
      await cache.getOrFetchUserCore('user-123', fetchFn);
      expect(cache.getStats().misses).toBe(2);
    });
  });

  describe('No KV Configured', () => {
    it('should work without KV (in-memory only)', async () => {
      const cache = new CacheRepository(undefined, undefined, {
        useInMemoryCache: true,
      });

      const fetchFn = vi.fn().mockResolvedValue(mockUserCore);

      // First fetch
      const result1 = await cache.getOrFetchUserCore('user-123', fetchFn);
      expect(result1).toEqual(mockUserCore);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Second fetch - hit in-memory
      const result2 = await cache.getOrFetchUserCore('user-123', fetchFn);
      expect(result2).toEqual(mockUserCore);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should invalidate without errors when KV not configured', async () => {
      const cache = new CacheRepository();

      // Should not throw
      await cache.invalidateUser('user-123');
      await cache.invalidateClient('client-456');

      expect(cache.getStats().invalidations).toBe(2);
    });
  });
});

describe('createCacheRepository', () => {
  it('should create cache with factory function', () => {
    const userCacheKV = createMockKV();
    const clientCacheKV = createMockKV();

    const cache = createCacheRepository(userCacheKV, clientCacheKV, {
      defaultTtlSeconds: 600,
    });

    expect(cache).toBeInstanceOf(CacheRepository);
  });
});

describe('Constants', () => {
  it('should export default cache config', () => {
    expect(DEFAULT_CACHE_CONFIG).toEqual({
      defaultTtlSeconds: 300,
      piiTtlSeconds: 60,
      useInMemoryCache: true,
      inMemoryCacheTtlMs: 10_000,
    });
  });

  it('should export cache key prefixes', () => {
    expect(CACHE_KEY_PREFIX).toEqual({
      USER_CORE: 'user:',
      USER_PII: 'pii:',
      CLIENT: 'client:',
      SESSION: 'session:',
    });
  });
});

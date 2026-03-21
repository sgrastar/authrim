import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getJwksWithCache,
  getKeyByKid,
  getVerificationKey,
  invalidateJwksCache,
  getJwksCacheStatus,
} from '../jwks-cache';
import type { Env } from '../../types/env';
import type { JWK } from 'jose';

/**
 * Test suite for Hierarchical JWKS Cache Manager (per-tenant)
 *
 * Tests the 3-tier caching strategy:
 * 1. In-memory cache (per-isolate, per-tenant)
 * 2. KV cache (shared across Workers, per-tenant)
 * 3. KeyManager DO (authoritative source, per-tenant)
 */

const TEST_TENANT = 'test-tenant';
const OTHER_TENANT = 'other-tenant';

// Mock JWKs for testing
const mockJwk1: JWK = {
  kty: 'RSA',
  kid: 'key-1',
  n: 'test-n-value',
  e: 'AQAB',
  alg: 'RS256',
  use: 'sig',
};

const mockJwk2: JWK = {
  kty: 'RSA',
  kid: 'key-2',
  n: 'test-n-value-2',
  e: 'AQAB',
  alg: 'RS256',
  use: 'sig',
};

// Helper to create mock environment
function createMockEnv(
  options: {
    kvKeys?: JWK[];
    doKeys?: JWK[];
    envJwk?: JWK;
    kvThrows?: boolean;
    doThrows?: boolean;
    keyVersion?: string;
  } = {}
): Env {
  const { kvKeys, doKeys, envJwk, kvThrows = false, doThrows = false, keyVersion = '' } = options;

  const mockKV = {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (kvThrows) throw new Error('KV error');
      if (key.startsWith('v1:key-version:')) return keyVersion;
      return kvKeys ?? null;
    }),
    put: vi.fn().mockResolvedValue(undefined),
  };

  const mockKeyManager = {
    idFromName: vi.fn().mockReturnValue('mock-id'),
    get: vi.fn().mockReturnValue({
      getAllPublicKeysRpc: vi.fn().mockImplementation(async () => {
        if (doThrows) throw new Error('DO error');
        return doKeys ?? [];
      }),
    }),
  };

  return {
    AUTHRIM_CONFIG: mockKV as unknown as KVNamespace,
    KEY_MANAGER: mockKeyManager as unknown as DurableObjectNamespace,
    PUBLIC_JWK_JSON: envJwk ? JSON.stringify(envJwk) : undefined,
  } as Env;
}

describe('JWKS Cache', () => {
  beforeEach(() => {
    // Clear in-memory cache for all tenants before each test
    invalidateJwksCache();
    vi.clearAllMocks();
  });

  describe('getJwksWithCache', () => {
    describe('cache hierarchy', () => {
      it('should fetch from KeyManager DO and cache in memory and KV', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1, mockJwk2] });

        const result = await getJwksWithCache(env, TEST_TENANT);

        expect(result.keys).toHaveLength(2);
        expect(result.source).toBe('do');
        expect(result.keys[0].kid).toBe('key-1');

        // Verify KV was updated with tenant-scoped key
        expect(env.AUTHRIM_CONFIG!.put).toHaveBeenCalledWith(
          `cache:jwks:${TEST_TENANT}`,
          expect.stringContaining('"version":""'),
          expect.objectContaining({ expirationTtl: 60 })
        );
      });

      it('should return from KV cache if available', async () => {
        const env = createMockEnv({ kvKeys: [mockJwk1] });

        const result = await getJwksWithCache(env, TEST_TENANT);

        expect(result.keys).toHaveLength(1);
        expect(result.source).toBe('kv');
        // DO should not be called
        expect(env.KEY_MANAGER.get).not.toHaveBeenCalled();
      });

      it('should use in-memory cache on subsequent calls for same tenant', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1] });

        // First call - fetches from DO
        const result1 = await getJwksWithCache(env, TEST_TENANT);
        expect(result1.source).toBe('do');

        // Second call - should use memory cache (no extra KV call)
        const result2 = await getJwksWithCache(env, TEST_TENANT);
        expect(result2.source).toBe('do'); // Source preserved from first call

        // KeyManager should only be queried once for the same tenant
        expect(env.KEY_MANAGER.get).toHaveBeenCalledTimes(1);
      });

      it('should keep separate caches for different tenants', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1] });

        await getJwksWithCache(env, TEST_TENANT);
        await getJwksWithCache(env, OTHER_TENANT);

        // KeyManager should be queried once per tenant
        expect(env.KEY_MANAGER.get).toHaveBeenCalledTimes(2);
        // KV key should be different for each tenant
        expect(env.AUTHRIM_CONFIG!.get).toHaveBeenCalledWith(
          `cache:jwks:${TEST_TENANT}`,
          expect.any(Object)
        );
        expect(env.AUTHRIM_CONFIG!.get).toHaveBeenCalledWith(
          `cache:jwks:${OTHER_TENANT}`,
          expect.any(Object)
        );
      });

      it('should fetch from correct tenant DO instance', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1] });

        await getJwksWithCache(env, TEST_TENANT);

        expect(env.KEY_MANAGER.idFromName).toHaveBeenCalledWith(`${TEST_TENANT}-v3`);
      });

      it('should refresh in-memory cache when key version changes', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1], keyVersion: 'v1' });
        const kvGet = env.AUTHRIM_CONFIG!.get as unknown as ReturnType<typeof vi.fn>;

        await getJwksWithCache(env, TEST_TENANT);
        kvGet.mockImplementation(async (key: string) => {
          if (key.startsWith('v1:key-version:')) return 'v2';
          return null;
        });

        await getJwksWithCache(env, TEST_TENANT);

        expect(env.KEY_MANAGER.get).toHaveBeenCalledTimes(2);
      });

      it('should fallback to env variable if DO fails', async () => {
        const env = createMockEnv({ doThrows: true, envJwk: mockJwk1 });

        const result = await getJwksWithCache(env, TEST_TENANT);

        expect(result.keys).toHaveLength(1);
        expect(result.source).toBe('env');
        expect(result.keys[0].kid).toBe('key-1');
      });

      it('should fallback to DO if KV fails', async () => {
        const env = createMockEnv({ kvThrows: true, doKeys: [mockJwk1] });

        const result = await getJwksWithCache(env, TEST_TENANT);

        expect(result.keys).toHaveLength(1);
        expect(result.source).toBe('do');
      });

      it('should return empty array if all sources fail', async () => {
        const env = createMockEnv({ doThrows: true });

        const result = await getJwksWithCache(env, TEST_TENANT);

        expect(result.keys).toHaveLength(0);
      });
    });

    describe('configuration', () => {
      it('should use custom KV cache key', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1] });

        await getJwksWithCache(env, TEST_TENANT, { kvCacheKey: 'custom:jwks' });

        expect(env.AUTHRIM_CONFIG!.get).toHaveBeenCalledWith('custom:jwks', expect.any(Object));
        expect(env.AUTHRIM_CONFIG!.put).toHaveBeenCalledWith(
          'custom:jwks',
          expect.any(String),
          expect.any(Object)
        );
      });

      it('should use custom KV TTL', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1] });

        await getJwksWithCache(env, TEST_TENANT, { kvTtlSeconds: 120 });

        expect(env.AUTHRIM_CONFIG!.put).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.objectContaining({ expirationTtl: 120 })
        );
      });

      it('should skip env fallback when disabled', async () => {
        const env = createMockEnv({ doThrows: true, envJwk: mockJwk1 });

        const result = await getJwksWithCache(env, TEST_TENANT, { useEnvFallback: false });

        expect(result.keys).toHaveLength(0);
      });
    });
  });

  describe('getKeyByKid', () => {
    it('should find key by kid', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1, mockJwk2] });

      const key = await getKeyByKid(env, TEST_TENANT, 'key-2');

      expect(key).toBeDefined();
      expect(key?.kid).toBe('key-2');
    });

    it('should return undefined if kid not found', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1] });

      const key = await getKeyByKid(env, TEST_TENANT, 'non-existent');

      expect(key).toBeUndefined();
    });

    it('should return first key if no kid specified', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1, mockJwk2] });

      const key = await getKeyByKid(env, TEST_TENANT, undefined);

      expect(key).toBeDefined();
      expect(key?.kid).toBe('key-1');
    });
  });

  describe('invalidateJwksCache', () => {
    it('should clear in-memory cache for specific tenant', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1] });

      // Populate caches for both tenants
      await getJwksWithCache(env, TEST_TENANT);
      await getJwksWithCache(env, OTHER_TENANT);
      expect(getJwksCacheStatus(TEST_TENANT)).not.toBeNull();
      expect(getJwksCacheStatus(OTHER_TENANT)).not.toBeNull();

      // Invalidate only TEST_TENANT
      invalidateJwksCache(TEST_TENANT);

      expect(getJwksCacheStatus(TEST_TENANT)).toBeNull();
      expect(getJwksCacheStatus(OTHER_TENANT)).not.toBeNull();
    });

    it('should clear all caches when called without tenantId', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1] });

      await getJwksWithCache(env, TEST_TENANT);
      await getJwksWithCache(env, OTHER_TENANT);

      invalidateJwksCache();

      expect(getJwksCacheStatus(TEST_TENANT)).toBeNull();
      expect(getJwksCacheStatus(OTHER_TENANT)).toBeNull();
    });

    it('should force fresh fetch after invalidation', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1] });

      // Populate cache
      await getJwksWithCache(env, TEST_TENANT);

      // Invalidate
      invalidateJwksCache(TEST_TENANT);

      // Next call should fetch fresh
      await getJwksWithCache(env, TEST_TENANT);

      // KeyManager should be queried twice (once before and once after invalidation)
      expect(env.KEY_MANAGER.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('getJwksCacheStatus', () => {
    it('should return null when cache is empty for tenant', () => {
      expect(getJwksCacheStatus(TEST_TENANT)).toBeNull();
    });

    it('should return status when cache is populated', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1, mockJwk2] });
      await getJwksWithCache(env, TEST_TENANT);

      const status = getJwksCacheStatus(TEST_TENANT);

      expect(status).not.toBeNull();
      expect(status?.keyCount).toBe(2);
      expect(status?.source).toBe('do');
      expect(status?.expiresIn).toBeGreaterThan(0);
    });

    it('should return null for different tenant even if one is populated', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1] });
      await getJwksWithCache(env, TEST_TENANT);

      expect(getJwksCacheStatus(OTHER_TENANT)).toBeNull();
    });
  });

  describe('getVerificationKey', () => {
    it('should return undefined if key not found', async () => {
      const env = createMockEnv({ doKeys: [] });

      const key = await getVerificationKey(env, TEST_TENANT, 'non-existent');

      expect(key).toBeUndefined();
    });

    // Note: Full importJWK testing requires valid JWK with proper key material
    // which is complex to mock. The function is tested via integration tests.
  });
});

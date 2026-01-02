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
 * Test suite for Hierarchical JWKS Cache Manager
 *
 * Tests the 3-tier caching strategy:
 * 1. In-memory cache (per-isolate)
 * 2. KV cache (shared across Workers)
 * 3. KeyManager DO (authoritative source)
 */

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
  } = {}
): Env {
  const { kvKeys, doKeys, envJwk, kvThrows = false, doThrows = false } = options;

  const mockKV = {
    get: vi.fn().mockImplementation(async () => {
      if (kvThrows) throw new Error('KV error');
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
    // Clear in-memory cache before each test
    invalidateJwksCache();
    vi.clearAllMocks();
  });

  describe('getJwksWithCache', () => {
    describe('cache hierarchy', () => {
      it('should fetch from KeyManager DO and cache in memory and KV', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1, mockJwk2] });

        const result = await getJwksWithCache(env);

        expect(result.keys).toHaveLength(2);
        expect(result.source).toBe('do');
        expect(result.keys[0].kid).toBe('key-1');

        // Verify KV was updated
        expect(env.AUTHRIM_CONFIG!.put).toHaveBeenCalledWith(
          'cache:jwks',
          expect.any(String),
          expect.objectContaining({ expirationTtl: 60 })
        );
      });

      it('should return from KV cache if available', async () => {
        const env = createMockEnv({ kvKeys: [mockJwk1] });

        const result = await getJwksWithCache(env);

        expect(result.keys).toHaveLength(1);
        expect(result.source).toBe('kv');
        // DO should not be called
        expect(env.KEY_MANAGER.get).not.toHaveBeenCalled();
      });

      it('should use in-memory cache on subsequent calls', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1] });

        // First call - fetches from DO
        const result1 = await getJwksWithCache(env);
        expect(result1.source).toBe('do');

        // Second call - should use memory cache
        const result2 = await getJwksWithCache(env);
        expect(result2.source).toBe('do'); // Source preserved from first call

        // KV should only be checked once
        expect(env.AUTHRIM_CONFIG!.get).toHaveBeenCalledTimes(1);
      });

      it('should fallback to env variable if DO fails', async () => {
        const env = createMockEnv({ doThrows: true, envJwk: mockJwk1 });

        const result = await getJwksWithCache(env);

        expect(result.keys).toHaveLength(1);
        expect(result.source).toBe('env');
        expect(result.keys[0].kid).toBe('key-1');
      });

      it('should fallback to DO if KV fails', async () => {
        const env = createMockEnv({ kvThrows: true, doKeys: [mockJwk1] });

        const result = await getJwksWithCache(env);

        expect(result.keys).toHaveLength(1);
        expect(result.source).toBe('do');
      });

      it('should return empty array if all sources fail', async () => {
        const env = createMockEnv({ doThrows: true });

        const result = await getJwksWithCache(env);

        expect(result.keys).toHaveLength(0);
      });
    });

    describe('configuration', () => {
      it('should use custom KV cache key', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1] });

        await getJwksWithCache(env, { kvCacheKey: 'custom:jwks' });

        expect(env.AUTHRIM_CONFIG!.get).toHaveBeenCalledWith('custom:jwks', expect.any(Object));
        expect(env.AUTHRIM_CONFIG!.put).toHaveBeenCalledWith(
          'custom:jwks',
          expect.any(String),
          expect.any(Object)
        );
      });

      it('should use custom KV TTL', async () => {
        const env = createMockEnv({ doKeys: [mockJwk1] });

        await getJwksWithCache(env, { kvTtlSeconds: 120 });

        expect(env.AUTHRIM_CONFIG!.put).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          expect.objectContaining({ expirationTtl: 120 })
        );
      });

      it('should skip env fallback when disabled', async () => {
        const env = createMockEnv({ doThrows: true, envJwk: mockJwk1 });

        const result = await getJwksWithCache(env, { useEnvFallback: false });

        expect(result.keys).toHaveLength(0);
      });
    });
  });

  describe('getKeyByKid', () => {
    it('should find key by kid', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1, mockJwk2] });

      const key = await getKeyByKid(env, 'key-2');

      expect(key).toBeDefined();
      expect(key?.kid).toBe('key-2');
    });

    it('should return undefined if kid not found', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1] });

      const key = await getKeyByKid(env, 'non-existent');

      expect(key).toBeUndefined();
    });

    it('should return first key if no kid specified', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1, mockJwk2] });

      const key = await getKeyByKid(env, undefined);

      expect(key).toBeDefined();
      expect(key?.kid).toBe('key-1');
    });
  });

  describe('invalidateJwksCache', () => {
    it('should clear in-memory cache', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1] });

      // Populate cache
      await getJwksWithCache(env);
      expect(getJwksCacheStatus()).not.toBeNull();

      // Invalidate
      invalidateJwksCache();

      expect(getJwksCacheStatus()).toBeNull();
    });

    it('should force fresh fetch after invalidation', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1] });

      // Populate cache
      await getJwksWithCache(env);

      // Invalidate
      invalidateJwksCache();

      // Next call should fetch fresh
      await getJwksWithCache(env);

      // KV should be checked twice (once for each call after invalidation)
      expect(env.AUTHRIM_CONFIG!.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('getJwksCacheStatus', () => {
    it('should return null when cache is empty', () => {
      expect(getJwksCacheStatus()).toBeNull();
    });

    it('should return status when cache is populated', async () => {
      const env = createMockEnv({ doKeys: [mockJwk1, mockJwk2] });
      await getJwksWithCache(env);

      const status = getJwksCacheStatus();

      expect(status).not.toBeNull();
      expect(status?.keyCount).toBe(2);
      expect(status?.source).toBe('do');
      expect(status?.expiresIn).toBeGreaterThan(0);
    });
  });

  describe('getVerificationKey', () => {
    it('should return undefined if key not found', async () => {
      const env = createMockEnv({ doKeys: [] });

      const key = await getVerificationKey(env, 'non-existent');

      expect(key).toBeUndefined();
    });

    // Note: Full importJWK testing requires valid JWK with proper key material
    // which is complex to mock. The function is tested via integration tests.
  });
});

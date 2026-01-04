/**
 * Hierarchical JWKS Cache Manager
 *
 * Implements 3-tier caching for JWKS (JSON Web Key Set):
 * 1. In-memory cache (fastest, per Worker isolate)
 * 2. KV cache (shared across Workers)
 * 3. KeyManager DO (authoritative source)
 *
 * Features:
 * - Environment variable fallback (PUBLIC_JWK_JSON)
 * - Key rotation support with cache invalidation
 * - Configurable TTLs
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7517
 */

import { importJWK, type JWK } from 'jose';
import type { Env } from '../types/env';
import { createLogger } from './logger';

const log = createLogger().module('JWKS');

/**
 * JWKS cache configuration options
 */
export interface JWKSCacheConfig {
  /** In-memory cache TTL in milliseconds (default: 5 minutes) */
  inMemoryTtlMs?: number;
  /** KV cache TTL in seconds (default: 60 seconds - shorter for key rotation) */
  kvTtlSeconds?: number;
  /** KV cache key (default: 'cache:jwks') */
  kvCacheKey?: string;
  /** Use environment variable fallback for PUBLIC_JWK_JSON (default: true) */
  useEnvFallback?: boolean;
}

/**
 * JWKS cache result with source information
 */
export interface JWKSCacheResult {
  /** Array of JWK keys */
  keys: JWK[];
  /** Source of the keys for debugging/monitoring */
  source: 'memory' | 'kv' | 'do' | 'env';
}

// Default configuration values
const DEFAULT_IN_MEMORY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_KV_TTL_SECONDS = 60; // 1 minute (shorter to allow key rotation)
const DEFAULT_KV_CACHE_KEY = 'cache:jwks';

// Module-level cache (per Worker isolate)
// This is intentionally a global variable to persist across requests within the same isolate
let jwksCache: {
  keys: JWK[];
  expiry: number;
  source: 'memory' | 'kv' | 'do' | 'env';
} | null = null;

/**
 * Get JWKS with hierarchical caching
 *
 * Cache hierarchy:
 * 1. In-memory cache - Fastest, per-isolate, 5-minute TTL
 * 2. KV cache - Shared across Workers, 1-minute TTL
 * 3. KeyManager DO - Authoritative source, singleton
 * 4. Environment variable fallback - PUBLIC_JWK_JSON
 *
 * @param env - Cloudflare Workers environment bindings
 * @param config - Optional cache configuration
 * @returns JWKS keys and their source
 *
 * @example
 * ```typescript
 * const { keys, source } = await getJwksWithCache(env);
 * console.log(`Got ${keys.length} keys from ${source}`);
 * ```
 */
export async function getJwksWithCache(
  env: Env,
  config: JWKSCacheConfig = {}
): Promise<JWKSCacheResult> {
  const {
    inMemoryTtlMs = DEFAULT_IN_MEMORY_TTL_MS,
    kvTtlSeconds = DEFAULT_KV_TTL_SECONDS,
    kvCacheKey = DEFAULT_KV_CACHE_KEY,
    useEnvFallback = true,
  } = config;

  const now = Date.now();

  // 1. Check in-memory cache (fastest path)
  if (jwksCache && jwksCache.expiry > now) {
    return { keys: jwksCache.keys, source: jwksCache.source };
  }

  // 2. Check KV cache (shared across Worker instances)
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvCached = await env.AUTHRIM_CONFIG.get<JWK[]>(kvCacheKey, { type: 'json' });
      if (kvCached && Array.isArray(kvCached) && kvCached.length > 0) {
        // Update in-memory cache from KV
        jwksCache = { keys: kvCached, expiry: now + inMemoryTtlMs, source: 'kv' };
        return { keys: kvCached, source: 'kv' };
      }
    } catch {
      // KV read failed, continue to next source
    }
  }

  // 3. Fetch from KeyManager DO (singleton, authoritative source)
  if (env.KEY_MANAGER) {
    try {
      const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
      const keyManager = env.KEY_MANAGER.get(keyManagerId);
      const keys = await keyManager.getAllPublicKeysRpc();

      if (keys && keys.length > 0) {
        // Update in-memory cache
        jwksCache = { keys, expiry: now + inMemoryTtlMs, source: 'do' };

        // Update KV cache (fire-and-forget, non-blocking)
        if (env.AUTHRIM_CONFIG) {
          env.AUTHRIM_CONFIG.put(kvCacheKey, JSON.stringify(keys), {
            expirationTtl: kvTtlSeconds,
          }).catch(() => {
            // Ignore KV write errors - not critical
          });
        }

        return { keys, source: 'do' };
      }
    } catch (error) {
      log.error('Failed to get JWKS from KeyManager', {}, error as Error);
      // Continue to fallback
    }
  }

  // 4. Environment variable fallback (PUBLIC_JWK_JSON)
  if (useEnvFallback && env.PUBLIC_JWK_JSON) {
    try {
      const jwk = JSON.parse(env.PUBLIC_JWK_JSON) as JWK;
      const keys = [jwk];
      // Cache env fallback with shorter TTL since it's less reliable
      jwksCache = { keys, expiry: now + inMemoryTtlMs, source: 'env' };
      return { keys, source: 'env' };
    } catch {
      log.error('Failed to parse PUBLIC_JWK_JSON');
    }
  }

  // No keys available
  return { keys: [], source: 'do' };
}

/**
 * Get a specific key by kid from cached JWKS
 *
 * @param env - Cloudflare Workers environment bindings
 * @param kid - Key ID to search for (optional - returns first key if not specified)
 * @param config - Optional cache configuration
 * @returns JWK if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const header = decodeProtectedHeader(token);
 * const jwk = await getKeyByKid(env, header.kid);
 * if (jwk) {
 *   const publicKey = await importJWK(jwk, 'RS256');
 * }
 * ```
 */
export async function getKeyByKid(
  env: Env,
  kid: string | undefined,
  config: JWKSCacheConfig = {}
): Promise<JWK | undefined> {
  const { keys } = await getJwksWithCache(env, config);

  if (kid) {
    return keys.find((k) => k.kid === kid);
  }

  // Return first key if no kid specified (backward compatibility)
  return keys[0];
}

/**
 * Get CryptoKey for verification with caching
 *
 * Convenience function that combines getKeyByKid and importJWK.
 *
 * @param env - Cloudflare Workers environment bindings
 * @param kid - Key ID to search for (optional)
 * @param algorithm - JWA algorithm (default: 'RS256')
 * @param config - Optional cache configuration
 * @returns CryptoKey for verification, undefined if key not found
 *
 * @example
 * ```typescript
 * const header = decodeProtectedHeader(token);
 * const publicKey = await getVerificationKey(env, header.kid);
 * if (publicKey) {
 *   await verifyToken(token, publicKey, issuer);
 * }
 * ```
 */
export async function getVerificationKey(
  env: Env,
  kid: string | undefined,
  algorithm: string = 'RS256',
  config: JWKSCacheConfig = {}
): Promise<CryptoKey | undefined> {
  const jwk = await getKeyByKid(env, kid, config);
  if (!jwk) return undefined;

  try {
    return (await importJWK(jwk, algorithm)) as CryptoKey;
  } catch (error) {
    log.error('Failed to import JWK', {}, error as Error);
    return undefined;
  }
}

/**
 * Invalidate the in-memory cache
 *
 * Call this when key rotation is detected or when you need to force
 * a fresh fetch from KeyManager DO.
 *
 * Note: This only invalidates the local in-memory cache.
 * KV cache will expire based on its TTL.
 *
 * @example
 * ```typescript
 * // After detecting a key rotation event
 * invalidateJwksCache();
 * const { keys } = await getJwksWithCache(env); // Will fetch fresh keys
 * ```
 */
export function invalidateJwksCache(): void {
  jwksCache = null;
}

/**
 * Get current cache status for debugging/monitoring
 *
 * @returns Current cache state or null if empty
 */
export function getJwksCacheStatus(): {
  keyCount: number;
  expiresIn: number;
  source: 'memory' | 'kv' | 'do' | 'env';
} | null {
  if (!jwksCache) return null;

  const now = Date.now();
  return {
    keyCount: jwksCache.keys.length,
    expiresIn: Math.max(0, jwksCache.expiry - now),
    source: jwksCache.source,
  };
}

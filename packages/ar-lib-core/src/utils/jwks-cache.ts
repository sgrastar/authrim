/**
 * Hierarchical JWKS Cache Manager
 *
 * Implements 3-tier caching for JWKS (JSON Web Key Set):
 * 1. In-memory cache (fastest, per Worker isolate, per tenant)
 * 2. KV cache (shared across Workers, per tenant)
 * 3. KeyManager DO (authoritative source, per tenant)
 *
 * Features:
 * - Per-tenant isolation: all cache keys are scoped to tenantId
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
  /**
   * Override KV cache key prefix (default: 'cache:jwks').
   * The effective KV key is `${kvCacheKey}:${tenantId}` unless explicitly overridden.
   */
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

// Module-level per-tenant cache (per Worker isolate)
// Map key is tenantId, value is the cached JWKS entry
type JwksCacheEntry = {
  keys: JWK[];
  expiry: number;
  source: 'memory' | 'kv' | 'do' | 'env';
  version: string;
};

const jwksCacheMap = new Map<string, JwksCacheEntry>();

type CachedJwksRecord = {
  keys: JWK[];
  version?: string;
};

async function getKeyVersion(env: Env, tenantId: string): Promise<string> {
  return (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';
}

/**
 * Get JWKS with hierarchical caching (per tenant)
 *
 * Cache hierarchy:
 * 1. In-memory cache - Fastest, per-isolate per-tenant, 5-minute TTL
 * 2. KV cache - Shared across Workers, per-tenant, 1-minute TTL
 * 3. KeyManager DO - Authoritative source, per tenant (${tenantId}-v3)
 * 4. Environment variable fallback - PUBLIC_JWK_JSON
 *
 * @param env - Cloudflare Workers environment bindings
 * @param tenantId - Tenant ID for isolation
 * @param config - Optional cache configuration
 * @returns JWKS keys and their source
 */
export async function getJwksWithCache(
  env: Env,
  tenantId: string,
  config: JWKSCacheConfig = {}
): Promise<JWKSCacheResult> {
  const {
    inMemoryTtlMs = DEFAULT_IN_MEMORY_TTL_MS,
    kvTtlSeconds = DEFAULT_KV_TTL_SECONDS,
    useEnvFallback = true,
  } = config;
  // Effective KV key: use explicit override, or default per-tenant key
  const kvCacheKey = config.kvCacheKey ?? `${DEFAULT_KV_CACHE_KEY}:${tenantId}`;

  const now = Date.now();
  const currentVersion = await getKeyVersion(env, tenantId);

  // 1. Check in-memory cache (fastest path)
  const cached = jwksCacheMap.get(tenantId);
  if (cached && cached.expiry > now && cached.version === currentVersion) {
    return { keys: cached.keys, source: cached.source };
  }
  if (cached && cached.version !== currentVersion) {
    jwksCacheMap.delete(tenantId);
  }

  // 2. Check KV cache (shared across Worker instances)
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvCached = await env.AUTHRIM_CONFIG.get<JWK[] | CachedJwksRecord>(kvCacheKey, {
        type: 'json',
      });
      const kvKeys = Array.isArray(kvCached) ? kvCached : kvCached?.keys;
      const kvVersion = Array.isArray(kvCached) ? '' : (kvCached?.version ?? '');

      if (kvKeys && Array.isArray(kvKeys) && kvKeys.length > 0 && kvVersion === currentVersion) {
        // Update in-memory cache from KV
        jwksCacheMap.set(tenantId, {
          keys: kvKeys,
          expiry: now + inMemoryTtlMs,
          source: 'kv',
          version: currentVersion,
        });
        return { keys: kvKeys, source: 'kv' };
      }
    } catch {
      // KV read failed, continue to next source
    }
  }

  // 3. Fetch from KeyManager DO — per-tenant (${tenantId}-v3)
  if (env.KEY_MANAGER) {
    try {
      const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
      const keyManager = env.KEY_MANAGER.get(keyManagerId);
      const keys = await keyManager.getAllPublicKeysRpc();

      if (keys && keys.length > 0) {
        // Update in-memory cache
        jwksCacheMap.set(tenantId, {
          keys,
          expiry: now + inMemoryTtlMs,
          source: 'do',
          version: currentVersion,
        });

        // Update KV cache (fire-and-forget, non-blocking)
        if (env.AUTHRIM_CONFIG) {
          env.AUTHRIM_CONFIG.put(
            kvCacheKey,
            JSON.stringify({ keys, version: currentVersion } satisfies CachedJwksRecord),
            {
              expirationTtl: kvTtlSeconds,
            }
          ).catch(() => {
            // Ignore KV write errors - not critical
          });
        }

        return { keys, source: 'do' };
      }
    } catch (error) {
      log.error('Failed to get JWKS from KeyManager', { tenantId }, error as Error);
      // Continue to fallback
    }
  }

  // 4. Environment variable fallback (PUBLIC_JWK_JSON)
  if (useEnvFallback && env.PUBLIC_JWK_JSON) {
    try {
      const jwk = JSON.parse(env.PUBLIC_JWK_JSON) as JWK;
      const keys = [jwk];
      // Cache env fallback with shorter TTL since it's less reliable
      jwksCacheMap.set(tenantId, {
        keys,
        expiry: now + inMemoryTtlMs,
        source: 'env',
        version: currentVersion,
      });
      return { keys, source: 'env' };
    } catch {
      log.error('Failed to parse PUBLIC_JWK_JSON');
    }
  }

  // No keys available
  return { keys: [], source: 'do' };
}

/**
 * Get a specific key by kid from cached JWKS (per tenant)
 *
 * @param env - Cloudflare Workers environment bindings
 * @param tenantId - Tenant ID for isolation
 * @param kid - Key ID to search for (optional - returns first key if not specified)
 * @param config - Optional cache configuration
 * @returns JWK if found, undefined otherwise
 */
export async function getKeyByKid(
  env: Env,
  tenantId: string,
  kid: string | undefined,
  config: JWKSCacheConfig = {}
): Promise<JWK | undefined> {
  const { keys } = await getJwksWithCache(env, tenantId, config);

  if (kid) {
    return keys.find((k) => k.kid === kid);
  }

  // Return first key if no kid specified
  return keys[0];
}

/**
 * Get CryptoKey for verification with caching (per tenant)
 *
 * @param env - Cloudflare Workers environment bindings
 * @param tenantId - Tenant ID for isolation
 * @param kid - Key ID to search for (optional)
 * @param algorithm - JWA algorithm (default: 'RS256')
 * @param config - Optional cache configuration
 * @returns CryptoKey for verification, undefined if key not found
 */
export async function getVerificationKey(
  env: Env,
  tenantId: string,
  kid: string | undefined,
  algorithm: string = 'RS256',
  config: JWKSCacheConfig = {}
): Promise<CryptoKey | undefined> {
  const jwk = await getKeyByKid(env, tenantId, kid, config);
  if (!jwk) return undefined;

  try {
    return (await importJWK(jwk, algorithm)) as CryptoKey;
  } catch (error) {
    log.error('Failed to import JWK', {}, error as Error);
    return undefined;
  }
}

/**
 * Fetch a public key directly from the KeyManager DO by kid (per tenant).
 *
 * Unlike getVerificationKey, this bypasses the in-memory / KV cache and
 * always goes to the authoritative source. Use this for token verification
 * where cache staleness would be a security risk.
 *
 * @param env - Cloudflare Workers environment bindings
 * @param tenantId - Tenant ID for isolation
 * @param kid - Key ID to look up
 * @returns CryptoKey if found, null otherwise
 */
export async function getPublicKeyByKid(
  env: Env,
  tenantId: string,
  kid: string
): Promise<CryptoKey | null> {
  if (!env.KEY_MANAGER) return null;

  try {
    const km = env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
    const keys = await km.getAllPublicKeysRpc().catch(() => [] as JWK[]);
    const jwk = keys.find((k) => k.kid === kid);
    if (!jwk) return null;
    return (await importJWK(jwk, (jwk.alg as string) || 'RS256')) as CryptoKey;
  } catch (error) {
    log.error('Failed to get public key from KeyManager', { tenantId, kid }, error as Error);
    return null;
  }
}

function requireTenantId(tenantId: string, context: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

/**
 * Invalidate the in-memory JWKS cache for a specific tenant.
 *
 * @param tenantId - Tenant to invalidate
 */
export function invalidateJwksCache(tenantId: string): void {
  jwksCacheMap.delete(requireTenantId(tenantId, 'invalidateJwksCache'));
}

/**
 * Invalidate all in-memory JWKS tenant caches.
 *
 * Use only for explicit platform/system-wide key maintenance.
 */
export function invalidateAllJwksCaches(): void {
  jwksCacheMap.clear();
}

/**
 * Get current cache status for a specific tenant (for debugging/monitoring)
 *
 * @param tenantId - Tenant ID to check
 * @returns Current cache state or null if empty
 */
export function getJwksCacheStatus(tenantId: string): {
  keyCount: number;
  expiresIn: number;
  source: 'memory' | 'kv' | 'do' | 'env';
} | null {
  const cached = jwksCacheMap.get(tenantId);
  if (!cached) return null;

  const now = Date.now();
  return {
    keyCount: cached.keys.length,
    expiresIn: Math.max(0, cached.expiry - now),
    source: cached.source,
  };
}

/**
 * Cache Configuration Utilities
 *
 * Provides cache mode management and TTL configuration for KV caching optimization.
 * Supports two modes:
 * - maintenance: Short TTL (30s) for development and client setting changes
 * - fixed: Long TTL for production use
 *
 * Key features:
 * - KV key versioning (v1:) for schema migration support
 * - Client-specific, platform-level, and default cache mode hierarchy
 * - Data type-specific TTL settings
 *
 * @see P0 KV Cache Optimization Plan
 */

import type { Env } from '../types/env';

// =============================================================================
// Types
// =============================================================================

/**
 * Cache mode for controlling TTL behavior
 * - maintenance: Short TTL (30s) for development/changes
 * - fixed: Long TTL for production
 */
export type CacheMode = 'maintenance' | 'fixed';

/**
 * TTL configuration for different data types (in seconds)
 */
export interface CacheTTLConfig {
  /** OIDC client metadata basic fields */
  clientMetadata: number;
  /** Client redirect URIs (slightly shorter for security) */
  redirectUris: number;
  /** Client grant types */
  grantTypes: number;
  /** Client scopes */
  scopes: number;
  /** JWKS (JSON Web Key Set) */
  jwks: number;
  /** Client secret (short for security) */
  clientSecret: number;
  /** Tenant/organization data */
  tenant: number;
  /** Policy data (RBAC/ABAC - short for immediate reflection) */
  policy: number;
  /** Discovery metadata response cache */
  discovery: number;
}

// =============================================================================
// Constants
// =============================================================================

/** KV key version prefix for schema migration support */
export const KV_KEY_VERSION = 'v1';

/**
 * TTL configuration for fixed mode (production)
 * Values are in seconds
 */
export const FIXED_MODE_TTL: CacheTTLConfig = {
  clientMetadata: 86400, // 24 hours
  redirectUris: 43200, // 12 hours (shorter for security)
  grantTypes: 86400, // 24 hours
  scopes: 86400, // 24 hours
  jwks: 86400, // 24 hours
  clientSecret: 600, // 10 minutes (short for security)
  tenant: 1800, // 30 minutes
  policy: 300, // 5 minutes (short for immediate reflection)
  discovery: 300, // 5 minutes (balance freshness and performance)
};

/**
 * TTL configuration for maintenance mode (development/changes)
 * All values are 30 seconds for quick updates
 */
export const MAINTENANCE_MODE_TTL: CacheTTLConfig = {
  clientMetadata: 30,
  redirectUris: 30,
  grantTypes: 30,
  scopes: 30,
  jwks: 30,
  clientSecret: 30,
  tenant: 30,
  policy: 30,
  discovery: 30,
};

/** Default cache mode when not specified */
export const DEFAULT_CACHE_MODE: CacheMode = 'fixed';

// =============================================================================
// KV Key Types
// =============================================================================

/**
 * Type-safe KV key types for versioned keys
 * Used with buildVersionedKey() for IDE autocompletion
 */
export type KVKeyType =
  | 'client'
  | 'tenant-profile'
  | 'discovery'
  | 'cache-mode:client'
  | 'cache-mode:platform';

/**
 * Build a versioned KV key
 *
 * @param type - Key type (client, tenant-profile, cache-mode:*)
 * @param id - Optional identifier (clientId, tenantId)
 * @returns Versioned key string (e.g., "v1:client:abc123")
 *
 * @example
 * buildVersionedKey('client', 'abc123') // "v1:client:abc123"
 * buildVersionedKey('cache-mode:platform') // "v1:cache-mode:platform"
 */
export function buildVersionedKey(type: KVKeyType, id?: string): string {
  return id ? `${KV_KEY_VERSION}:${type}:${id}` : `${KV_KEY_VERSION}:${type}`;
}

// =============================================================================
// Cache Mode Functions
// =============================================================================

/**
 * Get the current cache mode
 *
 * Evaluation order:
 * 1. Client-specific mode (v1:cache-mode:client:{clientId})
 * 2. Platform-level mode (v1:cache-mode:platform)
 * 3. Environment variable (CACHE_MODE)
 * 4. Default (fixed)
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Optional client ID for client-specific mode lookup
 * @returns Cache mode ('maintenance' or 'fixed')
 */
export async function getCacheMode(env: Env, clientId?: string): Promise<CacheMode> {
  const kv = env.AUTHRIM_CONFIG;

  // 1. Check client-specific mode
  if (kv && clientId) {
    try {
      const clientModeKey = buildVersionedKey('cache-mode:client', clientId);
      const clientMode = await kv.get(clientModeKey);
      if (clientMode === 'maintenance' || clientMode === 'fixed') {
        return clientMode;
      }
    } catch {
      // Ignore KV errors, fall through to next level
    }
  }

  // 2. Check platform-level mode
  if (kv) {
    try {
      const platformModeKey = buildVersionedKey('cache-mode:platform');
      const platformMode = await kv.get(platformModeKey);
      if (platformMode === 'maintenance' || platformMode === 'fixed') {
        return platformMode;
      }
    } catch {
      // Ignore KV errors, fall through to env var
    }
  }

  // 3. Check environment variable (not in Env type yet, but allow for future)
  // This would be added to Env type if needed: CACHE_MODE?: string

  // 4. Default
  return DEFAULT_CACHE_MODE;
}

/**
 * Get TTL for a specific data type based on current cache mode
 *
 * @param env - Cloudflare environment bindings
 * @param dataType - Data type key from CacheTTLConfig
 * @param clientId - Optional client ID for client-specific mode lookup
 * @returns TTL in seconds
 *
 * @example
 * const ttl = await getCacheTTL(env, 'clientMetadata', 'client123');
 * // Returns 86400 (24h) in fixed mode, 30 in maintenance mode
 */
export async function getCacheTTL(
  env: Env,
  dataType: keyof CacheTTLConfig,
  clientId?: string
): Promise<number> {
  const mode = await getCacheMode(env, clientId);
  const ttlConfig = mode === 'maintenance' ? MAINTENANCE_MODE_TTL : FIXED_MODE_TTL;
  return ttlConfig[dataType];
}

/**
 * Get the full TTL config based on current cache mode
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Optional client ID for client-specific mode lookup
 * @returns Full TTL configuration object
 */
export async function getCacheTTLConfig(env: Env, clientId?: string): Promise<CacheTTLConfig> {
  const mode = await getCacheMode(env, clientId);
  return mode === 'maintenance' ? MAINTENANCE_MODE_TTL : FIXED_MODE_TTL;
}

// =============================================================================
// Cache Mode Management (Admin API)
// =============================================================================

/**
 * Set platform-level cache mode
 *
 * @param env - Cloudflare environment bindings
 * @param mode - Cache mode to set
 */
export async function setPlatformCacheMode(env: Env, mode: CacheMode): Promise<void> {
  const kv = env.AUTHRIM_CONFIG;
  if (!kv) {
    throw new Error('AUTHRIM_CONFIG KV namespace not available');
  }

  const key = buildVersionedKey('cache-mode:platform');
  await kv.put(key, mode);
}

/**
 * Set client-specific cache mode
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID
 * @param mode - Cache mode to set, or null to use platform default
 */
export async function setClientCacheMode(
  env: Env,
  clientId: string,
  mode: CacheMode | null
): Promise<void> {
  const kv = env.AUTHRIM_CONFIG;
  if (!kv) {
    throw new Error('AUTHRIM_CONFIG KV namespace not available');
  }

  const key = buildVersionedKey('cache-mode:client', clientId);

  if (mode === null) {
    await kv.delete(key);
  } else {
    await kv.put(key, mode);
  }
}

/**
 * Get client-specific cache mode (without fallback)
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID
 * @returns Client-specific mode, or null if not set
 */
export async function getClientCacheMode(env: Env, clientId: string): Promise<CacheMode | null> {
  const kv = env.AUTHRIM_CONFIG;
  if (!kv) {
    return null;
  }

  try {
    const key = buildVersionedKey('cache-mode:client', clientId);
    const mode = await kv.get(key);
    if (mode === 'maintenance' || mode === 'fixed') {
      return mode;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get platform-level cache mode (without fallback)
 *
 * @param env - Cloudflare environment bindings
 * @returns Platform mode, or null if not set
 */
export async function getPlatformCacheMode(env: Env): Promise<CacheMode | null> {
  const kv = env.AUTHRIM_CONFIG;
  if (!kv) {
    return null;
  }

  try {
    const key = buildVersionedKey('cache-mode:platform');
    const mode = await kv.get(key);
    if (mode === 'maintenance' || mode === 'fixed') {
      return mode;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Request-Scoped Cache Utilities
 *
 * Provides request-level caching using Hono's context to eliminate
 * redundant reads within a single request. This is different from
 * KV caching which persists across requests.
 *
 * Key benefits:
 * - Eliminates redundant reads (e.g., getClient 5 times → 1 time)
 * - No additional infrastructure cost
 * - Automatic cleanup when request ends
 *
 * @see P0 KV Cache Optimization Plan
 */

import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { ClientMetadata } from '../types/oidc';
import type { TenantProfile } from '../types/contracts/tenant-profile';
import type { ClientContract } from '../types/contracts';
import { createAuthContextFromHono } from '../context';
import { getClient } from './kv';
import { loadTenantProfile, loadTenantContract, loadClientContract } from './contract-loader';
import { getTenantProfile } from '../types/contracts/tenant-profile';
import { buildVersionedKey, getCacheTTL } from './cache-config';
import { buildKVKey } from './tenant-context';
import { getTenantSystemSettings } from './tenant-settings';

function getTenantIdFromRequestCacheContext(c: Context<{ Bindings: Env }>): string {
  // Hono's generic context type does not know about middleware-injected values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenantId = ((c as any).get?.('tenantId') as string | undefined)?.trim();
  if (!tenantId) {
    throw new Error('Request cache requires tenant context');
  }
  return tenantId;
}

// =============================================================================
// Types
// =============================================================================

/** Request cache key in Hono context */
const REQUEST_CACHE_KEY = 'authrim:request-cache';

/**
 * Cache statistics for observability (P1 feature)
 */
export interface RequestCacheStats {
  clientHit: number;
  clientMiss: number;
  tenantProfileHit: number;
  tenantProfileMiss: number;
  systemSettingsHit: number;
  systemSettingsMiss: number;
  clientContractHit: number;
  clientContractMiss: number;
  featureFlagsHit: number;
  featureFlagsMiss: number;
  tenantFeatureFlagsHit: number;
  tenantFeatureFlagsMiss: number;
}

/**
 * System settings structure (partial, for caching purposes)
 * The actual structure is complex and varies; we cache the raw JSON
 * This interface covers the commonly accessed settings for type safety
 */
export interface CachedSystemSettings {
  oidc?: {
    tokenExchange?: {
      enabled?: boolean;
      allowedTypes?: string[];
      allowedSubjectTokenTypes?: string[];
      maxResourceParams?: number;
      maxAudienceParams?: number;
      idJag?: {
        enabled?: boolean;
        allowedIssuers?: string[];
        maxTokenLifetime?: number;
        includeTenantClaim?: boolean;
        requireConfidentialClient?: boolean;
      };
    };
    clientCredentials?: {
      enabled?: boolean;
    };
    [key: string]: unknown;
  };
  fapi?: {
    profile?: string;
    enabled?: boolean;
    requireDpop?: boolean;
  };
  [key: string]: unknown;
}

/**
 * Tenant feature flags settings from Settings Manager
 * Key format: settings:tenant:{tenantId}:feature-flags
 */
export interface TenantFeatureFlags {
  /** Flow Engine enabled */
  'feature.enable_flow_engine'?: boolean;
  /** Other feature flags */
  [key: string]: boolean | undefined;
}

/**
 * Request-scoped cache structure
 */
interface RequestCache {
  /** Cached client metadata (tenantId:clientId → metadata or null) */
  clients: Map<string, ClientMetadata | null>;
  /** Cached tenant profiles (tenantId → profile) */
  tenantProfiles: Map<string, TenantProfile>;
  /** Cached client contracts (tenantId:clientId → contract or null) */
  clientContracts: Map<string, ClientContract | null>;
  /** Cached feature flags (flagName → value) - legacy format */
  featureFlags: Map<string, boolean>;
  /** Cached tenant feature flags (tenantId → settings) - Settings Manager format */
  tenantFeatureFlags: Map<string, TenantFeatureFlags | null>;
  /** Tenant feature flags fetched flags (to distinguish null from not-fetched) */
  tenantFeatureFlagsFetched: Set<string>;
  /** Cached system settings (single instance per request) */
  systemSettings: CachedSystemSettings | null;
  /** System settings fetched flag (to distinguish null value from not-fetched) */
  systemSettingsFetched: boolean;
  /** Cache statistics */
  stats: RequestCacheStats;
}

// =============================================================================
// Cache Access
// =============================================================================

/**
 * Get or create request-scoped cache from Hono context
 *
 * @param c - Hono context
 * @returns Request cache instance
 */
export function getRequestCache(c: Context<{ Bindings: Env }>): RequestCache {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = c as any;
  let cache = ctx.get(REQUEST_CACHE_KEY) as RequestCache | undefined;

  if (!cache) {
    cache = {
      clients: new Map(),
      tenantProfiles: new Map(),
      clientContracts: new Map(),
      featureFlags: new Map(),
      tenantFeatureFlags: new Map(),
      tenantFeatureFlagsFetched: new Set(),
      systemSettings: null,
      systemSettingsFetched: false,
      stats: {
        clientHit: 0,
        clientMiss: 0,
        tenantProfileHit: 0,
        tenantProfileMiss: 0,
        systemSettingsHit: 0,
        systemSettingsMiss: 0,
        clientContractHit: 0,
        clientContractMiss: 0,
        featureFlagsHit: 0,
        featureFlagsMiss: 0,
        tenantFeatureFlagsHit: 0,
        tenantFeatureFlagsMiss: 0,
      },
    };
    ctx.set(REQUEST_CACHE_KEY, cache);
  }

  return cache;
}

/**
 * Get cache statistics for the current request
 * Useful for debugging and observability
 *
 * @param c - Hono context
 * @returns Cache statistics
 */
export function getRequestCacheStats(c: Context<{ Bindings: Env }>): RequestCacheStats {
  const cache = getRequestCache(c);
  return { ...cache.stats };
}

// =============================================================================
// Cached Wrappers
// =============================================================================

/**
 * Get client metadata with request-level caching
 *
 * Wraps the original getClient() function to cache results within
 * the request scope. Multiple calls with the same clientId will
 * return the cached result instead of hitting KV/D1 again.
 *
 * @param c - Hono context
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID to retrieve
 * @returns Client metadata or null if not found
 *
 * @example
 * // First call: hits KV/D1
 * const client1 = await getClientCached(c, c.env, 'client123');
 * // Second call: returns cached result
 * const client2 = await getClientCached(c, c.env, 'client123');
 */
export async function getClientCached(
  c: Context<{ Bindings: Env }>,
  env: Env,
  clientId: string
): Promise<ClientMetadata | null> {
  const cache = getRequestCache(c);
  const authCtx = createAuthContextFromHono(c, getTenantIdFromRequestCacheContext(c));
  const cacheKey = `${authCtx.tenantId}:${clientId}`;

  // Check request-level cache
  if (cache.clients.has(cacheKey)) {
    cache.stats.clientHit++;
    return cache.clients.get(cacheKey) ?? null;
  }

  // Cache miss - fetch from KV/D1
  cache.stats.clientMiss++;
  const clientMetadata = await getClient(env, authCtx.tenantId, clientId, authCtx.coreAdapter);

  // Store in request cache (including null for not-found)
  cache.clients.set(cacheKey, clientMetadata);

  return clientMetadata;
}

/**
 * Load tenant profile with request-level caching
 *
 * Wraps the original loadTenantProfile() function to cache results
 * within the request scope.
 *
 * @param c - Hono context
 * @param kv - AUTHRIM_CONFIG KV namespace
 * @param env - Cloudflare environment bindings
 * @param tenantId - Tenant identifier
 * @returns Tenant profile (never null, defaults to human profile)
 *
 * @example
 * // First call: hits KV
 * const profile1 = await loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, 'tenant123');
 * // Second call: returns cached result
 * const profile2 = await loadTenantProfileCached(c, c.env.AUTHRIM_CONFIG, c.env, 'tenant123');
 */
export async function loadTenantProfileCached(
  c: Context<{ Bindings: Env }>,
  kv: KVNamespace | undefined,
  env: Env,
  tenantId: string
): Promise<TenantProfile> {
  const cache = getRequestCache(c);

  // Check request-level cache
  if (cache.tenantProfiles.has(tenantId)) {
    cache.stats.tenantProfileHit++;
    return cache.tenantProfiles.get(tenantId)!;
  }

  // Cache miss - fetch from KV
  cache.stats.tenantProfileMiss++;
  const profile = await loadTenantProfileWithKVCache(kv, env, tenantId);

  // Store in request cache
  cache.tenantProfiles.set(tenantId, profile);

  return profile;
}

/**
 * Get system settings with request-level caching
 *
 * Caches system_settings within the request scope only.
 * Does NOT persist to KV (system_settings is environment config).
 *
 * @param c - Hono context
 * @param env - Cloudflare environment bindings
 * @returns System settings object or null
 *
 * @example
 * // First call: hits SETTINGS KV
 * const settings1 = await getSystemSettingsCached(c, c.env);
 * // Second call: returns cached result
 * const settings2 = await getSystemSettingsCached(c, c.env);
 */
export async function getSystemSettingsCached(
  c: Context<{ Bindings: Env }>,
  env: Env
): Promise<CachedSystemSettings | null> {
  const cache = getRequestCache(c);

  // Check request-level cache
  if (cache.systemSettingsFetched) {
    cache.stats.systemSettingsHit++;
    return cache.systemSettings;
  }

  // Cache miss - fetch from SETTINGS KV
  cache.stats.systemSettingsMiss++;

  try {
    const tenantId = getTenantIdFromRequestCacheContext(c);
    cache.systemSettings = (await getTenantSystemSettings(
      env.SETTINGS,
      tenantId
    )) as CachedSystemSettings | null;
  } catch {
    // Parse error or KV error - treat as no settings
    cache.systemSettings = null;
  }

  cache.systemSettingsFetched = true;
  return cache.systemSettings;
}

/**
 * Load client contract with request-level caching
 *
 * Wraps the original loadClientContract() function to cache results
 * within the request scope. ClientContract contains:
 * - Anonymous auth settings (enabled, expiration, upgrade methods)
 * - Other client-specific contract configurations
 *
 * @param c - Hono context
 * @param kv - AUTHRIM_CONFIG KV namespace
 * @param env - Cloudflare environment bindings
 * @param tenantId - Tenant identifier
 * @param clientId - Client identifier
 * @returns ClientContract or null if not found
 *
 * @example
 * // First call: hits KV
 * const contract1 = await loadClientContractCached(c, c.env.AUTHRIM_CONFIG, c.env, 'tenant1', 'client123');
 * // Second call: returns cached result
 * const contract2 = await loadClientContractCached(c, c.env.AUTHRIM_CONFIG, c.env, 'tenant1', 'client123');
 */
export async function loadClientContractCached(
  c: Context<{ Bindings: Env }>,
  kv: KVNamespace | undefined,
  env: Env,
  tenantId: string,
  clientId: string
): Promise<ClientContract | null> {
  const cache = getRequestCache(c);
  const cacheKey = `${tenantId}:${clientId}`;

  // Check request-level cache
  if (cache.clientContracts.has(cacheKey)) {
    cache.stats.clientContractHit++;
    return cache.clientContracts.get(cacheKey) ?? null;
  }

  // Cache miss - fetch from KV
  cache.stats.clientContractMiss++;
  const contract = await loadClientContract(kv, env, tenantId, clientId);

  // Store in request cache (including null for not-found)
  cache.clientContracts.set(cacheKey, contract);

  return contract;
}

/**
 * Get tenant feature flags with request-level caching (Settings Manager format)
 *
 * Caches feature flags from Settings Manager format within the request scope.
 * Key format: settings:tenant:{tenantId}:feature-flags
 *
 * @param c - Hono context
 * @param env - Cloudflare environment bindings
 * @param tenantId - Tenant identifier
 * @returns TenantFeatureFlags or null if not found
 *
 * @example
 * // First call: hits KV
 * const flags1 = await getTenantFeatureFlagsCached(c, c.env, 'tenant1');
 * // Second call: returns cached result
 * const flags2 = await getTenantFeatureFlagsCached(c, c.env, 'tenant1');
 */
export async function getTenantFeatureFlagsCached(
  c: Context<{ Bindings: Env }>,
  env: Env,
  tenantId: string
): Promise<TenantFeatureFlags | null> {
  const cache = getRequestCache(c);

  // Check request-level cache (use fetched set to distinguish null from not-fetched)
  if (cache.tenantFeatureFlagsFetched.has(tenantId)) {
    cache.stats.tenantFeatureFlagsHit++;
    return cache.tenantFeatureFlags.get(tenantId) ?? null;
  }

  // Cache miss - fetch from KV
  cache.stats.tenantFeatureFlagsMiss++;

  let flags: TenantFeatureFlags | null = null;

  if (env.AUTHRIM_CONFIG) {
    try {
      const settingsKey = `settings:tenant:${tenantId}:feature-flags`;
      const settingsJson = await env.AUTHRIM_CONFIG.get(settingsKey);
      if (settingsJson) {
        const parsed = JSON.parse(settingsJson);
        if (typeof parsed === 'object' && parsed !== null) {
          flags = parsed as TenantFeatureFlags;
        }
      }
    } catch {
      // Parse error - treat as no flags
      flags = null;
    }
  }

  // Store in request cache
  cache.tenantFeatureFlags.set(tenantId, flags);
  cache.tenantFeatureFlagsFetched.add(tenantId);

  return flags;
}

/**
 * Get a boolean feature flag with request-level caching (legacy format)
 *
 * Caches individual feature flags within the request scope.
 * Uses the existing getFeatureFlag logic but adds request-level caching.
 *
 * Priority: Request Cache → KV (flag:{flagName}) → Environment Variable → Default
 *
 * @param c - Hono context
 * @param flagName - Name of the feature flag (e.g., 'ENABLE_FLOW_ENGINE')
 * @param env - Cloudflare environment bindings
 * @param defaultValue - Default value if not configured
 * @returns true if enabled, false otherwise
 *
 * @example
 * // First call: hits KV or env
 * const enabled1 = await getFeatureFlagCached(c, 'ENABLE_FLOW_ENGINE', c.env, false);
 * // Second call: returns cached result
 * const enabled2 = await getFeatureFlagCached(c, 'ENABLE_FLOW_ENGINE', c.env, false);
 */
export async function getFeatureFlagCached(
  c: Context<{ Bindings: Env }>,
  flagName: string,
  env: Env,
  defaultValue: boolean = false
): Promise<boolean> {
  const cache = getRequestCache(c);

  // Check request-level cache
  if (cache.featureFlags.has(flagName)) {
    cache.stats.featureFlagsHit++;
    return cache.featureFlags.get(flagName)!;
  }

  // Cache miss - resolve value
  cache.stats.featureFlagsMiss++;

  let value = defaultValue;

  // 1. Try KV (dynamic override)
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await env.AUTHRIM_CONFIG.get(`flag:${flagName}`);
      if (kvValue !== null) {
        value = kvValue === 'true';
        cache.featureFlags.set(flagName, value);
        return value;
      }
    } catch {
      // Fall through to environment variable
    }
  }

  // 2. Check environment variable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envValue = (env as unknown as Record<string, string | undefined>)[flagName];
  if (envValue !== undefined) {
    value = envValue === 'true';
  }

  // Store in request cache
  cache.featureFlags.set(flagName, value);

  return value;
}

// =============================================================================
// Internal Helpers (with KV caching)
// =============================================================================

/**
 * Load tenant profile with KV caching support
 *
 * This extends the original loadTenantProfile with:
 * - KV cacheTtl for edge memory cache
 * - KV expirationTtl for persistence
 * - Cache mode aware TTL
 *
 * @internal
 */
async function loadTenantProfileWithKVCache(
  kv: KVNamespace | undefined,
  env: Env,
  tenantId: string
): Promise<TenantProfile> {
  if (!kv) {
    return getTenantProfile(undefined);
  }

  const cacheKey = buildVersionedKey('tenant-profile', tenantId);
  const ttl = await getCacheTTL(env, 'tenant');

  try {
    // Try to get from KV cache with edge memory cache
    const cached = await kv.get(cacheKey, {
      type: 'json',
      cacheTtl: ttl, // Edge memory cache
    });

    if (cached) {
      return cached as TenantProfile;
    }

    // Cache miss - load from contract
    const contract = await loadTenantContract(kv, env, tenantId);
    const profile = getTenantProfile(contract?.profile);

    // Store in KV cache (best-effort, don't block)
    kv.put(cacheKey, JSON.stringify(profile), {
      expirationTtl: ttl,
    }).catch(() => {
      // Ignore cache write errors
    });

    return profile;
  } catch {
    // On error, fall back to default profile
    return getTenantProfile(undefined);
  }
}

// =============================================================================
// Cache Invalidation Helpers
// =============================================================================

/**
 * Invalidate client cache in KV (for Admin API use)
 *
 * Uses the existing KV key format (tenant:{tenantId}:client:{clientId})
 * to ensure compatibility with current getClient() implementation.
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID to invalidate
 * @param tenantId - Tenant ID
 */
export async function invalidateClientCache(
  env: Env,
  clientId: string,
  tenantId: string
): Promise<void> {
  // Use the same key format as kv.ts getClient()
  const cacheKey = buildKVKey('client', clientId, tenantId);
  await env.CLIENTS_CACHE?.delete(cacheKey).catch(() => {
    // Ignore delete errors
  });
}

/**
 * Invalidate client cache and cache mode on client deletion
 * Security requirement: deleted clients must be immediately uncacheable
 *
 * @param env - Cloudflare environment bindings
 * @param clientId - Client ID to invalidate
 * @param tenantId - Tenant ID
 */
export async function invalidateClientCacheOnDelete(
  env: Env,
  clientId: string,
  tenantId: string
): Promise<void> {
  // Use the same key format as kv.ts getClient()
  const cacheKey = buildKVKey('client', clientId, tenantId);
  // Cache mode uses versioned key format
  const cacheModeKey = buildVersionedKey('cache-mode:client', clientId);

  await Promise.all([
    env.CLIENTS_CACHE?.delete(cacheKey).catch(() => {}),
    env.AUTHRIM_CONFIG?.delete(cacheModeKey).catch(() => {}),
  ]);
}

/**
 * Invalidate tenant profile cache in KV (for Admin API use)
 *
 * @param env - Cloudflare environment bindings
 * @param tenantId - Tenant ID to invalidate
 */
export async function invalidateTenantProfileCache(env: Env, tenantId: string): Promise<void> {
  const cacheKey = buildVersionedKey('tenant-profile', tenantId);
  await env.AUTHRIM_CONFIG?.delete(cacheKey).catch(() => {
    // Ignore delete errors
  });
}

/**
 * Invalidate discovery metadata cache in KV (for Admin API use)
 *
 * Should be called when settings that affect discovery metadata are changed:
 * - system_settings (OIDC config, FAPI config)
 * - logout_settings
 * - feature-flags (tenant or global)
 * - tenant profile
 *
 * @param env - Cloudflare environment bindings
 * @param tenantId - Tenant ID to invalidate
 */
export async function invalidateDiscoveryCache(env: Env, tenantId: string): Promise<void> {
  const cacheKey = buildVersionedKey('discovery', tenantId);
  await env.AUTHRIM_CONFIG?.delete(cacheKey).catch(() => {
    // Ignore delete errors
  });
}

/**
 * Deprecation Configuration Utilities
 *
 * Manages deprecation schedule via KV with fail-safe design.
 * If KV is unavailable, deprecation headers are simply not added (fail-open).
 *
 * Priority: Route > Version (route-level overrides version-level)
 *
 * @module deprecation-config
 */

import type { Env } from '../types/env';
import type { DeprecationEntry, DeprecationContext } from '../types/deprecation';
import {
  DEPRECATION_VERSION_PREFIX,
  DEPRECATION_ROUTE_PREFIX,
  DEFAULT_DEPRECATION_CONTEXT,
  parseDeprecationEntry,
} from '../types/deprecation';

/** Default cache TTL: 3 minutes */
const DEFAULT_CACHE_TTL_MS = 180 * 1000;

/**
 * Maximum allowed TTL: 24 hours (prevents integer overflow)
 * Security: Limits memory growth from excessively long cache durations
 */
const MAX_TTL_SECONDS = 86400;

/**
 * Maximum cache size to prevent memory exhaustion DoS
 * Security: Limits memory growth from malicious path enumeration attacks
 */
const MAX_CACHE_SIZE = 1000;

/**
 * In-memory cache for deprecation entries
 *
 * Threading model: Cloudflare Workers are single-threaded per isolate,
 * so there's no race condition within an isolate. Cache staleness across
 * isolates is acceptable given our TTL-based expiration strategy.
 *
 * Security: Bounded to MAX_CACHE_SIZE to prevent memory exhaustion
 */
const deprecationCache = new Map<string, { entry: DeprecationEntry | null; expiresAt: number }>();

/**
 * Evict entries to manage cache size (LRU-like behavior)
 *
 * Security: Also cleans up expired entries to prevent memory leaks
 * Note: Map iteration order is insertion order in JavaScript
 */
function evictIfNeeded(): void {
  const now = Date.now();

  // First pass: Remove all expired entries (prevents memory leak)
  for (const [key, value] of deprecationCache.entries()) {
    if (value.expiresAt <= now) {
      deprecationCache.delete(key);
    }
  }

  // Second pass: If still over limit, remove oldest 10%
  if (deprecationCache.size >= MAX_CACHE_SIZE) {
    const toRemove = Math.ceil(MAX_CACHE_SIZE * 0.1);
    let removed = 0;
    for (const key of deprecationCache.keys()) {
      if (removed >= toRemove) break;
      deprecationCache.delete(key);
      removed++;
    }
  }
}

/**
 * Parse cache TTL from environment with NaN and overflow protection
 *
 * @param env - Worker environment
 * @returns Cache TTL in milliseconds
 */
function getCacheTtlMs(env: Env): number {
  const ttlStr = env.CONFIG_CACHE_TTL || '180';
  const ttlSeconds = parseInt(ttlStr, 10);
  // NaN protection: fallback to default if invalid
  if (Number.isNaN(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_CACHE_TTL_MS;
  }
  // Overflow protection: cap at 24 hours to prevent integer overflow
  if (ttlSeconds > MAX_TTL_SECONDS) {
    console.warn(`[Deprecation] TTL ${ttlSeconds}s exceeds max ${MAX_TTL_SECONDS}s, using max`);
    return MAX_TTL_SECONDS * 1000;
  }
  return ttlSeconds * 1000;
}

/**
 * Get deprecation context for a request
 *
 * Priority:
 * 1. Route-level deprecation (if exists and enabled)
 * 2. Version-level deprecation (if exists and enabled)
 * 3. No deprecation
 *
 * @param env - Worker environment bindings
 * @param path - Request path
 * @param version - Current API version
 * @returns Deprecation context
 */
export async function getDeprecationContext(
  env: Env,
  path: string,
  version: string | null
): Promise<DeprecationContext> {
  // Check if deprecation headers are enabled
  const enabled = env.DEPRECATION_HEADERS_ENABLED !== 'false';
  if (!enabled) {
    return DEFAULT_DEPRECATION_CONTEXT;
  }

  // 1. Check route-level deprecation first (higher priority)
  const routeEntry = await getRouteDeprecation(env, path, version);
  if (routeEntry && routeEntry.enabled) {
    return {
      isDeprecated: true,
      sunsetDate: routeEntry.sunsetDate,
      migrationGuideUrl: routeEntry.migrationGuideUrl,
      replacement: routeEntry.replacement,
      source: 'route',
    };
  }

  // 2. Check version-level deprecation
  if (version) {
    const versionEntry = await getVersionDeprecation(env, version);
    if (versionEntry && versionEntry.enabled) {
      return {
        isDeprecated: true,
        sunsetDate: versionEntry.sunsetDate,
        migrationGuideUrl: versionEntry.migrationGuideUrl,
        replacement: versionEntry.replacement,
        source: 'version',
      };
    }
  }

  // 3. No deprecation
  return DEFAULT_DEPRECATION_CONTEXT;
}

/**
 * Get route-level deprecation entry
 *
 * @param env - Worker environment bindings
 * @param path - Request path
 * @param version - Current API version (for affectedVersions filter)
 * @returns Deprecation entry or null
 */
async function getRouteDeprecation(
  env: Env,
  path: string,
  version: string | null
): Promise<DeprecationEntry | null> {
  const kvKey = `${DEPRECATION_ROUTE_PREFIX}${path}`;
  const entry = await getCachedEntry(env, kvKey);

  if (!entry) return null;

  // Check if this version is affected (if affectedVersions is specified)
  if (entry.affectedVersions && entry.affectedVersions.length > 0) {
    if (!version || !entry.affectedVersions.includes(version)) {
      return null;
    }
  }

  return entry;
}

/**
 * Get version-level deprecation entry
 *
 * @param env - Worker environment bindings
 * @param version - API version
 * @returns Deprecation entry or null
 */
async function getVersionDeprecation(env: Env, version: string): Promise<DeprecationEntry | null> {
  const kvKey = `${DEPRECATION_VERSION_PREFIX}${version}`;
  return getCachedEntry(env, kvKey);
}

/**
 * Get cached deprecation entry from KV
 *
 * @param env - Worker environment bindings
 * @param kvKey - KV key
 * @returns Deprecation entry or null
 */
async function getCachedEntry(env: Env, kvKey: string): Promise<DeprecationEntry | null> {
  // Security: Capture time once to prevent TOCTOU issues
  const now = Date.now();

  // Check cache first
  const cached = deprecationCache.get(kvKey);
  if (cached && cached.expiresAt > now) {
    // LRU: Re-insert to move to end (most recently used)
    deprecationCache.delete(kvKey);
    deprecationCache.set(kvKey, cached);
    return cached.entry;
  }

  // Fetch from KV (fail-safe: return null on error)
  if (!env.AUTHRIM_CONFIG) {
    return null;
  }

  try {
    const json = await env.AUTHRIM_CONFIG.get(kvKey);
    const entry = parseDeprecationEntry(json);

    // Security: Evict old entries before adding new ones to prevent unbounded growth
    evictIfNeeded();

    // Cache the result (including null)
    // Security: Use captured `now` to prevent TOCTOU issues
    const cacheTtl = getCacheTtlMs(env);
    deprecationCache.set(kvKey, {
      entry,
      expiresAt: now + cacheTtl,
    });

    return entry;
  } catch (error) {
    // Fail-safe: log sanitized error and return null
    // Security: Only log error type/message, not full stack traces
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn('[Deprecation] Error reading KV:', errorMessage);

    // Cache null with shorter TTL on error (30 seconds instead of 3 minutes)
    // This prevents cascade failure when KV temporarily unavailable
    // Security: Use captured `now` to prevent TOCTOU issues
    const errorCacheTtl = 30 * 1000;
    deprecationCache.set(kvKey, {
      entry: null,
      expiresAt: now + errorCacheTtl,
    });

    return null;
  }
}

/**
 * Clear the deprecation cache (for testing or dynamic updates)
 */
export function clearDeprecationCache(): void {
  deprecationCache.clear();
}

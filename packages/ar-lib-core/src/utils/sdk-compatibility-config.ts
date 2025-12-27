/**
 * SDK Compatibility Configuration Utilities
 *
 * Manages SDK compatibility matrix via KV with fail-safe design.
 * If KV is unavailable, SDK compatibility checking is simply disabled (fail-open).
 *
 * @module sdk-compatibility-config
 */

import type { Env } from '../types/env';
import type {
  SdkCompatibilityConfig,
  SdkCompatibilityEntry,
  SdkCompatibilityResult,
  SdkCompatibilityStatus,
  ParsedSdkVersion,
} from '../types/sdk-compatibility';
import {
  SDK_COMPATIBILITY_PREFIX,
  SDK_COMPATIBILITY_CONFIG_KEY,
  DEFAULT_SDK_COMPATIBILITY_CONFIG,
  parseSdkVersion,
  compareSemver,
} from '../types/sdk-compatibility';

/** Default cache TTL: 3 minutes */
const DEFAULT_CACHE_TTL_MS = 180 * 1000;

/**
 * Maximum allowed TTL: 24 hours (prevents integer overflow)
 * Security: Limits memory growth from excessively long cache durations
 */
const MAX_TTL_SECONDS = 86400;

/**
 * Maximum cache size to prevent memory exhaustion DoS
 * Security: Limits memory growth from malicious SDK name enumeration
 */
const MAX_SDK_CACHE_SIZE = 100;

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
    console.warn(`[SDK Compatibility] TTL ${ttlSeconds}s exceeds max ${MAX_TTL_SECONDS}s, using max`);
    return MAX_TTL_SECONDS * 1000;
  }
  return ttlSeconds * 1000;
}

/**
 * Type guard for SdkCompatibilityEntry
 *
 * @param value - Value to check
 * @returns true if value is a valid SdkCompatibilityEntry
 */
function isSdkCompatibilityEntry(value: unknown): value is SdkCompatibilityEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.minVersion === 'string' &&
    typeof entry.recommendedVersion === 'string' &&
    typeof entry.latestVersion === 'string' &&
    typeof entry.enabled === 'boolean'
  );
}

/**
 * Type guard for SdkCompatibilityConfig
 *
 * @param value - Value to check
 * @returns true if value is a valid SdkCompatibilityConfig
 */
function isSdkCompatibilityConfig(value: unknown): value is Partial<SdkCompatibilityConfig> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const config = value as Record<string, unknown>;
  // sdks must be an object if present
  if (config.sdks !== undefined && (typeof config.sdks !== 'object' || config.sdks === null)) {
    return false;
  }
  return true;
}

/**
 * In-memory cache for SDK compatibility config (single object)
 *
 * Threading model: Cloudflare Workers are single-threaded per isolate,
 * so there's no race condition within an isolate. Cache staleness across
 * isolates is acceptable given our TTL-based expiration strategy.
 */
let configCache: { config: SdkCompatibilityConfig; expiresAt: number } | null = null;

/**
 * In-memory cache for individual SDK entries
 *
 * Security: Bounded to MAX_SDK_CACHE_SIZE to prevent memory exhaustion
 */
const sdkEntryCache = new Map<string, { entry: SdkCompatibilityEntry | null; expiresAt: number }>();

/**
 * Evict entries to manage cache size (LRU-like behavior)
 *
 * Security: Also cleans up expired entries to prevent memory leaks
 * Note: Map iteration order is insertion order in JavaScript
 */
function evictSdkCacheIfNeeded(): void {
  const now = Date.now();

  // First pass: Remove all expired entries (prevents memory leak)
  for (const [key, value] of sdkEntryCache.entries()) {
    if (value.expiresAt <= now) {
      sdkEntryCache.delete(key);
    }
  }

  // Second pass: If still over limit, remove oldest 10%
  if (sdkEntryCache.size >= MAX_SDK_CACHE_SIZE) {
    const toRemove = Math.ceil(MAX_SDK_CACHE_SIZE * 0.1);
    let removed = 0;
    for (const key of sdkEntryCache.keys()) {
      if (removed >= toRemove) break;
      sdkEntryCache.delete(key);
      removed++;
    }
  }
}

/**
 * Get SDK compatibility configuration
 *
 * Priority: Cache → KV → Environment → Defaults
 *
 * Environment variable controls the master switch:
 * - SDK_COMPATIBILITY_CHECK_ENABLED=true: Enabled
 * - SDK_COMPATIBILITY_CHECK_ENABLED=false: Disabled
 * - Not set: Disabled (default, until SDKs are developed)
 *
 * @param env - Worker environment bindings
 * @returns SDK compatibility config
 */
export async function getSdkCompatibilityConfig(env: Env): Promise<SdkCompatibilityConfig> {
  // Check cache first
  if (configCache && configCache.expiresAt > Date.now()) {
    return configCache.config;
  }

  // Check if enabled via environment (default: disabled until SDKs are developed)
  const envEnabled = env.SDK_COMPATIBILITY_CHECK_ENABLED === 'true';
  if (!envEnabled) {
    const config: SdkCompatibilityConfig = {
      ...DEFAULT_SDK_COMPATIBILITY_CONFIG,
      enabled: false,
    };
    cacheConfig(config, env);
    return config;
  }

  // Environment says enabled, use KV for SDK entries or use defaults with enabled=true
  const enabledConfig: SdkCompatibilityConfig = {
    enabled: true,
    sdks: {},
  };

  // Try to load from KV
  if (!env.AUTHRIM_CONFIG) {
    cacheConfig(enabledConfig, env);
    return enabledConfig;
  }

  try {
    const json = await env.AUTHRIM_CONFIG.get(SDK_COMPATIBILITY_CONFIG_KEY);
    if (json) {
      const parsed: unknown = JSON.parse(json);
      // Type validation: ensure parsed data matches expected structure
      if (isSdkCompatibilityConfig(parsed)) {
        const config: SdkCompatibilityConfig = {
          // Enabled is controlled by environment, KV can provide SDKs
          enabled: true,
          sdks: parsed.sdks ?? {},
        };
        cacheConfig(config, env);
        return config;
      } else {
        console.warn('[SDK Compatibility] Invalid config structure in KV');
      }
    }
  } catch (error) {
    // Security: Only log error type/message, not full stack traces
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn('[SDK Compatibility] Error reading config from KV:', errorMessage);
  }

  // Fallback to enabled config with no SDKs
  cacheConfig(enabledConfig, env);
  return enabledConfig;
}

/**
 * Get SDK entry from KV
 *
 * @param env - Worker environment bindings
 * @param sdkName - SDK name (e.g., "authrim-js")
 * @returns SDK compatibility entry or null
 */
export async function getSdkEntry(
  env: Env,
  sdkName: string
): Promise<SdkCompatibilityEntry | null> {
  const cacheKey = sdkName;

  // Security: Capture time once to prevent TOCTOU issues
  const now = Date.now();

  // Check cache first
  const cached = sdkEntryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    // LRU: Re-insert to move to end (most recently used)
    sdkEntryCache.delete(cacheKey);
    sdkEntryCache.set(cacheKey, cached);
    return cached.entry;
  }

  // Try to load from KV
  if (!env.AUTHRIM_CONFIG) {
    return null;
  }

  try {
    const kvKey = `${SDK_COMPATIBILITY_PREFIX}${sdkName}`;
    const json = await env.AUTHRIM_CONFIG.get(kvKey);
    if (json) {
      const parsed: unknown = JSON.parse(json);
      // Type validation: ensure parsed data matches expected structure
      if (isSdkCompatibilityEntry(parsed)) {
        cacheSdkEntry(sdkName, parsed, env);
        return parsed;
      } else {
        console.warn(`[SDK Compatibility] Invalid entry structure for ${sdkName}`);
      }
    }

    // Cache null result to avoid repeated KV lookups
    cacheSdkEntry(sdkName, null, env);
    return null;
  } catch (error) {
    // Security: Only log error type/message, not full stack traces
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[SDK Compatibility] Error reading SDK entry for ${sdkName}:`, errorMessage);

    // Cache null with shorter TTL on error (30 seconds instead of 3 minutes)
    // This prevents cascade failure when KV temporarily unavailable
    // Security: Use captured `now` to prevent TOCTOU issues
    const errorCacheTtl = 30 * 1000;
    sdkEntryCache.set(sdkName, {
      entry: null,
      expiresAt: now + errorCacheTtl,
    });

    return null;
  }
}

/**
 * Check SDK compatibility
 *
 * @param env - Worker environment bindings
 * @param sdkVersionHeader - SDK version header value (e.g., "authrim-js/1.0.0")
 * @returns SDK compatibility result
 */
export async function checkSdkCompatibility(
  env: Env,
  sdkVersionHeader: string | null
): Promise<SdkCompatibilityResult> {
  // No header provided
  if (!sdkVersionHeader) {
    return {
      hasHeader: false,
      sdk: null,
      status: 'unknown',
    };
  }

  // Parse SDK version
  const sdk = parseSdkVersion(sdkVersionHeader);
  if (!sdk) {
    return {
      hasHeader: true,
      sdk: null,
      status: 'unknown',
      warningMessage: 'Invalid SDK version format',
    };
  }

  // Get SDK entry
  const entry = await getSdkEntry(env, sdk.name);
  if (!entry || !entry.enabled) {
    return {
      hasHeader: true,
      sdk,
      status: 'unknown',
    };
  }

  // Check compatibility
  const status = determineCompatibilityStatus(sdk.version, entry);

  const result: SdkCompatibilityResult = {
    hasHeader: true,
    sdk,
    status,
    documentationUrl: entry.documentationUrl,
  };

  // Add warning info if not compatible
  if (status !== 'compatible') {
    result.recommendedVersion = entry.recommendedVersion;
    result.warningMessage = formatWarningMessage(status, sdk.version, entry);
  }

  return result;
}

/**
 * Determine compatibility status based on version comparison
 *
 * Security: Handles null returns from compareSemver for invalid versions
 *
 * @param version - Current SDK version
 * @param entry - SDK compatibility entry
 * @returns Compatibility status
 */
function determineCompatibilityStatus(
  version: string,
  entry: SdkCompatibilityEntry
): SdkCompatibilityStatus {
  // Check if version is deprecated
  if (entry.deprecatedVersions?.includes(version)) {
    return 'deprecated';
  }

  // Check if version is below minimum
  // Security: compareSemver returns null for invalid versions
  const minComparison = compareSemver(version, entry.minVersion);
  if (minComparison === null) {
    // Invalid version format - treat as unknown
    return 'unknown';
  }
  if (minComparison < 0) {
    return 'unsupported';
  }

  // Check if version is below recommended
  const recommendedComparison = compareSemver(version, entry.recommendedVersion);
  if (recommendedComparison === null) {
    // Invalid version format - treat as unknown
    return 'unknown';
  }
  if (recommendedComparison < 0) {
    return 'outdated';
  }

  return 'compatible';
}

/**
 * Format warning message based on status
 *
 * @param status - Compatibility status
 * @param version - Current SDK version
 * @param entry - SDK compatibility entry
 * @returns Warning message
 */
function formatWarningMessage(
  status: SdkCompatibilityStatus,
  version: string,
  entry: SdkCompatibilityEntry
): string {
  switch (status) {
    case 'outdated':
      return `SDK version ${version} is outdated. Please upgrade to ${entry.recommendedVersion}.`;
    case 'deprecated':
      return `SDK version ${version} is deprecated and will be unsupported soon. Please upgrade to ${entry.recommendedVersion}.`;
    case 'unsupported':
      return `SDK version ${version} is no longer supported. Minimum version is ${entry.minVersion}. Please upgrade to ${entry.recommendedVersion}.`;
    default:
      return '';
  }
}

/**
 * Cache config with TTL
 */
function cacheConfig(config: SdkCompatibilityConfig, env: Env): void {
  const cacheTtl = getCacheTtlMs(env);
  configCache = {
    config,
    expiresAt: Date.now() + cacheTtl,
  };
}

/**
 * Cache SDK entry with TTL
 */
function cacheSdkEntry(sdkName: string, entry: SdkCompatibilityEntry | null, env: Env): void {
  // Security: Evict old entries before adding new ones to prevent unbounded growth
  evictSdkCacheIfNeeded();

  const cacheTtl = getCacheTtlMs(env);
  sdkEntryCache.set(sdkName, {
    entry,
    expiresAt: Date.now() + cacheTtl,
  });
}

/**
 * Clear the SDK compatibility cache (for testing or dynamic updates)
 */
export function clearSdkCompatibilityCache(): void {
  configCache = null;
  sdkEntryCache.clear();
}

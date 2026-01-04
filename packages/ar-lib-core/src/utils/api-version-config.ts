/**
 * API Version Configuration Utilities
 *
 * Implements hybrid approach: Cache → KV → Environment Variable → Default Value
 * Per CLAUDE.md: code defaults should use secure values
 *
 * Priority:
 * 1. In-memory cache (3 min TTL)
 * 2. KV (dynamic, no redeploy needed)
 * 3. Environment variable (deploy-time default)
 * 4. Code default
 *
 * Fail-safe: If KV is unavailable, fall back to env/default (don't stop)
 *
 * @module api-version-config
 */

import type { Env } from '../types/env';
import type { ApiVersionConfig, ApiVersionString, UnknownVersionMode } from '../types/api-version';
import { DEFAULT_API_VERSION_CONFIG, isValidApiVersionFormat } from '../types/api-version';
import { createLogger } from './logger';

const log = createLogger().module('API_VERSION_CONFIG');

/** KV key for API version configuration */
const CONFIG_KV_KEY = 'api_versions:config';

/** Default cache TTL: 3 minutes (matches CONFIG_CACHE_TTL default) */
const DEFAULT_CACHE_TTL_MS = 180 * 1000;

/**
 * In-memory cache for config to reduce KV reads (single object)
 *
 * Threading model: Cloudflare Workers are single-threaded per isolate,
 * so there's no race condition within an isolate. Cache staleness across
 * isolates is acceptable given our TTL-based expiration strategy.
 *
 * Note: This is a single config object, so no size limits needed
 */
let configCache: { config: ApiVersionConfig; expiresAt: number } | null = null;

/**
 * Maximum allowed TTL: 24 hours (prevents integer overflow)
 * Security: Limits memory growth from excessively long cache durations
 */
const MAX_TTL_SECONDS = 86400;

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
    log.warn(`TTL ${ttlSeconds}s exceeds max ${MAX_TTL_SECONDS}s, using max`);
    return MAX_TTL_SECONDS * 1000;
  }
  return ttlSeconds * 1000;
}

/**
 * Type guard for validating KV config data
 *
 * Security: Validates structure of data from KV to prevent type confusion attacks
 * If KV is compromised, malformed data won't crash the application
 *
 * @param value - Unknown value from JSON.parse
 * @returns true if value is a valid partial ApiVersionConfig
 */
function isValidApiVersionKvConfig(value: unknown): value is Partial<ApiVersionConfig> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const config = value as Record<string, unknown>;

  // Validate string fields
  if (config.defaultVersion !== undefined && typeof config.defaultVersion !== 'string') {
    return false;
  }
  if (
    config.currentStableVersion !== undefined &&
    typeof config.currentStableVersion !== 'string'
  ) {
    return false;
  }

  // Validate unknownVersionMode enum
  if (config.unknownVersionMode !== undefined) {
    if (
      typeof config.unknownVersionMode !== 'string' ||
      !['fallback', 'warn', 'reject'].includes(config.unknownVersionMode)
    ) {
      return false;
    }
  }

  // Validate supportedVersions array
  if (config.supportedVersions !== undefined) {
    if (!Array.isArray(config.supportedVersions)) {
      return false;
    }
    if (!config.supportedVersions.every((v) => typeof v === 'string')) {
      return false;
    }
  }

  // Validate oidcEndpoints array
  if (config.oidcEndpoints !== undefined) {
    if (!Array.isArray(config.oidcEndpoints)) {
      return false;
    }
    if (!config.oidcEndpoints.every((v) => typeof v === 'string')) {
      return false;
    }
  }

  // Validate boolean field
  if (
    config.adminApiRequireVersion !== undefined &&
    typeof config.adminApiRequireVersion !== 'boolean'
  ) {
    return false;
  }

  return true;
}

/**
 * Get API version configuration
 *
 * Priority: Cache → KV → Environment Variable → Default
 *
 * @param env - Worker environment bindings
 * @returns API version configuration
 */
export async function getApiVersionConfig(env: Env): Promise<ApiVersionConfig> {
  // 1. Check in-memory cache first
  if (configCache && configCache.expiresAt > Date.now()) {
    return configCache.config;
  }

  // Start with defaults
  let config: ApiVersionConfig = { ...DEFAULT_API_VERSION_CONFIG };

  // 2. Try KV (dynamic override) - fail-safe: continue on error
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await env.AUTHRIM_CONFIG.get(CONFIG_KV_KEY);
      if (kvValue) {
        const parsed: unknown = JSON.parse(kvValue);
        // Security: Validate KV data structure before using
        if (isValidApiVersionKvConfig(parsed)) {
          config = mergeConfig(config, parsed);
        } else {
          log.warn('Invalid config structure in KV, using defaults');
        }
      }
    } catch (error) {
      // Fail-safe: log sanitized error and continue with env/default
      // Security: Only log error type/message, not full stack traces
      log.warn('Error reading KV config');
    }
  }

  // 3. Apply environment variable overrides
  config = applyEnvOverrides(config, env);

  // Validate configuration
  config = validateConfig(config);

  // Cache the resolved configuration
  const cacheTtl = getCacheTtlMs(env);
  configCache = {
    config,
    expiresAt: Date.now() + cacheTtl,
  };

  return config;
}

/**
 * Check if a version is supported
 *
 * @param env - Worker environment bindings
 * @param version - Version to check
 * @returns true if supported
 */
export async function isVersionSupported(env: Env, version: ApiVersionString): Promise<boolean> {
  const config = await getApiVersionConfig(env);
  return config.supportedVersions.includes(version);
}

/**
 * Get the default API version
 *
 * @param env - Worker environment bindings
 * @returns Default version string
 */
export async function getDefaultApiVersion(env: Env): Promise<ApiVersionString> {
  const config = await getApiVersionConfig(env);
  return config.defaultVersion;
}

/**
 * Clear the API version config cache (for testing or dynamic updates)
 */
export function clearApiVersionConfigCache(): void {
  configCache = null;
}

/**
 * Merge KV config with defaults
 *
 * Note: supportedVersionsSet is intentionally not handled here.
 * It will be created in validateConfig() from the supportedVersions array.
 */
function mergeConfig(
  base: ApiVersionConfig,
  override: Partial<ApiVersionConfig>
): ApiVersionConfig {
  return {
    ...base,
    ...override,
    // Arrays should be fully replaced, not merged
    supportedVersions: override.supportedVersions ?? base.supportedVersions,
    oidcEndpoints: override.oidcEndpoints ?? base.oidcEndpoints,
    // Set will be created by validateConfig() - use base Set temporarily
    supportedVersionsSet: base.supportedVersionsSet,
  };
}

/**
 * Apply environment variable overrides
 */
function applyEnvOverrides(config: ApiVersionConfig, env: Env): ApiVersionConfig {
  const envRecord = env as unknown as Record<string, string | undefined>;

  // API_DEFAULT_VERSION
  if (envRecord.API_DEFAULT_VERSION && isValidApiVersionFormat(envRecord.API_DEFAULT_VERSION)) {
    config.defaultVersion = envRecord.API_DEFAULT_VERSION;
  }

  // API_UNKNOWN_VERSION_MODE
  const modeValue = envRecord.API_UNKNOWN_VERSION_MODE;
  if (modeValue && ['fallback', 'warn', 'reject'].includes(modeValue)) {
    config.unknownVersionMode = modeValue as UnknownVersionMode;
  }

  // API_SUPPORTED_VERSIONS (comma-separated)
  if (envRecord.API_SUPPORTED_VERSIONS) {
    const versions = envRecord.API_SUPPORTED_VERSIONS.split(',')
      .map((v) => v.trim())
      .filter(isValidApiVersionFormat);
    if (versions.length > 0) {
      config.supportedVersions = versions;
    }
  }

  // API_CURRENT_STABLE_VERSION
  if (
    envRecord.API_CURRENT_STABLE_VERSION &&
    isValidApiVersionFormat(envRecord.API_CURRENT_STABLE_VERSION)
  ) {
    config.currentStableVersion = envRecord.API_CURRENT_STABLE_VERSION;
  }

  return config;
}

/**
 * Validate and fix configuration
 */
function validateConfig(config: ApiVersionConfig): ApiVersionConfig {
  // Ensure default version is in supported versions
  if (!config.supportedVersions.includes(config.defaultVersion)) {
    log.warn(`Default version ${config.defaultVersion} not in supported versions, adding it`);
    config.supportedVersions = [...config.supportedVersions, config.defaultVersion];
  }

  // Ensure current stable version is in supported versions
  if (!config.supportedVersions.includes(config.currentStableVersion)) {
    log.warn(
      `Current stable version ${config.currentStableVersion} not in supported versions, adding it`
    );
    config.supportedVersions = [...config.supportedVersions, config.currentStableVersion];
  }

  // Sort supported versions (newest first)
  config.supportedVersions = [...config.supportedVersions].sort().reverse();

  // Security: Create Set for O(1) version lookups (prevents timing attacks)
  config.supportedVersionsSet = new Set(config.supportedVersions);

  return config;
}

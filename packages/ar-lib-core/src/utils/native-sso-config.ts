/**
 * Native SSO Configuration Utilities
 *
 * OIDC Native SSO 1.0 (draft-07) configuration management.
 * Implements hybrid approach: KV → Environment Variable → Default Value
 *
 * Per CLAUDE.md: code defaults should use secure values.
 * Native SSO is disabled by default for security.
 */

import type { Env } from '../types/env';
import { createLogger } from './logger';

const log = createLogger().module('NATIVE_SSO_CONFIG');

/**
 * Native SSO Settings interface
 *
 * All settings have secure defaults:
 * - enabled: false (must explicitly enable)
 * - deviceSecretTTLDays: 30 (standard mobile session duration)
 * - maxDeviceSecretsPerUser: 10 (reasonable limit)
 * - maxSecretsBehavior: 'revoke_oldest' (UX-friendly)
 * - allowCrossClientNativeSSO: false (more secure)
 * - maxUseCountPerSecret: 10 (replay attack prevention)
 */
export interface NativeSSOSettings {
  /** Enable Native SSO feature (default: false) */
  enabled: boolean;
  /** Device secret TTL in days (default: 30, min: 1, max: 90) */
  deviceSecretTTLDays: number;
  /** Maximum device secrets per user (default: 10, min: 1, max: 50) */
  maxDeviceSecretsPerUser: number;
  /**
   * Maximum uses per device secret (default: 10, min: 1, max: 100)
   * Replay attack prevention: auto-revokes when limit exceeded
   * Set to 1 for one-time use (most secure)
   */
  maxUseCountPerSecret: number;
  /**
   * Behavior when max secrets exceeded:
   * - 'revoke_oldest': Automatically revoke oldest secret (recommended, UX-friendly)
   * - 'reject': Reject the creation request
   */
  maxSecretsBehavior: 'revoke_oldest' | 'reject';
  /** Allow cross-client Native SSO (default: false) */
  allowCrossClientNativeSSO: boolean;
  /** Rate limit settings for Token Exchange */
  rateLimit: {
    /** Max attempts per minute per user+device_secret (default: 10) */
    maxAttemptsPerMinute: number;
    /** Block duration in minutes (default: 15) */
    blockDurationMinutes: number;
  };
}

/** Default Native SSO settings (secure by default) */
const DEFAULT_SETTINGS: NativeSSOSettings = {
  enabled: false,
  deviceSecretTTLDays: 30,
  maxDeviceSecretsPerUser: 10,
  maxUseCountPerSecret: 10, // Replay attack prevention
  maxSecretsBehavior: 'revoke_oldest',
  allowCrossClientNativeSSO: false,
  rateLimit: {
    maxAttemptsPerMinute: 10,
    blockDurationMinutes: 15,
  },
};

/** In-memory cache for settings */
let settingsCache: { settings: NativeSSOSettings; expiresAt: number } | null = null;

/** Default cache TTL: 3 minutes */
const DEFAULT_CACHE_TTL_MS = 180 * 1000;

/**
 * Get Native SSO settings
 *
 * Priority: Cache → KV → Environment Variable → Default
 *
 * @param env - Worker environment bindings
 * @returns Native SSO settings
 */
export async function getNativeSSOConfig(env: Env): Promise<NativeSSOSettings> {
  // 1. Check in-memory cache first
  if (settingsCache && settingsCache.expiresAt > Date.now()) {
    return settingsCache.settings;
  }

  let settings = { ...DEFAULT_SETTINGS };

  // 2. Try KV (dynamic override)
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await env.AUTHRIM_CONFIG.get('config:native-sso');
      if (kvValue) {
        const kvSettings = JSON.parse(kvValue) as Partial<NativeSSOSettings>;
        settings = mergeSettings(settings, kvSettings);
      }
    } catch (error) {
      log.error('Error reading KV', {}, error as Error);
      // Fall through to environment variable
    }
  }

  // 3. Check environment variables
  settings = mergeWithEnvVars(settings, env);

  // 4. Validate and clamp values
  settings = validateSettings(settings);

  // Cache the resolved settings
  const cacheTtl = parseInt(
    (env as unknown as Record<string, string | undefined>).CONFIG_CACHE_TTL || '180',
    10
  );
  settingsCache = {
    settings,
    expiresAt: Date.now() + cacheTtl * 1000,
  };

  return settings;
}

/**
 * Check if Native SSO is enabled
 *
 * @param env - Worker environment bindings
 * @returns true if Native SSO is enabled
 */
export async function isNativeSSOEnabled(env: Env): Promise<boolean> {
  const config = await getNativeSSOConfig(env);
  return config.enabled;
}

/**
 * Get device secret TTL in milliseconds
 *
 * @param env - Worker environment bindings
 * @returns TTL in milliseconds
 */
export async function getDeviceSecretTTLMs(env: Env): Promise<number> {
  const config = await getNativeSSOConfig(env);
  return config.deviceSecretTTLDays * 24 * 60 * 60 * 1000;
}

/**
 * Clear the settings cache (for testing or dynamic updates)
 */
export function clearNativeSSOConfigCache(): void {
  settingsCache = null;
}

/**
 * Merge settings with KV overrides
 */
function mergeSettings(
  base: NativeSSOSettings,
  override: Partial<NativeSSOSettings>
): NativeSSOSettings {
  return {
    enabled: override.enabled ?? base.enabled,
    deviceSecretTTLDays: override.deviceSecretTTLDays ?? base.deviceSecretTTLDays,
    maxDeviceSecretsPerUser: override.maxDeviceSecretsPerUser ?? base.maxDeviceSecretsPerUser,
    maxUseCountPerSecret: override.maxUseCountPerSecret ?? base.maxUseCountPerSecret,
    maxSecretsBehavior: override.maxSecretsBehavior ?? base.maxSecretsBehavior,
    allowCrossClientNativeSSO: override.allowCrossClientNativeSSO ?? base.allowCrossClientNativeSSO,
    rateLimit: {
      maxAttemptsPerMinute:
        override.rateLimit?.maxAttemptsPerMinute ?? base.rateLimit.maxAttemptsPerMinute,
      blockDurationMinutes:
        override.rateLimit?.blockDurationMinutes ?? base.rateLimit.blockDurationMinutes,
    },
  };
}

/**
 * Merge settings with environment variables
 */
function mergeWithEnvVars(settings: NativeSSOSettings, env: Env): NativeSSOSettings {
  const envRecord = env as unknown as Record<string, string | undefined>;

  if (envRecord.NATIVE_SSO_ENABLED !== undefined) {
    settings.enabled = envRecord.NATIVE_SSO_ENABLED === 'true';
  }

  if (envRecord.NATIVE_SSO_DEVICE_SECRET_TTL_DAYS !== undefined) {
    const ttl = parseInt(envRecord.NATIVE_SSO_DEVICE_SECRET_TTL_DAYS, 10);
    if (!isNaN(ttl)) {
      settings.deviceSecretTTLDays = ttl;
    }
  }

  if (envRecord.NATIVE_SSO_MAX_SECRETS_PER_USER !== undefined) {
    const max = parseInt(envRecord.NATIVE_SSO_MAX_SECRETS_PER_USER, 10);
    if (!isNaN(max)) {
      settings.maxDeviceSecretsPerUser = max;
    }
  }

  if (envRecord.NATIVE_SSO_MAX_USE_COUNT_PER_SECRET !== undefined) {
    const max = parseInt(envRecord.NATIVE_SSO_MAX_USE_COUNT_PER_SECRET, 10);
    if (!isNaN(max)) {
      settings.maxUseCountPerSecret = max;
    }
  }

  if (envRecord.NATIVE_SSO_MAX_SECRETS_BEHAVIOR !== undefined) {
    const behavior = envRecord.NATIVE_SSO_MAX_SECRETS_BEHAVIOR;
    if (behavior === 'revoke_oldest' || behavior === 'reject') {
      settings.maxSecretsBehavior = behavior;
    }
  }

  if (envRecord.NATIVE_SSO_ALLOW_CROSS_CLIENT !== undefined) {
    settings.allowCrossClientNativeSSO = envRecord.NATIVE_SSO_ALLOW_CROSS_CLIENT === 'true';
  }

  if (envRecord.NATIVE_SSO_RATE_LIMIT_MAX_ATTEMPTS !== undefined) {
    const max = parseInt(envRecord.NATIVE_SSO_RATE_LIMIT_MAX_ATTEMPTS, 10);
    if (!isNaN(max)) {
      settings.rateLimit.maxAttemptsPerMinute = max;
    }
  }

  if (envRecord.NATIVE_SSO_RATE_LIMIT_BLOCK_MINUTES !== undefined) {
    const block = parseInt(envRecord.NATIVE_SSO_RATE_LIMIT_BLOCK_MINUTES, 10);
    if (!isNaN(block)) {
      settings.rateLimit.blockDurationMinutes = block;
    }
  }

  return settings;
}

/**
 * Validate and clamp settings to safe ranges
 * Also handles NaN, Infinity, and out-of-range values safely
 */
function validateSettings(settings: NativeSSOSettings): NativeSSOSettings {
  // Helper to safely clamp numeric values (handles NaN, Infinity)
  const safeClamp = (value: number, min: number, max: number, defaultVal: number): number => {
    if (!Number.isFinite(value)) return defaultVal;
    return Math.min(max, Math.max(min, Math.floor(value)));
  };

  return {
    ...settings,
    // Clamp TTL: 1-90 days
    deviceSecretTTLDays: safeClamp(settings.deviceSecretTTLDays, 1, 90, 30),
    // Clamp max secrets: 1-50
    maxDeviceSecretsPerUser: safeClamp(settings.maxDeviceSecretsPerUser, 1, 50, 10),
    // Clamp max use count: 1-100 (replay attack prevention)
    maxUseCountPerSecret: safeClamp(settings.maxUseCountPerSecret, 1, 100, 10),
    // Ensure valid behavior
    maxSecretsBehavior:
      settings.maxSecretsBehavior === 'reject' || settings.maxSecretsBehavior === 'revoke_oldest'
        ? settings.maxSecretsBehavior
        : 'revoke_oldest',
    rateLimit: {
      // Clamp rate limit: 1-100
      maxAttemptsPerMinute: safeClamp(settings.rateLimit.maxAttemptsPerMinute, 1, 100, 10),
      // Clamp block duration: 1-60 minutes
      blockDurationMinutes: safeClamp(settings.rateLimit.blockDurationMinutes, 1, 60, 15),
    },
  };
}

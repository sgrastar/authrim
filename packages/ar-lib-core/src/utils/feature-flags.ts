/**
 * Feature Flag Utilities
 *
 * Implements hybrid approach: KV → Environment Variable → Default Value
 * Per CLAUDE.md: code defaults should use secure values
 *
 * Priority:
 * 1. KV (dynamic, no redeploy needed)
 * 2. Environment variable (deploy-time default)
 * 3. Code default (secure by default)
 */

import type { Env } from '../types/env';
import { createLogger } from './logger';

const log = createLogger().module('FEATURE_FLAGS');

/** In-memory cache for feature flags to reduce KV reads */
const flagCache = new Map<string, { value: boolean; expiresAt: number }>();

/** Default cache TTL: 3 minutes (matches CONFIG_CACHE_TTL default) */
const DEFAULT_CACHE_TTL_MS = 180 * 1000;

/**
 * Get a boolean feature flag value
 *
 * Priority: Cache → KV → Environment Variable → Default
 *
 * @param flagName - Name of the feature flag (e.g., 'ENABLE_MOCK_AUTH')
 * @param env - Worker environment bindings
 * @param defaultValue - Default value if not configured (should be secure default)
 * @returns true if enabled, false otherwise
 */
export async function getFeatureFlag(
  flagName: string,
  env: Env,
  defaultValue: boolean = false
): Promise<boolean> {
  // 1. Check in-memory cache first
  const cached = flagCache.get(flagName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let value = defaultValue;

  // 2. Try KV (dynamic override)
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await env.AUTHRIM_CONFIG.get(`flag:${flagName}`);
      if (kvValue !== null) {
        value = kvValue === 'true';
        // Cache the KV value
        const cacheTtl = parseInt(env.CONFIG_CACHE_TTL || '180', 10) * 1000;
        flagCache.set(flagName, {
          value,
          expiresAt: Date.now() + cacheTtl,
        });
        return value;
      }
    } catch (error) {
      log.warn(`Error reading KV for ${flagName}`);
      // Fall through to environment variable
    }
  }

  // 3. Check environment variable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envValue = (env as unknown as Record<string, string | undefined>)[flagName];
  if (envValue !== undefined) {
    value = envValue === 'true';
  }

  // Cache the resolved value
  flagCache.set(flagName, {
    value,
    expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
  });

  return value;
}

/**
 * Check if mock authentication is enabled
 *
 * SECURITY WARNING: This should NEVER be enabled in production!
 * Mock auth allows device/CIBA flows to use mock users without real authentication.
 *
 * @param env - Worker environment bindings
 * @returns true if mock auth is enabled, false otherwise (secure default)
 */
export async function isMockAuthEnabled(env: Env): Promise<boolean> {
  // Extra safety: Always disable in production environment
  const environment = env.ENVIRONMENT || env.NODE_ENV || 'production';
  if (environment === 'production') {
    return false;
  }

  return getFeatureFlag('ENABLE_MOCK_AUTH', env, false);
}

/**
 * Clear the feature flag cache (for testing or dynamic updates)
 */
export function clearFeatureFlagCache(): void {
  flagCache.clear();
}

/**
 * Check if Anonymous Authentication is enabled
 *
 * Anonymous auth allows device-based login without email/password,
 * with the ability to upgrade to a full account later.
 *
 * @see architecture-decisions.md §17
 *
 * @param env - Worker environment bindings
 * @returns true if anonymous auth is enabled, false otherwise (secure default)
 */
export async function isAnonymousAuthEnabled(env: Env): Promise<boolean> {
  return getFeatureFlag('ENABLE_ANONYMOUS_AUTH', env, false);
}

/**
 * Check if ID-JAG (Identity Assertion Authorization Grant) is enabled
 *
 * ID-JAG enables IdP-mediated authorization for third-party APIs using
 * Token Exchange (RFC 8693) with identity assertions.
 *
 * @see draft-ietf-oauth-identity-assertion-authz-grant
 *
 * @param env - Worker environment bindings
 * @returns true if ID-JAG is enabled, false otherwise (secure default)
 */
export async function isIdJagEnabled(env: Env): Promise<boolean> {
  return getFeatureFlag('ENABLE_ID_JAG', env, false);
}

/**
 * Check if NIST Assurance Levels feature is enabled
 *
 * Enables explicit AAL/FAL/IAL tracking and risk-based selection
 * per NIST SP 800-63-4 guidelines.
 *
 * @see NIST SP 800-63C Revision 4
 *
 * @param env - Worker environment bindings
 * @returns true if assurance levels feature is enabled, false otherwise
 */
export async function isAssuranceLevelsEnabled(env: Env): Promise<boolean> {
  return getFeatureFlag('ENABLE_NIST_ASSURANCE_LEVELS', env, false);
}

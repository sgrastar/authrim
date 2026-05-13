/**
 * DCR Configuration Manager
 *
 * Provides helper functions for reading DCR settings from KV/env.
 * Uses the Settings API v2 storage format for consistency.
 *
 * Priority: SETTINGS KV > legacy AUTHRIM_CONFIG KV > Environment variable > Default value
 *
 * Settings:
 * - dcr.enabled: Enable Dynamic Client Registration (default: false)
 * - dcr.require_initial_access_token: Require IAT for registration (default: true)
 * - dcr.scope_restriction_enabled: Restrict scopes to registered values (default: false)
 * - dcr.allow_duplicate_software_id: Allow duplicate software_id (default: false)
 */

import type { Env } from '../types/env';
import { createLogger } from './logger';
import { DCR_DEFAULTS, type DCRSettings } from '../types/settings/dcr';

const log = createLogger().module('DCR_CONFIG');

/**
 * KV key for DCR settings (Settings API v2 format)
 * Settings are stored per-tenant under: settings:tenant:{tenantId}:dcr
 */
function getDCRSettingsKVKey(tenantId: string): string {
  return `settings:tenant:${tenantId}:dcr`;
}

function requireTenantId(tenantId: string, context: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error(`${context} requires tenantId`);
  }
  return normalized;
}

/**
 * In-memory cache for DCR settings
 */
interface CachedDCRSettings {
  data: Record<string, unknown>;
  expiresAt: number;
}

const cache: Map<string, CachedDCRSettings> = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Load DCR settings from KV
 */
async function loadDCRSettingsFromKV(env: Env, tenantId: string): Promise<Record<string, unknown>> {
  if (!tenantId.trim()) {
    throw new Error('DCR settings require tenantId');
  }
  const cacheKey = getDCRSettingsKVKey(tenantId);

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  // Settings API v2 stores category-scoped tenant settings in SETTINGS.
  // Keep AUTHRIM_CONFIG as a legacy fallback for older deployments.
  for (const kv of [env.SETTINGS, env.AUTHRIM_CONFIG]) {
    if (!kv) {
      continue;
    }

    try {
      const json = await kv.get(cacheKey);
      if (json) {
        const data = JSON.parse(json) as Record<string, unknown>;
        cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
        return data;
      }
    } catch (error) {
      log.warn('Failed to load DCR settings from KV');
    }
  }

  return {};
}

/**
 * Parse boolean from environment variable
 */
function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Get DCR setting value
 * Priority: KV > Environment variable > Default value
 *
 * @param key - Setting key (e.g., 'dcr.enabled')
 * @param env - Environment bindings
 * @param tenantId - Tenant ID
 * @returns Resolved setting value
 */
export async function getDCRSetting<K extends keyof DCRSettings>(
  key: K,
  env: Env,
  tenantId: string
): Promise<DCRSettings[K]> {
  // Load KV settings
  const kvSettings = await loadDCRSettingsFromKV(env, tenantId);

  // Check KV first
  if (kvSettings[key] !== undefined) {
    return kvSettings[key] as DCRSettings[K];
  }

  // Check environment variable
  const envKeyMap: Record<keyof DCRSettings, string> = {
    'dcr.enabled': 'DCR_ENABLED',
    'dcr.require_initial_access_token': 'DCR_REQUIRE_INITIAL_ACCESS_TOKEN',
    'dcr.scope_restriction_enabled': 'DCR_SCOPE_RESTRICTION_ENABLED',
    'dcr.allow_duplicate_software_id': 'DCR_ALLOW_DUPLICATE_SOFTWARE_ID',
  };

  const envKey = envKeyMap[key];
  const envValue = (env as unknown as Record<string, string | undefined>)[envKey];

  if (envValue !== undefined && envValue !== '') {
    return parseBool(envValue, DCR_DEFAULTS[key]) as DCRSettings[K];
  }

  // Return default
  return DCR_DEFAULTS[key];
}

/**
 * Get all DCR settings
 */
export async function getAllDCRSettings(env: Env, tenantId: string): Promise<DCRSettings> {
  return {
    'dcr.enabled': await getDCRSetting('dcr.enabled', env, tenantId),
    'dcr.require_initial_access_token': await getDCRSetting(
      'dcr.require_initial_access_token',
      env,
      tenantId
    ),
    'dcr.scope_restriction_enabled': await getDCRSetting(
      'dcr.scope_restriction_enabled',
      env,
      tenantId
    ),
    'dcr.allow_duplicate_software_id': await getDCRSetting(
      'dcr.allow_duplicate_software_id',
      env,
      tenantId
    ),
  };
}

/**
 * Clear DCR settings cache for one tenant.
 * Call this when tenant DCR settings are updated via Admin API.
 */
export function clearDCRSettingsCache(tenantId: string): void {
  cache.delete(getDCRSettingsKVKey(requireTenantId(tenantId, 'clearDCRSettingsCache')));
}

/**
 * Clear DCR settings cache for all tenants.
 * Use only for explicit platform/system-wide settings maintenance.
 */
export function clearAllDCRSettingsCache(): void {
  cache.clear();
}

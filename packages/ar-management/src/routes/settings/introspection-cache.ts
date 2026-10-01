/**
 * Introspection Cache Settings Admin API
 *
 * GET    /api/admin/settings/introspection-cache  - Get settings
 * PUT    /api/admin/settings/introspection-cache  - Update settings
 * DELETE /api/admin/settings/introspection-cache  - Clear override
 *
 * Settings for caching Token Introspection responses
 *
 * Security considerations:
 *   - Only cache active=true responses (revoke status is always checked fresh)
 *   - RFC 7662 Section 4: "responses MUST NOT be cached" refers to HTTP caching
 *   - Server-side application caching is permitted
 *   - Industry standards (Keycloak, Auth0, etc.) implement similarly
 *
 * Settings stored in SETTINGS KV under "system_settings" key:
 * {
 *   "oidc": {
 *     "introspectionCache": {
 *       "enabled": boolean,
 *       "ttlSeconds": number
 *     }
 *   }
 * }
 *
 * Cache stored in AUTHRIM_CONFIG KV:
 *   Key format: introspect_cache:{sha256(jti)}
 *   Value: IntrospectionResponse (JSON)
 *   TTL: configurable via ttlSeconds
 */

import type { Context } from 'hono';
import { getLogger, getTenantIdFromContext, type Env } from '@authrim/ar-lib-core';
import {
  readTenantSettingsView,
  SettingsUnavailableError,
  settingsUnavailableResponse,
} from './settings-unavailable';

// Default settings (default ON = optimized for production)
const DEFAULT_SETTINGS = {
  enabled: true,
  ttlSeconds: 60,
};

export interface IntrospectionCacheSettings {
  enabled: boolean;
  ttlSeconds: number;
}

interface SystemSettings {
  oidc?: {
    tokenExchange?: unknown;
    clientCredentials?: { enabled?: boolean };
    introspectionValidation?: unknown;
    introspectionCache?: Partial<IntrospectionCacheSettings>;
  };
  rateLimit?: unknown;
}

type SettingSource = 'kv' | 'env' | 'default';

interface IntrospectionCacheSettingsSources {
  enabled: SettingSource;
  ttlSeconds: SettingSource;
}

/**
 * Get current Introspection Cache settings (hybrid: KV > env > default)
 */
export async function getIntrospectionCacheSettings(
  env: Env,
  tenantId?: string,
  /** For admin display: settings that cannot be read throw (503) instead of turning the cache off. */
  options: { strict?: boolean } = {}
): Promise<{
  settings: IntrospectionCacheSettings;
  sources: IntrospectionCacheSettingsSources;
}> {
  const settings: IntrospectionCacheSettings = { ...DEFAULT_SETTINGS };
  const sources: IntrospectionCacheSettingsSources = {
    enabled: 'default',
    ttlSeconds: 'default',
  };

  // Check environment variables
  if (env.ENABLE_INTROSPECTION_CACHE !== undefined) {
    settings.enabled = env.ENABLE_INTROSPECTION_CACHE === 'true';
    sources.enabled = 'env';
  }

  if (env.INTROSPECTION_CACHE_TTL !== undefined) {
    const ttl = parseInt(env.INTROSPECTION_CACHE_TTL, 10);
    if (!isNaN(ttl) && ttl > 0) {
      settings.ttlSeconds = ttl;
      sources.ttlSeconds = 'env';
    }
  }

  // For a tenant: its view, as runtime reads it.
  let tenantSettings: SystemSettings | null | undefined;
  if (tenantId) {
    try {
      tenantSettings = await readTenantSettingsView<SystemSettings>(env, tenantId, ['oidc']);
    } catch (error) {
      if (options.strict) throw error;
      // At runtime, settings that cannot be read turn the cache off rather than falling back to
      // an older or env value that enables it: a cached response can outlive a change.
      settings.enabled = false;
      return { settings, sources: { ...sources, enabled: 'default' } };
    }
  }

  // Check KV (takes priority)
  try {
    const systemSettings =
      tenantSettings !== undefined
        ? tenantSettings
        : (JSON.parse(
            (await env.SETTINGS?.get('system_settings')) ?? 'null'
          ) as SystemSettings | null);
    if (systemSettings) {
      const kvSettings = systemSettings.oidc?.introspectionCache;

      if (kvSettings?.enabled !== undefined) {
        settings.enabled = kvSettings.enabled === true;
        sources.enabled = 'kv';
      }

      if (kvSettings?.ttlSeconds !== undefined) {
        const ttl = kvSettings.ttlSeconds;
        if (typeof ttl === 'number' && ttl > 0) {
          settings.ttlSeconds = ttl;
          sources.ttlSeconds = 'kv';
        }
      }
    }
  } catch {
    // Ignore KV errors
  }

  return { settings, sources };
}

/**
 * Get cache settings for use in introspect.ts
 */
export async function getIntrospectionCacheConfig(
  env: Env,
  tenantId?: string
): Promise<IntrospectionCacheSettings> {
  const { settings } = await getIntrospectionCacheSettings(env, tenantId);
  return settings;
}

/**
 * GET /api/admin/settings/introspection-cache
 * Get Introspection Cache settings with their sources
 */
export async function getIntrospectionCacheConfigHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IntrospectionCacheSettingsAPI');
  try {
    const { settings, sources } = await getIntrospectionCacheSettings(
      c.env,
      getTenantIdFromContext(c),
      { strict: true }
    );

    return c.json({
      settings: {
        enabled: {
          value: settings.enabled,
          source: sources.enabled,
          default: DEFAULT_SETTINGS.enabled,
          description:
            'When enabled, caches active=true introspection responses to reduce KeyManager DO and D1 load',
        },
        ttlSeconds: {
          value: settings.ttlSeconds,
          source: sources.ttlSeconds,
          default: DEFAULT_SETTINGS.ttlSeconds,
          description: 'Cache TTL in seconds (recommended: 30-120 seconds)',
        },
      },
      note: 'Cache only stores active=true responses. Revocation checks bypass cache for security.',
    });
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    log.error('Error getting settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get Introspection Cache settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/introspection-cache
 * Update Introspection Cache settings (stored in KV)
 *
 * Request body:
 * {
 *   "enabled": boolean,    // Optional
 *   "ttlSeconds": number   // Optional (must be > 0)
 * }
 */
export async function updateIntrospectionCacheConfigHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IntrospectionCacheSettingsAPI');
  // Check if KV is available
  if (!c.env.SETTINGS) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'SETTINGS KV namespace is not configured',
      },
      500
    );
  }

  let body: Partial<IntrospectionCacheSettings>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid JSON body',
      },
      400
    );
  }

  // Validate enabled
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return c.json(
      {
        error: 'invalid_value',
        error_description: '"enabled" must be a boolean',
      },
      400
    );
  }

  // Validate ttlSeconds
  if (body.ttlSeconds !== undefined) {
    if (typeof body.ttlSeconds !== 'number' || !Number.isInteger(body.ttlSeconds)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"ttlSeconds" must be an integer',
        },
        400
      );
    }

    if (body.ttlSeconds < 1 || body.ttlSeconds > 3600) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"ttlSeconds" must be between 1 and 3600',
        },
        400
      );
    }
  }

  try {
    // Read existing system_settings
    let systemSettings: SystemSettings = {};
    const existingJson = await c.env.SETTINGS.get('system_settings');
    if (existingJson) {
      systemSettings = JSON.parse(existingJson);
    }

    // Initialize nested structure if needed
    if (!systemSettings.oidc) {
      systemSettings.oidc = {};
    }
    if (!systemSettings.oidc.introspectionCache) {
      systemSettings.oidc.introspectionCache = {};
    }

    // Update only provided fields
    if (body.enabled !== undefined) {
      systemSettings.oidc.introspectionCache.enabled = body.enabled;
    }
    if (body.ttlSeconds !== undefined) {
      systemSettings.oidc.introspectionCache.ttlSeconds = body.ttlSeconds;
    }

    // Save back to KV
    await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));

    // Get updated settings
    const { settings } = await getIntrospectionCacheSettings(c.env, getTenantIdFromContext(c), {
      strict: true,
    });

    return c.json({
      success: true,
      settings,
      note: 'Introspection cache settings updated successfully.',
    });
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    log.error('Error updating settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        // SECURITY: Do not expose internal error details
        error_description: 'Failed to update settings',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/introspection-cache
 * Clear Introspection Cache settings override (revert to env/default)
 */
export async function clearIntrospectionCacheConfigHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IntrospectionCacheSettingsAPI');
  // Check if KV is available
  if (!c.env.SETTINGS) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'SETTINGS KV namespace is not configured',
      },
      500
    );
  }

  try {
    // Read existing system_settings
    const existingJson = await c.env.SETTINGS.get('system_settings');
    if (existingJson) {
      const systemSettings = JSON.parse(existingJson) as SystemSettings;

      // Remove introspectionCache settings
      if (systemSettings.oidc?.introspectionCache) {
        delete systemSettings.oidc.introspectionCache;
      }

      // Save back to KV
      await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));
    }

    // Get updated settings (will fall back to env/default)
    const { settings, sources } = await getIntrospectionCacheSettings(
      c.env,
      getTenantIdFromContext(c),
      { strict: true }
    );

    return c.json({
      success: true,
      settings,
      sources,
      note: 'Introspection cache settings cleared. Using env/default values.',
    });
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    log.error('Error clearing settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        // SECURITY: Do not expose internal error details
        error_description: 'Failed to clear settings',
      },
      500
    );
  }
}

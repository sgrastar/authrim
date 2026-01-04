/**
 * FAPI/Security Settings Admin API
 *
 * GET    /api/admin/settings/fapi-security  - Get settings
 * PUT    /api/admin/settings/fapi-security  - Update settings
 * DELETE /api/admin/settings/fapi-security  - Clear override
 *
 * FAPI 2.0 Security Profile and OIDC ACR configuration settings.
 *
 * Settings stored in SETTINGS KV under "system_settings" key:
 * {
 *   "fapi": {
 *     "enabled": boolean,
 *     "strictDPoP": boolean,
 *     "allowPublicClients": boolean
 *   },
 *   "oidc": {
 *     "supportedAcrValues": string[]
 *   }
 * }
 */

import type { Context } from 'hono';
import { getLogger, type Env } from '@authrim/ar-lib-core';

// Default ACR values per OIDC Core / SAML 2.0 specification
const DEFAULT_SUPPORTED_ACR_VALUES = [
  'urn:mace:incommon:iap:silver', // Basic authentication
  'urn:mace:incommon:iap:bronze', // Minimal authentication
  'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport', // Password over TLS
  'urn:oasis:names:tc:SAML:2.0:ac:classes:Password', // Simple password
  '0', // No authentication context (fallback)
];

// Default FAPI security settings (secure defaults)
const DEFAULT_FAPI_SETTINGS = {
  enabled: false, // FAPI 2.0 mode disabled by default
  strictDPoP: true, // When FAPI is enabled, strict DPoP validation is on by default
  allowPublicClients: false, // FAPI 2.0 requires confidential clients
};

interface FapiSecuritySettings {
  fapi: {
    enabled: boolean;
    strictDPoP: boolean;
    allowPublicClients: boolean;
  };
  oidc: {
    supportedAcrValues: string[];
  };
}

interface SystemSettings {
  fapi?: Partial<FapiSecuritySettings['fapi']>;
  oidc?: {
    supportedAcrValues?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type SettingSource = 'kv' | 'env' | 'default';

interface FapiSecuritySettingsSources {
  fapi: {
    enabled: SettingSource;
    strictDPoP: SettingSource;
    allowPublicClients: SettingSource;
  };
  oidc: {
    supportedAcrValues: SettingSource;
  };
}

/**
 * Get current FAPI/Security settings (hybrid: KV > env > default)
 */
export async function getFapiSecuritySettings(env: Env): Promise<{
  settings: FapiSecuritySettings;
  sources: FapiSecuritySettingsSources;
}> {
  const settings: FapiSecuritySettings = {
    fapi: { ...DEFAULT_FAPI_SETTINGS },
    oidc: { supportedAcrValues: [...DEFAULT_SUPPORTED_ACR_VALUES] },
  };

  const sources: FapiSecuritySettingsSources = {
    fapi: {
      enabled: 'default',
      strictDPoP: 'default',
      allowPublicClients: 'default',
    },
    oidc: {
      supportedAcrValues: 'default',
    },
  };

  // Check environment variables for OIDC ACR values
  if (env.SUPPORTED_ACR_VALUES) {
    settings.oidc.supportedAcrValues = env.SUPPORTED_ACR_VALUES.split(',').map((v) => v.trim());
    sources.oidc.supportedAcrValues = 'env';
  }

  // Check KV (takes priority)
  try {
    const settingsJson = await env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const systemSettings = JSON.parse(settingsJson) as SystemSettings;

      // FAPI settings from KV
      if (systemSettings.fapi?.enabled !== undefined) {
        settings.fapi.enabled = systemSettings.fapi.enabled === true;
        sources.fapi.enabled = 'kv';
      }
      if (systemSettings.fapi?.strictDPoP !== undefined) {
        settings.fapi.strictDPoP = systemSettings.fapi.strictDPoP === true;
        sources.fapi.strictDPoP = 'kv';
      }
      if (systemSettings.fapi?.allowPublicClients !== undefined) {
        settings.fapi.allowPublicClients = systemSettings.fapi.allowPublicClients === true;
        sources.fapi.allowPublicClients = 'kv';
      }

      // OIDC ACR values from KV
      if (
        systemSettings.oidc?.supportedAcrValues &&
        Array.isArray(systemSettings.oidc.supportedAcrValues)
      ) {
        settings.oidc.supportedAcrValues = systemSettings.oidc.supportedAcrValues;
        sources.oidc.supportedAcrValues = 'kv';
      }
    }
  } catch {
    // Ignore KV errors
  }

  return { settings, sources };
}

/**
 * Get supported ACR values (for use in authorize.ts)
 */
export async function getSupportedAcrValues(env: Env): Promise<string[]> {
  const { settings } = await getFapiSecuritySettings(env);
  return settings.oidc.supportedAcrValues;
}

/**
 * Get strictDPoP setting (for use in authorize.ts)
 */
export async function getStrictDPoPSetting(env: Env): Promise<boolean> {
  const { settings } = await getFapiSecuritySettings(env);
  // strictDPoP is only relevant when FAPI is enabled
  return settings.fapi.enabled && settings.fapi.strictDPoP;
}

/**
 * GET /api/admin/settings/fapi-security
 * Get FAPI/Security settings with their sources
 */
export async function getFapiSecurityConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('FapiSecurityAPI');
  try {
    const { settings, sources } = await getFapiSecuritySettings(c.env);

    return c.json({
      settings: {
        fapi: {
          enabled: {
            value: settings.fapi.enabled,
            source: sources.fapi.enabled,
            default: DEFAULT_FAPI_SETTINGS.enabled,
            description: 'Enable FAPI 2.0 Security Profile mode',
          },
          strictDPoP: {
            value: settings.fapi.strictDPoP,
            source: sources.fapi.strictDPoP,
            default: DEFAULT_FAPI_SETTINGS.strictDPoP,
            description:
              'When FAPI is enabled, reject invalid DPoP proofs instead of continuing without binding',
          },
          allowPublicClients: {
            value: settings.fapi.allowPublicClients,
            source: sources.fapi.allowPublicClients,
            default: DEFAULT_FAPI_SETTINGS.allowPublicClients,
            description: 'Allow public clients in FAPI 2.0 mode (not recommended)',
          },
        },
        oidc: {
          supportedAcrValues: {
            value: settings.oidc.supportedAcrValues,
            source: sources.oidc.supportedAcrValues,
            default: DEFAULT_SUPPORTED_ACR_VALUES,
            description:
              'Supported Authentication Context Class Reference values for ACR negotiation',
          },
        },
      },
      note: 'FAPI 2.0 enforces PAR, PKCE S256, and confidential clients. strictDPoP rejects invalid DPoP proofs when enabled.',
    });
  } catch (error) {
    log.error('Error getting settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get FAPI/Security settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/fapi-security
 * Update FAPI/Security settings (stored in KV)
 *
 * Request body:
 * {
 *   "fapi": {
 *     "enabled": boolean,      // Optional
 *     "strictDPoP": boolean,   // Optional
 *     "allowPublicClients": boolean // Optional
 *   },
 *   "oidc": {
 *     "supportedAcrValues": string[] // Optional
 *   }
 * }
 */
export async function updateFapiSecurityConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('FapiSecurityAPI');
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

  let body: {
    fapi?: Partial<FapiSecuritySettings['fapi']>;
    oidc?: Partial<FapiSecuritySettings['oidc']>;
  };

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

  // Validate FAPI settings
  if (body.fapi) {
    if (body.fapi.enabled !== undefined && typeof body.fapi.enabled !== 'boolean') {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"fapi.enabled" must be a boolean',
        },
        400
      );
    }
    if (body.fapi.strictDPoP !== undefined && typeof body.fapi.strictDPoP !== 'boolean') {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"fapi.strictDPoP" must be a boolean',
        },
        400
      );
    }
    if (
      body.fapi.allowPublicClients !== undefined &&
      typeof body.fapi.allowPublicClients !== 'boolean'
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"fapi.allowPublicClients" must be a boolean',
        },
        400
      );
    }
  }

  // Validate OIDC ACR values
  if (body.oidc?.supportedAcrValues !== undefined) {
    if (!Array.isArray(body.oidc.supportedAcrValues)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"oidc.supportedAcrValues" must be an array of strings',
        },
        400
      );
    }

    // Validate each ACR value is a non-empty string
    for (const acr of body.oidc.supportedAcrValues) {
      if (typeof acr !== 'string' || acr.trim().length === 0) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: 'Each ACR value must be a non-empty string',
          },
          400
        );
      }
    }

    // Ensure at least one ACR value
    if (body.oidc.supportedAcrValues.length === 0) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"oidc.supportedAcrValues" must contain at least one value',
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

    // Initialize nested structures if needed
    if (!systemSettings.fapi) {
      systemSettings.fapi = {};
    }
    if (!systemSettings.oidc) {
      systemSettings.oidc = {};
    }

    // Update FAPI settings
    if (body.fapi) {
      if (body.fapi.enabled !== undefined) {
        systemSettings.fapi.enabled = body.fapi.enabled;
      }
      if (body.fapi.strictDPoP !== undefined) {
        systemSettings.fapi.strictDPoP = body.fapi.strictDPoP;
      }
      if (body.fapi.allowPublicClients !== undefined) {
        systemSettings.fapi.allowPublicClients = body.fapi.allowPublicClients;
      }
    }

    // Update OIDC ACR values
    if (body.oidc?.supportedAcrValues !== undefined) {
      systemSettings.oidc.supportedAcrValues = body.oidc.supportedAcrValues;
    }

    // Save back to KV
    await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));

    // Get updated settings
    const { settings } = await getFapiSecuritySettings(c.env);

    return c.json({
      success: true,
      settings,
      note: 'FAPI/Security settings updated successfully.',
    });
  } catch (error) {
    log.error('Error updating settings', {}, error as Error);
    // SECURITY: Do not expose internal error details
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update settings',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/fapi-security
 * Clear FAPI/Security settings override (revert to env/default)
 */
export async function clearFapiSecurityConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('FapiSecurityAPI');
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

      // Remove FAPI settings
      if (systemSettings.fapi) {
        delete systemSettings.fapi;
      }

      // Remove OIDC ACR values (but preserve other oidc settings)
      if (systemSettings.oidc?.supportedAcrValues) {
        delete systemSettings.oidc.supportedAcrValues;
      }

      // Save back to KV
      await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));
    }

    // Get updated settings (will fall back to env/default)
    const { settings, sources } = await getFapiSecuritySettings(c.env);

    return c.json({
      success: true,
      settings,
      sources,
      note: 'FAPI/Security settings cleared. Using env/default values.',
    });
  } catch (error) {
    log.error('Error clearing settings', {}, error as Error);
    // SECURITY: Do not expose internal error details
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to clear settings',
      },
      500
    );
  }
}

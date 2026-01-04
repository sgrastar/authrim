/**
 * Introspection Validation Settings Admin API
 *
 * GET    /api/admin/settings/introspection-validation  - Get settings
 * PUT    /api/admin/settings/introspection-validation  - Update settings
 * DELETE /api/admin/settings/introspection-validation  - Clear override
 *
 * Strict validation settings for Token Introspection Control Plane Test
 *
 * RFC 7662 states aud/client_id validation is optional, but
 * when strict validation mode is enabled, the following additional checks are performed:
 *   - Whether aud matches ISSUER_URL
 *   - Whether client_id is a registered client
 *
 * Settings stored in SETTINGS KV under "system_settings" key:
 * {
 *   "oidc": {
 *     "introspectionValidation": {
 *       "strictValidation": boolean,
 *       "expectedAudience": string | null
 *     }
 *   }
 * }
 */

import type { Context } from 'hono';
import { getLogger, type Env } from '@authrim/ar-lib-core';

// Default settings (for security, default is OFF = RFC 7662 standard behavior)
const DEFAULT_SETTINGS = {
  strictValidation: false,
  expectedAudience: null as string | null,
};

interface IntrospectionValidationSettings {
  strictValidation: boolean;
  expectedAudience: string | null;
}

interface SystemSettings {
  oidc?: {
    tokenExchange?: unknown;
    clientCredentials?: { enabled?: boolean };
    introspectionValidation?: Partial<IntrospectionValidationSettings>;
  };
  rateLimit?: unknown;
}

type SettingSource = 'kv' | 'env' | 'default';

interface IntrospectionValidationSettingsSources {
  strictValidation: SettingSource;
  expectedAudience: SettingSource;
}

/**
 * Get current Introspection Validation settings (hybrid: KV > env > default)
 */
export async function getIntrospectionValidationSettings(env: Env): Promise<{
  settings: IntrospectionValidationSettings;
  sources: IntrospectionValidationSettingsSources;
}> {
  const settings: IntrospectionValidationSettings = { ...DEFAULT_SETTINGS };
  const sources: IntrospectionValidationSettingsSources = {
    strictValidation: 'default',
    expectedAudience: 'default',
  };

  // Check environment variables
  if (env.INTROSPECTION_STRICT_VALIDATION !== undefined) {
    settings.strictValidation = env.INTROSPECTION_STRICT_VALIDATION === 'true';
    sources.strictValidation = 'env';
  }

  if (env.INTROSPECTION_EXPECTED_AUDIENCE !== undefined) {
    settings.expectedAudience = env.INTROSPECTION_EXPECTED_AUDIENCE || null;
    sources.expectedAudience = 'env';
  }

  // Check KV (takes priority)
  try {
    const settingsJson = await env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const systemSettings = JSON.parse(settingsJson) as SystemSettings;
      const kvSettings = systemSettings.oidc?.introspectionValidation;

      if (kvSettings?.strictValidation !== undefined) {
        settings.strictValidation = kvSettings.strictValidation === true;
        sources.strictValidation = 'kv';
      }

      if (kvSettings?.expectedAudience !== undefined) {
        settings.expectedAudience = kvSettings.expectedAudience;
        sources.expectedAudience = 'kv';
      }
    }
  } catch {
    // Ignore KV errors
  }

  return { settings, sources };
}

/**
 * Get strictValidation setting value only (for use in introspect.ts)
 */
export async function getIntrospectionStrictValidation(env: Env): Promise<boolean> {
  const { settings } = await getIntrospectionValidationSettings(env);
  return settings.strictValidation;
}

/**
 * Get expectedAudience setting value only (for use in introspect.ts)
 * Returns ISSUER_URL if not explicitly set
 */
export async function getIntrospectionExpectedAudience(env: Env): Promise<string> {
  const { settings } = await getIntrospectionValidationSettings(env);
  return settings.expectedAudience || env.ISSUER_URL || '';
}

/**
 * GET /api/admin/settings/introspection-validation
 * Get Introspection Validation settings with their sources
 */
export async function getIntrospectionValidationConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IntrospectionValidationAPI');
  try {
    const { settings, sources } = await getIntrospectionValidationSettings(c.env);

    return c.json({
      settings: {
        strictValidation: {
          value: settings.strictValidation,
          source: sources.strictValidation,
          default: DEFAULT_SETTINGS.strictValidation,
          description:
            'When enabled, validates aud matches ISSUER_URL and client_id exists in database',
        },
        expectedAudience: {
          value: settings.expectedAudience,
          source: sources.expectedAudience,
          default: DEFAULT_SETTINGS.expectedAudience,
          description: 'Expected audience value (null = use ISSUER_URL)',
        },
      },
      note: 'RFC 7662 does not require aud/client_id validation. Enable strictValidation for additional security checks.',
    });
  } catch (error) {
    log.error('Error getting settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get Introspection Validation settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/introspection-validation
 * Update Introspection Validation settings (stored in KV)
 *
 * Request body:
 * {
 *   "strictValidation": boolean,    // Optional
 *   "expectedAudience": string|null // Optional
 * }
 */
export async function updateIntrospectionValidationConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IntrospectionValidationAPI');
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

  let body: Partial<IntrospectionValidationSettings>;
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

  // Validate strictValidation
  if (body.strictValidation !== undefined && typeof body.strictValidation !== 'boolean') {
    return c.json(
      {
        error: 'invalid_value',
        error_description: '"strictValidation" must be a boolean',
      },
      400
    );
  }

  // Validate expectedAudience
  if (body.expectedAudience !== undefined) {
    if (body.expectedAudience !== null && typeof body.expectedAudience !== 'string') {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"expectedAudience" must be a string or null',
        },
        400
      );
    }

    // If string, validate it's a valid URL
    if (typeof body.expectedAudience === 'string' && body.expectedAudience.length > 0) {
      try {
        new URL(body.expectedAudience);
      } catch {
        return c.json(
          {
            error: 'invalid_value',
            error_description: '"expectedAudience" must be a valid URL',
          },
          400
        );
      }
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
    if (!systemSettings.oidc.introspectionValidation) {
      systemSettings.oidc.introspectionValidation = {};
    }

    // Update only provided fields
    if (body.strictValidation !== undefined) {
      systemSettings.oidc.introspectionValidation.strictValidation = body.strictValidation;
    }
    if (body.expectedAudience !== undefined) {
      systemSettings.oidc.introspectionValidation.expectedAudience = body.expectedAudience;
    }

    // Save back to KV
    await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));

    // Get updated settings
    const { settings } = await getIntrospectionValidationSettings(c.env);

    return c.json({
      success: true,
      settings,
      note: 'Introspection validation settings updated successfully.',
    });
  } catch (error) {
    // Log full error details for debugging but don't expose to client
    log.error('Error updating settings', {}, error as Error);
    // SECURITY: Do not expose internal error details in response
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
 * DELETE /api/admin/settings/introspection-validation
 * Clear Introspection Validation settings override (revert to env/default)
 */
export async function clearIntrospectionValidationConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('IntrospectionValidationAPI');
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

      // Remove introspectionValidation settings
      if (systemSettings.oidc?.introspectionValidation) {
        delete systemSettings.oidc.introspectionValidation;
      }

      // Save back to KV
      await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));
    }

    // Get updated settings (will fall back to env/default)
    const { settings, sources } = await getIntrospectionValidationSettings(c.env);

    return c.json({
      success: true,
      settings,
      sources,
      note: 'Introspection validation settings cleared. Using env/default values.',
    });
  } catch (error) {
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

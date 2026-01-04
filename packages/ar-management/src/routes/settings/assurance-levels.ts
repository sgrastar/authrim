/**
 * NIST SP 800-63-4 Assurance Levels Settings Admin API
 *
 * GET    /api/admin/settings/assurance-levels  - Get settings
 * PUT    /api/admin/settings/assurance-levels  - Update settings
 * DELETE /api/admin/settings/assurance-levels  - Clear override
 *
 * Configuration for Authentication Assurance Level (AAL), Federation Assurance Level (FAL),
 * and Identity Assurance Level (IAL) per NIST SP 800-63 Revision 4.
 *
 * Settings stored in SETTINGS KV under "system_settings" key:
 * {
 *   "assurance": {
 *     "enabled": boolean,
 *     "defaultAAL": "AAL1" | "AAL2" | "AAL3",
 *     "defaultFAL": "FAL1" | "FAL2" | "FAL3",
 *     "defaultIAL": "IAL1" | "IAL2" | "IAL3",
 *     "scopeAALRequirements": { [scope: string]: "AAL2" | "AAL3" },
 *     "includeInIdToken": boolean,
 *     "includeInAccessToken": boolean,
 *     "fal2RequiresDPoP": boolean,
 *     "fal3RequiresPAR": boolean
 *   }
 * }
 */

import type { Context } from 'hono';
import {
  getLogger,
  type Env,
  type AAL,
  type FAL,
  type IAL,
  ASSURANCE_LEVELS_DEFAULTS,
} from '@authrim/ar-lib-core';

// Valid assurance level values
const VALID_AAL: AAL[] = ['AAL1', 'AAL2', 'AAL3'];
const VALID_FAL: FAL[] = ['FAL1', 'FAL2', 'FAL3'];
const VALID_IAL: IAL[] = ['IAL1', 'IAL2', 'IAL3'];

interface AssuranceSettings {
  enabled: boolean;
  defaultAAL: AAL;
  defaultFAL: FAL;
  defaultIAL: IAL;
  scopeAALRequirements: Record<string, AAL>;
  includeInIdToken: boolean;
  includeInAccessToken: boolean;
  fal2RequiresDPoP: boolean;
  fal3RequiresPAR: boolean;
}

interface SystemSettings {
  assurance?: Partial<AssuranceSettings>;
  [key: string]: unknown;
}

type SettingSource = 'kv' | 'env' | 'default';

interface AssuranceSettingsSources {
  enabled: SettingSource;
  defaultAAL: SettingSource;
  defaultFAL: SettingSource;
  defaultIAL: SettingSource;
  scopeAALRequirements: SettingSource;
  includeInIdToken: SettingSource;
  includeInAccessToken: SettingSource;
  fal2RequiresDPoP: SettingSource;
  fal3RequiresPAR: SettingSource;
}

// Default settings (secure defaults per NIST recommendations)
const DEFAULT_ASSURANCE_SETTINGS: AssuranceSettings = {
  enabled: false,
  defaultAAL: 'AAL1',
  defaultFAL: 'FAL1',
  defaultIAL: 'IAL1',
  scopeAALRequirements: {},
  includeInIdToken: true,
  includeInAccessToken: false,
  fal2RequiresDPoP: true,
  fal3RequiresPAR: true,
};

/**
 * Get current Assurance Levels settings (hybrid: KV > env > default)
 */
export async function getAssuranceLevelsSettings(env: Env): Promise<{
  settings: AssuranceSettings;
  sources: AssuranceSettingsSources;
}> {
  const settings: AssuranceSettings = { ...DEFAULT_ASSURANCE_SETTINGS };
  const sources: AssuranceSettingsSources = {
    enabled: 'default',
    defaultAAL: 'default',
    defaultFAL: 'default',
    defaultIAL: 'default',
    scopeAALRequirements: 'default',
    includeInIdToken: 'default',
    includeInAccessToken: 'default',
    fal2RequiresDPoP: 'default',
    fal3RequiresPAR: 'default',
  };

  // Check environment variables
  if (env.NIST_ASSURANCE_LEVELS_ENABLED === 'true') {
    settings.enabled = true;
    sources.enabled = 'env';
  }
  if (env.DEFAULT_AAL && VALID_AAL.includes(env.DEFAULT_AAL as AAL)) {
    settings.defaultAAL = env.DEFAULT_AAL as AAL;
    sources.defaultAAL = 'env';
  }
  if (env.DEFAULT_FAL && VALID_FAL.includes(env.DEFAULT_FAL as FAL)) {
    settings.defaultFAL = env.DEFAULT_FAL as FAL;
    sources.defaultFAL = 'env';
  }
  if (env.DEFAULT_IAL && VALID_IAL.includes(env.DEFAULT_IAL as IAL)) {
    settings.defaultIAL = env.DEFAULT_IAL as IAL;
    sources.defaultIAL = 'env';
  }

  // Check KV (takes priority)
  try {
    const settingsJson = await env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const systemSettings = JSON.parse(settingsJson) as SystemSettings;

      if (systemSettings.assurance?.enabled !== undefined) {
        settings.enabled = systemSettings.assurance.enabled === true;
        sources.enabled = 'kv';
      }
      if (
        systemSettings.assurance?.defaultAAL &&
        VALID_AAL.includes(systemSettings.assurance.defaultAAL)
      ) {
        settings.defaultAAL = systemSettings.assurance.defaultAAL;
        sources.defaultAAL = 'kv';
      }
      if (
        systemSettings.assurance?.defaultFAL &&
        VALID_FAL.includes(systemSettings.assurance.defaultFAL)
      ) {
        settings.defaultFAL = systemSettings.assurance.defaultFAL;
        sources.defaultFAL = 'kv';
      }
      if (
        systemSettings.assurance?.defaultIAL &&
        VALID_IAL.includes(systemSettings.assurance.defaultIAL)
      ) {
        settings.defaultIAL = systemSettings.assurance.defaultIAL;
        sources.defaultIAL = 'kv';
      }
      if (
        systemSettings.assurance?.scopeAALRequirements &&
        typeof systemSettings.assurance.scopeAALRequirements === 'object'
      ) {
        settings.scopeAALRequirements = systemSettings.assurance.scopeAALRequirements;
        sources.scopeAALRequirements = 'kv';
      }
      if (systemSettings.assurance?.includeInIdToken !== undefined) {
        settings.includeInIdToken = systemSettings.assurance.includeInIdToken === true;
        sources.includeInIdToken = 'kv';
      }
      if (systemSettings.assurance?.includeInAccessToken !== undefined) {
        settings.includeInAccessToken = systemSettings.assurance.includeInAccessToken === true;
        sources.includeInAccessToken = 'kv';
      }
      if (systemSettings.assurance?.fal2RequiresDPoP !== undefined) {
        settings.fal2RequiresDPoP = systemSettings.assurance.fal2RequiresDPoP === true;
        sources.fal2RequiresDPoP = 'kv';
      }
      if (systemSettings.assurance?.fal3RequiresPAR !== undefined) {
        settings.fal3RequiresPAR = systemSettings.assurance.fal3RequiresPAR === true;
        sources.fal3RequiresPAR = 'kv';
      }
    }
  } catch {
    // Ignore KV errors
  }

  return { settings, sources };
}

/**
 * Check if assurance levels feature is enabled
 */
export async function isAssuranceLevelsEnabled(env: Env): Promise<boolean> {
  const { settings } = await getAssuranceLevelsSettings(env);
  return settings.enabled;
}

/**
 * Get required AAL for a given scope
 */
export async function getRequiredAALForScope(env: Env, scope: string): Promise<AAL | null> {
  const { settings } = await getAssuranceLevelsSettings(env);
  if (!settings.enabled) return null;
  return settings.scopeAALRequirements[scope] || null;
}

/**
 * GET /api/admin/settings/assurance-levels
 * Get Assurance Levels settings with their sources
 */
export async function getAssuranceLevelsConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AssuranceLevelsAPI');
  try {
    const { settings, sources } = await getAssuranceLevelsSettings(c.env);

    return c.json({
      settings: {
        enabled: {
          value: settings.enabled,
          source: sources.enabled,
          default: DEFAULT_ASSURANCE_SETTINGS.enabled,
          description: 'Enable NIST SP 800-63-4 assurance level tracking',
        },
        defaultAAL: {
          value: settings.defaultAAL,
          source: sources.defaultAAL,
          default: DEFAULT_ASSURANCE_SETTINGS.defaultAAL,
          description: 'Default Authentication Assurance Level for new sessions',
          validValues: VALID_AAL,
        },
        defaultFAL: {
          value: settings.defaultFAL,
          source: sources.defaultFAL,
          default: DEFAULT_ASSURANCE_SETTINGS.defaultFAL,
          description: 'Default Federation Assurance Level',
          validValues: VALID_FAL,
        },
        defaultIAL: {
          value: settings.defaultIAL,
          source: sources.defaultIAL,
          default: DEFAULT_ASSURANCE_SETTINGS.defaultIAL,
          description: 'Default Identity Assurance Level for new users',
          validValues: VALID_IAL,
        },
        scopeAALRequirements: {
          value: settings.scopeAALRequirements,
          source: sources.scopeAALRequirements,
          default: DEFAULT_ASSURANCE_SETTINGS.scopeAALRequirements,
          description: 'Minimum AAL required for specific scopes (e.g., {"admin": "AAL2"})',
        },
        includeInIdToken: {
          value: settings.includeInIdToken,
          source: sources.includeInIdToken,
          default: DEFAULT_ASSURANCE_SETTINGS.includeInIdToken,
          description: 'Include acr/amr/aal/fal claims in ID tokens',
        },
        includeInAccessToken: {
          value: settings.includeInAccessToken,
          source: sources.includeInAccessToken,
          default: DEFAULT_ASSURANCE_SETTINGS.includeInAccessToken,
          description: 'Include assurance level claims in access tokens',
        },
        fal2RequiresDPoP: {
          value: settings.fal2RequiresDPoP,
          source: sources.fal2RequiresDPoP,
          default: DEFAULT_ASSURANCE_SETTINGS.fal2RequiresDPoP,
          description: 'Require DPoP proof-of-possession for FAL2 and higher',
        },
        fal3RequiresPAR: {
          value: settings.fal3RequiresPAR,
          source: sources.fal3RequiresPAR,
          default: DEFAULT_ASSURANCE_SETTINGS.fal3RequiresPAR,
          description: 'Require Pushed Authorization Requests for FAL3',
        },
      },
      note: 'NIST SP 800-63-4 defines AAL (Authentication), FAL (Federation), and IAL (Identity) assurance levels.',
    });
  } catch (error) {
    log.error('Error getting settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get Assurance Levels settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/assurance-levels
 * Update Assurance Levels settings (stored in KV)
 */
export async function updateAssuranceLevelsConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AssuranceLevelsAPI');

  if (!c.env.SETTINGS) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'SETTINGS KV namespace is not configured',
      },
      500
    );
  }

  let body: Partial<AssuranceSettings>;
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

  // Validate AAL/FAL/IAL values
  if (body.defaultAAL && !VALID_AAL.includes(body.defaultAAL)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid defaultAAL. Valid values: ${VALID_AAL.join(', ')}`,
      },
      400
    );
  }
  if (body.defaultFAL && !VALID_FAL.includes(body.defaultFAL)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid defaultFAL. Valid values: ${VALID_FAL.join(', ')}`,
      },
      400
    );
  }
  if (body.defaultIAL && !VALID_IAL.includes(body.defaultIAL)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid defaultIAL. Valid values: ${VALID_IAL.join(', ')}`,
      },
      400
    );
  }

  // Validate scopeAALRequirements
  if (body.scopeAALRequirements) {
    if (typeof body.scopeAALRequirements !== 'object') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'scopeAALRequirements must be an object',
        },
        400
      );
    }
    for (const [scope, aal] of Object.entries(body.scopeAALRequirements)) {
      if (!VALID_AAL.includes(aal as AAL)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid AAL '${aal}' for scope '${scope}'. Valid values: ${VALID_AAL.join(', ')}`,
          },
          400
        );
      }
    }
  }

  try {
    // Get existing settings
    const existingJson = await c.env.SETTINGS.get('system_settings');
    const systemSettings: SystemSettings = existingJson ? JSON.parse(existingJson) : {};

    // Merge new assurance settings
    systemSettings.assurance = {
      ...systemSettings.assurance,
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.defaultAAL && { defaultAAL: body.defaultAAL }),
      ...(body.defaultFAL && { defaultFAL: body.defaultFAL }),
      ...(body.defaultIAL && { defaultIAL: body.defaultIAL }),
      ...(body.scopeAALRequirements && { scopeAALRequirements: body.scopeAALRequirements }),
      ...(body.includeInIdToken !== undefined && { includeInIdToken: body.includeInIdToken }),
      ...(body.includeInAccessToken !== undefined && {
        includeInAccessToken: body.includeInAccessToken,
      }),
      ...(body.fal2RequiresDPoP !== undefined && { fal2RequiresDPoP: body.fal2RequiresDPoP }),
      ...(body.fal3RequiresPAR !== undefined && { fal3RequiresPAR: body.fal3RequiresPAR }),
    };

    // Save to KV
    await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));

    log.info('Assurance Levels settings updated', {
      updatedFields: Object.keys(body),
      action: 'SettingsUpdate',
    });

    // Return updated settings
    return getAssuranceLevelsConfig(c);
  } catch (error) {
    log.error('Error updating settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update Assurance Levels settings',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/assurance-levels
 * Clear Assurance Levels settings from KV (revert to env/defaults)
 */
export async function deleteAssuranceLevelsConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AssuranceLevelsAPI');

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
    // Get existing settings
    const existingJson = await c.env.SETTINGS.get('system_settings');
    if (existingJson) {
      const systemSettings: SystemSettings = JSON.parse(existingJson);

      // Remove assurance settings
      delete systemSettings.assurance;

      // Save updated settings
      await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));

      log.info('Assurance Levels settings cleared', { action: 'SettingsDelete' });
    }

    return c.json({
      message: 'Assurance Levels settings cleared. Will now use environment variables or defaults.',
    });
  } catch (error) {
    log.error('Error deleting settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete Assurance Levels settings',
      },
      500
    );
  }
}

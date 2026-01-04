/**
 * Token Exchange (RFC 8693) & ID-JAG Settings Admin API
 *
 * GET  /api/admin/settings/token-exchange     - Get Token Exchange settings
 * PUT  /api/admin/settings/token-exchange     - Update Token Exchange settings
 *
 * Settings stored in SETTINGS KV under "system_settings" key:
 * {
 *   "oidc": {
 *     "tokenExchange": {
 *       "enabled": boolean,
 *       "allowedSubjectTokenTypes": string[],
 *       "maxResourceParams": number,
 *       "maxAudienceParams": number,
 *       "idJag": {
 *         "enabled": boolean,
 *         "allowedIssuers": string[],
 *         "maxTokenLifetime": number,
 *         "includeTenantClaim": boolean,
 *         "requireConfidentialClient": boolean
 *       }
 *     }
 *   }
 * }
 *
 * @see RFC 8693 (Token Exchange)
 * @see draft-ietf-oauth-identity-assertion-authz-grant (ID-JAG)
 */

import type { Context } from 'hono';
import { getLogger, type Env } from '@authrim/ar-lib-core';

// Valid token types for Token Exchange
const VALID_TOKEN_TYPES = ['access_token', 'jwt', 'id_token'] as const;
type TokenType = (typeof VALID_TOKEN_TYPES)[number];

// Parameter limits constraints
const MIN_PARAM_LIMIT = 1;
const MAX_PARAM_LIMIT = 100; // Reasonable upper bound

// ID-JAG token lifetime constraints (seconds)
const MIN_ID_JAG_LIFETIME = 60; // 1 minute
const MAX_ID_JAG_LIFETIME = 86400; // 24 hours

// ID-JAG Settings
interface IdJagSettings {
  enabled: boolean;
  allowedIssuers: string[];
  maxTokenLifetime: number;
  includeTenantClaim: boolean;
  requireConfidentialClient: boolean;
}

// Default ID-JAG settings (secure defaults per spec)
const DEFAULT_ID_JAG_SETTINGS: IdJagSettings = {
  enabled: false,
  allowedIssuers: [],
  maxTokenLifetime: 3600, // 1 hour
  includeTenantClaim: true,
  requireConfidentialClient: true, // SHOULD only be supported for confidential clients
};

// Default settings
const DEFAULT_SETTINGS = {
  enabled: false,
  allowedSubjectTokenTypes: ['access_token'] as TokenType[],
  maxResourceParams: 10,
  maxAudienceParams: 10,
};

interface TokenExchangeSettings {
  enabled: boolean;
  allowedSubjectTokenTypes: TokenType[];
  maxResourceParams: number;
  maxAudienceParams: number;
  idJag?: IdJagSettings;
}

// SystemSettings stores partial/incomplete settings in KV
// Each field can be undefined until explicitly set
interface SystemSettings {
  oidc?: {
    tokenExchange?: {
      enabled?: boolean;
      allowedSubjectTokenTypes?: TokenType[];
      maxResourceParams?: number;
      maxAudienceParams?: number;
      idJag?: Partial<IdJagSettings>;
    };
    clientCredentials?: { enabled?: boolean };
  };
  rateLimit?: unknown;
}

type SettingSource = 'kv' | 'env' | 'default';

interface TokenExchangeSettingsSources {
  enabled: SettingSource;
  allowedSubjectTokenTypes: SettingSource;
  maxResourceParams: SettingSource;
  maxAudienceParams: SettingSource;
}

interface IdJagSettingsSources {
  enabled: SettingSource;
  allowedIssuers: SettingSource;
  maxTokenLifetime: SettingSource;
  includeTenantClaim: SettingSource;
  requireConfidentialClient: SettingSource;
}

/**
 * Get current ID-JAG settings (hybrid: KV > env > default)
 * Exported for use in token endpoint and discovery
 */
export async function getIdJagSettings(env: Env): Promise<{
  settings: IdJagSettings;
  sources: IdJagSettingsSources;
}> {
  const settings: IdJagSettings = { ...DEFAULT_ID_JAG_SETTINGS };
  const sources: IdJagSettingsSources = {
    enabled: 'default',
    allowedIssuers: 'default',
    maxTokenLifetime: 'default',
    includeTenantClaim: 'default',
    requireConfidentialClient: 'default',
  };

  // Check environment variables
  if (env.ID_JAG_ENABLED !== undefined) {
    settings.enabled = env.ID_JAG_ENABLED === 'true';
    sources.enabled = 'env';
  }

  if (env.ID_JAG_ALLOWED_ISSUERS) {
    settings.allowedIssuers = env.ID_JAG_ALLOWED_ISSUERS.split(',').map((s: string) => s.trim());
    sources.allowedIssuers = 'env';
  }

  if (env.ID_JAG_MAX_TOKEN_LIFETIME) {
    const parsed = parseInt(env.ID_JAG_MAX_TOKEN_LIFETIME, 10);
    if (!isNaN(parsed) && parsed >= MIN_ID_JAG_LIFETIME && parsed <= MAX_ID_JAG_LIFETIME) {
      settings.maxTokenLifetime = parsed;
      sources.maxTokenLifetime = 'env';
    }
  }

  // Check KV (takes priority)
  try {
    const settingsJson = await env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const systemSettings = JSON.parse(settingsJson) as SystemSettings;
      const kvSettings = systemSettings.oidc?.tokenExchange?.idJag;

      if (kvSettings?.enabled !== undefined) {
        settings.enabled = kvSettings.enabled === true;
        sources.enabled = 'kv';
      }

      if (Array.isArray(kvSettings?.allowedIssuers)) {
        settings.allowedIssuers = kvSettings.allowedIssuers;
        sources.allowedIssuers = 'kv';
      }

      if (typeof kvSettings?.maxTokenLifetime === 'number') {
        const value = kvSettings.maxTokenLifetime;
        if (value >= MIN_ID_JAG_LIFETIME && value <= MAX_ID_JAG_LIFETIME) {
          settings.maxTokenLifetime = value;
          sources.maxTokenLifetime = 'kv';
        }
      }

      if (kvSettings?.includeTenantClaim !== undefined) {
        settings.includeTenantClaim = kvSettings.includeTenantClaim === true;
        sources.includeTenantClaim = 'kv';
      }

      if (kvSettings?.requireConfidentialClient !== undefined) {
        settings.requireConfidentialClient = kvSettings.requireConfidentialClient === true;
        sources.requireConfidentialClient = 'kv';
      }
    }
  } catch {
    // Ignore KV errors
  }

  return { settings, sources };
}

/**
 * Get current Token Exchange settings (hybrid: KV > env > default)
 */
async function getTokenExchangeSettings(env: Env): Promise<{
  settings: TokenExchangeSettings;
  sources: TokenExchangeSettingsSources;
  idJag: { settings: IdJagSettings; sources: IdJagSettingsSources };
}> {
  const settings: TokenExchangeSettings = { ...DEFAULT_SETTINGS };
  const sources: TokenExchangeSettingsSources = {
    enabled: 'default',
    allowedSubjectTokenTypes: 'default',
    maxResourceParams: 'default',
    maxAudienceParams: 'default',
  };

  // Check environment variables
  if (env.ENABLE_TOKEN_EXCHANGE !== undefined) {
    settings.enabled = env.ENABLE_TOKEN_EXCHANGE === 'true';
    sources.enabled = 'env';
  }

  if (env.TOKEN_EXCHANGE_ALLOWED_TYPES) {
    const types = env.TOKEN_EXCHANGE_ALLOWED_TYPES.split(',')
      .map((t) => t.trim())
      .filter((t) => VALID_TOKEN_TYPES.includes(t as TokenType)) as TokenType[];
    if (types.length > 0) {
      settings.allowedSubjectTokenTypes = types;
      sources.allowedSubjectTokenTypes = 'env';
    }
  }

  // Environment variables for parameter limits
  if (env.TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS) {
    const parsed = parseInt(env.TOKEN_EXCHANGE_MAX_RESOURCE_PARAMS, 10);
    if (!isNaN(parsed) && parsed >= MIN_PARAM_LIMIT && parsed <= MAX_PARAM_LIMIT) {
      settings.maxResourceParams = parsed;
      sources.maxResourceParams = 'env';
    }
  }

  if (env.TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS) {
    const parsed = parseInt(env.TOKEN_EXCHANGE_MAX_AUDIENCE_PARAMS, 10);
    if (!isNaN(parsed) && parsed >= MIN_PARAM_LIMIT && parsed <= MAX_PARAM_LIMIT) {
      settings.maxAudienceParams = parsed;
      sources.maxAudienceParams = 'env';
    }
  }

  // Check KV (takes priority)
  try {
    const settingsJson = await env.SETTINGS?.get('system_settings');
    if (settingsJson) {
      const systemSettings = JSON.parse(settingsJson) as SystemSettings;
      const kvSettings = systemSettings.oidc?.tokenExchange;

      if (kvSettings?.enabled !== undefined) {
        settings.enabled = kvSettings.enabled === true;
        sources.enabled = 'kv';
      }

      if (Array.isArray(kvSettings?.allowedSubjectTokenTypes)) {
        const validTypes = kvSettings.allowedSubjectTokenTypes.filter((t) =>
          VALID_TOKEN_TYPES.includes(t as TokenType)
        ) as TokenType[];
        if (validTypes.length > 0) {
          settings.allowedSubjectTokenTypes = validTypes;
          sources.allowedSubjectTokenTypes = 'kv';
        }
      }

      if (typeof kvSettings?.maxResourceParams === 'number') {
        const value = kvSettings.maxResourceParams;
        if (value >= MIN_PARAM_LIMIT && value <= MAX_PARAM_LIMIT) {
          settings.maxResourceParams = value;
          sources.maxResourceParams = 'kv';
        }
      }

      if (typeof kvSettings?.maxAudienceParams === 'number') {
        const value = kvSettings.maxAudienceParams;
        if (value >= MIN_PARAM_LIMIT && value <= MAX_PARAM_LIMIT) {
          settings.maxAudienceParams = value;
          sources.maxAudienceParams = 'kv';
        }
      }
    }
  } catch {
    // Ignore KV errors
  }

  // Get ID-JAG settings
  const idJag = await getIdJagSettings(env);

  return { settings, sources, idJag };
}

/**
 * GET /api/admin/settings/token-exchange
 * Get Token Exchange settings with their sources
 */
export async function getTokenExchangeConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TokenExchangeSettingsAPI');
  try {
    const { settings, sources, idJag } = await getTokenExchangeSettings(c.env);

    return c.json({
      settings: {
        enabled: {
          value: settings.enabled,
          source: sources.enabled,
          default: DEFAULT_SETTINGS.enabled,
        },
        allowedSubjectTokenTypes: {
          value: settings.allowedSubjectTokenTypes,
          source: sources.allowedSubjectTokenTypes,
          default: DEFAULT_SETTINGS.allowedSubjectTokenTypes,
          validOptions: VALID_TOKEN_TYPES,
        },
        maxResourceParams: {
          value: settings.maxResourceParams,
          source: sources.maxResourceParams,
          default: DEFAULT_SETTINGS.maxResourceParams,
          min: MIN_PARAM_LIMIT,
          max: MAX_PARAM_LIMIT,
        },
        maxAudienceParams: {
          value: settings.maxAudienceParams,
          source: sources.maxAudienceParams,
          default: DEFAULT_SETTINGS.maxAudienceParams,
          min: MIN_PARAM_LIMIT,
          max: MAX_PARAM_LIMIT,
        },
        // ID-JAG (Identity Assertion Authorization Grant) settings
        idJag: {
          enabled: {
            value: idJag.settings.enabled,
            source: idJag.sources.enabled,
            default: DEFAULT_ID_JAG_SETTINGS.enabled,
            description: 'Enable ID-JAG token type for identity chaining',
          },
          allowedIssuers: {
            value: idJag.settings.allowedIssuers,
            source: idJag.sources.allowedIssuers,
            default: DEFAULT_ID_JAG_SETTINGS.allowedIssuers,
            description: 'List of trusted IdP issuers for subject_token validation',
          },
          maxTokenLifetime: {
            value: idJag.settings.maxTokenLifetime,
            source: idJag.sources.maxTokenLifetime,
            default: DEFAULT_ID_JAG_SETTINGS.maxTokenLifetime,
            min: MIN_ID_JAG_LIFETIME,
            max: MAX_ID_JAG_LIFETIME,
            unit: 'seconds',
            description: 'Maximum lifetime for issued ID-JAG tokens',
          },
          includeTenantClaim: {
            value: idJag.settings.includeTenantClaim,
            source: idJag.sources.includeTenantClaim,
            default: DEFAULT_ID_JAG_SETTINGS.includeTenantClaim,
            description: 'Include tenant claim in ID-JAG tokens',
          },
          requireConfidentialClient: {
            value: idJag.settings.requireConfidentialClient,
            source: idJag.sources.requireConfidentialClient,
            default: DEFAULT_ID_JAG_SETTINGS.requireConfidentialClient,
            description: 'Only allow confidential clients to use ID-JAG (recommended per spec)',
          },
        },
      },
      note: 'refresh_token is never allowed for security reasons, regardless of settings.',
      idJagNote:
        'ID-JAG implements draft-ietf-oauth-identity-assertion-authz-grant for IdP-mediated authorization.',
    });
  } catch (error) {
    log.error('Error getting settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get Token Exchange settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/token-exchange
 * Update Token Exchange settings (stored in KV)
 *
 * Request body:
 * {
 *   "enabled": boolean,                    // Optional
 *   "allowedSubjectTokenTypes": string[],  // Optional
 *   "maxResourceParams": number,           // Optional (1-100)
 *   "maxAudienceParams": number,           // Optional (1-100)
 *   "idJag": {                             // Optional - ID-JAG settings
 *     "enabled": boolean,
 *     "allowedIssuers": string[],
 *     "maxTokenLifetime": number,
 *     "includeTenantClaim": boolean,
 *     "requireConfidentialClient": boolean
 *   }
 * }
 */
export async function updateTokenExchangeConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TokenExchangeSettingsAPI');
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

  let body: Partial<TokenExchangeSettings> & { idJag?: Partial<IdJagSettings> };
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

  // Validate allowedSubjectTokenTypes
  if (body.allowedSubjectTokenTypes !== undefined) {
    if (!Array.isArray(body.allowedSubjectTokenTypes)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"allowedSubjectTokenTypes" must be an array',
        },
        400
      );
    }

    const invalidTypes = body.allowedSubjectTokenTypes.filter(
      (t) => !VALID_TOKEN_TYPES.includes(t as TokenType)
    );
    if (invalidTypes.length > 0) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `Invalid token types: ${invalidTypes.join(', ')}. Valid types: ${VALID_TOKEN_TYPES.join(', ')}`,
        },
        400
      );
    }

    // Security: reject if refresh_token is attempted
    if (body.allowedSubjectTokenTypes.includes('refresh_token' as TokenType)) {
      return c.json(
        {
          error: 'security_violation',
          error_description:
            'refresh_token cannot be allowed as subject_token_type for security reasons',
        },
        400
      );
    }
  }

  // Validate maxResourceParams
  if (body.maxResourceParams !== undefined) {
    if (typeof body.maxResourceParams !== 'number' || !Number.isInteger(body.maxResourceParams)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"maxResourceParams" must be an integer',
        },
        400
      );
    }
    if (body.maxResourceParams < MIN_PARAM_LIMIT || body.maxResourceParams > MAX_PARAM_LIMIT) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `"maxResourceParams" must be between ${MIN_PARAM_LIMIT} and ${MAX_PARAM_LIMIT}`,
        },
        400
      );
    }
  }

  // Validate maxAudienceParams
  if (body.maxAudienceParams !== undefined) {
    if (typeof body.maxAudienceParams !== 'number' || !Number.isInteger(body.maxAudienceParams)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"maxAudienceParams" must be an integer',
        },
        400
      );
    }
    if (body.maxAudienceParams < MIN_PARAM_LIMIT || body.maxAudienceParams > MAX_PARAM_LIMIT) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `"maxAudienceParams" must be between ${MIN_PARAM_LIMIT} and ${MAX_PARAM_LIMIT}`,
        },
        400
      );
    }
  }

  // Validate ID-JAG settings
  if (body.idJag !== undefined) {
    if (typeof body.idJag !== 'object' || body.idJag === null) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"idJag" must be an object',
        },
        400
      );
    }

    // Validate idJag.enabled
    if (body.idJag.enabled !== undefined && typeof body.idJag.enabled !== 'boolean') {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"idJag.enabled" must be a boolean',
        },
        400
      );
    }

    // Validate idJag.allowedIssuers
    if (body.idJag.allowedIssuers !== undefined) {
      if (!Array.isArray(body.idJag.allowedIssuers)) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: '"idJag.allowedIssuers" must be an array of strings',
          },
          400
        );
      }
      for (const issuer of body.idJag.allowedIssuers) {
        if (typeof issuer !== 'string' || issuer.trim().length === 0) {
          return c.json(
            {
              error: 'invalid_value',
              error_description: 'Each issuer in "idJag.allowedIssuers" must be a non-empty string',
            },
            400
          );
        }
        // Validate issuer is a valid URL
        try {
          new URL(issuer);
        } catch {
          return c.json(
            {
              error: 'invalid_value',
              error_description: `Invalid issuer URL: ${issuer}`,
            },
            400
          );
        }
      }
    }

    // Validate idJag.maxTokenLifetime
    if (body.idJag.maxTokenLifetime !== undefined) {
      if (
        typeof body.idJag.maxTokenLifetime !== 'number' ||
        !Number.isInteger(body.idJag.maxTokenLifetime)
      ) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: '"idJag.maxTokenLifetime" must be an integer',
          },
          400
        );
      }
      if (
        body.idJag.maxTokenLifetime < MIN_ID_JAG_LIFETIME ||
        body.idJag.maxTokenLifetime > MAX_ID_JAG_LIFETIME
      ) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: `"idJag.maxTokenLifetime" must be between ${MIN_ID_JAG_LIFETIME} and ${MAX_ID_JAG_LIFETIME} seconds`,
          },
          400
        );
      }
    }

    // Validate idJag.includeTenantClaim
    if (
      body.idJag.includeTenantClaim !== undefined &&
      typeof body.idJag.includeTenantClaim !== 'boolean'
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"idJag.includeTenantClaim" must be a boolean',
        },
        400
      );
    }

    // Validate idJag.requireConfidentialClient
    if (
      body.idJag.requireConfidentialClient !== undefined &&
      typeof body.idJag.requireConfidentialClient !== 'boolean'
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"idJag.requireConfidentialClient" must be a boolean',
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
    if (!systemSettings.oidc.tokenExchange) {
      systemSettings.oidc.tokenExchange = {};
    }

    // Update only provided fields
    if (body.enabled !== undefined) {
      systemSettings.oidc.tokenExchange.enabled = body.enabled;
    }
    if (body.allowedSubjectTokenTypes !== undefined) {
      systemSettings.oidc.tokenExchange.allowedSubjectTokenTypes =
        body.allowedSubjectTokenTypes as TokenType[];
    }
    if (body.maxResourceParams !== undefined) {
      systemSettings.oidc.tokenExchange.maxResourceParams = body.maxResourceParams;
    }
    if (body.maxAudienceParams !== undefined) {
      systemSettings.oidc.tokenExchange.maxAudienceParams = body.maxAudienceParams;
    }

    // Update ID-JAG settings
    if (body.idJag !== undefined) {
      const existingIdJag = systemSettings.oidc.tokenExchange.idJag ?? {};
      systemSettings.oidc.tokenExchange.idJag = {
        ...existingIdJag,
        ...(body.idJag.enabled !== undefined && { enabled: body.idJag.enabled }),
        ...(body.idJag.allowedIssuers !== undefined && {
          allowedIssuers: body.idJag.allowedIssuers,
        }),
        ...(body.idJag.maxTokenLifetime !== undefined && {
          maxTokenLifetime: body.idJag.maxTokenLifetime,
        }),
        ...(body.idJag.includeTenantClaim !== undefined && {
          includeTenantClaim: body.idJag.includeTenantClaim,
        }),
        ...(body.idJag.requireConfidentialClient !== undefined && {
          requireConfidentialClient: body.idJag.requireConfidentialClient,
        }),
      };
    }

    // Save back to KV
    await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));

    // Get updated settings
    const { settings, idJag } = await getTokenExchangeSettings(c.env);

    return c.json({
      success: true,
      settings: {
        ...settings,
        idJag: idJag.settings,
      },
      note: 'Settings updated successfully.',
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
 * DELETE /api/admin/settings/token-exchange
 * Clear Token Exchange settings override (revert to env/default)
 */
export async function clearTokenExchangeConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TokenExchangeSettingsAPI');
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

      // Remove tokenExchange settings
      if (systemSettings.oidc?.tokenExchange) {
        delete systemSettings.oidc.tokenExchange;
      }

      // Save back to KV
      await c.env.SETTINGS.put('system_settings', JSON.stringify(systemSettings));
    }

    // Get updated settings (will fall back to env/default)
    const { settings, sources } = await getTokenExchangeSettings(c.env);

    return c.json({
      success: true,
      settings,
      sources,
      note: 'Token Exchange settings cleared. Using env/default values.',
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

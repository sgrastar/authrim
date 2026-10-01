/**
 * Logout Configuration Admin API
 *
 * GET  /api/admin/settings/logout        - Get logout configuration
 * PUT  /api/admin/settings/logout        - Update logout configuration
 * DELETE /api/admin/settings/logout      - Reset to default configuration
 *
 * Phase A-6: Backchannel Logout configuration management
 */

import type { Context } from 'hono';
import {
  DEFAULT_LOGOUT_CONFIG,
  LOGOUT_SETTINGS_KEY,
  applyBackchannelLogoutSettings,
  getLogger,
  getTenantIdFromContext,
  resolveEffectiveSettingsWithSources,
  type LogoutConfig,
  type BackchannelLogoutConfig,
  type Env,
} from '@authrim/ar-lib-core';
import { SettingsUnavailableError, settingsUnavailableResponse } from './settings-unavailable';

const BACKCHANNEL_SETTING_KEYS = [
  'session.backchannel_logout_token_exp',
  'session.backchannel_request_timeout_ms',
  'session.backchannel_retry_max_attempts',
  'session.backchannel_retry_initial_delay_ms',
  'session.backchannel_retry_max_delay_ms',
  'session.backchannel_retry_backoff_multiplier',
  'session.backchannel_on_failure',
] as const;

/**
 * The config the request's tenant gets: back-channel values resolved through the Settings API
 * (`session.backchannel_*`: tenant, else this document, else env, else defaults) apply over this
 * document, as the logout handler applies them; with where each of those values comes from.
 * Throws SettingsUnavailableError (503) when they cannot be read.
 */
async function effectiveLogoutConfig(
  c: Context<{ Bindings: Env }>,
  config: LogoutConfig
): Promise<{ config: LogoutConfig; backchannelSources: Record<string, string> }> {
  try {
    const { values, sources } = await resolveEffectiveSettingsWithSources(c.env, 'session', {
      tenantId: getTenantIdFromContext(c),
      freshLegacy: true,
    });
    return {
      config: {
        ...config,
        backchannel: applyBackchannelLogoutSettings(config.backchannel, values),
      },
      backchannelSources: Object.fromEntries(
        BACKCHANNEL_SETTING_KEYS.map((key) => [key, sources[key]])
      ),
    };
  } catch (error) {
    throw new SettingsUnavailableError(error);
  }
}

/**
 * Validate BackchannelLogoutConfig values
 */
function validateBackchannelConfig(config: Partial<BackchannelLogoutConfig>): {
  valid: boolean;
  error?: string;
} {
  if (config.logout_token_exp_seconds !== undefined) {
    if (
      typeof config.logout_token_exp_seconds !== 'number' ||
      config.logout_token_exp_seconds < 30 ||
      config.logout_token_exp_seconds > 600
    ) {
      return {
        valid: false,
        error: 'logout_token_exp_seconds must be a number between 30 and 600',
      };
    }
  }

  if (config.request_timeout_ms !== undefined) {
    if (
      typeof config.request_timeout_ms !== 'number' ||
      config.request_timeout_ms < 1000 ||
      config.request_timeout_ms > 30000
    ) {
      return { valid: false, error: 'request_timeout_ms must be a number between 1000 and 30000' };
    }
  }

  if (config.retry !== undefined) {
    if (config.retry.max_attempts !== undefined) {
      if (
        typeof config.retry.max_attempts !== 'number' ||
        config.retry.max_attempts < 0 ||
        config.retry.max_attempts > 10
      ) {
        return { valid: false, error: 'retry.max_attempts must be a number between 0 and 10' };
      }
    }

    if (config.retry.initial_delay_ms !== undefined) {
      if (
        typeof config.retry.initial_delay_ms !== 'number' ||
        config.retry.initial_delay_ms < 100 ||
        config.retry.initial_delay_ms > 60000
      ) {
        return {
          valid: false,
          error: 'retry.initial_delay_ms must be a number between 100 and 60000',
        };
      }
    }

    if (config.retry.max_delay_ms !== undefined) {
      if (
        typeof config.retry.max_delay_ms !== 'number' ||
        config.retry.max_delay_ms < 1000 ||
        config.retry.max_delay_ms > 300000
      ) {
        return {
          valid: false,
          error: 'retry.max_delay_ms must be a number between 1000 and 300000',
        };
      }
    }

    if (config.retry.backoff_multiplier !== undefined) {
      if (
        typeof config.retry.backoff_multiplier !== 'number' ||
        config.retry.backoff_multiplier < 1 ||
        config.retry.backoff_multiplier > 5
      ) {
        return {
          valid: false,
          error: 'retry.backoff_multiplier must be a number between 1 and 5',
        };
      }
    }
  }

  if (config.on_final_failure !== undefined) {
    if (config.on_final_failure !== 'log_only' && config.on_final_failure !== 'alert') {
      return { valid: false, error: 'on_final_failure must be "log_only" or "alert"' };
    }
  }

  return { valid: true };
}

/**
 * GET /api/admin/settings/logout
 * Get current logout configuration
 */
export async function getLogoutConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LogoutConfigAPI');
  try {
    let currentConfig = DEFAULT_LOGOUT_CONFIG;
    let source = 'default';

    // Try to get from KV
    if (c.env.SETTINGS) {
      let kvConfig: string | null;
      try {
        kvConfig = await c.env.SETTINGS.get(LOGOUT_SETTINGS_KEY);
      } catch (error) {
        throw new SettingsUnavailableError(error);
      }
      if (kvConfig) {
        try {
          const parsed = JSON.parse(kvConfig) as LogoutConfig;
          currentConfig = {
            backchannel: { ...DEFAULT_LOGOUT_CONFIG.backchannel, ...parsed.backchannel },
            frontchannel: { ...DEFAULT_LOGOUT_CONFIG.frontchannel, ...parsed.frontchannel },
            session_management: {
              ...DEFAULT_LOGOUT_CONFIG.session_management,
              ...parsed.session_management,
            },
          };
          source = 'kv';
        } catch {
          // Invalid JSON in KV, use defaults
        }
      }
    }

    const effective = await effectiveLogoutConfig(c, currentConfig);
    return c.json({
      config: effective.config,
      // Whether the older settings:logout document is saved ('kv') or not ('default').
      source,
      // Where each back-channel value in effect comes from, as the Settings API reports it:
      // 'kv' (set for this tenant), 'platform' (the document above), 'env' or 'default'.
      backchannel_sources: effective.backchannelSources,
      defaults: DEFAULT_LOGOUT_CONFIG,
    });
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    log.error('Error getting config', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get logout configuration',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/logout
 * Update logout configuration (stored in KV)
 *
 * Request body: Partial<LogoutConfig>
 */
export async function updateLogoutConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LogoutConfigAPI');
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

  let body: Partial<LogoutConfig>;
  try {
    body = await c.req.json<Partial<LogoutConfig>>();
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid JSON in request body',
      },
      400
    );
  }

  // Validate backchannel config if provided
  if (body.backchannel) {
    const validation = validateBackchannelConfig(body.backchannel);
    if (!validation.valid) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: validation.error,
        },
        400
      );
    }
  }

  try {
    // Get existing config from KV
    let existingConfig: LogoutConfig = DEFAULT_LOGOUT_CONFIG;
    let kvConfig: string | null;
    try {
      kvConfig = await c.env.SETTINGS.get(LOGOUT_SETTINGS_KEY);
    } catch (error) {
      throw new SettingsUnavailableError(error);
    }
    if (kvConfig) {
      try {
        existingConfig = JSON.parse(kvConfig);
      } catch {
        // Invalid JSON, use defaults
      }
    }

    // Merge with new config (deep merge for nested objects)
    const newConfig: LogoutConfig = {
      backchannel: {
        ...existingConfig.backchannel,
        ...body.backchannel,
        retry: body.backchannel?.retry
          ? {
              ...existingConfig.backchannel.retry,
              ...body.backchannel.retry,
            }
          : existingConfig.backchannel.retry,
      },
      frontchannel: {
        ...existingConfig.frontchannel,
        ...body.frontchannel,
      },
      session_management: {
        ...existingConfig.session_management,
        ...body.session_management,
      },
    };

    // Save to KV
    await c.env.SETTINGS.put(LOGOUT_SETTINGS_KEY, JSON.stringify(newConfig));

    return c.json({
      success: true,
      config: (await effectiveLogoutConfig(c, newConfig)).config,
      note: 'Logout configuration updated. Back-channel values set per tenant through the Settings API take precedence; changes take effect within a minute.',
    });
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    log.error('Error updating config', {}, error as Error);
    // SECURITY: Do not expose internal error details
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update config',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/logout
 * Reset logout configuration to defaults (clear KV override)
 */
export async function resetLogoutConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LogoutConfigAPI');
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
    await c.env.SETTINGS.delete(LOGOUT_SETTINGS_KEY);

    return c.json({
      success: true,
      config: (await effectiveLogoutConfig(c, DEFAULT_LOGOUT_CONFIG)).config,
      note: 'Logout configuration reset to defaults.',
    });
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    log.error('Error resetting config', {}, error as Error);
    // SECURITY: Do not expose internal error details
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to reset config',
      },
      500
    );
  }
}

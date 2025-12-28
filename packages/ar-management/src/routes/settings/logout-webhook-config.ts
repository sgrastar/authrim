/**
 * Logout Webhook Configuration Admin API
 *
 * GET  /api/admin/settings/logout-webhook        - Get webhook configuration
 * PUT  /api/admin/settings/logout-webhook        - Update webhook configuration
 * DELETE /api/admin/settings/logout-webhook      - Reset to default configuration
 *
 * Simple Logout Webhook (Authrim Extension)
 * An alternative to OIDC Back-Channel Logout for clients that don't support
 * the full OIDC spec (e.g., Zendesk Remote Logout URL style).
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  DEFAULT_LOGOUT_WEBHOOK_CONFIG,
  LOGOUT_WEBHOOK_SETTINGS_KEY,
  type LogoutWebhookConfig,
  type LogoutRetryConfig,
} from '@authrim/ar-lib-core';

/**
 * Validate LogoutWebhookConfig values
 */
function validateWebhookConfig(config: Partial<LogoutWebhookConfig>): {
  valid: boolean;
  error?: string;
} {
  if (config.enabled !== undefined) {
    if (typeof config.enabled !== 'boolean') {
      return { valid: false, error: 'enabled must be a boolean' };
    }
  }

  if (config.request_timeout_ms !== undefined) {
    if (
      typeof config.request_timeout_ms !== 'number' ||
      config.request_timeout_ms < 1000 ||
      config.request_timeout_ms > 30000
    ) {
      return {
        valid: false,
        error: 'request_timeout_ms must be a number between 1000 and 30000',
      };
    }
  }

  if (config.include_sub_claim !== undefined) {
    if (typeof config.include_sub_claim !== 'boolean') {
      return { valid: false, error: 'include_sub_claim must be a boolean' };
    }
  }

  if (config.include_sid_claim !== undefined) {
    if (typeof config.include_sid_claim !== 'boolean') {
      return { valid: false, error: 'include_sid_claim must be a boolean' };
    }
  }

  if (config.retry !== undefined) {
    const retryValidation = validateRetryConfig(config.retry);
    if (!retryValidation.valid) {
      return retryValidation;
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
 * Validate LogoutRetryConfig values
 */
function validateRetryConfig(config: Partial<LogoutRetryConfig>): {
  valid: boolean;
  error?: string;
} {
  if (config.max_attempts !== undefined) {
    if (
      typeof config.max_attempts !== 'number' ||
      config.max_attempts < 0 ||
      config.max_attempts > 10
    ) {
      return { valid: false, error: 'retry.max_attempts must be a number between 0 and 10' };
    }
  }

  if (config.initial_delay_ms !== undefined) {
    if (
      typeof config.initial_delay_ms !== 'number' ||
      config.initial_delay_ms < 100 ||
      config.initial_delay_ms > 60000
    ) {
      return {
        valid: false,
        error: 'retry.initial_delay_ms must be a number between 100 and 60000',
      };
    }
  }

  if (config.max_delay_ms !== undefined) {
    if (
      typeof config.max_delay_ms !== 'number' ||
      config.max_delay_ms < 1000 ||
      config.max_delay_ms > 300000
    ) {
      return {
        valid: false,
        error: 'retry.max_delay_ms must be a number between 1000 and 300000',
      };
    }
  }

  if (config.backoff_multiplier !== undefined) {
    if (
      typeof config.backoff_multiplier !== 'number' ||
      config.backoff_multiplier < 1 ||
      config.backoff_multiplier > 5
    ) {
      return {
        valid: false,
        error: 'retry.backoff_multiplier must be a number between 1 and 5',
      };
    }
  }

  return { valid: true };
}

/**
 * GET /api/admin/settings/logout-webhook
 * Get current logout webhook configuration
 */
export async function getLogoutWebhookConfig(c: Context<{ Bindings: Env }>) {
  try {
    let currentConfig = DEFAULT_LOGOUT_WEBHOOK_CONFIG;
    let source = 'default';

    // Try to get from KV
    if (c.env.SETTINGS) {
      const kvConfig = await c.env.SETTINGS.get(LOGOUT_WEBHOOK_SETTINGS_KEY);
      if (kvConfig) {
        try {
          const parsed = JSON.parse(kvConfig) as Partial<LogoutWebhookConfig>;
          currentConfig = {
            ...DEFAULT_LOGOUT_WEBHOOK_CONFIG,
            ...parsed,
            retry: {
              ...DEFAULT_LOGOUT_WEBHOOK_CONFIG.retry,
              ...(parsed.retry || {}),
            },
          };
          source = 'kv';
        } catch {
          // Invalid JSON in KV, use defaults
        }
      }
    }

    return c.json({
      config: currentConfig,
      source,
      defaults: DEFAULT_LOGOUT_WEBHOOK_CONFIG,
    });
  } catch (error) {
    // SECURITY: Log only error type, not full details which may contain sensitive info
    console.error(
      '[Logout Webhook Config API] Error getting config:',
      error instanceof Error ? error.name : 'Unknown error'
    );
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get logout webhook configuration',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/logout-webhook
 * Update logout webhook configuration (stored in KV)
 *
 * Request body: Partial<LogoutWebhookConfig>
 */
export async function updateLogoutWebhookConfig(c: Context<{ Bindings: Env }>) {
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

  let body: Partial<LogoutWebhookConfig>;
  try {
    body = await c.req.json<Partial<LogoutWebhookConfig>>();
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid JSON in request body',
      },
      400
    );
  }

  // Validate config
  const validation = validateWebhookConfig(body);
  if (!validation.valid) {
    return c.json(
      {
        error: 'invalid_value',
        error_description: validation.error,
      },
      400
    );
  }

  try {
    // Get existing config from KV
    let existingConfig: LogoutWebhookConfig = DEFAULT_LOGOUT_WEBHOOK_CONFIG;
    const kvConfig = await c.env.SETTINGS.get(LOGOUT_WEBHOOK_SETTINGS_KEY);
    if (kvConfig) {
      try {
        existingConfig = {
          ...DEFAULT_LOGOUT_WEBHOOK_CONFIG,
          ...JSON.parse(kvConfig),
        };
      } catch {
        // Invalid JSON, use defaults
      }
    }

    // Merge with new config (deep merge for retry object)
    const newConfig: LogoutWebhookConfig = {
      ...existingConfig,
      ...body,
      retry: body.retry
        ? {
            ...existingConfig.retry,
            ...body.retry,
          }
        : existingConfig.retry,
    };

    // Save to KV
    await c.env.SETTINGS.put(LOGOUT_WEBHOOK_SETTINGS_KEY, JSON.stringify(newConfig));

    return c.json({
      success: true,
      config: newConfig,
      note: 'Logout webhook configuration updated. Changes take effect immediately.',
    });
  } catch (error) {
    // SECURITY: Log only error type, not full details which may contain sensitive info
    console.error(
      '[Logout Webhook Config API] Error updating config:',
      error instanceof Error ? error.name : 'Unknown error'
    );
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
 * DELETE /api/admin/settings/logout-webhook
 * Reset logout webhook configuration to defaults (clear KV override)
 */
export async function resetLogoutWebhookConfig(c: Context<{ Bindings: Env }>) {
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
    await c.env.SETTINGS.delete(LOGOUT_WEBHOOK_SETTINGS_KEY);

    return c.json({
      success: true,
      config: DEFAULT_LOGOUT_WEBHOOK_CONFIG,
      note: 'Logout webhook configuration reset to defaults.',
    });
  } catch (error) {
    // SECURITY: Log only error type, not full details which may contain sensitive info
    console.error(
      '[Logout Webhook Config API] Error resetting config:',
      error instanceof Error ? error.name : 'Unknown error'
    );
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to reset config',
      },
      500
    );
  }
}

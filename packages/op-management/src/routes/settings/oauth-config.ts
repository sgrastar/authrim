/**
 * OAuth/OIDC Configuration Admin API
 *
 * GET  /api/admin/settings/oauth-config        - Get all OAuth config values
 * PUT  /api/admin/settings/oauth-config/:name  - Update a specific config value
 * DELETE /api/admin/settings/oauth-config/:name - Clear a specific config override
 */

import type { Context } from 'hono';
import {
  createOAuthConfigManager,
  CONFIG_NAMES,
  CONFIG_METADATA,
  DEFAULT_CONFIG,
  type ConfigName,
} from '@authrim/shared';

/**
 * GET /api/admin/settings/oauth-config
 * Get all OAuth configuration values with their sources
 */
export async function getOAuthConfig(c: Context) {
  const configManager = createOAuthConfigManager(c.env);

  try {
    const sources = await configManager.getConfigSources();
    const metadata = CONFIG_METADATA;

    return c.json({
      configs: Object.fromEntries(
        CONFIG_NAMES.map((name) => [
          name,
          {
            value: sources[name].value,
            source: sources[name].source,
            default: DEFAULT_CONFIG[name],
            metadata: metadata[name],
          },
        ])
      ),
    });
  } catch (error) {
    console.error('[OAuth Config API] Error getting config:', error);
    return c.json(
      {
        error: 'internal_error',
        error_description: 'Failed to get OAuth configuration',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/oauth-config/:name
 * Update a specific OAuth configuration value (stored in KV)
 *
 * Request body:
 * { "value": number | boolean }
 */
export async function updateOAuthConfig(c: Context) {
  const name = c.req.param('name') as ConfigName;

  // Validate config name
  if (!CONFIG_NAMES.includes(name)) {
    return c.json(
      {
        error: 'invalid_config',
        error_description: `Unknown config name: ${name}. Valid names: ${CONFIG_NAMES.join(', ')}`,
      },
      400
    );
  }

  const body = await c.req.json<{ value: number | boolean }>();
  const { value } = body;

  if (value === undefined) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Request body must contain "value" field',
      },
      400
    );
  }

  const metadata = CONFIG_METADATA[name];

  // Type validation
  if (metadata.type === 'number') {
    if (typeof value !== 'number' || isNaN(value)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be a number`,
        },
        400
      );
    }

    // Range validation
    if (metadata.min !== undefined && value < metadata.min) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be >= ${metadata.min}`,
        },
        400
      );
    }
    if (metadata.max !== undefined && value > metadata.max) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be <= ${metadata.max}`,
        },
        400
      );
    }
  } else if (metadata.type === 'boolean') {
    if (typeof value !== 'boolean') {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `${name} must be a boolean`,
        },
        400
      );
    }
  }

  // Check if KV is available
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  try {
    const configManager = createOAuthConfigManager(c.env);
    await configManager.setConfig(name, value);

    return c.json({
      success: true,
      config: name,
      value,
      note: 'Config updated. Cache will refresh within 10 seconds.',
    });
  } catch (error) {
    console.error(`[OAuth Config API] Error updating ${name}:`, error);
    return c.json(
      {
        error: 'internal_error',
        error_description: `Failed to update config: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/oauth-config/:name
 * Clear a specific OAuth configuration override (revert to env/default)
 */
export async function clearOAuthConfig(c: Context) {
  const name = c.req.param('name') as ConfigName;

  // Validate config name
  if (!CONFIG_NAMES.includes(name)) {
    return c.json(
      {
        error: 'invalid_config',
        error_description: `Unknown config name: ${name}. Valid names: ${CONFIG_NAMES.join(', ')}`,
      },
      400
    );
  }

  // Check if KV is available
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  try {
    const configManager = createOAuthConfigManager(c.env);
    await configManager.clearConfig(name);

    return c.json({
      success: true,
      config: name,
      note: 'Config override cleared. Will use env/default value. Cache will refresh within 10 seconds.',
    });
  } catch (error) {
    console.error(`[OAuth Config API] Error clearing ${name}:`, error);
    return c.json(
      {
        error: 'internal_error',
        error_description: `Failed to clear config: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/oauth-config
 * Clear all OAuth configuration overrides (revert all to env/default)
 */
export async function clearAllOAuthConfig(c: Context) {
  // Check if KV is available
  if (!c.env.AUTHRIM_CONFIG) {
    return c.json(
      {
        error: 'kv_not_configured',
        error_description: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  try {
    const configManager = createOAuthConfigManager(c.env);
    await configManager.clearAllConfig();

    return c.json({
      success: true,
      note: 'All config overrides cleared. Will use env/default values. Cache will refresh within 10 seconds.',
    });
  } catch (error) {
    console.error('[OAuth Config API] Error clearing all config:', error);
    return c.json(
      {
        error: 'internal_error',
        error_description: `Failed to clear all config: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      500
    );
  }
}

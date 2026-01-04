/**
 * JIT Provisioning Configuration Admin API
 *
 * Manage Just-In-Time Provisioning settings stored in KV.
 *
 * GET    /api/admin/settings/jit-provisioning     - Get config
 * PUT    /api/admin/settings/jit-provisioning     - Update config
 * DELETE /api/admin/settings/jit-provisioning     - Reset to default
 */

import type { Context } from 'hono';
import { type JITProvisioningConfig, DEFAULT_JIT_CONFIG, getLogger } from '@authrim/ar-lib-core';

// =============================================================================
// Constants
// =============================================================================

const KV_KEY = 'jit_provisioning_config';

// =============================================================================
// Helpers
// =============================================================================

function validateConfig(config: Partial<JITProvisioningConfig>): string[] {
  const errors: string[] = [];

  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }

  if (
    config.auto_create_org_on_domain_match !== undefined &&
    typeof config.auto_create_org_on_domain_match !== 'boolean'
  ) {
    errors.push('auto_create_org_on_domain_match must be a boolean');
  }

  if (
    config.join_all_matching_orgs !== undefined &&
    typeof config.join_all_matching_orgs !== 'boolean'
  ) {
    errors.push('join_all_matching_orgs must be a boolean');
  }

  if (
    config.allow_user_without_org !== undefined &&
    typeof config.allow_user_without_org !== 'boolean'
  ) {
    errors.push('allow_user_without_org must be a boolean');
  }

  if (config.default_role_id !== undefined && typeof config.default_role_id !== 'string') {
    errors.push('default_role_id must be a string');
  }

  if (
    config.allow_unverified_domain_mappings !== undefined &&
    typeof config.allow_unverified_domain_mappings !== 'boolean'
  ) {
    errors.push('allow_unverified_domain_mappings must be a boolean');
  }

  if (config.allowed_provider_ids !== undefined && config.allowed_provider_ids !== null) {
    if (!Array.isArray(config.allowed_provider_ids)) {
      errors.push('allowed_provider_ids must be an array or null');
    } else if (!config.allowed_provider_ids.every((id) => typeof id === 'string')) {
      errors.push('allowed_provider_ids must be an array of strings');
    }
  }

  if (
    config.require_verified_email !== undefined &&
    typeof config.require_verified_email !== 'boolean'
  ) {
    errors.push('require_verified_email must be a boolean');
  }

  if (config.rate_limit !== undefined) {
    if (typeof config.rate_limit !== 'object') {
      errors.push('rate_limit must be an object');
    } else {
      if (
        config.rate_limit.max_per_minute !== undefined &&
        (typeof config.rate_limit.max_per_minute !== 'number' ||
          config.rate_limit.max_per_minute < 1)
      ) {
        errors.push('rate_limit.max_per_minute must be a positive number');
      }
      if (
        config.rate_limit.max_per_hour !== undefined &&
        (typeof config.rate_limit.max_per_hour !== 'number' || config.rate_limit.max_per_hour < 1)
      ) {
        errors.push('rate_limit.max_per_hour must be a positive number');
      }
    }
  }

  return errors;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/settings/jit-provisioning
 * Get JIT Provisioning configuration
 */
export async function getJITProvisioningConfig(c: Context) {
  const log = getLogger(c).module('JITProvisioningAPI');
  try {
    let config: JITProvisioningConfig = { ...DEFAULT_JIT_CONFIG };
    let source = 'default';

    // Try KV first
    if (c.env.SETTINGS) {
      try {
        const kvConfig = await c.env.SETTINGS.get(KV_KEY);
        if (kvConfig) {
          config = JSON.parse(kvConfig);
          source = 'kv';
        }
      } catch {
        // KV error, use default
      }
    }

    return c.json({
      config,
      source,
      defaults: DEFAULT_JIT_CONFIG,
    });
  } catch (error) {
    log.error('Get error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get JIT Provisioning configuration',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/jit-provisioning
 * Update JIT Provisioning configuration
 */
export async function updateJITProvisioningConfig(c: Context) {
  const log = getLogger(c).module('JITProvisioningAPI');
  const body = await c.req.json<Partial<JITProvisioningConfig>>();

  // Validate input
  const errors = validateConfig(body);
  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join(', '),
      },
      400
    );
  }

  if (!c.env.SETTINGS) {
    return c.json(
      {
        error: 'configuration_error',
        error_description: 'SETTINGS KV namespace not configured',
      },
      500
    );
  }

  try {
    // Get existing config or use defaults
    let existingConfig: JITProvisioningConfig = { ...DEFAULT_JIT_CONFIG };
    try {
      const kvConfig = await c.env.SETTINGS.get(KV_KEY);
      if (kvConfig) {
        existingConfig = JSON.parse(kvConfig);
      }
    } catch {
      // Use defaults if KV read fails
    }

    // Merge with updates
    const newConfig: JITProvisioningConfig = {
      ...existingConfig,
      ...body,
      // Handle nested rate_limit object
      rate_limit: body.rate_limit
        ? { ...existingConfig.rate_limit, ...body.rate_limit }
        : existingConfig.rate_limit,
      version: String(Date.now()),
      updated_at: Date.now(),
    };

    // Save to KV
    await c.env.SETTINGS.put(KV_KEY, JSON.stringify(newConfig));

    return c.json({
      config: newConfig,
      message: 'JIT Provisioning configuration updated',
    });
  } catch (error) {
    log.error('Update error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update JIT Provisioning configuration',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/jit-provisioning
 * Reset JIT Provisioning configuration to defaults
 */
export async function resetJITProvisioningConfig(c: Context) {
  const log = getLogger(c).module('JITProvisioningAPI');
  if (!c.env.SETTINGS) {
    return c.json(
      {
        error: 'configuration_error',
        error_description: 'SETTINGS KV namespace not configured',
      },
      500
    );
  }

  try {
    await c.env.SETTINGS.delete(KV_KEY);

    return c.json({
      config: DEFAULT_JIT_CONFIG,
      message: 'JIT Provisioning configuration reset to defaults',
    });
  } catch (error) {
    log.error('Reset error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to reset JIT Provisioning configuration',
      },
      500
    );
  }
}

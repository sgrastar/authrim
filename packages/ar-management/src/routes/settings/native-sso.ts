/**
 * OIDC Native SSO 1.0 (draft-07) Settings Admin API
 *
 * GET    /api/admin/settings/native-sso     - Get Native SSO settings
 * PUT    /api/admin/settings/native-sso     - Update Native SSO settings
 * DELETE /api/admin/settings/native-sso     - Clear Native SSO settings override
 *
 * Settings stored in AUTHRIM_CONFIG KV under "config:native-sso" key
 *
 * Native SSO enables seamless SSO between mobile/desktop apps sharing a Keychain/Keystore.
 */

import type { Context } from 'hono';
import {
  getNativeSSOConfig,
  clearNativeSSOConfigCache,
  getLogger,
  type NativeSSOSettings,
  type Env,
} from '@authrim/ar-lib-core';

// Valid max secrets behaviors
const VALID_MAX_SECRETS_BEHAVIORS = ['revoke_oldest', 'reject'] as const;
type MaxSecretsBehavior = (typeof VALID_MAX_SECRETS_BEHAVIORS)[number];

// Constraints
const MIN_DEVICE_SECRET_TTL_DAYS = 1;
const MAX_DEVICE_SECRET_TTL_DAYS = 90;
const MIN_MAX_SECRETS_PER_USER = 1;
const MAX_MAX_SECRETS_PER_USER = 50;
const MIN_MAX_USE_COUNT_PER_SECRET = 1;
const MAX_MAX_USE_COUNT_PER_SECRET = 100;
const MIN_RATE_LIMIT_ATTEMPTS = 1;
const MAX_RATE_LIMIT_ATTEMPTS = 100;
const MIN_RATE_LIMIT_BLOCK_MINUTES = 1;
const MAX_RATE_LIMIT_BLOCK_MINUTES = 60;

// Default settings
const DEFAULT_SETTINGS: NativeSSOSettings = {
  enabled: false,
  deviceSecretTTLDays: 30,
  maxDeviceSecretsPerUser: 10,
  maxUseCountPerSecret: 10, // Replay attack prevention
  maxSecretsBehavior: 'revoke_oldest',
  allowCrossClientNativeSSO: false,
  rateLimit: {
    maxAttemptsPerMinute: 10,
    blockDurationMinutes: 15,
  },
};

type SettingSource = 'kv' | 'env' | 'default';

interface NativeSSOSettingsSources {
  enabled: SettingSource;
  deviceSecretTTLDays: SettingSource;
  maxDeviceSecretsPerUser: SettingSource;
  maxUseCountPerSecret: SettingSource;
  maxSecretsBehavior: SettingSource;
  allowCrossClientNativeSSO: SettingSource;
  rateLimit: {
    maxAttemptsPerMinute: SettingSource;
    blockDurationMinutes: SettingSource;
  };
}

/**
 * Get current Native SSO settings with their sources
 */
async function getNativeSSOSettingsWithSources(env: Env): Promise<{
  settings: NativeSSOSettings;
  sources: NativeSSOSettingsSources;
}> {
  const settings = await getNativeSSOConfig(env);

  // Determine sources (simplified - actual implementation tracks during config loading)
  // For now, check if values differ from defaults and KV exists
  const sources: NativeSSOSettingsSources = {
    enabled: 'default',
    deviceSecretTTLDays: 'default',
    maxDeviceSecretsPerUser: 'default',
    maxUseCountPerSecret: 'default',
    maxSecretsBehavior: 'default',
    allowCrossClientNativeSSO: 'default',
    rateLimit: {
      maxAttemptsPerMinute: 'default',
      blockDurationMinutes: 'default',
    },
  };

  // Check KV for overrides
  try {
    const kvValue = await env.AUTHRIM_CONFIG?.get('config:native-sso');
    if (kvValue) {
      const kvSettings = JSON.parse(kvValue) as Partial<NativeSSOSettings>;
      if (kvSettings.enabled !== undefined) sources.enabled = 'kv';
      if (kvSettings.deviceSecretTTLDays !== undefined) sources.deviceSecretTTLDays = 'kv';
      if (kvSettings.maxDeviceSecretsPerUser !== undefined) sources.maxDeviceSecretsPerUser = 'kv';
      if (kvSettings.maxUseCountPerSecret !== undefined) sources.maxUseCountPerSecret = 'kv';
      if (kvSettings.maxSecretsBehavior !== undefined) sources.maxSecretsBehavior = 'kv';
      if (kvSettings.allowCrossClientNativeSSO !== undefined)
        sources.allowCrossClientNativeSSO = 'kv';
      if (kvSettings.rateLimit?.maxAttemptsPerMinute !== undefined)
        sources.rateLimit.maxAttemptsPerMinute = 'kv';
      if (kvSettings.rateLimit?.blockDurationMinutes !== undefined)
        sources.rateLimit.blockDurationMinutes = 'kv';
    }
  } catch {
    // Ignore KV errors
  }

  // Check environment variables
  const envRecord = env as unknown as Record<string, string | undefined>;
  if (sources.enabled === 'default' && envRecord.NATIVE_SSO_ENABLED !== undefined) {
    sources.enabled = 'env';
  }
  if (
    sources.deviceSecretTTLDays === 'default' &&
    envRecord.NATIVE_SSO_DEVICE_SECRET_TTL_DAYS !== undefined
  ) {
    sources.deviceSecretTTLDays = 'env';
  }
  if (
    sources.maxDeviceSecretsPerUser === 'default' &&
    envRecord.NATIVE_SSO_MAX_SECRETS_PER_USER !== undefined
  ) {
    sources.maxDeviceSecretsPerUser = 'env';
  }
  if (
    sources.maxUseCountPerSecret === 'default' &&
    envRecord.NATIVE_SSO_MAX_USE_COUNT_PER_SECRET !== undefined
  ) {
    sources.maxUseCountPerSecret = 'env';
  }
  if (
    sources.maxSecretsBehavior === 'default' &&
    envRecord.NATIVE_SSO_MAX_SECRETS_BEHAVIOR !== undefined
  ) {
    sources.maxSecretsBehavior = 'env';
  }
  if (
    sources.allowCrossClientNativeSSO === 'default' &&
    envRecord.NATIVE_SSO_ALLOW_CROSS_CLIENT !== undefined
  ) {
    sources.allowCrossClientNativeSSO = 'env';
  }
  if (
    sources.rateLimit.maxAttemptsPerMinute === 'default' &&
    envRecord.NATIVE_SSO_RATE_LIMIT_MAX_ATTEMPTS !== undefined
  ) {
    sources.rateLimit.maxAttemptsPerMinute = 'env';
  }
  if (
    sources.rateLimit.blockDurationMinutes === 'default' &&
    envRecord.NATIVE_SSO_RATE_LIMIT_BLOCK_MINUTES !== undefined
  ) {
    sources.rateLimit.blockDurationMinutes = 'env';
  }

  return { settings, sources };
}

/**
 * GET /api/admin/settings/native-sso
 * Get Native SSO settings with their sources
 */
export async function getNativeSSOSettingsConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('NativeSSOSettingsAPI');
  try {
    const { settings, sources } = await getNativeSSOSettingsWithSources(c.env);

    return c.json({
      settings: {
        enabled: {
          value: settings.enabled,
          source: sources.enabled,
          default: DEFAULT_SETTINGS.enabled,
          description: 'Enable Native SSO feature',
        },
        deviceSecretTTLDays: {
          value: settings.deviceSecretTTLDays,
          source: sources.deviceSecretTTLDays,
          default: DEFAULT_SETTINGS.deviceSecretTTLDays,
          min: MIN_DEVICE_SECRET_TTL_DAYS,
          max: MAX_DEVICE_SECRET_TTL_DAYS,
          description: 'Device secret TTL in days',
        },
        maxDeviceSecretsPerUser: {
          value: settings.maxDeviceSecretsPerUser,
          source: sources.maxDeviceSecretsPerUser,
          default: DEFAULT_SETTINGS.maxDeviceSecretsPerUser,
          min: MIN_MAX_SECRETS_PER_USER,
          max: MAX_MAX_SECRETS_PER_USER,
          description: 'Maximum device secrets per user',
        },
        maxUseCountPerSecret: {
          value: settings.maxUseCountPerSecret,
          source: sources.maxUseCountPerSecret,
          default: DEFAULT_SETTINGS.maxUseCountPerSecret,
          min: MIN_MAX_USE_COUNT_PER_SECRET,
          max: MAX_MAX_USE_COUNT_PER_SECRET,
          description: 'Maximum uses per device secret (replay attack prevention)',
        },
        maxSecretsBehavior: {
          value: settings.maxSecretsBehavior,
          source: sources.maxSecretsBehavior,
          default: DEFAULT_SETTINGS.maxSecretsBehavior,
          validOptions: VALID_MAX_SECRETS_BEHAVIORS,
          description: 'Behavior when max secrets exceeded',
        },
        allowCrossClientNativeSSO: {
          value: settings.allowCrossClientNativeSSO,
          source: sources.allowCrossClientNativeSSO,
          default: DEFAULT_SETTINGS.allowCrossClientNativeSSO,
          description: 'Allow Native SSO between different clients',
        },
        rateLimit: {
          maxAttemptsPerMinute: {
            value: settings.rateLimit.maxAttemptsPerMinute,
            source: sources.rateLimit.maxAttemptsPerMinute,
            default: DEFAULT_SETTINGS.rateLimit.maxAttemptsPerMinute,
            min: MIN_RATE_LIMIT_ATTEMPTS,
            max: MAX_RATE_LIMIT_ATTEMPTS,
            description: 'Max Token Exchange attempts per minute per device_secret',
          },
          blockDurationMinutes: {
            value: settings.rateLimit.blockDurationMinutes,
            source: sources.rateLimit.blockDurationMinutes,
            default: DEFAULT_SETTINGS.rateLimit.blockDurationMinutes,
            min: MIN_RATE_LIMIT_BLOCK_MINUTES,
            max: MAX_RATE_LIMIT_BLOCK_MINUTES,
            description: 'Block duration in minutes when rate limit exceeded',
          },
        },
      },
      note: 'Native SSO enables seamless SSO between mobile/desktop apps sharing a Keychain/Keystore.',
    });
  } catch (error) {
    log.error('Error getting settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get Native SSO settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/native-sso
 * Update Native SSO settings (stored in KV)
 */
export async function updateNativeSSOConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('NativeSSOSettingsAPI');
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

  let body: Partial<NativeSSOSettings>;
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

  // Validate deviceSecretTTLDays
  if (body.deviceSecretTTLDays !== undefined) {
    if (
      typeof body.deviceSecretTTLDays !== 'number' ||
      !Number.isInteger(body.deviceSecretTTLDays)
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"deviceSecretTTLDays" must be an integer',
        },
        400
      );
    }
    if (
      body.deviceSecretTTLDays < MIN_DEVICE_SECRET_TTL_DAYS ||
      body.deviceSecretTTLDays > MAX_DEVICE_SECRET_TTL_DAYS
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `"deviceSecretTTLDays" must be between ${MIN_DEVICE_SECRET_TTL_DAYS} and ${MAX_DEVICE_SECRET_TTL_DAYS}`,
        },
        400
      );
    }
  }

  // Validate maxDeviceSecretsPerUser
  if (body.maxDeviceSecretsPerUser !== undefined) {
    if (
      typeof body.maxDeviceSecretsPerUser !== 'number' ||
      !Number.isInteger(body.maxDeviceSecretsPerUser)
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"maxDeviceSecretsPerUser" must be an integer',
        },
        400
      );
    }
    if (
      body.maxDeviceSecretsPerUser < MIN_MAX_SECRETS_PER_USER ||
      body.maxDeviceSecretsPerUser > MAX_MAX_SECRETS_PER_USER
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `"maxDeviceSecretsPerUser" must be between ${MIN_MAX_SECRETS_PER_USER} and ${MAX_MAX_SECRETS_PER_USER}`,
        },
        400
      );
    }
  }

  // Validate maxUseCountPerSecret
  if (body.maxUseCountPerSecret !== undefined) {
    if (
      typeof body.maxUseCountPerSecret !== 'number' ||
      !Number.isInteger(body.maxUseCountPerSecret)
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"maxUseCountPerSecret" must be an integer',
        },
        400
      );
    }
    if (
      body.maxUseCountPerSecret < MIN_MAX_USE_COUNT_PER_SECRET ||
      body.maxUseCountPerSecret > MAX_MAX_USE_COUNT_PER_SECRET
    ) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `"maxUseCountPerSecret" must be between ${MIN_MAX_USE_COUNT_PER_SECRET} and ${MAX_MAX_USE_COUNT_PER_SECRET}`,
        },
        400
      );
    }
  }

  // Validate maxSecretsBehavior
  if (body.maxSecretsBehavior !== undefined) {
    if (!VALID_MAX_SECRETS_BEHAVIORS.includes(body.maxSecretsBehavior as MaxSecretsBehavior)) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: `"maxSecretsBehavior" must be one of: ${VALID_MAX_SECRETS_BEHAVIORS.join(', ')}`,
        },
        400
      );
    }
  }

  // Validate allowCrossClientNativeSSO
  if (
    body.allowCrossClientNativeSSO !== undefined &&
    typeof body.allowCrossClientNativeSSO !== 'boolean'
  ) {
    return c.json(
      {
        error: 'invalid_value',
        error_description: '"allowCrossClientNativeSSO" must be a boolean',
      },
      400
    );
  }

  // Validate rateLimit
  if (body.rateLimit !== undefined) {
    if (typeof body.rateLimit !== 'object' || body.rateLimit === null) {
      return c.json(
        {
          error: 'invalid_value',
          error_description: '"rateLimit" must be an object',
        },
        400
      );
    }

    if (body.rateLimit.maxAttemptsPerMinute !== undefined) {
      if (
        typeof body.rateLimit.maxAttemptsPerMinute !== 'number' ||
        !Number.isInteger(body.rateLimit.maxAttemptsPerMinute)
      ) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: '"rateLimit.maxAttemptsPerMinute" must be an integer',
          },
          400
        );
      }
      if (
        body.rateLimit.maxAttemptsPerMinute < MIN_RATE_LIMIT_ATTEMPTS ||
        body.rateLimit.maxAttemptsPerMinute > MAX_RATE_LIMIT_ATTEMPTS
      ) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: `"rateLimit.maxAttemptsPerMinute" must be between ${MIN_RATE_LIMIT_ATTEMPTS} and ${MAX_RATE_LIMIT_ATTEMPTS}`,
          },
          400
        );
      }
    }

    if (body.rateLimit.blockDurationMinutes !== undefined) {
      if (
        typeof body.rateLimit.blockDurationMinutes !== 'number' ||
        !Number.isInteger(body.rateLimit.blockDurationMinutes)
      ) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: '"rateLimit.blockDurationMinutes" must be an integer',
          },
          400
        );
      }
      if (
        body.rateLimit.blockDurationMinutes < MIN_RATE_LIMIT_BLOCK_MINUTES ||
        body.rateLimit.blockDurationMinutes > MAX_RATE_LIMIT_BLOCK_MINUTES
      ) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: `"rateLimit.blockDurationMinutes" must be between ${MIN_RATE_LIMIT_BLOCK_MINUTES} and ${MAX_RATE_LIMIT_BLOCK_MINUTES}`,
          },
          400
        );
      }
    }
  }

  try {
    // Read existing settings from KV
    let existingSettings: Partial<NativeSSOSettings> = {};
    const existingJson = await c.env.AUTHRIM_CONFIG.get('config:native-sso');
    if (existingJson) {
      existingSettings = JSON.parse(existingJson);
    }

    // Merge with new settings
    const updatedSettings: Partial<NativeSSOSettings> = {
      ...existingSettings,
    };

    if (body.enabled !== undefined) {
      updatedSettings.enabled = body.enabled;
    }
    if (body.deviceSecretTTLDays !== undefined) {
      updatedSettings.deviceSecretTTLDays = body.deviceSecretTTLDays;
    }
    if (body.maxDeviceSecretsPerUser !== undefined) {
      updatedSettings.maxDeviceSecretsPerUser = body.maxDeviceSecretsPerUser;
    }
    if (body.maxUseCountPerSecret !== undefined) {
      updatedSettings.maxUseCountPerSecret = body.maxUseCountPerSecret;
    }
    if (body.maxSecretsBehavior !== undefined) {
      updatedSettings.maxSecretsBehavior = body.maxSecretsBehavior;
    }
    if (body.allowCrossClientNativeSSO !== undefined) {
      updatedSettings.allowCrossClientNativeSSO = body.allowCrossClientNativeSSO;
    }
    if (body.rateLimit !== undefined) {
      updatedSettings.rateLimit = {
        ...(existingSettings.rateLimit || {}),
        ...body.rateLimit,
      };
    }

    // Save to KV
    await c.env.AUTHRIM_CONFIG.put('config:native-sso', JSON.stringify(updatedSettings));

    // Clear cache to pick up new settings
    clearNativeSSOConfigCache();

    // Get updated settings
    const { settings } = await getNativeSSOSettingsWithSources(c.env);

    return c.json({
      success: true,
      settings,
      note: 'Native SSO settings updated successfully.',
    });
  } catch (error) {
    log.error('Error updating settings', {}, error as Error);
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
 * DELETE /api/admin/settings/native-sso
 * Clear Native SSO settings override (revert to env/default)
 */
export async function clearNativeSSOConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('NativeSSOSettingsAPI');
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
    // Delete the KV entry
    await c.env.AUTHRIM_CONFIG.delete('config:native-sso');

    // Clear cache to pick up new settings
    clearNativeSSOConfigCache();

    // Get updated settings (will fall back to env/default)
    const { settings, sources } = await getNativeSSOSettingsWithSources(c.env);

    return c.json({
      success: true,
      settings,
      sources,
      note: 'Native SSO settings cleared. Using env/default values.',
    });
  } catch (error) {
    log.error('Error clearing settings', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to clear settings',
      },
      500
    );
  }
}

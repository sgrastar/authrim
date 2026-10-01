/**
 * Token Embedding Settings Admin API
 *
 * Manage feature flags and limits for token embedding.
 *
 * GET  /api/admin/settings/token-embedding  - Get current settings
 * PUT  /api/admin/settings/token-embedding  - Update settings
 */

import type { Context } from 'hono';
import {
  isCustomClaimsEnabled,
  isIdLevelPermissionsEnabled,
  getLogger,
  getTenantIdFromContext,
  resolveEffectiveSettingsWithSources,
  type TokenEmbeddingLimits,
} from '@authrim/ar-lib-core';
import { SettingsUnavailableError, settingsUnavailableResponse } from './settings-unavailable';

// =============================================================================
// Types
// =============================================================================

interface TokenEmbeddingSettings {
  // Feature flags
  policy_embedding_enabled: boolean;
  custom_claims_enabled: boolean;
  id_level_permissions_enabled: boolean;

  // Limits
  limits: TokenEmbeddingLimits;

  // Metadata
  last_updated?: string;
}

interface TokenEmbeddingSettingsUpdate {
  policy_embedding_enabled?: boolean;
  custom_claims_enabled?: boolean;
  id_level_permissions_enabled?: boolean;
  max_embedded_permissions?: number;
  max_resource_permissions?: number;
  max_custom_claims?: number;
}

// =============================================================================
// Helpers
// =============================================================================

const KV_KEYS = {
  POLICY_EMBEDDING: 'policy:flags:ENABLE_POLICY_EMBEDDING',
  CUSTOM_CLAIMS: 'policy:flags:ENABLE_CUSTOM_CLAIMS',
  ID_LEVEL_PERMISSIONS: 'policy:flags:ENABLE_ID_LEVEL_PERMISSIONS',
  MAX_EMBEDDED_PERMISSIONS: 'config:max_embedded_permissions',
  MAX_RESOURCE_PERMISSIONS: 'config:max_resource_permissions',
  MAX_CUSTOM_CLAIMS: 'config:max_custom_claims',
  LAST_UPDATED: 'config:token_embedding:last_updated',
};

/**
 * Policy embedding and the embedding limits as token issuance applies them for the request's
 * tenant (Settings API values, else the values saved here, else env, else defaults), read
 * without caches. Throws SettingsUnavailableError (503) when they cannot be read.
 */
async function effectiveEmbeddingSettings(c: Context): Promise<{
  policyEmbeddingEnabled: boolean;
  limits: TokenEmbeddingLimits;
}> {
  const tenantId = getTenantIdFromContext(c);
  try {
    const [flags, limits] = await Promise.all([
      resolveEffectiveSettingsWithSources(c.env, 'feature-flags', {
        tenantId,
        keys: ['feature.enable_policy_embedding'],
        freshLegacy: true,
      }),
      resolveEffectiveSettingsWithSources(c.env, 'limits', {
        tenantId,
        keys: [
          'limits.max_embedded_permissions',
          'limits.max_resource_permissions',
          'limits.max_custom_claims',
        ],
        freshLegacy: true,
      }),
    ]);
    return {
      policyEmbeddingEnabled: flags.values['feature.enable_policy_embedding'] === true,
      limits: {
        max_embedded_permissions: limits.values['limits.max_embedded_permissions'] as number,
        max_resource_permissions: limits.values['limits.max_resource_permissions'] as number,
        max_custom_claims: limits.values['limits.max_custom_claims'] as number,
      },
    };
  } catch (error) {
    throw new SettingsUnavailableError(error);
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/settings/token-embedding
 * Get current token embedding settings
 */
export async function getTokenEmbeddingSettings(c: Context) {
  const log = getLogger(c).module('TokenEmbeddingAPI');
  try {
    // Get current feature flag states
    const [{ policyEmbeddingEnabled, limits }, customClaimsEnabled, idLevelPermissionsEnabled] =
      await Promise.all([
        effectiveEmbeddingSettings(c),
        isCustomClaimsEnabled(c.env),
        isIdLevelPermissionsEnabled(c.env),
      ]);

    // Get last updated timestamp
    let lastUpdated: string | undefined;
    if (c.env.SETTINGS) {
      try {
        lastUpdated = (await c.env.SETTINGS.get(KV_KEYS.LAST_UPDATED)) || undefined;
      } catch {
        // Ignore KV errors
      }
    }

    const settings: TokenEmbeddingSettings = {
      policy_embedding_enabled: policyEmbeddingEnabled,
      custom_claims_enabled: customClaimsEnabled,
      id_level_permissions_enabled: idLevelPermissionsEnabled,
      limits,
      last_updated: lastUpdated,
    };

    return c.json(settings);
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    log.error('Get error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get token embedding settings',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/token-embedding
 * Update token embedding settings
 */
export async function updateTokenEmbeddingSettings(c: Context) {
  const log = getLogger(c).module('TokenEmbeddingAPI');
  const body = await c.req.json<TokenEmbeddingSettingsUpdate>();

  if (!c.env.SETTINGS) {
    return c.json(
      {
        error: 'configuration_error',
        error_description: 'SETTINGS KV namespace not configured',
      },
      500
    );
  }

  const booleanSettings = [
    ['policy_embedding_enabled', body.policy_embedding_enabled],
    ['custom_claims_enabled', body.custom_claims_enabled],
    ['id_level_permissions_enabled', body.id_level_permissions_enabled],
  ] as const;
  for (const [name, value] of booleanSettings) {
    if (value !== undefined && typeof value !== 'boolean') {
      return c.json(
        { error: 'invalid_request', error_description: `${name} must be a boolean` },
        400
      );
    }
  }

  const limitSettings = [
    ['max_embedded_permissions', body.max_embedded_permissions, 500],
    ['max_resource_permissions', body.max_resource_permissions, 1000],
    ['max_custom_claims', body.max_custom_claims, 100],
  ] as const;
  for (const [name, value, maximum] of limitSettings) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `${name} must be an integer between 1 and ${maximum}`,
        },
        400
      );
    }
  }

  try {
    const updates: string[] = [];

    // Update feature flags
    if (body.policy_embedding_enabled !== undefined) {
      await c.env.SETTINGS.put(
        KV_KEYS.POLICY_EMBEDDING,
        body.policy_embedding_enabled ? 'true' : 'false'
      );
      updates.push(`policy_embedding_enabled=${body.policy_embedding_enabled}`);
    }

    if (body.custom_claims_enabled !== undefined) {
      await c.env.SETTINGS.put(
        KV_KEYS.CUSTOM_CLAIMS,
        body.custom_claims_enabled ? 'true' : 'false'
      );
      updates.push(`custom_claims_enabled=${body.custom_claims_enabled}`);
    }

    if (body.id_level_permissions_enabled !== undefined) {
      await c.env.SETTINGS.put(
        KV_KEYS.ID_LEVEL_PERMISSIONS,
        body.id_level_permissions_enabled ? 'true' : 'false'
      );
      updates.push(`id_level_permissions_enabled=${body.id_level_permissions_enabled}`);
    }

    // Update limits
    if (body.max_embedded_permissions !== undefined) {
      await c.env.SETTINGS.put(
        KV_KEYS.MAX_EMBEDDED_PERMISSIONS,
        String(body.max_embedded_permissions)
      );
      updates.push(`max_embedded_permissions=${body.max_embedded_permissions}`);
    }

    if (body.max_resource_permissions !== undefined) {
      await c.env.SETTINGS.put(
        KV_KEYS.MAX_RESOURCE_PERMISSIONS,
        String(body.max_resource_permissions)
      );
      updates.push(`max_resource_permissions=${body.max_resource_permissions}`);
    }

    if (body.max_custom_claims !== undefined) {
      await c.env.SETTINGS.put(KV_KEYS.MAX_CUSTOM_CLAIMS, String(body.max_custom_claims));
      updates.push(`max_custom_claims=${body.max_custom_claims}`);
    }

    if (updates.length === 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'No valid settings provided to update',
        },
        400
      );
    }

    // Update last_updated timestamp
    const lastUpdated = new Date().toISOString();
    await c.env.SETTINGS.put(KV_KEYS.LAST_UPDATED, lastUpdated);

    // Log audit
    log.info('Settings updated', { updates: updates.join(', ') });

    // Return updated settings
    const [{ policyEmbeddingEnabled, limits }, customClaimsEnabled, idLevelPermissionsEnabled] =
      await Promise.all([
        effectiveEmbeddingSettings(c),
        isCustomClaimsEnabled(c.env),
        isIdLevelPermissionsEnabled(c.env),
      ]);

    const settings: TokenEmbeddingSettings = {
      policy_embedding_enabled: policyEmbeddingEnabled,
      custom_claims_enabled: customClaimsEnabled,
      id_level_permissions_enabled: idLevelPermissionsEnabled,
      limits,
      last_updated: lastUpdated,
    };

    return c.json(settings);
  } catch (error) {
    if (error instanceof SettingsUnavailableError) return settingsUnavailableResponse(c);
    log.error('Update error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update token embedding settings',
      },
      500
    );
  }
}

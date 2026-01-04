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
  isPolicyEmbeddingEnabled,
  isCustomClaimsEnabled,
  isIdLevelPermissionsEnabled,
  getEmbeddingLimits,
  getLogger,
  type TokenEmbeddingLimits,
} from '@authrim/ar-lib-core';

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
    const [policyEmbeddingEnabled, customClaimsEnabled, idLevelPermissionsEnabled, limits] =
      await Promise.all([
        isPolicyEmbeddingEnabled(c.env),
        isCustomClaimsEnabled(c.env),
        isIdLevelPermissionsEnabled(c.env),
        getEmbeddingLimits(c.env),
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
      if (body.max_embedded_permissions < 1 || body.max_embedded_permissions > 500) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'max_embedded_permissions must be between 1 and 500',
          },
          400
        );
      }
      await c.env.SETTINGS.put(
        KV_KEYS.MAX_EMBEDDED_PERMISSIONS,
        String(body.max_embedded_permissions)
      );
      updates.push(`max_embedded_permissions=${body.max_embedded_permissions}`);
    }

    if (body.max_resource_permissions !== undefined) {
      if (body.max_resource_permissions < 1 || body.max_resource_permissions > 1000) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'max_resource_permissions must be between 1 and 1000',
          },
          400
        );
      }
      await c.env.SETTINGS.put(
        KV_KEYS.MAX_RESOURCE_PERMISSIONS,
        String(body.max_resource_permissions)
      );
      updates.push(`max_resource_permissions=${body.max_resource_permissions}`);
    }

    if (body.max_custom_claims !== undefined) {
      if (body.max_custom_claims < 1 || body.max_custom_claims > 100) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'max_custom_claims must be between 1 and 100',
          },
          400
        );
      }
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
    const [policyEmbeddingEnabled, customClaimsEnabled, idLevelPermissionsEnabled, limits] =
      await Promise.all([
        isPolicyEmbeddingEnabled(c.env),
        isCustomClaimsEnabled(c.env),
        isIdLevelPermissionsEnabled(c.env),
        getEmbeddingLimits(c.env),
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

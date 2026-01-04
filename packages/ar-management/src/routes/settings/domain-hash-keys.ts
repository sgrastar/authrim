/**
 * Email Domain Hash Key Rotation Admin API
 *
 * Manage email domain hash secrets for key rotation.
 *
 * GET    /api/admin/settings/domain-hash-keys          - Get config (secrets masked)
 * POST   /api/admin/settings/domain-hash-keys/rotate   - Start key rotation
 * PUT    /api/admin/settings/domain-hash-keys/complete - Complete key rotation
 * GET    /api/admin/settings/domain-hash-keys/status   - Get migration status
 */

import type { Context } from 'hono';
import {
  type EmailDomainHashConfig,
  type KeyRotationStatus,
  type KeyRotationInput,
  type KeyRotationResult,
  getEmailDomainHashConfig,
  validateDomainHashConfig,
  getMappingCountByVersion,
  getLogger,
} from '@authrim/ar-lib-core';

// =============================================================================
// Constants
// =============================================================================

const KV_KEY = 'email_domain_hash_config';
const MIN_SECRET_LENGTH = 16;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Mask secret keys for display (show only first/last 4 chars)
 */
function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return '****';
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

/**
 * Get user count by email_domain_hash_version
 */
async function getUserCountByVersion(
  db: D1Database,
  tenantId: string
): Promise<Record<number, number>> {
  const result = await db
    .prepare(
      `SELECT email_domain_hash_version, COUNT(*) as count
       FROM users_core
       WHERE tenant_id = ?
       GROUP BY email_domain_hash_version`
    )
    .bind(tenantId)
    .all();

  const counts: Record<number, number> = {};
  const rows = (result.results || []) as Array<{
    email_domain_hash_version: number | null;
    count: number;
  }>;
  for (const row of rows) {
    const version = row.email_domain_hash_version ?? 1; // Default to version 1
    counts[version] = row.count;
  }

  return counts;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/settings/domain-hash-keys
 * Get domain hash key configuration (secrets masked)
 */
export async function getDomainHashKeysConfig(c: Context) {
  try {
    const config = await getEmailDomainHashConfig(c.env);

    // Mask secrets for security
    const maskedSecrets: Record<number, string> = {};
    for (const [version, secret] of Object.entries(config.secrets)) {
      maskedSecrets[parseInt(version, 10)] = maskSecret(secret);
    }

    return c.json({
      current_version: config.current_version,
      secrets: maskedSecrets,
      migration_in_progress: config.migration_in_progress,
      deprecated_versions: config.deprecated_versions,
      version: config.version,
      source: c.env.SETTINGS ? 'kv' : 'env',
    });
  } catch (error) {
    // No config found
    return c.json({
      current_version: 1,
      secrets: {},
      migration_in_progress: false,
      deprecated_versions: [],
      source: 'none',
      message:
        'No domain hash key configured. Set EMAIL_DOMAIN_HASH_SECRET environment variable or use key rotation API.',
    });
  }
}

/**
 * POST /api/admin/settings/domain-hash-keys/rotate
 * Start key rotation by adding a new secret
 */
export async function rotateDomainHashKey(c: Context) {
  const log = getLogger(c).module('DomainHashKeysAPI');
  const body = await c.req.json<KeyRotationInput>();

  // Validate new secret
  if (!body.new_secret || body.new_secret.length < MIN_SECRET_LENGTH) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `new_secret must be at least ${MIN_SECRET_LENGTH} characters`,
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
    // Get existing config or create new
    let existingConfig: EmailDomainHashConfig;
    try {
      existingConfig = await getEmailDomainHashConfig(c.env);
    } catch {
      // No existing config, create from env or default
      existingConfig = {
        current_version: 1,
        secrets: {},
        migration_in_progress: false,
        deprecated_versions: [],
      };

      // Use env var if available
      if (c.env.EMAIL_DOMAIN_HASH_SECRET) {
        existingConfig.secrets[1] = c.env.EMAIL_DOMAIN_HASH_SECRET;
      }
    }

    // Determine new version number
    const existingVersions = Object.keys(existingConfig.secrets).map((v) => parseInt(v, 10));
    const newVersion = existingVersions.length > 0 ? Math.max(...existingVersions) + 1 : 1;

    // Add new secret
    const newConfig: EmailDomainHashConfig = {
      ...existingConfig,
      current_version: newVersion,
      secrets: {
        ...existingConfig.secrets,
        [newVersion]: body.new_secret,
      },
      migration_in_progress: Object.keys(existingConfig.secrets).length > 0, // Only if there are existing keys
      version: String(Date.now()),
    };

    // Validate config
    const errors = validateDomainHashConfig(newConfig);
    if (errors.length > 0) {
      return c.json(
        {
          error: 'invalid_config',
          error_description: errors.join(', '),
        },
        400
      );
    }

    // Save to KV
    await c.env.SETTINGS.put(KV_KEY, JSON.stringify(newConfig));

    const result: KeyRotationResult = {
      new_version: newVersion,
      migration_in_progress: newConfig.migration_in_progress,
      message: newConfig.migration_in_progress
        ? `Key rotation started. New version: ${newVersion}. Users will be migrated on next login.`
        : `First key configured. Version: ${newVersion}.`,
    };

    return c.json(result);
  } catch (error) {
    log.error('Rotate error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to rotate domain hash key',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/domain-hash-keys/complete
 * Complete key rotation (deprecate old versions)
 */
export async function completeDomainHashKeyRotation(c: Context) {
  const log = getLogger(c).module('DomainHashKeysAPI');
  const body = await c.req.json<{ deprecate_versions?: number[] }>();

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
    const config = await getEmailDomainHashConfig(c.env);

    if (!config.migration_in_progress) {
      return c.json(
        {
          error: 'invalid_state',
          error_description: 'No migration in progress',
        },
        400
      );
    }

    // Mark old versions as deprecated
    const versionsToDeprecate = body.deprecate_versions || [];
    const newDeprecatedVersions = [
      ...new Set([...config.deprecated_versions, ...versionsToDeprecate]),
    ].filter((v) => v !== config.current_version);

    // Update config
    const newConfig: EmailDomainHashConfig = {
      ...config,
      migration_in_progress: false,
      deprecated_versions: newDeprecatedVersions,
      version: String(Date.now()),
    };

    // Save to KV
    await c.env.SETTINGS.put(KV_KEY, JSON.stringify(newConfig));

    return c.json({
      message: 'Key rotation completed',
      current_version: config.current_version,
      deprecated_versions: newDeprecatedVersions,
    });
  } catch (error) {
    log.error('Complete error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to complete key rotation',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings/domain-hash-keys/status
 * Get key rotation migration status
 */
export async function getDomainHashKeyStatus(c: Context) {
  const log = getLogger(c).module('DomainHashKeysAPI');
  const tenantId = 'default';

  try {
    let config: EmailDomainHashConfig;
    try {
      config = await getEmailDomainHashConfig(c.env);
    } catch {
      return c.json({
        current_version: 0,
        migration_in_progress: false,
        users_by_version: {},
        org_mappings_by_version: {},
        deprecated_versions: [],
        message: 'No domain hash key configured',
      });
    }

    // Get counts
    const usersByVersion = await getUserCountByVersion(c.env.DB, tenantId);
    const orgMappingsByVersion = await getMappingCountByVersion(c.env.DB, tenantId);

    // Calculate estimated completion
    let estimatedCompletion: string | undefined;
    if (config.migration_in_progress) {
      const totalUsers = Object.values(usersByVersion).reduce((a, b) => a + b, 0);
      const migratedUsers = usersByVersion[config.current_version] || 0;

      if (totalUsers > 0 && migratedUsers < totalUsers) {
        // Rough estimate: 1% of remaining users per day (based on login frequency)
        const remainingUsers = totalUsers - migratedUsers;
        const daysRemaining = Math.ceil(remainingUsers / (totalUsers * 0.01));
        const completionDate = new Date();
        completionDate.setDate(completionDate.getDate() + daysRemaining);
        estimatedCompletion = completionDate.toISOString();
      }
    }

    const status: KeyRotationStatus = {
      current_version: config.current_version,
      migration_in_progress: config.migration_in_progress,
      users_by_version: usersByVersion,
      org_mappings_by_version: orgMappingsByVersion,
      deprecated_versions: config.deprecated_versions,
      estimated_completion: estimatedCompletion,
    };

    return c.json(status);
  } catch (error) {
    log.error('Status error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get key rotation status',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/settings/domain-hash-keys/:version
 * Remove a deprecated secret version
 */
export async function deleteDomainHashKeyVersion(c: Context) {
  const log = getLogger(c).module('DomainHashKeysAPI');
  const version = parseInt(c.req.param('version'), 10);

  if (isNaN(version)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'version must be a number',
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
    const config = await getEmailDomainHashConfig(c.env);

    // Cannot delete current version
    if (version === config.current_version) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Cannot delete current active version',
        },
        400
      );
    }

    // Version must be deprecated
    if (!config.deprecated_versions.includes(version)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'Version must be deprecated before deletion. Complete key rotation first.',
        },
        400
      );
    }

    // Check if any users still use this version
    const usersByVersion = await getUserCountByVersion(c.env.DB, 'default');
    if (usersByVersion[version] && usersByVersion[version] > 0) {
      // SECURITY: Do not expose user count in error message
      log.warn('Cannot delete version - users still using it', {
        version,
        userCount: usersByVersion[version],
      });
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Cannot delete this version: users are still using it',
        },
        400
      );
    }

    // Remove version
    const { [version]: _, ...remainingSecrets } = config.secrets;
    const newConfig: EmailDomainHashConfig = {
      ...config,
      secrets: remainingSecrets,
      deprecated_versions: config.deprecated_versions.filter((v) => v !== version),
      version: String(Date.now()),
    };

    // Save to KV
    await c.env.SETTINGS.put(KV_KEY, JSON.stringify(newConfig));

    return c.json({
      message: `Version ${version} deleted`,
      remaining_versions: Object.keys(remainingSecrets).map((v) => parseInt(v, 10)),
    });
  } catch (error) {
    log.error('Delete error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete key version',
      },
      500
    );
  }
}

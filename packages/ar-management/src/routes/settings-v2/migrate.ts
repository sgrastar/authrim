/**
 * Settings Migration API
 *
 * Provides migration from legacy KV key format to unified settings-v2 format.
 *
 * Features:
 * - Dry-run mode (required before actual migration)
 * - Detailed change preview
 * - Platform admin only access
 * - One-time execution lock
 *
 * Routes:
 * - POST /api/admin/settings/migrate - Execute migration
 * - GET /api/admin/settings/migrate/status - Get migration status
 */

import { Hono, type Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getLogger } from '@authrim/ar-lib-core';

/**
 * Base context type for getLogger compatibility
 */
type BaseContext = Context<{ Bindings: Env }>;

// =============================================================================
// Security Utilities
// =============================================================================

/**
 * Dangerous keys that could be used for prototype pollution attacks
 */
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Sanitize object to prevent prototype pollution
 * Removes dangerous keys like __proto__, constructor, prototype
 */
function sanitizeObject(obj: unknown): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!DANGEROUS_KEYS.includes(key)) {
      result[key] = value;
    }
  }

  return result;
}

// =============================================================================
// Types
// =============================================================================

interface MigrationChange {
  scope: 'tenant' | 'client' | 'platform';
  scopeId: string | null;
  category: string;
  oldKey: string;
  newKey: string;
  oldValue: string | null;
  newValue: unknown;
  action: 'set' | 'skip' | 'conflict';
  reason?: string;
}

interface MigrationRequest {
  dryRun: boolean;
  fromVersion?: 'v1';
  toVersion?: 'v2';
  categories?: string[];
}

interface MigrationResult {
  dryRun: boolean;
  timestamp: string;
  changes: MigrationChange[];
  summary: {
    total: number;
    set: number;
    skipped: number;
    conflicts: number;
  };
  warnings: string[];
  errors: string[];
}

interface MigrationStatus {
  migrated: boolean;
  migratedAt: string | null;
  migratedBy: string | null;
  version: string | null;
}

/**
 * Type guard for MigrationStatus
 * Validates JSON.parse result has correct structure
 */
function isMigrationStatus(obj: unknown): obj is MigrationStatus {
  if (typeof obj !== 'object' || obj === null) return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.migrated === 'boolean' &&
    (candidate.migratedAt === null || typeof candidate.migratedAt === 'string') &&
    (candidate.migratedBy === null || typeof candidate.migratedBy === 'string') &&
    (candidate.version === null || typeof candidate.version === 'string')
  );
}

// =============================================================================
// Legacy Key Mappings
// =============================================================================

/**
 * Mapping of old KV keys to new settings-v2 keys
 *
 * Format:
 *   oldKey -> { category, newKey, transform? }
 */
const LEGACY_KEY_MAPPINGS: Record<
  string,
  {
    category: string;
    newKey: string;
    scope: 'tenant' | 'platform';
    transform?: (value: string) => unknown;
  }
> = {
  // Error Configuration
  error_locale: {
    category: 'oauth',
    newKey: 'oauth.error_locale',
    scope: 'tenant',
  },
  error_response_format: {
    category: 'oauth',
    newKey: 'oauth.error_response_format',
    scope: 'tenant',
  },
  error_id_mode: {
    category: 'oauth',
    newKey: 'oauth.error_id_mode',
    scope: 'tenant',
  },

  // Security Settings
  security_cloud_provider: {
    category: 'security',
    newKey: 'security.cloud_provider',
    scope: 'platform',
  },

  // Rate Limit - Global Profile Override
  'rate-limit:profile_override': {
    category: 'rate-limit',
    newKey: 'rate-limit.profile_override',
    scope: 'tenant',
  },

  // Infrastructure Settings
  code_shards: {
    category: 'infrastructure',
    newKey: 'infrastructure.code_shards',
    scope: 'platform',
    transform: (v) => parseInt(v, 10),
  },
  revocation_shards: {
    category: 'infrastructure',
    newKey: 'infrastructure.revocation_shards',
    scope: 'platform',
    transform: (v) => parseInt(v, 10),
  },

  // Policy Flags
  REQUIRE_PKCE_FOR_PUBLIC_CLIENTS: {
    category: 'security',
    newKey: 'security.require_pkce_public_clients',
    scope: 'tenant',
    transform: (v) => v === 'true',
  },
  REQUIRE_PKCE_FOR_ALL_CLIENTS: {
    category: 'security',
    newKey: 'security.require_pkce_all_clients',
    scope: 'tenant',
    transform: (v) => v === 'true',
  },
  STRICT_REDIRECT_URI_MATCHING: {
    category: 'security',
    newKey: 'security.strict_redirect_uri_matching',
    scope: 'tenant',
    transform: (v) => v === 'true',
  },
  ALLOW_LOCALHOST_REDIRECT: {
    category: 'security',
    newKey: 'security.allow_localhost_redirect',
    scope: 'tenant',
    transform: (v) => v === 'true',
  },
  ENFORCE_STATE_PARAMETER: {
    category: 'security',
    newKey: 'security.enforce_state_parameter',
    scope: 'tenant',
    transform: (v) => v === 'true',
  },
  ALLOW_IMPLICIT_GRANT: {
    category: 'oauth',
    newKey: 'oauth.allow_implicit_grant',
    scope: 'tenant',
    transform: (v) => v === 'true',
  },
  ALLOW_RESOURCE_OWNER_PASSWORD_GRANT: {
    category: 'oauth',
    newKey: 'oauth.allow_ropc_grant',
    scope: 'tenant',
    transform: (v) => v === 'true',
  },
};

/**
 * Pattern-based key mappings for rate limit settings
 */
const RATE_LIMIT_KEY_PATTERN = /^rate-limit:(\w+):(maxRequests|windowSeconds)$/;

// =============================================================================
// Migration Logic
// =============================================================================

/**
 * Build new KV key for settings-v2 format
 */
function buildNewKVKey(
  scope: 'tenant' | 'platform' | 'client',
  scopeId: string | null,
  category: string
): string {
  if (scope === 'platform') {
    return `settings:platform:${category}`;
  }
  if (scope === 'client') {
    return `settings:client:${scopeId || 'default'}:${category}`;
  }
  return `settings:tenant:${scopeId || 'default'}:${category}`;
}

/**
 * Scan KV for legacy keys and determine migration changes
 */
async function scanLegacyKeys(
  kv: KVNamespace,
  categories?: string[]
): Promise<{ changes: MigrationChange[]; warnings: string[] }> {
  const changes: MigrationChange[] = [];
  const warnings: string[] = [];

  // Scan for known static keys
  for (const [oldKey, mapping] of Object.entries(LEGACY_KEY_MAPPINGS)) {
    // Filter by category if specified
    if (categories && !categories.includes(mapping.category)) {
      continue;
    }

    try {
      const oldValue = await kv.get(oldKey);
      if (oldValue !== null) {
        const newValue = mapping.transform ? mapping.transform(oldValue) : oldValue;

        changes.push({
          scope: mapping.scope,
          scopeId: mapping.scope === 'tenant' ? 'default' : null,
          category: mapping.category,
          oldKey,
          newKey: mapping.newKey,
          oldValue,
          newValue,
          action: 'set',
        });
      }
    } catch (error) {
      warnings.push(
        `Failed to read key ${oldKey}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Scan for rate-limit pattern keys using KV list
  try {
    const listResult = await kv.list({ prefix: 'rate-limit:' });
    for (const key of listResult.keys) {
      const match = RATE_LIMIT_KEY_PATTERN.exec(key.name);
      if (match) {
        const [, profileName, settingType] = match;
        const oldValue = await kv.get(key.name);

        if (oldValue !== null) {
          const newKey =
            settingType === 'maxRequests'
              ? `rate-limit.${profileName}_max_requests`
              : `rate-limit.${profileName}_window_seconds`;

          changes.push({
            scope: 'tenant',
            scopeId: 'default',
            category: 'rate-limit',
            oldKey: key.name,
            newKey,
            oldValue,
            newValue: parseInt(oldValue, 10),
            action: 'set',
          });
        }
      }
    }
  } catch (error) {
    warnings.push(
      `Failed to scan rate-limit keys: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  return { changes, warnings };
}

/**
 * Apply migration changes to KV
 */
async function applyMigration(
  kv: KVNamespace,
  changes: MigrationChange[]
): Promise<{ applied: number; errors: string[] }> {
  const errors: string[] = [];
  let applied = 0;

  // Group changes by new KV key (category + scope)
  const groupedChanges = new Map<string, MigrationChange[]>();
  for (const change of changes) {
    if (change.action !== 'set') continue;

    const kvKey = buildNewKVKey(change.scope, change.scopeId, change.category);
    if (!groupedChanges.has(kvKey)) {
      groupedChanges.set(kvKey, []);
    }
    groupedChanges.get(kvKey)!.push(change);
  }

  // Apply grouped changes
  for (const [kvKey, categoryChanges] of groupedChanges) {
    try {
      // Read existing settings (if any) with type validation
      const existingRaw = await kv.get(kvKey);
      let existing: Record<string, unknown> = {};
      if (existingRaw) {
        try {
          const parsed = JSON.parse(existingRaw);
          // Validate parsed data is a plain object (not null, not array)
          // and sanitize to prevent prototype pollution
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            existing = sanitizeObject(parsed);
          } else {
            errors.push(
              `Invalid KV data format for ${kvKey}: expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
            );
          }
        } catch {
          errors.push(`Failed to parse KV data for ${kvKey}: invalid JSON`);
        }
      }

      // Merge new values
      for (const change of categoryChanges) {
        // Don't overwrite if already exists in new format
        if (existing[change.newKey] !== undefined) {
          change.action = 'skip';
          change.reason = 'Already exists in new format';
          continue;
        }

        existing[change.newKey] = change.newValue;
        applied++;
      }

      // Write back
      await kv.put(kvKey, JSON.stringify(existing));
    } catch (error) {
      errors.push(
        `Failed to write ${kvKey}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  return { applied, errors };
}

// =============================================================================
// Route Handlers
// =============================================================================

const migrateRouter = new Hono<{
  Bindings: Env;
  Variables: {
    adminUser?: { id: string; role?: string };
  };
}>();

/**
 * Platform admin middleware for migration routes
 * Per spec: "Migration API execution restriction - platform admin only"
 */
migrateRouter.use('/migrate', async (c, next) => {
  const adminUser = c.get('adminUser');

  // Check if user has platform_admin role
  // Note: The adminAuthMiddleware at /api/admin/* handles basic auth
  // This middleware adds the platform admin restriction for migration operations
  if (!adminUser || adminUser.role !== 'platform_admin') {
    return c.json(
      {
        error: 'forbidden',
        message: 'Migration API requires platform admin privileges',
      },
      403
    );
  }

  await next();
});

/**
 * POST /api/admin/settings/migrate
 *
 * Execute settings migration from v1 to v2 format
 * Requires: platform_admin role
 */
migrateRouter.post('/migrate', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return c.json(
      {
        error: 'kv_not_configured',
        message: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  // Parse request
  let body: MigrationRequest;
  try {
    body = await c.req.json<MigrationRequest>();
  } catch {
    return c.json(
      {
        error: 'bad_request',
        message: 'Invalid JSON body',
      },
      400
    );
  }

  // Validate dryRun is explicitly provided
  if (body.dryRun === undefined) {
    return c.json(
      {
        error: 'bad_request',
        message: 'dryRun parameter is required (must be true or false)',
      },
      400
    );
  }

  // Check migration lock (only for actual migration)
  if (!body.dryRun) {
    const status = await kv.get('settings:migration:status');
    if (status) {
      try {
        const parsed = JSON.parse(status);
        // Validate structure with type guard
        if (isMigrationStatus(parsed) && parsed.migrated) {
          return c.json(
            {
              error: 'already_migrated',
              message: 'Migration has already been executed. Delete the lock key to re-run.',
              migratedAt: parsed.migratedAt,
              migratedBy: parsed.migratedBy,
            },
            409
          );
        }
      } catch {
        // Invalid migration status data - treat as not migrated and continue
        const log = getLogger(c as unknown as BaseContext).module('SettingsMigrationAPI');
        log.warn('Invalid migration status JSON, treating as not migrated', {});
      }
    }
  }

  // Scan for legacy keys
  const { changes, warnings } = await scanLegacyKeys(kv, body.categories);

  // Calculate summary
  const summary = {
    total: changes.length,
    set: changes.filter((c) => c.action === 'set').length,
    skipped: changes.filter((c) => c.action === 'skip').length,
    conflicts: changes.filter((c) => c.action === 'conflict').length,
  };

  const result: MigrationResult = {
    dryRun: body.dryRun,
    timestamp: new Date().toISOString(),
    changes,
    summary,
    warnings,
    errors: [],
  };

  // If dry-run, return preview
  if (body.dryRun) {
    return c.json(result);
  }

  // Apply migration
  const { applied, errors } = await applyMigration(kv, changes);
  result.summary.set = applied;
  result.errors = errors;

  // Set migration lock
  const actor = c.get('adminUser')?.id ?? 'unknown';
  const migrationStatus: MigrationStatus = {
    migrated: true,
    migratedAt: new Date().toISOString(),
    migratedBy: actor,
    version: 'v2',
  };
  await kv.put('settings:migration:status', JSON.stringify(migrationStatus));

  return c.json(result);
});

/**
 * GET /api/admin/settings/migrate/status
 *
 * Get current migration status
 */
migrateRouter.get('/migrate/status', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return c.json(
      {
        error: 'kv_not_configured',
        message: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  const statusRaw = await kv.get('settings:migration:status');
  if (!statusRaw) {
    return c.json({
      migrated: false,
      migratedAt: null,
      migratedBy: null,
      version: null,
    });
  }

  try {
    const parsed = JSON.parse(statusRaw);
    // Validate structure with type guard
    if (isMigrationStatus(parsed)) {
      return c.json(parsed);
    }
    // Invalid structure - return default state
    const log = getLogger(c as unknown as BaseContext).module('SettingsMigrationAPI');
    log.warn('Invalid migration status structure, returning default state', {});
    return c.json({
      migrated: false,
      migratedAt: null,
      migratedBy: null,
      version: null,
    });
  } catch {
    // Invalid JSON in status - return default state
    const log = getLogger(c as unknown as BaseContext).module('SettingsMigrationAPI');
    log.warn('Invalid migration status JSON, returning default state', {});
    return c.json({
      migrated: false,
      migratedAt: null,
      migratedBy: null,
      version: null,
    });
  }
});

/**
 * DELETE /api/admin/settings/migrate/lock
 *
 * Clear migration lock (for re-running migration)
 * This is a sensitive operation and is logged for audit purposes
 */
migrateRouter.delete('/migrate/lock', async (c) => {
  const kv = c.env.AUTHRIM_CONFIG;
  if (!kv) {
    return c.json(
      {
        error: 'kv_not_configured',
        message: 'AUTHRIM_CONFIG KV namespace is not configured',
      },
      500
    );
  }

  // Get actor for audit logging
  const actor = c.get('adminUser')?.id ?? 'unknown';

  // Audit log before deletion
  const log = getLogger(c as unknown as BaseContext).module('SettingsMigrationAPI');
  log.info('Migration lock cleared', {
    event: 'migration.lock_cleared',
    actor,
  });

  await kv.delete('settings:migration:status');

  return c.json({
    success: true,
    message: 'Migration lock cleared. You can now re-run the migration.',
    clearedBy: actor,
  });
});

export default migrateRouter;

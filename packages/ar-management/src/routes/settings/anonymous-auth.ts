/**
 * Anonymous Authentication Admin API
 *
 * Provides admin endpoints for managing anonymous authentication settings
 * and anonymous users.
 *
 * Configuration APIs:
 * GET  /api/admin/settings/anonymous-auth        - Get anonymous auth config
 * PUT  /api/admin/settings/anonymous-auth        - Update anonymous auth config
 *
 * Anonymous User Management APIs:
 * GET    /api/admin/anonymous-users              - List anonymous users
 * GET    /api/admin/anonymous-users/:id          - Get specific anonymous user
 * GET    /api/admin/anonymous-users/:id/upgrades - Get upgrade history
 * DELETE /api/admin/anonymous-users/:id          - Delete anonymous user
 * POST   /api/admin/anonymous-users/cleanup      - Cleanup expired anonymous users
 *
 * @see architecture-decisions.md §17 for design details
 */

import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  isAnonymousAuthEnabled,
  getLogger,
  type Env,
} from '@authrim/ar-lib-core';

// ============================================================================
// Configuration API
// ============================================================================

/**
 * GET /api/admin/settings/anonymous-auth
 * Get anonymous authentication configuration
 */
export async function getAnonymousAuthConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AnonymousAuthConfigAPI');
  try {
    const enabled = await isAnonymousAuthEnabled(c.env);

    // Get additional config from KV if available
    let defaultExpiresInDays: number | null = null;
    let cleanupIntervalHours = 24;

    if (c.env.AUTHRIM_CONFIG) {
      const expiresConfig = await c.env.AUTHRIM_CONFIG.get(
        'anonymous_auth:default_expires_in_days'
      );
      if (expiresConfig) {
        defaultExpiresInDays = parseInt(expiresConfig, 10);
      }

      const cleanupConfig = await c.env.AUTHRIM_CONFIG.get('anonymous_auth:cleanup_interval_hours');
      if (cleanupConfig) {
        cleanupIntervalHours = parseInt(cleanupConfig, 10);
      }
    }

    return c.json({
      enabled,
      config: {
        default_expires_in_days: defaultExpiresInDays,
        cleanup_interval_hours: cleanupIntervalHours,
      },
      source: c.env.ENABLE_ANONYMOUS_AUTH ? 'env' : 'default',
    });
  } catch (error) {
    log.error('Error getting config', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get anonymous auth configuration',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/settings/anonymous-auth
 * Update anonymous authentication configuration
 *
 * Request body:
 * {
 *   "enabled": boolean,
 *   "default_expires_in_days": number | null,
 *   "cleanup_interval_hours": number
 * }
 */
export async function updateAnonymousAuthConfig(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AnonymousAuthConfigAPI');
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
    const body = await c.req.json<{
      enabled?: boolean;
      default_expires_in_days?: number | null;
      cleanup_interval_hours?: number;
    }>();

    const updates: string[] = [];

    // Update enabled flag
    if (body.enabled !== undefined) {
      await c.env.AUTHRIM_CONFIG.put(
        'feature_flag:ENABLE_ANONYMOUS_AUTH',
        body.enabled ? 'true' : 'false'
      );
      updates.push(`enabled: ${body.enabled}`);
    }

    // Update default expiration
    if (body.default_expires_in_days !== undefined) {
      if (body.default_expires_in_days === null) {
        await c.env.AUTHRIM_CONFIG.delete('anonymous_auth:default_expires_in_days');
        updates.push('default_expires_in_days: null (unlimited)');
      } else {
        if (typeof body.default_expires_in_days !== 'number' || body.default_expires_in_days < 1) {
          return c.json(
            {
              error: 'invalid_value',
              error_description: 'default_expires_in_days must be a positive number or null',
            },
            400
          );
        }
        await c.env.AUTHRIM_CONFIG.put(
          'anonymous_auth:default_expires_in_days',
          body.default_expires_in_days.toString()
        );
        updates.push(`default_expires_in_days: ${body.default_expires_in_days}`);
      }
    }

    // Update cleanup interval
    if (body.cleanup_interval_hours !== undefined) {
      if (typeof body.cleanup_interval_hours !== 'number' || body.cleanup_interval_hours < 1) {
        return c.json(
          {
            error: 'invalid_value',
            error_description: 'cleanup_interval_hours must be a positive number',
          },
          400
        );
      }
      await c.env.AUTHRIM_CONFIG.put(
        'anonymous_auth:cleanup_interval_hours',
        body.cleanup_interval_hours.toString()
      );
      updates.push(`cleanup_interval_hours: ${body.cleanup_interval_hours}`);
    }

    return c.json({
      success: true,
      updates,
      note: 'Config updated. Cache will refresh within 10 seconds.',
    });
  } catch (error) {
    log.error('Error updating config', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update configuration',
      },
      500
    );
  }
}

// ============================================================================
// Anonymous User Management API
// ============================================================================

/**
 * GET /api/admin/anonymous-users
 * List anonymous users with pagination
 *
 * Query params:
 * - limit: number (default: 50, max: 100)
 * - offset: number (default: 0)
 * - include_expired: boolean (default: false)
 */
export async function listAnonymousUsers(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AnonymousUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const includeExpired = c.req.query('include_expired') === 'true';

    const now = Date.now();

    // Build query based on include_expired flag
    let whereClause = 'WHERE ad.tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (!includeExpired) {
      whereClause += ' AND ad.is_active = 1 AND (ad.expires_at IS NULL OR ad.expires_at > ?)';
      params.push(now);
    }

    // Get total count
    const countResult = await authCtx.coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM anonymous_devices ad ${whereClause}`,
      params
    );

    // Get anonymous users with device info
    const users = await authCtx.coreAdapter.query<{
      device_id: string;
      user_id: string;
      device_platform: string | null;
      device_stability: string;
      expires_at: number | null;
      created_at: number;
      last_used_at: number;
      is_active: number;
    }>(
      `SELECT
        ad.id as device_id,
        ad.user_id,
        ad.device_platform,
        ad.device_stability,
        ad.expires_at,
        ad.created_at,
        ad.last_used_at,
        ad.is_active
      FROM anonymous_devices ad
      ${whereClause}
      ORDER BY ad.last_used_at DESC
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return c.json({
      total: countResult?.count || 0,
      limit,
      offset,
      users: users.map((u) => ({
        device_id: u.device_id,
        user_id: u.user_id,
        device_platform: u.device_platform,
        device_stability: u.device_stability,
        expires_at: u.expires_at,
        is_expired: u.expires_at !== null && u.expires_at < now,
        created_at: u.created_at,
        last_used_at: u.last_used_at,
        is_active: u.is_active === 1,
      })),
    });
  } catch (error) {
    log.error('Error listing users', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list anonymous users',
      },
      500
    );
  }
}

/**
 * GET /api/admin/anonymous-users/:id
 * Get specific anonymous user details
 */
export async function getAnonymousUser(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AnonymousUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userId = c.req.param('id');

    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID is required',
        },
        400
      );
    }

    // Get user core data
    const user = await authCtx.repositories.userCore.findById(userId);

    if (!user || user.tenant_id !== tenantId) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Anonymous user not found',
        },
        404
      );
    }

    if (user.user_type !== 'anonymous') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User is not an anonymous user',
        },
        400
      );
    }

    // Get all devices for this user
    const devices = await authCtx.coreAdapter.query<{
      id: string;
      device_platform: string | null;
      device_stability: string;
      expires_at: number | null;
      created_at: number;
      last_used_at: number;
      is_active: number;
    }>(
      `SELECT id, device_platform, device_stability, expires_at, created_at, last_used_at, is_active
       FROM anonymous_devices
       WHERE tenant_id = ? AND user_id = ?
       ORDER BY last_used_at DESC`,
      [tenantId, userId]
    );

    // Check if user has been upgraded
    const upgrade = await authCtx.coreAdapter.queryOne<{
      id: string;
      upgraded_user_id: string;
      upgrade_method: string;
      upgraded_at: number;
      preserve_sub: number;
    }>(
      `SELECT id, upgraded_user_id, upgrade_method, upgraded_at, preserve_sub
       FROM user_upgrades
       WHERE tenant_id = ? AND anonymous_user_id = ?
       ORDER BY upgraded_at DESC
       LIMIT 1`,
      [tenantId, userId]
    );

    const now = Date.now();

    return c.json({
      user_id: userId,
      user_type: user.user_type,
      created_at: user.created_at,
      last_login_at: user.last_login_at,
      devices: devices.map((d) => ({
        id: d.id,
        platform: d.device_platform,
        stability: d.device_stability,
        expires_at: d.expires_at,
        is_expired: d.expires_at !== null && d.expires_at < now,
        created_at: d.created_at,
        last_used_at: d.last_used_at,
        is_active: d.is_active === 1,
      })),
      upgrade: upgrade
        ? {
            upgraded_user_id: upgrade.upgraded_user_id,
            method: upgrade.upgrade_method,
            upgraded_at: upgrade.upgraded_at,
            preserve_sub: upgrade.preserve_sub === 1,
          }
        : null,
    });
  } catch (error) {
    log.error('Error getting user', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get anonymous user',
      },
      500
    );
  }
}

/**
 * GET /api/admin/anonymous-users/:id/upgrades
 * Get upgrade history for an anonymous user (audit trail)
 */
export async function getAnonymousUserUpgrades(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AnonymousUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userId = c.req.param('id');

    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID is required',
        },
        400
      );
    }

    // Get all upgrades related to this user (as anonymous or as upgraded target)
    const upgrades = await authCtx.coreAdapter.query<{
      id: string;
      anonymous_user_id: string;
      upgraded_user_id: string;
      upgrade_method: string;
      provider_id: string | null;
      preserve_sub: number;
      upgraded_at: number;
      data_migrated: number;
    }>(
      `SELECT id, anonymous_user_id, upgraded_user_id, upgrade_method, provider_id,
              preserve_sub, upgraded_at, data_migrated
       FROM user_upgrades
       WHERE tenant_id = ? AND (anonymous_user_id = ? OR upgraded_user_id = ?)
       ORDER BY upgraded_at DESC`,
      [tenantId, userId, userId]
    );

    return c.json({
      user_id: userId,
      upgrades: upgrades.map((u) => ({
        id: u.id,
        anonymous_user_id: u.anonymous_user_id,
        upgraded_user_id: u.upgraded_user_id,
        method: u.upgrade_method,
        provider_id: u.provider_id,
        preserve_sub: u.preserve_sub === 1,
        upgraded_at: u.upgraded_at,
        data_migrated: u.data_migrated === 1,
      })),
    });
  } catch (error) {
    log.error('Error getting upgrades', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get upgrade history',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/anonymous-users/:id
 * Delete an anonymous user and their devices
 */
export async function deleteAnonymousUser(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AnonymousUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userId = c.req.param('id');

    if (!userId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID is required',
        },
        400
      );
    }

    // Verify user exists and is anonymous
    const user = await authCtx.repositories.userCore.findById(userId);

    if (!user || user.tenant_id !== tenantId) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Anonymous user not found',
        },
        404
      );
    }

    if (user.user_type !== 'anonymous') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User is not an anonymous user. Use regular user deletion.',
        },
        400
      );
    }

    // Delete devices first (foreign key constraint)
    await authCtx.coreAdapter.execute(
      'DELETE FROM anonymous_devices WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    // Delete user (upgrade history preserved for audit)
    await authCtx.repositories.userCore.delete(userId);

    return c.json({
      success: true,
      deleted_user_id: userId,
      note: 'Upgrade history preserved for audit purposes.',
    });
  } catch (error) {
    log.error('Error deleting user', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete anonymous user',
      },
      500
    );
  }
}

/**
 * POST /api/admin/anonymous-users/cleanup
 * Cleanup expired anonymous users
 *
 * Request body:
 * {
 *   "dry_run": boolean (default: true),
 *   "limit": number (default: 100, max: 1000)
 * }
 */
export async function cleanupExpiredAnonymousUsers(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('AnonymousUsersAPI');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const body = await c.req
      .json<{
        dry_run?: boolean;
        limit?: number;
      }>()
      .catch(() => ({ dry_run: true, limit: 100 }));

    const dryRun = body.dry_run !== false; // Default to true (safe mode)
    const limit = Math.min(body.limit ?? 100, 1000);
    const now = Date.now();

    // Find expired anonymous users
    const expiredDevices = await authCtx.coreAdapter.query<{
      user_id: string;
      device_id: string;
      expires_at: number;
    }>(
      `SELECT ad.user_id, ad.id as device_id, ad.expires_at
       FROM anonymous_devices ad
       INNER JOIN users_core uc ON ad.user_id = uc.id
       WHERE ad.tenant_id = ? AND ad.is_active = 1 AND ad.expires_at IS NOT NULL AND ad.expires_at < ?
         AND uc.user_type = 'anonymous'
       ORDER BY ad.expires_at ASC
       LIMIT ?`,
      [tenantId, now, limit]
    );

    if (dryRun) {
      return c.json({
        dry_run: true,
        expired_count: expiredDevices.length,
        expired_devices: expiredDevices.map((d) => ({
          user_id: d.user_id,
          device_id: d.device_id,
          expired_at: d.expires_at,
          expired_since_hours: Math.floor((now - d.expires_at) / (1000 * 60 * 60)),
        })),
        note: 'Set dry_run=false to actually delete these users.',
      });
    }

    // Collect unique user IDs
    const userIds = [...new Set(expiredDevices.map((d) => d.user_id))];

    // Delete in transaction-like manner
    let deletedDevices = 0;
    let deletedUsers = 0;

    for (const userId of userIds) {
      // Check if user has any active (non-expired) devices
      const activeDevice = await authCtx.coreAdapter.queryOne<{ id: string }>(
        `SELECT id FROM anonymous_devices
         WHERE tenant_id = ? AND user_id = ? AND is_active = 1
           AND (expires_at IS NULL OR expires_at > ?)`,
        [tenantId, userId, now]
      );

      if (!activeDevice) {
        // No active devices, delete user
        await authCtx.coreAdapter.execute(
          'DELETE FROM anonymous_devices WHERE tenant_id = ? AND user_id = ?',
          [tenantId, userId]
        );
        await authCtx.repositories.userCore.delete(userId);
        deletedUsers++;
        deletedDevices += expiredDevices.filter((d) => d.user_id === userId).length;
      } else {
        // User has active devices, just deactivate expired ones
        await authCtx.coreAdapter.execute(
          `UPDATE anonymous_devices SET is_active = 0
           WHERE tenant_id = ? AND user_id = ? AND expires_at IS NOT NULL AND expires_at < ?`,
          [tenantId, userId, now]
        );
        deletedDevices += expiredDevices.filter((d) => d.user_id === userId).length;
      }
    }

    return c.json({
      success: true,
      dry_run: false,
      deleted_users: deletedUsers,
      deleted_devices: deletedDevices,
      deactivated_only: deletedDevices - (userIds.length === deletedUsers ? deletedDevices : 0),
    });
  } catch (error) {
    log.error('Error during cleanup', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to cleanup expired anonymous users',
      },
      500
    );
  }
}

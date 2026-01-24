/**
 * Settings History API Handlers
 *
 * Provides configuration versioning and rollback capabilities.
 *
 * Endpoints:
 * - GET /api/admin/settings/:category/history - List version history
 * - GET /api/admin/settings/:category/history/:version - Get specific version
 * - POST /api/admin/settings/:category/rollback - Rollback to previous version
 *
 * Supported Categories:
 * - oauth - Token expiration, refresh token settings
 * - rate_limit - Rate limiting configuration
 * - logout - Logout settings
 * - webhook - Webhook configuration
 * - feature_flags - Feature flags
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  createSettingsHistoryManager,
  type SettingsHistoryManager,
  type ListVersionsOptions,
  type RollbackInput,
  // Event System
  publishEvent,
  SETTINGS_EVENTS,
  type SettingsEventData,
  getLogger,
  // Authorization
  getScopedCategoryMeta,
  type CategoryName,
  type SettingScopeLevel,
} from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

/**
 * Admin user context (set by admin auth middleware)
 */
interface AdminUser {
  id: string;
  email?: string;
  role?: string;
}

/**
 * Base context type for publishEvent compatibility
 */
type BaseContext = Context<{ Bindings: Env }>;

/**
 * Context type with admin user variables
 */
type SettingsContext = Context<{
  Bindings: Env;
  Variables: {
    adminUser?: AdminUser;
    adminAuth?: AdminAuthContext;
  };
}>;

// =============================================================================
// Authorization Helpers (mirrored from index.ts for consistency)
// =============================================================================

/**
 * Check if user has permission for a category at a given scope level
 */
function checkRolePermission(
  userRoles: string[],
  category: CategoryName,
  scopeLevel: SettingScopeLevel,
  action: 'view' | 'edit'
): boolean {
  // super_admin and system_admin always have access
  if (userRoles.includes('super_admin') || userRoles.includes('system_admin')) {
    return true;
  }

  const scopedMeta = getScopedCategoryMeta(category);
  const perms = scopedMeta.scopePermissions[scopeLevel];

  if (action === 'edit') {
    return perms.editRoles.some((role) => userRoles.includes(role));
  }
  return perms.viewRoles.some((role) => userRoles.includes(role));
}

/**
 * Check if user can access a specific tenant's data
 * super_admin, system_admin and distributor_admin can access any tenant
 * org_admin can only access their own tenant
 */
function canAccessTenant(adminAuth: AdminAuthContext | undefined, tenantId: string): boolean {
  if (!adminAuth) return false;

  const userRoles = adminAuth.roles;

  // super_admin, system_admin and distributor_admin can access any tenant
  if (
    userRoles.includes('super_admin') ||
    userRoles.includes('system_admin') ||
    userRoles.includes('distributor_admin')
  ) {
    return true;
  }

  // org_admin can only access their own tenant
  if (userRoles.includes('org_admin')) {
    return adminAuth.org_id === tenantId;
  }

  // viewer with tenant association
  if (userRoles.includes('viewer')) {
    return !adminAuth.org_id || adminAuth.org_id === tenantId;
  }

  return false;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TENANT_ID = 'default';

// Valid settings categories
const VALID_CATEGORIES = [
  'oauth',
  'rate_limit',
  'logout',
  'webhook',
  'feature_flags',
  'security',
  'session',
  'consent',
  'scim',
  'saml',
  'federation',
] as const;

type SettingsCategory = (typeof VALID_CATEGORIES)[number];

// =============================================================================
// Helpers
// =============================================================================

function isValidCategory(category: string): category is SettingsCategory {
  return VALID_CATEGORIES.includes(category as SettingsCategory);
}

function getHistoryManager(c: SettingsContext): SettingsHistoryManager {
  if (!c.env.DB) {
    throw new Error('Database not configured');
  }
  const tenantId = DEFAULT_TENANT_ID;
  return createSettingsHistoryManager(c.env.DB, tenantId);
}

/**
 * Get current settings snapshot for a category
 */
async function getCurrentSnapshot(
  c: SettingsContext,
  category: SettingsCategory
): Promise<Record<string, unknown>> {
  // Read current settings from KV
  const kvPrefix = `settings:${category}:`;
  const kv = c.env.KV;

  if (!kv) {
    throw new Error('KV namespace not available');
  }

  // List all keys for this category
  const keys = await kv.list({ prefix: kvPrefix });
  const snapshot: Record<string, unknown> = {};

  for (const key of keys.keys) {
    const value = await kv.get(key.name);
    if (value !== null) {
      const shortKey = key.name.replace(kvPrefix, '');
      try {
        snapshot[shortKey] = JSON.parse(value);
      } catch {
        snapshot[shortKey] = value;
      }
    }
  }

  return snapshot;
}

/**
 * Apply a settings snapshot to KV
 */
async function applySnapshot(
  c: SettingsContext,
  category: SettingsCategory,
  snapshot: Record<string, unknown>
): Promise<void> {
  const kvPrefix = `settings:${category}:`;
  const kv = c.env.KV;

  if (!kv) {
    throw new Error('KV namespace not available');
  }

  // First, delete all existing keys for this category
  const existingKeys = await kv.list({ prefix: kvPrefix });
  for (const key of existingKeys.keys) {
    await kv.delete(key.name);
  }

  // Then, write all keys from snapshot
  for (const [key, value] of Object.entries(snapshot)) {
    const kvKey = `${kvPrefix}${key}`;
    const kvValue = typeof value === 'string' ? value : JSON.stringify(value);
    await kv.put(kvKey, kvValue);
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/settings/:category/history
 * List version history for a settings category
 */
export async function listSettingsHistory(c: SettingsContext) {
  const log = getLogger(c as unknown as BaseContext).module('SettingsHistoryAPI');
  const category = c.req.param('category');

  if (!isValidCategory(category)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid category: ${category}. Valid categories: ${VALID_CATEGORIES.join(', ')}`,
      },
      400
    );
  }

  // Authorization check
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];
  const tenantId = c.req.query('tenantId') || DEFAULT_TENANT_ID;

  if (!checkRolePermission(userRoles, category as CategoryName, 'tenant', 'view')) {
    return c.json({ error: 'forbidden', error_description: 'Insufficient permissions' }, 403);
  }

  if (!canAccessTenant(adminAuth, tenantId)) {
    return c.json({ error: 'forbidden', error_description: 'Cannot access this tenant' }, 403);
  }

  // Parse and validate pagination parameters
  const rawLimit = parseInt(c.req.query('limit') || '50', 10);
  const rawOffset = parseInt(c.req.query('offset') || '0', 10);

  // Validate pagination values
  if (isNaN(rawLimit) || isNaN(rawOffset)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid pagination parameters: limit and offset must be numbers',
      },
      400
    );
  }

  // Clamp values to safe bounds (prevent DoS via extreme values)
  const limit = Math.max(1, Math.min(rawLimit, 100)); // 1-100
  const offset = Math.max(0, rawOffset); // >= 0

  try {
    const historyManager = getHistoryManager(c);
    const result = await historyManager.listVersions(category, { limit, offset });

    return c.json({
      category,
      versions: result.versions,
      total: result.total,
      limit,
      offset,
    });
  } catch (error) {
    log.error('List error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list settings history',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings/:category/history/:version
 * Get a specific version's snapshot
 */
export async function getSettingsVersion(c: SettingsContext) {
  const log = getLogger(c as unknown as BaseContext).module('SettingsHistoryAPI');
  const category = c.req.param('category');
  const versionStr = c.req.param('version');

  if (!isValidCategory(category)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid category: ${category}`,
      },
      400
    );
  }

  // Authorization check
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];
  const tenantId = c.req.query('tenantId') || DEFAULT_TENANT_ID;

  if (!checkRolePermission(userRoles, category as CategoryName, 'tenant', 'view')) {
    return c.json({ error: 'forbidden', error_description: 'Insufficient permissions' }, 403);
  }

  if (!canAccessTenant(adminAuth, tenantId)) {
    return c.json({ error: 'forbidden', error_description: 'Cannot access this tenant' }, 403);
  }

  const version = parseInt(versionStr, 10);
  if (isNaN(version) || version < 1) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid version number',
      },
      400
    );
  }

  try {
    const historyManager = getHistoryManager(c);
    const entry = await historyManager.getVersion(category, version);

    if (!entry) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Version ${version} not found for category ${category}`,
        },
        404
      );
    }

    return c.json({
      category,
      version: entry.version,
      snapshot: entry.snapshot,
      changes: entry.changes,
      actor: {
        id: entry.actorId,
        type: entry.actorType,
      },
      changeReason: entry.changeReason,
      changeSource: entry.changeSource,
      createdAt: entry.createdAt,
    });
  } catch (error) {
    log.error('Get version error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get settings version',
      },
      500
    );
  }
}

/**
 * POST /api/admin/settings/:category/rollback
 * Rollback to a previous version
 *
 * Request body:
 * {
 *   "targetVersion": 5,
 *   "reason": "Optional reason for rollback"
 * }
 */
export async function rollbackSettings(c: SettingsContext) {
  const log = getLogger(c as unknown as BaseContext).module('SettingsHistoryAPI');
  const category = c.req.param('category');
  const tenantId = c.req.query('tenantId') || DEFAULT_TENANT_ID;

  if (!isValidCategory(category)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid category: ${category}`,
      },
      400
    );
  }

  // Authorization check (requires edit permission for rollback)
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  if (!checkRolePermission(userRoles, category as CategoryName, 'tenant', 'edit')) {
    return c.json(
      { error: 'forbidden', error_description: 'Insufficient permissions to rollback settings' },
      403
    );
  }

  if (!canAccessTenant(adminAuth, tenantId)) {
    return c.json(
      { error: 'forbidden', error_description: 'Cannot modify settings for this tenant' },
      403
    );
  }

  let body: { targetVersion: number; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid request body',
      },
      400
    );
  }

  if (typeof body.targetVersion !== 'number' || body.targetVersion < 1) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'targetVersion must be a positive integer',
      },
      400
    );
  }

  // Get actor info from context (set by admin auth middleware)
  const actorId = c.get('adminUser')?.id;

  try {
    const historyManager = getHistoryManager(c);

    // Publish rollback started event
    publishEvent(c as unknown as BaseContext, {
      type: SETTINGS_EVENTS.ROLLBACK_STARTED,
      tenantId,
      data: {
        category,
        targetVersion: body.targetVersion,
        actorId,
        changeSource: 'admin_api',
      } satisfies SettingsEventData,
    }).catch((err: unknown) => {
      log.warn(
        'Failed to publish event',
        { event: SETTINGS_EVENTS.ROLLBACK_STARTED },
        err as Error
      );
    });

    const result = await historyManager.rollback(
      category,
      {
        targetVersion: body.targetVersion,
        actorId,
        actorType: 'admin',
        changeReason: body.reason,
      },
      async () => getCurrentSnapshot(c, category),
      async (snapshot) => applySnapshot(c, category, snapshot)
    );

    // Publish rollback completed event
    publishEvent(c as unknown as BaseContext, {
      type: SETTINGS_EVENTS.ROLLBACK_COMPLETED,
      tenantId,
      data: {
        category,
        currentVersion: result.currentVersion,
        targetVersion: body.targetVersion,
        actorId,
        changeSource: 'admin_api',
      } satisfies SettingsEventData,
    }).catch((err: unknown) => {
      log.warn(
        'Failed to publish event',
        { event: SETTINGS_EVENTS.ROLLBACK_COMPLETED },
        err as Error
      );
    });

    log.info('Settings rolled back', {
      category,
      previousVersion: result.previousVersion,
      targetVersion: body.targetVersion,
      currentVersion: result.currentVersion,
    });

    return c.json({
      success: true,
      category,
      previousVersion: result.previousVersion,
      currentVersion: result.currentVersion,
      restoredFromVersion: body.targetVersion,
    });
  } catch (error) {
    // Publish rollback failed event
    publishEvent(c as unknown as BaseContext, {
      type: SETTINGS_EVENTS.ROLLBACK_FAILED,
      tenantId,
      data: {
        category,
        targetVersion: body.targetVersion,
        actorId,
        changeSource: 'admin_api',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      } satisfies SettingsEventData,
    }).catch((err: unknown) => {
      log.warn('Failed to publish event', { event: SETTINGS_EVENTS.ROLLBACK_FAILED }, err as Error);
    });

    log.error('Rollback error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: error instanceof Error ? error.message : 'Failed to rollback settings',
      },
      500
    );
  }
}

/**
 * GET /api/admin/settings/:category/current
 * Get current settings for a category (for comparison with history)
 */
export async function getCurrentSettings(c: SettingsContext) {
  const log = getLogger(c as unknown as BaseContext).module('SettingsHistoryAPI');
  const category = c.req.param('category');

  if (!isValidCategory(category)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid category: ${category}`,
      },
      400
    );
  }

  // Authorization check
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];
  const tenantId = c.req.query('tenantId') || DEFAULT_TENANT_ID;

  if (!checkRolePermission(userRoles, category as CategoryName, 'tenant', 'view')) {
    return c.json({ error: 'forbidden', error_description: 'Insufficient permissions' }, 403);
  }

  if (!canAccessTenant(adminAuth, tenantId)) {
    return c.json({ error: 'forbidden', error_description: 'Cannot access this tenant' }, 403);
  }

  try {
    const snapshot = await getCurrentSnapshot(c, category);
    const historyManager = getHistoryManager(c);
    const latestEntry = await historyManager.getLatestVersion(category);

    return c.json({
      category,
      currentVersion: latestEntry?.version ?? 0,
      settings: snapshot,
      lastModified: latestEntry?.createdAt,
      lastModifiedBy: latestEntry?.actorId,
    });
  } catch (error) {
    log.error('Get current error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get current settings',
      },
      500
    );
  }
}

/**
 * Compare two versions of settings
 *
 * GET /api/admin/settings/:category/compare?from=5&to=10
 */
export async function compareSettingsVersions(c: SettingsContext) {
  const log = getLogger(c as unknown as BaseContext).module('SettingsHistoryAPI');
  const category = c.req.param('category');
  const fromStr = c.req.query('from');
  const toStr = c.req.query('to');

  if (!isValidCategory(category)) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: `Invalid category: ${category}`,
      },
      400
    );
  }

  // Authorization check
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];
  const tenantId = c.req.query('tenantId') || DEFAULT_TENANT_ID;

  if (!checkRolePermission(userRoles, category as CategoryName, 'tenant', 'view')) {
    return c.json({ error: 'forbidden', error_description: 'Insufficient permissions' }, 403);
  }

  if (!canAccessTenant(adminAuth, tenantId)) {
    return c.json({ error: 'forbidden', error_description: 'Cannot access this tenant' }, 403);
  }

  if (!fromStr || !toStr) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Both from and to version parameters are required',
      },
      400
    );
  }

  const fromVersion = parseInt(fromStr, 10);
  const toVersion = parseInt(toStr, 10);

  if (isNaN(fromVersion) || isNaN(toVersion) || fromVersion < 1 || toVersion < 1) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid version numbers',
      },
      400
    );
  }

  try {
    const historyManager = getHistoryManager(c);

    const fromEntry = await historyManager.getVersion(category, fromVersion);
    const toEntry = await historyManager.getVersion(category, toVersion);

    if (!fromEntry) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Version ${fromVersion} not found`,
        },
        404
      );
    }

    if (!toEntry) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Version ${toVersion} not found`,
        },
        404
      );
    }

    // Calculate diff between the two snapshots
    const { calculateChanges } = await import('@authrim/ar-lib-core');
    const diff = calculateChanges(fromEntry.snapshot, toEntry.snapshot);

    return c.json({
      category,
      from: {
        version: fromVersion,
        createdAt: fromEntry.createdAt,
      },
      to: {
        version: toVersion,
        createdAt: toEntry.createdAt,
      },
      diff,
    });
  } catch (error) {
    log.error('Compare error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to compare settings versions',
      },
      500
    );
  }
}

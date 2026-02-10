/**
 * Settings API v2
 *
 * Unified settings management with:
 * - URL-based scope (tenantId/clientId)
 * - PATCH for partial updates with optimistic locking
 * - env > KV > default priority
 * - Audit logging
 * - Version history and rollback support
 *
 * Routes:
 * - GET/PATCH /api/admin/tenants/:tenantId/settings/:category
 * - GET/PATCH /api/admin/clients/:clientId/settings
 * - GET /api/admin/platform/settings/:category (read-only)
 * - GET /api/admin/settings/meta/:category
 * - POST /api/admin/settings/migrate (v1 → v2 migration)
 * - GET /api/admin/settings/migrate/status
 * - DELETE /api/admin/settings/migrate/lock
 *
 * History (Configuration Rollback):
 * - GET /api/admin/settings/:category/history - List version history
 * - GET /api/admin/settings/:category/history/:version - Get specific version
 * - POST /api/admin/settings/:category/rollback - Rollback to previous version
 * - GET /api/admin/settings/:category/current - Get current settings
 * - GET /api/admin/settings/:category/compare - Compare two versions
 */

import { Hono, type Context } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import migrateRouter from './migrate';
import {
  listSettingsHistory,
  getSettingsVersion,
  rollbackSettings,
  getCurrentSettings,
  compareSettingsVersions,
} from './history';
import {
  createSettingsManager,
  SettingsManager,
  type SettingScope,
  type SettingsPatchRequest,
  type CategoryMeta,
  ConflictError,
  ALL_CATEGORY_META,
  CATEGORY_SCOPE_CONFIG,
  type CategoryName,
  type SettingScopeLevel,
  getScopedCategoryMeta,
  DEFAULT_SCOPE_PERMISSIONS,
  // Rate limiting
  rateLimitMiddleware,
  getRateLimitProfileAsync,
  // Logger
  createLogger,
  // Security
  sanitizeObject,
  // Admin Auth
  type AdminAuthContext,
} from '@authrim/ar-lib-core';

// Module-level logger for settings audit
const log = createLogger().module('SETTINGS_AUDIT');

// =============================================================================
// Authorization Helper Functions
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
 * Check if a category is available at a given scope level
 */
function isCategoryAllowedAtScope(category: CategoryName, scopeLevel: SettingScopeLevel): boolean {
  const scopeConfig = CATEGORY_SCOPE_CONFIG[category];
  return scopeConfig?.allowedScopes.includes(scopeLevel) ?? false;
}

/**
 * Get the tenant ID that owns a client
 * Returns null if client not found
 */
async function getClientTenantId(env: Env, clientId: string): Promise<string | null> {
  try {
    // Try to get client metadata from KV
    const clientKey = `client:${clientId}:metadata`;
    const clientData = (await env.AUTHRIM_CONFIG?.get(clientKey, 'json')) as {
      tenant_id?: string;
    } | null;
    if (clientData?.tenant_id) {
      return clientData.tenant_id;
    }

    // Fallback: Try to get from D1 database if available
    const db = env.DB as D1Database | undefined;
    if (db) {
      const result = await db
        .prepare('SELECT tenant_id FROM oauth_clients WHERE client_id = ?')
        .bind(clientId)
        .first<{ tenant_id: string }>();
      return result?.tenant_id ?? null;
    }

    return null;
  } catch {
    log.warn('Failed to get client tenant ID', { clientId });
    return null;
  }
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
    // org_admin's org_id should match the tenantId
    return adminAuth.org_id === tenantId;
  }

  // viewer with tenant association
  if (userRoles.includes('viewer')) {
    // Viewers can view if they have no org restriction or org matches
    return !adminAuth.org_id || adminAuth.org_id === tenantId;
  }

  return false;
}

/**
 * Parse and sanitize PATCH request body
 */
function parsePatchRequest(rawBody: unknown): SettingsPatchRequest {
  if (typeof rawBody !== 'object' || rawBody === null) {
    return { ifMatch: '' };
  }

  const body = rawBody as Record<string, unknown>;
  return {
    ifMatch: typeof body.ifMatch === 'string' ? body.ifMatch : '',
    set: body.set && typeof body.set === 'object' ? sanitizeObject(body.set) : undefined,
    clear: Array.isArray(body.clear)
      ? body.clear.filter((k): k is string => typeof k === 'string')
      : undefined,
    disable: Array.isArray(body.disable)
      ? body.disable.filter((k): k is string => typeof k === 'string')
      : undefined,
  };
}

// Create the settings-v2 app with typed variables
const settingsV2 = new Hono<{
  Bindings: Env;
  Variables: {
    adminAuth?: AdminAuthContext;
  };
}>();

/**
 * Get or create SettingsManager for the request
 */
function getSettingsManager(env: Env): SettingsManager {
  const manager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: env.SETTINGS ?? null,
    cacheTTL: 5000, // 5 seconds (as per plan)
    auditCallback: async (event) => {
      // Log audit event (can be extended to write to KV/R2)
      log.info('Settings change', {
        action: event.event,
        scope: event.scope,
        scopeId: event.scopeId,
        category: event.category,
        actor: event.actor,
        diff: event.diff,
      });
    },
  });

  // Register all known categories
  for (const [, categoryMeta] of Object.entries(ALL_CATEGORY_META)) {
    manager.registerCategory(categoryMeta);
  }

  return manager;
}

/**
 * Error response helper
 */
function errorResponse(
  c: {
    json: (data: unknown, status: number) => Response;
  },
  error: string,
  message: string,
  status: number,
  details?: Record<string, unknown>
) {
  return c.json({ error, message, ...details }, status);
}

// =============================================================================
// Rate Limiting for Settings Endpoints
// =============================================================================

// Tenant settings - lenient for GET, moderate for PATCH
settingsV2.use('/tenants/:tenantId/settings/:category', async (c, next) => {
  const profile = await getRateLimitProfileAsync(
    c.env,
    c.req.method === 'PATCH' ? 'moderate' : 'lenient'
  );
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/tenants/:tenantId/settings/:category'],
  })(c as unknown as RateLimitContext, next);
});

// Client settings - lenient for GET, moderate for PATCH
settingsV2.use('/clients/:clientId/settings', async (c, next) => {
  const profile = await getRateLimitProfileAsync(
    c.env,
    c.req.method === 'PATCH' ? 'moderate' : 'lenient'
  );
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/clients/:clientId/settings'],
  })(c as unknown as RateLimitContext, next);
});

// Platform settings - lenient (read-only)
settingsV2.use('/platform/settings/:category', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/platform/settings/:category'],
  })(c as unknown as RateLimitContext, next);
});

// Meta endpoints - lenient
settingsV2.use('/settings/meta', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/settings/meta'],
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/meta/:category', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/settings/meta/:category'],
  })(c as unknown as RateLimitContext, next);
});

// =============================================================================
// Tenant Settings Routes
// =============================================================================

/**
 * GET /api/admin/tenants/:tenantId/settings/:category
 * Get all settings for a tenant and category
 */
settingsV2.get('/tenants/:tenantId/settings/:category', async (c) => {
  const tenantId = c.req.param('tenantId');
  const category = c.req.param('category') as CategoryName;

  // Security Check 1: Validate category exists
  if (!ALL_CATEGORY_META[category]) {
    return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
  }

  // Security Check 2: Validate category is available at tenant scope
  if (!isCategoryAllowedAtScope(category, 'tenant')) {
    return errorResponse(
      c,
      'bad_request',
      `Category "${category}" is not available at tenant scope`,
      400
    );
  }

  // Security Check 3: Validate user has permission for this category at tenant scope
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  if (!checkRolePermission(userRoles, category, 'tenant', 'view')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to view tenant settings', 403);
  }

  // Security Check 4: Validate user can access this specific tenant
  if (!canAccessTenant(adminAuth, tenantId)) {
    return errorResponse(c, 'forbidden', 'Cannot access settings for this tenant', 403);
  }

  const manager = getSettingsManager(c.env);
  const scope: SettingScope = { type: 'tenant', id: tenantId };

  try {
    const result = await manager.getAll(category, scope);
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unknown category')) {
      return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
    }
    throw error;
  }
});

/**
 * PATCH /api/admin/tenants/:tenantId/settings/:category
 * Partial update settings for a tenant and category
 */
settingsV2.patch('/tenants/:tenantId/settings/:category', async (c) => {
  const tenantId = c.req.param('tenantId');
  const category = c.req.param('category') as CategoryName;

  // Security Check 1: Validate category exists
  if (!ALL_CATEGORY_META[category]) {
    return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
  }

  // Security Check 2: Validate category is available at tenant scope
  if (!isCategoryAllowedAtScope(category, 'tenant')) {
    return errorResponse(
      c,
      'bad_request',
      `Category "${category}" is not available at tenant scope`,
      400
    );
  }

  // Security Check 3: Validate user has EDIT permission for this category at tenant scope
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  if (!checkRolePermission(userRoles, category, 'tenant', 'edit')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to edit tenant settings', 403);
  }

  // Security Check 4: Validate user can access this specific tenant
  if (!canAccessTenant(adminAuth, tenantId)) {
    return errorResponse(c, 'forbidden', 'Cannot modify settings for this tenant', 403);
  }

  const manager = getSettingsManager(c.env);
  const scope: SettingScope = { type: 'tenant', id: tenantId };

  try {
    // Parse and sanitize request body (prevent prototype pollution)
    const rawBody = await c.req.json();
    const body = parsePatchRequest(rawBody);

    // Validate ifMatch is provided
    if (!body.ifMatch) {
      return errorResponse(c, 'bad_request', 'ifMatch is required for PATCH operations', 400);
    }

    // Get actor from context (set by auth middleware)
    const actor = adminAuth?.userId ?? 'unknown';

    const result = await manager.patch(category, scope, body, actor);

    // Check if there were any rejections
    const hasRejections = Object.keys(result.rejected).length > 0;
    const hasApplied =
      result.applied.length > 0 || result.cleared.length > 0 || result.disabled.length > 0;

    // Return appropriate status
    // 200 OK if anything was applied (even with rejections)
    // 400 Bad Request if everything was rejected
    if (!hasApplied && hasRejections) {
      return c.json(
        {
          error: 'validation_failed',
          message: 'All changes were rejected',
          ...result,
        },
        400
      );
    }

    return c.json(result);
  } catch (error) {
    // Handle JSON parse errors
    if (error instanceof SyntaxError) {
      return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
    }
    if (error instanceof ConflictError) {
      return c.json(
        {
          error: 'conflict',
          message: error.message,
          currentVersion: error.currentVersion,
        },
        409
      );
    }
    if (error instanceof Error) {
      if (error.message.includes('Unknown category')) {
        return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
      }
      if (error.message.includes('read-only')) {
        return errorResponse(c, 'forbidden', error.message, 403);
      }
    }
    throw error;
  }
});

// =============================================================================
// Client Settings Routes
// =============================================================================

/**
 * GET /api/admin/clients/:clientId/settings
 * Get all settings for a client (default 'client' category)
 */
settingsV2.get('/clients/:clientId/settings', async (c) => {
  const clientId = c.req.param('clientId');
  const category: CategoryName = 'client';

  // Security Check 1: Validate user has permission for client settings
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  if (!checkRolePermission(userRoles, category, 'client', 'view')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to view client settings', 403);
  }

  // Security Check 2: Get client's tenant and verify access
  const clientTenantId = await getClientTenantId(c.env, clientId);
  if (!clientTenantId) {
    return errorResponse(c, 'not_found', `Client "${clientId}" not found`, 404);
  }

  // Security Check 3: Validate user can access this client's tenant
  if (!canAccessTenant(adminAuth, clientTenantId)) {
    return errorResponse(
      c,
      'forbidden',
      'Cannot access settings for clients in other tenants',
      403
    );
  }

  const manager = getSettingsManager(c.env);
  const scope: SettingScope = { type: 'client', id: clientId };

  try {
    // Client settings are stored under a single category
    const result = await manager.getAll('client', scope);
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unknown category')) {
      return errorResponse(c, 'not_found', 'Client settings category not found', 404);
    }
    throw error;
  }
});

/**
 * GET /api/admin/clients/:clientId/settings/:category
 * Get category-specific settings for a client (for categories that allow client-level override)
 */
settingsV2.get('/clients/:clientId/settings/:category', async (c) => {
  const clientId = c.req.param('clientId');
  const category = c.req.param('category') as CategoryName;

  // Security Check 1: Check if category exists
  if (!ALL_CATEGORY_META[category]) {
    return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
  }

  // Security Check 2: Check if category allows client-level settings
  if (!isCategoryAllowedAtScope(category, 'client')) {
    return errorResponse(
      c,
      'bad_request',
      `Category "${category}" does not support client-level settings`,
      400
    );
  }

  // Security Check 3: Validate user has permission for this category at client scope
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  if (!checkRolePermission(userRoles, category, 'client', 'view')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to view client settings', 403);
  }

  // Security Check 4: Get client's tenant and verify access
  const clientTenantId = await getClientTenantId(c.env, clientId);
  if (!clientTenantId) {
    return errorResponse(c, 'not_found', `Client "${clientId}" not found`, 404);
  }

  // Security Check 5: Validate user can access this client's tenant
  if (!canAccessTenant(adminAuth, clientTenantId)) {
    return errorResponse(
      c,
      'forbidden',
      'Cannot access settings for clients in other tenants',
      403
    );
  }

  const manager = getSettingsManager(c.env);
  const scope: SettingScope = { type: 'client', id: clientId };

  try {
    const result = await manager.getAll(category, scope);
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unknown category')) {
      return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
    }
    throw error;
  }
});

/**
 * PATCH /api/admin/clients/:clientId/settings
 * Partial update settings for a client (default 'client' category)
 */
settingsV2.patch('/clients/:clientId/settings', async (c) => {
  const clientId = c.req.param('clientId');
  const category: CategoryName = 'client';

  // Security Check 1: Validate user has EDIT permission for client settings
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  if (!checkRolePermission(userRoles, category, 'client', 'edit')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to edit client settings', 403);
  }

  // Security Check 2: Get client's tenant and verify access
  const clientTenantId = await getClientTenantId(c.env, clientId);
  if (!clientTenantId) {
    return errorResponse(c, 'not_found', `Client "${clientId}" not found`, 404);
  }

  // Security Check 3: Validate user can access this client's tenant
  if (!canAccessTenant(adminAuth, clientTenantId)) {
    return errorResponse(
      c,
      'forbidden',
      'Cannot modify settings for clients in other tenants',
      403
    );
  }

  const manager = getSettingsManager(c.env);
  const scope: SettingScope = { type: 'client', id: clientId };

  try {
    // Parse and sanitize request body (prevent prototype pollution)
    const rawBody = await c.req.json();
    const body = parsePatchRequest(rawBody);

    if (!body.ifMatch) {
      return errorResponse(c, 'bad_request', 'ifMatch is required for PATCH operations', 400);
    }

    const actor = adminAuth?.userId ?? 'unknown';
    const result = await manager.patch('client', scope, body, actor);

    const hasRejections = Object.keys(result.rejected).length > 0;
    const hasApplied =
      result.applied.length > 0 || result.cleared.length > 0 || result.disabled.length > 0;

    if (!hasApplied && hasRejections) {
      return c.json(
        {
          error: 'validation_failed',
          message: 'All changes were rejected',
          ...result,
        },
        400
      );
    }

    return c.json(result);
  } catch (error) {
    // Handle JSON parse errors
    if (error instanceof SyntaxError) {
      return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
    }
    if (error instanceof ConflictError) {
      return c.json(
        {
          error: 'conflict',
          message: error.message,
          currentVersion: error.currentVersion,
        },
        409
      );
    }
    throw error;
  }
});

/**
 * PATCH /api/admin/clients/:clientId/settings/:category
 * Partial update category-specific settings for a client
 */
settingsV2.patch('/clients/:clientId/settings/:category', async (c) => {
  const clientId = c.req.param('clientId');
  const category = c.req.param('category') as CategoryName;

  // Security Check 1: Check if category exists
  if (!ALL_CATEGORY_META[category]) {
    return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
  }

  // Security Check 2: Check if category allows client-level settings
  if (!isCategoryAllowedAtScope(category, 'client')) {
    return errorResponse(
      c,
      'bad_request',
      `Category "${category}" does not support client-level settings`,
      400
    );
  }

  // Security Check 3: Validate user has EDIT permission for this category at client scope
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  if (!checkRolePermission(userRoles, category, 'client', 'edit')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to edit client settings', 403);
  }

  // Security Check 4: Get client's tenant and verify access
  const clientTenantId = await getClientTenantId(c.env, clientId);
  if (!clientTenantId) {
    return errorResponse(c, 'not_found', `Client "${clientId}" not found`, 404);
  }

  // Security Check 5: Validate user can access this client's tenant
  if (!canAccessTenant(adminAuth, clientTenantId)) {
    return errorResponse(
      c,
      'forbidden',
      'Cannot modify settings for clients in other tenants',
      403
    );
  }

  const manager = getSettingsManager(c.env);
  const scope: SettingScope = { type: 'client', id: clientId };

  try {
    const rawBody = await c.req.json();
    const body = parsePatchRequest(rawBody);

    if (!body.ifMatch) {
      return errorResponse(c, 'bad_request', 'ifMatch is required for PATCH operations', 400);
    }

    const actor = adminAuth?.userId ?? 'unknown';
    const result = await manager.patch(category, scope, body, actor);

    const hasRejections = Object.keys(result.rejected).length > 0;
    const hasApplied =
      result.applied.length > 0 || result.cleared.length > 0 || result.disabled.length > 0;

    if (!hasApplied && hasRejections) {
      return c.json(
        {
          error: 'validation_failed',
          message: 'All changes were rejected',
          ...result,
        },
        400
      );
    }

    return c.json(result);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
    }
    if (error instanceof ConflictError) {
      return c.json(
        {
          error: 'conflict',
          message: error.message,
          currentVersion: error.currentVersion,
        },
        409
      );
    }
    if (error instanceof Error && error.message.includes('Unknown category')) {
      return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
    }
    throw error;
  }
});

// =============================================================================
// Platform Settings Routes (Read-Only)
// =============================================================================

/**
 * GET /api/admin/platform/settings/:category
 * Get platform settings (read-only)
 */
settingsV2.get('/platform/settings/:category', async (c) => {
  const category = c.req.param('category') as CategoryName;

  // Security Check 1: Validate category exists
  if (!ALL_CATEGORY_META[category]) {
    return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
  }

  // Security Check 2: Validate category is available at platform scope
  if (!isCategoryAllowedAtScope(category, 'platform')) {
    return errorResponse(
      c,
      'bad_request',
      `Category "${category}" is not available at platform scope`,
      400
    );
  }

  // Security Check 3: Validate user has permission for this category at platform scope
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  if (!checkRolePermission(userRoles, category, 'platform', 'view')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to view platform settings', 403);
  }

  const manager = getSettingsManager(c.env);
  const scope: SettingScope = { type: 'platform' };

  try {
    const result = await manager.getAll(category, scope);
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unknown category')) {
      return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
    }
    throw error;
  }
});

/**
 * PUT/PATCH/DELETE /api/admin/platform/settings/:category
 * Platform settings are read-only - return 405
 */
settingsV2.put('/platform/settings/:category', (c) => {
  return errorResponse(c, 'method_not_allowed', 'Platform settings are read-only', 405);
});

settingsV2.patch('/platform/settings/:category', (c) => {
  return errorResponse(c, 'method_not_allowed', 'Platform settings are read-only', 405);
});

settingsV2.delete('/platform/settings/:category', (c) => {
  return errorResponse(c, 'method_not_allowed', 'Platform settings are read-only', 405);
});

// =============================================================================
// Meta API Routes
// =============================================================================

/**
 * GET /api/admin/settings/meta/:category
 * Get settings metadata for a category
 */
settingsV2.get('/settings/meta/:category', async (c) => {
  const category = c.req.param('category');

  const manager = getSettingsManager(c.env);
  const meta = manager.getMeta(category);

  if (!meta) {
    return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
  }

  // Filter settings by visibility if needed
  // For now, return all settings (visibility filtering can be added based on user role)
  return c.json({
    category: meta.category,
    label: meta.label,
    description: meta.description,
    settings: meta.settings,
  });
});

/**
 * GET /api/admin/settings/meta
 * Get list of all available categories
 */
settingsV2.get('/settings/meta', (c) => {
  const categories = Object.entries(ALL_CATEGORY_META).map(([key, meta]) => ({
    category: key,
    label: meta.label,
    description: meta.description,
    settingsCount: Object.keys(meta.settings).length,
  }));

  return c.json({ categories });
});

/**
 * GET /api/admin/settings/meta/:category/scope
 * Get scope information for a category (allowed scopes and user permissions)
 *
 * Security: Only returns scopes the user has access to (view or edit)
 * to prevent information disclosure about the permission structure.
 */
settingsV2.get('/settings/meta/:category/scope', async (c) => {
  const category = c.req.param('category') as CategoryName;

  // Check if category exists
  if (!ALL_CATEGORY_META[category]) {
    return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
  }

  const scopeConfig = CATEGORY_SCOPE_CONFIG[category];
  if (!scopeConfig) {
    return errorResponse(c, 'not_found', `Scope configuration for "${category}" not found`, 404);
  }

  // Get user from context
  const adminAuth = c.get('adminAuth');
  const userRoles = adminAuth?.roles || [];

  // Get scoped metadata for permissions
  const scopedMeta = getScopedCategoryMeta(category);

  // Compute user permissions and filter to only accessible scopes
  const accessibleScopes: SettingScopeLevel[] = [];
  const userPermissions: Partial<Record<SettingScopeLevel, 'view' | 'edit'>> = {};

  for (const scope of scopeConfig.allowedScopes) {
    const perms = scopedMeta.scopePermissions[scope];
    let permission: 'view' | 'edit' | 'none' = 'none';

    // Check edit permission first
    if (perms.editRoles.some((role) => userRoles.includes(role))) {
      permission = 'edit';
    } else if (perms.viewRoles.some((role) => userRoles.includes(role))) {
      permission = 'view';
    } else if (userRoles.includes('system_admin')) {
      // system_admin always has access
      permission = perms.editRoles.length > 0 ? 'edit' : 'view';
    }

    // Only include scopes the user can access
    if (permission !== 'none') {
      accessibleScopes.push(scope);
      userPermissions[scope] = permission;
    }
  }

  // Return only accessible scopes and their permissions
  // (Does not reveal scopes the user cannot access)
  return c.json({
    allowedScopes: accessibleScopes,
    userPermissions,
  });
});

// =============================================================================
// Migration API Routes
// =============================================================================

// Mount migration routes under /settings
settingsV2.route('/settings', migrateRouter);

// =============================================================================
// Settings History Routes (Configuration Rollback)
// =============================================================================

// Rate limiting for Settings History endpoints
// Read operations (history, current, compare) use lenient profile
// Write operations (rollback) use moderate profile for stricter control
// Note: Use type assertion to bridge settingsV2's extended context type with rateLimitMiddleware's expected type
type RateLimitContext = Context<{ Bindings: Env }>;

settingsV2.use('/settings/:category/history', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/settings/:category/history'],
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/:category/history/:version', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/settings/:category/history/:version'],
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/:category/rollback', async (c, next) => {
  // Rollback is a sensitive operation that modifies system state
  // Use moderate profile for stricter rate limiting
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/settings/:category/rollback'],
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/:category/current', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/settings/:category/current'],
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/:category/compare', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/settings/:category/compare'],
  })(c as unknown as RateLimitContext, next);
});

/**
 * GET /api/admin/settings/:category/history
 * List version history for a settings category
 */
settingsV2.get('/settings/:category/history', listSettingsHistory);

/**
 * GET /api/admin/settings/:category/history/:version
 * Get a specific version's snapshot
 */
settingsV2.get('/settings/:category/history/:version', getSettingsVersion);

/**
 * POST /api/admin/settings/:category/rollback
 * Rollback to a previous version
 */
settingsV2.post('/settings/:category/rollback', rollbackSettings);

/**
 * GET /api/admin/settings/:category/current
 * Get current settings for a category (for comparison with history)
 */
settingsV2.get('/settings/:category/current', getCurrentSettings);

/**
 * GET /api/admin/settings/:category/compare
 * Compare two versions of settings
 */
settingsV2.get('/settings/:category/compare', compareSettingsVersions);

export default settingsV2;

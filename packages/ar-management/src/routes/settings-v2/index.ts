import { runTenantBackupCoveredMutation } from '../../tenant-backup-writer';
/**
 * Settings API v2
 *
 * Unified settings management with:
 * - URL-based scope (tenantId/clientId)
 * - PATCH for partial updates with optimistic locking
 * - canonical tenant/client document > env > default priority
 * - Workers KV projection for runtime readers
 * - Audit logging
 * - Version history and rollback support
 *
 * Routes:
 * - GET/PATCH /api/admin/tenants/:tenantId/settings/:category
 * - GET/PATCH /api/admin/clients/:clientId/settings
 * - GET/PATCH /api/admin/platform/settings/:category
 * - GET /api/admin/settings/meta/:category
 * - GET/POST /api/admin/platform/settings/legacy-import (one-time import of the older stores)
 *
 * History (Configuration Rollback):
 * - GET /api/admin/settings/:category/history - List version history
 * - GET /api/admin/settings/:category/history/:version - Get specific version
 * - POST /api/admin/settings/:category/rollback - Rollback to previous version
 * - GET /api/admin/settings/:category/current - Get current settings
 * - GET /api/admin/settings/:category/compare - Compare two versions
 */

import { Hono, type Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import legacyImportRouter from './legacy-import';
import {
  listSettingsHistory,
  getSettingsVersion,
  rollbackSettings,
  getCurrentSettings,
  compareSettingsVersions,
} from './history';
import {
  type SettingScope,
  type SettingsPatchRequest,
  ConflictError,
  ALL_CATEGORY_META,
  CATEGORY_SCOPE_CONFIG,
  settingsParentScopes,
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
  createAuditLogFromContext,
  // Admin Auth
  type AdminAuthContext,
  ensureDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  getTenantIdFromContext,
  validateLoginUICustomCss,
  bumpAuthenticationMethodsCacheRevision,
  resolveClientTrustPolicy,
  getTenantMetadataContextFromHono,
} from '@authrim/ar-lib-core';
import {
  categoryPatchNeedsState,
  validateCategoryPatch,
  validateCategoryPatchAt,
  validatePlatformUIPatch,
  validateTenantUIPaths,
} from './patch-validation';
import type { JsonObject, JsonValue } from '@authrim/ar-agent-access/core';
import { ensureSupportedTenantId } from '../../single-tenant-guard';
import { agentElevatedExecutionMiddleware } from '../../agent-elevated-execution';
import { identityMappingReferenceProblem } from './identity-mapping-reference';
import { applyTenantSettingsChange } from './tenant-settings-apply';
import { bulkApplyHandler, requireBulkApplyAuthority } from './bulk-apply';
import { bulkApplyIdempotency } from './bulk-apply-idempotency';
import {
  canAccessTenant,
  checkRolePermission,
  hasClientSettingsPermission,
  hasGlobalPlatformSettingsEdit,
  hasTenantSettingsPermission,
  isCategoryAllowedAtScope,
  isCategoryWritableAtScope,
} from './settings-authorization';
import {
  AUTHENTICATION_METHODS_CLIENT_CACHE_CATEGORIES,
  AUTHENTICATION_METHODS_TENANT_CACHE_CATEGORIES,
  errorResponse,
  getSettingsManager,
  invalidateAuthenticationMethodsCacheRevision,
  log,
  parsePatchRequest,
  recordSettingsAuditFailure,
  settingsKVKey,
} from './settings-support';
import {
  findDeprecatedClientConsentSetting,
  validateClientAppLoginPatch,
  validateLoginUIPatch,
  validatePostLoginRelatedPatch,
  validateTenantUIPatch,
} from './settings-validators';

export { canAccessTenant, hasGlobalPlatformSettingsEdit, hasTenantSettingsPermission };
export { getSettingsManager };

function settingValue(body: JsonObject, key: string): JsonValue | undefined {
  const set = body.set;
  return set && typeof set === 'object' && !Array.isArray(set)
    ? (set as JsonObject)[key]
    : undefined;
}

function definedEntries(
  entries: ReadonlyArray<readonly [string, JsonValue | undefined]>
): JsonObject {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as JsonObject;
}

function parsedJsonObject(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value) as JsonValue;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

const AGENT_ELEVATED_SETTINGS = {
  assurance: {
    operation: 'admin.write.assurance.update',
    input: (body: JsonObject) =>
      definedEntries([
        ['resource_version', body.ifMatch],
        ['enabled', settingValue(body, 'assurance.enabled')],
        ['defaultAAL', settingValue(body, 'assurance.default_aal')],
        ['defaultFAL', settingValue(body, 'assurance.default_fal')],
        ['defaultIAL', settingValue(body, 'assurance.default_ial')],
        [
          'scopeAALRequirements',
          parsedJsonObject(settingValue(body, 'assurance.scope_aal_requirements')),
        ],
        [
          'upstreamAcrMappings',
          parsedJsonObject(settingValue(body, 'assurance.upstream_acr_mappings')),
        ],
        [
          'outboundAcrMappings',
          parsedJsonObject(settingValue(body, 'assurance.outbound_acr_mappings')),
        ],
        ['includeInIdToken', settingValue(body, 'assurance.include_in_id_token')],
        ['includeInAccessToken', settingValue(body, 'assurance.include_in_access_token')],
        ['fal2RequiresDPoP', settingValue(body, 'assurance.fal2_requires_dpop')],
        ['fal3RequiresPAR', settingValue(body, 'assurance.fal3_requires_par')],
      ]),
  },
  security: {
    operation: 'admin.write.protocol-security.update',
    input: (body: JsonObject): JsonObject => ({
      resource_version: body.ifMatch,
      fapi: definedEntries([
        ['enabled', settingValue(body, 'security.fapi_enabled')],
        ['strictDPoP', settingValue(body, 'security.fapi_strict_dpop')],
        ['allowPublicClients', settingValue(body, 'security.fapi_allow_public_clients')],
      ]),
    }),
  },
  tokens: {
    operation: 'admin.write.token-exchange.update',
    input: (body: JsonObject) =>
      definedEntries([
        ['resource_version', body.ifMatch],
        ['enabled', settingValue(body, 'tokens.exchange_enabled')],
        ['delegationEnabled', settingValue(body, 'tokens.exchange_delegation_enabled')],
        ['impersonationEnabled', settingValue(body, 'tokens.exchange_impersonation_enabled')],
      ]),
  },
  oauth: {
    operation: 'admin.write.oauth.update',
    input: (body: JsonObject) =>
      definedEntries([
        ['resource_version', body.ifMatch],
        ['accessTokenExpiry', settingValue(body, 'oauth.access_token_expiry')],
        ['idTokenExpiry', settingValue(body, 'oauth.id_token_expiry')],
        ['authCodeTtl', settingValue(body, 'oauth.auth_code_ttl')],
        ['stateRequired', settingValue(body, 'oauth.state_required')],
        ['refreshTokenRotation', settingValue(body, 'oauth.refresh_token_rotation')],
        ['offlineAccessRequired', settingValue(body, 'oauth.offline_access_required')],
      ]),
  },
  session: {
    operation: 'admin.write.session.update',
    input: (body: JsonObject) =>
      definedEntries([
        ['resource_version', body.ifMatch],
        ['defaultTtl', settingValue(body, 'session.default_ttl')],
        ['maxTtl', settingValue(body, 'session.max_ttl')],
        ['refreshDefault', settingValue(body, 'session.refresh_default')],
        ['backchannelLogoutTokenExp', settingValue(body, 'session.backchannel_logout_token_exp')],
        ['backchannelOnFailure', settingValue(body, 'session.backchannel_on_failure')],
      ]),
  },
} as const;

/**
 * The keys each elevated Tool binds. An agent's elevated PATCH may set only these, and may not
 * clear or disable anything: what the approval did not bind is never written.
 */
const AGENT_ELEVATED_SETTING_KEYS: Record<keyof typeof AGENT_ELEVATED_SETTINGS, readonly string[]> =
  {
    assurance: [
      'assurance.enabled',
      'assurance.default_aal',
      'assurance.default_fal',
      'assurance.default_ial',
      'assurance.scope_aal_requirements',
      'assurance.upstream_acr_mappings',
      'assurance.outbound_acr_mappings',
      'assurance.include_in_id_token',
      'assurance.include_in_access_token',
      'assurance.fal2_requires_dpop',
      'assurance.fal3_requires_par',
    ],
    security: [
      'security.fapi_enabled',
      'security.fapi_strict_dpop',
      'security.fapi_allow_public_clients',
    ],
    tokens: [
      'tokens.exchange_enabled',
      'tokens.exchange_delegation_enabled',
      'tokens.exchange_impersonation_enabled',
    ],
    oauth: [
      'oauth.access_token_expiry',
      'oauth.id_token_expiry',
      'oauth.auth_code_ttl',
      'oauth.state_required',
      'oauth.refresh_token_rotation',
      'oauth.offline_access_required',
    ],
    session: [
      'session.default_ttl',
      'session.max_ttl',
      'session.refresh_default',
      'session.backchannel_logout_token_exp',
      'session.backchannel_on_failure',
    ],
  };

/** Whether an elevated PATCH body writes only what the category's Tool binds. */
export function agentElevatedSettingsBodyInScope(category: string, body: unknown): boolean {
  const keys = AGENT_ELEVATED_SETTING_KEYS[category as keyof typeof AGENT_ELEVATED_SETTINGS];
  if (!keys || !body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { set, clear, disable, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).some((field) => field !== 'ifMatch')) return false;
  if (clear !== undefined && !(Array.isArray(clear) && clear.length === 0)) return false;
  if (disable !== undefined && !(Array.isArray(disable) && disable.length === 0)) return false;
  if (set === undefined) return true;
  if (!set || typeof set !== 'object' || Array.isArray(set)) return false;
  return Object.keys(set).every((key) => keys.includes(key));
}

export function buildAgentElevatedSettingsToolInput(
  category: string,
  body: JsonObject
): { operation: string; input: JsonObject } | null {
  const definition = AGENT_ELEVATED_SETTINGS[category as keyof typeof AGENT_ELEVATED_SETTINGS];
  return definition ? { operation: definition.operation, input: definition.input(body) } : null;
}

async function requireAgentSettingsElevation(
  c: Context<{ Bindings: Env }>,
  next: () => Promise<void>
) {
  const adminAuth = c.get('adminAuth' as never) as AdminAuthContext | undefined;
  if (adminAuth?.actorType !== 'agent') return next();
  const category = c.req.param('category') ?? '';
  if (!hasTenantSettingsPermission(adminAuth, category as CategoryName, 'edit')) return next();
  const definition = buildAgentElevatedSettingsToolInput(category, {});
  if (!definition) return next();
  let body: unknown;
  try {
    body = await c.req.raw.clone().json();
  } catch {
    return c.json({ error: 'AGENT_ELEVATION_REQUEST_BODY_INVALID' }, 400);
  }
  if (!agentElevatedSettingsBodyInScope(category, body)) {
    // The approval binds only the Tool's own fields: anything else would be written unapproved.
    return c.json({ error: 'AGENT_ELEVATION_SETTINGS_OUT_OF_SCOPE' }, 400);
  }
  return agentElevatedExecutionMiddleware(
    definition.operation,
    ({ body }) => buildAgentElevatedSettingsToolInput(category, body)!.input
  )(c as never, next);
}

/**
 * Get the tenant ID that owns a client
 * Returns null if client not found
 */
async function getClientTenantId(
  env: Env,
  clientId: string,
  tenantId: string
): Promise<string | null> {
  try {
    // Try to get client metadata from KV
    const clientKey = `client:${tenantId}:${clientId}:metadata`;
    const clientData = (await env.AUTHRIM_CONFIG?.get(clientKey, 'json')) as {
      tenant_id?: string;
    } | null;
    if (clientData?.tenant_id === tenantId) {
      return clientData.tenant_id;
    }

    const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
      env,
      'settings-v2-client-tenant',
      { tenantId }
    );
    const result = await adapter.queryOne<{ tenant_id: string }>(
      'SELECT tenant_id FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
      [tenantId, clientId]
    );
    return result?.tenant_id ?? null;
  } catch {
    log.warn('Failed to get client tenant ID', { clientId, tenantId });
    return null;
  }
}

// Create the settings-v2 app with typed variables
const settingsV2 = new Hono<{
  Bindings: Env;
  Variables: {
    adminAuth?: AdminAuthContext;
  };
}>();

// A settings document that cannot be read answers 503 on every settings route, rather than the
// generic 500 (or values that are not the effective ones).
settingsV2.use('*', async (c, next) => {
  await next();
  if (
    c.error instanceof Error &&
    (c.error.message === 'settings_read_failed' || c.error.message === 'settings_data_invalid')
  ) {
    // A Settings API document that cannot be read: its values in effect are unknown.
    c.res = errorResponse(c, 'temporarily_unavailable', 'Settings cannot be read', 503);
  }
});

// =============================================================================
// Rate Limiting for Settings Endpoints
// =============================================================================

// Tenant settings - lenient for GET, moderate for PATCH
settingsV2.use('/tenants/:tenantId/settings/:category', async (c, next) => {
  const blocked = await ensureSupportedTenantId(c, c.req.param('tenantId')!, 'tenantId');
  if (blocked) {
    return blocked;
  }

  const profile = await getRateLimitProfileAsync(
    c.env,
    c.req.method === 'PATCH' ? 'moderate' : 'lenient'
  );
  return rateLimitMiddleware({
    ...profile,
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
  })(c as unknown as RateLimitContext, next);
});

// Platform settings - lenient
settingsV2.use('/platform/settings/:category', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
  })(c as unknown as RateLimitContext, next);
});

// Meta endpoints - lenient
settingsV2.use('/settings/meta', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/meta/:category', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
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
  const tenantId = c.req.param('tenantId')!;
  const category = c.req.param('category')! as CategoryName;

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
  if (!hasTenantSettingsPermission(adminAuth, category, 'view')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to view tenant settings', 403);
  }

  // Security Check 4: Validate user can access this specific tenant
  if (!canAccessTenant(adminAuth, tenantId)) {
    return errorResponse(c, 'forbidden', 'Cannot access settings for this tenant', 403);
  }

  const manager = getSettingsManager(c.env, c, true, true);
  const scope: SettingScope = { type: 'tenant', id: tenantId };

  try {
    const result = await manager.getAll(category, scope, {
      parents: settingsParentScopes(category, scope),
    });
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
settingsV2.patch(
  '/tenants/:tenantId/settings/:category',
  requireAgentSettingsElevation,
  async (c) =>
    applyTenantSettingsChange({
      c,
      adminAuth: c.get('adminAuth'),
      tenantId: c.req.param('tenantId')!,
      category: c.req.param('category')! as CategoryName,
      readBody: () => c.req.json(),
    })
);

// =============================================================================
// Client Settings Routes
// =============================================================================

/**
 * GET /api/admin/clients/:clientId/settings
 * Get all settings for a client (default 'client' category)
 */
settingsV2.get('/clients/:clientId/settings', async (c) => {
  const clientId = c.req.param('clientId')!;
  const category: CategoryName = 'client';

  // Security Check 1: Validate user has permission for client settings
  const adminAuth = c.get('adminAuth');
  if (!hasClientSettingsPermission(adminAuth, category, 'view')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to view client settings', 403);
  }

  // Security Check 2: Get client's tenant and verify access
  const requestedTenantId = getTenantIdFromContext(c);
  const clientTenantId = await getClientTenantId(c.env, clientId, requestedTenantId);
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

  const manager = getSettingsManager(c.env, c, true, true);
  const scope = { type: 'client', id: clientId, tenantId: clientTenantId } as SettingScope;

  try {
    // Client settings are stored under a single category
    const result = await manager.getAll('client', scope, {
      parents: settingsParentScopes('client', scope),
    });
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
  const clientId = c.req.param('clientId')!;
  const category = c.req.param('category')! as CategoryName;

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
  if (!hasClientSettingsPermission(adminAuth, category, 'view')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to view client settings', 403);
  }

  // Security Check 4: Get client's tenant and verify access
  const requestedTenantId = getTenantIdFromContext(c);
  const clientTenantId = await getClientTenantId(c.env, clientId, requestedTenantId);
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

  const manager = getSettingsManager(c.env, c, true, true);
  const scope = { type: 'client', id: clientId, tenantId: clientTenantId } as SettingScope;

  try {
    const result = await manager.getAll(category, scope, {
      parents: settingsParentScopes(category, scope),
    });
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
  const clientId = c.req.param('clientId')!;
  const category: CategoryName = 'client';

  // Security Check 1: Validate user has EDIT permission for client settings
  const adminAuth = c.get('adminAuth');
  if (!hasClientSettingsPermission(adminAuth, category, 'edit')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to edit client settings', 403);
  }

  // Security Check 2: Get client's tenant and verify access
  const requestedTenantId = getTenantIdFromContext(c);
  const clientTenantId = await getClientTenantId(c.env, clientId, requestedTenantId);
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

  return runTenantBackupCoveredMutation({
    env: c.env,
    tenantId: clientTenantId,
    run: async () => {
      const manager = getSettingsManager(c.env, c, true);
      const scope = { type: 'client', id: clientId, tenantId: clientTenantId } as SettingScope;

      try {
        // Parse and sanitize request body (prevent prototype pollution)
        const rawBody = await c.req.json();
        const body = parsePatchRequest(rawBody);

        if (!body.ifMatch) {
          await recordSettingsAuditFailure(c, { category, scope, reason: 'if_match_required' });
          return errorResponse(c, 'bad_request', 'ifMatch is required for PATCH operations', 400);
        }

        const deprecatedConsentSetting = findDeprecatedClientConsentSetting(body);
        if (deprecatedConsentSetting) {
          await recordSettingsAuditFailure(c, {
            category,
            scope,
            reason: 'deprecated_client_consent_setting',
          });
          return errorResponse(
            c,
            'bad_request',
            `${deprecatedConsentSetting} is no longer supported; use Client Trust Policy`,
            400
          );
        }

        const appLoginValidation = await validateClientAppLoginPatch(
          c.env,
          clientTenantId,
          clientId,
          body
        );
        if (!appLoginValidation.ok) {
          await recordSettingsAuditFailure(c, {
            category,
            scope,
            reason: 'app_login_validation_failed',
            metadata: appLoginValidation.details,
          });
          return errorResponse(
            c,
            appLoginValidation.error,
            appLoginValidation.message,
            appLoginValidation.status,
            appLoginValidation.details
          );
        }

        const actor = adminAuth?.userId ?? 'unknown';
        const result = await manager.patch('client', scope, body, actor, {
          parents: settingsParentScopes('client', scope),
        });

        const hasRejections = Object.keys(result.rejected).length > 0;
        const hasApplied =
          result.applied.length > 0 || result.cleared.length > 0 || result.disabled.length > 0;

        if (!hasApplied && hasRejections) {
          await recordSettingsAuditFailure(c, {
            category,
            scope,
            reason: 'validation_failed',
            metadata: { rejected: result.rejected },
          });
          return c.json(
            {
              error: 'validation_failed',
              message: 'All changes were rejected',
              ...result,
            },
            400
          );
        }

        if (hasApplied && AUTHENTICATION_METHODS_CLIENT_CACHE_CATEGORIES.has(category)) {
          await invalidateAuthenticationMethodsCacheRevision(
            c,
            clientTenantId,
            `client:${category}`
          );
        }

        return c.json(result);
      } catch (error) {
        // Handle JSON parse errors
        if (error instanceof SyntaxError) {
          await recordSettingsAuditFailure(c, { category, scope, reason: 'invalid_json' });
          return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
        }
        if (error instanceof ConflictError) {
          await recordSettingsAuditFailure(c, {
            category,
            scope,
            reason: 'version_conflict',
            metadata: { current_version: error.currentVersion },
          });
          return c.json(
            {
              error: 'conflict',
              message: error.message,
              currentVersion: error.currentVersion,
            },
            409
          );
        }
        await recordSettingsAuditFailure(c, {
          category,
          scope,
          reason: 'unhandled_error',
          metadata: { error_class: error instanceof Error ? error.name : 'unknown_error' },
        });
        throw error;
      }
    },
  });
});

/**
 * PATCH /api/admin/clients/:clientId/settings/:category
 * Partial update category-specific settings for a client
 */
settingsV2.patch('/clients/:clientId/settings/:category', async (c) => {
  const clientId = c.req.param('clientId')!;
  const category = c.req.param('category')! as CategoryName;

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
  if (!hasClientSettingsPermission(adminAuth, category, 'edit')) {
    return errorResponse(c, 'forbidden', 'Insufficient permissions to edit client settings', 403);
  }

  // Security Check 4: Get client's tenant and verify access
  const requestedTenantId = getTenantIdFromContext(c);
  const clientTenantId = await getClientTenantId(c.env, clientId, requestedTenantId);
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

  return runTenantBackupCoveredMutation({
    env: c.env,
    tenantId: clientTenantId,
    run: async () => {
      const manager = getSettingsManager(c.env, c, true);
      const scope = { type: 'client', id: clientId, tenantId: clientTenantId } as SettingScope;

      try {
        const rawBody = await c.req.json();
        const body = parsePatchRequest(rawBody);

        if (!body.ifMatch) {
          await recordSettingsAuditFailure(c, { category, scope, reason: 'if_match_required' });
          return errorResponse(c, 'bad_request', 'ifMatch is required for PATCH operations', 400);
        }

        if (category === 'client') {
          const deprecatedConsentSetting = findDeprecatedClientConsentSetting(body);
          if (deprecatedConsentSetting) {
            await recordSettingsAuditFailure(c, {
              category,
              scope,
              reason: 'deprecated_client_consent_setting',
            });
            return errorResponse(
              c,
              'bad_request',
              `${deprecatedConsentSetting} is no longer supported; use Client Trust Policy`,
              400
            );
          }
        }

        if (category === 'login-ui') {
          const loginUiValidation = validateLoginUIPatch(body);
          if (!loginUiValidation.ok) {
            await recordSettingsAuditFailure(c, {
              category,
              scope,
              reason: 'login_ui_validation_failed',
              metadata: loginUiValidation.details,
            });
            return errorResponse(
              c,
              'validation_failed',
              loginUiValidation.message ?? 'Login UI settings are invalid',
              400,
              loginUiValidation.details
            );
          }
        }

        // The device flow bounds are checked on the document the save leaves, like the tenant's:
        // what the client does not set is what it inherits from its tenant.
        const patchState = categoryPatchNeedsState(category)
          ? await manager.getAll(category, scope, {
              parents: settingsParentScopes(category, scope),
            })
          : null;
        const categoryError = validateCategoryPatchAt(
          category,
          'client',
          body,
          patchState && { current: patchState.values, inherited: patchState.inherited.values }
        );
        if (categoryError) {
          await recordSettingsAuditFailure(c, {
            category,
            scope,
            reason: `${category.replace('-', '_')}_validation_failed`,
          });
          return errorResponse(c, 'validation_failed', categoryError, 400);
        }

        if (category === 'client') {
          const appLoginValidation = await validateClientAppLoginPatch(
            c.env,
            clientTenantId,
            clientId,
            body
          );
          if (!appLoginValidation.ok) {
            await recordSettingsAuditFailure(c, {
              category,
              scope,
              reason: 'app_login_validation_failed',
              metadata: appLoginValidation.details,
            });
            return errorResponse(
              c,
              appLoginValidation.error,
              appLoginValidation.message,
              appLoginValidation.status,
              appLoginValidation.details
            );
          }
        }

        const actor = adminAuth?.userId ?? 'unknown';
        const result = await manager.patch(category, scope, body, actor, {
          parents: settingsParentScopes(category, scope),
        });

        const hasRejections = Object.keys(result.rejected).length > 0;
        const hasApplied =
          result.applied.length > 0 || result.cleared.length > 0 || result.disabled.length > 0;

        if (!hasApplied && hasRejections) {
          await recordSettingsAuditFailure(c, {
            category,
            scope,
            reason: 'validation_failed',
            metadata: { rejected: result.rejected },
          });
          return c.json(
            {
              error: 'validation_failed',
              message: 'All changes were rejected',
              ...result,
            },
            400
          );
        }

        if (hasApplied && AUTHENTICATION_METHODS_CLIENT_CACHE_CATEGORIES.has(category)) {
          await invalidateAuthenticationMethodsCacheRevision(
            c,
            clientTenantId,
            `client:${category}`
          );
        }

        return c.json(result);
      } catch (error) {
        if (error instanceof SyntaxError) {
          await recordSettingsAuditFailure(c, { category, scope, reason: 'invalid_json' });
          return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
        }
        if (error instanceof ConflictError) {
          await recordSettingsAuditFailure(c, {
            category,
            scope,
            reason: 'version_conflict',
            metadata: { current_version: error.currentVersion },
          });
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
          await recordSettingsAuditFailure(c, { category, scope, reason: 'unknown_category' });
          return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
        }
        await recordSettingsAuditFailure(c, {
          category,
          scope,
          reason: 'unhandled_error',
          metadata: { error_class: error instanceof Error ? error.name : 'unknown_error' },
        });
        throw error;
      }
    },
  });
});

// =============================================================================
// Platform Settings Routes (Read-Only)
// =============================================================================

// The one-time import of the older stores (before the category routes, which would take its
// path for a category).
settingsV2.route('/', legacyImportRouter);

/**
 * GET /api/admin/platform/settings/:category
 * Get platform settings
 */
settingsV2.get('/platform/settings/:category', async (c) => {
  const category = c.req.param('category')! as CategoryName;

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

  const manager = getSettingsManager(c.env, c, true, true);
  const scope: SettingScope = { type: 'platform' };

  try {
    const result = await manager.getAll(category, scope, {
      parents: settingsParentScopes(category, scope),
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unknown category')) {
      return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
    }
    throw error;
  }
});

/**
 * PATCH /api/admin/platform/settings/:category
 * Partial update settings for a platform category
 */
settingsV2.patch('/platform/settings/:category', (c) => {
  return (async () => {
    const category = c.req.param('category')! as CategoryName;

    if (!ALL_CATEGORY_META[category]) {
      return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
    }

    if (!isCategoryAllowedAtScope(category, 'platform')) {
      return errorResponse(
        c,
        'bad_request',
        `Category "${category}" is not available at platform scope`,
        400
      );
    }

    if (!isCategoryWritableAtScope(category, 'platform')) {
      return errorResponse(c, 'method_not_allowed', 'Platform settings are read-only', 405);
    }

    const adminAuth = c.get('adminAuth');

    // A platform setting reaches every tenant, so the role has to come from a global assignment:
    // `roles` also holds what is given for one tenant only (an Admin of one tenant who is a
    // super_admin there must not change what every other tenant inherits).
    if (!hasGlobalPlatformSettingsEdit(adminAuth, category)) {
      return errorResponse(
        c,
        'forbidden',
        'Insufficient permissions to edit platform settings',
        403
      );
    }

    return runTenantBackupCoveredMutation({
      env: c.env,
      scope: 'environment',
      run: async () => {
        const manager = getSettingsManager(c.env, c, true);
        const scope: SettingScope = { type: 'platform' };

        try {
          const rawBody = await c.req.json();
          const body = parsePatchRequest(rawBody);

          if (!body.ifMatch) {
            await recordSettingsAuditFailure(c, { category, scope, reason: 'if_match_required' });
            return errorResponse(c, 'bad_request', 'ifMatch is required for PATCH operations', 400);
          }

          if (category === 'login-ui') {
            const loginUiValidation = validateLoginUIPatch(body);
            if (!loginUiValidation.ok) {
              await recordSettingsAuditFailure(c, {
                category,
                scope,
                reason: 'login_ui_validation_failed',
                metadata: loginUiValidation.details,
              });
              return errorResponse(
                c,
                'validation_failed',
                loginUiValidation.message ?? 'Login UI settings are invalid',
                400,
                loginUiValidation.details
              );
            }
          }

          const platformError =
            category === 'tenant'
              ? (validatePlatformUIPatch(body, c.env) ??
                validateCategoryPatch(category, body, 'platform'))
              : validateCategoryPatch(category, body, 'platform');
          if (platformError) {
            await recordSettingsAuditFailure(c, {
              category,
              scope,
              reason: `${category}_validation_failed`,
            });
            return errorResponse(c, 'validation_failed', platformError, 400);
          }

          // The Mapping Set a default names must exist and be usable by every tenant (checked in
          // the Admin database, which the form checks above do not reach).
          if (category === 'identity-mapping') {
            const mappingProblem = await identityMappingReferenceProblem(c.env, body, scope);
            if (mappingProblem) {
              await recordSettingsAuditFailure(c, {
                category,
                scope,
                reason: mappingProblem.reason,
              });
              return mappingProblem.status === 503
                ? errorResponse(c, 'temporarily_unavailable', mappingProblem.message, 503)
                : errorResponse(c, 'validation_failed', mappingProblem.message, 400);
            }
          }

          const actor = adminAuth?.userId ?? 'unknown';
          const result = await manager.patch(category, scope, body, actor, {
            parents: settingsParentScopes(category, scope),
          });
          const hasRejections = Object.keys(result.rejected).length > 0;
          const hasApplied =
            result.applied.length > 0 || result.cleared.length > 0 || result.disabled.length > 0;

          if (!hasApplied && hasRejections) {
            await recordSettingsAuditFailure(c, {
              category,
              scope,
              reason: 'validation_failed',
              metadata: { rejected: result.rejected },
            });
            return c.json(
              {
                error: 'validation_failed',
                message: 'All changes were rejected',
                ...result,
              },
              400
            );
          }

          if (hasApplied && AUTHENTICATION_METHODS_TENANT_CACHE_CATEGORIES.has(category)) {
            await invalidateAuthenticationMethodsCacheRevision(c, null, `platform:${category}`);
          }

          return c.json(result);
        } catch (error) {
          if (error instanceof SyntaxError) {
            await recordSettingsAuditFailure(c, { category, scope, reason: 'invalid_json' });
            return errorResponse(c, 'bad_request', 'Invalid JSON body', 400);
          }
          if (error instanceof ConflictError) {
            await recordSettingsAuditFailure(c, {
              category,
              scope,
              reason: 'version_conflict',
              metadata: { current_version: error.currentVersion },
            });
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
            await recordSettingsAuditFailure(c, { category, scope, reason: 'unknown_category' });
            return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
          }
          await recordSettingsAuditFailure(c, {
            category,
            scope,
            reason: 'unhandled_error',
            metadata: { error_class: error instanceof Error ? error.name : 'unknown_error' },
          });
          throw error;
        }
      },
    });
  })();
});

/**
 * PUT/DELETE /api/admin/platform/settings/:category
 * Not supported
 */
settingsV2.put('/platform/settings/:category', (c) => {
  return errorResponse(c, 'method_not_allowed', 'Platform settings do not support PUT', 405);
});

settingsV2.delete('/platform/settings/:category', (c) => {
  return errorResponse(c, 'method_not_allowed', 'Platform settings do not support DELETE', 405);
});

// =============================================================================
// Meta API Routes
// =============================================================================

/**
 * GET /api/admin/settings/meta/:category
 * Get settings metadata for a category
 */
settingsV2.get('/settings/meta/:category', async (c) => {
  const category = c.req.param('category')!;

  const manager = getSettingsManager(c.env, c);
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
  const category = c.req.param('category')! as CategoryName;

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
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/:category/history/:version', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/:category/rollback', async (c, next) => {
  // Rollback is a sensitive operation that modifies system state
  // Use moderate profile for stricter rate limiting
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/:category/current', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
  })(c as unknown as RateLimitContext, next);
});

settingsV2.use('/settings/:category/compare', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'lenient');
  return rateLimitMiddleware({
    ...profile,
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

// =============================================================================
// Bulk apply (the same settings for several tenants)
// =============================================================================

/**
 * POST /api/admin/settings/bulk-apply
 * Preview, or apply, the same settings to several tenants. Platform authority only (checked
 * first, so a refused caller leaves no idempotency record), a strict rate limit, and a required
 * Idempotency-Key: a repeat of the same request answers with the stored result, and the same key
 * with another body is a conflict.
 */
settingsV2.post(
  '/settings/bulk-apply',
  requireBulkApplyAuthority,
  async (c, next) => {
    const profile = await getRateLimitProfileAsync(c.env, 'strict');
    return rateLimitMiddleware({
      ...profile,
      endpoints: ['/api/admin/settings/bulk-apply'],
    })(c as unknown as RateLimitContext, next);
  },
  bulkApplyIdempotency,
  bulkApplyHandler
);

export default settingsV2;

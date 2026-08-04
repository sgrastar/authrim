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
 * - GET/PATCH /api/admin/platform/settings/:category
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
  createAuditLogFromContext,
  // Admin Auth
  type AdminAuthContext,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  ensureDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  getTenantIdFromContext,
  parseTrustedRedirectOrigins,
  validateAccountPagePath,
  validatePostLoginRedirectUrl,
  validateLoginUICustomCss,
  validateTrustedRedirectOrigins,
  bumpAuthenticationMethodsCacheRevision,
  resolveClientTrustPolicy,
} from '@authrim/ar-lib-core';
import type { JsonObject, JsonValue } from '@authrim/ar-agent-access/core';
import { ensureSupportedTenantId } from '../../single-tenant-guard';
import { agentElevatedExecutionMiddleware } from '../../agent-elevated-execution';
import { BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS } from '../../human-verification-provider-projection';
import { markGlobalProviderDesiredRevision } from '../../provider-reprojection-jobs';

// Module-level logger for settings audit
const log = createLogger().module('SETTINGS_AUDIT');
const AUTHENTICATION_METHODS_TENANT_CACHE_CATEGORIES = new Set<CategoryName>([
  'authentication-methods',
  'login-ui',
  'self-service',
]);
const AUTHENTICATION_METHODS_CLIENT_CACHE_CATEGORIES = new Set<CategoryName>(['login-ui']);
const DEFAULT_HUMAN_VERIFICATION_PROVIDER = 'human-verification-cloudflare-turnstile';
const HUMAN_VERIFICATION_SETTING_PREFIX = 'authentication-methods.human_verification.';

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
        ['jarmEnabled', settingValue(body, 'oauth.jarm_enabled')],
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
  return agentElevatedExecutionMiddleware(
    definition.operation,
    ({ body }) => buildAgentElevatedSettingsToolInput(category, body)!.input
  )(c as never, next);
}

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

function hasTenantSettingsPermission(
  adminAuth: AdminAuthContext | undefined,
  category: CategoryName,
  action: 'view' | 'edit'
): boolean {
  if (!adminAuth) return false;
  if (
    adminAuth.actorType === 'agent' ||
    adminAuth.actorType === 'machine' ||
    adminAuth.authMethod === 'machine_access_token'
  ) {
    const granularEditPermission: Partial<Record<CategoryName, string>> = {
      assurance: ADMIN_PERMISSIONS.SETTINGS_ASSURANCE_UPDATE,
      security: ADMIN_PERMISSIONS.SETTINGS_SECURITY_UPDATE,
      tokens: ADMIN_PERMISSIONS.SETTINGS_TOKEN_EXCHANGE_UPDATE,
      oauth: ADMIN_PERMISSIONS.SETTINGS_OAUTH_UPDATE,
      session: ADMIN_PERMISSIONS.SETTINGS_SESSION_UPDATE,
      'login-ui': ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE,
    };
    const required =
      action === 'edit'
        ? (granularEditPermission[category] ?? ADMIN_PERMISSIONS.SETTINGS_WRITE)
        : ADMIN_PERMISSIONS.SETTINGS_READ;
    return hasAdminPermission(adminAuth.permissions ?? [], required);
  }
  return checkRolePermission(adminAuth.roles, category, 'tenant', action);
}

function hasClientSettingsPermission(
  adminAuth: AdminAuthContext | undefined,
  category: CategoryName,
  action: 'view' | 'edit'
): boolean {
  if (!adminAuth) return false;
  if (
    adminAuth.actorType === 'agent' ||
    adminAuth.actorType === 'machine' ||
    adminAuth.authMethod === 'machine_access_token'
  ) {
    const required =
      action === 'edit' ? ADMIN_PERMISSIONS.SETTINGS_WRITE : ADMIN_PERMISSIONS.SETTINGS_READ;
    return hasAdminPermission(adminAuth.permissions ?? [], required);
  }
  return checkRolePermission(adminAuth.roles, category, 'client', action);
}

/**
 * Check if a category is available at a given scope level
 */
function isCategoryAllowedAtScope(category: CategoryName, scopeLevel: SettingScopeLevel): boolean {
  const scopeConfig = CATEGORY_SCOPE_CONFIG[category];
  return scopeConfig?.allowedScopes.includes(scopeLevel) ?? false;
}

function isCategoryWritableAtScope(category: CategoryName, scopeLevel: SettingScopeLevel): boolean {
  const scopedMeta = getScopedCategoryMeta(category);
  return scopedMeta.scopePermissions[scopeLevel].editRoles.length > 0;
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

/**
 * Check if user can access a specific tenant's data
 * super_admin, system_admin and distributor_admin can access any tenant
 * org_admin can only access their own tenant
 */
function canAccessTenant(adminAuth: AdminAuthContext | undefined, tenantId: string): boolean {
  if (!adminAuth) return false;

  if (adminAuth.actorType === 'agent') {
    return adminAuth.tenantId === tenantId && adminAuth.tenantScope?.includes(tenantId) === true;
  }

  if (adminAuth.actorType === 'machine' || adminAuth.authMethod === 'machine_access_token') {
    return (
      adminAuth.tenantId === tenantId &&
      (adminAuth.tenantScope?.includes(tenantId) === true ||
        adminAuth.tenantScope?.includes('*') === true)
    );
  }

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

function validateLoginUIPatch(body: SettingsPatchRequest): {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
} {
  const supportedLoginUILocales = [
    'en',
    'ja',
    'zh-CN',
    'zh-TW',
    'es',
    'pt',
    'fr',
    'de',
    'ko',
    'ru',
    'id',
    'ar',
    'it',
    'th',
    'vi',
  ];
  const supportedLocales = body.set?.['login-ui.supported_locales'];
  const defaultLocale = body.set?.['login-ui.default_locale'];
  let parsedSupportedLocales: string[] | undefined;

  if (supportedLocales !== undefined) {
    if (typeof supportedLocales !== 'string') {
      return { ok: false, message: 'login-ui.supported_locales must be a comma-separated string' };
    }
    parsedSupportedLocales = supportedLocales
      .split(',')
      .map((locale) => locale.trim())
      .filter(Boolean);
    if (
      parsedSupportedLocales.length === 0 ||
      new Set(parsedSupportedLocales).size !== parsedSupportedLocales.length ||
      parsedSupportedLocales.some((locale) => !supportedLoginUILocales.includes(locale))
    ) {
      return {
        ok: false,
        message: 'login-ui.supported_locales must contain one or more unique supported locales',
      };
    }
  }

  if (
    defaultLocale !== undefined &&
    (typeof defaultLocale !== 'string' || !supportedLoginUILocales.includes(defaultLocale))
  ) {
    return { ok: false, message: 'login-ui.default_locale must be a supported locale' };
  }
  if (
    typeof defaultLocale === 'string' &&
    parsedSupportedLocales &&
    !parsedSupportedLocales.includes(defaultLocale)
  ) {
    return { ok: false, message: 'login-ui.default_locale must be enabled in supported_locales' };
  }

  const customCss = body.set?.['login-ui.custom_css'];
  if (customCss !== undefined) {
    const validation = validateLoginUICustomCss(customCss);
    if (!validation.valid) {
      return {
        ok: false,
        message: validation.errors.join(' '),
        details: { errors: validation.errors },
      };
    }
    body.set!['login-ui.custom_css'] = validation.sanitizedCss ?? '';
  }

  const accountPages = body.set?.['login-ui.account_pages'];
  if (accountPages !== undefined) {
    if (typeof accountPages !== 'string' || accountPages.length > 2_000_000) {
      return { ok: false, message: 'login-ui.account_pages must be a JSON string under 2 MB' };
    }
    try {
      const document = JSON.parse(accountPages) as Record<string, unknown>;
      if (
        document.schema_version !== 'authrim.account_pages.v1' ||
        !Array.isArray(document.pages)
      ) {
        throw new Error('Invalid account pages schema');
      }
      if (document.pages.length > 24) throw new Error('At most 24 account pages are allowed');
      const pageIds = new Set<string>();
      for (const rawPage of document.pages) {
        if (!rawPage || typeof rawPage !== 'object' || Array.isArray(rawPage))
          throw new Error('Invalid account page');
        const page = rawPage as Record<string, unknown>;
        if (
          typeof page.id !== 'string' ||
          !/^[a-z0-9_-]{1,96}$/u.test(page.id) ||
          pageIds.has(page.id)
        ) {
          throw new Error('Account page IDs must be unique safe identifiers');
        }
        if (typeof page.name !== 'string' || !page.name.trim() || page.name.length > 80) {
          throw new Error('Account page names must contain 1 to 80 characters');
        }
        if (
          page.base_preset_id !== 'authrim-default' ||
          typeof page.base_preset_version !== 'number' ||
          !Number.isInteger(page.base_preset_version) ||
          page.base_preset_version < 1
        ) {
          throw new Error('Invalid account page base preset');
        }
        if (
          typeof page.published_version !== 'number' ||
          !Number.isInteger(page.published_version) ||
          page.published_version < 0 ||
          typeof page.published_at !== 'string'
        ) {
          throw new Error('Invalid account page publication metadata');
        }
        pageIds.add(page.id);
        for (const rawDefinition of [page.draft, page.published, page.rollback].filter(Boolean)) {
          if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition))
            throw new Error('Invalid account page definition');
          const definition = rawDefinition as Record<string, unknown>;
          if (!Array.isArray(definition.screens) || definition.screens.length > 32)
            throw new Error('An account page may contain at most 32 screens');
          const placementIds = new Set<string>();
          const screenKeys = new Set<string>();
          const snapshots = definition.screen_snapshots;
          const stableTargets = new Set(
            definition.screens
              .filter(
                (placement) =>
                  Boolean(placement) &&
                  typeof placement === 'object' &&
                  !Array.isArray(placement) &&
                  (placement as Record<string, unknown>).enabled !== false &&
                  ((placement as Record<string, unknown>).condition === undefined ||
                    (placement as Record<string, unknown>).condition === 'always')
              )
              .map((placement) => String((placement as Record<string, unknown>).id))
          );
          for (const rawPlacement of definition.screens) {
            if (!rawPlacement || typeof rawPlacement !== 'object' || Array.isArray(rawPlacement))
              throw new Error('Invalid screen placement');
            const placement = rawPlacement as Record<string, unknown>;
            if (
              typeof placement.id !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,96}$/u.test(placement.id) ||
              placementIds.has(placement.id)
            )
              throw new Error('Placement IDs must be unique');
            if (
              typeof placement.screen_key !== 'string' ||
              !/^[a-z0-9_-]{1,96}$/u.test(placement.screen_key) ||
              screenKeys.has(placement.screen_key)
            )
              throw new Error('Screen keys must be unique safe identifiers');
            placementIds.add(placement.id);
            screenKeys.add(placement.screen_key);
            if (
              placement.condition !== undefined &&
              ![
                'always',
                'hidden',
                'passkey_enabled',
                'totp_enabled',
                'external_idp_enabled',
                'consent_records_available',
                'multiple_sessions',
              ].includes(String(placement.condition))
            ) {
              throw new Error('Invalid account page visibility condition');
            }
            if (placement.enabled !== false && snapshots !== undefined) {
              if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots))
                throw new Error('Published definitions require screen snapshots');
              const snapshot = (snapshots as Record<string, unknown>)[placement.screen_key];
              if (
                !snapshot ||
                typeof snapshot !== 'object' ||
                Array.isArray(snapshot) ||
                (snapshot as Record<string, unknown>).screen_kind !== 'account'
              )
                throw new Error(`Missing account screen snapshot for ${placement.screen_key}`);
              const fields = (snapshot as Record<string, unknown>).fields;
              if (!Array.isArray(fields)) throw new Error('Invalid account screen fields');
              for (const rawField of fields) {
                if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) continue;
                const field = rawField as Record<string, unknown>;
                if (
                  ![
                    'layout_row',
                    'heading',
                    'text',
                    'link',
                    'divider',
                    'account_profile_widget',
                    'account_device_list_widget',
                    'account_session_widget',
                    'account_passkey_widget',
                    'account_totp_widget',
                    'account_consent_widget',
                    'account_activity_widget',
                    'account_social_account_widget',
                  ].includes(String(field.block_type))
                ) {
                  throw new Error('Account screen snapshots contain an unsupported block type');
                }
                if (field.block_type !== 'link') continue;
                if (typeof field.href !== 'string' || field.href.length > 2048) {
                  throw new Error('Account screen links require a safe URL');
                }
                const href = field.href.trim();
                let safe = /^#[a-zA-Z][\w-]*$/u.test(href) || /^\/(?!\/)/u.test(href);
                if (!safe) {
                  try {
                    safe = new URL(href).protocol === 'https:';
                  } catch {
                    safe = false;
                  }
                }
                if (!safe)
                  throw new Error(
                    'Account screen links only allow anchors, relative paths, or HTTPS'
                  );
                if (href.startsWith('#') && !stableTargets.has(href.slice(1))) {
                  throw new Error(
                    'Account screen anchor links must target an always-visible placement'
                  );
                }
              }
              const widgetCount = fields.filter(
                (field) =>
                  Boolean(field) &&
                  typeof field === 'object' &&
                  typeof (field as Record<string, unknown>).block_type === 'string' &&
                  String((field as Record<string, unknown>).block_type).startsWith('account_')
              ).length;
              if (widgetCount > 1)
                throw new Error('Account screens may contain at most one primary widget');
            }
          }
        }
      }
      if (
        document.default_page_id !== null &&
        (typeof document.default_page_id !== 'string' || !pageIds.has(document.default_page_id))
      )
        throw new Error('The default account page must reference an existing page');
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Invalid account pages JSON',
      };
    }
  }

  return { ok: true };
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
function getSettingsManager(
  env: Env,
  auditContext?: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>
): SettingsManager {
  const manager = createSettingsManager({
    env: env as unknown as Record<string, string | undefined>,
    kv: env.SETTINGS ?? null,
    cacheTTL: 5000, // 5 seconds (as per plan)
    auditCallback: async (event) => {
      log.info('Settings change', {
        action: event.event,
        scope: event.scope,
        scopeId: event.scopeId,
        category: event.category,
        actor: event.actor,
        diff: event.diff,
      });
      if (auditContext) {
        try {
          await createAuditLogFromContext(
            auditContext as unknown as Parameters<typeof createAuditLogFromContext>[0],
            `settings.${event.event}`,
            'settings',
            `${event.scope}:${event.scopeId}:${event.category}`,
            {
              scope: event.scope,
              scope_id: event.scopeId,
              category: event.category,
              actor: event.actor,
              diff: sanitizeObject(event.diff),
            }
          );
        } catch {
          log.warn('Failed to mirror settings update audit', {
            category: event.category,
            scope: event.scope,
            scopeId: event.scopeId,
          });
        }
      }
    },
  });

  // Register all known categories
  for (const [, categoryMeta] of Object.entries(ALL_CATEGORY_META)) {
    manager.registerCategory(categoryMeta);
  }

  return manager;
}

async function recordSettingsAuditFailure(
  c: Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }, string>,
  input: {
    category: CategoryName;
    scope: SettingScope;
    reason: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const scopeId =
    'id' in input.scope && typeof input.scope.id === 'string' ? input.scope.id : 'platform';
  try {
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'settings.patch.failure',
      'settings',
      `${input.scope.type}:${scopeId}:${input.category}`,
      {
        scope: input.scope.type,
        scope_id: scopeId,
        category: input.category,
        result: 'failure',
        reason: input.reason,
        ...(input.metadata ? sanitizeObject(input.metadata) : {}),
      },
      'warning'
    );
  } catch {
    log.warn('Failed to mirror settings failure audit', {
      category: input.category,
      scope: input.scope.type,
      reason: input.reason,
    });
  }
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

function settingsKVKey(category: string, scope: SettingScope): string {
  if (scope.type === 'platform') {
    return `settings:platform:${category}`;
  }
  if (scope.type === 'client') {
    return `settings:client:${scope.tenantId}:${scope.id}:${category}`;
  }
  return `settings:${scope.type}:${scope.id}:${category}`;
}

async function invalidateAuthenticationMethodsCacheRevision(
  c: { env: Env },
  tenantId: string | null,
  reason: string
): Promise<void> {
  try {
    await bumpAuthenticationMethodsCacheRevision(c.env, tenantId);
  } catch (error) {
    log.warn('Failed to bump authentication methods cache revision', {
      tenantId: tenantId ?? 'global',
      reason,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

async function readScopedSettingsRecord(
  env: Env,
  category: string,
  scope: SettingScope
): Promise<Record<string, unknown>> {
  try {
    const raw = await env.SETTINGS?.get(settingsKVKey(category, scope));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function selectedHumanVerificationProvider(settings: Record<string, unknown>): string {
  const value = settings[`${HUMAN_VERIFICATION_SETTING_PREFIX}provider`];
  return typeof value === 'string' && BUILTIN_HUMAN_VERIFICATION_PROVIDER_IDS.has(value)
    ? value
    : DEFAULT_HUMAN_VERIFICATION_PROVIDER;
}

async function scheduleInheritedHumanVerificationProjection(
  env: Env,
  tenantId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Promise<void> {
  if (!env.SETTINGS) return;
  const providers = new Set([
    selectedHumanVerificationProvider(before),
    selectedHumanVerificationProvider(after),
  ]);
  for (const pluginId of providers) {
    const override = await env.SETTINGS.get(`plugins:config:${pluginId}:tenant:${tenantId}`);
    if (override === null) {
      await markGlobalProviderDesiredRevision(env, pluginId);
    }
  }
}

async function ensureTenantAccountPageEnabled(env: Env, tenantId: string): Promise<void> {
  if (!env.SETTINGS) {
    return;
  }
  const scope: SettingScope = { type: 'tenant', id: tenantId };
  const current = await readScopedSettingsRecord(env, 'self-service', scope);
  if (current['self-service.account_page_enabled'] === true) {
    return;
  }
  await env.SETTINGS.put(
    settingsKVKey('self-service', scope),
    JSON.stringify({
      ...current,
      'self-service.account_page_enabled': true,
      'self-service.account_page_path':
        typeof current['self-service.account_page_path'] === 'string'
          ? current['self-service.account_page_path']
          : '/account',
    })
  );
}

function parseStringArraySetting(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function validateAppLoginScope(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const scope = value.trim();
  return (
    scope.length > 0 &&
    scope.length <= 512 &&
    scope.split(/\s+/).every((part) => /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(part)) &&
    scope.split(/\s+/).includes('openid')
  );
}

async function getAppLoginClientProfile(
  env: Env,
  tenantId: string,
  clientId: string
): Promise<{
  clientId: string;
  redirectUris: string[];
  firstParty: boolean;
  appLoginEnabled: boolean;
} | null> {
  const trimmedClientId = clientId.trim();
  if (!trimmedClientId) {
    return null;
  }

  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'settings-v2-app-login', {
    tenantId,
  });
  const client = await adapter.queryOne<{
    client_id: string;
    redirect_uris: string | string[] | null;
  }>('SELECT client_id, redirect_uris FROM oauth_clients WHERE tenant_id = ? AND client_id = ?', [
    tenantId,
    trimmedClientId,
  ]);
  if (!client) {
    return null;
  }

  const [clientSettings, trustPolicy] = await Promise.all([
    readScopedSettingsRecord(env, 'client', {
      type: 'client',
      tenantId,
      id: trimmedClientId,
    }),
    resolveClientTrustPolicy(adapter, tenantId, 'oidc_client', trimmedClientId),
  ]);

  return {
    clientId: client.client_id,
    redirectUris: parseStringArraySetting(client.redirect_uris),
    firstParty: trustPolicy?.first_party === true,
    appLoginEnabled: clientSettings['client.app_login_enabled'] === true,
  };
}

async function validateAppLoginTarget(
  env: Env,
  tenantId: string,
  input: {
    clientId: unknown;
    redirectUri: unknown;
    scope: unknown;
    finalReturnTo: unknown;
    trustedOrigins: readonly string[];
  }
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      details?: Record<string, unknown>;
    }
> {
  if (typeof input.clientId !== 'string' || !input.clientId.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'login-entry.app_login_client_id is required when App Login is selected',
    };
  }
  if (typeof input.redirectUri !== 'string' || !input.redirectUri.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'login-entry.app_login_redirect_uri is required when App Login is selected',
    };
  }
  if (!validateAppLoginScope(input.scope)) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'login-entry.app_login_scope must include openid and contain valid scope tokens',
    };
  }
  if (
    input.finalReturnTo !== undefined &&
    input.finalReturnTo !== '' &&
    !validatePostLoginRedirectUrl(input.finalReturnTo, input.trustedOrigins)
  ) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message:
        'login-entry.app_login_final_return_to must be empty, a non-reserved relative path, or a trusted HTTPS URL',
    };
  }

  const client = await getAppLoginClientProfile(env, tenantId, input.clientId);
  if (!client) {
    return {
      ok: false,
      status: 404,
      error: 'not_found',
      message: `App Login client "${input.clientId.trim()}" was not found in this tenant`,
    };
  }
  if (!client.firstParty || !client.appLoginEnabled) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message:
        'App Login target client must be same-tenant, first-party, and have App Login enabled in Client settings',
      details: { clientId: client.clientId, resolutionLink: `/admin/clients/${client.clientId}` },
    };
  }
  const redirectUri = input.redirectUri.trim();
  if (!client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'login-entry.app_login_redirect_uri must be registered on the App Login client',
      details: { clientId: client.clientId, resolutionLink: `/admin/clients/${client.clientId}` },
    };
  }

  return { ok: true };
}

async function validateClientAppLoginPatch(
  env: Env,
  tenantId: string,
  clientId: string,
  body: SettingsPatchRequest
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      details?: Record<string, unknown>;
    }
> {
  const set = body.set ?? {};
  const current = await readScopedSettingsRecord(env, 'client', {
    type: 'client',
    tenantId,
    id: clientId,
  });
  const effectiveAppLoginEnabled =
    set['client.app_login_enabled'] ?? current['client.app_login_enabled'] ?? false;
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'settings-v2-app-login', {
    tenantId,
  });
  const trustPolicy = await resolveClientTrustPolicy(adapter, tenantId, 'oidc_client', clientId);
  const effectiveFirstParty = trustPolicy?.first_party === true;
  if (effectiveAppLoginEnabled === true && effectiveFirstParty !== true) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'App Login can only be enabled for first-party clients',
      details: { clientId, requiredPolicy: 'client_trust_policy.first_party' },
    };
  }

  const disablesAppLogin =
    set['client.app_login_enabled'] === false ||
    body.disable?.includes('client.app_login_enabled') ||
    body.clear?.includes('client.app_login_enabled');
  if (!disablesAppLogin) {
    return { ok: true };
  }

  const loginEntry = await readScopedSettingsRecord(env, 'login-entry', {
    type: 'tenant',
    id: tenantId,
  });
  if (
    loginEntry['login-entry.post_login_behavior'] === 'app_login' &&
    loginEntry['login-entry.app_login_client_id'] === clientId
  ) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message:
        'This client is used by Login UI App Login. Change /admin/login-ui#post-login before disabling First Party App or App Login.',
      details: { resolutionLink: '/admin/login-ui#post-login' },
    };
  }

  return { ok: true };
}

const DEPRECATED_CLIENT_CONSENT_SETTING_KEYS = new Set([
  'client.consent_required',
  'client.first_party',
]);

function findDeprecatedClientConsentSetting(body: SettingsPatchRequest): string | undefined {
  const keys = [...Object.keys(body.set ?? {}), ...(body.disable ?? []), ...(body.clear ?? [])];
  return keys.find((key) => DEPRECATED_CLIENT_CONSENT_SETTING_KEYS.has(key));
}

async function validatePostLoginRelatedPatch(
  env: Env,
  tenantId: string,
  category: CategoryName,
  body: SettingsPatchRequest
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      details?: Record<string, unknown>;
    }
> {
  const set = body.set ?? {};

  if (category === 'security' && 'security.trusted_redirect_origins' in set) {
    if (!validateTrustedRedirectOrigins(set['security.trusted_redirect_origins'])) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        message: 'security.trusted_redirect_origins must contain HTTPS origins only',
      };
    }
  }

  if (category === 'self-service') {
    if (
      'self-service.account_page_path' in set &&
      !validateAccountPagePath(set['self-service.account_page_path'])
    ) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        message:
          'self-service.account_page_path must be a non-reserved relative path prefix such as /account',
      };
    }

    const disablesAccountPage =
      set['self-service.account_page_enabled'] === false ||
      body.disable?.includes('self-service.account_page_enabled') ||
      body.clear?.includes('self-service.account_page_enabled');
    if (disablesAccountPage) {
      const loginEntry = await readScopedSettingsRecord(env, 'login-entry', {
        type: 'tenant',
        id: tenantId,
      });
      if (loginEntry['login-entry.post_login_behavior'] === 'account') {
        return {
          ok: false,
          status: 400,
          error: 'bad_request',
          message:
            'Account Page cannot be disabled while Login UI post-login behavior is account. Change /admin/login-ui#post-login first.',
          details: { resolutionLink: '/admin/login-ui#post-login' },
        };
      }
    }
  }

  if (category === 'login-entry') {
    const loginEntry = await readScopedSettingsRecord(env, 'login-entry', {
      type: 'tenant',
      id: tenantId,
    });
    const effectiveBehavior =
      set['login-entry.post_login_behavior'] ?? loginEntry['login-entry.post_login_behavior'];
    const effectiveRedirectUrl =
      set['login-entry.post_login_redirect_url'] ??
      loginEntry['login-entry.post_login_redirect_url'] ??
      '/';
    const security = await readScopedSettingsRecord(env, 'security', {
      type: 'tenant',
      id: tenantId,
    });
    const trustedOrigins = parseTrustedRedirectOrigins(
      security['security.trusted_redirect_origins']
    );
    if (
      effectiveBehavior === 'custom_url' &&
      !validatePostLoginRedirectUrl(effectiveRedirectUrl, trustedOrigins)
    ) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        message:
          'login-entry.post_login_redirect_url must be a non-reserved relative path or a trusted HTTPS URL',
      };
    }

    if (effectiveBehavior === 'app_login') {
      const validation = await validateAppLoginTarget(env, tenantId, {
        clientId:
          set['login-entry.app_login_client_id'] ??
          loginEntry['login-entry.app_login_client_id'] ??
          '',
        redirectUri:
          set['login-entry.app_login_redirect_uri'] ??
          loginEntry['login-entry.app_login_redirect_uri'] ??
          '',
        finalReturnTo:
          set['login-entry.app_login_final_return_to'] ??
          loginEntry['login-entry.app_login_final_return_to'] ??
          '',
        scope:
          set['login-entry.app_login_scope'] ??
          loginEntry['login-entry.app_login_scope'] ??
          'openid profile email',
        trustedOrigins,
      });
      if (!validation.ok) {
        return validation;
      }
    }
  }

  return { ok: true };
}

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

  const manager = getSettingsManager(c.env, c);
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
settingsV2.patch(
  '/tenants/:tenantId/settings/:category',
  requireAgentSettingsElevation,
  async (c) => {
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

    // Security Check 3: Validate user has EDIT permission for this category at tenant scope
    const adminAuth = c.get('adminAuth');
    if (!hasTenantSettingsPermission(adminAuth, category, 'edit')) {
      return errorResponse(c, 'forbidden', 'Insufficient permissions to edit tenant settings', 403);
    }

    // Security Check 4: Validate user can access this specific tenant
    if (!canAccessTenant(adminAuth, tenantId)) {
      return errorResponse(c, 'forbidden', 'Cannot modify settings for this tenant', 403);
    }

    const manager = getSettingsManager(c.env, c);
    const scope: SettingScope = { type: 'tenant', id: tenantId };

    try {
      // Parse and sanitize request body (prevent prototype pollution)
      const rawBody = await c.req.json();
      const body = parsePatchRequest(rawBody);

      // Validate ifMatch is provided
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

      const postLoginValidation = await validatePostLoginRelatedPatch(
        c.env,
        tenantId,
        category,
        body
      );
      if (!postLoginValidation.ok) {
        await recordSettingsAuditFailure(c, {
          category,
          scope,
          reason: 'post_login_validation_failed',
          metadata: postLoginValidation.details,
        });
        return errorResponse(
          c,
          postLoginValidation.error,
          postLoginValidation.message,
          postLoginValidation.status,
          postLoginValidation.details
        );
      }

      // Get actor from context (set by auth middleware)
      const actor = adminAuth?.userId ?? 'unknown';
      const authenticationMethodsBefore =
        category === 'authentication-methods'
          ? await readScopedSettingsRecord(c.env, category, scope)
          : null;

      const result = await manager.patch(category, scope, body, actor);

      if (
        category === 'login-entry' &&
        body.set?.['login-entry.post_login_behavior'] === 'account' &&
        result.applied.includes('login-entry.post_login_behavior')
      ) {
        await ensureTenantAccountPageEnabled(c.env, tenantId);
      }

      // Check if there were any rejections
      const hasRejections = Object.keys(result.rejected).length > 0;
      const hasApplied =
        result.applied.length > 0 || result.cleared.length > 0 || result.disabled.length > 0;
      const changedKeys = [...result.applied, ...result.cleared, ...result.disabled];

      if (
        authenticationMethodsBefore &&
        changedKeys.some((key) => key.startsWith(HUMAN_VERIFICATION_SETTING_PREFIX))
      ) {
        const authenticationMethodsAfter = await readScopedSettingsRecord(c.env, category, scope);
        await scheduleInheritedHumanVerificationProjection(
          c.env,
          tenantId,
          authenticationMethodsBefore,
          authenticationMethodsAfter
        );
      }

      // Return appropriate status
      // 200 OK if anything was applied (even with rejections)
      // 400 Bad Request if everything was rejected
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
        await invalidateAuthenticationMethodsCacheRevision(c, tenantId, `tenant:${category}`);
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
      if (error instanceof Error) {
        if (error.message.includes('Unknown category')) {
          await recordSettingsAuditFailure(c, { category, scope, reason: 'unknown_category' });
          return errorResponse(c, 'not_found', `Category "${category}" not found`, 404);
        }
        if (error.message.includes('read-only')) {
          await recordSettingsAuditFailure(c, { category, scope, reason: 'read_only' });
          return errorResponse(c, 'forbidden', error.message, 403);
        }
      }
      await recordSettingsAuditFailure(c, {
        category,
        scope,
        reason: 'unhandled_error',
        metadata: { error_class: error instanceof Error ? error.name : 'unknown_error' },
      });
      throw error;
    }
  }
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

  const manager = getSettingsManager(c.env, c);
  const scope = { type: 'client', id: clientId, tenantId: clientTenantId } as SettingScope;

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

  const manager = getSettingsManager(c.env, c);
  const scope = { type: 'client', id: clientId, tenantId: clientTenantId } as SettingScope;

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

  const manager = getSettingsManager(c.env, c);
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
    const result = await manager.patch('client', scope, body, actor);

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
      await invalidateAuthenticationMethodsCacheRevision(c, clientTenantId, `client:${category}`);
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

  const manager = getSettingsManager(c.env, c);
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
    const result = await manager.patch(category, scope, body, actor);

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
      await invalidateAuthenticationMethodsCacheRevision(c, clientTenantId, `client:${category}`);
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
});

// =============================================================================
// Platform Settings Routes (Read-Only)
// =============================================================================

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

  const manager = getSettingsManager(c.env, c);
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
    const userRoles = adminAuth?.roles || [];

    if (!checkRolePermission(userRoles, category, 'platform', 'edit')) {
      return errorResponse(
        c,
        'forbidden',
        'Insufficient permissions to edit platform settings',
        403
      );
    }

    const manager = getSettingsManager(c.env, c);
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

      const actor = adminAuth?.userId ?? 'unknown';
      const result = await manager.patch(category, scope, body, actor);
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

export default settingsV2;

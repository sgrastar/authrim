/**
 * The settings catalog: every category's metadata, where each category may be set, and who
 * may view or edit it at each scope.
 *
 * Kept apart from the SettingsManager (which needs node:crypto) so browser code — the Admin
 * console renders settings and mirrors their access rules — can import it on its own.
 * Everything here is re-exported from `./index`.
 */

// Import all category metadata for registration
import { OAUTH_CATEGORY_META } from './oauth';
import { SESSION_CATEGORY_META } from './session';
import { SECURITY_CATEGORY_META } from './security';
import { INFRASTRUCTURE_CATEGORY_META } from './infrastructure';
import { CIBA_CATEGORY_META } from './ciba';
import { RATE_LIMIT_CATEGORY_META } from './rate-limit';
import { DEVICE_FLOW_CATEGORY_META } from './device-flow';
import { TOKENS_CATEGORY_META } from './tokens';
import { EXTERNAL_IDP_CATEGORY_META } from './external-idp';
import { CREDENTIALS_CATEGORY_META } from './credentials';
import { FEDERATION_CATEGORY_META } from './federation';
import { CLIENT_CATEGORY_META } from './client';
import { ENCRYPTION_CATEGORY_META } from './encryption';
import { CACHE_CATEGORY_META } from './cache';
import { FEATURE_FLAGS_CATEGORY_META } from './feature-flags';
import { LIMITS_CATEGORY_META } from './limits';
import { TENANT_CATEGORY_META } from './tenant';
import { VC_CATEGORY_META } from './verifiable-credentials';
import { DISCOVERY_CATEGORY_META } from './discovery';
import { PLUGIN_CATEGORY_META } from './plugin';
import { ASSURANCE_LEVELS_CATEGORY_META } from './assurance-levels';
import { CHECK_API_AUDIT_CATEGORY_META } from './check-api-audit';
import { DCR_CATEGORY_META } from './dcr';
import { LOGIN_UI_CATEGORY_META } from './login-ui';
import { ACCOUNT_LIFECYCLE_CATEGORY_META } from './account-lifecycle';
import { AUTHENTICATION_METHODS_CATEGORY_META } from './authentication-methods';
import { DIAGNOSTIC_LOGGING_CATEGORY_META } from './diagnostic-logging';
import { DR_BACKUP_CATEGORY_META } from './dr-backup';
import { LOGIN_ENTRY_CATEGORY_META } from './login-entry';
import { TENANT_DISCOVERY_UI_CATEGORY_META } from './tenant-discovery-ui';
import { SUPPORT_OPS_CATEGORY_META } from './support-ops';
import { SELF_SERVICE_CATEGORY_META } from './self-service';
import { SERVICE_SITE_CATEGORY_META } from './service-site';

/**
 * All category metadata for easy registration
 */
export const ALL_CATEGORY_META = {
  // Tenant Settings
  oauth: OAUTH_CATEGORY_META,
  session: SESSION_CATEGORY_META,
  security: SECURITY_CATEGORY_META,
  ciba: CIBA_CATEGORY_META,
  'rate-limit': RATE_LIMIT_CATEGORY_META,
  'device-flow': DEVICE_FLOW_CATEGORY_META,
  tokens: TOKENS_CATEGORY_META,
  'external-idp': EXTERNAL_IDP_CATEGORY_META,
  credentials: CREDENTIALS_CATEGORY_META,
  federation: FEDERATION_CATEGORY_META,
  // Client Settings
  client: CLIENT_CATEGORY_META,
  // Cache Settings
  cache: CACHE_CATEGORY_META,
  // Feature Flags
  'feature-flags': FEATURE_FLAGS_CATEGORY_META,
  // Limits
  limits: LIMITS_CATEGORY_META,
  // Tenant
  tenant: TENANT_CATEGORY_META,
  // Verifiable Credentials
  vc: VC_CATEGORY_META,
  // Discovery
  discovery: DISCOVERY_CATEGORY_META,
  // Plugin
  plugin: PLUGIN_CATEGORY_META,
  // Platform Settings (read-only)
  infrastructure: INFRASTRUCTURE_CATEGORY_META,
  encryption: ENCRYPTION_CATEGORY_META,
  // Assurance Levels (NIST SP 800-63-4)
  assurance: ASSURANCE_LEVELS_CATEGORY_META,
  // Check API Audit
  'check-api-audit': CHECK_API_AUDIT_CATEGORY_META,
  // Dynamic Client Registration (RFC 7591)
  dcr: DCR_CATEGORY_META,
  // Login UI Customization
  'login-ui': LOGIN_UI_CATEGORY_META,
  'authentication-methods': AUTHENTICATION_METHODS_CATEGORY_META,
  'account-lifecycle': ACCOUNT_LIFECYCLE_CATEGORY_META,
  // Diagnostic Logging
  'diagnostic-logging': DIAGNOSTIC_LOGGING_CATEGORY_META,
  'dr-backup': DR_BACKUP_CATEGORY_META,
  // Login Entry / Discovery
  'login-entry': LOGIN_ENTRY_CATEGORY_META,
  'tenant-discovery-ui': TENANT_DISCOVERY_UI_CATEGORY_META,
  'support-ops': SUPPORT_OPS_CATEGORY_META,
  'self-service': SELF_SERVICE_CATEGORY_META,
  'service-site': SERVICE_SITE_CATEGORY_META,
} as const;

/**
 * Category names (for type safety)
 */
export type CategoryName = keyof typeof ALL_CATEGORY_META;

import type { SettingScopeLevel, ScopePermission, ScopedCategoryMeta } from './common';
import { DEFAULT_SCOPE_PERMISSIONS } from './common';
import type { SettingScope } from '../../utils/settings-manager';

/**
 * Category scope configuration
 * Defines which scopes each category is available at and role-based permissions
 */
export const CATEGORY_SCOPE_CONFIG: Record<
  CategoryName,
  {
    allowedScopes: SettingScopeLevel[];
    scopePermissions?: Partial<Record<SettingScopeLevel, Partial<ScopePermission>>>;
  }
> = {
  // Platform-only categories (infrastructure settings)
  infrastructure: {
    allowedScopes: ['platform'],
    scopePermissions: {
      platform: { viewRoles: ['system_admin', 'viewer'], editRoles: [] }, // read-only
    },
  },
  encryption: {
    allowedScopes: ['platform'],
    scopePermissions: {
      platform: { viewRoles: ['system_admin'], editRoles: [] }, // read-only, restricted view
    },
  },
  cache: {
    allowedScopes: ['platform'],
  },

  // Platform + Tenant categories
  'rate-limit': {
    allowedScopes: ['platform', 'tenant'],
  },
  'feature-flags': {
    allowedScopes: ['platform', 'tenant'],
  },
  limits: {
    allowedScopes: ['platform', 'tenant'],
  },
  'check-api-audit': {
    // The Check API reads the platform's audit settings (it audits before a check's tenant is known).
    allowedScopes: ['platform'],
  },

  // Categories a tenant (and, for some, a client) can override; several also have
  // platform-wide values the tenants inherit
  oauth: {
    allowedScopes: ['platform', 'tenant', 'client'],
  },
  security: {
    allowedScopes: ['platform', 'tenant', 'client'],
  },
  'device-flow': {
    allowedScopes: ['tenant', 'client'],
  },

  // Tenant categories (some with platform-wide values the tenants inherit)
  session: {
    allowedScopes: ['platform', 'tenant'],
  },
  ciba: {
    allowedScopes: ['tenant'],
  },
  tokens: {
    allowedScopes: ['platform', 'tenant'],
  },
  'external-idp': {
    allowedScopes: ['platform', 'tenant'],
  },
  credentials: {
    allowedScopes: ['tenant'],
  },
  federation: {
    allowedScopes: ['tenant'],
  },
  tenant: {
    allowedScopes: ['platform', 'tenant'],
    scopePermissions: {
      tenant: {
        viewRoles: ['system_admin', 'distributor_admin', 'org_admin', 'admin', 'viewer'],
        editRoles: ['system_admin', 'distributor_admin', 'org_admin', 'admin'],
      },
    },
  },
  vc: {
    allowedScopes: ['tenant'],
  },
  discovery: {
    allowedScopes: ['platform', 'tenant'],
  },
  plugin: {
    allowedScopes: ['tenant'],
  },
  assurance: {
    allowedScopes: ['tenant'],
  },

  // Client-only category
  client: {
    allowedScopes: ['client'],
  },

  // Dynamic Client Registration (RFC 7591)
  dcr: {
    allowedScopes: ['tenant'],
  },

  // Login UI Customization
  'login-ui': {
    allowedScopes: ['tenant', 'client'],
  },
  'authentication-methods': {
    allowedScopes: ['tenant'],
  },
  'account-lifecycle': {
    allowedScopes: ['tenant'],
  },
  'login-entry': {
    allowedScopes: ['platform', 'tenant'],
  },
  'tenant-discovery-ui': {
    allowedScopes: ['platform', 'tenant'],
  },
  'support-ops': {
    allowedScopes: ['tenant'],
  },
  'self-service': {
    // The platform sets defaults (the re-authentication window); account page placement stays
    // per tenant (each such setting is limited to the tenant scope).
    allowedScopes: ['platform', 'tenant'],
  },
  'service-site': {
    allowedScopes: ['tenant'],
  },

  // Diagnostic Logging (tenant + client in future)
  'diagnostic-logging': {
    allowedScopes: ['tenant'], // Phase 1: tenant only, will add 'client' in future
  },
  'dr-backup': {
    allowedScopes: ['tenant'],
  },
};

/**
 * Get scoped category metadata for a category
 */
export function getScopedCategoryMeta(categoryName: CategoryName): ScopedCategoryMeta {
  const baseMeta = ALL_CATEGORY_META[categoryName];
  const scopeConfig = CATEGORY_SCOPE_CONFIG[categoryName];

  // Merge default permissions with category-specific overrides
  const scopePermissions: Record<SettingScopeLevel, ScopePermission> = {
    platform: { ...DEFAULT_SCOPE_PERMISSIONS.platform },
    tenant: { ...DEFAULT_SCOPE_PERMISSIONS.tenant },
    client: { ...DEFAULT_SCOPE_PERMISSIONS.client },
  };

  if (scopeConfig.scopePermissions) {
    for (const [scope, perms] of Object.entries(scopeConfig.scopePermissions)) {
      const scopeLevel = scope as SettingScopeLevel;
      // Use !== undefined to properly handle empty arrays (e.g., editRoles: [] for read-only)
      if (perms.viewRoles !== undefined) {
        scopePermissions[scopeLevel].viewRoles = perms.viewRoles;
      }
      if (perms.editRoles !== undefined) {
        scopePermissions[scopeLevel].editRoles = perms.editRoles;
      }
    }
  }

  return {
    ...baseMeta,
    allowedScopes: scopeConfig.allowedScopes,
    scopePermissions,
  };
}

/**
 * Get all scoped category metadata
 */
export function getAllScopedCategoryMeta(): Record<CategoryName, ScopedCategoryMeta> {
  const result = {} as Record<CategoryName, ScopedCategoryMeta>;
  for (const categoryName of Object.keys(ALL_CATEGORY_META) as CategoryName[]) {
    result[categoryName] = getScopedCategoryMeta(categoryName);
  }
  return result;
}

/**
 * Get categories available at a specific scope level
 */
export function getCategoriesForScope(scope: SettingScopeLevel): CategoryName[] {
  return (Object.keys(CATEGORY_SCOPE_CONFIG) as CategoryName[]).filter((category) =>
    CATEGORY_SCOPE_CONFIG[category].allowedScopes.includes(scope)
  );
}

/**
 * Check if a category is available at a specific scope level
 */
export function isCategoryAvailableAtScope(
  category: CategoryName,
  scope: SettingScopeLevel
): boolean {
  return CATEGORY_SCOPE_CONFIG[category]?.allowedScopes.includes(scope) ?? false;
}

/**
 * The scopes a setting inherits from, nearest first: a client inherits from its tenant and
 * then the platform, a tenant from the platform. Scopes the category does not allow are
 * skipped, so a value can only come from a scope where it could have been set.
 */
export function settingsParentScopes(category: CategoryName, scope: SettingScope): SettingScope[] {
  const parents: SettingScope[] = [];
  if (scope.type === 'client' && isCategoryAvailableAtScope(category, 'tenant')) {
    parents.push({ type: 'tenant', id: scope.tenantId });
  }
  if (scope.type !== 'platform' && isCategoryAvailableAtScope(category, 'platform')) {
    parents.push({ type: 'platform' });
  }
  return parents;
}

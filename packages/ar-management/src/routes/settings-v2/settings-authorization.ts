/**
 * Who may read or edit which settings, where: the checks the Settings API routes (tenant, app and
 * platform) and the bulk apply share.
 */
import {
  ADMIN_PERMISSIONS,
  CATEGORY_SCOPE_CONFIG,
  categoryTenantEditRequiresPlatformAuthority,
  getScopedCategoryMeta,
  hasAdminPermission,
  hasGlobalMachinePermission,
  type AdminAuthContext,
  type CategoryName,
  type SettingScopeLevel,
} from '@authrim/ar-lib-core';

// =============================================================================
// Authorization Helper Functions
// =============================================================================

/**
 * Check if user has permission for a category at a given scope level
 */
export function checkRolePermission(
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
 * Whether the caller may edit a category at the platform scope. A person needs a role that may,
 * held through a global assignment, with a global tenant scope: `adminAuth.roles` adds up every
 * assignment that applies to the request, so it is not what a change that reaches every tenant is
 * judged on. A machine token has no roles; it needs the settings write permission for every
 * tenant (a global tenant scope, and the permission among its global ones). A token limited to
 * some tenants holds nothing for the platform, whatever its permissions are.
 */
export function hasGlobalPlatformSettingsEdit(
  adminAuth: AdminAuthContext | undefined,
  category: CategoryName
): boolean {
  if (!adminAuth) return false;
  if (adminAuth.authMethod === 'machine_access_token') {
    return hasGlobalMachinePermission(adminAuth, ADMIN_PERMISSIONS.SETTINGS_WRITE);
  }
  if (!(adminAuth.tenantScope ?? []).includes('*')) return false;
  return checkRolePermission(adminAuth.globalRoles ?? [], category, 'platform', 'edit');
}

/**
 * The roles a person holds for `tenantId`. `adminAuth.roles` adds up the global assignments and the
 * ones for the tenant the request arrived on (`adminAuth.tenantId`), so they are the caller's roles
 * for that tenant only; for any other tenant, only the global assignments (under a global tenant
 * scope) hold. A tenant-only super_admin, or a global viewer who is a super_admin of one tenant,
 * is therefore not a super_admin of the others.
 */
export function rolesForTenant(
  adminAuth: AdminAuthContext,
  tenantId: string | undefined
): readonly string[] {
  if (tenantId === undefined || tenantId === adminAuth.tenantId) return adminAuth.roles;
  return (adminAuth.tenantScope ?? []).includes('*') ? (adminAuth.globalRoles ?? []) : [];
}

/**
 * Whether the caller may change a tenant's settings of a category that only the platform may change
 * (see `tenantEditRequiresPlatformAuthority`): platform authority, never an agent. True for a
 * category that has no such rule, so this is the one place the rule is added to the role check.
 */
export function hasPlatformAuthorityForTenantEdit(
  adminAuth: AdminAuthContext | undefined,
  category: CategoryName
): boolean {
  if (!categoryTenantEditRequiresPlatformAuthority(category)) return true;
  if (!adminAuth || adminAuth.actorType === 'agent') return false;
  return hasGlobalPlatformSettingsEdit(adminAuth, category);
}

/**
 * Whether the caller may view or edit a category of the tenant's settings. `tenantId` is the tenant
 * the settings belong to; left out, it is the tenant the request arrived on.
 */
export function hasTenantSettingsPermission(
  adminAuth: AdminAuthContext | undefined,
  category: CategoryName,
  action: 'view' | 'edit',
  tenantId?: string
): boolean {
  if (!adminAuth) return false;
  if (action === 'edit' && !hasPlatformAuthorityForTenantEdit(adminAuth, category)) return false;
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
  return checkRolePermission([...rolesForTenant(adminAuth, tenantId)], category, 'tenant', action);
}

export function hasClientSettingsPermission(
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
export function isCategoryAllowedAtScope(
  category: CategoryName,
  scopeLevel: SettingScopeLevel
): boolean {
  const scopeConfig = CATEGORY_SCOPE_CONFIG[category];
  return scopeConfig?.allowedScopes.includes(scopeLevel) ?? false;
}

export function isCategoryWritableAtScope(
  category: CategoryName,
  scopeLevel: SettingScopeLevel
): boolean {
  const scopedMeta = getScopedCategoryMeta(category);
  return scopedMeta.scopePermissions[scopeLevel].editRoles.length > 0;
}

/**
 * Check if user can access a specific tenant's data
 * super_admin, system_admin and distributor_admin can access any tenant, as long as they hold the
 * role for every tenant (a global assignment) or the tenant is the one the request arrived on
 * org_admin can only access their own tenant
 */
export function canAccessTenant(
  adminAuth: AdminAuthContext | undefined,
  tenantId: string
): boolean {
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

  // Only the roles held for this tenant count: for a tenant other than the request's, those of
  // the global assignments.
  const userRoles = rolesForTenant(adminAuth, tenantId);

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

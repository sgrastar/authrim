import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  getTenantIdFromContext,
  hasGlobalAdminPermission,
  hasGlobalAdminRole,
} from '@authrim/ar-lib-core';

const PLATFORM_TENANT_MANAGEMENT_ROLES = new Set([
  'super_admin',
  'system_admin',
  'distributor_admin',
]);

export function getAdminAuth(c: Context<{ Bindings: Env }>): AdminAuthContext | undefined {
  return (c as unknown as { get: (key: string) => unknown }).get('adminAuth') as
    | AdminAuthContext
    | undefined;
}

/**
 * Whether the caller manages tenants as a platform administrator: a platform role, or the
 * wildcard (or the `requiredPermission` when one is named), held through a global assignment.
 * Managing tenants takes effect across them, and `roles` and `permissions` also add up what the
 * caller holds for one tenant only, so neither is read here.
 */
export function hasPlatformTenantManagementAuthority(
  adminAuth: AdminAuthContext | undefined,
  requiredPermission?: string
): boolean {
  if (!adminAuth) {
    return false;
  }

  if (hasGlobalAdminRole(adminAuth, [...PLATFORM_TENANT_MANAGEMENT_ROLES])) return true;
  if (requiredPermission === undefined && isGlobalMachineToken(adminAuth)) {
    // A machine token has one scope, so all its permissions are global exactly when that scope
    // is; the route's own permission rule says which of them it needs.
    return true;
  }
  return hasGlobalAdminPermission(adminAuth, requiredPermission ?? '*');
}

function isGlobalMachineToken(adminAuth: AdminAuthContext): boolean {
  return (
    adminAuth.authMethod === 'machine_access_token' && adminAuth.tenantScope?.includes('*') === true
  );
}

/**
 * Whether the caller reaches a tenant's own resources. `requestTenantId` is the tenant the
 * caller's roles and permissions were worked out for; a caller whose scope is global through a
 * global assignment reaches that tenant with them, and any other tenant only as a platform
 * administrator.
 */
export function canAccessTenantResource(
  adminAuth: AdminAuthContext | undefined,
  tenantId: string,
  requestTenantId?: string
): boolean {
  if (!adminAuth) {
    return false;
  }
  if (hasPlatformTenantManagementAuthority(adminAuth)) {
    return true;
  }
  if (adminAuth.tenantScope?.includes(tenantId)) {
    return true;
  }
  if (adminAuth.tenantScope?.includes('*') && requestTenantId === tenantId) {
    return true;
  }
  return adminAuth.tenantId === tenantId;
}

export function getTenantInventoryScope(adminAuth: AdminAuthContext | undefined): string[] {
  if (!adminAuth) {
    return [];
  }

  const scopedTenantIds = new Set<string>();
  for (const tenantId of adminAuth.tenantScope ?? []) {
    if (tenantId !== '*') {
      scopedTenantIds.add(tenantId);
    }
  }
  if (adminAuth.tenantId) {
    scopedTenantIds.add(adminAuth.tenantId);
  }

  return [...scopedTenantIds];
}

export function isTenantScopedAdminPath(pathname: string): boolean {
  return (
    /^\/api\/admin\/tenants\/[^/]+\/directory-(?:auth|connectors)(?:\/|$)/.test(pathname) ||
    /^\/api\/admin\/tenants\/[^/]+\/settings(?:\/|$)/.test(pathname)
  );
}

export async function requireTenantResourceAccess(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<Response | null> {
  if (canAccessTenantResource(getAdminAuth(c), tenantId, getTenantIdFromContext(c))) {
    return null;
  }

  return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
    variables: {
      required_scope: 'tenant',
      tenant_id: tenantId,
      reason: 'Administrator is not authorized for this tenant',
    },
  });
}

export async function requirePlatformTenantManagementAuthority(
  c: Context<{ Bindings: Env }>,
  requiredPermission?: string
): Promise<Response | null> {
  if (hasPlatformTenantManagementAuthority(getAdminAuth(c), requiredPermission)) {
    return null;
  }

  return await createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
    variables: {
      required_scope: 'platform',
      ...(requiredPermission ? { required_permission: requiredPermission } : {}),
      reason: 'Tenant management requires platform administrator authority',
    },
  });
}

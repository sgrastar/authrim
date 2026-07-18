import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { AR_ERROR_CODES, createErrorResponse, hasAdminPermission } from '@authrim/ar-lib-core';

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

export function hasPlatformTenantManagementAuthority(
  adminAuth: AdminAuthContext | undefined,
  requiredPermission?: string
): boolean {
  if (!adminAuth) {
    return false;
  }

  if (adminAuth.roles.some((role) => PLATFORM_TENANT_MANAGEMENT_ROLES.has(role))) return true;
  if (adminAuth.tenantScope?.includes('*') !== true) return false;
  return requiredPermission
    ? hasAdminPermission(adminAuth.permissions ?? [], requiredPermission)
    : true;
}

export function canAccessTenantResource(
  adminAuth: AdminAuthContext | undefined,
  tenantId: string
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
  if (canAccessTenantResource(getAdminAuth(c), tenantId)) {
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

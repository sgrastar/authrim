import {
  hasAdminPermission,
  hasGlobalAdminPermission,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';

/**
 * Whether the caller may act on these tenants with `permission`.
 *
 * A caller whose tenant scope is global has a global assignment, but `permissions` also adds up
 * what the caller holds for the request's tenant alone. So for tenants other than the request's,
 * the permission has to come from a global assignment; for the request's tenant itself,
 * `permissions` is the set worked out for it.
 */
export function actorReachesTenants(
  auth: AdminAuthContext,
  requestTenantId: string,
  tenantIds: readonly string[],
  permission: string
): boolean {
  const scope = auth.tenantScope ?? [];
  if (!scope.includes('*')) {
    return tenantIds.every((tenantId) => scope.includes(tenantId));
  }
  return (
    hasGlobalAdminPermission(auth, permission) ||
    tenantIds.every((tenantId) => tenantId === requestTenantId)
  );
}

/**
 * Whether the caller holds `permission` for these tenants. For the request's tenant alone,
 * `permissions` is the set worked out for it; for any other tenant the permission has to come from
 * a global assignment, since `permissions` also adds up what is held for the request's tenant only.
 */
export function actorHoldsOnTenants(
  auth: AdminAuthContext,
  requestTenantId: string,
  tenantIds: readonly string[],
  permission: string
): boolean {
  return tenantIds.every((tenantId) => tenantId === requestTenantId)
    ? hasAdminPermission(auth.permissions ?? [], permission)
    : hasGlobalAdminPermission(auth, permission);
}

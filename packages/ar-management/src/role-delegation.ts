import { ADMIN_PERMISSIONS, hasAdminPermission, type AdminAuthContext } from '@authrim/ar-lib-core';

function hasMachineFullAdminBypass(authContext: AdminAuthContext | null): boolean {
  if (authContext?.authMethod !== 'machine_access_token') {
    return false;
  }
  const permissions = authContext.permissions ?? [];
  return (
    hasAdminPermission(permissions, ADMIN_PERMISSIONS.ALL) ||
    permissions.some((permission) => permission === 'admin:*')
  );
}

type GrantRole = { grant_tier: number };

/** The tier a machine access token with every admin permission may delegate (the highest). */
const MACHINE_FULL_ADMIN_GRANT_TIER = 3;

/**
 * Whether the administrator may grant, revoke or edit an end-user role: the role's `grant_tier`
 * is at most the administrator's `maxGrantTier` (from its admin roles' definitions). This is the
 * only delegation guard for end-user roles.
 */
export function grantCeilingOf(auth: AdminAuthContext): number {
  return hasMachineFullAdminBypass(auth) ? MACHINE_FULL_ADMIN_GRANT_TIER : (auth.maxGrantTier ?? 0);
}

export function canGrantRole(auth: AdminAuthContext | null, role: GrantRole): boolean {
  if (!auth || !Number.isInteger(role.grant_tier) || role.grant_tier < 1) return false;
  const ceiling = grantCeilingOf(auth);
  return Number.isInteger(ceiling) && role.grant_tier <= ceiling;
}

export function mayManageEndUserRole(auth: AdminAuthContext | null, role: GrantRole) {
  return canGrantRole(auth, role);
}

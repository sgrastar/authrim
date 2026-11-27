import { ADMIN_PERMISSIONS, hasAdminPermission, type AdminAuthContext } from '@authrim/ar-lib-core';

function getNumericHierarchyLevel(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

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

export function canManageRoleHierarchy(
  authContext: AdminAuthContext | null,
  targetHierarchyLevel: unknown
): boolean {
  if (hasMachineFullAdminBypass(authContext)) {
    return true;
  }

  if (authContext?.hierarchyLevel === undefined) {
    return false;
  }

  return getNumericHierarchyLevel(targetHierarchyLevel) < authContext.hierarchyLevel;
}

type GrantRole = { grant_tier: number; hierarchy_level: number | null };

/** Compatibility mapping for current admin roles (support, tenant admin, super admin). */
const LEGACY_GRANT_TIERS = [
  { minLevel: 100, tier: 3 },
  { minLevel: 80, tier: 2 },
  { minLevel: 1, tier: 1 },
] as const;

export function canGrantRole(
  auth: AdminAuthContext | null,
  role: Pick<GrantRole, 'grant_tier'>
): boolean {
  if (!auth || !Number.isInteger(role.grant_tier) || role.grant_tier < 1) return false;
  const level = hasMachineFullAdminBypass(auth) ? 100 : (auth.hierarchyLevel ?? 0);
  const ceiling =
    auth.maxGrantTier ?? LEGACY_GRANT_TIERS.find((row) => level >= row.minLevel)?.tier ?? 0;
  return Number.isInteger(ceiling) && role.grant_tier <= ceiling;
}

export function mayManageEndUserRole(auth: AdminAuthContext | null, role: GrantRole) {
  return canGrantRole(auth, role) && canManageRoleHierarchy(auth, role.hierarchy_level);
}

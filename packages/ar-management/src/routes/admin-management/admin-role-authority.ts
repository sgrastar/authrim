/**
 * Who may change an Admin role, and what a change may give.
 *
 * `adminAuth.permissions` adds up every assignment of the caller that applies to the request, and a
 * role's permissions also include what it inherits. A role that a global assignment (or a pending
 * global invitation) leads to is the way into everything the platform owns, so changing what such a
 * role holds is a global operation: it needs the permission from a global assignment, and may give
 * only what the caller's global permissions hold.
 */

import type { AdminAuthContext, AdminRole, DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  hasAdminPermission,
  hasGlobalAdminPermission,
  isReservedAdminRoleName,
} from '@authrim/ar-lib-core';

/**
 * Whether a custom role may take this name. Admin checks read the standard roles' names as
 * authority, so every name that starts with the reserved prefix is the standard roles' alone.
 */
export function isRoleNameReserved(name: string): boolean {
  return isReservedAdminRoleName(name.trim());
}

/**
 * Where a role may be assigned. The super admin reaches every tenant and the platform, so it is
 * held through a global assignment only; the other standard roles, and custom roles, may be given
 * for a tenant or globally.
 */
export function isScopeAllowedForRole(roleName: string, scopeType: string): boolean {
  if (roleName === ADMIN_ROLES.SUPER_ADMIN) {
    return scopeType === 'global';
  }
  return scopeType === 'global' || scopeType === 'tenant';
}

/** Whether the caller's hierarchy is above `level`. A caller without a hierarchy outranks nothing. */
export function callerOutranks(auth: AdminAuthContext, level: number): boolean {
  return auth.hierarchyLevel !== undefined && level < auth.hierarchyLevel;
}

/**
 * Whether the caller's global hierarchy is above `level`. A global role, or a global assignment, is
 * measured by what the global assignments give: `hierarchyLevel` also adds up a high role held for
 * one tenant, and what is built from that would reach every tenant.
 */
export function callerOutranksGlobally(auth: AdminAuthContext, level: number): boolean {
  return auth.globalHierarchyLevel !== undefined && level < auth.globalHierarchyLevel;
}

function canSeeRole(role: AdminRole, tenantId: string): boolean {
  return role.tenant_id === tenantId || (role.tenant_id === 'default' && role.is_system);
}

/**
 * Whether a global assignment, or a pending global invitation, leads to this role: the role itself
 * or one that inherits it, directly or through others.
 */
export async function roleReachesGlobalAssignment(
  adapter: DatabaseAdapter,
  tenantId: string,
  roleId: string
): Promise<boolean> {
  const roles = await adapter.query<{ id: string; inherits_from: string | null }>(
    `SELECT id, inherits_from FROM admin_roles
      WHERE tenant_id = ? OR (tenant_id = 'default' AND is_system = 1)`,
    [tenantId]
  );
  const leadsToRole = new Set<string>([roleId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const role of roles) {
      if (role.inherits_from && leadsToRole.has(role.inherits_from) && !leadsToRole.has(role.id)) {
        leadsToRole.add(role.id);
        grew = true;
      }
    }
  }

  // A pending invitation counts whether or not it has expired: a resend brings it back.
  const [assignments, invitations] = await Promise.all([
    adapter.query<{ admin_role_id: string }>(
      `SELECT DISTINCT admin_role_id FROM admin_role_assignments
        WHERE tenant_id = ? AND scope_type = 'global'`,
      [tenantId]
    ),
    adapter.query<{ admin_role_id: string }>(
      `SELECT DISTINCT admin_role_id FROM admin_invitations
        WHERE tenant_id = ? AND scope_type = 'global' AND status = 'pending'`,
      [tenantId]
    ),
  ]);
  return [...assignments, ...invitations].some((row) => leadsToRole.has(row.admin_role_id));
}

export type InheritanceCheck =
  | { ok: true; inheritedPermissions: string[] }
  | { ok: false; reason: 'invalid' | 'forbidden' };

/**
 * Whether a role may inherit from `parentId`. The parent has to be one the tenant can see; its
 * permissions (with what it inherits in turn) have to be within the caller's own; its hierarchy has
 * to be below the caller's; and it must not lead back to the role being changed.
 */
export async function checkRoleInheritance(
  roles: {
    getRole(id: string): Promise<AdminRole | null>;
    getEffectivePermissions(id: string): Promise<string[]>;
  },
  tenantId: string,
  auth: AdminAuthContext,
  parentId: unknown,
  changedRoleId?: string
): Promise<InheritanceCheck> {
  if (parentId === null || parentId === undefined || parentId === '') {
    return { ok: true, inheritedPermissions: [] };
  }
  if (typeof parentId !== 'string') {
    return { ok: false, reason: 'invalid' };
  }

  const parent = await roles.getRole(parentId);
  if (!parent || !canSeeRole(parent, tenantId)) {
    return { ok: false, reason: 'invalid' };
  }

  if (changedRoleId !== undefined) {
    const visited = new Set<string>();
    let current: AdminRole | null = parent;
    while (current && !visited.has(current.id)) {
      if (current.id === changedRoleId) {
        return { ok: false, reason: 'invalid' };
      }
      visited.add(current.id);
      current = current.inherits_from ? await roles.getRole(current.inherits_from) : null;
    }
  }

  if (!callerOutranks(auth, parent.hierarchy_level)) {
    return { ok: false, reason: 'forbidden' };
  }
  const inheritedPermissions = await roles.getEffectivePermissions(parent.id);
  if (!inheritedPermissions.every((p) => hasAdminPermission(auth.permissions ?? [], p))) {
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, inheritedPermissions };
}

/** Whether the caller may give `permissions` on a role a global assignment leads to. */
export function mayGiveGlobally(auth: AdminAuthContext, permissions: readonly string[]): boolean {
  return (
    hasGlobalAdminPermission(auth, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE) &&
    permissions.every((permission) => hasAdminPermission(auth.globalPermissions ?? [], permission))
  );
}

/**
 * What an Admin account holds in the tenant, as it decides who may act on the account: whether any
 * active global assignment, and the highest hierarchy among all active assignments that apply to
 * the tenant (the global ones and the tenant's own).
 */
export interface AdminStanding {
  hasGlobalAssignment: boolean;
  highestLevel: number;
}

export async function loadAdminStanding(
  adapter: DatabaseAdapter,
  tenantId: string,
  adminUserId: string
): Promise<AdminStanding> {
  const rows = await adapter.query<{ scope_type: string; hierarchy_level: number | null }>(
    `SELECT ra.scope_type AS scope_type, r.hierarchy_level AS hierarchy_level
       FROM admin_role_assignments ra
       JOIN admin_roles r
         ON r.id = ra.admin_role_id
        AND (r.tenant_id = ra.tenant_id OR (r.tenant_id = 'default' AND r.is_system = 1))
      WHERE ra.tenant_id = ?
        AND ra.admin_user_id = ?
        AND (
          ra.scope_type = 'global'
          OR (ra.scope_type = 'tenant' AND (ra.scope_id = ? OR ra.scope_id IS NULL))
        )
        AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
    [tenantId, adminUserId, tenantId, Date.now()]
  );
  return {
    hasGlobalAssignment: rows.some((row) => row.scope_type === 'global'),
    highestLevel: rows.reduce((max, row) => Math.max(max, Number(row.hierarchy_level ?? 0)), 0),
  };
}

/**
 * Whether the caller may act on another Admin's account (change it, suspend, delete, activate or
 * unlock it). An account that holds a global assignment, or a role above the caller's own, is
 * reached by what the global assignments give: the permission from a global assignment, and a
 * global hierarchy at least as high as the account's. `permissions` and `hierarchyLevel` add up
 * what the caller holds for one tenant, which is not what an account that reaches every tenant
 * (or outranks the caller) is judged on. Any other account is the caller's by the route's own
 * permission rule.
 */
export function mayActOnAdminAccount(
  auth: AdminAuthContext,
  target: AdminStanding,
  permission: string
): boolean {
  if (!target.hasGlobalAssignment && target.highestLevel <= (auth.hierarchyLevel ?? 0)) {
    return true;
  }
  return (
    hasGlobalAdminPermission(auth, permission) &&
    (isGlobalMachine(auth) || (auth.globalHierarchyLevel ?? 0) >= target.highestLevel)
  );
}

/**
 * A machine token has no hierarchy (it is always 0), and a person who may issue one may give it
 * the permissions they hold for the tenant, so a tenant-scoped machine is judged by hierarchy like
 * any other caller: it outranks nothing. Only a token that holds its permission for every tenant
 * is measured by that permission alone: such a token can only be issued by a global assignment.
 */
function isGlobalMachine(auth: AdminAuthContext): boolean {
  return auth.authMethod === 'machine_access_token' && (auth.tenantScope ?? []).includes('*');
}

/**
 * Whether the caller may remove an assignment of a role at `roleLevel`. A global assignment is
 * removed on the global permission and the global hierarchy; a tenant one on a hierarchy that is not
 * below the role's.
 */
export function mayRemoveAssignment(
  auth: AdminAuthContext,
  scopeType: string,
  hierarchyLevel: number | null | undefined
): boolean {
  const roleLevel = Number(hierarchyLevel ?? 0);
  if (scopeType === 'global') {
    return (
      hasGlobalAdminPermission(auth, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE) &&
      (isGlobalMachine(auth) || (auth.globalHierarchyLevel ?? 0) >= roleLevel)
    );
  }
  return (
    (isGlobalMachine(auth) &&
      hasGlobalAdminPermission(auth, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE)) ||
    (auth.hierarchyLevel ?? 0) >= roleLevel
  );
}

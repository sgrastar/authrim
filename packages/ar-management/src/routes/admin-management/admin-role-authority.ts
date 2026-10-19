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
  hasAdminPermission,
  hasGlobalAdminPermission,
} from '@authrim/ar-lib-core';

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

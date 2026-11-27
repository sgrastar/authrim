import {
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  assignGroupRole,
  bumpTenantRBACCacheVersion,
  removeGroupRole,
  findTenantRole,
  ensureDatabaseAdapter,
  updateGroup,
  upsertGroupMembership,
  type AdminAuthContext,
  type DatabaseSource,
  type GroupRoleGrant,
  type GroupRoleKey,
  type TransactionContext,
} from '@authrim/ar-lib-core';
import type { KVNamespace } from '@cloudflare/workers-types';
import { mayManageEndUserRole } from './role-delegation';

type Admin = AdminAuthContext | null;

/** The delegation check of a grant: the role-write permission and the grant ceiling. */
export function assertDelegableRole(
  auth: Admin,
  role: { grant_tier: number; hierarchy_level: number | null }
) {
  if (
    !auth ||
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.ROLES_WRITE) ||
    !mayManageEndUserRole(auth, role)
  )
    throw new Error('role_delegation_denied');
}

async function requireDelegableRole(
  metadata: DatabaseSource,
  tenant: string,
  auth: Admin,
  roleId: string
) {
  const role = await findTenantRole(metadata, tenant, { id: roleId });
  if (!role) throw new Error('role_delegation_denied');
  assertDelegableRole(auth, role);
  return role;
}

/** Whether a role can be granted: 1/0 in SQLite and D1, true/false in PostgreSQL, NULL is not. */
export function isRoleAssignable(role: { is_assignable: number | boolean | null }) {
  return role.is_assignable === 1 || role.is_assignable === true;
}

export async function adminAssignGroupRole(
  metadata: DatabaseSource,
  tenant: string,
  auth: Admin,
  grant: GroupRoleGrant,
  cache?: KVNamespace
) {
  const role = await requireDelegableRole(metadata, tenant, auth, grant.roleId);
  if (!isRoleAssignable(role)) throw new Error('role_not_assignable');
  await assignGroupRole(metadata, tenant, grant, cache);
}

export async function adminRemoveGroupRole(
  metadata: DatabaseSource,
  tenant: string,
  auth: Admin,
  key: GroupRoleKey,
  cache?: KVNamespace
) {
  const role = await findTenantRole(metadata, tenant, { id: key.roleId });
  if (!role) {
    // The role definition is gone, so the grant is already unreachable and nothing is deleted;
    // the version is still bumped so a retry after a failed bump completes the invalidation.
    if (!auth || !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.ROLES_WRITE))
      throw new Error('role_delegation_denied');
    if (cache) await bumpTenantRBACCacheVersion(cache, tenant);
    return;
  }
  assertDelegableRole(auth, role);
  await removeGroupRole(metadata, tenant, key, cache);
}

/** Include dormant groups: restoring their active state could expose an already delegated role. */
export async function canManageGroupMembership(
  metadata: Pick<TransactionContext, 'query'>,
  tenant: string,
  auth: Admin,
  groupId: string
) {
  const roles = await metadata.query<{
    grant_tier: number;
    hierarchy_level: number;
  }>(
    `WITH RECURSIVE ancestors(id, parent_group_id) AS (
      SELECT id, parent_group_id FROM "groups" WHERE tenant_id=? AND id=?
      UNION SELECT g.id, g.parent_group_id FROM "groups" g JOIN ancestors a ON g.id=a.parent_group_id
      WHERE g.tenant_id=?
    ) SELECT DISTINCT r.grant_tier, r.hierarchy_level FROM ancestors a
      JOIN group_role_assignments g ON g.group_id=a.id AND g.tenant_id=?
      JOIN roles r ON r.id=g.role_id AND r.tenant_id=g.tenant_id
      WHERE g.expires_at IS NULL OR g.expires_at>?`,
    [tenant, groupId, tenant, tenant, Math.floor(Date.now() / 1000)]
  );
  if (!roles.length) return true;
  // Adding a member to a group that carries roles grants those roles: the same operation
  // permission as a direct grant is required, on top of the grant ceiling of every role.
  if (!auth || !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.ROLES_WRITE))
    return false;
  return roles.every((role) => mayManageEndUserRole(auth, role));
}

export async function adminUpsertGroupMembership(
  auth: Admin,
  ...args: Parameters<typeof upsertGroupMembership>
) {
  const [dbs, tenant, subjectId, input] = args;
  if (auth?.userId === subjectId) throw new Error('role_delegation_denied');
  if (
    !(await canManageGroupMembership(
      ensureDatabaseAdapter(dbs.metadata),
      tenant,
      auth,
      input.groupId
    ))
  )
    throw new Error('role_delegation_denied');
  await upsertGroupMembership(...args);
}

/** The delegation checks of moving a group: the group and the parent it moves under. */
export async function assertMayReparentGroup(
  metadata: DatabaseSource,
  tenant: string,
  auth: Admin,
  id: string,
  parentGroupId: string | null
) {
  const db = ensureDatabaseAdapter(metadata);
  if (
    !(await canManageGroupMembership(db, tenant, auth, id)) ||
    (parentGroupId && !(await canManageGroupMembership(db, tenant, auth, parentGroupId)))
  )
    throw new Error('role_delegation_denied');
}

export async function adminReparentGroup(
  metadata: DatabaseSource,
  tenant: string,
  auth: Admin,
  id: string,
  parentGroupId: string | null,
  cache?: KVNamespace
) {
  await assertMayReparentGroup(metadata, tenant, auth, id, parentGroupId);
  await updateGroup(metadata, tenant, id, { parentGroupId }, cache);
}

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
  dependentGroups,
  groupReferencedByPolicyRules,
  groupRoleGrantConflictsWithDenyRules,
  type AdminAuthContext,
  type GroupPlan,
  type DatabaseSource,
  type GroupRoleGrant,
  type GroupRoleKey,
  type TransactionContext,
} from '@authrim/ar-lib-core';
import type { KVNamespace } from '@cloudflare/workers-types';
import { mayManageEndUserRole } from './role-delegation';

type Admin = AdminAuthContext | null;

/** The delegation check of a grant: the role-write permission and the grant ceiling. */
export function assertDelegableRole(auth: Admin, role: { grant_tier: number }) {
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
  if (
    await groupRoleGrantConflictsWithDenyRules(
      ensureDatabaseAdapter(metadata),
      tenant,
      grant.groupId,
      role.name
    )
  )
    throw new Error('dynamic_group_negative_condition');
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

/**
 * Whether the admin may change who is a member of the group. A group carries authorization when
 * it or an ancestor has an unexpired role grant, an active, unexpired resource permission
 * granted to it (`subject_type = 'group'`) or an unexpired ReBAC group tuple
 * (`relationships.from_type = 'group'` with `from_relation = 'member'`, as role-guard's
 * groupsCarryingRoles counts it; a legacy row without it is inert), or is named by a group
 * condition of an enabled policy
 * rule (role-guard's groupReferencedByPolicyRules): a member gets that authorization (or, for
 * `not_in_any_group`, a non-member does), so changing the membership, adding or removing, needs
 * what granting it directly needs (the role-write permission, which the resource permissions and
 * policy rule APIs also require, and the grant ceiling of every role).
 *
 * Include dormant groups: restoring their active state could expose an already delegated role.
 */
export async function canManageGroupMembership(
  metadata: Pick<TransactionContext, 'query'>,
  tenant: string,
  auth: Admin,
  groupId: string
) {
  // A member of this group is, through member(<group>) conditions, also a member of every
  // service group whose rule references it, transitively (as a service-group save checks it):
  // the change needs the standing for each of those too.
  const groups = await groupsReachedByMembership(metadata, tenant, groupId);
  if (!groups) return false;
  for (const id of groups) {
    if (!(await canManageOneGroupMembership(metadata, tenant, auth, id))) return false;
  }
  return true;
}

/**
 * The group and every service group whose membership depends on it (`dependentGroups` of the
 * tenant's saved catalog). Null when the catalog cannot be read: no change is allowed on a guess.
 */
async function groupsReachedByMembership(
  metadata: Pick<TransactionContext, 'query'>,
  tenant: string,
  groupId: string
): Promise<Set<string> | null> {
  const [catalog] = await metadata.query<{ plan_json?: unknown }>(
    'SELECT plan_json FROM service_group_catalog WHERE tenant_id = ?',
    [tenant]
  );
  if (typeof catalog?.plan_json !== 'string') return new Set([groupId]);
  let plan: GroupPlan;
  try {
    plan = JSON.parse(catalog.plan_json) as GroupPlan;
  } catch {
    return null;
  }
  if (!plan || typeof plan !== 'object' || typeof plan.dependents !== 'object') return null;
  return dependentGroups(plan, [groupId]);
}

async function canManageOneGroupMembership(
  metadata: Pick<TransactionContext, 'query'>,
  tenant: string,
  auth: Admin,
  groupId: string
) {
  const now = Math.floor(Date.now() / 1000);
  const grants = await metadata.query<{
    kind: string;
    grant_tier: number | null;
  }>(
    `WITH RECURSIVE ancestors(id, parent_group_id) AS (
      SELECT id, parent_group_id FROM "groups" WHERE tenant_id=? AND id=?
      UNION SELECT g.id, g.parent_group_id FROM "groups" g JOIN ancestors a ON g.id=a.parent_group_id
      WHERE g.tenant_id=?
    ) SELECT DISTINCT 'role' AS kind, r.grant_tier AS grant_tier FROM ancestors a
      JOIN group_role_assignments g ON g.group_id=a.id AND g.tenant_id=?
      JOIN roles r ON r.id=g.role_id AND r.tenant_id=g.tenant_id
      WHERE g.expires_at IS NULL OR g.expires_at>?
    UNION
    SELECT DISTINCT 'resource_permission' AS kind, NULL AS grant_tier FROM ancestors a
      JOIN resource_permissions p
        ON p.subject_type='group' AND p.subject_id=a.id AND p.tenant_id=?
      WHERE p.is_active=1 AND (p.expires_at IS NULL OR p.expires_at>?)
    UNION
    SELECT DISTINCT 'relationship' AS kind, NULL AS grant_tier FROM ancestors a
      JOIN relationships t
        ON t.from_type='group' AND t.from_relation='member' AND t.from_id=a.id AND t.tenant_id=?
      WHERE t.expires_at IS NULL OR t.expires_at>?`,
    [tenant, groupId, tenant, tenant, now, tenant, now, tenant, now]
  );
  // A policy rule carries no grant tier: the role-write permission, which editing it needs, is
  // what changing who it matches needs.
  const referenced = await groupReferencedByPolicyRules(metadata, tenant, groupId);
  if (!grants.length && !referenced) return true;
  // Adding a member to a group that carries authorization grants it: the same operation
  // permission as a direct grant is required, on top of the grant ceiling of every role.
  if (!auth || !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.ROLES_WRITE))
    return false;
  // A resource permission or a ReBAC group userset carries no grant tier: the permission above
  // is all it needs.
  return grants.every(
    (grant) =>
      grant.kind === 'resource_permission' ||
      grant.kind === 'relationship' ||
      mayManageEndUserRole(auth, { grant_tier: Number(grant.grant_tier) })
  );
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

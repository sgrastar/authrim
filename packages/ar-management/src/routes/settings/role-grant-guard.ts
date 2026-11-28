import type { Context } from 'hono';
import {
  rbacIdBatches,
  ROLE_TIER_BELOW_WILDCARD,
  roleTierCoversWildcards,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { getAdminAuth } from '../../admin-tenant-access';
import {
  assertDelegableRole,
  canManageGroupMembership,
  isRoleAssignable,
} from '../../group-role-management';

/**
 * The delegation check of a setting that grants roles later, without an administrator (a JIT
 * role assignment rule): the administrator saving it must be allowed to grant each role directly
 * (`admin:roles:write` and the role's grant tier within their ceiling). A response to return (400: the role is not the tenant's,
 * 403: `role_delegation_denied`), or null when every role may be delegated.
 */
export async function refuseUndelegableRoles(
  c: Context,
  metadata: DatabaseAdapter,
  tenantId: string,
  roleIds: Iterable<string | null | undefined>
): Promise<Response | null> {
  const auth = getAdminAuth(c as Context<{ Bindings: Env }>) ?? null;
  const ids = [
    ...new Set([...roleIds].filter((id): id is string => typeof id === 'string' && !!id)),
  ];
  if (!ids.length) return null;
  // Read in batches of 90 (D1 binds at most 100 values per statement).
  const roles = new Map<
    string,
    {
      id: string;
      grant_tier: number;
      is_assignable: number | boolean | null;
      permissions_json: string;
    }
  >();
  for (const batch of rbacIdBatches(ids)) {
    const rows = await metadata.query<{
      id: string;
      grant_tier: number;
      is_assignable: number | boolean | null;
      permissions_json: string;
    }>(
      `SELECT id, grant_tier, is_assignable, permissions_json FROM roles
        WHERE tenant_id = ? AND id IN (${batch.map(() => '?').join(', ')})`,
      [tenantId, ...batch]
    );
    for (const row of rows) roles.set(row.id, row);
  }
  for (const roleId of ids) {
    const role = roles.get(roleId);
    if (!role)
      return c.json(
        { error: 'invalid_request', error_description: `Role ${roleId} not found` },
        400
      );
    // A role that cannot be assigned is refused as a direct grant of it is (403).
    if (!isRoleAssignable(role))
      return c.json(
        { error: 'role_not_assignable', error_description: `Role ${roleId} cannot be assigned` },
        403
      );
    // A role below the tier its wildcards need is not given later either (409).
    if (!roleTierCoversWildcards(role))
      return c.json(
        {
          error: ROLE_TIER_BELOW_WILDCARD,
          error_description: `Role ${roleId} holds a wildcard its grant_tier does not allow`,
        },
        409
      );
    try {
      assertDelegableRole(auth, role);
    } catch {
      return c.json(
        {
          error: 'role_delegation_denied',
          error_description: `The administrator may not delegate role ${roleId}`,
        },
        403
      );
    }
  }
  return null;
}

/**
 * The same check for the groups a setting joins later without an administrator (a JIT role
 * assignment rule's `join_group` actions): each group must be the tenant's, and the administrator
 * saving it must be allowed to add a member to it (a group carrying roles grants them, so the
 * grant ceiling of every role it and its ancestors carry). A response to return (400: the group is
 * not the tenant's, 403: `role_delegation_denied`), or null.
 */
export async function refuseUndelegableGroupJoins(
  c: Context,
  metadata: DatabaseAdapter,
  tenantId: string,
  groupIds: Iterable<string>
): Promise<Response | null> {
  const auth = getAdminAuth(c as Context<{ Bindings: Env }>) ?? null;
  for (const groupId of new Set(groupIds)) {
    const group = await metadata.queryOne<{ id: string }>(
      'SELECT id FROM "groups" WHERE tenant_id = ? AND id = ?',
      [tenantId, groupId]
    );
    if (!group)
      return c.json(
        { error: 'invalid_request', error_description: `Group ${groupId} not found` },
        400
      );
    if (!(await canManageGroupMembership(metadata, tenantId, auth, groupId)))
      return c.json(
        {
          error: 'role_delegation_denied',
          error_description: `The administrator may not add members to group ${groupId}`,
        },
        403
      );
  }
  return null;
}

/** The groups a rule's `join_group` actions join. */
export function actionGroupIds(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action: unknown) =>
    action &&
    typeof action === 'object' &&
    (action as { type?: unknown }).type === 'join_group' &&
    typeof (action as { group_id?: unknown }).group_id === 'string'
      ? [(action as { group_id: string }).group_id]
      : []
  );
}

/** The roles a rule's actions assign. */
export function actionRoleIds(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action: unknown) =>
    action &&
    typeof action === 'object' &&
    typeof (action as { role_id?: unknown }).role_id === 'string'
      ? [(action as { role_id: string }).role_id]
      : []
  );
}

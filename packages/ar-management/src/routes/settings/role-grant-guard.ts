import type { Context } from 'hono';
import { rbacIdBatches, type DatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { getAdminAuth } from '../../admin-tenant-access';
import { assertDelegableRole, isRoleAssignable } from '../../group-role-management';

/**
 * The delegation check of a setting that grants roles later, without an administrator (a JIT
 * role assignment rule, a domain mapping's automatic role): the administrator saving it must be
 * allowed to grant each role directly (`admin:roles:write` and the role's grant tier within
 * their ceiling, below their level). A response to return (400: the role is not the tenant's,
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
      hierarchy_level: number | null;
      is_assignable: number | boolean | null;
    }
  >();
  for (const batch of rbacIdBatches(ids)) {
    const rows = await metadata.query<{
      id: string;
      grant_tier: number;
      hierarchy_level: number | null;
      is_assignable: number | boolean | null;
    }>(
      `SELECT id, grant_tier, hierarchy_level, is_assignable FROM roles
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

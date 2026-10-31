/**
 * The platform administrator is kept in the same way as the tenant administrator
 * (`last-tenant-admin.ts`): a count read before a change does not stop two requests that each
 * leave "one other" from removing both, so the change carries the count as a condition of its
 * own statement (`AdminWriteGuard`) as well.
 */

import type { Context } from 'hono';
import {
  ADMIN_GUARD_NOW_MS,
  ADMIN_ROLES,
  type AdminWriteGuard,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

/** A role given as SQL: the ID itself, or a sub-select that finds it. */
interface RoleRef {
  sql: string;
  params: unknown[];
}

/** The standard platform role, which is the system role of the `default` tenant. */
const PLATFORM_ROLE: RoleRef = {
  sql: "(SELECT id FROM admin_roles WHERE tenant_id = 'default' AND name = ? AND is_system = 1 LIMIT 1)",
  params: [ADMIN_ROLES.SUPER_ADMIN],
};

/**
 * The count of active accounts holding a role, as a SELECT. `globalOnly` counts the global
 * assignments alone, which is how the platform role is held.
 */
function activeRoleHolders(
  tenantId: string,
  role: RoleRef,
  globalOnly: boolean,
  clock: 'request' | 'database' = 'request'
): { sql: string; params: unknown[] } {
  // A guard is decided when the write runs, so it reads the clock there, not the request's.
  const now = clock === 'database' ? ADMIN_GUARD_NOW_MS : '?';
  return {
    sql: `SELECT COUNT(DISTINCT au.id) AS count
     FROM admin_role_assignments ra
     JOIN admin_users au
       ON au.id = ra.admin_user_id
      AND au.tenant_id = ra.tenant_id
     WHERE ra.tenant_id = ?
       AND ra.admin_role_id = ${role.sql}
       ${globalOnly ? "AND ra.scope_type = 'global'" : ''}
       AND au.is_active = 1
       AND au.status = 'active'
       AND (ra.expires_at IS NULL OR ra.expires_at > ${now})`,
    params: [tenantId, ...role.params, ...(clock === 'request' ? [Date.now()] : [])],
  };
}

export async function countActiveRoleHolders(
  adapter: DatabaseAdapter,
  tenantId: string,
  roleId: string,
  globalOnly: boolean
): Promise<number> {
  const { sql, params } = activeRoleHolders(tenantId, { sql: '?', params: [roleId] }, globalOnly);
  const row = await adapter.queryOne<{ count: number }>(sql, params);
  return Number(row?.count ?? 0);
}

/** Holds while more than one active account holds the role, so one can go and one remains. */
export function roleKeepsHolderGuard(
  tenantId: string,
  roleId: string,
  globalOnly: boolean
): AdminWriteGuard {
  const holders = activeRoleHolders(
    tenantId,
    { sql: '?', params: [roleId] },
    globalOnly,
    'database'
  );
  return { sql: `(${holders.sql}) > 1`, params: holders.params };
}

/**
 * Holds unless the account is a current platform administrator and the last one: an account that
 * is not one, or a deployment without the platform role, is not stopped.
 */
export function platformAdminKeptGuard(tenantId: string, adminUserId: string): AdminWriteGuard {
  const holders = activeRoleHolders(tenantId, PLATFORM_ROLE, true, 'database');
  return {
    sql: `NOT EXISTS (
        SELECT 1
          FROM admin_role_assignments ra
          JOIN admin_roles r
            ON r.id = ra.admin_role_id
           AND (r.tenant_id = ra.tenant_id OR (r.tenant_id = 'default' AND r.is_system = 1))
         WHERE ra.tenant_id = ?
           AND ra.admin_user_id = ?
           AND r.name = ?
           AND ra.scope_type = 'global'
           AND (ra.expires_at IS NULL OR ra.expires_at > ${ADMIN_GUARD_NOW_MS})
      )
      OR ${PLATFORM_ROLE.sql} IS NULL
      OR (${holders.sql}) > 1`,
    params: [
      tenantId,
      adminUserId,
      ADMIN_ROLES.SUPER_ADMIN,
      ...PLATFORM_ROLE.params,
      ...holders.params,
    ],
  };
}

/** The 409 answer for an operation that would take the last platform administrator away. */
export function lastPlatformAdminResponse(c: Context, change: 'role' | 'account'): Response {
  return c.json(
    {
      error: 'last_platform_admin',
      error_description: `At least one active platform administrator must remain. Assign another platform administrator before ${
        change === 'role' ? 'removing this role' : 'changing this account'
      }.`,
    },
    409
  );
}

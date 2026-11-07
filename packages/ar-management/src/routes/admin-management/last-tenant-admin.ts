/**
 * A tenant must keep an administrator.
 *
 * Taking the last active `ar_tenant_admin` of a tenant away (removing the assignment, suspending
 * or deleting the account) would leave the tenant with nobody who can manage its admins, so it is
 * refused with 409 `last_tenant_admin`. Only the tenant's own administrators count: the
 * assignments of the tenant (`scope_type = 'tenant'`) and the global ones held by an account of
 * the tenant, held by the account itself or through one of its admin groups
 * (`admin_effective_role_assignments`). An administrator of another tenant does not. Two things are kept: the tenant must
 * not be left without a current administrator, and, when it has a permanent one, it must not be
 * left without a permanent one, because an assignment that has an expiry ends by itself. Giving a
 * permanent assignment an expiry is therefore held to the same rule as removing it.
 *
 * It does not apply when the tenant itself is removed; that has its own lifecycle.
 */

import type { Context } from 'hono';
import {
  ADMIN_GUARD_NOW_MS,
  ADMIN_ROLES,
  allOfGuards,
  type AdminWriteGuard,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

export type LastTenantAdminExclusion =
  /**
   * One assignment is going away, or, with `stillCurrent`, only ceasing to be permanent: it
   * stays an administrator until its (future) expiry.
   */
  | {
      assignmentId: string;
      stillCurrent?: boolean;
      /**
       * The expiry the assignment is given. A write guard reckons with it against the clock of
       * the database when the write runs, instead of taking `stillCurrent` as it was at the request.
       */
      newExpiresAt?: number;
    }
  /** An account is going away (suspended, deleted): every assignment it holds, own or group. */
  | { adminUserId: string }
  /** An account loses the role under every scope it holds it itself; its groups' stay. */
  | { adminUserId: string; directOnly: true }
  /** A member leaves a group: what came to them through that membership. */
  | { groupMemberId: string }
  /**
   * A group's grant goes away, or, with `newExpiresAt`, is given an expiry: what every member
   * holds through it.
   */
  | { groupGrantId: string; newExpiresAt?: number }
  /** A group goes away: everything its members hold through it. */
  | { adminGroupId: string };

/** The SQL that leaves `exclusion` out of the count, with its parameter. */
function exclusionClause(exclusion: LastTenantAdminExclusion): { sql: string; param: string } {
  if ('assignmentId' in exclusion) {
    return { sql: 'AND ra.id <> ?', param: exclusion.assignmentId };
  }
  if ('groupMemberId' in exclusion) {
    // A direct assignment has no membership (NULL) and always stays.
    return {
      sql: 'AND (ra.group_member_id IS NULL OR ra.group_member_id <> ?)',
      param: exclusion.groupMemberId,
    };
  }
  if ('groupGrantId' in exclusion) {
    return {
      sql: 'AND (ra.group_grant_id IS NULL OR ra.group_grant_id <> ?)',
      param: exclusion.groupGrantId,
    };
  }
  if ('adminGroupId' in exclusion) {
    return {
      sql: 'AND (ra.admin_group_id IS NULL OR ra.admin_group_id <> ?)',
      param: exclusion.adminGroupId,
    };
  }
  if ('directOnly' in exclusion) {
    return {
      sql: "AND NOT (ra.source = 'direct' AND ra.admin_user_id = ?)",
      param: exclusion.adminUserId,
    };
  }
  return { sql: 'AND au.id <> ?', param: exclusion.adminUserId };
}

/** The expiry an exclusion gives what it covers, when it is not taken away but shortened. */
function exclusionNewExpiry(exclusion: LastTenantAdminExclusion): number | undefined {
  if ('assignmentId' in exclusion || 'groupGrantId' in exclusion) {
    return exclusion.newExpiresAt;
  }
  return undefined;
}

/** The count of the tenant's administrators as a SELECT, with the parameters it binds. */
function tenantAdminCount(
  tenantId: string,
  permanentOnly: boolean,
  exclusion?: LastTenantAdminExclusion,
  clock: 'request' | 'database' = 'request'
): { sql: string; params: unknown[] } {
  const params: unknown[] = [tenantId, ADMIN_ROLES.TENANT_ADMIN, tenantId];
  // A permanent assignment has no expiry; otherwise any assignment that has not ended counts.
  let lifetime = 'AND ra.expires_at IS NULL';
  if (!permanentOnly) {
    // A guard is decided when the write runs, so it reads the clock there, not the request's.
    lifetime =
      clock === 'database'
        ? `AND (ra.expires_at IS NULL OR ra.expires_at > ${ADMIN_GUARD_NOW_MS})`
        : 'AND (ra.expires_at IS NULL OR ra.expires_at > ?)';
    if (clock === 'request') {
      params.push(Date.now());
    }
  }
  let exclude = '';
  if (exclusion) {
    const clause = exclusionClause(exclusion);
    exclude = clause.sql;
    params.push(clause.param);
  }
  return {
    sql: `SELECT COUNT(DISTINCT au.id) AS count
       FROM admin_effective_role_assignments ra
       JOIN admin_roles r
         ON r.id = ra.admin_role_id
        AND (r.tenant_id = ra.tenant_id OR (r.tenant_id = 'default' AND r.is_system = 1))
       JOIN admin_users au
         ON au.id = ra.admin_user_id
        AND au.tenant_id = ra.tenant_id
      WHERE ra.tenant_id = ?
        AND r.name = ?
        AND (
          ra.scope_type = 'global'
          OR (ra.scope_type = 'tenant' AND (ra.scope_id = ? OR ra.scope_id IS NULL))
        )
        AND au.is_active = 1
        AND au.status = 'active'
        ${lifetime}
        ${exclude}`,
    params,
  };
}

async function countTenantAdmins(
  adapter: DatabaseAdapter,
  tenantId: string,
  permanentOnly: boolean,
  exclusion?: LastTenantAdminExclusion
): Promise<number> {
  const { sql, params } = tenantAdminCount(tenantId, permanentOnly, exclusion);
  const row = await adapter.queryOne<{ count: number }>(sql, params);
  return Number(row?.count ?? 0);
}

/**
 * The same rule as `wouldLeaveNoTenantAdmin`, as a condition on the write itself: it holds while
 * the tenant would still have a current administrator, and a permanent one if it has one now,
 * once `exclusion` is taken away. Put in the `WHERE` of the statement that makes the change, the
 * database decides it atomically, so two requests that each leave "one other administrator" do
 * not both go through.
 */
export function tenantKeepsAdminGuard(
  tenantId: string,
  exclusion: LastTenantAdminExclusion
): AdminWriteGuard {
  const stillCurrent = 'assignmentId' in exclusion && exclusion.stillCurrent === true;
  const keeps = (permanentOnly: boolean): AdminWriteGuard => {
    const others = tenantAdminCount(tenantId, permanentOnly, exclusion, 'database');
    const all = tenantAdminCount(tenantId, permanentOnly, undefined, 'database');
    return {
      sql: `(${others.sql}) >= 1 OR (${all.sql}) = 0`,
      params: [...others.params, ...all.params],
    };
  };
  const newExpiresAt = exclusionNewExpiry(exclusion);
  let current: AdminWriteGuard | undefined;
  if (newExpiresAt !== undefined) {
    // What it covers stays an administrator only while its new expiry is still to come, which
    // is the database's call when the write runs.
    const others = keeps(false);
    current = {
      sql: `? > ${ADMIN_GUARD_NOW_MS} OR ${others.sql}`,
      params: [newExpiresAt, ...others.params],
    };
  } else if (!stillCurrent) {
    current = keeps(false);
  }
  // The tenant must keep a current administrator, and a permanent one if it has one now.
  return allOfGuards(current, keeps(true)) ?? { sql: '1 = 1', params: [] };
}

/**
 * Whether taking `exclusion` away would leave the tenant without an active `ar_tenant_admin`. A
 * tenant that has none already, or an exclusion that is not one of them, is not stopped here.
 */
export async function wouldLeaveNoTenantAdmin(
  adapter: DatabaseAdapter,
  tenantId: string,
  exclusion: LastTenantAdminExclusion
): Promise<boolean> {
  // The tenant must not end up with nobody at all. What is only given an expiry (still to come)
  // stays an administrator until then.
  const newExpiry = exclusionNewExpiry(exclusion);
  const stillCurrent =
    ('assignmentId' in exclusion && exclusion.stillCurrent === true) ||
    (newExpiry !== undefined && newExpiry > Date.now());
  if (!stillCurrent && (await countTenantAdmins(adapter, tenantId, false, exclusion)) === 0) {
    if ((await countTenantAdmins(adapter, tenantId, false)) > 0) {
      return true;
    }
  }
  // A permanent administrator must not be replaced by ones that expire.
  if ((await countTenantAdmins(adapter, tenantId, true, exclusion)) === 0) {
    return (await countTenantAdmins(adapter, tenantId, true)) > 0;
  }
  return false;
}

/** The 409 answer for an operation that would take the last tenant administrator away. */
export function lastTenantAdminResponse(c: Context): Response {
  return c.json(
    {
      error: 'last_tenant_admin',
      error_description:
        'At least one active tenant administrator must remain. Assign another tenant administrator before changing this account or role.',
    },
    409
  );
}

/** Returns the 409 answer when `exclusion` would leave the tenant without an administrator. */
export async function ensureTenantKeepsAdmin(
  c: Context,
  adapter: DatabaseAdapter,
  tenantId: string,
  exclusion: LastTenantAdminExclusion
): Promise<Response | null> {
  return (await wouldLeaveNoTenantAdmin(adapter, tenantId, exclusion))
    ? lastTenantAdminResponse(c)
    : null;
}

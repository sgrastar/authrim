/**
 * A tenant must keep an administrator.
 *
 * Taking the last active `ar_tenant_admin` of a tenant away (removing the assignment, suspending
 * or deleting the account) would leave the tenant with nobody who can manage its admins, so it is
 * refused with 409 `last_tenant_admin`. Only the tenant's own administrators count: the
 * assignments of the tenant (`scope_type = 'tenant'`) and the global ones held by an account of
 * the tenant. An administrator of another tenant does not. Two things are kept: the tenant must
 * not be left without a current administrator, and, when it has a permanent one, it must not be
 * left without a permanent one, because an assignment that has an expiry ends by itself. Giving a
 * permanent assignment an expiry is therefore held to the same rule as removing it.
 *
 * It does not apply when the tenant itself is removed; that has its own lifecycle.
 */

import type { Context } from 'hono';
import { ADMIN_ROLES, type DatabaseAdapter } from '@authrim/ar-lib-core';

export type LastTenantAdminExclusion =
  /**
   * One assignment is going away, or, with `stillCurrent`, only ceasing to be permanent: it
   * stays an administrator until its (future) expiry.
   */
  | { assignmentId: string; stillCurrent?: boolean }
  /** An account is going away (suspended, deleted) or loses the role under every scope. */
  | { adminUserId: string };

async function countTenantAdmins(
  adapter: DatabaseAdapter,
  tenantId: string,
  permanentOnly: boolean,
  exclusion?: LastTenantAdminExclusion
): Promise<number> {
  const params: unknown[] = [tenantId, ADMIN_ROLES.TENANT_ADMIN, tenantId];
  // A permanent assignment has no expiry; otherwise any assignment that has not ended counts.
  let lifetime = 'AND ra.expires_at IS NULL';
  if (!permanentOnly) {
    lifetime = 'AND (ra.expires_at IS NULL OR ra.expires_at > ?)';
    params.push(Date.now());
  }
  let exclude = '';
  if (exclusion && 'assignmentId' in exclusion) {
    exclude = 'AND ra.id <> ?';
    params.push(exclusion.assignmentId);
  } else if (exclusion) {
    exclude = 'AND au.id <> ?';
    params.push(exclusion.adminUserId);
  }
  const row = await adapter.queryOne<{ count: number }>(
    `SELECT COUNT(DISTINCT au.id) AS count
       FROM admin_role_assignments ra
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
    params
  );
  return Number(row?.count ?? 0);
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
  // The tenant must not end up with nobody at all.
  const stillCurrent = 'assignmentId' in exclusion && exclusion.stillCurrent === true;
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

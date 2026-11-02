/**
 * Admin credential eligibility
 *
 * Whether an administrator may hold an Authrim admin credential for their home tenant. Used when
 * an offer is created (ar-management) and again right before the credential is signed (ar-vc,
 * through ar-management's AdminCredentialEligibilityEntrypoint), so both decisions share one
 * predicate.
 */

import type { DatabaseAdapter } from '../db/adapter';

export interface AdminCredentialEligibility {
  eligible: boolean;
  /** Present when eligible; the claims the credential carries. */
  email?: string;
  name?: string | null;
}

interface EligibilityUserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string | null;
  is_active: number;
  status: string;
  locked_until: number | null;
}

/**
 * Evaluate eligibility in the admin's home tenant: an active, unlocked admin with at least one
 * non-expired role assignment effective in that tenant. The assignment predicate is the one Admin
 * session authentication applies (`middleware/admin-auth.ts`); expiry is compared in
 * milliseconds, as assignments are written.
 */
export async function evaluateAdminCredentialEligibility(
  adminAdapter: DatabaseAdapter,
  input: { tenantId: string; adminUserId: string; now: number }
): Promise<AdminCredentialEligibility> {
  const user = await adminAdapter.queryOne<EligibilityUserRow>(
    `SELECT id, tenant_id, email, name, is_active, status, locked_until
       FROM admin_users
      WHERE id = ? AND tenant_id = ?`,
    [input.adminUserId, input.tenantId]
  );
  if (
    !user ||
    user.is_active !== 1 ||
    user.status !== 'active' ||
    (typeof user.locked_until === 'number' && user.locked_until > input.now)
  ) {
    return { eligible: false };
  }

  const assignment = await adminAdapter.queryOne<{ id: string }>(
    `SELECT ra.id
       FROM admin_role_assignments ra
       JOIN admin_roles r ON ra.admin_role_id = r.id
      WHERE ra.admin_user_id = ?
        AND ra.tenant_id = ?
        AND (r.tenant_id = ? OR (r.tenant_id = 'default' AND r.is_system = 1))
        AND (
          ra.scope_type = 'global'
          OR (
            ra.scope_type = 'tenant'
            AND (ra.scope_id = ? OR ra.scope_id IS NULL)
          )
        )
        AND (ra.expires_at IS NULL OR ra.expires_at > ?)
      LIMIT 1`,
    [input.adminUserId, input.tenantId, input.tenantId, input.tenantId, input.now]
  );
  if (!assignment) return { eligible: false };

  return { eligible: true, email: user.email, name: user.name };
}

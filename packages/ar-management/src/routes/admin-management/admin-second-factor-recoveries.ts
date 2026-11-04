/**
 * Admin second-factor recoveries (the other administrators' side)
 *
 * The tenant's administrators see the open recovery requests of the tenant's admins and can cancel
 * one during its waiting period. Cancelling stops a change, so it needs the admin-users write
 * permission and a fresh passkey, not a step-up receipt: an administrator who has not registered a
 * second factor yet must still be able to stop a request they did not expect.
 *
 * Endpoints:
 * - GET  /api/admin/admin-second-factor-recoveries            - Open requests in the tenant
 * - POST /api/admin/admin-second-factor-recoveries/:id/cancel - Cancel one
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AdminSecondFactorRecoveryRepository,
  adminAuthMiddleware,
  createErrorResponse,
  evaluateAdminStepUpEvidence,
  getLogger,
  getTenantIdFromContext,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { refuseAdminFreshAuth } from '../../admin-step-up-gate';
import { presentRecovery } from './my-second-factor-recovery';
import { sendRecoveryNoticeAfterCommit } from './second-factor-recovery-notice';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

export const adminSecondFactorRecoveriesRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Permissions are enforced by the route access rules (admin users read / write).
adminSecondFactorRecoveriesRouter.use('*', adminAuthMiddleware({}));

function recoveriesLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-SF-RECOVERY');
}

function adminAdapter(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

async function emailsOf(
  adapter: DatabaseAdapter,
  adminUserIds: string[]
): Promise<Map<string, string>> {
  if (adminUserIds.length === 0) return new Map();
  const rows = await adapter.query<{ id: string; email: string }>(
    `SELECT id, email FROM admin_users WHERE id IN (${adminUserIds.map(() => '?').join(', ')})`,
    adminUserIds
  );
  return new Map(rows.map((row) => [row.id, row.email]));
}

/**
 * GET /api/admin/admin-second-factor-recoveries
 */
adminSecondFactorRecoveriesRouter.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const adapter = adminAdapter(c);
    const recoveries = await new AdminSecondFactorRecoveryRepository(adapter).listOpenByTenant(
      getTenantIdFromContext(c),
      Date.now()
    );
    const emails = await emailsOf(adapter, [
      ...new Set(recoveries.map((recovery) => recovery.admin_user_id)),
    ]);
    return c.json({
      items: recoveries.map((recovery) => ({
        ...presentRecovery(recovery),
        admin_user_id: recovery.admin_user_id,
        admin_email: emails.get(recovery.admin_user_id) ?? null,
      })),
    });
  } catch (error) {
    recoveriesLog(c).error('Failed to list second-factor recovery requests', {
      action: 'admin_second_factor_recovery_list',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-second-factor-recoveries/:id/cancel
 */
adminSecondFactorRecoveriesRouter.post('/:id/cancel', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('adminAuth');
  if (!auth || !isAdminStepUpHumanSession(auth)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }
  const now = Date.now();
  if (evaluateAdminStepUpEvidence(auth, 'L1', now).missing.length > 0) {
    return refuseAdminFreshAuth(c);
  }

  try {
    const adapter = adminAdapter(c);
    const repo = new AdminSecondFactorRecoveryRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const recovery = await repo.findById(c.req.param('id'));
    if (
      !recovery ||
      recovery.tenant_id !== tenantId ||
      !(await repo.cancel(
        recovery.id,
        { tenantId },
        { adminUserId: auth.userId, reason: 'admin' },
        now
      ))
    ) {
      return c.json({ error: 'not_found', error_description: 'No open recovery request' }, 404);
    }

    // The cancellation took effect; a failure to notify must not hide that or skip the audit.
    try {
      const requesterEmail = (await emailsOf(adapter, [recovery.admin_user_id])).get(
        recovery.admin_user_id
      );
      if (requesterEmail) {
        await sendRecoveryNoticeAfterCommit(c.env, adapter, {
          event: 'cancelled',
          recovery: { ...recovery, status: 'cancelled', cancelled_at: now },
          requester: { id: recovery.admin_user_id, email: requesterEmail },
          now,
        });
      }
    } catch {
      recoveriesLog(c).warn('Second-factor recovery cancellation notice was not sent', {
        action: 'admin_second_factor_recovery_notice',
      });
    }
    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.recovery_cancelled',
      resourceType: 'admin_second_factor_recovery',
      resourceId: recovery.id,
      result: 'success',
      metadata: { reason: 'admin', requester_id: recovery.admin_user_id },
    });
    return c.json({ cancelled: true });
  } catch (error) {
    recoveriesLog(c).error('Failed to cancel a second-factor recovery request', {
      action: 'admin_second_factor_recovery_cancel_by_admin',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

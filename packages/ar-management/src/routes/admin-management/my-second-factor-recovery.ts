/**
 * Admin second-factor recovery (the requester's side)
 *
 * An admin who lost their step-up second factors registers a new device-bound credential with a
 * fresh passkey (`POST /api/admin/me/second-factors/webauthn/options|verify` with
 * `purpose: 'recovery'`). That files a request instead of a factor. The admin and the tenant's
 * administrators are emailed; any of them can cancel it during the 24-hour wait. Afterwards the
 * admin completes it with a fresh passkey again, which revokes every old factor, makes the new
 * credential their second factor and ends their other sessions.
 *
 * A request is refused when the admin is the only one in the whole system (nobody could cancel
 * it; the last-resort recovery applies) or when email cannot be delivered (nobody would know).
 *
 * (A prefix of its own, so the second-factors router's middleware does not run again here.)
 *
 * Endpoints:
 * - GET  /api/admin/me/second-factor-recovery          - The admin's open request, if any
 * - POST /api/admin/me/second-factor-recovery/complete - Complete it after the wait
 * - POST /api/admin/me/second-factor-recovery/cancel   - Cancel it
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminSecondFactorRecovery,
  DatabaseAdapter,
  Env,
} from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AdminSecondFactorRecoveryRepository,
  adminAuthMiddleware,
  createErrorResponse,
  evaluateAdminStepUpEvidence,
  getLogger,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { refuseAdminFreshAuth } from '../../admin-step-up-gate';
import {
  recoveryNoticeAvailable,
  sendRecoveryNotice,
  sendRecoveryNoticeAfterCommit,
  showRecoveryInConsole,
} from './second-factor-recovery-notice';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type HumanSession = AdminAuthContext & { sessionId: string; sessionTenantId: string };

export const mySecondFactorRecoveryRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

mySecondFactorRecoveryRouter.use('*', adminAuthMiddleware({}));

function setNoStore(c: AdminContext): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function humanSession(auth: AdminAuthContext | undefined): HumanSession | null {
  if (!auth || !isAdminStepUpHumanSession(auth) || !auth.sessionTenantId) return null;
  return auth as HumanSession;
}

function recoveryLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-SF-RECOVERY');
}

function adminAdapter(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

export function presentRecovery(recovery: AdminSecondFactorRecovery) {
  return {
    id: recovery.id,
    status: recovery.status,
    label: recovery.label,
    aaguid: recovery.aaguid,
    requested_at: recovery.requested_at,
    not_before: recovery.not_before,
    expires_at: recovery.expires_at,
  };
}

/** Whether anyone other than this admin is an active administrator anywhere. */
async function hasAnotherAdmin(adapter: DatabaseAdapter, adminUserId: string): Promise<boolean> {
  const row = await adapter.queryOne<{ id: string }>(
    `SELECT id FROM admin_users
      WHERE id <> ? AND is_active = 1 AND status = 'active' LIMIT 1`,
    [adminUserId]
  );
  return row !== null;
}

/**
 * The checks before registration options are issued for a recovery request. Returns the refusal,
 * or null when the admin may go ahead.
 */
export async function refuseRecoveryRequest(
  c: AdminContext,
  auth: HumanSession,
  adapter: DatabaseAdapter,
  now: number
): Promise<Response | null> {
  if (evaluateAdminStepUpEvidence(auth, 'L1', now).missing.length > 0) {
    return refuseAdminFreshAuth(c);
  }
  if (!(await hasAnotherAdmin(adapter, auth.userId))) {
    return c.json(
      {
        error: 'recovery_requires_last_resort',
        error_description:
          'You are the only administrator; recover with the environment owner procedure',
      },
      403
    );
  }
  if (await new AdminSecondFactorRecoveryRepository(adapter).findOpenByUser(auth.userId, now)) {
    return c.json(
      { error: 'recovery_pending', error_description: 'A recovery request is already open' },
      409
    );
  }
  if (!auth.email || !(await recoveryNoticeAvailable(c.env, auth.sessionTenantId))) {
    return c.json(
      {
        error: 'recovery_notification_unavailable',
        error_description: 'Email delivery is required to notify administrators of the request',
      },
      503
    );
  }
  return null;
}

/**
 * File the request for a verified new credential and notify. If any notice cannot be handed to
 * delivery, the request is cancelled again rather than left to wait unseen.
 */
export async function fileRecoveryRequest(
  c: AdminContext,
  auth: HumanSession,
  credential: {
    credential_id: string;
    public_key: string;
    counter: number;
    transports: string[];
    aaguid: string | null;
    label: string | null;
  }
): Promise<Response> {
  const requesterEmail = auth.email;
  if (!requesterEmail) {
    return c.json(
      {
        error: 'recovery_notification_unavailable',
        error_description: 'Email delivery is required to notify administrators of the request',
      },
      503
    );
  }
  try {
    const adapter = adminAdapter(c);
    const repo = new AdminSecondFactorRecoveryRepository(adapter);
    const now = Date.now();
    const result = await repo.create(
      {
        admin_user_id: auth.userId,
        tenant_id: auth.sessionTenantId,
        requested_session_id: auth.sessionId,
        ...credential,
      },
      now
    );
    if (!result.created) {
      return result.reason === 'already_pending'
        ? c.json(
            { error: 'recovery_pending', error_description: 'A recovery request is already open' },
            409
          )
        : c.json(
            {
              error: 'credential_in_use',
              error_description: 'This credential is already registered',
            },
            409
          );
    }

    // Only a request whose notices all went out is marked notified, and only a notified request
    // can be completed: whatever fails here, the request can never complete unseen.
    let noticed = false;
    try {
      noticed =
        (await sendRecoveryNotice(c.env, adapter, {
          event: 'requested',
          recovery: result.recovery,
          requester: { id: auth.userId, email: requesterEmail },
          now,
        })) && (await repo.markNotified(result.recovery.id, Date.now()));
    } catch {
      noticed = false;
    }
    if (!noticed) {
      try {
        await repo.cancel(
          result.recovery.id,
          { adminUserId: auth.userId },
          { adminUserId: auth.userId, reason: 'notification_failed' },
          now
        );
      } catch {
        // Left pending without notified_at: it cannot be completed and the next request closes it.
      }
      return c.json(
        {
          error: 'recovery_notification_failed',
          error_description: 'Administrators could not be notified; the request was withdrawn',
        },
        503
      );
    }

    await showRecoveryInConsole(adapter, 'requested', result.recovery, requesterEmail);
    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.recovery_requested',
      resourceType: 'admin_second_factor_recovery',
      resourceId: result.recovery.id,
      result: 'success',
      metadata: { not_before: result.recovery.not_before },
    });
    return c.json({ recovery: presentRecovery(result.recovery) }, 201);
  } catch (error) {
    recoveryLog(c).error('Failed to file a second-factor recovery request', {
      action: 'admin_second_factor_recovery_request',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/me/second-factor-recovery
 */
mySecondFactorRecoveryRouter.get('/', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const open = await new AdminSecondFactorRecoveryRepository(adminAdapter(c)).findOpenByUser(
      auth.userId,
      Date.now()
    );
    return c.json({ recovery: open ? presentRecovery(open) : null });
  } catch (error) {
    recoveryLog(c).error('Failed to read the second-factor recovery request', {
      action: 'admin_second_factor_recovery_read',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/second-factor-recovery/complete
 */
mySecondFactorRecoveryRouter.post('/complete', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const now = Date.now();
  if (evaluateAdminStepUpEvidence(auth, 'L1', now).missing.length > 0) {
    return refuseAdminFreshAuth(c);
  }

  try {
    const adapter = adminAdapter(c);
    const repo = new AdminSecondFactorRecoveryRepository(adapter);
    const open = await repo.findOpenByUser(auth.userId, now);
    let result;
    try {
      result = await repo.complete(auth.userId, auth.sessionId, now);
    } catch {
      // The new credential was registered elsewhere meanwhile (the batch rolled back).
      return c.json(
        { error: 'credential_in_use', error_description: 'This credential is already registered' },
        409
      );
    }
    if (!result.completed) {
      if (result.reason === 'too_early') {
        return c.json(
          {
            error: 'recovery_waiting',
            error_description: 'The waiting period has not ended',
            not_before: open?.not_before ?? null,
          },
          409
        );
      }
      return c.json({ error: 'not_found', error_description: 'No open recovery request' }, 404);
    }

    if (open) {
      const noticed = await sendRecoveryNoticeAfterCommit(c.env, adapter, {
        event: 'completed',
        recovery: { ...open, status: 'completed', completed_at: now },
        requester: { id: auth.userId, email: auth.email ?? '' },
        now,
      });
      if (!noticed) {
        recoveryLog(c).warn('Second-factor recovery completion notice was not delivered', {
          action: 'admin_second_factor_recovery_notice',
        });
      }
    }
    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.recovery_completed',
      resourceType: 'admin_second_factor_recovery',
      resourceId: open?.id ?? auth.userId,
      result: 'success',
      metadata: { second_factor_id: result.secondFactorId },
    });
    return c.json({ completed: true, second_factor_id: result.secondFactorId });
  } catch (error) {
    recoveryLog(c).error('Failed to complete a second-factor recovery', {
      action: 'admin_second_factor_recovery_complete',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/second-factor-recovery/cancel
 */
mySecondFactorRecoveryRouter.post('/cancel', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const now = Date.now();
  // As for another admin's cancellation and for completion: a fresh passkey, so a session left
  // open cannot quietly withdraw the request.
  if (evaluateAdminStepUpEvidence(auth, 'L1', now).missing.length > 0) {
    return refuseAdminFreshAuth(c);
  }
  try {
    const adapter = adminAdapter(c);
    const repo = new AdminSecondFactorRecoveryRepository(adapter);
    const open = await repo.findOpenByUser(auth.userId, now);
    if (
      !open ||
      !(await repo.cancel(
        open.id,
        { adminUserId: auth.userId },
        { adminUserId: auth.userId, reason: 'requester' },
        now
      ))
    ) {
      return c.json({ error: 'not_found', error_description: 'No open recovery request' }, 404);
    }
    await sendRecoveryNoticeAfterCommit(c.env, adapter, {
      event: 'cancelled',
      recovery: { ...open, status: 'cancelled', cancelled_at: now },
      requester: { id: auth.userId, email: auth.email ?? '' },
      now,
    });
    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.recovery_cancelled',
      resourceType: 'admin_second_factor_recovery',
      resourceId: open.id,
      result: 'success',
      metadata: { reason: 'requester' },
    });
    return c.json({ cancelled: true });
  } catch (error) {
    recoveryLog(c).error('Failed to cancel a second-factor recovery', {
      action: 'admin_second_factor_recovery_cancel',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

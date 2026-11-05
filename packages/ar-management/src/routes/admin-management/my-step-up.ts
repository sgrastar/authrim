/**
 * Admin step-up receipts
 *
 * An operation refused with 403 `step_up_required` returns a `step_up_id`. Once the session's
 * evidence is fresh enough for the operation's level, the admin exchanges it here for a
 * single-use receipt, then repeats the operation with the receipt in `authrim-step-up-receipt`.
 *
 * Endpoints:
 * - GET  /api/admin/me/step-up/requirements - Which operations need L1 or L2 in the selected tenant
 * - POST /api/admin/me/step-up/receipts - Issue the receipt for a step-up request
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_STEP_UP_ALWAYS_ENFORCED,
  ADMIN_STEP_UP_EVIDENCE_WINDOW_MS,
  ADMIN_STEP_UP_OPERATIONS,
  AR_ERROR_CODES,
  AdminSecondFactorRepository,
  AdminStepUpError,
  adminAuthMiddleware,
  createErrorResponse,
  describeAdminStepUpFreshness,
  effectiveAdminStepUpLevel,
  getLogger,
  isAdminStepUpHumanSession,
  issueAdminStepUpReceipt,
  readAdminStepUpPolicy,
  requireDedicatedAdminDatabaseAdapter,
  type AdminStepUpLevel,
  type AdminStepUpOperation,
  type AdminStepUpPolicy,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

export const myStepUpRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// The receipt is for the caller's own session; what it allows is checked by the operation.
myStepUpRouter.use('*', adminAuthMiddleware({}));

function stepUpLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-STEP-UP');
}

/**
 * GET /api/admin/me/step-up/requirements
 *
 * What the console needs to tell an admin, before they act, that an operation will ask for a
 * passkey (L1) or a passkey and a security key (L2): every catalog operation's level in the
 * selected tenant, and how fresh the session's own factors are. A hint only: each operation's
 * gate decides on its own, and an operation that acts on another tenant (its own second factors
 * act on the admin's home tenant) is judged against that tenant's settings.
 */
myStepUpRouter.get('/requirements', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  const auth = c.get('adminAuth');
  if (!auth?.tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }
  // A hint for a signed-in admin's console. Machine and agent callers cannot meet a step-up and
  // have no console to show it in, so they are not shown the tenant's policy either.
  if (!isAdminStepUpHumanSession(auth)) {
    return c.json(
      {
        error: 'step_up_human_required',
        error_description: 'Step-up requirements are for a signed-in admin',
      },
      403
    );
  }

  let policy: AdminStepUpPolicy;
  try {
    policy = await readAdminStepUpPolicy(c.env, auth.tenantId);
  } catch {
    // Same answer as the gate: a level the tenant may have raised is never guessed.
    return c.json(
      {
        error: 'step_up_unavailable',
        error_description: 'The step-up policy could not be read',
      },
      503
    );
  }

  const operations: Record<
    string,
    { level: AdminStepUpLevel; catalog_level: 'L1' | 'L2'; always_enforced: boolean }
  > = {};
  for (const operation of Object.keys(ADMIN_STEP_UP_OPERATIONS) as AdminStepUpOperation[]) {
    operations[operation] = {
      level: effectiveAdminStepUpLevel(operation, policy),
      catalog_level: ADMIN_STEP_UP_OPERATIONS[operation],
      always_enforced: ADMIN_STEP_UP_ALWAYS_ENFORCED.has(operation),
    };
  }

  const freshness = describeAdminStepUpFreshness(auth, Date.now());
  let secondFactorRegistered: boolean;
  try {
    const factors = await new AdminSecondFactorRepository(
      requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management')
    ).listActiveByUser(auth.userId);
    secondFactorRegistered = factors.length > 0;
  } catch (error) {
    stepUpLog(c).error('Failed to read second factors for step-up requirements', {
      action: 'admin_step_up_requirements',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  return c.json({
    tenant_id: auth.tenantId,
    enforced: policy.enforced !== false,
    evidence_window_seconds: ADMIN_STEP_UP_EVIDENCE_WINDOW_MS / 1000,
    evidence: {
      passkey_fresh_until: freshness.passkeyFreshUntil,
      second_factor_fresh_until: freshness.secondFactorFreshUntil,
    },
    second_factor_registered: secondFactorRegistered,
    operations,
  });
});

/**
 * POST /api/admin/me/step-up/receipts
 * Body: { step_up_id: string }
 */
myStepUpRouter.post('/receipts', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  const auth = c.get('adminAuth');
  if (!auth) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
  }

  let body: { step_up_id?: unknown };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('Body is not an object');
    body = parsed;
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  if (typeof body.step_up_id !== 'string' || body.step_up_id.length === 0) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  try {
    const issued = await issueAdminStepUpReceipt(c.env, {
      stepUpId: body.step_up_id,
      auth,
      isSecondFactorActive: (adminUserId, secondFactorId) =>
        new AdminSecondFactorRepository(
          requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management')
        ).isActive(adminUserId, secondFactorId),
    });
    await writeAdminAuditLog(c, {
      action: 'admin.step_up.receipt_issued',
      resourceType: 'admin_session',
      resourceId: issued.binding.sessionId,
      result: 'success',
      metadata: {
        operation: issued.binding.operation,
        level: issued.binding.level,
        target_tenant_id: issued.binding.targetTenantId,
      },
    });
    return c.json({ step_up_receipt: issued.receipt, expires_at: issued.expiresAt });
  } catch (error) {
    if (error instanceof AdminStepUpError) {
      if (error.code === 'step_up_evidence_required') {
        return c.json(
          {
            error: 'step_up_evidence_required',
            error_description: 'Verify the missing factors, then ask again',
            missing: error.missing ?? [],
          },
          403
        );
      }
      return c.json(
        { error: 'invalid_step_up', error_description: 'Step-up request was not found' },
        400
      );
    }
    stepUpLog(c).error('Failed to issue a step-up receipt', {
      action: 'admin_step_up_receipt',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Admin step-up receipts
 *
 * An operation refused with 403 `step_up_required` returns a `step_up_id`. Once the session's
 * evidence is fresh enough for the operation's level, the admin exchanges it here for a
 * single-use receipt, then repeats the operation with the receipt in `authrim-step-up-receipt`.
 *
 * Endpoints:
 * - POST /api/admin/me/step-up/receipts - Issue the receipt for a step-up request
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AdminStepUpError,
  adminAuthMiddleware,
  createErrorResponse,
  getLogger,
  issueAdminStepUpReceipt,
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
    const issued = await issueAdminStepUpReceipt(c.env, { stepUpId: body.step_up_id, auth });
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

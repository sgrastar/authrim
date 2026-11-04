/**
 * The admin step-up gate for one operation: what it needs (the catalog, raised by the target
 * tenant's `security.admin_step_up_overrides`) and whether this request meets it.
 *
 * - L1: a fresh passkey on the session. Otherwise 403 `admin_fresh_auth_required`, which the
 *   console answers with an in-session passkey re-authentication.
 * - L2: a receipt in `authrim-step-up-receipt` for exactly this operation. Otherwise 403
 *   `step_up_required` with a `step_up_id` to issue the receipt against.
 *
 * Only human admin sessions can meet either level. The tenant's settings are read strictly: when
 * they cannot be read the operation is refused, never run under a level the tenant may have
 * raised.
 */

import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminStepUpBinding,
  AdminStepUpOperationDescriptor,
  Env,
} from '@authrim/ar-lib-core';
import {
  ADMIN_STEP_UP_OVERRIDES_KEY,
  ADMIN_STEP_UP_RECEIPT_HEADER,
  AdminStepUpError,
  consumeAdminStepUpReceipt,
  createAdminStepUpOperationHash,
  createAdminStepUpRequirement,
  evaluateAdminStepUpEvidence,
  isAdminStepUpHumanSession,
  resolveAdminStepUpLevel,
  resolveEffectiveSettings,
} from '@authrim/ar-lib-core';

type GateContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

function refuse(c: GateContext, body: Record<string, unknown>, status: 403 | 503): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(body, status);
}

/** The L1 refusal: the console answers it with an in-session passkey re-authentication. */
export function refuseAdminFreshAuth(c: GateContext): Response {
  return refuse(
    c,
    {
      error: 'admin_fresh_auth_required',
      error_description: 'Re-authenticate with a passkey to continue',
      fresh_auth_required: true,
      required_level: 'L1',
    },
    403
  );
}

/**
 * Returns null when the request may go ahead, or the response refusing it. An L2 receipt is
 * spent here, so call this once, after the request has been validated and just before acting.
 */
export async function requireAdminStepUp(
  c: GateContext,
  descriptor: AdminStepUpOperationDescriptor,
  now: number = Date.now()
): Promise<Response | null> {
  const auth = c.get('adminAuth');

  let overrides: unknown;
  try {
    const settings = await resolveEffectiveSettings(c.env, 'security', {
      tenantId: descriptor.targetTenantId,
    });
    overrides = settings[ADMIN_STEP_UP_OVERRIDES_KEY];
  } catch {
    return refuse(
      c,
      {
        error: 'step_up_unavailable',
        error_description: 'The step-up policy could not be read',
      },
      503
    );
  }
  const level = resolveAdminStepUpLevel(descriptor.operation, overrides);

  if (!auth || !isAdminStepUpHumanSession(auth) || !auth.sessionTenantId) {
    return refuse(
      c,
      {
        error: 'step_up_human_required',
        error_description: 'This operation needs a signed-in admin',
        required_level: level,
      },
      403
    );
  }

  if (level === 'L1') {
    const evidence = evaluateAdminStepUpEvidence(auth, 'L1', now);
    if (evidence.missing.length === 0) return null;
    return refuseAdminFreshAuth(c);
  }

  const binding: AdminStepUpBinding = {
    adminUserId: auth.userId,
    sessionId: auth.sessionId,
    homeTenantId: auth.sessionTenantId,
    targetTenantId: descriptor.targetTenantId,
    level,
    operation: descriptor.operation,
    operationHash: await createAdminStepUpOperationHash(descriptor),
  };

  const receipt = c.req.header(ADMIN_STEP_UP_RECEIPT_HEADER);
  if (receipt) {
    try {
      await consumeAdminStepUpReceipt(c.env, receipt, binding);
      return null;
    } catch (error) {
      if (!(error instanceof AdminStepUpError)) throw error;
      // A spent or mismatched receipt asks for a new one below.
    }
  }

  const requirement = await createAdminStepUpRequirement(c.env, binding, now);
  return refuse(
    c,
    {
      error: 'step_up_required',
      error_description: 'This operation needs a step-up receipt',
      required_level: level,
      step_up_id: requirement.stepUpId,
      expires_at: requirement.expiresAt,
      missing: evaluateAdminStepUpEvidence(auth, level, now).missing,
    },
    403
  );
}

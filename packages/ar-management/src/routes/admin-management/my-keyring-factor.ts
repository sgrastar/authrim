/**
 * Keyring as an admin second factor (OpenID4VP, cross-device QR)
 *
 * The admin presents their admin credential from Keyring. The console shows a QR code and a
 * two-digit number; the admin scans the code, checks what is being approved, types the number
 * and confirms with Face ID. ar-vc verifies the presentation; this router hands its result over
 * once and records it here:
 *
 * - step-up: on the session, as the second-factor evidence L2 needs (like a security key)
 * - enrolment: the credential's holder key becomes one of the admin's second factors
 *
 * Endpoints:
 * - POST /api/admin/me/keyring/step-up       - Start a presentation for the session's second factor
 * - GET  /api/admin/me/keyring/step-up/:id   - Its progress; records the result once verified
 * - POST /api/admin/me/keyring/enroll        - Start a presentation that registers the holder key
 * - GET  /api/admin/me/keyring/enroll/:id    - Its progress; registers the key once verified
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminPresentationPurpose,
  AdminPresentationResult,
  Env,
} from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AdminSecondFactorRepository,
  AdminSessionRepository,
  adminAuthMiddleware,
  createAuthContextFromHono,
  createErrorResponse,
  evaluateAdminCredentialEligibility,
  evaluateAdminStepUpEvidence,
  getLogger,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { refuseAdminFreshAuth, requireAdminStepUp } from '../../admin-step-up-gate';
import { getCanonicalTenantBaseUrlAsync } from '../../request-issuer';
import { enrollmentState, presentSecondFactor } from './my-second-factors';
import { ADMIN_CREDENTIAL_TYPE } from './admin-wallet-credential-store';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type HumanSession = AdminAuthContext & { sessionId: string; sessionTenantId: string };

export const myKeyringFactorRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Any signed-in admin acts on their own session and factors; no permission is required.
myKeyringFactorRouter.use('*', adminAuthMiddleware({}));

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const KEYRING_LABEL = 'Keyring';

function setNoStore(c: AdminContext): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function humanSession(auth: AdminAuthContext | undefined): HumanSession | null {
  if (!auth || !isAdminStepUpHumanSession(auth) || !auth.sessionTenantId) return null;
  return auth as HumanSession;
}

function log(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-KEYRING-FACTOR');
}

function refuse(c: AdminContext, status: 400 | 403 | 404 | 409 | 503, error: string) {
  setNoStore(c);
  return c.json({ error }, status);
}

function adminAdapter(c: AdminContext) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

/** The admin credential lives in the admin's home tenant, whatever tenant the session acts in. */
async function homeTenantOf(c: AdminContext, adminUserId: string): Promise<string | null> {
  const row = await adminAdapter(c).queryOne<{ tenant_id: string }>(
    'SELECT tenant_id FROM admin_users WHERE id = ?',
    [adminUserId]
  );
  return row?.tenant_id ?? null;
}

interface Started {
  tenantId: string;
  credentialIssuer: string;
}

/** What every start needs: an eligible admin, the VC service and an https issuer. */
async function prepareStart(c: AdminContext, auth: HumanSession): Promise<Started | Response> {
  if (!c.env.VC_ISSUER) return refuse(c, 503, 'keyring_unavailable');
  const tenantId = await homeTenantOf(c, auth.userId);
  if (!tenantId) return refuse(c, 403, 'keyring_not_eligible');
  const eligibility = await evaluateAdminCredentialEligibility(adminAdapter(c), {
    tenantId,
    adminUserId: auth.userId,
    now: Date.now(),
  });
  if (!eligibility.eligible) return refuse(c, 403, 'keyring_not_eligible');
  const issuer = new URL(await getCanonicalTenantBaseUrlAsync(c.env, tenantId));
  if (issuer.protocol !== 'https:' || issuer.port !== '') {
    return refuse(c, 503, 'keyring_unavailable');
  }
  return { tenantId, credentialIssuer: issuer.origin };
}

async function startPresentation(
  c: AdminContext,
  auth: HumanSession,
  started: Started,
  purpose: AdminPresentationPurpose,
  holderJkts: string[],
  context: Record<string, string | null>
): Promise<Response> {
  const request = await c.env.VC_ISSUER!.createAdminPresentationRequest({
    tenantId: started.tenantId,
    adminUserId: auth.userId,
    sessionId: auth.sessionId,
    purpose,
    holderJkts,
    credentialIssuer: started.credentialIssuer,
    tenantLabel: new URL(started.credentialIssuer).hostname,
    context,
  });
  setNoStore(c);
  return c.json(
    {
      request_id: request.requestId,
      qr: request.qr,
      match_code: request.matchCode,
      expires_at: request.expiresAt,
    },
    201
  );
}

/**
 * The progress of a presentation; once verified, its result handed over (exactly once). A
 * pending, failed or expired presentation answers its status only.
 */
async function progress(
  c: AdminContext,
  auth: HumanSession,
  purpose: AdminPresentationPurpose
): Promise<{ result: AdminPresentationResult; tenantId: string } | Response> {
  const requestId = c.req.param('id') ?? '';
  if (!REQUEST_ID.test(requestId)) return refuse(c, 404, 'not_found');
  if (!c.env.VC_ISSUER) return refuse(c, 503, 'keyring_unavailable');
  const tenantId = await homeTenantOf(c, auth.userId);
  if (!tenantId) return refuse(c, 404, 'not_found');
  const ref = { tenantId, adminUserId: auth.userId, sessionId: auth.sessionId, requestId };
  const status = await c.env.VC_ISSUER.getAdminPresentationStatus(ref);
  if (!status) return refuse(c, 404, 'not_found');
  setNoStore(c);
  if (status.status !== 'verified') {
    return c.json({
      status: status.status,
      expires_at: status.expiresAt,
      ...(status.errorCode ? { error: status.errorCode } : {}),
    });
  }
  const result = await c.env.VC_ISSUER.consumeAdminPresentation(ref);
  // Consumed by a concurrent poll of the same session, or too old: nothing to record here.
  if (!result || result.purpose !== purpose) {
    return c.json({ status: 'consumed', expires_at: status.expiresAt });
  }
  // The credential may have been revoked since the wallet answered: its own row decides now.
  if (!(await adminCredentialIsActive(c, tenantId, auth.userId, result.credentialId))) {
    return c.json({ status: 'failed', error: 'credential_not_active' });
  }
  return { result, tenantId };
}

async function adminCredentialIsActive(
  c: AdminContext,
  tenantId: string,
  adminUserId: string,
  credentialId: string
): Promise<boolean> {
  const coreAdapter = createAuthContextFromHono(
    c as unknown as Context<{ Bindings: Env }>,
    tenantId
  ).coreAdapter;
  const row = await coreAdapter.queryOne<{ status: string }>(
    `SELECT status FROM issued_credentials
      WHERE tenant_id = ? AND public_id = ? AND user_id = ? AND credential_type = ?`,
    [tenantId, credentialId, adminUserId, ADMIN_CREDENTIAL_TYPE]
  );
  return row?.status === 'active';
}

/**
 * POST /api/admin/me/keyring/step-up
 * Starts a presentation that verifies one of the admin's registered Keyring factors.
 */
myKeyringFactorRouter.post('/step-up', async (c) => {
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const started = await prepareStart(c, auth);
    if (started instanceof Response) return started;
    const factors = (
      await new AdminSecondFactorRepository(adminAdapter(c)).listActiveByUser(auth.userId)
    ).filter((factor) => factor.kind === 'keyring_holder_key' && factor.holder_jkt);
    if (factors.length === 0) return refuse(c, 409, 'keyring_not_registered');
    return startPresentation(
      c,
      auth,
      started,
      'step_up',
      factors.map((factor) => factor.holder_jkt!),
      {}
    );
  } catch (error) {
    log(c).error('Failed to start a Keyring step-up', {
      action: 'admin_keyring_step_up_start',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/me/keyring/step-up/:id
 * Once verified, records the Keyring factor on the session as its second-factor evidence.
 */
myKeyringFactorRouter.get('/step-up/:id', async (c) => {
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const outcome = await progress(c, auth, 'step_up');
    if (outcome instanceof Response) return outcome;
    const { result } = outcome;

    const adapter = adminAdapter(c);
    const repo = new AdminSecondFactorRepository(adapter);
    // The key was registered when the request started; it must still be when it is recorded.
    const factor = await repo.findActiveKeyringFactor(auth.userId, result.holderJkt);
    if (!factor) return c.json({ status: 'failed', error: 'holder_key_not_registered' });

    const verifiedAt = Date.now();
    await repo.touch(factor.id, verifiedAt);
    // The session row is the one of the tenant it was created in, whatever tenant it acts in now.
    const recorded = await new AdminSessionRepository(
      adapter,
      auth.sessionTenantId
    ).recordSecondFactorVerification(
      auth.sessionId,
      { adminUserId: auth.userId, secondFactorId: factor.id },
      verifiedAt
    );
    if (!recorded) return c.json({ status: 'failed', error: 'session_or_factor_changed' });

    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.verified',
      resourceType: 'admin_session',
      resourceId: auth.sessionId,
      result: 'success',
      metadata: { second_factor_id: factor.id, kind: factor.kind },
    });
    return c.json({ status: 'verified', verified_at: verifiedAt });
  } catch (error) {
    log(c).error('Failed to complete a Keyring step-up', {
      action: 'admin_keyring_step_up_complete',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/keyring/enroll
 * Starts a presentation that registers the holder key of the admin's Keyring credential. Like a
 * security key: an L2 receipt (admin.second_factor.add) once a factor is active, a fresh passkey
 * inside the first-enrollment window, otherwise recovery.
 */
myKeyringFactorRouter.post('/enroll', async (c) => {
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const started = await prepareStart(c, auth);
    if (started instanceof Response) return started;
    const repo = new AdminSecondFactorRepository(adminAdapter(c));
    const now = Date.now();
    const state = await enrollmentState(repo, auth.userId, now);
    if (state.mode === 'recovery_required') {
      return c.json(
        {
          error: 'second_factor_recovery_required',
          error_description:
            'No second factor is registered and the first-enrollment window has closed',
        },
        403
      );
    }
    if (state.mode === 'first') {
      if (evaluateAdminStepUpEvidence(auth, 'L1', now).missing.length > 0) {
        return refuseAdminFreshAuth(c);
      }
    } else {
      // The receipt is spent here, after every check that can still refuse the request.
      const refused = await requireAdminStepUp(
        c,
        {
          operation: 'admin.second_factor.add',
          targetTenantId: auth.sessionTenantId,
          targetIds: [auth.userId],
          params: { kind: 'keyring_holder_key' },
        },
        now
      );
      if (refused) return refused;
    }
    // Every holder key ever registered (revoked ones included) is refused again.
    const registered = (await repo.listByUser(auth.userId)).flatMap((factor) =>
      factor.holder_jkt ? [factor.holder_jkt] : []
    );
    return startPresentation(c, auth, started, 'enroll', registered, {
      mode: state.mode,
      approving_factor_id: state.mode === 'step_up' ? (auth.secondFactorId ?? null) : null,
    });
  } catch (error) {
    log(c).error('Failed to start a Keyring enrolment', {
      action: 'admin_keyring_enroll_start',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/me/keyring/enroll/:id
 * Once verified, registers the presented holder key as a second factor.
 */
myKeyringFactorRouter.get('/enroll/:id', async (c) => {
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const outcome = await progress(c, auth, 'enroll');
    if (outcome instanceof Response) return outcome;
    const { result } = outcome;
    const mode = result.context.mode;
    if (mode !== 'first' && mode !== 'step_up') {
      return c.json({ status: 'failed', error: 'invalid_enrollment' });
    }

    const repo = new AdminSecondFactorRepository(adminAdapter(c));
    // The evidence the registration rests on must still be fresh when the key is saved.
    if (
      evaluateAdminStepUpEvidence(auth, mode === 'step_up' ? 'L2' : 'L1', Date.now()).missing
        .length > 0
    ) {
      return c.json({ status: 'failed', error: 'step_up_expired' }, 403);
    }
    // An added key was approved by the factor behind the receipt; if that factor was revoked
    // since, the approval is gone too.
    const approving = result.context.approving_factor_id;
    if (
      mode === 'step_up' &&
      (!approving ||
        auth.secondFactorId !== approving ||
        !(await repo.isActive(auth.userId, approving)))
    ) {
      return c.json({ status: 'failed', error: 'step_up_required' }, 403);
    }

    const inserted = await repo.insertKeyringHolderKey(
      { admin_user_id: auth.userId, holder_jkt: result.holderJkt, label: KEYRING_LABEL },
      {
        firstOnly: mode === 'first',
        ...(mode === 'step_up' && approving
          ? { approvedBy: { factorId: approving, sessionId: auth.sessionId } }
          : {}),
      }
    );
    if (!inserted.inserted && inserted.reason === 'approval_revoked') {
      return c.json({ status: 'failed', error: 'step_up_required' }, 403);
    }
    if (!inserted.inserted) {
      const error =
        inserted.reason === 'credential_in_use'
          ? 'credential_in_use'
          : inserted.reason === 'enrollment_closed'
            ? 'second_factor_recovery_required'
            : 'second_factor_already_enrolled';
      return c.json({ status: 'failed', error }, 409);
    }

    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.added',
      resourceType: 'admin_second_factor',
      resourceId: inserted.factor.id,
      result: 'success',
      metadata: { kind: inserted.factor.kind, mode, credential_id: result.credentialId },
    });
    return c.json({ status: 'verified', second_factor: presentSecondFactor(inserted.factor) }, 201);
  } catch (error) {
    log(c).error('Failed to complete a Keyring enrolment', {
      action: 'admin_keyring_enroll_complete',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

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
 * - recovery (enrolment with `purpose: 'recovery'`): the holder key is filed as the new second
 *   factor of a recovery request instead (my-second-factor-recovery.ts), for an admin who lost
 *   their factors
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
  ADMIN_KEYRING_DC_API_KEY,
  ADMIN_UI_BFF_MODE_HEADER,
  ADMIN_UI_FORWARDED_ORIGIN_HEADER,
  AdminSecondFactorRepository,
  AdminSessionRepository,
  adminAuthMiddleware,
  ensureDatabaseAdapter,
  resolveTenantMetadataContext,
  createErrorResponse,
  evaluateAdminCredentialEligibility,
  evaluateAdminStepUpEvidence,
  getLogger,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
  resolveAdminWebAuthnBrowserOrigin,
  resolveEffectiveSettings,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { refuseAdminFreshAuth, requireAdminStepUp } from '../../admin-step-up-gate';
import { getCanonicalTenantBaseUrlAsync } from '../../request-issuer';
import { enrollmentState, presentSecondFactor } from './my-second-factors';
import { isActiveOwnAdminCredential } from './admin-wallet-credential-store';
import { fileRecoveryRequest, refuseRecoveryRequest } from './my-second-factor-recovery';

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

type Transport = { mode: 'direct_post' } | { mode: 'dc_api'; origin: string };

/** Whether admins may present Keyring through the browser (platform switch, off by default). */
export async function keyringDcApiEnabled(env: Env, tenantId: string): Promise<boolean> {
  try {
    const settings = await resolveEffectiveSettings(env, 'security', { tenantId });
    return settings[ADMIN_KEYRING_DC_API_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * How the console asks for the presentation: a QR code by default, or `{ "mode": "dc_api" }`
 * for the browser's Digital Credentials API, bound to the console origin the request came from.
 */
interface StartBody {
  mode?: unknown;
  purpose?: unknown;
}

/** The optional JSON body of a start: `{ mode?, purpose? }`. */
async function readStartBody(c: AdminContext): Promise<StartBody | Response> {
  try {
    const text = await c.req.text();
    const body = text ? (JSON.parse(text) as unknown) : {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return refuse(c, 400, 'invalid_request');
    }
    return body;
  } catch {
    return refuse(c, 400, 'invalid_request');
  }
}

async function requestedTransport(
  c: AdminContext,
  auth: HumanSession,
  body: StartBody
): Promise<Transport | Response> {
  const mode = body.mode;
  if (mode === undefined || mode === 'direct_post') return { mode: 'direct_post' };
  if (mode !== 'dc_api') return refuse(c, 400, 'invalid_request');
  if (!(await keyringDcApiEnabled(c.env, auth.sessionTenantId))) {
    return refuse(c, 409, 'keyring_dc_api_disabled');
  }
  // The admin console origin, as WebAuthn checks it: the answer is bound to exactly this one.
  const origin = resolveAdminWebAuthnBrowserOrigin({
    env: c.env,
    originHeader: c.req.header('origin'),
    bffModeHeader: c.req.header(ADMIN_UI_BFF_MODE_HEADER),
    forwardedOriginHeader: c.req.header(ADMIN_UI_FORWARDED_ORIGIN_HEADER),
  });
  if (!origin || !origin.startsWith('https://')) return refuse(c, 400, 'invalid_origin');
  return { mode: 'dc_api', origin };
}

async function startPresentation(
  c: AdminContext,
  auth: HumanSession,
  started: Started,
  purpose: AdminPresentationPurpose,
  holderJkts: string[],
  context: Record<string, string | null>,
  transport: Transport
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
    mode: transport.mode,
    ...(transport.mode === 'dc_api' ? { origin: transport.origin } : {}),
  });
  setNoStore(c);
  if (request.dcRequest) {
    return c.json(
      {
        request_id: request.requestId,
        dc_request: request.dcRequest,
        expires_at: request.expiresAt,
      },
      201
    );
  }
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
 * POST …/:id/response — the answer the browser gave the console for a Digital Credentials API
 * request (`{ "response": <DigitalCredential.data> }`). Once ar-vc verified it, the result is
 * collected and recorded like a QR presentation's.
 */
async function submitBrowserAnswer(
  c: AdminContext,
  complete: () => Promise<Response>
): Promise<Response> {
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const requestId = c.req.param('id') ?? '';
  if (!REQUEST_ID.test(requestId)) return refuse(c, 404, 'not_found');
  if (!c.env.VC_ISSUER) return refuse(c, 503, 'keyring_unavailable');
  let body: { response?: unknown } | null;
  try {
    const text = await c.req.text();
    if (text.length > 96 * 1024) return refuse(c, 400, 'invalid_request');
    body = JSON.parse(text) as { response?: unknown } | null;
  } catch {
    return refuse(c, 400, 'invalid_request');
  }
  if (!body || body.response === undefined) return refuse(c, 400, 'invalid_request');
  try {
    const tenantId = await homeTenantOf(c, auth.userId);
    if (!tenantId) return refuse(c, 404, 'not_found');
    const submitted = await c.env.VC_ISSUER.submitAdminPresentationResponse({
      tenantId,
      adminUserId: auth.userId,
      sessionId: auth.sessionId,
      requestId,
      data: body.response,
    });
    setNoStore(c);
    switch (submitted.outcome) {
      case 'verified':
        return complete();
      case 'refused':
        return c.json({ status: 'failed', error: submitted.error ?? 'invalid_vp_token' });
      case 'unknown':
        return refuse(c, 404, 'not_found');
      case 'replayed':
        return refuse(c, 409, 'replayed');
      default:
        return refuse(c, 503, 'keyring_unavailable');
    }
  } catch (error) {
    log(c).error('Failed to submit a Keyring browser answer', {
      action: 'admin_keyring_dc_api_submit',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
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
  // This route acts outside any selected tenant: the core database is the admin's home tenant's.
  const context = await resolveTenantMetadataContext(c.env, tenantId);
  const coreAdapter = ensureDatabaseAdapter(context.coreDb, 'admin-keyring-factor');
  return isActiveOwnAdminCredential(coreAdapter, tenantId, adminUserId, credentialId);
}

/**
 * POST /api/admin/me/keyring/step-up
 * Starts a presentation that verifies one of the admin's registered Keyring factors.
 */
myKeyringFactorRouter.post('/step-up', async (c) => {
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const body = await readStartBody(c);
    if (body instanceof Response) return body;
    const transport = await requestedTransport(c, auth, body);
    if (transport instanceof Response) return transport;
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
      {},
      transport
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
async function completeStepUp(c: AdminContext): Promise<Response> {
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
}

/**
 * A verified recovery presentation: the holder key is filed as the new second factor of a
 * recovery request (the waiting period, notices and completion are the request's), answered in
 * the shape of a presentation's progress.
 */
async function fileKeyringRecovery(
  c: AdminContext,
  auth: HumanSession,
  result: AdminPresentationResult
): Promise<Response> {
  // The fresh passkey the request rests on must still be fresh when it is filed.
  if (evaluateAdminStepUpEvidence(auth, 'L1', Date.now()).missing.length > 0) {
    return c.json({ status: 'failed', error: 'admin_fresh_auth_required' }, 403);
  }
  const filed = await fileRecoveryRequest(c, auth, {
    kind: 'keyring_holder_key',
    holder_jkt: result.holderJkt,
    admin_credential_id: result.credentialId,
    label: KEYRING_LABEL,
  });
  const body = (await filed.json().catch(() => null)) as {
    recovery?: unknown;
    error?: unknown;
  } | null;
  setNoStore(c);
  if (filed.ok && body?.recovery) {
    return c.json({ status: 'verified', recovery: body.recovery }, 201);
  }
  return c.json(
    {
      status: 'failed',
      error: typeof body?.error === 'string' ? body.error : 'recovery_failed',
    },
    filed.status as 403 | 409 | 500 | 503
  );
}

myKeyringFactorRouter.get('/step-up/:id', (c) => completeStepUp(c));
myKeyringFactorRouter.post('/step-up/:id/response', (c) =>
  submitBrowserAnswer(c, () => completeStepUp(c))
);

/**
 * POST /api/admin/me/keyring/enroll
 * Starts a presentation that registers the holder key of the admin's Keyring credential. Like a
 * security key: an L2 receipt (admin.second_factor.add) once a factor is active, a fresh passkey
 * inside the first-enrollment window, otherwise recovery.
 *
 * With `purpose: 'recovery'` the key is for a recovery request instead: a fresh passkey and the
 * same checks as a security key's recovery request (another admin exists, none is open, email can
 * be delivered); the request is filed once the presentation is verified.
 */
myKeyringFactorRouter.post('/enroll', async (c) => {
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const body = await readStartBody(c);
    if (body instanceof Response) return body;
    if (body.purpose !== undefined && body.purpose !== 'recovery') {
      return refuse(c, 400, 'invalid_request');
    }
    const transport = await requestedTransport(c, auth, body);
    if (transport instanceof Response) return transport;
    const started = await prepareStart(c, auth);
    if (started instanceof Response) return started;
    const adapter = adminAdapter(c);
    const repo = new AdminSecondFactorRepository(adapter);
    const now = Date.now();
    // Every holder key ever registered (revoked ones included) is refused again.
    const registered = (await repo.listByUser(auth.userId)).flatMap((factor) =>
      factor.holder_jkt ? [factor.holder_jkt] : []
    );
    if (body.purpose === 'recovery') {
      const refused = await refuseRecoveryRequest(c, auth, adapter, now);
      if (refused) return refused;
      return startPresentation(
        c,
        auth,
        started,
        'enroll',
        registered,
        { mode: 'recovery', approving_factor_id: null },
        transport
      );
    }
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
    return startPresentation(
      c,
      auth,
      started,
      'enroll',
      registered,
      {
        mode: state.mode,
        approving_factor_id: state.mode === 'step_up' ? (auth.secondFactorId ?? null) : null,
      },
      transport
    );
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
async function completeEnroll(c: AdminContext): Promise<Response> {
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const outcome = await progress(c, auth, 'enroll');
    if (outcome instanceof Response) return outcome;
    const { result } = outcome;
    const mode = result.context.mode;
    if (mode === 'recovery') return fileKeyringRecovery(c, auth, result);
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

    // The credential may have been revoked while the key was being registered (its revocation
    // found no factor to retire yet): checked again now, and the new factor retired if so.
    // Fail closed: a credential that cannot be confirmed active now does not keep the factor.
    const stillActive = await adminCredentialIsActive(
      c,
      outcome.tenantId,
      auth.userId,
      result.credentialId
    ).catch(() => false);
    if (!stillActive) {
      await repo.revokeByAdmin(auth.userId, inserted.factor.id);
      return c.json({ status: 'failed', error: 'credential_not_active' });
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
}

myKeyringFactorRouter.get('/enroll/:id', (c) => completeEnroll(c));
myKeyringFactorRouter.post('/enroll/:id/response', (c) =>
  submitBrowserAnswer(c, () => completeEnroll(c))
);

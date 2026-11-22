/**
 * An authenticator app (TOTP) as an admin second factor
 *
 * Another kind of second factor for L2, alongside security keys and Keyring. It is weaker than
 * those (a person can be tricked into typing a code, and a copy of the secret works anywhere), so
 * a tenant must list `totp` in `security.admin_second_factor_allowed_kinds` before it can be
 * registered or counted. Where it is allowed, it follows the same rules as the other kinds:
 * registering needs an L2 receipt once the admin has a second factor, or a fresh passkey inside
 * the first-enrolment window; it is never offered to a recovery request.
 *
 * Endpoints (under /api/admin/me/second-factors/totp):
 * - POST /enroll         - Start: a new secret (shown once) and the otpauth URI for the app
 * - POST /enroll/verify  - Confirm with a code from the app and store the secret, sealed
 * - POST /verify         - Verify a code as the session's second factor (the L2 evidence; the
 *                           tenant being acted on decides whether it counts, at the gate)
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Challenge, Env, StoreChallengeRequest } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  AdminSecondFactorRepository,
  AdminSessionRepository,
  TOTP_COMPATIBLE_PROFILE,
  adminAuthMiddleware,
  buildDOKey,
  buildOtpAuthUri,
  createErrorResponse,
  evaluateAdminStepUpEvidence,
  generateId,
  generateTotpSecret,
  getChallengeStoreByChallengeId,
  getLogger,
  isAdminSecondFactorKindAllowed,
  isAdminStepUpHumanSession,
  openAdminTotpSecret,
  readAdminStepUpPolicy,
  requireDedicatedAdminDatabaseAdapter,
  resolveAdminSecondFactorAllowedKinds,
  sealAdminTotpSecret,
  verifyTotpCode,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';
import { refuseAdminFreshAuth, requireAdminStepUp } from '../../admin-step-up-gate';
import { enrollmentState, presentSecondFactor } from './my-second-factors';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type HumanSession = AdminAuthContext & { sessionId: string; sessionTenantId: string };

export const myTotpFactorRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// An admin manages only their own second factors; what each change needs is checked per route.
myTotpFactorRouter.use('*', adminAuthMiddleware({}));

const CHALLENGE_TYPE = 'admin_totp_enrollment';
const CHALLENGE_TTL_SECONDS = 300;
const MAX_LABEL_LENGTH = 64;
const DEFAULT_LABEL = 'Authenticator app';
const ISSUER = 'Authrim Admin';
/** Wrong codes allowed per admin and action in the window; each guess is one of a million. */
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_SECONDS = 300;

interface EnrollmentChallengeStore {
  storeChallengeRpc(request: StoreChallengeRequest): Promise<unknown>;
  getChallengeRpc(id: string): Promise<Challenge | null>;
  consumeChallengeRpc(request: { id: string; tenantId: string; type: string }): Promise<unknown>;
}

async function challengeStore(
  env: Env,
  challengeId: string,
  tenantId: string
): Promise<EnrollmentChallengeStore> {
  const stub: unknown = await getChallengeStoreByChallengeId(env, challengeId, tenantId);
  return stub as EnrollmentChallengeStore;
}

function challengeKey(challengeId: string): string {
  return `${CHALLENGE_TYPE}:${challengeId}`;
}

function setNoStore(c: AdminContext): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function humanSession(auth: AdminAuthContext | undefined): HumanSession | null {
  if (!auth || !isAdminStepUpHumanSession(auth) || !auth.sessionTenantId) return null;
  return auth as HumanSession;
}

function totpLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-TOTP-FACTOR');
}

async function readObject(c: AdminContext): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await c.req.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function repository(c: AdminContext): AdminSecondFactorRepository {
  return new AdminSecondFactorRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management')
  );
}

function verificationFailed(c: AdminContext): Response {
  return c.json({ error: 'verification_failed', error_description: 'Code was not verified' }, 400);
}

function codeOf(value: unknown): string | null {
  return typeof value === 'string' && /^\d{6}$/u.test(value.replace(/\s+/gu, ''))
    ? value.replace(/\s+/gu, '')
    : null;
}

/**
 * Whether the tenant the admin signed in to allows authenticator apps. Null when the policy
 * cannot be read: a list nobody could read is never taken as permission.
 */
async function totpAllowed(c: AdminContext, tenantId: string): Promise<boolean | null> {
  try {
    const policy = await readAdminStepUpPolicy(c.env, tenantId);
    return isAdminSecondFactorKindAllowed(
      'totp',
      resolveAdminSecondFactorAllowedKinds(policy.allowedKinds)
    );
  } catch {
    return null;
  }
}

function refuseKind(c: AdminContext, allowed: boolean | null): Response | null {
  if (allowed === null) {
    return c.json(
      { error: 'step_up_unavailable', error_description: 'The step-up policy could not be read' },
      503
    );
  }
  if (!allowed) {
    return c.json(
      {
        error: 'second_factor_kind_not_allowed',
        error_description: 'This tenant does not allow authenticator apps as a second factor',
      },
      403
    );
  }
  return null;
}

async function rateLimited(
  c: AdminContext,
  auth: HumanSession,
  action: 'enroll' | 'verify'
): Promise<Response | null> {
  const limiter = c.env.RATE_LIMITER.get(
    c.env.RATE_LIMITER.idFromName(buildDOKey('rate-limit', 'admin-totp', auth.sessionTenantId))
  );
  const result = await limiter.incrementRpc(`${action}:${auth.userId}`, {
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: RATE_LIMIT_MAX_ATTEMPTS,
  });
  if (result.allowed) return null;
  return c.json(
    {
      error: 'rate_limited',
      error_description: 'Too many attempts. Please try again later.',
      retry_after: result.retryAfter,
    },
    429
  );
}

/**
 * POST /api/admin/me/second-factors/totp/enroll
 * Body: { label?: string }
 */
myTotpFactorRouter.post('/enroll', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

  const body = (await readObject(c)) ?? {};
  if (
    body.label !== undefined &&
    (typeof body.label !== 'string' || body.label.length > MAX_LABEL_LENGTH)
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const label =
    typeof body.label === 'string' && body.label.trim() ? body.label.trim() : DEFAULT_LABEL;

  try {
    const kindRefused = refuseKind(c, await totpAllowed(c, auth.sessionTenantId));
    if (kindRefused) return kindRefused;

    const repo = repository(c);
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
    if (state.active.some((factor) => factor.kind === 'totp')) {
      return c.json({ error: 'second_factor_kind_in_use' }, 409);
    }

    // Nothing that can still refuse the request may come after the receipt is spent.
    const secret = generateTotpSecret();
    const sealed = await sealAdminTotpSecret(c.env, auth.userId, secret);
    if (!sealed) return c.json({ error: 'totp_unavailable' }, 503);

    if (state.mode === 'first') {
      if (evaluateAdminStepUpEvidence(auth, 'L1', now).missing.length > 0) {
        return refuseAdminFreshAuth(c);
      }
    } else {
      const refused = await requireAdminStepUp(
        c,
        {
          operation: 'admin.second_factor.add',
          targetTenantId: auth.sessionTenantId,
          targetIds: [auth.userId],
          params: { kind: 'totp' },
        },
        now
      );
      if (refused) return refused;
    }

    // The registration rests on fresh sign-in evidence: the challenge lasts no longer than it.
    const evidence = evaluateAdminStepUpEvidence(auth, state.mode === 'step_up' ? 'L2' : 'L1', now);
    if (evidence.freshUntil === undefined) return refuseAdminFreshAuth(c);
    const ttl = Math.min(
      CHALLENGE_TTL_SECONDS,
      Math.max(1, Math.floor((evidence.freshUntil - now) / 1000))
    );

    const challengeId = generateId();
    await (
      await challengeStore(c.env, challengeId, auth.sessionTenantId)
    ).storeChallengeRpc({
      id: challengeKey(challengeId),
      tenantId: auth.sessionTenantId,
      type: CHALLENGE_TYPE,
      userId: auth.userId,
      challenge: challengeId,
      ttl,
      notAfterMs: evidence.freshUntil,
      metadata: {
        sessionId: auth.sessionId,
        mode: state.mode,
        label,
        approvingFactorId: state.mode === 'step_up' ? (auth.secondFactorId ?? null) : null,
        secretEncrypted: sealed.encrypted,
        secretKeyVersion: sealed.keyVersion,
      },
    });

    return c.json(
      {
        challenge_id: challengeId,
        otpauth_uri: buildOtpAuthUri({
          issuer: ISSUER,
          accountName: auth.email || auth.userId,
          secretBase32: secret,
          profile: TOTP_COMPATIBLE_PROFILE,
        }),
        // For an app that cannot scan the code; shown once, never returned again.
        secret,
        expires_at: now + ttl * 1000,
      },
      201
    );
  } catch (error) {
    totpLog(c).error('Failed to start an authenticator app enrolment', {
      action: 'admin_totp_enroll_start',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/second-factors/totp/enroll/verify
 * Body: { challenge_id: string, code: string }
 */
myTotpFactorRouter.post('/enroll/verify', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

  const body = await readObject(c);
  const code = codeOf(body?.code);
  if (!body || typeof body.challenge_id !== 'string' || body.challenge_id.length === 0 || !code) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  try {
    const kindRefused = refuseKind(c, await totpAllowed(c, auth.sessionTenantId));
    if (kindRefused) return kindRefused;
    const limited = await rateLimited(c, auth, 'enroll');
    if (limited) return limited;

    const store = await challengeStore(c.env, body.challenge_id, auth.sessionTenantId);
    const now = Date.now();
    // Read first and consumed only on success: a mistyped code does not cost the admin a new
    // receipt. The attempts are limited above, and the challenge is short-lived.
    const challenge = await store.getChallengeRpc(challengeKey(body.challenge_id));
    const metadata = challenge?.metadata as
      | {
          sessionId?: string;
          mode?: string;
          label?: string | null;
          approvingFactorId?: string | null;
          secretEncrypted?: string;
          secretKeyVersion?: number;
        }
      | undefined;
    if (
      !challenge ||
      challenge.type !== CHALLENGE_TYPE ||
      challenge.tenantId !== auth.sessionTenantId ||
      challenge.consumed ||
      challenge.expiresAt <= now ||
      challenge.userId !== auth.userId ||
      metadata?.sessionId !== auth.sessionId ||
      (metadata.mode !== 'first' && metadata.mode !== 'step_up') ||
      typeof metadata.secretEncrypted !== 'string'
    ) {
      return c.json(
        { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
        400
      );
    }
    const mode = metadata.mode;

    const secret = await openAdminTotpSecret(c.env, auth.userId, metadata.secretEncrypted);
    if (!secret) {
      return c.json(
        { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
        400
      );
    }
    const checked = await verifyTotpCode({
      code,
      secretBase32: secret,
      profile: TOTP_COMPATIBLE_PROFILE,
      nowMs: now,
    });
    if (!checked.valid || checked.timeStep === null) return verificationFailed(c);

    // The evidence the registration rests on must still be fresh when the secret is saved.
    if (
      evaluateAdminStepUpEvidence(auth, mode === 'step_up' ? 'L2' : 'L1', now).missing.length > 0
    ) {
      return c.json({ error: 'step_up_expired' }, 403);
    }
    // An added factor was approved by the factor behind the receipt; if that factor was revoked
    // since, the approval is gone too.
    const repo = repository(c);
    const approving = metadata.approvingFactorId ?? null;
    if (
      mode === 'step_up' &&
      (!approving ||
        auth.secondFactorId !== approving ||
        !(await repo.isActive(auth.userId, approving)))
    ) {
      return c.json({ error: 'step_up_required' }, 403);
    }

    try {
      await store.consumeChallengeRpc({
        id: challengeKey(body.challenge_id),
        tenantId: auth.sessionTenantId,
        type: CHALLENGE_TYPE,
      });
    } catch {
      return c.json(
        { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
        400
      );
    }

    const sealedVersion = metadata.secretKeyVersion;
    const inserted = await repo.insertTotp(
      {
        admin_user_id: auth.userId,
        secret_encrypted: metadata.secretEncrypted,
        secret_key_version:
          typeof sealedVersion === 'number' && Number.isFinite(sealedVersion) ? sealedVersion : 1,
        time_step: checked.timeStep,
        label: metadata.label ?? DEFAULT_LABEL,
      },
      {
        firstOnly: mode === 'first',
        sessionId: auth.sessionId,
        ...(mode === 'step_up' && approving
          ? { approvedBy: { factorId: approving, sessionId: auth.sessionId } }
          : {}),
        now,
      }
    );
    if (!inserted.inserted) {
      switch (inserted.reason) {
        case 'approval_revoked':
          return c.json({ error: 'step_up_required' }, 403);
        case 'session_ended':
          return c.json({ error: 'session_ended' }, 401);
        case 'enrollment_closed':
          return c.json({ error: 'second_factor_recovery_required' }, 409);
        case 'kind_in_use':
          return c.json({ error: 'second_factor_kind_in_use' }, 409);
        default:
          return c.json({ error: 'second_factor_already_enrolled' }, 409);
      }
    }

    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.added',
      resourceType: 'admin_second_factor',
      resourceId: inserted.factor.id,
      result: 'success',
      metadata: { kind: inserted.factor.kind, mode },
    });
    return c.json({ second_factor: presentSecondFactor(inserted.factor) }, 201);
  } catch (error) {
    totpLog(c).error('Failed to complete an authenticator app enrolment', {
      action: 'admin_totp_enroll_complete',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/second-factors/totp/verify
 * Body: { code: string }
 *
 * The admin's authenticator app as the session's second factor. A code verifies once: a code for
 * a step at or before the last accepted one is refused, even when two requests carry it at once.
 */
myTotpFactorRouter.post('/verify', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

  const body = await readObject(c);
  const code = codeOf(body?.code);
  if (!code) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);

  try {
    // No policy check here: this only records the evidence on the session. Whether an
    // authenticator app counts is decided where the evidence is used, against the tenant being
    // acted on (the gate and the receipt), which may not be the tenant the session lives in.
    const limited = await rateLimited(c, auth, 'verify');
    if (limited) return limited;

    const repo = repository(c);
    const secrets = await repo.listActiveTotpSecrets(auth.userId);
    if (secrets.length === 0) {
      return c.json(
        {
          error: 'no_second_factor',
          error_description: 'No authenticator app is registered as a second factor',
        },
        400
      );
    }

    const now = Date.now();
    let matched: { factorId: string; timeStep: number } | null = null;
    for (const stored of secrets) {
      const secret = await openAdminTotpSecret(c.env, auth.userId, stored.secret_encrypted);
      if (!secret) continue;
      const checked = await verifyTotpCode({
        code,
        secretBase32: secret,
        profile: TOTP_COMPATIBLE_PROFILE,
        nowMs: now,
        lastUsedTimeStep: stored.last_used_time_step,
      });
      if (checked.valid && checked.timeStep !== null) {
        matched = { factorId: stored.factor.id, timeStep: checked.timeStep };
        break;
      }
    }
    if (!matched) return verificationFailed(c);

    // Conditional: a concurrent use of the same code, or a revocation, leaves no evidence.
    const used = await repo.recordTotpUse(matched.factorId, {
      timeStep: matched.timeStep,
      usedAt: now,
    });
    if (!used) return verificationFailed(c);

    const sessionRepo = new AdminSessionRepository(
      requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management'),
      auth.sessionTenantId
    );
    const recorded = await sessionRepo.recordSecondFactorVerification(
      auth.sessionId,
      { adminUserId: auth.userId, secondFactorId: matched.factorId },
      now
    );
    if (!recorded) {
      // The session ended, or the factor was revoked, after the checks above.
      return verificationFailed(c);
    }

    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.verified',
      resourceType: 'admin_session',
      resourceId: auth.sessionId,
      result: 'success',
      metadata: { second_factor_id: matched.factorId, kind: 'totp' },
    });
    return c.json({ verified: true, verified_at: now });
  } catch (error) {
    totpLog(c).error('Authenticator app verification failed', {
      action: 'admin_totp_verify',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

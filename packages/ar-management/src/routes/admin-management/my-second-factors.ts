/**
 * Admin step-up second factors
 *
 * The current admin's second factors for L2: credentials registered for step-up only, never used
 * to sign in. A WebAuthn second factor must be device-bound (backup eligibility off).
 *
 * Registering needs an L2 receipt once the admin has a second factor. The first one can be
 * registered with a fresh passkey alone, but only inside the admin's one-time enrollment window;
 * after it, an admin without any must go through recovery. Removing needs an L2 receipt and never
 * leaves fewer than the minimum.
 *
 * Endpoints:
 * - GET    /api/admin/me/second-factors                  - List own second factors and the enrollment state
 * - POST   /api/admin/me/second-factors/webauthn/options - Registration options for a security key
 * - POST   /api/admin/me/second-factors/webauthn/verify  - Verify the registration and store it
 * - DELETE /api/admin/me/second-factors/:id              - Revoke a second factor
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  AdminAuthContext,
  AdminSecondFactor,
  Env,
  StoreChallengeRequest,
} from '@authrim/ar-lib-core';
import {
  ADMIN_SECOND_FACTOR_MINIMUM,
  ADMIN_UI_BFF_MODE_HEADER,
  ADMIN_UI_FORWARDED_ORIGIN_HEADER,
  AR_ERROR_CODES,
  AdminPasskeyRepository,
  AdminSecondFactorRepository,
  adminAuthMiddleware,
  adminWebAuthnOriginMatchesRpId,
  createErrorResponse,
  evaluateAdminStepUpEvidence,
  generateId,
  getAdminWebAuthnRpIdForOrigin,
  getChallengeStoreByChallengeId,
  getLogger,
  isAdminStepUpHumanSession,
  requireDedicatedAdminDatabaseAdapter,
  resolveAdminWebAuthnBrowserOrigin,
} from '@authrim/ar-lib-core';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { writeAdminAuditLog } from '../../admin-shared';
import { refuseAdminFreshAuth, requireAdminStepUp } from '../../admin-step-up-gate';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type HumanSession = AdminAuthContext & { sessionId: string; sessionTenantId: string };

export const mySecondFactorsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// An admin manages only their own second factors; what each change needs is checked per route.
mySecondFactorsRouter.use('*', adminAuthMiddleware({}));

const RP_NAME = 'Authrim Admin';
const CHALLENGE_TYPE = 'admin_second_factor_registration';
const CHALLENGE_TTL_SECONDS = 300;
const MAX_LABEL_LENGTH = 64;
const VALID_TRANSPORTS: readonly string[] = [
  'usb',
  'nfc',
  'ble',
  'internal',
  'hybrid',
  'smart-card',
];

type EnrollmentMode = 'first' | 'step_up';

interface RegistrationChallenge {
  userId: string;
  challenge: string;
  metadata?: {
    rpID?: string;
    origin?: string;
    sessionId?: string;
    mode?: EnrollmentMode;
    label?: string | null;
  };
}

interface RegistrationChallengeStore {
  storeChallengeRpc(request: StoreChallengeRequest): Promise<unknown>;
  consumeChallengeRpc(request: { id: string; tenantId: string; type: string }): Promise<unknown>;
}

async function challengeStore(
  env: Env,
  challengeId: string,
  tenantId: string
): Promise<RegistrationChallengeStore> {
  const stub: unknown = await getChallengeStoreByChallengeId(env, challengeId, tenantId);
  return stub as RegistrationChallengeStore;
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

function resolveBrowserOrigin(c: AdminContext): string | null {
  return resolveAdminWebAuthnBrowserOrigin({
    env: c.env,
    originHeader: c.req.header('origin'),
    bffModeHeader: c.req.header(ADMIN_UI_BFF_MODE_HEADER),
    forwardedOriginHeader: c.req.header(ADMIN_UI_FORWARDED_ORIGIN_HEADER),
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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

function secondFactorLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-SECOND-FACTOR');
}

function repository(c: AdminContext): AdminSecondFactorRepository {
  return new AdminSecondFactorRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management')
  );
}

function present(factor: AdminSecondFactor) {
  return {
    id: factor.id,
    kind: factor.kind,
    label: factor.label,
    aaguid: factor.aaguid,
    created_at: factor.created_at,
    last_used_at: factor.last_used_at,
    revoked_at: factor.revoked_at,
  };
}

function minimumReached(c: AdminContext): Response {
  return c.json(
    {
      error: 'second_factor_minimum',
      error_description: 'Register another second factor before removing this one',
      minimum: ADMIN_SECOND_FACTOR_MINIMUM,
    },
    409
  );
}

/**
 * How the admin may register now: `step_up` with an L2 receipt once a factor is active, `first`
 * with a fresh passkey inside the enrollment window, otherwise `recovery_required`.
 */
async function enrollmentState(
  repo: AdminSecondFactorRepository,
  adminUserId: string,
  now: number
): Promise<{
  mode: EnrollmentMode | 'recovery_required';
  active: AdminSecondFactor[];
  graceEndsAt: number | null;
}> {
  const active = await repo.listActiveByUser(adminUserId);
  const graceEndsAt = await repo.getEnrollmentGraceEndsAt(adminUserId);
  if (active.length > 0) return { mode: 'step_up', active, graceEndsAt };
  if (graceEndsAt !== null && now < graceEndsAt) return { mode: 'first', active, graceEndsAt };
  return { mode: 'recovery_required', active, graceEndsAt };
}

/**
 * GET /api/admin/me/second-factors
 */
mySecondFactorsRouter.get('/', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  try {
    const repo = repository(c);
    const state = await enrollmentState(repo, auth.userId, Date.now());
    const factors = await repo.listByUser(auth.userId);
    return c.json({
      second_factors: factors.map(present),
      active_count: state.active.length,
      minimum: ADMIN_SECOND_FACTOR_MINIMUM,
      enrollment: { mode: state.mode, first_enrollment_ends_at: state.graceEndsAt },
    });
  } catch (error) {
    secondFactorLog(c).error('Failed to list second factors', {
      action: 'admin_second_factor_list',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/second-factors/webauthn/options
 * Body: { rp_id: string, label?: string }
 */
mySecondFactorsRouter.post('/webauthn/options', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

  const body = await readObject(c);
  if (
    !body ||
    typeof body.rp_id !== 'string' ||
    body.rp_id.length === 0 ||
    (body.label !== undefined &&
      (typeof body.label !== 'string' || body.label.length > MAX_LABEL_LENGTH))
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;

  const browserOrigin = resolveBrowserOrigin(c);
  if (!browserOrigin || !adminWebAuthnOriginMatchesRpId(browserOrigin, body.rp_id)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const rpID = getAdminWebAuthnRpIdForOrigin(browserOrigin);
  if (!rpID) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);

  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
    const repo = new AdminSecondFactorRepository(adapter);
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
      // The receipt is spent here; the challenge below carries the authorization to verify.
      const refused = await requireAdminStepUp(
        c,
        {
          operation: 'admin.second_factor.add',
          targetTenantId: auth.sessionTenantId,
          targetIds: [auth.userId],
        },
        now
      );
      if (refused) return refused;
    }

    // Neither a sign-in passkey nor a registered second factor may be registered again.
    const passkeys = await new AdminPasskeyRepository(adapter).getPasskeysByUser(auth.userId);
    const factors = await repo.listByUser(auth.userId);
    const excludeCredentials = [
      ...passkeys.map((passkey) => passkey.credential_id),
      ...factors.flatMap((factor) => (factor.credential_id ? [factor.credential_id] : [])),
    ].map((id) => ({ id, type: 'public-key' as const }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: auth.email || auth.userId,
      userDisplayName: auth.email || auth.userId,
      userID: Uint8Array.from(new TextEncoder().encode(auth.userId)),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'discouraged',
        userVerification: 'required',
      },
      timeout: 60000,
    });

    const challengeId = generateId();
    await (
      await challengeStore(c.env, challengeId, auth.sessionTenantId)
    ).storeChallengeRpc({
      id: challengeKey(challengeId),
      tenantId: auth.sessionTenantId,
      type: CHALLENGE_TYPE,
      userId: auth.userId,
      challenge: options.challenge,
      ttl: CHALLENGE_TTL_SECONDS,
      metadata: {
        rpID,
        origin: browserOrigin,
        sessionId: auth.sessionId,
        mode: state.mode,
        label,
      },
    });

    return c.json({ options, challenge_id: challengeId, mode: state.mode });
  } catch (error) {
    secondFactorLog(c).error('Failed to create second-factor registration options', {
      action: 'admin_second_factor_options',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/second-factors/webauthn/verify
 * Body: { challenge_id: string, credential: RegistrationResponseJSON }
 */
mySecondFactorsRouter.post('/webauthn/verify', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);

  const body = await readObject(c);
  const credential = body?.credential as RegistrationResponseJSON | undefined;
  if (
    !body ||
    typeof body.challenge_id !== 'string' ||
    body.challenge_id.length === 0 ||
    !credential ||
    typeof credential !== 'object' ||
    typeof credential.id !== 'string'
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  // Single use: consumed before anything else.
  let challengeData: RegistrationChallenge;
  try {
    challengeData = (await (
      await challengeStore(c.env, body.challenge_id, auth.sessionTenantId)
    ).consumeChallengeRpc({
      id: challengeKey(body.challenge_id),
      tenantId: auth.sessionTenantId,
      type: CHALLENGE_TYPE,
    })) as RegistrationChallenge;
  } catch {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
      400
    );
  }

  const metadata = challengeData.metadata;
  if (
    challengeData.userId !== auth.userId ||
    metadata?.sessionId !== auth.sessionId ||
    !metadata.origin ||
    !metadata.rpID ||
    (metadata.mode !== 'first' && metadata.mode !== 'step_up') ||
    resolveBrowserOrigin(c) !== metadata.origin
  ) {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge does not match this session' },
      400
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: metadata.origin,
      expectedRPID: metadata.rpID,
      requireUserVerification: true,
    });
  } catch {
    return c.json(
      { error: 'verification_failed', error_description: 'Security key was not verified' },
      400
    );
  }
  if (!verification.verified) {
    return c.json(
      { error: 'verification_failed', error_description: 'Security key was not verified' },
      400
    );
  }

  const info = verification.registrationInfo;
  // A credential that can sync (backup eligible) is not independent of the account's devices.
  if (info.credentialDeviceType !== 'singleDevice' || info.credentialBackedUp) {
    return c.json(
      {
        error: 'second_factor_not_device_bound',
        error_description: 'Use a security key or credential that cannot be synced',
      },
      400
    );
  }

  try {
    const repo = repository(c);
    const transports = (credential.response.transports ?? []).filter((transport) =>
      VALID_TRANSPORTS.includes(transport)
    );
    const result = await repo.insertWebAuthn(
      {
        admin_user_id: auth.userId,
        credential_id: info.credential.id,
        public_key: bytesToBase64(info.credential.publicKey),
        counter: info.credential.counter,
        transports,
        aaguid: info.aaguid ?? null,
        backup_eligible: false,
        backup_state: false,
        label: metadata.label ?? null,
      },
      { firstOnly: metadata.mode === 'first' }
    );
    if (!result.inserted && result.reason === 'enrollment_closed') {
      return c.json(
        {
          error: 'second_factor_recovery_required',
          error_description: 'The first-enrollment window has closed',
        },
        403
      );
    }
    if (!result.inserted) {
      return c.json(
        result.reason === 'credential_in_use'
          ? {
              error: 'credential_in_use',
              error_description: 'This credential is already registered',
            }
          : {
              error: 'second_factor_already_enrolled',
              error_description: 'A second factor was registered in the meantime',
            },
        409
      );
    }

    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.added',
      resourceType: 'admin_second_factor',
      resourceId: result.factor.id,
      result: 'success',
      metadata: { kind: result.factor.kind, mode: metadata.mode },
    });

    return c.json({ second_factor: present(result.factor) }, 201);
  } catch (error) {
    secondFactorLog(c).error('Failed to register a second factor', {
      action: 'admin_second_factor_register',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/me/second-factors/:id
 */
mySecondFactorsRouter.delete('/:id', async (c) => {
  setNoStore(c);
  const auth = humanSession(c.get('adminAuth'));
  if (!auth) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  const id = c.req.param('id');

  try {
    const repo = repository(c);
    const active = await repo.listActiveByUser(auth.userId);
    if (!active.some((factor) => factor.id === id)) {
      return c.json({ error: 'not_found', error_description: 'Second factor not found' }, 404);
    }
    // Refused before the receipt is spent; the revocation below checks it again atomically.
    if (active.length <= ADMIN_SECOND_FACTOR_MINIMUM) return minimumReached(c);
    const refused = await requireAdminStepUp(c, {
      operation: 'admin.second_factor.remove',
      targetTenantId: auth.sessionTenantId,
      targetIds: [id],
    });
    if (refused) return refused;

    const result = await repo.revoke(auth.userId, id);
    if (!result.revoked) {
      return result.reason === 'minimum_reached'
        ? minimumReached(c)
        : c.json({ error: 'not_found', error_description: 'Second factor not found' }, 404);
    }

    await writeAdminAuditLog(c, {
      action: 'admin.second_factor.revoked',
      resourceType: 'admin_second_factor',
      resourceId: id,
      result: 'success',
    });
    return c.json({ revoked: true });
  } catch (error) {
    secondFactorLog(c).error('Failed to revoke a second factor', {
      action: 'admin_second_factor_revoke',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

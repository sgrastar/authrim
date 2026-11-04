/**
 * Admin in-session passkey re-authentication
 *
 * A signed-in admin proves possession of one of their own passkeys again, without a new
 * session. The verified assertion is recorded on the admin session (passkey_verified_at), which
 * the admin auth middleware exposes as authenticationTimeMs, so operations that require a fresh
 * admin (isFreshAdminHuman) accept the session again for their window.
 *
 * A registered step-up second factor (a device-bound WebAuthn credential) is verified the same
 * way and recorded separately (second_factor_verified_at); L2 needs both to be fresh.
 *
 * Endpoints:
 * - POST /api/admin/me/reauth/passkey/options       - WebAuthn assertion options for the session's admin
 * - POST /api/admin/me/reauth/passkey/verify        - Verify the assertion and record it on the session
 * - POST /api/admin/me/reauth/second-factor/options - Assertion options for the admin's second factors
 * - POST /api/admin/me/reauth/second-factor/verify  - Verify a second factor and record it on the session
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext, StoreChallengeRequest } from '@authrim/ar-lib-core';
import {
  AdminPasskeyRepository,
  AdminSecondFactorRepository,
  AdminSessionRepository,
  ADMIN_UI_BFF_MODE_HEADER,
  ADMIN_UI_FORWARDED_ORIGIN_HEADER,
  AR_ERROR_CODES,
  adminAuthMiddleware,
  adminWebAuthnOriginMatchesRpId,
  createErrorResponse,
  generateId,
  getAdminWebAuthnRpIdForOrigin,
  getChallengeStoreByChallengeId,
  getLogger,
  requireDedicatedAdminDatabaseAdapter,
  resolveAdminWebAuthnBrowserOrigin,
} from '@authrim/ar-lib-core';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransport } from '@simplewebauthn/server';
import { writeAdminAuditLog } from '../../admin-shared';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

export const myReauthRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Any signed-in admin may re-authenticate their own session; no permission is required.
myReauthRouter.use('*', adminAuthMiddleware({}));

const CHALLENGE_TYPE = 'admin_passkey_reauth';
const SECOND_FACTOR_CHALLENGE_TYPE = 'admin_second_factor_reauth';
const CHALLENGE_TTL_SECONDS = 300;

interface AdminPasskeyReauthChallenge {
  userId: string;
  challenge: string;
  metadata?: {
    rpID?: string;
    origin?: string;
    sessionId?: string;
  };
}

/** The two ChallengeStore RPCs used here (the Durable Object stub itself is untyped). */
interface ReauthChallengeStore {
  storeChallengeRpc(request: StoreChallengeRequest): Promise<unknown>;
  consumeChallengeRpc(request: { id: string; tenantId: string; type: string }): Promise<unknown>;
}

async function reauthChallengeStore(
  env: Env,
  challengeId: string,
  tenantId: string
): Promise<ReauthChallengeStore> {
  const stub: unknown = await getChallengeStoreByChallengeId(env, challengeId, tenantId);
  return stub as ReauthChallengeStore;
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function challengeKey(challengeId: string, type: string = CHALLENGE_TYPE): string {
  return `${type}:${challengeId}`;
}

function setNoStore(c: AdminContext): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/**
 * Only a human admin session can be re-authenticated: the evidence is stored on the session row,
 * and a bearer or machine credential has no session to carry it.
 */
function requireHumanSession(
  auth: AdminAuthContext | undefined
): (AdminAuthContext & { sessionId: string; tenantId: string }) | null {
  if (
    !auth ||
    auth.authMethod !== 'session' ||
    (auth.actorType && auth.actorType !== 'human') ||
    typeof auth.sessionId !== 'string' ||
    auth.sessionId.length === 0 ||
    typeof auth.tenantId !== 'string' ||
    auth.tenantId.length === 0
  ) {
    return null;
  }
  return auth as AdminAuthContext & { sessionId: string; tenantId: string };
}

function resolveBrowserOrigin(c: AdminContext): string | null {
  return resolveAdminWebAuthnBrowserOrigin({
    env: c.env,
    originHeader: c.req.header('origin'),
    bffModeHeader: c.req.header(ADMIN_UI_BFF_MODE_HEADER),
    forwardedOriginHeader: c.req.header(ADMIN_UI_FORWARDED_ORIGIN_HEADER),
  });
}

function toBase64URL(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function reauthLog(c: AdminContext) {
  return getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-REAUTH');
}

function verificationFailed(c: AdminContext): Response {
  return c.json(
    { error: 'verification_failed', error_description: 'Passkey was not verified' },
    400
  );
}

/**
 * POST /api/admin/me/reauth/passkey/options
 * Body: { rp_id: string }
 */
myReauthRouter.post('/passkey/options', async (c) => {
  setNoStore(c);
  const auth = requireHumanSession(c.get('adminAuth'));
  if (!auth) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  let body: { rp_id?: unknown };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('Body is not an object');
    body = parsed;
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  if (typeof body.rp_id !== 'string' || body.rp_id.length === 0) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const browserOrigin = resolveBrowserOrigin(c);
  if (!browserOrigin || !adminWebAuthnOriginMatchesRpId(browserOrigin, body.rp_id)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const rpID = getAdminWebAuthnRpIdForOrigin(browserOrigin);
  if (!rpID) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  try {
    const passkeyRepo = new AdminPasskeyRepository(
      requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management')
    );
    const passkeys = await passkeyRepo.getPasskeysByUser(auth.userId);
    if (passkeys.length === 0) {
      return c.json(
        {
          error: 'no_reauth_method',
          error_description: 'No passkey is available for re-authentication',
        },
        400
      );
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: passkeys.map((passkey) => ({
        id: toBase64URL(passkey.credential_id),
        type: 'public-key' as const,
        transports:
          passkey.transports && passkey.transports.length > 0
            ? (passkey.transports as AuthenticatorTransport[])
            : undefined,
      })),
      timeout: 60000,
    });

    const challengeId = generateId();
    const challengeStore = await reauthChallengeStore(c.env, challengeId, auth.tenantId);
    await challengeStore.storeChallengeRpc({
      id: challengeKey(challengeId),
      tenantId: auth.tenantId,
      type: CHALLENGE_TYPE,
      userId: auth.userId,
      challenge: options.challenge,
      ttl: CHALLENGE_TTL_SECONDS,
      metadata: {
        rpID,
        origin: browserOrigin,
        sessionId: auth.sessionId,
      },
    });

    return c.json({ options, challenge_id: challengeId });
  } catch (error) {
    reauthLog(c).error('Failed to create passkey re-authentication options', {
      action: 'admin_reauth_options',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/reauth/passkey/verify
 * Body: { challenge_id: string, credential: AuthenticationResponseJSON }
 */
myReauthRouter.post('/passkey/verify', async (c) => {
  setNoStore(c);
  const auth = requireHumanSession(c.get('adminAuth'));
  if (!auth) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  let body: { challenge_id?: unknown; credential?: AuthenticationResponseJSON };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('Body is not an object');
    body = parsed;
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  if (
    typeof body.challenge_id !== 'string' ||
    body.challenge_id.length === 0 ||
    !body.credential ||
    typeof body.credential.id !== 'string'
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  // Single use: the challenge is consumed before anything else, so a failed attempt cannot be
  // retried against the same challenge.
  let challengeData: AdminPasskeyReauthChallenge;
  try {
    const challengeStore = await reauthChallengeStore(c.env, body.challenge_id, auth.tenantId);
    challengeData = (await challengeStore.consumeChallengeRpc({
      id: challengeKey(body.challenge_id),
      tenantId: auth.tenantId,
      type: CHALLENGE_TYPE,
    })) as AdminPasskeyReauthChallenge;
  } catch {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
      400
    );
  }

  const expectedOrigin = challengeData.metadata?.origin;
  const expectedRPID = challengeData.metadata?.rpID;
  if (
    challengeData.userId !== auth.userId ||
    challengeData.metadata?.sessionId !== auth.sessionId ||
    !expectedOrigin ||
    !expectedRPID ||
    resolveBrowserOrigin(c) !== expectedOrigin
  ) {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge does not match this session' },
      400
    );
  }

  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
    const passkeyRepo = new AdminPasskeyRepository(adapter);
    const passkey = await passkeyRepo.findByCredentialId(toBase64URL(body.credential.id));
    if (!passkey || passkey.admin_user_id !== auth.userId) {
      return verificationFailed(c);
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: challengeData.challenge,
        expectedOrigin,
        expectedRPID,
        credential: {
          id: passkey.credential_id,
          publicKey: base64ToBytes(passkey.public_key),
          counter: passkey.counter,
        },
        requireUserVerification: true,
      });
    } catch {
      return verificationFailed(c);
    }
    if (!verification.verified) {
      return verificationFailed(c);
    }

    // The library already refused a counter that went backwards; a zero counter (platform
    // passkeys) leaves the row unchanged, as at sign-in.
    await passkeyRepo.updateCounter(passkey.id, verification.authenticationInfo.newCounter);

    const verifiedAt = Date.now();
    const sessionRepo = new AdminSessionRepository(adapter, auth.tenantId);
    const recorded = await sessionRepo.recordPasskeyVerification(
      auth.sessionId,
      passkey.credential_id,
      verifiedAt
    );
    if (!recorded) {
      // The session ended between the middleware check and this write.
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_AUTH_REQUIRED);
    }

    await writeAdminAuditLog(c, {
      action: 'admin.reauthenticated',
      resourceType: 'admin_session',
      resourceId: auth.sessionId,
      result: 'success',
      metadata: { method: 'passkey', passkey_id: passkey.id },
    });

    return c.json({ verified: true, authenticated_at: verifiedAt });
  } catch (error) {
    reauthLog(c).error('Passkey re-authentication failed', {
      action: 'admin_reauth_verify',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/reauth/second-factor/options
 * Body: { rp_id: string }
 */
myReauthRouter.post('/second-factor/options', async (c) => {
  setNoStore(c);
  const auth = requireHumanSession(c.get('adminAuth'));
  if (!auth) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  let body: { rp_id?: unknown };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('Body is not an object');
    body = parsed;
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  if (typeof body.rp_id !== 'string' || body.rp_id.length === 0) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  const browserOrigin = resolveBrowserOrigin(c);
  if (!browserOrigin || !adminWebAuthnOriginMatchesRpId(browserOrigin, body.rp_id)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  const rpID = getAdminWebAuthnRpIdForOrigin(browserOrigin);
  if (!rpID) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  try {
    const factorRepo = new AdminSecondFactorRepository(
      requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management')
    );
    const factors = (await factorRepo.listActiveByUser(auth.userId)).filter(
      (factor) => factor.kind === 'webauthn_credential' && factor.credential_id
    );
    if (factors.length === 0) {
      return c.json(
        {
          error: 'no_second_factor',
          error_description: 'No security key is registered as a second factor',
        },
        400
      );
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: factors.map((factor) => ({
        id: factor.credential_id as string,
        type: 'public-key' as const,
        transports:
          factor.transports && factor.transports.length > 0
            ? (factor.transports as AuthenticatorTransport[])
            : undefined,
      })),
      timeout: 60000,
    });

    const challengeId = generateId();
    const challengeStore = await reauthChallengeStore(c.env, challengeId, auth.tenantId);
    await challengeStore.storeChallengeRpc({
      id: challengeKey(challengeId, SECOND_FACTOR_CHALLENGE_TYPE),
      tenantId: auth.tenantId,
      type: SECOND_FACTOR_CHALLENGE_TYPE,
      userId: auth.userId,
      challenge: options.challenge,
      ttl: CHALLENGE_TTL_SECONDS,
      metadata: {
        rpID,
        origin: browserOrigin,
        sessionId: auth.sessionId,
      },
    });

    return c.json({ options, challenge_id: challengeId });
  } catch (error) {
    reauthLog(c).error('Failed to create second-factor verification options', {
      action: 'admin_second_factor_reauth_options',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/reauth/second-factor/verify
 * Body: { challenge_id: string, credential: AuthenticationResponseJSON }
 */
myReauthRouter.post('/second-factor/verify', async (c) => {
  setNoStore(c);
  const auth = requireHumanSession(c.get('adminAuth'));
  if (!auth) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  let body: { challenge_id?: unknown; credential?: AuthenticationResponseJSON };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== 'object') throw new Error('Body is not an object');
    body = parsed;
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }
  if (
    typeof body.challenge_id !== 'string' ||
    body.challenge_id.length === 0 ||
    !body.credential ||
    typeof body.credential.id !== 'string'
  ) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
  }

  let challengeData: AdminPasskeyReauthChallenge;
  try {
    const challengeStore = await reauthChallengeStore(c.env, body.challenge_id, auth.tenantId);
    challengeData = (await challengeStore.consumeChallengeRpc({
      id: challengeKey(body.challenge_id, SECOND_FACTOR_CHALLENGE_TYPE),
      tenantId: auth.tenantId,
      type: SECOND_FACTOR_CHALLENGE_TYPE,
    })) as AdminPasskeyReauthChallenge;
  } catch {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
      400
    );
  }

  const expectedOrigin = challengeData.metadata?.origin;
  const expectedRPID = challengeData.metadata?.rpID;
  if (
    challengeData.userId !== auth.userId ||
    challengeData.metadata?.sessionId !== auth.sessionId ||
    !expectedOrigin ||
    !expectedRPID ||
    resolveBrowserOrigin(c) !== expectedOrigin
  ) {
    return c.json(
      { error: 'invalid_challenge', error_description: 'Challenge does not match this session' },
      400
    );
  }

  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
    const factorRepo = new AdminSecondFactorRepository(adapter);
    const factor = await factorRepo.findActiveByCredentialId(toBase64URL(body.credential.id));
    if (
      !factor ||
      factor.admin_user_id !== auth.userId ||
      factor.kind !== 'webauthn_credential' ||
      !factor.credential_id ||
      !factor.public_key
    ) {
      return verificationFailed(c);
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: challengeData.challenge,
        expectedOrigin,
        expectedRPID,
        credential: {
          id: factor.credential_id,
          publicKey: base64ToBytes(factor.public_key),
          counter: factor.counter,
        },
        requireUserVerification: true,
      });
    } catch {
      return verificationFailed(c);
    }
    if (!verification.verified) {
      return verificationFailed(c);
    }
    // Backup eligibility never changes after registration; a credential now reporting it (or a
    // backup) is not the device-bound one that was registered.
    if (
      verification.authenticationInfo.credentialDeviceType !== 'singleDevice' ||
      verification.authenticationInfo.credentialBackedUp ||
      factor.backup_eligible !== false
    ) {
      return verificationFailed(c);
    }

    // Both writes are conditional: a concurrent use of the same factor (the counter moved) or its
    // revocation in the meantime leaves the session without this evidence.
    const verifiedAt = Date.now();
    const used = await factorRepo.recordUse(factor.id, {
      expectedCounter: factor.counter,
      counter: verification.authenticationInfo.newCounter,
      backupState: false,
      usedAt: verifiedAt,
    });
    if (!used) {
      return verificationFailed(c);
    }

    const sessionRepo = new AdminSessionRepository(adapter, auth.tenantId);
    const recorded = await sessionRepo.recordSecondFactorVerification(
      auth.sessionId,
      { adminUserId: auth.userId, secondFactorId: factor.id },
      verifiedAt
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
      metadata: { second_factor_id: factor.id, kind: factor.kind },
    });

    return c.json({ verified: true, verified_at: verifiedAt });
  } catch (error) {
    reauthLog(c).error('Second-factor verification failed', {
      action: 'admin_second_factor_reauth_verify',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

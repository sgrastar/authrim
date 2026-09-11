import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  AR_ERROR_CODES,
  BROWSER_STATE_COOKIE_NAME,
  GUEST_RESUME_COOKIE,
  CanonicalRuntimeUserStore,
  GuestLifecycleRepository,
  createAccountAuthContextFromHono,
  createErrorResponse,
  createPIIContextFromHono,
  createAuditLog,
  createTenantPlacementWriteFenceResponse,
  generateBrowserState,
  generateUserIdFromSettings,
  getBrowserStateCookieSameSite,
  getChallengeStoreByChallengeId,
  getLogger,
  getSessionClientMetadata,
  getSessionCookieSameSite,
  getSessionStoreBySessionId,
  getSessionStoreForNewSession,
  getTenantIdFromContext,
  loadClientContractCached,
  resolveAccountDataContextFromHono,
  resolveGuestSettings,
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
  type Env,
  type Session,
  type Challenge,
} from '@authrim/ar-lib-core';
import { provisionGuestAccount, resolveGuestAccountRoute } from './account-provisioning';
import { resolveSessionTtl } from './session-ttl';
import { getDirectAuthWebAuthnOrigin, validateDirectAuthClient } from './direct-auth';
import { verifyHumanVerificationForAction } from './human-verification';

export { GUEST_RESUME_COOKIE } from '@authrim/ar-lib-core';
const RESUME_TTL_SECONDS = 180 * 86400;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A random bearer credential, scoped to tenant and client. Device identifiers are never proof. */
export async function guestResumeHash(secret: string, tenantId: string, clientId: string) {
  if (!SECRET_PATTERN.test(secret)) throw new Error('invalid_guest_resume_credential');
  return hex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify(['authrim-guest-resume-v1', tenantId, clientId, secret])
        )
      )
    )
  );
}

export async function guestLoginHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const log = getLogger(c).module('GUEST-LOGIN');
  try {
    const body = await c.req.json<{
      authorizationChallengeId?: unknown;
      clientId?: unknown;
      human_verification_response?: unknown;
    }>();
    let clientId: string;
    let requestedScopes: string[];
    let proofContext: string;
    let proofExpiresAt = Date.now() + 300000;
    if (body.authorizationChallengeId !== undefined) {
      if (
        typeof body.authorizationChallengeId !== 'string' ||
        !body.authorizationChallengeId ||
        body.authorizationChallengeId.length > 256
      ) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
      const challengeStore = await getChallengeStoreByChallengeId(
        c.env,
        body.authorizationChallengeId,
        tenantId
      );
      const challenge = (await challengeStore.getChallengeRpc(
        body.authorizationChallengeId
      )) as Challenge | null;
      if (
        !challenge ||
        challenge.type !== 'login' ||
        challenge.tenantId !== tenantId ||
        challenge.consumed ||
        !Number.isFinite(challenge.expiresAt) ||
        challenge.expiresAt <= Date.now() ||
        (challenge.metadata?.tenant_id !== undefined && challenge.metadata.tenant_id !== tenantId)
      ) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }
      const challengeClientId = challenge.metadata?.client_id;
      if (typeof challengeClientId !== 'string' || !challengeClientId)
        return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
      clientId = challengeClientId;
      requestedScopes =
        typeof challenge.metadata?.scope === 'string'
          ? challenge.metadata.scope.split(' ').filter(Boolean)
          : [];
      proofContext = body.authorizationChallengeId;
      proofExpiresAt = challenge.expiresAt;
    } else {
      // Direct Login UI creates a cookie session only; it does not mint an OAuth grant.
      if (typeof body.clientId !== 'string' || !body.clientId || body.clientId.length > 256) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
      const origin = getDirectAuthWebAuthnOrigin(c, c.req.header('origin'));
      if (!origin) return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
      const validation = await validateDirectAuthClient(c, body.clientId, 'browser', origin);
      if (!validation.valid)
        return (
          validation.errorResponse ?? createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED)
        );
      clientId = body.clientId;
      requestedScopes = ['openid'];
      proofContext = `direct:${clientId}`;
    }
    const settings = await resolveGuestSettings(c.env, tenantId);
    const contract = await loadClientContractCached(
      c,
      c.env.AUTHRIM_CONFIG,
      c.env,
      tenantId,
      clientId
    );
    if (!settings.loginEnabled || !contract?.guestAuth?.enabled) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    if (requestedScopes.some((scope) => !contract.guestAuth!.allowedScopes.includes(scope))) {
      return c.json(
        {
          error: 'invalid_scope',
          error_description: 'The client does not permit the requested guest scopes',
        },
        400
      );
    }
    const sessionCookie = getCookie(c, 'authrim_session');
    if (sessionCookie) {
      const { stub } = getSessionStoreBySessionId(c.env, sessionCookie, tenantId);
      const existingSession = (await stub.getSessionRpc(sessionCookie)) as Session | null;
      if (
        existingSession &&
        existingSession.expiresAt > Date.now() &&
        !existingSession.data?.is_guest_session
      ) {
        return c.json(
          {
            error: 'account_session_exists',
            error_description: 'Sign out before starting a guest account',
          },
          409
        );
      }
    }
    let secret = getCookie(c, GUEST_RESUME_COOKIE);
    if (!secret || !SECRET_PATTERN.test(secret)) {
      secret = hex(crypto.getRandomValues(new Uint8Array(32)));
      // Set before provisioning so retries use the same private credential and idempotency key.
      setCookie(c, GUEST_RESUME_COOKIE, secret, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: RESUME_TTL_SECONDS,
      });
    }
    const credentialHash = await guestResumeHash(secret, tenantId, clientId);
    const proofId = `guest-human:${await guestResumeHash(secret, tenantId, proofContext)}`;
    const proofStore = await getChallengeStoreByChallengeId(c.env, proofId, tenantId);
    const proof = (await proofStore.getChallengeRpc(proofId)) as Challenge | null;
    const hasProof =
      proof?.tenantId === tenantId &&
      proof.type === 'anon_login' &&
      proof.metadata?.purpose === 'guest_human_verification' &&
      proof.metadata?.client_id === clientId &&
      proof.challenge === credentialHash &&
      !proof.consumed &&
      proof.expiresAt > Date.now();
    if (!hasProof) {
      const verificationError = await verifyHumanVerificationForAction(
        c,
        'login',
        body.human_verification_response
      );
      if (verificationError) return verificationError;
      await proofStore.storeChallengeRpc({
        id: proofId,
        tenantId,
        type: 'anon_login',
        userId: '',
        challenge: credentialHash,
        ttl: Math.max(1, Math.min(300, Math.ceil((proofExpiresAt - Date.now()) / 1000))),
        metadata: { purpose: 'guest_human_verification', client_id: clientId },
      });
    }
    let route;
    try {
      route = await resolveGuestAccountRoute(c, credentialHash);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'account_data_route_not_found')
        throw error;
    }
    let userId = route?.legacyUserId;
    let isNewUser = false;
    if (!userId) {
      const provisioned = await provisionGuestAccount(c, {
        tenantId,
        candidateUserId: await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env),
        resumeCredential: {
          credentialHash,
          expiresInDays: RESUME_TTL_SECONDS / 86400,
          guestLifecycle: {
            clientId,
            deletionAfterDays: settings.policy.deletionAfterDays,
            policyVersion: settings.policyVersion,
          },
        },
      });
      if (provisioned.status === 'pending') {
        for (const cookie of c.res.headers.getSetCookie())
          provisioned.response.headers.append('Set-Cookie', cookie);
        return provisioned.response;
      }
      userId = provisioned.userId;
      isNewUser = true;
      const resolved = await resolveAccountDataContextFromHono(c, userId);
      if (resolved.accountId !== provisioned.accountId || resolved.legacyUserId !== userId)
        throw new Error('guest_account_route_mismatch');
    }
    const auth = createAccountAuthContextFromHono(c, tenantId);
    const pii = createPIIContextFromHono(c, tenantId);
    const credential = await auth.coreAdapter.queryOne<{
      id: string;
      user_id: string;
      expires_at: number | null;
      created_at: number;
    }>(
      'SELECT id, user_id, expires_at, created_at FROM guest_devices WHERE tenant_id = ? AND resume_credential_hash = ? AND is_active = TRUE',
      [tenantId, credentialHash],
      { consistencyClass: 'primary_required' }
    );
    const credentialCheckTime = Date.now();
    if (
      !credential ||
      credential.user_id !== userId ||
      !Number.isFinite(credential.created_at) ||
      credential.created_at + RESUME_TTL_SECONDS * 1000 <= credentialCheckTime ||
      (credential.expires_at !== null && credential.expires_at <= credentialCheckTime)
    ) {
      // Expired or revoked secrets never get reassigned to another subject.
      setCookie(c, GUEST_RESUME_COOKIE, '', {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: 0,
      });
      return c.json(
        {
          error: 'invalid_guest_credential',
          error_description: 'The guest credential is no longer valid',
        },
        401
      );
    }
    const lifecycle = await new GuestLifecycleRepository(auth.coreAdapter, tenantId).get(userId);
    const user = await new CanonicalRuntimeUserStore({
      coreAdapter: auth.coreAdapter,
      piiAdapter: pii.defaultPiiAdapter,
      tenantId,
    }).findById(userId);
    if (
      !lifecycle ||
      lifecycle.client_id !== clientId ||
      lifecycle.phase !== 'active' ||
      user?.registration_state !== 'guest'
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }
    const resumedAt = Date.now();
    const refreshedCredential = await auth.coreAdapter.execute(
      `UPDATE guest_devices SET last_used_at = ?
       WHERE id = ? AND tenant_id = ? AND user_id = ? AND resume_credential_hash = ?
         AND is_active = TRUE AND (expires_at IS NULL OR expires_at > ?)`,
      [resumedAt, credential.id, tenantId, userId, credentialHash, resumedAt]
    );
    if (refreshedCredential.rowsAffected !== 1) {
      setCookie(c, GUEST_RESUME_COOKIE, '', {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: 0,
      });
      return c.json(
        {
          error: 'invalid_guest_credential',
          error_description: 'The guest credential is no longer valid',
        },
        401
      );
    }
    const ttl = await resolveSessionTtl(c.env, tenantId, 'guest');
    const { stub, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);
    await stub.createSessionRpc(
      sessionId,
      userId,
      ttl.seconds,
      {
        ...getSessionClientMetadata(c.req.raw),
        amr: ['anon'],
        acr: 'urn:mace:incommon:iap:anonymous',
        is_guest_session: true,
        client_id: clientId,
        guest_resume_credential_hash: credentialHash,
        guest_resume_credential: true,
      },
      tenantId
    );
    // Recheck after session creation. A concurrent deletion must not publish a usable session.
    const latest = await new GuestLifecycleRepository(auth.coreAdapter, tenantId).get(userId);
    if (latest?.phase !== 'active') {
      await stub.invalidateSessionRpc(sessionId);
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }
    const ipAddress =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      c.req.header('X-Real-IP') ||
      'unknown';
    const userAgent = c.req.header('User-Agent') || 'unknown';
    if (isNewUser) {
      await createAuditLog(c.env, {
        tenantId,
        userId,
        action: 'account.guest.created',
        resource: 'user',
        resourceId: userId,
        ipAddress,
        userAgent,
        metadata: JSON.stringify({ method: 'browser', client_id: clientId }),
        severity: 'info',
      });
    }
    publishEvent(c, {
      type: AUTH_EVENTS.LOGIN_SUCCEEDED,
      tenantId,
      data: { userId, method: 'guest', clientId, sessionId } satisfies AuthEventData,
    }).catch((error) => {
      log.error('Failed to publish guest login event', { action: 'event_publish' }, error as Error);
    });
    publishEvent(c, {
      type: SESSION_EVENTS.USER_CREATED,
      tenantId,
      data: { sessionId, userId, ttlSeconds: ttl.seconds } satisfies SessionEventData,
    }).catch((error) => {
      log.error(
        'Failed to publish guest session event',
        { action: 'event_publish' },
        error as Error
      );
    });
    const loginAudit = createAuditLog(c.env, {
      tenantId,
      userId,
      action: 'user.login',
      resource: 'session',
      resourceId: sessionId,
      ipAddress,
      userAgent,
      metadata: JSON.stringify({ method: 'guest', is_new_user: isNewUser, client_id: clientId }),
      severity: 'info',
    }).catch((error) => {
      log.error('Failed to create guest login audit', { action: 'audit_log' }, error as Error);
    });
    try {
      c.executionCtx.waitUntil(loginAudit);
    } catch {
      await loginAudit;
    }
    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: ttl.seconds,
    });
    setCookie(c, BROWSER_STATE_COOKIE_NAME, await generateBrowserState(sessionId), {
      path: '/',
      secure: true,
      sameSite: getBrowserStateCookieSameSite(c.env),
      maxAge: ttl.seconds,
    });
    c.header('Cache-Control', 'no-store');
    log.info('Guest login completed', {
      action: 'guest_login',
      tenantId,
      userId,
      clientId,
      isNewUser,
    });
    // The login challenge is consumed by the existing /flow/login continuation, preserving OIDC validation.
    return c.json({ success: true });
  } catch (error) {
    log.error('Guest login failed', {}, error as Error);
    return (
      createTenantPlacementWriteFenceResponse(c, error) ??
      createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR)
    );
  }
}

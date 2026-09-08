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
  type Env,
  type Session,
  type Challenge,
} from '@authrim/ar-lib-core';
import { provisionAnonymousAccount, resolveAnonymousAccountRoute } from './account-provisioning';
import { resolveSessionTtl } from './session-ttl';
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
      human_verification_response?: unknown;
    }>();
    if (
      typeof body.authorizationChallengeId !== 'string' ||
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
    const clientId = challenge.metadata?.client_id;
    if (typeof clientId !== 'string' || !clientId)
      return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
    const settings = await resolveGuestSettings(c.env, tenantId);
    const contract = await loadClientContractCached(
      c,
      c.env.AUTHRIM_CONFIG,
      c.env,
      tenantId,
      clientId
    );
    if (!settings.loginEnabled || !contract?.anonymousAuth?.enabled) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const requestedScopes =
      typeof challenge.metadata?.scope === 'string'
        ? challenge.metadata.scope.split(' ').filter(Boolean)
        : [];
    if (requestedScopes.some((scope) => !contract.anonymousAuth!.allowedScopes.includes(scope))) {
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
        !existingSession.data?.is_anonymous
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
    const proofId = `guest-human:${await guestResumeHash(secret, tenantId, body.authorizationChallengeId)}`;
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
        ttl: Math.max(1, Math.min(300, Math.ceil((challenge.expiresAt - Date.now()) / 1000))),
        metadata: { purpose: 'guest_human_verification', client_id: clientId },
      });
    }
    let route;
    try {
      route = await resolveAnonymousAccountRoute(c, credentialHash);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'account_data_route_not_found')
        throw error;
    }
    let userId = route?.legacyUserId;
    if (!userId) {
      const provisioned = await provisionAnonymousAccount(c, {
        tenantId,
        candidateUserId: await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env),
        device: {
          deviceIdHash: credentialHash,
          installationIdHash: null,
          fingerprintHash: null,
          platform: 'web',
          stability: 'installation',
          expiresInDays: null,
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
      const resolved = await resolveAccountDataContextFromHono(c, userId);
      if (resolved.accountId !== provisioned.accountId || resolved.legacyUserId !== userId)
        throw new Error('guest_account_route_mismatch');
    }
    const auth = createAccountAuthContextFromHono(c, tenantId);
    const pii = createPIIContextFromHono(c, tenantId);
    const credential = await auth.coreAdapter.queryOne<{
      user_id: string;
      created_at: number;
    }>(
      'SELECT user_id, created_at FROM anonymous_devices WHERE tenant_id = ? AND device_id_hash = ? AND is_active = TRUE',
      [tenantId, credentialHash],
      { consistencyClass: 'primary_required' }
    );
    if (
      !credential ||
      credential.user_id !== userId ||
      !Number.isFinite(credential.created_at) ||
      credential.created_at + RESUME_TTL_SECONDS * 1000 <= Date.now()
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
      user?.account_type !== 'anonymous'
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }
    const ttl = await resolveSessionTtl(c.env, tenantId, 'anonymous');
    const { stub, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);
    await stub.createSessionRpc(
      sessionId,
      userId,
      ttl.seconds,
      {
        ...getSessionClientMetadata(c.req.raw),
        amr: ['anon'],
        acr: 'urn:mace:incommon:iap:anonymous',
        is_anonymous: true,
        client_id: clientId,
        device_id_hash: credentialHash,
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

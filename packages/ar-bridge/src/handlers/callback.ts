/**
 * External IdP Callback Handler
 * GET/POST /auth/external/:provider/callback - Handle OAuth callback
 *
 * Most OAuth providers use GET with query parameters.
 * Apple Sign In uses POST with response_mode=form_post when name/email scope is requested.
 */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as jose from 'jose';
import type { Env } from '@authrim/ar-lib-core';
import {
  type DatabaseAdapter,
  getSessionStoreForNewSession,
  getUIConfig,
  buildIssuerUrl,
  shouldUseBuiltinForms,
  getDefaultTenantId,
  getTenantIdFromContext,
  createDiagnosticLoggerFromContext,
  getDiagnosticSessionId,
  DIAGNOSTIC_FLOW_ID_HEADER,
  createAuthContextFromHono,
  createPIIContextFromHono,
  CanonicalRuntimeUserStore,
  getCachedAuthCorePersistenceContextFromEnv,
  resolveAccountDataContextByIdentifier,
  // Challenge Store for auth_code generation
  getChallengeStoreByChallengeId,
  // Event System
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
  // Logger
  getLogger,
  createLogger,
  resolveAuthCorePersistenceAdapterFromEnv,
  // Audit Log
  createAuditLog,
  // Errors
  AR_ERROR_CODES,
  createErrorResponse,
  safeFetchJson,
} from '@authrim/ar-lib-core';
import { consumeAuthState, getAuthStateCookieName, matchesAuthStateCookie } from '../utils/state';
import { getProviderByIdOrSlug } from '../services/provider-store';
import { OIDCRPClient } from '../clients/oidc-client';
import { Fapi2Client } from '../clients/fapi2-client';
import { completeTenantD1ExternalIdpJIT, handleIdentity } from '../services/identity-stitching';
import { decrypt, encrypt, getEncryptionKeyOrUndefined } from '../utils/crypto';
import {
  ExternalIdPError,
  ExternalIdPErrorCode,
  type ExternalIdpAuthState,
  type HandleIdentityPendingResult,
  type HandleIdentityReadyResult,
  type TokenResponse,
  type UserInfo,
  type UpstreamProvider,
} from '../types';
import {
  GITHUB_USER_EMAILS_ENDPOINT,
  type GitHubEmail,
  type GitHubProviderQuirks,
} from '../providers/github';
import { type FacebookProviderQuirks, generateAppSecretProof } from '../providers/facebook';
import { type TwitterProviderQuirks } from '../providers/twitter';
import { isAppleProvider, type AppleProviderQuirks } from '../providers/apple';
import { generateAppleClientSecret, parseAppleUserData } from '../utils/apple-jwt';
import {
  UserInfoSubjectMismatchError,
  assertUserInfoSubjectMatches,
} from '../utils/userinfo-validation';
import {
  isFapi2Provider,
  loadFapi2ProviderConfig,
  type Fapi2ProviderConfig,
  validateFapi2ProviderMetadata,
} from '../services/fapi2-provider';

/**
 * Extract callback parameters from GET query string or POST form body
 * Apple Sign In uses POST with form_post response mode
 */
async function getCallbackParams(c: Context<{ Bindings: Env }>): Promise<{
  code: string | undefined;
  idToken: string | undefined;
  state: string | undefined;
  error: string | undefined;
  errorDescription: string | undefined;
  issuer: string | undefined;
  responseJwt: string | undefined;
  tenantId: string;
  user: string | undefined; // Apple-specific: user data JSON
}> {
  // Try GET parameters first (standard OAuth)
  const tenantId = getTenantIdFromContext(c);
  let code = c.req.query('code');
  let idToken = c.req.query('id_token');
  let state = c.req.query('state');
  let error = c.req.query('error');
  let errorDescription = c.req.query('error_description');
  let issuer = c.req.query('iss');
  let responseJwt = c.req.query('response');
  let user = c.req.query('user');

  // If POST request (Apple form_post), try to get from body
  if (c.req.method === 'POST') {
    try {
      const body = await c.req.parseBody();
      // POST body takes precedence over query params for OAuth response
      code = (body.code as string) || code;
      idToken = (body.id_token as string) || idToken;
      state = (body.state as string) || state;
      error = (body.error as string) || error;
      errorDescription = (body.error_description as string) || errorDescription;
      issuer = (body.iss as string) || issuer;
      responseJwt = (body.response as string) || responseJwt;
      // Apple-specific: user data is only in POST body
      user = (body.user as string) || user;
    } catch {
      // Body parsing failed, fall back to query params
    }
  }

  return { code, idToken, state, error, errorDescription, issuer, responseJwt, tenantId, user };
}

/**
 * Hybrid responses use fragment encoding by default. Fragments are never sent
 * to the server, so the browser relays an allowlisted set of parameters in a
 * same-origin POST. No fragment value is interpolated into this HTML.
 */
export function createHybridFragmentRelayResponse(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Completing sign-in</title></head>
<body><p>Completing sign-in…</p><script nonce="${nonce}">
(() => {
  const source = new URLSearchParams(location.hash.slice(1));
  const form = document.createElement('form');
  form.method = 'post';
  form.action = location.pathname + location.search;
  for (const name of ['code', 'id_token', 'state', 'error', 'error_description']) {
    const value = source.get(name);
    if (value === null) continue;
    const input = document.createElement('input');
    input.type = 'hidden'; input.name = name; input.value = value;
    form.append(input);
  }
  history.replaceState(null, '', location.pathname + location.search);
  document.body.append(form);
  form.submit();
})();
</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}

/**
 * Generate authorization code for Direct Auth token exchange
 * TTL: 60 seconds, single-use
 */
async function generateAuthCode(
  env: Env,
  tenantId: string,
  userId: string,
  codeChallenge: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const authCode = crypto.randomUUID();
  const challengeStore = await getChallengeStoreByChallengeId(env, authCode, tenantId);

  await challengeStore.storeChallengeRpc({
    id: `direct_auth:${authCode}`,
    tenantId,
    type: 'direct_auth_code',
    userId,
    challenge: codeChallenge, // Store code_challenge for verification
    ttl: 60, // 60 seconds
    metadata: {
      ...metadata,
      created_at: Date.now(),
    },
  });

  return authCode;
}

async function completeExternalAuthentication(
  c: Context<{ Bindings: Env }>,
  input: {
    authState: ExternalIdpAuthState;
    provider: UpstreamProvider;
    userInfo: UserInfo;
    upstreamIdToken?: string;
    result: HandleIdentityReadyResult;
  }
): Promise<Response> {
  const { authState, provider, userInfo, result } = input;
  const persistence = await getCachedAuthCorePersistenceContextFromEnv(c.env);
  if (persistence.storageProfileId === 'builtin:storage:tenant-d1') {
    const account = await resolveAccountDataContextByIdentifier(c.env, {
      tenantId: authState.tenantId,
      indexKind: 'external_subject',
      identifier: { issuer: provider.id, subject: userInfo.sub },
      expectedAccountId: `account:${result.userId}`,
    });
    (c as unknown as { set(key: string, value: unknown): void }).set('accountDataContext', account);
  }
  publishEvent(c, {
    type: AUTH_EVENTS.EXTERNAL_IDP_SUCCEEDED,
    tenantId: authState.tenantId,
    data: {
      userId: result.userId,
      method: 'external_idp',
      clientId: provider.id,
    } satisfies Omit<AuthEventData, 'sessionId'>,
  }).catch((eventError: unknown) => {
    getLogger(c)
      .module('CALLBACK')
      .error('Failed to publish auth.external_idp.succeeded', {}, eventError as Error);
  });

  const codeChallenge = authState.codeChallenge;
  if (!codeChallenge) {
    throw new ExternalIdPError(
      ExternalIdPErrorCode.CALLBACK_FAILED,
      'Missing code_challenge in auth state'
    );
  }
  const clientId = authState.clientId;
  if (!clientId) {
    throw new ExternalIdPError(
      ExternalIdPErrorCode.CALLBACK_FAILED,
      'Missing client_id in auth state'
    );
  }

  const tenantId = authState.tenantId;
  if (authState.enableSso !== false) {
    const authCtx = createAuthContextFromHono(c, tenantId);
    const piiCtx = createPIIContextFromHono(c, tenantId);
    const runtimeUsers = new CanonicalRuntimeUserStore({
      coreAdapter: authCtx.coreAdapter,
      piiAdapter: piiCtx.defaultPiiAdapter,
      tenantId,
    });
    const runtimeUser = await runtimeUsers.findById(result.userId);
    if (!runtimeUser) return createErrorResponse(c, AR_ERROR_CODES.USER_INACTIVE);

    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);
    const sessionTTL = 24 * 60 * 60;
    const encryptionKey = getEncryptionKeyOrUndefined(c.env);
    const upstreamIdTokenEncrypted =
      input.upstreamIdToken && encryptionKey
        ? await encrypt(input.upstreamIdToken, encryptionKey)
        : undefined;
    await sessionStore.createSessionRpc(
      sessionId,
      result.userId,
      sessionTTL,
      {
        email: userInfo.email || null,
        name: userInfo.name || null,
        amr: ['external_idp'],
        acr: 'urn:mace:incommon:iap:bronze',
        client_id: clientId,
        external_idp: provider.id,
        external_provider_id: provider.id,
        external_provider_sub: userInfo.sub,
        external_provider_sid: typeof userInfo.sid === 'string' ? userInfo.sid : undefined,
        upstream_id_token_encrypted: upstreamIdTokenEncrypted,
      },
      tenantId
    );
    await recordExternalProviderSession(c.env, {
      tenantId,
      sessionId,
      userId: result.userId,
      providerId: provider.id,
      providerSub: userInfo.sub,
      providerSid: typeof userInfo.sid === 'string' ? userInfo.sid : undefined,
      expiresAt: Date.now() + sessionTTL * 1000,
    });

    const issuerUrl = buildIssuerUrl(c.env, tenantId);
    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: issuerUrl.startsWith('https://'),
      sameSite: 'Lax',
      maxAge: sessionTTL,
    });

    const handoffToken = crypto.randomUUID();
    const handoffStore = await getChallengeStoreByChallengeId(c.env, handoffToken, tenantId);
    await handoffStore.storeChallengeRpc({
      id: `handoff:${handoffToken}`,
      tenantId,
      type: 'handoff',
      userId: result.userId,
      challenge: sessionId,
      ttl: 30,
      metadata: {
        client_id: clientId,
        state: authState.state,
        aud: 'handoff',
        created_at: Date.now(),
      },
    });
    const redirectUrl = new URL(authState.redirectUri);
    redirectUrl.searchParams.set('handoff_token', handoffToken);
    redirectUrl.searchParams.set('state', authState.state);
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl.toString(),
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    });
  }

  const authCode = await generateAuthCode(c.env, tenantId, result.userId, codeChallenge, {
    method: 'external_idp',
    provider: provider.id,
    provider_id: provider.id,
    provider_slug: provider.slug ?? provider.id,
    client_id: clientId,
    is_new_user: result.isNewUser,
    stitched_from_existing: result.stitchedFromExisting,
  });
  const redirectUrl = new URL(authState.redirectUri);
  redirectUrl.searchParams.set('code', authCode);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl.toString(),
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });
}

const EXTERNAL_PROVISIONING_TTL_SECONDS = 5 * 60;
const EXTERNAL_PROVISIONING_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const SAFE_CONTINUATION_TENANT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

interface ExternalIdpProvisioningContinuation {
  schemaVersion: 1;
  authState: ExternalIdpAuthState;
  providerId: string;
  userInfo: UserInfo;
  upstreamIdToken?: string;
  result: HandleIdentityPendingResult;
}

function randomContinuationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function continuationDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function continuationCookieName(digest: string): string {
  return `authrim_external_provisioning_${digest.slice(0, 24)}`;
}

async function beginExternalIdpProvisioningContinuation(
  c: Context<{ Bindings: Env }>,
  continuation: Omit<ExternalIdpProvisioningContinuation, 'schemaVersion'>
): Promise<Response> {
  const encryptionKey = getEncryptionKeyOrUndefined(c.env);
  if (!encryptionKey) throw new Error('RP_TOKEN_ENCRYPTION_KEY is not configured');
  const token = randomContinuationToken();
  const digest = await continuationDigest(token);
  const id = `external_idp_provisioning:${digest}`;
  const payload = JSON.stringify({ schemaVersion: 1, ...continuation });
  if (new TextEncoder().encode(payload).byteLength > 48 * 1024) {
    throw new Error('external_idp_provisioning_continuation_too_large');
  }
  const store = await getChallengeStoreByChallengeId(c.env, id, continuation.authState.tenantId);
  await store.storeChallengeRpc({
    id,
    tenantId: continuation.authState.tenantId,
    type: 'external_idp_provisioning_resume',
    userId: continuation.result.userId,
    challenge: digest,
    ttl: EXTERNAL_PROVISIONING_TTL_SECONDS,
    metadata: { schema_version: 1, encrypted_payload: await encrypt(payload, encryptionKey) },
  });
  const issuerUrl = buildIssuerUrl(c.env, continuation.authState.tenantId);
  setCookie(c, continuationCookieName(digest), digest, {
    path: '/',
    httpOnly: true,
    secure: issuerUrl.startsWith('https://'),
    sameSite: 'Lax',
    maxAge: EXTERNAL_PROVISIONING_TTL_SECONDS,
  });
  const redirect = new URL(continuation.authState.redirectUri);
  redirect.searchParams.set('provisioning_token', token);
  redirect.searchParams.set('provisioning_tenant', continuation.authState.tenantId);
  redirect.searchParams.set('state', continuation.authState.state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function parseContinuation(value: string): ExternalIdpProvisioningContinuation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('external_idp_provisioning_continuation_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('external_idp_provisioning_continuation_invalid');
  }
  const continuation = parsed as Partial<ExternalIdpProvisioningContinuation>;
  const authState = continuation.authState as Partial<ExternalIdpAuthState> | undefined;
  const result = continuation.result as Partial<HandleIdentityPendingResult> | undefined;
  const userInfo = continuation.userInfo as Partial<UserInfo> | undefined;
  const boundedString = (candidate: unknown, maximumLength = 2048): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= maximumLength;
  if (
    continuation.schemaVersion !== 1 ||
    !authState ||
    !result ||
    !userInfo ||
    result.status !== 'pending' ||
    result.isNewUser !== true ||
    result.stitchedFromExisting !== false ||
    !boundedString(authState.id, 256) ||
    !boundedString(authState.tenantId, 256) ||
    !SAFE_CONTINUATION_TENANT.test(authState.tenantId) ||
    !boundedString(authState.providerId, 256) ||
    !boundedString(authState.state, 2048) ||
    !boundedString(authState.redirectUri, 4096) ||
    !boundedString(authState.clientId, 256) ||
    !boundedString(authState.codeChallenge, 2048) ||
    !Number.isSafeInteger(authState.expiresAt) ||
    !Number.isSafeInteger(authState.createdAt) ||
    !boundedString(continuation.providerId, 256) ||
    continuation.providerId !== authState.providerId ||
    !boundedString(userInfo.sub) ||
    !boundedString(result.userId, 256) ||
    !boundedString(result.accountId, 256) ||
    !boundedString(result.operationId, 256) ||
    !boundedString(result.providerId, 256) ||
    !boundedString(result.providerUserId) ||
    result.accountId !== `account:${result.userId}` ||
    continuation.providerId !== result.providerId ||
    userInfo.sub !== result.providerUserId
  ) {
    throw new Error('external_idp_provisioning_continuation_invalid');
  }
  return continuation as ExternalIdpProvisioningContinuation;
}

async function loadExternalIdpContinuation(
  c: Context<{ Bindings: Env }>,
  token: string,
  tenantId: string
): Promise<{
  digest: string;
  id: string;
  store: Awaited<ReturnType<typeof getChallengeStoreByChallengeId>>;
  continuation: ExternalIdpProvisioningContinuation;
}> {
  if (!EXTERNAL_PROVISIONING_TOKEN.test(token) || !SAFE_CONTINUATION_TENANT.test(tenantId)) {
    throw new Error('external_idp_provisioning_token_invalid');
  }
  const digest = await continuationDigest(token);
  if (!matchesAuthStateCookie(digest, getCookie(c, continuationCookieName(digest)))) {
    throw new Error('external_idp_provisioning_browser_binding_failed');
  }
  const id = `external_idp_provisioning:${digest}`;
  const store = await getChallengeStoreByChallengeId(c.env, id, tenantId);
  const challenge = await store.getChallengeRpc(id);
  const encryptedPayload = challenge?.metadata?.encrypted_payload;
  if (
    !challenge ||
    challenge.type !== 'external_idp_provisioning_resume' ||
    challenge.tenantId !== tenantId ||
    challenge.challenge !== digest ||
    challenge.consumed ||
    challenge.expiresAt <= Date.now() ||
    typeof encryptedPayload !== 'string'
  ) {
    throw new Error('external_idp_provisioning_token_invalid');
  }
  const encryptionKey = getEncryptionKeyOrUndefined(c.env);
  if (!encryptionKey) throw new Error('external_idp_provisioning_key_unavailable');
  const continuation = parseContinuation(await decrypt(encryptedPayload, encryptionKey));
  if (
    continuation.authState.tenantId !== tenantId ||
    continuation.result.userId !== challenge.userId
  ) {
    throw new Error('external_idp_provisioning_continuation_invalid');
  }
  return { digest, id, store, continuation };
}

export async function handleExternalProvisioningStatus(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const encodedBody = await c.req.text();
    if (new TextEncoder().encode(encodedBody).byteLength > 4096) {
      throw new Error('external_idp_provisioning_request_too_large');
    }
    const body = JSON.parse(encodedBody) as unknown;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, 'provisioning_token') ||
      !Object.hasOwn(body, 'tenant_id') ||
      typeof (body as Record<string, unknown>).provisioning_token !== 'string' ||
      typeof (body as Record<string, unknown>).tenant_id !== 'string'
    ) {
      throw new Error('external_idp_provisioning_token_invalid');
    }
    const request = body as { provisioning_token: string; tenant_id: string };
    const loaded = await loadExternalIdpContinuation(
      c,
      request.provisioning_token,
      request.tenant_id
    );
    const provisioner = c.env.EXTERNAL_IDP_ACCOUNT_PROVISIONER;
    if (!provisioner) throw new Error('external_idp_account_provisioner_unavailable');
    const expected = loaded.continuation.result;
    const status = await provisioner.getExternalIdpAccountProvisioningStatus({
      schemaVersion: 1,
      tenantId: loaded.continuation.authState.tenantId,
      operationId: expected.operationId,
      flow: 'external_idp',
    });
    if (
      status.operationId !== expected.operationId ||
      status.accountId !== expected.accountId ||
      status.userId !== expected.userId
    ) {
      throw new Error('external_idp_provisioning_status_mismatch');
    }
    if (status.status === 'failed') {
      await loaded.store.consumeChallengeRpc({
        id: loaded.id,
        tenantId: loaded.continuation.authState.tenantId,
        type: 'external_idp_provisioning_resume',
        challenge: loaded.digest,
      });
      deleteCookie(c, continuationCookieName(loaded.digest), { path: '/' });
    }
    return c.json(
      status.status === 'ready'
        ? {
            status: 'ready',
            resume_url: `/auth/external/provisioning/resume?token=${encodeURIComponent(request.provisioning_token)}&tenant=${encodeURIComponent(request.tenant_id)}`,
          }
        : status.status === 'failed'
          ? { status: 'failed' }
          : { status: 'pending', retry_after_ms: 500 },
      status.status === 'ready' ? 200 : status.status === 'failed' ? 409 : 202,
      { 'Cache-Control': 'no-store' }
    );
  } catch {
    return c.json({ error: 'invalid_or_expired_provisioning_continuation' }, 400, {
      'Cache-Control': 'no-store',
    });
  }
}

export async function handleExternalProvisioningResume(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const token = c.req.query('token');
    const tenantId = c.req.query('tenant');
    if (!token || !tenantId) throw new Error('external_idp_provisioning_token_invalid');
    const loaded = await loadExternalIdpContinuation(c, token, tenantId);
    const expected = loaded.continuation.result;
    const provisioner = c.env.EXTERNAL_IDP_ACCOUNT_PROVISIONER;
    if (!provisioner) throw new Error('external_idp_account_provisioner_unavailable');
    const status = await provisioner.getExternalIdpAccountProvisioningStatus({
      schemaVersion: 1,
      tenantId,
      operationId: expected.operationId,
      flow: 'external_idp',
    });
    if (
      status.status !== 'ready' ||
      status.operationId !== expected.operationId ||
      status.accountId !== expected.accountId ||
      status.userId !== expected.userId
    ) {
      throw new Error('external_idp_provisioning_not_ready');
    }
    const completed = await completeTenantD1ExternalIdpJIT(c.env, {
      tenantId,
      userId: expected.userId,
      providerId: expected.providerId,
      providerUserId: expected.providerUserId,
    });
    const consumed = await loaded.store.consumeChallengeRpc({
      id: loaded.id,
      tenantId,
      type: 'external_idp_provisioning_resume',
      challenge: loaded.digest,
    });
    if (consumed.userId !== expected.userId) {
      throw new Error('external_idp_provisioning_consume_mismatch');
    }
    deleteCookie(c, continuationCookieName(loaded.digest), { path: '/' });
    const provider = await getProviderByIdOrSlug(c.env, loaded.continuation.providerId, tenantId);
    if (!provider || provider.id !== expected.providerId || !completed.linkedIdentityId) {
      throw new Error('external_idp_provisioning_provider_mismatch');
    }
    return await completeExternalAuthentication(c, {
      authState: loaded.continuation.authState,
      provider,
      userInfo: loaded.continuation.userInfo,
      upstreamIdToken: loaded.continuation.upstreamIdToken,
      result: {
        status: 'ready',
        userId: expected.userId,
        isNewUser: true,
        linkedIdentityId: completed.linkedIdentityId,
        stitchedFromExisting: false,
        roles_assigned: completed.roles_assigned,
        orgs_joined: completed.orgs_joined,
      },
    });
  } catch {
    return redirectWithError(
      c,
      ExternalIdPErrorCode.CALLBACK_FAILED,
      'Authentication could not be resumed. Please try again.'
    );
  }
}

/**
 * Handle OAuth callback from external IdP
 *
 * Query/Body Parameters:
 * - code: Authorization code from provider
 * - state: State parameter for CSRF validation
 * - error: Error code (if authorization failed)
 * - error_description: Error description
 * - user: (Apple only) JSON with user name, only on first authorization
 */
export async function handleExternalCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('CALLBACK');
  const providerIdOrSlug = c.req.param('provider');
  if (!providerIdOrSlug) return redirectWithError(c, 'invalid_request', 'Missing provider');
  const callbackParams = await getCallbackParams(c);
  let { code, state, error, errorDescription, issuer } = callbackParams;
  const { idToken, responseJwt, tenantId, user } = callbackParams;
  let diagnosticLogger: Awaited<ReturnType<typeof createDiagnosticLoggerFromContext>> = null;
  let diagnosticSessionId: string | undefined;
  let diagnosticFlowId: string | undefined;
  let fapi2Flow = false;
  let fapi2Stage:
    | 'authorization-response'
    | 'provider-metadata'
    | 'token-response'
    | 'id-token'
    | 'resource-response' = 'authorization-response';
  // Declared outside the try block for failure event and diagnostic correlation.
  let provider: UpstreamProvider | null = null;

  if (c.req.method === 'GET' && !code && !state && !error && !responseJwt) {
    return createHybridFragmentRelayResponse();
  }

  try {
    // 1. Get provider configuration first (by slug or ID)
    provider = await getProviderByIdOrSlug(c.env, providerIdOrSlug, tenantId);
    if (!provider) {
      return redirectWithError(c, 'unknown_provider', 'Provider not found');
    }

    diagnosticLogger = await createDiagnosticLoggerFromContext(c, {
      tenantId,
      clientId: provider.clientId,
    }).catch(() => null);
    diagnosticSessionId = getDiagnosticSessionId(c);
    fapi2Flow = isFapi2Provider(provider);

    if (responseJwt && !state) {
      try {
        state = extractUnverifiedJarmState(responseJwt);
      } catch {
        await logCallbackRejection(log, diagnosticLogger, {
          diagnosticSessionId,
          validationError: 'malformed_jarm',
          fapi2: fapi2Flow,
        });
        return redirectWithError(c, 'invalid_request', 'Invalid JARM response');
      }
    }

    if (!state) {
      await logCallbackRejection(log, diagnosticLogger, {
        diagnosticSessionId,
        validationError: 'missing_state',
        fapi2: fapi2Flow,
      });
      return redirectWithError(c, 'invalid_request', 'Missing state');
    }

    const stateCookieName = await getAuthStateCookieName(state);
    if (!matchesAuthStateCookie(state, getCookie(c, stateCookieName))) {
      await logCallbackRejection(log, diagnosticLogger, {
        diagnosticSessionId,
        validationError: 'browser_state_binding_failed',
        fapi2: fapi2Flow,
      });
      return redirectWithError(c, 'invalid_state', 'State is not bound to this browser');
    }
    deleteCookie(c, stateCookieName, { path: '/auth/external/' });

    // 2. Validate state and get stored data
    const authState = await consumeAuthState(c.env, state);
    if (!authState) {
      await logCallbackRejection(log, diagnosticLogger, {
        diagnosticSessionId,
        validationError: 'invalid_or_expired_state',
        fapi2: fapi2Flow,
      });
      return redirectWithError(c, 'invalid_state', 'State validation failed or expired');
    }

    // Verify the provider ID matches (authState always stores the actual ID)
    if (authState.providerId !== provider.id) {
      await logCallbackRejection(log, diagnosticLogger, {
        diagnosticSessionId,
        validationError: 'provider_mismatch',
        fapi2: fapi2Flow,
      });
      return redirectWithError(c, 'invalid_state', 'Provider mismatch');
    }

    const flowId = authState.flowId;
    diagnosticFlowId = flowId;
    if (flowId) {
      c.header(DIAGNOSTIC_FLOW_ID_HEADER, flowId);
    }

    // 3. Get client secret (Apple requires dynamic JWT generation)
    let clientSecret: string;
    if (isAppleProvider(provider)) {
      // Apple: Generate JWT client_secret from private key
      const quirks = provider.providerQuirks as unknown as AppleProviderQuirks;
      const encryptionKey = getEncryptionKeyOrUndefined(c.env);
      if (!encryptionKey) {
        throw new Error('RP_TOKEN_ENCRYPTION_KEY is not configured');
      }
      const privateKey = await decrypt(quirks.privateKeyEncrypted, encryptionKey);
      clientSecret = await generateAppleClientSecret(
        quirks.teamId,
        provider.clientId,
        quirks.keyId,
        privateKey,
        quirks.clientSecretTtl || 2592000 // Default 30 days
      );
    } else {
      // Standard: Decrypt stored client secret
      clientSecret = await decryptClientSecret(c.env, provider.clientSecretEncrypted);
    }

    // 4. Build callback URL (use slug if available, same as in start)
    const providerIdentifier = provider.slug || provider.id;
    const callbackTenantId = authState.tenantId || tenantId;
    const callbackUri = `${buildIssuerUrl(c.env, callbackTenantId)}/auth/external/${providerIdentifier}/callback`;
    const client = OIDCRPClient.fromProvider(provider, callbackUri, clientSecret);

    const fapi2Enabled = fapi2Flow;
    let fapi2Config: Fapi2ProviderConfig | undefined;
    let fapi2Client: Fapi2Client | undefined;
    let fapi2Metadata: Awaited<ReturnType<OIDCRPClient['discover']>> | undefined;
    if (fapi2Enabled) {
      fapi2Stage = 'provider-metadata';
      const encryptionKey = getEncryptionKeyOrUndefined(c.env);
      if (!encryptionKey) throw new Error('RP_TOKEN_ENCRYPTION_KEY is not configured');
      fapi2Config = await loadFapi2ProviderConfig(provider, encryptionKey);
      fapi2Metadata = await client.discover();
      validateFapi2ProviderMetadata(fapi2Metadata, fapi2Config.profile, fapi2Config);
      await recordCallbackDiagnostic(log, () =>
        diagnosticLogger?.logTokenValidation({
          diagnosticSessionId,
          flowId,
          step: 'fapi2-provider-metadata-validation',
          tokenType: 'provider_metadata',
          result: 'pass',
          details: { issuer_valid: true, profile: fapi2Config?.profile },
        })
      );
      fapi2Client = new Fapi2Client({
        issuer: fapi2Metadata.issuer,
        clientId: provider.clientId,
        redirectUri: callbackUri,
        clientAssertionPrivateJwk: fapi2Config.clientAssertionPrivateJwk,
        dpopPrivateJwk: fapi2Config.dpopPrivateJwk,
      });
      fapi2Stage = 'authorization-response';
      if (fapi2Config.jarm) {
        if (!responseJwt) {
          throw new ExternalIdPError(
            ExternalIdPErrorCode.CALLBACK_FAILED,
            'Missing JARM authorization response'
          );
        }
        if (!fapi2Metadata.jwks_uri) {
          throw new Error('FAPI2 JARM provider metadata has no jwks_uri');
        }
        const jwks = await safeFetchJson<jose.JSONWebKeySet>(fapi2Metadata.jwks_uri, {
          timeoutMs: 5_000,
          maxResponseSize: 256 * 1024,
        });
        const jarm = await fapi2Client.validateJarmResponse({
          responseJwt,
          jwks,
          expectedState: state,
          signingAlgorithm: fapi2Config.authorizationSignedResponseAlg,
        });
        code = jarm.code;
        state = jarm.state;
        issuer = jarm.iss;
        error = jarm.error;
        errorDescription = jarm.error_description;
      } else if (responseJwt) {
        throw new ExternalIdPError(
          ExternalIdPErrorCode.CALLBACK_FAILED,
          'Unexpected JARM authorization response'
        );
      }
      if (!provider.issuer || issuer !== provider.issuer) {
        throw new ExternalIdPError(
          ExternalIdPErrorCode.CALLBACK_FAILED,
          issuer ? 'FAPI2 authorization response issuer mismatch' : 'Missing FAPI2 issuer parameter'
        );
      }
      await recordCallbackDiagnostic(log, () =>
        diagnosticLogger?.logTokenValidation({
          diagnosticSessionId,
          flowId,
          step: 'fapi2-authorization-response-validation',
          tokenType: fapi2Config?.jarm ? 'jarm' : 'authorization_response',
          result: 'pass',
          details: {
            issuer_valid: true,
            state_valid: true,
            signature_valid: fapi2Config?.jarm ? true : undefined,
          },
        })
      );
    }

    // Provider errors are processed only after state binding and, for JARM,
    // signature/issuer/audience validation have completed.
    if (error) {
      log.error('External IdP returned error', { error });
      return redirectWithError(c, error, errorDescription);
    }
    if (!code) {
      return redirectWithError(c, 'invalid_request', 'Missing code');
    }

    // 4b. Log authorization response (OIDF conformance)
    if (diagnosticLogger) {
      await diagnosticLogger.logAuthDecision({
        diagnosticSessionId,
        flowId,
        decision: 'allow',
        reason: 'authorization_response',
        flow: 'external_idp',
        context: {
          provider: provider.slug ?? provider.id,
          client_id: provider.clientId,
          authrim_client_id: authState.clientId,
          redirect_uri: callbackUri,
          state_present: true,
          code_present: true,
          state_bound_to_browser: true,
        },
      });
    }

    // 5. Exchange code for tokens
    if (!authState.codeVerifier) {
      throw new ExternalIdPError(
        ExternalIdPErrorCode.CALLBACK_FAILED,
        'Missing code_verifier in auth state'
      );
    }

    const responseType =
      provider.providerQuirks?.responseType === 'code id_token' ? 'code id_token' : 'code';
    let authorizationIdTokenClaims: UserInfo | undefined;
    if (responseType === 'code id_token') {
      if (!idToken) {
        throw new ExternalIdPError(
          ExternalIdPErrorCode.CALLBACK_FAILED,
          'Missing authorization response ID token for Hybrid Flow'
        );
      }
      if (!authState.nonce) {
        throw new ExternalIdPError(
          ExternalIdPErrorCode.CALLBACK_FAILED,
          'Missing nonce for Hybrid Flow ID token validation'
        );
      }
      authorizationIdTokenClaims = await client.validateIdToken(
        idToken,
        {
          nonce: authState.nonce,
          code,
          requireCodeHash: true,
          maxAge: authState.maxAge,
          acrValues: authState.acrValues,
        },
        diagnosticLogger ? { logger: diagnosticLogger, flowId, diagnosticSessionId } : undefined
      );
    }

    let tokens: TokenResponse;
    let requestContext;
    let fapi2IdTokenSigningAlgorithms: string[] | undefined;
    if (fapi2Enabled && fapi2Config) {
      fapi2Stage = 'token-response';
      const metadata = fapi2Metadata ?? (await client.discover());
      validateFapi2ProviderMetadata(metadata, fapi2Config.profile, fapi2Config);
      fapi2IdTokenSigningAlgorithms = metadata.id_token_signing_alg_values_supported;
      if (!fapi2Client) throw new Error('FAPI2 client was not initialized');
      tokens = await fapi2Client.exchangeCode({
        tokenEndpoint: metadata.token_endpoint,
        code,
        codeVerifier: authState.codeVerifier,
      });
      requestContext = {
        tokenEndpoint: metadata.token_endpoint,
        authMethod: 'private_key_jwt',
        authHeaderPresent: false,
      };
      await recordCallbackDiagnostic(log, () =>
        diagnosticLogger?.logTokenValidation({
          diagnosticSessionId,
          flowId,
          step: 'fapi2-token-response-validation',
          tokenType: 'token_response',
          result: 'pass',
          details: {
            access_token_present: true,
            token_type_valid: tokens.token_type.toLowerCase() === 'dpop',
            expires_in_present: tokens.expires_in !== undefined,
          },
        })
      );
    } else {
      ({ tokens, requestContext } = await client.exchangeCode(code, authState.codeVerifier));
    }

    if (diagnosticLogger) {
      await diagnosticLogger.logTokenValidation({
        diagnosticSessionId,
        flowId,
        step: 'token-request',
        tokenType: 'authorization_code',
        result: 'pass',
        details: {
          token_endpoint: requestContext.tokenEndpoint,
          auth_method: requestContext.authMethod,
          auth_header_present: requestContext.authHeaderPresent,
          grant_type: 'authorization_code',
          redirect_uri: callbackUri,
          client_id: provider.clientId,
          authorization_code_present: true,
          code_verifier_present: true,
        },
      });

      await diagnosticLogger.logTokenValidation({
        diagnosticSessionId,
        flowId,
        step: 'token-response',
        tokenType: 'token',
        token: tokens.access_token,
        result: 'pass',
        details: {
          token_endpoint: requestContext.tokenEndpoint,
          token_type: tokens.token_type,
          expires_in: tokens.expires_in,
          scope: tokens.scope,
          access_token: tokens.access_token,
          id_token: tokens.id_token,
          refresh_token: tokens.refresh_token,
        },
      });
    }

    // 6. Validate ID token and/or fetch user info
    let userInfo;
    let idTokenSub: string | undefined;
    const diagnostics = diagnosticLogger
      ? {
          logger: diagnosticLogger,
          flowId,
          diagnosticSessionId,
        }
      : undefined;
    if (provider.providerType === 'oidc' && tokens.id_token && authState.nonce) {
      if (fapi2Enabled) fapi2Stage = 'id-token';
      // Use the new options-based signature for comprehensive OIDC validation
      userInfo = await client.validateIdToken(
        tokens.id_token,
        {
          nonce: authState.nonce,
          accessToken: tokens.access_token, // For at_hash validation if present
          maxAge: authState.maxAge, // For auth_time validation if max_age was requested
          acrValues: authState.acrValues, // For acr validation if acr_values was requested
          requireExactAudience: fapi2Enabled,
          expectedSigningAlgorithms: fapi2IdTokenSigningAlgorithms,
        },
        diagnostics
      );
      idTokenSub = userInfo.sub;
      if (
        authorizationIdTokenClaims &&
        (authorizationIdTokenClaims.iss !== userInfo.iss ||
          authorizationIdTokenClaims.sub !== userInfo.sub)
      ) {
        throw new ExternalIdPError(
          ExternalIdPErrorCode.CALLBACK_FAILED,
          'Hybrid Flow ID token issuer or subject mismatch'
        );
      }

      // Optionally fetch userinfo even when id_token is present
      // Enable this for OIDC RP certification testing or when userinfo has additional claims
      if (fapi2Client && fapi2Config?.resourceUrl) {
        fapi2Stage = 'resource-response';
        const resourceData = await fapi2Client.fetchResource({
          resourceUrl: fapi2Config.resourceUrl,
          accessToken: tokens.access_token,
        });
        if (idTokenSub && typeof resourceData.sub === 'string') {
          assertUserInfoSubjectMatches(idTokenSub, resourceData.sub);
        }
        await recordCallbackDiagnostic(log, () =>
          diagnosticLogger?.logTokenValidation({
            diagnosticSessionId,
            flowId,
            step: 'fapi2-resource-response-validation',
            tokenType: 'resource_response',
            result: 'pass',
            details: {
              dpop_authorization_scheme_accepted: true,
              subject_consistent:
                !idTokenSub ||
                typeof resourceData.sub !== 'string' ||
                resourceData.sub === idTokenSub,
            },
          })
        );
        userInfo = { ...userInfo, ...resourceData };
      } else if (provider.alwaysFetchUserinfo && !fapi2Client) {
        try {
          const {
            userInfo: userinfoData,
            endpoint,
            signedResponse,
          } = await client.fetchUserInfoWithMeta(tokens.access_token);
          if (diagnosticLogger) {
            await diagnosticLogger.logTokenValidation({
              diagnosticSessionId,
              flowId,
              step: 'userinfo-request',
              tokenType: 'access_token',
              token: tokens.access_token,
              result: 'pass',
              details: {
                endpoint,
              },
            });
            await diagnosticLogger.logTokenValidation({
              diagnosticSessionId,
              flowId,
              step: 'userinfo-response',
              tokenType: 'access_token',
              token: tokens.access_token,
              result: 'pass',
              details: {
                endpoint,
                claims: userinfoData,
                signed_response: signedResponse,
              },
            });
          }
          if (idTokenSub && userinfoData.sub && userinfoData.sub !== idTokenSub) {
            if (diagnosticLogger) {
              await diagnosticLogger.logTokenValidation({
                diagnosticSessionId,
                flowId,
                step: 'userinfo-mismatch',
                tokenType: 'id_token',
                result: 'fail',
                errorMessage: 'Userinfo sub claim does not match ID token sub',
                details: {
                  expected_sub: idTokenSub,
                  actual_sub: userinfoData.sub,
                },
              });
            }
            assertUserInfoSubjectMatches(idTokenSub, userinfoData.sub);
          }
          // Merge userinfo data (userinfo may have additional claims not in id_token)
          userInfo = { ...userInfo, ...userinfoData };
        } catch (error) {
          if (error instanceof UserInfoSubjectMismatchError) throw error;
          // Userinfo fetch failure is not fatal - we already have claims from id_token
          log.warn('Userinfo fetch failed, using id_token claims only');
        }
      }
    } else if (fapi2Client && fapi2Config?.resourceUrl) {
      fapi2Stage = 'resource-response';
      const resourceData = await fapi2Client.fetchResource({
        resourceUrl: fapi2Config.resourceUrl,
        accessToken: tokens.access_token,
      });
      await recordCallbackDiagnostic(log, () =>
        diagnosticLogger?.logTokenValidation({
          diagnosticSessionId,
          flowId,
          step: 'fapi2-resource-response-validation',
          tokenType: 'resource_response',
          result: 'pass',
          details: { dpop_authorization_scheme_accepted: true },
        })
      );
      // Plain OAuth resource responses commonly use an ecosystem-specific
      // account identifier. attributeMapping normalizes it to `sub` below.
      userInfo = resourceData as UserInfo;
    } else {
      const {
        userInfo: userinfoData,
        endpoint,
        signedResponse,
      } = await client.fetchUserInfoWithMeta(tokens.access_token);
      if (diagnosticLogger) {
        await diagnosticLogger.logTokenValidation({
          diagnosticSessionId,
          flowId,
          step: 'userinfo-request',
          tokenType: 'access_token',
          token: tokens.access_token,
          result: 'pass',
          details: {
            endpoint,
          },
        });
        await diagnosticLogger.logTokenValidation({
          diagnosticSessionId,
          flowId,
          step: 'userinfo-response',
          tokenType: 'access_token',
          token: tokens.access_token,
          result: 'pass',
          details: {
            endpoint,
            claims: userinfoData,
            signed_response: signedResponse,
          },
        });
      }
      userInfo = userinfoData;
    }

    // 6.2. Apple-specific: Parse user data from POST body (first authorization only)
    // Apple returns name info in a JSON 'user' parameter, not in the ID token
    // Note: 'user' is extracted by getCallbackParams() from POST body for form_post mode
    if (isAppleProvider(provider)) {
      const appleUserData = parseAppleUserData(user);
      if (appleUserData) {
        // Merge Apple user data (name only provided on first auth)
        if (appleUserData.name) userInfo.name = appleUserData.name;
        if (appleUserData.given_name) userInfo.given_name = appleUserData.given_name;
        if (appleUserData.family_name) userInfo.family_name = appleUserData.family_name;
        // Note: email from ID token is more reliable than from user param
      }
    }

    // 6.3. GitHub-specific: Fetch primary email from /user/emails if needed
    // GitHub's /user endpoint may not return email if it's set to private
    if (isGitHubProvider(provider) && !userInfo.email) {
      const quirks = provider.providerQuirks as GitHubProviderQuirks | undefined;
      const fetchPrimaryEmail = quirks?.fetchPrimaryEmail !== false; // Default: true

      if (fetchPrimaryEmail) {
        const emailInfo = await fetchGitHubPrimaryEmail(
          tokens.access_token,
          quirks?.allowUnverifiedEmail || false
        );
        if (emailInfo) {
          userInfo.email = emailInfo.email;
          userInfo.email_verified = emailInfo.verified;
        }
      }
    }

    // 6.4. Facebook-specific: Re-fetch with app_secret_proof if enabled
    if (isFacebookProvider(provider) && provider.providerType === 'oauth2') {
      const quirks = provider.providerQuirks as FacebookProviderQuirks | undefined;
      if (quirks?.useAppSecretProof) {
        const facebookUserInfo = await fetchFacebookUserInfo(
          tokens.access_token,
          clientSecret,
          quirks
        );
        if (facebookUserInfo) {
          userInfo = { ...userInfo, ...facebookUserInfo };
        }
      }
    }

    // 6.5. Twitter-specific: Re-fetch with user.fields if configured
    if (isTwitterProvider(provider) && provider.providerType === 'oauth2') {
      const quirks = provider.providerQuirks as TwitterProviderQuirks | undefined;
      if (quirks?.userFields) {
        const twitterUserInfo = await fetchTwitterUserInfo(tokens.access_token, quirks);
        if (twitterUserInfo) {
          userInfo = { ...userInfo, ...twitterUserInfo };
        }
      }
    }

    // 6.5. Normalize userinfo using attributeMapping (important for OAuth2 providers)
    // OAuth2 providers like GitHub may use different claim names (e.g., "id" instead of "sub")
    userInfo = normalizeUserInfo(userInfo, provider.attributeMapping);

    // Ensure sub is present (required for identity linking)
    if (!userInfo.sub) {
      return redirectWithError(
        c,
        ExternalIdPErrorCode.CALLBACK_FAILED,
        'Provider did not return a user identifier. Check attributeMapping configuration.'
      );
    }

    // 7. Handle identity stitching or account creation
    const result = await handleIdentity(c.env, {
      provider,
      userInfo,
      tokens,
      linkingUserId: authState.userId,
      tenantId: authState.tenantId,
    });

    if (result.status === 'pending') {
      return await beginExternalIdpProvisioningContinuation(c, {
        authState,
        providerId: provider.id,
        userInfo,
        upstreamIdToken: tokens.id_token,
        result,
      });
    }
    return await completeExternalAuthentication(c, {
      authState,
      provider,
      userInfo,
      upstreamIdToken: tokens.id_token,
      result,
    });
  } catch (error) {
    log.error('Callback error', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorCode:
        error instanceof ExternalIdPError
          ? error.code
          : classifyFapi2CallbackError(error) || ExternalIdPErrorCode.CALLBACK_FAILED,
    });

    if (diagnosticLogger && fapi2Flow) {
      const validationError = classifyFapi2CallbackError(error);
      await recordCallbackDiagnostic(log, () =>
        diagnosticLogger?.logTokenValidation({
          diagnosticSessionId,
          flowId: diagnosticFlowId,
          step: `fapi2-${fapi2Stage}-validation`,
          tokenType: fapi2Stage.replaceAll('-', '_'),
          result: 'fail',
          errorMessage: validationError,
          details: { validation_error: validationError },
        })
      );
      await recordCallbackDiagnostic(log, () =>
        diagnosticLogger?.logAuthDecision({
          diagnosticSessionId,
          flowId: diagnosticFlowId,
          decision: 'deny',
          reason: 'fapi2_callback_rejected',
          flow: 'fapi2',
          context: {
            validation_stage: fapi2Stage,
            validation_error: validationError,
          },
        })
      );
    }

    // Determine error code for event
    let errorCode: string = ExternalIdPErrorCode.CALLBACK_FAILED;
    if (error instanceof ExternalIdPError) {
      errorCode = error.code;
    } else if (error instanceof Error && error.message.includes('acr')) {
      errorCode = ExternalIdPErrorCode.ACR_VALUES_NOT_SATISFIED;
    }

    // Publish authentication failure event (non-blocking)
    // SECURITY: Use validated provider.id, fallback to 'invalid_provider' to prevent log injection
    publishEvent(c, {
      type: AUTH_EVENTS.EXTERNAL_IDP_FAILED,
      tenantId,
      data: {
        method: 'external_idp',
        clientId: provider?.id || 'invalid_provider',
        errorCode,
      } satisfies AuthEventData,
    }).catch((err: unknown) => {
      log.error('Failed to publish auth.external_idp.failed', {}, err as Error);
    });

    // Handle specific ExternalIdPError with appropriate error codes
    // SECURITY: Do not expose internal error details in redirect URL
    if (error instanceof ExternalIdPError) {
      return redirectWithError(c, error.code, 'Authentication failed. Please try again.');
    }

    // Handle generic errors
    if (error instanceof Error) {
      // Check for specific OIDC validation errors
      if (error.message.includes('acr')) {
        // ACR validation failed - the authentication level doesn't meet requirements
        return redirectWithError(
          c,
          ExternalIdPErrorCode.ACR_VALUES_NOT_SATISFIED,
          'The authentication level does not meet the required security level. Please try again with a stronger authentication method.'
        );
      }

      log.error('Unexpected error in callback', {});
      return redirectWithError(
        c,
        ExternalIdPErrorCode.CALLBACK_FAILED,
        'An error occurred during authentication. Please try again.'
      );
    }

    return redirectWithError(
      c,
      ExternalIdPErrorCode.CALLBACK_FAILED,
      'Authentication failed. Please try again.'
    );
  } finally {
    if (diagnosticLogger) {
      await diagnosticLogger.cleanup().catch((cleanupError: unknown) => {
        log.warn('Failed to flush callback diagnostic logs', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
    }
  }
}

async function recordCallbackDiagnostic(
  log: ReturnType<ReturnType<typeof getLogger>['module']>,
  write: () => Promise<void> | undefined
): Promise<void> {
  try {
    await write();
  } catch (error) {
    log.warn('Failed to record callback diagnostic event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function logCallbackRejection(
  log: ReturnType<ReturnType<typeof getLogger>['module']>,
  diagnosticLogger: Awaited<ReturnType<typeof createDiagnosticLoggerFromContext>>,
  options: {
    diagnosticSessionId?: string;
    flowId?: string;
    validationError: string;
    fapi2: boolean;
  }
): Promise<void> {
  if (!diagnosticLogger) return;
  if (options.fapi2) {
    await recordCallbackDiagnostic(log, () =>
      diagnosticLogger.logTokenValidation({
        diagnosticSessionId: options.diagnosticSessionId,
        flowId: options.flowId,
        step: 'fapi2-authorization-response-validation',
        tokenType: 'authorization_response',
        result: 'fail',
        errorMessage: options.validationError,
        details: { validation_error: options.validationError },
      })
    );
  }
  await recordCallbackDiagnostic(log, () =>
    diagnosticLogger.logAuthDecision({
      diagnosticSessionId: options.diagnosticSessionId,
      flowId: options.flowId,
      decision: 'deny',
      reason: options.fapi2 ? 'fapi2_callback_rejected' : 'authorization_response_rejected',
      flow: options.fapi2 ? 'fapi2' : 'external_idp',
      context: {
        validation_stage: 'authorization-response',
        validation_error: options.validationError,
      },
    })
  );
}

export function classifyFapi2CallbackError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const exact = new Map<string, string>([
    ['Malformed JARM response', 'malformed_jarm'],
    ['Missing JARM authorization response', 'missing_jarm_response'],
    ['Unexpected JARM authorization response', 'unexpected_jarm_response'],
    ['FAPI2 authorization response issuer mismatch', 'issuer_mismatch'],
    ['Missing FAPI2 issuer parameter', 'missing_issuer'],
    ['JARM response audience must contain only the client_id', 'audience_mismatch'],
    ['JARM response state mismatch', 'state_mismatch'],
    ['JARM response missing iss', 'missing_issuer'],
    ['JARM response missing state', 'missing_state'],
    ['JARM response has invalid code', 'invalid_code'],
    ['JARM response has invalid error', 'invalid_error'],
    ['JARM response contains neither code nor error', 'missing_code_or_error'],
    ['Token response missing access_token', 'missing_access_token'],
    ['Token response token_type must be DPoP', 'invalid_token_type'],
    ['Token response has invalid expires_in', 'invalid_expires_in'],
  ]);
  const known = exact.get(message);
  if (known) return known;

  const joseError = error as { code?: unknown; claim?: unknown; reason?: unknown };
  const code = typeof joseError?.code === 'string' ? joseError.code : '';
  const claim = typeof joseError?.claim === 'string' ? joseError.claim : '';
  const reason = typeof joseError?.reason === 'string' ? joseError.reason : '';
  const missing = reason.toLowerCase().includes('missing');
  if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') return 'unexpected_signing_algorithm';
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'invalid_signature';
  if (code === 'ERR_JWKS_NO_MATCHING_KEY') return 'signing_key_not_found';
  if (code === 'ERR_JWS_INVALID' || code === 'ERR_JWT_INVALID') return 'malformed_jwt';
  if (code === 'ERR_JWT_EXPIRED') return 'expired_expiration';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    if (claim === 'iss') return missing ? 'missing_issuer' : 'issuer_mismatch';
    if (claim === 'aud') return missing ? 'missing_audience' : 'audience_mismatch';
    if (claim === 'exp') return missing ? 'missing_expiration' : 'invalid_expiration';
    if (claim === 'nonce') return missing ? 'missing_nonce' : 'nonce_mismatch';
    return missing ? 'missing_required_claim' : 'claim_validation_failed';
  }
  if (message.includes('nonce'))
    return message.includes('missing') ? 'missing_nonce' : 'nonce_mismatch';
  if (message.includes('audience')) return 'audience_mismatch';
  if (message.includes('issuer')) return 'issuer_mismatch';
  if (message.includes('signature')) return 'invalid_signature';
  return 'fapi2_validation_failed';
}

export function extractUnverifiedJarmState(responseJwt: string): string | undefined {
  try {
    const unverified = jose.decodeJwt(responseJwt);
    return typeof unverified.state === 'string' ? unverified.state : undefined;
  } catch {
    throw new Error('Malformed JARM response');
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Redirect with error parameters
 * Uses UI config if available, falls back to issuer URL
 */
async function redirectWithError(
  c: Context<{ Bindings: Env }>,
  error: string,
  description?: string
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const uiConfig = await getUIConfig(c.env);

  let baseUrl: string;
  if (uiConfig?.baseUrl) {
    baseUrl = uiConfig.baseUrl;
  } else {
    // Fallback to issuer URL
    baseUrl = buildIssuerUrl(c.env, tenantId);
  }

  const loginPath = uiConfig?.paths?.login || '/login';
  const redirectUrl = new URL(loginPath, baseUrl);
  redirectUrl.searchParams.set('error', error);
  if (description) {
    redirectUrl.searchParams.set('error_description', description);
  }
  // Add tenant_hint for UI branding (UX only)
  if (tenantId && tenantId !== getDefaultTenantId(c.env)) {
    redirectUrl.searchParams.set('tenant_hint', tenantId);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl.toString(),
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });
}

interface ExternalProviderSessionRecord {
  userId: string;
  tenantId: string;
  sessionId: string;
  providerId: string;
  providerSub: string;
  providerSid?: string;
  expiresAt: number;
}

/**
 * Record the same external-provider binding in D1 that is stored in the
 * sharded SessionStore. Back-channel logout uses this index to find sessions
 * without scanning Durable Object shards.
 */
async function recordExternalProviderSession(
  env: Env,
  options: ExternalProviderSessionRecord
): Promise<void> {
  try {
    const coreAdapter: DatabaseAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
      env,
      'bridge-callback-session-record',
      { tenantId: options.tenantId }
    );
    await coreAdapter.execute(
      `INSERT INTO sessions (
         id, user_id, expires_at, created_at, external_provider_id, external_provider_sub,
         external_provider_sid, tenant_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         external_provider_id = excluded.external_provider_id,
         external_provider_sub = excluded.external_provider_sub,
         external_provider_sid = excluded.external_provider_sid,
         expires_at = excluded.expires_at`,
      [
        options.sessionId,
        options.userId,
        options.expiresAt,
        Date.now(),
        options.providerId,
        options.providerSub,
        options.providerSid ?? null,
        options.tenantId,
      ]
    );
  } catch {
    // Authentication still succeeds if the secondary logout index is
    // temporarily unavailable; the Durable Object remains authoritative.
    createLogger().module('CALLBACK').warn('Failed to record session in D1 for backchannel logout');
  }
}

/**
 * Build session cookie
 */
function buildSessionCookie(sessionId: string, issuerUrl: string): string {
  const domain = new URL(issuerUrl).hostname;
  const isSecure = issuerUrl.startsWith('https://');

  const parts = [
    `authrim_session=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=3600', // 1 hour
  ];

  if (isSecure) {
    parts.push('Secure');
  }

  // Don't set domain for localhost
  if (!domain.includes('localhost') && !domain.includes('127.0.0.1')) {
    parts.push(`Domain=${domain}`);
  }

  return parts.join('; ');
}

/**
 * Decrypt client secret
 * Requires RP_TOKEN_ENCRYPTION_KEY to be configured
 */
async function decryptClientSecret(env: Env, encrypted: string): Promise<string> {
  const encryptionKey = getEncryptionKeyOrUndefined(env);

  if (!encryptionKey) {
    throw new Error('RP_TOKEN_ENCRYPTION_KEY is not configured');
  }

  return decrypt(encrypted, encryptionKey);
}

/**
 * Normalize userinfo using provider's attributeMapping
 *
 * This is critical for OAuth2 providers that don't follow OIDC conventions:
 * - GitHub uses "id" (number) instead of "sub" (string)
 * - Twitter uses "data.id" (nested)
 * - Facebook uses "id" instead of "sub"
 *
 * The attributeMapping allows mapping provider-specific claims to standard OIDC claims.
 *
 * Example attributeMapping for GitHub:
 * {
 *   "sub": "id",
 *   "name": "name",
 *   "email": "email",
 *   "picture": "avatar_url"
 * }
 *
 * @param userInfo - Raw userinfo from provider
 * @param attributeMapping - Mapping from OIDC claim names to provider claim names
 * @returns Normalized userinfo with standard claim names
 */
function normalizeUserInfo(userInfo: UserInfo, attributeMapping: Record<string, string>): UserInfo {
  // If no mapping provided, return as-is (assume OIDC-compliant provider)
  if (!attributeMapping || Object.keys(attributeMapping).length === 0) {
    return userInfo;
  }

  const normalized: UserInfo = { ...userInfo };

  // Apply attribute mapping
  for (const [targetClaim, sourcePath] of Object.entries(attributeMapping)) {
    const value = getNestedValue(userInfo, sourcePath);
    if (value !== undefined) {
      // Convert numbers to strings for sub (required for OIDC compatibility)
      if (targetClaim === 'sub' && typeof value === 'number') {
        (normalized as Record<string, unknown>)[targetClaim] = String(value);
      } else {
        (normalized as Record<string, unknown>)[targetClaim] = value;
      }
    }
  }

  return normalized;
}

/**
 * Get a nested value from an object using dot notation
 * e.g., getNestedValue(obj, "data.user.id") returns obj.data.user.id
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// =============================================================================
// URL Host Checking Helper
// =============================================================================

/**
 * Safely check if a URL's host matches expected hosts
 * This prevents URL substring attacks like "evil.com/api.github.com"
 *
 * @param url - The URL string to check
 * @param allowedHosts - Array of allowed hostnames (exact match or subdomain)
 * @returns true if the URL's host matches one of the allowed hosts
 */
function urlHostMatches(url: string | undefined, allowedHosts: string[]): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return allowedHosts.some((allowed) => {
      const normalizedAllowed = allowed.toLowerCase();
      // Exact match or subdomain match (e.g., "api.github.com" matches "github.com")
      return host === normalizedAllowed || host.endsWith('.' + normalizedAllowed);
    });
  } catch {
    return false;
  }
}

// =============================================================================
// GitHub-specific helpers
// =============================================================================

/**
 * Check if a provider is GitHub (by checking endpoints or name)
 */
function isGitHubProvider(provider: UpstreamProvider): boolean {
  // Check by userinfo endpoint - must be github.com domain
  if (urlHostMatches(provider.userinfoEndpoint, ['api.github.com', 'github.com'])) {
    return true;
  }
  // Check by authorization endpoint - must be github.com domain
  if (urlHostMatches(provider.authorizationEndpoint, ['github.com'])) {
    return true;
  }
  // Check by name (case insensitive)
  if (provider.name.toLowerCase().includes('github')) {
    return true;
  }
  return false;
}

/**
 * Fetch primary verified email from GitHub /user/emails API
 *
 * GitHub's /user endpoint may not return email if:
 * - User has set their email to private
 * - User has no public email
 *
 * The /user/emails endpoint returns all user emails with verification status.
 * Requires `user:email` scope.
 *
 * @param accessToken - GitHub access token
 * @param allowUnverified - Whether to accept unverified emails (not recommended)
 * @returns Primary email info or null if not found
 */
async function fetchGitHubPrimaryEmail(
  accessToken: string,
  allowUnverified: boolean = false
): Promise<{ email: string; verified: boolean } | null> {
  try {
    const emails = await safeFetchJson<GitHubEmail[]>(GITHUB_USER_EMAILS_ENDPOINT, {
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    // Find primary email
    const primaryEmail = emails.find((e) => e.primary);

    if (!primaryEmail) {
      const log = createLogger().module('CALLBACK');
      log.warn('GitHub: No primary email found');
      return null;
    }

    // Check if email is verified (security requirement)
    if (!primaryEmail.verified && !allowUnverified) {
      const log = createLogger().module('CALLBACK');
      log.warn('GitHub: Primary email is not verified');
      return null;
    }

    return {
      email: primaryEmail.email,
      verified: primaryEmail.verified,
    };
  } catch (error) {
    const log = createLogger().module('CALLBACK');
    log.error('Failed to fetch GitHub emails', {}, error as Error);
    return null;
  }
}

// =============================================================================
// Facebook-specific helpers
// =============================================================================

/**
 * Check if a provider is Facebook
 */
function isFacebookProvider(provider: UpstreamProvider): boolean {
  // Check by authorization endpoint - must be facebook.com domain
  if (urlHostMatches(provider.authorizationEndpoint, ['facebook.com', 'www.facebook.com'])) {
    return true;
  }
  // Check by token endpoint - must be graph.facebook.com domain
  if (urlHostMatches(provider.tokenEndpoint, ['graph.facebook.com'])) {
    return true;
  }
  // Check by name (case insensitive)
  if (provider.name.toLowerCase().includes('facebook')) {
    return true;
  }
  return false;
}

/**
 * Fetch user info from Facebook Graph API with app_secret_proof
 *
 * @param accessToken - Facebook access token
 * @param appSecret - Facebook app secret (for app_secret_proof)
 * @param quirks - Facebook provider quirks
 * @returns User info or null if failed
 */
async function fetchFacebookUserInfo(
  accessToken: string,
  appSecret: string,
  quirks?: FacebookProviderQuirks
): Promise<Record<string, unknown> | null> {
  try {
    const apiVersion = quirks?.apiVersion || 'v20.0';
    const fields = quirks?.fields?.join(',') || 'id,name,email,picture.type(large)';

    const url = new URL(`https://graph.facebook.com/${apiVersion}/me`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('access_token', accessToken);

    // Add app_secret_proof if enabled
    if (quirks?.useAppSecretProof) {
      const proof = await generateAppSecretProof(accessToken, appSecret);
      url.searchParams.set('appsecret_proof', proof);
    }

    const data = await safeFetchJson<Record<string, unknown>>(url.toString(), {
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
    });
    return data;
  } catch (error) {
    const log = createLogger().module('CALLBACK');
    log.error('Failed to fetch Facebook user info', {}, error as Error);
    return null;
  }
}

// =============================================================================
// Twitter-specific helpers
// =============================================================================

/**
 * Check if a provider is Twitter/X
 */
function isTwitterProvider(provider: UpstreamProvider): boolean {
  // Check by authorization endpoint - must be twitter.com or x.com domain
  if (urlHostMatches(provider.authorizationEndpoint, ['twitter.com', 'x.com'])) {
    return true;
  }
  // Check by token endpoint - must be api.twitter.com or api.x.com domain
  if (urlHostMatches(provider.tokenEndpoint, ['api.twitter.com', 'api.x.com'])) {
    return true;
  }
  // Check by name (case insensitive)
  const name = provider.name.toLowerCase();
  if (name.includes('twitter') || name === 'x') {
    return true;
  }
  return false;
}

/**
 * Fetch user info from Twitter API v2 with user.fields
 *
 * @param accessToken - Twitter access token
 * @param quirks - Twitter provider quirks
 * @returns User info or null if failed
 */
async function fetchTwitterUserInfo(
  accessToken: string,
  quirks?: TwitterProviderQuirks
): Promise<Record<string, unknown> | null> {
  try {
    const url = new URL('https://api.twitter.com/2/users/me');

    // Add user.fields
    const userFields = quirks?.userFields || 'id,name,username,profile_image_url';
    url.searchParams.set('user.fields', userFields);

    // Add expansions if specified
    if (quirks?.expansions) {
      url.searchParams.set('expansions', quirks.expansions);
    }

    const data = await safeFetchJson<Record<string, unknown>>(url.toString(), {
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return data;
  } catch (error) {
    const log = createLogger().module('CALLBACK');
    log.error('Failed to fetch Twitter user info', {}, error as Error);
    return null;
  }
}

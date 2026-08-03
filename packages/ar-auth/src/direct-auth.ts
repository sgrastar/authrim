/**
 * Direct Authentication API Handlers
 *
 * BetterAuth-style API for custom login pages.
 * Uses Authorization Code + PKCE pattern for security.
 *
 * Flow:
 * 1. start: Generate challenge, store with code_challenge, return challenge_id + WebAuthn/email options
 * 2. finish: Verify credential, verify PKCE, return direct_auth_artifact (60s TTL, single-use)
 * 3. token: Legacy token exchange endpoint returns a Phase 1 compatibility error
 *
 * Security:
 * - PKCE required for all flows
 * - Direct Auth artifact: 60 second TTL, single-use
 * - Challenge: 5 minute TTL, atomic consumption
 * - Origin validation via CORS allowlist
 * - No direct token return (artifact intermediate step)
 */

import { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import { getRefreshTokenRotatorStubByJti } from '@authrim/ar-lib-core/services/refresh-token-family-store';
import {
  isAllowedOrigin,
  parseAllowedOrigins,
  getSessionStoreBySessionId,
  getSessionStoreForNewSession,
  isShardedSessionId,
  getChallengeStoreByChallengeId,
  getChallengeStoreByUserId,
  getDefaultTenantId,
  getTenantIdFromContext,
  buildDOKey,
  buildDOInstanceName,
  getTenantSettings,
  generateId,
  generateUserIdFromSettings,
  createAuthContextFromHono,
  createPIIContextFromHono,
  createErrorResponse,
  createTenantPlacementWriteFenceResponse,
  AR_ERROR_CODES,
  // Event System
  publishEvent,
  AUTH_EVENTS,
  SESSION_EVENTS,
  type AuthEventData,
  type SessionEventData,
  // Logging
  getLogger,
  // Audit Log
  createAuditLog,
  // Timing-safe comparison
  timingSafeEqual,
  // Cookie Configuration
  getSessionCookieSameSite,
  // KV Client Cache
  getClient,
  getWebOriginRegistry,
  // Native SSO logout propagation
  isNativeSSOEnabled,
  normalizeDeviceSecretLogoutScope,
  revokeDeviceSecretsForLogoutScope,
  // Refresh Token
  listRefreshTokenFamiliesByUser,
  expireRefreshTokenFamiliesByUser,
  createCompatibilityErrorResponse,
  generateBrowserState,
  advancePasskeyAuthenticationState,
  isAccountAuthenticationDeniedError,
  BROWSER_STATE_COOKIE_NAME,
  getBrowserStateCookieSameSite,
  produceNotificationDelivery,
  resolvePostLoginRedirectUrl,
  CanonicalRuntimeUserStore,
  ensureDatabaseAdapter,
  getTenantMetadataContextFromHono,
  markOtpLoginEmailVerified,
  resolveOtpAccountCoreDataContextByIdentifierFromHono,
  resolveAccountDataContextFromHono,
  type CanonicalOtpLoginUser,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  applyInvitationAssignments,
  consumeInvitationUse,
  findActiveInvitationByToken,
  hasRemainingInvitationUses,
} from '@authrim/ar-lib-core/services/invitation-auth-core';

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

import { isoBase64URL } from '@simplewebauthn/server/helpers';

import type {
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';

import {
  generateEmailCode,
  hashEmailCode,
  verifyEmailCodeHash,
  hashEmail,
} from './utils/email-code-utils';
import { getEmailCodeHtml, getEmailCodeText } from './utils/email/templates';
import {
  buildCanonicalProfileRuntimeUserFields,
  persistRegistrationFieldValuesFromEnv,
  validateRegistrationFieldSubmissionFromEnv,
} from './registration-field-utils';
import {
  verifyHumanVerificationForAction,
  type HumanVerificationAction,
} from './human-verification';
import { resolveSessionTtl } from './session-ttl';
import { verifyEmailVerificationProtocol } from './email-verification-protocol';
import {
  buildAuthorizeContinuationUrl,
  createAuthorizationRequestContinuation,
} from './authorization-continuation';
import {
  publishTenantD1PasskeyRoute,
  provisionTenantD1EmailAccount,
  resolveTenantD1PasskeyAccountRoute,
  resolveTenantD1EmailAccountRoute,
  usesTenantD1AccountStorage,
} from './account-provisioning';

// ===== Constants =====

const RP_NAME = 'Authrim';
const CHALLENGE_TTL = 5 * 60; // 5 minutes
const AUTH_CODE_TTL = 60; // 60 seconds
const EMAIL_CODE_TTL = 5 * 60; // 5 minutes
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const DIRECT_AUTH_GRANT_REDIRECT_URI = 'https://authrim.local/direct-auth/callback';

type DirectAuthChannel = 'browser' | 'native' | 'server';

type AuthorizationChallengeType = 'login' | 'reauth';
type AuthenticationMethodUsage = 'login' | 'signup' | 'reauth' | 'account_link';

export interface AuthorizationChallengeContinuation {
  redirectUrl: string;
  type: AuthorizationChallengeType;
}

interface AuthorizationChallengeData {
  userId?: string;
  metadata?: Record<string, unknown>;
}

interface AuthenticationMethodKVSettings {
  'authentication-methods.passkey.enabled'?: boolean | string;
  'authentication-methods.passkey.login_enabled'?: boolean | string;
  'authentication-methods.passkey.signup_enabled'?: boolean | string;
  'authentication-methods.passkey.reauth_enabled'?: boolean | string;
  'authentication-methods.passkey.account_link_enabled'?: boolean | string;
  'authentication-methods.email_otp.enabled'?: boolean | string;
  'authentication-methods.email_otp.login_enabled'?: boolean | string;
  'authentication-methods.email_otp.signup_enabled'?: boolean | string;
  'authentication-methods.email_otp.reauth_enabled'?: boolean | string;
  'authentication-methods.email_otp.account_link_enabled'?: boolean | string;
}

function isDirectAuthChannel(channel: unknown): channel is DirectAuthChannel {
  return channel === 'browser' || channel === 'native' || channel === 'server';
}

function createCanonicalRuntimeUserStore(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): CanonicalRuntimeUserStore {
  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  return new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
}

type DirectAuthClientChannelMetadata = {
  application_type?: unknown;
  allowed_channels?: unknown;
  native_channel_allowed?: unknown;
};

export function isDirectAuthClientChannelAllowed(
  client: DirectAuthClientChannelMetadata,
  channel: DirectAuthChannel
): boolean {
  if (channel === 'native' && client.native_channel_allowed === false) {
    return false;
  }

  if (Array.isArray(client.allowed_channels) && client.allowed_channels.length > 0) {
    return client.allowed_channels.includes(channel);
  }

  if (channel === 'native') {
    return client.application_type === 'native';
  }

  if (client.application_type === 'native') {
    return false;
  }

  return true;
}

function normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

async function readAuthenticationMethodSettings(
  env: Env,
  tenantId: string
): Promise<AuthenticationMethodKVSettings> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AuthenticationMethodKVSettings) : {};
  } catch {
    return {};
  }
}

function methodUsageEnabled(
  settings: AuthenticationMethodKVSettings,
  method: 'passkey' | 'email_otp',
  usage: AuthenticationMethodUsage
): boolean {
  const legacyEnabled = settings[`authentication-methods.${method}.enabled`];
  const defaultEnabled = method === 'passkey';
  const legacyFallback = normalizeBooleanSetting(legacyEnabled, defaultEnabled);
  const key =
    usage === 'account_link'
      ? `authentication-methods.${method}.account_link_enabled`
      : `authentication-methods.${method}.${usage}_enabled`;
  return normalizeBooleanSetting(
    settings[key as keyof AuthenticationMethodKVSettings],
    legacyFallback
  );
}

async function isAuthenticationMethodUsageEnabled(
  env: Env,
  tenantId: string,
  method: 'passkey' | 'email_otp',
  usage: AuthenticationMethodUsage
): Promise<boolean> {
  const settings = await readAuthenticationMethodSettings(env, tenantId);
  return methodUsageEnabled(settings, method, usage);
}

async function rejectIfAuthenticationMethodDisabled(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  method: 'passkey' | 'email_otp',
  usage: AuthenticationMethodUsage
): Promise<Response | null> {
  const enabled = await isAuthenticationMethodUsageEnabled(c.env, tenantId, method, usage);
  if (enabled) return null;
  return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS, {
    extensions: {
      authentication_method: method,
      usage,
    },
  });
}

// WebAuthn transport types
type AuthenticatorTransport = 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid';

// PKCE code_challenge_method (only S256 is supported)
type CodeChallengeMethod = 'S256';

// ===== Type Definitions =====

/**
 * @simplewebauthn registrationInfo type compatibility layer
 */
interface RegistrationInfoCompat {
  credentialID?: Uint8Array;
  credentialPublicKey?: Uint8Array;
  counter?: number;
  aaguid?: string;
  credential?: {
    id: Uint8Array;
    publicKey: Uint8Array;
    counter: number;
  };
}

type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

// ===== Helper Functions =====

/**
 * Get allowed origins from env or KV (Settings Manager format)
 * Priority: env (ALLOWED_ORIGINS) > KV (tenant.allowed_origins) > ISSUER_URL
 */
async function getAllowedOriginsFromKV(env: Env, tenantId: string): Promise<string[]> {
  let allowedOriginsValue: string | undefined;

  const settings = await getTenantSettings(env.AUTHRIM_CONFIG, tenantId, 'tenant');
  if (settings && typeof settings['tenant.allowed_origins'] === 'string') {
    allowedOriginsValue = settings['tenant.allowed_origins'];
  }

  const allowedOriginsEnv = env.ALLOWED_ORIGINS || allowedOriginsValue || env.ISSUER_URL;
  return parseAllowedOrigins(allowedOriginsEnv);
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function originForHost(host: string): string[] {
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedHost) {
    return [];
  }

  const origins = [`https://${normalizedHost}`];
  const hostnameOnly = normalizedHost.split(':')[0];
  if (isLocalHost(hostnameOnly)) {
    origins.push(`http://${normalizedHost}`);
  }
  return origins;
}

/**
 * Allow Direct Auth browser calls made through the Login UI's same-origin proxy.
 *
 * In custom-domain deployments the browser origin is the tenant login host while
 * the upstream Worker URL may be the API host. The proxy forwards the original
 * host explicitly so the auth worker can still validate the browser origin.
 */
function isSameOriginBrowserRequest(
  c: Context<{ Bindings: Env }>,
  originHeader: string | undefined
): boolean {
  if (!originHeader) {
    return false;
  }

  const normalizedOrigin = normalizeOrigin(originHeader);
  const candidateOrigins = new Set<string>();

  try {
    candidateOrigins.add(normalizeOrigin(new URL(c.req.url).origin));
  } catch {
    // Ignore malformed or unavailable request URL and fall back to headers.
  }

  for (const headerName of ['x-authrim-forwarded-host', 'x-forwarded-host', 'host']) {
    const headerValue = c.req.header(headerName)?.split(',')[0]?.trim();
    if (!headerValue) {
      continue;
    }
    for (const origin of originForHost(headerValue)) {
      candidateOrigins.add(origin);
    }
  }

  return candidateOrigins.has(normalizedOrigin);
}

/**
 * Allow explicitly configured origins and the current request origin.
 *
 * This keeps same-origin passkey flows working on tenant subdomains even when
 * tenant.allowed_origins has not been populated with the tenant host yet.
 */
function isAllowedPasskeyRequestOrigin(
  c: Context<{ Bindings: Env }>,
  originHeader: string | undefined,
  allowedOrigins: string[]
): boolean {
  if (!originHeader) {
    return false;
  }

  const normalizedOrigin = normalizeOrigin(originHeader);
  if (isAllowedOrigin(normalizedOrigin, allowedOrigins)) {
    return true;
  }

  return isSameOriginBrowserRequest(c, originHeader);
}

function normalizeOriginHeaderValue(originHeader: string | undefined | null): string | undefined {
  if (!originHeader) {
    return undefined;
  }

  try {
    return new URL(originHeader).origin;
  } catch {
    return undefined;
  }
}

function getDirectAuthWebAuthnOrigin(
  c: Context<{ Bindings: Env }>,
  originHeader: string | undefined
): string | undefined {
  const browserOriginHeader = c.req.header('x-authrim-browser-origin');
  const isLoginUiProxy = c.req.header('x-authrim-ui-proxy') === 'login-ui';
  if (
    isLoginUiProxy &&
    browserOriginHeader &&
    originHeader &&
    isSameOriginBrowserRequest(c, originHeader)
  ) {
    const browserOrigin = normalizeOriginHeaderValue(browserOriginHeader);
    if (browserOrigin) {
      return browserOrigin;
    }
  }

  return normalizeOriginHeaderValue(originHeader);
}

/**
 * Normalize any credential identifier to an unpadded base64url string.
 */
function toBase64URLString(input: CredentialIDLike): string {
  if (typeof input === 'string') {
    if (isoBase64URL.isBase64URL(input)) {
      return isoBase64URL.trimPadding(input);
    }

    if (isoBase64URL.isBase64(input)) {
      const buffer = isoBase64URL.toBuffer(input, 'base64');
      return isoBase64URL.fromBuffer(buffer);
    }

    return isoBase64URL.fromUTF8String(input);
  }

  if (input instanceof ArrayBuffer) {
    return isoBase64URL.fromBuffer(new Uint8Array(input));
  }

  const view = input as ArrayBufferView;
  const typedArray = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  // @ts-ignore - TypeScript strict buffer type mismatch
  return isoBase64URL.fromBuffer(typedArray);
}

function normalizeStoredCredentialId(id?: string | null): string | null {
  if (!id) {
    return null;
  }
  return toBase64URLString(id);
}

function matchesPasskeyUserHandle(userHandle: string | undefined, userId: string): boolean {
  return (
    typeof userHandle === 'string' &&
    userHandle.length > 0 &&
    userHandle === isoBase64URL.fromUTF8String(userId)
  );
}

/**
 * Verify PKCE code_challenge using S256 method
 * Uses timing-safe comparison to prevent timing attacks
 */
async function verifyPKCE(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const computed = isoBase64URL.fromBuffer(new Uint8Array(digest));
  // Use timing-safe comparison to prevent timing attacks
  // This handles length differences securely without early return
  return timingSafeEqual(computed, codeChallenge);
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value ? value : undefined;
}

export async function consumeAuthorizationChallengeContinuation(
  env: Env,
  tenantId: string,
  challengeId: string,
  authenticatedUserId: string,
  authTime: number,
  fallbackIssuer: string
): Promise<AuthorizationChallengeContinuation | { error: Response }> {
  const challengeStore = await getChallengeStoreByChallengeId(env, challengeId, tenantId);
  let challengeData: AuthorizationChallengeData;
  let type: AuthorizationChallengeType;

  try {
    challengeData = (await challengeStore.consumeChallengeRpc({
      id: challengeId,
      tenantId,
      type: 'login',
      challenge: challengeId,
    })) as AuthorizationChallengeData;
    type = 'login';
  } catch {
    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: challengeId,
        tenantId,
        type: 'reauth',
        challenge: challengeId,
      })) as AuthorizationChallengeData;
      type = 'reauth';
    } catch {
      return {
        error: new Response(
          JSON.stringify({
            error: 'invalid_request',
            error_description: 'Authorization challenge is invalid or expired',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        ),
      };
    }
  }

  const metadata = challengeData.metadata || {};
  const expectedUserId =
    type === 'reauth'
      ? metadataString(metadata, 'sessionUserId') || challengeData.userId
      : undefined;
  if (expectedUserId && expectedUserId !== authenticatedUserId) {
    return {
      error: new Response(
        JSON.stringify({
          error: 'access_denied',
          error_description: 'Authenticated user does not match the re-authentication challenge',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  const confirmationId = crypto.randomUUID();
  const confirmationStore = await getChallengeStoreByChallengeId(env, confirmationId, tenantId);
  await confirmationStore.storeChallengeRpc({
    id: confirmationId,
    tenantId,
    type: 'reauth',
    userId: authenticatedUserId,
    challenge: confirmationId,
    ttl: 60,
    metadata: {
      purpose: 'authorize_confirmation',
      authTime,
      sessionUserId: expectedUserId || authenticatedUserId,
      authorization_request: createAuthorizationRequestContinuation(metadata),
    },
  });

  return {
    type,
    redirectUrl: buildAuthorizeContinuationUrl(metadata, confirmationId, fallbackIssuer),
  };
}

export async function readAuthorizationChallengeType(
  env: Env,
  tenantId: string,
  challengeId: string | undefined
): Promise<AuthorizationChallengeType | null> {
  if (!challengeId) return null;

  try {
    const challengeStore = await getChallengeStoreByChallengeId(env, challengeId, tenantId);
    const challenge = (await challengeStore.getChallengeRpc(challengeId)) as {
      tenantId?: string;
      type?: string;
    } | null;
    if (challenge?.tenantId !== tenantId) return null;
    if (challenge.type === 'login' || challenge.type === 'reauth') return challenge.type;
  } catch {
    return null;
  }

  return null;
}

async function resolveDirectStartTurnstileAction(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  authorizationChallengeId: string | undefined
): Promise<HumanVerificationAction | { error: Response }> {
  if (!authorizationChallengeId) return 'login';

  const challengeType = await readAuthorizationChallengeType(
    c.env,
    tenantId,
    authorizationChallengeId
  );
  if (!challengeType) {
    return {
      error: await createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'authorization_challenge_id' },
      }),
    };
  }

  return challengeType;
}

async function validateDirectAuthClient(
  c: Context<{ Bindings: Env }>,
  clientId: string,
  channel: DirectAuthChannel,
  origin?: string | null
): Promise<{ valid: boolean; errorResponse?: Response }> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);

  const client = await getClient(c.env, tenantId, clientId, authCtx.coreAdapter);

  if (!client) {
    return {
      valid: false,
      errorResponse: await createErrorResponse(c, AR_ERROR_CODES.CLIENT_INVALID),
    };
  }

  if (!isDirectAuthClientChannelAllowed(client, channel)) {
    return {
      valid: false,
      errorResponse: await createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE),
    };
  }

  // Browser Direct Auth uses web_origin_registry as the canonical origin allowlist.
  // allowed_redirect_origins is only a legacy fallback for deployments without registry rows.
  if (origin) {
    const registry = await getWebOriginRegistry(
      c.env,
      tenantId,
      clientId,
      authCtx.coreAdapter
    ).catch(() => ({ origins: [] }));
    const allowedOrigins =
      registry.origins.length > 0
        ? registry.origins.filter((entry) => entry.handoff_allowed).map((entry) => entry.origin)
        : (client.allowed_redirect_origins ?? []);
    if (
      allowedOrigins.length > 0 &&
      !isAllowedOrigin(origin, allowedOrigins) &&
      !(channel === 'browser' && isSameOriginBrowserRequest(c, origin))
    ) {
      return {
        valid: false,
        errorResponse: await createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS),
      };
    }
  }

  return { valid: true };
}

// ===== Platform Detection =====

type PlatformType = 'web' | 'mobile' | 'desktop' | 'unknown';

/**
 * Detect platform from request headers
 */
function detectPlatform(origin?: string | null, userAgent?: string | null): PlatformType {
  // Web: Origin header present indicates browser request
  if (origin) {
    return 'web';
  }

  // Mobile/Desktop: Detect from User-Agent
  if (userAgent) {
    const ua = userAgent.toLowerCase();

    // Mobile detection
    if (
      ua.includes('android') ||
      ua.includes('iphone') ||
      ua.includes('ipad') ||
      ua.includes('mobile') ||
      ua.includes('okhttp') || // Android HTTP client
      (ua.includes('darwin') && ua.includes('cfnetwork')) // iOS HTTP client
    ) {
      return 'mobile';
    }

    // Desktop detection
    if (
      ua.includes('windows') ||
      ua.includes('macintosh') ||
      ua.includes('linux') ||
      ua.includes('x11')
    ) {
      return 'desktop';
    }
  }

  return 'unknown';
}

// ===== Session Helper Functions =====

/**
 * Get session ID from cookie or Authorization header
 */
function getSessionIdFromRequest(c: Context<{ Bindings: Env }>): string | null {
  // Try cookie first
  const cookieSession = getCookie(c, 'authrim_session');
  if (cookieSession) {
    return cookieSession;
  }

  // Try Authorization header
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}

/**
 * Validate session and return session data
 */
async function validateSession(
  c: Context<{ Bindings: Env }>,
  sessionId: string
): Promise<Session | null> {
  if (!isShardedSessionId(sessionId)) {
    return null;
  }

  const { stub: sessionStore } = getSessionStoreBySessionId(
    c.env,
    sessionId,
    getTenantIdFromContext(c)
  );
  const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

  if (!session) {
    return null;
  }

  // Check expiration
  if (session.expiresAt <= Date.now()) {
    return null;
  }

  return session;
}

/**
 * Generate auth_code and store in ChallengeStore
 */
async function generateAuthCode(
  env: Env,
  tenantId: string,
  userId: string,
  codeChallenge: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const authCode = crypto.randomUUID();
  const clientId = typeof metadata?.client_id === 'string' ? metadata.client_id : undefined;
  const scope = typeof metadata?.scope === 'string' ? metadata.scope : 'openid profile email';

  if (!clientId) {
    throw new Error('Direct Auth artifact requires client_id binding');
  }

  const authCodeStoreId = env.AUTH_CODE_STORE.idFromName(
    buildDOInstanceName('auth-code', tenantId)
  );
  const authCodeStore = env.AUTH_CODE_STORE.get(authCodeStoreId);

  await authCodeStore.storeCodeRpc({
    code: authCode,
    tenantId,
    clientId,
    redirectUri: DIRECT_AUTH_GRANT_REDIRECT_URI,
    userId,
    scope,
    codeChallenge,
    codeChallengeMethod: 'S256',
    authTime:
      typeof metadata?.auth_time === 'number' ? metadata.auth_time : Math.floor(Date.now() / 1000),
    acr: 'urn:mace:incommon:iap:bronze',
  });

  const challengeStore = await getChallengeStoreByChallengeId(env, authCode, tenantId);

  await challengeStore.storeChallengeRpc({
    id: `direct_auth:${authCode}`,
    tenantId,
    type: 'direct_auth_code',
    userId,
    challenge: codeChallenge, // Store code_challenge for verification
    ttl: AUTH_CODE_TTL, // 60 seconds
    metadata: {
      ...metadata,
      created_at: Date.now(),
    },
  });

  return authCode;
}

// ===== Passkey Login Handlers =====

/**
 * Passkey Login Start
 * POST /api/v1/auth/direct/passkey/login/start
 */
export async function directPasskeyLoginStartHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      client_id: string;
      code_challenge: string;
      code_challenge_method: CodeChallengeMethod;
      channel: DirectAuthChannel;
      scope?: string;
      email?: string; // Accepted for backward compatibility; passkey discovery ignores it.
      authorization_challenge_id?: string;
      human_verification_response?: string;
      cf_turnstile_response?: string;
    }>();

    const {
      client_id,
      code_challenge,
      code_challenge_method,
      channel,
      scope,
      authorization_challenge_id,
      human_verification_response,
      cf_turnstile_response,
    } = body;

    // Validate required fields
    if (!client_id || !code_challenge || code_challenge_method !== 'S256' || !channel) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id, code_challenge, code_challenge_method=S256, channel' },
      });
    }
    if (!isDirectAuthChannel(channel)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const tenantId = getTenantIdFromContext(c);
    const turnstileAction = await resolveDirectStartTurnstileAction(
      c,
      tenantId,
      authorization_challenge_id
    );
    if (typeof turnstileAction !== 'string') return turnstileAction.error;
    const methodDisabledError = await rejectIfAuthenticationMethodDisabled(
      c,
      tenantId,
      'passkey',
      turnstileAction
    );
    if (methodDisabledError) return methodDisabledError;
    const turnstileError = await verifyHumanVerificationForAction(
      c,
      turnstileAction,
      human_verification_response ?? cf_turnstile_response
    );
    if (turnstileError) return turnstileError;

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const webAuthnOrigin = getDirectAuthWebAuthnOrigin(c, originHeader);
    const clientValidation = await validateDirectAuthClient(c, client_id, channel, webAuthnOrigin);
    if (!clientValidation.valid) {
      return clientValidation.errorResponse as Response;
    }

    const allowedOrigins = await getAllowedOriginsFromKV(c.env, tenantId);

    if (!webAuthnOrigin || !isAllowedPasskeyRequestOrigin(c, webAuthnOrigin, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    const originUrl = new URL(webAuthnOrigin);
    const rpID = originUrl.hostname;

    // Generate authentication options
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      // Passkey login is discoverable; email is reserved for OTP/profile collection flows.
      allowCredentials: [],
    });

    // Store challenge with code_challenge in ChallengeStore
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challengeId,
      getTenantIdFromContext(c)
    );

    await challengeStore.storeChallengeRpc({
      id: `direct_passkey_login:${challengeId}`,
      tenantId: getTenantIdFromContext(c),
      type: 'direct_passkey_login',
      userId: 'unknown', // Will be determined during verification
      challenge: options.challenge,
      ttl: CHALLENGE_TTL,
      metadata: {
        code_challenge,
        client_id,
        channel,
        scope,
        transaction_id: challengeId,
        origin: webAuthnOrigin,
        rpID,
        authorization_challenge_id,
      },
    });

    return c.json({
      challenge_id: challengeId,
      options: {
        challenge: options.challenge,
        timeout: options.timeout,
        rpId: options.rpId,
        allowCredentials: options.allowCredentials,
        userVerification: options.userVerification,
        extensions: options.extensions,
      },
    });
  } catch (error) {
    log.error('Direct passkey login start error', {
      action: 'login_start',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Passkey Login Finish
 * POST /api/v1/auth/direct/passkey/login/finish
 */
export async function directPasskeyLoginFinishHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      challenge_id: string;
      credential: AuthenticationResponseJSON;
      code_verifier: string;
      channel: DirectAuthChannel;
    }>();

    const { challenge_id, credential, code_verifier, channel } = body;

    if (!challenge_id || !credential || !code_verifier || !channel) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id, credential, code_verifier, channel' },
      });
    }
    if (!isDirectAuthChannel(channel)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Consume challenge atomically
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challenge_id,
      getTenantIdFromContext(c)
    );

    let challengeData: {
      challenge: string;
      metadata?: {
        code_challenge: string;
        client_id: string;
        channel: DirectAuthChannel;
        scope?: string;
        transaction_id?: string;
        email?: string;
        origin: string;
        rpID: string;
        authorization_challenge_id?: string;
      };
    };

    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `direct_passkey_login:${challenge_id}`,
        tenantId: getTenantIdFromContext(c),
        type: 'direct_passkey_login',
      })) as typeof challengeData;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Verify PKCE
    const isValidPKCE = await verifyPKCE(
      code_verifier,
      challengeData.metadata?.code_challenge || ''
    );
    if (!isValidPKCE) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }
    if (challengeData.metadata?.channel !== channel) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Get credential ID and lookup passkey
    const credentialIDBase64URL = toBase64URLString(credential.id);
    const tenantId = getTenantIdFromContext(c);
    const origin = challengeData.metadata?.origin || '';
    const rpID = challengeData.metadata?.rpID || '';
    let accountRoute;
    try {
      accountRoute = await resolveTenantD1PasskeyAccountRoute(c, {
        credentialId: credentialIDBase64URL,
        rpId: rpID,
      });
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }
    const authCtx = createAuthContextFromHono(c, tenantId);

    let passkey = await authCtx.repositories.passkey.findByCredentialId(credentialIDBase64URL);

    // Legacy fallback
    if (!passkey && isoBase64URL.isBase64URL(credentialIDBase64URL)) {
      const legacyId = isoBase64URL.toBase64(credentialIDBase64URL);
      passkey = await authCtx.repositories.passkey.findByCredentialId(legacyId);

      if (passkey) {
        await authCtx.coreAdapter.execute(
          'UPDATE passkeys SET credential_id = ? WHERE id = ? AND tenant_id = ?',
          [credentialIDBase64URL, passkey.id, tenantId]
        );
        passkey.credential_id = credentialIDBase64URL;
      }
    }

    if (!passkey) {
      publishEvent(c, {
        type: AUTH_EVENTS.PASSKEY_FAILED,
        tenantId,
        data: {
          method: 'passkey',
          clientId: challengeData.metadata?.client_id || 'direct-auth',
          errorCode: 'credential_not_found',
        } satisfies AuthEventData,
      }).catch(() => {});

      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED, {
        extensions: {
          webauthn_signal: {
            unknown_credential: true,
          },
        },
      });
    }

    if (
      (accountRoute && accountRoute.legacyUserId !== passkey.user_id) ||
      (accountRoute &&
        !matchesPasskeyUserHandle(credential.response.userHandle, passkey.user_id)) ||
      (!accountRoute &&
        credential.response.userHandle !== undefined &&
        !matchesPasskeyUserHandle(credential.response.userHandle, passkey.user_id))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    // Verify authentication response
    const normalizedCredentialId = normalizeStoredCredentialId(passkey.credential_id as string);
    if (!normalizedCredentialId) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    const publicKey = Uint8Array.from(Buffer.from(passkey.public_key as string, 'base64'));

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: challengeData.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: normalizedCredentialId,
          publicKey: publicKey,
          counter: passkey.counter as number,
        },
      });
    } catch (error) {
      log.error('Authentication verification failed', {
        action: 'login_finish',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    const { verified, authenticationInfo } = verification;

    if (!verified) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    const proofVerifiedAtMs = Date.now();
    const authTime = Math.floor(proofVerifiedAtMs / 1000);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const accountAuthentication = await runtimeUsers.findAccountAuthenticationState(
      passkey.user_id
    );
    if (!accountAuthentication) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }
    try {
      await advancePasskeyAuthenticationState(
        c.env,
        {
          tenantId,
          userId: passkey.user_id,
          credentialId: passkey.id,
          storedCounter: passkey.counter,
          observedCounter: authenticationInfo.newCounter,
          observedAtMs: proofVerifiedAtMs,
        },
        () => Promise.resolve(accountAuthentication)
      );
    } catch (error) {
      if (!isAccountAuthenticationDeniedError(error)) {
        return c.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'Authentication state unavailable.',
          },
          503,
          { 'Retry-After': '1' }
        );
      }
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    c.executionCtx.waitUntil(
      Promise.all([
        authCtx.repositories.passkey.mirrorCounterAfterAuth(
          passkey.id,
          authenticationInfo.newCounter
        ),
        runtimeUsers.touchLastLogin(passkey.user_id),
      ]).catch((error: unknown) => {
        log.error('Failed to mirror direct Passkey authentication state', {
          action: 'passkey_state_mirror',
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
      })
    );

    // Generate auth_code
    const authCode = await generateAuthCode(
      c.env,
      tenantId,
      passkey.user_id,
      challengeData.metadata?.code_challenge || '',
      {
        method: 'passkey',
        client_id: challengeData.metadata?.client_id,
        channel,
        scope: challengeData.metadata?.scope,
        transaction_id: challengeData.metadata?.transaction_id || challenge_id,
        passkey_id: passkey.id,
        auth_time: authTime,
        authorization_challenge_id: challengeData.metadata?.authorization_challenge_id,
      }
    );

    // Publish success event
    publishEvent(c, {
      type: AUTH_EVENTS.PASSKEY_SUCCEEDED,
      tenantId,
      data: {
        userId: passkey.user_id,
        method: 'passkey',
        clientId: challengeData.metadata?.client_id || 'direct-auth',
      } satisfies AuthEventData,
    }).catch(() => {});

    return c.json({
      direct_auth_artifact: authCode,
      expires_in: AUTH_CODE_TTL,
    });
  } catch (error) {
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    log.error('Direct passkey login finish error', {
      action: 'login_finish',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// ===== Passkey Signup Handlers =====

/**
 * Passkey Signup Start
 * POST /api/v1/auth/direct/passkey/signup/start
 */
export async function directPasskeySignupStartHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      client_id: string;
      email?: string;
      display_name?: string;
      code_challenge: string;
      code_challenge_method: CodeChallengeMethod;
      channel: DirectAuthChannel;
      scope?: string;
      authenticator_type?: 'platform' | 'cross-platform' | 'any';
      resident_key?: 'required' | 'preferred' | 'discouraged';
      user_verification?: 'required' | 'preferred' | 'discouraged';
      custom_fields?: Record<string, unknown>;
      authorization_challenge_id?: string;
      human_verification_response?: string;
      cf_turnstile_response?: string;
    }>();

    const {
      client_id,
      email,
      display_name,
      code_challenge,
      code_challenge_method,
      channel,
      scope,
      authenticator_type = 'any',
      resident_key = 'required',
      user_verification = 'required',
      custom_fields,
      authorization_challenge_id,
      human_verification_response,
      cf_turnstile_response,
    } = body;

    if (!client_id || !code_challenge || code_challenge_method !== 'S256' || !channel) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: {
          field: 'client_id, code_challenge, code_challenge_method=S256, channel',
        },
      });
    }
    if (!isDirectAuthChannel(channel)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const tenantId = getTenantIdFromContext(c);
    const passkeySignupUsage = authorization_challenge_id
      ? await resolveDirectStartTurnstileAction(c, tenantId, authorization_challenge_id)
      : 'signup';
    if (typeof passkeySignupUsage !== 'string') return passkeySignupUsage.error;
    const methodDisabledError = await rejectIfAuthenticationMethodDisabled(
      c,
      tenantId,
      'passkey',
      passkeySignupUsage
    );
    if (methodDisabledError) return methodDisabledError;
    const turnstileError = await verifyHumanVerificationForAction(
      c,
      passkeySignupUsage,
      human_verification_response ?? cf_turnstile_response
    );
    if (turnstileError) return turnstileError;

    // Validate Origin
    const originHeader = c.req.header('origin');
    const webAuthnOrigin = getDirectAuthWebAuthnOrigin(c, originHeader);
    const clientValidation = await validateDirectAuthClient(c, client_id, channel, webAuthnOrigin);
    if (!clientValidation.valid) {
      return clientValidation.errorResponse as Response;
    }

    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    if (!webAuthnOrigin || !isAllowedPasskeyRequestOrigin(c, webAuthnOrigin, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    const originUrl = new URL(webAuthnOrigin);
    const rpID = originUrl.hostname;

    // Check if user exists or create new
    let user: { id: string; email: string | null; name: string | null } | null = null;
    const normalizedEmail =
      typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
    const tenantD1 = usesTenantD1AccountStorage(c);
    if (tenantD1 && !normalizedEmail) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'email' },
      });
    }
    const accountRoute = normalizedEmail
      ? await resolveTenantD1EmailAccountRoute(c, normalizedEmail)
      : 'not_required';
    let runtimeUsers: CanonicalRuntimeUserStore | null =
      accountRoute === 'not_found' ? null : createCanonicalRuntimeUserStore(c, tenantId);

    if (normalizedEmail) {
      const existingUser = await runtimeUsers?.findByEmail(normalizedEmail);
      if (existingUser) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
      }
    }

    const customFieldValidation = await validateRegistrationFieldSubmissionFromEnv(
      c.env,
      tenantId,
      {
        ...(custom_fields ?? {}),
        ...(normalizedEmail
          ? { email: normalizedEmail, 'field.canonical.email': normalizedEmail }
          : {}),
        ...(display_name ? { name: display_name, 'field.canonical.name': display_name } : {}),
      }
    );
    if (!customFieldValidation.ok) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
        variables: { field: 'custom_fields', reason: customFieldValidation.error },
        extensions: customFieldValidation.missingRequiredFields
          ? {
              missing_required_fields: customFieldValidation.missingRequiredFields.map((field) => ({
                field_key: field.fieldKey,
                label: field.label,
                field_type: field.fieldType,
              })),
            }
          : undefined,
      });
    }
    const canonicalProfileFields = buildCanonicalProfileRuntimeUserFields({
      ...(custom_fields ?? {}),
      ...customFieldValidation.values,
    });

    if (!user) {
      // Create new user
      const newUserId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);
      const defaultName = display_name || null;
      const preferredUsername = normalizedEmail?.split('@')[0] ?? newUserId;
      const provisioningRuntimeUser = {
        active: true as const,
        emailVerified: false,
        userType: 'end_user',
        displayName: defaultName,
        sourceRef: 'auth:passkey',
        piiFields: {
          ...canonicalProfileFields.piiFields,
          email: true,
          ...(defaultName ? { name: true } : {}),
        },
        sensitiveValues: {
          ...canonicalProfileFields.sensitiveValues,
          email: normalizedEmail!,
          ...(defaultName ? { name: defaultName } : {}),
        },
        customAttributesJson: JSON.stringify({ preferred_username: preferredUsername }),
      };

      try {
        if (tenantD1) {
          const provisioned = await provisionTenantD1EmailAccount(c, {
            tenantId,
            candidateUserId: newUserId,
            flow: 'passkey',
            email: normalizedEmail!,
            runtimeUser: provisioningRuntimeUser,
          });
          if (provisioned.status === 'pending') return provisioned.response;
          await resolveAccountDataContextFromHono(c, provisioned.accountId);
          runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
          user = { id: provisioned.userId, email: normalizedEmail, name: defaultName };
        } else {
          await runtimeUsers!.syncUser({
            userId: newUserId,
            email: normalizedEmail,
            name: defaultName,
            active: true,
            emailVerified: false,
            userType: 'end_user',
            sourceRef: 'direct_auth_passkey',
            piiFields: canonicalProfileFields.piiFields,
            sensitiveValues: canonicalProfileFields.sensitiveValues,
            customAttributesJson: provisioningRuntimeUser.customAttributesJson,
          });
        }
      } catch (piiError) {
        const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, piiError);
        if (writeFenceResponse) return writeFenceResponse;
        log.error('Failed to create canonical runtime user', {
          action: 'runtime_user_create',
          errorType: piiError instanceof Error ? piiError.name : 'Unknown',
        });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      user ??= { id: newUserId, email: normalizedEmail, name: defaultName };
    }

    // Get existing passkeys for exclusion
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existingPasskeys = await authCtx.repositories.passkey.findByUserId(user.id);

    const excludeCredentials: Array<{
      id: string;
      type: 'public-key';
      transports?: AuthenticatorTransport[];
    }> = existingPasskeys
      .map((pk) => {
        const normalizedId = normalizeStoredCredentialId(pk.credential_id);
        if (!normalizedId) return null;

        return {
          id: normalizedId,
          type: 'public-key' as const,
          transports: pk.transports.length > 0 ? pk.transports : undefined,
        };
      })
      .filter((cred): cred is NonNullable<typeof cred> => cred !== null);

    // Generate registration options
    const encoder = new TextEncoder();
    const authenticatorSelection: {
      authenticatorAttachment?: 'platform' | 'cross-platform';
      residentKey: 'required' | 'preferred' | 'discouraged';
      userVerification: 'required' | 'preferred' | 'discouraged';
    } = {
      residentKey: resident_key,
      userVerification: user_verification,
    };

    if (authenticator_type !== 'any') {
      authenticatorSelection.authenticatorAttachment = authenticator_type;
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      // @ts-ignore - TextEncoder.encode() returns compatible Uint8Array
      userID: encoder.encode(user.id),
      userName: normalizedEmail ?? user.id,
      userDisplayName: display_name || user.name || normalizedEmail || user.id,
      excludeCredentials,
      authenticatorSelection,
      attestationType: 'none',
    });

    // Store challenge using userId-based sharding
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByUserId(
      c.env,
      user.id,
      getTenantIdFromContext(c)
    );

    await challengeStore.storeChallengeRpc({
      id: `direct_passkey_signup:${user.id}`,
      tenantId: getTenantIdFromContext(c),
      type: 'direct_passkey_signup',
      userId: user.id,
      challenge: options.challenge,
      ttl: CHALLENGE_TTL,
      email: normalizedEmail ?? undefined,
      metadata: {
        code_challenge,
        client_id,
        channel,
        scope,
        origin: webAuthnOrigin,
        rpID,
        challenge_id: challengeId,
        authorization_challenge_id,
        ...(Object.keys(customFieldValidation.values).length > 0
          ? { custom_fields: customFieldValidation.values }
          : {}),
      },
    });

    // Also store challenge_id -> userId mapping for finish endpoint
    const challengeMapStore = await getChallengeStoreByChallengeId(
      c.env,
      challengeId,
      getTenantIdFromContext(c)
    );
    await challengeMapStore.storeChallengeRpc({
      id: `direct_passkey_signup_map:${challengeId}`,
      tenantId: getTenantIdFromContext(c),
      type: 'direct_passkey_signup_map',
      userId: user.id,
      challenge: challengeId, // Just for reference
      ttl: CHALLENGE_TTL,
    });

    return c.json({
      challenge_id: challengeId,
      options: {
        rp: options.rp,
        user: options.user,
        challenge: options.challenge,
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        excludeCredentials: options.excludeCredentials,
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
        extensions: options.extensions,
      },
    });
  } catch (error) {
    log.error('Direct passkey signup start error', {
      action: 'signup_start',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Passkey Signup Finish
 * POST /api/v1/auth/direct/passkey/signup/finish
 */
export async function directPasskeySignupFinishHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      challenge_id: string;
      credential: RegistrationResponseJSON;
      code_verifier: string;
      channel: DirectAuthChannel;
    }>();

    const { challenge_id, credential, code_verifier, channel } = body;

    if (!challenge_id || !credential || !code_verifier || !channel) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id, credential, code_verifier, channel' },
      });
    }
    if (!isDirectAuthChannel(channel)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Find user by challenge_id from metadata
    // We need to search for the challenge - it's stored by userId
    // The challenge_id was stored in metadata during signup/start
    // Get tenantId for user lookup
    const tenantId = getTenantIdFromContext(c);

    // Look up userId from challenge_id mapping
    // We stored this mapping in signup/start using challenge_id-based sharding
    const challengeMapStore = await getChallengeStoreByChallengeId(
      c.env,
      challenge_id,
      getTenantIdFromContext(c)
    );
    let userId: string;

    try {
      // Get userId from challenge_id mapping
      const mappingData = (await challengeMapStore.getChallengeRpc(
        `direct_passkey_signup_map:${challenge_id}`
      )) as { userId: string } | null;

      if (mappingData && mappingData.userId) {
        userId = mappingData.userId;
      } else {
        // If no mapping, the challenge wasn't stored correctly
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
      }
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Now consume the actual challenge using userId-based sharding
    const challengeStore = await getChallengeStoreByUserId(
      c.env,
      userId,
      getTenantIdFromContext(c)
    );

    let challengeData: {
      challenge: string;
      email?: string;
      metadata?: {
        code_challenge: string;
        client_id: string;
        channel: DirectAuthChannel;
        scope?: string;
        origin: string;
        rpID: string;
        custom_fields?: Record<string, unknown>;
        authorization_challenge_id?: string;
      };
    };

    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `direct_passkey_signup:${userId}`,
        tenantId: getTenantIdFromContext(c),
        type: 'direct_passkey_signup',
      })) as typeof challengeData;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Verify PKCE
    const isValidPKCE = await verifyPKCE(
      code_verifier,
      challengeData.metadata?.code_challenge || ''
    );
    if (!isValidPKCE) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }
    if (challengeData.metadata?.channel !== channel) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    const origin = challengeData.metadata?.origin || '';
    const rpID = challengeData.metadata?.rpID || '';

    // Verify registration response
    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challengeData.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (error) {
      log.error('Registration verification failed', {
        action: 'signup_finish',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    const { verified, registrationInfo } = verification;

    if (!verified || !registrationInfo) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    // Handle @simplewebauthn version compatibility
    const regInfo = registrationInfo as unknown as RegistrationInfoCompat;
    const credentialID = regInfo.credentialID || regInfo.credential?.id;
    const credentialPublicKey = regInfo.credentialPublicKey || regInfo.credential?.publicKey;
    const counter = regInfo.counter ?? regInfo.credential?.counter ?? 0;

    if (!credentialID || !credentialPublicKey) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Store passkey
    if (usesTenantD1AccountStorage(c)) {
      await resolveAccountDataContextFromHono(c, userId);
    }
    const authCtx = createAuthContextFromHono(c, tenantId);
    const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64');
    const credentialIDBase64URL = toBase64URLString(credentialID as CredentialIDLike);
    const passkeyId = crypto.randomUUID();

    await authCtx.repositories.passkey.create({
      id: passkeyId,
      user_id: userId,
      credential_id: credentialIDBase64URL,
      rp_id: rpID,
      public_key: publicKeyBase64,
      counter,
      transports: (credential.response.transports || []) as AuthenticatorTransport[],
      device_name: 'Direct Auth Passkey',
      aaguid: regInfo.aaguid ?? null,
    });
    await publishTenantD1PasskeyRoute(c, {
      tenantId,
      userId,
      passkeyId,
      credentialId: credentialIDBase64URL,
      rpId: rpID,
    });

    const now = Date.now();
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);

    // Check if this is a new user (created in this flow)
    const runtimeUser = await runtimeUsers.findById(userId, { includeInactive: true });
    const isNewUser = runtimeUser ? now - Date.parse(runtimeUser.created_at) < 60000 : false;

    const customFields = challengeData.metadata?.custom_fields;
    if (customFields) {
      try {
        await persistRegistrationFieldValuesFromEnv(c.env, tenantId, userId, customFields);
      } catch (persistError) {
        log.warn(
          'Failed to persist registration field values',
          { action: 'registration_fields_persist' },
          persistError as Error
        );
      }
    }

    // Generate auth_code
    const authCode = await generateAuthCode(
      c.env,
      tenantId,
      userId,
      challengeData.metadata?.code_challenge || '',
      {
        method: 'passkey_signup',
        client_id: challengeData.metadata?.client_id,
        channel,
        scope: challengeData.metadata?.scope,
        transaction_id: challenge_id,
        passkey_id: passkeyId,
        is_new_user: isNewUser,
        authorization_challenge_id: challengeData.metadata?.authorization_challenge_id,
      }
    );

    return c.json({
      direct_auth_artifact: authCode,
      expires_in: AUTH_CODE_TTL,
      is_new_user: isNewUser,
    });
  } catch (error) {
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    log.error('Direct passkey signup finish error', {
      action: 'signup_finish',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// ===== Email Code Handlers =====

type DirectEmailVerificationMethod = 'email_code' | 'email_verification_protocol';

interface DirectEmailVerificationCompletionInput {
  tenantId: string;
  userId: string;
  trustedEmail: string;
  channel: DirectAuthChannel;
  transactionId: string;
  method: DirectEmailVerificationMethod;
  metadata: Record<string, unknown>;
}

interface EmailVerificationProtocolChallengeData {
  challenge?: string;
  tenantId?: string;
  type?: string;
  metadata?: Record<string, unknown>;
}

function emailVerificationProtocolMetadataMatches(
  metadata: Record<string, unknown> | undefined,
  runtimeInteractionId: string,
  externalOrigin: string
): boolean {
  if (!metadata) return false;

  return (
    metadataString(metadata, 'interaction_id') === runtimeInteractionId &&
    metadataString(metadata, 'expected_origin') === externalOrigin
  );
}

async function emailVerificationProtocolChallengeIsCurrent(
  c: Context<{ Bindings: Env }>,
  challengeTenantId: string,
  metadata: Record<string, unknown> | undefined
): Promise<boolean> {
  if (!metadata) return false;
  const interactionId = metadataString(metadata, 'interaction_id');
  const sourceStepId = metadataString(metadata, 'source_step_id');
  const verificationStepId = metadataString(metadata, 'verification_step_id');
  const contractHash = metadataString(metadata, 'contract_hash');
  if (!interactionId || !sourceStepId || !verificationStepId || !contractHash) {
    return false;
  }

  try {
    const authCtx = createAuthContextFromHono(c, challengeTenantId);
    const interaction = await authCtx.coreAdapter.queryOne<{
      state: string;
      current_step_id: string | null;
      contract_hash: string;
      expires_at: number;
    }>(
      `SELECT state, current_step_id, contract_hash, expires_at
         FROM flow_interactions
        WHERE tenant_id = ? AND id = ?`,
      [challengeTenantId, interactionId]
    );
    return Boolean(
      interaction &&
      (interaction.state === 'created' || interaction.state === 'active') &&
      interaction.expires_at > Math.floor(Date.now() / 1000) &&
      interaction.contract_hash === contractHash &&
      (interaction.current_step_id === sourceStepId ||
        interaction.current_step_id === verificationStepId)
    );
  } catch {
    return false;
  }
}

async function completeDirectEmailVerification(
  c: Context<{ Bindings: Env }>,
  input: DirectEmailVerificationCompletionInput
): Promise<Response> {
  const { tenantId, userId, trustedEmail, channel, transactionId, method, metadata } = input;
  const log = getLogger(c).module('DIRECT-AUTH');
  const tenantD1 = usesTenantD1AccountStorage(c);
  let runtimeUser: CanonicalOtpLoginUser | null;
  let coreAdapter: DatabaseAdapter;

  if (tenantD1) {
    const accountData = await resolveOtpAccountCoreDataContextByIdentifierFromHono(c, {
      indexKind: 'account_id',
      identifier: `account:${userId}`,
      expectedAccountId: `account:${userId}`,
      expectedLegacyUserId: userId,
      trustedEmail,
    });
    runtimeUser = accountData.user;
    coreAdapter = ensureDatabaseAdapter(accountData.coreDb, 'otp-account-core');
  } else {
    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    runtimeUser = await runtimeUsers.findForOtpLogin(userId, trustedEmail, {
      includeInactive: true,
    });
    coreAdapter = authCtx.coreAdapter;
  }

  if (!runtimeUser || runtimeUser.active !== 1) {
    return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
  }

  const now = Date.now();
  if (tenantD1) {
    if (runtimeUser.email_verified !== 1) {
      c.executionCtx.waitUntil(
        markOtpLoginEmailVerified(coreAdapter, tenantId, userId, now).catch((error: unknown) => {
          log.error(
            'Failed to update user after direct OTP login',
            { action: 'direct_email_user_update' },
            error as Error
          );
        })
      );
    }
  } else {
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    await runtimeUsers.markEmailVerifiedAndTouchLastLogin(userId, now);
  }

  const isNewUser = now - Date.parse(runtimeUser.created_at) < 60000;

  // Apply invitation role/org assignment if present.
  const inviteId = metadataString(metadata, 'invite_id');
  const inviteToken = metadataString(metadata, 'invite_token');

  if (inviteId && inviteToken) {
    const inviteNow = Math.floor(now / 1000);
    try {
      const invitation = await findActiveInvitationByToken(coreAdapter, inviteToken, inviteNow);
      if (!invitation || invitation.id !== inviteId || invitation.tenant_id !== tenantId) {
        log.warn('Invitation metadata no longer matches an active tenant invitation', {
          invite_id: inviteId,
          tenant_id: tenantId,
        });
      } else if (
        !(await consumeInvitationUse(coreAdapter, invitation.id, invitation.tenant_id, inviteNow))
      ) {
        log.warn('Invitation use_count increment was skipped during email verification', {
          invite_id: inviteId,
          tenant_id: tenantId,
        });
      } else {
        const assignmentResults = await applyInvitationAssignments(coreAdapter, {
          userId,
          tenantId,
          roleId: invitation.role_id,
          orgId: invitation.org_id,
        });

        if (invitation.role_id && !assignmentResults.roleAssignment?.success) {
          log.warn('Failed to assign role from invitation', {
            invite_id: inviteId,
            tenant_id: tenantId,
            error: assignmentResults.roleAssignment?.error,
          });
        }

        if (invitation.org_id && !assignmentResults.orgMembership?.success) {
          log.warn('Failed to assign organization from invitation', {
            invite_id: inviteId,
            tenant_id: tenantId,
            error: assignmentResults.orgMembership?.error,
          });
        }
      }
    } catch (inviteErr) {
      log.warn('Failed to apply invitation assignments', {
        error: String(inviteErr),
        invite_id: inviteId,
      });
    }
  }

  // Save custom registration fields if present.
  const customFieldsValue = metadata.custom_fields;
  const customFields =
    customFieldsValue && typeof customFieldsValue === 'object' && !Array.isArray(customFieldsValue)
      ? (customFieldsValue as Record<string, unknown>)
      : undefined;
  if (customFields) {
    try {
      await persistRegistrationFieldValuesFromEnv(c.env, tenantId, userId, customFields);
    } catch (persistError) {
      log.warn(
        'Failed to persist registration field values',
        { action: 'registration_fields_persist' },
        persistError as Error
      );
    }
  }

  const authCode = await generateAuthCode(
    c.env,
    tenantId,
    userId,
    metadataString(metadata, 'code_challenge') || '',
    {
      method,
      client_id: metadataString(metadata, 'client_id'),
      channel,
      scope: metadataString(metadata, 'scope'),
      transaction_id: metadataString(metadata, 'transaction_id') || transactionId,
      is_new_user: isNewUser,
      authorization_challenge_id: metadataString(metadata, 'authorization_challenge_id'),
      runtime_interaction_id: metadataString(metadata, 'runtime_interaction_id'),
    }
  );

  if (method === 'email_code') {
    publishEvent(c, {
      type: AUTH_EVENTS.EMAIL_CODE_SUCCEEDED,
      tenantId,
      data: {
        userId,
        method: 'email_code',
        clientId: metadataString(metadata, 'client_id') || 'direct-auth',
      } satisfies AuthEventData,
    }).catch(() => {});
  } else {
    publishEvent(c, {
      type: 'auth.email_verification_protocol.succeeded',
      tenantId,
      data: {
        userId,
        method: 'email_verification_protocol',
        clientId: metadataString(metadata, 'client_id') || 'direct-auth',
      },
    }).catch(() => {});
  }

  return c.json({
    direct_auth_artifact: authCode,
    expires_in: AUTH_CODE_TTL,
    is_new_user: isNewUser,
  });
}

async function tryEmailVerificationProtocol(
  c: Context<{ Bindings: Env }>,
  input: {
    tenantId: string;
    challengeTenantId: string;
    userId: string;
    normalizedEmail: string;
    channel: DirectAuthChannel;
    presentationToken: string | undefined;
    challengeId: string | undefined;
    runtimeInteractionId: string | undefined;
    completionMetadata: Record<string, unknown>;
  }
): Promise<Response | null> {
  const {
    tenantId,
    challengeTenantId,
    userId,
    normalizedEmail,
    channel,
    presentationToken,
    challengeId,
    runtimeInteractionId,
    completionMetadata,
  } = input;

  // The runtime interaction, browser challenge, user, and resulting managed session must all
  // remain within one tenant. Email-domain routing can change the Direct Auth tenant after the
  // Flow challenge was issued, so never complete EVP across that boundary.
  if (tenantId !== challengeTenantId) {
    return null;
  }

  if (
    channel !== 'browser' ||
    typeof presentationToken !== 'string' ||
    presentationToken.length === 0 ||
    typeof challengeId !== 'string' ||
    challengeId.length === 0 ||
    typeof runtimeInteractionId !== 'string' ||
    runtimeInteractionId.length === 0
  ) {
    return null;
  }

  const externalOrigin = getDirectAuthWebAuthnOrigin(c, c.req.header('origin'));
  if (!externalOrigin) return null;

  const challengeKey = `email_verification_protocol:${challengeId}`;
  const challengeStore = await getChallengeStoreByChallengeId(
    c.env,
    challengeId,
    challengeTenantId
  ).catch(() => null);
  if (!challengeStore) return null;

  let challengeData: EmailVerificationProtocolChallengeData | null;

  try {
    challengeData = (await challengeStore.getChallengeRpc(
      challengeKey
    )) as EmailVerificationProtocolChallengeData | null;
  } catch {
    return null;
  }

  if (
    !challengeData ||
    challengeData.type !== 'email_verification_protocol' ||
    challengeData.tenantId !== challengeTenantId ||
    typeof challengeData.challenge !== 'string' ||
    challengeData.challenge.length === 0 ||
    !emailVerificationProtocolMetadataMatches(
      challengeData.metadata,
      runtimeInteractionId,
      externalOrigin
    )
  ) {
    return null;
  }

  if (
    !(await emailVerificationProtocolChallengeIsCurrent(
      c,
      challengeTenantId,
      challengeData.metadata
    ))
  ) {
    return null;
  }

  const expectedNonce = challengeData.challenge;
  const verificationResult = await verifyEmailVerificationProtocol({
    presentationToken,
    expectedEmail: normalizedEmail,
    expectedNonce,
    expectedAudience: externalOrigin,
  }).catch(() => ({ verified: false as const, reason: 'invalid_presentation' as const }));

  if (!verificationResult.verified) return null;

  let consumedChallenge: EmailVerificationProtocolChallengeData;
  try {
    consumedChallenge = (await challengeStore.consumeChallengeRpc({
      id: challengeKey,
      tenantId: challengeTenantId,
      type: 'email_verification_protocol',
      challenge: expectedNonce,
    })) as EmailVerificationProtocolChallengeData;
  } catch {
    return null;
  }

  if (
    consumedChallenge.challenge !== expectedNonce ||
    !emailVerificationProtocolMetadataMatches(
      consumedChallenge.metadata,
      runtimeInteractionId,
      externalOrigin
    )
  ) {
    return null;
  }
  if (
    !(await emailVerificationProtocolChallengeIsCurrent(
      c,
      challengeTenantId,
      consumedChallenge.metadata
    ))
  ) {
    return null;
  }

  return completeDirectEmailVerification(c, {
    tenantId,
    userId,
    trustedEmail: normalizedEmail,
    channel,
    transactionId: challengeId,
    method: 'email_verification_protocol',
    metadata: {
      ...completionMetadata,
      runtime_interaction_id: runtimeInteractionId,
    },
  });
}

/**
 * Email Code Send
 * POST /api/v1/auth/direct/email-code/send
 */
export async function directEmailCodeSendHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      client_id: string;
      email: string;
      code_challenge: string;
      code_challenge_method: CodeChallengeMethod;
      channel: DirectAuthChannel;
      scope?: string;
      locale?: string;
      invite_token?: string;
      authorization_challenge_id?: string;
      display_name?: string;
      name?: string;
      custom_fields?: Record<string, unknown>;
      human_verification_response?: string;
      cf_turnstile_response?: string;
      email_verification_token?: string;
      email_verification_challenge_id?: string;
      runtime_interaction_id?: string;
    }>();

    const {
      client_id,
      email,
      code_challenge,
      code_challenge_method,
      channel,
      scope,
      locale,
      invite_token,
      authorization_challenge_id,
      display_name,
      name,
      custom_fields,
      human_verification_response,
      cf_turnstile_response,
      email_verification_token,
      email_verification_challenge_id,
      runtime_interaction_id,
    } = body;

    if (!client_id || !email || !code_challenge || code_challenge_method !== 'S256' || !channel) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: {
          field: 'client_id, email, code_challenge, code_challenge_method=S256, channel',
        },
      });
    }
    if (!isDirectAuthChannel(channel)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const clientValidation = await validateDirectAuthClient(
      c,
      client_id,
      channel,
      c.req.header('origin')
    );
    if (!clientValidation.valid) {
      return clientValidation.errorResponse as Response;
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const normalizedEmail = email.toLowerCase();
    const boundRuntimeInteractionId =
      typeof runtime_interaction_id === 'string' &&
      runtime_interaction_id.length > 0 &&
      runtime_interaction_id.length <= 128
        ? runtime_interaction_id
        : undefined;
    const rawDisplayName =
      typeof display_name === 'string' ? display_name : typeof name === 'string' ? name : undefined;
    const displayName = rawDisplayName?.trim() || null;

    // Check/create user
    const challengeTenantId = getTenantIdFromContext(c);
    let tenantId = challengeTenantId;
    const routingCoreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;

    // Invitation token routing: overrides all other tenant resolution
    let inviteData: {
      invite_id: string;
      invite_token: string;
      invite_role_id: string | null;
      invite_org_id: string | null;
      invited_email: string | null;
    } | null = null;

    if (invite_token) {
      const nowTs = Math.floor(Date.now() / 1000);
      const invitation = await findActiveInvitationByToken(routingCoreAdapter, invite_token, nowTs);

      if (!invitation) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      if (!hasRemainingInvitationUses(invitation)) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      // If invitation is restricted to a specific email, enforce it
      if (invitation.invited_email && invitation.invited_email.toLowerCase() !== normalizedEmail) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      tenantId = invitation.tenant_id;
      inviteData = {
        invite_id: invitation.id,
        invite_token,
        invite_role_id: invitation.role_id,
        invite_org_id: invitation.org_id,
        invited_email: invitation.invited_email,
      };
    }

    // A Flow interaction is tenant-bound before Direct Auth begins. Invitations must not move a
    // runtime-bound request into another tenant, otherwise the user, OTP/EVP challenge, artifact,
    // managed session, and Flow interaction would be split across tenant stores.
    if (boundRuntimeInteractionId && tenantId !== challengeTenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const tenantD1 =
      getTenantMetadataContextFromHono(c)?.storageProfileId === 'builtin:storage:tenant-d1';
    if (tenantD1 && tenantId !== challengeTenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Rate limiting
    const rateLimiterId = c.env.RATE_LIMITER.idFromName(
      buildDOKey('rate-limit', 'email-code', tenantId)
    );
    const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);

    const rateLimitResult = await rateLimiter.incrementRpc(`direct_email_code:${normalizedEmail}`, {
      windowSeconds: 15 * 60,
      maxRequests: 3,
    });

    if (!rateLimitResult.allowed) {
      return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
        variables: { retry_after: rateLimitResult.retryAfter },
      });
    }

    let runtimeUsers: CanonicalRuntimeUserStore | null = null;
    let user: { id: string; email: string; name: string | null } | null = null;
    let routedUser: CanonicalOtpLoginUser | null = null;
    let customFieldValues: Record<string, string> = {};

    if (tenantD1) {
      try {
        const accountData = await resolveOtpAccountCoreDataContextByIdentifierFromHono(c, {
          indexKind: 'email_exact',
          identifier: normalizedEmail,
          trustedEmail: normalizedEmail,
        });
        routedUser = accountData.user.active === 1 ? accountData.user : null;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'account_data_route_not_found') {
          throw error;
        }
      }
    } else {
      runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    }

    const existingUser = tenantD1 ? routedUser : await runtimeUsers?.findByEmail(normalizedEmail);
    if (existingUser) {
      user = {
        id: existingUser.id,
        email: existingUser.email || normalizedEmail,
        name: existingUser.name || null,
      };
    }

    let suppressEmailCodeSend = false;

    let turnstileAction: HumanVerificationAction;
    if (authorization_challenge_id) {
      const resolvedAction = await resolveDirectStartTurnstileAction(
        c,
        tenantId,
        authorization_challenge_id
      );
      if (typeof resolvedAction !== 'string') return resolvedAction.error;
      turnstileAction = resolvedAction;
    } else {
      turnstileAction = user ? 'login' : 'signup';
    }
    const emailCodeUsage = turnstileAction;
    const emailOtpEnabled = await isAuthenticationMethodUsageEnabled(
      c.env,
      tenantId,
      'email_otp',
      emailCodeUsage
    );
    if (!emailOtpEnabled) {
      suppressEmailCodeSend = true;
      log.info('Suppressing email-code send because email OTP usage is disabled', {
        action: 'direct_email_code_send_suppressed',
        reason: 'method_disabled',
        usage: emailCodeUsage,
      });
    }
    const turnstileError = await verifyHumanVerificationForAction(
      c,
      turnstileAction,
      human_verification_response ?? cf_turnstile_response
    );
    if (turnstileError) {
      suppressEmailCodeSend = true;
      log.info('Suppressing email-code send because human verification failed', {
        action: 'direct_email_code_send_suppressed',
        reason: 'human_verification',
        usage: turnstileAction,
      });
    }

    if (!user && !suppressEmailCodeSend) {
      const customFieldValidation = await validateRegistrationFieldSubmissionFromEnv(
        c.env,
        tenantId,
        {
          ...(custom_fields ?? {}),
          email: normalizedEmail,
          'field.canonical.email': normalizedEmail,
          ...(displayName ? { name: displayName, 'field.canonical.name': displayName } : {}),
        }
      );
      if (!customFieldValidation.ok) {
        suppressEmailCodeSend = true;
        log.info('Suppressing email-code send because signup field validation failed', {
          action: 'direct_email_code_send_suppressed',
          reason: 'signup_field_validation',
        });
      } else {
        customFieldValues = customFieldValidation.values;
      }
    }

    if (suppressEmailCodeSend) {
      return acceptedEmailCodeSendResponse(c, normalizedEmail);
    }

    const canonicalProfileFields = buildCanonicalProfileRuntimeUserFields({
      ...(custom_fields ?? {}),
      ...customFieldValues,
    });

    if (!user) {
      const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);
      const preferredUsername = normalizedEmail.split('@')[0];
      const runtimeUser = {
        active: true as const,
        emailVerified: false,
        userType: 'end_user',
        displayName,
        sourceRef: 'auth:email_code',
        piiFields: {
          ...canonicalProfileFields.piiFields,
          email: true,
          ...(displayName ? { name: true } : {}),
        },
        sensitiveValues: {
          ...canonicalProfileFields.sensitiveValues,
          email: normalizedEmail,
          ...(displayName ? { name: displayName } : {}),
        },
        customAttributesJson: JSON.stringify({
          preferred_username: preferredUsername,
        }),
      };

      try {
        if (tenantD1) {
          const provisioned = await provisionTenantD1EmailAccount(c, {
            tenantId,
            candidateUserId: userId,
            flow: 'email_code',
            email: normalizedEmail,
            runtimeUser,
          });
          if (provisioned.status === 'pending') return provisioned.response;
          user = {
            id: provisioned.userId,
            email: normalizedEmail,
            name: displayName,
          };
        } else {
          await runtimeUsers!.syncUser({
            userId,
            email: normalizedEmail,
            name: displayName,
            active: true,
            emailVerified: false,
            userType: 'end_user',
            sourceRef: 'direct_auth_email',
            piiFields: canonicalProfileFields.piiFields,
            sensitiveValues: canonicalProfileFields.sensitiveValues,
            customAttributesJson: runtimeUser.customAttributesJson,
          });
        }
      } catch (error) {
        const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
        if (writeFenceResponse) return writeFenceResponse;
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      user ??= { id: userId, email: normalizedEmail, name: displayName };
    }

    const emailVerificationMetadata: Record<string, unknown> = {
      code_challenge,
      client_id,
      channel,
      scope,
      authorization_challenge_id,
      ...(boundRuntimeInteractionId ? { runtime_interaction_id: boundRuntimeInteractionId } : {}),
      ...(inviteData
        ? {
            invite_id: inviteData.invite_id,
            invite_token: inviteData.invite_token,
            invite_role_id: inviteData.invite_role_id,
            invite_org_id: inviteData.invite_org_id,
            invite_tenant_id: tenantId,
          }
        : {}),
      ...(Object.keys(customFieldValues).length > 0 ? { custom_fields: customFieldValues } : {}),
    };

    const emailVerificationResponse = await tryEmailVerificationProtocol(c, {
      tenantId,
      challengeTenantId,
      userId: user.id,
      normalizedEmail,
      channel,
      presentationToken: email_verification_token,
      challengeId: email_verification_challenge_id,
      runtimeInteractionId: boundRuntimeInteractionId,
      completionMetadata: emailVerificationMetadata,
    });
    if (emailVerificationResponse) return emailVerificationResponse;

    // Generate attempt ID and code
    const attemptId = crypto.randomUUID();
    const code = generateEmailCode();
    const issuedAt = Date.now();
    const hmacSecret = c.env.OTP_HMAC_SECRET;
    if (!hmacSecret) {
      log.error('OTP_HMAC_SECRET must be configured for direct email-code auth', {
        action: 'direct_email_code_send',
      });
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }

    const [codeHash, emailHash, challengeStore] = await Promise.all([
      hashEmailCode(code, normalizedEmail, attemptId, issuedAt, hmacSecret),
      hashEmail(normalizedEmail),
      getChallengeStoreByChallengeId(c.env, attemptId, getTenantIdFromContext(c)),
    ]);

    await challengeStore.storeChallengeRpc({
      id: `direct_email_code:${attemptId}`,
      tenantId: getTenantIdFromContext(c),
      type: 'direct_email_code',
      userId: user.id,
      challenge: codeHash,
      ttl: EMAIL_CODE_TTL,
      email: normalizedEmail,
      metadata: {
        ...emailVerificationMetadata,
        transaction_id: attemptId,
        email_hash: emailHash,
        issued_at: issuedAt,
      },
    });

    const fromEmail = c.env.EMAIL_FROM || 'noreply@authrim.dev';
    const delivery = await produceNotificationDelivery(c.env, {
      owner: { owner: 'tenant', tenantId },
      intentId: `direct-email-code:${attemptId}`,
      outboxId: `notification:${attemptId}`,
      notificationKind: 'auth.direct-email-code',
      idempotencyKey: `direct-email-code:${attemptId}`,
      expiresAt: Math.floor(issuedAt / 1000) + EMAIL_CODE_TTL,
      payload: {
        channel: 'email',
        to: normalizedEmail,
        from: fromEmail,
        subject: 'Your verification code',
        body: getEmailCodeHtml({
          name: user.name || undefined,
          email: normalizedEmail,
          code,
          expiresInMinutes: EMAIL_CODE_TTL / 60,
          appName: 'Authrim',
          logoUrl: undefined,
        }),
        metadata: {
          textBody: getEmailCodeText({
            name: user.name || undefined,
            email: normalizedEmail,
            code,
            expiresInMinutes: EMAIL_CODE_TTL / 60,
            appName: 'Authrim',
          }),
        },
      },
    });
    if (delivery.delivery === 'permanent_failure') {
      log.error('Failed to send direct email code', { action: 'email_send' });
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    return c.json({
      attempt_id: attemptId,
      expires_in: EMAIL_CODE_TTL,
      masked_email: maskEmail(normalizedEmail),
    });
  } catch (error) {
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    log.error('Direct email code send error', {
      action: 'email_send',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Mask email for display (u***@example.com)
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;

  const masked =
    local.length <= 2 ? local.charAt(0) + '***' : local.charAt(0) + '***' + local.slice(-1);

  return `${masked}@${domain}`;
}

function acceptedEmailCodeSendResponse(c: Context<{ Bindings: Env }>, normalizedEmail: string) {
  return c.json({
    attempt_id: crypto.randomUUID(),
    expires_in: EMAIL_CODE_TTL,
    masked_email: maskEmail(normalizedEmail),
  });
}

/**
 * Email Code Verify
 * POST /api/v1/auth/direct/email-code/verify
 */
export async function directEmailCodeVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      attempt_id: string;
      code: string;
      code_verifier: string;
      channel: DirectAuthChannel;
    }>();

    const { attempt_id, code, code_verifier, channel } = body;

    if (!attempt_id || !code || !code_verifier || !channel) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'attempt_id, code, code_verifier, channel' },
      });
    }
    if (!isDirectAuthChannel(channel)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Validate code format
    if (!/^\d{6}$/.test(code)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Rate limit: Max 5 attempts per code
    const tenantId = getTenantIdFromContext(c);
    const rateLimiterId = c.env.RATE_LIMITER.idFromName(
      buildDOKey('rate-limit', 'email-code-verify', tenantId)
    );
    const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);

    const attemptResult = await rateLimiter.incrementRpc(`verify:${attempt_id}`, {
      windowSeconds: EMAIL_CODE_TTL,
      maxRequests: 5, // Max 5 attempts per code
    });

    if (!attemptResult.allowed) {
      // Invalidate the challenge when max attempts exceeded
      const challengeStore = await getChallengeStoreByChallengeId(c.env, attempt_id, tenantId);
      await challengeStore.deleteChallengeRpc(`direct_email_code:${attempt_id}`).catch(() => {});

      return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
        variables: { retry_after: attemptResult.retryAfter },
      });
    }

    // Read first so an invalid code does not consume the attempt. The challenge is
    // atomically consumed below only after all submitted values have been verified.
    const challengeStore = await getChallengeStoreByChallengeId(c.env, attempt_id, tenantId);

    let challengeData: {
      challenge: string;
      userId: string;
      email?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata?: Record<string, any>;
    };

    try {
      challengeData = (await challengeStore.getChallengeRpc(
        `direct_email_code:${attempt_id}`
      )) as typeof challengeData;
      if (!challengeData) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Verify PKCE
    const isValidPKCE = await verifyPKCE(
      code_verifier,
      challengeData.metadata?.code_challenge || ''
    );
    if (!isValidPKCE) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }
    if (challengeData.metadata?.channel !== channel) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Verify code hash
    const hmacSecret = c.env.OTP_HMAC_SECRET;
    if (!hmacSecret) {
      log.error('OTP_HMAC_SECRET must be configured for direct email-code verification', {
        action: 'direct_email_code_verify',
      });
      return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
    }
    const isValidCode = await verifyEmailCodeHash(
      code,
      challengeData.email?.toLowerCase() || '',
      attempt_id,
      challengeData.metadata?.issued_at || 0,
      challengeData.challenge,
      hmacSecret
    );

    if (!isValidCode) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `direct_email_code:${attempt_id}`,
        tenantId,
        type: 'direct_email_code',
      })) as typeof challengeData;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    return completeDirectEmailVerification(c, {
      tenantId,
      userId: challengeData.userId,
      trustedEmail: challengeData.email ?? '',
      channel,
      transactionId: attempt_id,
      method: 'email_code',
      metadata: challengeData.metadata ?? {},
    });
  } catch (error) {
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    log.error('Direct email code verify error', {
      action: 'email_verify',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// ===== Token Exchange Handler =====

/**
 * Managed Browser Session Finish
 * POST /api/v1/auth/direct/session
 *
 * Redeems a canonical Direct Auth artifact into an Authrim-managed
 * HttpOnly browser session. This is the built-in LoginUI/BFF-style path:
 * no OAuth/OIDC token material is returned to browser JavaScript.
 */
export async function directSessionCreateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      direct_auth_artifact: string;
      client_id: string;
      code_verifier: string;
      channel: DirectAuthChannel;
      provider_id?: string;
      authorization_challenge_id?: string;
      defer_authorization_continuation?: boolean;
    }>();

    const {
      direct_auth_artifact,
      client_id,
      code_verifier,
      channel,
      provider_id,
      authorization_challenge_id,
      defer_authorization_continuation,
    } = body;

    const missingFields = [
      !direct_auth_artifact ? 'direct_auth_artifact' : null,
      !client_id ? 'client_id' : null,
      !code_verifier ? 'code_verifier' : null,
      !channel ? 'channel' : null,
    ].filter((field): field is string => field !== null);

    if (missingFields.length > 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Missing required fields: ${missingFields.join(', ')}`,
          error_details: {
            code: 'DIRECT_SESSION_REQUIRED_FIELDS_MISSING',
            missing_fields: missingFields,
          },
        },
        400
      );
    }

    if (channel !== 'browser') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'managed browser session finish requires channel=browser',
          error_details: {
            code: 'DIRECT_SESSION_INVALID_CHANNEL',
            expected: 'browser',
          },
        },
        400
      );
    }

    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      direct_auth_artifact,
      getTenantIdFromContext(c)
    );
    let artifactData: {
      challenge: string;
      userId: string;
      metadata?: Record<string, unknown>;
    };

    try {
      artifactData = (await challengeStore.consumeChallengeRpc({
        id: `direct_auth:${direct_auth_artifact}`,
        tenantId: getTenantIdFromContext(c),
        type: 'direct_auth_code',
      })) as typeof artifactData;
    } catch (error) {
      log.warn('Direct Auth session artifact consume failed', {
        action: 'direct_auth_session_finish',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Direct Auth artifact is invalid or expired',
        },
        400
      );
    }

    const metadata = artifactData.metadata || {};
    if (metadata.client_id !== client_id) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Direct Auth artifact client binding mismatch',
        },
        400
      );
    }

    if (metadata.channel !== channel) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Direct Auth artifact channel binding mismatch',
        },
        400
      );
    }

    const allowedProviders = new Set<string>();
    for (const key of ['provider_id', 'provider_slug', 'provider']) {
      const value = metadata[key];
      if (typeof value === 'string' && value) {
        allowedProviders.add(value);
      }
    }
    if (allowedProviders.size > 0 && (!provider_id || !allowedProviders.has(provider_id))) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Direct Auth artifact provider binding mismatch',
        },
        400
      );
    }

    const pkceValid = await verifyPKCE(code_verifier, artifactData.challenge);
    if (!pkceValid) {
      return c.json(
        {
          error: 'invalid_grant',
          error_description: 'Direct Auth artifact PKCE verification failed',
        },
        400
      );
    }

    const tenantId = getTenantIdFromContext(c);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const runtimeUser = await runtimeUsers.findById(artifactData.userId);
    if (!runtimeUser) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    const sessionTtl = await resolveSessionTtl(c.env, tenantId, 'direct_auth');
    const now = Date.now();
    const authTime = Math.floor(now / 1000);
    const amr = [typeof metadata.method === 'string' ? metadata.method : 'direct_auth'];
    const acr = 'urn:mace:incommon:iap:bronze';

    const artifactAuthorizationChallengeId =
      typeof metadata.authorization_challenge_id === 'string'
        ? metadata.authorization_challenge_id
        : undefined;
    const effectiveAuthorizationChallengeId = defer_authorization_continuation
      ? undefined
      : authorization_challenge_id || artifactAuthorizationChallengeId;

    let authorizationContinuation: AuthorizationChallengeContinuation | undefined;
    if (effectiveAuthorizationChallengeId) {
      const continuation = await consumeAuthorizationChallengeContinuation(
        c.env,
        tenantId,
        effectiveAuthorizationChallengeId,
        artifactData.userId,
        authTime,
        new URL(c.req.url).origin
      );
      if ('error' in continuation) {
        return continuation.error;
      }
      authorizationContinuation = continuation;
    }

    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);

    await sessionStore.createSessionRpc(
      sessionId,
      artifactData.userId,
      sessionTtl.seconds,
      {
        email: runtimeUser.email || null,
        name: runtimeUser.name,
        amr,
        acr,
        authTime,
        client_id,
        direct_auth_channel: channel,
        ...(typeof metadata.runtime_interaction_id === 'string'
          ? { runtime_interaction_id: metadata.runtime_interaction_id }
          : {}),
      },
      tenantId
    );

    const isSecure = new URL(c.req.url).protocol === 'https:';
    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: isSecure,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: sessionTtl.seconds,
    });

    const browserState = await generateBrowserState(sessionId);
    setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
      path: '/',
      secure: isSecure,
      sameSite: getBrowserStateCookieSameSite(c.env),
      maxAge: sessionTtl.seconds,
    });

    const postLoginRedirect = authorizationContinuation
      ? authorizationContinuation.redirectUrl
      : (await resolvePostLoginRedirectUrl(c.env, tenantId)).redirectUrl;

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      ok: true,
      expires_in: sessionTtl.seconds,
      session: {
        userId: artifactData.userId,
        createdAt: now,
        expiresAt: now + sessionTtl.milliseconds,
        authTime,
        acr,
        amr,
      },
      user: {
        id: artifactData.userId,
        email: runtimeUser.email,
        name: runtimeUser.name,
      },
      ...(authorizationContinuation
        ? {
            authorization: {
              challenge_id: effectiveAuthorizationChallengeId,
              type: authorizationContinuation.type,
            },
          }
        : {}),
      redirect_url: postLoginRedirect,
    });
  } catch (error) {
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    log.error('Direct Auth session finish error', {
      action: 'direct_auth_session_finish',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Token Exchange
 * POST /api/v1/auth/direct/token
 *
 * Legacy Direct Auth token endpoint.
 *
 * Phase 1 uses the canonical OAuth token endpoint with the
 * direct-auth-finish grant. This legacy endpoint must not issue tokens.
 */
export async function directTokenHandler(c: Context<{ Bindings: Env }>) {
  return createCompatibilityErrorResponse('legacy_endpoint_not_supported', 400);
}

// ===== Passkey Register Handlers (Authenticated User) =====

/**
 * Passkey Register Start (for authenticated users)
 * POST /api/v1/auth/direct/passkey/register/start
 *
 * Allows authenticated users to add additional passkeys to their account.
 */
export async function directPasskeyRegisterStartHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    // Get session from cookie or Authorization header
    const sessionId = getSessionIdFromRequest(c);

    if (!sessionId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    // Validate session
    const session = await validateSession(c, sessionId);
    if (!session) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const body = await c.req.json<{
      client_id?: string;
      display_name?: string;
      authenticator_type?: 'platform' | 'cross-platform' | 'any';
      resident_key?: 'required' | 'preferred' | 'discouraged';
      user_verification?: 'required' | 'preferred' | 'discouraged';
    }>();

    const {
      display_name,
      authenticator_type = 'any',
      resident_key = 'required',
      user_verification = 'required',
    } = body;

    // Validate Origin header
    const originHeader = c.req.header('origin');
    const webAuthnOrigin = getDirectAuthWebAuthnOrigin(c, originHeader);
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    if (!webAuthnOrigin || !isAllowedPasskeyRequestOrigin(c, webAuthnOrigin, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    const originUrl = new URL(webAuthnOrigin);
    const rpID = originUrl.hostname;

    // Get user info
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);

    const runtimeUser = await runtimeUsers.findById(session.userId);
    if (!runtimeUser) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    // Get existing passkeys for exclusion
    const existingPasskeys = await authCtx.repositories.passkey.findByUserId(session.userId);

    const excludeCredentials: Array<{
      id: string;
      type: 'public-key';
      transports?: AuthenticatorTransport[];
    }> = existingPasskeys
      .map((pk) => {
        const normalizedId = normalizeStoredCredentialId(pk.credential_id);
        if (!normalizedId) return null;

        return {
          id: normalizedId,
          type: 'public-key' as const,
          transports: pk.transports.length > 0 ? pk.transports : undefined,
        };
      })
      .filter((cred): cred is NonNullable<typeof cred> => cred !== null);

    // Generate registration options
    const encoder = new TextEncoder();
    const authenticatorSelection: {
      authenticatorAttachment?: 'platform' | 'cross-platform';
      residentKey: 'required' | 'preferred' | 'discouraged';
      userVerification: 'required' | 'preferred' | 'discouraged';
    } = {
      residentKey: resident_key,
      userVerification: user_verification,
    };

    if (authenticator_type !== 'any') {
      authenticatorSelection.authenticatorAttachment = authenticator_type;
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      // @ts-ignore - TextEncoder.encode() returns compatible Uint8Array
      userID: encoder.encode(session.userId),
      userName: runtimeUser.email || session.userId,
      userDisplayName: display_name || runtimeUser.name || runtimeUser.email || session.userId,
      excludeCredentials,
      authenticatorSelection,
      attestationType: 'none',
    });

    // Store challenge
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByUserId(
      c.env,
      session.userId,
      getTenantIdFromContext(c)
    );

    await challengeStore.storeChallengeRpc({
      id: `direct_passkey_register:${session.userId}`,
      tenantId: getTenantIdFromContext(c),
      type: 'direct_passkey_register',
      userId: session.userId,
      challenge: options.challenge,
      ttl: CHALLENGE_TTL,
      metadata: {
        origin: webAuthnOrigin,
        rpID,
        challenge_id: challengeId,
        session_id: sessionId,
        display_name,
        authenticator_type,
      },
    });

    // Store challenge_id -> userId mapping
    const challengeMapStore = await getChallengeStoreByChallengeId(
      c.env,
      challengeId,
      getTenantIdFromContext(c)
    );
    await challengeMapStore.storeChallengeRpc({
      id: `direct_passkey_register_map:${challengeId}`,
      tenantId: getTenantIdFromContext(c),
      type: 'direct_passkey_register_map',
      userId: session.userId,
      challenge: challengeId,
      ttl: CHALLENGE_TTL,
    });

    return c.json({
      challenge_id: challengeId,
      options: {
        rp: options.rp,
        user: options.user,
        challenge: options.challenge,
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        excludeCredentials: options.excludeCredentials,
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
        extensions: options.extensions,
      },
    });
  } catch (error) {
    log.error('Direct passkey register start error', {
      action: 'register_start',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Passkey Register Finish (for authenticated users)
 * POST /api/v1/auth/direct/passkey/register/finish
 */
export async function directPasskeyRegisterFinishHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      challenge_id: string;
      credential: RegistrationResponseJSON;
      device_name?: string;
    }>();

    const { challenge_id, credential, device_name } = body;

    if (!challenge_id || !credential) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id, credential' },
      });
    }

    // Look up userId from challenge_id mapping
    const challengeMapStore = await getChallengeStoreByChallengeId(
      c.env,
      challenge_id,
      getTenantIdFromContext(c)
    );
    let userId: string;

    try {
      const mappingData = (await challengeMapStore.getChallengeRpc(
        `direct_passkey_register_map:${challenge_id}`
      )) as { userId: string } | null;

      if (mappingData?.userId) {
        userId = mappingData.userId;
      } else {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
      }
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Consume the actual challenge
    const challengeStore = await getChallengeStoreByUserId(
      c.env,
      userId,
      getTenantIdFromContext(c)
    );

    let challengeData: {
      challenge: string;
      metadata?: {
        origin: string;
        rpID: string;
        session_id: string;
        display_name?: string;
        authenticator_type?: 'platform' | 'cross-platform' | 'any';
      };
    };

    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `direct_passkey_register:${userId}`,
        tenantId: getTenantIdFromContext(c),
        type: 'direct_passkey_register',
      })) as typeof challengeData;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Verify session is still valid
    const sessionId = challengeData.metadata?.session_id;
    if (!sessionId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const session = await validateSession(c, sessionId);
    if (!session || session.userId !== userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    const origin = challengeData.metadata?.origin || '';
    const rpID = challengeData.metadata?.rpID || '';

    // Verify registration response
    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challengeData.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (error) {
      log.error('Registration verification failed', {
        action: 'register_finish',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    const { verified, registrationInfo } = verification;

    if (!verified || !registrationInfo) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    // Handle @simplewebauthn version compatibility
    const regInfo = registrationInfo as unknown as RegistrationInfoCompat;
    const credentialID = regInfo.credentialID || regInfo.credential?.id;
    const credentialPublicKey = regInfo.credentialPublicKey || regInfo.credential?.publicKey;
    const counter = regInfo.counter ?? regInfo.credential?.counter ?? 0;

    if (!credentialID || !credentialPublicKey) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Store passkey
    const tenantId = getTenantIdFromContext(c);
    if (usesTenantD1AccountStorage(c)) {
      await resolveAccountDataContextFromHono(c, userId);
    }
    const authCtx = createAuthContextFromHono(c, tenantId);
    const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64');
    const credentialIDBase64URL = toBase64URLString(credentialID as CredentialIDLike);
    const passkeyId = crypto.randomUUID();
    const transports = (credential.response.transports || []) as AuthenticatorTransport[];

    // Determine authenticator type from stored metadata or infer from transports
    let authenticatorType: 'platform' | 'cross-platform' = 'cross-platform';
    if (challengeData.metadata?.authenticator_type === 'platform') {
      authenticatorType = 'platform';
    } else if (transports.includes('internal' as AuthenticatorTransport)) {
      authenticatorType = 'platform';
    }

    await authCtx.repositories.passkey.create({
      id: passkeyId,
      user_id: userId,
      credential_id: credentialIDBase64URL,
      rp_id: rpID,
      public_key: publicKeyBase64,
      counter,
      transports,
      device_name: device_name || challengeData.metadata?.display_name || 'Additional Passkey',
      aaguid: regInfo.aaguid ?? null,
    });
    await publishTenantD1PasskeyRoute(c, {
      tenantId,
      userId,
      passkeyId,
      credentialId: credentialIDBase64URL,
      rpId: rpID,
    });

    // Clean up challenge mapping
    await challengeMapStore
      .deleteChallengeRpc(`direct_passkey_register_map:${challenge_id}`)
      .catch(() => {});

    // Return SDK-compatible response
    return c.json({
      credential_id: credentialIDBase64URL,
      public_key: publicKeyBase64,
      authenticator_type: authenticatorType,
      transports: transports.length > 0 ? transports : undefined,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    log.error('Direct passkey register finish error', {
      action: 'register_finish',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// ===== Session Handler =====

/**
 * Get Session Information
 * GET /api/v1/auth/direct/session
 *
 * Returns current session and user information.
 */
export async function directSessionHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    // Get session from cookie or Authorization header
    const sessionId = getSessionIdFromRequest(c);

    if (!sessionId) {
      // Return 401 for SDK compatibility (SDK expects !response.ok for no session)
      return c.json({ error: 'no_session', error_description: 'No session found' }, 401);
    }

    // Validate session
    const session = await validateSession(c, sessionId);
    if (!session) {
      // Return 401 for SDK compatibility
      return c.json({ error: 'session_expired', error_description: 'Session has expired' }, 401);
    }

    // Get user info
    const tenantId = getTenantIdFromContext(c);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);

    const runtimeUser = await runtimeUsers.findById(session.userId, { includeInactive: true });
    if (!runtimeUser || runtimeUser.active !== 1) {
      // Return 401 for SDK compatibility
      return c.json({ error: 'user_not_found', error_description: 'User not found' }, 401);
    }

    // Return SDK-compatible response: { session: Session, user: User }
    return c.json({
      session: {
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        data: session.data,
      },
      user: {
        id: runtimeUser.id,
        email: runtimeUser.email,
        name: runtimeUser.name,
        emailVerified: runtimeUser.email_verified === 1,
        createdAt: runtimeUser.created_at,
        updatedAt: runtimeUser.updated_at,
        lastLoginAt: runtimeUser.last_login_at,
      },
    });
  } catch (error) {
    log.error('Direct session error', {
      action: 'session',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// ===== Logout Handler =====

/**
 * Logout
 * POST /api/v1/auth/direct/logout
 *
 * Ends the current session and clears cookies.
 */
export async function directLogoutHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req
      .json<{
        client_id?: string;
        revoke_tokens?: boolean;
        logout_scope?: string;
      }>()
      .catch(() => ({ client_id: undefined, revoke_tokens: false, logout_scope: undefined }));

    const { client_id, revoke_tokens } = body;
    const logoutScope = body.logout_scope
      ? normalizeDeviceSecretLogoutScope(body.logout_scope)
      : 'local';

    // Get session from cookie or Authorization header
    const sessionId = getSessionIdFromRequest(c);

    if (sessionId) {
      let session: Session | null = null;

      // Invalidate session from SessionStore
      if (isShardedSessionId(sessionId)) {
        const { stub: sessionStore } = getSessionStoreBySessionId(
          c.env,
          sessionId,
          getTenantIdFromContext(c)
        );

        try {
          session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
        } catch (error) {
          log.warn('Failed to load session before logout', {
            action: 'logout_session_load',
            errorType: error instanceof Error ? error.name : 'Unknown',
          });
        }

        try {
          await sessionStore.invalidateSessionRpc(sessionId);
        } catch (error) {
          log.warn('Failed to invalidate session', {
            action: 'logout_session_invalidate',
            errorType: error instanceof Error ? error.name : 'Unknown',
          });
        }
      }

      const tenantId = getTenantIdFromContext(c);
      const authCtx = createAuthContextFromHono(c, tenantId);

      const nativeSSOEnabled = await isNativeSSOEnabled(c.env);
      if (nativeSSOEnabled) {
        try {
          const result = await revokeDeviceSecretsForLogoutScope({
            adapter: authCtx.coreAdapter,
            tenantId,
            sessionIds: [sessionId],
            userId: session?.userId,
            clientId: client_id,
            scope: logoutScope,
            reason: 'logout',
            callerAuthMode: 'access_token',
          });

          if (result.revokedDeviceSecrets > 0 || result.revokedInstallations > 0) {
            log.info('Revoked device secrets on Direct Auth logout', {
              action: 'direct_logout_device_secret_revoke',
              revokedCount: result.revokedDeviceSecrets,
              revokedInstallations: result.revokedInstallations,
              logoutScope: result.scope,
              trustGroupId: result.trustGroupId,
              targetClientId: result.clientId,
            });
          }
        } catch (error) {
          log.warn('Failed to revoke device secrets on logout', {
            action: 'direct_logout_device_secret_revoke_error',
            errorType: error instanceof Error ? error.name : 'Unknown',
          });
        }
      }

      // Revoke refresh tokens for this user if requested
      if (revoke_tokens && c.env.REFRESH_TOKEN_ROTATOR) {
        try {
          if (session?.userId) {
            // Query all active token families for this user from D1
            // Find all active token families for this user
            const families = await listRefreshTokenFamiliesByUser(authCtx.coreAdapter, {
              tenantId,
              userId: session.userId,
              activeOnly: true,
              nowMs: Date.now(),
            });

            // Revoke each family in the RefreshTokenRotator
            for (const family of families) {
              try {
                const { stub: rotator } = getRefreshTokenRotatorStubByJti(
                  c.env,
                  family.client_id,
                  family.jti,
                  getTenantIdFromContext(c)
                );
                await rotator.revokeByJtiRpc(family.jti, 'direct_auth_revoke_tokens');
              } catch (familyError) {
                // Log but continue with other families
                log.warn('Failed to revoke token family', {
                  action: 'revoke_token_family',
                  jti: family.jti,
                  errorType: familyError instanceof Error ? familyError.name : 'Unknown',
                });
              }
            }

            // Mark families as revoked in D1
            await expireRefreshTokenFamiliesByUser(authCtx.coreAdapter, {
              tenantId,
              userId: session.userId,
            });

            log.info('Revoked refresh tokens on logout', {
              action: 'revoke_refresh_tokens',
              userId: session.userId,
              familyCount: families.length,
            });
          }
        } catch (revokeError) {
          // Log but don't fail logout
          log.warn('Failed to revoke refresh tokens', {
            action: 'revoke_tokens_error',
            errorType: revokeError instanceof Error ? revokeError.name : 'Unknown',
          });
        }
      }
    }

    // Clear session cookie (SameSite must match when setting)
    deleteCookie(c, 'authrim_session', {
      path: '/',
      secure: true,
      sameSite: getSessionCookieSameSite(c.env),
    });

    return c.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    log.error('Direct logout error', {
      action: 'logout',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

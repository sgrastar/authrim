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
  buildDOInstanceName,
  getTenantSettings,
  generateId,
  generateUserIdFromSettings,
  createAuthContextFromHono,
  createPIIContextFromHono,
  hasPIIDatabase,
  createErrorResponse,
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
  BROWSER_STATE_COOKIE_NAME,
  getBrowserStateCookieSameSite,
  // Tenant domain resolution
  resolveTenantFromEmailDomain,
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
import { getPluginContext } from '@authrim/ar-lib-core';
import {
  persistRegistrationFieldValuesFromEnv,
  validateRegistrationFieldSubmissionFromEnv,
} from './registration-field-utils';

// ===== Constants =====

const RP_NAME = 'Authrim';
const CHALLENGE_TTL = 5 * 60; // 5 minutes
const AUTH_CODE_TTL = 60; // 60 seconds
const EMAIL_CODE_TTL = 5 * 60; // 5 minutes
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const DIRECT_AUTH_GRANT_REDIRECT_URI = 'https://authrim.local/direct-auth/callback';

type DirectAuthChannel = 'browser' | 'native' | 'server';

type AuthorizationChallengeType = 'login' | 'reauth';

interface AuthorizationChallengeContinuation {
  redirectUrl: string;
  type: AuthorizationChallengeType;
}

interface AuthorizationChallengeData {
  userId?: string;
  metadata?: Record<string, unknown>;
}

function isDirectAuthChannel(channel: unknown): channel is DirectAuthChannel {
  return channel === 'browser' || channel === 'native' || channel === 'server';
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
  credential?: {
    id: Uint8Array;
    publicKey: Uint8Array;
    counter: number;
  };
}

type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

// ===== Helper Functions =====

/**
 * Get allowed origins from KV (Settings Manager format) with fallback to env
 * Priority: KV (tenant.allowed_origins) > env (ALLOWED_ORIGINS) > ISSUER_URL
 */
async function getAllowedOriginsFromKV(env: Env, tenantId: string): Promise<string[]> {
  let allowedOriginsValue: string | undefined;

  const settings = await getTenantSettings(env.AUTHRIM_CONFIG, tenantId, 'tenant');
  if (settings && typeof settings['tenant.allowed_origins'] === 'string') {
    allowedOriginsValue = settings['tenant.allowed_origins'];
  }

  const allowedOriginsEnv = allowedOriginsValue || env.ALLOWED_ORIGINS || env.ISSUER_URL;
  return parseAllowedOrigins(allowedOriginsEnv);
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
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

  try {
    if (normalizeOrigin(new URL(c.req.url).origin) === normalizedOrigin) {
      return true;
    }
  } catch {
    // Ignore malformed or unavailable request URL and fall back to Host header.
  }

  const host = c.req.header('host');
  if (!host) {
    return false;
  }

  const normalizedHost = host.trim().toLowerCase();
  const candidates = new Set<string>([`https://${normalizedHost}`]);

  const hostnameOnly = normalizedHost.split(':')[0];
  if (isLocalHost(hostnameOnly)) {
    candidates.add(`http://${normalizedHost}`);
  }

  return candidates.has(normalizedOrigin);
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

function buildAuthorizeContinuationUrl(
  metadata: Record<string, unknown>,
  authTime: number,
  fallbackIssuer: string
): string {
  const issuer = metadataString(metadata, 'issuer') || fallbackIssuer;
  const authorizeUrl = new URL('/authorize', issuer);
  const params = new URLSearchParams();
  for (const key of [
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
    'claims',
    'response_mode',
    'max_age',
    'prompt',
    'acr_values',
    'id_token_hint',
    'display',
    'ui_locales',
    'login_hint',
    'error_uri',
    'cancel_uri',
  ]) {
    const value = metadataString(metadata, key);
    if (value) {
      params.set(key, value);
    }
  }

  params.set('_confirmed', 'true');
  params.set('_auth_time', String(authTime));

  const sessionUserId = metadataString(metadata, 'sessionUserId');
  if (sessionUserId) {
    params.set('_session_user_id', sessionUserId);
  }

  authorizeUrl.search = params.toString();
  return authorizeUrl.toString();
}

async function consumeAuthorizationChallengeContinuation(
  env: Env,
  challengeId: string,
  authenticatedUserId: string,
  authTime: number,
  fallbackIssuer: string
): Promise<AuthorizationChallengeContinuation | { error: Response }> {
  const challengeStore = await getChallengeStoreByChallengeId(env, challengeId);
  let challengeData: AuthorizationChallengeData;
  let type: AuthorizationChallengeType;

  try {
    challengeData = (await challengeStore.consumeChallengeRpc({
      id: challengeId,
      type: 'login',
      challenge: challengeId,
    })) as AuthorizationChallengeData;
    type = 'login';
  } catch {
    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: challengeId,
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

  return {
    type,
    redirectUrl: buildAuthorizeContinuationUrl(metadata, authTime, fallbackIssuer),
  };
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
    if (allowedOrigins.length > 0 && !isAllowedOrigin(origin, allowedOrigins)) {
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
    clientId,
    redirectUri: DIRECT_AUTH_GRANT_REDIRECT_URI,
    userId,
    scope,
    codeChallenge,
    codeChallengeMethod: 'S256',
    authTime: Math.floor(Date.now() / 1000),
    acr: 'urn:mace:incommon:iap:bronze',
  });

  const challengeStore = await getChallengeStoreByChallengeId(env, authCode);

  await challengeStore.storeChallengeRpc({
    id: `direct_auth:${authCode}`,
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
      email?: string; // Optional: for allowCredentials filtering
    }>();

    const { client_id, code_challenge, code_challenge_method, channel, scope, email } = body;

    // Validate required fields
    if (!client_id || !code_challenge || code_challenge_method !== 'S256' || !channel) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id, code_challenge, code_challenge_method=S256, channel' },
      });
    }
    if (!isDirectAuthChannel(channel)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const clientValidation = await validateDirectAuthClient(c, client_id, channel, originHeader);
    if (!clientValidation.valid) {
      return clientValidation.errorResponse as Response;
    }

    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    if (!originHeader || !isAllowedPasskeyRequestOrigin(c, originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;

    // Get user's passkeys if email is provided
    let allowCredentials: Array<{
      id: string;
      type: 'public-key';
      transports?: AuthenticatorTransport[];
    }> = [];

    if (email && hasPIIDatabase(c)) {
      const tenantId = getTenantIdFromContext(c);
      const authCtx = createAuthContextFromHono(c, tenantId);
      const piiCtx = createPIIContextFromHono(c, tenantId);

      const userPII = await piiCtx.piiRepositories.userPII.findByTenantAndEmail(tenantId, email);

      if (userPII) {
        const userCore = await authCtx.repositories.userCore.findById(userPII.id);
        if (userCore && userCore.is_active) {
          const userPasskeys = await authCtx.repositories.passkey.findByUserId(userPII.id);

          allowCredentials = userPasskeys
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
        }
      }
    }

    // Generate authentication options
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: allowCredentials.length > 0 ? allowCredentials : [],
    });

    // Store challenge with code_challenge in ChallengeStore
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId);

    await challengeStore.storeChallengeRpc({
      id: `direct_passkey_login:${challengeId}`,
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
        email: email || null,
        origin: originHeader,
        rpID,
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
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge_id);

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
      };
    };

    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `direct_passkey_login:${challenge_id}`,
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

      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    // Verify authentication response
    const origin = challengeData.metadata?.origin || '';
    const rpID = challengeData.metadata?.rpID || '';

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

    // Update counter
    await authCtx.repositories.passkey.updateCounterAfterAuth(
      passkey.id,
      authenticationInfo.newCounter
    );

    // Update last_login_at
    await authCtx.repositories.userCore.updateLastLogin(passkey.user_id);

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
      email: string;
      display_name?: string;
      code_challenge: string;
      code_challenge_method: CodeChallengeMethod;
      channel: DirectAuthChannel;
      scope?: string;
      authenticator_type?: 'platform' | 'cross-platform' | 'any';
      resident_key?: 'required' | 'preferred' | 'discouraged';
      user_verification?: 'required' | 'preferred' | 'discouraged';
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

    // Validate Origin
    const originHeader = c.req.header('origin');
    const clientValidation = await validateDirectAuthClient(c, client_id, channel, originHeader);
    if (!clientValidation.valid) {
      return clientValidation.errorResponse as Response;
    }

    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    if (!originHeader || !isAllowedPasskeyRequestOrigin(c, originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;

    // Check if user exists or create new
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    let user: { id: string; email: string; name: string | null } | null = null;

    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userPII = await piiCtx.piiRepositories.userPII.findByTenantAndEmail(
        tenantId,
        email.toLowerCase()
      );

      if (userPII) {
        const userCore = await authCtx.repositories.userCore.findById(userPII.id);
        if (userCore && userCore.is_active) {
          user = {
            id: userPII.id,
            email: userPII.email,
            name: userPII.name || null,
          };
        }
      }
    }

    if (!user) {
      // Create new user
      const newUserId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId);
      const defaultName = display_name || null;
      const preferredUsername = email.split('@')[0];

      await authCtx.repositories.userCore.createUser({
        id: newUserId,
        tenant_id: tenantId,
        email_verified: false,
        user_type: 'end_user',
        pii_partition: tenantId,
        pii_status: 'pending',
      });

      if (hasPIIDatabase(c)) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        try {
          await piiCtx.piiRepositories.userPII.createPII({
            id: newUserId,
            tenant_id: tenantId,
            email: email.toLowerCase(),
            name: defaultName,
            preferred_username: preferredUsername,
          });
          await authCtx.repositories.userCore.updatePIIStatus(newUserId, 'active');
        } catch (piiError) {
          log.error('Failed to create user in PII DB', {
            action: 'pii_create',
            errorType: piiError instanceof Error ? piiError.name : 'Unknown',
          });
          await authCtx.repositories.userCore.updatePIIStatus(newUserId, 'failed').catch(() => {});
        }
      }

      user = { id: newUserId, email: email.toLowerCase(), name: defaultName };
    }

    // Get existing passkeys for exclusion
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
      userName: email.toLowerCase(),
      userDisplayName: display_name || user.name || email,
      excludeCredentials,
      authenticatorSelection,
      attestationType: 'none',
    });

    // Store challenge using userId-based sharding
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByUserId(c.env, user.id);

    await challengeStore.storeChallengeRpc({
      id: `direct_passkey_signup:${user.id}`,
      type: 'direct_passkey_signup',
      userId: user.id,
      challenge: options.challenge,
      ttl: CHALLENGE_TTL,
      email: email.toLowerCase(),
      metadata: {
        code_challenge,
        client_id,
        channel,
        scope,
        origin: originHeader,
        rpID,
        challenge_id: challengeId,
      },
    });

    // Also store challenge_id -> userId mapping for finish endpoint
    const challengeMapStore = await getChallengeStoreByChallengeId(c.env, challengeId);
    await challengeMapStore.storeChallengeRpc({
      id: `direct_passkey_signup_map:${challengeId}`,
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
    const challengeMapStore = await getChallengeStoreByChallengeId(c.env, challenge_id);
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
    const challengeStore = await getChallengeStoreByUserId(c.env, userId);

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
      };
    };

    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `direct_passkey_signup:${userId}`,
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
    const authCtx = createAuthContextFromHono(c, tenantId);
    const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64');
    const credentialIDBase64URL = toBase64URLString(credentialID as CredentialIDLike);
    const passkeyId = crypto.randomUUID();

    await authCtx.repositories.passkey.create({
      id: passkeyId,
      user_id: userId,
      credential_id: credentialIDBase64URL,
      public_key: publicKeyBase64,
      counter,
      transports: (credential.response.transports || []) as AuthenticatorTransport[],
      device_name: 'Direct Auth Passkey',
    });

    // Update email_verified
    const now = Date.now();
    await authCtx.coreAdapter.execute(
      'UPDATE users_core SET email_verified = 1, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [now, userId, tenantId]
    );

    // Check if this is a new user (created in this flow)
    const userCore = await authCtx.repositories.userCore.findById(userId);
    const isNewUser = userCore ? now - (userCore.created_at || 0) < 60000 : false; // Created within last minute

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
      }
    );

    return c.json({
      direct_auth_artifact: authCode,
      expires_in: AUTH_CODE_TTL,
      is_new_user: isNewUser,
    });
  } catch (error) {
    log.error('Direct passkey signup finish error', {
      action: 'signup_finish',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// ===== Email Code Handlers =====

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
      custom_fields?: Record<string, unknown>;
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
      custom_fields,
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

    // Rate limiting
    const rateLimiterId = c.env.RATE_LIMITER.idFromName('email-code');
    const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);

    const rateLimitResult = await rateLimiter.incrementRpc(
      `direct_email_code:${email.toLowerCase()}`,
      {
        windowSeconds: 15 * 60,
        maxRequests: 3,
      }
    );

    if (!rateLimitResult.allowed) {
      return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
        variables: { retry_after: rateLimitResult.retryAfter },
      });
    }

    // Check/create user
    let tenantId = getTenantIdFromContext(c);
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
      if (
        invitation.invited_email &&
        invitation.invited_email.toLowerCase() !== email.toLowerCase()
      ) {
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
    } else if (tenantId === getDefaultTenantId(c.env)) {
      // If Host header did not resolve a specific tenant, try email domain routing
      const resolvedTenantId = await resolveTenantFromEmailDomain(routingCoreAdapter, email, c.env);
      if (resolvedTenantId) {
        tenantId = resolvedTenantId;
      }
    }

    const customFieldValidation = await validateRegistrationFieldSubmissionFromEnv(
      c.env,
      tenantId,
      custom_fields
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

    const authCtx = createAuthContextFromHono(c, tenantId);
    let user: { id: string; email: string; name: string | null } | null = null;

    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userPII = await piiCtx.piiRepositories.userPII.findByTenantAndEmail(
        tenantId,
        email.toLowerCase()
      );

      if (userPII) {
        const userCore = await authCtx.repositories.userCore.findById(userPII.id);
        if (userCore && userCore.is_active) {
          user = {
            id: userPII.id,
            email: userPII.email,
            name: userPII.name || null,
          };
        }
      }
    }

    if (!user) {
      const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId);
      const preferredUsername = email.split('@')[0];

      await authCtx.repositories.userCore.createUser({
        id: userId,
        tenant_id: tenantId,
        email_verified: false,
        user_type: 'end_user',
        pii_partition: tenantId,
        pii_status: 'pending',
      });

      if (hasPIIDatabase(c)) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        try {
          await piiCtx.piiRepositories.userPII.createPII({
            id: userId,
            tenant_id: tenantId,
            email: email.toLowerCase(),
            name: null,
            preferred_username: preferredUsername,
          });
          await authCtx.repositories.userCore.updatePIIStatus(userId, 'active');
        } catch {
          await authCtx.repositories.userCore.updatePIIStatus(userId, 'failed').catch(() => {});
        }
      }

      user = { id: userId, email: email.toLowerCase(), name: null };
    }

    // Generate attempt ID and code
    const attemptId = crypto.randomUUID();
    const code = generateEmailCode();
    const issuedAt = Date.now();
    const hmacSecret = c.env.OTP_HMAC_SECRET || c.env.ISSUER_URL;

    const [codeHash, emailHash, challengeStore] = await Promise.all([
      hashEmailCode(code, email.toLowerCase(), attemptId, issuedAt, hmacSecret),
      hashEmail(email.toLowerCase()),
      getChallengeStoreByChallengeId(c.env, attemptId),
    ]);

    await challengeStore.storeChallengeRpc({
      id: `direct_email_code:${attemptId}`,
      type: 'direct_email_code',
      userId: user.id,
      challenge: codeHash,
      ttl: EMAIL_CODE_TTL,
      email: email.toLowerCase(),
      metadata: {
        code_challenge,
        client_id,
        channel,
        scope,
        transaction_id: attemptId,
        email_hash: emailHash,
        issued_at: issuedAt,
        // Invite metadata (present only when signup is via invitation)
        ...(inviteData
          ? {
              invite_id: inviteData.invite_id,
              invite_token: inviteData.invite_token,
              invite_role_id: inviteData.invite_role_id,
              invite_org_id: inviteData.invite_org_id,
              invite_tenant_id: tenantId,
            }
          : {}),
        // Custom registration fields (validated and saved after email verification)
        ...(Object.keys(customFieldValidation.values).length > 0
          ? { custom_fields: customFieldValidation.values }
          : {}),
      },
    });

    // Send email
    const pluginCtx = getPluginContext(c);
    const emailNotifier = pluginCtx.registry.getNotifier('email');

    if (!emailNotifier) {
      log.warn('No email notifier plugin configured', {
        action: 'notifier_check',
        devCode: code,
      });
      return c.json({
        attempt_id: attemptId,
        expires_in: EMAIL_CODE_TTL,
        masked_email: maskEmail(email),
        _dev_code: code, // Only for development
      });
    }

    const fromEmail = c.env.EMAIL_FROM || 'noreply@authrim.dev';

    await emailNotifier.send({
      channel: 'email',
      to: email,
      from: fromEmail,
      subject: 'Your verification code',
      body: getEmailCodeHtml({
        name: user.name || undefined,
        email,
        code,
        expiresInMinutes: EMAIL_CODE_TTL / 60,
        appName: 'Authrim',
        logoUrl: undefined,
      }),
      metadata: {
        textBody: getEmailCodeText({
          name: user.name || undefined,
          email,
          code,
          expiresInMinutes: EMAIL_CODE_TTL / 60,
          appName: 'Authrim',
        }),
      },
    });

    return c.json({
      attempt_id: attemptId,
      expires_in: EMAIL_CODE_TTL,
      masked_email: maskEmail(email),
    });
  } catch (error) {
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
    const rateLimiterId = c.env.RATE_LIMITER.idFromName('email-code-verify');
    const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);

    const attemptResult = await rateLimiter.incrementRpc(`verify:${attempt_id}`, {
      windowSeconds: EMAIL_CODE_TTL,
      maxRequests: 5, // Max 5 attempts per code
    });

    if (!attemptResult.allowed) {
      // Invalidate the challenge when max attempts exceeded
      const challengeStore = await getChallengeStoreByChallengeId(c.env, attempt_id);
      await challengeStore.deleteChallengeRpc(`direct_email_code:${attempt_id}`).catch(() => {});

      return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
        variables: { retry_after: attemptResult.retryAfter },
      });
    }

    // Consume challenge
    const challengeStore = await getChallengeStoreByChallengeId(c.env, attempt_id);

    let challengeData: {
      challenge: string;
      userId: string;
      email?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata?: Record<string, any>;
    };

    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `direct_email_code:${attempt_id}`,
        type: 'direct_email_code',
      })) as typeof challengeData;
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
    const hmacSecret = c.env.OTP_HMAC_SECRET || c.env.ISSUER_URL;
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

    // Get user
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userCore = await authCtx.repositories.userCore.findById(challengeData.userId);

    if (!userCore || !userCore.is_active) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    // Update email_verified
    const now = Date.now();
    await authCtx.coreAdapter.execute(
      'UPDATE users_core SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [now, now, challengeData.userId, tenantId]
    );

    const isNewUser = userCore ? now - (userCore.created_at || 0) < 60000 : false;

    // Apply invitation role/org assignment if present
    const inviteId = challengeData.metadata?.invite_id as string | undefined;
    const inviteToken = challengeData.metadata?.invite_token as string | undefined;

    if (inviteId && inviteToken) {
      const inviteNow = Math.floor(now / 1000);
      try {
        const invitation = await findActiveInvitationByToken(
          authCtx.coreAdapter,
          inviteToken,
          inviteNow
        );
        if (!invitation || invitation.id !== inviteId || invitation.tenant_id !== tenantId) {
          log.warn('Invitation metadata no longer matches an active tenant invitation', {
            invite_id: inviteId,
            tenant_id: tenantId,
          });
        } else if (!(await consumeInvitationUse(authCtx.coreAdapter, invitation.id, inviteNow))) {
          log.warn('Invitation use_count increment was skipped during email verification', {
            invite_id: inviteId,
            tenant_id: tenantId,
          });
        } else {
          const assignmentResults = await applyInvitationAssignments(authCtx.coreAdapter, {
            userId: challengeData.userId,
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

    // Save custom registration fields if present
    const customFields = challengeData.metadata?.custom_fields as
      | Record<string, unknown>
      | undefined;
    if (customFields) {
      try {
        await persistRegistrationFieldValuesFromEnv(
          c.env,
          tenantId,
          challengeData.userId,
          customFields
        );
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
      challengeData.userId,
      challengeData.metadata?.code_challenge || '',
      {
        method: 'email_code',
        client_id: challengeData.metadata?.client_id,
        channel,
        scope: challengeData.metadata?.scope,
        transaction_id: challengeData.metadata?.transaction_id || attempt_id,
        is_new_user: isNewUser,
      }
    );

    // Publish success event
    publishEvent(c, {
      type: AUTH_EVENTS.EMAIL_CODE_SUCCEEDED,
      tenantId,
      data: {
        userId: challengeData.userId,
        method: 'email_code',
        clientId: challengeData.metadata?.client_id || 'direct-auth',
      } satisfies AuthEventData,
    }).catch(() => {});

    return c.json({
      direct_auth_artifact: authCode,
      expires_in: AUTH_CODE_TTL,
      is_new_user: isNewUser,
    });
  } catch (error) {
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
    }>();

    const {
      direct_auth_artifact,
      client_id,
      code_verifier,
      channel,
      provider_id,
      authorization_challenge_id,
    } = body;

    if (!direct_auth_artifact || !client_id || !code_verifier || !channel) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'direct_auth_artifact, client_id, code_verifier, and channel are required',
        },
        400
      );
    }

    if (channel !== 'browser') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'managed browser session finish requires channel=browser',
        },
        400
      );
    }

    const challengeStore = await getChallengeStoreByChallengeId(c.env, direct_auth_artifact);
    let artifactData: {
      challenge: string;
      userId: string;
      metadata?: Record<string, unknown>;
    };

    try {
      artifactData = (await challengeStore.consumeChallengeRpc({
        id: `direct_auth:${direct_auth_artifact}`,
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
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userCore = await authCtx.repositories.userCore.findById(artifactData.userId);
    if (!userCore || !userCore.is_active) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    let userPII: { email: string; name: string | null } = { email: '', name: null };
    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiResult = await piiCtx.piiRepositories.userPII.findById(artifactData.userId);
      if (piiResult) {
        userPII = { email: piiResult.email, name: piiResult.name || null };
      }
    }

    const sessionTTL = 24 * 60 * 60;
    const now = Date.now();
    const authTime = Math.floor(now / 1000);
    const amr = [typeof metadata.method === 'string' ? metadata.method : 'direct_auth'];
    const acr = 'urn:mace:incommon:iap:bronze';

    let authorizationContinuation: AuthorizationChallengeContinuation | undefined;
    if (authorization_challenge_id) {
      const continuation = await consumeAuthorizationChallengeContinuation(
        c.env,
        authorization_challenge_id,
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
      sessionTTL,
      {
        email: userPII.email || null,
        name: userPII.name,
        amr,
        acr,
        authTime,
        client_id,
        direct_auth_channel: channel,
      },
      tenantId
    );

    const isSecure = new URL(c.req.url).protocol === 'https:';
    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: isSecure,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: sessionTTL,
    });

    const browserState = await generateBrowserState(sessionId);
    setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
      path: '/',
      secure: isSecure,
      sameSite: getBrowserStateCookieSameSite(c.env),
      maxAge: sessionTTL,
    });

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({
      ok: true,
      expires_in: sessionTTL,
      session: {
        userId: artifactData.userId,
        createdAt: now,
        expiresAt: now + sessionTTL * 1000,
        authTime,
        acr,
        amr,
      },
      user: {
        id: artifactData.userId,
        email: userPII.email,
        name: userPII.name,
      },
      ...(authorizationContinuation
        ? {
            authorization: {
              challenge_id: authorization_challenge_id,
              type: authorizationContinuation.type,
            },
            redirect_url: authorizationContinuation.redirectUrl,
          }
        : {}),
    });
  } catch (error) {
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
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    if (!originHeader || !isAllowedPasskeyRequestOrigin(c, originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;

    // Get user info
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    const userCore = await authCtx.repositories.userCore.findById(session.userId);
    if (!userCore || !userCore.is_active) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    let userPII: { email: string; name: string | null } = { email: '', name: null };
    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiResult = await piiCtx.piiRepositories.userPII.findById(session.userId);
      if (piiResult) {
        userPII = { email: piiResult.email, name: piiResult.name || null };
      }
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
      userName: userPII.email,
      userDisplayName: display_name || userPII.name || userPII.email,
      excludeCredentials,
      authenticatorSelection,
      attestationType: 'none',
    });

    // Store challenge
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByUserId(c.env, session.userId);

    await challengeStore.storeChallengeRpc({
      id: `direct_passkey_register:${session.userId}`,
      type: 'direct_passkey_register',
      userId: session.userId,
      challenge: options.challenge,
      ttl: CHALLENGE_TTL,
      metadata: {
        origin: originHeader,
        rpID,
        challenge_id: challengeId,
        session_id: sessionId,
        display_name,
        authenticator_type,
      },
    });

    // Store challenge_id -> userId mapping
    const challengeMapStore = await getChallengeStoreByChallengeId(c.env, challengeId);
    await challengeMapStore.storeChallengeRpc({
      id: `direct_passkey_register_map:${challengeId}`,
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
    const challengeMapStore = await getChallengeStoreByChallengeId(c.env, challenge_id);
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
    const challengeStore = await getChallengeStoreByUserId(c.env, userId);

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
      public_key: publicKeyBase64,
      counter,
      transports,
      device_name: device_name || challengeData.metadata?.display_name || 'Additional Passkey',
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
    const authCtx = createAuthContextFromHono(c, tenantId);

    const userCore = await authCtx.repositories.userCore.findById(session.userId);
    if (!userCore || !userCore.is_active) {
      // Return 401 for SDK compatibility
      return c.json({ error: 'user_not_found', error_description: 'User not found' }, 401);
    }

    let userPII: { email: string | null; name: string | null } = { email: null, name: null };
    if (hasPIIDatabase(c)) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiResult = await piiCtx.piiRepositories.userPII.findById(session.userId);
      if (piiResult) {
        userPII = { email: piiResult.email, name: piiResult.name || null };
      }
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
        id: userCore.id,
        email: userPII.email,
        name: userPII.name,
        emailVerified: userCore.email_verified,
        createdAt: userCore.created_at,
        updatedAt: userCore.updated_at,
        lastLoginAt: userCore.last_login_at,
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
                  family.jti
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
    log.error('Direct logout error', {
      action: 'logout',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

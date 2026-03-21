/**
 * Direct Authentication API Handlers
 *
 * BetterAuth-style API for custom login pages.
 * Uses Authorization Code + PKCE pattern for security.
 *
 * Flow:
 * 1. start: Generate challenge, store with code_challenge, return challenge_id + WebAuthn/email options
 * 2. finish: Verify credential, verify PKCE, return auth_code (60s TTL, single-use)
 * 3. token: Verify auth_code + code_verifier, issue session/tokens
 *
 * Security:
 * - PKCE required for all flows
 * - auth_code: 60 second TTL, single-use
 * - Challenge: 5 minute TTL, atomic consumption
 * - Origin validation via CORS allowlist
 * - No direct token return (auth_code intermediate step)
 */

import { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  isAllowedOrigin,
  parseAllowedOrigins,
  getSessionStoreForNewSession,
  getSessionStoreBySessionId,
  isShardedSessionId,
  getChallengeStoreByChallengeId,
  getChallengeStoreByUserId,
  getTenantIdFromContext,
  getTenantSettings,
  generateId,
  generateUserIdFromSettings,
  createAuthContextFromHono,
  createPIIContextFromHono,
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
  // Refresh Token
  createRefreshToken,
  getRefreshTokenShardConfig,
  getRefreshTokenShardIndex,
  buildRefreshTokenRotatorInstanceName,
  createRefreshTokenJti,
  generateRefreshTokenRandomPart,
  // Tenant domain resolution
  resolveTenantFromEmailDomain,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';

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
import { importPKCS8 } from 'jose';

// ===== Constants =====

const RP_NAME = 'Authrim';
const CHALLENGE_TTL = 5 * 60; // 5 minutes
const AUTH_CODE_TTL = 60; // 60 seconds
const EMAIL_CODE_TTL = 5 * 60; // 5 minutes
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days

// Per-tenant Map cache for signing keys (avoids expensive RSA key import on every request)
const signingKeyCache = new Map<string, {
  privateKey: CryptoKey;
  kid: string;
  timestamp: number;
  version: string;
}>();
const KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get signing key from per-tenant KeyManager DO (with per-tenant caching).
 * Checks KV version signal to detect cross-worker emergency rotations.
 */
async function getSigningKeyFromKeyManager(
  env: Env,
  tenantId: string
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();
  const cached = signingKeyCache.get(tenantId);

  // Check cache — if within TTL, verify KV version to detect emergency rotation
  if (cached && now - cached.timestamp < KEY_CACHE_TTL) {
    const currentVersion = await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null) ?? '';
    if (currentVersion === cached.version) {
      return { privateKey: cached.privateKey, kid: cached.kid };
    }
    // Version mismatch: emergency rotation detected — fall through to refresh
  }

  // Fetch from per-tenant KeyManager DO
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Get active key via RPC
  let keyData = await keyManager.getActiveKeyWithPrivateRpc();

  if (!keyData) {
    // No active key, generate and activate one
    keyData = await keyManager.rotateKeysWithPrivateRpc();
  }

  // Import private key
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  // Fetch current version for cache coherence
  const version = await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null) ?? '';

  signingKeyCache.set(tenantId, { privateKey, kid: keyData.kid, timestamp: now, version });
  return { privateKey, kid: keyData.kid };
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

/**
 * Validate client_id exists and optionally verify origin
 * Note: This function is defined but not currently used in handlers.
 * It can be enabled for stricter client validation when needed.
 */
async function _validateClientId(
  c: Context<{ Bindings: Env }>,
  clientId: string,
  origin?: string | null
): Promise<{ valid: boolean; errorResponse?: Response }> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);

  // Find client by client_id using KV cache (with D1 fallback)
  const client = await getClient(c.env, clientId);

  if (!client) {
    return {
      valid: false,
      errorResponse: await createErrorResponse(c, AR_ERROR_CODES.CLIENT_INVALID),
    };
  }

  // Validate origin if provided and client has allowed_redirect_origins
  if (origin && client.allowed_redirect_origins) {
    const allowedOrigins = client.allowed_redirect_origins;
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
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

  const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
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
  userId: string,
  codeChallenge: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const authCode = crypto.randomUUID();
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

/**
 * Consume auth_code and verify PKCE
 */
async function consumeAuthCode(
  env: Env,
  authCode: string,
  codeVerifier: string
): Promise<{
  userId: string;
  metadata?: Record<string, unknown>;
} | null> {
  const challengeStore = await getChallengeStoreByChallengeId(env, authCode);

  try {
    const challengeData = (await challengeStore.consumeChallengeRpc({
      id: `direct_auth:${authCode}`,
      type: 'direct_auth_code',
    })) as {
      userId: string;
      challenge: string;
      metadata?: Record<string, unknown>;
    };

    // Verify PKCE
    const isValidPKCE = await verifyPKCE(codeVerifier, challengeData.challenge);
    if (!isValidPKCE) {
      return null;
    }

    return {
      userId: challengeData.userId,
      metadata: challengeData.metadata,
    };
  } catch {
    return null;
  }
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
      email?: string; // Optional: for allowCredentials filtering
    }>();

    const { client_id, code_challenge, code_challenge_method, email } = body;

    // Validate required fields
    if (!client_id || !code_challenge || code_challenge_method !== 'S256') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id, code_challenge, code_challenge_method=S256' },
      });
    }

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    if (!originHeader || !isAllowedOrigin(originHeader, allowedOrigins)) {
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

    if (email && c.env.DB_PII) {
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
    }>();

    const { challenge_id, credential, code_verifier } = body;

    if (!challenge_id || !credential || !code_verifier) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id, credential, code_verifier' },
      });
    }

    // Consume challenge atomically
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge_id);

    let challengeData: {
      challenge: string;
      metadata?: {
        code_challenge: string;
        client_id: string;
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
        await authCtx.coreAdapter.execute('UPDATE passkeys SET credential_id = ? WHERE id = ?', [
          credentialIDBase64URL,
          passkey.id,
        ]);
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
      passkey.user_id,
      challengeData.metadata?.code_challenge || '',
      {
        method: 'passkey',
        client_id: challengeData.metadata?.client_id,
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
      auth_code: authCode,
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
      authenticator_type = 'any',
      resident_key = 'required',
      user_verification = 'required',
    } = body;

    if (!client_id || !email || !code_challenge || code_challenge_method !== 'S256') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id, email, code_challenge, code_challenge_method=S256' },
      });
    }

    // Validate Origin
    const originHeader = c.req.header('origin');
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    if (!originHeader || !isAllowedOrigin(originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;

    // Check if user exists or create new
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    let user: { id: string; email: string; name: string | null } | null = null;

    if (c.env.DB_PII) {
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
        pii_partition: 'default',
        pii_status: 'pending',
      });

      if (c.env.DB_PII) {
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
    }>();

    const { challenge_id, credential, code_verifier } = body;

    if (!challenge_id || !credential || !code_verifier) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challenge_id, credential, code_verifier' },
      });
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
      'UPDATE users_core SET email_verified = 1, updated_at = ? WHERE id = ?',
      [now, userId]
    );

    // Check if this is a new user (created in this flow)
    const userCore = await authCtx.repositories.userCore.findById(userId);
    const isNewUser = userCore ? now - (userCore.created_at || 0) < 60000 : false; // Created within last minute

    // Generate auth_code
    const authCode = await generateAuthCode(
      c.env,
      userId,
      challengeData.metadata?.code_challenge || '',
      {
        method: 'passkey_signup',
        client_id: challengeData.metadata?.client_id,
        passkey_id: passkeyId,
        is_new_user: isNewUser,
      }
    );

    return c.json({
      auth_code: authCode,
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
      locale?: string;
      invite_token?: string;
      custom_fields?: Record<string, unknown>;
    }>();

    const {
      client_id,
      email,
      code_challenge,
      code_challenge_method,
      locale,
      invite_token,
      custom_fields,
    } = body;

    if (!client_id || !email || !code_challenge || code_challenge_method !== 'S256') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'client_id, email, code_challenge, code_challenge_method=S256' },
      });
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

    // Invitation token routing: overrides all other tenant resolution
    let inviteData: {
      invite_id: string;
      invite_token: string;
      invite_role_id: string | null;
      invite_org_id: string | null;
      invited_email: string | null;
    } | null = null;

    if (invite_token && c.env.DB) {
      const nowTs = Math.floor(Date.now() / 1000);
      const row = await c.env.DB.prepare(
        `SELECT id, tenant_id, invited_email, role_id, org_id, max_uses, use_count
         FROM tenant_invitations WHERE token = ? AND expires_at > ?`
      )
        .bind(invite_token, nowTs)
        .first<{
          id: string;
          tenant_id: string;
          invited_email: string | null;
          role_id: string | null;
          org_id: string | null;
          max_uses: number;
          use_count: number;
        }>();

      if (!row) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      if (row.max_uses !== -1 && row.use_count >= row.max_uses) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      // If invitation is restricted to a specific email, enforce it
      if (row.invited_email && row.invited_email.toLowerCase() !== email.toLowerCase()) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      tenantId = row.tenant_id;
      inviteData = {
        invite_id: row.id,
        invite_token,
        invite_role_id: row.role_id,
        invite_org_id: row.org_id,
        invited_email: row.invited_email,
      };
    } else if (tenantId === 'default' && c.env.DB) {
      // If Host header did not resolve a specific tenant, try email domain routing
      const resolvedTenantId = await resolveTenantFromEmailDomain(c.env.DB, email, c.env);
      if (resolvedTenantId) {
        tenantId = resolvedTenantId;
      }
    }

    const authCtx = createAuthContextFromHono(c, tenantId);
    let user: { id: string; email: string; name: string | null } | null = null;

    if (c.env.DB_PII) {
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
        pii_partition: 'default',
        pii_status: 'pending',
      });

      if (c.env.DB_PII) {
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
        ...(custom_fields ? { custom_fields } : {}),
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
    }>();

    const { attempt_id, code, code_verifier } = body;

    if (!attempt_id || !code || !code_verifier) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'attempt_id, code, code_verifier' },
      });
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
      'UPDATE users_core SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ?',
      [now, now, challengeData.userId]
    );

    const isNewUser = userCore ? now - (userCore.created_at || 0) < 60000 : false;

    // Apply invitation role/org assignment if present
    const inviteId = challengeData.metadata?.invite_id as string | undefined;
    const inviteToken = challengeData.metadata?.invite_token as string | undefined;
    const inviteRoleId = challengeData.metadata?.invite_role_id as string | undefined;
    const inviteOrgId = challengeData.metadata?.invite_org_id as string | undefined;

    if (inviteId && inviteToken && c.env.DB) {
      const inviteNow = Math.floor(now / 1000);
      try {
        // Increment use_count atomically
        await c.env.DB.prepare(
          'UPDATE tenant_invitations SET use_count = use_count + 1, updated_at = ? WHERE id = ?'
        )
          .bind(inviteNow, inviteId)
          .run();

        // Assign role if specified
        if (inviteRoleId) {
          await c.env.DB.prepare(
            `INSERT OR IGNORE INTO role_assignments (id, tenant_id, user_id, role_id, scope_type, scope_target, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'tenant', ?, ?, ?)`
          )
            .bind(
              crypto.randomUUID(),
              tenantId,
              challengeData.userId,
              inviteRoleId,
              tenantId,
              inviteNow,
              inviteNow
            )
            .run();
        }

        // Assign org if specified
        if (inviteOrgId) {
          await c.env.DB.prepare(
            `INSERT OR IGNORE INTO org_memberships (id, tenant_id, user_id, org_id, membership_type, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'member', ?, ?)`
          )
            .bind(
              crypto.randomUUID(),
              tenantId,
              challengeData.userId,
              inviteOrgId,
              inviteNow,
              inviteNow
            )
            .run();
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
    if (customFields && c.env.DB) {
      const schemaRows = await c.env.DB.prepare(
        `SELECT field_key, field_type, validation_rules
         FROM custom_claim_schemas
         WHERE tenant_id = ? AND show_on_registration = 1 AND is_active = 1`
      )
        .bind(tenantId)
        .all<{ field_key: string; field_type: string; validation_rules: string | null }>();
      const schemaMap = new Map((schemaRows.results ?? []).map((r) => [r.field_key, r]));
      const fieldNow = Math.floor(now / 1000);

      for (const [key, value] of Object.entries(customFields)) {
        const schema = schemaMap.get(key);
        if (!schema) continue; // unknown field — reject

        const strVal = String(value);

        // Apply validation_rules if present
        if (schema.validation_rules) {
          try {
            const rules = JSON.parse(schema.validation_rules) as Record<string, unknown>;
            if (schema.field_type === 'number') {
              const numVal = Number(strVal);
              if (isNaN(numVal)) continue;
              if (rules.min !== undefined && numVal < (rules.min as number)) continue;
              if (rules.max !== undefined && numVal > (rules.max as number)) continue;
            } else if (schema.field_type === 'enum') {
              const enumVals = rules.enum_values as string[] | undefined;
              if (enumVals && !enumVals.includes(strVal)) continue;
            } else {
              // string / date
              if (rules.min_length !== undefined && strVal.length < (rules.min_length as number))
                continue;
              if (rules.max_length !== undefined && strVal.length > (rules.max_length as number))
                continue;
              if (rules.pattern) {
                try {
                  if (!new RegExp(rules.pattern as string).test(strVal)) continue;
                } catch {
                  /* invalid regex — skip pattern check */
                }
              }
            }
          } catch {
            /* malformed validation_rules JSON — skip validation */
          }
        }

        try {
          await c.env.DB.prepare(
            `INSERT INTO user_custom_fields (id, user_id, tenant_id, field_key, field_value, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, tenant_id, field_key) DO UPDATE SET field_value=excluded.field_value, updated_at=excluded.updated_at`
          )
            .bind(
              crypto.randomUUID(),
              challengeData.userId,
              tenantId,
              key,
              strVal,
              fieldNow,
              fieldNow
            )
            .run();
        } catch {
          // Non-fatal
        }
      }
    }

    // Generate auth_code
    const authCode = await generateAuthCode(
      c.env,
      challengeData.userId,
      challengeData.metadata?.code_challenge || '',
      {
        method: 'email_code',
        client_id: challengeData.metadata?.client_id,
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
      auth_code: authCode,
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
 * Token Exchange
 * POST /api/v1/auth/direct/token
 *
 * Exchange auth_code for session/tokens
 */
export async function directTokenHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DIRECT-AUTH');

  try {
    const body = await c.req.json<{
      grant_type: 'authorization_code';
      code: string;
      client_id: string;
      code_verifier: string;
      provider_id?: string;
      request_refresh_token?: boolean;
    }>();

    const { grant_type, code, client_id, code_verifier, provider_id, request_refresh_token } = body;

    if (grant_type !== 'authorization_code' || !code || !client_id || !code_verifier) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'grant_type=authorization_code, code, client_id, code_verifier' },
      });
    }

    // Consume and verify auth_code
    const authCodeData = await consumeAuthCode(c.env, code, code_verifier);

    if (!authCodeData) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    const { userId, metadata } = authCodeData;

    // Verify client_id matches
    if (!metadata?.client_id || metadata.client_id !== client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Verify provider_id matches when code is bound to an external provider
    const allowedProviders = new Set<string>();
    if (metadata?.provider_id) allowedProviders.add(String(metadata.provider_id));
    if (metadata?.provider_slug) allowedProviders.add(String(metadata.provider_slug));
    if (metadata?.provider) allowedProviders.add(String(metadata.provider));
    if (allowedProviders.size > 0) {
      if (!provider_id || !allowedProviders.has(provider_id)) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }
    }

    // Get user info
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const userCore = await authCtx.repositories.userCore.findById(userId);

    if (!userCore || !userCore.is_active) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    let userPII: { email: string | null; name: string | null } = { email: null, name: null };
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiResult = await piiCtx.piiRepositories.userPII.findById(userId);
      if (piiResult) {
        userPII = { email: piiResult.email, name: piiResult.name || null };
      }
    }

    // Detect platform
    const originHeader = c.req.header('origin');
    const userAgent = c.req.header('User-Agent');
    const platform = detectPlatform(originHeader, userAgent);

    // Create session
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(
      c.env,
      getTenantIdFromContext(c)
    );
    const sessionTTL = 24 * 60 * 60; // 24 hours

    try {
      const authMethod = typeof metadata?.method === 'string' ? metadata.method : 'unknown';
      await sessionStore.createSessionRpc(sessionId, userId, sessionTTL, {
        email: userPII.email,
        name: userPII.name,
        amr: [authMethod],
        acr: 'urn:mace:incommon:iap:bronze',
        client_id,
        platform,
      });
    } catch (error) {
      log.error('Failed to create session', {
        action: 'session_create',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.SESSION_STORE_ERROR);
    }

    // Generate tokens
    // For web platform, use session cookie
    // For mobile (request_refresh_token), return refresh_token
    const accessToken = sessionId; // Session ID acts as access token for now
    const expiresIn = sessionTTL;

    // Set session cookie for web (SameSite determined dynamically based on origin configuration)
    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getSessionCookieSameSite(c.env),
      maxAge: sessionTTL,
    });

    // Publish session event
    publishEvent(c, {
      type: SESSION_EVENTS.USER_CREATED,
      tenantId,
      data: {
        sessionId,
        userId,
        ttlSeconds: sessionTTL,
      } satisfies SessionEventData,
    }).catch(() => {});

    // Audit log
    const ipAddress =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      c.req.header('X-Real-IP') ||
      'unknown';

    const auditPromise = createAuditLog(c.env, {
      tenantId,
      userId,
      action: 'user.login',
      resource: 'session',
      resourceId: sessionId,
      ipAddress,
      userAgent: userAgent || 'unknown',
      metadata: JSON.stringify({
        method: metadata?.method || 'direct_auth',
        client_id,
      }),
      severity: 'info',
    }).catch(() => {});
    c.executionCtx?.waitUntil(auditPromise);

    // Build response
    const response: {
      token_type: 'Bearer';
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      id_token?: string;
      scope?: string;
      session_established: boolean;
      session?: {
        id: string;
        userId: string;
        createdAt: string;
        expiresAt: string;
      };
      user?: {
        id: string;
        email?: string | null;
        name?: string | null;
        emailVerified?: boolean;
      };
    } = {
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: expiresIn,
      session_established: true,
      session: {
        id: sessionId,
        userId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + sessionTTL * 1000).toISOString(),
      },
      user: {
        id: userId,
        email: userPII.email,
        name: userPII.name,
        emailVerified: userCore.email_verified,
      },
    };

    // Add refresh_token if requested (for mobile/SPA)
    if (request_refresh_token && c.env.REFRESH_TOKEN_ROTATOR) {
      try {
        // Get signing key from KeyManager
        const { privateKey, kid } = await getSigningKeyFromKeyManager(c.env, getTenantIdFromContext(c));

        // Get shard configuration and calculate shard index
        const shardConfig = await getRefreshTokenShardConfig(c.env, client_id);
        const shardIndex = await getRefreshTokenShardIndex(
          userId,
          client_id,
          shardConfig.currentShardCount
        );

        // Generate sharded JTI with generation and shard info
        const randomPart = generateRefreshTokenRandomPart();
        const refreshTokenJti = createRefreshTokenJti(
          shardConfig.currentGeneration,
          shardIndex,
          randomPart
        );

        // Route to sharded DO instance
        const instanceName = buildRefreshTokenRotatorInstanceName(
          client_id,
          shardConfig.currentGeneration,
          shardIndex
        );
        const rotatorId = c.env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
        const rotator = c.env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

        // Create token family in RefreshTokenRotator
        const familyResult = await rotator.createFamilyRpc({
          jti: refreshTokenJti,
          userId,
          clientId: client_id,
          scope: 'openid profile email', // Default scope for direct auth
          ttl: REFRESH_TOKEN_TTL,
          generation: shardConfig.currentGeneration,
          shardIndex,
        });

        // Create refresh token JWT with rtv (Refresh Token Version) claim
        const refreshTokenResult = await createRefreshToken(
          {
            iss: getRequestIssuer(c),
            sub: userId,
            aud: client_id,
            client_id,
            scope: familyResult.allowedScope,
          },
          privateKey,
          kid,
          familyResult.expiresIn,
          familyResult.newJti,
          familyResult.version
        );

        response.refresh_token = refreshTokenResult.token;

        log.info('Refresh token issued', {
          action: 'refresh_token_issued',
          userId,
          clientId: client_id,
          jti: refreshTokenJti,
        });
      } catch (error) {
        // Log error but don't fail the request - session is still valid
        log.error('Failed to generate refresh token', {
          action: 'refresh_token_error',
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
        // Continue without refresh token
      }
    }

    return c.json(response);
  } catch (error) {
    log.error('Direct token error', {
      action: 'token',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
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

    if (!originHeader || !isAllowedOrigin(originHeader, allowedOrigins)) {
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
    if (c.env.DB_PII) {
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
    if (c.env.DB_PII) {
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
      }>()
      .catch(() => ({ client_id: undefined, revoke_tokens: false }));

    const { revoke_tokens } = body;

    // Get session from cookie or Authorization header
    const sessionId = getSessionIdFromRequest(c);

    if (sessionId) {
      // Invalidate session from SessionStore
      if (isShardedSessionId(sessionId)) {
        const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);

        try {
          await sessionStore.invalidateSessionRpc(sessionId);
        } catch (error) {
          log.warn('Failed to invalidate session', {
            action: 'logout_session_invalidate',
            errorType: error instanceof Error ? error.name : 'Unknown',
          });
        }
      }

      // Revoke refresh tokens for this user if requested
      if (revoke_tokens && c.env.REFRESH_TOKEN_ROTATOR && c.env.DB) {
        try {
          // Get session to get user ID
          const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
          const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

          if (session?.userId) {
            // Query all active token families for this user from D1
            const tenantId = getTenantIdFromContext(c);
            const authCtx = createAuthContextFromHono(c, tenantId);

            // Find all active token families for this user
            const families = await authCtx.coreAdapter.query<{
              jti: string;
              client_id: string;
              generation: number;
            }>(
              `SELECT jti, client_id, generation FROM user_token_families
               WHERE user_id = ? AND tenant_id = ? AND expires_at > ?`,
              [session.userId, tenantId, Date.now()]
            );

            // Revoke each family in the RefreshTokenRotator
            for (const family of families) {
              try {
                // Parse JTI to get shard info
                const jtiParts = family.jti.split(':');
                if (jtiParts.length >= 3) {
                  const shardIndex = parseInt(jtiParts[1], 10);
                  const instanceName = buildRefreshTokenRotatorInstanceName(
                    family.client_id,
                    family.generation,
                    shardIndex
                  );
                  const rotatorId = c.env.REFRESH_TOKEN_ROTATOR.idFromName(instanceName);
                  const rotator = c.env.REFRESH_TOKEN_ROTATOR.get(rotatorId);

                  // Revoke the family
                  await rotator.revokeFamilyRpc(family.jti);
                }
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
            await authCtx.coreAdapter.execute(
              `UPDATE user_token_families SET expires_at = 0
               WHERE user_id = ? AND tenant_id = ?`,
              [session.userId, tenantId]
            );

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

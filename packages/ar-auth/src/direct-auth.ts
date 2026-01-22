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
  generateId,
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
} from '@authrim/ar-lib-core';

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

// ===== Constants =====

const RP_NAME = 'Authrim';
const CHALLENGE_TTL = 5 * 60; // 5 minutes
const AUTH_CODE_TTL = 60; // 60 seconds
const EMAIL_CODE_TTL = 5 * 60; // 5 minutes

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

  // Find client by client_id using D1 query
  const clientResult = await authCtx.coreAdapter.queryOne<{
    id: string;
    client_id: string;
    allowed_redirect_origins: string | null;
  }>(
    'SELECT id, client_id, allowed_redirect_origins FROM oauth_clients WHERE client_id = ? LIMIT 1',
    [clientId]
  );

  if (!clientResult) {
    return {
      valid: false,
      errorResponse: await createErrorResponse(c, AR_ERROR_CODES.CLIENT_INVALID),
    };
  }

  // Validate origin if provided and client has allowed_redirect_origins
  if (origin && clientResult.allowed_redirect_origins) {
    const allowedOrigins = JSON.parse(clientResult.allowed_redirect_origins) as string[];
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
    const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

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
    const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

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
      const newUserId = generateId();
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
    }>();

    const { client_id, email, code_challenge, code_challenge_method, locale } = body;

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
      const userId = generateId();
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
      metadata?: {
        code_challenge: string;
        client_id: string;
        issued_at: number;
      };
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
      request_refresh_token?: boolean;
    }>();

    const { grant_type, code, client_id, code_verifier, request_refresh_token } = body;

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
    if (metadata?.client_id && metadata.client_id !== client_id) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
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
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env);
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
    if (request_refresh_token) {
      // TODO: Implement refresh token generation using RefreshTokenRotator
      // For now, we don't issue refresh tokens
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
    const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

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

      // TODO: If revoke_tokens is true, also revoke refresh tokens
      if (revoke_tokens) {
        // Future: Revoke refresh tokens associated with this session
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

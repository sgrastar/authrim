/**
 * WebAuthn/Passkey Handler
 * Implements Passkey registration and authentication using @simplewebauthn/server
 */

import { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  isAllowedOrigin,
  parseAllowedOrigins,
  getSessionStoreForNewSession,
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
  createLogger,
  // Audit Log
  createAuditLog,
  // Cookie Configuration
  getAdminCookieSameSite,
  getSessionCookieSameSite,
  // Admin Session Repository
  AdminSessionRepository,
  requireDedicatedAdminDatabaseAdapter,
  CanonicalRuntimeUserStore,
} from '@authrim/ar-lib-core';
import {
  persistRegistrationFieldValuesFromEnv,
  validateRegistrationFieldSubmissionFromEnv,
} from './registration-field-utils';
import { resolveSessionTtl } from './session-ttl';

// ===== Module-level Logger for Helper Functions =====
const moduleLogger = createLogger().module('PASSKEY');
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
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

// WebAuthn transport types (matches PasskeyRepository.AuthenticatorTransport)
type AuthenticatorTransport = 'usb' | 'nfc' | 'ble' | 'internal' | 'hybrid';

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

/**
 * @simplewebauthn registrationInfo type compatibility layer
 * The library changed its response format across versions, so we need to support both:
 * - v9 and earlier: credentialID, credentialPublicKey, counter at root level
 * - v10+: nested under credential property
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

/**
 * Allow explicitly configured origins and the current request origin.
 *
 * Same-origin WebAuthn requests should not require duplicating the tenant host
 * in tenant.allowed_origins, especially in multi-tenant subdomain deployments.
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

// RP (Relying Party) configuration
const RP_NAME = 'Authrim';

type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

/**
 * Normalize any credential identifier to an unpadded base64url string.
 * Handles legacy base64-encoded values saved in D1 as well as ArrayBuffer inputs.
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
 * Generate registration options for Passkey creation
 * POST /auth/passkey/register/options
 */
export async function passkeyRegisterOptionsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PASSKEY');
  try {
    const body = await c.req.json<{
      email: string;
      userId?: string;
      name?: string;
      custom_fields?: Record<string, unknown>;
    }>();

    const { email, userId, name, custom_fields } = body;

    if (!email) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'email' },
      });
    }
    if (userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    // Reject unauthorized origins
    if (!originHeader || !isAllowedPasskeyRequestOrigin(c, originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    // Use validated origin for RP ID and origin
    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;
    const origin = originHeader;

    const tenantId = getTenantIdFromContext(c);
    const customFieldValidation = await validateRegistrationFieldSubmissionFromEnv(
      c.env,
      tenantId,
      {
        ...(custom_fields ?? {}),
        email,
        'field.canonical.email': email,
        ...(name ? { name, 'field.canonical.name': name } : {}),
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

    // Check if user exists in the canonical runtime user store.
    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    let user: { id: string; email: string; name: string | null } | null = null;

    const normalizedEmail = email.toLowerCase();
    const runtimeUser = await runtimeUsers.findByEmail(normalizedEmail);
    if (runtimeUser) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    // If user doesn't exist, create a new canonical runtime user.
    if (!user) {
      const newUserId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);
      const defaultName = name || null;
      const preferredUsername = email.split('@')[0];

      try {
        await runtimeUsers.syncUser({
          userId: newUserId,
          email: normalizedEmail,
          name: defaultName,
          active: true,
          emailVerified: false,
          userType: 'end_user',
          sourceRef: 'passkey',
          customAttributesJson: JSON.stringify({
            preferred_username: preferredUsername,
          }),
        });
      } catch (piiError: unknown) {
        // PII Protection: Don't log full error (may contain PII)
        log.error('Failed to create canonical runtime user', {
          action: 'runtime_user_create',
          errorType: piiError instanceof Error ? piiError.name : 'Unknown',
        });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      user = { id: newUserId, email: normalizedEmail, name: defaultName || email.split('@')[0] };
    }

    // Get user's existing passkeys via Repository
    const existingPasskeys = await authCtx.repositories.passkey.findByUserId(user.id);

    const excludeCredentials: Array<{
      id: string;
      type: 'public-key';
      transports?: AuthenticatorTransport[];
    }> = existingPasskeys
      .map((pk) => {
        const normalizedId = normalizeStoredCredentialId(pk.credential_id);
        if (!normalizedId) {
          return null;
        }

        return {
          id: normalizedId,
          type: 'public-key' as const,
          transports: pk.transports.length > 0 ? pk.transports : undefined,
        };
      })
      .filter((cred): cred is NonNullable<typeof cred> => cred !== null);

    // Generate registration options
    const encoder = new TextEncoder();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      // @ts-ignore - TextEncoder.encode() returns compatible Uint8Array
      userID: encoder.encode(user.id as string),
      userName: normalizedEmail,
      userDisplayName: (user.name as string) || normalizedEmail,
      excludeCredentials: excludeCredentials,
      // Use platform authenticator (device-bound) for better security
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      attestationType: 'none',
    });

    // Store challenge in ChallengeStore DO for verification (TTL: 5 minutes) (RPC)
    // Use userId-based sharding (UUID, no PII in DO instance name)
    const challengeStore = await getChallengeStoreByUserId(
      c.env,
      user.id as string,
      getTenantIdFromContext(c)
    );

    await challengeStore.storeChallengeRpc({
      id: `passkey_reg:${user.id}`,
      tenantId: getTenantIdFromContext(c),
      type: 'passkey_registration',
      userId: user.id as string,
      challenge: options.challenge,
      ttl: 300, // 5 minutes
      email: normalizedEmail,
      metadata:
        Object.keys(customFieldValidation.values).length > 0
          ? { custom_fields: customFieldValidation.values }
          : undefined,
    });

    return c.json({
      options,
      userId: user.id,
    });
  } catch (error) {
    // PII Protection: Don't log full error (may contain user data)
    log.error('Passkey registration options error', {
      action: 'register_options',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Verify Passkey registration
 * POST /auth/passkey/register/verify
 */
export async function passkeyRegisterVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PASSKEY');
  try {
    const body = await c.req.json<{
      userId: string;
      credential: RegistrationResponseJSON;
      deviceName?: string;
    }>();

    const { userId, credential, deviceName } = body;

    if (!userId || !credential) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'userId and credential' },
      });
    }

    // Consume challenge from ChallengeStore DO (atomic operation, RPC)
    // This prevents parallel replay attacks
    // Use userId-based sharding (UUID, no PII) - must match the shard used during options generation
    const challengeStore = await getChallengeStoreByUserId(
      c.env,
      userId,
      getTenantIdFromContext(c)
    );

    let challengeData: {
      challenge: string;
      metadata?: {
        custom_fields?: Record<string, unknown>;
      };
    };
    try {
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `passkey_reg:${userId}`,
        tenantId: getTenantIdFromContext(c),
        type: 'passkey_registration',
        // No challenge value needed - DO will return it
      })) as typeof challengeData;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }
    if ((challengeData as { userId?: string }).userId !== userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    // Reject unauthorized origins
    if (!originHeader || !isAllowedPasskeyRequestOrigin(c, originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    // Use validated origin for RP ID and origin
    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;
    const origin = originHeader;

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
      // PII Protection: Don't log full error
      log.error('Registration verification failed', {
        action: 'register_verify',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED, {
        extensions: {
          webauthn_signal: {
            unknown_credential: true,
          },
        },
      });
    }

    const { verified, registrationInfo } = verification;

    if (!verified || !registrationInfo) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    // Handle @simplewebauthn version compatibility (v9 vs v10+ response format)
    const regInfo = registrationInfo as unknown as RegistrationInfoCompat;
    const credentialID = regInfo.credentialID || regInfo.credential?.id;
    const credentialPublicKey = regInfo.credentialPublicKey || regInfo.credential?.publicKey;
    const counter = regInfo.counter ?? regInfo.credential?.counter ?? 0;

    if (!credentialID || !credentialPublicKey) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }

    // Convert credentialPublicKey (Uint8Array) to base64
    const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64');
    const credentialIDBase64URL = toBase64URLString(credentialID as CredentialIDLike);

    const passkeyId = crypto.randomUUID();
    const now = Date.now();
    const tenantId = getTenantIdFromContext(c);
    const sessionTtl = await resolveSessionTtl(c.env, tenantId, 'passkey_registration');

    // Step 1: Create session using SessionStore Durable Object (FIRST, sharded) via RPC
    // This ensures that if session creation fails, we don't store the passkey
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);

    let sessionData: { id: string };
    try {
      const createdSession = (await sessionStore.createSessionRpc(
        sessionId,
        userId,
        sessionTtl.seconds,
        {
          amr: ['passkey'],
          acr: 'urn:mace:incommon:iap:bronze',
        },
        tenantId
      )) as Session;
      sessionData = { id: createdSession.id };
    } catch (error) {
      // PII Protection: Don't log full error
      log.error('Failed to create session', {
        action: 'session_create',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.SESSION_STORE_ERROR);
    }

    // Step 2: Store passkey via Repository
    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);

    await authCtx.repositories.passkey.create({
      id: passkeyId,
      user_id: userId,
      credential_id: credentialIDBase64URL,
      public_key: publicKeyBase64,
      counter,
      transports: (credential.response.transports || []) as AuthenticatorTransport[],
      device_name: deviceName || 'Unknown Device',
      aaguid: regInfo.aaguid ?? null,
    });

    // Registering a passkey proves possession of the authenticator, not the email address.
    // Keep email verification tied to email-code or explicit verification flows.
    const updatedUser = await runtimeUsers.findById(userId, { includeInactive: true });

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

    // Note: Challenge is already consumed by ChallengeStore DO (atomic operation)
    // No need to explicitly delete - consumed challenges are auto-cleaned by DO

    return c.json({
      verified: true,
      passkeyId,
      sessionId: sessionData.id,
      message: 'Passkey registered successfully',
      userId: userId,
      user: {
        id: updatedUser!.id,
        email: updatedUser!.email,
        name: updatedUser!.name,
        email_verified: updatedUser!.email_verified,
        created_at: updatedUser!.created_at,
        updated_at: updatedUser!.updated_at,
        last_login_at: updatedUser!.last_login_at,
      },
    });
  } catch (error) {
    // PII Protection: Don't log full error (may contain credential data)
    log.error('Passkey registration verify error', {
      action: 'register_verify_final',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Generate authentication options for Passkey login
 * POST /auth/passkey/login/options
 */
export async function passkeyLoginOptionsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PASSKEY');
  try {
    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    // Reject unauthorized origins
    if (!originHeader || !isAllowedPasskeyRequestOrigin(c, originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    // Use validated origin for RP ID
    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;

    // Generate authentication options
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      // Always use discoverable credentials. Email collection belongs to OTP or profile flows.
      allowCredentials: [],
    });

    // WebAuthn Level 3: Add hints to influence browser UI
    // 'hybrid' suggests cross-device authentication (1Password, phone as authenticator)
    // 'client-device' suggests platform authenticators (Touch ID, etc.)
    // 'security-key' suggests roaming authenticators (YubiKey, etc.)
    // Order indicates preference - hybrid first for password managers like 1Password
    options.hints = ['hybrid', 'client-device', 'security-key'];

    // Store challenge in ChallengeStore DO for verification (TTL: 5 minutes) (RPC)
    // Use challengeId-based sharding for discoverable credentials (email may not be provided)
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challengeId,
      getTenantIdFromContext(c)
    );

    await challengeStore.storeChallengeRpc({
      id: `passkey_auth:${challengeId}`,
      tenantId: getTenantIdFromContext(c),
      type: 'passkey_authentication',
      userId: 'unknown', // Will be determined during verification
      challenge: options.challenge,
      ttl: 300, // 5 minutes
    });

    return c.json({
      options,
      challengeId,
    });
  } catch (error) {
    // PII Protection: Don't log full error (may contain user data)
    log.error('Passkey login options error', {
      action: 'login_options',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Verify Passkey authentication
 * POST /auth/passkey/login/verify
 */
export async function passkeyLoginVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('PASSKEY');
  try {
    const body = await c.req.json<{
      challengeId: string;
      credential: AuthenticationResponseJSON;
    }>();

    const { challengeId, credential } = body;

    if (!challengeId || !credential) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'challengeId and credential' },
      });
    }

    // Consume challenge from ChallengeStore DO (atomic operation, RPC)
    // Use challengeId-based sharding - must match the shard used during options generation
    const challengeStore = await getChallengeStoreByChallengeId(
      c.env,
      challengeId,
      getTenantIdFromContext(c)
    );

    let challenge: string;
    try {
      const challengeData = (await challengeStore.consumeChallengeRpc({
        id: `passkey_auth:${challengeId}`,
        tenantId: getTenantIdFromContext(c),
        type: 'passkey_authentication',
      })) as { challenge: string };
      challenge = challengeData.challenge;
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Get credential ID from response
    const credentialIDBase64URL = toBase64URLString(credential.id);

    // Look up passkey via Repository
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    let passkey = await authCtx.repositories.passkey.findByCredentialId(credentialIDBase64URL);

    // Legacy fallback: credential IDs used to be stored as standard base64
    if (!passkey && isoBase64URL.isBase64URL(credentialIDBase64URL)) {
      const legacyId = isoBase64URL.toBase64(credentialIDBase64URL);
      passkey = await authCtx.repositories.passkey.findByCredentialId(legacyId);

      if (passkey) {
        // Update legacy credential ID to base64url format via Adapter
        await authCtx.coreAdapter.execute(
          'UPDATE passkeys SET credential_id = ? WHERE id = ? AND tenant_id = ?',
          [credentialIDBase64URL, passkey.id, tenantId]
        );
        passkey.credential_id = credentialIDBase64URL;
      }
    }

    if (!passkey) {
      // Publish auth.passkey.failed event (non-blocking)
      // Security: Don't include userId to prevent enumeration
      publishEvent(c, {
        type: AUTH_EVENTS.PASSKEY_FAILED,
        tenantId,
        data: {
          method: 'passkey',
          clientId: 'passkey-auth',
          errorCode: 'credential_not_found',
        } satisfies AuthEventData,
      }).catch((err) => {
        log.error('Failed to publish auth.passkey.failed event', {
          action: 'event_publish',
          errorType: err instanceof Error ? err.name : 'Unknown',
        });
      });

      // Security: Generic message to prevent passkey enumeration
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOrigins = await getAllowedOriginsFromKV(c.env, getTenantIdFromContext(c));

    // Reject unauthorized origins
    if (!originHeader || !isAllowedPasskeyRequestOrigin(c, originHeader, allowedOrigins)) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    // Use validated origin for RP ID and origin
    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;
    const origin = originHeader;

    // Convert stored public key from base64 to Uint8Array
    const normalizedCredentialId = normalizeStoredCredentialId(passkey.credential_id as string);
    if (!normalizedCredentialId) {
      // PII Protection: Don't log passkey.id
      log.error('Stored credential ID could not be normalized', { action: 'credential_normalize' });
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    const publicKey = Uint8Array.from(Buffer.from(passkey.public_key as string, 'base64'));

    // Verify authentication response
    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: normalizedCredentialId as string,
          publicKey: publicKey,
          counter: passkey.counter as number,
        },
      });
    } catch (error) {
      // Publish auth.passkey.failed event (non-blocking)
      publishEvent(c, {
        type: AUTH_EVENTS.PASSKEY_FAILED,
        tenantId,
        data: {
          method: 'passkey',
          clientId: 'passkey-auth',
          errorCode: 'verification_exception',
        } satisfies AuthEventData,
      }).catch((err) => {
        log.error('Failed to publish auth.passkey.failed event', {
          action: 'event_publish',
          errorType: err instanceof Error ? err.name : 'Unknown',
        });
      });

      // PII Protection: Don't log full error
      log.error('Authentication verification failed', {
        action: 'login_verify',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    const { verified, authenticationInfo } = verification;

    if (!verified) {
      // Publish auth.passkey.failed event (non-blocking)
      publishEvent(c, {
        type: AUTH_EVENTS.PASSKEY_FAILED,
        tenantId,
        data: {
          method: 'passkey',
          clientId: 'passkey-auth',
          errorCode: 'verification_failed',
        } satisfies AuthEventData,
      }).catch((err) => {
        log.error('Failed to publish auth.passkey.failed event', {
          action: 'event_publish',
          errorType: err instanceof Error ? err.name : 'Unknown',
        });
      });

      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const runtimeUser = await runtimeUsers.findById(passkey.user_id);
    if (!runtimeUser || runtimeUser.active !== 1) {
      publishEvent(c, {
        type: AUTH_EVENTS.PASSKEY_FAILED,
        tenantId,
        data: {
          userId: passkey.user_id,
          method: 'passkey',
          clientId: 'passkey-auth',
          errorCode: 'user_inactive',
        } satisfies AuthEventData,
      }).catch((err) => {
        log.error('Failed to publish auth.passkey.failed event', {
          action: 'event_publish',
          errorType: err instanceof Error ? err.name : 'Unknown',
        });
      });

      return createErrorResponse(c, AR_ERROR_CODES.AUTH_PASSKEY_FAILED);
    }

    const now = Date.now();
    const referer = c.req.header('Referer') || '';
    const isAdminContext = referer.includes('/admin');
    const isAdminSessionContext = isAdminContext && runtimeUser.account_type === 'admin';
    const sessionTtl = await resolveSessionTtl(
      c.env,
      tenantId,
      isAdminSessionContext ? 'admin_passkey' : 'passkey'
    );

    // Step 1: Create session using SessionStore Durable Object (FIRST, sharded) via RPC
    // This ensures that if session creation fails, we don't update the database
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env, tenantId);

    let sessionData: { id: string };
    try {
      const createdSession = (await sessionStore.createSessionRpc(
        sessionId,
        passkey.user_id as string,
        sessionTtl.seconds,
        {
          amr: ['passkey'],
          acr: 'urn:mace:incommon:iap:bronze',
        },
        tenantId
      )) as Session;
      sessionData = { id: createdSession.id };
    } catch (error) {
      // PII Protection: Don't log full error
      log.error('Failed to create session', {
        action: 'session_create',
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return createErrorResponse(c, AR_ERROR_CODES.SESSION_STORE_ERROR);
    }

    // Step 2: Update counter and last_used_at via Repository
    await authCtx.repositories.passkey.updateCounterAfterAuth(
      passkey.id,
      authenticationInfo.newCounter
    );

    // Step 3: Update user's last_login_at in canonical runtime metadata.
    await runtimeUsers.touchLastLogin(passkey.user_id);

    // Admin/EndUser Separation: Create session in admin_sessions table for admin users
    // This is required because admin-auth middleware reads from admin_sessions (DB_ADMIN)
    if (runtimeUser?.account_type === 'admin' && c.env.DB_ADMIN) {
      try {
        const adminAdapter = requireDedicatedAdminDatabaseAdapter(c.env, 'passkey-admin');
        const adminSessionRepo = new AdminSessionRepository(adminAdapter);

        // Get client IP from Cloudflare header
        const clientIp =
          c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null;
        const userAgent = c.req.header('User-Agent') || null;

        await adminSessionRepo.createSession({
          id: sessionData.id, // Use same session ID as SessionStore DO
          tenant_id: tenantId,
          admin_user_id: passkey.user_id,
          ip_address: clientIp || undefined,
          user_agent: userAgent || undefined,
          expires_at: now + sessionTtl.milliseconds,
          mfa_verified: true, // Passkey is MFA
        });

        log.info('Admin session created in admin_sessions table', {
          action: 'admin_session_create',
          sessionId: sessionData.id,
        });
      } catch (error) {
        // Log but don't fail - SessionStore DO session is already created
        log.error('Failed to create admin session in DB_ADMIN', {
          action: 'admin_session_create',
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
      }
    }

    // Note: Challenge is already consumed by ChallengeStore DO (atomic operation)
    // No need to explicitly delete - consumed challenges are auto-cleaned by DO

    // Publish auth.passkey.succeeded event (non-blocking)
    publishEvent(c, {
      type: AUTH_EVENTS.PASSKEY_SUCCEEDED,
      tenantId,
      data: {
        userId: passkey.user_id,
        method: 'passkey',
        clientId: 'passkey-auth', // Direct passkey auth has no OAuth client
        sessionId: sessionData.id,
      } satisfies AuthEventData,
    }).catch((err) => {
      // Non-blocking: log error but don't fail the request
      log.error('Failed to publish auth.passkey.succeeded event', {
        action: 'event_publish',
        errorType: err instanceof Error ? err.name : 'Unknown',
      });
    });

    // Publish session.user.created event (non-blocking)
    publishEvent(c, {
      type: SESSION_EVENTS.USER_CREATED,
      tenantId,
      data: {
        sessionId: sessionData.id,
        userId: passkey.user_id,
        ttlSeconds: sessionTtl.seconds,
      } satisfies SessionEventData,
    }).catch((err) => {
      log.error('Failed to publish session.user.created event', {
        action: 'event_publish',
        errorType: err instanceof Error ? err.name : 'Unknown',
      });
    });

    // Write audit log for passkey login (non-blocking)
    const ipAddress =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      c.req.header('X-Real-IP') ||
      'unknown';
    const userAgent = c.req.header('User-Agent') || 'unknown';

    // Schedule audit log with waitUntil to ensure it completes after response
    const auditPromise = createAuditLog(c.env, {
      tenantId,
      userId: passkey.user_id,
      action: 'user.login',
      resource: 'session',
      resourceId: sessionData.id,
      ipAddress,
      userAgent,
      metadata: JSON.stringify({ method: 'passkey', passkey_id: passkey.id }),
      severity: 'info',
    }).catch((err) => {
      log.error('Failed to create audit log for passkey login', {
        action: 'audit_log',
        errorType: err instanceof Error ? err.name : 'Unknown',
      });
    });
    c.executionCtx?.waitUntil(auditPromise);

    // Set session cookie based on validated login context.
    // - Admin UI login by an admin user: 'authrim_admin_session'
    // - Login UI / End-user login: 'authrim_session' for OIDC SSO
    // This allows admin users to also have end-user sessions for SSO testing
    // SameSite is determined dynamically based on origin configuration:
    // - Same origin: 'Lax' (more secure)
    // - Cross origin: 'None' (required for cross-origin)
    const cookieName = isAdminSessionContext ? 'authrim_admin_session' : 'authrim_session';
    const sameSiteFn = isAdminSessionContext ? getAdminCookieSameSite : getSessionCookieSameSite;
    const sameSiteValue = sameSiteFn(c.env);

    // Debug: Log session cookie creation for SSO troubleshooting
    log.info('Setting session cookie', {
      action: 'session_cookie_set',
      cookieName,
      sessionIdPrefix: sessionData.id.substring(0, 30),
      sameSite: sameSiteValue,
      isAdminContext: isAdminSessionContext,
    });

    setCookie(c, cookieName, sessionData.id, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: sameSiteValue,
      maxAge: sessionTtl.seconds,
    });

    return c.json({
      verified: true,
      sessionId: sessionData.id,
      userId: passkey.user_id,
      user: {
        id: runtimeUser!.id,
        email: runtimeUser!.email,
        name: runtimeUser!.name,
        email_verified: runtimeUser!.email_verified,
        created_at: runtimeUser!.created_at,
        updated_at: runtimeUser!.updated_at,
        last_login_at: runtimeUser!.last_login_at,
      },
    });
  } catch (error) {
    // PII Protection: Don't log full error (may contain credential data)
    log.error('Passkey login verify error', {
      action: 'login_verify_final',
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * WebAuthn/Passkey Handler
 * Implements Passkey registration and authentication using @simplewebauthn/server
 */

import { Context } from 'hono';
import type { Env, Session } from '@authrim/shared';
import {
  isAllowedOrigin,
  parseAllowedOrigins,
  getSessionStoreForNewSession,
  getChallengeStoreByChallengeId,
  getChallengeStoreByUserId,
  getTenantIdFromContext,
  generateId,
  createAuthContextFromHono,
  createPIIContextFromHono,
} from '@authrim/shared';
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
  try {
    const body = await c.req.json<{
      email: string;
      userId?: string;
      name?: string;
    }>();

    const { email, userId, name } = body;

    if (!email) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Email is required',
        },
        400
      );
    }

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

    // Reject unauthorized origins
    if (!originHeader || !isAllowedOrigin(originHeader, allowedOrigins)) {
      return c.json(
        {
          error: 'unauthorized_origin',
          error_description: 'Origin not allowed for WebAuthn operations',
        },
        403
      );
    }

    // Use validated origin for RP ID and origin
    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;
    const origin = originHeader;

    // Check if user exists via Repository pattern
    // PII/Non-PII DB分離: email検索はPII DB、ID検索はCore DBを使用
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    let user: { id: string; email: string; name: string | null } | null = null;

    if (userId) {
      // Search by userId: Core DB has the ID, PII DB has email/name
      const userCore = await authCtx.repositories.userCore.findById(userId);

      if (userCore && userCore.is_active && c.env.DB_PII) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        const userPII = await piiCtx.piiRepositories.userPII.findById(userId);
        if (userPII) {
          user = {
            id: userCore.id,
            email: userPII.email,
            name: userPII.name || null,
          };
        }
      } else if (userCore && userCore.is_active) {
        // No PII DB - use Core only (email will be missing)
        user = { id: userCore.id, email: '', name: null };
      }
    } else if (c.env.DB_PII) {
      // Search by email: PII DB first to get user id
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const userPII = await piiCtx.piiRepositories.userPII.findByTenantAndEmail(tenantId, email);

      if (userPII) {
        // Verify user is active in Core DB
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

    // If user doesn't exist, create a new user via Repository
    if (!user) {
      const newUserId = generateId();
      const now = Date.now();
      const defaultName = name || null;
      const preferredUsername = email.split('@')[0];

      // Step 1: Create user in Core DB with pii_status='pending'
      await authCtx.repositories.userCore.createUser({
        id: newUserId,
        tenant_id: tenantId,
        email_verified: false,
        user_type: 'end_user',
        pii_partition: 'default',
        pii_status: 'pending',
      });

      // Step 2: Create user in PII DB (if DB_PII is configured)
      if (c.env.DB_PII) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        await piiCtx.piiRepositories.userPII.createPII({
          id: newUserId,
          tenant_id: tenantId,
          email,
          name: defaultName,
          preferred_username: preferredUsername,
        });

        // Step 3: Update pii_status to 'active'
        await authCtx.repositories.userCore.updatePIIStatus(newUserId, 'active');
      }

      user = { id: newUserId, email, name: defaultName || email.split('@')[0] };
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
      userName: email,
      userDisplayName: (user.name as string) || email,
      excludeCredentials: excludeCredentials as any,
      // Use platform authenticator (device-bound) for better security
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      attestationType: 'none',
    });

    // Store challenge in ChallengeStore DO for verification (TTL: 5 minutes) (RPC)
    // Use userId-based sharding (UUID, no PII in DO instance name)
    const challengeStore = await getChallengeStoreByUserId(c.env, user.id as string);

    await challengeStore.storeChallengeRpc({
      id: `passkey_reg:${user.id}`,
      type: 'passkey_registration',
      userId: user.id as string,
      challenge: options.challenge,
      ttl: 300, // 5 minutes
      email,
    });

    return c.json({
      options,
      userId: user.id,
    });
  } catch (error) {
    console.error('Passkey registration options error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to generate registration options',
      },
      500
    );
  }
}

/**
 * Verify Passkey registration
 * POST /auth/passkey/register/verify
 */
export async function passkeyRegisterVerifyHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      userId: string;
      credential: RegistrationResponseJSON;
      deviceName?: string;
    }>();

    const { userId, credential, deviceName } = body;

    if (!userId || !credential) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User ID and credential are required',
        },
        400
      );
    }

    // Consume challenge from ChallengeStore DO (atomic operation, RPC)
    // This prevents parallel replay attacks
    // Use userId-based sharding (UUID, no PII) - must match the shard used during options generation
    const challengeStore = await getChallengeStoreByUserId(c.env, userId);

    let challenge: string;
    try {
      const challengeData = (await challengeStore.consumeChallengeRpc({
        id: `passkey_reg:${userId}`,
        type: 'passkey_registration',
        // No challenge value needed - DO will return it
      })) as { challenge: string };
      challenge = challengeData.challenge;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Challenge not found or expired',
        },
        400
      );
    }

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

    // Reject unauthorized origins
    if (!originHeader || !isAllowedOrigin(originHeader, allowedOrigins)) {
      return c.json(
        {
          error: 'unauthorized_origin',
          error_description: 'Origin not allowed for WebAuthn operations',
        },
        403
      );
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
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (error) {
      console.error('Registration verification failed:', error);
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Registration verification failed',
        },
        400
      );
    }

    const { verified, registrationInfo } = verification;

    if (!verified || !registrationInfo) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Registration could not be verified',
        },
        400
      );
    }

    const registrationInfoAny = registrationInfo as any;
    const credentialID = registrationInfoAny.credentialID || registrationInfoAny.credential?.id;
    const credentialPublicKey =
      registrationInfoAny.credentialPublicKey || registrationInfoAny.credential?.publicKey;
    const counter = registrationInfoAny.counter || registrationInfoAny.credential?.counter || 0;

    if (!credentialID || !credentialPublicKey) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Registration response missing credential information',
        },
        500
      );
    }

    // Convert credentialPublicKey (Uint8Array) to base64
    const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64');
    const credentialIDBase64URL = toBase64URLString(credentialID as CredentialIDLike);

    const passkeyId = crypto.randomUUID();
    const now = Date.now();

    // Step 1: Create session using SessionStore Durable Object (FIRST, sharded) via RPC
    // This ensures that if session creation fails, we don't store the passkey
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env);

    let sessionData: { id: string };
    try {
      const createdSession = (await sessionStore.createSessionRpc(
        sessionId,
        userId,
        30 * 24 * 60 * 60, // 30 days in seconds
        {
          amr: ['passkey'],
          acr: 'urn:mace:incommon:iap:bronze',
        }
      )) as Session;
      sessionData = { id: createdSession.id };
    } catch (error) {
      console.error('Failed to create session:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create session',
        },
        500
      );
    }

    // Step 2: Store passkey via Repository
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);

    await authCtx.repositories.passkey.create({
      id: passkeyId,
      user_id: userId,
      credential_id: credentialIDBase64URL,
      public_key: publicKeyBase64,
      counter,
      transports: (credential.response.transports || []) as AuthenticatorTransport[],
      device_name: deviceName || 'Unknown Device',
    });

    // Step 3: Update user's email_verified status via Adapter (direct SQL)
    await authCtx.coreAdapter.execute(
      'UPDATE users_core SET email_verified = 1, updated_at = ? WHERE id = ?',
      [now, userId]
    );

    // Get updated user details via Repository
    const updatedUserCore = await authCtx.repositories.userCore.findById(userId);

    let updatedUserPII: { email: string | null; name: string | null } = {
      email: null,
      name: null,
    };
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiResult = await piiCtx.piiRepositories.userPII.findById(userId);
      if (piiResult) {
        updatedUserPII = {
          email: piiResult.email,
          name: piiResult.name || null,
        };
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
        id: updatedUserCore!.id,
        email: updatedUserPII.email,
        name: updatedUserPII.name,
        email_verified: updatedUserCore!.email_verified,
        created_at: updatedUserCore!.created_at,
        updated_at: updatedUserCore!.updated_at,
        last_login_at: updatedUserCore!.last_login_at,
      },
    });
  } catch (error) {
    console.error('Passkey registration verify error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to verify registration',
      },
      500
    );
  }
}

/**
 * Generate authentication options for Passkey login
 * POST /auth/passkey/login/options
 */
export async function passkeyLoginOptionsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      email?: string;
    }>();

    const { email } = body;

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

    // Reject unauthorized origins
    if (!originHeader || !isAllowedOrigin(originHeader, allowedOrigins)) {
      return c.json(
        {
          error: 'unauthorized_origin',
          error_description: 'Origin not allowed for WebAuthn operations',
        },
        403
      );
    }

    // Use validated origin for RP ID
    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;

    let allowCredentials: Array<{
      id: string;
      type: 'public-key';
      transports?: AuthenticatorTransport[];
    }> = [];

    // If email provided, get user's passkeys via Repository
    // PII/Non-PII DB分離: email検索はPII DBを使用
    if (email && c.env.DB_PII) {
      const tenantId = getTenantIdFromContext(c);
      const authCtx = createAuthContextFromHono(c, tenantId);
      const piiCtx = createPIIContextFromHono(c, tenantId);

      // Search by email in PII DB
      const userPII = await piiCtx.piiRepositories.userPII.findByTenantAndEmail(tenantId, email);

      // Verify user is active in Core DB
      let user: { id: string } | null = null;
      if (userPII) {
        const userCore = await authCtx.repositories.userCore.findById(userPII.id);
        if (userCore && userCore.is_active) {
          user = { id: userCore.id };
        }
      }

      if (user) {
        const userPasskeys = await authCtx.repositories.passkey.findByUserId(user.id);

        allowCredentials = userPasskeys
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
      }
    }

    // Generate authentication options
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      // Always include allowCredentials, even if empty (required by @simplewebauthn/browser v11+)
      allowCredentials: allowCredentials.length > 0 ? (allowCredentials as any) : [],
    } as any);

    // Store challenge in ChallengeStore DO for verification (TTL: 5 minutes) (RPC)
    // Use challengeId-based sharding for discoverable credentials (email may not be provided)
    const challengeId = crypto.randomUUID();
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId);

    await challengeStore.storeChallengeRpc({
      id: `passkey_auth:${challengeId}`,
      type: 'passkey_authentication',
      userId: 'unknown', // Will be determined during verification
      challenge: options.challenge,
      ttl: 300, // 5 minutes
      metadata: { email: email || null },
    });

    return c.json({
      options,
      challengeId,
    });
  } catch (error) {
    console.error('Passkey login options error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to generate authentication options',
      },
      500
    );
  }
}

/**
 * Verify Passkey authentication
 * POST /auth/passkey/login/verify
 */
export async function passkeyLoginVerifyHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      challengeId: string;
      credential: AuthenticationResponseJSON;
    }>();

    const { challengeId, credential } = body;

    if (!challengeId || !credential) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Challenge ID and credential are required',
        },
        400
      );
    }

    // Consume challenge from ChallengeStore DO (atomic operation, RPC)
    // Use challengeId-based sharding - must match the shard used during options generation
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId);

    let challenge: string;
    try {
      const challengeData = (await challengeStore.consumeChallengeRpc({
        id: `passkey_auth:${challengeId}`,
        type: 'passkey_authentication',
      })) as { challenge: string };
      challenge = challengeData.challenge;
    } catch {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Challenge not found or expired',
        },
        400
      );
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
        await authCtx.coreAdapter.execute('UPDATE passkeys SET credential_id = ? WHERE id = ?', [
          credentialIDBase64URL,
          passkey.id,
        ]);
        passkey.credential_id = credentialIDBase64URL;
      }
    }

    if (!passkey) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Passkey not found',
        },
        400
      );
    }

    // Validate Origin header against allowlist
    const originHeader = c.req.header('origin');
    const allowedOriginsEnv = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
    const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);

    // Reject unauthorized origins
    if (!originHeader || !isAllowedOrigin(originHeader, allowedOrigins)) {
      return c.json(
        {
          error: 'unauthorized_origin',
          error_description: 'Origin not allowed for WebAuthn operations',
        },
        403
      );
    }

    // Use validated origin for RP ID and origin
    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;
    const origin = originHeader;

    // Convert stored public key from base64 to Uint8Array
    const normalizedCredentialId = normalizeStoredCredentialId(passkey.credential_id as string);
    if (!normalizedCredentialId) {
      console.error('Stored credential ID could not be normalized for passkey:', passkey.id);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Stored credential is corrupted',
        },
        500
      );
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
      } as any);
    } catch (error) {
      console.error('Authentication verification failed:', error);
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Authentication verification failed',
        },
        400
      );
    }

    const { verified, authenticationInfo } = verification;

    if (!verified) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Authentication could not be verified',
        },
        400
      );
    }

    const now = Date.now();

    // Step 1: Create session using SessionStore Durable Object (FIRST, sharded) via RPC
    // This ensures that if session creation fails, we don't update the database
    const { stub: sessionStore, sessionId } = await getSessionStoreForNewSession(c.env);

    let sessionData: { id: string };
    try {
      const createdSession = (await sessionStore.createSessionRpc(
        sessionId,
        passkey.user_id as string,
        30 * 24 * 60 * 60, // 30 days in seconds
        {
          amr: ['passkey'],
          acr: 'urn:mace:incommon:iap:bronze',
        }
      )) as Session;
      sessionData = { id: createdSession.id };
    } catch (error) {
      console.error('Failed to create session:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create session',
        },
        500
      );
    }

    // Step 2: Update counter and last_used_at via Repository
    await authCtx.repositories.passkey.updateCounterAfterAuth(
      passkey.id,
      authenticationInfo.newCounter
    );

    // Step 3: Update user's last_login_at via Repository
    await authCtx.repositories.userCore.updateLastLogin(passkey.user_id);

    // Get user details via Repository
    const userCore = await authCtx.repositories.userCore.findById(passkey.user_id);

    let userPII: { email: string | null; name: string | null } = {
      email: null,
      name: null,
    };
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      const piiResult = await piiCtx.piiRepositories.userPII.findById(passkey.user_id);
      if (piiResult) {
        userPII = {
          email: piiResult.email,
          name: piiResult.name || null,
        };
      }
    }

    // Note: Challenge is already consumed by ChallengeStore DO (atomic operation)
    // No need to explicitly delete - consumed challenges are auto-cleaned by DO

    return c.json({
      verified: true,
      sessionId: sessionData.id,
      userId: passkey.user_id,
      user: {
        id: userCore!.id,
        email: userPII.email,
        name: userPII.name,
        email_verified: userCore!.email_verified,
        created_at: userCore!.created_at,
        updated_at: userCore!.updated_at,
        last_login_at: userCore!.last_login_at,
      },
    });
  } catch (error) {
    console.error('Passkey login verify error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to verify authentication',
      },
      500
    );
  }
}

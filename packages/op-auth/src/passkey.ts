/**
 * WebAuthn/Passkey Handler
 * Implements Passkey registration and authentication using @simplewebauthn/server
 */

import { Context } from 'hono';
import type { Env } from '@enrai/shared';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

// RP (Relying Party) configuration
const RP_NAME = 'Enrai';

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

    // Get RP ID from ISSUER_URL (e.g., "enrai.sgrastar.workers.dev")
    const issuerUrl = new URL(c.env.ISSUER_URL);
    const rpID = issuerUrl.hostname;
    const origin = c.env.ISSUER_URL;

    // Check if user exists
    let user;
    if (userId) {
      user = await c.env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?')
        .bind(userId)
        .first();
    } else {
      user = await c.env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?')
        .bind(email)
        .first();
    }

    // If user doesn't exist, create a new user
    if (!user) {
      const newUserId = crypto.randomUUID();
      const now = Date.now();

      await c.env.DB.prepare(
        `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      )
        .bind(newUserId, email, name || email.split('@')[0], now, now)
        .run();

      user = { id: newUserId, email, name: name || email.split('@')[0] };
    }

    // Get user's existing passkeys
    const existingPasskeys = await c.env.DB.prepare(
      'SELECT credential_id, transports FROM passkeys WHERE user_id = ?'
    )
      .bind(user.id)
      .all();

    const excludeCredentials = existingPasskeys.results.map((pk: any) => ({
      id: pk.credential_id,
      type: 'public-key' as const,
      transports: pk.transports ? JSON.parse(pk.transports) : undefined,
    }));

    // Generate registration options
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: email,
      userDisplayName: (user.name as string) || email,
      // Use platform authenticator (device-bound) for better security
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      attestationType: 'none',
    } as any);

    // Store challenge in ChallengeStore DO for verification (TTL: 5 minutes)
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    await challengeStore.fetch(
      new Request('https://challenge-store/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `passkey_reg:${user.id}`,
          type: 'passkey_registration',
          userId: user.id as string,
          challenge: options.challenge,
          ttl: 300, // 5 minutes
          email,
        }),
      })
    );

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

    // Consume challenge from ChallengeStore DO (atomic operation)
    // This prevents parallel replay attacks
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    let challenge: string;
    try {
      const consumeResponse = await challengeStore.fetch(
        new Request('https://challenge-store/challenge/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `passkey_reg:${userId}`,
            type: 'passkey_registration',
            // No challenge value needed - DO will return it
          }),
        })
      );

      if (!consumeResponse.ok) {
        const error = (await consumeResponse.json()) as { error_description?: string };
        return c.json(
          {
            error: 'invalid_request',
            error_description: error.error_description || 'Challenge not found or expired',
          },
          400
        );
      }

      const challengeData = (await consumeResponse.json()) as { challenge: string };
      challenge = challengeData.challenge;
    } catch (error) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to consume challenge',
        },
        500
      );
    }

    // Get RP ID from ISSUER_URL
    const issuerUrl = new URL(c.env.ISSUER_URL);
    const rpID = issuerUrl.hostname;
    const origin = c.env.ISSUER_URL;

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

    // Convert credentialPublicKey (Uint8Array) to base64
    const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64');
    const credentialIDBase64 =
      typeof credentialID === 'string'
        ? credentialID
        : Buffer.from(credentialID).toString('base64');

    const passkeyId = crypto.randomUUID();
    const now = Date.now();

    // Step 1: Create session using SessionStore Durable Object (FIRST)
    // This ensures that if session creation fails, we don't store the passkey
    const sessionId = crypto.randomUUID();
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionResponse = await sessionStore.fetch(
      new Request('https://session-store/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: userId,
          ttl: 30 * 24 * 60 * 60, // 30 days in seconds
          data: {
            amr: ['passkey'],
            acr: 'urn:mace:incommon:iap:bronze',
          },
        }),
      })
    );

    if (!sessionResponse.ok) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create session',
        },
        500
      );
    }

    const sessionData = (await sessionResponse.json()) as { id: string };

    // Step 2: Store passkey in D1
    await c.env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_name, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        passkeyId,
        userId,
        credentialIDBase64,
        publicKeyBase64,
        counter,
        JSON.stringify(credential.response.transports || []),
        deviceName || 'Unknown Device',
        now,
        now
      )
      .run();

    // Step 3: Update user's email_verified status
    await c.env.DB.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?')
      .bind(now, userId)
      .run();

    // Note: Challenge is already consumed by ChallengeStore DO (atomic operation)
    // No need to explicitly delete - consumed challenges are auto-cleaned by DO

    return c.json({
      verified: true,
      passkeyId,
      sessionId: sessionData.id,
      message: 'Passkey registered successfully',
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

    // Get RP ID from ISSUER_URL
    const issuerUrl = new URL(c.env.ISSUER_URL);
    const rpID = issuerUrl.hostname;

    let allowCredentials: Array<{
      id: string;
      type: 'public-key';
      transports?: string[];
    }> = [];

    // If email provided, get user's passkeys
    if (email) {
      const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
        .bind(email)
        .first();

      if (user) {
        const userPasskeys = await c.env.DB.prepare(
          'SELECT credential_id, transports FROM passkeys WHERE user_id = ?'
        )
          .bind(user.id)
          .all();

        allowCredentials = userPasskeys.results.map((pk: any) => ({
          id: pk.credential_id,
          type: 'public-key' as const,
          transports: pk.transports ? JSON.parse(pk.transports) : undefined,
        }));
      }
    }

    // Generate authentication options
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
    } as any);

    // Store challenge in ChallengeStore DO for verification (TTL: 5 minutes)
    const challengeId = crypto.randomUUID();
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    await challengeStore.fetch(
      new Request('https://challenge-store/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `passkey_auth:${challengeId}`,
          type: 'passkey_authentication',
          userId: 'unknown', // Will be determined during verification
          challenge: options.challenge,
          ttl: 300, // 5 minutes
          metadata: { email: email || null },
        }),
      })
    );

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

    // Consume challenge from ChallengeStore DO (atomic operation)
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    let challenge: string;
    try {
      const consumeResponse = await challengeStore.fetch(
        new Request('https://challenge-store/challenge/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `passkey_auth:${challengeId}`,
            type: 'passkey_authentication',
          }),
        })
      );

      if (!consumeResponse.ok) {
        const error = (await consumeResponse.json()) as { error_description?: string };
        return c.json(
          {
            error: 'invalid_request',
            error_description: error.error_description || 'Challenge not found or expired',
          },
          400
        );
      }

      const challengeData = (await consumeResponse.json()) as { challenge: string };
      challenge = challengeData.challenge;
    } catch (error) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to consume challenge',
        },
        500
      );
    }

    // Get credential ID from response
    const credentialIDBase64 = credential.id;

    // Look up passkey in database
    const passkey = await c.env.DB.prepare(
      'SELECT id, user_id, credential_id, public_key, counter FROM passkeys WHERE credential_id = ?'
    )
      .bind(credentialIDBase64)
      .first();

    if (!passkey) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Passkey not found',
        },
        400
      );
    }

    // Get RP ID from ISSUER_URL
    const issuerUrl = new URL(c.env.ISSUER_URL);
    const rpID = issuerUrl.hostname;
    const origin = c.env.ISSUER_URL;

    // Convert stored public key from base64 to Uint8Array
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
          id: passkey.credential_id as string,
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

    // Step 1: Create session using SessionStore Durable Object (FIRST)
    // This ensures that if session creation fails, we don't update the database
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionResponse = await sessionStore.fetch(
      new Request('https://session-store/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: passkey.user_id,
          ttl: 30 * 24 * 60 * 60, // 30 days in seconds
          data: {
            amr: ['passkey'],
            acr: 'urn:mace:incommon:iap:bronze',
          },
        }),
      })
    );

    if (!sessionResponse.ok) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create session',
        },
        500
      );
    }

    const sessionData = (await sessionResponse.json()) as { id: string };

    // Step 2: Update counter and last_used_at in database
    await c.env.DB.prepare(
      'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?'
    )
      .bind(authenticationInfo.newCounter, now, credentialIDBase64)
      .run();

    // Step 3: Update user's last_login_at
    await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(now, passkey.user_id)
      .run();

    // Get user details
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(passkey.user_id)
      .first();

    // Note: Challenge is already consumed by ChallengeStore DO (atomic operation)
    // No need to explicitly delete - consumed challenges are auto-cleaned by DO

    return c.json({
      verified: true,
      sessionId: sessionData.id,
      userId: passkey.user_id,
      user: {
        id: user!.id,
        email: user!.email,
        name: user!.name,
        email_verified: user!.email_verified,
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

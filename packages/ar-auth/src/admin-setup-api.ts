/**
 * Admin UI Setup API
 *
 * Provides endpoints for Admin UI passkey registration during initial setup.
 * These endpoints are called by Admin UI after the initial setup on Router.
 *
 * Flow:
 * 1. Initial setup on Router creates admin user + setup token
 * 2. User is redirected to Admin UI /setup/complete?token=xxx
 * 3. Admin UI calls these APIs to verify token and register passkey
 * 4. Passkey is registered with Admin UI's RP ID (domain)
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env } from '@authrim/ar-lib-core';
import {
  generateId,
  createLogger,
  D1Adapter,
  AdminUserRepository,
  AdminPasskeyRepository,
  AdminSessionRepository,
  getAdminCookieSameSite,
} from '@authrim/ar-lib-core';

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';

const logger = createLogger().module('ADMIN_SETUP_API');
const RP_NAME = 'Authrim Admin';

// Helper type for credential ID conversion
type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

/**
 * Convert various credential ID formats to base64url string
 */
function toBase64URLString(input: CredentialIDLike): string {
  if (typeof input === 'string') {
    if (/^[A-Za-z0-9+/]+=*$/.test(input)) {
      return input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return input;
  }

  let bytes: Uint8Array;
  if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Create Hono app for admin setup API routes
export const adminSetupApiApp = new Hono<{ Bindings: Env }>();

/**
 * Verify setup token and return admin user info
 * POST /api/admin/setup-token/verify
 *
 * Request:
 * { token: string }
 *
 * Response:
 * { valid: true, user: { id, email, name } }
 */
adminSetupApiApp.post('/api/admin/setup-token/verify', async (c) => {
  try {
    const body = await c.req.json<{ token: string }>();
    const { token } = body;

    if (!token) {
      return c.json({ error: 'invalid_request', error_description: 'token is required' }, 400);
    }

    if (!c.env.DB_ADMIN) {
      return c.json(
        { error: 'server_error', error_description: 'Admin database not configured' },
        500
      );
    }

    const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });

    // Find the setup token
    const tokenResult = await adminAdapter.queryOne<{
      id: string;
      admin_user_id: string;
      status: string;
      expires_at: number;
    }>('SELECT id, admin_user_id, status, expires_at FROM admin_setup_tokens WHERE id = ?', [
      token,
    ]);

    if (!tokenResult) {
      return c.json({ error: 'invalid_token', error_description: 'Setup token not found' }, 401);
    }

    // Check token status
    if (tokenResult.status !== 'pending') {
      return c.json(
        { error: 'token_used', error_description: 'Setup token has already been used' },
        401
      );
    }

    // Check expiration
    if (tokenResult.expires_at < Date.now()) {
      return c.json({ error: 'token_expired', error_description: 'Setup token has expired' }, 401);
    }

    // Get admin user info
    const adminUserRepo = new AdminUserRepository(adminAdapter);
    const adminUser = await adminUserRepo.findById(tokenResult.admin_user_id);

    if (!adminUser) {
      return c.json({ error: 'user_not_found', error_description: 'Admin user not found' }, 404);
    }

    return c.json({
      valid: true,
      user: {
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name || null,
      },
    });
  } catch (error) {
    logger.error('Setup token verification failed', { action: 'verify_token' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Verification failed' }, 500);
  }
});

/**
 * Get passkey registration options for Admin UI
 * POST /api/admin/setup-token/passkey/options
 *
 * Request:
 * { token: string, rp_id: string }
 *
 * Response:
 * { options: PublicKeyCredentialCreationOptionsJSON, challenge_id: string }
 */
adminSetupApiApp.post('/api/admin/setup-token/passkey/options', async (c) => {
  try {
    const body = await c.req.json<{ token: string; rp_id: string }>();
    const { token, rp_id } = body;

    if (!token || !rp_id) {
      return c.json(
        { error: 'invalid_request', error_description: 'token and rp_id are required' },
        400
      );
    }

    if (!c.env.DB_ADMIN) {
      return c.json(
        { error: 'server_error', error_description: 'Admin database not configured' },
        500
      );
    }

    const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });

    // Verify token (same as above)
    const tokenResult = await adminAdapter.queryOne<{
      id: string;
      admin_user_id: string;
      status: string;
      expires_at: number;
    }>('SELECT id, admin_user_id, status, expires_at FROM admin_setup_tokens WHERE id = ?', [
      token,
    ]);

    if (!tokenResult || tokenResult.status !== 'pending' || tokenResult.expires_at < Date.now()) {
      return c.json({ error: 'invalid_token', error_description: 'Invalid or expired token' }, 401);
    }

    // Get admin user
    const adminUserRepo = new AdminUserRepository(adminAdapter);
    const adminUser = await adminUserRepo.findById(tokenResult.admin_user_id);

    if (!adminUser) {
      return c.json({ error: 'user_not_found', error_description: 'Admin user not found' }, 404);
    }

    // Generate passkey registration options with Admin UI's RP ID
    const encoder = new TextEncoder();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp_id, // Admin UI's domain
      userName: adminUser.email,
      userDisplayName: adminUser.name || adminUser.email,
      // @ts-ignore - TextEncoder.encode() returns compatible Uint8Array
      userID: encoder.encode(adminUser.id),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        // Allow both platform and cross-platform authenticators
      },
      timeout: 60000,
    });

    // Store challenge for verification
    const challengeId = generateId();
    if (c.env.AUTHRIM_CONFIG) {
      await c.env.AUTHRIM_CONFIG.put(
        `admin_setup:challenge:${challengeId}`,
        JSON.stringify({
          challenge: options.challenge,
          rpID: rp_id,
          userId: adminUser.id,
          token,
        }),
        { expirationTtl: 300 } // 5 minutes
      );
    }

    return c.json({
      options,
      challenge_id: challengeId,
    });
  } catch (error) {
    logger.error(
      'Passkey options generation failed',
      { action: 'passkey_options' },
      error as Error
    );
    return c.json({ error: 'server_error', error_description: 'Failed to generate options' }, 500);
  }
});

/**
 * Complete passkey registration for Admin UI
 * POST /api/admin/setup-token/passkey/complete
 *
 * Request:
 * {
 *   token: string,
 *   challenge_id: string,
 *   passkey_response: RegistrationResponseJSON,
 *   origin: string
 * }
 *
 * Response:
 * { success: true, user: { id, email, name } }
 */
adminSetupApiApp.post('/api/admin/setup-token/passkey/complete', async (c) => {
  try {
    const body = await c.req.json<{
      token: string;
      challenge_id: string;
      passkey_response: RegistrationResponseJSON;
      origin: string;
    }>();

    const { token, challenge_id, passkey_response, origin } = body;

    if (!token || !challenge_id || !passkey_response || !origin) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'token, challenge_id, passkey_response, and origin are required',
        },
        400
      );
    }

    if (!c.env.DB_ADMIN || !c.env.AUTHRIM_CONFIG) {
      return c.json(
        { error: 'server_error', error_description: 'Configuration not available' },
        500
      );
    }

    // Get stored challenge
    const challengeData = await c.env.AUTHRIM_CONFIG.get(`admin_setup:challenge:${challenge_id}`);
    if (!challengeData) {
      return c.json(
        { error: 'invalid_request', error_description: 'Challenge expired or not found' },
        400
      );
    }

    const {
      challenge,
      rpID,
      userId,
      token: storedToken,
    } = JSON.parse(challengeData) as {
      challenge: string;
      rpID: string;
      userId: string;
      token: string;
    };

    // Verify token matches
    if (storedToken !== token) {
      return c.json({ error: 'invalid_token', error_description: 'Token mismatch' }, 401);
    }

    const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });

    // Verify token is still valid
    const tokenResult = await adminAdapter.queryOne<{
      id: string;
      admin_user_id: string;
      status: string;
      expires_at: number;
    }>('SELECT id, admin_user_id, status, expires_at FROM admin_setup_tokens WHERE id = ?', [
      token,
    ]);

    if (!tokenResult || tokenResult.status !== 'pending' || tokenResult.expires_at < Date.now()) {
      return c.json({ error: 'invalid_token', error_description: 'Invalid or expired token' }, 401);
    }

    // Verify passkey registration
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: passkey_response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (error) {
      logger.error('Passkey verification failed', { action: 'verify_passkey' }, error as Error);
      await c.env.AUTHRIM_CONFIG.delete(`admin_setup:challenge:${challenge_id}`);
      return c.json(
        { error: 'verification_failed', error_description: 'Passkey verification failed' },
        400
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      await c.env.AUTHRIM_CONFIG.delete(`admin_setup:challenge:${challenge_id}`);
      return c.json(
        { error: 'verification_failed', error_description: 'Passkey was not verified' },
        400
      );
    }

    // Extract credential data (handle both old and new SimpleWebAuthn API)
    const registrationInfoAny = verification.registrationInfo as any;
    const credentialID = registrationInfoAny.credentialID || registrationInfoAny.credential?.id;
    const credentialPublicKey =
      registrationInfoAny.credentialPublicKey || registrationInfoAny.credential?.publicKey;
    const counter = registrationInfoAny.counter || registrationInfoAny.credential?.counter || 0;

    if (!credentialID || !credentialPublicKey) {
      return c.json({ error: 'server_error', error_description: 'Missing credential data' }, 500);
    }

    // Convert to storage format
    const credentialIdB64 = toBase64URLString(credentialID as CredentialIDLike);
    const publicKeyB64 = Buffer.from(credentialPublicKey).toString('base64');

    // Filter transports
    const validTransports = ['usb', 'nfc', 'ble', 'internal', 'hybrid'] as const;
    type AuthenticatorTransport = (typeof validTransports)[number];
    const rawTransports = passkey_response.response.transports || [];
    const transports: AuthenticatorTransport[] = rawTransports.filter(
      (t): t is AuthenticatorTransport => validTransports.includes(t as AuthenticatorTransport)
    );

    // Store the passkey
    const adminPasskeyRepo = new AdminPasskeyRepository(adminAdapter);
    await adminPasskeyRepo.createPasskey({
      admin_user_id: userId,
      credential_id: credentialIdB64,
      public_key: publicKeyB64,
      counter,
      transports,
      device_name: 'Admin UI Setup Passkey',
    });

    // Mark token as used
    const now = Date.now();
    const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null;
    await adminAdapter.execute(
      'UPDATE admin_setup_tokens SET status = ?, used_at = ?, used_ip = ? WHERE id = ?',
      ['used', now, clientIp, token]
    );

    // Mark passkey setup as completed
    await adminAdapter.execute(
      'UPDATE admin_users SET passkey_setup_completed = 1, updated_at = ? WHERE id = ?',
      [now, userId]
    );

    // Clean up challenge
    await c.env.AUTHRIM_CONFIG.delete(`admin_setup:challenge:${challenge_id}`);

    // Get updated user info
    const adminUserRepo = new AdminUserRepository(adminAdapter);
    const adminUser = await adminUserRepo.findById(userId);

    logger.info('Admin UI passkey registration completed', {
      action: 'passkey_registered',
      userId: userId.substring(0, 8) + '...',
    });

    return c.json({
      success: true,
      user: {
        id: adminUser!.id,
        email: adminUser!.email,
        name: adminUser!.name || null,
      },
    });
  } catch (error) {
    logger.error('Passkey registration failed', { action: 'passkey_complete' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Registration failed' }, 500);
  }
});

/**
 * Generate a new setup token (for CLI recovery)
 * POST /api/admin/setup-token/generate
 *
 * This endpoint requires admin authentication or a special recovery key.
 * Used when the initial setup token expires before passkey registration.
 *
 * Request:
 * { admin_user_id: string, recovery_key?: string }
 *
 * Response:
 * { token: string, expires_at: number }
 */
adminSetupApiApp.post('/api/admin/setup-token/generate', async (c) => {
  try {
    const body = await c.req.json<{ admin_user_id: string; recovery_key?: string }>();
    const { admin_user_id, recovery_key } = body;

    if (!admin_user_id) {
      return c.json(
        { error: 'invalid_request', error_description: 'admin_user_id is required' },
        400
      );
    }

    if (!c.env.DB_ADMIN) {
      return c.json(
        { error: 'server_error', error_description: 'Admin database not configured' },
        500
      );
    }

    // Verify recovery key (stored in KV during initial setup)
    if (c.env.AUTHRIM_CONFIG) {
      const storedRecoveryKey = await c.env.AUTHRIM_CONFIG.get('setup:recovery_key');
      if (storedRecoveryKey && recovery_key !== storedRecoveryKey) {
        return c.json({ error: 'unauthorized', error_description: 'Invalid recovery key' }, 401);
      }
      if (!storedRecoveryKey && !recovery_key) {
        // If no recovery key is set, this endpoint is disabled
        return c.json({ error: 'unauthorized', error_description: 'Recovery key required' }, 401);
      }
    }

    const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });

    // Verify admin user exists and hasn't completed passkey setup
    const adminUserRepo = new AdminUserRepository(adminAdapter);
    const adminUser = await adminUserRepo.findById(admin_user_id);

    if (!adminUser) {
      return c.json({ error: 'user_not_found', error_description: 'Admin user not found' }, 404);
    }

    // Check if passkey is already registered
    const adminPasskeyRepo = new AdminPasskeyRepository(adminAdapter);
    const existingPasskeys = await adminPasskeyRepo.getPasskeysByUser(admin_user_id);
    if (existingPasskeys.length > 0) {
      return c.json(
        { error: 'already_setup', error_description: 'Passkey already registered for this user' },
        409
      );
    }

    // Invalidate any existing pending tokens for this user
    await adminAdapter.execute(
      "UPDATE admin_setup_tokens SET status = 'revoked' WHERE admin_user_id = ? AND status = 'pending'",
      [admin_user_id]
    );

    // Generate new token
    const tokenId = generateId();
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

    await adminAdapter.execute(
      `INSERT INTO admin_setup_tokens (id, tenant_id, admin_user_id, status, expires_at, created_at, created_by)
       VALUES (?, 'default', ?, 'pending', ?, ?, 'cli')`,
      [tokenId, admin_user_id, expiresAt, now]
    );

    logger.info('Setup token generated via CLI', {
      action: 'token_generated',
      userId: admin_user_id.substring(0, 8) + '...',
    });

    return c.json({
      token: tokenId,
      expires_at: expiresAt,
      admin_user: {
        id: adminUser.id,
        email: adminUser.email,
      },
    });
  } catch (error) {
    logger.error('Token generation failed', { action: 'generate_token' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Token generation failed' }, 500);
  }
});

// =============================================================================
// Admin Passkey Login Endpoints
// =============================================================================
// These endpoints handle admin authentication using passkeys stored in admin_passkeys.
// Separate from end-user passkey login which uses the passkeys table.
// =============================================================================

/**
 * Get admin passkey login options
 * POST /api/admin/auth/passkey/options
 *
 * Request: {} (empty body, discoverable credentials)
 *
 * Response:
 * { options: PublicKeyCredentialRequestOptionsJSON, challenge_id: string }
 */
adminSetupApiApp.post('/api/admin/auth/passkey/options', async (c) => {
  try {
    // Get RP ID from origin header
    const originHeader = c.req.header('origin');
    if (!originHeader) {
      return c.json({ error: 'invalid_request', error_description: 'Origin header required' }, 400);
    }

    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;

    // Generate authentication options (discoverable credentials - no allowCredentials)
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: [], // Empty for discoverable credentials
    });

    // Add hints for authenticator selection
    options.hints = ['hybrid', 'client-device', 'security-key'];

    // Store challenge for verification
    const challengeId = generateId();
    if (c.env.AUTHRIM_CONFIG) {
      await c.env.AUTHRIM_CONFIG.put(
        `admin_auth:challenge:${challengeId}`,
        JSON.stringify({
          challenge: options.challenge,
          rpID,
          origin: originHeader,
        }),
        { expirationTtl: 300 } // 5 minutes
      );
    }

    return c.json({
      options,
      challengeId,
    });
  } catch (error) {
    logger.error('Admin login options failed', { action: 'admin_login_options' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to generate options' }, 500);
  }
});

/**
 * Verify admin passkey login
 * POST /api/admin/auth/passkey/verify
 *
 * Request:
 * { challengeId: string, credential: AuthenticationResponseJSON }
 *
 * Response:
 * { verified: true, sessionId: string, userId: string, user: { id, email, name } }
 */
adminSetupApiApp.post('/api/admin/auth/passkey/verify', async (c) => {
  try {
    const body = await c.req.json<{
      challengeId: string;
      credential: AuthenticationResponseJSON;
    }>();

    const { challengeId, credential } = body;

    if (!challengeId || !credential) {
      return c.json(
        { error: 'invalid_request', error_description: 'challengeId and credential required' },
        400
      );
    }

    if (!c.env.DB_ADMIN || !c.env.AUTHRIM_CONFIG) {
      return c.json(
        { error: 'server_error', error_description: 'Configuration not available' },
        500
      );
    }

    // Get stored challenge
    const challengeData = await c.env.AUTHRIM_CONFIG.get(`admin_auth:challenge:${challengeId}`);
    if (!challengeData) {
      return c.json({ error: 'invalid_request', error_description: 'Challenge expired' }, 400);
    }

    const { challenge, rpID, origin } = JSON.parse(challengeData) as {
      challenge: string;
      rpID: string;
      origin: string;
    };

    // Find passkey by credential ID
    const credentialIdB64 = toBase64URLString(credential.id);
    const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });
    const adminPasskeyRepo = new AdminPasskeyRepository(adminAdapter);

    const passkey = await adminPasskeyRepo.findByCredentialId(credentialIdB64);

    if (!passkey) {
      await c.env.AUTHRIM_CONFIG.delete(`admin_auth:challenge:${challengeId}`);
      return c.json({ error: 'auth_failed', error_description: 'Passkey not found' }, 401);
    }

    // Get admin user
    const adminUserRepo = new AdminUserRepository(adminAdapter);
    const adminUser = await adminUserRepo.findById(passkey.admin_user_id);

    if (!adminUser) {
      await c.env.AUTHRIM_CONFIG.delete(`admin_auth:challenge:${challengeId}`);
      return c.json({ error: 'auth_failed', error_description: 'Admin user not found' }, 401);
    }

    // Convert stored public key
    const publicKey = Uint8Array.from(Buffer.from(passkey.public_key, 'base64'));

    // Verify authentication response
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credential_id,
          publicKey: publicKey,
          counter: passkey.counter,
        },
      });
    } catch (error) {
      logger.error('Admin passkey verification failed', { action: 'admin_verify' }, error as Error);
      await c.env.AUTHRIM_CONFIG.delete(`admin_auth:challenge:${challengeId}`);
      return c.json(
        { error: 'auth_failed', error_description: 'Passkey verification failed' },
        401
      );
    }

    if (!verification.verified) {
      await c.env.AUTHRIM_CONFIG.delete(`admin_auth:challenge:${challengeId}`);
      return c.json({ error: 'auth_failed', error_description: 'Passkey not verified' }, 401);
    }

    // Update passkey counter
    await adminPasskeyRepo.updateCounter(passkey.id, verification.authenticationInfo.newCounter);

    // Create session in D1 admin_sessions table only
    // Admin sessions use D1 (not SessionStore DO) for simpler management
    const sessionId = generateId();
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days
    const adminSessionRepo = new AdminSessionRepository(adminAdapter);

    try {
      await adminSessionRepo.createSession({
        id: sessionId,
        tenant_id: 'default',
        admin_user_id: adminUser.id,
        ip_address:
          c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
        user_agent: c.req.header('user-agent') || undefined,
        expires_at: expiresAt,
      });
    } catch (error) {
      logger.error('Failed to create admin session', { action: 'session_create' }, error as Error);
      await c.env.AUTHRIM_CONFIG.delete(`admin_auth:challenge:${challengeId}`);
      return c.json({ error: 'server_error', error_description: 'Failed to create session' }, 500);
    }

    // Clean up challenge
    await c.env.AUTHRIM_CONFIG.delete(`admin_auth:challenge:${challengeId}`);

    // Set session cookie using Hono's setCookie helper
    // Cookie name must match admin-auth middleware expectation: authrim_admin_session
    setCookie(c, 'authrim_admin_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: getAdminCookieSameSite(c.env),
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    logger.info('Admin login successful', {
      action: 'admin_login_success',
      userId: adminUser.id.substring(0, 8) + '...',
    });

    return c.json({
      verified: true,
      sessionId,
      userId: adminUser.id,
      user: {
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name || null,
        email_verified: adminUser.email_verified,
      },
    });
  } catch (error) {
    logger.error('Admin login verify failed', { action: 'admin_login_verify' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Login verification failed' }, 500);
  }
});

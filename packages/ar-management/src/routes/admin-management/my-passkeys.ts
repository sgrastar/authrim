/**
 * My PassKey Management API
 *
 * Endpoints for managing the current admin user's own PassKeys.
 * Each admin can only manage their own PassKeys (not other users').
 *
 * Endpoints:
 * - GET    /api/admin/me/passkeys           - List own PassKeys
 * - POST   /api/admin/me/passkeys/options   - Get registration options (WebAuthn challenge)
 * - POST   /api/admin/me/passkeys/complete  - Complete PassKey registration
 * - PATCH  /api/admin/me/passkeys/:id       - Update device name
 * - DELETE /api/admin/me/passkeys/:id       - Delete a PassKey
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  AdminPasskeyRepository,
  AdminAuditLogRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  generateId,
} from '@authrim/ar-lib-core';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';

// Context type with adminAuth variable
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

// Create router
export const myPasskeysRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Apply admin authentication to all routes (no special permissions required - only managing own passkeys)
myPasskeysRouter.use('*', adminAuthMiddleware({}));

const RP_NAME = 'Authrim Admin';

// Valid WebAuthn transports
const VALID_TRANSPORTS = ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'];

// Helper type for credential ID conversion
type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

/**
 * Convert various credential ID formats to base64url string
 */
function toBase64URLString(input: CredentialIDLike): string {
  if (typeof input === 'string') {
    // Check if it's already base64
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
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Helper to get DB_ADMIN adapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAdminAdapter(c: Context<any, any, any>) {
  if (!c.env.DB_ADMIN) {
    throw new Error('DB_ADMIN is not configured');
  }
  return new D1Adapter({ db: c.env.DB_ADMIN });
}

/**
 * Create audit log entry for passkey operations
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createAuditLog(
  c: Context<any, any, any>,
  action: string,
  resourceId: string,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): Promise<void> {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const adapter = getAdminAdapter(c);
  const auditRepo = new AdminAuditLogRepository(adapter);
  const tenantId = getTenantIdFromContext(c);

  await auditRepo.createAuditLog({
    tenant_id: tenantId,
    admin_user_id: authContext.userId,
    admin_email: authContext.email,
    action,
    resource_type: 'admin_passkey',
    resource_id: resourceId,
    result,
    ip_address: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
    user_agent: c.req.header('user-agent') || undefined,
    metadata,
  });
}

/**
 * Sanitize passkey for response (remove sensitive fields)
 */
function sanitizePasskey(passkey: {
  id: string;
  device_name: string | null;
  created_at: number;
  last_used_at: number | null;
}) {
  return {
    id: passkey.id,
    device_name: passkey.device_name,
    created_at: passkey.created_at,
    last_used_at: passkey.last_used_at,
  };
}

/**
 * GET /api/admin/me/passkeys
 * List own PassKeys
 */
myPasskeysRouter.get('/', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  try {
    const adapter = getAdminAdapter(c);
    const passkeyRepo = new AdminPasskeyRepository(adapter);

    const passkeys = await passkeyRepo.getPasskeysByUser(authContext.userId);

    return c.json({
      passkeys: passkeys.map(sanitizePasskey),
      total: passkeys.length,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/passkeys/options
 * Get registration options (WebAuthn challenge)
 */
myPasskeysRouter.post('/options', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  try {
    const body = await c.req.json<{
      rp_id: string;
      device_name?: string;
    }>();

    if (!body.rp_id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const adapter = getAdminAdapter(c);
    const passkeyRepo = new AdminPasskeyRepository(adapter);

    // Get existing passkeys to exclude from registration
    const existingPasskeys = await passkeyRepo.getPasskeysByUser(authContext.userId);
    const excludeCredentials = existingPasskeys.map((pk) => ({
      id: pk.credential_id,
      type: 'public-key' as const,
      transports: pk.transports as AuthenticatorTransportFuture[] | undefined,
    }));

    // Generate passkey registration options
    const encoder = new TextEncoder();
    const userName = authContext.email || authContext.userId;
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: body.rp_id,
      userName,
      userDisplayName: userName,
      // @ts-ignore - TextEncoder.encode() returns compatible Uint8Array
      userID: encoder.encode(authContext.userId),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      timeout: 60000,
      excludeCredentials,
    });

    // Store challenge for verification
    const challengeId = generateId();
    if (c.env.AUTHRIM_CONFIG) {
      await c.env.AUTHRIM_CONFIG.put(
        `admin_passkey:challenge:${challengeId}`,
        JSON.stringify({
          challenge: options.challenge,
          rpID: body.rp_id,
          userId: authContext.userId,
          deviceName: body.device_name || null,
        }),
        { expirationTtl: 300 } // 5 minutes
      );
    }

    return c.json({
      options,
      challenge_id: challengeId,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/me/passkeys/complete
 * Complete PassKey registration
 */
myPasskeysRouter.post('/complete', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  try {
    const body = await c.req.json<{
      challenge_id: string;
      passkey_response: RegistrationResponseJSON;
      origin: string;
      device_name?: string;
    }>();

    if (!body.challenge_id || !body.passkey_response || !body.origin) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Retrieve stored challenge
    const storedChallengeJson = await c.env.AUTHRIM_CONFIG?.get(
      `admin_passkey:challenge:${body.challenge_id}`
    );

    if (!storedChallengeJson) {
      return c.json(
        { error: 'invalid_challenge', error_description: 'Challenge not found or expired' },
        400
      );
    }

    const storedChallenge = JSON.parse(storedChallengeJson) as {
      challenge: string;
      rpID: string;
      userId: string;
      deviceName: string | null;
    };

    // Verify user ID matches
    if (storedChallenge.userId !== authContext.userId) {
      await c.env.AUTHRIM_CONFIG?.delete(`admin_passkey:challenge:${body.challenge_id}`);
      return c.json({ error: 'invalid_challenge', error_description: 'User mismatch' }, 401);
    }

    // Verify passkey registration
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.passkey_response,
        expectedChallenge: storedChallenge.challenge,
        expectedOrigin: body.origin,
        expectedRPID: storedChallenge.rpID,
        requireUserVerification: false,
      });
    } catch (error) {
      await c.env.AUTHRIM_CONFIG?.delete(`admin_passkey:challenge:${body.challenge_id}`);
      return c.json(
        { error: 'verification_failed', error_description: 'Passkey verification failed' },
        400
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      await c.env.AUTHRIM_CONFIG?.delete(`admin_passkey:challenge:${body.challenge_id}`);
      return c.json(
        { error: 'verification_failed', error_description: 'Passkey was not verified' },
        400
      );
    }

    // Extract credential data (handle both old and new SimpleWebAuthn API)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registrationInfoAny = verification.registrationInfo as any;
    const credentialID = registrationInfoAny.credentialID || registrationInfoAny.credential?.id;
    const credentialPublicKey =
      registrationInfoAny.credentialPublicKey || registrationInfoAny.credential?.publicKey;
    const counter = registrationInfoAny.counter || registrationInfoAny.credential?.counter || 0;

    if (!credentialID || !credentialPublicKey) {
      await c.env.AUTHRIM_CONFIG?.delete(`admin_passkey:challenge:${body.challenge_id}`);
      return c.json(
        { error: 'verification_failed', error_description: 'Invalid credential data' },
        400
      );
    }

    // Convert credential ID and public key to base64url
    const credentialIdB64 = toBase64URLString(credentialID);
    const publicKeyB64 = Buffer.from(credentialPublicKey).toString('base64');

    const adapter = getAdminAdapter(c);
    const passkeyRepo = new AdminPasskeyRepository(adapter);

    // Check if credential already exists
    const existingCredential = await passkeyRepo.credentialExists(credentialIdB64);
    if (existingCredential) {
      await c.env.AUTHRIM_CONFIG?.delete(`admin_passkey:challenge:${body.challenge_id}`);
      return c.json(
        { error: 'credential_exists', error_description: 'This passkey is already registered' },
        409
      );
    }

    // Get transports from response
    const transports = (body.passkey_response.response.transports || []).filter((t: string) =>
      VALID_TRANSPORTS.includes(t)
    );

    // Use device name from completion request, fallback to options request, or generate default
    const deviceName = body.device_name || storedChallenge.deviceName || `Passkey ${Date.now()}`;

    // Create passkey
    const passkey = await passkeyRepo.createPasskey({
      admin_user_id: authContext.userId,
      credential_id: credentialIdB64,
      public_key: publicKeyB64,
      counter,
      transports,
      device_name: deviceName,
      attestation_type: verification.registrationInfo.attestationObject ? 'direct' : 'none',
      aaguid: registrationInfoAny.aaguid || null,
    });

    // Clean up challenge
    await c.env.AUTHRIM_CONFIG?.delete(`admin_passkey:challenge:${body.challenge_id}`);

    // Create audit log
    await createAuditLog(c, 'passkey.created', passkey.id, 'success', {
      device_name: deviceName,
    });

    return c.json(
      {
        success: true,
        passkey: sanitizePasskey(passkey),
      },
      201
    );
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /api/admin/me/passkeys/:id
 * Update device name
 */
myPasskeysRouter.patch('/:id', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const passkeyId = c.req.param('id');

  try {
    const body = await c.req.json<{
      device_name: string;
    }>();

    if (!body.device_name || typeof body.device_name !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Validate device name length
    if (body.device_name.length > 100) {
      return c.json(
        { error: 'invalid_request', error_description: 'Device name too long (max 100 chars)' },
        400
      );
    }

    const adapter = getAdminAdapter(c);
    const passkeyRepo = new AdminPasskeyRepository(adapter);

    // Get the passkey
    const passkey = await passkeyRepo.getPasskey(passkeyId);
    if (!passkey) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Verify ownership
    if (passkey.admin_user_id !== authContext.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    // Update device name
    await passkeyRepo.updateDeviceName(passkeyId, body.device_name);

    // Create audit log
    await createAuditLog(c, 'passkey.updated', passkeyId, 'success', {
      old_device_name: passkey.device_name,
      new_device_name: body.device_name,
    });

    return c.json({
      success: true,
      passkey: sanitizePasskey({
        id: passkey.id,
        device_name: body.device_name,
        created_at: passkey.created_at,
        last_used_at: passkey.last_used_at,
      }),
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/me/passkeys/:id
 * Delete a PassKey
 */
myPasskeysRouter.delete('/:id', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const passkeyId = c.req.param('id');

  try {
    const adapter = getAdminAdapter(c);
    const passkeyRepo = new AdminPasskeyRepository(adapter);

    // Get the passkey
    const passkey = await passkeyRepo.getPasskey(passkeyId);
    if (!passkey) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Verify ownership
    if (passkey.admin_user_id !== authContext.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    // Check if this is the last passkey (prevent lockout)
    const passkeyCount = await passkeyRepo.countByUser(authContext.userId);
    if (passkeyCount <= 1) {
      return c.json(
        {
          error: 'last_passkey',
          error_description:
            'Cannot delete the last passkey. You need at least one passkey to sign in.',
        },
        400
      );
    }

    // Delete passkey
    await passkeyRepo.deletePasskey(passkeyId);

    // Create audit log
    await createAuditLog(c, 'passkey.deleted', passkeyId, 'success', {
      device_name: passkey.device_name,
    });

    return c.json({
      success: true,
      message: 'Passkey deleted successfully',
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export default myPasskeysRouter;

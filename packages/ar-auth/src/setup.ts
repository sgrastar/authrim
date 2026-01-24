/**
 * Initial Admin Setup Handler
 *
 * Provides endpoints and UI for setting up the first system administrator.
 * This feature is permanently disabled after the first admin is created.
 *
 * Flow:
 * 1. Deploy script generates setup token and stores in KV (1 hour TTL)
 * 2. Admin opens /admin-init-setup?token=xxx in browser
 * 3. Admin enters email, registers Passkey
 * 4. System creates user with system_admin role
 * 5. Setup is permanently disabled (setup:completed flag set)
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  // Setup utilities
  isSetupDisabled,
  validateSetupToken,
  completeSetup,
  createSetupSession,
  validateSetupSession,
  deleteSetupSession,
  isSystemInitialized,
  assignSystemAdminRole,
  // Helpers
  generateId,
  createAuthContextFromHono,
  createPIIContextFromHono,
  getTenantIdFromContext,
  parseAllowedOrigins,
  isAllowedOrigin,
  // Logger
  createLogger,
  // Admin repositories (for DB_ADMIN)
  AdminUserRepository,
  AdminPasskeyRepository,
  // Database adapter
  D1Adapter,
} from '@authrim/ar-lib-core';

import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/server';

// RP (Relying Party) configuration
const RP_NAME = 'Authrim';

// Helper type for credential ID conversion
type CredentialIDLike = string | ArrayBuffer | ArrayBufferView;

/**
 * Convert various credential ID formats to base64url string
 * Handles legacy base64-encoded values saved in D1 as well as ArrayBuffer inputs.
 */
function toBase64URLString(input: CredentialIDLike): string {
  if (typeof input === 'string') {
    // Already a string, check if it needs conversion
    if (/^[A-Za-z0-9+/]+=*$/.test(input)) {
      // Standard base64 -> base64url
      return input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return input;
  }

  // Handle ArrayBuffer or TypedArray
  let bytes: Uint8Array;
  if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  // Convert to base64url using btoa (available in Workers)
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Get allowed origins from KV (priority) or environment variables
 * Priority: KV > env > ISSUER_URL
 */
async function getAllowedOriginsFromKV(env: Env): Promise<string[]> {
  let allowedOriginsValue: string | undefined;

  // Try to read from KV first
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvData = await env.AUTHRIM_CONFIG.get('settings:tenant:default:tenant');
      if (kvData) {
        const settings = JSON.parse(kvData) as Record<string, unknown>;
        if (typeof settings['tenant.allowed_origins'] === 'string') {
          allowedOriginsValue = settings['tenant.allowed_origins'];
        }
      }
    } catch {
      // Ignore KV read errors, fall back to env
    }
  }

  // Fall back to environment variables
  const allowedOriginsEnv = allowedOriginsValue || env.ALLOWED_ORIGINS || env.ISSUER_URL;
  return parseAllowedOrigins(allowedOriginsEnv);
}

// Setup session header name
const SETUP_SESSION_HEADER = 'X-Setup-Session';
const CSRF_TOKEN_HEADER = 'X-CSRF-Token';

// Security constants
const MAX_EMAIL_LENGTH = 254; // RFC 5321
const MAX_NAME_LENGTH = 200;
const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_SECONDS = 3600; // 1 hour
const SETUP_LOCK_TTL_SECONDS = 60;

// Module-level logger for setup functions
const moduleLogger = createLogger().module('SETUP');

// Create Hono app for setup routes
export const setupApp = new Hono<{ Bindings: Env }>();

/**
 * Generate a cryptographically secure random string
 */
function generateSecureToken(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Rate limiting middleware for setup endpoints
 * Limits requests per IP to prevent brute force attacks
 */
async function rateLimitMiddleware(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  if (!c.env.AUTHRIM_CONFIG) {
    return next();
  }

  // Get client IP from Cloudflare header
  const clientIP = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const rateLimitKey = `ratelimit:setup:${clientIP}`;

  try {
    const countStr = await c.env.AUTHRIM_CONFIG.get(rateLimitKey);
    // Protect against integer overflow - cap at max + 1
    const count = countStr ? Math.min(parseInt(countStr, 10) || 0, RATE_LIMIT_MAX_REQUESTS + 1) : 0;

    if (count >= RATE_LIMIT_MAX_REQUESTS) {
      return c.json(
        {
          error: 'too_many_requests',
          error_description: 'Too many setup attempts. Please try again later.',
        },
        429
      );
    }

    // Increment counter BEFORE processing to prevent bypass via errors
    // Only increment on actual attempts (not status checks)
    if (c.req.path !== '/api/admin-init-setup/status') {
      const newCount = (count + 1).toString();
      await c.env.AUTHRIM_CONFIG.put(rateLimitKey, newCount, {
        expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
      });
    }

    // Process the request
    await next();
  } catch {
    // Don't block on rate limit errors, continue with request
    return next();
  }
}

/**
 * Middleware to check if setup is disabled
 * Returns 403 if setup has already been completed
 */
async function checkSetupEnabled(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  if (await isSetupDisabled(c.env)) {
    return c.json(
      {
        error: 'setup_completed',
        error_description: 'Initial setup has already been completed',
      },
      403
    );
  }
  return next();
}

/**
 * Validate email address with stricter rules
 */
function validateEmail(email: string): { valid: boolean; error?: string } {
  // Check length
  if (email.length > MAX_EMAIL_LENGTH) {
    return { valid: false, error: 'Email address is too long' };
  }

  // Check for dangerous characters (potential injection, XSS, log injection)
  // Includes: < > " ' ` \ and null character
  const dangerousChars = /[<>"'`\\\x00]/;
  if (dangerousChars.test(email)) {
    return { valid: false, error: 'Email contains invalid characters' };
  }

  // More strict email regex (RFC 5322 subset)
  const emailRegex =
    /^[a-zA-Z0-9.!#$%&*+/=?^_{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Invalid email format' };
  }

  // Check local part length (before @)
  const localPart = email.split('@')[0];
  if (localPart.length > 64) {
    return { valid: false, error: 'Email local part is too long' };
  }

  return { valid: true };
}

/**
 * Random delay to reduce lock contention
 * @param min - Minimum delay in ms
 * @param max - Maximum delay in ms
 */
async function randomDelay(min: number, max: number): Promise<void> {
  const delay = min + Math.random() * (max - min);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Acquire a distributed lock using KV
 * Returns true if lock acquired, false otherwise
 *
 * NOTE: Cloudflare KV is eventually consistent, so this lock is "best effort".
 * It significantly reduces race conditions but cannot 100% prevent them.
 * For the setup flow, this is acceptable since:
 * 1. Setup is a one-time operation
 * 2. We have additional guards (system_initialized check inside lock)
 * 3. Worst case is a user creation + rollback
 */
async function acquireSetupLock(env: Env): Promise<boolean> {
  if (!env.AUTHRIM_CONFIG) {
    return true; // No KV, proceed without lock
  }

  const lockKey = 'setup:lock';
  const lockValue = `${Date.now()}-${generateSecureToken(16)}`;

  try {
    // Add random jitter to reduce thundering herd
    await randomDelay(10, 100);

    // First check: Is lock already held?
    const existingLock = await env.AUTHRIM_CONFIG.get(lockKey);
    if (existingLock) {
      return false; // Lock already held
    }

    // Small delay to let any in-flight writes propagate
    await randomDelay(20, 50);

    // Second check: Re-verify lock is still free
    const existingLockRecheck = await env.AUTHRIM_CONFIG.get(lockKey);
    if (existingLockRecheck) {
      return false; // Lock was acquired by another request
    }

    // Try to acquire lock
    await env.AUTHRIM_CONFIG.put(lockKey, lockValue, {
      expirationTtl: SETUP_LOCK_TTL_SECONDS,
    });

    // Verification delay: Wait for KV propagation
    await randomDelay(50, 100);

    // Verify we got the lock
    const verifyLock = await env.AUTHRIM_CONFIG.get(lockKey);
    if (verifyLock !== lockValue) {
      // Someone else won the race - clean up our attempt if possible
      return false;
    }

    // Double verification: Read again to be more confident
    await randomDelay(20, 50);
    const finalVerify = await env.AUTHRIM_CONFIG.get(lockKey);
    return finalVerify === lockValue;
  } catch {
    return false;
  }
}

/**
 * Release the setup lock
 */
async function releaseSetupLock(env: Env): Promise<void> {
  if (env.AUTHRIM_CONFIG) {
    try {
      await env.AUTHRIM_CONFIG.delete('setup:lock');
    } catch {
      // Ignore errors on lock release
    }
  }
}

/**
 * Rollback user creation on Passkey registration failure
 * Deletes the Admin user from DB_ADMIN (or legacy DB if DB_ADMIN unavailable)
 */
async function rollbackUserCreation(
  c: Context<{ Bindings: Env }>,
  userId: string,
  tenantId: string
): Promise<void> {
  try {
    // Use DB_ADMIN when available (new architecture)
    if (c.env.DB_ADMIN) {
      const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });
      const adminUserRepo = new AdminUserRepository(adminAdapter);
      const adminPasskeyRepo = new AdminPasskeyRepository(adminAdapter);

      // Delete any passkeys first (foreign key constraint)
      await adminPasskeyRepo.deleteAllByUser(userId);

      // Delete from admin_users
      await adminAdapter.execute('DELETE FROM admin_users WHERE id = ?', [userId]);

      moduleLogger.info('Admin user rollback completed', {
        action: 'rollback_completed',
        userId: userId.substring(0, 8) + '...',
        database: 'DB_ADMIN',
      });
      return;
    }

    // Fallback to legacy DB
    const authCtx = createAuthContextFromHono(c, tenantId);

    // Delete from users_core
    await authCtx.repositories.userCore.delete(userId);

    // Delete from users_pii if PII DB is available
    if (c.env.DB_PII) {
      const piiCtx = createPIIContextFromHono(c, tenantId);
      await piiCtx.piiRepositories.userPII.delete(userId);
    }

    moduleLogger.info('User rollback completed (legacy)', {
      action: 'rollback_completed',
      userId: userId.substring(0, 8) + '...',
      database: 'DB_CORE',
    });
  } catch (error) {
    // Log but don't throw - rollback failure shouldn't block error response
    moduleLogger.error('User rollback failed', { action: 'rollback_failed' }, error as Error);
  }
}

// Apply setup check and rate limiting to all API endpoints
setupApp.use('/api/admin-init-setup/*', rateLimitMiddleware);
setupApp.use('/api/admin-init-setup/*', checkSetupEnabled);

/**
 * GET /api/admin-init-setup/status
 *
 * Returns the current setup status.
 * - initialized: true if system_admin exists
 * - setup_token_valid: true if a valid setup token exists
 */
setupApp.get('/api/admin-init-setup/status', async (c) => {
  const initialized = await isSystemInitialized(c.env);
  const disabled = await isSetupDisabled(c.env);

  // Check if a setup token exists (without validating a specific token)
  let setupTokenValid = false;
  if (!disabled && c.env.AUTHRIM_CONFIG) {
    const storedToken = await c.env.AUTHRIM_CONFIG.get('setup:token');
    setupTokenValid = !!storedToken;
  }

  return c.json({
    initialized,
    setup_disabled: disabled,
    setup_token_valid: setupTokenValid,
  });
});

/**
 * POST /api/admin-init-setup/initialize
 *
 * Creates the initial admin user and returns Passkey registration options.
 *
 * Request:
 * {
 *   setup_token: string,
 *   email: string,
 *   name?: string
 * }
 *
 * Response:
 * {
 *   success: true,
 *   user_id: string,
 *   temp_session_token: string,
 *   passkey_options: PublicKeyCredentialCreationOptionsJSON
 * }
 */
setupApp.post('/api/admin-init-setup/initialize', async (c) => {
  let lockAcquired = false;

  try {
    const body = await c.req.json<{
      setup_token: string;
      email: string;
      name?: string;
      csrf_token?: string;
    }>();

    const { setup_token, email, name, csrf_token } = body;

    // Validate required fields
    if (!setup_token) {
      return c.json(
        { error: 'invalid_request', error_description: 'setup_token is required' },
        400
      );
    }
    if (!email) {
      return c.json({ error: 'invalid_request', error_description: 'email is required' }, 400);
    }

    // Validate CSRF token (required for security)
    // CSRF token is generated when the setup form is served
    if (!csrf_token) {
      return c.json({ error: 'invalid_csrf', error_description: 'CSRF token is required' }, 403);
    }

    if (c.env.AUTHRIM_CONFIG) {
      const storedCsrf = await c.env.AUTHRIM_CONFIG.get(`csrf:${csrf_token}`);
      if (!storedCsrf) {
        return c.json(
          { error: 'invalid_csrf', error_description: 'Invalid or expired CSRF token' },
          403
        );
      }
      // Note: CSRF token is deleted in /complete endpoint after successful Passkey registration
      // This allows retry if Passkey registration fails
    }

    // Validate email format with stricter rules
    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return c.json(
        { error: 'invalid_request', error_description: emailValidation.error || 'Invalid email' },
        400
      );
    }

    // Validate name length if provided
    if (name && name.length > MAX_NAME_LENGTH) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Name is too long (max ${MAX_NAME_LENGTH} characters)`,
        },
        400
      );
    }

    // Acquire distributed lock to prevent race conditions
    lockAcquired = await acquireSetupLock(c.env);
    if (!lockAcquired) {
      return c.json(
        {
          error: 'setup_in_progress',
          error_description: 'Another setup is currently in progress. Please try again.',
        },
        409
      );
    }

    // Check if system is already initialized (inside lock)
    if (await isSystemInitialized(c.env)) {
      await releaseSetupLock(c.env);
      return c.json(
        { error: 'already_initialized', error_description: 'System already has an administrator' },
        409
      );
    }

    // Validate setup token
    const tokenValidation = await validateSetupToken(c.env, setup_token);
    if (!tokenValidation.valid) {
      await releaseSetupLock(c.env);
      const messages: Record<string, string> = {
        no_token: 'No valid setup token found. Please generate a new token.',
        invalid_token: 'Invalid setup token',
        setup_completed: 'Setup has already been completed',
      };
      return c.json(
        {
          error: 'invalid_token',
          error_description: messages[tokenValidation.reason || 'invalid_token'],
        },
        401
      );
    }

    // Validate Origin header for WebAuthn
    const originHeader = c.req.header('origin');
    const allowedOrigins = await getAllowedOriginsFromKV(c.env);

    if (!originHeader || !isAllowedOrigin(originHeader, allowedOrigins)) {
      await releaseSetupLock(c.env);
      return c.json(
        {
          error: 'invalid_origin',
          error_description: 'Origin not allowed for WebAuthn operations',
        },
        403
      );
    }

    const originUrl = new URL(originHeader);
    const rpID = originUrl.hostname;

    // Create user in database
    const tenantId = getTenantIdFromContext(c);
    const userId = generateId();

    // Use DB_ADMIN when available (new Admin/EndUser separation architecture)
    if (c.env.DB_ADMIN) {
      const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });
      const adminUserRepo = new AdminUserRepository(adminAdapter);

      // Create Admin user in admin_users (no PII separation needed for Admin)
      await adminUserRepo.createAdminUser({
        id: userId,
        tenant_id: tenantId,
        email: email.toLowerCase(),
        name: name || undefined,
        // email_verified is set to true during setup
        // MFA can be configured later
      });

      // Set email as verified for initial admin
      await adminUserRepo.setEmailVerified(userId);
    } else {
      // Fallback to legacy DB (users_core + users_pii)
      const authCtx = createAuthContextFromHono(c, tenantId);

      // Create user in users_core (non-PII)
      // Note: user_type is 'end_user' | 'admin' | 'm2m' - admin for initial setup
      await authCtx.repositories.userCore.createUser({
        id: userId,
        tenant_id: tenantId,
        email_verified: true, // Admin email is trusted
        user_type: 'admin',
        pii_partition: 'default',
        pii_status: 'pending',
      });

      // Create user in users_pii if PII DB is available
      if (c.env.DB_PII) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        const preferredUsername = email.split('@')[0];
        await piiCtx.piiRepositories.userPII.createPII({
          id: userId,
          tenant_id: tenantId,
          email: email.toLowerCase(),
          name: name || null,
          preferred_username: preferredUsername,
        });
      }
    }

    // Generate Passkey registration options
    const encoder = new TextEncoder();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: email,
      userDisplayName: name || email,
      // @ts-ignore - TextEncoder.encode() returns compatible Uint8Array
      userID: encoder.encode(userId),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        // Note: authenticatorAttachment is intentionally omitted to allow
        // both platform (Touch ID, etc.) and cross-platform (1Password, etc.) authenticators
      },
      timeout: 60000,
    });

    // Store challenge in setup session
    const tempSessionToken = await createSetupSession(c.env, {
      userId,
      email,
      name,
    });

    // Store the challenge for verification
    if (c.env.AUTHRIM_CONFIG) {
      await c.env.AUTHRIM_CONFIG.put(
        `setup:challenge:${tempSessionToken}`,
        JSON.stringify({
          challenge: options.challenge,
          rpID,
          origin: originHeader,
          userId,
          csrfToken: csrf_token, // Store for cleanup in /complete
        }),
        { expirationTtl: 300 } // 5 minutes
      );
    }

    // Release lock - user creation successful, now waiting for Passkey registration
    await releaseSetupLock(c.env);
    lockAcquired = false;

    return c.json({
      success: true,
      user_id: userId,
      temp_session_token: tempSessionToken,
      passkey_options: options,
    });
  } catch (error) {
    // Release lock on error
    if (lockAcquired) {
      await releaseSetupLock(c.env);
    }

    // Sanitized error logging - don't log full error object
    moduleLogger.error('Setup initialization failed', { action: 'initialize' }, error as Error);

    return c.json(
      {
        error: 'server_error',
        error_description: 'An error occurred during setup initialization',
      },
      500
    );
  }
});

/**
 * POST /api/admin-init-setup/complete
 *
 * Completes the setup by verifying Passkey registration and assigning system_admin role.
 *
 * Headers:
 *   X-Setup-Session: <temp_session_token>
 *
 * Request:
 * {
 *   passkey_response: RegistrationResponseJSON
 * }
 *
 * Response:
 * {
 *   success: true,
 *   user: { id, email, role },
 *   redirect_url: string
 * }
 */
setupApp.post('/api/admin-init-setup/complete', async (c) => {
  try {
    const tempSessionToken = c.req.header(SETUP_SESSION_HEADER);
    if (!tempSessionToken) {
      return c.json(
        { error: 'invalid_request', error_description: 'X-Setup-Session header is required' },
        400
      );
    }

    // Validate setup session
    const sessionValidation = await validateSetupSession(c.env, tempSessionToken);
    if (!sessionValidation.valid || !sessionValidation.data) {
      return c.json(
        {
          error: 'invalid_session',
          error_description: 'Setup session is invalid or expired',
        },
        401
      );
    }

    const { userId, email, name } = sessionValidation.data;

    // Get tenant ID early for potential rollback
    const tenantId = getTenantIdFromContext(c);

    const body = await c.req.json<{
      passkey_response: RegistrationResponseJSON;
    }>();

    const { passkey_response } = body;
    if (!passkey_response) {
      return c.json(
        { error: 'invalid_request', error_description: 'passkey_response is required' },
        400
      );
    }

    // Get stored challenge
    if (!c.env.AUTHRIM_CONFIG) {
      return c.json(
        { error: 'server_error', error_description: 'Configuration not available' },
        500
      );
    }

    const challengeData = await c.env.AUTHRIM_CONFIG.get(`setup:challenge:${tempSessionToken}`);
    if (!challengeData) {
      return c.json(
        { error: 'invalid_request', error_description: 'Challenge expired or not found' },
        400
      );
    }

    const { challenge, rpID, origin, csrfToken } = JSON.parse(challengeData) as {
      challenge: string;
      rpID: string;
      origin: string;
      userId: string;
      csrfToken?: string;
    };

    // Verify Passkey registration
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
      // Sanitized error logging
      moduleLogger.error(
        'Passkey verification failed',
        { action: 'verify_passkey' },
        error as Error
      );

      // Clean up challenge on error
      if (c.env.AUTHRIM_CONFIG) {
        await c.env.AUTHRIM_CONFIG.delete(`setup:challenge:${tempSessionToken}`);
      }

      // Rollback user creation to prevent zombie users
      await rollbackUserCreation(c, userId, tenantId);

      return c.json(
        {
          error: 'verification_failed',
          error_description: 'Passkey registration verification failed',
        },
        400
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      // Clean up challenge on verification failure
      if (c.env.AUTHRIM_CONFIG) {
        await c.env.AUTHRIM_CONFIG.delete(`setup:challenge:${tempSessionToken}`);
      }

      // Rollback user creation to prevent zombie users
      await rollbackUserCreation(c, userId, tenantId);

      return c.json(
        {
          error: 'verification_failed',
          error_description: 'Passkey registration was not verified',
        },
        400
      );
    }

    // Handle both old and new SimpleWebAuthn API shapes
    const registrationInfoAny = verification.registrationInfo as any;
    const credentialID = registrationInfoAny.credentialID || registrationInfoAny.credential?.id;
    const credentialPublicKey =
      registrationInfoAny.credentialPublicKey || registrationInfoAny.credential?.publicKey;
    const counter = registrationInfoAny.counter || registrationInfoAny.credential?.counter || 0;

    if (!credentialID || !credentialPublicKey) {
      // Rollback user creation to prevent zombie users
      await rollbackUserCreation(c, userId, tenantId);

      return c.json({ error: 'server_error', error_description: 'Missing credential data' }, 500);
    }

    // Convert to storage format (base64url for ID, base64 for public key)
    const credentialId = toBase64URLString(credentialID as CredentialIDLike);
    const publicKey = Buffer.from(credentialPublicKey).toString('base64');

    // Filter transports to only valid AuthenticatorTransport values
    const validTransports = ['usb', 'nfc', 'ble', 'internal', 'hybrid'] as const;
    type AuthenticatorTransport = (typeof validTransports)[number];
    const rawTransports = passkey_response.response.transports || [];
    const transports: AuthenticatorTransport[] = rawTransports.filter(
      (t): t is AuthenticatorTransport => validTransports.includes(t as AuthenticatorTransport)
    );

    // Store the Passkey credential
    // Use admin_passkeys when DB_ADMIN is available, otherwise use legacy passkeys table
    if (c.env.DB_ADMIN) {
      const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });
      const adminPasskeyRepo = new AdminPasskeyRepository(adminAdapter);

      await adminPasskeyRepo.createPasskey({
        admin_user_id: userId,
        credential_id: credentialId,
        public_key: publicKey,
        counter,
        transports,
        device_name: 'Initial Setup Passkey',
      });
    } else {
      // Fallback to legacy passkeys table
      const authCtx = createAuthContextFromHono(c, tenantId);
      await authCtx.repositories.passkey.create({
        id: generateId(),
        user_id: userId,
        credential_id: credentialId,
        public_key: publicKey,
        counter,
        transports,
      });
    }

    // Assign super_admin (or system_admin for legacy) role
    await assignSystemAdminRole(c.env, userId, tenantId);

    // Complete setup (permanently disable setup feature)
    await completeSetup(c.env);

    // Clean up temporary data
    await deleteSetupSession(c.env, tempSessionToken);
    await c.env.AUTHRIM_CONFIG.delete(`setup:challenge:${tempSessionToken}`);
    // Delete CSRF token after successful completion
    if (csrfToken) {
      await c.env.AUTHRIM_CONFIG.delete(`csrf:${csrfToken}`);
    }

    // Get Admin UI URL from environment if available
    const adminUiUrl = (c.env as unknown as Record<string, string>).ADMIN_UI_URL || null;

    return c.json({
      success: true,
      user: {
        id: userId,
        email,
        name: name || null,
        role: 'system_admin',
      },
      message: 'Initial administrator created successfully.',
      admin_ui_url: adminUiUrl,
    });
  } catch (error) {
    // Sanitized error logging - don't log full error object
    moduleLogger.error('Setup completion failed', { action: 'complete' }, error as Error);

    return c.json(
      {
        error: 'server_error',
        error_description: 'An error occurred during setup completion',
      },
      500
    );
  }
});

/**
 * GET /admin-init-setup
 *
 * Returns the setup UI HTML page.
 * The page handles the entire Passkey registration flow in the browser.
 */
setupApp.get('/admin-init-setup', async (c) => {
  const token = c.req.query('token');

  // Check if setup is disabled
  if (await isSetupDisabled(c.env)) {
    return c.html(setupCompletedHtml());
  }

  // Validate token (if provided)
  if (!token) {
    return c.html(invalidTokenHtml('No setup token provided'));
  }

  const tokenValidation = await validateSetupToken(c.env, token);
  if (!tokenValidation.valid) {
    const messages: Record<string, string> = {
      no_token: 'The setup token has expired. Please generate a new token.',
      invalid_token: 'Invalid setup token. Please check the URL.',
      setup_completed: 'Setup has already been completed.',
    };
    return c.html(invalidTokenHtml(messages[tokenValidation.reason || 'invalid_token']));
  }

  // Generate CSRF token for the form
  const csrfToken = generateSecureToken(32);
  if (c.env.AUTHRIM_CONFIG) {
    await c.env.AUTHRIM_CONFIG.put(`csrf:${csrfToken}`, 'true', {
      expirationTtl: 3600, // 1 hour
    });
  }

  // Return the setup form HTML with CSRF token
  return c.html(setupFormHtml(token, csrfToken));
});

/**
 * Generate the setup form HTML
 */
function setupFormHtml(token: string, csrfToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Initial Admin Setup - Authrim</title>
  <script src="https://unpkg.com/@simplewebauthn/browser@13/dist/bundle/index.umd.min.js"></script>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 2.5rem;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      width: 100%;
      max-width: 420px;
    }
    .logo {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    .logo svg {
      width: 48px;
      height: 48px;
    }
    h1 {
      color: #333;
      margin: 0 0 0.5rem 0;
      font-size: 1.5rem;
      text-align: center;
    }
    .subtitle {
      color: #666;
      text-align: center;
      margin-bottom: 2rem;
      font-size: 0.95rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      margin-bottom: 0.5rem;
      color: #444;
      font-weight: 500;
      font-size: 0.9rem;
    }
    input {
      width: 100%;
      padding: 0.875rem 1rem;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    input::placeholder {
      color: #999;
    }
    .btn {
      width: 100%;
      padding: 1rem;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .btn:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-icon {
      width: 20px;
      height: 20px;
    }
    .status {
      padding: 1rem;
      border-radius: 8px;
      margin-top: 1rem;
      display: none;
    }
    .status.error {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
      display: block;
    }
    .status.success {
      background: #f0fdf4;
      color: #16a34a;
      border: 1px solid #bbf7d0;
      display: block;
    }
    .status.loading {
      background: #f0f9ff;
      color: #0284c7;
      border: 1px solid #bae6fd;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid #0284c7;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .footer {
      margin-top: 2rem;
      text-align: center;
      color: #999;
      font-size: 0.85rem;
    }
    .security-note {
      background: #fefce8;
      border: 1px solid #fef08a;
      color: #854d0e;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.85rem;
      margin-bottom: 1.5rem;
    }
    .security-note strong {
      display: block;
      margin-bottom: 0.25rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="45" fill="url(#grad)" />
        <path d="M35 55 L50 40 L65 55 L50 70 Z" fill="white" />
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#667eea" />
            <stop offset="100%" style="stop-color:#764ba2" />
          </linearGradient>
        </defs>
      </svg>
    </div>
    <h1>Initial Admin Setup</h1>
    <p class="subtitle">Create your first administrator account</p>

    <div class="security-note">
      <strong>One-time setup</strong>
      This setup page will be permanently disabled after creating the admin account.
    </div>

    <form id="setup-form">
      <input type="hidden" id="setup-token" value="${escapeHtml(token)}" />
      <input type="hidden" id="csrf-token" value="${escapeHtml(csrfToken)}" />

      <div class="form-group">
        <label for="email">Email Address *</label>
        <input type="email" id="email" name="email" required placeholder="admin@example.com" autocomplete="email" />
      </div>

      <div class="form-group">
        <label for="name">Display Name (optional)</label>
        <input type="text" id="name" name="name" placeholder="Your name" autocomplete="name" />
      </div>

      <button type="submit" class="btn" id="submit-btn">
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <circle cx="12" cy="16" r="1"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        Register Passkey
      </button>
    </form>

    <div id="status" class="status"></div>

    <div class="footer">Powered by Authrim</div>
  </div>

  <script>
    const form = document.getElementById('setup-form');
    const statusEl = document.getElementById('status');
    const submitBtn = document.getElementById('submit-btn');
    const { startRegistration } = SimpleWebAuthnBrowser;

    function showStatus(type, message) {
      statusEl.className = 'status ' + type;
      if (type === 'loading') {
        statusEl.innerHTML = '<div class="spinner"></div>' + message;
      } else {
        statusEl.textContent = message;
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;

      const setupToken = document.getElementById('setup-token').value;
      const csrfToken = document.getElementById('csrf-token').value;
      const email = document.getElementById('email').value;
      const name = document.getElementById('name').value;

      try {
        // Step 1: Initialize setup
        showStatus('loading', 'Initializing setup...');

        const initResponse = await fetch('/api/admin-init-setup/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setup_token: setupToken, email, name, csrf_token: csrfToken }),
        });

        const initData = await initResponse.json();

        if (!initResponse.ok) {
          throw new Error(initData.error_description || 'Initialization failed');
        }

        // Step 2: Start Passkey registration
        showStatus('loading', 'Registering Passkey... Follow your browser prompts.');

        const attResp = await startRegistration({ optionsJSON: initData.passkey_options });

        // Step 3: Complete setup
        showStatus('loading', 'Completing setup...');

        const completeResponse = await fetch('/api/admin-init-setup/complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Setup-Session': initData.temp_session_token,
          },
          body: JSON.stringify({ passkey_response: attResp }),
        });

        const completeData = await completeResponse.json();

        if (!completeResponse.ok) {
          throw new Error(completeData.error_description || 'Setup completion failed');
        }

        // Success! Show completion page
        document.body.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
        const container = document.querySelector('.container');
        // Clear existing content
        while (container.firstChild) container.removeChild(container.firstChild);

        // Build completion page using DOM methods for security
        const logo = document.createElement('div');
        logo.className = 'logo';
        logo.innerHTML = '<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="45" fill="url(#grad2)"/><path d="M30 50 L45 65 L70 35" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><defs><linearGradient id="grad2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#10b981"/><stop offset="100%" style="stop-color:#059669"/></linearGradient></defs></svg>';
        container.appendChild(logo);

        const h1 = document.createElement('h1');
        h1.style.color = '#059669';
        h1.textContent = 'Setup Complete!';
        container.appendChild(h1);

        const subtitle = document.createElement('p');
        subtitle.className = 'subtitle';
        subtitle.textContent = 'Your administrator account has been created successfully.';
        container.appendChild(subtitle);

        // Info card
        const infoCard = document.createElement('div');
        infoCard.className = 'info-card';
        const items = [
          ['Email', completeData.user.email],
          ['Role', 'System Administrator'],
          ['Authentication', 'Passkey (WebAuthn)']
        ];
        items.forEach(([label, value]) => {
          const item = document.createElement('div');
          item.className = 'info-item';
          const labelSpan = document.createElement('span');
          labelSpan.className = 'info-label';
          labelSpan.textContent = label;
          const valueSpan = document.createElement('span');
          valueSpan.className = 'info-value';
          valueSpan.textContent = value;
          item.appendChild(labelSpan);
          item.appendChild(valueSpan);
          infoCard.appendChild(item);
        });
        container.appendChild(infoCard);

        // Admin UI link if available
        if (completeData.admin_ui_url) {
          const adminLink = document.createElement('a');
          adminLink.href = completeData.admin_ui_url;
          adminLink.className = 'btn';
          adminLink.style.marginBottom = '1rem';
          adminLink.textContent = 'Open Admin Dashboard';
          container.appendChild(adminLink);
        }

        // Next steps
        const nextSteps = document.createElement('div');
        nextSteps.className = 'next-steps';
        const h3 = document.createElement('h3');
        h3.textContent = "What's Next?";
        nextSteps.appendChild(h3);
        const ul = document.createElement('ul');
        ['Your Passkey is now registered and ready to use',
         'You can create OAuth clients to enable application authentication',
         'Configure identity providers for social login'
        ].forEach(text => {
          const li = document.createElement('li');
          li.textContent = text;
          ul.appendChild(li);
        });
        nextSteps.appendChild(ul);
        container.appendChild(nextSteps);

        const footer = document.createElement('div');
        footer.className = 'footer';
        footer.textContent = 'Powered by Authrim';
        container.appendChild(footer);

        // Add completion styles
        const style = document.createElement('style');
        style.textContent = '.info-card{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:1.5rem;margin:1.5rem 0}.info-item{display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid #dcfce7}.info-item:last-child{border-bottom:none}.info-label{color:#166534;font-weight:500}.info-value{color:#15803d}.next-steps{background:#f8fafc;border-radius:12px;padding:1.5rem;margin-top:1.5rem;text-align:left}.next-steps h3{color:#334155;margin:0 0 1rem 0;font-size:1rem}.next-steps ul{margin:0;padding-left:1.5rem;color:#64748b}.next-steps li{margin-bottom:0.5rem}';
        document.head.appendChild(style);

      } catch (error) {
        console.error('Setup error:', error);
        showStatus('error', error.message || 'An error occurred during setup');
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Generate the "setup completed" error HTML
 */
function setupCompletedHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Setup Complete - Authrim</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    }
    .container {
      background: white;
      padding: 2.5rem;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      text-align: center;
      max-width: 420px;
    }
    .icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { color: #333; margin-bottom: 0.5rem; }
    p { color: #666; line-height: 1.6; }
    .btn {
      display: inline-block;
      margin-top: 1.5rem;
      padding: 0.875rem 2rem;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
    }
    .footer { margin-top: 2rem; color: #999; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#10003;</div>
    <h1>Setup Already Complete</h1>
    <p>The initial administrator account has already been created.</p>
    <p>Please use the login page to access your account.</p>
    <a href="/login" class="btn">Go to Login</a>
    <div class="footer">Powered by Authrim</div>
  </div>
</body>
</html>`;
}

/**
 * Generate the "invalid token" error HTML
 */
function invalidTokenHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invalid Token - Authrim</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
    }
    .container {
      background: white;
      padding: 2.5rem;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      text-align: center;
      max-width: 420px;
    }
    .icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { color: #dc2626; margin-bottom: 0.5rem; }
    p { color: #666; line-height: 1.6; }
    .footer { margin-top: 2rem; color: #999; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#10007;</div>
    <h1>Invalid Setup Token</h1>
    <p>${escapeHtml(message)}</p>
    <p>Please run the setup script again to generate a new token.</p>
    <div class="footer">Powered by Authrim</div>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

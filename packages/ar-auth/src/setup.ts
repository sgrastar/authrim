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

// Note: Passkey registration is now handled by Admin UI, not Router
// See admin-setup-api.ts for the passkey registration endpoints

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
    if (!originHeader) {
      await releaseSetupLock(c.env);
      return c.json(
        {
          error: 'invalid_origin',
          error_description: 'Origin header is required for WebAuthn operations',
        },
        403
      );
    }

    const allowedOrigins = await getAllowedOriginsFromKV(c.env);

    // During initial setup, if no allowed origins are configured (ISSUER_URL not set),
    // allow the current request's origin. This is safe because:
    // 1. Setup token has already been validated above
    // 2. This is a one-time setup operation
    // 3. The origin is validated to be a proper HTTPS URL below
    const isOriginAllowed =
      allowedOrigins.length === 0 ||
      isAllowedOrigin(originHeader, allowedOrigins) ||
      // Also allow if the origin matches the current host (self-referential request)
      originHeader === `https://${c.req.header('host')}`;

    if (!isOriginAllowed) {
      await releaseSetupLock(c.env);
      moduleLogger.warn('Initial setup rejected: Origin not allowed', {
        origin: originHeader,
        allowedOrigins,
      });
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

    // Assign super_admin role
    await assignSystemAdminRole(c.env, userId, tenantId);

    // Create setup token for Admin UI passkey registration
    const setupTokenId = generateId();
    const now = Date.now();
    const tokenExpiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

    if (c.env.DB_ADMIN) {
      const adminAdapter = new D1Adapter({ db: c.env.DB_ADMIN });
      await adminAdapter.execute(
        `INSERT INTO admin_setup_tokens (id, tenant_id, admin_user_id, status, expires_at, created_at, created_by)
         VALUES (?, ?, ?, 'pending', ?, ?, 'initial_setup')`,
        [setupTokenId, tenantId, userId, tokenExpiresAt, now]
      );
    }

    // Store temporary session for the /complete endpoint
    const tempSessionToken = await createSetupSession(c.env, {
      userId,
      email,
      name,
      setupTokenId, // Store setup token ID for reference
    });

    // Store CSRF token reference for cleanup
    if (c.env.AUTHRIM_CONFIG && csrf_token) {
      await c.env.AUTHRIM_CONFIG.put(
        `setup:csrf:${tempSessionToken}`,
        csrf_token,
        { expirationTtl: 3600 } // 1 hour
      );
    }

    // Release lock - user creation successful
    await releaseSetupLock(c.env);
    lockAcquired = false;

    // Get Admin UI URL from environment
    const adminUiUrl = (c.env as unknown as Record<string, string>).ADMIN_UI_URL || null;
    const adminUiSetupUrl = adminUiUrl
      ? `${adminUiUrl}/setup/complete?token=${setupTokenId}`
      : null;

    return c.json({
      success: true,
      user_id: userId,
      temp_session_token: tempSessionToken,
      setup_token: setupTokenId,
      admin_ui_url: adminUiUrl,
      admin_ui_setup_url: adminUiSetupUrl,
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
 * Completes the initial setup on Router.
 * Passkey registration will happen separately on Admin UI.
 *
 * Headers:
 *   X-Setup-Session: <temp_session_token>
 *
 * Response:
 * {
 *   success: true,
 *   user: { id, email, role },
 *   admin_ui_setup_url: string,
 *   cli_fallback: string
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

    const { userId, email, name, setupTokenId } = sessionValidation.data as {
      userId: string;
      email: string;
      name?: string;
      setupTokenId?: string;
    };

    // Complete setup (permanently disable setup feature)
    await completeSetup(c.env);

    // Clean up temporary data
    await deleteSetupSession(c.env, tempSessionToken);

    // Clean up CSRF token
    if (c.env.AUTHRIM_CONFIG) {
      const csrfToken = await c.env.AUTHRIM_CONFIG.get(`setup:csrf:${tempSessionToken}`);
      if (csrfToken) {
        await c.env.AUTHRIM_CONFIG.delete(`csrf:${csrfToken}`);
        await c.env.AUTHRIM_CONFIG.delete(`setup:csrf:${tempSessionToken}`);
      }
    }

    // Get Admin UI URL from environment
    const adminUiUrl = (c.env as unknown as Record<string, string>).ADMIN_UI_URL || null;
    const adminUiSetupUrl =
      adminUiUrl && setupTokenId ? `${adminUiUrl}/setup/complete?token=${setupTokenId}` : null;

    moduleLogger.info('Initial setup completed on Router', {
      action: 'setup_completed',
      userId: userId.substring(0, 8) + '...',
      hasAdminUiUrl: !!adminUiSetupUrl,
    });

    return c.json({
      success: true,
      user: {
        id: userId,
        email,
        name: name || null,
        role: 'system_admin',
      },
      message: 'Administrator account created. Please complete passkey registration on Admin UI.',
      admin_ui_url: adminUiUrl,
      admin_ui_setup_url: adminUiSetupUrl,
      setup_token: setupTokenId,
      cli_fallback:
        'If the Admin UI setup URL does not work, run: npx @authrim/setup admin-passkey --env <env>',
    });
  } catch (error) {
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
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Create Admin Account
      </button>
    </form>

    <div id="status" class="status"></div>

    <div class="footer">Powered by Authrim</div>
  </div>

  <script>
    const form = document.getElementById('setup-form');
    const statusEl = document.getElementById('status');
    const submitBtn = document.getElementById('submit-btn');

    function showStatus(type, message) {
      statusEl.className = 'status ' + type;
      // Clear existing content
      while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
      if (type === 'loading') {
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        statusEl.appendChild(spinner);
        const text = document.createTextNode(message);
        statusEl.appendChild(text);
      } else {
        statusEl.textContent = message;
      }
    }

    // Create SVG element using DOM API (for security)
    function createCheckmarkSvg() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('fill', 'none');

      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
      gradient.setAttribute('id', 'grad2');
      gradient.setAttribute('x1', '0%');
      gradient.setAttribute('y1', '0%');
      gradient.setAttribute('x2', '100%');
      gradient.setAttribute('y2', '100%');
      const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      stop1.setAttribute('offset', '0%');
      stop1.setAttribute('style', 'stop-color:#667eea');
      const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      stop2.setAttribute('offset', '100%');
      stop2.setAttribute('style', 'stop-color:#764ba2');
      gradient.appendChild(stop1);
      gradient.appendChild(stop2);
      defs.appendChild(gradient);
      svg.appendChild(defs);

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '50');
      circle.setAttribute('cy', '50');
      circle.setAttribute('r', '45');
      circle.setAttribute('fill', 'url(#grad2)');
      svg.appendChild(circle);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M30 50 L45 65 L70 35');
      path.setAttribute('stroke', 'white');
      path.setAttribute('stroke-width', '8');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);

      return svg;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;

      const setupToken = document.getElementById('setup-token').value;
      const csrfToken = document.getElementById('csrf-token').value;
      const email = document.getElementById('email').value;
      const name = document.getElementById('name').value;

      try {
        // Step 1: Initialize setup (create admin user)
        showStatus('loading', 'Creating administrator account...');

        const initResponse = await fetch('/api/admin-init-setup/initialize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setup_token: setupToken, email, name, csrf_token: csrfToken }),
        });

        const initData = await initResponse.json();

        if (!initResponse.ok) {
          throw new Error(initData.error_description || 'Initialization failed');
        }

        // Step 2: Complete setup on Router
        showStatus('loading', 'Finalizing setup...');

        const completeResponse = await fetch('/api/admin-init-setup/complete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Setup-Session': initData.temp_session_token,
          },
        });

        const completeData = await completeResponse.json();

        if (!completeResponse.ok) {
          throw new Error(completeData.error_description || 'Setup completion failed');
        }

        // Success! Show completion page with Admin UI redirect
        document.body.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        const container = document.querySelector('.container');
        // Clear existing content
        while (container.firstChild) container.removeChild(container.firstChild);

        // Build completion page using DOM methods for security
        const logo = document.createElement('div');
        logo.className = 'logo';
        logo.appendChild(createCheckmarkSvg());
        container.appendChild(logo);

        const h1 = document.createElement('h1');
        h1.style.color = '#667eea';
        h1.textContent = 'Account Created!';
        container.appendChild(h1);

        const subtitle = document.createElement('p');
        subtitle.className = 'subtitle';
        subtitle.textContent = 'Your administrator account has been created. Please complete Passkey registration on Admin UI.';
        container.appendChild(subtitle);

        // Info card
        const infoCard = document.createElement('div');
        infoCard.className = 'info-card';
        const items = [
          ['Email', completeData.user.email],
          ['Role', 'System Administrator'],
          ['Status', 'Passkey registration required']
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

        // Admin UI setup link (primary action)
        if (completeData.admin_ui_setup_url) {
          const setupNote = document.createElement('div');
          setupNote.className = 'setup-note';
          const noteStrong = document.createElement('strong');
          noteStrong.textContent = 'Next Step:';
          setupNote.appendChild(noteStrong);
          const noteText = document.createTextNode(' Register your Passkey on Admin UI to enable login.');
          setupNote.appendChild(noteText);
          container.appendChild(setupNote);

          const adminLink = document.createElement('a');
          adminLink.href = completeData.admin_ui_setup_url;
          adminLink.className = 'btn';
          adminLink.textContent = 'Register Passkey on Admin UI';
          container.appendChild(adminLink);
        } else {
          // No Admin UI URL - show CLI fallback
          const noAdminNote = document.createElement('div');
          noAdminNote.className = 'setup-note warning';
          const noteTitle = document.createElement('strong');
          noteTitle.textContent = 'Admin UI not configured';
          noAdminNote.appendChild(noteTitle);
          noAdminNote.appendChild(document.createElement('br'));
          const noteDesc = document.createTextNode('Run the following command to generate a setup token later:');
          noAdminNote.appendChild(noteDesc);
          noAdminNote.appendChild(document.createElement('br'));
          const cliCode = document.createElement('code');
          cliCode.textContent = 'npx @authrim/setup admin-passkey --env <env>';
          noAdminNote.appendChild(cliCode);
          container.appendChild(noAdminNote);
        }

        // CLI Fallback info
        const fallbackInfo = document.createElement('div');
        fallbackInfo.className = 'fallback-info';
        const fallbackTitle = document.createElement('p');
        fallbackTitle.className = 'fallback-title';
        fallbackTitle.textContent = 'Setup link expired or not working?';
        fallbackInfo.appendChild(fallbackTitle);
        const fallbackCommand = document.createElement('code');
        fallbackCommand.className = 'fallback-command';
        fallbackCommand.textContent = completeData.cli_fallback || 'npx @authrim/setup admin-passkey --env <env>';
        fallbackInfo.appendChild(fallbackCommand);
        container.appendChild(fallbackInfo);

        const footer = document.createElement('div');
        footer.className = 'footer';
        footer.textContent = 'Powered by Authrim';
        container.appendChild(footer);

        // Add completion styles
        const style = document.createElement('style');
        style.textContent = '.info-card{background:#f0f4ff;border:1px solid #c7d2fe;border-radius:12px;padding:1.5rem;margin:1.5rem 0}.info-item{display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid #e0e7ff}.info-item:last-child{border-bottom:none}.info-label{color:#4338ca;font-weight:500}.info-value{color:#6366f1}.setup-note{background:#fef3c7;border:1px solid #fcd34d;color:#92400e;padding:1rem;border-radius:8px;margin:1rem 0;font-size:0.9rem}.setup-note.warning{background:#fef2f2;border-color:#fecaca;color:#b91c1c}.setup-note strong{display:block;margin-bottom:0.25rem}.setup-note code{display:block;margin-top:0.5rem;background:rgba(0,0,0,0.05);padding:0.5rem;border-radius:4px;font-size:0.85rem}.fallback-info{margin-top:1.5rem;padding:1rem;background:#f8fafc;border-radius:8px;text-align:center}.fallback-title{color:#64748b;margin:0 0 0.5rem 0;font-size:0.85rem}.fallback-command{display:block;background:#1e293b;color:#94a3b8;padding:0.75rem 1rem;border-radius:6px;font-size:0.8rem;word-break:break-all}';
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

/**
 * Anonymous User Upgrade API
 *
 * Upgrades anonymous users to full accounts while optionally preserving their sub.
 * Supports multiple upgrade methods: email, passkey, social.
 *
 * Security Features:
 * - Requires authenticated anonymous session
 * - Validates upgrade method is allowed for client
 * - Records upgrade history for audit
 * - Supports sub preservation or new sub assignment
 *
 * Flow:
 * 1. Anonymous user starts upgrade process
 * 2. Complete authentication with chosen method (email OTP, passkey, etc.)
 * 3. POST /api/auth/upgrade/complete - Finalize upgrade
 *
 * @see architecture-decisions.md §17 for design details
 */

import { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  generateId,
  createAuthContextFromHono,
  createPIIContextFromHono,
  createErrorResponse,
  AR_ERROR_CODES,
  isAnonymousAuthEnabled,
  loadClientContract,
  // Event System
  publishEvent,
  type AuthEventData,
  // Logger
  getLogger,
} from '@authrim/ar-lib-core';

/**
 * Upgrade method types
 */
type UpgradeMethod = 'email' | 'passkey' | 'social' | 'phone';

/**
 * Upgrade request body
 */
interface UpgradeRequest {
  method: UpgradeMethod;
  preserve_sub?: boolean;
  migrate_data?: boolean;
  // Method-specific params
  email?: string;
  name?: string;
  social_provider?: string;
  external_user_id?: string;
}

/**
 * Get authenticated session and verify it's anonymous
 */
async function getAnonymousSession(
  c: Context<{ Bindings: Env }>
): Promise<{ session: Session; sessionId: string } | null> {
  const sessionId = getCookie(c, 'authrim_session');
  if (!sessionId) {
    return null;
  }

  try {
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (!session || !session.userId) {
      return null;
    }

    // Verify session is anonymous
    if (!session.data?.is_anonymous) {
      return null;
    }

    return { session, sessionId };
  } catch {
    return null;
  }
}

/**
 * Start Anonymous User Upgrade
 * POST /api/auth/upgrade
 *
 * Initiates the upgrade process by returning instructions for the chosen method.
 * The actual authentication (email OTP, passkey, etc.) is handled by existing endpoints.
 */
export async function upgradeHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('UPGRADE');

  try {
    const tenantId = getTenantIdFromContext(c);

    // Check feature flag
    if (!(await isAnonymousAuthEnabled(c.env))) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Get anonymous session
    const sessionResult = await getAnonymousSession(c);
    if (!sessionResult) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED, {
        variables: { reason: 'Anonymous session required for upgrade' },
      });
    }

    const { session } = sessionResult;
    const clientId = (session.data?.client_id as string) || '';

    const body = await c.req.json<UpgradeRequest>();
    const { method } = body;

    // Validate method
    if (!method || !['email', 'passkey', 'social', 'phone'].includes(method)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Load client contract to check allowed upgrade methods
    const clientContract = await loadClientContract(
      c.env.AUTHRIM_CONFIG,
      c.env,
      tenantId,
      clientId
    );

    if (clientContract?.anonymousAuth?.allowedUpgradeMethods) {
      const allowedMethods = clientContract.anonymousAuth.allowedUpgradeMethods;
      if (!allowedMethods.includes(method)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
    }

    // Return instructions for the chosen method
    const methodInstructions: Record<UpgradeMethod, object> = {
      email: {
        method: 'email',
        endpoint: '/api/auth/email-codes/send',
        description: 'Send email verification code, then verify with /api/auth/email-codes/verify',
        next_step: 'Call /api/auth/upgrade/complete after email verification',
      },
      passkey: {
        method: 'passkey',
        endpoint: '/api/auth/passkeys/register/options',
        description: 'Register a passkey, then verify with /api/auth/passkeys/register/verify',
        next_step: 'Call /api/auth/upgrade/complete after passkey registration',
      },
      social: {
        method: 'social',
        endpoint: '/authorize',
        description: 'Complete OAuth flow with social provider',
        next_step: 'Include upgrade_anonymous=true in authorize request',
      },
      phone: {
        method: 'phone',
        endpoint: '/api/auth/phone/send',
        description: 'Send phone verification code (if enabled)',
        next_step: 'Call /api/auth/upgrade/complete after phone verification',
      },
    };

    return c.json({
      success: true,
      user_id: session.userId,
      upgrade_token: generateId(), // Token to track upgrade flow
      instructions: methodInstructions[method],
    });
  } catch (error) {
    log.error('Upgrade start error', { action: 'start' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Complete Anonymous User Upgrade
 * POST /api/auth/upgrade/complete
 *
 * Finalizes the upgrade after the user has completed authentication.
 * Updates user type and records upgrade history.
 */
export async function upgradeCompleteHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('UPGRADE');

  try {
    const tenantId = getTenantIdFromContext(c);

    // Check feature flag
    if (!(await isAnonymousAuthEnabled(c.env))) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Get anonymous session
    const sessionResult = await getAnonymousSession(c);
    if (!sessionResult) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED, {
        variables: { reason: 'Anonymous session required for upgrade' },
      });
    }

    const { session, sessionId } = sessionResult;
    const anonymousUserId = session.userId;
    const clientId = (session.data?.client_id as string) || '';

    const body = await c.req.json<{
      method: UpgradeMethod;
      preserve_sub?: boolean;
      migrate_data?: boolean;
      email?: string;
      name?: string;
      provider_id?: string;
      external_user_id?: string;
    }>();

    const { method, name, provider_id } = body;

    // Security: For email upgrade, email MUST have been verified via OTP flow
    // The verified email is stored in session data by email-code.ts
    // This prevents attackers from claiming arbitrary email addresses
    let email: string | undefined;
    let otpUserId: string | undefined; // User created during OTP flow (needs cleanup)

    if (method === 'email') {
      const verifiedEmail = session.data?.verified_email as string | undefined;
      const verifiedAt = session.data?.verified_email_at as number | undefined;
      const verifiedEmailUserId = session.data?.verified_email_user_id as string | undefined;
      const upgradeNonce = session.data?.upgrade_nonce as string | undefined;

      if (!verifiedEmail) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'verified email' },
        });
      }

      // TOCTOU FIX: Atomically consume the upgrade nonce
      // If nonce is missing, another concurrent request already consumed it
      if (!upgradeNonce) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Immediately clear the nonce to prevent concurrent requests
      // This MUST happen before any other processing
      const { stub: earlySessionStore } = getSessionStoreBySessionId(c.env, sessionId);
      await earlySessionStore.updateSessionDataRpc(sessionId, {
        upgrade_nonce: undefined, // Consume nonce atomically
      });

      // Security: Check if email was verified recently (within 10 minutes)
      // This prevents stale verifications from being used
      const maxAge = 10 * 60 * 1000; // 10 minutes in milliseconds
      const now = Date.now();
      if (verifiedAt && now - verifiedAt > maxAge) {
        // Clear remaining verification data
        await earlySessionStore.updateSessionDataRpc(sessionId, {
          verified_email: undefined,
          verified_email_at: undefined,
          verified_email_user_id: undefined,
        });
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
      }

      // Use verified email from session, NOT from request body
      email = verifiedEmail;

      // Track OTP user for cleanup (if different from anonymous user)
      if (verifiedEmailUserId && verifiedEmailUserId !== anonymousUserId) {
        otpUserId = verifiedEmailUserId;
      }
    } else {
      // For non-email methods, email is optional from request body
      email = body.email;
    }

    // Load client contract for default settings
    const clientContract = await loadClientContract(
      c.env.AUTHRIM_CONFIG,
      c.env,
      tenantId,
      clientId
    );

    // Determine if we should preserve sub (client default or explicit request)
    const preserveSub =
      body.preserve_sub ?? clientContract?.anonymousAuth?.preserveSubOnUpgrade ?? true;

    const authCtx = createAuthContextFromHono(c, tenantId);
    const now = Date.now();

    let finalUserId: string;
    let previousUserId: string | undefined;

    if (preserveSub) {
      // Keep the same user ID (sub)
      finalUserId = anonymousUserId;

      // Update user type from 'anonymous' to 'end_user'
      await authCtx.coreAdapter.execute(
        `UPDATE users_core SET
          user_type = 'end_user',
          email_verified = CASE WHEN ? = 'email' THEN 1 ELSE email_verified END,
          pii_status = CASE WHEN ? IS NOT NULL THEN 'pending' ELSE pii_status END,
          updated_at = ?
        WHERE id = ?`,
        [method, email, now, anonymousUserId]
      );

      // Create PII record if email provided
      if (email && c.env.DB_PII) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        try {
          await piiCtx.piiRepositories.userPII.createPII({
            id: anonymousUserId,
            tenant_id: tenantId,
            email: email.toLowerCase(),
            name: name || null,
            preferred_username: email.split('@')[0],
          });

          // Update pii_status to 'active'
          await authCtx.repositories.userCore.updatePIIStatus(anonymousUserId, 'active');
        } catch (piiError: unknown) {
          log.warn('Failed to create PII', { action: 'create_pii' });
          await authCtx.repositories.userCore.updatePIIStatus(anonymousUserId, 'failed');
        }
      }
    } else {
      // Create new user with new sub
      finalUserId = generateId();
      previousUserId = anonymousUserId;

      // Create new user in Core DB
      await authCtx.repositories.userCore.createUser({
        id: finalUserId,
        tenant_id: tenantId,
        email_verified: method === 'email',
        user_type: 'end_user',
        pii_partition: 'default',
        pii_status: email ? 'pending' : 'none',
      });

      // Create PII record for new user
      if (email && c.env.DB_PII) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        try {
          await piiCtx.piiRepositories.userPII.createPII({
            id: finalUserId,
            tenant_id: tenantId,
            email: email.toLowerCase(),
            name: name || null,
            preferred_username: email.split('@')[0],
          });
          await authCtx.repositories.userCore.updatePIIStatus(finalUserId, 'active');
        } catch (piiError: unknown) {
          log.warn('Failed to create PII for new user', { action: 'create_pii_new_user' });
          await authCtx.repositories.userCore.updatePIIStatus(finalUserId, 'failed');
        }
      }

      // Deactivate old anonymous user
      await authCtx.coreAdapter.execute(
        'UPDATE users_core SET is_active = 0, updated_at = ? WHERE id = ?',
        [now, anonymousUserId]
      );
    }

    // Record upgrade history
    const upgradeId = generateId();
    await authCtx.coreAdapter.execute(
      `INSERT INTO user_upgrades (
        id, tenant_id, anonymous_user_id, upgraded_user_id,
        upgrade_method, provider_id, preserve_sub, upgraded_at, data_migrated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        upgradeId,
        tenantId,
        anonymousUserId,
        finalUserId,
        method,
        provider_id || null,
        preserveSub ? 1 : 0,
        now,
        0, // data_migrated - can be updated later if app migrates data
      ]
    );

    // Deactivate anonymous device (no longer needed)
    await authCtx.coreAdapter.execute(
      'UPDATE anonymous_devices SET is_active = 0 WHERE user_id = ?',
      [anonymousUserId]
    );

    // Update session to reflect upgraded state
    // Security: Clear verified_email to prevent replay attacks
    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
    await sessionStore.updateSessionDataRpc(sessionId, {
      is_anonymous: false,
      upgrade_eligible: false,
      upgraded_at: now,
      upgrade_method: method,
      // Clear email verification data (prevent replay / TOCTOU)
      verified_email: undefined,
      verified_email_at: undefined,
      verified_email_user_id: undefined,
      upgrade_nonce: undefined,
      // Clear device identification data (privacy)
      device_id_hash: undefined,
    });

    // Cleanup: Delete orphaned OTP user (created during email verification)
    // This user was only a placeholder for the email verification flow
    if (otpUserId) {
      authCtx.coreAdapter
        .execute('DELETE FROM users_core WHERE id = ? AND tenant_id = ?', [otpUserId, tenantId])
        .catch((error) => {
          // Non-critical: orphaned user can be cleaned up later
          log.warn('Failed to cleanup OTP user', { action: 'cleanup_otp_user' });
        });
    }

    // If user ID changed, we need to update the session's user ID
    if (!preserveSub) {
      await sessionStore.updateSessionUserIdRpc(sessionId, finalUserId);
    }

    // Publish upgrade event
    publishEvent(c, {
      type: 'user.upgraded',
      tenantId,
      data: {
        userId: finalUserId,
        method: 'upgrade',
        clientId,
        previousUserId: preserveSub ? undefined : previousUserId,
        upgradeMethod: method,
        preserveSub,
      } satisfies AuthEventData & {
        previousUserId?: string;
        upgradeMethod: string;
        preserveSub: boolean;
      },
    }).catch((err) => {
      log.warn('Failed to publish user.upgraded event', { action: 'event_publish' });
    });

    return c.json({
      success: true,
      user_id: finalUserId,
      previous_user_id: preserveSub ? undefined : previousUserId,
      preserve_sub: preserveSub,
      method,
      upgraded_at: now,
    });
  } catch (error) {
    log.error('Upgrade complete error', { action: 'complete' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Get Upgrade Status
 * GET /api/auth/upgrade/status
 *
 * Returns current upgrade eligibility and history for the session user.
 */
export async function upgradeStatusHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('UPGRADE');

  try {
    const tenantId = getTenantIdFromContext(c);

    // Get session
    const sessionId = getCookie(c, 'authrim_session');
    if (!sessionId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (!session || !session.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    const authCtx = createAuthContextFromHono(c, tenantId);

    // Check if user is anonymous
    const user = await authCtx.repositories.userCore.findById(session.userId);
    const isAnonymous = user?.user_type === 'anonymous';

    // Get upgrade history if exists
    const upgradeHistory = await authCtx.coreAdapter.query<{
      id: string;
      upgrade_method: string;
      upgraded_at: number;
      preserve_sub: number;
    }>(
      `SELECT id, upgrade_method, upgraded_at, preserve_sub
       FROM user_upgrades
       WHERE anonymous_user_id = ? OR upgraded_user_id = ?
       ORDER BY upgraded_at DESC`,
      [session.userId, session.userId]
    );

    return c.json({
      user_id: session.userId,
      is_anonymous: isAnonymous,
      upgrade_eligible: isAnonymous,
      upgrade_history: upgradeHistory.map((h) => ({
        id: h.id,
        method: h.upgrade_method,
        upgraded_at: h.upgraded_at,
        preserve_sub: h.preserve_sub === 1,
      })),
    });
  } catch (error) {
    log.error('Upgrade status error', { action: 'status' }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

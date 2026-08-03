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
import type { Env, Session, UserLifecycleState } from '@authrim/ar-lib-core';
import {
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  generateId,
  createAuthContextFromHono,
  createPIIContextFromHono,
  CanonicalRuntimeUserStore,
  createErrorResponse,
  createTenantPlacementWriteFenceResponse,
  AR_ERROR_CODES,
  isAnonymousAuthEnabled,
  loadClientContractCached,
  // Event System
  publishEvent,
  type AuthEventData,
  // Logger
  getLogger,
  syncUserLifecycleState,
  resolveCustomClaimRuntimeSourcesFromEnv,
} from '@authrim/ar-lib-core';
import {
  removeTenantD1AnonymousDeviceRoute,
  usesTenantD1AccountStorage,
} from './account-provisioning';

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
 * Upgrade method types
 */
type UpgradeMethod = 'email' | 'passkey' | 'social' | 'phone';

/**
 * Upgrade request body
 */
interface UpgradeRequest {
  method: UpgradeMethod;
  upgrade_token?: string;
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
    const { stub: sessionStore } = getSessionStoreBySessionId(
      c.env,
      sessionId,
      getTenantIdFromContext(c)
    );
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

    const { session, sessionId } = sessionResult;
    const clientId = (session.data?.client_id as string) || '';

    const body = await c.req.json<UpgradeRequest>();
    const { method } = body;

    // Validate method
    if (!method || !['email', 'passkey', 'social', 'phone'].includes(method)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Load client contract to check allowed upgrade methods
    const clientContract = await loadClientContractCached(
      c,
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

    const upgradeToken = generateId();
    const { stub: sessionStore } = getSessionStoreBySessionId(
      c.env,
      sessionId,
      getTenantIdFromContext(c)
    );
    await sessionStore.updateSessionDataRpc(sessionId, {
      pending_upgrade_token: upgradeToken,
      pending_upgrade_method: method,
    });

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
      upgrade_token: upgradeToken,
      instructions: methodInstructions[method],
    });
  } catch (error) {
    log.error('Upgrade start error', { action: 'start' }, error as Error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
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
      upgrade_token?: string;
      preserve_sub?: boolean;
      migrate_data?: boolean;
      email?: string;
      name?: string;
      provider_id?: string;
      external_user_id?: string;
    }>();

    const { method, name, provider_id, upgrade_token } = body;

    if (!method || !['email', 'passkey', 'social', 'phone'].includes(method)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const pendingUpgradeToken = session.data?.pending_upgrade_token as string | undefined;
    const pendingUpgradeMethod = session.data?.pending_upgrade_method as string | undefined;
    if (
      !upgrade_token ||
      upgrade_token !== pendingUpgradeToken ||
      method !== pendingUpgradeMethod
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const clientContract = await loadClientContractCached(
      c,
      c.env.AUTHRIM_CONFIG,
      c.env,
      tenantId,
      clientId
    );
    if (
      clientContract?.anonymousAuth?.allowedUpgradeMethods &&
      !clientContract.anonymousAuth.allowedUpgradeMethods.includes(method)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

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
      const { stub: earlySessionStore } = getSessionStoreBySessionId(
        c.env,
        sessionId,
        getTenantIdFromContext(c)
      );
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
      if (session.data?.verified_upgrade_method !== method) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
      // For non-email methods, email is optional from request body after method proof.
      email = body.email;
    }

    // Determine if we should preserve sub (client default or explicit request)
    const preserveSub =
      body.preserve_sub ?? clientContract?.anonymousAuth?.preserveSubOnUpgrade ?? true;

    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const now = Date.now();
    const routedAnonymousDevices = usesTenantD1AccountStorage(c)
      ? await authCtx.coreAdapter.query<{ id: string; device_id_hash: string }>(
          `SELECT id, device_id_hash FROM anonymous_devices
            WHERE tenant_id = ? AND user_id = ? AND is_active = TRUE
            ORDER BY id LIMIT 65`,
          [tenantId, anonymousUserId],
          { consistencyClass: 'primary_required' }
        )
      : [];
    if (routedAnonymousDevices.length > 64) {
      throw new Error('anonymous_upgrade_device_limit_exceeded');
    }

    let finalUserId: string;
    let previousUserId: string | undefined;

    if (preserveSub) {
      // Keep the same user ID (sub)
      finalUserId = anonymousUserId;

      await runtimeUsers.syncUser({
        userId: anonymousUserId,
        email: email?.toLowerCase() ?? null,
        name: name || null,
        active: true,
        emailVerified: method === 'email',
        userType: 'end_user',
        sourceRef: 'anonymous_upgrade',
        customAttributesJson: email
          ? JSON.stringify({ preferred_username: email.split('@')[0] })
          : null,
      });
    } else {
      // Create new user with new sub
      finalUserId = generateId();
      previousUserId = anonymousUserId;

      await runtimeUsers.syncUser({
        userId: finalUserId,
        email: email?.toLowerCase() ?? null,
        name: name || null,
        active: true,
        emailVerified: method === 'email',
        userType: 'end_user',
        sourceRef: 'anonymous_upgrade',
        customAttributesJson: email
          ? JSON.stringify({ preferred_username: email.split('@')[0] })
          : null,
      });

      // Deactivate old anonymous user
      await runtimeUsers.syncUser({
        userId: anonymousUserId,
        active: false,
        userType: 'anonymous',
        sourceRef: 'anonymous_upgrade',
      });
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
      'UPDATE anonymous_devices SET is_active = 0 WHERE tenant_id = ? AND user_id = ?',
      [tenantId, anonymousUserId]
    );
    for (const device of routedAnonymousDevices) {
      await removeTenantD1AnonymousDeviceRoute(c, {
        tenantId,
        userId: anonymousUserId,
        deviceId: device.id,
        deviceIdHash: device.device_id_hash,
      });
    }

    const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
    const lifecycleSync = await syncUserLifecycleState({
      db: customClaimSources.nonPiiDb,
      dbPii: customClaimSources.piiDb,
      schemaDb: customClaimSources.schemaDb,
      stateDb: authCtx.coreAdapter,
      tenantId,
      userId: finalUserId,
      accountAuthenticationEnv: c.env,
    });
    const missingRequiredCustomClaims = lifecycleSync.missingRequiredFields.map((field) => ({
      field_key: field.fieldKey,
      label: field.label,
      field_type: field.fieldType,
    }));
    const profileCompletionRequired = missingRequiredCustomClaims.length > 0;
    const accountLifecycleState: UserLifecycleState = lifecycleSync.lifecycleState;

    // Update session to reflect upgraded state
    // Security: Clear verified_email to prevent replay attacks
    const { stub: sessionStore } = getSessionStoreBySessionId(
      c.env,
      sessionId,
      getTenantIdFromContext(c)
    );
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
      pending_upgrade_token: undefined,
      pending_upgrade_method: undefined,
      verified_upgrade_method: undefined,
      // Clear device identification data (privacy)
      device_id_hash: undefined,
      // Mirror the lifecycle snapshot into session data so the UI can recover
      // completion state without an extra round-trip after upgrade.
      profile_completion_required: profileCompletionRequired,
      missing_required_custom_claims: missingRequiredCustomClaims,
      account_lifecycle_state: accountLifecycleState,
    });

    // Cleanup: Delete orphaned OTP user (created during email verification)
    // This user was only a placeholder for the email verification flow
    if (otpUserId) {
      runtimeUsers.deleteUser(otpUserId).catch((_error: unknown) => {
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
    }).catch((_err: unknown) => {
      log.warn('Failed to publish user.upgraded event', { action: 'event_publish' });
    });

    return c.json({
      success: true,
      user_id: finalUserId,
      previous_user_id: preserveSub ? undefined : previousUserId,
      preserve_sub: preserveSub,
      method,
      upgraded_at: now,
      profile_completion_required: profileCompletionRequired,
      missing_required_custom_claims: missingRequiredCustomClaims,
      account_lifecycle_state: accountLifecycleState,
    });
  } catch (error) {
    log.error('Upgrade complete error', { action: 'complete' }, error as Error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
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

    const { stub: sessionStore } = getSessionStoreBySessionId(
      c.env,
      sessionId,
      getTenantIdFromContext(c)
    );
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (!session || !session.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
    }

    // Check if user is anonymous
    const authCtx = createAuthContextFromHono(c, tenantId);
    const runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
    const user = await runtimeUsers.findById(session.userId, { includeInactive: true });
    const isAnonymous = user?.account_type === 'anonymous';
    let missingRequiredCustomClaims: Array<{
      field_key: string;
      label: string;
      field_type: string;
    }> = [];
    let accountLifecycleState: UserLifecycleState = 'active';

    if (!isAnonymous) {
      const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(c.env, tenantId);
      const lifecycleSync = await syncUserLifecycleState({
        db: customClaimSources.nonPiiDb,
        dbPii: customClaimSources.piiDb,
        schemaDb: customClaimSources.schemaDb,
        stateDb: authCtx.coreAdapter,
        tenantId,
        userId: session.userId,
        accountAuthenticationEnv: c.env,
      });
      missingRequiredCustomClaims = lifecycleSync.missingRequiredFields.map((field) => ({
        field_key: field.fieldKey,
        label: field.label,
        field_type: field.fieldType,
      }));
      accountLifecycleState = lifecycleSync.lifecycleState;
    }

    const profileCompletionRequired = missingRequiredCustomClaims.length > 0;

    // Get upgrade history if exists
    const upgradeHistory = await authCtx.coreAdapter.query<{
      id: string;
      upgrade_method: string;
      upgraded_at: number;
      preserve_sub: number;
    }>(
      `SELECT id, upgrade_method, upgraded_at, preserve_sub
       FROM user_upgrades
       WHERE tenant_id = ? AND (anonymous_user_id = ? OR upgraded_user_id = ?)
       ORDER BY upgraded_at DESC`,
      [tenantId, session.userId, session.userId]
    );

    return c.json({
      user_id: session.userId,
      is_anonymous: isAnonymous,
      upgrade_eligible: isAnonymous,
      profile_completion_required: profileCompletionRequired,
      missing_required_custom_claims: missingRequiredCustomClaims,
      account_lifecycle_state: accountLifecycleState,
      upgrade_history: upgradeHistory.map((h) => ({
        id: h.id,
        method: h.upgrade_method,
        upgraded_at: h.upgraded_at,
        preserve_sub: h.preserve_sub === 1,
      })),
    });
  } catch (error) {
    log.error('Upgrade status error', { action: 'status' }, error as Error);
    const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
    if (writeFenceResponse) return writeFenceResponse;
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

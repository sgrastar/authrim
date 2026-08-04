/**
 * Anonymous Login (Device-based Authentication) Handler
 *
 * Enables device-based anonymous authentication for games and trial SaaS.
 * Users can later upgrade to full accounts while preserving their sub.
 *
 * Security Features:
 * - Device ID hashed with HMAC-SHA256 (never stored as plaintext)
 * - Challenge-response pattern for device verification
 * - Single-use challenges (consumed atomically)
 * - Feature flag gated (disabled by default)
 * - Rate limiting (strict profile)
 * - Timing-safe comparisons
 *
 * Flow:
 * 1. POST /api/auth/anon-login/challenge - Request challenge
 * 2. POST /api/auth/anon-login/verify - Verify device and create session
 *
 * @see architecture-decisions.md §17 for design details
 */

import { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { Env } from '@authrim/ar-lib-core';
import {
  getSessionStoreForNewSession,
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  resolveAccountDataContextFromHono,
  generateUserIdFromSettings,
  createAuthContextFromHono,
  createPIIContextFromHono,
  createErrorResponse,
  createTenantPlacementWriteFenceResponse,
  AR_ERROR_CODES,
  generateBrowserState,
  BROWSER_STATE_COOKIE_NAME,
  isAnonymousAuthEnabled,
  loadClientContractCached,
  // Device Fingerprint
  hashDeviceIdentifiers,
  verifyDeviceSignature,
  verifyChallengeResponse,
  generateDeviceChallenge,
  validateDeviceId,
  validateDeviceStability,
  type DeviceIdentifiers,
  type DeviceSignature,
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
  // Cookie Configuration
  getSessionCookieSameSite,
  getBrowserStateCookieSameSite,
  CanonicalRuntimeUserStore,
} from '@authrim/ar-lib-core';
import { resolveSessionTtl } from './session-ttl';
import {
  provisionAnonymousAccount,
  removeAnonymousDeviceRoute,
  resolveAnonymousAccountRoute,
} from './account-provisioning';

const CHALLENGE_TTL = 5 * 60; // 5 minutes in seconds

/**
 * Minimum response time for anon-login operations (milliseconds)
 *
 * Security: Prevents device enumeration via timing attacks.
 */
const MIN_RESPONSE_TIME_MS = 500;
const JITTER_MS = 100;

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
 * Ensure constant-time execution
 */
async function constantTimeWrapper<T>(operation: () => Promise<T>): Promise<T> {
  const startTime = Date.now();
  const result = await operation();

  const elapsed = Date.now() - startTime;
  const jitter = Math.random() * JITTER_MS;
  const targetTime = MIN_RESPONSE_TIME_MS + jitter;
  const remaining = targetTime - elapsed;

  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  return result;
}

/**
 * Request Challenge for Anonymous Login
 * POST /api/auth/anon-login/challenge
 *
 * Returns a cryptographic challenge that must be signed by the client.
 * The challenge is stored in ChallengeStore with 5-minute TTL.
 */
export async function anonLoginChallengeHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ANON-LOGIN');
  return constantTimeWrapper(async () => {
    try {
      const tenantId = getTenantIdFromContext(c);

      // Check feature flag
      if (!(await isAnonymousAuthEnabled(c.env))) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      const body = await c.req.json<{
        client_id: string;
        device_id: string;
        installation_id?: string;
        fingerprint?: string;
        platform?: 'ios' | 'android' | 'web' | 'other';
        device_stability?: 'session' | 'installation' | 'device';
      }>();

      const { client_id, device_id, installation_id, fingerprint, platform, device_stability } =
        body;

      // Validate required fields
      if (!client_id) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'client_id' },
        });
      }

      if (!device_id) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'device_id' },
        });
      }

      // Validate device_id format
      if (!validateDeviceId(device_id)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Load client contract to check anonymous auth settings
      const clientContract = await loadClientContractCached(
        c,
        c.env.AUTHRIM_CONFIG,
        c.env,
        tenantId,
        client_id
      );

      if (!clientContract) {
        return createErrorResponse(c, AR_ERROR_CODES.CLIENT_AUTH_FAILED);
      }

      // Check if anonymous auth is enabled for this client
      if (!clientContract.anonymousAuth?.enabled) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Validate device_stability if provided
      const resolvedStability = device_stability || clientContract.anonymousAuth.deviceStability;
      if (device_stability && !validateDeviceStability(device_stability)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Generate challenge
      const challenge = generateDeviceChallenge();

      // Get HMAC secret for device ID hashing
      // SECURITY: DEVICE_HMAC_SECRET or OTP_HMAC_SECRET MUST be configured
      // DO NOT fallback to ISSUER_URL as it is publicly known
      const hmacSecret = c.env.DEVICE_HMAC_SECRET || c.env.OTP_HMAC_SECRET;
      if (!hmacSecret) {
        log.error('DEVICE_HMAC_SECRET or OTP_HMAC_SECRET must be configured for anonymous auth', {
          action: 'security_config',
        });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      // Hash device identifiers
      const deviceIdentifiers: DeviceIdentifiers = {
        device_id,
        installation_id,
        fingerprint,
        platform,
      };

      const deviceSignature = await hashDeviceIdentifiers(deviceIdentifiers, hmacSecret);

      // Store challenge in ChallengeStore
      const challengeStore = await getChallengeStoreByChallengeId(
        c.env,
        challenge.challenge_id,
        getTenantIdFromContext(c)
      );

      await challengeStore.storeChallengeRpc({
        id: `anon_login:${challenge.challenge_id}`,
        tenantId: getTenantIdFromContext(c),
        type: 'anon_login',
        userId: '', // Will be set on verify
        challenge: challenge.challenge,
        ttl: CHALLENGE_TTL,
        metadata: {
          client_id,
          device_signature: deviceSignature,
          device_stability: resolvedStability,
          platform,
        },
      });

      return c.json({
        challenge_id: challenge.challenge_id,
        challenge: challenge.challenge,
        expires_at: challenge.expires_at,
      });
    } catch (error) {
      log.error('Anon login challenge error', { action: 'challenge' }, error as Error);
      const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
      if (writeFenceResponse) return writeFenceResponse;
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  });
}

/**
 * Verify Device and Create/Resume Anonymous Session
 * POST /api/auth/anon-login/verify
 *
 * Verifies the challenge response and either:
 * - Resumes existing anonymous session (same device_id)
 * - Creates new anonymous user and session
 */
export async function anonLoginVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ANON-LOGIN');
  return constantTimeWrapper(async () => {
    try {
      const tenantId = getTenantIdFromContext(c);

      // Check feature flag
      if (!(await isAnonymousAuthEnabled(c.env))) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      const body = await c.req.json<{
        challenge_id: string;
        device_id: string;
        installation_id?: string;
        fingerprint?: string;
        platform?: 'ios' | 'android' | 'web' | 'other';
        response: string; // Signed challenge response
        timestamp: number;
      }>();

      const {
        challenge_id,
        device_id,
        installation_id,
        fingerprint,
        platform,
        response,
        timestamp,
      } = body;

      // Validate required fields
      if (!challenge_id || !device_id || !response || !timestamp) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'challenge_id, device_id, response, timestamp' },
        });
      }

      // Validate device_id format
      if (!validateDeviceId(device_id)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Get challenge from ChallengeStore
      const challengeStore = await getChallengeStoreByChallengeId(
        c.env,
        challenge_id,
        getTenantIdFromContext(c)
      );

      let challengeData: {
        challenge: string;
        userId: string;
        metadata?: {
          client_id: string;
          device_signature: DeviceSignature;
          device_stability: string;
          platform?: string;
        };
      };

      try {
        // Consume challenge atomically
        challengeData = (await challengeStore.consumeChallengeRpc({
          id: `anon_login:${challenge_id}`,
          tenantId,
          type: 'anon_login',
        })) as typeof challengeData;
      } catch (error) {
        // Publish auth.anon_login.failed event
        publishEvent(c, {
          type: AUTH_EVENTS.LOGIN_FAILED,
          tenantId,
          data: {
            method: 'anonymous',
            clientId: 'anon-auth',
            errorCode: 'challenge_error',
          } satisfies AuthEventData,
        }).catch((err) => {
          log.error(
            'Failed to publish auth.login.failed event',
            { action: 'event_publish' },
            err as Error
          );
        });

        // Generic error for security
        log.error('Challenge consume error', { action: 'challenge_consume' }, error as Error);
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      const clientId = challengeData.metadata?.client_id;
      if (!clientId) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      // Verify challenge response (HMAC signature)
      // SECURITY: DEVICE_HMAC_SECRET or OTP_HMAC_SECRET MUST be configured
      // DO NOT fallback to ISSUER_URL as it is publicly known
      const hmacSecret = c.env.DEVICE_HMAC_SECRET || c.env.OTP_HMAC_SECRET;
      if (!hmacSecret) {
        log.error('DEVICE_HMAC_SECRET or OTP_HMAC_SECRET must be configured for anonymous auth', {
          action: 'security_config',
        });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      const isValidResponse = await verifyChallengeResponse(
        challengeData.challenge,
        response,
        device_id,
        timestamp,
        hmacSecret
      );

      if (!isValidResponse) {
        // Publish auth.anon_login.failed event
        publishEvent(c, {
          type: AUTH_EVENTS.LOGIN_FAILED,
          tenantId,
          data: {
            method: 'anonymous',
            clientId,
            errorCode: 'invalid_response',
          } satisfies AuthEventData,
        }).catch((err) => {
          log.error(
            'Failed to publish auth.login.failed event',
            { action: 'event_publish' },
            err as Error
          );
        });

        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      // Verify device signature matches
      const storedSignature = challengeData.metadata?.device_signature;
      if (storedSignature) {
        const deviceIdentifiers: DeviceIdentifiers = {
          device_id,
          installation_id,
          fingerprint,
          platform,
        };

        const signatureMatch = await verifyDeviceSignature(
          deviceIdentifiers,
          storedSignature,
          hmacSecret
        );

        if (!signatureMatch) {
          return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
        }
      }

      const now = Date.now();

      // Check for existing anonymous device
      let userId: string | null = null;
      let isNewUser = false;
      let runtimeUsers: CanonicalRuntimeUserStore;

      // Hash current device_id for lookup
      const currentSignature = await hashDeviceIdentifiers(
        { device_id, installation_id, fingerprint, platform },
        hmacSecret
      );
      {
        let account = null;
        try {
          account = await resolveAnonymousAccountRoute(c, currentSignature.device_id_hash);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'account_data_route_not_found') {
            throw error;
          }
        }
        if (account) {
          const authCtx = createAuthContextFromHono(c, tenantId);
          const existingDevice = await authCtx.coreAdapter.queryOne<{
            id: string;
            user_id: string;
            expires_at: number | null;
          }>(
            `SELECT id, user_id, expires_at FROM anonymous_devices
              WHERE tenant_id = ? AND device_id_hash = ? AND is_active = TRUE`,
            [tenantId, currentSignature.device_id_hash],
            { consistencyClass: 'primary_required' }
          );
          if (!existingDevice || existingDevice.user_id !== account.legacyUserId) {
            return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
          }
          if (existingDevice.expires_at !== null && existingDevice.expires_at < now) {
            await authCtx.coreAdapter.execute(
              `UPDATE anonymous_devices SET is_active = FALSE
                WHERE id = ? AND tenant_id = ? AND user_id = ? AND is_active = TRUE`,
              [existingDevice.id, tenantId, existingDevice.user_id]
            );
            await removeAnonymousDeviceRoute(c, {
              tenantId,
              userId: existingDevice.user_id,
              deviceId: existingDevice.id,
              deviceIdHash: currentSignature.device_id_hash,
            });
            return c.json(
              {
                status: 'anonymous_credential_recycling',
                restart_required: true,
                retry_after_ms: 500,
              },
              202
            );
          }
          userId = existingDevice.user_id;
          await authCtx.coreAdapter.execute(
            'UPDATE anonymous_devices SET last_used_at = ? WHERE id = ? AND tenant_id = ?',
            [now, existingDevice.id, tenantId]
          );
          runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
        } else {
          const clientContract = await loadClientContractCached(
            c,
            c.env.AUTHRIM_CONFIG,
            c.env,
            tenantId,
            clientId
          );
          const candidateUserId = await generateUserIdFromSettings(
            c.env.AUTHRIM_CONFIG,
            tenantId,
            c.env
          );
          const stability = ['session', 'installation', 'device'].includes(
            challengeData.metadata?.device_stability ?? ''
          )
            ? (challengeData.metadata?.device_stability as 'session' | 'installation' | 'device')
            : 'installation';
          const provisioned = await provisionAnonymousAccount(c, {
            tenantId,
            candidateUserId,
            device: {
              deviceIdHash: currentSignature.device_id_hash,
              installationIdHash: currentSignature.installation_id_hash ?? null,
              fingerprintHash: currentSignature.fingerprint_hash ?? null,
              platform: currentSignature.device_platform ?? null,
              stability,
              expiresInDays: clientContract?.anonymousAuth?.expiresInDays ?? null,
            },
          });
          if (provisioned.status === 'pending') return provisioned.response;
          const resolved = await resolveAccountDataContextFromHono(c, provisioned.userId);
          if (
            resolved.accountId !== provisioned.accountId ||
            resolved.legacyUserId !== provisioned.userId
          ) {
            throw new Error('anonymous_account_provisioning_route_mismatch');
          }
          const authCtx = createAuthContextFromHono(c, tenantId);
          const reflectedDevice = await authCtx.coreAdapter.queryOne<{ user_id: string }>(
            `SELECT user_id FROM anonymous_devices
              WHERE tenant_id = ? AND device_id_hash = ? AND is_active = TRUE`,
            [tenantId, currentSignature.device_id_hash],
            { consistencyClass: 'primary_required' }
          );
          if (reflectedDevice?.user_id !== provisioned.userId) {
            throw new Error('anonymous_account_provisioning_authority_missing');
          }
          userId = provisioned.userId;
          isNewUser = true;
          runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
        }
      }

      if (!userId) throw new Error('anonymous_account_resolution_failed');

      const sessionTtl = await resolveSessionTtl(c.env, tenantId, 'anonymous');

      // Create session using SessionStore Durable Object
      let sessionId: string;
      try {
        const { stub: sessionStore, sessionId: newSessionId } = await getSessionStoreForNewSession(
          c.env,
          tenantId
        );
        sessionId = newSessionId;

        await sessionStore.createSessionRpc(
          newSessionId,
          userId,
          sessionTtl.seconds,
          {
            amr: ['anon'],
            acr: 'urn:mace:incommon:iap:anonymous',
            is_anonymous: true,
            upgrade_eligible: true,
            device_id_hash: currentSignature.device_id_hash,
            client_id: clientId,
          },
          tenantId
        );
      } catch (error) {
        log.error('Failed to create session', { action: 'session_create' }, error as Error);
        return createErrorResponse(c, AR_ERROR_CODES.SESSION_STORE_ERROR);
      }

      // Update last_login_at (fire-and-forget)
      runtimeUsers.touchLastLogin(userId, now).catch((error: unknown) => {
        log.error(
          'Failed to update user login timestamp',
          { action: 'user_update' },
          error as Error
        );
      });

      // Set session cookie (SameSite determined dynamically based on origin configuration)
      setCookie(c, 'authrim_session', sessionId, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: getSessionCookieSameSite(c.env),
        maxAge: sessionTtl.seconds,
      });

      // Set browser state cookie for OIDC Session Management
      const browserState = await generateBrowserState(sessionId);
      setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
        path: '/',
        secure: true,
        sameSite: getBrowserStateCookieSameSite(c.env),
        maxAge: sessionTtl.seconds,
      });

      // Publish auth.login.succeeded event
      publishEvent(c, {
        type: AUTH_EVENTS.LOGIN_SUCCEEDED,
        tenantId,
        data: {
          userId,
          method: 'anonymous',
          clientId,
          sessionId,
        } satisfies AuthEventData,
      }).catch((err) => {
        log.error(
          'Failed to publish auth.login.succeeded event',
          { action: 'event_publish' },
          err as Error
        );
      });

      // Publish session.user.created event
      publishEvent(c, {
        type: SESSION_EVENTS.USER_CREATED,
        tenantId,
        data: {
          sessionId,
          userId,
          ttlSeconds: sessionTtl.seconds,
        } satisfies SessionEventData,
      }).catch((err) => {
        log.error(
          'Failed to publish session.user.created event',
          { action: 'event_publish' },
          err as Error
        );
      });

      // Write audit log for anonymous login (non-blocking)
      const ipAddress =
        c.req.header('CF-Connecting-IP') ||
        c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
        c.req.header('X-Real-IP') ||
        'unknown';
      const userAgent = c.req.header('User-Agent') || 'unknown';

      // Schedule audit log with waitUntil to ensure it completes after response
      const auditPromise = createAuditLog(c.env, {
        tenantId,
        userId,
        action: 'user.login',
        resource: 'session',
        resourceId: sessionId,
        ipAddress,
        userAgent,
        metadata: JSON.stringify({
          method: 'anonymous',
          is_new_user: isNewUser,
          client_id: clientId,
        }),
        severity: 'info',
      }).catch((err) => {
        log.error(
          'Failed to create audit log for anonymous login',
          { action: 'audit_log' },
          err as Error
        );
      });
      c.executionCtx?.waitUntil(auditPromise);

      return c.json({
        success: true,
        session_id: sessionId,
        user_id: userId,
        is_new_user: isNewUser,
        upgrade_eligible: true,
        user: {
          id: userId,
          user_type: 'anonymous',
        },
      });
    } catch (error) {
      log.error('Anon login verify error', { action: 'verify' }, error as Error);
      const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
      if (writeFenceResponse) return writeFenceResponse;
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  });
}

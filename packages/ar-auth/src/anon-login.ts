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
  generateId,
  createAuthContextFromHono,
  createErrorResponse,
  AR_ERROR_CODES,
  generateBrowserState,
  BROWSER_STATE_COOKIE_NAME,
  isAnonymousAuthEnabled,
  loadClientContract,
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
} from '@authrim/ar-lib-core';

const CHALLENGE_TTL = 5 * 60; // 5 minutes in seconds
const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

/**
 * Minimum response time for anon-login operations (milliseconds)
 *
 * Security: Prevents device enumeration via timing attacks.
 */
const MIN_RESPONSE_TIME_MS = 500;
const JITTER_MS = 100;

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
      const clientContract = await loadClientContract(
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
        console.error(
          '[SECURITY] DEVICE_HMAC_SECRET or OTP_HMAC_SECRET must be configured for anonymous auth'
        );
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
      const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge.challenge_id);

      await challengeStore.storeChallengeRpc({
        id: `anon_login:${challenge.challenge_id}`,
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
      console.error(
        'Anon login challenge error:',
        error instanceof Error ? error.name : 'Unknown error'
      );
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
      const challengeStore = await getChallengeStoreByChallengeId(c.env, challenge_id);

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
          console.error('[Event] Failed to publish auth.login.failed:', err);
        });

        // Generic error for security
        console.error(
          'Challenge consume error:',
          error instanceof Error ? error.name : 'Unknown error'
        );
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
        console.error(
          '[SECURITY] DEVICE_HMAC_SECRET or OTP_HMAC_SECRET must be configured for anonymous auth'
        );
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
          console.error('[Event] Failed to publish auth.login.failed:', err);
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

      // Get auth context
      const authCtx = createAuthContextFromHono(c, tenantId);
      const now = Date.now();

      // Check for existing anonymous device
      let userId: string | null = null;
      let isNewUser = false;

      // Hash current device_id for lookup
      const currentSignature = await hashDeviceIdentifiers(
        { device_id, installation_id, fingerprint, platform },
        hmacSecret
      );

      // Look up existing anonymous device by device_id_hash
      const existingDevice = await authCtx.coreAdapter.queryOne<{
        id: string;
        user_id: string;
        expires_at: number | null;
        is_active: number;
      }>(
        `SELECT id, user_id, expires_at, is_active FROM anonymous_devices
         WHERE tenant_id = ? AND device_id_hash = ? AND is_active = 1`,
        [tenantId, currentSignature.device_id_hash]
      );

      if (existingDevice) {
        // Check if expired
        if (existingDevice.expires_at && existingDevice.expires_at < now) {
          // Device expired - deactivate and create new
          await authCtx.coreAdapter.execute(
            'UPDATE anonymous_devices SET is_active = 0 WHERE id = ?',
            [existingDevice.id]
          );
        } else {
          // Resume existing user
          userId = existingDevice.user_id;

          // Update last_used_at
          await authCtx.coreAdapter.execute(
            'UPDATE anonymous_devices SET last_used_at = ? WHERE id = ?',
            [now, existingDevice.id]
          );
        }
      }

      // Create new anonymous user if not found
      if (!userId) {
        isNewUser = true;
        const newUserId = generateId();

        // Load client contract for expiration settings
        const clientContract = await loadClientContract(
          c.env.AUTHRIM_CONFIG,
          c.env,
          tenantId,
          clientId
        );

        const expiresInDays = clientContract?.anonymousAuth?.expiresInDays;
        const expiresAt = expiresInDays ? now + expiresInDays * 24 * 60 * 60 * 1000 : null;

        // Create anonymous user in Core DB (pii_status='none' - no PII)
        await authCtx.repositories.userCore.createUser({
          id: newUserId,
          tenant_id: tenantId,
          email_verified: false,
          user_type: 'anonymous',
          pii_partition: 'none', // No PII for anonymous users
          pii_status: 'none',
        });

        // Create anonymous device record using INSERT OR IGNORE
        // This handles race conditions where another request created the device concurrently
        const deviceId = generateId();
        await authCtx.coreAdapter.execute(
          `INSERT OR IGNORE INTO anonymous_devices (
            id, tenant_id, user_id, device_id_hash, installation_id_hash,
            fingerprint_hash, device_platform, device_stability,
            expires_at, created_at, last_used_at, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            deviceId,
            tenantId,
            newUserId,
            currentSignature.device_id_hash,
            currentSignature.installation_id_hash || null,
            currentSignature.fingerprint_hash || null,
            currentSignature.device_platform || null,
            challengeData.metadata?.device_stability || 'installation',
            expiresAt,
            now,
            now,
          ]
        );

        // RACE CONDITION FIX: Re-check if another request created a device first
        // This handles the case where two requests passed the initial check concurrently
        const raceCheckDevice = await authCtx.coreAdapter.queryOne<{
          user_id: string;
        }>(
          `SELECT user_id FROM anonymous_devices
           WHERE tenant_id = ? AND device_id_hash = ? AND is_active = 1
           ORDER BY created_at ASC LIMIT 1`,
          [tenantId, currentSignature.device_id_hash]
        );

        if (raceCheckDevice && raceCheckDevice.user_id !== newUserId) {
          // Another request won the race - use their user and cleanup ours
          userId = raceCheckDevice.user_id;
          isNewUser = false;

          // Cleanup our orphaned user (fire-and-forget)
          authCtx.coreAdapter
            .execute('DELETE FROM users_core WHERE id = ? AND tenant_id = ?', [newUserId, tenantId])
            .catch((err) => {
              console.error('[ANON-LOGIN] Failed to cleanup orphaned user:', err);
            });

          // Also delete our device record if it was inserted
          authCtx.coreAdapter
            .execute('DELETE FROM anonymous_devices WHERE id = ? AND tenant_id = ?', [
              deviceId,
              tenantId,
            ])
            .catch((err) => {
              console.error('[ANON-LOGIN] Failed to cleanup orphaned device:', err);
            });
        } else {
          // Our insert succeeded or we won the race
          userId = newUserId;
        }
      }

      // Create session using SessionStore Durable Object
      let sessionId: string;
      try {
        const { stub: sessionStore, sessionId: newSessionId } = await getSessionStoreForNewSession(
          c.env
        );
        sessionId = newSessionId;

        await sessionStore.createSessionRpc(newSessionId, userId, SESSION_TTL, {
          amr: ['anon'],
          acr: 'urn:mace:incommon:iap:anonymous',
          is_anonymous: true,
          upgrade_eligible: true,
          device_id_hash: currentSignature.device_id_hash,
          client_id: clientId,
        });
      } catch (error) {
        console.error(
          'Failed to create session:',
          error instanceof Error ? error.name : 'Unknown error'
        );
        return createErrorResponse(c, AR_ERROR_CODES.SESSION_STORE_ERROR);
      }

      // Update last_login_at (fire-and-forget)
      authCtx.coreAdapter
        .execute('UPDATE users_core SET last_login_at = ?, updated_at = ? WHERE id = ?', [
          now,
          now,
          userId,
        ])
        .catch((error) => {
          console.error(
            'Failed to update user login timestamp:',
            error instanceof Error ? error.name : 'Unknown error'
          );
        });

      // Set session cookie
      setCookie(c, 'authrim_session', sessionId, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        maxAge: SESSION_TTL,
      });

      // Set browser state cookie for OIDC Session Management
      const browserState = await generateBrowserState(sessionId);
      setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
        path: '/',
        secure: true,
        sameSite: 'None',
        maxAge: SESSION_TTL,
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
        console.error('[Event] Failed to publish auth.login.succeeded:', err);
      });

      // Publish session.user.created event
      publishEvent(c, {
        type: SESSION_EVENTS.USER_CREATED,
        tenantId,
        data: {
          sessionId,
          userId,
          ttlSeconds: SESSION_TTL,
        } satisfies SessionEventData,
      }).catch((err) => {
        console.error('[Event] Failed to publish session.user.created:', err);
      });

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
      console.error(
        'Anon login verify error:',
        error instanceof Error ? error.name : 'Unknown error'
      );
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  });
}

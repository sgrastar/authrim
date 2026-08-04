/**
 * Email Code (OTP) Authentication Handler
 * Passwordless authentication via email verification codes
 *
 * Security Features:
 * - 6-digit numeric OTP
 * - 5-minute TTL
 * - Single-use (consumed on verification)
 * - Session binding (otp_session_id cookie)
 * - HMAC hash storage (no plaintext)
 * - Rate limiting (3/15min per email)
 * - Safari autofill compatible
 * - Constant-time response (prevents user enumeration via timing)
 */

import { Context } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/ar-lib-core';
import {
  getSessionStoreForNewSession,
  getSessionStoreBySessionId,
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  buildDOKey,
  generateId,
  generateUserIdFromSettings,
  createAccountAuthContextFromHono,
  createPIIContextFromHono,
  createErrorResponse,
  createTenantPlacementWriteFenceResponse,
  createDataTemporarilyUnavailableResponse,
  AR_ERROR_CODES,
  produceNotificationDelivery,
  generateBrowserState,
  ensureAccountAuthenticationState,
  findCanonicalAccountAuthenticationState,
  BROWSER_STATE_COOKIE_NAME,
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
  ensureDatabaseAdapter,
  getTenantMetadataContextFromHono,
  markOtpLoginEmailVerified,
  resolveOtpAccountCoreDataContextByIdentifierFromHono,
  type CanonicalOtpLoginUser,
  type OtpAccountCoreDataContext,
} from '@authrim/ar-lib-core';
import { getRequestIssuer } from './issuer';
import { getEmailCodeHtml, getEmailCodeText } from './utils/email/templates';
import {
  generateEmailCode,
  hashEmailCode,
  verifyEmailCodeHash,
  hashEmail,
} from './utils/email-code-utils';
import {
  buildCanonicalProfileRuntimeUserFields,
  persistRegistrationFieldValuesFromEnv,
  validateRegistrationFieldSubmissionFromEnv,
} from './registration-field-utils';
import { resolveSessionTtl } from './session-ttl';
import { provisionTenantD1EmailAccount } from './account-provisioning';
import { timeAuthRequestDiagnosticOperation } from './request-diagnostics';

const EMAIL_CODE_TTL = 5 * 60; // 5 minutes in seconds
const OTP_SESSION_COOKIE = 'authrim_otp_session';

/**
 * Minimum response time for email-code operations (milliseconds)
 *
 * Security: This prevents user enumeration via timing attacks.
 * The value is set higher than the maximum expected processing time
 * to ensure consistent response times regardless of code path.
 *
 * Typical timings:
 * - New user (no DB lookup): ~200ms
 * - Existing user (with DB lookup): ~350ms
 * - Minimum constant time: 500ms (with some jitter)
 */
const MIN_RESPONSE_TIME_MS = 500;
const JITTER_MS = 100; // Random jitter to prevent statistical analysis

function createCanonicalRuntimeUserStore(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): CanonicalRuntimeUserStore {
  const authCtx = createAccountAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  return new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
}

/**
 * Ensure constant-time execution
 *
 * This function ensures that an async operation takes at least
 * MIN_RESPONSE_TIME_MS to complete, preventing timing attacks.
 *
 * @param operation - Async operation to wrap
 * @returns Result of the operation
 */
async function constantTimeWrapper<T>(operation: () => Promise<T>): Promise<T> {
  const startTime = Date.now();

  // Execute the operation
  const result = await operation();

  // Calculate remaining time to wait
  const elapsed = Date.now() - startTime;
  // Add random jitter to prevent statistical analysis
  const jitter = Math.random() * JITTER_MS;
  const targetTime = MIN_RESPONSE_TIME_MS + jitter;
  const remaining = targetTime - elapsed;

  // Wait if we finished too early
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  return result;
}

/**
 * Send Email Code (OTP)
 * POST /api/auth/email-code/send
 *
 * Security: Uses constant-time wrapper to prevent user enumeration via timing attacks.
 * All responses take at least MIN_RESPONSE_TIME_MS to complete.
 */
export async function emailCodeSendHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('EMAIL-CODE');
  return constantTimeWrapper(async () => {
    try {
      const body = await c.req.json<{
        email: string;
        name?: string;
        custom_fields?: Record<string, unknown>;
      }>();

      const { email, name, custom_fields } = body;

      if (!email) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'email' },
        });
      }

      // Email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      const tenantId = getTenantIdFromContext(c);

      // Rate limiting check: 3 requests per 15 minutes per email via RPC
      const rateLimiterId = c.env.RATE_LIMITER.idFromName(
        buildDOKey('rate-limit', 'email-code', tenantId)
      );
      const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);

      const rateLimitResult = await rateLimiter.incrementRpc(`email_code:${email.toLowerCase()}`, {
        windowSeconds: 15 * 60, // 15 minutes
        maxRequests: 3,
      });

      if (!rateLimitResult.allowed) {
        return createErrorResponse(c, AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
          variables: { retry_after: rateLimitResult.retryAfter },
        });
      }

      // Check if user exists, if not create a new canonical runtime user.
      let user: { id: string; email: string; name: string | null } | null = null;
      const tenantD1 = true;
      let runtimeUsers: CanonicalRuntimeUserStore | null = null;
      const normalizedEmail = email.toLowerCase();
      let routedUser: CanonicalOtpLoginUser | null = null;
      let customFieldValues: Record<string, string> = {};

      if (tenantD1) {
        try {
          const accountData = await resolveOtpAccountCoreDataContextByIdentifierFromHono(c, {
            indexKind: 'email_exact',
            identifier: normalizedEmail,
            trustedEmail: normalizedEmail,
          });
          routedUser = accountData.user.active === 1 ? accountData.user : null;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'account_data_route_not_found') {
            throw error;
          }
        }
      } else {
        runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
      }

      const existingUser = tenantD1 ? routedUser : await runtimeUsers?.findByEmail(normalizedEmail);
      if (existingUser) {
        user = {
          id: existingUser.id,
          email: existingUser.email ?? normalizedEmail,
          name: existingUser.name || null,
        };
      }

      if (!user) {
        const customFieldValidation = await validateRegistrationFieldSubmissionFromEnv(
          c.env,
          tenantId,
          {
            ...(custom_fields ?? {}),
            email: normalizedEmail,
            'field.canonical.email': normalizedEmail,
            ...(name ? { name, 'field.canonical.name': name } : {}),
          }
        );
        if (!customFieldValidation.ok) {
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_FORMAT, {
            variables: { field: 'custom_fields', reason: customFieldValidation.error },
            extensions: customFieldValidation.missingRequiredFields
              ? {
                  missing_required_fields: customFieldValidation.missingRequiredFields.map(
                    (field) => ({
                      field_key: field.fieldKey,
                      label: field.label,
                      field_type: field.fieldType,
                    })
                  ),
                }
              : undefined,
          });
        }
        customFieldValues = customFieldValidation.values;
        const canonicalProfileFields = buildCanonicalProfileRuntimeUserFields({
          ...(custom_fields ?? {}),
          ...customFieldValues,
        });

        const userId = await generateUserIdFromSettings(c.env.AUTHRIM_CONFIG, tenantId, c.env);
        const defaultName = name || null;
        const preferredUsername = normalizedEmail.split('@')[0];
        const runtimeUser = {
          active: true as const,
          emailVerified: false,
          userType: 'end_user',
          displayName: defaultName,
          sourceRef: 'auth:email_code',
          piiFields: {
            ...canonicalProfileFields.piiFields,
            email: true,
            ...(defaultName ? { name: true } : {}),
          },
          sensitiveValues: {
            ...canonicalProfileFields.sensitiveValues,
            email: normalizedEmail,
            ...(defaultName ? { name: defaultName } : {}),
          },
          customAttributesJson: JSON.stringify({
            preferred_username: preferredUsername,
          }),
        };

        try {
          if (tenantD1) {
            const provisioned = await provisionTenantD1EmailAccount(c, {
              tenantId,
              candidateUserId: userId,
              flow: 'email_code',
              email: normalizedEmail,
              runtimeUser,
            });
            if (provisioned.status === 'pending') return provisioned.response;
            user = {
              id: provisioned.userId,
              email: normalizedEmail,
              name: defaultName,
            };
          } else {
            await runtimeUsers!.syncUser({
              userId,
              email: normalizedEmail,
              name: defaultName,
              active: true,
              emailVerified: false,
              userType: 'end_user',
              sourceRef: 'email_code',
              piiFields: canonicalProfileFields.piiFields,
              sensitiveValues: canonicalProfileFields.sensitiveValues,
              customAttributesJson: runtimeUser.customAttributesJson,
            });
          }
        } catch (piiError: unknown) {
          const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, piiError);
          if (writeFenceResponse) return writeFenceResponse;
          // PII Protection: Don't log full error (may contain PII)
          log.error(
            'Failed to create canonical runtime user',
            { action: 'runtime_user_create' },
            piiError instanceof Error ? piiError : undefined
          );
          return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
        }

        user ??= {
          id: userId,
          email: normalizedEmail,
          name: defaultName || email.split('@')[0],
        };
      }

      // Generate OTP session ID for session binding
      const otpSessionId = crypto.randomUUID();
      const issuedAt = Date.now();

      // Generate 6-digit OTP code
      const code = generateEmailCode();

      const hmacSecret = c.env.OTP_HMAC_SECRET;
      if (!hmacSecret) {
        log.error('OTP_HMAC_SECRET must be configured for email-code auth', {
          action: 'email_code_send',
        });
        return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
      }

      // Hash the code and get ChallengeStore in parallel (independent operations)
      const [codeHash, emailHash, challengeStore] = await Promise.all([
        hashEmailCode(code, email.toLowerCase(), otpSessionId, issuedAt, hmacSecret),
        hashEmail(email.toLowerCase()),
        getChallengeStoreByChallengeId(c.env, otpSessionId, getTenantIdFromContext(c)),
      ]);

      await challengeStore.storeChallengeRpc({
        id: `email_code:${otpSessionId}`,
        tenantId: getTenantIdFromContext(c),
        type: 'email_code',
        userId: user.id as string,
        challenge: codeHash, // Store hash, not plaintext
        ttl: EMAIL_CODE_TTL, // 5 minutes
        email: email.toLowerCase(),
        metadata: {
          email_hash: emailHash,
          otp_session_id: otpSessionId,
          issued_at: issuedAt,
          purpose: 'login',
          ...(Object.keys(customFieldValues).length > 0
            ? { custom_fields: customFieldValues }
            : {}),
        },
      });

      // Set OTP session cookie
      setCookie(c, OTP_SESSION_COOKIE, otpSessionId, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: EMAIL_CODE_TTL,
      });

      const fromEmail = c.env.EMAIL_FROM || 'noreply@authrim.dev';

      // Authentication-Info header for OTP AutoFill (Safari/iOS)
      // This enables domain-bound code verification for phishing protection
      const authenticationInfoHeader = `<${getRequestIssuer(c)}>; otpauth=email`;

      const delivery = await produceNotificationDelivery(c.env, {
        owner: { owner: 'tenant', tenantId: getTenantIdFromContext(c) },
        intentId: `email-code:${otpSessionId}`,
        outboxId: `notification:${otpSessionId}`,
        notificationKind: 'auth.email-code',
        idempotencyKey: `email-code:${otpSessionId}`,
        expiresAt: Math.floor(issuedAt / 1000) + EMAIL_CODE_TTL,
        payload: {
          channel: 'email',
          to: email,
          from: fromEmail,
          subject: 'Your Authrim verification code',
          body: getEmailCodeHtml({
            name: (user.name as string) || undefined,
            email,
            code,
            expiresInMinutes: EMAIL_CODE_TTL / 60,
            appName: 'Authrim',
            logoUrl: undefined,
          }),
          metadata: {
            // Plain text version for email clients that prefer it
            textBody: getEmailCodeText({
              name: (user.name as string) || undefined,
              email,
              code,
              expiresInMinutes: EMAIL_CODE_TTL / 60,
              appName: 'Authrim',
            }),
            // OTP AutoFill header for Safari/iOS
            headers: {
              'Authentication-Info': authenticationInfoHeader,
            },
          },
        },
      });

      if (delivery.delivery === 'permanent_failure') {
        log.error('Failed to send email code', {
          action: 'email_send',
        });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      return c.json({
        success: true,
        message: 'Verification code sent to your email',
        messageId: delivery.reference.intentId,
      });
    } catch (error) {
      const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
      if (writeFenceResponse) return writeFenceResponse;
      const unavailableResponse = createDataTemporarilyUnavailableResponse(c, error);
      if (unavailableResponse) return unavailableResponse;
      // PII Protection: Don't log full error (may contain email/user data)
      log.error('Email code send error', { action: 'send' }, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  });
}

/**
 * Verify Email Code (OTP)
 * POST /api/auth/email-code/verify
 *
 * Security: Uses constant-time wrapper to prevent timing-based user enumeration.
 */
export async function emailCodeVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('EMAIL-CODE');
  return constantTimeWrapper(async () => {
    try {
      const body = await c.req.json<{
        code: string;
        email: string;
      }>();

      const { code, email } = body;

      if (!code || !email) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'code and email' },
        });
      }

      // Validate code format (6 digits)
      if (!/^\d{6}$/.test(code)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Get OTP session ID from cookie
      const otpSessionId = getCookie(c, OTP_SESSION_COOKIE);

      if (!otpSessionId) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
      }

      // Get challenge from ChallengeStore (RPC)
      // Use otpSessionId-based sharding - same UUID always routes to same shard
      const challengeStore = await timeAuthRequestDiagnosticOperation(
        c,
        'auth_otp_challenge_route',
        () => getChallengeStoreByChallengeId(c.env, otpSessionId, getTenantIdFromContext(c))
      );

      let challengeData: {
        challenge: string;
        userId: string;
        email?: string;
        metadata?: {
          email_hash: string;
          otp_session_id: string;
          issued_at: number;
          purpose: string;
          custom_fields?: Record<string, unknown>;
        };
      };

      try {
        // Consume challenge atomically (includes existence, expiry, and consumed checks)
        // This replaces the previous getChallengeRpc + consumeChallengeRpc pattern
        challengeData = (await timeAuthRequestDiagnosticOperation(
          c,
          'auth_otp_challenge_consume',
          () =>
            challengeStore.consumeChallengeRpc({
              id: `email_code:${otpSessionId}`,
              tenantId: getTenantIdFromContext(c),
              type: 'email_code',
            })
        )) as typeof challengeData;
      } catch (error) {
        // Publish auth.email_code.failed event (non-blocking)
        const tenantIdForEvent = getTenantIdFromContext(c);
        publishEvent(c, {
          type: AUTH_EVENTS.EMAIL_CODE_FAILED,
          tenantId: tenantIdForEvent,
          data: {
            method: 'email_code',
            clientId: 'email-auth',
            errorCode: 'challenge_error',
          } satisfies AuthEventData,
        }).catch((err) => {
          log.error(
            'Failed to publish auth.email_code.failed event',
            { action: 'event_publish' },
            err as Error
          );
        });

        // Security: Return same generic error for all challenge-related failures
        // to prevent user enumeration via timing or error message differences.
        // Do NOT branch on error message content (e.g., 'not found', 'expired', 'already consumed')
        // as this can leak information about challenge state to attackers.
        // PII Protection: Don't log full error
        log.error('Challenge store error', { action: 'challenge_consume' }, error as Error);
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      // Verify session binding and email match
      if (challengeData.metadata?.otp_session_id !== otpSessionId) {
        return createErrorResponse(c, AR_ERROR_CODES.SESSION_INVALID_STATE);
      }
      if (challengeData.email?.toLowerCase() !== email.toLowerCase()) {
        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      // Parallel: verify the code hash and resolve the minimal OTP user projection.
      const tenantId = getTenantIdFromContext(c);
      const tenantD1 = true;
      const hmacSecret = c.env.OTP_HMAC_SECRET;
      if (!hmacSecret) {
        log.error('OTP_HMAC_SECRET must be configured for email-code verification', {
          action: 'email_code_verify',
        });
        return createErrorResponse(c, AR_ERROR_CODES.CONFIG_MISSING_SECRET);
      }
      const sessionTtlPromise = timeAuthRequestDiagnosticOperation(c, 'auth_otp_session_ttl', () =>
        resolveSessionTtl(c.env, tenantId, 'email_code')
      );
      let runtimeUsers: CanonicalRuntimeUserStore | null = null;
      let userLookupPromise: Promise<
        | { kind: 'tenant_d1'; context: OtpAccountCoreDataContext }
        | { kind: 'standard'; user: CanonicalOtpLoginUser | null }
      >;
      if (tenantD1) {
        userLookupPromise = timeAuthRequestDiagnosticOperation(
          c,
          'auth_otp_account_route_and_user',
          async () => ({
            kind: 'tenant_d1' as const,
            context: await resolveOtpAccountCoreDataContextByIdentifierFromHono(c, {
              indexKind: 'account_id',
              identifier: `account:${challengeData.userId}`,
              expectedAccountId: `account:${challengeData.userId}`,
              expectedLegacyUserId: challengeData.userId,
              trustedEmail: challengeData.email ?? email,
            }),
          })
        );
      } else {
        runtimeUsers = createCanonicalRuntimeUserStore(c, tenantId);
        userLookupPromise = runtimeUsers
          .findForOtpLogin(challengeData.userId, challengeData.email ?? email, {
            includeInactive: true,
          })
          .then((user) => ({ kind: 'standard' as const, user }));
      }

      const [codeVerification, userLookup] = await timeAuthRequestDiagnosticOperation(
        c,
        'auth_otp_hash_and_user',
        () =>
          Promise.all([
            verifyEmailCodeHash(
              code,
              email.toLowerCase(),
              otpSessionId,
              challengeData.metadata?.issued_at || 0,
              challengeData.challenge,
              hmacSecret
            ).then((valid) => ({ valid, verifiedAtMs: Date.now() })),
            userLookupPromise,
          ])
      );
      const runtimeUser =
        userLookup.kind === 'tenant_d1' ? userLookup.context.user : userLookup.user;

      if (!codeVerification.valid) {
        // Publish auth.email_code.failed event (non-blocking)
        publishEvent(c, {
          type: AUTH_EVENTS.EMAIL_CODE_FAILED,
          tenantId,
          data: {
            method: 'email_code',
            clientId: 'email-auth',
            errorCode: 'invalid_code',
          } satisfies AuthEventData,
        }).catch((err) => {
          log.error(
            'Failed to publish auth.email_code.failed event',
            { action: 'event_publish' },
            err as Error
          );
        });

        return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
      }

      if (!runtimeUser || runtimeUser.active !== 1) {
        log.warn('Canonical runtime user unavailable after account route resolution', {
          action: 'email_code_verify_user_read',
          routeLegacyUserMatches:
            userLookup.kind === 'tenant_d1'
              ? userLookup.context.legacyUserId === challengeData.userId
              : undefined,
          runtimeUserState: runtimeUser ? 'inactive' : 'missing',
        });
        // Publish auth.email_code.failed event (non-blocking)
        publishEvent(c, {
          type: AUTH_EVENTS.EMAIL_CODE_FAILED,
          tenantId,
          data: {
            method: 'email_code',
            clientId: 'email-auth',
            errorCode: 'user_inactive',
          } satisfies AuthEventData,
        }).catch((err) => {
          log.error(
            'Failed to publish auth.email_code.failed event',
            { action: 'event_publish' },
            err as Error
          );
        });

        return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
      }

      // Merge Core and PII data
      const user = {
        id: runtimeUser.id,
        email: runtimeUser.email || email.toLowerCase(),
        name: runtimeUser.name || null,
      };

      const now = codeVerification.verifiedAtMs;
      const authTime = Math.floor(now / 1000);
      const accountCoreAdapter =
        userLookup.kind === 'tenant_d1'
          ? ensureDatabaseAdapter(userLookup.context.coreDb, 'otp-account-core')
          : createAccountAuthContextFromHono(c, tenantId).coreAdapter;
      try {
        await timeAuthRequestDiagnosticOperation(c, 'auth_account_state_read', () =>
          ensureAccountAuthenticationState(c.env, tenantId, user.id, () =>
            findCanonicalAccountAuthenticationState(accountCoreAdapter, tenantId, user.id)
          )
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'account_authentication_not_allowed') {
          return c.json(
            {
              error: 'temporarily_unavailable',
              error_description: 'Authentication state unavailable.',
            },
            503,
            { 'Retry-After': '1' }
          );
        }
        return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
      }
      const customFields = challengeData.metadata?.custom_fields;
      if (customFields) {
        try {
          await persistRegistrationFieldValuesFromEnv(
            c.env,
            tenantId,
            challengeData.userId,
            customFields
          );
        } catch (persistError) {
          log.warn(
            'Failed to persist registration field values',
            { action: 'registration_fields_persist' },
            persistError as Error
          );
        }
      }

      // Check for existing anonymous session (for upgrade flow)
      // If the user is upgrading from anonymous, update the existing session
      // instead of creating a new one
      const existingSessionId = getCookie(c, 'authrim_session');
      let sessionId: string | undefined;
      let isAnonymousUpgrade = false;

      if (existingSessionId) {
        try {
          const { stub: existingSessionStore } = getSessionStoreBySessionId(
            c.env,
            existingSessionId,
            tenantId
          );
          const existingSession = (await existingSessionStore.getSessionRpc(
            existingSessionId
          )) as Session | null;

          // Check if this is an anonymous session for the same tenant
          if (existingSession?.data?.is_anonymous === true) {
            // SECURITY FIX: Prevent email takeover attack
            // For anonymous upgrade, only allow emails that:
            // 1. Are NOT already verified by another user, OR
            // 2. Belong to a user that was just created (email_verified=false)
            //
            // Attack scenario prevented:
            // 1. Attacker has anonymous session
            // 2. Attacker sends OTP to victim@example.com (existing user)
            // 3. Attacker obtains OTP via social engineering
            // 4. Without this check, attacker could claim victim's email
            if (runtimeUser.email_verified) {
              // Email is already verified by an existing user
              // Anonymous user cannot claim this email - they should login instead
              log.warn('Anonymous upgrade blocked: email already verified by existing user', {
                action: 'anon_upgrade_check',
              });
              // Don't set isAnonymousUpgrade - create new session for the existing user instead
            } else {
              // Email is new or unverified - safe to use for anonymous upgrade
              // Generate upgrade nonce for TOCTOU protection
              // This nonce must be consumed atomically during upgrade/complete
              const upgradeNonce = crypto.randomUUID();
              await existingSessionStore.updateSessionDataRpc(existingSessionId, {
                verified_email: user.email,
                verified_email_at: now,
                // Store the OTP user ID to verify consistency in upgrade/complete
                verified_email_user_id: user.id,
                // TOCTOU protection: nonce prevents double-upgrade via concurrent requests
                upgrade_nonce: upgradeNonce,
                // Keep anonymous status until upgrade/complete is called
              });
              sessionId = existingSessionId;
              isAnonymousUpgrade = true;
            }
          }
        } catch {
          // If session lookup fails, proceed with new session creation
        }
      }

      // Create new session if not an anonymous upgrade
      const sessionTtl = await sessionTtlPromise;
      if (!isAnonymousUpgrade) {
        try {
          const { stub: sessionStore, sessionId: newSessionId } =
            await timeAuthRequestDiagnosticOperation(c, 'auth_otp_session_route', () =>
              getSessionStoreForNewSession(c.env, getTenantIdFromContext(c))
            );
          sessionId = newSessionId;

          await timeAuthRequestDiagnosticOperation(c, 'auth_otp_session_create', () =>
            sessionStore.createSessionRpc(
              newSessionId,
              user.id as string,
              sessionTtl.seconds,
              {
                email: user.email,
                name: user.name,
                amr: ['otp'],
                acr: 'urn:mace:incommon:iap:bronze',
                authTime,
              },
              tenantId
            )
          );
        } catch (error) {
          // PII Protection: Don't log full error
          log.error('Failed to create session', { action: 'session_create' }, error as Error);
          return createErrorResponse(c, AR_ERROR_CODES.SESSION_STORE_ERROR);
        }
      }

      // Safety check - sessionId should always be assigned at this point
      if (!sessionId) {
        log.error('Unexpected state: sessionId not assigned', { action: 'session_check' });
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      // Tenant-D1 sessions record last-login state while registering with the user-scoped
      // revocation DO. Only an actually unverified email still needs a Core write, and that
      // write updates the contact point directly without re-reading or rewriting account metadata.
      // Standard storage keeps the legacy metadata update for compatibility.
      if (!tenantD1 || runtimeUser.email_verified !== 1) {
        const userUpdate = (
          userLookup.kind === 'tenant_d1'
            ? markOtpLoginEmailVerified(
                ensureDatabaseAdapter(userLookup.context.coreDb, 'otp-account-core'),
                tenantId,
                challengeData.userId,
                now
              )
            : runtimeUsers
              ? runtimeUsers.markEmailVerifiedAndTouchLastLogin(challengeData.userId, now)
              : Promise.reject(new Error('otp_runtime_user_store_unavailable'))
        ).catch((error: unknown) => {
          // PII Protection: Don't log full error
          log.error(
            'Failed to update user after OTP login',
            { action: 'user_update' },
            error as Error
          );
        });
        c.executionCtx.waitUntil(userUpdate);
      }

      // Clear OTP session cookie
      setCookie(c, OTP_SESSION_COOKIE, '', {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        maxAge: 0,
      });

      // Set authentication session cookie (only for new sessions, not anonymous upgrade)
      // SameSite is determined dynamically based on origin configuration
      if (!isAnonymousUpgrade) {
        setCookie(c, 'authrim_session', sessionId, {
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: getSessionCookieSameSite(c.env),
          maxAge: sessionTtl.seconds,
        });

        // Set browser state cookie for OIDC Session Management (NOT HttpOnly so JS can read it)
        const browserState = await generateBrowserState(sessionId);
        setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
          path: '/',
          secure: true,
          sameSite: getBrowserStateCookieSameSite(c.env),
          maxAge: sessionTtl.seconds,
        });
      }

      // Publish auth.email_code.succeeded event (non-blocking)
      publishEvent(c, {
        type: AUTH_EVENTS.EMAIL_CODE_SUCCEEDED,
        tenantId,
        data: {
          userId: user.id as string,
          method: 'email_code',
          clientId: 'email-auth', // Direct email auth has no OAuth client
          sessionId,
        } satisfies AuthEventData,
      }).catch((err) => {
        log.error(
          'Failed to publish auth.email_code.succeeded event',
          { action: 'event_publish' },
          err as Error
        );
      });

      // Publish session.user.created event (non-blocking)
      publishEvent(c, {
        type: SESSION_EVENTS.USER_CREATED,
        tenantId,
        data: {
          sessionId,
          userId: user.id as string,
          ttlSeconds: sessionTtl.seconds,
        } satisfies SessionEventData,
      }).catch((err) => {
        log.error(
          'Failed to publish session.user.created event',
          { action: 'event_publish' },
          err as Error
        );
      });

      // Write audit log for email code login (non-blocking)
      const ipAddress =
        c.req.header('CF-Connecting-IP') ||
        c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
        c.req.header('X-Real-IP') ||
        'unknown';
      const userAgent = c.req.header('User-Agent') || 'unknown';

      // Schedule audit log with waitUntil to ensure it completes after response
      const auditPromise = createAuditLog(c.env, {
        tenantId,
        userId: user.id as string,
        action: 'user.login',
        resource: 'session',
        resourceId: sessionId,
        ipAddress,
        userAgent,
        metadata: JSON.stringify({
          method: 'email_code',
          is_anonymous_upgrade: isAnonymousUpgrade,
        }),
        severity: 'info',
      }).catch((err) => {
        log.error(
          'Failed to create audit log for email code login',
          {
            action: 'audit_log',
          },
          err as Error
        );
      });
      c.executionCtx?.waitUntil(auditPromise);

      return c.json({
        success: true,
        sessionId,
        userId: user.id as string,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          email_verified: 1,
        },
      });
    } catch (error) {
      const writeFenceResponse = createTenantPlacementWriteFenceResponse(c, error);
      if (writeFenceResponse) return writeFenceResponse;
      const unavailableResponse = createDataTemporarilyUnavailableResponse(c, error);
      if (unavailableResponse) return unavailableResponse;
      // PII Protection: Don't log full error (may contain email/code data)
      log.error('Email code verify error', { action: 'verify' }, error as Error);
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  });
}

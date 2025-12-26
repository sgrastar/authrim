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
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  generateId,
  createAuthContextFromHono,
  createPIIContextFromHono,
  createErrorResponse,
  createRFCErrorResponse,
  AR_ERROR_CODES,
  RFC_ERROR_CODES,
  getPluginContext,
  generateBrowserState,
  BROWSER_STATE_COOKIE_NAME,
} from '@authrim/ar-lib-core';
import { getEmailCodeHtml, getEmailCodeText } from './utils/email/templates';
import {
  generateEmailCode,
  hashEmailCode,
  verifyEmailCodeHash,
  hashEmail,
} from './utils/email-code-utils';

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
  return constantTimeWrapper(async () => {
    try {
      const body = await c.req.json<{
        email: string;
        name?: string;
      }>();

      const { email, name } = body;

      if (!email) {
        return createRFCErrorResponse(c, RFC_ERROR_CODES.INVALID_REQUEST, 400, 'Email is required');
      }

      // Email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return createRFCErrorResponse(
          c,
          RFC_ERROR_CODES.INVALID_REQUEST,
          400,
          'Invalid email format'
        );
      }

      // Rate limiting check: 3 requests per 15 minutes per email via RPC
      const rateLimiterId = c.env.RATE_LIMITER.idFromName('email-code');
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

      // Check if user exists, if not create a new user via Repository
      // PII/Non-PII DB separation: email lookup uses PII DB, user creation uses both DBs
      const tenantId = getTenantIdFromContext(c);
      const authCtx = createAuthContextFromHono(c, tenantId);
      let user: { id: string; email: string; name: string | null } | null = null;

      // Search by email in PII DB
      if (c.env.DB_PII) {
        const piiCtx = createPIIContextFromHono(c, tenantId);
        const userPII = await piiCtx.piiRepositories.userPII.findByTenantAndEmail(
          tenantId,
          email.toLowerCase()
        );

        if (userPII) {
          // Verify user is active in Core DB
          const userCore = await authCtx.repositories.userCore.findById(userPII.id);
          if (userCore && userCore.is_active) {
            user = {
              id: userPII.id,
              email: userPII.email,
              name: userPII.name || null,
            };
          }
        }
      }

      if (!user) {
        const userId = generateId();
        const defaultName = name || null;
        const preferredUsername = email.split('@')[0];

        // Step 1: Create user in Core DB with pii_status='pending'
        await authCtx.repositories.userCore.createUser({
          id: userId,
          tenant_id: tenantId,
          email_verified: false,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'pending',
        });

        // Step 2: Create user in PII DB (if DB_PII is configured)
        if (c.env.DB_PII) {
          const piiCtx = createPIIContextFromHono(c, tenantId);
          try {
            await piiCtx.piiRepositories.userPII.createPII({
              id: userId,
              tenant_id: tenantId,
              email: email.toLowerCase(),
              name: defaultName,
              preferred_username: preferredUsername,
            });

            // Step 3: Update pii_status to 'active' (only on successful PII DB write)
            await authCtx.repositories.userCore.updatePIIStatus(userId, 'active');
          } catch (piiError: unknown) {
            // PII Protection: Don't log full error (may contain PII)
            console.error(
              '[EMAIL-CODE] Failed to create user in PII DB:',
              piiError instanceof Error ? piiError.name : 'Unknown error'
            );
            // Update pii_status to 'failed' to indicate PII DB write failure
            await authCtx.repositories.userCore
              .updatePIIStatus(userId, 'failed')
              .catch((statusError: unknown) => {
                console.error(
                  '[EMAIL-CODE] Failed to update pii_status to failed:',
                  statusError instanceof Error ? statusError.name : 'Unknown error'
                );
              });
            // Note: We continue with user creation - Core DB user exists, PII can be retried
          }
        } else {
          console.warn('[EMAIL-CODE] DB_PII not configured - user created with pii_status=pending');
        }

        user = { id: userId, email: email.toLowerCase(), name: defaultName || email.split('@')[0] };
      }

      // Generate OTP session ID for session binding
      const otpSessionId = crypto.randomUUID();
      const issuedAt = Date.now();

      // Generate 6-digit OTP code
      const code = generateEmailCode();

      // Get HMAC secret from environment (or generate one)
      const hmacSecret = c.env.OTP_HMAC_SECRET || c.env.ISSUER_URL;

      // Hash the code and get ChallengeStore in parallel (independent operations)
      const [codeHash, emailHash, challengeStore] = await Promise.all([
        hashEmailCode(code, email.toLowerCase(), otpSessionId, issuedAt, hmacSecret),
        hashEmail(email.toLowerCase()),
        getChallengeStoreByChallengeId(c.env, otpSessionId),
      ]);

      await challengeStore.storeChallengeRpc({
        id: `email_code:${otpSessionId}`,
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

      // Send email via Notifier Plugin
      const pluginCtx = getPluginContext(c);
      const emailNotifier = pluginCtx.registry.getNotifier('email');

      if (!emailNotifier) {
        // Development mode: no email notifier configured
        console.warn('[EMAIL-CODE] No email notifier plugin configured. Code:', code);
        return c.json({
          success: true,
          message: 'Verification code generated (email not sent - no notifier plugin configured)',
          code: code, // Only for development
        });
      }

      const fromEmail = c.env.EMAIL_FROM || 'noreply@authrim.dev';

      // Authentication-Info header for OTP AutoFill (Safari/iOS)
      // This enables domain-bound code verification for phishing protection
      const authenticationInfoHeader = `<${c.env.ISSUER_URL}>; otpauth=email`;

      const emailResult = await emailNotifier.send({
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
      });

      if (!emailResult.success) {
        // PII Protection: Don't log full error (may contain email details)
        console.error('[EMAIL-CODE] Failed to send email code:', emailResult.error);
        return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
      }

      return c.json({
        success: true,
        message: 'Verification code sent to your email',
        messageId: emailResult.messageId,
      });
    } catch (error) {
      // PII Protection: Don't log full error (may contain email/user data)
      console.error(
        'Email code send error:',
        error instanceof Error ? error.name : 'Unknown error'
      );
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  });
}

/**
 * Verify Email Code (OTP)
 * POST /api/auth/email-code/verify
 */
export async function emailCodeVerifyHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      code: string;
      email: string;
    }>();

    const { code, email } = body;

    if (!code || !email) {
      return createRFCErrorResponse(
        c,
        RFC_ERROR_CODES.INVALID_REQUEST,
        400,
        'Code and email are required'
      );
    }

    // Validate code format (6 digits)
    if (!/^\d{6}$/.test(code)) {
      return createRFCErrorResponse(c, RFC_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid code format');
    }

    // Get OTP session ID from cookie
    const otpSessionId = getCookie(c, OTP_SESSION_COOKIE);

    if (!otpSessionId) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
    }

    // Get challenge from ChallengeStore (RPC)
    // Use otpSessionId-based sharding - same UUID always routes to same shard
    const challengeStore = await getChallengeStoreByChallengeId(c.env, otpSessionId);

    let challengeData: {
      challenge: string;
      userId: string;
      email?: string;
      metadata?: {
        email_hash: string;
        otp_session_id: string;
        issued_at: number;
        purpose: string;
      };
    };

    try {
      // Consume challenge atomically (includes existence, expiry, and consumed checks)
      // This replaces the previous getChallengeRpc + consumeChallengeRpc pattern
      challengeData = (await challengeStore.consumeChallengeRpc({
        id: `email_code:${otpSessionId}`,
        type: 'email_code',
      })) as typeof challengeData;
    } catch (error) {
      // Security: Return same generic error for all challenge-related failures
      // to prevent user enumeration via timing or error message differences.
      // Do NOT branch on error message content (e.g., 'not found', 'expired', 'already consumed')
      // as this can leak information about challenge state to attackers.
      // PII Protection: Don't log full error
      console.error(
        'Challenge store error:',
        error instanceof Error ? error.name : 'Unknown error'
      );
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Verify session binding and email match
    if (challengeData.metadata?.otp_session_id !== otpSessionId) {
      return createErrorResponse(c, AR_ERROR_CODES.SESSION_INVALID_STATE);
    }
    if (challengeData.email?.toLowerCase() !== email.toLowerCase()) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    // Parallel: Verify code hash AND fetch user details from both DBs (independent operations)
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const hmacSecret = c.env.OTP_HMAC_SECRET || c.env.ISSUER_URL;

    // Create PII context only if DB_PII is configured
    const piiCtx = c.env.DB_PII ? createPIIContextFromHono(c, tenantId) : null;

    const [isValidCode, userCore, userPII] = await Promise.all([
      verifyEmailCodeHash(
        code,
        email.toLowerCase(),
        otpSessionId,
        challengeData.metadata?.issued_at || 0,
        challengeData.challenge,
        hmacSecret
      ),
      authCtx.repositories.userCore.findById(challengeData.userId),
      piiCtx
        ? piiCtx.piiRepositories.userPII.findById(challengeData.userId)
        : Promise.resolve(null),
    ]);

    if (!isValidCode) {
      return createErrorResponse(c, AR_ERROR_CODES.AUTH_INVALID_CODE);
    }

    if (!userCore || !userCore.is_active) {
      return createErrorResponse(c, AR_ERROR_CODES.USER_INVALID_CREDENTIALS);
    }

    // Merge Core and PII data
    const user = {
      id: userCore.id,
      email: userPII?.email || email.toLowerCase(),
      name: userPII?.name || null,
    };

    const now = Date.now();

    // Create session using SessionStore Durable Object (sharded) via RPC
    let sessionId: string;
    try {
      const { stub: sessionStore, sessionId: newSessionId } = await getSessionStoreForNewSession(
        c.env
      );
      sessionId = newSessionId;

      await sessionStore.createSessionRpc(
        newSessionId,
        user.id as string,
        24 * 60 * 60, // 24 hours in seconds
        {
          email: user.email,
          name: user.name,
          amr: ['otp'],
          acr: 'urn:mace:incommon:iap:bronze',
        }
      );
    } catch (error) {
      // PII Protection: Don't log full error
      console.error(
        'Failed to create session:',
        error instanceof Error ? error.name : 'Unknown error'
      );
      return createErrorResponse(c, AR_ERROR_CODES.SESSION_STORE_ERROR);
    }

    // Update user's email_verified and last_login_at in Core DB (fire-and-forget)
    // This is non-critical for the login flow - session is already created
    authCtx.coreAdapter
      .execute(
        'UPDATE users_core SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ?',
        [now, now, challengeData.userId]
      )
      .catch((error) => {
        // PII Protection: Don't log full error
        console.error(
          'Failed to update user login timestamp:',
          error instanceof Error ? error.name : 'Unknown error'
        );
      });

    // Clear OTP session cookie
    setCookie(c, OTP_SESSION_COOKIE, '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 0,
    });

    // Set authentication session cookie (HttpOnly for security)
    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None', // Needs None for OIDC Session Management cross-site iframe
      maxAge: 24 * 60 * 60, // 24 hours (matches session TTL)
    });

    // Set browser state cookie for OIDC Session Management (NOT HttpOnly so JS can read it)
    const browserState = await generateBrowserState(sessionId);
    setCookie(c, BROWSER_STATE_COOKIE_NAME, browserState, {
      path: '/',
      secure: true,
      sameSite: 'None', // Needs None for OIDC Session Management cross-site iframe
      maxAge: 24 * 60 * 60, // 24 hours (matches session TTL)
    });

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
    // PII Protection: Don't log full error (may contain email/code data)
    console.error(
      'Email code verify error:',
      error instanceof Error ? error.name : 'Unknown error'
    );
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

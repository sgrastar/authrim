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
 */

import { Context } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/shared';
import {
  getSessionStoreForNewSession,
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  generateId,
  createAuthContextFromHono,
  createPIIContextFromHono,
} from '@authrim/shared';
import { ResendEmailProvider } from './utils/email/resend-provider';
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
 * Send Email Code (OTP)
 * POST /api/auth/email-code/send
 */
export async function emailCodeSendHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      email: string;
      name?: string;
    }>();

    const { email, name } = body;

    if (!email) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Email is required',
        },
        400
      );
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid email format',
        },
        400
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
      return c.json(
        {
          error: 'rate_limit_exceeded',
          error_description: 'Too many code requests. Please try again later.',
          retry_after: rateLimitResult.retryAfter,
        },
        429
      );
    }

    // Check if user exists, if not create a new user via Repository
    // PII/Non-PII DB分離: email検索はPII DB、ユーザー作成は両DBに
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
        await piiCtx.piiRepositories.userPII.createPII({
          id: userId,
          tenant_id: tenantId,
          email: email.toLowerCase(),
          name: defaultName,
          preferred_username: preferredUsername,
        });

        // Step 3: Update pii_status to 'active'
        await authCtx.repositories.userCore.updatePIIStatus(userId, 'active');
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

    // Send email via Resend
    const resendApiKey = c.env.RESEND_API_KEY;
    if (!resendApiKey) {
      console.warn('RESEND_API_KEY not configured. Code:', code);
      // In development, return the code directly
      return c.json({
        success: true,
        message: 'Verification code generated (email not sent - RESEND_API_KEY not configured)',
        code: code, // Only for development
      });
    }

    const emailProvider = new ResendEmailProvider(resendApiKey);
    const fromEmail = c.env.EMAIL_FROM || 'noreply@authrim.dev';

    // Authentication-Info header for OTP AutoFill (Safari/iOS)
    // This enables domain-bound code verification for phishing protection
    const authenticationInfoHeader = `<${c.env.ISSUER_URL}>; otpauth=email`;

    const emailResult = await emailProvider.send({
      to: email,
      from: fromEmail,
      subject: 'Your Authrim verification code',
      html: getEmailCodeHtml({
        name: (user.name as string) || undefined,
        email,
        code,
        expiresInMinutes: EMAIL_CODE_TTL / 60,
        appName: 'Authrim',
        logoUrl: undefined,
      }),
      text: getEmailCodeText({
        name: (user.name as string) || undefined,
        email,
        code,
        expiresInMinutes: EMAIL_CODE_TTL / 60,
        appName: 'Authrim',
      }),
      headers: {
        'Authentication-Info': authenticationInfoHeader,
      },
    });

    if (!emailResult.success) {
      console.error('Failed to send email code:', emailResult.error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to send verification code',
        },
        500
      );
    }

    return c.json({
      success: true,
      message: 'Verification code sent to your email',
      messageId: emailResult.messageId,
    });
  } catch (error) {
    console.error('Email code send error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to send verification code',
      },
      500
    );
  }
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Code and email are required',
        },
        400
      );
    }

    // Validate code format (6 digits)
    if (!/^\d{6}$/.test(code)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid code format',
        },
        400
      );
    }

    // Get OTP session ID from cookie
    const otpSessionId = getCookie(c, OTP_SESSION_COOKIE);

    if (!otpSessionId) {
      return c.json(
        {
          error: 'invalid_session',
          error_description: 'Session expired or invalid. Please request a new code.',
        },
        400
      );
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Map specific errors to appropriate responses
      if (errorMessage.includes('not found') || errorMessage.includes('expired')) {
        return c.json({ error: 'invalid_code', error_description: 'Invalid or expired code' }, 400);
      }
      if (errorMessage.includes('already consumed')) {
        return c.json(
          { error: 'invalid_code', error_description: 'Code has already been used' },
          400
        );
      }
      console.error('Challenge store error:', error);
      return c.json({ error: 'server_error', error_description: 'Failed to verify code' }, 500);
    }

    // Verify session binding and email match
    if (challengeData.metadata?.otp_session_id !== otpSessionId) {
      return c.json(
        {
          error: 'session_mismatch',
          error_description: 'Session mismatch. Please request a new code.',
        },
        400
      );
    }
    if (challengeData.email?.toLowerCase() !== email.toLowerCase()) {
      return c.json({ error: 'invalid_code', error_description: 'Invalid code' }, 400);
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
      return c.json({ error: 'invalid_code', error_description: 'Invalid or expired code' }, 400);
    }

    if (!userCore || !userCore.is_active) {
      return c.json({ error: 'invalid_request', error_description: 'User not found' }, 400);
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
      console.error('Failed to create session:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to create session. Please try again.',
        },
        500
      );
    }

    // Update user's email_verified and last_login_at in Core DB (fire-and-forget)
    // This is non-critical for the login flow - session is already created
    authCtx.coreAdapter
      .execute(
        'UPDATE users_core SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ?',
        [now, now, challengeData.userId]
      )
      .catch((error) => {
        console.error('Failed to update user login timestamp:', error);
      });

    // Clear OTP session cookie
    setCookie(c, OTP_SESSION_COOKIE, '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 0,
    });

    // Set authentication session cookie
    setCookie(c, 'authrim_session', sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
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
    console.error('Email code verify error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to verify code',
      },
      500
    );
  }
}

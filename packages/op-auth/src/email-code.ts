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
import type { Env } from '@authrim/shared';
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

    // Rate limiting check: 3 requests per 15 minutes per email
    const rateLimiterId = c.env.RATE_LIMITER.idFromName('email-code');
    const rateLimiter = c.env.RATE_LIMITER.get(rateLimiterId);

    const rateLimitResponse = await rateLimiter.fetch('http://internal/increment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientIP: `email_code:${email.toLowerCase()}`,
        config: {
          windowSeconds: 15 * 60, // 15 minutes
          maxRequests: 3,
        },
      }),
    });

    const rateLimitResult = (await rateLimitResponse.json()) as {
      allowed: boolean;
      current: number;
      limit: number;
      resetAt: number;
      retryAfter: number;
    };

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

    // Check if user exists, if not create a new user
    let user = await c.env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?')
      .bind(email.toLowerCase())
      .first();

    if (!user) {
      const userId = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);

      // Create user with minimal profile data
      const defaultName = name || null;
      const preferredUsername = email.split('@')[0];

      await c.env.DB.prepare(
        `INSERT INTO users (
          id, email, name, preferred_username, email_verified, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
        .bind(userId, email.toLowerCase(), defaultName, preferredUsername, now, now)
        .run();

      user = { id: userId, email: email.toLowerCase(), name: name || email.split('@')[0] };
    }

    // Generate OTP session ID for session binding
    const otpSessionId = crypto.randomUUID();
    const issuedAt = Date.now();

    // Generate 6-digit OTP code
    const code = generateEmailCode();

    // Get HMAC secret from environment (or generate one)
    const hmacSecret = c.env.OTP_HMAC_SECRET || c.env.ISSUER_URL;

    // Hash the code for storage
    const codeHash = await hashEmailCode(
      code,
      email.toLowerCase(),
      otpSessionId,
      issuedAt,
      hmacSecret
    );
    const emailHash = await hashEmail(email.toLowerCase());

    // Store in ChallengeStore DO with TTL (5 minutes)
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    await challengeStore.fetch(
      new Request('https://challenge-store/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        }),
      })
    );

    // Set OTP session cookie
    setCookie(c, OTP_SESSION_COOKIE, otpSessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: EMAIL_CODE_TTL,
    });

    // Get domain from ISSUER_URL for Safari autofill
    const issuerUrl = new URL(c.env.ISSUER_URL);
    const domain = issuerUrl.hostname;

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
        domain,
        logoUrl: undefined,
      }),
      text: getEmailCodeText({
        name: (user.name as string) || undefined,
        email,
        code,
        expiresInMinutes: EMAIL_CODE_TTL / 60,
        appName: 'Authrim',
        domain,
      }),
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

    // Get challenge from ChallengeStore
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

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
      // Get challenge info first (without consuming)
      const getResponse = await challengeStore.fetch(
        new Request(`https://challenge-store/challenge/email_code:${otpSessionId}`, {
          method: 'GET',
        })
      );

      if (!getResponse.ok) {
        return c.json(
          {
            error: 'invalid_code',
            error_description: 'Invalid or expired code',
          },
          400
        );
      }

      const challengeInfo = (await getResponse.json()) as {
        userId: string;
        consumed: boolean;
        expiresAt: number;
      };

      if (challengeInfo.consumed) {
        return c.json(
          {
            error: 'invalid_code',
            error_description: 'Code has already been used',
          },
          400
        );
      }

      // Now consume the challenge atomically
      const consumeResponse = await challengeStore.fetch(
        new Request('https://challenge-store/challenge/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `email_code:${otpSessionId}`,
            type: 'email_code',
          }),
        })
      );

      if (!consumeResponse.ok) {
        const error = (await consumeResponse.json()) as { error_description?: string };
        return c.json(
          {
            error: 'invalid_code',
            error_description: error.error_description || 'Invalid or expired code',
          },
          400
        );
      }

      challengeData = (await consumeResponse.json()) as typeof challengeData;
    } catch (error) {
      console.error('Challenge store error:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to verify code',
        },
        500
      );
    }

    // Verify session binding
    if (challengeData.metadata?.otp_session_id !== otpSessionId) {
      return c.json(
        {
          error: 'session_mismatch',
          error_description: 'Session mismatch. Please request a new code.',
        },
        400
      );
    }

    // Verify email matches
    if (challengeData.email?.toLowerCase() !== email.toLowerCase()) {
      return c.json(
        {
          error: 'invalid_code',
          error_description: 'Invalid code',
        },
        400
      );
    }

    // Verify the code hash
    const hmacSecret = c.env.OTP_HMAC_SECRET || c.env.ISSUER_URL;
    const isValidCode = await verifyEmailCodeHash(
      code,
      email.toLowerCase(),
      otpSessionId,
      challengeData.metadata?.issued_at || 0,
      challengeData.challenge,
      hmacSecret
    );

    if (!isValidCode) {
      return c.json(
        {
          error: 'invalid_code',
          error_description: 'Invalid or expired code',
        },
        400
      );
    }

    // Get user details
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(challengeData.userId)
      .first();

    if (!user) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'User not found',
        },
        400
      );
    }

    const now = Date.now();

    // Create session using SessionStore Durable Object
    const sessionId = crypto.randomUUID();
    const sessionStoreId = c.env.SESSION_STORE.idFromName(sessionId);
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    try {
      await sessionStore.fetch(
        new Request(`https://session-store/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            userId: user.id,
            email: user.email,
            name: user.name,
            expiresAt: now + 24 * 60 * 60 * 1000, // 24 hours
          }),
        })
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

    // Update user's email_verified and last_login_at
    await c.env.DB.prepare(
      'UPDATE users SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ?'
    )
      .bind(now, now, challengeData.userId)
      .run();

    // Clear OTP session cookie
    setCookie(c, OTP_SESSION_COOKIE, '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 0,
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

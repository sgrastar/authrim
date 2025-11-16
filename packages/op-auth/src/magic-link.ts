/**
 * Magic Link Authentication Handler
 * Passwordless authentication via email magic links
 */

import { Context } from 'hono';
import type { Env } from '@enrai/shared';
import { ResendEmailProvider } from './utils/email/resend-provider';
import { getMagicLinkEmailHtml, getMagicLinkEmailText } from './utils/email/templates';

const MAGIC_LINK_TTL = 15 * 60; // 15 minutes in seconds

/**
 * Send Magic Link email
 * POST /auth/magic-link/send
 */
export async function magicLinkSendHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      email: string;
      name?: string;
      redirect_uri?: string;
    }>();

    const { email, name, redirect_uri } = body;

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
    const rateLimitKey = `magic_link_rate:${email}`;
    const rateLimitData = await c.env.RATE_LIMIT?.get(rateLimitKey, 'json');

    if (rateLimitData) {
      const { count, resetAt } = rateLimitData as { count: number; resetAt: number };
      if (count >= 3 && Date.now() < resetAt) {
        return c.json(
          {
            error: 'rate_limit_exceeded',
            error_description: 'Too many magic link requests. Please try again later.',
            retry_after: Math.ceil((resetAt - Date.now()) / 1000),
          },
          429
        );
      }
    }

    // Check if user exists, if not create a new user
    let user = await c.env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?')
      .bind(email)
      .first();

    if (!user) {
      const userId = crypto.randomUUID();
      const now = Date.now();

      await c.env.DB.prepare(
        `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      )
        .bind(userId, email, name || email.split('@')[0], now, now)
        .run();

      user = { id: userId, email, name: name || email.split('@')[0] };
    }

    // Generate secure magic link token
    const token = crypto.randomUUID();
    const now = Date.now();

    // Store token in ChallengeStore DO with TTL (15 minutes)
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    await challengeStore.fetch(
      new Request('https://challenge-store/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `magic_link:${token}`,
          type: 'magic_link',
          userId: user.id as string,
          challenge: token, // Token is the challenge value
          ttl: MAGIC_LINK_TTL, // 15 minutes
          email,
          redirectUri: redirect_uri || undefined,
        }),
      })
    );

    // Construct magic link URL
    const issuerUrl = new URL(c.env.ISSUER_URL);
    const magicLinkUrl = new URL('/auth/magic-link/verify', issuerUrl);
    magicLinkUrl.searchParams.set('token', token);
    if (redirect_uri) {
      magicLinkUrl.searchParams.set('redirect_uri', redirect_uri);
    }

    // Send email via Resend
    const resendApiKey = c.env.RESEND_API_KEY;
    if (!resendApiKey) {
      console.warn('RESEND_API_KEY not configured. Magic link URL:', magicLinkUrl.toString());
      // In development, return the magic link URL directly
      return c.json({
        success: true,
        message: 'Magic link generated (email not sent - RESEND_API_KEY not configured)',
        magic_link_url: magicLinkUrl.toString(), // Only for development
      });
    }

    const emailProvider = new ResendEmailProvider(resendApiKey);
    const fromEmail = c.env.EMAIL_FROM || 'noreply@enrai.dev';

    const emailResult = await emailProvider.send({
      to: email,
      from: fromEmail,
      subject: 'Sign in to Enrai',
      html: getMagicLinkEmailHtml({
        name: (user.name as string) || undefined,
        email,
        magicLink: magicLinkUrl.toString(),
        expiresInMinutes: MAGIC_LINK_TTL / 60,
        appName: 'Enrai',
        logoUrl: undefined, // TODO: Add logo URL
      }),
      text: getMagicLinkEmailText({
        name: (user.name as string) || undefined,
        email,
        magicLink: magicLinkUrl.toString(),
        expiresInMinutes: MAGIC_LINK_TTL / 60,
        appName: 'Enrai',
      }),
    });

    if (!emailResult.success) {
      console.error('Failed to send magic link email:', emailResult.error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to send magic link email',
        },
        500
      );
    }

    // Update rate limit counter
    const rateLimitResetAt = Date.now() + MAGIC_LINK_TTL * 1000;
    const newRateLimitData = {
      count: rateLimitData ? (rateLimitData as any).count + 1 : 1,
      resetAt: rateLimitResetAt,
    };
    await c.env.RATE_LIMIT?.put(rateLimitKey, JSON.stringify(newRateLimitData), {
      expirationTtl: MAGIC_LINK_TTL,
    });

    return c.json({
      success: true,
      message: 'Magic link sent to your email',
      messageId: emailResult.messageId,
    });
  } catch (error) {
    console.error('Magic link send error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to send magic link',
      },
      500
    );
  }
}

/**
 * Verify Magic Link token and create session
 * GET /auth/magic-link/verify
 */
export async function magicLinkVerifyHandler(c: Context<{ Bindings: Env }>) {
  try {
    const token = c.req.query('token');
    const redirect_uri = c.req.query('redirect_uri');

    if (!token) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Token is required',
        },
        400
      );
    }

    // Consume token from ChallengeStore DO (atomic operation)
    // This prevents parallel replay attacks
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    let userId: string;
    let email: string;
    let storedRedirectUri: string | undefined;
    try {
      const consumeResponse = await challengeStore.fetch(
        new Request('https://challenge-store/challenge/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `magic_link:${token}`,
            type: 'magic_link',
            challenge: token,
          }),
        })
      );

      if (!consumeResponse.ok) {
        const error = (await consumeResponse.json()) as { error_description?: string };
        return c.json(
          {
            error: 'invalid_token',
            error_description: error.error_description || 'Magic link token is invalid or expired',
          },
          400
        );
      }

      const challengeData = (await consumeResponse.json()) as {
        challenge: string;
        userId: string;
        email?: string;
        redirectUri?: string;
      };
      userId = challengeData.userId;
      email = challengeData.email || '';
      storedRedirectUri = challengeData.redirectUri;
    } catch (error) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to consume magic link token',
        },
        500
      );
    }

    // Get user details
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();

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

    // Step 1: Create session using SessionStore Durable Object (FIRST)
    // If this fails, token remains valid and user can retry
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

    // Step 2: Update user's email_verified and last_login_at
    // If this fails, session exists but email not verified - acceptable state
    await c.env.DB.prepare(
      'UPDATE users SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ?'
    )
      .bind(now, now, userId)
      .run();

    // Note: Challenge token is already consumed by ChallengeStore DO (atomic operation)
    // No need to explicitly delete - consumed challenges are auto-cleaned by DO

    // If redirect_uri provided, redirect to it with session
    if (redirect_uri) {
      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('session_id', sessionId);
      return c.redirect(redirectUrl.toString());
    }

    // Otherwise return JSON response
    return c.json({
      success: true,
      sessionId,
      userId,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        email_verified: 1,
      },
    });
  } catch (error) {
    console.error('Magic link verify error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to verify magic link',
      },
      500
    );
  }
}

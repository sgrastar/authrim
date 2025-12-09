/**
 * ITP-Compliant Session Management API
 *
 * Provides session token issuance and verification for handling ITP (Intelligent Tracking Prevention)
 * restrictions in Safari and other privacy-focused browsers.
 *
 * Endpoints:
 * - POST /auth/session/token - Issue short-lived single-use token
 * - POST /auth/session/verify - Verify token and create RP session
 * - GET /session/status - Check session validity
 * - POST /session/refresh - Extend session expiration (Active TTL)
 */

import { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, Session } from '@authrim/shared';
import {
  generateCheckSessionIframeHtml,
  getSessionStoreBySessionId,
  isShardedSessionId,
} from '@authrim/shared';

/**
 * Issue a short-lived session token (5 minute TTL, single-use)
 * POST /auth/session/token
 *
 * This token can be used to establish a session on an RP domain,
 * bypassing ITP restrictions on third-party cookies.
 */
export async function issueSessionTokenHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get session from cookie
    const sessionId = getCookie(c, 'authrim_session');

    if (!sessionId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'No active session found',
        },
        401
      );
    }

    // Verify session exists in SessionStore (sharded)
    if (!isShardedSessionId(sessionId)) {
      return c.json(
        {
          error: 'session_not_found',
          error_description: 'Session has expired or is invalid',
        },
        401
      );
    }

    const sessionStore = await getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (!session) {
      return c.json(
        {
          error: 'session_not_found',
          error_description: 'Session has expired or is invalid',
        },
        401
      );
    }

    // Generate short-lived token
    const token = crypto.randomUUID();

    // Store token in ChallengeStore DO with 5 minute TTL
    // This provides atomic single-use guarantee (prevents race conditions)
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    await challengeStore.fetch(
      new Request('https://challenge-store/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `session_token:${token}`,
          type: 'session_token',
          userId: session.userId,
          challenge: token,
          ttl: 5 * 60, // 5 minutes
          metadata: {
            sessionId: session.id,
          },
        }),
      })
    );

    return c.json({
      token,
      expires_in: 300, // 5 minutes in seconds
      session_id: session.id,
    });
  } catch (error) {
    console.error('Issue session token error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to issue session token',
      },
      500
    );
  }
}

/**
 * Verify session token and create RP session
 * POST /auth/session/verify
 *
 * Validates a single-use token and creates a new session for the RP domain.
 */
export async function verifySessionTokenHandler(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<{
      token: string;
      rp_origin?: string;
    }>();

    const { token, rp_origin } = body;

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
    // This prevents race conditions and ensures single-use
    const challengeStoreId = c.env.CHALLENGE_STORE.idFromName('global');
    const challengeStore = c.env.CHALLENGE_STORE.get(challengeStoreId);

    let sessionId: string;
    let userId: string;
    try {
      const consumeResponse = await challengeStore.fetch(
        new Request('https://challenge-store/challenge/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `session_token:${token}`,
            type: 'session_token',
            challenge: token,
          }),
        })
      );

      if (!consumeResponse.ok) {
        const error = (await consumeResponse.json()) as { error_description?: string };
        return c.json(
          {
            error: 'invalid_token',
            error_description:
              error.error_description || 'Token not found, expired, or already used',
          },
          401
        );
      }

      const challengeData = (await consumeResponse.json()) as {
        challenge: string;
        userId: string;
        metadata?: {
          sessionId: string;
        };
      };
      userId = challengeData.userId;
      sessionId = challengeData.metadata?.sessionId || '';
    } catch (error) {
      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to verify session token',
        },
        500
      );
    }

    // Verify the original session still exists (sharded)
    if (!isShardedSessionId(sessionId)) {
      return c.json(
        {
          error: 'session_expired',
          error_description: 'Original session has expired',
        },
        401
      );
    }

    const sessionStore = await getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (!session) {
      return c.json(
        {
          error: 'session_expired',
          error_description: 'Original session has expired',
        },
        401
      );
    }

    // Create a new session for the RP domain (if rp_origin provided)
    // This allows the RP to have its own session cookie
    let rpSessionId = session.id;

    if (rp_origin) {
      // Create new session linked to the same user via RPC
      try {
        const newSession = (await sessionStore.createSessionRpc(
          crypto.randomUUID(), // Generate new session ID
          session.userId,
          86400, // 24 hours TTL
          {
            rpOrigin: rp_origin,
            parentSessionId: session.id,
          }
        )) as Session;
        rpSessionId = newSession.id;
      } catch (error) {
        console.warn('Failed to create RP session:', error);
        // Fall back to original session ID
      }
    }

    return c.json({
      session_id: rpSessionId,
      user_id: session.userId,
      expires_at: session.expiresAt,
      verified: true,
    });
  } catch (error) {
    console.error('Verify session token error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to verify session token',
      },
      500
    );
  }
}

/**
 * Check session status
 * GET /session/status
 *
 * Validates session from cookie and returns status.
 * Alternative to iframe-based session checking for ITP compatibility.
 */
export async function sessionStatusHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get session from cookie
    const sessionId = getCookie(c, 'authrim_session');

    if (!sessionId) {
      return c.json(
        {
          active: false,
          error: 'no_session',
        },
        200
      );
    }

    // Check session in SessionStore (sharded)
    if (!isShardedSessionId(sessionId)) {
      return c.json(
        {
          active: false,
          error: 'session_expired',
        },
        200
      );
    }

    const sessionStore = await getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;

    if (!session) {
      return c.json(
        {
          active: false,
          error: 'session_expired',
        },
        200
      );
    }

    // Check if session is expired
    if (session.expiresAt <= Date.now()) {
      return c.json(
        {
          active: false,
          error: 'session_expired',
        },
        200
      );
    }

    return c.json({
      active: true,
      session_id: session.id,
      user_id: session.userId,
      expires_at: session.expiresAt,
      created_at: session.createdAt,
    });
  } catch (error) {
    console.error('Session status error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check session status',
      },
      500
    );
  }
}

/**
 * Refresh session (Active TTL)
 * POST /session/refresh
 *
 * Extends session expiration time to implement Active TTL.
 * The session is extended each time the user is active.
 */
export async function refreshSessionHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get session from cookie or body
    let sessionId = getCookie(c, 'authrim_session');

    // Get extension duration (default: 1 hour)
    let extendSeconds = 3600; // Default: 1 hour

    if (!sessionId) {
      const body = await c.req.json<{ session_id?: string; extend_seconds?: number }>();
      sessionId = body.session_id;
      extendSeconds = body.extend_seconds || 3600;
    } else {
      // If we have sessionId from cookie, still try to get extend_seconds from body
      try {
        const body = await c.req.json<{ extend_seconds?: number }>();
        extendSeconds = body.extend_seconds || 3600;
      } catch {
        // Body is optional if session_id comes from cookie
        extendSeconds = 3600;
      }
    }

    if (!sessionId) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Session ID is required',
        },
        400
      );
    }

    // Validate extension duration (max 24 hours)
    if (extendSeconds > 86400 || extendSeconds < 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Extension duration must be between 0 and 86400 seconds',
        },
        400
      );
    }

    // Extend session in SessionStore (sharded)
    if (!isShardedSessionId(sessionId)) {
      return c.json(
        {
          error: 'session_not_found',
          error_description: 'Session has expired or is invalid',
        },
        401
      );
    }

    const sessionStore = await getSessionStoreBySessionId(c.env, sessionId);
    const session = (await sessionStore.extendSessionRpc(
      sessionId,
      extendSeconds
    )) as Session | null;

    if (!session) {
      return c.json(
        {
          error: 'session_not_found',
          error_description: 'Session not found or has expired',
        },
        404
      );
    }

    return c.json({
      session_id: session.id,
      user_id: session.userId,
      expires_at: session.expiresAt,
      extended_by: extendSeconds,
      message: 'Session extended successfully',
    });
  } catch (error) {
    console.error('Refresh session error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to refresh session',
      },
      500
    );
  }
}

/**
 * OIDC Session Management - Check Session Iframe
 * GET /session/check
 *
 * Returns an HTML page that can be loaded in an iframe by the RP
 * to monitor session state changes using postMessage.
 *
 * https://openid.net/specs/openid-connect-session-1_0.html#OPiframe
 */
export async function checkSessionIframeHandler(c: Context<{ Bindings: Env }>) {
  const issuerUrl = c.env.ISSUER_URL;
  const html = generateCheckSessionIframeHtml(issuerUrl);

  // Set appropriate headers for iframe embedding
  // Note: We need to allow framing for this specific endpoint
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Allow framing from any origin (RPs need to embed this)
      'X-Frame-Options': 'ALLOWALL',
      // CSP that allows inline scripts (needed for the session check logic)
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors *;",
      // Cache for a short time
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}

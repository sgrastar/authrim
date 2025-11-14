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
import type { Env } from '@enrai/shared';

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
    const sessionId = getCookie(c, 'enrai_session');

    if (!sessionId) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'No active session found',
        },
        401
      );
    }

    // Verify session exists in SessionStore
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionResponse = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionId}`, {
        method: 'GET',
      })
    );

    if (!sessionResponse.ok) {
      return c.json(
        {
          error: 'session_not_found',
          error_description: 'Session has expired or is invalid',
        },
        401
      );
    }

    const session = (await sessionResponse.json()) as {
      id: string;
      userId: string;
      expiresAt: number;
      createdAt: number;
    };

    // Generate short-lived token
    const token = crypto.randomUUID();
    const tokenKey = `session_token:${token}`;

    // Store token in KV with 5 minute TTL
    const tokenData = {
      sessionId: session.id,
      userId: session.userId,
      used: false,
      createdAt: Date.now(),
    };

    // Use STATE_STORE as fallback if KV is not configured
    const kvStore = c.env.KV || c.env.STATE_STORE;
    await kvStore.put(tokenKey, JSON.stringify(tokenData), {
      expirationTtl: 5 * 60, // 5 minutes
    });

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

    // Get token data from KV
    const tokenKey = `session_token:${token}`;
    const kvStore = c.env.KV || c.env.STATE_STORE;
    const tokenDataStr = await kvStore.get(tokenKey);

    if (!tokenDataStr) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Token not found or has expired',
        },
        401
      );
    }

    const tokenData = JSON.parse(tokenDataStr) as {
      sessionId: string;
      userId: string;
      used: boolean;
      createdAt: number;
    };

    // Check if token has already been used (single-use)
    if (tokenData.used) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Token has already been used',
        },
        401
      );
    }

    // Mark token as used
    tokenData.used = true;
    await kvStore.put(tokenKey, JSON.stringify(tokenData), {
      expirationTtl: 60, // Keep for 1 minute for audit
    });

    // Verify the original session still exists
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionResponse = await sessionStore.fetch(
      new Request(`https://session-store/session/${tokenData.sessionId}`, {
        method: 'GET',
      })
    );

    if (!sessionResponse.ok) {
      return c.json(
        {
          error: 'session_expired',
          error_description: 'Original session has expired',
        },
        401
      );
    }

    const session = (await sessionResponse.json()) as {
      id: string;
      userId: string;
      expiresAt: number;
      createdAt: number;
    };

    // Create a new session for the RP domain (if rp_origin provided)
    // This allows the RP to have its own session cookie
    let rpSessionId = session.id;

    if (rp_origin) {
      // Create new session linked to the same user
      const createResponse = await sessionStore.fetch(
        new Request('https://session-store/session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: session.userId,
            ttl: 86400, // 24 hours
            data: {
              rpOrigin: rp_origin,
              parentSessionId: session.id,
            },
          }),
        })
      );

      if (createResponse.ok) {
        const newSession = (await createResponse.json()) as { id: string };
        rpSessionId = newSession.id;
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
    const sessionId = getCookie(c, 'enrai_session');

    if (!sessionId) {
      return c.json(
        {
          active: false,
          error: 'no_session',
        },
        200
      );
    }

    // Check session in SessionStore
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const sessionResponse = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionId}`, {
        method: 'GET',
      })
    );

    if (!sessionResponse.ok) {
      return c.json(
        {
          active: false,
          error: 'session_expired',
        },
        200
      );
    }

    const session = (await sessionResponse.json()) as {
      id: string;
      userId: string;
      expiresAt: number;
      createdAt: number;
    };

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
    let sessionId = getCookie(c, 'enrai_session');

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

    // Extend session in SessionStore
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    const extendResponse = await sessionStore.fetch(
      new Request(`https://session-store/session/${sessionId}/extend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          seconds: extendSeconds,
        }),
      })
    );

    if (!extendResponse.ok) {
      if (extendResponse.status === 404) {
        return c.json(
          {
            error: 'session_not_found',
            error_description: 'Session not found or has expired',
          },
          404
        );
      }

      return c.json(
        {
          error: 'server_error',
          error_description: 'Failed to extend session',
        },
        500
      );
    }

    const session = (await extendResponse.json()) as {
      id: string;
      userId: string;
      expiresAt: number;
      createdAt: number;
    };

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

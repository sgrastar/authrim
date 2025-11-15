/**
 * Logout Functionality
 *
 * Implements OpenID Connect logout mechanisms:
 * - Front-channel logout (GET /logout)
 * - Back-channel logout (POST /logout/backchannel) - RFC 8725
 *
 * Front-channel: Browser-initiated logout with redirect
 * Back-channel: Server-to-server logout notification
 */

import { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '@enrai/shared';
import { timingSafeEqual } from '@enrai/shared';
import * as jose from 'jose';

/**
 * Front-channel Logout
 * GET /logout
 *
 * Handles browser-initiated logout requests.
 * Invalidates the user's session and redirects to the post-logout URI.
 *
 * Query Parameters:
 * - id_token_hint: ID token issued to the RP
 * - post_logout_redirect_uri: Where to redirect after logout
 * - state: Opaque value to maintain state
 */
export async function frontChannelLogoutHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Get query parameters
    const idTokenHint = c.req.query('id_token_hint');
    const postLogoutRedirectUri = c.req.query('post_logout_redirect_uri');
    const state = c.req.query('state');

    let userId: string | undefined;
    let clientId: string | undefined;

    // Validate and parse ID token if provided
    if (idTokenHint) {
      try {
        // Get signing key from KeyManager
        const keyManagerId = c.env.KEY_MANAGER.idFromName('global');
        const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

        const jwksResponse = await keyManager.fetch(
          new Request('https://key-manager/jwks', {
            method: 'GET',
          })
        );

        if (!jwksResponse.ok) {
          throw new Error('Failed to fetch JWKS');
        }

        const jwks = (await jwksResponse.json()) as jose.JSONWebKeySet;

        // Create a local JWKS resolver
        const getKey = async () => {
          // Return the first key from JWKS (in production, match by kid)
          const key = jwks.keys[0];
          if (!key) {
            throw new Error('No keys in JWKS');
          }
          return await jose.importJWK(key);
        };

        // Verify ID token
        const { payload } = await jose.jwtVerify(idTokenHint, await getKey(), {
          issuer: c.env.ISSUER_URL,
          algorithms: ['RS256'],
        });

        userId = payload.sub;
        clientId = payload.aud as string;
      } catch (error) {
        console.error('ID token validation error:', error);
        // Continue with logout even if token validation fails
      }
    }

    // Get session from cookie
    const sessionId = getCookie(c, 'enrai_session');

    if (sessionId) {
      // Invalidate session in SessionStore
      const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
      const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

      const deleteResponse = await sessionStore.fetch(
        new Request(`https://session-store/session/${sessionId}`, {
          method: 'DELETE',
        })
      );

      if (!deleteResponse.ok) {
        console.warn('Failed to delete session:', sessionId);
      }

      // If we have userId from token or session, we could do additional cleanup
      if (userId) {
        // Optional: Trigger back-channel logout to all RPs
        // This would notify other RPs that this user has logged out
        console.log(`User ${userId} logged out from client ${clientId}`);
      }
    }

    // Validate post_logout_redirect_uri if provided
    if (postLogoutRedirectUri && clientId) {
      // Get client configuration
      const client = await c.env.DB.prepare(
        'SELECT redirect_uris FROM oauth_clients WHERE client_id = ?'
      )
        .bind(clientId)
        .first();

      if (client) {
        const redirectUris = JSON.parse(client.redirect_uris as string) as string[];

        // Check if post_logout_redirect_uri is registered
        if (!redirectUris.includes(postLogoutRedirectUri)) {
          return c.json(
            {
              error: 'invalid_request',
              error_description: 'post_logout_redirect_uri is not registered for this client',
            },
            400
          );
        }
      }
    }

    // Build redirect URL
    let redirectUrl = postLogoutRedirectUri || `${c.env.ISSUER_URL}/logged-out`;

    if (state && postLogoutRedirectUri) {
      const url = new URL(redirectUrl);
      url.searchParams.set('state', state);
      redirectUrl = url.toString();
    }

    // Clear session cookie
    setCookie(c, 'enrai_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 0,
    });

    // Redirect to post-logout URI
    return c.redirect(redirectUrl, 302);
  } catch (error) {
    console.error('Front-channel logout error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to process logout request',
      },
      500
    );
  }
}

/**
 * Back-channel Logout
 * POST /logout/backchannel
 *
 * Handles server-to-server logout notifications per RFC 8725.
 * Allows an RP to notify the OP that a user has logged out.
 *
 * Request Body (application/x-www-form-urlencoded):
 * - logout_token: JWT containing logout claims
 *
 * Logout Token Claims:
 * - iss: Issuer identifier
 * - sub: Subject identifier (user ID)
 * - aud: Client ID
 * - iat: Issued at
 * - jti: Unique identifier
 * - events: { "http://schemas.openid.net/event/backchannel-logout": {} }
 * - sid: Session ID (optional)
 */
export async function backChannelLogoutHandler(c: Context<{ Bindings: Env }>) {
  try {
    // Parse form data
    const body = await c.req.parseBody();
    const logoutToken = body['logout_token'];

    if (!logoutToken || typeof logoutToken !== 'string') {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'logout_token is required',
        },
        400
      );
    }

    // Validate client authentication (using HTTP Basic Auth or client assertion)
    const authHeader = c.req.header('Authorization');
    let clientId: string | undefined;

    if (authHeader?.startsWith('Basic ')) {
      // HTTP Basic Authentication
      const credentials = atob(authHeader.substring(6));
      const [id, secret] = credentials.split(':');

      // Verify client credentials
      const client = await c.env.DB.prepare(
        'SELECT client_id, client_secret FROM oauth_clients WHERE client_id = ?'
      )
        .bind(id)
        .first();

      // Use timing-safe comparison to prevent timing attacks
      if (
        !client ||
        !client.client_secret ||
        !timingSafeEqual(client.client_secret as string, secret)
      ) {
        return c.json(
          {
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          },
          401
        );
      }

      clientId = id;
    } else {
      // For now, allow unauthenticated back-channel logout for testing
      // In production, this should require proper client authentication
      console.warn('Back-channel logout called without client authentication');
    }

    // Verify logout token
    let logoutClaims;
    try {
      // Get signing key from KeyManager
      const keyManagerId = c.env.KEY_MANAGER.idFromName('global');
      const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

      const jwksResponse = await keyManager.fetch(
        new Request('https://key-manager/jwks', {
          method: 'GET',
        })
      );

      if (!jwksResponse.ok) {
        throw new Error('Failed to fetch JWKS');
      }

      const jwks = (await jwksResponse.json()) as jose.JSONWebKeySet;

      // Create a local JWKS resolver
      const getKey = async () => {
        // Return the first key from JWKS (in production, match by kid)
        const key = jwks.keys[0];
        if (!key) {
          throw new Error('No keys in JWKS');
        }
        return await jose.importJWK(key);
      };

      // Verify JWT
      const { payload } = await jose.jwtVerify(logoutToken, await getKey(), {
        issuer: c.env.ISSUER_URL,
        algorithms: ['RS256'],
      });

      logoutClaims = payload;
    } catch (error) {
      console.error('Logout token validation error:', error);
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid logout_token',
        },
        400
      );
    }

    // Validate logout token claims
    if (!logoutClaims.sub) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'logout_token must contain sub claim',
        },
        400
      );
    }

    // Validate events claim
    const events = logoutClaims.events as any;
    if (!events || !events['http://schemas.openid.net/event/backchannel-logout']) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'logout_token must contain backchannel-logout event',
        },
        400
      );
    }

    // Validate that nonce is not present (per spec)
    if (logoutClaims.nonce) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'logout_token must not contain nonce claim',
        },
        400
      );
    }

    const userId = logoutClaims.sub as string;
    const sessionId = logoutClaims.sid as string | undefined;

    // Invalidate sessions
    const sessionStoreId = c.env.SESSION_STORE.idFromName('global');
    const sessionStore = c.env.SESSION_STORE.get(sessionStoreId);

    if (sessionId) {
      // Invalidate specific session
      const deleteResponse = await sessionStore.fetch(
        new Request(`https://session-store/session/${sessionId}`, {
          method: 'DELETE',
        })
      );

      if (!deleteResponse.ok) {
        console.warn(`Failed to delete session ${sessionId}`);
      }
    } else {
      // Invalidate all sessions for user
      const sessionsResponse = await sessionStore.fetch(
        new Request(`https://session-store/sessions/user/${userId}`, {
          method: 'GET',
        })
      );

      if (sessionsResponse.ok) {
        const data = (await sessionsResponse.json()) as {
          sessions: Array<{ id: string }>;
        };

        // Delete all sessions
        await Promise.all(
          data.sessions.map(async (session) => {
            await sessionStore.fetch(
              new Request(`https://session-store/session/${session.id}`, {
                method: 'DELETE',
              })
            );
          })
        );

        console.log(`Invalidated ${data.sessions.length} sessions for user ${userId}`);
      }
    }

    // Log the logout event
    console.log(
      `Back-channel logout: user=${userId}, session=${sessionId || 'all'}, client=${clientId || 'unknown'}`
    );

    // Return 200 OK (no content)
    return c.body(null, 200);
  } catch (error) {
    console.error('Back-channel logout error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to process logout request',
      },
      500
    );
  }
}

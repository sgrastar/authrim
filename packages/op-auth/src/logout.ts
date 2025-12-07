/**
 * Logout Functionality
 *
 * Implements OpenID Connect logout mechanisms:
 * - Front-channel logout (GET /logout)
 * - Back-channel logout (POST /logout/backchannel) - RFC 8725
 *
 * Front-channel: Browser-initiated logout with redirect
 * Back-channel: Server-to-server logout notification
 *
 * @see https://openid.net/specs/openid-connect-rpinitiated-1_0.html
 */

import { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '@authrim/shared';
import {
  timingSafeEqual,
  validateIdTokenHint,
  validatePostLogoutRedirectUri,
  validateLogoutParameters,
} from '@authrim/shared';
import { importJWK, jwtVerify } from 'jose';
import type { JSONWebKeySet, CryptoKey } from 'jose';

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
    let sid: string | undefined;

    // Helper function to get public key from KeyManager
    const getPublicKey = async (): Promise<CryptoKey> => {
      const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
      const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

      const jwksResponse = await keyManager.fetch(
        new Request('https://key-manager/jwks', {
          method: 'GET',
        })
      );

      if (!jwksResponse.ok) {
        throw new Error('Failed to fetch JWKS');
      }

      const jwks = (await jwksResponse.json()) as JSONWebKeySet;
      const key = jwks.keys[0];
      if (!key) {
        throw new Error('No keys in JWKS');
      }
      return (await importJWK(key)) as CryptoKey;
    };

    // Step 1: Validate parameter combination
    // If post_logout_redirect_uri is provided, id_token_hint is required
    const paramValidation = validateLogoutParameters(postLogoutRedirectUri, idTokenHint, true);
    if (!paramValidation.valid) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: paramValidation.error,
        },
        400
      );
    }

    // Step 2: Validate and parse ID token hint if provided
    if (idTokenHint) {
      const idTokenResult = await validateIdTokenHint(idTokenHint, getPublicKey, c.env.ISSUER_URL, {
        required: false,
        allowExpired: true,
      });

      if (!idTokenResult.valid) {
        // Return error for invalid id_token_hint
        return c.json(
          {
            error: idTokenResult.errorCode || 'invalid_request',
            error_description: idTokenResult.error,
          },
          400
        );
      }

      userId = idTokenResult.userId;
      clientId = idTokenResult.clientId;
      sid = idTokenResult.sid;
    }

    // Step 3: Validate post_logout_redirect_uri if provided
    if (postLogoutRedirectUri) {
      if (!clientId) {
        // This shouldn't happen if step 1 validation passed, but double-check
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Cannot validate post_logout_redirect_uri without id_token_hint',
          },
          400
        );
      }

      // Get client configuration
      const client = await c.env.DB.prepare(
        'SELECT redirect_uris, post_logout_redirect_uris FROM oauth_clients WHERE client_id = ?'
      )
        .bind(clientId)
        .first();

      if (!client) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Client not found',
          },
          400
        );
      }

      // Per OIDC RP-Initiated Logout 1.0, only post_logout_redirect_uris should be used
      // Do NOT fall back to redirect_uris - this is a security measure to ensure
      // only explicitly registered logout URIs are allowed
      let registeredUris: string[] = [];
      if (client.post_logout_redirect_uris) {
        registeredUris = JSON.parse(client.post_logout_redirect_uris as string) as string[];
      }

      // If no post_logout_redirect_uris are registered, reject the request
      if (registeredUris.length === 0) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'No post_logout_redirect_uris registered for this client',
          },
          400
        );
      }

      const uriValidation = validatePostLogoutRedirectUri(postLogoutRedirectUri, registeredUris);
      if (!uriValidation.valid) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: uriValidation.error,
          },
          400
        );
      }
    }

    // Step 4: Invalidate session
    const sessionId = getCookie(c, 'authrim_session');

    if (sessionId) {
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

      if (userId) {
        console.log(
          `User ${userId} logged out from client ${clientId || 'unknown'}${sid ? ` (sid: ${sid})` : ''}`
        );
      }
    }

    // Step 5: Build redirect URL
    let redirectUrl = postLogoutRedirectUri || `${c.env.ISSUER_URL}/logged-out`;

    if (state && postLogoutRedirectUri) {
      const url = new URL(redirectUrl);
      url.searchParams.set('state', state);
      redirectUrl = url.toString();
    }

    // Step 6: Clear session cookie
    setCookie(c, 'authrim_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 0,
    });

    // Step 7: Redirect to post-logout URI
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
      const keyManagerId = c.env.KEY_MANAGER.idFromName('default-v3');
      const keyManager = c.env.KEY_MANAGER.get(keyManagerId);

      const jwksResponse = await keyManager.fetch(
        new Request('https://key-manager/jwks', {
          method: 'GET',
        })
      );

      if (!jwksResponse.ok) {
        throw new Error('Failed to fetch JWKS');
      }

      const jwks = (await jwksResponse.json()) as JSONWebKeySet;

      // Create a local JWKS resolver
      const getKey = async () => {
        // Return the first key from JWKS (in production, match by kid)
        const key = jwks.keys[0];
        if (!key) {
          throw new Error('No keys in JWKS');
        }
        return await importJWK(key);
      };

      // Verify JWT
      const { payload } = await jwtVerify(logoutToken, await getKey(), {
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

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
  getSessionStoreBySessionId,
  isShardedSessionId,
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
 * Per OIDC RP-Initiated Logout 1.0:
 * - Session is ALWAYS invalidated when user visits logout endpoint (if session exists)
 * - Redirect to post_logout_redirect_uri only if validation passes
 * - Otherwise redirect to default /logged-out page
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
    // Matches the key by 'kid' from the JWT header
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

      // Extract kid from id_token_hint header if available
      let targetKid: string | undefined;
      if (idTokenHint) {
        try {
          const headerPart = idTokenHint.split('.')[0];
          const header = JSON.parse(atob(headerPart.replace(/-/g, '+').replace(/_/g, '/')));
          targetKid = header.kid;
        } catch {
          // If we can't parse the header, fall back to first key
        }
      }

      // Find the matching key by kid, or use the first key as fallback
      let key;
      if (targetKid) {
        key = jwks.keys.find((k) => k.kid === targetKid);
        if (!key) {
          // Key not found by kid - this could mean the key was rotated out
          throw new Error(`Key with kid '${targetKid}' not found in JWKS`);
        }
      } else {
        key = jwks.keys[0];
        if (!key) {
          throw new Error('No keys in JWKS');
        }
      }

      return (await importJWK(key)) as CryptoKey;
    };

    // ========================================
    // Step 1: Validate id_token_hint for session identification
    // ========================================
    // We validate the signature BEFORE using sid for session deletion
    // to prevent attackers from crafting fake tokens to log out other users
    let idTokenValid = false;
    if (idTokenHint) {
      const idTokenResult = await validateIdTokenHint(idTokenHint, getPublicKey, c.env.ISSUER_URL, {
        required: false,
        allowExpired: true, // Allow expired tokens for logout
      });

      if (idTokenResult.valid) {
        userId = idTokenResult.userId;
        clientId = idTokenResult.clientId;
        sid = idTokenResult.sid;
        idTokenValid = true;
      } else {
        console.warn('id_token_hint validation failed:', idTokenResult.error);
      }
    }

    // ========================================
    // Step 2: Invalidate sessions
    // ========================================
    // Per OIDC spec, when user visits logout endpoint, they intend to log out.
    // We delete sessions from:
    // 1. Cookie (always - this is the browser's session)
    // 2. sid from validated id_token_hint (if valid - for server-to-server logout)
    const sessionId = getCookie(c, 'authrim_session');
    const deletedSessions: string[] = [];

    // Delete session from cookie if present (only sharded format)
    if (sessionId && isShardedSessionId(sessionId)) {
      try {
        const sessionStore = getSessionStoreBySessionId(c.env, sessionId);
        const deleteResponse = await sessionStore.fetch(
          new Request(`https://session-store/session/${sessionId}`, {
            method: 'DELETE',
          })
        );

        if (deleteResponse.ok) {
          deletedSessions.push(sessionId);
        } else {
          console.warn('Failed to delete cookie session:', sessionId);
        }
      } catch (error) {
        console.warn('Failed to route to session store for:', sessionId, error);
      }
    }

    // Also delete session by sid from id_token_hint (only if signature was verified)
    // This ensures logout works even when called without browser cookies
    // Security: We only trust sid from verified tokens to prevent DoS attacks
    if (
      idTokenValid &&
      sid &&
      sid !== sessionId &&
      !deletedSessions.includes(sid) &&
      isShardedSessionId(sid)
    ) {
      try {
        const sessionStore = getSessionStoreBySessionId(c.env, sid);
        const deleteResponse = await sessionStore.fetch(
          new Request(`https://session-store/session/${sid}`, {
            method: 'DELETE',
          })
        );

        if (deleteResponse.ok) {
          deletedSessions.push(sid);
        } else {
          // Session might not exist or already deleted - this is OK
          console.debug('Session from id_token_hint not found or already deleted:', sid);
        }
      } catch (error) {
        console.warn('Failed to route to session store for sid:', sid, error);
      }
    }

    // Step 3: Clear session cookie immediately
    setCookie(c, 'authrim_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 0,
    });

    // ========================================
    // Step 4: Validate parameters for redirect
    // ========================================
    // Even if validation fails, user is already logged out.
    // Validation only determines WHERE to redirect.

    // Track validation state and error reason
    let canRedirectToRequestedUri = true;
    let validationError: string | undefined;

    // Step 4a: Validate parameter combination
    // If post_logout_redirect_uri is provided, id_token_hint is required
    const paramValidation = validateLogoutParameters(postLogoutRedirectUri, idTokenHint, true);
    if (!paramValidation.valid) {
      console.warn('Logout parameter validation failed:', paramValidation.error);
      canRedirectToRequestedUri = false;
      validationError = 'id_token_hint_required';
    }

    // Step 4b: Check if id_token_hint was valid (already validated in Step 1)
    // Only treat invalid id_token_hint as an error when post_logout_redirect_uri is provided,
    // since we need to validate the redirect URI against the client's registered URIs.
    // Without post_logout_redirect_uri, invalid id_token_hint just means we can't use sid from it.
    if (canRedirectToRequestedUri && postLogoutRedirectUri && idTokenHint && !idTokenValid) {
      canRedirectToRequestedUri = false;
      validationError = 'invalid_id_token_hint';
    }

    // Step 4c: Validate post_logout_redirect_uri if provided
    if (canRedirectToRequestedUri && postLogoutRedirectUri) {
      if (!clientId) {
        console.warn('Cannot validate post_logout_redirect_uri without valid id_token_hint');
        canRedirectToRequestedUri = false;
        validationError = 'invalid_id_token_hint';
      } else {
        // Get client configuration
        const client = await c.env.DB.prepare(
          'SELECT redirect_uris, post_logout_redirect_uris FROM oauth_clients WHERE client_id = ?'
        )
          .bind(clientId)
          .first();

        if (!client) {
          console.warn('Client not found for logout:', clientId);
          canRedirectToRequestedUri = false;
          validationError = 'invalid_client';
        } else {
          // Per OIDC RP-Initiated Logout 1.0, only post_logout_redirect_uris should be used
          let registeredUris: string[] = [];
          if (client.post_logout_redirect_uris) {
            registeredUris = JSON.parse(client.post_logout_redirect_uris as string) as string[];
          }

          if (registeredUris.length === 0) {
            console.warn('No post_logout_redirect_uris registered for client:', clientId);
            canRedirectToRequestedUri = false;
            validationError = 'unregistered_post_logout_redirect_uri';
          } else {
            const uriValidation = validatePostLogoutRedirectUri(
              postLogoutRedirectUri,
              registeredUris
            );
            if (!uriValidation.valid) {
              console.warn('post_logout_redirect_uri validation failed:', uriValidation.error);
              canRedirectToRequestedUri = false;
              validationError = 'unregistered_post_logout_redirect_uri';
            }
          }
        }
      }
    }

    // Log the logout event
    console.log(
      `[LOGOUT] User ${userId || 'unknown'} logged out from client ${clientId || 'unknown'}, ` +
        `cookieSessionId=${sessionId || 'none'}, sidFromToken=${sid || 'none'}, ` +
        `deletedSessions=[${deletedSessions.join(', ') || 'none'}], ` +
        `idTokenValid=${idTokenValid}, validationError=${validationError || 'none'}`
    );

    // ========================================
    // Step 5: Build redirect URL
    // ========================================
    let redirectUrl: string;

    if (canRedirectToRequestedUri && postLogoutRedirectUri) {
      // Validation passed - redirect to requested URI
      redirectUrl = postLogoutRedirectUri;
      if (state) {
        const url = new URL(redirectUrl);
        url.searchParams.set('state', state);
        redirectUrl = url.toString();
      }
    } else if (validationError) {
      // Validation failed - redirect to error page
      // Per OIDC spec, OP SHOULD display an error page when validation fails
      const errorUrl = new URL(`${c.env.ISSUER_URL}/logout-error`);
      errorUrl.searchParams.set('error', validationError);
      redirectUrl = errorUrl.toString();
    } else {
      // No URI requested and no error - redirect to default logout success page
      redirectUrl = `${c.env.ISSUER_URL}/logged-out`;
    }

    // Step 6: Redirect to post-logout URI
    // IMPORTANT: Hono's c.redirect() creates a new Response that doesn't include
    // headers set via setCookie(). We need to manually add the Set-Cookie header
    // to ensure the session cookie is properly cleared in the browser.
    const response = c.redirect(redirectUrl, 302);

    // Clone the response and add the Set-Cookie header
    const headers = new Headers(response.headers);
    headers.set(
      'Set-Cookie',
      'authrim_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0'
    );

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    console.error('Front-channel logout error:', error);
    // Even on error, try to clear session cookie
    setCookie(c, 'authrim_session', '', {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 0,
    });
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

      // Extract kid from logout token header and find matching key
      let key;
      try {
        const headerPart = logoutToken.split('.')[0];
        const header = JSON.parse(atob(headerPart.replace(/-/g, '+').replace(/_/g, '/')));
        const targetKid = header.kid;

        if (targetKid) {
          key = jwks.keys.find((k) => k.kid === targetKid);
          if (!key) {
            throw new Error(`Key with kid '${targetKid}' not found in JWKS`);
          }
        } else {
          key = jwks.keys[0];
        }
      } catch {
        // If we can't parse the header, fall back to first key
        key = jwks.keys[0];
      }

      if (!key) {
        throw new Error('No keys in JWKS');
      }

      const publicKey = await importJWK(key);

      // Verify JWT
      const { payload } = await jwtVerify(logoutToken, publicKey, {
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
    // With sharded SessionStore, we can only delete sessions by specific sessionId
    if (sessionId && isShardedSessionId(sessionId)) {
      // Invalidate specific session using sharded routing
      try {
        const sessionStore = getSessionStoreBySessionId(c.env, sessionId);
        const deleteResponse = await sessionStore.fetch(
          new Request(`https://session-store/session/${sessionId}`, {
            method: 'DELETE',
          })
        );

        if (!deleteResponse.ok) {
          console.warn(`Failed to delete session ${sessionId}`);
        }
      } catch (error) {
        console.warn(`Failed to route to session store for back-channel logout:`, sessionId, error);
      }
    } else if (sessionId) {
      // Legacy non-sharded session ID - cannot route
      console.warn(`Back-channel logout: Cannot delete legacy session format: ${sessionId}`);
    } else {
      // No sessionId provided - "delete all user sessions" is not supported with sharding
      // This would require maintaining a userId -> sessionIds index across all shards
      console.warn(
        `Back-channel logout: Cannot invalidate all sessions for user ${userId} - ` +
          `sessionId (sid claim) is required with sharded SessionStore`
      );
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

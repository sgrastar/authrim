/**
 * Back-Channel Logout Handler
 * POST /auth/external/:provider/backchannel-logout
 *
 * Implements OpenID Connect Back-Channel Logout 1.0
 * https://openid.net/specs/openid-connect-backchannel-1_0.html
 *
 * When a user logs out at the IdP, the IdP sends a logout token to this endpoint.
 * The RP (Authrim) validates the token and terminates associated sessions.
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  type DatabaseAdapter,
  getSessionStoreBySessionId,
  isShardedSessionId,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
} from '@authrim/ar-lib-core';
import * as jose from 'jose';
import { getProviderByIdOrSlug } from '../services/provider-store';
import {
  findLinkedIdentitiesByProviderSub,
  updateLinkedIdentity,
} from '../services/linked-identity-store';
import type { UpstreamProvider } from '../types';

/**
 * Logout Token claims (OpenID Connect Back-Channel Logout 1.0)
 */
interface LogoutTokenClaims {
  /** Issuer - must match provider's issuer */
  iss: string;
  /** Subject - the user being logged out (optional if sid present) */
  sub?: string;
  /** Audience - must contain our client_id */
  aud: string | string[];
  /** Issued at time */
  iat: number;
  /** JWT ID - unique identifier for this token */
  jti: string;
  /** Session ID at the IdP (optional if sub present) */
  sid?: string;
  /** Events claim - must contain back-channel logout event */
  events: {
    'http://schemas.openid.net/event/backchannel-logout': Record<string, never>;
  };
  /** Nonce MUST NOT be present in logout tokens */
  nonce?: never;
}

/**
 * Handle backchannel logout request from IdP
 *
 * Request body (application/x-www-form-urlencoded):
 * - logout_token: The logout token JWT
 */
export async function handleBackchannelLogout(c: Context<{ Bindings: Env }>): Promise<Response> {
  const log = getLogger(c).module('BACKCHANNEL-LOGOUT');
  const providerIdOrSlug = c.req.param('provider');
  const tenantId = c.req.query('tenant_id') || 'default';

  try {
    // 1. Get provider configuration
    const provider = await getProviderByIdOrSlug(c.env, providerIdOrSlug, tenantId);
    if (!provider) {
      log.error('Backchannel logout: Provider not found', { providerIdOrSlug });
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // 2. Parse form body to get logout_token
    const contentType = c.req.header('Content-Type');
    if (!contentType?.includes('application/x-www-form-urlencoded')) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const formData = await c.req.parseBody();
    const logoutToken = formData['logout_token'];

    if (!logoutToken || typeof logoutToken !== 'string') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'logout_token' },
      });
    }

    // 3. Validate logout token
    const claims = await validateLogoutToken(c.env, provider, logoutToken);

    // 4. Find and invalidate sessions/tokens for the subject
    const result = await invalidateUserSessions(c.env, provider.id, claims, log);

    log.info('Backchannel logout processed', {
      provider: provider.name,
      sub: claims.sub,
      sid: claims.sid,
      identitiesAffected: result.identitiesAffected,
      sessionsTerminated: result.sessionsTerminated,
    });

    // 5. Return success (spec requires 200 OK for success)
    // Cache-Control: no-store per spec
    return new Response(null, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    log.error('Backchannel logout error', {}, error as Error);

    // Return 400 for token validation errors
    // SECURITY: Don't leak internal error details to prevent information disclosure
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
}

/**
 * Validate logout token per OpenID Connect Back-Channel Logout 1.0 Section 2.6
 */
async function validateLogoutToken(
  env: Env,
  provider: UpstreamProvider,
  logoutToken: string
): Promise<LogoutTokenClaims> {
  // Fetch JWKS from provider
  const jwksUri = provider.jwksUri || `${provider.issuer}/.well-known/jwks.json`;
  const jwksResponse = await fetch(jwksUri);
  if (!jwksResponse.ok) {
    throw new Error(`Failed to fetch JWKS from ${jwksUri}`);
  }
  const jwks: jose.JSONWebKeySet = await jwksResponse.json();
  const JWKS = jose.createLocalJWKSet(jwks);

  // Verify signature and decode
  const { payload } = await jose.jwtVerify(logoutToken, JWKS, {
    issuer: provider.issuer,
    audience: provider.clientId,
  });

  const claims = payload as unknown as LogoutTokenClaims;

  // 1. Verify events claim contains backchannel logout event
  if (!claims.events?.['http://schemas.openid.net/event/backchannel-logout']) {
    throw new Error('Logout token missing backchannel-logout event');
  }

  // 2. Verify either sub or sid is present (at least one required)
  if (!claims.sub && !claims.sid) {
    throw new Error('Logout token must contain either sub or sid claim');
  }

  // 3. Verify nonce is NOT present (MUST NOT per spec)
  if ('nonce' in claims && claims.nonce !== undefined) {
    throw new Error('Logout token MUST NOT contain nonce claim');
  }

  // 4. Verify jti is present (SHOULD per spec, we require it)
  if (!claims.jti) {
    throw new Error('Logout token missing jti claim');
  }

  // 5. Verify iat is not too old (within 5 minutes for replay protection)
  const now = Math.floor(Date.now() / 1000);
  const maxAge = 300; // 5 minutes
  if (claims.iat < now - maxAge) {
    throw new Error('Logout token is too old');
  }

  // 6. Check jti against KV cache to prevent replay attacks
  // Key format: bcl_jti:{providerId}:{jti}
  const jtiCacheKey = `bcl_jti:${provider.id}:${claims.jti}`;
  if (env.SETTINGS) {
    const existingJti = await env.SETTINGS.get(jtiCacheKey);
    if (existingJti) {
      throw new Error('Logout token replay detected');
    }

    // Store jti in KV with TTL matching the iat window (5 minutes + buffer)
    // This prevents the same logout token from being processed twice
    await env.SETTINGS.put(jtiCacheKey, '1', {
      expirationTtl: maxAge + 60, // 6 minutes (5 min window + 1 min buffer)
    });
  }

  return claims;
}

/**
 * Invalidate sessions and mark tokens for the subject
 */
async function invalidateUserSessions(
  env: Env,
  providerId: string,
  claims: LogoutTokenClaims,
  log: ReturnType<ReturnType<typeof getLogger>['module']>
): Promise<{ identitiesAffected: number; sessionsTerminated: number }> {
  let identitiesAffected = 0;
  let sessionsTerminated = 0;

  // Find linked identities for this provider and subject
  if (claims.sub) {
    const identities = await findLinkedIdentitiesByProviderSub(env, providerId, claims.sub);

    for (const identity of identities) {
      identitiesAffected++;

      // Mark the linked identity as requiring re-authentication
      // We do this by clearing the tokens
      await updateLinkedIdentity(env, identity.id, {
        tokens: {
          access_token: '', // Clear tokens
          token_type: 'Bearer',
        },
      });
    }

    // Terminate sessions that were created via this provider and subject
    // Query D1 for sessions with matching external_provider_id and external_provider_sub
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: env.DB });
    const sessions = await coreAdapter.query<{ id: string }>(
      `SELECT id FROM sessions
       WHERE external_provider_id = ?
         AND external_provider_sub = ?
         AND expires_at > ?`,
      [providerId, claims.sub, Date.now()]
    );

    for (const session of sessions) {
      // Terminate session in Durable Object
      if (isShardedSessionId(session.id)) {
        try {
          const { stub: sessionStore } = getSessionStoreBySessionId(env, session.id);
          await sessionStore.fetch(
            new Request(`https://session-store/session/${session.id}`, {
              method: 'DELETE',
            })
          );
          sessionsTerminated++;
        } catch (error) {
          log.warn('Failed to terminate session', { sessionId: session.id });
        }
      }
    }

    // Clean up terminated sessions from D1
    if (sessionsTerminated > 0) {
      await coreAdapter.execute(
        `DELETE FROM sessions
         WHERE external_provider_id = ?
           AND external_provider_sub = ?`,
        [providerId, claims.sub]
      );
    }
  }

  // If sid is present, log for debugging (could implement IdP-sid based lookup in future)
  if (claims.sid) {
    log.debug('IdP session ID received (not yet used for targeted logout)', { sid: claims.sid });
  }

  return { identitiesAffected, sessionsTerminated };
}

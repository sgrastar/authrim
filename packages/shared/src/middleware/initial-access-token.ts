/**
 * Initial Access Token Middleware
 *
 * Implements Initial Access Token validation for Dynamic Client Registration
 * as described in OpenID Connect Dynamic Client Registration 1.0 Section 3.1
 *
 * Security: Tokens are stored with SHA-256 hash as the key, not plaintext.
 * This prevents token leakage if KV storage is compromised.
 *
 * https://openid.net/specs/openid-connect-registration-1_0.html#ClientRegistration
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';

/**
 * Token metadata stored in context
 */
interface TokenMetadata {
  single_use?: boolean;
  description?: string;
}

/**
 * Hash token for secure storage comparison using SHA-256
 * Same implementation as SCIM tokens for consistency
 * Exported for use by Admin API
 */
export async function hashInitialAccessToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Internal alias for backwards compatibility
const hashToken = hashInitialAccessToken;

/**
 * Variables added to Hono context
 */
interface ContextVariables {
  initialAccessTokenMetadata?: TokenMetadata;
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Middleware to validate Initial Access Token for Dynamic Client Registration
 *
 * Behavior:
 * - If OPEN_REGISTRATION=true: Allow requests without token
 * - If OPEN_REGISTRATION=false or unset: Require valid Initial Access Token
 *
 * Token validation:
 * - Token must be present in Authorization: Bearer <token> header
 * - Token must exist in INITIAL_ACCESS_TOKENS KV store
 * - Token can be single-use (deleted after use) or reusable (kept in KV)
 */
export function initialAccessTokenMiddleware(): MiddlewareHandler<{
  Bindings: Env;
  Variables: ContextVariables;
}> {
  return async (c: Context<{ Bindings: Env; Variables: ContextVariables }>, next) => {
    const env = c.env;

    // Check if open registration is enabled
    const openRegistration = env.OPEN_REGISTRATION?.toLowerCase() === 'true';

    if (openRegistration) {
      // Open registration enabled - no token required
      console.log('Open registration enabled - skipping Initial Access Token validation');
      return next();
    }

    // Check if request is from a trusted domain
    const trustedDomains = env.TRUSTED_DOMAINS?.split(',').map((d) => d.trim()) || [];
    if (trustedDomains.length > 0) {
      try {
        // Clone the request to read body without consuming it
        const clonedRequest = c.req.raw.clone();
        const body = (await clonedRequest.json()) as any;

        // Check if redirect_uris contain any trusted domain
        if (body && Array.isArray(body.redirect_uris)) {
          const hasTrustedRedirect = body.redirect_uris.some((uri: string) => {
            try {
              const url = new URL(uri);
              const redirectDomain = url.hostname;
              return trustedDomains.some(
                (trusted) => redirectDomain === trusted || redirectDomain.endsWith('.' + trusted)
              );
            } catch {
              return false;
            }
          });

          if (hasTrustedRedirect) {
            console.log(
              'Trusted domain detected in redirect_uris - skipping Initial Access Token validation'
            );
            return next();
          }
        }
      } catch (error) {
        // If body parsing fails, continue to normal token validation
        console.log('Failed to parse request body for trusted domain check:', error);
      }
    }

    // Open registration disabled - Initial Access Token required
    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        {
          error: 'invalid_token',
          error_description:
            'Initial Access Token is required. Include it in the Authorization header as "Bearer <token>"',
        },
        401,
        {
          'WWW-Authenticate': 'Bearer realm="Dynamic Client Registration"',
        }
      );
    }

    // Validate token against KV store
    if (!env.INITIAL_ACCESS_TOKENS) {
      console.error('INITIAL_ACCESS_TOKENS KV namespace not configured');
      return c.json(
        {
          error: 'server_error',
          error_description: 'Initial Access Token validation is not properly configured',
        },
        500
      );
    }

    try {
      // Hash the token for secure lookup (same pattern as SCIM tokens)
      const tokenHash = await hashToken(token);
      const kvKey = `iat:${tokenHash}`;

      const tokenData = await env.INITIAL_ACCESS_TOKENS.get(kvKey, 'json');

      if (!tokenData) {
        return c.json(
          {
            error: 'invalid_token',
            error_description: 'The provided Initial Access Token is invalid or has expired',
          },
          401,
          {
            'WWW-Authenticate': 'Bearer realm="Dynamic Client Registration", error="invalid_token"',
          }
        );
      }

      // Token is valid - check if it's single-use
      const metadata = tokenData as TokenMetadata;

      if (metadata.single_use) {
        // Delete single-use token immediately using the hashed key
        await env.INITIAL_ACCESS_TOKENS.delete(kvKey);
        console.log(`Single-use Initial Access Token consumed: ${tokenHash.substring(0, 10)}...`);
      } else {
        console.log(`Reusable Initial Access Token used: ${tokenHash.substring(0, 10)}...`);
      }

      // Store token metadata in context for use by handlers
      c.set('initialAccessTokenMetadata', metadata);

      return next();
    } catch (error) {
      console.error('Error validating Initial Access Token:', error);
      return c.json(
        {
          error: 'server_error',
          error_description: 'An error occurred while validating the Initial Access Token',
        },
        500
      );
    }
  };
}

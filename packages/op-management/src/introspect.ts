import type { Context } from 'hono';
import type { Env } from '@enrai/shared';
import type { IntrospectionResponse } from '@enrai/shared';
import { validateClientId, timingSafeEqual } from '@enrai/shared';
import { getRefreshToken, isTokenRevoked } from '@enrai/shared';
import { parseToken, verifyToken } from '@enrai/shared';
import { importJWK, type KeyLike } from 'jose';

/**
 * Token Introspection Endpoint Handler
 * https://tools.ietf.org/html/rfc7662
 *
 * Allows authorized clients to query the authorization server about the state of a token
 */
export async function introspectHandler(c: Context<{ Bindings: Env }>) {
  // Verify Content-Type is application/x-www-form-urlencoded
  const contentType = c.req.header('Content-Type');
  if (!contentType || !contentType.includes('application/x-www-form-urlencoded')) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      },
      400
    );
  }

  // Parse form data
  let formData: Record<string, string>;
  try {
    const body = await c.req.parseBody();
    formData = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value : ''])
    );
  } catch {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Failed to parse request body',
      },
      400
    );
  }

  const token = formData.token;
  const token_type_hint = formData.token_type_hint as 'access_token' | 'refresh_token' | undefined;

  // Extract client credentials from either form data or Authorization header
  let client_id = formData.client_id;
  let client_secret = formData.client_secret;

  // Check for HTTP Basic authentication (client_secret_basic)
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const base64Credentials = authHeader.substring(6);
      const credentials = atob(base64Credentials);
      const [basicClientId, basicClientSecret] = credentials.split(':', 2);

      if (!client_id && basicClientId) {
        client_id = basicClientId;
      }
      if (!client_secret && basicClientSecret) {
        client_secret = basicClientSecret;
      }
    } catch {
      return c.json(
        {
          error: 'invalid_client',
          error_description: 'Invalid Authorization header format',
        },
        401
      );
    }
  }

  // Validate token parameter
  if (!token) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'token parameter is required',
      },
      400
    );
  }

  // Validate client_id (client authentication required for introspection)
  const clientIdValidation = validateClientId(client_id);
  if (!clientIdValidation.valid) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: clientIdValidation.error,
      },
      401
    );
  }

  // RFC 7662 Section 2.1: The authorization server first validates the client credentials
  // Fetch client to verify client_secret
  const clientRecord = await c.env.DB.prepare(
    'SELECT client_id, client_secret FROM oauth_clients WHERE client_id = ?'
  )
    .bind(client_id)
    .first();

  if (!clientRecord) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Client not found',
      },
      401
    );
  }

  // Verify client_secret using timing-safe comparison to prevent timing attacks
  if (!client_secret || !timingSafeEqual(clientRecord.client_secret as string, client_secret)) {
    return c.json(
      {
        error: 'invalid_client',
        error_description: 'Invalid client credentials',
      },
      401
    );
  }

  // Parse token to extract claims (without verification yet)
  let tokenPayload;
  try {
    tokenPayload = parseToken(token);
  } catch {
    // If token format is invalid, return inactive response (per RFC 7662)
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  const jti = tokenPayload.jti as string;
  const sub = tokenPayload.sub as string;
  const aud = tokenPayload.aud as string;
  const scope = tokenPayload.scope as string;
  const iss = tokenPayload.iss as string;
  const exp = tokenPayload.exp as number;
  const iat = tokenPayload.iat as number;
  const tokenClientId = tokenPayload.client_id as string;

  // Load public key for verification
  const publicJwkJson = c.env.PUBLIC_JWK_JSON;
  if (!publicJwkJson) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'Server configuration error',
      },
      500
    );
  }

  let publicKey;
  try {
    const jwk = JSON.parse(publicJwkJson) as Parameters<typeof importJWK>[0];
    publicKey = (await importJWK(jwk, 'RS256')) as KeyLike;
  } catch (err) {
    console.error('Failed to import public key:', err);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load verification key',
      },
      500
    );
  }

  // Verify token signature
  try {
    // Determine expected audience based on token content
    // For access tokens, aud should be the issuer URL
    // For refresh tokens, aud should be the client_id
    // Use the actual aud from the token to determine verification strategy
    const expectedAud = aud;
    await verifyToken(token, publicKey, iss, expectedAud);
  } catch (error) {
    console.error('Token verification failed:', error);
    // Token signature verification failed, return inactive
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // Check if token is expired
  const now = Math.floor(Date.now() / 1000);
  if (exp && exp < now) {
    return c.json<IntrospectionResponse>({
      active: false,
    });
  }

  // Check if token has been revoked (for access tokens)
  if (jti && token_type_hint !== 'refresh_token') {
    const revoked = await isTokenRevoked(c.env, jti);
    if (revoked) {
      return c.json<IntrospectionResponse>({
        active: false,
      });
    }
  }

  // Check if refresh token exists in KV (for refresh tokens)
  if (jti && token_type_hint === 'refresh_token') {
    const refreshTokenData = await getRefreshToken(c.env, jti);
    if (!refreshTokenData) {
      return c.json<IntrospectionResponse>({
        active: false,
      });
    }
  }

  // Token is active, return introspection response
  const response: IntrospectionResponse = {
    active: true,
    scope,
    client_id: tokenClientId,
    token_type: 'Bearer',
    exp,
    iat,
    sub,
    aud,
    iss,
    jti,
  };

  return c.json(response);
}

import type { Context } from 'hono';
import type { Env } from '@enrai/shared';
import { validateClientId, timingSafeEqual } from '@enrai/shared';
import { deleteRefreshToken, getRefreshToken, revokeToken } from '@enrai/shared';
import { parseToken } from '@enrai/shared';

/**
 * Token Revocation Endpoint Handler
 * https://tools.ietf.org/html/rfc7009
 *
 * Allows clients to notify the authorization server that a token is no longer needed
 */
export async function revokeHandler(c: Context<{ Bindings: Env }>) {
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

  // Validate client_id (client authentication required for revocation)
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

  // RFC 7009 Section 2.1: The authorization server first validates the client credentials
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

  // Parse token to extract JTI
  let tokenPayload;
  try {
    tokenPayload = parseToken(token);
  } catch (error) {
    // Per RFC 7009 Section 2.2: The authorization server responds with HTTP status code 200
    // if the token has been revoked successfully or if the client submitted an invalid token.
    // This is to prevent token scanning attacks.
    console.warn('Failed to parse token for revocation:', error);
    return c.body(null, 200);
  }

  const jti = tokenPayload.jti as string;
  const tokenClientId = tokenPayload.client_id as string;

  if (!jti) {
    // No JTI, cannot revoke - return success to prevent information disclosure
    return c.body(null, 200);
  }

  // Verify that the token belongs to the requesting client
  // This prevents clients from revoking each other's tokens
  if (tokenClientId !== client_id) {
    console.warn(`Client ${client_id} attempted to revoke token belonging to ${tokenClientId}`);
    // Per RFC 7009: Return success even if client doesn't own the token
    return c.body(null, 200);
  }

  // Determine token type and revoke accordingly
  if (token_type_hint === 'refresh_token') {
    // Revoke refresh token
    await deleteRefreshToken(c.env, jti);
  } else if (token_type_hint === 'access_token') {
    // Revoke access token
    const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);
    await revokeToken(c.env, jti, expiresIn);
  } else {
    // No hint provided, try both types
    // First, check if it's a refresh token
    const refreshTokenData = await getRefreshToken(c.env, jti);
    if (refreshTokenData) {
      // It's a refresh token
      await deleteRefreshToken(c.env, jti);
    } else {
      // Assume it's an access token
      const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);
      await revokeToken(c.env, jti, expiresIn);
    }
  }

  // Per RFC 7009 Section 2.2: The authorization server responds with HTTP status code 200
  // The content of the response body is ignored by the client
  return c.body(null, 200);
}

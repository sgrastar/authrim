import type { Context } from 'hono';
import type { Env } from '@authrim/shared';
import { validateClientId, timingSafeEqual } from '@authrim/shared';
import { deleteRefreshToken, getRefreshToken, revokeToken } from '@authrim/shared';
import { parseToken, verifyToken } from '@authrim/shared';
import { importJWK, decodeProtectedHeader, type CryptoKey, type JWK } from 'jose';

// In-memory JWKS cache with 5-minute TTL (shared pattern with introspect.ts)
let jwksCache: { keys: JWK[]; expiry: number } | null = null;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get JWKS from KeyManager DO with in-memory caching
 */
async function getJwksFromKeyManager(env: Env): Promise<JWK[]> {
  const now = Date.now();

  // Return cached JWKS if still valid
  if (jwksCache && jwksCache.expiry > now) {
    return jwksCache.keys;
  }

  // Fetch from KeyManager DO
  try {
    const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = env.KEY_MANAGER.get(keyManagerId);
    const keys = await keyManager.getAllPublicKeysRpc();
    jwksCache = {
      keys,
      expiry: now + JWKS_CACHE_TTL_MS,
    };
    return keys;
  } catch (error) {
    console.error('Failed to get JWKS from KeyManager:', error);
    // Return empty array on error, will fall back to PUBLIC_JWK_JSON
    return [];
  }
}

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
  // RFC 7617: client_id and client_secret are URL-encoded before Base64 encoding
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const base64Credentials = authHeader.substring(6);
      const credentials = atob(base64Credentials);
      const colonIndex = credentials.indexOf(':');

      if (colonIndex === -1) {
        return c.json(
          {
            error: 'invalid_client',
            error_description: 'Invalid Authorization header format: missing colon separator',
          },
          401
        );
      }

      // RFC 7617 Section 2: The user-id and password are URL-decoded after Base64 decoding
      const basicClientId = decodeURIComponent(credentials.substring(0, colonIndex));
      const basicClientSecret = decodeURIComponent(credentials.substring(colonIndex + 1));

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

  // Parse token to extract claims (without verification yet)
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
  // V2: Extract userId and version for refresh token operations
  const userId = tokenPayload.sub as string;
  const version = typeof tokenPayload.rtv === 'number' ? tokenPayload.rtv : 1;
  // Extract audience for signature verification
  const aud = tokenPayload.aud as string;

  if (!jti) {
    // No JTI, cannot revoke - return success to prevent information disclosure
    return c.body(null, 200);
  }

  // ========== Signature Verification (Security Enhancement) ==========
  // Verify token signature to prevent forged token attacks
  // Without this, an attacker with valid client credentials could forge tokens
  // with arbitrary JTIs and revoke other clients' tokens

  // Load public key for verification
  let publicKey: CryptoKey | undefined;
  let tokenKid: string | undefined;

  // Extract kid from token header
  try {
    const header = decodeProtectedHeader(token);
    tokenKid = header.kid;
  } catch {
    // If we can't decode the header, token is invalid
    console.warn('Failed to decode token header for revocation');
    return c.body(null, 200);
  }

  // Try to find matching key from KeyManager DO (with in-memory caching)
  if (tokenKid) {
    try {
      const jwksKeys = await getJwksFromKeyManager(c.env);
      const matchingKey = jwksKeys.find((k) => k.kid === tokenKid);
      if (matchingKey) {
        publicKey = (await importJWK(matchingKey, 'RS256')) as CryptoKey;
      }
    } catch {
      // KeyManager access failed, fall back to PUBLIC_JWK_JSON
    }
  }

  // Fall back to PUBLIC_JWK_JSON if no matching key found
  if (!publicKey) {
    const publicJwkJson = c.env.PUBLIC_JWK_JSON;
    if (!publicJwkJson) {
      console.error('PUBLIC_JWK_JSON not configured for revocation');
      // Return 200 to prevent information disclosure
      return c.body(null, 200);
    }

    try {
      const jwk = JSON.parse(publicJwkJson) as Parameters<typeof importJWK>[0];
      publicKey = (await importJWK(jwk, 'RS256')) as CryptoKey;
    } catch (err) {
      console.error('Failed to import public key for revocation:', err);
      return c.body(null, 200);
    }
  }

  // Verify token signature
  try {
    const expectedIssuer = c.env.ISSUER_URL;
    if (!expectedIssuer) {
      console.error('ISSUER_URL not configured for revocation');
      return c.body(null, 200);
    }
    // Use aud from token for audience verification
    await verifyToken(token, publicKey, expectedIssuer, { audience: aud });
  } catch (error) {
    // Token signature verification failed - could be forged token
    console.warn('Token signature verification failed for revocation:', error);
    return c.body(null, 200);
  }
  // ========== Signature Verification END ==========

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
    await deleteRefreshToken(c.env, jti, tokenClientId);
  } else if (token_type_hint === 'access_token') {
    // Revoke access token
    const expiresIn = parseInt(c.env.TOKEN_EXPIRY, 10);
    await revokeToken(c.env, jti, expiresIn);
  } else {
    // No hint provided, try both types
    // First, check if it's a refresh token (V2 API)
    const refreshTokenData = userId
      ? await getRefreshToken(c.env, userId, version, tokenClientId, jti)
      : null;
    if (refreshTokenData) {
      // It's a refresh token
      await deleteRefreshToken(c.env, jti, tokenClientId);
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

import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { KeyLike, JWK } from 'jose';
import { verifyToken } from '../utils/jwt';
import { importJWK } from 'jose';
import { isTokenRevoked } from '../utils/kv';

/**
 * Cached public key for token verification
 * Cloudflare Workers isolate caches this at module level
 */
let cachedPublicKey: KeyLike | null = null;
let cachedKeyId: string | null = null;

/**
 * Get or create cached public key for token verification
 * This optimization reduces cryptographic operations
 */
async function getPublicKey(publicJWKJson: string, keyId: string): Promise<KeyLike> {
  // Return cached key if available and key ID matches
  if (cachedPublicKey && cachedKeyId === keyId) {
    return cachedPublicKey;
  }

  // Parse and import public JWK
  const publicJWK = JSON.parse(publicJWKJson) as JWK;
  const importedKey = await importJWK(publicJWK, 'RS256');

  // Type guard: ensure we have a KeyLike, not Uint8Array
  if (importedKey instanceof Uint8Array) {
    throw new Error('Unexpected key type: expected KeyLike, got Uint8Array');
  }

  // Cache the key for future requests
  cachedPublicKey = importedKey;
  cachedKeyId = keyId;

  return importedKey;
}

/**
 * UserInfo Endpoint Handler
 * https://openid.net/specs/openid-connect-core-1_0.html#UserInfo
 *
 * Returns claims about the authenticated user
 */
export async function userinfoHandler(c: Context<{ Bindings: Env }>) {
  let accessToken: string | undefined;

  // Try to extract access token from Authorization header (preferred method)
  const authHeader = c.req.header('Authorization');
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      accessToken = parts[1];
    } else {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Invalid Authorization header format. Expected: Bearer <token>',
        },
        401
      );
    }
  }

  // If no Authorization header, try POST body (optional per OAuth 2.0 RFC 6750 Section 2.2)
  if (!accessToken && c.req.method === 'POST') {
    try {
      const body = await c.req.parseBody();
      if (body.access_token && typeof body.access_token === 'string') {
        accessToken = body.access_token;
      }
    } catch {
      // Ignore parse errors, will be caught by missing token check below
    }
  }

  // If still no token found, return error
  if (!accessToken) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing access token (provide via Authorization header or POST body)',
      },
      401
    );
  }

  // Verify access token
  const publicJWKJson = c.env.PUBLIC_JWK_JSON;
  const keyId = c.env.KEY_ID || 'default';

  if (!publicJWKJson) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'Server configuration error',
      },
      500
    );
  }

  let publicKey: KeyLike;
  try {
    // Get cached public key from environment variable
    publicKey = await getPublicKey(publicJWKJson, keyId);
  } catch (error) {
    console.error('Failed to load verification key:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to load verification key',
      },
      500
    );
  }

  const issuerUrl = c.env.ISSUER_URL;
  if (!issuerUrl) {
    return c.json(
      {
        error: 'server_error',
        error_description: 'Server configuration error',
      },
      500
    );
  }

  let tokenClaims;
  try {
    tokenClaims = await verifyToken(
      accessToken,
      publicKey,
      issuerUrl,
      issuerUrl // For MVP, access token audience is the issuer
    );
  } catch (error) {
    c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
    return c.json(
      {
        error: 'invalid_token',
        error_description: error instanceof Error ? error.message : 'Invalid or expired token',
      },
      401
    );
  }

  // Check if token has been revoked (due to authorization code reuse)
  // Per RFC 6749 Section 4.1.2: Tokens should be revoked when code reuse is detected
  const jti = tokenClaims.jti as string | undefined;
  if (jti) {
    const revoked = await isTokenRevoked(c.env, jti);
    if (revoked) {
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Token has been revoked',
        },
        401
      );
    }
  }

  // Extract claims from token
  const sub = tokenClaims.sub as string;
  const scope = (tokenClaims.scope as string) || '';
  const claimsParam = (tokenClaims.claims as string) || undefined;

  if (!sub) {
    return c.json(
      {
        error: 'invalid_token',
        error_description: 'Token does not contain subject claim',
      },
      401
    );
  }

  // Parse claims parameter if present
  let requestedUserinfoClaims: Record<string, { essential?: boolean; value?: unknown; values?: unknown[] } | null> = {};
  if (claimsParam) {
    try {
      const parsedClaims = JSON.parse(claimsParam);
      if (parsedClaims.userinfo && typeof parsedClaims.userinfo === 'object') {
        requestedUserinfoClaims = parsedClaims.userinfo;
      }
    } catch (error) {
      console.error('Failed to parse claims parameter:', error);
      // Continue without claims parameter if parsing fails
    }
  }

  // Build user claims based on scope
  const scopes = scope.split(' ');
  const userClaims: Record<string, unknown> = {
    sub,
  };

  // Static user data for MVP
  // In production, fetch from user database based on sub
  const userData = {
    name: 'Test User',
    family_name: 'User',
    given_name: 'Test',
    middle_name: 'Demo',
    nickname: 'Tester',
    preferred_username: 'testuser',
    profile: 'https://example.com/testuser',
    picture: 'https://example.com/testuser/avatar.jpg',
    website: 'https://example.com',
    gender: 'unknown',
    birthdate: '1990-01-01',
    zoneinfo: 'Asia/Tokyo',
    locale: 'en-US',
    updated_at: Math.floor(Date.now() / 1000),
    email: 'test@example.com',
    email_verified: true,
  };

  // Profile scope claims (OIDC Core 5.4)
  const profileClaims = [
    'name', 'family_name', 'given_name', 'middle_name', 'nickname',
    'preferred_username', 'profile', 'picture', 'website', 'gender',
    'birthdate', 'zoneinfo', 'locale', 'updated_at'
  ];

  // Add profile claims if profile scope is granted OR if explicitly requested
  if (scopes.includes('profile')) {
    // Include all profile claims when profile scope is granted
    for (const claim of profileClaims) {
      if (claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  } else {
    // Include individual profile claims if explicitly requested via claims parameter
    for (const claim of profileClaims) {
      if (claim in requestedUserinfoClaims && claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  }

  // Email scope claims
  const emailClaims = ['email', 'email_verified'];

  // Add email claims if email scope is granted OR if explicitly requested
  if (scopes.includes('email')) {
    // Include all email claims when email scope is granted
    for (const claim of emailClaims) {
      if (claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  } else {
    // Include individual email claims if explicitly requested via claims parameter
    for (const claim of emailClaims) {
      if (claim in requestedUserinfoClaims && claim in userData) {
        userClaims[claim] = userData[claim as keyof typeof userData];
      }
    }
  }

  return c.json(userClaims);
}

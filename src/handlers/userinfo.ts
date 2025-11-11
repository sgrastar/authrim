import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { KeyLike } from 'jose';
import { verifyToken } from '../utils/jwt';
import { importPKCS8, exportJWK, importJWK } from 'jose';

/**
 * Cached public key for token verification
 * Cloudflare Workers isolate caches this at module level
 */
let cachedPublicKey: KeyLike | null = null;
let cachedKeyId: string | null = null;

/**
 * Get or create cached public key for token verification
 * This optimization reduces cryptographic operations from 3 to 1 per request
 */
async function getPublicKey(privateKeyPEM: string, keyId: string): Promise<KeyLike> {
  // Return cached key if available and key ID matches
  if (cachedPublicKey && cachedKeyId === keyId) {
    return cachedPublicKey;
  }

  // Import private key and derive public key
  const privateKey = await importPKCS8(privateKeyPEM, 'RS256');
  const publicJWK = await exportJWK(privateKey);
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
  // Parse Authorization header
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing Authorization header',
      },
      401
    );
  }

  // Extract Bearer token
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Invalid Authorization header format. Expected: Bearer <token>',
      },
      401
    );
  }

  const accessToken = parts[1];
  if (!accessToken) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Missing access token',
      },
      401
    );
  }

  // Verify access token
  const privateKeyPEM = c.env.PRIVATE_KEY_PEM;
  const keyId = c.env.KEY_ID || 'default';

  if (!privateKeyPEM) {
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
    // Get cached public key or derive from private key
    // This optimization reduces 3 crypto operations to 1 per request
    publicKey = await getPublicKey(privateKeyPEM, keyId);
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

  // Extract claims from token
  const sub = tokenClaims.sub as string;
  const scope = (tokenClaims.scope as string) || '';

  if (!sub) {
    return c.json(
      {
        error: 'invalid_token',
        error_description: 'Token does not contain subject claim',
      },
      401
    );
  }

  // Build user claims based on scope
  const scopes = scope.split(' ');
  const userClaims: Record<string, unknown> = {
    sub,
  };

  // Add profile claims if profile scope is granted
  if (scopes.includes('profile')) {
    // For MVP, use static profile data
    // In production, fetch from user database based on sub
    userClaims.name = 'Test User';
    userClaims.preferred_username = 'testuser';
  }

  // Add email claims if email scope is granted
  if (scopes.includes('email')) {
    // For MVP, use static email data
    userClaims.email = 'test@example.com';
    userClaims.email_verified = true;
  }

  return c.json(userClaims);
}

/**
 * SCIM 2.0 Authentication Middleware
 *
 * Implements Bearer token authentication for SCIM endpoints
 * as per RFC 7644 Section 2
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7644#section-2
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import { SCIM_SCHEMAS } from '../types/scim';
import type { ScimError } from '../types/scim';

/**
 * SCIM Bearer Token Authentication Middleware
 *
 * Validates Bearer tokens against configured SCIM tokens in KV storage
 * or database. Tokens should be generated and stored securely.
 */
export async function scimAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return scimErrorResponse(c, 401, 'No authorization header provided');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return scimErrorResponse(c, 401, 'Invalid authorization header format. Expected: Bearer <token>');
  }

  const token = parts[1];

  try {
    // Validate token against stored SCIM tokens
    const isValid = await validateScimToken(c.env, token);

    if (!isValid) {
      return scimErrorResponse(c, 401, 'Invalid or expired SCIM token');
    }

    // Token is valid, proceed to next middleware
    await next();
  } catch (error) {
    console.error('SCIM auth error:', error);
    return scimErrorResponse(c, 500, 'Internal server error during authentication');
  }
}

/**
 * Validate SCIM token
 *
 * This implementation checks against KV storage where SCIM tokens are stored.
 * You can customize this to use database or other storage.
 */
async function validateScimToken(env: Env, token: string): Promise<boolean> {
  try {
    // Hash the token to match stored format
    const tokenHash = await hashToken(token);

    // Check in INITIAL_ACCESS_TOKENS KV namespace (reusing existing infrastructure)
    // or create a dedicated SCIM_TOKENS namespace
    const storedToken = await env.INITIAL_ACCESS_TOKENS?.get(`scim:${tokenHash}`);

    if (!storedToken) {
      return false;
    }

    // Parse token metadata
    const tokenData = JSON.parse(storedToken);

    // Check if token is expired
    if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      return false;
    }

    // Check if token is enabled
    if (tokenData.enabled === false) {
      return false;
    }

    return true;
  } catch (error) {
    console.error('Token validation error:', error);
    return false;
  }
}

/**
 * Hash token for secure storage comparison
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Return SCIM-compliant error response
 */
function scimErrorResponse(c: Context, status: number, detail: string, scimType?: string) {
  const error: ScimError = {
    schemas: [SCIM_SCHEMAS.ERROR],
    status: status.toString(),
    detail,
  };

  if (scimType) {
    error.scimType = scimType as any;
  }

  return c.json(error, status);
}

/**
 * Generate a new SCIM token (for admin use)
 */
export async function generateScimToken(
  env: Env,
  options: {
    description?: string;
    expiresInDays?: number;
    enabled?: boolean;
  } = {}
): Promise<{ token: string; tokenHash: string }> {
  // Generate a cryptographically secure random token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const tokenHash = await hashToken(token);

  const expiresAt = options.expiresInDays
    ? new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const tokenData = {
    description: options.description || 'SCIM provisioning token',
    createdAt: new Date().toISOString(),
    expiresAt,
    enabled: options.enabled !== false,
    type: 'scim',
  };

  // Store in KV
  await env.INITIAL_ACCESS_TOKENS?.put(`scim:${tokenHash}`, JSON.stringify(tokenData), {
    expirationTtl: options.expiresInDays ? options.expiresInDays * 24 * 60 * 60 : undefined,
  });

  return { token, tokenHash };
}

/**
 * Revoke a SCIM token
 */
export async function revokeScimToken(env: Env, tokenHash: string): Promise<boolean> {
  try {
    await env.INITIAL_ACCESS_TOKENS?.delete(`scim:${tokenHash}`);
    return true;
  } catch (error) {
    console.error('Token revocation error:', error);
    return false;
  }
}

/**
 * List all SCIM tokens (admin function)
 */
export async function listScimTokens(env: Env): Promise<
  Array<{
    tokenHash: string;
    description: string;
    createdAt: string;
    expiresAt: string | null;
    enabled: boolean;
  }>
> {
  const tokens: Array<any> = [];

  try {
    const list = await env.INITIAL_ACCESS_TOKENS?.list({ prefix: 'scim:' });

    if (!list) {
      return [];
    }

    for (const key of list.keys) {
      const value = await env.INITIAL_ACCESS_TOKENS?.get(key.name);
      if (value) {
        const tokenData = JSON.parse(value);
        tokens.push({
          tokenHash: key.name.replace('scim:', ''),
          description: tokenData.description,
          createdAt: tokenData.createdAt,
          expiresAt: tokenData.expiresAt,
          enabled: tokenData.enabled,
        });
      }
    }
  } catch (error) {
    console.error('List tokens error:', error);
  }

  return tokens;
}

/**
 * Optional: Database-based token validation
 *
 * If you prefer to store SCIM tokens in the database instead of KV,
 * you can create a `scim_tokens` table and use this function.
 */
export async function validateScimTokenFromDB(
  db: D1Database,
  token: string
): Promise<boolean> {
  try {
    const tokenHash = await hashToken(token);

    const result = await db
      .prepare(
        `SELECT id, expires_at, enabled FROM scim_tokens
         WHERE token_hash = ? AND enabled = 1`
      )
      .bind(tokenHash)
      .first<{ id: string; expires_at: string | null; enabled: number }>();

    if (!result) {
      return false;
    }

    // Check expiration
    if (result.expires_at && new Date(result.expires_at) < new Date()) {
      return false;
    }

    return true;
  } catch (error) {
    console.error('DB token validation error:', error);
    return false;
  }
}

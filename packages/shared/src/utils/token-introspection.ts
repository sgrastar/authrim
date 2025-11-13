/**
 * Internal Token Introspection Utility
 *
 * Provides comprehensive token validation for Protected Resource endpoints.
 * This is different from RFC 7662 introspection - it's an internal utility
 * that handles DPoP validation, token verification, and error response building.
 *
 * Benefits:
 * - Simplifies Protected Resource endpoint implementation
 * - Handles all token validation logic in one place
 * - Automatically validates DPoP proofs when present
 * - Builds RFC 6750-compliant error responses
 */

import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { KeyLike, JWTPayload, JWK } from 'jose';
import { importJWK } from 'jose';
import { verifyToken } from './jwt';
import { isTokenRevoked } from './kv';
import {
  extractDPoPProof,
  validateDPoPProof,
  isDPoPBoundToken,
  extractDPoPToken,
} from './dpop';

/**
 * Token introspection result
 */
export interface TokenIntrospectionResult {
  /** Whether the token is valid and active */
  valid: boolean;
  /** Token claims (if valid) */
  claims?: JWTPayload;
  /** Error information (if invalid) */
  error?: {
    /** OAuth 2.0 error code */
    error: string;
    /** Human-readable error description */
    error_description: string;
    /** WWW-Authenticate header value */
    wwwAuthenticate: string;
    /** HTTP status code */
    statusCode: number;
  };
}

/**
 * Internal token introspection request parameters
 * (Not to be confused with RFC 7662 TokenValidationRequest from types/oidc)
 */
export interface TokenValidationRequest {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Full request URL */
  url: string;
  /** Request headers */
  headers: Headers;
  /** Environment bindings */
  env: Env;
}

/**
 * Cached public key for token verification
 * Module-level cache for performance optimization
 */
let cachedPublicKey: KeyLike | null = null;
let cachedKeyId: string | null = null;

/**
 * Get or create cached public key for token verification
 */
async function getPublicKey(publicJWKJson: string, keyId: string): Promise<KeyLike> {
  if (cachedPublicKey && cachedKeyId === keyId) {
    return cachedPublicKey;
  }

  const publicJWK = JSON.parse(publicJWKJson) as JWK;
  const importedKey = await importJWK(publicJWK, 'RS256');

  if (importedKey instanceof Uint8Array) {
    throw new Error('Unexpected key type: expected KeyLike, got Uint8Array');
  }

  cachedPublicKey = importedKey;
  cachedKeyId = keyId;

  return importedKey;
}

/**
 * Extract access token from Authorization header
 */
function extractAccessToken(authHeader: string): {
  token: string;
  isDPoP: boolean;
} | null {
  // Check for DPoP-bound token
  if (isDPoPBoundToken(authHeader)) {
    const token = extractDPoPToken(authHeader);
    if (!token) {
      return null;
    }
    return { token, isDPoP: true };
  }

  // Check for Bearer token
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    return { token: parts[1], isDPoP: false };
  }

  return null;
}

/**
 * Comprehensive token introspection with DPoP validation
 *
 * This function performs all necessary validations for a Protected Resource:
 * 1. Extracts access token from Authorization header
 * 2. Verifies JWT signature and expiration
 * 3. Validates DPoP proof (if token is DPoP-bound)
 * 4. Checks token revocation status
 * 5. Returns validation result with claims or error details
 *
 * @param request - Introspection request parameters
 * @returns Token introspection result
 *
 * @example
 * ```typescript
 * const result = await introspectToken({
 *   method: c.req.method,
 *   url: c.req.url,
 *   headers: c.req.raw.headers,
 *   env: c.env,
 * });
 *
 * if (!result.valid) {
 *   c.header('WWW-Authenticate', result.error!.wwwAuthenticate);
 *   return c.json({
 *     error: result.error!.error,
 *     error_description: result.error!.error_description,
 *   }, result.error!.statusCode);
 * }
 *
 * // Token is valid, use result.claims
 * const sub = result.claims!.sub;
 * ```
 */
export async function introspectToken(
  request: TokenValidationRequest
): Promise<TokenIntrospectionResult> {
  // Extract Authorization header
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return {
      valid: false,
      error: {
        error: 'invalid_request',
        error_description: 'Missing Authorization header',
        wwwAuthenticate: 'Bearer',
        statusCode: 401,
      },
    };
  }

  // Extract access token
  const tokenInfo = extractAccessToken(authHeader);
  if (!tokenInfo) {
    return {
      valid: false,
      error: {
        error: 'invalid_request',
        error_description: 'Invalid Authorization header format. Expected: Bearer <token> or DPoP <token>',
        wwwAuthenticate: 'Bearer',
        statusCode: 401,
      },
    };
  }

  const { token: accessToken, isDPoP } = tokenInfo;

  // Load public key for verification
  const publicJWKJson = request.env.PUBLIC_JWK_JSON;
  const keyId = request.env.KEY_ID || 'default';

  if (!publicJWKJson) {
    return {
      valid: false,
      error: {
        error: 'server_error',
        error_description: 'Server configuration error',
        wwwAuthenticate: isDPoP ? 'DPoP' : 'Bearer',
        statusCode: 500,
      },
    };
  }

  let publicKey: KeyLike;
  try {
    publicKey = await getPublicKey(publicJWKJson, keyId);
  } catch (error) {
    console.error('Failed to load verification key:', error);
    return {
      valid: false,
      error: {
        error: 'server_error',
        error_description: 'Failed to load verification key',
        wwwAuthenticate: isDPoP ? 'DPoP' : 'Bearer',
        statusCode: 500,
      },
    };
  }

  const issuerUrl = request.env.ISSUER_URL;
  if (!issuerUrl) {
    return {
      valid: false,
      error: {
        error: 'server_error',
        error_description: 'Server configuration error',
        wwwAuthenticate: isDPoP ? 'DPoP' : 'Bearer',
        statusCode: 500,
      },
    };
  }

  // Verify JWT signature and expiration
  let tokenClaims: JWTPayload;
  try {
    tokenClaims = await verifyToken(
      accessToken,
      publicKey,
      issuerUrl,
      issuerUrl // For MVP, access token audience is the issuer
    );
  } catch (error) {
    const wwwAuth = isDPoP ? 'DPoP error="invalid_token"' : 'Bearer error="invalid_token"';
    return {
      valid: false,
      error: {
        error: 'invalid_token',
        error_description: error instanceof Error ? error.message : 'Invalid or expired token',
        wwwAuthenticate: wwwAuth,
        statusCode: 401,
      },
    };
  }

  // DPoP validation (if token is DPoP-bound)
  if (isDPoP) {
    // Extract DPoP proof from header
    const dpopProof = extractDPoPProof(request.headers);
    if (!dpopProof) {
      return {
        valid: false,
        error: {
          error: 'invalid_dpop_proof',
          error_description: 'DPoP proof is required for DPoP-bound tokens',
          wwwAuthenticate: 'DPoP error="invalid_dpop_proof"',
          statusCode: 401,
        },
      };
    }

    // Validate DPoP proof with htm, htu, and ath parameters
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      request.method,
      request.url,
      accessToken, // Include access token for ath validation
      request.env.NONCE_STORE
    );

    if (!dpopValidation.valid) {
      return {
        valid: false,
        error: {
          error: dpopValidation.error || 'invalid_dpop_proof',
          error_description: dpopValidation.error_description || 'DPoP proof validation failed',
          wwwAuthenticate: 'DPoP error="invalid_dpop_proof"',
          statusCode: 401,
        },
      };
    }

    // Verify that the DPoP proof's JWK thumbprint matches the token's cnf claim
    const cnf = tokenClaims.cnf as { jkt?: string } | undefined;
    if (!cnf || !cnf.jkt) {
      return {
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Access token is not DPoP-bound (missing cnf claim)',
          wwwAuthenticate: 'DPoP error="invalid_token"',
          statusCode: 401,
        },
      };
    }

    if (cnf.jkt !== dpopValidation.jkt) {
      return {
        valid: false,
        error: {
          error: 'invalid_dpop_proof',
          error_description: 'DPoP proof JWK does not match token binding',
          wwwAuthenticate: 'DPoP error="invalid_dpop_proof"',
          statusCode: 401,
        },
      };
    }
  } else {
    // If Bearer token is used, ensure the token is NOT DPoP-bound
    const cnf = tokenClaims.cnf as { jkt?: string } | undefined;
    if (cnf && cnf.jkt) {
      return {
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'This token is DPoP-bound and requires DPoP proof. Use "DPoP" token type instead of "Bearer".',
          wwwAuthenticate: 'DPoP error="invalid_token"',
          statusCode: 401,
        },
      };
    }
  }

  // Check if token has been revoked
  const jti = tokenClaims.jti;
  if (jti && typeof jti === 'string') {
    const revoked = await isTokenRevoked(request.env, jti);
    if (revoked) {
      const wwwAuth = isDPoP ? 'DPoP error="invalid_token"' : 'Bearer error="invalid_token"';
      return {
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token has been revoked',
          wwwAuthenticate: wwwAuth,
          statusCode: 401,
        },
      };
    }
  }

  // Token is valid - return claims
  return {
    valid: true,
    claims: tokenClaims,
  };
}

/**
 * Convenience function for Hono context
 *
 * @example
 * ```typescript
 * const result = await introspectTokenFromContext(c);
 * if (!result.valid) {
 *   c.header('WWW-Authenticate', result.error!.wwwAuthenticate);
 *   return c.json({
 *     error: result.error!.error,
 *     error_description: result.error!.error_description,
 *   }, result.error!.statusCode);
 * }
 * ```
 */
export async function introspectTokenFromContext(
  c: Context<{ Bindings: Env }>
): Promise<TokenIntrospectionResult> {
  return await introspectToken({
    method: c.req.method,
    url: c.req.url,
    headers: c.req.raw.headers,
    env: c.env,
  });
}

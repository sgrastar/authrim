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
import type { CryptoKey, JWTPayload, JWK } from 'jose';
import { importJWK } from 'jose';
import { verifyToken } from './jwt';
import { isTokenRevoked } from './kv';
import { extractDPoPProof, validateDPoPProof, isDPoPBoundToken, extractDPoPToken } from './dpop';

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
  /** Request body (for form-encoded POST requests) */
  body?: URLSearchParams;
}

// ===== Key Caching for Performance Optimization =====
// Cache public keys to avoid expensive KeyManager DO calls on every request.
// Public keys are safe to cache (public information) and dramatically reduce
// DO access under high load. TTL of 30 minutes is safe with 24h key rotation.

/** Cache TTL for public keys from KeyManager DO (30 minutes) */
const KEY_MANAGER_CACHE_TTL = 30 * 60 * 1000;

/** Cached public keys from KeyManager DO */
let cachedKeyManagerKeys: Array<JWK & { kid?: string }> | null = null;
let cachedKeyManagerTimestamp = 0;

/**
 * Cached public key for token verification (from PUBLIC_JWK_JSON fallback)
 * Module-level cache for performance optimization
 */
let cachedPublicKey: CryptoKey | null = null;
let cachedKeyId: string | null = null;

/**
 * Get or create cached public key for token verification (from PUBLIC_JWK_JSON)
 */
async function getPublicKey(publicJWKJson: string, keyId: string): Promise<CryptoKey> {
  if (cachedPublicKey && cachedKeyId === keyId) {
    return cachedPublicKey;
  }

  const publicJWK = JSON.parse(publicJWKJson) as JWK;
  const importedKey = (await importJWK(publicJWK, 'RS256')) as CryptoKey;

  if (importedKey instanceof Uint8Array) {
    throw new Error('Unexpected key type: expected CryptoKey, got Uint8Array');
  }

  cachedPublicKey = importedKey;
  cachedKeyId = keyId;

  return importedKey;
}

/**
 * Get public keys from KeyManager DO with caching
 *
 * Performance optimization: Caches all public keys from KeyManager DO to avoid
 * expensive DO calls on every request. Cache TTL is 30 minutes, which is safe
 * with 24-hour key rotation (keys have 48h overlap period).
 *
 * @param env - Environment bindings with KEY_MANAGER DO
 * @returns Array of JWK public keys, or null if unavailable
 */
async function getKeysFromKeyManager(env: Env): Promise<Array<JWK & { kid?: string }> | null> {
  const now = Date.now();

  // Check cache first
  if (cachedKeyManagerKeys && now - cachedKeyManagerTimestamp < KEY_MANAGER_CACHE_TTL) {
    return cachedKeyManagerKeys;
  }

  // Cache miss: fetch from KeyManager DO
  if (!env.KEY_MANAGER) {
    return null;
  }

  try {
    const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
    const keyManager = env.KEY_MANAGER.get(keyManagerId);
    const keys = await keyManager.getAllPublicKeysRpc();

    if (keys && keys.length > 0) {
      // Update cache
      cachedKeyManagerKeys = keys as Array<JWK & { kid?: string }>;
      cachedKeyManagerTimestamp = now;
      return cachedKeyManagerKeys;
    }

    return null;
  } catch (error) {
    // PII Protection: Don't log full error object
    console.warn(
      'Failed to fetch keys from KeyManager DO:',
      error instanceof Error ? error.name : 'Unknown error'
    );
    return null;
  }
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
  let accessToken: string | null = null;
  let isDPoP = false;

  // Extract Authorization header
  const authHeader = request.headers.get('Authorization');

  if (authHeader) {
    // Extract access token from Authorization header
    const tokenInfo = extractAccessToken(authHeader);
    if (!tokenInfo) {
      return {
        valid: false,
        error: {
          error: 'invalid_request',
          error_description:
            'Invalid Authorization header format. Expected: Bearer <token> or DPoP <token>',
          wwwAuthenticate: 'Bearer',
          statusCode: 401,
        },
      };
    }
    accessToken = tokenInfo.token;
    isDPoP = tokenInfo.isDPoP;
  } else if (request.method === 'POST' && request.body) {
    // RFC 6750 Section 2.2: Form-Encoded Body Parameter
    // When sending the access token in the HTTP request entity-body, the client
    // adds the access token to the request-body using the "access_token" parameter.

    // Verify Content-Type is application/x-www-form-urlencoded
    const contentType = request.headers.get('Content-Type');
    if (!contentType || !contentType.includes('application/x-www-form-urlencoded')) {
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

    // Extract access_token from form body
    const bodyToken = request.body.get('access_token');
    if (!bodyToken) {
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

    accessToken = bodyToken;
    isDPoP = false; // Form-encoded body only supports Bearer tokens
  } else {
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

  if (!accessToken) {
    return {
      valid: false,
      error: {
        error: 'invalid_request',
        error_description: 'Missing access token',
        wwwAuthenticate: 'Bearer',
        statusCode: 401,
      },
    };
  }

  // Load public key for verification
  // First, try to extract kid from JWT header
  let kid: string | undefined;
  try {
    const parts = accessToken.split('.');
    if (parts.length === 3) {
      const headerBase64url = parts[0];
      const headerBase64 = headerBase64url.replace(/-/g, '+').replace(/_/g, '/');
      const headerJson = JSON.parse(atob(headerBase64)) as { kid?: string; alg?: string };
      kid = headerJson.kid;
    }
  } catch (error) {
    // PII Protection: Don't log full error object
    console.warn(
      'Failed to extract kid from JWT header:',
      error instanceof Error ? error.name : 'Unknown error'
    );
  }

  let publicKey: CryptoKey | null = null;

  // Try to fetch JWKS from KeyManager DO with caching (30-minute TTL)
  // This dramatically reduces DO calls under high load while maintaining security
  const keys = await getKeysFromKeyManager(request.env);
  if (keys && keys.length > 0) {
    // Find key by kid (key ID from JWT header)
    const jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
    if (jwk) {
      try {
        publicKey = (await importJWK(jwk, 'RS256')) as CryptoKey;
      } catch (importError) {
        // PII Protection: Don't log full error object
        console.warn(
          'Failed to import JWK from KeyManager:',
          importError instanceof Error ? importError.name : 'Unknown error'
        );
      }
    }
  }

  // Fallback to PUBLIC_JWK_JSON if KeyManager unavailable or failed
  if (!publicKey) {
    const publicJWKJson = request.env.PUBLIC_JWK_JSON;
    const keyId = request.env.KEY_ID || 'default';

    if (!publicJWKJson) {
      return {
        valid: false,
        error: {
          error: 'server_error',
          error_description: 'Server configuration error: no public key available',
          wwwAuthenticate: isDPoP ? 'DPoP' : 'Bearer',
          statusCode: 500,
        },
      };
    }

    try {
      publicKey = await getPublicKey(publicJWKJson, keyId);
    } catch (error) {
      // PII Protection: Don't log full error object
      console.error(
        'Failed to load verification key:',
        error instanceof Error ? error.name : 'Unknown error'
      );
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
  }

  // Ensure we have a public key
  if (!publicKey) {
    return {
      valid: false,
      error: {
        error: 'server_error',
        error_description: 'No public key available for token verification',
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
    tokenClaims = await verifyToken(accessToken, publicKey, issuerUrl, {
      audience: issuerUrl, // For MVP, access token audience is the issuer
    });
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

    // Extract client_id from token claims (azp or client_id claim)
    const client_id =
      (tokenClaims.azp as string | undefined) || (tokenClaims.client_id as string | undefined);

    // Validate DPoP proof with htm, htu, and ath parameters (issue #12: DPoP JTI replay protection via DO)
    // Pass full Env for region-aware sharding support
    const dpopValidation = await validateDPoPProof(
      dpopProof,
      request.method,
      request.url,
      accessToken, // Include access token for ath validation
      request.env, // Pass full Env for region-aware DPoP JTI sharding
      client_id // Bind JTI to client_id for additional security
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
          error_description:
            'This token is DPoP-bound and requires DPoP proof. Use "DPoP" token type instead of "Bearer".',
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
  // Parse request body if it's a POST request with form-encoded content
  let body: URLSearchParams | undefined;
  if (c.req.method === 'POST') {
    const contentType = c.req.header('Content-Type');
    if (contentType && contentType.includes('application/x-www-form-urlencoded')) {
      try {
        // Parse form-encoded body
        const formData = await c.req.parseBody();
        // Convert to URLSearchParams
        body = new URLSearchParams();
        for (const [key, value] of Object.entries(formData)) {
          if (typeof value === 'string') {
            body.append(key, value);
          }
        }
      } catch (error) {
        // PII Protection: Don't log full error object (may contain request body data)
        console.warn(
          'Failed to parse request body:',
          error instanceof Error ? error.name : 'Unknown error'
        );
      }
    }
  }

  return await introspectToken({
    method: c.req.method,
    url: c.req.url,
    headers: c.req.raw.headers,
    env: c.env,
    body,
  });
}

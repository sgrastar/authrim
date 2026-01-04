/**
 * Check API Authentication Middleware
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Supports dual authentication:
 * - API Key: Authorization: Bearer chk_xxx (prefix-based detection)
 * - Access Token: Authorization: Bearer <JWT> (JWT format detection)
 *
 * Authentication Priority: DPoP > Access Token > API Key
 *
 * Security measures:
 * - Timing-safe comparison for API key verification
 * - Rate limiting by tier (strict, moderate, lenient)
 * - API key expiration support
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import {
  timingSafeEqual,
  verifyToken,
  importPublicKeyFromJWK,
  parseTokenHeader,
  createLogger,
} from '@authrim/ar-lib-core';
import type { JWK } from 'jose';
import type { CheckApiKey, RateLimitTier, CheckApiOperation } from '@authrim/ar-lib-core';

const log = createLogger().module('CHECK-AUTH');

// =============================================================================
// Types
// =============================================================================

/**
 * Extended JWT Payload with OAuth/OIDC access token claims
 * Includes standard claims plus custom Authrim claims
 */
interface AccessTokenPayload {
  sub?: string;
  client_id?: string;
  azp?: string;
  tenant_id?: string;
}

/**
 * Authentication result
 */
export interface CheckAuthResult {
  /** Whether authentication succeeded */
  authenticated: boolean;
  /** Authentication method used */
  method?: 'api_key' | 'access_token' | 'policy_secret';
  /** Error message if authentication failed */
  error?: string;
  /** Error description for response */
  errorDescription?: string;
  /** HTTP status code for error response */
  statusCode?: number;
  /** API Key ID (if authenticated via API key) */
  apiKeyId?: string;
  /** Client ID (from API key or access token) */
  clientId?: string;
  /** Tenant ID */
  tenantId?: string;
  /** Subject ID (from access token, if available) */
  subjectId?: string;
  /** Rate limit tier */
  rateLimitTier?: RateLimitTier;
  /** Allowed operations */
  allowedOperations?: CheckApiOperation[];
}

/**
 * Authentication context for Check API
 */
export interface CheckAuthContext {
  db: D1Database;
  cache?: KVNamespace;
  policyApiSecret?: string;
  defaultTenantId?: string;
  /** Issuer URL for JWT verification (e.g., https://auth.example.com) */
  issuerUrl?: string;
  /** Expected audience for JWT verification */
  expectedAudience?: string;
  /** JWKS (JSON Web Key Set) for JWT signature verification */
  jwks?: { keys: JWK[] };
}

// =============================================================================
// Constants
// =============================================================================

/** API Key prefix for Check API */
const API_KEY_PREFIX = 'chk_';

/** Cache key prefix for API key validation */
const API_KEY_CACHE_PREFIX = 'check:apikey:';

/** Cache TTL for API key validation (5 minutes) */
const API_KEY_CACHE_TTL = 300;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a token looks like a JWT
 */
function isJwtFormat(token: string): boolean {
  // JWTs have 3 base64url-encoded parts separated by dots
  const parts = token.split('.');
  if (parts.length !== 3) {
    return false;
  }

  // Each part should be valid base64url
  const base64urlPattern = /^[A-Za-z0-9_-]+$/;
  return parts.every((part) => base64urlPattern.test(part));
}

/**
 * Check if a token is a Check API key
 */
function isCheckApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/**
 * Hash a string using SHA-256 (for API key comparison)
 */
async function hashString(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get key prefix for identification
 */
function getKeyPrefix(apiKey: string): string {
  // Format: chk_xxxxxxxxxxxx (prefix is first 8 chars including chk_)
  return apiKey.substring(0, 8);
}

// =============================================================================
// API Key Validation
// =============================================================================

interface ApiKeyValidationResult {
  valid: boolean;
  key?: CheckApiKey;
  error?: string;
}

/**
 * Validate API key against database
 */
async function validateApiKey(
  ctx: CheckAuthContext,
  apiKey: string
): Promise<ApiKeyValidationResult> {
  const keyPrefix = getKeyPrefix(apiKey);
  const keyHash = await hashString(apiKey);

  // Try cache first
  if (ctx.cache) {
    try {
      const cached = await ctx.cache.get(`${API_KEY_CACHE_PREFIX}${keyHash}`);
      if (cached) {
        const key = JSON.parse(cached) as CheckApiKey;

        // Verify hash using timing-safe comparison
        if (!timingSafeEqual(key.key_hash, keyHash)) {
          return { valid: false, error: 'invalid_api_key' };
        }

        // Check if key is active and not expired
        if (!key.is_active) {
          return { valid: false, error: 'api_key_inactive' };
        }

        if (key.expires_at && key.expires_at < Math.floor(Date.now() / 1000)) {
          return { valid: false, error: 'api_key_expired' };
        }

        return { valid: true, key };
      }
    } catch {
      // Cache error - continue to database
    }
  }

  // Query database by prefix (narrow down candidates) then verify hash
  try {
    const result = await ctx.db
      .prepare(
        `SELECT id, tenant_id, client_id, name, key_hash, key_prefix,
                allowed_operations, rate_limit_tier, is_active, expires_at,
                created_at, updated_at
         FROM check_api_keys
         WHERE key_prefix = ?
         LIMIT 10`
      )
      .bind(keyPrefix)
      .all<{
        id: string;
        tenant_id: string;
        client_id: string;
        name: string;
        key_hash: string;
        key_prefix: string;
        allowed_operations: string;
        rate_limit_tier: string;
        is_active: number;
        expires_at: number | null;
        created_at: number;
        updated_at: number;
      }>();

    for (const row of result.results) {
      // Use timing-safe comparison to prevent timing attacks
      if (timingSafeEqual(row.key_hash, keyHash)) {
        // Check if active
        if (row.is_active !== 1) {
          return { valid: false, error: 'api_key_inactive' };
        }

        // Check expiration
        if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) {
          return { valid: false, error: 'api_key_expired' };
        }

        const key: CheckApiKey = {
          id: row.id,
          tenant_id: row.tenant_id,
          client_id: row.client_id,
          name: row.name,
          key_hash: row.key_hash,
          key_prefix: row.key_prefix,
          allowed_operations: JSON.parse(row.allowed_operations) as CheckApiOperation[],
          rate_limit_tier: row.rate_limit_tier as RateLimitTier,
          is_active: row.is_active === 1,
          expires_at: row.expires_at ?? undefined,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };

        // Cache valid key
        if (ctx.cache) {
          try {
            await ctx.cache.put(`${API_KEY_CACHE_PREFIX}${keyHash}`, JSON.stringify(key), {
              expirationTtl: API_KEY_CACHE_TTL,
            });
          } catch {
            // Cache write error - continue
          }
        }

        return { valid: true, key };
      }
    }

    return { valid: false, error: 'invalid_api_key' };
  } catch (error) {
    log.error('API key validation error', { error: String(error) }, error as Error);
    return { valid: false, error: 'validation_error' };
  }
}

// =============================================================================
// Access Token Validation
// =============================================================================

interface AccessTokenValidationResult {
  valid: boolean;
  clientId?: string;
  subjectId?: string;
  tenantId?: string;
  error?: string;
}

/**
 * Validate Access Token (JWT) with full signature verification
 *
 * Security features:
 * - JWT signature verification using JWKS
 * - Token expiration check (via jose library)
 * - Issuer validation
 * - Audience validation
 */
async function validateAccessToken(
  ctx: CheckAuthContext,
  token: string
): Promise<AccessTokenValidationResult> {
  try {
    // Parse JWT parts for validation
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'invalid_jwt_format' };
    }

    // If JWKS is not configured, fall back to basic validation with warning
    if (!ctx.jwks || !ctx.issuerUrl) {
      log.warn('JWKS or issuerUrl not configured - falling back to expiration-only validation', {
        hint: 'Configure JWKS for production security',
      });

      // Decode payload for basic validation
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

      // Check expiration
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return { valid: false, error: 'token_expired' };
      }

      return {
        valid: true,
        clientId: payload.client_id || payload.azp,
        subjectId: payload.sub,
        tenantId: payload.tenant_id || 'default',
      };
    }

    // Full JWT verification with signature check
    // Extract kid from header to select the correct key
    const header = parseTokenHeader(token);
    const kid = header.kid;

    // Find the matching key from JWKS
    let publicKey: JWK | undefined;
    if (kid) {
      publicKey = ctx.jwks.keys.find((key) => key.kid === kid);
    }
    if (!publicKey) {
      // If no kid match, use the first RS256 key
      publicKey = ctx.jwks.keys.find((key) => key.alg === 'RS256' || key.kty === 'RSA');
    }

    if (!publicKey) {
      log.error('No suitable public key found in JWKS', {});
      return { valid: false, error: 'no_suitable_key' };
    }

    // Import the public key
    const cryptoKey = await importPublicKeyFromJWK(publicKey);

    // Verify the token (signature, expiration, issuer, audience)
    const payload = await verifyToken(token, cryptoKey, ctx.issuerUrl, {
      audience: ctx.expectedAudience,
      skipAudienceCheck: !ctx.expectedAudience, // Skip if not configured
    });

    // Cast payload to access token type for custom claims
    const tokenPayload = payload as AccessTokenPayload;
    return {
      valid: true,
      clientId: tokenPayload.client_id || tokenPayload.azp,
      subjectId: payload.sub,
      tenantId: tokenPayload.tenant_id || 'default',
    };
  } catch (error) {
    if (error instanceof Error) {
      // Handle specific jose library errors
      if (error.message.includes('expired')) {
        return { valid: false, error: 'token_expired' };
      }
      if (error.message.includes('signature')) {
        log.error('JWT signature verification failed', {});
        return { valid: false, error: 'invalid_signature' };
      }
      if (error.message.includes('issuer')) {
        return { valid: false, error: 'invalid_issuer' };
      }
      if (error.message.includes('audience')) {
        return { valid: false, error: 'invalid_audience' };
      }
    }
    log.error('Access token validation error', { error: String(error) }, error as Error);
    return { valid: false, error: 'invalid_token' };
  }
}

// =============================================================================
// Main Authentication Function
// =============================================================================

/**
 * Authenticate Check API request
 *
 * @param authHeader - Authorization header value
 * @param ctx - Authentication context
 * @returns Authentication result
 */
export async function authenticateCheckApiRequest(
  authHeader: string | undefined,
  ctx: CheckAuthContext
): Promise<CheckAuthResult> {
  // No authorization header
  if (!authHeader) {
    return {
      authenticated: false,
      error: 'invalid_token',
      errorDescription: 'Authorization header is required',
      statusCode: 401,
    };
  }

  // Must be Bearer token
  if (!authHeader.startsWith('Bearer ')) {
    return {
      authenticated: false,
      error: 'invalid_request',
      errorDescription: 'Authorization header must use Bearer scheme',
      statusCode: 400,
    };
  }

  const token = authHeader.slice(7);

  if (!token) {
    return {
      authenticated: false,
      error: 'invalid_request',
      errorDescription: 'Bearer token is missing',
      statusCode: 400,
    };
  }

  // Determine token type and validate

  // 1. Check for Check API Key (chk_ prefix)
  if (isCheckApiKey(token)) {
    const result = await validateApiKey(ctx, token);

    if (!result.valid || !result.key) {
      const errorMap: Record<string, { error: string; description: string; status: number }> = {
        invalid_api_key: {
          error: 'invalid_token',
          description: 'Invalid API key',
          status: 401,
        },
        api_key_inactive: {
          error: 'invalid_token',
          description: 'API key is inactive',
          status: 401,
        },
        api_key_expired: {
          error: 'invalid_token',
          description: 'API key has expired',
          status: 401,
        },
        validation_error: {
          error: 'server_error',
          description: 'API key validation failed',
          status: 500,
        },
      };

      const errorInfo = errorMap[result.error || 'invalid_api_key'] || errorMap.invalid_api_key;

      return {
        authenticated: false,
        error: errorInfo.error,
        errorDescription: errorInfo.description,
        statusCode: errorInfo.status,
      };
    }

    return {
      authenticated: true,
      method: 'api_key',
      apiKeyId: result.key.id,
      clientId: result.key.client_id,
      tenantId: result.key.tenant_id,
      rateLimitTier: result.key.rate_limit_tier,
      allowedOperations: result.key.allowed_operations,
    };
  }

  // 2. Check for Access Token (JWT format)
  if (isJwtFormat(token)) {
    const result = await validateAccessToken(ctx, token);

    if (!result.valid) {
      const errorMap: Record<string, { error: string; description: string; status: number }> = {
        invalid_jwt_format: {
          error: 'invalid_request',
          description: 'Invalid JWT format',
          status: 400,
        },
        token_expired: {
          error: 'invalid_token',
          description: 'Access token has expired',
          status: 401,
        },
        invalid_signature: {
          error: 'invalid_token',
          description: 'Invalid token signature',
          status: 401,
        },
        invalid_issuer: {
          error: 'invalid_token',
          description: 'Invalid token issuer',
          status: 401,
        },
        invalid_audience: {
          error: 'invalid_token',
          description: 'Invalid token audience',
          status: 401,
        },
        no_suitable_key: {
          error: 'server_error',
          description: 'No suitable key found for signature verification',
          status: 500,
        },
        invalid_token: {
          error: 'invalid_token',
          description: 'Invalid access token',
          status: 401,
        },
      };

      const errorInfo = errorMap[result.error || 'invalid_token'] || errorMap.invalid_token;

      return {
        authenticated: false,
        error: errorInfo.error,
        errorDescription: errorInfo.description,
        statusCode: errorInfo.status,
      };
    }

    return {
      authenticated: true,
      method: 'access_token',
      clientId: result.clientId,
      subjectId: result.subjectId,
      tenantId: result.tenantId || ctx.defaultTenantId || 'default',
      // Access tokens get moderate rate limiting by default
      rateLimitTier: 'moderate',
      // Access tokens can do check and batch by default
      allowedOperations: ['check', 'batch'],
    };
  }

  // 3. Fallback: Check if it matches POLICY_API_SECRET (for backward compatibility)
  if (ctx.policyApiSecret && timingSafeEqual(token, ctx.policyApiSecret)) {
    return {
      authenticated: true,
      method: 'policy_secret',
      tenantId: ctx.defaultTenantId || 'default',
      // Policy secret gets lenient rate limiting (internal use)
      rateLimitTier: 'lenient',
      allowedOperations: ['check', 'batch', 'subscribe'],
    };
  }

  // Unknown token format
  return {
    authenticated: false,
    error: 'invalid_request',
    errorDescription: 'Token format not recognized. Use API key (chk_xxx) or access token (JWT)',
    statusCode: 400,
  };
}

/**
 * Check if operation is allowed for the authenticated context
 */
export function isOperationAllowed(auth: CheckAuthResult, operation: CheckApiOperation): boolean {
  if (!auth.authenticated || !auth.allowedOperations) {
    return false;
  }

  return auth.allowedOperations.includes(operation);
}

// =============================================================================
// Rate Limit Configuration
// =============================================================================

/**
 * Rate limit configuration by tier
 */
export const RATE_LIMIT_CONFIG: Record<RateLimitTier, { requests: number; windowMs: number }> = {
  strict: { requests: 100, windowMs: 60000 }, // 100/min
  moderate: { requests: 500, windowMs: 60000 }, // 500/min
  lenient: { requests: 2000, windowMs: 60000 }, // 2000/min
};

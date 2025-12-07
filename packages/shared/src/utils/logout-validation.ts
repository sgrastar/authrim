/**
 * Logout Validation Utilities
 *
 * Provides validation functions for OpenID Connect logout endpoints.
 * Implements validation for id_token_hint and post_logout_redirect_uri
 * per OpenID Connect RP-Initiated Logout 1.0 specification.
 */

import { jwtVerify, errors } from 'jose';
import type { JWTPayload, JWTVerifyOptions, CryptoKey } from 'jose';
import type { ValidationResult } from './validation';

/**
 * ID Token Hint validation result
 */
export interface IdTokenHintValidationResult {
  valid: boolean;
  userId?: string;
  clientId?: string;
  sid?: string;
  error?: string;
  errorCode?: 'invalid_token' | 'invalid_request';
}

/**
 * Options for ID Token Hint validation
 */
export interface IdTokenHintValidationOptions {
  /** Whether id_token_hint is required (default: false) */
  required?: boolean;
  /** Whether to allow expired tokens (default: true for logout) */
  allowExpired?: boolean;
}

/**
 * Validate ID Token Hint for logout endpoints
 *
 * Per OpenID Connect RP-Initiated Logout 1.0:
 * - If provided, MUST be a valid ID Token issued by this OP
 * - The OP SHOULD verify the token signature
 * - May be expired (users should be able to logout even with expired tokens)
 *
 * @param idTokenHint - The id_token_hint parameter
 * @param getPublicKey - Function to get the public key for verification
 * @param issuer - Expected issuer URL
 * @param options - Validation options
 * @returns Validation result with extracted claims
 */
export async function validateIdTokenHint(
  idTokenHint: string | undefined,
  getPublicKey: () => Promise<CryptoKey>,
  issuer: string,
  options: IdTokenHintValidationOptions = {}
): Promise<IdTokenHintValidationResult> {
  const { required = false, allowExpired = true } = options;

  // Check if id_token_hint is required
  if (!idTokenHint) {
    if (required) {
      return {
        valid: false,
        error: 'id_token_hint is required',
        errorCode: 'invalid_request',
      };
    }
    return { valid: true };
  }

  // Validate token format (3 parts separated by dots)
  const parts = idTokenHint.split('.');
  if (parts.length !== 3) {
    return {
      valid: false,
      error: 'id_token_hint is not a valid JWT format',
      errorCode: 'invalid_token',
    };
  }

  try {
    const publicKey = await getPublicKey();

    // Verify token signature
    // For logout, we allow expired tokens since users should be able to logout
    // even after their session has expired
    const verifyOptions: JWTVerifyOptions = {
      issuer,
      algorithms: ['RS256'],
    };

    // If we don't allow expired tokens, include clock tolerance
    if (!allowExpired) {
      verifyOptions.clockTolerance = 0;
    }

    let payload: JWTPayload;

    if (allowExpired) {
      // First try normal verification
      try {
        const result = await jwtVerify(idTokenHint, publicKey, verifyOptions);
        payload = result.payload;
      } catch (verifyError) {
        // If it fails due to expiration, try to decode without exp check
        if (verifyError instanceof errors.JWTExpired) {
          // Decode without verification to get claims, but we already verified signature
          // Re-verify without exp check by using a large clock tolerance
          const result = await jwtVerify(idTokenHint, publicKey, {
            ...verifyOptions,
            clockTolerance: Number.MAX_SAFE_INTEGER,
          });
          payload = result.payload;
        } else {
          throw verifyError;
        }
      }
    } else {
      const result = await jwtVerify(idTokenHint, publicKey, verifyOptions);
      payload = result.payload;
    }

    // Extract claims
    const userId = payload.sub;
    const clientId = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    const sid = payload.sid as string | undefined;

    if (!userId) {
      return {
        valid: false,
        error: 'id_token_hint does not contain sub claim',
        errorCode: 'invalid_token',
      };
    }

    return {
      valid: true,
      userId,
      clientId,
      sid,
    };
  } catch (error) {
    // Handle specific JWT errors
    if (error instanceof errors.JWSSignatureVerificationFailed) {
      return {
        valid: false,
        error: 'id_token_hint signature verification failed',
        errorCode: 'invalid_token',
      };
    }

    if (error instanceof errors.JWTClaimValidationFailed) {
      return {
        valid: false,
        error: `id_token_hint validation failed: ${(error as Error).message}`,
        errorCode: 'invalid_token',
      };
    }

    // Generic error
    return {
      valid: false,
      error: 'id_token_hint validation failed',
      errorCode: 'invalid_token',
    };
  }
}

/**
 * Validate post_logout_redirect_uri
 *
 * Per OpenID Connect RP-Initiated Logout 1.0:
 * - MUST be a valid URI
 * - MUST be registered for the client (exact match)
 * - Query parameters in the URI must match exactly
 *
 * @param uri - The post_logout_redirect_uri to validate
 * @param registeredUris - List of registered redirect URIs for the client
 * @returns ValidationResult
 */
export function validatePostLogoutRedirectUri(
  uri: string | undefined,
  registeredUris: string[]
): ValidationResult {
  // If not provided, it's valid (will use default logout page)
  if (!uri) {
    return { valid: true };
  }

  // Validate URI format
  let parsedUri: URL;
  try {
    parsedUri = new URL(uri);
  } catch {
    return {
      valid: false,
      error: 'post_logout_redirect_uri is not a valid URL',
    };
  }

  // Check protocol (only https or http://localhost for development)
  if (parsedUri.protocol !== 'https:') {
    if (
      parsedUri.protocol !== 'http:' ||
      (parsedUri.hostname !== 'localhost' && parsedUri.hostname !== '127.0.0.1')
    ) {
      return {
        valid: false,
        error: 'post_logout_redirect_uri must use HTTPS (or http://localhost)',
      };
    }
  }

  // Check if URI is registered (exact match required per spec)
  // Normalize URL encoding before comparison to handle encoding differences
  // (e.g., %2F vs /, %20 vs space) while maintaining strict matching
  const normalizedUri = parsedUri.href; // URL.href returns normalized form

  const isMatch = registeredUris.some((registeredUri) => {
    try {
      const normalizedRegistered = new URL(registeredUri).href;
      return normalizedUri === normalizedRegistered;
    } catch {
      // If registered URI is invalid, fall back to exact string comparison
      return uri === registeredUri;
    }
  });

  if (!isMatch) {
    return {
      valid: false,
      error: 'post_logout_redirect_uri is not registered for this client',
    };
  }

  return { valid: true };
}

/**
 * Check if post_logout_redirect_uri requires id_token_hint
 *
 * Per OpenID Connect RP-Initiated Logout 1.0:
 * - If post_logout_redirect_uri is provided, id_token_hint SHOULD be provided
 * - Some OPs require id_token_hint when post_logout_redirect_uri is present
 *
 * @param postLogoutRedirectUri - The post_logout_redirect_uri parameter
 * @param idTokenHint - The id_token_hint parameter
 * @param requireIdTokenHint - Whether to require id_token_hint (default: true for security)
 * @returns ValidationResult
 */
export function validateLogoutParameters(
  postLogoutRedirectUri: string | undefined,
  idTokenHint: string | undefined,
  requireIdTokenHint: boolean = true
): ValidationResult {
  // If post_logout_redirect_uri is provided, check if id_token_hint is required
  if (postLogoutRedirectUri && requireIdTokenHint && !idTokenHint) {
    return {
      valid: false,
      error: 'id_token_hint is required when post_logout_redirect_uri is provided',
    };
  }

  return { valid: true };
}

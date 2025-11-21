/**
 * Validation Utilities
 *
 * Provides validation functions for OpenID Connect and OAuth 2.0 parameters.
 * Ensures that all input parameters meet specification requirements.
 */

/**
 * Validation result interface
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Client ID validation
 * Must be a non-empty string with reasonable length
 *
 * @param clientId - Client identifier to validate
 * @returns ValidationResult
 */
export function validateClientId(clientId: string | undefined): ValidationResult {
  if (clientId === undefined || clientId === null) {
    return {
      valid: false,
      error: 'client_id is required',
    };
  }

  if (typeof clientId !== 'string') {
    return {
      valid: false,
      error: 'client_id must be a string',
    };
  }

  if (clientId.length === 0) {
    return {
      valid: false,
      error: 'client_id cannot be empty',
    };
  }

  if (clientId.length > 256) {
    return {
      valid: false,
      error: 'client_id is too long (max 256 characters)',
    };
  }

  // Client ID should contain only alphanumeric characters, hyphens, and underscores
  const clientIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!clientIdPattern.test(clientId)) {
    return {
      valid: false,
      error:
        'client_id contains invalid characters (use only alphanumeric, hyphens, and underscores)',
    };
  }

  return { valid: true };
}

/**
 * Redirect URI validation
 * Must be a valid HTTPS URL (or http://localhost for development)
 *
 * @param redirectUri - Redirect URI to validate
 * @param allowHttp - Allow http:// for development (default: false)
 * @returns ValidationResult
 */
export function validateRedirectUri(
  redirectUri: string | undefined,
  allowHttp: boolean = false
): ValidationResult {
  if (!redirectUri) {
    return {
      valid: false,
      error: 'redirect_uri is required',
    };
  }

  if (typeof redirectUri !== 'string') {
    return {
      valid: false,
      error: 'redirect_uri must be a string',
    };
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return {
      valid: false,
      error: 'redirect_uri is not a valid URL',
    };
  }

  // Check protocol
  if (url.protocol === 'https:') {
    // HTTPS is always allowed
    return { valid: true };
  }

  if (url.protocol === 'http:') {
    if (!allowHttp) {
      return {
        valid: false,
        error: 'redirect_uri must use HTTPS (http:// is not allowed)',
      };
    }

    // Allow http://localhost or http://127.0.0.1 for development
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return { valid: true };
    }

    return {
      valid: false,
      error: 'redirect_uri must use HTTPS or be http://localhost',
    };
  }

  return {
    valid: false,
    error: `redirect_uri protocol "${url.protocol}" is not supported`,
  };
}

/**
 * Scope validation
 * Must contain 'openid' and only valid scope values
 *
 * @param scope - Space-separated scope string
 * @param allowCustomScopes - Allow custom scopes (for resource server integration)
 * @returns ValidationResult
 */
export function validateScope(
  scope: string | undefined,
  allowCustomScopes: boolean = true
): ValidationResult {
  if (!scope) {
    return {
      valid: false,
      error: 'scope is required',
    };
  }

  if (typeof scope !== 'string') {
    return {
      valid: false,
      error: 'scope must be a string',
    };
  }

  const scopes = scope
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);

  if (scopes.length === 0) {
    return {
      valid: false,
      error: 'scope cannot be empty',
    };
  }

  // OpenID Connect requires 'openid' scope
  if (!scopes.includes('openid')) {
    return {
      valid: false,
      error: 'scope must include "openid"',
    };
  }

  // Standard OIDC scopes
  const standardScopes = ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'];

  if (!allowCustomScopes) {
    // Strict mode: only allow standard scopes
    const invalidScopes = scopes.filter((s) => !standardScopes.includes(s));
    if (invalidScopes.length > 0) {
      return {
        valid: false,
        error: `Invalid scope(s): ${invalidScopes.join(', ')}. Only standard OIDC scopes are allowed.`,
      };
    }
  } else {
    // Permissive mode: allow custom scopes but warn about unknown standard scopes
    const unknownScopes = scopes.filter((s) => !standardScopes.includes(s));
    if (unknownScopes.length > 0) {
      // Log warning for monitoring, but don't fail validation
      // This allows custom resource server scopes (e.g., 'api:read', 'admin:write')
      console.warn(`Non-standard scopes requested: ${unknownScopes.join(', ')}`);
    }
  }

  return { valid: true };
}

/**
 * State parameter validation
 * Optional but recommended for CSRF protection
 *
 * @param state - State parameter to validate
 * @returns ValidationResult
 */
export function validateState(state: string | undefined): ValidationResult {
  // State is optional
  if (state === undefined || state === null) {
    return { valid: true };
  }

  if (typeof state !== 'string') {
    return {
      valid: false,
      error: 'state must be a string',
    };
  }

  if (state.length === 0) {
    return {
      valid: false,
      error: 'state cannot be empty if provided',
    };
  }

  if (state.length > 512) {
    return {
      valid: false,
      error: 'state is too long (max 512 characters)',
    };
  }

  return { valid: true };
}

/**
 * Nonce parameter validation
 * Optional but recommended for replay protection
 *
 * @param nonce - Nonce parameter to validate
 * @returns ValidationResult
 */
export function validateNonce(nonce: string | undefined): ValidationResult {
  // Nonce is optional (but recommended when using implicit flow)
  if (nonce === undefined || nonce === null) {
    return { valid: true };
  }

  if (typeof nonce !== 'string') {
    return {
      valid: false,
      error: 'nonce must be a string',
    };
  }

  if (nonce.length === 0) {
    return {
      valid: false,
      error: 'nonce cannot be empty if provided',
    };
  }

  if (nonce.length > 512) {
    return {
      valid: false,
      error: 'nonce is too long (max 512 characters)',
    };
  }

  return { valid: true };
}

/**
 * Grant type validation
 * Supports 'authorization_code' and 'refresh_token' grant types
 *
 * @param grantType - Grant type to validate
 * @returns ValidationResult
 */
export function validateGrantType(grantType: string | undefined): ValidationResult {
  if (!grantType) {
    return {
      valid: false,
      error: 'grant_type is required',
    };
  }

  if (typeof grantType !== 'string') {
    return {
      valid: false,
      error: 'grant_type must be a string',
    };
  }

  const supportedGrantTypes = ['authorization_code', 'refresh_token'];

  if (!supportedGrantTypes.includes(grantType)) {
    return {
      valid: false,
      error: `Unsupported grant_type: ${grantType}. Supported types: ${supportedGrantTypes.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Response type validation
 * Must be 'code' for authorization code flow
 *
 * @param responseType - Response type to validate
 * @returns ValidationResult
 */
export function validateResponseType(responseType: string | undefined): ValidationResult {
  if (!responseType) {
    return {
      valid: false,
      error: 'response_type is required',
    };
  }

  if (typeof responseType !== 'string') {
    return {
      valid: false,
      error: 'response_type must be a string',
    };
  }

  // Supported response types per OIDC Core 3.3 (Hybrid Flow)
  const supportedResponseTypes = [
    'code',                    // Authorization Code Flow
    'id_token',                // Implicit Flow (ID Token only)
    'id_token token',          // Implicit Flow (ID Token + Access Token)
    'code id_token',           // Hybrid Flow 1
    'code token',              // Hybrid Flow 2
    'code id_token token',     // Hybrid Flow 3
  ];

  if (!supportedResponseTypes.includes(responseType)) {
    return {
      valid: false,
      error: `Unsupported response_type: ${responseType}. Supported types: ${supportedResponseTypes.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Authorization code validation
 * Accepts base64url-encoded random strings (recommended minimum 128 characters)
 *
 * @param code - Authorization code to validate
 * @returns ValidationResult
 */
export function validateAuthCode(code: string | undefined): ValidationResult {
  if (code === undefined || code === null) {
    return {
      valid: false,
      error: 'code is required',
    };
  }

  if (typeof code !== 'string') {
    return {
      valid: false,
      error: 'code must be a string',
    };
  }

  if (code.length === 0) {
    return {
      valid: false,
      error: 'code cannot be empty',
    };
  }

  // Base64url format validation (URL-safe: A-Z, a-z, 0-9, -, _)
  // Minimum length: 128 characters (recommended for security)
  // Maximum length: 512 characters (to prevent abuse)
  const base64urlPattern = /^[A-Za-z0-9_-]+$/;

  if (!base64urlPattern.test(code)) {
    return {
      valid: false,
      error: 'code format is invalid (must be base64url format)',
    };
  }

  if (code.length < 128) {
    return {
      valid: false,
      error: 'code is too short (minimum 128 characters recommended)',
    };
  }

  if (code.length > 512) {
    return {
      valid: false,
      error: 'code is too long (maximum 512 characters)',
    };
  }

  return { valid: true };
}

/**
 * Token validation (JWT format)
 * Must be a valid JWT format (3 parts separated by dots)
 *
 * @param token - Token to validate
 * @returns ValidationResult
 */
export function validateToken(token: string | undefined): ValidationResult {
  if (!token) {
    return {
      valid: false,
      error: 'token is required',
    };
  }

  if (typeof token !== 'string') {
    return {
      valid: false,
      error: 'token must be a string',
    };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return {
      valid: false,
      error: 'token format is invalid (must have 3 parts)',
    };
  }

  // Check if parts are base64url encoded
  const base64urlPattern = /^[A-Za-z0-9_-]+$/;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || !base64urlPattern.test(part)) {
      return {
        valid: false,
        error: `token part ${i + 1} is not valid base64url`,
      };
    }
  }

  return { valid: true };
}

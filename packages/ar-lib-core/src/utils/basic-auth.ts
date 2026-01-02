/**
 * HTTP Basic Authentication Parser
 * RFC 7617: The 'Basic' HTTP Authentication Scheme
 *
 * This module provides utilities for parsing HTTP Basic Authentication headers
 * in OAuth 2.0 client authentication contexts.
 *
 * Security Features:
 * - Proper Base64 decoding with error handling
 * - URL decoding per RFC 7617 Section 2
 * - Input validation to prevent injection attacks
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7617
 */

/**
 * Credentials extracted from Basic Authentication header
 */
export interface BasicAuthCredentials {
  /** Username (client_id in OAuth context) */
  username: string;
  /** Password (client_secret in OAuth context) */
  password: string;
}

/**
 * Successful parse result
 */
export interface BasicAuthSuccess {
  success: true;
  credentials: BasicAuthCredentials;
}

/**
 * Failed parse result with error type
 */
export interface BasicAuthFailure {
  success: false;
  error: 'missing_header' | 'invalid_scheme' | 'malformed_credentials' | 'decode_error';
}

/**
 * Result type for parseBasicAuth function
 */
export type BasicAuthResult = BasicAuthSuccess | BasicAuthFailure;

/**
 * Parse HTTP Basic Authentication header
 *
 * Implements RFC 7617 Section 2:
 * 1. Extract Base64-encoded credentials after "Basic "
 * 2. Decode Base64 to get "user-id:password"
 * 3. URL-decode both parts (they are URL-encoded before Base64 encoding)
 *
 * @param authHeader - The Authorization header value (or undefined if not present)
 * @returns Parsed credentials or error
 *
 * @example
 * ```typescript
 * const result = parseBasicAuth(c.req.header('Authorization'));
 * if (result.success) {
 *   const { username, password } = result.credentials;
 *   // username = client_id, password = client_secret
 * } else {
 *   // Handle error based on result.error
 * }
 * ```
 */
export function parseBasicAuth(authHeader: string | undefined): BasicAuthResult {
  // Check if header is present (undefined or null means no header was provided)
  if (authHeader === undefined || authHeader === null) {
    return { success: false, error: 'missing_header' };
  }

  // Check for "Basic " prefix (case-sensitive per RFC 7617)
  // Empty string or wrong scheme both return invalid_scheme
  if (!authHeader.startsWith('Basic ')) {
    return { success: false, error: 'invalid_scheme' };
  }

  try {
    // Extract Base64-encoded credentials (everything after "Basic ")
    const base64Credentials = authHeader.substring(6);

    // Decode Base64
    const credentials = atob(base64Credentials);

    // Find the first colon separator
    // RFC 7617: The user-id itself cannot contain a colon character
    const colonIndex = credentials.indexOf(':');

    if (colonIndex === -1) {
      return { success: false, error: 'malformed_credentials' };
    }

    // RFC 7617 Section 2:
    // "The user-id and password are URL-decoded after Base64 decoding"
    // This is because special characters in client_id/secret are URL-encoded
    // before being Base64 encoded
    const username = decodeURIComponent(credentials.substring(0, colonIndex));
    const password = decodeURIComponent(credentials.substring(colonIndex + 1));

    return {
      success: true,
      credentials: { username, password },
    };
  } catch {
    // Base64 decoding or URL decoding failed
    return { success: false, error: 'decode_error' };
  }
}

/**
 * Extract client credentials from Basic Auth header
 *
 * Convenience wrapper for OAuth client authentication.
 * Returns client_id and client_secret if Basic auth is present and valid.
 *
 * @param authHeader - The Authorization header value
 * @returns Object with client_id and client_secret, or empty object if not present/invalid
 *
 * @example
 * ```typescript
 * const { client_id, client_secret } = extractClientCredentialsFromBasicAuth(
 *   c.req.header('Authorization')
 * );
 * if (client_id) {
 *   // Basic auth was provided
 * }
 * ```
 */
export function extractClientCredentialsFromBasicAuth(authHeader: string | undefined): {
  client_id?: string;
  client_secret?: string;
} {
  const result = parseBasicAuth(authHeader);
  if (result.success) {
    return {
      client_id: result.credentials.username,
      client_secret: result.credentials.password,
    };
  }
  return {};
}

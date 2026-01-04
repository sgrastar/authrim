/**
 * Custom Redirect URI Validation (Authrim Extension)
 *
 * Provides secure validation for custom redirect URIs (error_uri, cancel_uri)
 * in the OAuth 2.0 / OIDC authorization flow.
 *
 * IMPORTANT: This is an Authrim extension, NOT part of OIDC standard.
 * - error_uri / cancel_uri are NOT token delivery endpoints
 * - Tokens are ALWAYS returned to redirect_uri only
 * - These URIs are for UX improvement (error/cancel navigation)
 *
 * Security Model:
 * 1. Same-origin with redirect_uri: Always allowed
 * 2. Pre-registered origins: Allowed if in allowed_redirect_origins
 * 3. All others: Rejected (Open Redirect prevention)
 *
 * Additional validation:
 * - HTTPS required (localhost excepted)
 * - Fragment identifiers (#) forbidden
 * - Invalid URL format rejected
 */

import { createLogger } from './logger';

const log = createLogger().module('CustomRedirect');

/**
 * Result of custom redirect URI validation
 */
export interface CustomRedirectValidationResult {
  /** Whether the URI is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Normalized URI (if valid) */
  normalizedUri?: string;
  /** Reason why the URI was allowed */
  allowedReason?: 'same_origin' | 'pre_registered';
}

/**
 * Result of validating multiple custom redirect parameters
 */
export interface CustomRedirectParamsValidationResult {
  /** Whether all parameters are valid */
  valid: boolean;
  /** Validation errors keyed by parameter name */
  errors: Record<string, string>;
  /** Validated URIs (only present if valid) */
  validatedUris?: {
    error_uri?: string;
    cancel_uri?: string;
  };
}

/**
 * Validate a single custom redirect URI
 *
 * Validates that the URI is safe for redirection based on:
 * 1. Same-origin check: customUri.origin === redirectUri.origin
 * 2. Allowlist check: customUri.origin in allowedOrigins
 *
 * @param customUri - The custom redirect URI to validate
 * @param redirectUri - The registered redirect_uri for comparison
 * @param allowedOrigins - Pre-registered allowed origins
 * @returns Validation result with error or normalized URI
 *
 * @example
 * // Same origin allowed
 * validateCustomRedirectUri(
 *   'https://app.example.com/error',
 *   'https://app.example.com/callback',
 *   []
 * ); // { valid: true, normalizedUri: '...', allowedReason: 'same_origin' }
 *
 * // Pre-registered origin allowed
 * validateCustomRedirectUri(
 *   'https://admin.example.com/error',
 *   'https://app.example.com/callback',
 *   ['https://admin.example.com']
 * ); // { valid: true, normalizedUri: '...', allowedReason: 'pre_registered' }
 *
 * // Unregistered origin rejected
 * validateCustomRedirectUri(
 *   'https://evil.com/steal',
 *   'https://app.example.com/callback',
 *   []
 * ); // { valid: false, error: 'Origin not allowed...' }
 */
export function validateCustomRedirectUri(
  customUri: string | undefined,
  redirectUri: string,
  allowedOrigins: string[]
): CustomRedirectValidationResult {
  // If no custom URI provided, nothing to validate
  if (!customUri || customUri.trim() === '') {
    return { valid: true };
  }

  // Parse custom URI
  let customUrl: URL;
  try {
    customUrl = new URL(customUri);
  } catch {
    return {
      valid: false,
      error: 'Invalid URL format',
    };
  }

  // Fragment identifiers are forbidden (security: prevents leaking to other pages)
  if (customUrl.hash && customUrl.hash.length > 1) {
    return {
      valid: false,
      error: 'Fragment identifiers (#) are not allowed',
    };
  }

  // HTTPS required (localhost excepted for development)
  if (!isSecureProtocol(customUrl)) {
    return {
      valid: false,
      error: 'HTTPS is required (except localhost)',
    };
  }

  // Parse redirect_uri for origin comparison
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectUri);
  } catch {
    // If redirect_uri is invalid, we can't do origin comparison
    // This shouldn't happen as redirect_uri should be validated earlier
    return {
      valid: false,
      error: 'Cannot validate: redirect_uri is invalid',
    };
  }

  // Same-origin check
  if (customUrl.origin === redirectUrl.origin) {
    return {
      valid: true,
      normalizedUri: customUrl.toString(),
      allowedReason: 'same_origin',
    };
  }

  // Allowlist check (normalize origins for comparison)
  const normalizedCustomOrigin = customUrl.origin.toLowerCase();
  const normalizedAllowedOrigins = allowedOrigins.map((o) => normalizeOrigin(o));

  if (normalizedAllowedOrigins.includes(normalizedCustomOrigin)) {
    return {
      valid: true,
      normalizedUri: customUrl.toString(),
      allowedReason: 'pre_registered',
    };
  }

  // Not allowed - potential Open Redirect
  return {
    valid: false,
    error: `Origin not allowed: ${customUrl.origin}. Register in allowed_redirect_origins or use same origin as redirect_uri.`,
  };
}

/**
 * Validate multiple custom redirect parameters
 *
 * Validates error_uri and cancel_uri in one call.
 *
 * @param params - Object containing error_uri and/or cancel_uri
 * @param redirectUri - The registered redirect_uri for comparison
 * @param allowedOrigins - Pre-registered allowed origins
 * @returns Combined validation result
 */
export function validateCustomRedirectParams(
  params: { error_uri?: string; cancel_uri?: string },
  redirectUri: string,
  allowedOrigins: string[]
): CustomRedirectParamsValidationResult {
  const errors: Record<string, string> = {};
  const validatedUris: { error_uri?: string; cancel_uri?: string } = {};

  // Validate error_uri
  if (params.error_uri) {
    const result = validateCustomRedirectUri(params.error_uri, redirectUri, allowedOrigins);
    if (!result.valid) {
      errors['error_uri'] = result.error || 'Invalid error_uri';
    } else if (result.normalizedUri) {
      validatedUris.error_uri = result.normalizedUri;
    }
  }

  // Validate cancel_uri
  if (params.cancel_uri) {
    const result = validateCustomRedirectUri(params.cancel_uri, redirectUri, allowedOrigins);
    if (!result.valid) {
      errors['cancel_uri'] = result.error || 'Invalid cancel_uri';
    } else if (result.normalizedUri) {
      validatedUris.cancel_uri = result.normalizedUri;
    }
  }

  const valid = Object.keys(errors).length === 0;

  return {
    valid,
    errors,
    ...(valid ? { validatedUris } : {}),
  };
}

/**
 * Parse allowed_redirect_origins from JSON string stored in client record
 *
 * Handles parse failures gracefully with strict mode:
 * - Parse failure → empty array (most secure)
 * - Non-array → empty array
 * - Filters out non-string elements
 *
 * Note: This is different from parseAllowedOrigins in origin-validator.ts
 * which parses comma-separated environment variable.
 *
 * @param jsonString - JSON string from database (oauth_clients.allowed_redirect_origins)
 * @returns Array of origin strings
 */
export function parseClientAllowedOrigins(jsonString: string | null): string[] {
  if (!jsonString) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) {
      log.warn('allowed_redirect_origins is not an array, treating as empty');
      return [];
    }
    return parsed.filter((o) => typeof o === 'string');
  } catch {
    // JSON parse failed → empty array (strict mode)
    log.warn('Failed to parse allowed_redirect_origins, treating as empty');
    return [];
  }
}

/**
 * Normalize an origin string for comparison
 *
 * - Lowercase
 * - Remove trailing slash
 * - Extract origin only (no path)
 *
 * @param origin - Origin string to normalize
 * @returns Normalized origin
 */
export function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin.toLowerCase();
  } catch {
    // If not a valid URL, return lowercase trimmed version
    return origin.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Validate and normalize allowed origins for client registration
 *
 * Used when registering or updating a client to ensure origins are valid.
 *
 * @param origins - Array of origin strings
 * @returns Validation result with normalized origins
 */
export function validateAllowedOrigins(origins: string[]): {
  valid: boolean;
  errors: string[];
  normalizedOrigins: string[];
} {
  const errors: string[] = [];
  const normalizedOrigins: string[] = [];
  const seen = new Set<string>();

  for (const origin of origins) {
    // Parse origin
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      errors.push(`Invalid origin format: ${origin}`);
      continue;
    }

    // Must be just origin (no path, query, or fragment)
    if (url.pathname !== '/' || url.search || url.hash) {
      errors.push(`Origin must not contain path, query, or fragment: ${origin}`);
      continue;
    }

    // HTTPS required (localhost excepted)
    if (!isSecureProtocol(url)) {
      errors.push(`HTTPS required for origin (except localhost): ${origin}`);
      continue;
    }

    // Normalize and deduplicate
    const normalized = url.origin.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      normalizedOrigins.push(normalized);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    normalizedOrigins,
  };
}

/**
 * Check if URL uses a secure protocol
 *
 * @param url - URL to check
 * @returns true if HTTPS or localhost
 */
function isSecureProtocol(url: URL): boolean {
  // HTTPS is always allowed
  if (url.protocol === 'https:') {
    return true;
  }

  // HTTP is only allowed for localhost (development)
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  }

  return false;
}

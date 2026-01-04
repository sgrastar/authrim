/**
 * API Versioning Types (Stripe-style date-based versioning)
 *
 * @module api-version
 * @see https://docs.authrim.com/api-versioning
 */

import { createLogger } from '../utils/logger';

const log = createLogger().module('ApiVersion');

/**
 * API Version string format: YYYY-MM-DD (Stripe-style)
 * Only this format is accepted for KV key consistency.
 *
 * @example "2024-12-01"
 */
export type ApiVersionString = string;

/**
 * Version pattern for validation: YYYY-MM-DD format only
 */
export const API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Unknown version handling mode
 *
 * - `fallback`: HTTP 200, use default version, add warning header (recommended for initial phase)
 * - `warn`: HTTP 200, use requested version (if valid format), add warning header
 * - `reject`: HTTP 400, RFC 9457 Problem Details response (for strict environments)
 */
export type UnknownVersionMode = 'fallback' | 'warn' | 'reject';

/**
 * API Version configuration
 */
export interface ApiVersionConfig {
  /** Current stable version (latest supported) */
  currentStableVersion: ApiVersionString;
  /** List of all supported versions */
  supportedVersions: ApiVersionString[];
  /**
   * Set of supported versions for O(1) lookup (derived from supportedVersions)
   * Security: Prevents timing attacks from array linear search
   */
  supportedVersionsSet: Set<ApiVersionString>;
  /** Default version when not specified */
  defaultVersion: ApiVersionString;
  /** Unknown version handling mode */
  unknownVersionMode: UnknownVersionMode;
  /** Admin API requires version header (future extension) */
  adminApiRequireVersion?: boolean;
  /** OIDC endpoints (excluded from versioning) */
  oidcEndpoints: string[];
}

/**
 * API Version context stored in request
 */
export interface ApiVersionContext {
  /** Version requested by client (null if not specified) */
  requestedVersion: ApiVersionString | null;
  /** Version actually applied */
  effectiveVersion: ApiVersionString;
  /** Whether this is an OIDC endpoint (versioning skipped) */
  isOidcEndpoint: boolean;
  /** Whether the requested version was unknown */
  isUnknownVersion: boolean;
  /** Warning messages for response headers */
  warnings: string[];
}

/**
 * OIDC endpoints that require exact matching
 * These paths must match exactly (no suffix allowed)
 *
 * Security: Prevents path traversal bypass like /authorize/../admin
 */
export const OIDC_EXACT_ENDPOINTS = [
  '/authorize',
  '/token',
  '/userinfo',
  '/introspect',
  '/revoke',
  '/jwks',
  '/par',
  '/device_authorization',
  '/bc-authorize', // CIBA
  '/ciba', // CIBA alternate
  '/logout',
  '/session',
] as const;

/**
 * OIDC endpoints that require prefix matching
 * These paths have legitimate subpaths (e.g., /.well-known/openid-configuration)
 */
export const OIDC_PREFIX_ENDPOINTS = ['/.well-known/'] as const;

/**
 * Maximum path length to prevent DoS via huge paths
 * Security: Limits memory/CPU usage during normalization
 */
const MAX_PATH_LENGTH = 2048;

/**
 * Normalize a URL path for secure comparison
 *
 * Security: Prevents bypass via:
 * - Trailing slashes: /authorize/ → /authorize
 * - Double slashes: /authorize//foo → /authorize/foo
 * - URL encoding: /authorize%2F → /authorize/
 * - Double encoding: /authorize%252F → /authorize/
 * - Path traversal: /authorize/../admin → /admin
 * - Unicode normalization: /ａｕｔｈ → /auth (if fullwidth chars used)
 * - Length limits before and after normalization (prevents expansion attacks)
 *
 * @param path - Raw request path
 * @returns Normalized path
 */
function normalizePath(path: string): string {
  // Security: Reject paths that are too long before processing
  if (path.length > MAX_PATH_LENGTH) {
    return path; // Return original (fail-safe)
  }

  try {
    let decoded = path;

    // Handle double/triple encoding: decode repeatedly until stable (max 5 iterations)
    // Security: Prevents bypass via %252F (encoded %2F)
    let previous = '';
    let iterations = 0;
    while (decoded !== previous && iterations < 5) {
      previous = decoded;
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // Malformed encoding, stop decoding
        break;
      }
      iterations++;
      // Security: Check length after each decode iteration
      if (decoded.length > MAX_PATH_LENGTH) {
        return path; // Return original (fail-safe)
      }
    }

    // Unicode normalization (NFC) to handle fullwidth characters
    // Security: Prevents bypass via /ａｕｔｈｏｒｉｚｅ (fullwidth)
    decoded = decoded.normalize('NFC');

    // Security: Re-check length after Unicode normalization (can expand or contract)
    if (decoded.length > MAX_PATH_LENGTH) {
      log.warn('Path exceeded max length after normalization');
      return path; // Return original (fail-safe)
    }

    // Collapse multiple slashes into single slash
    const collapsed = decoded.replace(/\/+/g, '/');

    // Resolve path traversal (.. and .)
    // Security: Prevents bypass via /authorize/../admin
    const parts = collapsed.split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        // Go up one directory (but don't go above root)
        if (resolved.length > 0) {
          resolved.pop();
        }
      } else if (part !== '.' && part !== '') {
        resolved.push(part);
      }
    }

    // Reconstruct path
    const result = '/' + resolved.join('/');

    // Remove trailing slash (but keep root /)
    const final = result.length > 1 ? result.replace(/\/+$/, '') : result;

    // Security: Final length check after normalization (defense-in-depth)
    if (final.length > MAX_PATH_LENGTH) {
      log.warn('Path exceeded max length after final normalization');
      return path; // Return original (fail-safe)
    }

    return final;
  } catch {
    // If any processing fails, return original path (fail-safe)
    return path;
  }
}

/**
 * Check if a path is an OIDC endpoint (uses exact or prefix matching as appropriate)
 *
 * Security: Path is normalized before comparison to prevent bypass attacks
 *
 * @param path - Request path
 * @param oidcEndpoints - List of OIDC endpoints
 * @returns true if this is an OIDC endpoint
 */
export function isOidcEndpoint(path: string, oidcEndpoints: string[]): boolean {
  // Security: Normalize path to prevent bypass via /authorize/, /authorize%2F, etc.
  const normalized = normalizePath(path);

  for (const endpoint of oidcEndpoints) {
    // Prefix endpoints (ending with /) use startsWith
    if (endpoint.endsWith('/')) {
      // For prefix match, compare against normalized path with the prefix (minus trailing /)
      const prefix = endpoint.slice(0, -1);
      if (normalized === prefix || normalized.startsWith(endpoint)) {
        return true;
      }
    } else {
      // Exact endpoints must match exactly (no suffix)
      if (normalized === endpoint) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Default API version configuration
 */
export const DEFAULT_API_VERSION_CONFIG: ApiVersionConfig = {
  currentStableVersion: '2024-12-01',
  supportedVersions: ['2024-12-01'],
  supportedVersionsSet: new Set(['2024-12-01']),
  defaultVersion: '2024-12-01',
  unknownVersionMode: 'fallback',
  adminApiRequireVersion: false,
  // Note: Endpoints NOT ending with '/' use exact match, those ending with '/' use prefix match
  oidcEndpoints: [...OIDC_EXACT_ENDPOINTS, ...OIDC_PREFIX_ENDPOINTS],
};

/**
 * Request header name for API version
 */
export const API_VERSION_REQUEST_HEADER = 'Authrim-Version';

/**
 * Response header name for applied API version
 */
export const API_VERSION_RESPONSE_HEADER = 'X-Authrim-Version';

/**
 * Warning header name for version issues
 * Format: unknown_version; requested=XXXX; applied=YYYY
 */
export const API_VERSION_WARNING_HEADER = 'X-Authrim-Version-Warning';

/**
 * RFC 9457 Problem Details type for unknown version error
 */
export const UNKNOWN_VERSION_ERROR_TYPE = 'https://docs.authrim.com/errors/unknown-api-version';

/**
 * Validate if a string is a valid API version format (YYYY-MM-DD)
 *
 * @param version - String to validate
 * @returns true if valid format
 */
export function isValidApiVersionFormat(version: string): boolean {
  return API_VERSION_PATTERN.test(version);
}

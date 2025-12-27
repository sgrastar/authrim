/**
 * Deprecation Types (RFC 8594 Sunset Header)
 *
 * Supports two granularity levels:
 * - Version-level: Deprecate entire API version
 * - Route-level: Deprecate specific endpoints
 *
 * Priority: Route > Version (route overrides version if both exist)
 *
 * @module deprecation
 * @see https://tools.ietf.org/html/rfc8594
 * @see https://docs.authrim.com/api-versioning
 */

/**
 * Deprecation entry for a version or route
 */
export interface DeprecationEntry {
  /** Sunset date in ISO 8601 format (when the feature will be removed) */
  sunsetDate: string;
  /** URL to migration guide (optional) */
  migrationGuideUrl?: string;
  /** Description of the replacement (optional) */
  replacement?: string;
  /** Affected API versions (only for route-level deprecation) */
  affectedVersions?: string[];
  /** Whether this deprecation is enabled */
  enabled: boolean;
}

/**
 * Deprecation context stored in request
 */
export interface DeprecationContext {
  /** Whether the endpoint/version is deprecated */
  isDeprecated: boolean;
  /** Sunset date if deprecated */
  sunsetDate?: string;
  /** Migration guide URL if available */
  migrationGuideUrl?: string;
  /** Replacement description if available */
  replacement?: string;
  /** Source of deprecation (version or route) */
  source?: 'version' | 'route';
}

/**
 * Default deprecation context (not deprecated)
 */
export const DEFAULT_DEPRECATION_CONTEXT: DeprecationContext = {
  isDeprecated: false,
};

/**
 * KV key prefix for version-level deprecation
 * Format: deprecation:version:YYYY-MM-DD
 */
export const DEPRECATION_VERSION_PREFIX = 'deprecation:version:';

/**
 * KV key prefix for route-level deprecation
 * Format: deprecation:route:/path/to/endpoint
 */
export const DEPRECATION_ROUTE_PREFIX = 'deprecation:route:';

/**
 * Response header names
 */
export const DEPRECATION_HEADER = 'Deprecation';
export const SUNSET_HEADER = 'Sunset';
export const LINK_HEADER = 'Link';

/**
 * Maximum JSON size for deprecation entries (prevents DoS via huge payloads)
 * 10KB should be more than enough for deprecation metadata
 */
const MAX_DEPRECATION_JSON_SIZE = 10000;

/**
 * Parse deprecation entry from KV JSON
 *
 * Security: Limits JSON size to prevent DoS via huge payloads
 *
 * @param json - JSON string from KV
 * @returns Parsed entry or null if invalid
 */
export function parseDeprecationEntry(json: string | null): DeprecationEntry | null {
  if (!json) return null;

  // Security: Limit JSON size to prevent DoS via huge payloads
  if (json.length > MAX_DEPRECATION_JSON_SIZE) {
    console.warn('[Deprecation] JSON payload too large, rejecting');
    return null;
  }

  try {
    const entry = JSON.parse(json) as DeprecationEntry;
    // Validate required fields
    if (typeof entry.sunsetDate !== 'string' || typeof entry.enabled !== 'boolean') {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Format sunset date as HTTP-date (RFC 7231)
 *
 * Security: Returns null for invalid dates instead of "Invalid Date" string
 * This prevents sending invalid HTTP headers to clients.
 *
 * @param isoDate - ISO 8601 date string
 * @returns HTTP-date string (e.g., "Sat, 01 Jun 2025 00:00:00 GMT") or null if invalid
 */
export function formatSunsetDate(isoDate: string): string | null {
  try {
    const date = new Date(isoDate);
    // Check if date is valid (NaN check)
    if (Number.isNaN(date.getTime())) {
      console.warn('[Deprecation] Invalid sunset date format:', isoDate);
      return null;
    }
    return date.toUTCString();
  } catch {
    console.warn('[Deprecation] Error parsing sunset date:', isoDate);
    return null;
  }
}

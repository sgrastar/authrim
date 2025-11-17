/**
 * Origin Validator Utility
 * Validates request origins against an allowlist with wildcard support
 */

/**
 * Check if an origin matches an allowed pattern
 * Supports exact matches and wildcard patterns (e.g., https://*.example.com)
 *
 * @param origin - The origin to validate (e.g., "https://example.com")
 * @param allowedPatterns - Array of allowed origin patterns
 * @returns true if origin is allowed, false otherwise
 */
export function isAllowedOrigin(origin: string | undefined, allowedPatterns: string[]): boolean {
  if (!origin) {
    return false;
  }

  // Normalize origin (remove trailing slash)
  const normalizedOrigin = origin.replace(/\/$/, '');

  for (const pattern of allowedPatterns) {
    const normalizedPattern = pattern.trim().replace(/\/$/, '');

    // Exact match
    if (normalizedOrigin === normalizedPattern) {
      return true;
    }

    // Wildcard match (e.g., https://*.pages.dev)
    if (normalizedPattern.includes('*')) {
      const regex = patternToRegex(normalizedPattern);
      if (regex.test(normalizedOrigin)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Convert a wildcard pattern to a regex
 * Supports: https://*.example.com, https://subdomain.*.example.com
 *
 * @param pattern - Pattern with wildcards
 * @returns RegExp for matching
 */
function patternToRegex(pattern: string): RegExp {
  // Escape special regex characters except *
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    // Replace * with regex pattern for subdomain
    .replace(/\*/g, '[a-z0-9]([a-z0-9-]*[a-z0-9])?');

  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Parse ALLOWED_ORIGINS environment variable into array
 * Supports comma-separated values
 *
 * @param allowedOriginsEnv - Environment variable value
 * @returns Array of allowed origin patterns
 */
export function parseAllowedOrigins(allowedOriginsEnv: string | undefined): string[] {
  if (!allowedOriginsEnv) {
    return [];
  }

  return allowedOriginsEnv
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

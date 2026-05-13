/**
 * Origin Validator Utility
 * Validates request origins against an allowlist with wildcard support
 */

import { extractOrigin } from './session-state';

/**
 * Check if an origin matches an allowed pattern
 * Supports exact matches and single-label subdomain wildcards (e.g., https://*.example.com)
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
      if (regex?.test(normalizedOrigin)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Convert a wildcard pattern to a regex.
 * Only supports HTTPS single-label subdomain wildcards such as https://*.example.com.
 *
 * @param pattern - Pattern with wildcards
 * @returns RegExp for matching
 */
function patternToRegex(pattern: string): RegExp | null {
  if (
    !/^https:\/\/\*\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i.test(
      pattern
    )
  ) {
    return null;
  }

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?')}$`, 'i');
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

/**
 * Check if an origin is allowed based on client's redirect URIs
 *
 * Extracts origins from client.redirect.allowedRedirectUris and checks if the given origin matches.
 *
 * Security considerations:
 * - Exact origin match required (protocol, host, port must all match)
 * - Wildcards in redirect URIs are NOT supported for origin extraction
 * - If client has allowLocalhost=true, localhost origins are implicitly allowed
 *
 * @param client - Client contract with redirect configuration
 * @param requestOrigin - Origin from the request (e.g., from Origin or Referer header)
 * @returns true if origin is allowed, false otherwise
 *
 * @example
 * const client = {
 *   redirect: {
 *     allowedRedirectUris: ['https://example.com/callback', 'https://app.example.com/auth'],
 *     allowLocalhost: true
 *   }
 * };
 *
 * isAllowedOriginForClient(client, 'https://example.com') → true
 * isAllowedOriginForClient(client, 'https://app.example.com') → true
 * isAllowedOriginForClient(client, 'https://evil.com') → false
 * isAllowedOriginForClient(client, 'http://localhost:3000') → true (because allowLocalhost=true)
 */
export function isAllowedOriginForClient(
  client: { redirect: { allowedRedirectUris: string[]; allowLocalhost: boolean } },
  requestOrigin: string
): boolean {
  if (!requestOrigin) {
    return false;
  }

  // Normalize request origin (remove trailing slash)
  const normalizedRequestOrigin = requestOrigin.replace(/\/$/, '');

  // Extract origins from allowedRedirectUris
  const allowedOrigins = new Set<string>();

  for (const redirectUri of client.redirect.allowedRedirectUris || []) {
    const origin = extractOrigin(redirectUri);
    if (origin && origin !== '') {
      allowedOrigins.add(origin);
    }
  }

  // Check if request origin matches any allowed origin
  if (allowedOrigins.has(normalizedRequestOrigin)) {
    return true;
  }

  // Check localhost exception (if enabled)
  if (client.redirect.allowLocalhost) {
    try {
      const requestUrl = new URL(normalizedRequestOrigin);
      const hostname = requestUrl.hostname;

      // Allow localhost, 127.0.0.1, and ::1
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return true;
      }
    } catch {
      // Invalid URL format
      return false;
    }
  }

  return false;
}

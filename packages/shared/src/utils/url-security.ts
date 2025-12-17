/**
 * URL Security Utilities
 * Provides protection against SSRF (Server-Side Request Forgery) attacks
 *
 * SSRF attacks occur when an attacker can make a server issue requests to
 * internal/private resources. This module provides validation to prevent
 * requests to internal addresses.
 */

/**
 * Internal/private IP patterns that should be blocked for SSRF protection
 *
 * Includes:
 * - localhost (127.x.x.x, ::1)
 * - Private IPv4 ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
 * - Link-local addresses (169.254.x.x, fe80::)
 * - Unique local addresses (fc00::, fd00::)
 * - Zero address (0.x.x.x)
 * - Special domains (.local, .internal)
 */
const BLOCKED_HOSTNAME_PATTERNS = [
  // localhost
  'localhost',
  '127.',
  // Private IPv4 (Class A)
  '10.',
  // Private IPv4 (Class B) - 172.16.0.0 to 172.31.255.255
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  // Private IPv4 (Class C)
  '192.168.',
  // Link-local IPv4
  '169.254.',
  // Zero address
  '0.',
  // IPv6 localhost
  '::1',
  // IPv6 link-local
  'fe80::',
  // IPv6 unique local
  'fc00::',
  'fd00::',
];

/**
 * Domain suffixes that should be blocked for SSRF protection
 */
const BLOCKED_DOMAIN_SUFFIXES = ['.local', '.internal', '.localhost'];

/**
 * Check if a URL hostname points to an internal/private address
 *
 * @param url - The URL to check (string or URL object)
 * @returns true if the URL points to an internal address (should be blocked)
 *
 * @example
 * ```typescript
 * isInternalUrl('https://localhost/api');  // true
 * isInternalUrl('https://192.168.1.1/api');  // true
 * isInternalUrl('https://example.com/api');  // false
 * ```
 */
export function isInternalUrl(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    // Invalid URL - treat as potentially dangerous
    return true;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Check against blocked patterns
  const matchesBlockedPattern = BLOCKED_HOSTNAME_PATTERNS.some(
    (pattern) => hostname === pattern || hostname.startsWith(pattern)
  );

  if (matchesBlockedPattern) {
    return true;
  }

  // Check against blocked domain suffixes
  const matchesBlockedSuffix = BLOCKED_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix));

  if (matchesBlockedSuffix) {
    return true;
  }

  return false;
}

/**
 * Validate a URL for SSRF protection
 *
 * Returns an error object if the URL is invalid or points to an internal address.
 *
 * @param url - The URL to validate
 * @param options - Validation options
 * @returns null if valid, error object if invalid
 *
 * @example
 * ```typescript
 * const error = validateExternalUrl('https://localhost/api');
 * if (error) {
 *   return c.json({ error: error.error, error_description: error.error_description }, 400);
 * }
 * ```
 */
export function validateExternalUrl(
  url: string,
  options: {
    /** Require HTTPS protocol (default: true) */
    requireHttps?: boolean;
    /** Allow http://localhost for development (default: false) */
    allowLocalhost?: boolean;
    /** Error type to return (default: 'invalid_request') */
    errorType?: string;
    /** Field name for error messages */
    fieldName?: string;
  } = {}
): { error: string; error_description: string } | null {
  const {
    requireHttps = true,
    allowLocalhost = false,
    errorType = 'invalid_request',
    fieldName = 'URL',
  } = options;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      error: errorType,
      error_description: `${fieldName} must be a valid URL`,
    };
  }

  // Protocol validation
  if (requireHttps) {
    const isAllowedHttp =
      allowLocalhost && parsed.protocol === 'http:' && parsed.hostname === 'localhost';
    if (parsed.protocol !== 'https:' && !isAllowedHttp) {
      return {
        error: errorType,
        error_description: `${fieldName} must use HTTPS`,
      };
    }
  }

  // SSRF protection: Block internal addresses
  // Even with HTTPS, internal addresses should be blocked to prevent SSRF
  if (isInternalUrl(parsed)) {
    // Special case: Allow localhost if explicitly permitted
    if (allowLocalhost && parsed.hostname === 'localhost') {
      return null;
    }

    return {
      error: errorType,
      error_description: `${fieldName} cannot point to internal addresses`,
    };
  }

  return null;
}

/**
 * Safe fetch wrapper with SSRF protection
 *
 * Validates the URL before making the request and prevents requests to internal addresses.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options plus SSRF validation options
 * @returns Fetch response
 * @throws Error if URL is invalid or points to an internal address
 *
 * @example
 * ```typescript
 * try {
 *   const response = await safeFetch('https://example.com/api', {
 *     requireHttps: true,
 *     headers: { Accept: 'application/json' }
 *   });
 *   const data = await response.json();
 * } catch (error) {
 *   // Handle SSRF block or fetch error
 * }
 * ```
 */
export async function safeFetch(
  url: string,
  options: RequestInit & {
    /** Require HTTPS protocol (default: true) */
    requireHttps?: boolean;
    /** Allow http://localhost for development (default: false) */
    allowLocalhost?: boolean;
  } = {}
): Promise<Response> {
  const { requireHttps, allowLocalhost, ...fetchOptions } = options;

  const validationError = validateExternalUrl(url, {
    requireHttps,
    allowLocalhost,
    errorType: 'ssrf_blocked',
    fieldName: 'Target URL',
  });

  if (validationError) {
    throw new Error(`SSRF protection: ${validationError.error_description}`);
  }

  return fetch(url, fetchOptions);
}

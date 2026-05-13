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

/** Default timeout for safe fetch in milliseconds (10 seconds) */
const DEFAULT_FETCH_TIMEOUT_MS = 10000;

/** Default maximum response size in bytes (1 MB) */
const DEFAULT_MAX_RESPONSE_SIZE = 1024 * 1024;

/**
 * Safe fetch options extending RequestInit
 */
export interface SafeFetchOptions extends RequestInit {
  /** Require HTTPS protocol (default: true) */
  requireHttps?: boolean;
  /** Allow http://localhost for development (default: false) */
  allowLocalhost?: boolean;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Maximum response size in bytes (default: 1MB). Set to 0 to disable. */
  maxResponseSize?: number;
}

/**
 * Safe fetch wrapper with SSRF protection, timeout, and response size limits
 *
 * Validates the URL before making the request and prevents requests to internal addresses.
 * Includes timeout to prevent hanging requests and response size limits to prevent DoS.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options plus SSRF validation options
 * @returns Fetch response
 * @throws Error if URL is invalid, points to an internal address, times out, or exceeds size limit
 *
 * @example
 * ```typescript
 * try {
 *   const response = await safeFetch('https://example.com/api', {
 *     requireHttps: true,
 *     timeoutMs: 5000,
 *     headers: { Accept: 'application/json' }
 *   });
 *   const data = await response.json();
 * } catch (error) {
 *   // Handle SSRF block, timeout, or fetch error
 * }
 * ```
 */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<Response> {
  const {
    requireHttps,
    allowLocalhost,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxResponseSize = DEFAULT_MAX_RESPONSE_SIZE,
    ...fetchOptions
  } = options;

  // SSRF validation
  const validationError = validateExternalUrl(url, {
    requireHttps,
    allowLocalhost,
    errorType: 'ssrf_blocked',
    fieldName: 'Target URL',
  });

  if (validationError) {
    throw new Error(`SSRF protection: ${validationError.error_description}`);
  }

  // Setup timeout with AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });

    // Check response size if Content-Length header is present
    if (maxResponseSize > 0) {
      const contentLength = response.headers?.get?.('Content-Length');
      if (contentLength && parseInt(contentLength, 10) > maxResponseSize) {
        throw new Error(
          `Response size exceeds limit: ${contentLength} bytes > ${maxResponseSize} bytes`
        );
      }
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Safe fetch for JSON responses with size-limited parsing
 *
 * Fetches a URL and parses the response as JSON, with SSRF protection,
 * timeout, and response size limits.
 *
 * @param url - The URL to fetch
 * @param options - Safe fetch options
 * @returns Parsed JSON response
 * @throws Error if URL is invalid, fetch fails, or JSON parsing fails
 *
 * @example
 * ```typescript
 * const data = await safeFetchJson<{ id: string }>('https://example.com/api');
 * ```
 */
export async function safeFetchJson<T = unknown>(
  url: string,
  options: SafeFetchOptions = {}
): Promise<T> {
  const response = await safeFetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const maxSize = options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
  if (maxSize > 0) {
    const text = await readResponseTextWithLimit(response, maxSize);
    return JSON.parse(text) as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Safe fetch for text responses with size-limited body reading.
 *
 * Use this for externally supplied XML, metadata, or other text payloads where
 * `response.text()` would otherwise buffer an unbounded response body.
 */
export async function safeFetchText(url: string, options: SafeFetchOptions = {}): Promise<string> {
  const response = await safeFetch(url, options);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const maxSize = options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
  if (maxSize > 0) {
    return readResponseTextWithLimit(response, maxSize);
  }

  return response.text();
}

/**
 * Read a response body as text while enforcing a byte limit.
 *
 * This caps streamed responses even when the peer omits Content-Length.
 */
export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (maxBytes <= 0) {
    return response.text();
  }

  if (!response.body) {
    const text =
      typeof response.text === 'function'
        ? await response.text()
        : typeof response.json === 'function'
          ? JSON.stringify(await response.json())
          : '';
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) {
      throw new Error(`Response body exceeds limit: ${byteLength} > ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`Response body exceeds limit: ${totalBytes} > ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

/**
 * Read at most `maxBytes` of a response body as text and cancel the remaining
 * stream. Use for diagnostic previews where oversized responses should be
 * truncated instead of rejected.
 */
export async function readResponseTextPreview(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (maxBytes <= 0) {
    return '';
  }

  if (!response.body) {
    const text =
      typeof response.text === 'function'
        ? await response.text()
        : typeof response.json === 'function'
          ? JSON.stringify(await response.json())
          : '';
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - totalBytes;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        totalBytes += remaining;
        truncated = true;
        break;
      }

      chunks.push(value);
      totalBytes += value.byteLength;
    }
    if (totalBytes >= maxBytes) {
      truncated = true;
    }
    if (truncated) {
      void reader.cancel().catch(() => {});
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

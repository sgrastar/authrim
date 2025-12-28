/**
 * SSRF Protection Utilities
 *
 * Provides URL validation to prevent Server-Side Request Forgery (SSRF) attacks.
 * Used for validating webhook URIs, sector_identifier_uri, and other external URLs.
 *
 * Features:
 * - Blocks private/internal IP ranges (RFC 1918, RFC 4193)
 * - Blocks loopback addresses
 * - Blocks link-local addresses
 * - Blocks cloud provider metadata endpoints (AWS, GCP, Azure)
 * - Blocks known internal hostnames (localhost, *.local, *.internal)
 *
 * @packageDocumentation
 */

/**
 * SSRF Validation Result
 */
export interface SSRFValidationResult {
  /** Whether the URL is safe to fetch */
  valid: boolean;

  /** Error message if validation failed */
  error?: string;

  /** Parsed URL (if valid) */
  parsedUrl?: URL;
}

/**
 * SSRF Protection Configuration
 */
export interface SSRFProtectionConfig {
  /** Allow localhost (for development) */
  allowLocalhost?: boolean;

  /** Additional blocked hostnames (glob patterns) */
  additionalBlockedHostnames?: string[];

  /** Additional allowed hostnames (overrides blocks) */
  allowedHostnames?: string[];
}

/**
 * IPv4 ranges to block (CIDR notation)
 *
 * Includes:
 * - RFC 1918 private networks
 * - Loopback (127.0.0.0/8)
 * - Link-local (169.254.0.0/16)
 * - Cloud metadata (169.254.169.254)
 */
const BLOCKED_IPV4_RANGES: Array<{ network: number; mask: number; description: string }> = [
  // Loopback
  { network: 0x7f000000, mask: 0xff000000, description: 'Loopback (127.0.0.0/8)' },

  // Private networks (RFC 1918)
  { network: 0x0a000000, mask: 0xff000000, description: 'Private (10.0.0.0/8)' },
  { network: 0xac100000, mask: 0xfff00000, description: 'Private (172.16.0.0/12)' },
  { network: 0xc0a80000, mask: 0xffff0000, description: 'Private (192.168.0.0/16)' },

  // Link-local
  { network: 0xa9fe0000, mask: 0xffff0000, description: 'Link-local (169.254.0.0/16)' },

  // Shared address space (RFC 6598)
  { network: 0x64400000, mask: 0xffc00000, description: 'Shared (100.64.0.0/10)' },

  // Documentation ranges (RFC 5737)
  { network: 0xc0000200, mask: 0xffffff00, description: 'Documentation (192.0.2.0/24)' },
  { network: 0xc6336400, mask: 0xffffff00, description: 'Documentation (198.51.100.0/24)' },
  { network: 0xcb007100, mask: 0xffffff00, description: 'Documentation (203.0.113.0/24)' },

  // Broadcast
  { network: 0xffffffff, mask: 0xffffffff, description: 'Broadcast (255.255.255.255)' },

  // Current network (RFC 1122)
  { network: 0x00000000, mask: 0xff000000, description: 'Current network (0.0.0.0/8)' },
];

/**
 * Specific IPv4 addresses to block
 *
 * Cloud provider metadata endpoints
 */
const BLOCKED_IPV4_ADDRESSES: Array<{ ip: string; description: string }> = [
  // AWS/GCP/Azure Instance Metadata Service (IMDS)
  { ip: '169.254.169.254', description: 'Cloud metadata endpoint' },

  // AWS ECS task metadata
  { ip: '169.254.170.2', description: 'AWS ECS metadata' },

  // Azure Instance Metadata (alias)
  { ip: '168.63.129.16', description: 'Azure wireserver' },
];

/**
 * Hostnames to block (case-insensitive, supports wildcards)
 */
const BLOCKED_HOSTNAMES: string[] = [
  // Localhost variants
  'localhost',
  'localhost.localdomain',

  // Local domain TLDs
  '*.local',
  '*.localdomain',
  '*.localhost',

  // Internal/private
  '*.internal',
  '*.private',
  '*.corp',
  '*.home',
  '*.lan',

  // Cloud metadata
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  '*.metadata.google.internal',

  // Kubernetes internal
  '*.cluster.local',
  '*.svc.cluster.local',
  '*.pod.cluster.local',

  // AWS internal
  '*.compute.internal',
  '*.ec2.internal',
  '*.amazonaws.com.cn',

  // Link-local hostnames
  '*.linklocal',
];

/**
 * Parse IPv4 address to 32-bit integer
 */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }

  return result >>> 0; // Convert to unsigned
}

/**
 * Check if IPv4 address is in a blocked range
 */
function isIPv4InBlockedRange(ip: string): { blocked: boolean; reason?: string } {
  const ipNum = parseIPv4(ip);
  if (ipNum === null) {
    return { blocked: false };
  }

  // Check specific blocked addresses first
  for (const blocked of BLOCKED_IPV4_ADDRESSES) {
    if (ip === blocked.ip) {
      return { blocked: true, reason: blocked.description };
    }
  }

  // Check CIDR ranges
  // Note: Use >>> 0 to convert to unsigned 32-bit integer
  // JavaScript bitwise ops treat numbers as signed 32-bit, causing comparison issues
  for (const range of BLOCKED_IPV4_RANGES) {
    if ((ipNum & range.mask) >>> 0 === range.network) {
      return { blocked: true, reason: range.description };
    }
  }

  return { blocked: false };
}

/**
 * Check if IPv6 address should be blocked
 *
 * Blocks:
 * - Loopback (::1)
 * - Unspecified (::)
 * - IPv4-mapped (::ffff:0:0/96)
 * - IPv4-compatible (deprecated, ::0:0:0:0/96)
 * - Unique local (fc00::/7)
 * - Link-local (fe80::/10)
 * - Site-local (deprecated, fec0::/10)
 */
function isIPv6Blocked(ip: string): { blocked: boolean; reason?: string } {
  const normalized = ip.toLowerCase();

  // Loopback
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return { blocked: true, reason: 'IPv6 loopback (::1)' };
  }

  // Unspecified
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
    return { blocked: true, reason: 'IPv6 unspecified (::)' };
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x) - dotted decimal format
  const ipv4MappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4MappedMatch) {
    const ipv4 = ipv4MappedMatch[1];
    const ipv4Result = isIPv4InBlockedRange(ipv4);
    if (ipv4Result.blocked) {
      return { blocked: true, reason: `IPv4-mapped ${ipv4Result.reason}` };
    }
  }

  // IPv4-mapped IPv6 in hex format (::ffff:XXXX:XXXX)
  // URL parsers often convert ::ffff:127.0.0.1 to ::ffff:7f00:1
  const ipv4MappedHexMatch = normalized.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (ipv4MappedHexMatch) {
    const highWord = parseInt(ipv4MappedHexMatch[1], 16);
    const lowWord = parseInt(ipv4MappedHexMatch[2], 16);
    // Convert hex words back to IPv4: XXXX:YYYY -> a.b.c.d
    const a = (highWord >> 8) & 0xff;
    const b = highWord & 0xff;
    const c = (lowWord >> 8) & 0xff;
    const d = lowWord & 0xff;
    const ipv4 = `${a}.${b}.${c}.${d}`;
    const ipv4Result = isIPv4InBlockedRange(ipv4);
    if (ipv4Result.blocked) {
      return { blocked: true, reason: `IPv4-mapped ${ipv4Result.reason}` };
    }
  }

  // Unique local addresses (fc00::/7)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return { blocked: true, reason: 'IPv6 unique local (fc00::/7)' };
  }

  // Link-local (fe80::/10)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return { blocked: true, reason: 'IPv6 link-local (fe80::/10)' };
  }

  // Site-local (deprecated, fec0::/10)
  if (
    normalized.startsWith('fec') ||
    normalized.startsWith('fed') ||
    normalized.startsWith('fee') ||
    normalized.startsWith('fef')
  ) {
    return { blocked: true, reason: 'IPv6 site-local (fec0::/10)' };
  }

  return { blocked: false };
}

/**
 * Check if hostname matches a blocked pattern
 *
 * @param hostname - Hostname to check
 * @param patterns - Patterns to match against (supports * wildcard)
 */
function matchesBlockedHostname(
  hostname: string,
  patterns: string[]
): { blocked: boolean; pattern?: string } {
  const normalizedHostname = hostname.toLowerCase();

  for (const pattern of patterns) {
    const normalizedPattern = pattern.toLowerCase();

    if (normalizedPattern.startsWith('*.')) {
      // Wildcard pattern: *.example.com matches foo.example.com
      const suffix = normalizedPattern.slice(1); // .example.com
      if (
        normalizedHostname.endsWith(suffix) ||
        normalizedHostname === normalizedPattern.slice(2)
      ) {
        return { blocked: true, pattern };
      }
    } else {
      // Exact match
      if (normalizedHostname === normalizedPattern) {
        return { blocked: true, pattern };
      }
    }
  }

  return { blocked: false };
}

/**
 * Validate a URL for SSRF vulnerabilities
 *
 * SECURITY NOTE: This function relies on the URL parser (WHATWG URL Standard) for
 * hostname normalization. The parser handles:
 * - IPv4 with leading zeros (127.000.000.001 → 127.0.0.1)
 * - IPv6 normalization (mixed case, zero compression)
 * - Punycode for IDN hostnames
 *
 * We validate AFTER parsing to ensure we're checking the normalized form.
 *
 * @param url - URL string to validate
 * @param config - Optional configuration
 * @returns Validation result
 */
export function validateUrlForSSRF(
  url: string,
  config: SSRFProtectionConfig = {}
): SSRFValidationResult {
  const { allowLocalhost = false, additionalBlockedHostnames = [], allowedHostnames = [] } = config;

  // Parse URL - this normalizes the hostname according to WHATWG URL Standard
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Only allow http/https schemes
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { valid: false, error: `Invalid scheme: ${parsedUrl.protocol}` };
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // Check allowed hostnames first (override blocks)
  if (allowedHostnames.length > 0) {
    const allowedMatch = matchesBlockedHostname(hostname, allowedHostnames);
    if (allowedMatch.blocked) {
      return { valid: true, parsedUrl };
    }
  }

  // Allow localhost if configured
  // Note: IPv6 addresses in URLs may include brackets (e.g., [::1])
  if (
    allowLocalhost &&
    (hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]')
  ) {
    return { valid: true, parsedUrl };
  }

  // Check if hostname is an IP address
  const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const isIPv6 = hostname.includes(':');

  if (isIPv4) {
    const ipv4Result = isIPv4InBlockedRange(hostname);
    if (ipv4Result.blocked) {
      return { valid: false, error: `Blocked IP range: ${ipv4Result.reason}` };
    }
  } else if (isIPv6) {
    // Remove brackets if present
    const cleanIPv6 = hostname.replace(/^\[|\]$/g, '');
    const ipv6Result = isIPv6Blocked(cleanIPv6);
    if (ipv6Result.blocked) {
      return { valid: false, error: `Blocked IPv6 address: ${ipv6Result.reason}` };
    }
  } else {
    // Hostname - check against blocked patterns
    const allBlockedHostnames = [...BLOCKED_HOSTNAMES, ...additionalBlockedHostnames];
    const hostnameResult = matchesBlockedHostname(hostname, allBlockedHostnames);
    if (hostnameResult.blocked) {
      return { valid: false, error: `Blocked hostname pattern: ${hostnameResult.pattern}` };
    }
  }

  return { valid: true, parsedUrl };
}

/**
 * Validate a webhook URL
 *
 * Stricter validation for webhook endpoints:
 * - Must be HTTPS (except localhost in development)
 * - No fragment identifiers allowed
 * - SSRF protection enabled
 *
 * @param url - URL string to validate
 * @param allowLocalhostHttp - Allow http://localhost for development
 * @returns Validation result
 */
export function validateWebhookUrl(
  url: string,
  allowLocalhostHttp: boolean = false
): SSRFValidationResult {
  // First, run SSRF validation
  const ssrfResult = validateUrlForSSRF(url, { allowLocalhost: allowLocalhostHttp });
  if (!ssrfResult.valid) {
    return ssrfResult;
  }

  const parsedUrl = ssrfResult.parsedUrl!;

  // Check for fragment identifiers
  if (parsedUrl.hash) {
    return { valid: false, error: 'Fragment identifiers are not allowed in webhook URLs' };
  }

  // Require HTTPS (except localhost in development)
  const isLocalhost =
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === '::1';

  if (parsedUrl.protocol !== 'https:') {
    if (allowLocalhostHttp && isLocalhost) {
      // Allow http://localhost for development
      return { valid: true, parsedUrl };
    }
    return { valid: false, error: 'Webhook URL must use HTTPS' };
  }

  return { valid: true, parsedUrl };
}

/**
 * Sanitize URL for logging
 *
 * Removes sensitive information (credentials) from URL for safe logging.
 *
 * @param url - URL to sanitize
 * @returns Sanitized URL string
 */
export function sanitizeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);

    // Remove credentials
    parsed.username = '';
    parsed.password = '';

    return parsed.toString();
  } catch {
    // If parsing fails, return a redacted version
    return '[invalid-url]';
  }
}

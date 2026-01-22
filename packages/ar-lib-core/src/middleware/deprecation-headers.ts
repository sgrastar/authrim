/**
 * Deprecation Headers Middleware (RFC 8594 Sunset Header)
 *
 * Adds deprecation-related headers to responses for deprecated endpoints/versions.
 *
 * Middleware order (important):
 *   api-version → deprecation-headers → sdk-compatibility → auth/policy/handler
 *
 * Output Headers:
 * - Deprecation: true
 * - Sunset: Sat, 01 Jun 2025 00:00:00 GMT
 * - Link: <https://docs.authrim.com/migration/v2>; rel="deprecation"
 *
 * @module deprecation-headers-middleware
 * @see https://tools.ietf.org/html/rfc8594
 * @see https://docs.authrim.com/api-versioning
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import type { DeprecationContext } from '../types/deprecation';
import {
  DEPRECATION_HEADER,
  SUNSET_HEADER,
  LINK_HEADER,
  formatSunsetDate,
  DEFAULT_DEPRECATION_CONTEXT,
} from '../types/deprecation';
import { getDeprecationContext } from '../utils/deprecation-config';
import { getApiVersionContext } from './api-version';

/**
 * Maximum URL length for security (prevent DoS via huge URLs)
 */
const MAX_URL_LENGTH = 2048;

/**
 * Validate and sanitize URL for HTTP headers
 *
 * Security measures:
 * - Only allows http:// and https:// schemes
 * - Removes control characters (CRLF injection prevention)
 * - Limits URL length to prevent DoS
 *
 * @param url - URL to validate
 * @returns Sanitized URL or null if invalid
 */
function sanitizeUrlForHeader(url: string): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // Limit length first
  if (url.length > MAX_URL_LENGTH) {
    return null;
  }

  // Remove control characters (ASCII 0-31) including \r and \n
  // eslint-disable-next-line no-control-regex
  const sanitized = url.replace(/[\x00-\x1f]/gu, '');

  // Validate URL format and scheme
  try {
    const parsed = new URL(sanitized);
    // Only allow http and https schemes
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    // Return the sanitized, parsed URL (normalizes it)
    return parsed.href;
  } catch {
    return null;
  }
}

/** Context key for deprecation info */
const DEPRECATION_CONTEXT_KEY = 'deprecation';

/**
 * Variables added to Hono context by this middleware
 */
export interface DeprecationVariables {
  deprecation: DeprecationContext;
}

/**
 * Deprecation Headers Middleware
 *
 * - Checks for version-level or route-level deprecation
 * - Adds RFC 8594 compliant headers to responses
 * - Fail-safe: If KV is unavailable, no headers are added
 *
 * @returns Hono middleware handler
 */
export function deprecationHeadersMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Helper to set context (type-safe wrapper)
    const setContext = (ctx: DeprecationContext): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (c as any).set(DEPRECATION_CONTEXT_KEY, ctx);
    };

    // Check if deprecation headers are enabled
    const enabled = c.env.ENABLE_DEPRECATION_HEADERS !== 'false';
    if (!enabled) {
      setContext(DEFAULT_DEPRECATION_CONTEXT);
      return next();
    }

    // Get current API version from context (set by api-version middleware)
    const apiVersionCtx = getApiVersionContext(c);
    const version = apiVersionCtx.effectiveVersion;
    const path = c.req.path;

    // Skip OIDC endpoints (they're not versioned)
    if (apiVersionCtx.isOidcEndpoint) {
      setContext(DEFAULT_DEPRECATION_CONTEXT);
      return next();
    }

    // Get deprecation context (fail-safe: returns default if error)
    const deprecationCtx = await getDeprecationContext(c.env, path, version);
    setContext(deprecationCtx);

    // Continue to next middleware/handler
    await next();

    // Add deprecation headers if deprecated
    if (deprecationCtx.isDeprecated) {
      // Deprecation: true (RFC draft-ietf-httpapi-deprecation-header)
      c.header(DEPRECATION_HEADER, 'true');

      // Sunset: <HTTP-date> (RFC 8594)
      // Security: Only set header if date is valid (formatSunsetDate returns null for invalid dates)
      if (deprecationCtx.sunsetDate) {
        const formattedDate = formatSunsetDate(deprecationCtx.sunsetDate);
        if (formattedDate) {
          c.header(SUNSET_HEADER, formattedDate);
        }
      }

      // Link: <url>; rel="deprecation"
      // Security: Validate and sanitize URL before inserting into header
      if (deprecationCtx.migrationGuideUrl) {
        const safeUrl = sanitizeUrlForHeader(deprecationCtx.migrationGuideUrl);
        if (safeUrl) {
          // Append to existing Link header if present
          const existingLink = c.res.headers.get(LINK_HEADER);
          const deprecationLink = `<${safeUrl}>; rel="deprecation"`;
          if (existingLink) {
            c.header(LINK_HEADER, `${existingLink}, ${deprecationLink}`);
          } else {
            c.header(LINK_HEADER, deprecationLink);
          }
        }
        // If URL is invalid, silently skip (fail-safe design)
      }
    }
  };
}

/**
 * Get deprecation context from request
 *
 * @param c - Hono context
 * @returns Deprecation context or default
 */
export function getDeprecationContextFromRequest(
  c: Context<{ Bindings: Env }>
): DeprecationContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const ctx = (c as any).get(DEPRECATION_CONTEXT_KEY) as DeprecationContext | undefined;
  return ctx || DEFAULT_DEPRECATION_CONTEXT;
}

/**
 * Check if current request is deprecated
 *
 * @param c - Hono context
 * @returns true if deprecated
 */
export function isDeprecated(c: Context<{ Bindings: Env }>): boolean {
  return getDeprecationContextFromRequest(c).isDeprecated;
}

/**
 * CSRF Protection Middleware
 *
 * Protects state-changing requests (POST, PUT, PATCH, DELETE) from
 * Cross-Site Request Forgery attacks.
 *
 * Even with httpOnly cookies, browsers automatically send cookies on
 * cross-origin requests when credentials: 'include' is used with fetch().
 * This middleware ensures that such requests can only originate from
 * allowed origins.
 *
 * Protection strategy:
 * 1. Safe methods (GET, HEAD, OPTIONS) are always allowed
 * 2. Requests with Bearer token authentication are skipped (server-to-server)
 * 3. Origin header is validated against the allowlist
 * 4. If Origin is absent, Referer header is validated as fallback
 * 5. If neither header is present, the request is rejected
 *    (legitimate browser requests always send at least one)
 *
 * This provides defense-in-depth alongside SameSite cookies and CORS.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import { isAllowedOrigin, parseAllowedOrigins } from '../utils/origin-validator';
import { createLogger } from '../utils/logger';

const log = createLogger().module('CSRF');

/**
 * Options for CSRF protection middleware
 */
export interface CsrfProtectionOptions {
  /**
   * Paths to exclude from CSRF checking.
   * Use for server-to-server endpoints that use client credentials
   * (e.g., /token, /par, /introspect, /register).
   * Supports prefix matching (e.g., '/scim/v2' matches '/scim/v2/Users').
   */
  excludePaths?: string[];

  /**
   * Skip CSRF check when Bearer token is present in Authorization header.
   * Server-to-server requests use Bearer tokens, not cookies, so they
   * are inherently not vulnerable to CSRF.
   * Default: true
   */
  skipForBearerToken?: boolean;

  /**
   * Custom function to resolve allowed origins.
   * If not provided, reads from env.ALLOWED_ORIGINS and env.ISSUER_URL.
   */
  resolveAllowedOrigins?: (c: Context<{ Bindings: Env }>) => Promise<string[]> | string[];
}

/**
 * Default function to resolve allowed origins from environment
 */
async function defaultResolveAllowedOrigins(c: Context<{ Bindings: Env }>): Promise<string[]> {
  // 1. Try KV (tenant settings) for dynamic configuration
  if (c.env.AUTHRIM_CONFIG) {
    try {
      const kvData = await c.env.AUTHRIM_CONFIG.get('settings:tenant:default:tenant');
      if (kvData) {
        const settings = JSON.parse(kvData) as Record<string, unknown>;
        const kvValue = settings['tenant.allowed_origins'];
        if (typeof kvValue === 'string' && kvValue.length > 0) {
          // Merge KV origins with env origins
          const kvOrigins = parseAllowedOrigins(kvValue);
          const envOrigins = c.env.ALLOWED_ORIGINS
            ? parseAllowedOrigins(c.env.ALLOWED_ORIGINS)
            : [];
          const issuerOrigins = c.env.ISSUER_URL ? parseAllowedOrigins(c.env.ISSUER_URL) : [];
          return [...new Set([...kvOrigins, ...envOrigins, ...issuerOrigins])];
        }
      }
    } catch {
      // KV read error - fall through to env
    }
  }

  // 2. Fallback to environment variables
  const originsStr = c.env.ALLOWED_ORIGINS || c.env.ISSUER_URL;
  return originsStr ? parseAllowedOrigins(originsStr) : [];
}

/**
 * Check if a request path matches any excluded path prefix
 */
function isExcludedPath(requestPath: string, excludePaths: string[]): boolean {
  for (const excluded of excludePaths) {
    if (requestPath === excluded || requestPath.startsWith(excluded + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * CSRF Protection Middleware
 *
 * Validates that state-changing requests originate from allowed origins.
 * Must be applied BEFORE route handlers.
 *
 * @param options - Configuration options
 * @returns Hono middleware function
 *
 * @example
 * // Apply to all admin API routes
 * app.use('/api/admin/*', csrfProtectionMiddleware());
 *
 * @example
 * // Apply with custom excluded paths
 * app.use('*', csrfProtectionMiddleware({
 *   excludePaths: ['/token', '/par', '/introspect'],
 * }));
 */
export function csrfProtectionMiddleware(options: CsrfProtectionOptions = {}) {
  const { excludePaths = [], skipForBearerToken = true } = options;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const method = c.req.method;

    // 1. Skip safe methods (no state change)
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }

    // 2. Skip excluded paths (server-to-server endpoints)
    if (excludePaths.length > 0) {
      const path = new URL(c.req.url).pathname;
      if (isExcludedPath(path, excludePaths)) {
        return next();
      }
    }

    // 3. Skip for Bearer token authentication (server-to-server)
    if (skipForBearerToken) {
      const authHeader = c.req.header('Authorization');
      if (authHeader?.startsWith('Bearer ')) {
        return next();
      }
    }

    // 4. Resolve allowed origins
    const resolveOrigins = options.resolveAllowedOrigins || defaultResolveAllowedOrigins;
    const allowedOrigins = await resolveOrigins(c);

    // 5. Validate Origin header (primary check)
    const origin = c.req.header('Origin');
    if (origin) {
      if (isAllowedOrigin(origin, allowedOrigins)) {
        return next();
      }

      log.warn('CSRF: Origin not allowed', {
        origin,
        method,
        path: new URL(c.req.url).pathname,
      });

      return c.json(
        {
          error: 'csrf_validation_failed',
          error_description: 'Origin not allowed',
        },
        403
      );
    }

    // 6. Fallback: validate Referer header
    const referer = c.req.header('Referer');
    if (referer) {
      try {
        const refererOrigin = new URL(referer).origin;
        if (isAllowedOrigin(refererOrigin, allowedOrigins)) {
          return next();
        }
      } catch {
        // Invalid Referer URL - fall through to rejection
      }

      log.warn('CSRF: Referer origin not allowed', {
        referer,
        method,
        path: new URL(c.req.url).pathname,
      });

      return c.json(
        {
          error: 'csrf_validation_failed',
          error_description: 'Referer origin not allowed',
        },
        403
      );
    }

    // 7. Neither Origin nor Referer present - reject
    // Legitimate browser requests always send at least one of these headers
    // on state-changing requests (POST/PUT/PATCH/DELETE).
    log.warn('CSRF: Missing Origin and Referer headers', {
      method,
      path: new URL(c.req.url).pathname,
    });

    return c.json(
      {
        error: 'csrf_validation_failed',
        error_description: 'Origin or Referer header is required for state-changing requests',
      },
      403
    );
  };
}

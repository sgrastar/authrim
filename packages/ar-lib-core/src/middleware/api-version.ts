/**
 * API Version Middleware (Stripe-style date-based versioning)
 *
 * Handles API version negotiation via Authrim-Version header.
 * OIDC endpoints are excluded from versioning per specification.
 *
 * Middleware order (important):
 *   api-version → deprecation-headers → sdk-compatibility → auth/policy/handler
 *
 * ## Security Design: Fail-Open Architecture
 *
 * This middleware uses a **fail-open** design by default:
 * - If KV is unavailable, uses environment/default values
 * - If version parsing fails, falls back to default version
 * - If configuration is invalid, continues with safe defaults
 *
 * **Rationale (OIDC/OAuth2 context)**:
 * - OIDC is authentication infrastructure - availability is critical
 * - A failing version check should not block authentication flows
 * - Better to serve with default version than reject valid requests
 *
 * **Trade-off**: Fail-open prioritizes availability over strict version control.
 * For environments requiring strict version enforcement, set
 * `API_UNKNOWN_VERSION_MODE=reject` in production configuration.
 *
 * @module api-version-middleware
 * @see https://docs.authrim.com/api-versioning
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import type { ApiVersionContext, ApiVersionString } from '../types/api-version';
import { createLogger } from '../utils/logger';

const log = createLogger().module('ApiVersion');
import {
  API_VERSION_REQUEST_HEADER,
  API_VERSION_RESPONSE_HEADER,
  API_VERSION_WARNING_HEADER,
  UNKNOWN_VERSION_ERROR_TYPE,
  isValidApiVersionFormat,
  isOidcEndpoint,
} from '../types/api-version';
import { getApiVersionConfig } from '../utils/api-version-config';

/**
 * Maximum length for header values (security: prevent DoS via huge headers)
 */
const MAX_HEADER_VALUE_LENGTH = 256;

/**
 * Sanitize header value to prevent HTTP Response Splitting (CRLF injection)
 * Removes control characters (ASCII 0-31) including \r and \n
 *
 * Security: Limit length FIRST to prevent CPU DoS on huge inputs,
 * then remove control characters to ensure no CRLF in final output.
 *
 * @param value - Raw header value
 * @returns Sanitized value safe for HTTP headers
 */
function sanitizeHeaderValue(value: string): string {
  if (!value) return '';
  // Security: Limit length FIRST to prevent processing huge inputs
  const limited =
    value.length > MAX_HEADER_VALUE_LENGTH ? value.substring(0, MAX_HEADER_VALUE_LENGTH) : value;
  // Then remove control characters (ASCII 0-31) including \r and \n
  // eslint-disable-next-line no-control-regex
  return limited.replace(/[\x00-\x1f]/gu, '');
}

/** Context key for API version */
const API_VERSION_CONTEXT_KEY = 'apiVersion';

/**
 * Variables added to Hono context by this middleware
 */
export interface ApiVersionVariables {
  apiVersion: ApiVersionContext;
}

/**
 * API Version Middleware
 *
 * - Parses Authrim-Version header
 * - Skips OIDC endpoints (not subject to versioning)
 * - Handles unknown versions based on configuration (fallback/warn/reject)
 * - Sets X-Authrim-Version and X-Authrim-Version-Warning headers
 *
 * @returns Hono middleware handler
 */
export function apiVersionMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Helper to set context (type-safe wrapper)
    const setContext = (ctx: ApiVersionContext): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (c as any).set(API_VERSION_CONTEXT_KEY, ctx);
    };

    // Check if API versioning is enabled
    const enabled = c.env.ENABLE_API_VERSIONING !== 'false';
    if (!enabled) {
      // Versioning disabled - skip
      const ctx: ApiVersionContext = {
        requestedVersion: null,
        effectiveVersion: '2024-12-01', // Default version
        isOidcEndpoint: false,
        isUnknownVersion: false,
        warnings: [],
      };
      setContext(ctx);
      return next();
    }

    const path = c.req.path;

    // Get configuration (fail-safe: uses defaults if KV unavailable)
    const config = await getApiVersionConfig(c.env);

    // Check if this is an OIDC endpoint (excluded from versioning)
    // Security: Uses exact matching for most endpoints, prefix only for /.well-known/
    const isOidc = isOidcEndpoint(path, config.oidcEndpoints);

    if (isOidc) {
      // OIDC endpoints are not versioned per specification
      const ctx: ApiVersionContext = {
        requestedVersion: null,
        effectiveVersion: config.currentStableVersion,
        isOidcEndpoint: true,
        isUnknownVersion: false,
        warnings: [],
      };
      setContext(ctx);
      return next();
    }

    // Parse requested version from header
    // Security: Handle multiple header values (use first valid one)
    const rawHeaderValue = c.req.header(API_VERSION_REQUEST_HEADER);
    let requestedVersion: string | undefined;

    if (rawHeaderValue) {
      // HTTP allows multiple values (comma-separated or multiple headers)
      // Hono may return comma-separated string; we use the first value
      const versions = rawHeaderValue.split(',').map((v) => v.trim());
      if (versions.length > 1) {
        log.warn('Multiple version headers detected, using first', { version: versions[0] });
      }
      requestedVersion = versions[0];
    }

    const warnings: string[] = [];
    let effectiveVersion: ApiVersionString;
    let isUnknownVersion = false;

    if (!requestedVersion) {
      // No version specified - use default
      effectiveVersion = config.defaultVersion;
    } else if (!isValidApiVersionFormat(requestedVersion)) {
      // Invalid format (not YYYY-MM-DD) - treat as unknown
      isUnknownVersion = true;
      const result = handleUnknownVersion(
        c,
        requestedVersion,
        config.defaultVersion,
        config.unknownVersionMode,
        config.supportedVersions
      );
      if (result.shouldReject && result.response) {
        return result.response;
      }
      effectiveVersion = result.effectiveVersion;
      warnings.push(buildWarningMessage('invalid_format', requestedVersion, effectiveVersion));
    } else if (!config.supportedVersionsSet.has(requestedVersion)) {
      // Security: Use Set.has() for O(1) lookup (prevents timing attacks)
      // Valid format but not supported
      isUnknownVersion = true;
      const result = handleUnknownVersion(
        c,
        requestedVersion,
        config.defaultVersion,
        config.unknownVersionMode,
        config.supportedVersions
      );
      if (result.shouldReject && result.response) {
        return result.response;
      }
      effectiveVersion = result.effectiveVersion;
      warnings.push(buildWarningMessage('unknown_version', requestedVersion, effectiveVersion));
    } else {
      // Valid and supported version
      effectiveVersion = requestedVersion;
    }

    // Store context for downstream handlers
    const ctx: ApiVersionContext = {
      requestedVersion: requestedVersion || null,
      effectiveVersion,
      isOidcEndpoint: false,
      isUnknownVersion,
      warnings,
    };
    setContext(ctx);

    // Continue to next middleware/handler
    await next();

    // Add response headers
    c.header(API_VERSION_RESPONSE_HEADER, effectiveVersion);
    if (warnings.length > 0) {
      c.header(API_VERSION_WARNING_HEADER, warnings.join('; '));
    }
  };
}

/**
 * Get API version context from request
 *
 * @param c - Hono context
 * @returns API version context or default
 */
export function getApiVersionContext(c: Context<{ Bindings: Env }>): ApiVersionContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const ctx = (c as any).get(API_VERSION_CONTEXT_KEY) as ApiVersionContext | undefined;
  return (
    ctx || {
      requestedVersion: null,
      effectiveVersion: '2024-12-01',
      isOidcEndpoint: false,
      isUnknownVersion: false,
      warnings: [],
    }
  );
}

/**
 * Check if current request matches a specific API version
 *
 * @param c - Hono context
 * @param version - Version to check
 * @returns true if matching
 */
export function isApiVersion(c: Context<{ Bindings: Env }>, version: ApiVersionString): boolean {
  const ctx = getApiVersionContext(c);
  return ctx.effectiveVersion === version;
}

/**
 * Handle unknown version based on mode
 *
 * Security notes:
 * - requestedVersion is sanitized before inclusion in error response
 * - supported_versions only included in non-production environments
 */
function handleUnknownVersion(
  c: Context<{ Bindings: Env }>,
  requestedVersion: string,
  defaultVersion: ApiVersionString,
  mode: 'fallback' | 'warn' | 'reject',
  supportedVersions: string[]
): { shouldReject: boolean; effectiveVersion: ApiVersionString; response?: Response } {
  switch (mode) {
    case 'reject': {
      // Sanitize user input for error response
      const safeRequestedVersion = sanitizeHeaderValue(requestedVersion);

      // RFC 9457 Problem Details response
      // Security: Only include supported_versions in development/staging
      const isProduction = c.env.ENVIRONMENT === 'production' || c.env.NODE_ENV === 'production';

      const errorBody: Record<string, unknown> = {
        type: UNKNOWN_VERSION_ERROR_TYPE,
        title: 'Unknown API Version',
        status: 400,
        detail: `The requested API version '${safeRequestedVersion}' is not supported.`,
        instance: c.req.path,
        requested_version: safeRequestedVersion,
      };

      // Only expose supported versions in non-production environments
      if (!isProduction) {
        errorBody.supported_versions = supportedVersions;
      }

      return {
        shouldReject: true,
        effectiveVersion: defaultVersion,
        response: c.json(errorBody, 400, {
          'Content-Type': 'application/problem+json',
        }),
      };
    }

    case 'warn':
      // Continue with requested version (if valid format) or default
      return {
        shouldReject: false,
        effectiveVersion: isValidApiVersionFormat(requestedVersion)
          ? requestedVersion
          : defaultVersion,
      };

    case 'fallback':
    default:
      // Fall back to default version
      return {
        shouldReject: false,
        effectiveVersion: defaultVersion,
      };
  }
}

/**
 * Build warning message for response header
 * Format: {reason}; requested={value}; applied={value}
 *
 * Security: All values are sanitized to prevent HTTP Response Splitting
 */
function buildWarningMessage(
  reason: 'unknown_version' | 'invalid_format',
  requested: string,
  applied: string
): string {
  // Sanitize user-provided value to prevent header injection
  const safeRequested = sanitizeHeaderValue(requested);
  return `${reason}; requested=${safeRequested}; applied=${applied}`;
}

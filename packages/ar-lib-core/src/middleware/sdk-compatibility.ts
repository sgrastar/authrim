/**
 * SDK Compatibility Middleware
 *
 * Checks SDK version compatibility and adds warning headers for outdated SDKs.
 * This middleware is designed to WARN only, never block requests.
 *
 * Middleware order (important):
 *   api-version → deprecation-headers → sdk-compatibility → auth/policy/handler
 *
 * Request Header: Authrim-SDK-Version: authrim-js/1.0.0
 * Response Headers:
 * - X-Authrim-SDK-Warning: outdated; recommended=1.2.0
 * - X-Authrim-SDK-Recommended: 1.2.0
 *
 * @module sdk-compatibility-middleware
 * @see https://docs.authrim.com/sdk/versioning
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import type { SdkCompatibilityContext, SdkCompatibilityResult } from '../types/sdk-compatibility';
import {
  SDK_VERSION_REQUEST_HEADER,
  SDK_WARNING_HEADER,
  SDK_RECOMMENDED_HEADER,
  DEFAULT_SDK_COMPATIBILITY_CONTEXT,
  formatSdkWarning,
} from '../types/sdk-compatibility';
import {
  getSdkCompatibilityConfig,
  checkSdkCompatibility,
} from '../utils/sdk-compatibility-config';

/** Context key for SDK compatibility info */
const SDK_COMPATIBILITY_CONTEXT_KEY = 'sdkCompatibility';

/**
 * Variables added to Hono context by this middleware
 */
export interface SdkCompatibilityVariables {
  sdkCompatibility: SdkCompatibilityContext;
}

/**
 * SDK Compatibility Middleware
 *
 * - Checks SDK version from request header
 * - Adds warning headers for outdated/deprecated/unsupported SDKs
 * - Never blocks requests (warn-only design)
 * - Fail-safe: If KV is unavailable, no warnings are added
 *
 * @returns Hono middleware handler
 */
export function sdkCompatibilityMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // Helper to set context (type-safe wrapper)
    const setContext = (ctx: SdkCompatibilityContext): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (c as any).set(SDK_COMPATIBILITY_CONTEXT_KEY, ctx);
    };

    // Check if SDK compatibility checking is enabled
    const config = await getSdkCompatibilityConfig(c.env);
    if (!config.enabled) {
      setContext(DEFAULT_SDK_COMPATIBILITY_CONTEXT);
      return next();
    }

    // Get SDK version from request header
    const sdkVersionHeader = c.req.header(SDK_VERSION_REQUEST_HEADER) || null;

    // Check compatibility
    const result = await checkSdkCompatibility(c.env, sdkVersionHeader);

    // Build context
    const ctx: SdkCompatibilityContext = {
      result,
      hasWarning: shouldWarn(result),
    };
    setContext(ctx);

    // Continue to next middleware/handler
    await next();

    // Add warning headers after response is generated
    if (ctx.hasWarning && result.status !== 'compatible') {
      // X-Authrim-SDK-Warning: outdated; recommended=1.2.0
      const warningValue = formatSdkWarning(result.status, result.recommendedVersion);
      if (warningValue) {
        c.header(SDK_WARNING_HEADER, warningValue);
      }

      // X-Authrim-SDK-Recommended: 1.2.0
      if (result.recommendedVersion) {
        c.header(SDK_RECOMMENDED_HEADER, result.recommendedVersion);
      }
    }
  };
}

/**
 * Determine if a warning should be sent
 *
 * @param result - SDK compatibility result
 * @returns true if warning should be sent
 */
function shouldWarn(result: SdkCompatibilityResult): boolean {
  if (!result.hasHeader) {
    return false;
  }

  switch (result.status) {
    case 'outdated':
    case 'deprecated':
    case 'unsupported':
      return true;
    default:
      return false;
  }
}

/**
 * Get SDK compatibility context from request
 *
 * @param c - Hono context
 * @returns SDK compatibility context or default
 */
export function getSdkCompatibilityContextFromRequest(
  c: Context<{ Bindings: Env }>
): SdkCompatibilityContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const ctx = (c as any).get(SDK_COMPATIBILITY_CONTEXT_KEY) as SdkCompatibilityContext | undefined;
  return ctx || DEFAULT_SDK_COMPATIBILITY_CONTEXT;
}

/**
 * Check if current request has an SDK version header
 *
 * @param c - Hono context
 * @returns true if SDK version was provided
 */
export function hasSdkVersion(c: Context<{ Bindings: Env }>): boolean {
  return getSdkCompatibilityContextFromRequest(c).result.hasHeader;
}

/**
 * Check if current SDK version has a warning
 *
 * @param c - Hono context
 * @returns true if SDK version has a warning
 */
export function hasSdkWarning(c: Context<{ Bindings: Env }>): boolean {
  return getSdkCompatibilityContextFromRequest(c).hasWarning;
}

/**
 * Get SDK compatibility status
 *
 * @param c - Hono context
 * @returns SDK compatibility status
 */
export function getSdkStatus(c: Context<{ Bindings: Env }>): SdkCompatibilityResult['status'] {
  return getSdkCompatibilityContextFromRequest(c).result.status;
}

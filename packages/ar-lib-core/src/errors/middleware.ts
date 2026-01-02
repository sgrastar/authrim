/**
 * Error Handling Middleware for Hono
 *
 * Integrates ErrorFactory with Hono applications for consistent error handling.
 *
 * Usage:
 * ```ts
 * import { errorMiddleware } from '@authrim/ar-lib-core';
 *
 * const app = new Hono();
 * app.use('*', errorMiddleware());
 *
 * // Errors thrown with AR codes will be automatically serialized
 * app.get('/api/resource', (c) => {
 *   throw new AuthrimError(AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
 * });
 * ```
 *
 * @packageDocumentation
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { ErrorDescriptor, ErrorLocale, ErrorIdMode, ErrorResponseFormat } from './types';
import type { ARErrorCode, RFCErrorCode } from './codes';
import { ErrorFactory } from './factory';
import { serializeError, determineFormat } from './serializer';

// KV key constants for configuration
const KV_KEY_LOCALE = 'error_locale';
const KV_KEY_RESPONSE_FORMAT = 'error_response_format';
const KV_KEY_ERROR_ID_MODE = 'error_id_mode';

// Defaults
const DEFAULT_LOCALE: ErrorLocale = 'en';
const DEFAULT_RESPONSE_FORMAT: ErrorResponseFormat = 'oauth';
// SECURITY: Production uses 'security_only' to track only security-relevant errors
// Development uses '5xx' to track all server errors for debugging
const DEFAULT_ERROR_ID_MODE: ErrorIdMode =
  typeof process !== 'undefined' && process.env?.NODE_ENV === 'production'
    ? 'security_only'
    : '5xx';

/**
 * Authrim Error class for throwing errors with AR codes
 *
 * Use this to throw errors that will be automatically handled by the middleware.
 *
 * @example
 * ```ts
 * throw new AuthrimError(AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
 * throw new AuthrimError(AR_ERROR_CODES.RATE_LIMIT_EXCEEDED, {
 *   variables: { retry_after: 60 },
 *   state: 'abc123',
 * });
 * ```
 */
export class AuthrimError extends Error {
  public readonly code: ARErrorCode;
  public readonly options: {
    variables?: Record<string, string | number>;
    state?: string;
  };

  constructor(
    code: ARErrorCode,
    options: { variables?: Record<string, string | number>; state?: string } = {}
  ) {
    super(`AuthrimError: ${code}`);
    this.name = 'AuthrimError';
    this.code = code;
    this.options = options;
  }
}

/**
 * RFC Error class for throwing standard RFC errors
 */
export class RFCError extends Error {
  public readonly rfcError: RFCErrorCode;
  public readonly status: number;
  public readonly detail?: string;

  constructor(rfcError: RFCErrorCode, status: number, detail?: string) {
    super(`RFCError: ${rfcError}`);
    this.name = 'RFCError';
    this.rfcError = rfcError;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Error middleware configuration
 */
interface ErrorMiddlewareOptions {
  /**
   * Default locale (can be overridden by KV)
   */
  locale?: ErrorLocale;

  /**
   * Default response format (can be overridden by KV or Accept header)
   */
  format?: ErrorResponseFormat;

  /**
   * Default error ID mode (can be overridden by KV)
   */
  errorIdMode?: ErrorIdMode;

  /**
   * Base URL for Problem Details type URIs
   */
  baseUrl?: string;

  /**
   * Custom error handler for unhandled errors
   */
  onError?: (error: unknown, c: Context) => void;
}

/**
 * Get error configuration from KV with fallback to defaults
 */
async function getErrorConfig(
  c: Context,
  options: ErrorMiddlewareOptions
): Promise<{
  locale: ErrorLocale;
  format: ErrorResponseFormat;
  errorIdMode: ErrorIdMode;
}> {
  const env = c.env as {
    AUTHRIM_CONFIG?: { get: (key: string) => Promise<string | null> };
  };

  let locale = options.locale || DEFAULT_LOCALE;
  let format = options.format || DEFAULT_RESPONSE_FORMAT;
  let errorIdMode = options.errorIdMode || DEFAULT_ERROR_ID_MODE;

  if (env.AUTHRIM_CONFIG) {
    try {
      const [kvLocale, kvFormat, kvMode] = await Promise.all([
        env.AUTHRIM_CONFIG.get(KV_KEY_LOCALE),
        env.AUTHRIM_CONFIG.get(KV_KEY_RESPONSE_FORMAT),
        env.AUTHRIM_CONFIG.get(KV_KEY_ERROR_ID_MODE),
      ]);

      if (kvLocale && (kvLocale === 'en' || kvLocale === 'ja')) {
        locale = kvLocale;
      }
      if (kvFormat && (kvFormat === 'oauth' || kvFormat === 'problem_details')) {
        format = kvFormat;
      }
      if (
        kvMode &&
        (kvMode === 'all' || kvMode === '5xx' || kvMode === 'security_only' || kvMode === 'none')
      ) {
        errorIdMode = kvMode as ErrorIdMode;
      }
    } catch {
      // KV read error - use defaults
    }
  }

  return { locale, format, errorIdMode };
}

/**
 * Create error handling middleware for Hono
 *
 * This middleware catches errors thrown in handlers and serializes them
 * using the ErrorFactory system.
 *
 * @param options - Middleware configuration
 * @returns Hono middleware handler
 */
export function errorMiddleware(options: ErrorMiddlewareOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (error) {
      // Get configuration
      const config = await getErrorConfig(c, options);

      // Create factory with configuration
      const factory = new ErrorFactory({
        locale: config.locale,
        errorIdMode: config.errorIdMode,
      });

      let descriptor: ErrorDescriptor;

      if (error instanceof AuthrimError) {
        // Handle AuthrimError
        descriptor = factory.create(error.code, {
          variables: error.options.variables,
          state: error.options.state,
        });
      } else if (error instanceof RFCError) {
        // Handle RFCError
        descriptor = factory.createFromRFC(error.rfcError, error.status, error.detail);
      } else {
        // Handle unexpected errors
        descriptor = factory.createInternalError();

        // Call custom error handler if provided
        if (options.onError) {
          options.onError(error, c);
        } else {
          // Default error logging
          console.error('Unhandled error:', error);
        }
      }

      // Determine response format
      // Safe access to c.req.header - may not be a function in some test mocks
      const acceptHeader =
        typeof c.req?.header === 'function' ? c.req.header('accept') || null : null;
      const responseFormat = determineFormat(c.req?.path, acceptHeader, config.format);

      // Serialize and return response
      return serializeError(descriptor, {
        format: responseFormat,
        baseUrl: options.baseUrl,
      });
    }
  };
}

/**
 * Create a pre-configured error factory from Hono context
 *
 * Use this to create errors with proper localization in handlers.
 *
 * @example
 * ```ts
 * app.get('/api/resource', async (c) => {
 *   const factory = await createErrorFactoryFromContext(c);
 *   const error = factory.create(AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
 *   return errorResponse(c, error);
 * });
 * ```
 */
export async function createErrorFactoryFromContext(c: Context): Promise<ErrorFactory> {
  const config = await getErrorConfig(c, {});
  return new ErrorFactory({
    locale: config.locale,
    errorIdMode: config.errorIdMode,
  });
}

/**
 * Helper to create error response directly in handlers
 *
 * @example
 * ```ts
 * app.get('/api/resource', (c) => {
 *   return createErrorResponse(c, AR_ERROR_CODES.AUTH_SESSION_EXPIRED);
 * });
 * ```
 */
export async function createErrorResponse(
  c: Context,
  code: ARErrorCode,
  options?: { variables?: Record<string, string | number>; state?: string }
): Promise<Response> {
  const config = await getErrorConfig(c, {});
  const factory = new ErrorFactory({
    locale: config.locale,
    errorIdMode: config.errorIdMode,
  });

  const descriptor = factory.create(code, options);
  // Safe access to c.req.header - may not be a function in some test mocks
  const acceptHeader = typeof c.req?.header === 'function' ? c.req.header('accept') || null : null;
  const format = determineFormat(c.req?.path, acceptHeader, config.format);

  return serializeError(descriptor, { format });
}

/**
 * Helper to create RFC error response
 *
 * @deprecated Use createErrorResponse() with appropriate AR_ERROR_CODES instead.
 * This function bypasses security masking and should not be used for new code.
 * It will be removed in the next major version.
 *
 * Migration example:
 * ```ts
 * // Before (deprecated)
 * return createRFCErrorResponse(c, 'invalid_request', 400, 'Email is required');
 *
 * // After (recommended)
 * return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
 *   variables: { field: 'email' }
 * });
 * ```
 */
export async function createRFCErrorResponse(
  c: Context,
  rfcError: RFCErrorCode,
  status: number,
  detail?: string
): Promise<Response> {
  const config = await getErrorConfig(c, {});
  const factory = new ErrorFactory({
    locale: config.locale,
    errorIdMode: config.errorIdMode,
  });

  const descriptor = factory.createFromRFC(rfcError, status, detail);
  // Safe access to c.req.header - may not be a function in some test mocks
  const acceptHeader = typeof c.req?.header === 'function' ? c.req.header('accept') || null : null;
  const format = determineFormat(c.req?.path, acceptHeader, config.format);

  return serializeError(descriptor, { format });
}

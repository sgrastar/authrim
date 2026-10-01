/**
 * Error Handling Middleware for Hono
 *
 * Integrates ErrorFactory with Hono applications for consistent error handling.
 *
 * Usage:
 * ```ts
 * import { errorHandler } from '@authrim/ar-lib-core';
 *
 * const app = new Hono();
 * app.onError(errorHandler());
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
import { createLogger } from '../utils/logger';
import { getTenantIdFromContext } from '../middleware/request-context';
import {
  resolveEffectiveSettingsWithSources,
  type EffectiveSettingsEnv,
} from '../services/effective-settings';

const log = createLogger().module('ErrorMiddleware');

// KV key constants for configuration
const KV_KEY_LOCALE = 'error_locale';

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
    extensions?: Record<string, unknown>;
  };

  constructor(
    code: ARErrorCode,
    options: {
      variables?: Record<string, string | number>;
      state?: string;
      extensions?: Record<string, unknown>;
    } = {}
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
   * Default response format, used where the Settings API has no value (the Accept header can
   * still select Problem Details)
   */
  format?: ErrorResponseFormat;

  /**
   * Default error ID mode, used where the Settings API has no value
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

const RESPONSE_FORMATS: readonly ErrorResponseFormat[] = ['oauth', 'problem_details'];
const ERROR_ID_MODES: readonly ErrorIdMode[] = ['all', '5xx', 'security_only', 'none'];
const ERROR_SETTING_KEYS = ['oauth.error_response_format', 'oauth.error_id_mode'] as const;

/**
 * Tenants whose error settings could not be read recently, so error responses (which invalid
 * requests produce in bulk) do not retry the read each time while a store is failing.
 */
const FAILED_READ_BACKOFF_MS = 10_000;
const FAILED_READ_MAX_ENTRIES = 1000;
const failedReads = new WeakMap<object, Map<string, number>>();

function failuresFor(env: object): Map<string, number> {
  let failures = failedReads.get(env);
  if (!failures) {
    failures = new Map();
    failedReads.set(env, failures);
  }
  return failures;
}

function recentlyFailed(env: object, tenantId: string): boolean {
  const failures = failuresFor(env);
  const until = failures.get(tenantId);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  failures.delete(tenantId);
  return false;
}

function rememberFailure(env: object, tenantId: string): void {
  const failures = failuresFor(env);
  failures.delete(tenantId);
  if (failures.size >= FAILED_READ_MAX_ENTRIES) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(tenantId, Date.now() + FAILED_READ_BACKOFF_MS);
}

/**
 * The tenant's `oauth.error_response_format` and `oauth.error_id_mode` where they are set: as
 * the Settings API resolves them (tenant, else the older AUTHRIM_CONFIG values, else env). Null
 * when they cannot be read, so an error response never fails on its own settings.
 */
async function readErrorSettings(
  c: Context
): Promise<{ format?: ErrorResponseFormat; errorIdMode?: ErrorIdMode } | null> {
  if (!c.env) return null;
  const env = c.env as EffectiveSettingsEnv;
  // Failures are remembered per settings binding (one per deployment; one per test env).
  const settingsBinding = (env.SETTINGS ?? env.AUTHRIM_CONFIG ?? env) as object;
  let tenantId: string | undefined;
  try {
    tenantId = getTenantIdFromContext(c);
    if (recentlyFailed(settingsBinding, tenantId)) return null;
    // Only the stores that hold these two settings: an unrelated document must not affect them.
    const { values, sources } = await resolveEffectiveSettingsWithSources(
      c.env as EffectiveSettingsEnv,
      'oauth',
      // Strict: a store that cannot be read fails the whole read (defaults, then the backoff
      // below), rather than applying whichever of the two values happened to be readable.
      { tenantId, keys: ERROR_SETTING_KEYS, strictLegacy: true }
    );
    // A value nobody set leaves the middleware's own default in place.
    const configured = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
      const value = values[key] as T;
      return sources[key] !== 'default' && allowed.includes(value) ? value : undefined;
    };
    return {
      format: configured('oauth.error_response_format', RESPONSE_FORMATS),
      errorIdMode: configured('oauth.error_id_mode', ERROR_ID_MODES),
    };
  } catch (error) {
    if (tenantId !== undefined) rememberFailure(settingsBinding, tenantId);
    log.warn('Error settings could not be read', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get error configuration: the tenant's Settings API values where set, else the middleware
 * options, else defaults. The locale is kept in AUTHRIM_CONFIG only.
 */
async function getErrorConfig(
  c: Context,
  options: ErrorMiddlewareOptions
): Promise<{
  locale: ErrorLocale;
  format: ErrorResponseFormat;
  errorIdMode: ErrorIdMode;
}> {
  const env = (c.env ?? {}) as {
    AUTHRIM_CONFIG?: { get: (key: string) => Promise<string | null> };
  };

  let locale = options.locale || DEFAULT_LOCALE;
  let format = options.format || DEFAULT_RESPONSE_FORMAT;
  let errorIdMode = options.errorIdMode || DEFAULT_ERROR_ID_MODE;

  const readLocale = async (): Promise<string | null> => {
    try {
      return (await env.AUTHRIM_CONFIG?.get(KV_KEY_LOCALE)) ?? null;
    } catch {
      return null;
    }
  };
  const [kvLocale, settings] = await Promise.all([readLocale(), readErrorSettings(c)]);
  if (kvLocale === 'en' || kvLocale === 'ja') {
    locale = kvLocale;
  }
  if (settings?.format) format = settings.format;
  if (settings?.errorIdMode) errorIdMode = settings.errorIdMode;

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
    let caughtError: unknown;
    try {
      await next();
    } catch (error) {
      caughtError = error;
    }

    // Hono normally captures downstream exceptions in c.error instead of
    // rethrowing them through middleware. Handle both forms so the configured
    // Authrim response is not replaced by Hono's plain-text 500 response.
    const error = caughtError ?? c.error;
    if (error) {
      return handleError(error, c, options);
    }
  };
}

async function handleError(
  error: unknown,
  c: Context,
  options: ErrorMiddlewareOptions
): Promise<Response> {
  const config = await getErrorConfig(c, options);
  const factory = new ErrorFactory({ locale: config.locale, errorIdMode: config.errorIdMode });
  let descriptor: ErrorDescriptor;

  if (error instanceof AuthrimError) {
    descriptor = factory.create(error.code, {
      variables: error.options.variables,
      state: error.options.state,
      extensions: error.options.extensions,
    });
  } else if (error instanceof RFCError) {
    descriptor = factory.createFromRFC(error.rfcError, error.status, error.detail);
  } else {
    descriptor = factory.createInternalError();
    if (options.onError) {
      options.onError(error, c);
    } else {
      log.error('Unhandled error', {}, error as Error);
    }
  }

  const acceptHeader = typeof c.req?.header === 'function' ? c.req.header('accept') || null : null;
  const responseFormat = determineFormat(c.req?.path, acceptHeader, config.format);
  return serializeError(descriptor, { format: responseFormat, baseUrl: options.baseUrl });
}

/**
 * Create a Hono onError handler. Hono catches route exceptions at the app
 * boundary, so applications should register this with `app.onError(...)`.
 */
export function errorHandler(options: ErrorMiddlewareOptions = {}) {
  return (error: Error, c: Context): Promise<Response> => handleError(error, c, options);
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
  options?: {
    variables?: Record<string, string | number>;
    state?: string;
    extensions?: Record<string, unknown>;
  }
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

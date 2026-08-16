/**
 * Request Context Middleware
 *
 * This middleware establishes request-scoped context including:
 * - Request ID for correlation across logs
 * - Tenant ID (resolved from Host header in multi-tenant mode)
 * - Structured logger instance
 *
 * Multi-tenant mode is enabled when BASE_DOMAIN is set.
 *
 * Should be added early in the middleware chain so all subsequent
 * handlers have access to the context.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import { DEFAULT_TENANT_ID, resolveTenantFromRequest } from '../utils/tenant-context';
import { getRequestHost, isMultiTenantEnabled, validateTenantExistsAsync } from '../utils/issuer';
import { validateTenantRequestBinding } from '../utils/tenant-binding-policy';
import {
  classifyTenantRequestPath,
  extractTenantScopedPathTenantId,
  isAdminTenantHeaderRequired,
  isValidTenantIdentifier,
} from '../utils/tenant-request-policy';
import { createLogger, type Logger } from '../utils/logger';
import {
  getPrimaryTenantVanityDomain,
  resolveTenantFromVanityHost,
} from '../services/tenant-vanity-domain-resolver';
import {
  resolveTenantMetadataContext,
  type TenantMetadataContext,
} from '../services/runtime-data-context';
import { TenantDatabaseResolverError } from '../services/tenant-database-resolver';

/**
 * Request context available to all handlers via c.get()
 */
export interface RequestContext {
  /** Unique request identifier (UUID v4) */
  requestId: string;
  /** Tenant identifier ('default' in single-tenant mode) */
  tenantId: string;
  /** Request start timestamp for duration calculation */
  startTime: number;
  /** Structured logger with request context */
  logger: Logger;
}

/**
 * Request context middleware
 *
 * Sets the following context values accessible via c.get():
 * - 'requestId': Unique request identifier
 * - 'tenantId': Tenant identifier
 * - 'logger': Structured logger instance
 * - 'startTime': Request start timestamp
 *
 * @example
 * // In router setup
 * app.use('*', requestContextMiddleware());
 *
 * // In handler
 * const requestId = c.get('requestId');
 * const logger = c.get('logger');
 * logger.info('Processing request', { action: 'process' });
 */
/**
 * Options for request context middleware
 */
export interface RequestContextMiddlewareOptions {
  /**
   * Whether to return error response on tenant resolution failure.
   * If true (default), returns 400/404 JSON error response.
   * If false, continues with default tenant (useful for health checks).
   */
  requireTenant?: boolean;
}

interface DiagnosticTimingSpan {
  name: string;
  durationMs: number;
}

interface RequestContextCacheEntry<T> {
  value: T;
  expiresAt: number;
}

const REQUEST_CONTEXT_CACHE_DEFAULT_TTL_MS = 180_000;
const REQUEST_CONTEXT_CACHE_MIN_TTL_MS = 10_000;
const REQUEST_CONTEXT_CACHE_MAX_TTL_MS = 600_000;
const REQUEST_CONTEXT_CACHE_MAX_ENTRIES = 256;
const DIAGNOSTIC_SESSION_ID_HEADER = 'X-Diagnostic-Session-Id';
const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 128;
const DIAGNOSTIC_TIMING_PATHS = new Set([
  '/api/auth/authentication-methods',
  '/api/v1/login/interactions/start',
]);
const tenantExistsCache = new WeakMap<object, Map<string, RequestContextCacheEntry<true>>>();

function sanitizeDiagnosticSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH);
}

function isFlowRuntimeTimingEnabled(env: Env, path: string, request: Request): boolean {
  if (
    DIAGNOSTIC_TIMING_PATHS.has(path) &&
    isDiagnosticTimingEnabled(env) &&
    sanitizeDiagnosticSessionId(request.headers.get(DIAGNOSTIC_SESSION_ID_HEADER))
  ) {
    return true;
  }
  if (path !== '/api/v1/login/interactions/start') {
    return false;
  }
  const value = env.AUTHRIM_FLOW_RUNTIME_TIMING?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function isDiagnosticTimingEnabled(env: Env): boolean {
  const value = env.AUTHRIM_DIAGNOSTIC_TIMING_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function getRequestContextCacheTtlMs(env: Env): number {
  const ttlSeconds = Number.parseInt(env.CONFIG_CACHE_TTL ?? '', 10);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return REQUEST_CONTEXT_CACHE_DEFAULT_TTL_MS;
  }
  return Math.min(
    REQUEST_CONTEXT_CACHE_MAX_TTL_MS,
    Math.max(REQUEST_CONTEXT_CACHE_MIN_TTL_MS, ttlSeconds * 1000)
  );
}

function getEnvScopedCache<T>(cache: WeakMap<object, Map<string, T>>, env: Env): Map<string, T> {
  const envKey = env as object;
  let scoped = cache.get(envKey);
  if (!scoped) {
    scoped = new Map<string, T>();
    cache.set(envKey, scoped);
  }
  return scoped;
}

function setBoundedCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= REQUEST_CONTEXT_CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

function roundDiagnosticDurationMs(value: number): number {
  return Math.round(value * 10) / 10;
}

async function timeDiagnosticSpan<T>(
  spans: DiagnosticTimingSpan[] | null,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!spans) {
    return operation();
  }

  const startedAtMs = Date.now();
  try {
    return await operation();
  } finally {
    spans.push({
      name,
      durationMs: roundDiagnosticDurationMs(Date.now() - startedAtMs),
    });
  }
}

function appendServerTiming(c: Context<{ Bindings: Env }>, spans: DiagnosticTimingSpan[]): void {
  if (spans.length === 0) {
    return;
  }

  const value = spans.map((span) => `${span.name};dur=${span.durationMs.toFixed(1)}`).join(', ');
  const existing = c.res.headers.get('Server-Timing');
  c.res.headers.set('Server-Timing', existing ? `${existing}, ${value}` : value);
}

function shouldAttemptVanityHostResolution(
  env: Partial<Env>,
  requestHost: string | undefined,
  requestClass:
    | 'platform_admin'
    | 'tenant_inventory_admin'
    | 'tenant_scoped_admin'
    | 'discovery_ui'
    | 'health_or_internal'
    | 'public_protocol_or_rest'
): boolean {
  if (!requestHost || !isMultiTenantEnabled(env)) {
    return false;
  }

  if (requestClass === 'platform_admin' || requestClass === 'tenant_inventory_admin') {
    return false;
  }

  const baseDomain = env.BASE_DOMAIN?.toLowerCase();
  if (!baseDomain) {
    return false;
  }

  if (requestHost === baseDomain || requestHost.endsWith(`.${baseDomain}`)) {
    return false;
  }

  return true;
}

function isPublicAuthenticationMethodsPath(path: string): boolean {
  return path === '/api/auth/authentication-methods';
}

function shouldResolveTenantDataContexts(
  requestClass:
    | 'platform_admin'
    | 'tenant_inventory_admin'
    | 'tenant_scoped_admin'
    | 'discovery_ui'
    | 'health_or_internal'
    | 'public_protocol_or_rest',
  path: string
): boolean {
  if (isPublicAuthenticationMethodsPath(path)) {
    return false;
  }

  return (
    requestClass === 'tenant_scoped_admin' ||
    requestClass === 'discovery_ui' ||
    requestClass === 'public_protocol_or_rest'
  );
}

async function validateTenantExistsWithIsolateCache(
  env: Env,
  db: Parameters<typeof validateTenantExistsAsync>[0],
  tenantId: string
): Promise<boolean> {
  const cache = getEnvScopedCache(tenantExistsCache, env);
  const cacheKey = `tenant:${tenantId}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return true;
  }

  const exists = await validateTenantExistsAsync(db, env.AUTHRIM_CONFIG, tenantId);
  if (exists) {
    setBoundedCacheEntry(cache, cacheKey, {
      value: true,
      expiresAt: now + getRequestContextCacheTtlMs(env),
    });
  } else {
    cache.delete(cacheKey);
  }
  return exists;
}

function getConfiguredUrlHostname(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getPrimaryTenantIssuerHostname(env: Partial<Env>): string | null {
  const baseDomain = env.BASE_DOMAIN?.toLowerCase();
  if (!baseDomain) {
    return null;
  }

  if (env.NAKED_DOMAIN_AS_ISSUER === 'true') {
    return baseDomain;
  }

  const tenantId = env.PRIMARY_TENANT_ID || env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID;
  return `${tenantId.toLowerCase()}.${baseDomain}`;
}

function isReservedUiHost(env: Partial<Env>, requestHost: string | undefined): boolean {
  if (!requestHost) {
    return false;
  }

  const baseDomain = env.BASE_DOMAIN?.toLowerCase();
  if (env.NAKED_DOMAIN_AS_ISSUER === 'true' && baseDomain && requestHost === baseDomain) {
    return false;
  }

  if (getConfiguredUrlHostname(env.ADMIN_UI_URL) === requestHost) {
    return true;
  }

  const loginUiHost = getConfiguredUrlHostname(env.UI_URL);
  if (loginUiHost !== requestHost) {
    return false;
  }

  return loginUiHost !== getPrimaryTenantIssuerHostname(env);
}

export function requestContextMiddleware(options: RequestContextMiddlewareOptions = {}) {
  const { requireTenant = true } = options;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    const diagnosticSessionId = sanitizeDiagnosticSessionId(
      c.req.raw.headers.get(DIAGNOSTIC_SESSION_ID_HEADER)
    );
    const timingEnabled = isFlowRuntimeTimingEnabled(c.env, c.req.path, c.req.raw);
    const timingSpans: DiagnosticTimingSpan[] | null = timingEnabled ? [] : null;
    const requestClass = classifyTenantRequestPath(c.req.path);
    const requestedTenantId = isAdminTenantHeaderRequired(c.req.path)
      ? c.req.header('X-Tenant-Id')?.trim()
      : undefined;

    if (isAdminTenantHeaderRequired(c.req.path)) {
      if (!requestedTenantId) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'X-Tenant-Id header is required',
          },
          400
        );
      }

      if (!isValidTenantIdentifier(requestedTenantId)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'X-Tenant-Id header has an invalid format',
          },
          400
        );
      }

      const pathTenantId = extractTenantScopedPathTenantId(c.req.path);
      if (pathTenantId && pathTenantId !== requestedTenantId) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'X-Tenant-Id must match the tenant path parameter',
          },
          400
        );
      }
    }

    // Resolve tenant from Host header
    // Single-tenant mode: always returns default tenant
    // Multi-tenant mode: extracts from subdomain
    const tenantResult = resolveTenantFromRequest(c.req.raw, c.env);
    let tenantId = tenantResult.tenantId;
    const requestHost = getRequestHost(c.req.raw)?.split(':')[0]?.toLowerCase();
    if (isReservedUiHost(c.env, requestHost)) {
      tenantResult.success = false;
      tenantResult.tenantId = c.env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID;
      delete tenantResult.error;
      delete tenantResult.statusCode;
      tenantId = tenantResult.tenantId;
    }

    if (
      !tenantResult.success &&
      shouldAttemptVanityHostResolution(c.env, requestHost, requestClass)
    ) {
      const vanityTenantId = await timeDiagnosticSpan(timingSpans, 'rc_vanity_host', () =>
        resolveTenantFromVanityHost(c.env, requestHost)
      );
      if (vanityTenantId) {
        tenantResult.success = true;
        tenantResult.tenantId = vanityTenantId;
        delete tenantResult.error;
        delete tenantResult.statusCode;
        tenantId = vanityTenantId;
      }
    }
    const allowUnknownTenant =
      requestClass === 'discovery_ui' ||
      requestClass === 'platform_admin' ||
      requestClass === 'tenant_inventory_admin' ||
      requestClass === 'health_or_internal';

    // Handle tenant resolution failure in multi-tenant mode
    if (
      !tenantResult.success &&
      isMultiTenantEnabled(c.env) &&
      requireTenant &&
      !allowUnknownTenant &&
      requestClass !== 'tenant_scoped_admin'
    ) {
      // Create logger for error logging
      const errorLogger = createLogger({ requestId, tenantId: 'unknown' });
      errorLogger.warn('Tenant resolution failed', {
        error: tenantResult.error,
        host: c.req.header('Host'),
        path: c.req.path,
      });

      // Return appropriate error response
      const statusCode = tenantResult.statusCode || 400;
      const errorMessage =
        tenantResult.error === 'tenant_not_found'
          ? 'Tenant not found'
          : tenantResult.error === 'missing_host'
            ? 'Host header is required'
            : 'Invalid Host header format';

      return c.json(
        {
          error: tenantResult.error === 'tenant_not_found' ? 'not_found' : 'invalid_request',
          error_description: errorMessage,
        },
        statusCode
      );
    }

    // Fallback to default tenant if resolution failed but not required
    if (!tenantResult.success) {
      tenantId = c.env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID;
    }

    if (requestClass === 'tenant_scoped_admin' && requestedTenantId) {
      tenantId = requestedTenantId;
    }

    if (
      requestClass === 'tenant_scoped_admin' &&
      !isMultiTenantEnabled(c.env) &&
      tenantId !== (c.env.DEFAULT_TENANT_ID || DEFAULT_TENANT_ID)
    ) {
      return c.json({ error: 'not_found', error_description: 'Tenant not found' }, 404);
    }

    // In multi-tenant mode, validate that the resolved tenant actually exists in D1.
    // Uses positive-only isolate/KV caches to avoid per-request storage lookups.
    // Missing routes and storage errors fail closed unless a positive cache entry already exists.
    const shouldValidateTenantExists =
      isMultiTenantEnabled(c.env) &&
      !!tenantId &&
      (requestClass === 'tenant_scoped_admin' ||
        ((requestClass !== 'platform_admin' && requestClass !== 'tenant_inventory_admin') &&
          tenantResult.success));

    let tenantMetadataContext: TenantMetadataContext | undefined;
    if (shouldResolveTenantDataContexts(requestClass, c.req.path)) {
      try {
        tenantMetadataContext = await timeDiagnosticSpan(timingSpans, 'rc_tenant_metadata', () =>
          resolveTenantMetadataContext(c.env, tenantId)
        );
      } catch (error) {
        if (error instanceof TenantDatabaseResolverError) {
          return c.json(
            {
              error: error.code,
              route: c.req.path,
              tenant_id: tenantId,
            },
            409
          );
        }
        const code = error instanceof Error ? error.message : 'tenant_metadata_source_unavailable';
        const errorLogger = createLogger({ requestId, tenantId: 'unknown' });
        errorLogger.warn('Tenant metadata source resolution failed', {
          error: code,
          tenantId,
          path: c.req.path,
        });
        return c.json(
          { error: 'temporarily_unavailable', error_description: 'Tenant unavailable' },
          503
        );
      }
    }

    if (shouldValidateTenantExists) {
      const exists = await timeDiagnosticSpan(timingSpans, 'rc_tenant_exists', () =>
        validateTenantExistsWithIsolateCache(c.env, tenantMetadataContext?.coreDb, tenantId)
      );
      if (!exists) {
        const errorLogger = createLogger({ requestId, tenantId: 'unknown' });
        errorLogger.warn('Tenant existence check failed', {
          tenantId,
          host: c.req.header('Host'),
          path: c.req.path,
        });
        return c.json({ error: 'not_found', error_description: 'Tenant not found' }, 404);
      }
    }

    // The legacy tenant subdomain is a platform-controlled alias, so it can be
    // canonicalized before tenant-configured host binding is evaluated.
    if (
      isMultiTenantEnabled(c.env) &&
      tenantResult.success &&
      requestHost &&
      c.env.BASE_DOMAIN &&
      requestHost === `${tenantId}.${c.env.BASE_DOMAIN.toLowerCase()}`
    ) {
      const primaryVanity = await timeDiagnosticSpan(timingSpans, 'rc_primary_vanity', () =>
        getPrimaryTenantVanityDomain(
          {
            AUTHRIM_CONFIG: c.env.AUTHRIM_CONFIG,
            tenantCoreDb: tenantMetadataContext?.coreDb,
          },
          tenantId
        )
      );
      if (primaryVanity && primaryVanity.hostname !== requestHost) {
        const isBrowserNavigation =
          ['GET', 'HEAD'].includes(c.req.method) &&
          !c.req.path.startsWith('/api/') &&
          (c.req.header('Accept') || '').includes('text/html');

        if (isBrowserNavigation) {
          const redirectUrl = new URL(c.req.url);
          redirectUrl.hostname = primaryVanity.hostname;
          return c.redirect(redirectUrl.toString(), 308);
        }

        if (requestClass === 'public_protocol_or_rest') {
          return c.json({ error: 'not_found', error_description: 'Tenant not found' }, 404);
        }
      }
    }

    const shouldValidateTenantBinding =
      isMultiTenantEnabled(c.env) &&
      requestClass === 'public_protocol_or_rest' &&
      !!tenantId &&
      tenantResult.success;

    if (shouldValidateTenantBinding) {
      const bindingAllowed = await timeDiagnosticSpan(timingSpans, 'rc_binding', () =>
        validateTenantRequestBinding(c.req.raw, c.env.AUTHRIM_CONFIG, c.env, tenantId)
      );
      if (!bindingAllowed) {
        const errorLogger = createLogger({ requestId, tenantId: 'unknown' });
        errorLogger.warn('Tenant host or identifier binding check failed', {
          tenantId,
          host: c.req.header('Host'),
          path: c.req.path,
        });
        return c.json({ error: 'not_found', error_description: 'Tenant not found' }, 404);
      }
    }

    // Every public protocol transaction for a tenant has exactly one issuer
    // namespace. Validate that the incoming host is tenant-bound before
    // canonicalizing it so an unapproved alias cannot disclose tenant routing.
    if (isMultiTenantEnabled(c.env) && tenantResult.success && requestHost) {
      const primaryVanity = await timeDiagnosticSpan(timingSpans, 'rc_primary_vanity', () =>
        getPrimaryTenantVanityDomain(
          {
            AUTHRIM_CONFIG: c.env.AUTHRIM_CONFIG,
            tenantCoreDb: tenantMetadataContext?.coreDb,
          },
          tenantId
        )
      );
      if (primaryVanity && primaryVanity.hostname !== requestHost) {
        const isBrowserNavigation =
          ['GET', 'HEAD'].includes(c.req.method) &&
          !c.req.path.startsWith('/api/') &&
          (c.req.header('Accept') || '').includes('text/html');

        if (isBrowserNavigation) {
          const redirectUrl = new URL(c.req.url);
          redirectUrl.hostname = primaryVanity.hostname;
          return c.redirect(redirectUrl.toString(), 308);
        }

        if (requestClass === 'public_protocol_or_rest') {
          return c.json({ error: 'not_found', error_description: 'Tenant not found' }, 404);
        }
      }
    }

    // Create logger with request context
    const logger = createLogger({
      requestId,
      tenantId,
    });

    // Set context values
    // Using type assertion because Hono's context types don't know about our custom values
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = c as any;
    ctx.set('requestId', requestId);
    ctx.set('tenantId', tenantId);
    ctx.set('logger', logger);
    ctx.set('startTime', startTime);
    if (tenantMetadataContext) {
      ctx.set('tenantMetadataContext', tenantMetadataContext);
    }
    // Log request start
    logger.debug('Request started', {
      method: c.req.method,
      path: c.req.path,
      host: c.req.header('Host'),
      userAgent: c.req.header('User-Agent'),
    });

    try {
      await next();
    } finally {
      // Log request completion
      const duration = Date.now() - startTime;
      if (timingSpans) {
        timingSpans.push({
          name: 'rc_total',
          durationMs: roundDiagnosticDurationMs(duration),
        });
        appendServerTiming(c, timingSpans);
        logger.info('Request context timing', {
          diagnosticSessionId,
          path: c.req.path,
          request_class: requestClass,
          duration_ms: roundDiagnosticDurationMs(duration),
          spans_ms: Object.fromEntries(timingSpans.map((span) => [span.name, span.durationMs])),
        });
      }
      logger.debug('Request completed', {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: duration,
      });
    }
  };
}

/**
 * Get request context from Hono context.
 * Helper function for type-safe context access.
 *
 * @param c - Hono context
 * @returns Request context object
 */
export function getRequestContext(c: Context<{ Bindings: Env }>): RequestContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = c as any;
  return {
    requestId: ctx.get('requestId') || 'unknown',
    tenantId: ctx.get('tenantId') || DEFAULT_TENANT_ID,
    startTime: ctx.get('startTime') || Date.now(),
    logger: ctx.get('logger') || createLogger(),
  };
}

/**
 * Get the logger from Hono context.
 * Convenience function for the most common use case.
 *
 * @param c - Hono context
 * @returns Logger instance
 */
export function getLogger<TBindings extends object>(c: Context<{ Bindings: TBindings }>): Logger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = (c as any).get('logger');
  if (logger) {
    return logger;
  }
  // Fallback to a default logger if middleware wasn't applied
  return createLogger();
}

/**
 * Get the tenant ID from Hono context.
 *
 * @param c - Hono context (accepts any context with Env bindings)
 * @returns Tenant ID string
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTenantIdFromContext(c: Context<any, any, any>): string {
  const requestPath =
    c.req.path ||
    (() => {
      try {
        return c.req.raw ? new URL(c.req.raw.url).pathname : undefined;
      } catch {
        return undefined;
      }
    })();

  if (isAdminTenantHeaderRequired(requestPath)) {
    const requestedTenantId = c.req.header('X-Tenant-Id')?.trim();
    if (requestedTenantId && isValidTenantIdentifier(requestedTenantId)) {
      return requestedTenantId;
    }
  }

  return c.get('tenantId') || DEFAULT_TENANT_ID;
}

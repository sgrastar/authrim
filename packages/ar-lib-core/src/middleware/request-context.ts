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
import { resolveAuthCorePersistenceSourceFromEnv } from '../services/auth-core-persistence-context';
import { resolveUserStoreRuntimeSourcesFromEnv } from '../services/user-store-runtime-sources';

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

export function requestContextMiddleware(options: RequestContextMiddlewareOptions = {}) {
  const { requireTenant = true } = options;

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
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
    const authCoreSource = await resolveAuthCorePersistenceSourceFromEnv(c.env).catch(
      () => c.env.DB
    );
    let tenantId = tenantResult.tenantId;
    const requestHost = getRequestHost(c.req.raw)?.split(':')[0]?.toLowerCase();
    if (!tenantResult.success && shouldAttemptVanityHostResolution(c.env, requestHost, requestClass)) {
      const vanityTenantId = await resolveTenantFromVanityHost(
        authCoreSource,
        c.env.AUTHRIM_CONFIG,
        requestHost
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
    // Uses positive-only KV cache (300s TTL) to avoid per-request D1 queries.
    // Fail-open on D1 errors to prevent outages from blocking all requests.
    const shouldValidateTenantExists =
      isMultiTenantEnabled(c.env) &&
      !!tenantId &&
      (requestClass === 'tenant_scoped_admin' || tenantResult.success);

    if (shouldValidateTenantExists) {
      const exists = await validateTenantExistsAsync(authCoreSource, c.env.AUTHRIM_CONFIG, tenantId);
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

    if (
      isMultiTenantEnabled(c.env) &&
      tenantResult.success &&
      requestHost &&
      !!c.env.BASE_DOMAIN &&
      requestHost === `${tenantId}.${c.env.BASE_DOMAIN}`
    ) {
      const primaryVanity = await getPrimaryTenantVanityDomain(
        { ...c.env, DB: authCoreSource },
        tenantId
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
      const bindingAllowed = await validateTenantRequestBinding(
        c.req.raw,
        c.env.AUTHRIM_CONFIG,
        c.env,
        tenantId
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
    ctx.set(
      'runtimeUserStoreSources',
      await resolveUserStoreRuntimeSourcesFromEnv(c.env, tenantId)
    );

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
export function getLogger(c: Context<{ Bindings: Env }>): Logger {
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

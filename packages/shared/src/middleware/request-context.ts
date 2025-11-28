/**
 * Request Context Middleware
 *
 * This middleware establishes request-scoped context including:
 * - Request ID for correlation across logs
 * - Tenant ID for future multi-tenant support
 * - Structured logger instance
 *
 * Should be added early in the middleware chain so all subsequent
 * handlers have access to the context.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import { DEFAULT_TENANT_ID } from '../utils/tenant-context';
import { createLogger, type Logger } from '../utils/logger';

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
export function requestContextMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();

    // Single-tenant mode: always use default tenant
    // Future MT: Extract from subdomain
    // const host = c.req.header('Host') || '';
    // const tenantId = extractSubdomain(host, env.BASE_DOMAIN) || DEFAULT_TENANT_ID;
    const tenantId = DEFAULT_TENANT_ID;

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

    // Log request start
    logger.debug('Request started', {
      method: c.req.method,
      path: c.req.path,
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
 * @param c - Hono context
 * @returns Tenant ID string
 */
export function getTenantIdFromContext(c: Context<{ Bindings: Env }>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c as any).get('tenantId') || DEFAULT_TENANT_ID;
}

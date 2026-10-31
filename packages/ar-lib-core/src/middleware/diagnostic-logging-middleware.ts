/**
 * Diagnostic Logging Middleware
 *
 * Middleware for logging HTTP requests and responses for diagnostic purposes.
 * Used for debugging, troubleshooting, and OIDF conformance testing.
 *
 * Features:
 * - Semantic HTTP logging (not raw dumps)
 * - Respects diagnostic-logging settings
 * - Integrates with DiagnosticLogger service
 * - Handles X-Diagnostic-Session-Id header
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import {
  createDiagnosticLogger,
  type DiagnosticLogger,
} from '../services/diagnostic/diagnostic-logger';
import { createSettingsManager } from '../utils/settings-manager';
import type { DiagnosticLoggingSettings } from '../types/settings/diagnostic-logging';
import {
  DIAGNOSTIC_LOGGING_CATEGORY_META,
  DIAGNOSTIC_LOGGING_DEFAULTS,
} from '../types/settings/diagnostic-logging';
import { createLogger } from '../utils/logger';
import { parseBasicAuth } from '../utils/basic-auth';
import { readRequestTextWithLimit } from '../utils/body-limits';
import { isSafeIdentifier } from '../utils/diagnostic-redaction';

const log = createLogger().module('DiagnosticLoggingMiddleware');
const DIAGNOSTIC_CLIENT_ID_BODY_MAX_BYTES = 64 * 1024;
const DIAGNOSTIC_SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;
type HonoExecutionContext = Context<{ Bindings: Env }>['executionCtx'];

interface CachedDiagnosticSettings {
  settings: DiagnosticLoggingSettings;
  cachedAt: number;
  source: 'default' | 'kv';
}

const diagnosticSettingsCache = new WeakMap<object, Map<string, CachedDiagnosticSettings>>();

/**
 * Diagnostic logging middleware configuration
 */
export interface DiagnosticLoggingMiddlewareConfig {
  /** Tenant ID */
  tenantId?: string;

  /** Client ID (optional) */
  clientId?: string;

  /** Path patterns to exclude from logging (e.g., health checks) */
  excludePatterns?: RegExp[];
}

/**
 * Context variable name for diagnostic session ID
 */
const DIAGNOSTIC_SESSION_ID_VAR = 'diagnosticSessionId';
export const DIAGNOSTIC_FLOW_ID_HEADER = 'X-Authrim-Diagnostic-Flow-Id';

function getContextTenantId(c: Context<any>): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const tenantId = ((c as any).get('tenantId') as string | null | undefined)?.trim();
    return tenantId || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Diagnostic logging middleware
 *
 * Logs HTTP requests and responses using the DiagnosticLogger service.
 *
 * @param config - Middleware configuration
 * @returns Hono middleware
 */
export function diagnosticLoggingMiddleware(config: DiagnosticLoggingMiddlewareConfig) {
  return async (
    c: Context<{ Bindings: Env; Variables: { [DIAGNOSTIC_SESSION_ID_VAR]?: string } }>,
    next: Next
  ) => {
    const startTime = Date.now();

    // Check if path should be excluded
    if (config.excludePatterns) {
      const path = new URL(c.req.url).pathname;
      if (config.excludePatterns.some((pattern) => pattern.test(path))) {
        return next();
      }
    }

    // Get diagnostic session ID from header (if provided by SDK)
    const rawDiagnosticSessionId = c.req.header('X-Diagnostic-Session-Id');
    const diagnosticSessionId =
      rawDiagnosticSessionId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rawDiagnosticSessionId)
        ? rawDiagnosticSessionId
        : undefined;
    if (diagnosticSessionId) {
      c.set(DIAGNOSTIC_SESSION_ID_VAR as any, diagnosticSessionId);
    }

    const tenantId = config.tenantId?.trim() || getContextTenantId(c);
    if (!tenantId) {
      log.warn('Skipping diagnostic logging because tenant context is missing');
      return next();
    }

    const settings = getDiagnosticSettingsForMiddleware(c.env, tenantId, c.executionCtx);

    // Check if diagnostic logging is enabled
    if (!settings['diagnostic-logging.enabled']) {
      return next();
    }

    const clientId = config.clientId ?? (await resolveClientIdFromRequest(c));

    // Create diagnostic logger
    const logger = createDiagnosticLogger({
      env: c.env,
      tenantId,
      clientId,
      settings,
      ctx: c.executionCtx,
    });

    if (!logger) {
      return next();
    }

    // Generate request ID if not present
    // A client-supplied id is adopted only when it is a plain identifier (it is stored and
    // exported with every entry); anything else, an email address for one, is replaced.
    const suppliedRequestId = c.req.header('X-Request-Id');
    const requestId =
      suppliedRequestId && isSafeIdentifier(suppliedRequestId)
        ? suppliedRequestId
        : crypto.randomUUID();

    // Log HTTP request
    try {
      await logger.logHttpRequest({
        diagnosticSessionId,
        request: c.req.raw,
        requestId,
      });
    } catch (error) {
      log.warn('Failed to log HTTP request', { error: String(error) });
    }

    // Execute next middleware/handler
    await next();

    // Log HTTP response
    try {
      const durationMs = Date.now() - startTime;
      await logger.logHttpResponse({
        diagnosticSessionId,
        response: c.res,
        requestId,
        durationMs,
        flowId: c.res.headers.get(DIAGNOSTIC_FLOW_ID_HEADER) || undefined,
      });
    } catch (error) {
      log.warn('Failed to log HTTP response', { error: String(error) });
    }

    // Cleanup logger (flush buffer)
    try {
      await logger.cleanup();
    } catch (error) {
      log.warn('Failed to cleanup diagnostic logger', { error: String(error) });
    }
  };
}

/**
 * The settings a request uses until the tenant's are read (and when they cannot be read): the
 * built-in defaults, which are the safe values. Logging is off, and the PII filter is on.
 */
function getDefaultDiagnosticSettings(): DiagnosticLoggingSettings {
  return { ...DIAGNOSTIC_LOGGING_DEFAULTS };
}

function getDiagnosticSettingsCache(env: Env): Map<string, CachedDiagnosticSettings> {
  const key = env as object;
  let cache = diagnosticSettingsCache.get(key);
  if (!cache) {
    cache = new Map();
    diagnosticSettingsCache.set(key, cache);
  }
  return cache;
}

function getDiagnosticSettingsForMiddleware(
  env: Env,
  tenantId: string,
  ctx?: HonoExecutionContext
): DiagnosticLoggingSettings {
  const now = Date.now();
  const cache = getDiagnosticSettingsCache(env);
  const cached = cache.get(tenantId);
  if (cached && now - cached.cachedAt < DIAGNOSTIC_SETTINGS_CACHE_TTL_MS) {
    return cached.settings;
  }

  const defaultSettings = getDefaultDiagnosticSettings();
  cache.set(tenantId, {
    settings: defaultSettings,
    cachedAt: now,
    source: 'default',
  });
  scheduleDiagnosticSettingsRefresh(env, tenantId, ctx);
  return defaultSettings;
}

function scheduleDiagnosticSettingsRefresh(
  env: Env,
  tenantId: string,
  ctx?: HonoExecutionContext
): void {
  if (!env.SETTINGS) {
    return;
  }
  const refresh = loadDiagnosticSettings(env, tenantId)
    .then((settings) => {
      getDiagnosticSettingsCache(env).set(tenantId, {
        settings,
        cachedAt: Date.now(),
        source: 'kv',
      });
    })
    .catch(() => {
      getDiagnosticSettingsCache(env).set(tenantId, {
        settings: getDefaultDiagnosticSettings(),
        cachedAt: Date.now(),
        source: 'default',
      });
    });
  if (ctx) {
    ctx.waitUntil(refresh);
    return;
  }
  void refresh;
}

async function resolveClientIdFromRequest(c: Context): Promise<string | undefined> {
  const url = new URL(c.req.url);

  const queryClientId =
    url.searchParams.get('client_id') ??
    url.searchParams.get('clientId') ??
    url.searchParams.get('client');

  if (queryClientId) {
    return queryClientId;
  }

  const authHeader = c.req.header('Authorization');
  const basicAuth = parseBasicAuth(authHeader);
  if (basicAuth.success) {
    return basicAuth.credentials.username;
  }

  const contentType = c.req.header('Content-Type') || '';
  if (c.req.method !== 'POST') return undefined;

  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const bodyText = await readRequestTextWithLimit(
        c.req.raw.clone(),
        DIAGNOSTIC_CLIENT_ID_BODY_MAX_BYTES
      );
      const params = new URLSearchParams(bodyText);
      return params.get('client_id') ?? params.get('clientId') ?? undefined;
    }

    if (contentType.includes('application/json')) {
      const bodyText = await readRequestTextWithLimit(
        c.req.raw.clone(),
        DIAGNOSTIC_CLIENT_ID_BODY_MAX_BYTES
      );
      const body = JSON.parse(bodyText) as unknown;
      if (body && typeof body === 'object') {
        const maybeClientId =
          (body as Record<string, unknown>).client_id ?? (body as Record<string, unknown>).clientId;
        return typeof maybeClientId === 'string' ? maybeClientId : undefined;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Load diagnostic logging settings for a tenant
 *
 * @param env - Environment bindings
 * @param tenantId - Tenant ID
 * @returns Diagnostic logging settings
 */
async function loadDiagnosticSettings(
  env: Env,
  tenantId: string
): Promise<DiagnosticLoggingSettings> {
  try {
    const manager = createSettingsManager({
      env: env as unknown as Record<string, string | undefined>,
      kv: env.SETTINGS ?? null,
      cacheTTL: 5000,
    });

    // Register diagnostic-logging category (if not already registered)
    // Note: In production, categories should be registered at startup
    manager.registerCategory(DIAGNOSTIC_LOGGING_CATEGORY_META);
    const result = await manager.getAll('diagnostic-logging', {
      type: 'tenant',
      id: tenantId,
    });

    return result.values as unknown as DiagnosticLoggingSettings;
  } catch (error) {
    log.warn('Failed to load diagnostic logging settings, using defaults', {
      error: String(error),
    });

    return getDefaultDiagnosticSettings();
  }
}

/**
 * Get diagnostic session ID from context
 *
 * @param c - Hono context
 * @returns Diagnostic session ID or undefined
 */
export function getDiagnosticSessionId(c: Context): string | undefined {
  return c.get(DIAGNOSTIC_SESSION_ID_VAR) as string | undefined;
}

/**
 * Create a diagnostic logger helper for manual logging
 *
 * Use this helper to manually log diagnostic events outside of the middleware.
 *
 * @param c - Hono context
 * @param config - Logger configuration
 * @returns DiagnosticLogger instance or null if disabled
 */
export async function createDiagnosticLoggerFromContext(
  c: Context<{ Bindings: Env }>,
  config: {
    tenantId: string;
    clientId?: string;
  }
): Promise<DiagnosticLogger | null> {
  const settings = await loadDiagnosticSettings(c.env, config.tenantId);

  if (!settings['diagnostic-logging.enabled']) {
    return null;
  }

  return createDiagnosticLogger({
    env: c.env,
    tenantId: config.tenantId,
    clientId: config.clientId,
    settings,
    ctx: c.executionCtx,
  });
}

/**
 * Check API Routes
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Provides unified permission checking endpoint:
 * - POST /api/check - Single permission check
 * - POST /api/check/batch - Batch permission check (Step 5)
 * - GET /api/check/health - Health check
 *
 * Authentication:
 * - API Key: Authorization: Bearer chk_xxx (prefix-based detection)
 * - Access Token: Authorization: Bearer <JWT> (JWT format detection)
 */

import { Hono } from 'hono';
import type { KVNamespace } from '@cloudflare/workers-types';
import type { Env as SharedEnv } from '@authrim/ar-lib-core';
import {
  createUnifiedCheckService,
  createReBACService,
  parsePermission,
  createErrorResponse,
  AR_ERROR_CODES,
  type CheckApiRequest,
  type UnifiedCheckService,
  type ReBACConfig,
  type IStorageAdapter,
} from '@authrim/ar-lib-core';
import {
  authenticateCheckApiRequest,
  isOperationAllowed,
  type CheckAuthResult,
} from '../middleware/check-auth';
import {
  checkRateLimit,
  addRateLimitHeaders,
  type RateLimitContext,
} from '../middleware/rate-limit';

// =============================================================================
// Types
// =============================================================================

interface Env extends SharedEnv {
  /** Internal API secret for service-to-service auth */
  POLICY_API_SECRET: string;
  /** KV namespace for ReBAC caching */
  REBAC_CACHE_KV?: KVNamespace;
  /** KV namespace for Check API caching */
  CHECK_CACHE_KV?: KVNamespace;
  /** KV namespace for feature flags (dynamic override) - uses AUTHRIM_CONFIG if not set */
  POLICY_FLAGS_KV?: KVNamespace;
  /** Shared config KV namespace (fallback for POLICY_FLAGS_KV) */
  AUTHRIM_CONFIG?: KVNamespace;
  /** Default tenant ID */
  DEFAULT_TENANT_ID?: string;
  /** Feature flag: Enable Check API */
  ENABLE_CHECK_API?: string;
  /** Feature flag: Enable Check API debug mode */
  CHECK_API_DEBUG_MODE?: string;
  /** Batch size limit for batch check API (1-1000, default: 100) */
  CHECK_API_BATCH_SIZE_LIMIT?: string;
}

// =============================================================================
// Storage Adapter for ReBAC
// =============================================================================

class D1StorageAdapter implements IStorageAdapter {
  constructor(private db: D1Database) {}

  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string, _ttl?: number): Promise<void> {}

  async delete(_key: string): Promise<void> {}

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    if (params && params.length > 0) {
      stmt.bind(...params);
    }
    const result = await stmt.all<T>();
    return result.results ?? [];
  }

  async execute(
    sql: string,
    params?: unknown[]
  ): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> {
    const stmt = this.db.prepare(sql);
    if (params && params.length > 0) {
      stmt.bind(...params);
    }
    const result = await stmt.run();
    return {
      success: result.success,
      meta: {
        changes: result.meta?.changes ?? 0,
        last_row_id: result.meta?.last_row_id ?? 0,
      },
    };
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** KV key for Check API enable flag */
const KV_CHECK_API_ENABLED_KEY = 'CHECK_API_ENABLED';

/** KV key for batch size limit */
const KV_BATCH_SIZE_LIMIT_KEY = 'CHECK_API_BATCH_SIZE_LIMIT';

/** Default batch size limit (secure default: not too large to prevent DoS) */
const DEFAULT_BATCH_SIZE_LIMIT = 100;

/** In-memory cache for batch size limit (to reduce KV reads) */
let batchSizeLimitCache: { value: number; expiresAt: number } | null = null;

/**
 * Clear batch size limit cache (for testing)
 */
export function clearBatchSizeLimitCache(): void {
  batchSizeLimitCache = null;
}

/**
 * Get config KV namespace (POLICY_FLAGS_KV or AUTHRIM_CONFIG)
 * Priority: POLICY_FLAGS_KV → AUTHRIM_CONFIG
 */
function getConfigKV(env: Env): KVNamespace | undefined {
  return env.POLICY_FLAGS_KV || env.AUTHRIM_CONFIG;
}

/**
 * Get batch size limit from KV → Environment Variable → Default
 * Uses in-memory cache to reduce KV reads
 */
async function getBatchSizeLimit(env: Env): Promise<number> {
  // 1. Check in-memory cache first (5 minute TTL)
  const now = Date.now();
  if (batchSizeLimitCache && batchSizeLimitCache.expiresAt > now) {
    return batchSizeLimitCache.value;
  }

  let limit = DEFAULT_BATCH_SIZE_LIMIT;

  // 2. Check KV for dynamic override (highest priority)
  const configKV = getConfigKV(env);
  if (configKV) {
    try {
      const kvValue = await configKV.get(KV_BATCH_SIZE_LIMIT_KEY);
      if (kvValue !== null) {
        const parsed = parseInt(kvValue, 10);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 1000) {
          limit = parsed;
          // Cache the KV value
          batchSizeLimitCache = { value: limit, expiresAt: now + 5 * 60 * 1000 };
          return limit;
        }
      }
    } catch (error) {
      console.error('[Check API] Failed to read batch size limit from KV:', error);
    }
  }

  // 3. Check environment variable
  if (env.CHECK_API_BATCH_SIZE_LIMIT) {
    const parsed = parseInt(env.CHECK_API_BATCH_SIZE_LIMIT, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 1000) {
      limit = parsed;
    }
  }

  // Cache the resolved value
  batchSizeLimitCache = { value: limit, expiresAt: now + 5 * 60 * 1000 };
  return limit;
}

/**
 * Check if Check API feature is enabled
 * Priority: KV → Environment Variable → Default (disabled for security)
 */
async function isCheckApiEnabled(env: Env): Promise<boolean> {
  // 1. Check KV for dynamic override (highest priority)
  const configKV = getConfigKV(env);
  if (configKV) {
    try {
      const kvValue = await configKV.get(KV_CHECK_API_ENABLED_KEY);
      if (kvValue !== null) {
        return kvValue === 'true';
      }
    } catch (error) {
      // KV error: log and fall through to env var check
      console.error('[Check API] Failed to read KV flag:', error);
    }
  }

  // 2. Check environment variable
  if (env.ENABLE_CHECK_API === 'true') {
    return true;
  }

  // 3. Default: disabled (secure default)
  return false;
}

/**
 * Check if debug mode is enabled
 */
function isDebugModeEnabled(env: Env): boolean {
  return env.CHECK_API_DEBUG_MODE === 'true';
}

/**
 * Create UnifiedCheckService instance
 */
function getCheckService(env: Env, debugMode: boolean): UnifiedCheckService | null {
  if (!env.DB) {
    return null;
  }

  // Create ReBAC service if cache KV is available
  const rebacAdapter = new D1StorageAdapter(env.DB);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rebacConfig: ReBACConfig = {
    cache_namespace: env.REBAC_CACHE_KV as any,
    cache_ttl: 60,
    max_depth: 5,
  };
  const rebacService = createReBACService(rebacAdapter, rebacConfig);

  return createUnifiedCheckService({
    db: env.DB,
    cache: env.CHECK_CACHE_KV,
    rebacService,
    cacheTTL: 60,
    debugMode,
  });
}

// =============================================================================
// Routes
// =============================================================================

const checkRoutes = new Hono<{ Bindings: Env }>();

/**
 * Health check
 * GET /api/check/health
 */
checkRoutes.get('/health', async (c) => {
  const enabled = await isCheckApiEnabled(c.env);
  const hasDatabase = !!c.env.DB;
  const hasCache = !!c.env.CHECK_CACHE_KV;
  const batchSizeLimit = await getBatchSizeLimit(c.env);

  return c.json({
    status: enabled && hasDatabase ? 'ok' : 'limited',
    service: 'check-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    enabled,
    database: hasDatabase,
    cache: hasCache,
    debug_mode: isDebugModeEnabled(c.env),
    batch_size_limit: batchSizeLimit,
  });
});

/**
 * Single permission check
 * POST /api/check
 *
 * Request body:
 * {
 *   "subject_id": "user_123",
 *   "permission": "documents:doc_456:read"  // or { resource, id?, action }
 *   "tenant_id": "default",                 // optional
 *   "resource_context": { ... },            // optional, for ABAC
 *   "rebac": { relation, object }           // optional, for ReBAC
 * }
 *
 * Response:
 * {
 *   "allowed": true,
 *   "resolved_via": ["id_level"],
 *   "final_decision": "allow",
 *   "cache_ttl": 60
 * }
 */
checkRoutes.post('/', async (c) => {
  // Check if feature is enabled
  const enabled = await isCheckApiEnabled(c.env);
  if (!enabled) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  // Authenticate request using dual auth (API Key + Access Token)
  const auth = await authenticateCheckApiRequest(c.req.header('Authorization'), {
    db: c.env.DB,
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
    defaultTenantId: c.env.DEFAULT_TENANT_ID,
  });

  if (!auth.authenticated) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check operation permission
  if (!isOperationAllowed(auth, 'check')) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  // Check rate limit
  const rateLimitCtx: RateLimitContext = {
    cache: c.env.CHECK_CACHE_KV,
    configKv: getConfigKV(c.env),
  };
  const rateLimitResult = await checkRateLimit(auth, rateLimitCtx);

  // Add rate limit headers to response
  const responseHeaders = new Headers();
  addRateLimitHeaders(responseHeaders, rateLimitResult);

  if (!rateLimitResult.allowed) {
    return c.json(
      {
        error: 'slow_down',
        error_description: 'Too many requests. Please retry later.',
        retry_after: rateLimitResult.retryAfter,
      },
      {
        status: 429,
        headers: Object.fromEntries(responseHeaders.entries()),
      }
    );
  }

  // Get check service
  const debugMode = isDebugModeEnabled(c.env);
  const checkService = getCheckService(c.env, debugMode);
  if (!checkService) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    // Parse request body
    const body = await c.req.json<Partial<CheckApiRequest>>();

    // Validate required fields
    if (!body.subject_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'subject_id' },
      });
    }

    if (!body.permission) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'permission' },
      });
    }

    // Validate permission format
    try {
      parsePermission(body.permission);
    } catch (error) {
      console.error('[Check API] Permission parse error:', error);
      // SECURITY: Do not expose internal parser error details
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Build full request
    // Use tenant from auth context if not specified in request
    const request: CheckApiRequest = {
      subject_id: body.subject_id,
      subject_type: body.subject_type ?? 'user',
      permission: body.permission,
      tenant_id: body.tenant_id ?? auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default',
      resource_context: body.resource_context,
      rebac: body.rebac,
    };

    // Execute check
    const result = await checkService.check(request);

    // Return with rate limit headers
    return c.json(result, {
      status: 200,
      headers: Object.fromEntries(responseHeaders.entries()),
    });
  } catch (error) {
    console.error('[Check API] Check error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Batch permission check (placeholder - Step 5 will implement fully)
 * POST /api/check/batch
 */
checkRoutes.post('/batch', async (c) => {
  // Check if feature is enabled
  const enabled = await isCheckApiEnabled(c.env);
  if (!enabled) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  // Authenticate request using dual auth (API Key + Access Token)
  const auth = await authenticateCheckApiRequest(c.req.header('Authorization'), {
    db: c.env.DB,
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
    defaultTenantId: c.env.DEFAULT_TENANT_ID,
  });

  if (!auth.authenticated) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check operation permission
  if (!isOperationAllowed(auth, 'batch')) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  // Check rate limit
  const rateLimitCtx: RateLimitContext = {
    cache: c.env.CHECK_CACHE_KV,
    configKv: getConfigKV(c.env),
  };
  const rateLimitResult = await checkRateLimit(auth, rateLimitCtx);

  // Add rate limit headers to response
  const responseHeaders = new Headers();
  addRateLimitHeaders(responseHeaders, rateLimitResult);

  if (!rateLimitResult.allowed) {
    return c.json(
      {
        error: 'slow_down',
        error_description: 'Too many requests. Please retry later.',
        retry_after: rateLimitResult.retryAfter,
      },
      {
        status: 429,
        headers: Object.fromEntries(responseHeaders.entries()),
      }
    );
  }

  // Get check service
  const debugMode = isDebugModeEnabled(c.env);
  const checkService = getCheckService(c.env, debugMode);
  if (!checkService) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    const body = await c.req.json<{
      checks?: CheckApiRequest[];
      stop_on_deny?: boolean;
    }>();

    // Validate request
    if (!body.checks || !Array.isArray(body.checks) || body.checks.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'checks' },
      });
    }

    // Limit batch size (configurable via KV → Environment Variable → Default)
    const batchSizeLimit = await getBatchSizeLimit(c.env);
    if (body.checks.length > batchSizeLimit) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Validate all permission formats first
    for (const check of body.checks) {
      if (!check.subject_id || !check.permission) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      try {
        parsePermission(check.permission);
      } catch (error) {
        console.error('[Check API] Batch permission parse error:', error);
        // SECURITY: Do not expose internal parser error details
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
    }

    // Apply default tenant_id (use auth context tenant if available)
    const defaultTenantId = auth.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'default';
    const normalizedChecks = body.checks.map((check) => ({
      ...check,
      subject_type: check.subject_type ?? 'user',
      tenant_id: check.tenant_id ?? defaultTenantId,
    }));

    // Execute batch check
    const result = await checkService.batchCheck({
      checks: normalizedChecks,
      stop_on_deny: body.stop_on_deny,
    });

    // Return with rate limit headers
    return c.json(result, {
      status: 200,
      headers: Object.fromEntries(responseHeaders.entries()),
    });
  } catch (error) {
    console.error('[Check API] Batch check error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export { checkRoutes };

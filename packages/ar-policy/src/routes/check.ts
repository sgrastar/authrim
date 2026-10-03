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

import { Hono, type Context } from 'hono';
import type { KVNamespace, ExecutionContext, Queue } from '@cloudflare/workers-types';
import type { Env as SharedEnv } from '@authrim/ar-lib-core';
import {
  parsePermission,
  createErrorResponse,
  AR_ERROR_CODES,
  createLogger,
  resolveOptionalCoreAdapterFromHono,
  UserVerifiedAttributeRepository,
  resolvePlatformSettingsWithSources,
  CHECK_API_AUDIT_DEFAULTS,
  type CheckApiRequest,
} from '@authrim/ar-lib-core';
import {
  createUnifiedCheckService,
  type UnifiedCheckService,
} from '@authrim/ar-lib-core/services/unified-check-service';
import {
  createCheckAuditService,
  type CheckAuditService,
  type CheckAuditServiceConfig,
  type AuditMode,
} from '@authrim/ar-lib-core/services/check-audit-service';

const log = createLogger().module('CHECK-API');
import {
  authenticateCheckApiRequest,
  isOperationAllowed,
  resolveAuthorizedCheckTenantId,
  type CheckAuthResult,
} from '../middleware/check-auth';
import {
  checkRateLimit,
  addRateLimitHeaders,
  type RateLimitContext,
} from '../middleware/rate-limit';
import { createPolicyReBACService, getPolicyCoreAdapter } from '../rebac-storage-adapter';
import { resolveTenantPolicy } from '../tenant-policy';

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
  /** Default tenant ID */
  DEFAULT_TENANT_ID?: string;
  /** Feature flag: Enable Check API */
  ENABLE_CHECK_API?: string;
  /** Feature flag: Enable Check API debug mode */
  ENABLE_CHECK_API_DEBUG?: string;
  /** Batch size limit for batch check API (1-1000, default: 100) */
  CHECK_API_BATCH_SIZE_LIMIT?: string;
  /** Feature flag: Enable Check API audit logging */
  ENABLE_CHECK_API_AUDIT?: string;
  /** Audit log mode: 'waitUntil' | 'sync' | 'queue' (default: 'waitUntil') */
  CHECK_API_AUDIT_MODE?: string;
  /** Audit log allow policy: 'always' | 'sample' | 'never' (default: 'sample') */
  CHECK_API_AUDIT_LOG_ALLOW?: string;
  /** Audit log sample rate for allow events (0.0-1.0, default: 0.01) */
  CHECK_API_AUDIT_SAMPLE_RATE?: string;
  /** Audit log retention days (default: 90) */
  CHECK_API_AUDIT_RETENTION_DAYS?: string;
  /** Queue for audit log processing (required for queue mode) */
  CHECK_AUDIT_QUEUE?: Queue;
}

// =============================================================================
// Helpers
// =============================================================================

/** Default batch size limit (secure default: not too large to prevent DoS) */
const DEFAULT_BATCH_SIZE_LIMIT = 100;

/** A batch size limit as the Check API applies it: a whole number in 1..1000, else unset. */
function batchSizeLimitOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1000
    ? value
    : undefined;
}

/** The batch size from env alone (CHECK_API_BATCH_SIZE_LIMIT), else the default. */
function envBatchSizeLimit(env: Env): number {
  const batch = env.CHECK_API_BATCH_SIZE_LIMIT
    ? batchSizeLimitOf(parseInt(env.CHECK_API_BATCH_SIZE_LIMIT, 10))
    : undefined;
  return batch ?? DEFAULT_BATCH_SIZE_LIMIT;
}

/**
 * Whether the Check API is on, and the most checks in one batch, for the whole platform: the
 * Settings API values (`feature.enable_check_api`, `limits.check_api_batch_size`), else env,
 * else off and 100. When the switch cannot be read the Check API is off (env does not turn on what
 * a saved value may have turned off); a batch size that cannot be read is env's, else 100.
 */
async function readCheckApiSettings(
  env: Env
): Promise<{ enabled: boolean; batchSizeLimit: number }> {
  // Each read apart, as before: one that fails leaves the other's value in effect.
  const [flags, limits] = await Promise.allSettled([
    resolvePlatformSettingsWithSources(env, 'feature-flags', {}),
    resolvePlatformSettingsWithSources(env, 'limits', {}),
  ]);
  for (const result of [flags, limits]) {
    if (result.status === 'rejected') {
      log.error(
        'Failed to read Check API settings',
        { error: String(result.reason) },
        result.reason as Error
      );
    }
  }
  return {
    enabled:
      flags.status === 'fulfilled'
        ? flags.value.values['feature.enable_check_api'] === true
        : false,
    batchSizeLimit:
      limits.status === 'fulfilled'
        ? (batchSizeLimitOf(limits.value.values['limits.check_api_batch_size']) ??
          DEFAULT_BATCH_SIZE_LIMIT)
        : envBatchSizeLimit(env),
  };
}

/** Whether the Check API is on (see readCheckApiSettings). */
async function isCheckApiEnabled(env: Env): Promise<boolean> {
  return (await readCheckApiSettings(env)).enabled;
}

/** The most checks in one batch request (see readCheckApiSettings). */
async function getBatchSizeLimit(env: Env): Promise<number> {
  return (await readCheckApiSettings(env)).batchSizeLimit;
}

/**
 * Check if debug mode is enabled
 */
function isDebugModeEnabled(env: Env): boolean {
  return env.ENABLE_CHECK_API_DEBUG === 'true';
}

/**
 * The Check API's audit settings for the whole platform: the Settings API values
 * (`audit.check_api_*`), else env, else the defaults. When they cannot be read, auditing stays on
 * with the defaults: a read failure must not stop an audit that may have been turned on.
 */
async function getAuditConfig(env: Env): Promise<{
  enabled: boolean;
  config: CheckAuditServiceConfig;
}> {
  let values: Record<string, unknown>;
  try {
    values = (await resolvePlatformSettingsWithSources(env, 'check-api-audit', {})).values;
  } catch (error) {
    log.error('Failed to read Check API audit settings', { error: String(error) }, error as Error);
    values = { ...CHECK_API_AUDIT_DEFAULTS, 'audit.check_api_enabled': true };
  }
  return {
    enabled: values['audit.check_api_enabled'] === true,
    config: {
      mode: values['audit.check_api_mode'] as AuditMode,
      logDeny: 'always',
      logAllow: values['audit.check_api_log_allow'] as 'always' | 'sample' | 'never',
      sampleRate: values['audit.check_api_sample_rate'] as number,
      retentionDays: values['audit.check_api_retention_days'] as number,
    },
  };
}

/**
 * Create UnifiedCheckService instance with optional audit service
 */
async function getCheckService(
  c: Context<{ Bindings: Env }>,
  debugMode: boolean
): Promise<{ checkService: UnifiedCheckService; auditService?: CheckAuditService } | null> {
  const env = c.env;
  const coreAdapter = getPolicyCoreAdapter(c);

  // Create ReBAC service if cache KV is available
  const rebacService = createPolicyReBACService(coreAdapter, env.REBAC_CACHE_KV);

  // Create audit service if enabled
  let auditService: CheckAuditService | undefined;
  const auditConfig = await getAuditConfig(env);
  if (auditConfig.enabled) {
    auditService = createCheckAuditService(coreAdapter, auditConfig.config, env.CHECK_AUDIT_QUEUE);
  }

  const checkService = createUnifiedCheckService({
    db: coreAdapter,
    cache: env.CHECK_CACHE_KV,
    rebacService,
    cacheTTL: 60,
    debugMode,
    auditService,
    // Verified attributes and the tenant's rules, as each check's tenant settings enable them.
    attributeRepository: new UserVerifiedAttributeRepository(coreAdapter),
    tenantPolicy: (tenantId) => resolveTenantPolicy(env, coreAdapter, tenantId),
  });

  return { checkService, auditService };
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
  const hasDatabase = Boolean(
    resolveOptionalCoreAdapterFromHono(
      c as unknown as Context<{ Bindings: SharedEnv }>,
      'policy-health'
    )
  );
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
 *   "tenant_id": "tenant-a",                // required for system secret; optional for tenant-bound credentials
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
  const coreAdapter = getPolicyCoreAdapter(c);
  const auth = await authenticateCheckApiRequest(c.req.header('Authorization'), {
    db: coreAdapter,
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
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
  const services = await getCheckService(c, debugMode);
  if (!services) {
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
      log.debug('Permission parse error', { error: String(error) });
      // SECURITY: Do not expose internal parser error details
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    // Validate rebac parameters if provided
    if (body.rebac) {
      // Validate relation
      if (!body.rebac.relation || typeof body.rebac.relation !== 'string') {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'rebac.relation' },
        });
      }
      // Validate object
      if (!body.rebac.object || typeof body.rebac.object !== 'string') {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'rebac.object' },
        });
      }
      // Validate contextual_tuples if provided
      if (body.rebac.contextual_tuples !== undefined) {
        if (!Array.isArray(body.rebac.contextual_tuples)) {
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
        // Limit contextual_tuples size to prevent DoS
        const maxContextualTuples = 100;
        if (body.rebac.contextual_tuples.length > maxContextualTuples) {
          log.warn('Contextual tuples limit exceeded', {
            count: body.rebac.contextual_tuples.length,
            limit: maxContextualTuples,
          });
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
        // Validate each tuple
        for (let i = 0; i < body.rebac.contextual_tuples.length; i++) {
          const tuple = body.rebac.contextual_tuples[i];
          if (!tuple || typeof tuple !== 'object') {
            return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
          }
          if (!tuple.user_id || typeof tuple.user_id !== 'string') {
            return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
              variables: { field: `rebac.contextual_tuples[${i}].user_id` },
            });
          }
          if (!tuple.relation || typeof tuple.relation !== 'string') {
            return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
              variables: { field: `rebac.contextual_tuples[${i}].relation` },
            });
          }
          if (!tuple.object || typeof tuple.object !== 'string') {
            return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
              variables: { field: `rebac.contextual_tuples[${i}].object` },
            });
          }
        }
      }
    }

    const tenantId = resolveAuthorizedCheckTenantId(auth, body.tenant_id);
    if (!tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
    }

    // Build full request using the authenticated tenant unless a system secret
    // explicitly targets another tenant.
    const request: CheckApiRequest = {
      subject_id: body.subject_id,
      subject_type: body.subject_type ?? 'user',
      permission: body.permission,
      tenant_id: tenantId,
      resource_context: body.resource_context,
      rebac: body.rebac,
    };

    // Execute check with audit options
    // Note: ExecutionContext is available via c.executionCtx in Hono
    const result = await services.checkService.check(request, {
      ctx: c.executionCtx as ExecutionContext,
      apiKeyId: auth.apiKeyId,
      clientId: auth.clientId,
      requestId: c.req.header('X-Request-ID'),
    });

    // Return with rate limit headers
    return c.json(result, {
      status: 200,
      headers: Object.fromEntries(responseHeaders.entries()),
    });
  } catch (error) {
    log.error('Check error', { error: String(error) }, error as Error);
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
  const coreAdapter = getPolicyCoreAdapter(c);
  const auth = await authenticateCheckApiRequest(c.req.header('Authorization'), {
    db: coreAdapter,
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
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
  const services = await getCheckService(c, debugMode);
  if (!services) {
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

    // Validate all check requests
    const maxContextualTuples = 100;
    for (let checkIdx = 0; checkIdx < body.checks.length; checkIdx++) {
      const check = body.checks[checkIdx];
      if (!check.subject_id || !check.permission) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      try {
        parsePermission(check.permission);
      } catch (error) {
        log.debug('Batch permission parse error', { error: String(error) });
        // SECURITY: Do not expose internal parser error details
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      // Validate rebac parameters if provided
      if (check.rebac) {
        if (!check.rebac.relation || typeof check.rebac.relation !== 'string') {
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
        if (!check.rebac.object || typeof check.rebac.object !== 'string') {
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
        // Validate contextual_tuples if provided
        if (check.rebac.contextual_tuples !== undefined) {
          if (!Array.isArray(check.rebac.contextual_tuples)) {
            return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
          }
          if (check.rebac.contextual_tuples.length > maxContextualTuples) {
            log.warn('Batch contextual tuples limit exceeded', {
              checkIndex: checkIdx,
              count: check.rebac.contextual_tuples.length,
              limit: maxContextualTuples,
            });
            return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
          }
          for (const tuple of check.rebac.contextual_tuples) {
            if (
              !tuple ||
              typeof tuple !== 'object' ||
              !tuple.user_id ||
              typeof tuple.user_id !== 'string' ||
              !tuple.relation ||
              typeof tuple.relation !== 'string' ||
              !tuple.object ||
              typeof tuple.object !== 'string'
            ) {
              return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
            }
          }
        }
      }
    }

    // Apply default tenant_id and reject cross-tenant overrides for tenant-bound auth.
    const normalizedChecks: CheckApiRequest[] = [];
    for (const check of body.checks) {
      const tenantId = resolveAuthorizedCheckTenantId(auth, check.tenant_id);
      if (!tenantId) {
        return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
      }
      normalizedChecks.push({
        ...check,
        subject_type: check.subject_type ?? 'user',
        tenant_id: tenantId,
      });
    }

    // Execute batch check with audit options
    const result = await services.checkService.batchCheck(
      {
        checks: normalizedChecks,
        stop_on_deny: body.stop_on_deny,
      },
      {
        ctx: c.executionCtx as ExecutionContext,
        apiKeyId: auth.apiKeyId,
        clientId: auth.clientId,
        requestId: c.req.header('X-Request-ID'),
      }
    );

    // Return with rate limit headers
    return c.json(result, {
      status: 200,
      headers: Object.fromEntries(responseHeaders.entries()),
    });
  } catch (error) {
    log.error('Batch check error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export { checkRoutes };

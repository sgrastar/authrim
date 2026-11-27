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
 * Authentication and contracts (CheckContract in ar-lib-core):
 * - Server contract: API Key (Authorization: Bearer chk_xxx) or the policy service secret. Any
 *   subject of the tenant; `resource_context` and `rebac` are taken from the request.
 * - Self contract: an end-user access token (Authorization: Bearer <JWT>; see
 *   middleware/check-access-token.ts). The subject is the token's account. Each check may carry only
 *   `permission` (plus `subject_id` / `subject_type: 'user'` / `tenant_id` when they name the token's
 *   own subject and tenant); `resource_context`, `rebac` and anything else are refused with 400
 *   (POLICY_CHECK_CONTRACT_VIOLATION), single and batch alike. The resource's owner, group and
 *   attributes are resolved server-side (resource-context-resolvers.ts; none by default).
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
  resolveAccountCoreDataContext,
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
  checkContractOf,
  isOperationAllowed,
  resolveAuthorizedCheckTenantId,
  type CheckAuthContext,
  type CheckAuthResult,
} from '../middleware/check-auth';
import { createCheckAccessTokenVerifier } from '../middleware/check-access-token';
import { getBatchSizeLimit, isCheckApiEnabled } from './check-settings';
import { checkAuthenticationFailure } from './check-auth-response';
import { checkResourceContextResolvers } from '../resource-context-resolvers';
import {
  checkRateLimit,
  addRateLimitHeaders,
  RateLimiterUnavailableError,
  type RateLimitContext,
  type RateLimitResult,
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

/** The authentication context of a Check API request (access tokens: check-access-token.ts). */
function checkAuthContext(c: Context<{ Bindings: Env }>): CheckAuthContext {
  return {
    db: getPolicyCoreAdapter(c),
    cache: c.env.CHECK_CACHE_KV,
    policyApiSecret: c.env.POLICY_API_SECRET,
    accessTokenVerifier: createCheckAccessTokenVerifier(c),
  };
}

/** The fields a self-contract check may carry (see the module comment). */
const SELF_CONTRACT_CHECK_FIELDS: ReadonlySet<string> = new Set([
  'permission',
  'subject_id',
  'subject_type',
  'tenant_id',
]);

/**
 * Why a self-contract check is refused (a field it may not carry, or a subject other than the
 * token's), or null. `subject_id` may only be omitted or name the token's own public `sub` (what
 * the app knows the user as); it is never compared with the internal account id, so the answer
 * reveals nothing about a pairwise subject's account.
 */
function selfContractViolation(
  check: Record<string, unknown>,
  auth: CheckAuthResult
): string | null {
  for (const field of Object.keys(check)) {
    if (!SELF_CONTRACT_CHECK_FIELDS.has(field)) return field;
  }
  if (
    check.subject_id !== undefined &&
    (auth.tokenSubject === undefined || check.subject_id !== auth.tokenSubject)
  ) {
    return 'subject_id';
  }
  if (check.subject_type !== undefined && check.subject_type !== 'user') return 'subject_type';
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request body as JSON, or `undefined` when it is not JSON (a 400, never a 500). */
async function readJsonBody(c: Context<{ Bindings: Env }>): Promise<unknown> {
  try {
    return await c.req.json<unknown>();
  } catch {
    return undefined;
  }
}

/** Whether a request's `tenant_id` is absent or a string (anything else is a 400). */
function isTenantIdShape(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** The keys a structured permission may have. */
const PERMISSION_OBJECT_KEYS: ReadonlySet<string> = new Set(['resource', 'id', 'action']);

/**
 * Whether a permission has a valid shape before it is parsed: a non-empty string, or an object
 * with only `resource`, `action` (non-empty strings) and an optional non-empty string `id`.
 */
function isWellFormedPermission(permission: unknown): boolean {
  if (typeof permission === 'string') return permission.length > 0;
  if (!isPlainObject(permission)) return false;
  if (Object.keys(permission).some((key) => !PERMISSION_OBJECT_KEYS.has(key))) return false;
  if (typeof permission.resource !== 'string' || !permission.resource) return false;
  if (typeof permission.action !== 'string' || !permission.action) return false;
  if (permission.id !== undefined && (typeof permission.id !== 'string' || !permission.id)) {
    return false;
  }
  return true;
}

/** The keys of a batch request. */
const BATCH_ENVELOPE_KEYS: ReadonlySet<string> = new Set(['checks', 'stop_on_deny']);

/** The rate limit, or a 503 when the atomic limiter is unavailable (fail closed). */
async function checkRateLimitOrUnavailable(
  auth: Parameters<typeof checkRateLimit>[0],
  ctx: RateLimitContext
): Promise<RateLimitResult | Response> {
  try {
    return await checkRateLimit(auth, ctx);
  } catch (error) {
    if (!(error instanceof RateLimiterUnavailableError)) throw error;
    return new Response(
      JSON.stringify({
        error: 'temporarily_unavailable',
        error_description: 'The service is temporarily unavailable. Please try again later.',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }
    );
  }
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
): Promise<{ checkService: UnifiedCheckService; auditService?: CheckAuditService }> {
  const env = c.env;
  const coreAdapter = getPolicyCoreAdapter(c);

  // Create ReBAC service if cache KV is available
  // No shared ReBAC result cache on the Check API: each decision reads the current tuples (v1
  // keeps no shared allow cache; a revoked relationship must not keep granting).
  const rebacService = createPolicyReBACService(coreAdapter, undefined);

  // Create audit service if enabled
  let auditService: CheckAuditService | undefined;
  const auditConfig = await getAuditConfig(env);
  if (auditConfig.enabled) {
    auditService = createCheckAuditService(env, auditConfig.config);
  }

  const checkService = createUnifiedCheckService({
    db: coreAdapter,
    // A subject's role assignments and organisation memberships are in its account database.
    subjectAccountDb: async (tenantId, subjectId) =>
      (await resolveAccountCoreDataContext(env, { tenantId, accountId: subjectId })).coreDb,
    cache: env.CHECK_CACHE_KV,
    rebacService,
    cacheTTL: 60,
    debugMode,
    auditService,
    // Verified attributes and the tenant's rules, as each check's tenant settings enable them.
    attributeRepository: new UserVerifiedAttributeRepository(coreAdapter),
    tenantPolicy: (tenantId) => resolveTenantPolicy(env, coreAdapter, tenantId),
    // Self-contract checks: the resource's owner, group and attributes, server-side.
    resourceContextResolver: checkResourceContextResolvers,
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
  const auth = await authenticateCheckApiRequest(
    c.req.header('Authorization'),
    checkAuthContext(c)
  );

  if (!auth.authenticated) {
    return checkAuthenticationFailure(c, auth);
  }
  const contract = checkContractOf(auth);

  // Check operation permission
  if (!isOperationAllowed(auth, 'check')) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  // Check rate limit
  const rateLimitCtx: RateLimitContext = {
    limiter: c.env.RATE_LIMITER,
  };
  const rateLimitResult = await checkRateLimitOrUnavailable(auth, rateLimitCtx);
  if (rateLimitResult instanceof Response) {
    return rateLimitResult;
  }

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

  // Get check service (debug details only for server credentials)
  const debugMode = isDebugModeEnabled(c.env) && contract === 'server';
  const services = await getCheckService(c, debugMode);

  try {
    // Parse request body
    const rawBody = await readJsonBody(c);
    if (!isPlainObject(rawBody) || !isTenantIdShape(rawBody.tenant_id)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const body = rawBody as Partial<CheckApiRequest>;

    // Self contract: only the permission (and the token's own subject / tenant)
    if (contract === 'self') {
      const violation = selfContractViolation(rawBody, auth);
      if (violation) {
        log.debug('Self-contract check refused', { field: violation });
        return createErrorResponse(c, AR_ERROR_CODES.POLICY_CHECK_CONTRACT_VIOLATION);
      }
    } else if (!body.subject_id) {
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
    if (!isWellFormedPermission(body.permission)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
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
    const request: CheckApiRequest =
      contract === 'self'
        ? {
            // The token's account (bound server-side), never the body's.
            subject_id: auth.subjectId as string,
            subject_type: 'user',
            permission: body.permission,
            tenant_id: tenantId,
          }
        : {
            subject_id: body.subject_id as string,
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
      contract,
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
  const auth = await authenticateCheckApiRequest(
    c.req.header('Authorization'),
    checkAuthContext(c)
  );

  if (!auth.authenticated) {
    return checkAuthenticationFailure(c, auth);
  }
  const contract = checkContractOf(auth);

  // Check operation permission
  if (!isOperationAllowed(auth, 'batch')) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  // Check rate limit
  const rateLimitCtx: RateLimitContext = {
    limiter: c.env.RATE_LIMITER,
  };
  const rateLimitResult = await checkRateLimitOrUnavailable(auth, rateLimitCtx);
  if (rateLimitResult instanceof Response) {
    return rateLimitResult;
  }

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

  // Get check service (debug details only for server credentials)
  const debugMode = isDebugModeEnabled(c.env) && contract === 'server';
  const services = await getCheckService(c, debugMode);

  try {
    const rawBody = await readJsonBody(c);
    // The envelope: an object with only `checks` and an optional boolean `stop_on_deny`.
    if (
      !isPlainObject(rawBody) ||
      Object.keys(rawBody).some((key) => !BATCH_ENVELOPE_KEYS.has(key)) ||
      (rawBody.stop_on_deny !== undefined && typeof rawBody.stop_on_deny !== 'boolean')
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }
    const body = rawBody as { checks?: CheckApiRequest[]; stop_on_deny?: boolean };

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
      if (!isPlainObject(check) || !isTenantIdShape(check.tenant_id)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
      // Self contract: every check carries only the permission (and the token's own subject)
      if (contract === 'self') {
        const violation = selfContractViolation(check, auth);
        if (violation) {
          log.debug('Self-contract batch check refused', {
            checkIndex: checkIdx,
            field: violation,
          });
          return createErrorResponse(c, AR_ERROR_CODES.POLICY_CHECK_CONTRACT_VIOLATION);
        }
        if (!check.permission) {
          return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
        }
      } else if (!check.subject_id || !check.permission) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }

      if (!isWellFormedPermission(check.permission)) {
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
      normalizedChecks.push(
        contract === 'self'
          ? {
              // The token's account (bound server-side), never the body's.
              subject_id: auth.subjectId as string,
              subject_type: 'user',
              permission: check.permission,
              tenant_id: tenantId,
            }
          : {
              ...check,
              subject_type: check.subject_type ?? 'user',
              tenant_id: tenantId,
            }
      );
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
        contract,
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

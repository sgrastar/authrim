/**
 * Policy Service Worker
 *
 * Separate Worker for policy evaluation.
 * Provides REST API for access control decisions.
 *
 * Phase 1: Role-based access control with scoped roles.
 * Phase 2: ReBAC (Relationship-Based Access Control) with Zanzibar-style check API.
 * Phase 8.3: Unified Check API (Real-time permission checking)
 *
 * Routes handled by this worker (via Cloudflare custom domain routes):
 * - /policy/* - Policy evaluation endpoints
 * - /api/rebac/* - ReBAC relationship endpoints
 * - /api/check/* - Unified Check API endpoints (Phase 8.3)
 *
 * Endpoints:
 * - POST /policy/evaluate - Evaluate policy for a given context
 * - POST /policy/check-role - Quick role check
 * - POST /policy/check-access - Check access for resource/action
 * - GET /policy/health - Health check
 * - GET /policy/flags - Get feature flags status
 * - PUT /policy/flags/:name - Set feature flag override
 * - DELETE /policy/flags/:name - Clear feature flag override
 * - POST /api/rebac/check - ReBAC relationship check
 * - POST /api/rebac/batch-check - Batch ReBAC checks
 * - POST /api/rebac/list-objects - List objects for user
 * - POST /api/rebac/list-users - List users for object
 * - POST /api/rebac/write - Write relationship tuple
 * - DELETE /api/rebac/tuples - Delete relationship tuple
 * - GET /api/rebac/health - ReBAC health check
 * - POST /api/check - Unified permission check (Phase 8.3)
 * - POST /api/check/batch - Batch permission check (Phase 8.3)
 * - GET /api/check/health - Check API health (Phase 8.3)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env as SharedEnv, IStorageAdapter } from '@authrim/ar-lib-core';
import {
  versionCheckMiddleware,
  requestContextMiddleware,
  pluginContextMiddleware,
  createReBACService,
  timingSafeEqual,
  D1Adapter,
  createPermissionChangeNotifier,
  createPermissionChangeEvent,
  createErrorResponse,
  AR_ERROR_CODES,
  getLogger,
  type DatabaseAdapter,
  type ReBACService,
  type CheckRequest,
  type BatchCheckRequest,
  type ListObjectsRequest,
  type ListUsersRequest,
  type ReBACConfig,
  type PermissionChangeNotifier,
} from '@authrim/ar-lib-core';
import {
  createDefaultPolicyEngine,
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin,
  subjectFromClaims,
  createFeatureFlagsManager,
  type PolicyContext,
  type PolicySubject,
  type SubjectRole,
  type FeatureFlagsManager,
  type KVNamespace,
} from '@authrim/ar-lib-policy';
import { checkRoutes } from './routes/check';
import { subscribeRoutes } from './routes/subscribe';

/**
 * Environment bindings for Policy Service
 */
interface Env extends SharedEnv {
  /** Internal API secret for service-to-service auth */
  POLICY_API_SECRET: string;

  /** KV namespace for feature flags (optional) */
  POLICY_FLAGS_KV?: KVNamespace;

  /** KV namespace for ReBAC caching (optional) */
  REBAC_CACHE_KV?: KVNamespace;

  /** Feature flag environment variables */
  ENABLE_ABAC?: string;
  ENABLE_REBAC?: string;
  ENABLE_POLICY_LOGGING?: string;
  ENABLE_VERIFIED_ATTRIBUTES?: string;
  ENABLE_CUSTOM_RULES?: string;
}

// Create main Hono app
const app = new Hono<{ Bindings: Env }>();

// Create sub-apps for different route prefixes
const policyRoutes = new Hono<{ Bindings: Env }>();
const rebacRoutes = new Hono<{ Bindings: Env }>();

// Create default policy engine
const policyEngine = createDefaultPolicyEngine();

// Global middleware
app.use('*', logger());
app.use('*', versionCheckMiddleware('ar-policy'));
app.use('*', requestContextMiddleware());
app.use('*', pluginContextMiddleware());
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
    },
  })
);
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);

/**
 * Authenticate internal service requests
 * Requires Bearer token matching POLICY_API_SECRET
 */
function authenticateRequest(c: {
  req: { header: (name: string) => string | undefined };
  env: Env;
}): boolean {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice(7);
  // Use timing-safe comparison to prevent timing attacks
  return !!c.env.POLICY_API_SECRET && timingSafeEqual(token, c.env.POLICY_API_SECRET);
}

// ============================================================
// Policy Routes (/policy/*)
// ============================================================

/**
 * Get feature flags manager for current request
 */
function getFeatureFlagsManager(env: Env): FeatureFlagsManager {
  return createFeatureFlagsManager(
    {
      ENABLE_ABAC: env.ENABLE_ABAC,
      ENABLE_REBAC: env.ENABLE_REBAC,
      ENABLE_POLICY_LOGGING: env.ENABLE_POLICY_LOGGING,
      ENABLE_VERIFIED_ATTRIBUTES: env.ENABLE_VERIFIED_ATTRIBUTES,
      ENABLE_CUSTOM_RULES: env.ENABLE_CUSTOM_RULES,
    },
    env.POLICY_FLAGS_KV ?? null
  );
}

/**
 * Health check endpoint
 * GET /policy/health
 */
policyRoutes.get('/health', async (c) => {
  const flagsManager = getFeatureFlagsManager(c.env);
  const flags = await flagsManager.getAllFlags();

  return c.json({
    status: 'ok',
    service: 'ar-policy',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    features: {
      abac: flags.ENABLE_ABAC,
      rebac: flags.ENABLE_REBAC,
      logging: flags.ENABLE_POLICY_LOGGING,
      verifiedAttributes: flags.ENABLE_VERIFIED_ATTRIBUTES,
      customRules: flags.ENABLE_CUSTOM_RULES,
    },
  });
});

/**
 * Get feature flags with sources (for debugging/admin)
 * GET /policy/flags
 */
policyRoutes.get('/flags', async (c) => {
  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  const flagsManager = getFeatureFlagsManager(c.env);
  const sources = await flagsManager.getFlagSources();

  return c.json({
    flags: sources,
    kvEnabled: !!c.env.POLICY_FLAGS_KV,
  });
});

/**
 * Set a feature flag override (requires KV)
 * PUT /policy/flags/:name
 */
policyRoutes.put('/flags/:name', async (c) => {
  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  const name = c.req.param('name');
  const validNames = [
    'ENABLE_ABAC',
    'ENABLE_REBAC',
    'ENABLE_POLICY_LOGGING',
    'ENABLE_VERIFIED_ATTRIBUTES',
    'ENABLE_CUSTOM_RULES',
  ];

  if (!validNames.includes(name)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  try {
    const body = await c.req.json<{ value: boolean }>();
    if (typeof body.value !== 'boolean') {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const flagsManager = getFeatureFlagsManager(c.env);
    await flagsManager.setFlag(name as 'ENABLE_ABAC', body.value);

    return c.json({
      success: true,
      flag: name,
      value: body.value,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('KV not configured')) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    throw error;
  }
});

/**
 * Clear a feature flag override (revert to env/default)
 * DELETE /policy/flags/:name
 */
policyRoutes.delete('/flags/:name', async (c) => {
  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  const name = c.req.param('name');
  const validNames = [
    'ENABLE_ABAC',
    'ENABLE_REBAC',
    'ENABLE_POLICY_LOGGING',
    'ENABLE_VERIFIED_ATTRIBUTES',
    'ENABLE_CUSTOM_RULES',
  ];

  if (!validNames.includes(name)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }

  try {
    const flagsManager = getFeatureFlagsManager(c.env);
    await flagsManager.clearFlag(name as 'ENABLE_ABAC');

    return c.json({
      success: true,
      flag: name,
      message: 'Flag override cleared. Now using environment/default value.',
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('KV not configured')) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
    throw error;
  }
});

/**
 * Evaluate policy for a given context
 * POST /policy/evaluate
 */
policyRoutes.post('/evaluate', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('POLICY');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  try {
    const body = await c.req.json<PolicyContext>();

    if (!body.subject || !body.resource || !body.action) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const context: PolicyContext = {
      ...body,
      timestamp: body.timestamp || Date.now(),
    };

    const decision = policyEngine.evaluate(context);
    return c.json(decision);
  } catch (error) {
    log.error('Policy evaluation error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Quick role check endpoint
 * POST /policy/check-role
 */
policyRoutes.post('/check-role', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('POLICY');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  try {
    const body = await c.req.json<{
      subject?: PolicySubject | { claims: Record<string, unknown> };
      role?: string;
      roles?: string[];
      mode?: 'any' | 'all';
      scope?: string;
      scopeTarget?: string;
    }>();

    if (!body.subject) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'subject' },
      });
    }

    let subject: PolicySubject;
    if ('claims' in body.subject) {
      subject = subjectFromClaims(body.subject.claims as Record<string, unknown>);
    } else {
      subject = body.subject;
    }

    const options = {
      scope: body.scope,
      scopeTarget: body.scopeTarget,
    };

    let hasRequiredRole = false;

    if (body.role) {
      hasRequiredRole = hasRole(subject, body.role, options);
    } else if (body.roles && body.roles.length > 0) {
      if (body.mode === 'all') {
        hasRequiredRole = hasAllRoles(subject, body.roles, options);
      } else {
        hasRequiredRole = hasAnyRole(subject, body.roles, options);
      }
    } else {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const activeRoles = subject.roles
      .filter((r) => !r.expiresAt || r.expiresAt > Date.now())
      .map((r) => r.name);

    return c.json({
      hasRole: hasRequiredRole,
      activeRoles: [...new Set(activeRoles)],
    });
  } catch (error) {
    log.error('Role check error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Check access for resource/action
 * POST /policy/check-access
 */
policyRoutes.post('/check-access', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('POLICY');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  try {
    const body = await c.req.json<{
      subjectId?: string;
      claims?: Record<string, unknown>;
      roles?: SubjectRole[];
      resourceType: string;
      resourceId: string;
      resourceOwnerId?: string;
      resourceOrgId?: string;
      action: string;
      operation?: string;
    }>();

    if (!body.resourceType || !body.resourceId || !body.action) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    let subject: PolicySubject;
    if (body.claims) {
      subject = subjectFromClaims(body.claims);
      if (body.subjectId) {
        subject.id = body.subjectId;
      }
    } else if (body.roles) {
      subject = {
        id: body.subjectId || '',
        roles: body.roles,
      };
    } else {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const context: PolicyContext = {
      subject,
      resource: {
        type: body.resourceType,
        id: body.resourceId,
        ownerId: body.resourceOwnerId,
        orgId: body.resourceOrgId,
      },
      action: {
        name: body.action,
        operation: body.operation,
      },
      timestamp: Date.now(),
    };

    const decision = policyEngine.evaluate(context);

    return c.json({
      allowed: decision.allowed,
      reason: decision.reason,
    });
  } catch (error) {
    log.error('Access check error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Check if subject is an admin
 * POST /policy/is-admin
 */
policyRoutes.post('/is-admin', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('POLICY');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  try {
    const body = await c.req.json<{
      claims?: Record<string, unknown>;
      roles?: string[];
    }>();

    let subject: PolicySubject;

    if (body.claims) {
      subject = subjectFromClaims(body.claims);
    } else if (body.roles) {
      subject = {
        id: '',
        roles: body.roles.map((name) => ({ name, scope: 'global' as const })),
      };
    } else {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    return c.json({
      isAdmin: isAdmin(subject),
    });
  } catch (error) {
    log.error('Admin check error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

// ============================================================
// ReBAC Routes (/api/rebac/*)
// ============================================================

/**
 * Simple D1 Storage Adapter for ReBAC
 * Implements only the query() and execute() methods needed by ReBACService
 */
class D1StorageAdapter implements IStorageAdapter {
  constructor(private db: D1Database) {}

  async get(_key: string): Promise<string | null> {
    // Not used by ReBACService
    return null;
  }

  async set(_key: string, _value: string, _ttl?: number): Promise<void> {
    // Not used by ReBACService
  }

  async delete(_key: string): Promise<void> {
    // Not used by ReBACService
  }

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

/**
 * Get or create ReBACService instance for request
 * ReBAC requires D1 database binding
 */
function getReBACService(env: Env): ReBACService | null {
  if (!env.DB) {
    return null;
  }

  const adapter = new D1StorageAdapter(env.DB);
  // ReBACConfig uses Cloudflare Workers' global KVNamespace type
  // Use type assertion to bypass incompatibility between KVNamespace versions
  const config: ReBACConfig = {
    cache_namespace: env.REBAC_CACHE_KV as unknown as ReBACConfig['cache_namespace'],
    cache_ttl: 60,
    max_depth: 5,
  };

  return createReBACService(adapter, config);
}

/**
 * Get or create PermissionChangeNotifier instance for request
 * Phase 8.3: Used to publish permission change events
 */
function getPermissionChangeNotifier(env: Env): PermissionChangeNotifier {
  return createPermissionChangeNotifier({
    db: env.DB,
    // Cast to satisfy type compatibility between policy-core KVNamespace and Cloudflare Workers KVNamespace
    cache: env.REBAC_CACHE_KV as unknown as globalThis.KVNamespace | undefined,
    permissionChangeHub: env.PERMISSION_CHANGE_HUB,
    debug: false,
  });
}

/**
 * ReBAC health check
 * GET /api/rebac/health
 */
rebacRoutes.get('/health', async (c) => {
  const flagsManager = getFeatureFlagsManager(c.env);
  const rebacEnabled = await flagsManager.getFlag('ENABLE_REBAC');
  const hasDatabase = !!c.env.DB;
  const hasCache = !!c.env.REBAC_CACHE_KV;

  return c.json({
    status: rebacEnabled && hasDatabase ? 'ok' : 'limited',
    service: 'ar-policy-rebac',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    enabled: rebacEnabled,
    database: hasDatabase,
    cache: hasCache,
  });
});

/**
 * Check relationship (ReBAC)
 * POST /api/rebac/check
 *
 * Request body:
 * {
 *   "tenant_id": "tenant_123",  // optional, uses DEFAULT_TENANT_ID if not provided
 *   "user_id": "user:user_123",
 *   "relation": "viewer",
 *   "object": "document:doc_456"
 * }
 */
rebacRoutes.post('/check', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('REBAC');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check if ReBAC is enabled
  const flagsManager = getFeatureFlagsManager(c.env);
  const rebacEnabled = await flagsManager.getFlag('ENABLE_REBAC');
  if (!rebacEnabled) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  const rebacService = getReBACService(c.env);
  if (!rebacService) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    const body = await c.req.json<{
      tenant_id?: string;
      user_id: string;
      relation: string;
      object: string;
      object_type?: string;
    }>();

    if (!body.user_id || !body.relation || !body.object) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const request: CheckRequest = {
      tenant_id: body.tenant_id || c.env.DEFAULT_TENANT_ID || 'default',
      user_id: body.user_id,
      relation: body.relation,
      object: body.object,
      object_type: body.object_type,
    };

    const result = await rebacService.check(request);
    return c.json(result);
  } catch (error) {
    log.error('ReBAC check error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Batch check relationships (ReBAC)
 * POST /api/rebac/batch-check
 *
 * Request body:
 * {
 *   "checks": [
 *     { "tenant_id": "t1", "user_id": "u1", "relation": "viewer", "object": "doc:1" },
 *     { "tenant_id": "t1", "user_id": "u1", "relation": "editor", "object": "doc:2" }
 *   ]
 * }
 */
rebacRoutes.post('/batch-check', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('REBAC');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check if ReBAC is enabled
  const flagsManager = getFeatureFlagsManager(c.env);
  const rebacEnabled = await flagsManager.getFlag('ENABLE_REBAC');
  if (!rebacEnabled) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  const rebacService = getReBACService(c.env);
  if (!rebacService) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    const body = await c.req.json<{ checks: CheckRequest[] }>();

    if (!body.checks || !Array.isArray(body.checks) || body.checks.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'checks' },
      });
    }

    // Limit batch size
    if (body.checks.length > 100) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const defaultTenantId = c.env.DEFAULT_TENANT_ID || 'default';
    const request: BatchCheckRequest = {
      checks: body.checks.map((check) => ({
        ...check,
        tenant_id: check.tenant_id || defaultTenantId,
      })),
    };

    const result = await rebacService.batchCheck(request);
    return c.json(result);
  } catch (error) {
    log.error('ReBAC batch check error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * List objects user has access to
 * POST /api/rebac/list-objects
 *
 * Request body:
 * {
 *   "tenant_id": "tenant_123",
 *   "user_id": "user:user_123",
 *   "relation": "viewer",
 *   "object_type": "document",
 *   "limit": 100,
 *   "cursor": "next_page_cursor"
 * }
 */
rebacRoutes.post('/list-objects', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('REBAC');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check if ReBAC is enabled
  const flagsManager = getFeatureFlagsManager(c.env);
  const rebacEnabled = await flagsManager.getFlag('ENABLE_REBAC');
  if (!rebacEnabled) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  const rebacService = getReBACService(c.env);
  if (!rebacService) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    const body = await c.req.json<ListObjectsRequest>();

    if (!body.user_id || !body.relation || !body.object_type) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const request: ListObjectsRequest = {
      tenant_id: body.tenant_id || c.env.DEFAULT_TENANT_ID || 'default',
      user_id: body.user_id,
      relation: body.relation,
      object_type: body.object_type,
      limit: Math.min(body.limit || 100, 1000),
      cursor: body.cursor,
    };

    const result = await rebacService.listObjects(request);
    return c.json(result);
  } catch (error) {
    log.error('ReBAC list objects error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * List users with access to an object
 * POST /api/rebac/list-users
 *
 * Request body:
 * {
 *   "tenant_id": "tenant_123",
 *   "object": "document:doc_456",
 *   "relation": "viewer",
 *   "limit": 100
 * }
 */
rebacRoutes.post('/list-users', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('REBAC');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check if ReBAC is enabled
  const flagsManager = getFeatureFlagsManager(c.env);
  const rebacEnabled = await flagsManager.getFlag('ENABLE_REBAC');
  if (!rebacEnabled) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  const rebacService = getReBACService(c.env);
  if (!rebacService) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    const body = await c.req.json<ListUsersRequest>();

    if (!body.object || !body.relation) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const request: ListUsersRequest = {
      tenant_id: body.tenant_id || c.env.DEFAULT_TENANT_ID || 'default',
      object: body.object,
      object_type: body.object_type,
      relation: body.relation,
      limit: Math.min(body.limit || 100, 1000),
      cursor: body.cursor,
    };

    const result = await rebacService.listUsers(request);
    return c.json(result);
  } catch (error) {
    log.error('ReBAC list users error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Write a relationship tuple
 * POST /api/rebac/write
 *
 * Request body:
 * {
 *   "tenant_id": "tenant_123",
 *   "object_type": "document",
 *   "object_id": "doc_456",
 *   "relation": "viewer",
 *   "subject_type": "user",
 *   "subject_id": "user_123",
 *   "expires_at": 1735689600  // optional, Unix timestamp
 * }
 */
rebacRoutes.post('/write', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('REBAC');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check if ReBAC is enabled
  const flagsManager = getFeatureFlagsManager(c.env);
  const rebacEnabled = await flagsManager.getFlag('ENABLE_REBAC');
  if (!rebacEnabled) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  if (!c.env.DB) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    const body = await c.req.json<{
      tenant_id?: string;
      object_type: string;
      object_id: string;
      relation: string;
      subject_type: string;
      subject_id: string;
      expires_at?: number;
    }>();

    if (
      !body.object_type ||
      !body.object_id ||
      !body.relation ||
      !body.subject_type ||
      !body.subject_id
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const tenantId = body.tenant_id || c.env.DEFAULT_TENANT_ID || 'default';
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();

    // Insert relationship tuple
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    await coreAdapter.execute(
      `INSERT INTO relationships (
        id, tenant_id, relationship_type, from_type, from_id,
        to_type, to_id, permission_level, expires_at, is_bidirectional,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, from_type, from_id, to_type, to_id, relationship_type)
      DO UPDATE SET expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [
        id,
        tenantId,
        body.relation,
        body.subject_type,
        body.subject_id,
        body.object_type,
        body.object_id,
        'full', // default permission level
        body.expires_at ?? null,
        0, // not bidirectional
        now,
        now,
      ]
    );

    // Invalidate cache for the affected object
    const rebacService = getReBACService(c.env);
    if (rebacService) {
      await rebacService.invalidateCache(tenantId, body.object_type, body.object_id, body.relation);
    }

    // Phase 8.3: Publish permission change event
    try {
      const notifier = getPermissionChangeNotifier(c.env);
      await notifier.publish(
        createPermissionChangeEvent('grant', tenantId, body.subject_id, {
          resource: `${body.object_type}:${body.object_id}`,
          relation: body.relation,
        })
      );
    } catch (notifyError) {
      // Log but don't fail the request if notification fails
      log.warn('Permission change notification failed', { error: String(notifyError) });
    }

    return c.json({
      success: true,
      tuple: {
        id,
        tenant_id: tenantId,
        object_type: body.object_type,
        object_id: body.object_id,
        relation: body.relation,
        subject_type: body.subject_type,
        subject_id: body.subject_id,
        expires_at: body.expires_at,
        created_at: now,
      },
    });
  } catch (error) {
    log.error('ReBAC write error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Delete a relationship tuple
 * DELETE /api/rebac/tuples
 *
 * Request body:
 * {
 *   "tenant_id": "tenant_123",
 *   "object_type": "document",
 *   "object_id": "doc_456",
 *   "relation": "viewer",
 *   "subject_type": "user",
 *   "subject_id": "user_123"
 * }
 */
rebacRoutes.delete('/tuples', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('REBAC');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  // Check if ReBAC is enabled
  const flagsManager = getFeatureFlagsManager(c.env);
  const rebacEnabled = await flagsManager.getFlag('ENABLE_REBAC');
  if (!rebacEnabled) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }

  if (!c.env.DB) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    const body = await c.req.json<{
      tenant_id?: string;
      object_type: string;
      object_id: string;
      relation: string;
      subject_type: string;
      subject_id: string;
    }>();

    if (
      !body.object_type ||
      !body.object_id ||
      !body.relation ||
      !body.subject_type ||
      !body.subject_id
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const tenantId = body.tenant_id || c.env.DEFAULT_TENANT_ID || 'default';

    // Delete relationship tuple
    const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });
    const result = await coreAdapter.execute(
      `DELETE FROM relationships
       WHERE tenant_id = ?
         AND from_type = ?
         AND from_id = ?
         AND to_type = ?
         AND to_id = ?
         AND relationship_type = ?`,
      [
        tenantId,
        body.subject_type,
        body.subject_id,
        body.object_type,
        body.object_id,
        body.relation,
      ]
    );

    // Invalidate cache for the affected object
    const rebacService = getReBACService(c.env);
    if (rebacService) {
      await rebacService.invalidateCache(tenantId, body.object_type, body.object_id, body.relation);
    }

    // Phase 8.3: Publish permission change event (only if something was deleted)
    const deleted = (result.rowsAffected ?? 0) > 0;
    if (deleted) {
      try {
        const notifier = getPermissionChangeNotifier(c.env);
        await notifier.publish(
          createPermissionChangeEvent('revoke', tenantId, body.subject_id, {
            resource: `${body.object_type}:${body.object_id}`,
            relation: body.relation,
          })
        );
      } catch (notifyError) {
        // Log but don't fail the request if notification fails
        log.warn('Permission change notification failed', { error: String(notifyError) });
      }
    }

    return c.json({
      success: true,
      deleted,
    });
  } catch (error) {
    log.error('ReBAC delete error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Invalidate cache for user or object
 * POST /api/rebac/invalidate
 *
 * Request body:
 * {
 *   "tenant_id": "tenant_123",
 *   "type": "user" | "object",
 *   "object_type": "document",  // for type=object
 *   "object_id": "doc_456",     // for type=object
 *   "user_id": "user_123"       // for type=user
 * }
 */
rebacRoutes.post('/invalidate', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('REBAC');

  if (!authenticateRequest(c)) {
    return createErrorResponse(c, AR_ERROR_CODES.AUTH_LOGIN_REQUIRED);
  }

  const rebacService = getReBACService(c.env);
  if (!rebacService) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }

  try {
    const body = await c.req.json<{
      tenant_id?: string;
      type: 'user' | 'object';
      object_type?: string;
      object_id?: string;
      user_id?: string;
    }>();

    const tenantId = body.tenant_id || c.env.DEFAULT_TENANT_ID || 'default';

    if (body.type === 'user') {
      if (!body.user_id) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'user_id' },
        });
      }
      await rebacService.invalidateUserCache(tenantId, body.user_id);
    } else if (body.type === 'object') {
      if (!body.object_type || !body.object_id) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
      }
      await rebacService.invalidateCache(tenantId, body.object_type, body.object_id);
    } else {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('ReBAC invalidate error', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

// ============================================================
// Mount sub-apps to main app
// ============================================================

// Mount policy routes at /api/policy/* (for custom domain routes)
app.route('/api/policy', policyRoutes);

// Mount ReBAC routes at /api/rebac/* (for custom domain routes)
app.route('/api/rebac', rebacRoutes);

// Mount Check API routes at /api/check/* (Phase 8.3)
app.route('/api/check', checkRoutes);

// Mount WebSocket Subscribe routes at /api/check/* (Phase 8.3)
// These routes are under /api/check to share the same base path
app.route('/api/check', subscribeRoutes);

// Also mount at root for workers.dev access via router (Service Bindings)
// When accessed via router, the path comes without /api/policy prefix
app.route('/', policyRoutes);

// ============================================================
// Error handlers
// ============================================================

// 404 handler
app.notFound((c) => {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
});

// Error handler
app.onError((err, c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = getLogger(c as any).module('POLICY');
  log.error('Unhandled error', { error: String(err) }, err);
  return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
});

export default app;

/**
 * Policy Service Worker
 *
 * Separate Worker for policy evaluation.
 * Provides REST API for access control decisions.
 *
 * Phase 1: Role-based access control with scoped roles.
 *
 * Routes handled by this worker (via Cloudflare custom domain routes):
 * - /policy/* - Policy evaluation endpoints
 * - /api/rebac/* - ReBAC relationship endpoints
 *
 * Endpoints:
 * - POST /policy/evaluate - Evaluate policy for a given context
 * - POST /policy/check-role - Quick role check
 * - POST /policy/check-access - Check access for resource/action
 * - GET /policy/health - Health check
 * - POST /api/rebac/check - ReBAC relationship check
 * - GET /api/rebac/health - ReBAC health check
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env as SharedEnv } from '@authrim/shared';
import { versionCheckMiddleware } from '@authrim/shared';
import {
  createDefaultPolicyEngine,
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin,
  subjectFromClaims,
  type PolicyContext,
  type PolicySubject,
  type SubjectRole,
} from '@authrim/policy-core';

/**
 * Environment bindings for Policy Service
 */
interface Env extends SharedEnv {
  /** Internal API secret for service-to-service auth */
  POLICY_API_SECRET: string;
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
app.use('*', versionCheckMiddleware('policy-service'));
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
  return token === c.env.POLICY_API_SECRET;
}

// ============================================================
// Policy Routes (/policy/*)
// ============================================================

/**
 * Health check endpoint
 * GET /policy/health
 */
policyRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'policy-service',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Evaluate policy for a given context
 * POST /policy/evaluate
 */
policyRoutes.post('/evaluate', async (c) => {
  if (!authenticateRequest(c)) {
    return c.json(
      {
        error: 'unauthorized',
        error_description: 'Valid Bearer token required',
      },
      401
    );
  }

  try {
    const body = await c.req.json<PolicyContext>();

    if (!body.subject || !body.resource || !body.action) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'subject, resource, and action are required',
        },
        400
      );
    }

    const context: PolicyContext = {
      ...body,
      timestamp: body.timestamp || Date.now(),
    };

    const decision = policyEngine.evaluate(context);
    return c.json(decision);
  } catch (error) {
    console.error('Policy evaluation error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to evaluate policy',
      },
      500
    );
  }
});

/**
 * Quick role check endpoint
 * POST /policy/check-role
 */
policyRoutes.post('/check-role', async (c) => {
  if (!authenticateRequest(c)) {
    return c.json(
      {
        error: 'unauthorized',
        error_description: 'Valid Bearer token required',
      },
      401
    );
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'subject is required',
        },
        400
      );
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Either role or roles is required',
        },
        400
      );
    }

    const activeRoles = subject.roles
      .filter((r) => !r.expiresAt || r.expiresAt > Date.now())
      .map((r) => r.name);

    return c.json({
      hasRole: hasRequiredRole,
      activeRoles: [...new Set(activeRoles)],
    });
  } catch (error) {
    console.error('Role check error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check role',
      },
      500
    );
  }
});

/**
 * Check access for resource/action
 * POST /policy/check-access
 */
policyRoutes.post('/check-access', async (c) => {
  if (!authenticateRequest(c)) {
    return c.json(
      {
        error: 'unauthorized',
        error_description: 'Valid Bearer token required',
      },
      401
    );
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'resourceType, resourceId, and action are required',
        },
        400
      );
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Either claims or roles is required',
        },
        400
      );
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
    console.error('Access check error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check access',
      },
      500
    );
  }
});

/**
 * Check if subject is an admin
 * POST /policy/is-admin
 */
policyRoutes.post('/is-admin', async (c) => {
  if (!authenticateRequest(c)) {
    return c.json(
      {
        error: 'unauthorized',
        error_description: 'Valid Bearer token required',
      },
      401
    );
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
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Either claims or roles is required',
        },
        400
      );
    }

    return c.json({
      isAdmin: isAdmin(subject),
    });
  } catch (error) {
    console.error('Admin check error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check admin status',
      },
      500
    );
  }
});

// ============================================================
// ReBAC Routes (/api/rebac/*)
// ============================================================

/**
 * ReBAC health check
 * GET /api/rebac/health
 */
rebacRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'rebac-service',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Check relationship (ReBAC)
 * POST /api/rebac/check
 *
 * Request body:
 * {
 *   "subject": "user:user_123",
 *   "relation": "viewer",
 *   "object": "document:doc_456"
 * }
 */
rebacRoutes.post('/check', async (c) => {
  if (!authenticateRequest(c)) {
    return c.json(
      {
        error: 'unauthorized',
        error_description: 'Valid Bearer token required',
      },
      401
    );
  }

  try {
    const body = await c.req.json<{
      subject: string;
      relation: string;
      object: string;
    }>();

    if (!body.subject || !body.relation || !body.object) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'subject, relation, and object are required',
        },
        400
      );
    }

    // TODO: Implement actual ReBAC check using D1 database
    // For now, return a placeholder response
    return c.json({
      allowed: false,
      reason: 'ReBAC check not yet implemented - use policy endpoints',
    });
  } catch (error) {
    console.error('ReBAC check error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check relationship',
      },
      500
    );
  }
});

// ============================================================
// Mount sub-apps to main app
// ============================================================

// Mount policy routes at /policy/* (for custom domain routes)
app.route('/policy', policyRoutes);

// Mount ReBAC routes at /api/rebac/* (for custom domain routes)
app.route('/api/rebac', rebacRoutes);

// Also mount at root for workers.dev access via router (Service Bindings)
// When accessed via router, the path comes without /policy prefix
app.route('/', policyRoutes);

// ============================================================
// Error handlers
// ============================================================

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: 'not_found',
      error_description: 'The requested resource was not found',
      path: c.req.path,
    },
    404
  );
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json(
    {
      error: 'internal_server_error',
      error_description: 'An unexpected error occurred',
    },
    500
  );
});

export default app;

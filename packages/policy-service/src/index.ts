/**
 * Policy Service Worker
 *
 * Separate Worker for policy evaluation.
 * Provides REST API for access control decisions.
 *
 * Phase 1: Role-based access control with scoped roles.
 *
 * Endpoints:
 * - POST /evaluate - Evaluate policy for a given context
 * - POST /check-role - Quick role check
 * - POST /check-access - Check access for resource/action
 * - GET /health - Health check
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import type { Env as SharedEnv } from '@authrim/shared';
import {
  PolicyEngine,
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

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// Create default policy engine
const policyEngine = createDefaultPolicyEngine();

// Middleware
app.use('*', logger());
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

/**
 * Health check endpoint
 * GET /health
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'policy-service',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Evaluate policy for a given context
 * POST /evaluate
 *
 * Request body:
 * {
 *   "subject": { "id": "...", "roles": [...], ... },
 *   "resource": { "type": "...", "id": "...", ... },
 *   "action": { "name": "..." },
 *   "timestamp": 1234567890
 * }
 *
 * Response:
 * {
 *   "allowed": true,
 *   "reason": "...",
 *   "decidedBy": "..."
 * }
 */
app.post('/evaluate', async (c) => {
  // Authenticate request
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

    // Validate required fields
    if (!body.subject || !body.resource || !body.action) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'subject, resource, and action are required',
        },
        400
      );
    }

    // Ensure timestamp is set
    const context: PolicyContext = {
      ...body,
      timestamp: body.timestamp || Date.now(),
    };

    // Evaluate policy
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
 * POST /check-role
 *
 * Request body:
 * {
 *   "subject": { "roles": [...] } | { "claims": {...} },
 *   "role": "role_name" | "roles": ["role1", "role2"],
 *   "mode": "any" | "all",
 *   "scope": "global",
 *   "scopeTarget": "org:org_123"
 * }
 *
 * Response:
 * {
 *   "hasRole": true,
 *   "activeRoles": ["role1", "role2"]
 * }
 */
app.post('/check-role', async (c) => {
  // Authenticate request
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

    // Convert claims to subject if needed
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
      // Single role check
      hasRequiredRole = hasRole(subject, body.role, options);
    } else if (body.roles && body.roles.length > 0) {
      // Multiple roles check
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

    // Get active role names
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
 * POST /check-access
 *
 * Convenience endpoint that builds a PolicyContext and evaluates.
 *
 * Request body:
 * {
 *   "subjectId": "user_123",
 *   "claims": { "authrim_roles": [...], ... },
 *   "resourceType": "organization",
 *   "resourceId": "org_456",
 *   "resourceOwnerId": "user_789",
 *   "resourceOrgId": "org_456",
 *   "action": "manage"
 * }
 *
 * Response:
 * {
 *   "allowed": true,
 *   "reason": "..."
 * }
 */
app.post('/check-access', async (c) => {
  // Authenticate request
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

    // Validate required fields
    if (!body.resourceType || !body.resourceId || !body.action) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'resourceType, resourceId, and action are required',
        },
        400
      );
    }

    // Build subject from claims or roles
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

    // Build context
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

    // Evaluate policy
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
 * POST /is-admin
 *
 * Request body:
 * {
 *   "claims": { "authrim_roles": [...] }
 * }
 * OR
 * {
 *   "roles": ["role1", "role2"]
 * }
 */
app.post('/is-admin', async (c) => {
  // Authenticate request
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

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: 'not_found',
      error_description: 'The requested resource was not found',
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

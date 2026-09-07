/**
 * Admin Policy API
 *
 * Endpoints for managing Admin access control policies.
 * Policies combine RBAC/ABAC/ReBAC conditions for Admin access control.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  AdminPolicyRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminPolicyConditions,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

// Define context type
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

// Create router
export const adminPoliciesRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

const adminPoliciesAuth = adminAuthMiddleware({
  requirePermissions: [ADMIN_PERMISSIONS.ADMIN_ROLES_READ],
});
adminPoliciesRouter.use('/admin-policies', adminPoliciesAuth);
adminPoliciesRouter.use('/admin-policies/*', adminPoliciesAuth);

/**
 * Helper to get DB_ADMIN adapter
 */
function getAdminAdapter(c: AdminContext) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

/**
 * Helper to check write permission
 */
function hasWritePermission(authContext: AdminAuthContext): boolean {
  const permissions = authContext.permissions || [];
  return hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE);
}

/**
 * Create audit log entry
 */
async function createAuditLog(
  c: AdminContext,
  action: string,
  resourceId: string,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): Promise<void> {
  await writeAdminAuditLog(c, {
    action,
    resourceType: 'admin_policy',
    resourceId,
    result,
    metadata,
  });
}

// =============================================================================
// Policy Endpoints
// =============================================================================

/**
 * GET /api/admin/admin-policies
 * List all Admin policies
 */
adminPoliciesRouter.get('/admin-policies', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const activeOnly = c.req.query('active_only') === 'true';
    const resourcePattern = c.req.query('resource');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    const { policies, total } = await repo.listPolicies(tenantId, {
      activeOnly,
      resourcePattern,
      limit,
      offset,
    });

    return c.json({
      items: policies,
      total,
      limit,
      offset,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-policies/:id
 * Get Admin policy by ID
 */
adminPoliciesRouter.get('/admin-policies/:id', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;

    const policy = await repo.getPolicy(id);
    if (!policy) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (policy.tenant_id !== tenantId && !policy.is_system) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    return c.json(policy);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-policies
 * Create new Admin policy
 */
adminPoliciesRouter.post('/admin-policies', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json<{
      name: string;
      display_name?: string;
      description?: string;
      effect?: 'allow' | 'deny';
      priority?: number;
      resource_pattern: string;
      actions?: string[];
      conditions?: AdminPolicyConditions;
    }>();

    // Validate required fields
    if (!body.name || !body.resource_pattern) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'name and resource_pattern are required',
        },
        400
      );
    }

    // Check for duplicate
    const existing = await repo.getPolicyByName(tenantId, body.name);
    if (existing) {
      return c.json({ error: 'conflict', message: 'Policy with this name already exists' }, 409);
    }

    // Explicit field mapping to prevent Mass Assignment
    const policy = await repo.createPolicy({
      tenant_id: tenantId,
      name: body.name,
      display_name: body.display_name,
      description: body.description,
      effect: body.effect,
      priority: body.priority,
      resource_pattern: body.resource_pattern,
      actions: body.actions,
      conditions: body.conditions,
    });

    await createAuditLog(c, 'admin_policy.create', policy.id, 'success', {
      name: policy.name,
      resource_pattern: policy.resource_pattern,
    });

    return c.json(policy, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /api/admin/admin-policies/:id
 * Update Admin policy
 */
adminPoliciesRouter.patch('/admin-policies/:id', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;

    // Check if policy exists and belongs to this tenant
    const existing = await repo.getPolicy(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    const body = await c.req.json<{
      display_name?: string;
      description?: string;
      effect?: 'allow' | 'deny';
      priority?: number;
      resource_pattern?: string;
      actions?: string[];
      conditions?: AdminPolicyConditions;
    }>();

    // Explicit field mapping to prevent Mass Assignment
    const policy = await repo.updatePolicy(id, {
      display_name: body.display_name,
      description: body.description,
      effect: body.effect,
      priority: body.priority,
      resource_pattern: body.resource_pattern,
      actions: body.actions,
      conditions: body.conditions,
    });

    if (!policy) {
      return c.json({ error: 'not_found', message: 'Policy not found or is system policy' }, 404);
    }

    await createAuditLog(c, 'admin_policy.update', id, 'success', {
      updates: Object.keys(body),
    });

    return c.json(policy);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-policies/:id/activate
 * Activate Admin policy
 */
adminPoliciesRouter.post('/admin-policies/:id/activate', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;

    // Check if policy exists and belongs to this tenant
    const existing = await repo.getPolicy(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    const updated = await repo.setActive(id, true);
    if (!updated) {
      return c.json({ error: 'not_found', message: 'Policy not found or is system policy' }, 404);
    }

    await createAuditLog(c, 'admin_policy.activate', id, 'success');

    const policy = await repo.getPolicy(id);
    return c.json(policy);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-policies/:id/deactivate
 * Deactivate Admin policy
 */
adminPoliciesRouter.post('/admin-policies/:id/deactivate', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;

    // Check if policy exists and belongs to this tenant
    const existing = await repo.getPolicy(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    const updated = await repo.setActive(id, false);
    if (!updated) {
      return c.json({ error: 'not_found', message: 'Policy not found or is system policy' }, 404);
    }

    await createAuditLog(c, 'admin_policy.deactivate', id, 'success');

    const policy = await repo.getPolicy(id);
    return c.json(policy);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admin-policies/:id
 * Delete Admin policy
 */
adminPoliciesRouter.delete('/admin-policies/:id', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;

    // Check if policy exists and belongs to this tenant
    const existing = await repo.getPolicy(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'Policy not found' }, 404);
    }

    const deleted = await repo.deletePolicy(id);
    if (!deleted) {
      return c.json({ error: 'not_found', message: 'Policy not found or is system policy' }, 404);
    }

    await createAuditLog(c, 'admin_policy.delete', id, 'success');

    return c.json({ success: true });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-policies/evaluate
 * Evaluate policies for a resource and action
 */
adminPoliciesRouter.post('/admin-policies/evaluate', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json();

    if (!body.resource || !body.action) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'resource and action are required',
        },
        400
      );
    }

    const policies = await repo.getPoliciesForResource(tenantId, body.resource, body.action);

    // Simple evaluation: return matching policies
    // Full evaluation would check conditions against user context
    return c.json({
      resource: body.resource,
      action: body.action,
      matching_policies: policies.map((p) => ({
        id: p.id,
        name: p.name,
        effect: p.effect,
        priority: p.priority,
        conditions: p.conditions,
      })),
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-policies/simulate
 * Simulate policy evaluation with user context for testing
 */
adminPoliciesRouter.post('/admin-policies/simulate', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminPolicyRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const body = await c.req.json<{
      resource: string;
      action: string;
      admin_user_context: {
        roles?: string[];
        attributes?: Record<string, string | number | boolean>;
        relationships?: Array<{ type: string; target: string }>;
      };
    }>();

    // Validate required fields
    if (!body.resource || !body.action || !body.admin_user_context) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'resource, action, and admin_user_context are required',
        },
        400
      );
    }

    // Get policies matching the resource and action
    const policies = await repo.getPoliciesForResource(tenantId, body.resource, body.action);

    // Evaluate policies
    const evaluations = [];
    let finalDecision: 'allow' | 'deny' | 'no_match' = 'no_match';

    for (const policy of policies) {
      const evaluation = evaluatePolicy(policy, body.admin_user_context);
      evaluations.push({
        policy_id: policy.id,
        policy_name: policy.name,
        matched: evaluation.matched,
        effect: policy.effect,
        priority: policy.priority,
        condition_results: evaluation.conditionResults,
      });

      // Determine final decision (deny takes precedence)
      if (evaluation.matched) {
        if (policy.effect === 'deny') {
          finalDecision = 'deny';
          break; // Deny immediately
        } else if (policy.effect === 'allow' && finalDecision === 'no_match') {
          finalDecision = 'allow';
        }
      }
    }

    return c.json({
      resource: body.resource,
      action: body.action,
      decision: finalDecision,
      evaluations,
      total_policies_evaluated: policies.length,
    });
  } catch (error) {
    console.error('Policy simulation error:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Evaluate a single policy against user context
 * Exported for testing purposes
 */
export function evaluatePolicy(
  policy: {
    conditions: AdminPolicyConditions;
  },
  context: {
    roles?: string[];
    attributes?: Record<string, string | number | boolean>;
    relationships?: Array<{ type: string; target: string }>;
  }
): { matched: boolean; conditionResults: Record<string, boolean> } {
  const conditionResults: Record<string, boolean> = {};
  const conditions = policy.conditions;
  const conditionType = conditions.condition_type || 'all';

  // RBAC: Check roles
  if (conditions.roles && conditions.roles.length > 0) {
    const hasRole = context.roles?.some((role) => conditions.roles?.includes(role)) ?? false;
    conditionResults.roles = hasRole;
  }

  // ABAC: Check attributes
  if (conditions.attributes && Object.keys(conditions.attributes).length > 0) {
    const attributesMatch = Object.entries(conditions.attributes).every(([key, condition]) => {
      const userValue = context.attributes?.[key];
      if (userValue === undefined) return false;

      // Condition evaluation
      if (condition.equals !== undefined) {
        return userValue === condition.equals;
      }
      if (condition.not_equals !== undefined) {
        return userValue !== condition.not_equals;
      }
      if (condition.contains !== undefined && typeof userValue === 'string') {
        return userValue.includes(condition.contains);
      }
      if (
        condition.in !== undefined &&
        (typeof userValue === 'string' || typeof userValue === 'number')
      ) {
        return condition.in.includes(userValue);
      }
      if (condition.gte !== undefined && typeof userValue === 'number') {
        return userValue >= condition.gte;
      }
      if (condition.lte !== undefined && typeof userValue === 'number') {
        return userValue <= condition.lte;
      }
      if (condition.gt !== undefined && typeof userValue === 'number') {
        return userValue > condition.gt;
      }
      if (condition.lt !== undefined && typeof userValue === 'number') {
        return userValue < condition.lt;
      }
      return false;
    });
    conditionResults.attributes = attributesMatch;
  }

  // ReBAC: Check relationships
  if (conditions.relationships && Object.keys(conditions.relationships).length > 0) {
    const relationshipsMatch = Object.keys(conditions.relationships).some((relType) => {
      return context.relationships?.some((rel) => rel.type === relType) ?? false;
    });
    conditionResults.relationships = relationshipsMatch;
  }

  // Determine if policy matches based on condition type
  const conditionValues = Object.values(conditionResults);
  const matched =
    conditionValues.length === 0
      ? false
      : conditionType === 'all'
        ? conditionValues.every((v) => v)
        : conditionValues.some((v) => v);

  return { matched, conditionResults };
}

export default adminPoliciesRouter;

/**
 * Admin Access Control Hub API
 *
 * Endpoints for Admin Access Control Hub statistics.
 * Provides aggregated stats for Admin RBAC, ABAC, ReBAC, and Policies.
 *
 * Requires admin authentication.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';

import {
  AdminRoleRepository,
  AdminRoleAssignmentRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';

// Create router
export const adminAccessControlRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Apply admin authentication to all routes
adminAccessControlRouter.use('*', adminAuthMiddleware({}));

/**
 * Helper to get DB_ADMIN adapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAdminAdapter(c: Context<any, any, any>) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

/**
 * GET /api/admin/admin-access-control/stats
 * Get aggregated statistics for Admin Access Control
 */
adminAccessControlRouter.get('/stats', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const tenantId = getTenantIdFromContext(c);

    // RBAC Stats
    const roleRepo = new AdminRoleRepository(adapter);

    const roles = await roleRepo.getRolesByTenant(tenantId);

    // Count role assignments
    const assignmentsCountResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_role_assignments WHERE tenant_id = ?',
      [tenantId]
    );
    const totalAssignments = assignmentsCountResult[0]?.count || 0;

    // ABAC Stats
    // Get total number of attribute definitions
    const attributeCountResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_attributes WHERE tenant_id = ? OR is_system = 1',
      [tenantId]
    );
    const totalAttributes = attributeCountResult[0]?.count || 0;

    // Get total number of active attribute values (non-expired)
    const activeAttributesResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM admin_attribute_values
			WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, Date.now()]
    );
    const activeAttributes = activeAttributesResult[0]?.count || 0;

    // ReBAC Stats
    // Get total number of ReBAC definitions
    const definitionsCountResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_rebac_definitions WHERE tenant_id = ? OR is_system = 1',
      [tenantId]
    );
    const totalDefinitions = definitionsCountResult[0]?.count || 0;

    // Get total number of relationship tuples (active, non-expired)
    const tuplesCountResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM admin_relationships
			WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, Date.now()]
    );
    const totalTuples = tuplesCountResult[0]?.count || 0;

    // Policy Stats
    // Get total number of policies
    const policiesCountResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_policies WHERE tenant_id = ?',
      [tenantId]
    );
    const totalPolicies = policiesCountResult[0]?.count || 0;

    // Get total number of active policies
    const activePoliciesResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM admin_policies WHERE tenant_id = ? AND is_active = 1',
      [tenantId]
    );
    const activePolicies = activePoliciesResult[0]?.count || 0;

    return c.json({
      rbac: {
        total_roles: roles.length,
        total_assignments: totalAssignments,
      },
      abac: {
        total_attributes: totalAttributes,
        active_attributes: activeAttributes,
      },
      rebac: {
        total_definitions: totalDefinitions,
        total_tuples: totalTuples,
      },
      policies: {
        total_policies: totalPolicies,
        active_policies: activePolicies,
      },
    });
  } catch (error) {
    console.error('Failed to fetch admin access control stats:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * Admin Role Management API
 *
 * Endpoints for managing Admin roles (stored in DB_ADMIN).
 * Includes role definitions and permission management.
 *
 * Requires super_admin role or admin:admin_roles:* permission.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';

// Define context type with adminAuth variable
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
import {
  D1Adapter,
  AdminRoleRepository,
  AdminRoleAssignmentRepository,
  AdminAuditLogRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
} from '@authrim/ar-lib-core';

// Create router
export const adminRolesRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Apply admin authentication to all routes
adminRolesRouter.use(
  '*',
  adminAuthMiddleware({
    requirePermissions: [ADMIN_PERMISSIONS.ADMIN_ROLES_READ],
  })
);

/**
 * Helper to get DB_ADMIN adapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAdminAdapter(c: Context<any, any, any>) {
  if (!c.env.DB_ADMIN) {
    throw new Error('DB_ADMIN is not configured');
  }
  return new D1Adapter({ db: c.env.DB_ADMIN });
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createAuditLog(
  c: Context<any, any, any>,
  action: string,
  resourceId: string,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): Promise<void> {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const adapter = getAdminAdapter(c);
  const auditRepo = new AdminAuditLogRepository(adapter);
  const tenantId = getTenantIdFromContext(c);

  await auditRepo.createAuditLog({
    tenant_id: tenantId,
    admin_user_id: authContext.userId,
    admin_email: authContext.email,
    action,
    resource_type: 'admin_role',
    resource_id: resourceId,
    result,
    ip_address: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
    user_agent: c.req.header('user-agent') || undefined,
    metadata,
  });
}

/**
 * GET /api/admin/admin-roles
 * List all Admin roles
 */
adminRolesRouter.get('/', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const includeSystem = c.req.query('include_system') !== 'false';

    // Get tenant roles
    const tenantRoles = await roleRepo.getRolesByTenant(tenantId);

    // Get system roles if requested
    let allRoles = tenantRoles;
    if (includeSystem) {
      const systemRoles = await roleRepo.getSystemRoles();
      // Merge, avoiding duplicates
      const tenantRoleIds = new Set(tenantRoles.map((r) => r.id));
      const uniqueSystemRoles = systemRoles.filter((r) => !tenantRoleIds.has(r.id));
      allRoles = [...tenantRoles, ...uniqueSystemRoles];
    }

    // Sort by hierarchy level (highest first)
    allRoles.sort((a, b) => b.hierarchy_level - a.hierarchy_level);

    return c.json({
      items: allRoles,
      total: allRoles.length,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-roles/:id
 * Get Admin role details
 */
adminRolesRouter.get('/:id', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id');

    const role = await roleRepo.getRole(id);
    if (!role) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Tenant boundary check - prevent IDOR (allow system roles for all tenants)
    if (role.tenant_id !== tenantId && !role.is_system) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Get users assigned to this role
    const assignedUsers = await roleAssignmentRepo.getUsersByRole(id);

    return c.json({
      ...role,
      assigned_user_count: assignedUsers.length,
      assigned_user_ids: assignedUsers,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-roles
 * Create a new custom Admin role
 */
adminRolesRouter.post('/', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const body = await c.req.json<{
      name: string;
      display_name?: string;
      description?: string;
      permissions: string[];
      hierarchy_level?: number;
    }>();

    // Validate required fields
    if (!body.name) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    if (!body.permissions || !Array.isArray(body.permissions)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Check if name already exists
    const existing = await roleRepo.findByName(tenantId, body.name);
    if (existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    // Validate hierarchy level - can only create roles with lower hierarchy
    const hierarchyLevel = body.hierarchy_level ?? 0;
    if (authContext.hierarchyLevel !== undefined && hierarchyLevel >= authContext.hierarchyLevel) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    // Validate permissions - can only grant permissions you have
    const myPermissions = authContext.permissions || [];
    if (!hasAdminPermission(myPermissions, '*')) {
      for (const perm of body.permissions) {
        if (!hasAdminPermission(myPermissions, perm)) {
          return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
        }
      }
    }

    const role = await roleRepo.createRole({
      tenant_id: tenantId,
      name: body.name,
      display_name: body.display_name,
      description: body.description,
      permissions: body.permissions,
      hierarchy_level: hierarchyLevel,
      role_type: 'custom',
    });

    // Create audit log
    await createAuditLog(c, 'admin_role.create', role.id, 'success', {
      name: role.name,
      permissions: role.permissions,
    });

    return c.json(role, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /api/admin/admin-roles/:id
 * Update an Admin role
 */
adminRolesRouter.patch('/:id', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id');

    // Check if role exists
    const existing = await roleRepo.getRole(id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Can't update system roles
    if (existing.is_system) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    const body = await c.req.json<{
      display_name?: string;
      description?: string;
      permissions?: string[];
      hierarchy_level?: number;
    }>();

    // Validate permissions if being updated
    if (body.permissions) {
      const myPermissions = authContext.permissions || [];
      if (!hasAdminPermission(myPermissions, '*')) {
        for (const perm of body.permissions) {
          if (!hasAdminPermission(myPermissions, perm)) {
            return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
          }
        }
      }
    }

    // Validate hierarchy level if being updated
    if (body.hierarchy_level !== undefined) {
      if (
        authContext.hierarchyLevel !== undefined &&
        body.hierarchy_level >= authContext.hierarchyLevel
      ) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    }

    const role = await roleRepo.updateRole(id, {
      display_name: body.display_name,
      description: body.description,
      permissions: body.permissions,
      hierarchy_level: body.hierarchy_level,
    });

    if (!role) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Create audit log
    await createAuditLog(c, 'admin_role.update', id, 'success', {
      changes: body,
    });

    return c.json(role);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admin-roles/:id
 * Delete an Admin role
 */
adminRolesRouter.delete('/:id', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id');

    // Check if role exists
    const existing = await roleRepo.getRole(id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Can't delete system or builtin roles
    if (existing.is_system || existing.role_type === 'builtin') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    // Check if role has assignments
    const assignedUsers = await roleAssignmentRepo.getUsersByRole(id);
    if (assignedUsers.length > 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    await roleRepo.deleteRole(id);

    // Create audit log
    await createAuditLog(c, 'admin_role.delete', id, 'success', {
      name: existing.name,
    });

    return c.json({ success: true, message: 'Admin role deleted' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot delete')) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-roles/permissions
 * List all available Admin permissions
 */
adminRolesRouter.get('/permissions/list', async (c) => {
  // Return all available permissions with descriptions
  const permissionsList = [
    { key: '*', description: 'Full access to all admin functions' },
    { key: ADMIN_PERMISSIONS.ADMIN_USERS_READ, description: 'View admin users' },
    { key: ADMIN_PERMISSIONS.ADMIN_USERS_WRITE, description: 'Create and update admin users' },
    { key: ADMIN_PERMISSIONS.ADMIN_USERS_DELETE, description: 'Delete admin users' },
    { key: ADMIN_PERMISSIONS.ADMIN_ROLES_READ, description: 'View admin roles' },
    {
      key: ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
      description: 'Create, update, and delete admin roles',
    },
    { key: ADMIN_PERMISSIONS.ADMIN_AUDIT_READ, description: 'View admin audit logs' },
    { key: ADMIN_PERMISSIONS.IP_ALLOWLIST_READ, description: 'View IP allowlist' },
    { key: ADMIN_PERMISSIONS.IP_ALLOWLIST_WRITE, description: 'Manage IP allowlist' },
    { key: ADMIN_PERMISSIONS.USERS_READ, description: 'View end users' },
    { key: ADMIN_PERMISSIONS.USERS_WRITE, description: 'Create and update end users' },
    { key: ADMIN_PERMISSIONS.USERS_DELETE, description: 'Delete end users' },
    { key: ADMIN_PERMISSIONS.CLIENTS_READ, description: 'View OAuth clients' },
    { key: ADMIN_PERMISSIONS.CLIENTS_WRITE, description: 'Create and update OAuth clients' },
    { key: ADMIN_PERMISSIONS.CLIENTS_DELETE, description: 'Delete OAuth clients' },
    { key: ADMIN_PERMISSIONS.SETTINGS_READ, description: 'View system settings' },
    { key: ADMIN_PERMISSIONS.SETTINGS_WRITE, description: 'Update system settings' },
    { key: ADMIN_PERMISSIONS.SECURITY_READ, description: 'View security settings' },
    { key: ADMIN_PERMISSIONS.SECURITY_WRITE, description: 'Update security settings' },
    { key: ADMIN_PERMISSIONS.AUDIT_READ, description: 'View end user audit logs' },
  ];

  return c.json({
    items: permissionsList,
    total: permissionsList.length,
  });
});

export default adminRolesRouter;

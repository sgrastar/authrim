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
  AdminUserRepository,
  AdminRoleRepository,
  AdminRoleAssignmentRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminRole,
  type AdminRoleAssignmentScopeType,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

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
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
}

/**
 * Helper to check write permission
 */
function hasWritePermission(authContext: AdminAuthContext): boolean {
  const permissions = authContext.permissions || [];
  return hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE);
}

function canAccessRole(role: AdminRole, tenantId: string): boolean {
  return role.tenant_id === tenantId || (role.tenant_id === 'default' && role.is_system);
}

function isPlatformAdminRole(roleName: string | undefined): boolean {
  return roleName === 'super_admin';
}

function mergeAvailableRoles(tenantRoles: AdminRole[], systemRoles: AdminRole[]): AdminRole[] {
  const rolesByName = new Map<string, AdminRole>();

  for (const role of systemRoles) {
    rolesByName.set(role.name, role);
  }

  // Hide legacy tenant-scoped system role copies when a canonical default role exists.
  for (const role of tenantRoles) {
    if (!role.is_system || !rolesByName.has(role.name)) {
      rolesByName.set(role.name, role);
    }
  }

  return Array.from(rolesByName.values()).sort(
    (a, b) => b.hierarchy_level - a.hierarchy_level || a.name.localeCompare(b.name)
  );
}

function normalizeAssignmentScope(
  scopeType: AdminRoleAssignmentScopeType | undefined,
  scopeId: string | undefined,
  tenantId: string
): { scopeType: AdminRoleAssignmentScopeType; scopeId: string | null } | null {
  const normalizedScopeType = scopeType ?? 'tenant';

  // Admin org-scoped assignments are intentionally reserved until Admin resources
  // have target-org enforcement. Use tenant-scoped RBAC plus ABAC attributes for now.
  if (!['global', 'tenant'].includes(normalizedScopeType)) {
    return null;
  }

  if (normalizedScopeType === 'global') {
    return { scopeType: normalizedScopeType, scopeId: null };
  }

  if (normalizedScopeType === 'tenant') {
    const normalizedScopeId = scopeId?.trim() || tenantId;
    if (normalizedScopeId !== tenantId) {
      return null;
    }
    return { scopeType: normalizedScopeType, scopeId: normalizedScopeId };
  }

  return null;
}

async function countActiveRoleAssignees(
  adapter: ReturnType<typeof getAdminAdapter>,
  tenantId: string,
  roleId: string
): Promise<number> {
  const now = Date.now();
  const row = await adapter.queryOne<{ count: number }>(
    `SELECT COUNT(DISTINCT au.id) as count
     FROM admin_role_assignments ra
     JOIN admin_users au
       ON au.id = ra.admin_user_id
      AND au.tenant_id = ra.tenant_id
     WHERE ra.tenant_id = ?
       AND ra.admin_role_id = ?
       AND au.is_active = 1
       AND au.status = 'active'
       AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
    [tenantId, roleId, now]
  );
  return Number(row?.count ?? 0);
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
  await writeAdminAuditLog(c, {
    action,
    resourceType: 'admin_role',
    resourceId,
    result,
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
      allRoles = mergeAvailableRoles(tenantRoles, systemRoles);
    } else {
      allRoles.sort(
        (a, b) => b.hierarchy_level - a.hierarchy_level || a.name.localeCompare(b.name)
      );
    }

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
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    const id = c.req.param('id')!;

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
 * GET /api/admin/admin-roles/:id/assignments
 * List role assignments and their scope bindings.
 */
adminRolesRouter.get('/:id/assignments', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    const id = c.req.param('id')!;
    const role = await roleRepo.getRole(id);
    if (!role || !canAccessRole(role, tenantId)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const includeExpired = c.req.query('include_expired') === 'true';
    const assignments = await roleAssignmentRepo.getAssignmentsByRole(id, includeExpired);

    return c.json({
      items: assignments,
      total: assignments.length,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-roles/:id/assignments
 * Assign this role to an Admin user with an explicit scope binding.
 */
adminRolesRouter.post('/:id/assignments', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const userRepo = new AdminUserRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    const id = c.req.param('id')!;
    const role = await roleRepo.getRole(id);
    if (!role || !canAccessRole(role, tenantId)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      admin_user_id?: string;
      scope_type?: AdminRoleAssignmentScopeType;
      scope_id?: string;
      expires_at?: number;
    }>();

    if (!body.admin_user_id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const user = await userRepo.findByTenantAndId(tenantId, body.admin_user_id);
    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const normalizedScope = normalizeAssignmentScope(body.scope_type, body.scope_id, tenantId);
    if (!normalizedScope) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    if (
      normalizedScope.scopeType === 'global' &&
      !hasAdminPermission(authContext.permissions || [], '*')
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (
      authContext.hierarchyLevel !== undefined &&
      role.hierarchy_level >= authContext.hierarchyLevel
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (
      body.expires_at !== undefined &&
      (!Number.isFinite(body.expires_at) || body.expires_at <= 0)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const duplicate = await roleAssignmentRepo.assignmentExists({
      adminUserId: body.admin_user_id,
      adminRoleId: id,
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
    });
    if (duplicate) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    const assignment = await roleAssignmentRepo.assignRole({
      tenant_id: tenantId,
      admin_user_id: body.admin_user_id,
      admin_role_id: id,
      scope_type: normalizedScope.scopeType,
      scope_id: normalizedScope.scopeId ?? undefined,
      expires_at: body.expires_at,
      assigned_by: authContext.userId,
    });

    await createAuditLog(c, 'admin_role.assignment_create', assignment.id, 'success', {
      role_id: id,
      role_name: role.name,
      admin_user_id: body.admin_user_id,
      scope_type: normalizedScope.scopeType,
      scope_id: normalizedScope.scopeId,
    });

    return c.json(assignment, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /api/admin/admin-roles/:id/assignments/:assignmentId
 * Update an assignment scope binding or expiration.
 */
adminRolesRouter.patch('/:id/assignments/:assignmentId', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    const id = c.req.param('id')!;
    const assignmentId = c.req.param('assignmentId')!;
    const role = await roleRepo.getRole(id);
    if (!role || !canAccessRole(role, tenantId)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const assignment = await roleAssignmentRepo.getAssignment(assignmentId);
    if (!assignment || assignment.admin_role_id !== id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      scope_type?: AdminRoleAssignmentScopeType;
      scope_id?: string;
      expires_at?: number | null;
    }>();

    const normalizedScope = normalizeAssignmentScope(
      body.scope_type ?? assignment.scope_type,
      body.scope_id ?? assignment.scope_id ?? undefined,
      tenantId
    );
    if (!normalizedScope) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    if (
      normalizedScope.scopeType === 'global' &&
      !hasAdminPermission(authContext.permissions || [], '*')
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (
      body.expires_at !== undefined &&
      body.expires_at !== null &&
      (!Number.isFinite(body.expires_at) || body.expires_at <= 0)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const duplicate = await roleAssignmentRepo.assignmentExists({
      adminUserId: assignment.admin_user_id,
      adminRoleId: id,
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
      excludeAssignmentId: assignmentId,
    });
    if (duplicate) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    const updated = await roleAssignmentRepo.updateAssignment(assignmentId, {
      scope_type: normalizedScope.scopeType,
      scope_id: normalizedScope.scopeId,
      expires_at: body.expires_at,
    });

    if (!updated) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await createAuditLog(c, 'admin_role.assignment_update', assignmentId, 'success', {
      role_id: id,
      role_name: role.name,
      admin_user_id: assignment.admin_user_id,
      scope_type: normalizedScope.scopeType,
      scope_id: normalizedScope.scopeId,
      expires_at: body.expires_at,
    });

    return c.json(updated);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admin-roles/:id/assignments/:assignmentId
 * Remove a role assignment by assignment ID.
 */
adminRolesRouter.delete('/:id/assignments/:assignmentId', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    const id = c.req.param('id')!;
    const assignmentId = c.req.param('assignmentId')!;
    const role = await roleRepo.getRole(id);
    if (!role || !canAccessRole(role, tenantId)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const assignment = await roleAssignmentRepo.getAssignment(assignmentId);
    if (!assignment || assignment.admin_role_id !== id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (isPlatformAdminRole(role.name)) {
      const activeAssignees = await countActiveRoleAssignees(adapter, tenantId, id);
      if (activeAssignees <= 1) {
        return c.json(
          {
            error: 'last_platform_admin',
            error_description:
              'At least one active platform administrator must remain. Assign another platform administrator before removing this role.',
          },
          409
        );
      }

      if (assignment.admin_user_id === authContext.userId) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    }

    const removed = await roleAssignmentRepo.removeAssignmentById(assignmentId);
    if (!removed) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await createAuditLog(c, 'admin_role.assignment_remove', assignmentId, 'success', {
      role_id: id,
      role_name: role.name,
      admin_user_id: assignment.admin_user_id,
      scope_type: assignment.scope_type,
      scope_id: assignment.scope_id,
    });

    return c.json({ success: true, message: 'Role assignment removed' });
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
      inherits_from?: string | null;
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
      inherits_from: body.inherits_from,
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

    const id = c.req.param('id')!;

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
      inherits_from?: string | null;
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
      inherits_from: body.inherits_from,
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
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    const id = c.req.param('id')!;

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
 * GET /api/admin/admin-roles/:id/effective-permissions
 * Get effective permissions for a role (including inherited permissions)
 */
adminRolesRouter.get('/:id/effective-permissions', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const roleRepo = new AdminRoleRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id')!;

    const role = await roleRepo.getRole(id);
    if (!role) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Tenant boundary check
    if (role.tenant_id !== tenantId && !role.is_system) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Get effective permissions (including inherited)
    const effectivePermissions = await roleRepo.getEffectivePermissions(id);

    return c.json({
      role_id: role.id,
      role_name: role.name,
      direct_permissions: role.permissions,
      effective_permissions: effectivePermissions,
      inherits_from: role.inherits_from,
    });
  } catch (error) {
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
    {
      key: ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
      description: 'View full admin audit detail payloads',
    },
    { key: ADMIN_PERMISSIONS.IP_ALLOWLIST_READ, description: 'View IP allowlist' },
    { key: ADMIN_PERMISSIONS.IP_ALLOWLIST_WRITE, description: 'Manage IP allowlist' },
    { key: ADMIN_PERMISSIONS.USERS_READ, description: 'View end users' },
    { key: ADMIN_PERMISSIONS.USERS_WRITE, description: 'Create and update end users' },
    { key: ADMIN_PERMISSIONS.USERS_SUSPEND, description: 'Suspend end users' },
    { key: ADMIN_PERMISSIONS.USERS_DELETE, description: 'Delete end users' },
    { key: ADMIN_PERMISSIONS.CLIENTS_READ, description: 'View OAuth clients' },
    { key: ADMIN_PERMISSIONS.CLIENTS_WRITE, description: 'Create and update OAuth clients' },
    { key: ADMIN_PERMISSIONS.CLIENTS_CREATE, description: 'Create OAuth clients' },
    { key: ADMIN_PERMISSIONS.CLIENTS_UPDATE, description: 'Update OAuth clients' },
    {
      key: ADMIN_PERMISSIONS.CLIENTS_SECRET_ROTATE,
      description: 'Rotate OAuth client secrets',
    },
    { key: ADMIN_PERMISSIONS.CLIENTS_DELETE, description: 'Delete OAuth clients' },
    { key: ADMIN_PERMISSIONS.SETTINGS_READ, description: 'View system settings' },
    { key: ADMIN_PERMISSIONS.SETTINGS_WRITE, description: 'Update system settings' },
    {
      key: ADMIN_PERMISSIONS.SETTINGS_ASSURANCE_UPDATE,
      description: 'Update tenant authentication assurance settings',
    },
    {
      key: ADMIN_PERMISSIONS.SETTINGS_SECURITY_UPDATE,
      description: 'Update tenant protocol security settings',
    },
    {
      key: ADMIN_PERMISSIONS.SETTINGS_TOKEN_EXCHANGE_UPDATE,
      description: 'Update tenant token exchange settings',
    },
    {
      key: ADMIN_PERMISSIONS.SETTINGS_OAUTH_UPDATE,
      description: 'Update tenant OAuth settings',
    },
    {
      key: ADMIN_PERMISSIONS.SETTINGS_SESSION_UPDATE,
      description: 'Update tenant session and logout settings',
    },
    {
      key: ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE,
      description: 'Update tenant login UI settings',
    },
    {
      key: ADMIN_PERMISSIONS.POLICY_SIMULATE,
      description: 'Simulate tenant authorization policies',
    },
    {
      key: ADMIN_PERMISSIONS.FLOWS_VALIDATE,
      description: 'Validate authentication Flows',
    },
    {
      key: ADMIN_PERMISSIONS.FLOWS_COMPILE,
      description: 'Compile authentication Flows',
    },
    {
      key: ADMIN_PERMISSIONS.FLOWS_PUBLISH,
      description: 'Publish authentication Flows',
    },
    { key: ADMIN_PERMISSIONS.WEBHOOKS_READ, description: 'View webhook configurations' },
    { key: ADMIN_PERMISSIONS.WEBHOOKS_WRITE, description: 'Create and update webhooks' },
    { key: ADMIN_PERMISSIONS.WEBHOOKS_DELETE, description: 'Delete webhooks' },
    {
      key: ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ,
      description: 'View full webhook delivery request/response payloads',
    },
    {
      key: ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_READ,
      description: 'View external identity providers',
    },
    {
      key: ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_WRITE,
      description: 'Create and update external identity providers',
    },
    {
      key: ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_DELETE,
      description: 'Delete external identity providers',
    },
    {
      key: ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ,
      description: 'View external IdP token refresh configuration and run history',
    },
    {
      key: ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE,
      description: 'Update external IdP token refresh configuration',
    },
    {
      key: ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_RUN,
      description: 'Run external IdP token refresh for an authorized tenant',
    },
    { key: ADMIN_PERMISSIONS.SAML_PROVIDERS_LIST, description: 'List SAML providers' },
    { key: ADMIN_PERMISSIONS.SAML_PROVIDERS_READ, description: 'View SAML provider details' },
    { key: ADMIN_PERMISSIONS.SAML_PROVIDERS_CREATE, description: 'Create SAML providers' },
    { key: ADMIN_PERMISSIONS.SAML_PROVIDERS_UPDATE, description: 'Update SAML providers' },
    { key: ADMIN_PERMISSIONS.SAML_PROVIDERS_DELETE, description: 'Delete SAML providers' },
    {
      key: ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_IMPORT,
      description: 'Import SAML provider metadata',
    },
    {
      key: ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_REFRESH,
      description: 'Refresh SAML provider metadata',
    },
    {
      key: ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_PUBLISH_NEXT,
      description: 'Publish next SAML signing certificate',
    },
    {
      key: ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_PROMOTE,
      description: 'Promote next SAML signing certificate',
    },
    {
      key: ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_RETIRE_BACKUP,
      description: 'Retire backup SAML signing certificate',
    },
    {
      key: ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_DR_BUNDLE_EXPORT,
      description: 'Export encrypted SAML signing DR bundle',
    },
    {
      key: ADMIN_PERMISSIONS.SAML_PROVIDERS_SIGNING_DR_BUNDLE_IMPORT,
      description: 'Import encrypted SAML signing DR bundle',
    },
    {
      key: ADMIN_PERMISSIONS.SAML_ATTRIBUTE_PRESETS_READ,
      description: 'View SAML attribute presets',
    },
    { key: ADMIN_PERMISSIONS.JOBS_READ, description: 'View admin job status and summaries' },
    { key: ADMIN_PERMISSIONS.JOBS_WRITE, description: 'Create and manage admin jobs' },
    {
      key: ADMIN_PERMISSIONS.JOBS_ARTIFACT_READ,
      description: 'Read full admin job result artifacts and manifests',
    },
    {
      key: ADMIN_PERMISSIONS.JOBS_DESTINATION_SELECT,
      description: 'Select approved storage destinations for admin jobs',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST,
      description: 'List tenant storage destinations',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ,
      description: 'View tenant storage destination metadata',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
      description: 'Create tenant storage destinations',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
      description: 'Update tenant storage destination metadata',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
      description: 'Delete tenant storage destinations',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
      description: 'Create or rotate storage destination credentials',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_HEALTH_CHECK,
      description: 'Run storage destination health checks',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_TEST,
      description: 'Test storage destination connectivity',
    },
    {
      key: ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_USAGE_READ,
      description: 'View storage destination usage by features',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      description: 'View logging routing and delivery overview',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_READ,
      description: 'View platform logging defaults and fallback policy',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      description: 'Update platform logging defaults and fallback policy',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_READ,
      description: 'View tenant logging overrides',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE,
      description: 'Update eligible tenant logging overrides',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_CRITICAL_UPDATE,
      description: 'Update critical logging destinations and fallback behavior',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
      description: 'View logging delivery, retry, fallback, and DLQ events',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY,
      description: 'Create logging delivery retry message jobs',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_DLQ_REPLAY,
      description: 'Replay logging DLQ items back to the delivery queue',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_DLQ_DELETE,
      description: 'Mark logging DLQ items as deleted without deleting replay payloads',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_DLQ_PURGE,
      description: 'Purge logging DLQ replay payloads and metadata status',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH,
      description: 'Publish runtime logging policy snapshots',
    },
    {
      key: ADMIN_PERMISSIONS.LOGGING_ROLLBACK,
      description: 'Rollback logging policy changes',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ,
      description: 'View admin logging overview',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_READ,
      description: 'View admin audit coverage status',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_UPDATE,
      description: 'Update admin audit coverage registry state',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ,
      description: 'Preview admin logging catalog repair findings',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN,
      description: 'Run safe automatic admin logging catalog repairs',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ,
      description: 'View admin logging sensitive detail policy',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_UPDATE,
      description: 'Update admin logging sensitive detail policy',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_LOGGING_CRITICAL_UPDATE,
      description: 'Update critical admin logging behavior',
    },
    {
      key: ADMIN_PERMISSIONS.DIAGNOSTIC_LOGGING_DESTINATION_SELECT,
      description: 'Select approved storage destinations for diagnostic logging',
    },
    {
      key: ADMIN_PERMISSIONS.DR_BACKUP_DESTINATION_SELECT,
      description: 'Select approved storage destinations for DR backup',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_LIST,
      description: 'List platform database connections',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_READ,
      description: 'View platform database connection metadata',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREATE,
      description: 'Create platform database connections',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_UPDATE,
      description: 'Update platform database connection metadata',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_DELETE,
      description: 'Delete platform database connections',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREDENTIALS_WRITE,
      description: 'Create or rotate platform database connection credentials',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_TEST,
      description: 'Test platform database connectivity',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_ROUTING_READ,
      description: 'View platform database routing state',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_ROUTING_WRITE,
      description: 'Stage platform database routing changes',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_ROUTING_SWITCH,
      description: 'Switch runtime traffic to a staged database route',
    },
    {
      key: ADMIN_PERMISSIONS.DATABASE_ROUTING_ROLLBACK,
      description: 'Rollback runtime database routing changes',
    },
    { key: ADMIN_PERMISSIONS.APPROVALS_READ, description: 'View approval and elevation requests' },
    {
      key: ADMIN_PERMISSIONS.APPROVALS_WRITE,
      description: 'Create and update approval and elevation requests',
    },
    {
      key: ADMIN_PERMISSIONS.APPROVALS_APPROVE,
      description: 'Approve or deny approval and elevation requests',
    },
    { key: ADMIN_PERMISSIONS.AGENT_USE, description: 'Use delegated Agent Access' },
    { key: ADMIN_PERMISSIONS.AGENT_GRANTS_READ, description: 'View Agent Access grants' },
    { key: ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE, description: 'Create and update Agent grants' },
    { key: ADMIN_PERMISSIONS.AGENT_GRANTS_REVOKE, description: 'Revoke Agent grants' },
    { key: ADMIN_PERMISSIONS.AGENT_SETTINGS_READ, description: 'View Agent Access settings' },
    { key: ADMIN_PERMISSIONS.AGENT_SETTINGS_WRITE, description: 'Update Agent Access settings' },
    {
      key: ADMIN_PERMISSIONS.AGENT_ELEVATION_RECONCILE,
      description: 'Reconcile indeterminate Agent executions',
    },
    { key: ADMIN_PERMISSIONS.AGENT_TASK_SETS_READ, description: 'View Agent Task Sets' },
    { key: ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE, description: 'Manage Agent Task Sets' },
    {
      key: ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_READ,
      description: 'View Agent Scope Policies',
    },
    {
      key: ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE,
      description: 'Manage Agent Scope Policies',
    },
    {
      key: ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH,
      description: 'Publish Agent templates across explicitly selected tenants',
    },
    { key: ADMIN_PERMISSIONS.AGENT_BASELINES_READ, description: 'View Agent baselines and drift' },
    { key: ADMIN_PERMISSIONS.AGENT_BASELINES_WRITE, description: 'Manage Agent baselines' },
    {
      key: ADMIN_PERMISSIONS.AGENT_BASELINES_APPLY,
      description: 'Assign Agent baselines and approve exceptions',
    },
    { key: ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ, description: 'View auth configuration plans' },
    {
      key: ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE,
      description: 'Create auth configuration plans',
    },
    {
      key: ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_APPLY,
      description: 'Apply auth configuration plans',
    },
    {
      key: ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CANCEL,
      description: 'Cancel auth configuration plans',
    },
    { key: ADMIN_PERMISSIONS.BULK_PLANS_READ, description: 'View cross-tenant bulk plans' },
    { key: ADMIN_PERMISSIONS.BULK_PLANS_CREATE, description: 'Create cross-tenant bulk plans' },
    { key: ADMIN_PERMISSIONS.BULK_PLANS_APPLY, description: 'Apply cross-tenant bulk plans' },
    { key: ADMIN_PERMISSIONS.BULK_PLANS_PAUSE, description: 'Pause cross-tenant bulk plans' },
    { key: ADMIN_PERMISSIONS.BULK_PLANS_RESUME, description: 'Resume cross-tenant bulk plans' },
    {
      key: ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_READ,
      description: 'View Admin Machine Access principals and credentials',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE,
      description: 'Create and update Admin Machine Access principals and credentials',
    },
    {
      key: ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE,
      description: 'Delete principals and revoke Admin Machine Access credentials',
    },
    {
      key: ADMIN_PERMISSIONS.OPERATIONAL_LOGS_READ,
      description: 'View operational log summaries',
    },
    {
      key: ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ,
      description: 'Read full operational log reason detail payloads',
    },
    { key: ADMIN_PERMISSIONS.TENANT_DOMAINS_READ, description: 'View tenant vanity domains' },
    {
      key: ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE,
      description: 'Create and update tenant vanity domains',
    },
    { key: ADMIN_PERMISSIONS.TENANT_DOMAINS_DELETE, description: 'Delete tenant vanity domains' },
    {
      key: ADMIN_PERMISSIONS.TENANT_DOMAINS_ALL,
      description: 'Full tenant vanity domain management',
    },
    {
      key: ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
      description: 'View Directory Authentication and Wordwarden connector state',
    },
    {
      key: ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
      description: 'Update Directory Authentication retention and support settings',
    },
    {
      key: ADMIN_PERMISSIONS.DIRECTORY_AUTH_MIGRATION_WRITE,
      description: 'Create and update Directory Authentication migration campaigns',
    },
    {
      key: ADMIN_PERMISSIONS.DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE,
      description: 'Create and manage Directory Authentication evidence exports',
    },
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

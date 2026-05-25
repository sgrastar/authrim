/**
 * Admin User Management API
 *
 * Endpoints for managing Admin users (stored in DB_ADMIN).
 * These are separate from EndUser management (stored in DB_CORE).
 *
 * Requires super_admin role or admin:admin_users:* permission.
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
  AdminPasskeyRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
  type AdminUser,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

// Create router
export const adminUsersRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Apply admin authentication to all routes
adminUsersRouter.use(
  '*',
  adminAuthMiddleware({
    requirePermissions: [ADMIN_PERMISSIONS.ADMIN_USERS_READ],
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
  return hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_USERS_WRITE);
}

/**
 * Helper to check delete permission
 */
function hasDeletePermission(authContext: AdminAuthContext): boolean {
  const permissions = authContext.permissions || [];
  return hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_USERS_DELETE);
}

function isPlatformAdminRole(roleName: string | undefined): boolean {
  return roleName === 'super_admin';
}

function normalizeAdminAssignmentScope(
  scopeType: 'global' | 'tenant' | 'org' | undefined,
  scopeId: string | undefined,
  tenantId: string
): { scopeType: 'global' | 'tenant'; scopeId: string | null } | null {
  const normalizedScopeType = scopeType ?? 'tenant';

  // Admin org-scoped assignments are reserved until Admin resources have target-org enforcement.
  if (normalizedScopeType !== 'global' && normalizedScopeType !== 'tenant') {
    return null;
  }

  if (normalizedScopeType === 'global') {
    return { scopeType: 'global', scopeId: null };
  }

  const normalizedScopeId = scopeId?.trim() || tenantId;
  if (normalizedScopeId !== tenantId) {
    return null;
  }

  return { scopeType: 'tenant', scopeId: normalizedScopeId };
}

async function countActivePlatformAdmins(
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
       AND ra.scope_type = 'global'
       AND au.is_active = 1
       AND au.status = 'active'
       AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
    [tenantId, roleId, now]
  );
  return Number(row?.count ?? 0);
}

async function userHasActivePlatformAdminRole(
  adapter: ReturnType<typeof getAdminAdapter>,
  tenantId: string,
  adminUserId: string
): Promise<boolean> {
  const now = Date.now();
  const row = await adapter.queryOne<{ id: string }>(
    `SELECT ra.id
     FROM admin_role_assignments ra
     JOIN admin_roles r
       ON r.id = ra.admin_role_id
      AND (
        r.tenant_id = ra.tenant_id
        OR (r.tenant_id = 'default' AND r.is_system = 1)
      )
     WHERE ra.tenant_id = ?
       AND ra.admin_user_id = ?
       AND r.name = 'super_admin'
       AND ra.scope_type = 'global'
       AND (ra.expires_at IS NULL OR ra.expires_at > ?)
     LIMIT 1`,
    [tenantId, adminUserId, now]
  );
  return !!row;
}

async function ensureNotRemovingLastPlatformAdmin(
  c: AdminContext,
  adapter: ReturnType<typeof getAdminAdapter>,
  tenantId: string,
  adminUserId: string
): Promise<Response | null> {
  const hasPlatformAdminRole = await userHasActivePlatformAdminRole(adapter, tenantId, adminUserId);
  if (!hasPlatformAdminRole) {
    return null;
  }

  const platformRole = await adapter.queryOne<{ id: string }>(
    "SELECT id FROM admin_roles WHERE tenant_id = 'default' AND name = 'super_admin' AND is_system = 1 LIMIT 1",
    []
  );
  if (!platformRole) {
    return null;
  }

  const activePlatformAdmins = await countActivePlatformAdmins(adapter, tenantId, platformRole.id);
  if (activePlatformAdmins > 1) {
    return null;
  }

  return c.json(
    {
      error: 'last_platform_admin',
      error_description:
        'At least one active platform administrator must remain. Assign another platform administrator before changing this account.',
    },
    409
  );
}

/**
 * Sanitize admin user for response (remove sensitive fields)
 */
function sanitizeAdminUser(
  user: AdminUser
): Omit<AdminUser, 'password_hash' | 'totp_secret_encrypted'> {
  const { password_hash, totp_secret_encrypted, ...sanitized } = user;
  return sanitized;
}

/**
 * Hash password using PBKDF2 (secure password hashing for Cloudflare Workers)
 *
 * Uses PBKDF2-SHA256 with 100,000 iterations and a 16-byte random salt.
 * The result format is: base64(salt):base64(hash)
 *
 * This is more secure than simple SHA-256 hashing because:
 * - PBKDF2 is intentionally slow, making brute-force attacks expensive
 * - Each password has a unique salt, preventing rainbow table attacks
 * - 100,000 iterations provide adequate security for modern systems
 */
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const hashArray = new Uint8Array(derivedBits);
  const saltBase64 = btoa(String.fromCharCode(...salt));
  const hashBase64 = btoa(String.fromCharCode(...hashArray));

  return `${saltBase64}:${hashBase64}`;
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
    resourceType: 'admin_user',
    resourceId,
    result,
    metadata,
  });
}

/**
 * GET /api/admin/admins
 * List Admin users with pagination and filtering
 */
adminUsersRouter.get('/', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    // Parse query parameters
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
    const status = c.req.query('status') as 'active' | 'suspended' | 'locked' | undefined;
    const email = c.req.query('email');
    const mfaEnabled = c.req.query('mfa_enabled');

    const result = await userRepo.searchAdminUsers(
      {
        tenant_id: tenantId,
        status,
        email,
        mfa_enabled: mfaEnabled === 'true' ? true : mfaEnabled === 'false' ? false : undefined,
      },
      {
        page,
        limit,
        sortBy: 'created_at',
        sortOrder: 'desc',
      }
    );

    return c.json({
      items: result.items.map(sanitizeAdminUser),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admins/:id
 * Get Admin user details
 */
adminUsersRouter.get('/:id', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);
    const passkeyRepo = new AdminPasskeyRepository(adapter);

    const id = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    const user = await userRepo.findByTenantAndId(tenantId, id);
    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Get role assignments
    const roleAssignments = await roleAssignmentRepo.getAssignmentsByUser(id);
    const roles = roleAssignments.map((ra) => ({
      id: ra.admin_role_id,
      assignment_id: ra.id,
      role_id: ra.admin_role_id,
      name: ra.role.name,
      display_name: ra.role.display_name,
      scope_type: ra.scope_type,
      scope_id: ra.scope_id,
      assigned_at: ra.created_at,
      expires_at: ra.expires_at,
      assigned_by: ra.assigned_by,
    }));

    // Get passkey count
    const passkeyCount = await passkeyRepo.countByUser(id);

    return c.json({
      ...sanitizeAdminUser(user),
      roles,
      passkey_count: passkeyCount,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admins
 * Create a new Admin user
 */
adminUsersRouter.post('/', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const body = await c.req.json<{
      email: string;
      name?: string;
      password?: string;
      mfa_enabled?: boolean;
    }>();

    // Validate required fields
    if (!body.email) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Check if email already exists
    const existing = await userRepo.findByEmail(tenantId, body.email);
    if (existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    // Hash password if provided using PBKDF2
    let passwordHash: string | undefined;
    if (body.password) {
      passwordHash = await hashPassword(body.password);
    }

    // Create admin user
    const user = await userRepo.createAdminUser({
      tenant_id: tenantId,
      email: body.email.toLowerCase(),
      name: body.name,
      password: passwordHash,
      mfa_enabled: body.mfa_enabled,
      created_by: authContext.userId,
    });

    // Create audit log
    await createAuditLog(c, 'admin_user.create', user.id, 'success', {
      email: user.email,
    });

    return c.json(sanitizeAdminUser(user), 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /api/admin/admins/:id
 * Update an Admin user
 */
adminUsersRouter.patch('/:id', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);

    const id = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);

    // Check if user exists
    const existing = await userRepo.findByTenantAndId(tenantId, id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      name?: string;
      email?: string;
      status?: 'active' | 'suspended';
      mfa_enabled?: boolean;
    }>();

    // Check hierarchy - can't modify users with higher hierarchy level
    if (authContext.hierarchyLevel !== undefined && existing.id !== authContext.userId) {
      // This would require fetching the target user's hierarchy level
      // For now, only super_admin can modify other admins
      const permissions = authContext.permissions || [];
      if (!hasAdminPermission(permissions, '*')) {
        // Check if user is trying to modify someone else
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    }

    const user = await userRepo.updateAdminUser(id, {
      name: body.name,
      email: body.email?.toLowerCase(),
      status: body.status,
      mfa_enabled: body.mfa_enabled,
    });

    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Create audit log
    await createAuditLog(c, 'admin_user.update', id, 'success', {
      changes: body,
    });

    return c.json(sanitizeAdminUser(user));
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admins/:id
 * Delete (deactivate) an Admin user
 */
adminUsersRouter.delete('/:id', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasDeletePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);

    const id = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);

    // Check if user exists
    const existing = await userRepo.findByTenantAndId(tenantId, id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Prevent self-deletion
    if (id === authContext.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    const lastPlatformAdminResponse = await ensureNotRemovingLastPlatformAdmin(
      c,
      adapter,
      tenantId,
      id
    );
    if (lastPlatformAdminResponse) {
      return lastPlatformAdminResponse;
    }

    // Soft delete (deactivate)
    await userRepo.updateAdminUser(id, { is_active: false });

    // Create audit log
    await createAuditLog(c, 'admin_user.delete', id, 'success', {
      email: existing.email,
    });

    return c.json({ success: true, message: 'Admin user deleted' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admins/:id/suspend
 * Suspend an Admin user
 */
adminUsersRouter.post('/:id/suspend', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);

    const id = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);

    // Check if user exists
    const existing = await userRepo.findByTenantAndId(tenantId, id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Prevent self-suspension
    if (id === authContext.userId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    const lastPlatformAdminResponse = await ensureNotRemovingLastPlatformAdmin(
      c,
      adapter,
      tenantId,
      id
    );
    if (lastPlatformAdminResponse) {
      return lastPlatformAdminResponse;
    }

    await userRepo.suspendAccount(id);

    // Create audit log
    await createAuditLog(c, 'admin_user.suspend', id, 'success');

    return c.json({ success: true, message: 'Admin user suspended' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admins/:id/activate
 * Activate a suspended Admin user
 */
adminUsersRouter.post('/:id/activate', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);

    const id = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);

    // Check if user exists
    const existing = await userRepo.findByTenantAndId(tenantId, id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await userRepo.activateAccount(id);

    // Create audit log
    await createAuditLog(c, 'admin_user.activate', id, 'success');

    return c.json({ success: true, message: 'Admin user activated' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admins/:id/unlock
 * Unlock a locked Admin user
 */
adminUsersRouter.post('/:id/unlock', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);

    const id = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);

    // Check if user exists
    const existing = await userRepo.findByTenantAndId(tenantId, id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await userRepo.unlockAccount(id);

    // Create audit log
    await createAuditLog(c, 'admin_user.unlock', id, 'success');

    return c.json({ success: true, message: 'Admin user unlocked' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admins/:id/roles
 * Assign a role to an Admin user
 */
adminUsersRouter.post('/:id/roles', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const permissions = authContext.permissions || [];

  if (!hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);
    const roleRepo = new AdminRoleRepository(adapter);

    const id = c.req.param('id')!;
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    // Check if user exists
    const user = await userRepo.findByTenantAndId(tenantId, id);
    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      role_id: string;
      scope_type?: 'global' | 'tenant' | 'org';
      scope_id?: string;
      expires_at?: number;
    }>();

    if (!body.role_id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Check if role exists
    const role = await roleRepo.getRole(body.role_id);
    if (!role) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Prevent cross-tenant role assignment while still allowing shared system roles.
    if (role.tenant_id !== tenantId && !(role.tenant_id === 'default' && role.is_system)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check hierarchy - can only assign roles with lower hierarchy level
    if (
      authContext.hierarchyLevel !== undefined &&
      role.hierarchy_level >= authContext.hierarchyLevel
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    const normalizedScope = normalizeAdminAssignmentScope(body.scope_type, body.scope_id, tenantId);
    if (!normalizedScope) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    if (normalizedScope.scopeType === 'global' && !hasAdminPermission(permissions, '*')) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (
      body.expires_at !== undefined &&
      (!Number.isFinite(body.expires_at) || body.expires_at <= 0)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const duplicate = await roleAssignmentRepo.assignmentExists({
      adminUserId: id,
      adminRoleId: body.role_id,
      scopeType: normalizedScope.scopeType,
      scopeId: normalizedScope.scopeId,
    });
    if (duplicate) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    // Create assignment
    const assignment = await roleAssignmentRepo.assignRole({
      tenant_id: tenantId,
      admin_user_id: id,
      admin_role_id: body.role_id,
      scope_type: normalizedScope.scopeType,
      scope_id: normalizedScope.scopeId ?? undefined,
      expires_at: body.expires_at,
      assigned_by: authContext.userId,
    });

    // Create audit log
    await createAuditLog(c, 'admin_user.role_assign', id, 'success', {
      role_id: body.role_id,
      role_name: role.name,
      scope_type: normalizedScope.scopeType,
      scope_id: normalizedScope.scopeId,
    });

    return c.json(assignment, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admins/:id/role-assignments/:assignmentId
 * Remove a specific role assignment from an Admin user.
 */
adminUsersRouter.delete('/:id/role-assignments/:assignmentId', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const permissions = authContext.permissions || [];

  if (!hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);
    const roleRepo = new AdminRoleRepository(adapter);

    const id = c.req.param('id')!;
    const assignmentId = c.req.param('assignmentId')!;
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    const user = await userRepo.findByTenantAndId(tenantId, id);
    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const assignment = await roleAssignmentRepo.getAssignment(assignmentId);
    if (!assignment || assignment.admin_user_id !== id) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const role = await roleRepo.getRole(assignment.admin_role_id);
    if (!role) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (isPlatformAdminRole(role.name)) {
      const activePlatformAdmins = await countActivePlatformAdmins(adapter, tenantId, role.id);
      if (activePlatformAdmins <= 1) {
        return c.json(
          {
            error: 'last_platform_admin',
            error_description:
              'At least one active platform administrator must remain. Assign another platform administrator before removing this role.',
          },
          409
        );
      }
      if (id === authContext.userId) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    }

    const removed = await roleAssignmentRepo.removeAssignmentById(assignmentId);
    if (!removed) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await createAuditLog(c, 'admin_user.role_assignment_remove', id, 'success', {
      assignment_id: assignmentId,
      role_id: role.id,
      role_name: role.name,
      scope_type: assignment.scope_type,
      scope_id: assignment.scope_id,
    });

    return c.json({ success: true, message: 'Role assignment removed' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admins/:id/roles/:roleId
 * Remove a role from an Admin user
 */
adminUsersRouter.delete('/:id/roles/:roleId', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const permissions = authContext.permissions || [];

  if (!hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const userRepo = new AdminUserRepository(adapter);
    const roleRepo = new AdminRoleRepository(adapter);

    const id = c.req.param('id')!;
    const roleId = c.req.param('roleId')!;
    const tenantId = getTenantIdFromContext(c);
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter, tenantId);

    // Check if user exists
    const user = await userRepo.findByTenantAndId(tenantId, id);
    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const role = await roleRepo.getRole(roleId);
    if (!role) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (isPlatformAdminRole(role.name)) {
      const activePlatformAdmins = await countActivePlatformAdmins(adapter, tenantId, roleId);
      if (activePlatformAdmins <= 1) {
        return c.json(
          {
            error: 'last_platform_admin',
            error_description:
              'At least one active platform administrator must remain. Assign another platform administrator before removing this role.',
          },
          409
        );
      }
    }

    // Prevent removing own super_admin role
    if (id === authContext.userId) {
      if (isPlatformAdminRole(role.name)) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    }

    const removed = await roleAssignmentRepo.removeAssignment(id, roleId);

    if (!removed) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Create audit log
    await createAuditLog(c, 'admin_user.role_remove', id, 'success', {
      role_id: roleId,
    });

    return c.json({ success: true, message: 'Role removed' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export default adminUsersRouter;

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
  D1Adapter,
  AdminUserRepository,
  AdminRoleRepository,
  AdminRoleAssignmentRepository,
  AdminPasskeyRepository,
  AdminAuditLogRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  type AdminUser,
} from '@authrim/ar-lib-core';

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
  return hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_USERS_WRITE);
}

/**
 * Helper to check delete permission
 */
function hasDeletePermission(authContext: AdminAuthContext): boolean {
  const permissions = authContext.permissions || [];
  return hasAdminPermission(permissions, ADMIN_PERMISSIONS.ADMIN_USERS_DELETE);
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
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const adapter = getAdminAdapter(c);
  const auditRepo = new AdminAuditLogRepository(adapter);
  const tenantId = getTenantIdFromContext(c);

  await auditRepo.createAuditLog({
    tenant_id: tenantId,
    admin_user_id: authContext.userId,
    admin_email: authContext.email,
    action,
    resource_type: 'admin_user',
    resource_id: resourceId,
    result,
    ip_address: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
    user_agent: c.req.header('user-agent') || undefined,
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
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter);
    const passkeyRepo = new AdminPasskeyRepository(adapter);

    const id = c.req.param('id');
    const tenantId = getTenantIdFromContext(c);

    const user = await userRepo.findByTenantAndId(tenantId, id);
    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Get role assignments
    const roleAssignments = await roleAssignmentRepo.getAssignmentsByUser(id);
    const roles = roleAssignments.map((ra) => ({
      id: ra.admin_role_id,
      name: ra.role.name,
      display_name: ra.role.display_name,
      assigned_at: ra.created_at,
      expires_at: ra.expires_at,
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

    const id = c.req.param('id');
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

    const id = c.req.param('id');
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

    const id = c.req.param('id');
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

    const id = c.req.param('id');
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

    const id = c.req.param('id');
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
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter);

    const id = c.req.param('id');
    const tenantId = getTenantIdFromContext(c);

    // Check if user exists
    const user = await userRepo.findByTenantAndId(tenantId, id);
    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      role_id: string;
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

    // Check hierarchy - can only assign roles with lower hierarchy level
    if (
      authContext.hierarchyLevel !== undefined &&
      role.hierarchy_level >= authContext.hierarchyLevel
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    // Create assignment
    const assignment = await roleAssignmentRepo.assignRole({
      tenant_id: tenantId,
      admin_user_id: id,
      admin_role_id: body.role_id,
      expires_at: body.expires_at,
      assigned_by: authContext.userId,
    });

    // Create audit log
    await createAuditLog(c, 'admin_user.role_assign', id, 'success', {
      role_id: body.role_id,
      role_name: role.name,
    });

    return c.json(assignment, 201);
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
    const roleAssignmentRepo = new AdminRoleAssignmentRepository(adapter);

    const id = c.req.param('id');
    const roleId = c.req.param('roleId');
    const tenantId = getTenantIdFromContext(c);

    // Check if user exists
    const user = await userRepo.findByTenantAndId(tenantId, id);
    if (!user) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Prevent removing own super_admin role
    if (id === authContext.userId) {
      const roleRepo = new AdminRoleRepository(adapter);
      const role = await roleRepo.getRole(roleId);
      if (role?.name === 'super_admin') {
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

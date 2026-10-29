/**
 * Admin User Management API
 *
 * Endpoints for managing Admin users (stored in DB_ADMIN).
 * These are separate from EndUser management (stored in DB_CORE).
 *
 * Requires the admin:admin_users:* permission.
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
  hasGlobalAdminPermission,
  ADMIN_ROLES,
  allOfGuards,
  type AdminWriteGuard,
  requireDedicatedAdminDatabaseAdapter,
  type AdminUser,
} from '@authrim/ar-lib-core';
import { resolveAaguidAuthenticator } from '@authrim/ar-lib-core/webauthn/aaguid-metadata';
import { writeAdminAuditLog } from '../../admin-shared';
import {
  callerOutranks,
  callerOutranksGlobally,
  loadAdminStanding,
  isScopeAllowedForRole,
  mayActOnAdminAccount,
  mayRemoveAssignment,
} from './admin-role-authority';
import {
  ensureTenantKeepsAdmin,
  lastTenantAdminResponse,
  tenantKeepsAdminGuard,
} from './last-tenant-admin';
import {
  countActiveRoleHolders,
  lastPlatformAdminResponse,
  platformAdminKeptGuard,
  roleKeepsHolderGuard,
} from './last-platform-admin';

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
  return roleName === ADMIN_ROLES.SUPER_ADMIN;
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

function countActivePlatformAdmins(
  adapter: ReturnType<typeof getAdminAdapter>,
  tenantId: string,
  roleId: string
): Promise<number> {
  return countActiveRoleHolders(adapter, tenantId, roleId, true);
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
       AND r.name = ?
       AND ra.scope_type = 'global'
       AND (ra.expires_at IS NULL OR ra.expires_at > ?)
     LIMIT 1`,
    [tenantId, adminUserId, ADMIN_ROLES.SUPER_ADMIN, now]
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
    "SELECT id FROM admin_roles WHERE tenant_id = 'default' AND name = ? AND is_system = 1 LIMIT 1",
    [ADMIN_ROLES.SUPER_ADMIN]
  );
  if (!platformRole) {
    return null;
  }

  const activePlatformAdmins = await countActivePlatformAdmins(adapter, tenantId, platformRole.id);
  if (activePlatformAdmins > 1) {
    return null;
  }

  return lastPlatformAdminResponse(c, 'account');
}

/**
 * The answer for a guarded write of an account that did not apply: the account is gone (404), or
 * it was the last administrator by the time the write ran, which another request got to first.
 */
async function refusedAccountWrite(
  c: AdminContext,
  adapter: ReturnType<typeof getAdminAdapter>,
  userRepo: AdminUserRepository,
  tenantId: string,
  adminUserId: string
): Promise<Response> {
  if (!(await userRepo.findByTenantAndId(tenantId, adminUserId))) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  }
  return (
    (await ensureNotRemovingLastPlatformAdmin(c, adapter, tenantId, adminUserId)) ??
    lastTenantAdminResponse(c)
  );
}

/**
 * What stops an account from being taken out of service, decided by the write itself. An account
 * that is not in service when the write runs has nothing to lose, so the guard holds for it: the
 * state read before the request is not what decides whether to guard (it may have been
 * re-activated since), the write is.
 */
function accountKeptGuard(tenantId: string, adminUserId: string): AdminWriteGuard {
  const kept = allOfGuards(
    platformAdminKeptGuard(tenantId, adminUserId),
    tenantKeepsAdminGuard(tenantId, { adminUserId })
  ) as AdminWriteGuard;
  return {
    sql: `NOT EXISTS (
        SELECT 1 FROM admin_users WHERE id = ? AND is_active = 1 AND status = 'active'
      ) OR (${kept.sql})`,
    params: [adminUserId, ...kept.params],
  };
}

/**
 * An account that holds a global assignment, or a role above the caller's own, is acted on with
 * the permission and the hierarchy of the caller's global assignments. Acting on oneself keeps its
 * own rules.
 */
async function requireAuthorityOverAccount(
  c: AdminContext,
  adapter: ReturnType<typeof getAdminAdapter>,
  tenantId: string,
  authContext: AdminAuthContext,
  targetId: string,
  permission: string
): Promise<Response | null> {
  if (targetId === authContext.userId) {
    return null;
  }
  const standing = await loadAdminStanding(adapter, tenantId, targetId);
  if (mayActOnAdminAccount(authContext, standing, permission)) {
    return null;
  }
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
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

    // Get passkeys
    const passkeys = await passkeyRepo.getPasskeysByUser(id);

    return c.json({
      ...sanitizeAdminUser(user),
      roles,
      passkey_count: passkeys.length,
      passkeys: passkeys.map((passkey) => ({
        id: passkey.id,
        device_name: passkey.device_name,
        aaguid: passkey.aaguid,
        provider: resolveAaguidAuthenticator(passkey.aaguid),
        created_at: passkey.created_at,
        last_used_at: passkey.last_used_at,
      })),
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admins
 * Direct Admin creation is disabled. Use /api/admin/admin-invitations so every new Admin
 * proves possession of a newly registered Passkey before the account becomes active.
 */
adminUsersRouter.post('/', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  return c.json(
    {
      error: 'admin_invitation_required',
      error_description:
        'Direct Admin creation is disabled. Create an invitation at /api/admin/admin-invitations.',
    },
    409
  );
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

    const authorityResponse = await requireAuthorityOverAccount(
      c,
      adapter,
      tenantId,
      authContext,
      id,
      ADMIN_PERMISSIONS.ADMIN_USERS_WRITE
    );
    if (authorityResponse) {
      return authorityResponse;
    }

    const body = await c.req.json<{
      name?: string;
      email?: string;
      status?: 'active' | 'suspended';
      mfa_enabled?: boolean;
    }>();

    // The account is active or suspended through this route; any other value is refused.
    if (body.status !== undefined && body.status !== 'active' && body.status !== 'suspended') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Making an account unable to sign in is held to the same protections as the suspend route.
    const suspending = body.status === 'suspended' && existing.status === 'active';
    if (suspending) {
      const lastPlatformAdminResponse = await ensureNotRemovingLastPlatformAdmin(
        c,
        adapter,
        tenantId,
        id
      );
      if (lastPlatformAdminResponse) {
        return lastPlatformAdminResponse;
      }
      const tenantAdminRefusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, {
        adminUserId: id,
      });
      if (tenantAdminRefusal) {
        return tenantAdminRefusal;
      }
    }

    const user = await userRepo.updateAdminUser(
      id,
      {
        name: body.name,
        email: body.email?.toLowerCase(),
        status: body.status,
        mfa_enabled: body.mfa_enabled,
      },
      body.status === 'suspended' ? accountKeptGuard(tenantId, id) : undefined
    );

    if (!user) {
      return body.status === 'suspended'
        ? refusedAccountWrite(c, adapter, userRepo, tenantId, id)
        : createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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

    const authorityResponse = await requireAuthorityOverAccount(
      c,
      adapter,
      tenantId,
      authContext,
      id,
      ADMIN_PERMISSIONS.ADMIN_USERS_DELETE
    );
    if (authorityResponse) {
      return authorityResponse;
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

    const tenantAdminRefusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, {
      adminUserId: id,
    });
    if (tenantAdminRefusal) {
      return tenantAdminRefusal;
    }

    // Soft delete (deactivate)
    if (!(await userRepo.deactivateAccount(id, accountKeptGuard(tenantId, id)))) {
      return refusedAccountWrite(c, adapter, userRepo, tenantId, id);
    }

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

    const authorityResponse = await requireAuthorityOverAccount(
      c,
      adapter,
      tenantId,
      authContext,
      id,
      ADMIN_PERMISSIONS.ADMIN_USERS_WRITE
    );
    if (authorityResponse) {
      return authorityResponse;
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

    const tenantAdminRefusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, {
      adminUserId: id,
    });
    if (tenantAdminRefusal) {
      return tenantAdminRefusal;
    }

    if (!(await userRepo.suspendAccount(id, accountKeptGuard(tenantId, id)))) {
      return refusedAccountWrite(c, adapter, userRepo, tenantId, id);
    }

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

    const authorityResponse = await requireAuthorityOverAccount(
      c,
      adapter,
      tenantId,
      authContext,
      id,
      ADMIN_PERMISSIONS.ADMIN_USERS_WRITE
    );
    if (authorityResponse) {
      return authorityResponse;
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

    const authorityResponse = await requireAuthorityOverAccount(
      c,
      adapter,
      tenantId,
      authContext,
      id,
      ADMIN_PERMISSIONS.ADMIN_USERS_WRITE
    );
    if (authorityResponse) {
      return authorityResponse;
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
    if (!callerOutranks(authContext, role.hierarchy_level)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    const normalizedScope = normalizeAdminAssignmentScope(body.scope_type, body.scope_id, tenantId);
    if (!normalizedScope) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // The super admin is held through a global assignment only.
    if (!isScopeAllowedForRole(role.name, normalizedScope.scopeType)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // A global assignment is measured by the caller's global hierarchy, not the sum.
    if (
      normalizedScope.scopeType === 'global' &&
      !callerOutranksGlobally(authContext, role.hierarchy_level)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (normalizedScope.scopeType === 'global' && !hasGlobalAdminPermission(authContext, '*')) {
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

    if (!mayRemoveAssignment(authContext, assignment.scope_type, role.hierarchy_level)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (isPlatformAdminRole(role.name)) {
      const activePlatformAdmins = await countActivePlatformAdmins(adapter, tenantId, role.id);
      if (activePlatformAdmins <= 1) {
        return lastPlatformAdminResponse(c, 'role');
      }
      if (id === authContext.userId) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    }

    const tenantAdminRefusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, {
      assignmentId,
    });
    if (tenantAdminRefusal) {
      return tenantAdminRefusal;
    }

    const removed = await roleAssignmentRepo.removeAssignmentById(
      assignmentId,
      allOfGuards(
        isPlatformAdminRole(role.name) ? roleKeepsHolderGuard(tenantId, role.id, true) : undefined,
        role.name === ADMIN_ROLES.TENANT_ADMIN
          ? tenantKeepsAdminGuard(tenantId, { assignmentId })
          : undefined
      )
    );
    if (!removed) {
      // Gone, or the last administrator by the time the write ran: another request got there first.
      if (!(await roleAssignmentRepo.getAssignment(assignmentId))) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      return isPlatformAdminRole(role.name) &&
        (await countActivePlatformAdmins(adapter, tenantId, role.id)) <= 1
        ? lastPlatformAdminResponse(c, 'role')
        : lastTenantAdminResponse(c);
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

    // This removes the role under every scope the user holds it in: each is judged as removing
    // that assignment by its ID would be.
    const held = (await roleAssignmentRepo.getAssignmentsByUser(id, true)).filter(
      (assignment) => assignment.admin_role_id === roleId
    );
    if (
      !held.every((assignment) =>
        mayRemoveAssignment(authContext, assignment.scope_type, role.hierarchy_level)
      )
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (isPlatformAdminRole(role.name)) {
      const activePlatformAdmins = await countActivePlatformAdmins(adapter, tenantId, roleId);
      if (activePlatformAdmins <= 1) {
        return lastPlatformAdminResponse(c, 'role');
      }
    }

    // Prevent removing own ar_super_admin role
    if (id === authContext.userId) {
      if (isPlatformAdminRole(role.name)) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
      }
    }

    if (role.name === ADMIN_ROLES.TENANT_ADMIN) {
      const tenantAdminRefusal = await ensureTenantKeepsAdmin(c, adapter, tenantId, {
        adminUserId: id,
      });
      if (tenantAdminRefusal) {
        return tenantAdminRefusal;
      }
    }

    const removed = await roleAssignmentRepo.removeAssignment(
      id,
      roleId,
      undefined,
      undefined,
      allOfGuards(
        isPlatformAdminRole(role.name) ? roleKeepsHolderGuard(tenantId, roleId, true) : undefined,
        role.name === ADMIN_ROLES.TENANT_ADMIN
          ? tenantKeepsAdminGuard(tenantId, { adminUserId: id })
          : undefined
      )
    );

    if (!removed) {
      // Nothing held (404), or the last administrator by the time the write ran.
      const stillHeld = (await roleAssignmentRepo.getAssignmentsByUser(id, true)).some(
        (assignment) => assignment.admin_role_id === roleId
      );
      if (!stillHeld) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      return isPlatformAdminRole(role.name) &&
        (await countActivePlatformAdmins(adapter, tenantId, roleId)) <= 1
        ? lastPlatformAdminResponse(c, 'role')
        : lastTenantAdminResponse(c);
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

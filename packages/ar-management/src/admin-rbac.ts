/**
 * RBAC Admin API Endpoints
 *
 * Phase 1 RBAC implementation for administrative dashboard:
 * - Role management (read-only for system roles)
 * - Role assignment management
 * - Relationship management (parent-child between subjects)
 *
 * All endpoints require admin authentication via adminAuthMiddleware()
 */

import { mayManageEndUserRole } from './role-delegation';
import { bumpTenantReBACVersion } from './rebac-version';
export { canGrantRole } from './role-delegation';
import { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import { removeRoleAssignment, type RevocationContext } from './access-revocation';
import {
  getTenantIdFromContext,
  createAuthContextFromHono,
  createAccountAuthContextFromHono,
  createPIIContextFromHono,
  resolveAccountDataContextFromHono,
  getAccountDataContextFromHono,
  hasPIIDatabase,
  D1Adapter,
  type DatabaseAdapter,
  escapeLikePattern,
  getLogger,
  createErrorResponse,
  AR_ERROR_CODES,
  generateId,
  createAuditLogFromContext,
  CanonicalRuntimeUserStore,
  findTenantRole,
  listSubjectRoleAssignments,
  loadTenantRoles,
  resolveSubjectRoles,
  invalidateSubjectRBACCache,
  bumpTenantRBACCacheVersion,
  roleAssignmentHolds,
  roleScopeTargetError,
  ensureDatabaseAdapter,
  rolePermissions,
  type TenantRBACDatabases,
  isUniqueConstraintError,
  countRoleAssignments,
  listRoleAssignmentsPage,
  MergedPageTooDeepError,
  DEFAULT_ROLES,
  isReservedAdminRoleName,
} from '@authrim/ar-lib-core';
import {
  accountStoreHolding,
  routedSubjectContacts,
  tenantRBACStores,
  type SubjectContacts,
  type TenantRBACStores,
} from './rbac-account-stores';
import { isInactiveAccountRouteError } from './account-route-errors';
import { recordAdminOperationAudit } from './admin-operation-audit';

/**
 * Hono context type with admin auth variable
 */
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/**
 * Convert timestamp to milliseconds for API response
 * Handles both seconds (10 digits) and milliseconds (13 digits) timestamps
 */
export function toMilliseconds(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  if (timestamp < 1e12) {
    return timestamp * 1000;
  }
  return timestamp;
}

/**
 * Get admin auth context from request
 */
function getAdminAuth(c: AdminContext): AdminAuthContext | null {
  return c.get('adminAuth') ?? null;
}

function getAdminAuthFromContext(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  return (c as unknown as AdminContext).get('adminAuth') ?? null;
}

/** A role's delegation tier: an integer from 1 to 3. */
function isValidGrantTier(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3;
}

function insufficientAdminPermissions(c: Context<{ Bindings: Env }>) {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
}

/** Removals made through the Admin API, audited with the request. */
function revocationContext(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  adapter: DatabaseAdapter
): RevocationContext {
  return {
    env: c.env,
    tenantId,
    adapter,
    log: getLogger(c).module('ADMIN-RBAC'),
    audit: (action, resource, resourceId, details, stable) =>
      createAuditLogFromContext(
        c,
        action,
        resource,
        resourceId,
        details,
        'info',
        stable?.id,
        stable?.at
      ),
    // The removal is done and answered; caches that cannot be dropped expire on their own.
    onCacheFailure: 'warn',
  };
}

/**
 * The databases of an account's RBAC: role and group definitions in the tenant metadata
 * database, the account's assignments and memberships in `account` (its account database, from
 * createAdaptersFromContext after the account was resolved).
 */
export function rbacDatabasesFromContext(
  c: Context<{ Bindings: Env }>,
  account: DatabaseAdapter
): TenantRBACDatabases {
  return {
    metadata: createAuthContextFromHono(c, getTenantIdFromContext(c)).coreAdapter,
    account,
  };
}

/**
 * Resolves the user's account (its databases) onto the request. False when the tenant has no
 * account for it.
 */
export async function resolveSubjectAccount(
  c: Context<{ Bindings: Env }>,
  subjectId: string
): Promise<boolean> {
  try {
    await resolveAccountDataContextFromHono(c, subjectId);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') return false;
    throw error;
  }
}

/**
 * The account database of the subject, for removing a role assignment or membership from it. An
 * active account is found through its route (resolved onto the request). A suspended or locked
 * one, which account routes refuse, is found in the tenant's user stores (the one holding its
 * account, whatever its type), so its access can still be taken away and does not come back when
 * it is activated again. Null when the tenant has no such account.
 */
export async function subjectAccountForRevocation(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  subjectId: string
): Promise<DatabaseAdapter | null> {
  try {
    if (!(await resolveSubjectAccount(c, subjectId))) return null;
    return createAdaptersFromContext(c).coreAdapter;
  } catch (error) {
    if (!isInactiveAccountRouteError(error)) throw error;
  }
  return accountStoreHolding(c.env, tenantId, subjectId);
}

/**
 * Create database adapters from context
 */
export function createAdaptersFromContext(c: Context<{ Bindings: Env }>): {
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter | null;
} {
  const tenantId = getTenantIdFromContext(c);
  const accountData = getAccountDataContextFromHono(c);
  const coreAdapter = accountData
    ? createAccountAuthContextFromHono(c, tenantId).coreAdapter
    : createAuthContextFromHono(c, tenantId).coreAdapter;
  const piiAdapter =
    accountData || hasPIIDatabase(c)
      ? createPIIContextFromHono(c, tenantId).defaultPiiAdapter
      : null;
  return { coreAdapter, piiAdapter };
}

function createRuntimeUserStore(
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  tenantId: string
): CanonicalRuntimeUserStore | null {
  if (!piiAdapter) {
    return null;
  }
  return new CanonicalRuntimeUserStore({ coreAdapter, piiAdapter, tenantId });
}

async function fetchRuntimeUserContactMap(
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  tenantId: string,
  userIds: string[]
): Promise<Map<string, { email: string | null; name: string | null }>> {
  const map = new Map<string, { email: string | null; name: string | null }>();
  const runtimeUsers = createRuntimeUserStore(coreAdapter, piiAdapter, tenantId);
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (!runtimeUsers || uniqueIds.length === 0) {
    return map;
  }
  await Promise.all(
    uniqueIds.map(async (id) => {
      const user = await runtimeUsers.findById(id, { includeInactive: true });
      if (user) {
        map.set(id, { email: user.email, name: user.name });
      }
    })
  );
  return map;
}

/** The contacts of a page of a tenant-wide list, each from the account's own databases. */
export async function subjectContacts(
  c: Context<{ Bindings: Env }>,
  stores: TenantRBACStores,
  tenantId: string,
  subjectIds: string[]
): Promise<SubjectContacts> {
  if (stores.routed) return routedSubjectContacts(c.env, tenantId, subjectIds);
  return fetchRuntimeUserContactMap(
    stores.metadata,
    createAdaptersFromContext(c).piiAdapter,
    tenantId,
    subjectIds
  );
}

const MAX_LIST_PAGE_SIZE = 100;

/** The page asked for: page from 1, limit from 1 to MAX_LIST_PAGE_SIZE (20 by default). */
export function listPage(c: Context<{ Bindings: Env }>): {
  page: number;
  limit: number;
  offset: number;
} {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.min(
    MAX_LIST_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('limit') || '20', 10) || 20)
  );
  return { page, limit, offset: (page - 1) * limit };
}

export function pageTooDeep(c: Context<{ Bindings: Env }>) {
  return c.json(
    {
      error: 'invalid_request',
      error_description:
        "This page is too deep to read across the tenant's account stores; ask for an earlier page",
    },
    400
  );
}

export async function runtimeUserExists(
  coreAdapter: DatabaseAdapter,
  piiAdapter: DatabaseAdapter | null,
  tenantId: string,
  userId: string
): Promise<boolean> {
  const runtimeUsers = createRuntimeUserStore(coreAdapter, piiAdapter, tenantId);
  if (!runtimeUsers) {
    return false;
  }
  return (await runtimeUsers.findById(userId)) !== null;
}

// =============================================================================
// Role Management
// =============================================================================

/**
 * GET /api/admin/roles
 * List all roles
 */
export async function adminRolesListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const stores = await tenantRBACStores(c, tenantId);
    // The roles are in the metadata database, their holders in every account database.
    const [roles, countMap] = await Promise.all([
      stores.metadata.query<Record<string, unknown>>(
        `SELECT id, tenant_id, name, display_name, description, permissions_json,
                is_system, role_type, grant_tier, created_at, updated_at
         FROM roles
         WHERE tenant_id = ?
         ORDER BY is_system DESC, role_type ASC, name ASC`,
        [tenantId]
      ),
      countRoleAssignments(stores.accounts, tenantId, { per: 'subject' }),
    ]);

    const formattedRoles = roles.map((role: Record<string, unknown>) => ({
      ...role,
      is_system: Boolean(role.is_system),
      created_at: toMilliseconds(role.created_at as number),
      updated_at: toMilliseconds(role.updated_at as number),
      assignment_count: countMap.get(role.id as string) || 0,
    }));

    return c.json({
      roles: formattedRoles,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin roles list error', { action: 'list_roles' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve roles',
      },
      500
    );
  }
}

/**
 * GET /api/admin/roles/:id
 * Get role details with its permissions
 */
export async function adminRoleGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const roleId = c.req.param('id')!;
    const stores = await tenantRBACStores(c, tenantId);
    const coreAdapter = stores.metadata;

    const role = await coreAdapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [roleId, tenantId]
    );

    if (!role) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Parse own permissions
    const ownPermissions: string[] = JSON.parse((role.permissions_json as string) || '[]');

    // Users with this role, in every account database
    const assignmentCount = (
      await countRoleAssignments(stores.accounts, tenantId, { per: 'subject', roleIds: [roleId] })
    ).get(roleId);

    return c.json({
      role: {
        ...role,
        is_system: Boolean(role.is_system),
        created_at: toMilliseconds(role.created_at as number),
        updated_at: toMilliseconds(role.updated_at as number),
        assignment_count: assignmentCount ?? 0,
        // Parsed permissions for easier frontend consumption
        added_permissions: ownPermissions,
        // Roles do not inherit: a role's effective permissions are its own.
        effective_permissions: ownPermissions,
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin role get error', { action: 'get_role' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve role',
      },
      500
    );
  }
}

// =============================================================================
// Role Assignment Management
// =============================================================================

/**
 * GET /api/admin/users/:id/roles
 * Get user's role assignments
 */
export async function adminUserRolesListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    await resolveAccountDataContextFromHono(c, userId);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, userId))) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Direct assignments only: these are the rows the DELETE endpoint accepts. Roles reached
    // through groups appear in the effective permissions view with their origin.
    const dbs = rbacDatabasesFromContext(c, coreAdapter);
    const directAssignments = await listSubjectRoleAssignments(dbs.account, tenantId, userId);
    const roleDefinitions = await loadTenantRoles(
      dbs.metadata,
      tenantId,
      directAssignments.map((assignment) => assignment.role_id)
    );
    const assignments = directAssignments.flatMap((assignment) => {
      const role = roleDefinitions.get(assignment.role_id);
      return role ? [{ assignment, role }] : [];
    });

    const formattedAssignments = assignments.map(({ assignment, role }) => ({
      id: assignment.id,
      role_id: assignment.role_id,
      role_name: role.name,
      role_display_name: role.display_name,
      is_system_role: Boolean(role.is_system),
      role_type: role.role_type,
      scope: assignment.scope_type,
      scope_target: assignment.scope_target,
      assigned_by: assignment.assigned_by,
      expires_at: assignment.expires_at ? toMilliseconds(assignment.expires_at) : null,
      created_at: toMilliseconds(assignment.created_at),
    }));

    return c.json({
      user_id: userId,
      roles: formattedAssignments,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin user roles list error', { action: 'list_user_roles' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve user roles',
      },
      500
    );
  }
}

/**
 * POST /api/admin/users/:id/roles
 * Assign a role to user
 */
export async function adminUserRoleAssignHandler(c: AdminContext) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    await resolveAccountDataContextFromHono(c as unknown as Context<{ Bindings: Env }>, userId);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(
      c as unknown as Context<{ Bindings: Env }>
    );
    const adminAuth = getAdminAuth(c);
    const body = await c.req.json<{
      role_id?: string;
      role_name?: string;
      scope?: string;
      scope_target?: string;
      expires_at?: number;
    }>();

    const { role_id, role_name, scope, scope_target, expires_at } = body;

    if (!role_id && !role_name) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Either role_id or role_name is required',
        },
        400
      );
    }

    if (adminAuth?.userId === userId) {
      return insufficientAdminPermissions(c as unknown as Context<{ Bindings: Env }>);
    }

    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, userId))) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Get role (by id or name), from the tenant metadata database; the assignment goes to the
    // user's account database (coreAdapter).
    const metadata = rbacDatabasesFromContext(
      c as unknown as Context<{ Bindings: Env }>,
      coreAdapter
    ).metadata;
    const role = await findTenantRole(
      metadata,
      tenantId,
      role_id ? { id: role_id } : { name: role_name! }
    );

    if (!role) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // 0 in SQLite/D1, false in PostgreSQL
    if (role.is_assignable === 0 || role.is_assignable === false) {
      return insufficientAdminPermissions(c as unknown as Context<{ Bindings: Env }>);
    }

    if (!mayManageEndUserRole(adminAuth, role)) {
      return insufficientAdminPermissions(c as unknown as Context<{ Bindings: Env }>);
    }

    const assignmentId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const assignmentScope = scope || 'global';
    const assignmentScopeTarget = scope_target || '';

    // The scope and target as readers read them (roleAssignmentHolds): none for global, empty or
    // this tenant for tenant, `group:<id>` of a group of the tenant, `resource:[<type>:]<id>`.
    const scopeError = roleScopeTargetError(assignmentScope, assignmentScopeTarget, tenantId);
    if (scopeError) {
      return c.json({ error: 'invalid_request', error_description: scopeError }, 400);
    }
    if (
      assignmentScope === 'group' &&
      !(await ensureDatabaseAdapter(metadata).queryOne<{ id: string }>(
        'SELECT id FROM "groups" WHERE tenant_id = ? AND id = ?',
        [tenantId, assignmentScopeTarget.slice('group:'.length)]
      ))
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'scope_target names no group of the tenant',
        },
        400
      );
    }

    // Check for duplicate assignment
    const existing = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM role_assignments
       WHERE tenant_id = ? AND subject_id = ? AND role_id = ? AND scope_type = ? AND scope_target = ?`,
      [tenantId, userId, role.id, assignmentScope, assignmentScopeTarget]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'This role assignment already exists',
        },
        409
      );
    }

    // Convert expires_at from milliseconds to seconds if provided
    const expiresAtSeconds = expires_at ? Math.floor(expires_at / 1000) : null;

    await coreAdapter.execute(
      `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, scope_type, scope_target, assigned_by, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assignmentId,
        tenantId,
        userId,
        role.id,
        assignmentScope,
        assignmentScopeTarget,
        adminAuth?.userId || 'system',
        expiresAtSeconds,
        now,
        now,
      ]
    );
    if (c.env.REBAC_CACHE) await invalidateSubjectRBACCache(c.env.REBAC_CACHE, tenantId, userId);

    return c.json(
      {
        success: true,
        message: 'Role assigned successfully',
        assignment: {
          id: assignmentId,
          subject_id: userId,
          role_id: role.id,
          role_name: role.name,
          scope: assignmentScope,
          scope_target: assignmentScopeTarget,
          assigned_by: adminAuth?.userId || 'system',
          expires_at: expires_at || null,
          created_at: toMilliseconds(now),
        },
      },
      201
    );
  } catch (error) {
    const log = getLogger(c as unknown as Context<{ Bindings: Env }>).module('ADMIN-RBAC');
    log.error('Admin user role assign error', { action: 'assign_user_role' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to assign role',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/users/:id/roles/:assignmentId
 * Remove a role assignment from user
 */
export async function adminUserRoleRemoveHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    const assignmentId = c.req.param('assignmentId')!;
    // The assignment is in the user's account database, suspended or not.
    const coreAdapter = await subjectAccountForRevocation(c, tenantId, userId);
    if (!coreAdapter) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }
    const adminAuth = getAdminAuthFromContext(c);

    if (adminAuth?.userId === userId) {
      return insufficientAdminPermissions(c);
    }

    // Check if assignment exists and belongs to this user (in the user's account database), and
    // the role it gives (in the tenant metadata database)
    const assigned = await coreAdapter.queryOne<{ id: string; role_id: string }>(
      `SELECT id, role_id FROM role_assignments
       WHERE tenant_id = ? AND id = ? AND subject_id = ?`,
      [tenantId, assignmentId, userId]
    );
    const role = assigned
      ? await findTenantRole(rbacDatabasesFromContext(c, coreAdapter).metadata, tenantId, {
          id: assigned.role_id,
        })
      : null;

    if (!assigned) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // An assignment of a role the tenant no longer has grants nothing: it can be removed without a
    // grant tier to check.
    if (role && !mayManageEndUserRole(adminAuth, role)) {
      return insufficientAdminPermissions(c);
    }

    await removeRoleAssignment(revocationContext(c, tenantId, coreAdapter), {
      userId,
      assignmentId,
    });

    return c.json({
      success: true,
      message: 'Role assignment removed successfully',
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin user role remove error', { action: 'remove_user_role' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to remove role assignment',
      },
      500
    );
  }
}

// =============================================================================
// Relationship Management
// =============================================================================

/**
 * Resolve the path user's account store. An unknown user has no account route, which is the
 * not-found the handler gives; any other failure is the handler's own error.
 */
async function resolveUserAccountStore(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<boolean> {
  try {
    await resolveAccountDataContextFromHono(c, userId);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') return false;
    throw error;
  }
}

function relationshipUserNotFound(c: Context<{ Bindings: Env }>) {
  return c.json(
    {
      error: 'not_found',
      error_description: 'The requested resource was not found',
    },
    404
  );
}

/**
 * Subject-to-subject types, named as the readers of `relationships` name them (acting-as
 * consent, the relationships claim, guardian approval resolution). A row runs from the
 * subject who acts (`from_id`: parent, guardian, delegate, manager) to the one acted for
 * (`to_id`). `reseller_of` is left out: it joins organisations, not users.
 */
const USER_RELATIONSHIP_TYPES: readonly string[] = [
  'parent_child',
  'guardian',
  'delegate',
  'manager',
];

/**
 * GET /api/admin/users/:id/relationships
 * Get user's relationships: outgoing (the user is `from_id`) and incoming (the user is `to_id`)
 */
export async function adminUserRelationshipsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    if (!(await resolveUserAccountStore(c, userId))) return relationshipUserNotFound(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const direction = c.req.query('direction'); // 'outgoing', 'incoming', or undefined for both

    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, userId))) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const outgoing: Record<string, unknown>[] = [];
    const incoming: Record<string, unknown>[] = [];

    // Get outgoing relationships (where user is the subject)
    // PII/Non-PII DB separation: Cannot JOIN, so fetch PII separately after getting relationships
    if (!direction || direction === 'outgoing') {
      const outgoingResult = await coreAdapter.query<Record<string, unknown>>(
        `SELECT r.*
         FROM relationships r
         WHERE r.tenant_id = ?
           AND r.from_type = 'subject'
           AND r.from_id = ?
           AND r.to_type = 'subject'
           AND (r.expires_at IS NULL OR r.expires_at > ?)
         ORDER BY r.created_at DESC`,
        [tenantId, userId, now]
      );

      // Fetch PII for related users from PII DB
      const relatedUserIds = [...new Set(outgoingResult.map((r) => r.to_id as string))];
      const relatedUserPIIMap = await fetchRuntimeUserContactMap(
        coreAdapter,
        piiAdapter,
        tenantId,
        relatedUserIds
      );

      for (const rel of outgoingResult) {
        const pii = relatedUserPIIMap.get(rel.to_id as string);
        outgoing.push({
          id: rel.id,
          relationship_type: rel.relationship_type,
          related_subject_id: rel.to_id,
          related_email: pii?.email || null,
          related_name: pii?.name || null,
          expires_at: rel.expires_at ? toMilliseconds(rel.expires_at as number) : null,
          created_at: toMilliseconds(rel.created_at as number),
        });
      }
    }

    // Get incoming relationships (where user is the related_subject)
    // PII/Non-PII DB separation: Cannot JOIN, so fetch PII separately after getting relationships
    if (!direction || direction === 'incoming') {
      const incomingResult = await coreAdapter.query<Record<string, unknown>>(
        `SELECT r.*
         FROM relationships r
         WHERE r.tenant_id = ?
           AND r.to_type = 'subject'
           AND r.to_id = ?
           AND r.from_type = 'subject'
           AND (r.expires_at IS NULL OR r.expires_at > ?)
         ORDER BY r.created_at DESC`,
        [tenantId, userId, now]
      );

      // Fetch PII for subject users from PII DB
      const subjectUserPIIMap = await fetchRuntimeUserContactMap(
        coreAdapter,
        piiAdapter,
        tenantId,
        incomingResult.map((r) => r.from_id as string)
      );

      for (const rel of incomingResult) {
        const pii = subjectUserPIIMap.get(rel.from_id as string);
        incoming.push({
          id: rel.id,
          relationship_type: rel.relationship_type,
          subject_id: rel.from_id,
          subject_email: pii?.email || null,
          subject_name: pii?.name || null,
          expires_at: rel.expires_at ? toMilliseconds(rel.expires_at as number) : null,
          created_at: toMilliseconds(rel.created_at as number),
        });
      }
    }

    return c.json({
      user_id: userId,
      outgoing_relationships: direction === 'incoming' ? undefined : outgoing,
      incoming_relationships: direction === 'outgoing' ? undefined : incoming,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error(
      'Admin user relationships list error',
      { action: 'list_user_relationships' },
      error as Error
    );
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve user relationships',
      },
      500
    );
  }
}

/**
 * POST /api/admin/users/:id/relationships
 * Create a relationship from user to another subject
 */
export async function adminUserRelationshipCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    const body = await c.req.json<{
      related_subject_id: string;
      relationship_type: string;
      expires_at?: number;
    }>();

    const { related_subject_id, relationship_type, expires_at } = body;

    if (!related_subject_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'related_subject_id is required',
        },
        400
      );
    }

    if (!relationship_type) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'relationship_type is required',
        },
        400
      );
    }

    if (!USER_RELATIONSHIP_TYPES.includes(relationship_type)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Invalid relationship_type. Must be one of: ${USER_RELATIONSHIP_TYPES.join(', ')}`,
        },
        400
      );
    }

    // A given expiry is a future instant in milliseconds; 0 or a past time would otherwise be
    // stored as no expiry, or as a relationship that never applied.
    if (
      expires_at !== undefined &&
      expires_at !== null &&
      (typeof expires_at !== 'number' ||
        !Number.isSafeInteger(expires_at) ||
        expires_at <= Date.now())
    ) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'expires_at must be a future time in milliseconds',
        },
        400
      );
    }

    // The row lives with the path user's account. The related user is looked up in the same
    // store, so a user kept in another account store is not found and nothing is written.
    if (!(await resolveUserAccountStore(c, userId))) return relationshipUserNotFound(c);
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, userId))) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, related_subject_id))) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Prevent self-relationship
    if (userId === related_subject_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Cannot create relationship with self',
        },
        400
      );
    }

    // Check for existing relationship
    const existing = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM relationships
       WHERE tenant_id = ? AND relationship_type = ?
         AND from_type = 'subject' AND from_id = ? AND to_type = 'subject' AND to_id = ?`,
      [tenantId, relationship_type, userId, related_subject_id]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'This relationship already exists',
        },
        409
      );
    }

    const relationshipId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = typeof expires_at === 'number' ? Math.floor(expires_at / 1000) : null;

    try {
      await coreAdapter.execute(
        `INSERT INTO relationships (
           id, tenant_id, relationship_type, from_type, from_id, to_type, to_id,
           expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'subject', ?, 'subject', ?, ?, ?, ?)`,
        [
          relationshipId,
          tenantId,
          relationship_type,
          userId,
          related_subject_id,
          expiresAtSeconds,
          now,
          now,
        ]
      );
    } catch (error) {
      // A concurrent create of the same tuple lost the race on the unique index.
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      return c.json(
        {
          error: 'conflict',
          error_description: 'This relationship already exists',
        },
        409
      );
    }
    // Relationship tuples share the ReBAC version: the policy service's cached results go.
    await bumpTenantReBACVersion(c, tenantId);

    return c.json(
      {
        success: true,
        message: 'Relationship created successfully',
        relationship: {
          id: relationshipId,
          subject_id: userId,
          related_subject_id,
          relationship_type,
          expires_at: expires_at || null,
          created_at: toMilliseconds(now),
        },
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error(
      'Admin user relationship create error',
      { action: 'create_user_relationship' },
      error as Error
    );
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create relationship',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/users/:id/relationships/:relationshipId
 * Delete a relationship
 */
export async function adminUserRelationshipDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    const relationshipId = c.req.param('relationshipId')!;
    if (!(await resolveUserAccountStore(c, userId))) return relationshipUserNotFound(c);
    const { coreAdapter } = createAdaptersFromContext(c);

    // Check if relationship exists and involves this user
    const relationship = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM relationships
       WHERE id = ? AND tenant_id = ?
         AND from_type = 'subject' AND to_type = 'subject'
         AND (from_id = ? OR to_id = ?)`,
      [relationshipId, tenantId, userId, userId]
    );

    if (!relationship) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    await coreAdapter.execute('DELETE FROM relationships WHERE id = ? AND tenant_id = ?', [
      relationshipId,
      tenantId,
    ]);
    await bumpTenantReBACVersion(c, tenantId);

    return c.json({
      success: true,
      message: 'Relationship deleted successfully',
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error(
      'Admin user relationship delete error',
      { action: 'delete_user_relationship' },
      error as Error
    );
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete relationship',
      },
      500
    );
  }
}

// =============================================================================
// Effective Permissions
// =============================================================================

/**
 * Effective permission entry
 */
interface EffectivePermission {
  permission: string;
  source: 'role';
  source_id: string | null;
  source_name: string | null;
  granted_at: number | null;
  expires_at: number | null;
}

/**
 * GET /api/admin/users/:id/effective-permissions
 * Get user's effective permissions
 *
 * As tokens carry them: the permissions of the user's unexpired roles assigned across the tenant
 * (global, or tenant in this tenant). Roles assigned for one group or on one resource are
 * listed with their scope; their permissions hold there only, so they are not counted here.
 */
export async function adminUserEffectivePermissionsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;

    if (!userId) {
      return c.json({ error: 'invalid_request', error_description: 'User ID is required' }, 400);
    }

    // The user's assignments and memberships are in its account database.
    if (!(await resolveSubjectAccount(c, userId))) {
      return c.json({ error: 'not_found', error_description: 'User not found' }, 404);
    }
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);

    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, userId))) {
      return c.json({ error: 'not_found', error_description: 'User not found' }, 404);
    }

    const dbs = rbacDatabasesFromContext(c, coreAdapter);
    const userRoles = await resolveSubjectRoles(dbs, tenantId, userId);

    const permissions: EffectivePermission[] = [];
    const seenPermissions = new Set<string>();
    for (const { assignment, role } of userRoles) {
      if (
        !roleAssignmentHolds(
          { scope: assignment.scope_type, scopeTarget: assignment.scope_target },
          { tenantId }
        )
      ) {
        continue;
      }
      for (const permission of rolePermissions(role)) {
        if (seenPermissions.has(permission)) continue;
        seenPermissions.add(permission);
        permissions.push({
          permission,
          source: 'role',
          source_id: role.id,
          source_name: role.name,
          granted_at: assignment.created_at,
          expires_at: assignment.expires_at,
        });
      }
    }

    // Group permissions by category
    const permissionsByCategory: Record<string, EffectivePermission[]> = {};
    for (const perm of permissions) {
      const category = perm.permission.split(':')[0] || 'other';
      if (!permissionsByCategory[category]) {
        permissionsByCategory[category] = [];
      }
      permissionsByCategory[category].push(perm);
    }

    return c.json({
      user_id: userId,
      permissions,
      by_category: permissionsByCategory,
      summary: {
        total_permissions: permissions.length,
        from_roles: permissions.filter((p) => p.source === 'role').length,
      },
      roles: userRoles.map(({ assignment, role }) => ({
        role_id: role.id,
        role_name: role.name,
        scope: assignment.scope_type,
        scope_target: assignment.scope_target,
        granted_at: toMilliseconds(assignment.created_at),
        expires_at: toMilliseconds(assignment.expires_at),
        via:
          assignment.via.kind === 'group'
            ? {
                kind: 'group' as const,
                group_id: assignment.via.groupId,
                through_group_id: assignment.via.throughGroupId,
              }
            : { kind: 'direct' as const },
      })),
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error(
      'Admin user effective permissions error',
      { action: 'get_effective_permissions' },
      error as Error
    );
    return c.json(
      { error: 'server_error', error_description: 'Failed to get effective permissions' },
      500
    );
  }
}

// =============================================================================
// Role Assignment Listing (by Role)
// =============================================================================

/**
 * GET /api/admin/roles/:id/assignments
 * Get users assigned to a specific role
 */
export async function adminRoleAssignmentsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const roleId = c.req.param('id')!;
    const { page, limit, offset } = listPage(c);
    const stores = await tenantRBACStores(c, tenantId);

    // Check if role exists
    const role = await findTenantRole(stores.metadata, tenantId, { id: roleId });

    if (!role) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // The assignments are in every account database; total counts assignments, as listed.
    const { total, items } = await listRoleAssignmentsPage(stores.accounts, tenantId, roleId, {
      activeAt: Math.floor(Date.now() / 1000),
      limit,
      offset,
    });
    const totalPages = Math.ceil(total / limit);
    const assignments = items.map(({ row }) => row);

    const userContactMap = await subjectContacts(
      c,
      stores,
      tenantId,
      assignments.map((a) => a.subject_id)
    );

    const formattedAssignments = assignments.map((a) => {
      const pii = userContactMap.get(a.subject_id);
      return {
        assignment_id: a.id,
        user_id: a.subject_id,
        user_email: pii?.email || null,
        user_name: pii?.name || null,
        scope: a.scope_type,
        scope_target: a.scope_target,
        assigned_by: a.assigned_by,
        expires_at: a.expires_at ? toMilliseconds(a.expires_at) : null,
        assigned_at: toMilliseconds(a.created_at),
      };
    });

    return c.json({
      role_id: roleId,
      role_name: role.name,
      assignments: formattedAssignments,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    if (error instanceof MergedPageTooDeepError) return pageTooDeep(c);
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error(
      'Admin role assignments list error',
      { action: 'list_role_assignments' },
      error as Error
    );
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve role assignments',
      },
      500
    );
  }
}

/**
 * GET /api/admin/roles/:id/group-assignments
 * The groups a role is granted to (the group role grants of the role in this tenant).
 * Metadata database only: the grants and the groups live there.
 */
export async function adminRoleGroupAssignmentsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const roleId = c.req.param('id')!;
    const { page, limit, offset } = listPage(c);
    // Roles and their group grants are in the metadata database alone: the account databases
    // are not resolved (an unreachable one must not break this list).
    const metadata = createAuthContextFromHono(c, tenantId).coreAdapter;

    const role = await findTenantRole(metadata, tenantId, { id: roleId });
    if (!role) {
      return c.json(
        { error: 'not_found', error_description: 'The requested resource was not found' },
        404
      );
    }

    const totalRow = await metadata.queryOne<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM group_role_assignments WHERE tenant_id = ? AND role_id = ?',
      [tenantId, roleId]
    );
    const total = Number(totalRow?.count ?? 0);
    const rows = await metadata.query<{
      id: string;
      group_id: string;
      group_key: string | null;
      group_display_name: string | null;
      scope_type: string;
      scope_target: string;
      expires_at: number | null;
      assigned_by: string | null;
      created_at: number;
    }>(
      `SELECT a.id, a.group_id, g.group_key AS group_key, g.display_name AS group_display_name,
              a.scope_type, a.scope_target, a.expires_at, a.assigned_by, a.created_at
         FROM group_role_assignments a
         LEFT JOIN "groups" g ON g.tenant_id = a.tenant_id AND g.id = a.group_id
        WHERE a.tenant_id = ? AND a.role_id = ?
        ORDER BY a.created_at ASC, a.id ASC
        LIMIT ? OFFSET ?`,
      [tenantId, roleId, limit, offset]
    );
    const totalPages = Math.ceil(total / limit);

    return c.json({
      role_id: roleId,
      role_name: role.name,
      group_assignments: rows.map((row) => ({
        assignment_id: row.id,
        group_id: row.group_id,
        group_key: row.group_key,
        group_display_name: row.group_display_name,
        scope: row.scope_type,
        scope_target: row.scope_target,
        assigned_by: row.assigned_by,
        expires_at: row.expires_at ? toMilliseconds(row.expires_at) : null,
        assigned_at: toMilliseconds(row.created_at),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error(
      'Admin role group assignments list error',
      { action: 'list_role_group_assignments' },
      error as Error
    );
    return c.json(
      { error: 'server_error', error_description: 'Failed to retrieve role group assignments' },
      500
    );
  }
}

// =============================================================================
// Phase 3: Custom Role Creation
// =============================================================================

/**
 * POST /api/admin/roles
 * Create a custom role with specified permissions
 */
export async function adminRoleCreateHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const log = getLogger(c).module('ADMIN-RBAC');

  try {
    const body = await c.req.json<{
      name: string;
      display_name?: unknown;
      description?: string;
      permissions: string[];
      grant_tier?: unknown;
    }>();
    const adminAuth = getAdminAuthFromContext(c);

    // The display name is optional text; empty counts as none.
    if (
      body.display_name !== undefined &&
      body.display_name !== null &&
      (typeof body.display_name !== 'string' || body.display_name.length > 100)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'display_name',
          reason: 'display_name must be a string of at most 100 characters',
        },
      });
    }
    const displayName =
      typeof body.display_name === 'string' && body.display_name.trim()
        ? body.display_name.trim()
        : null;

    // Validate name
    if (!body.name || body.name.length < 2 || body.name.length > 50) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'name', reason: 'Name must be between 2 and 50 characters' },
      });
    }

    // Validate name format (alphanumeric, underscore, dash)
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(body.name)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'name',
          reason:
            'Name must start with a letter and contain only letters, numbers, underscores, and dashes',
        },
      });
    }

    // The preset roles cannot be created, and the `ar_` prefix belongs to the Admin roles of the
    // people who run Authrim, so a role of the service's users must not look like one of them.
    const presetRoles: string[] = Object.values(DEFAULT_ROLES);
    if (presetRoles.includes(body.name.toLowerCase()) || isReservedAdminRoleName(body.name)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'name', reason: 'Cannot create system roles' },
      });
    }

    // Validate permissions
    if (!body.permissions || !Array.isArray(body.permissions) || body.permissions.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'permissions' },
      });
    }

    // Validate permission format
    const validPermissionPattern = /^[a-z]+:[a-z_]+$/;
    const invalidPermissions = body.permissions.filter((p) => !validPermissionPattern.test(p));
    if (invalidPermissions.length > 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'permissions',
          reason: `Invalid permission format: ${invalidPermissions.slice(0, 3).join(', ')}`,
        },
      });
    }

    const { coreAdapter: adapter } = createAdaptersFromContext(c);
    // A new role has the lowest grant tier (1) unless one is asked for, and the caller can grant
    // only a tier up to its own.
    const grantTier = body.grant_tier === undefined ? 1 : body.grant_tier;
    if (!isValidGrantTier(grantTier)) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'grant_tier', reason: 'grant_tier must be an integer from 1 to 3' },
      });
    }
    if (!mayManageEndUserRole(adminAuth, { grant_tier: grantTier })) {
      return insufficientAdminPermissions(c);
    }

    // Check if role name already exists
    const existingRole = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM roles WHERE tenant_id = ? AND name = ?',
      [tenantId, body.name]
    );

    if (existingRole) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'name', reason: 'A role with this name already exists' },
      });
    }

    const roleId = generateId();
    const nowTs = Date.now();

    // Create the role
    await adapter.execute(
      `INSERT INTO roles (
         id, tenant_id, name, display_name, description, permissions_json, role_type,
         is_assignable, is_system, grant_tier, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        roleId,
        tenantId,
        body.name,
        displayName,
        body.description ?? null,
        JSON.stringify(body.permissions),
        'custom',
        1,
        0,
        grantTier,
        nowTs,
        nowTs,
      ]
    );

    // Write audit log
    await recordAdminOperationAudit(c, {
      action: 'role.created',
      resourceType: 'role',
      resourceId: roleId,
      metadata: {
        name: body.name,
        permission_count: body.permissions.length,
        grant_tier: grantTier,
      },
    });

    log.info('Role created', { action: 'role_create', roleId, name: body.name });

    return c.json(
      {
        role_id: roleId,
        name: body.name,
        display_name: displayName,
        description: body.description ?? null,
        permissions: body.permissions,
        grant_tier: grantTier,
        is_system: false,
        created_at: new Date(nowTs).toISOString(),
      },
      201
    );
  } catch (error) {
    log.error('Admin role create error', { action: 'role_create' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to create role' }, 500);
  }
}

/**
 * PATCH /api/admin/roles/:id
 * Update a custom role (description and/or permissions)
 */
export async function adminRoleUpdateHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const roleId = c.req.param('id')!;
  const log = getLogger(c).module('ADMIN-RBAC');

  try {
    const body = await c.req.json<{
      description?: string;
      permissions?: string[];
      grant_tier?: unknown;
    }>();
    const adminAuth = getAdminAuthFromContext(c);

    const { coreAdapter: adapter } = createAdaptersFromContext(c);

    // Get the existing role
    const existingRole = await adapter.queryOne<{
      id: string;
      name: string;
      description: string | null;
      permissions_json: string;
      is_system: number;
      role_type: string | null;
      grant_tier: number;
    }>(
      `SELECT id, name, description, permissions_json, is_system, role_type, grant_tier
       FROM roles WHERE tenant_id = ? AND id = ?`,
      [tenantId, roleId]
    );

    if (!existingRole) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'role', id: roleId },
      });
    }

    // Check if role can be edited (only custom roles can be edited)
    if (
      existingRole.is_system === 1 ||
      existingRole.role_type === 'system' ||
      existingRole.role_type === 'builtin'
    ) {
      return c.json(
        { error: 'forbidden', error_description: 'System and builtin roles cannot be modified' },
        403
      );
    }

    if (!mayManageEndUserRole(adminAuth, existingRole)) {
      return insufficientAdminPermissions(c);
    }

    // A new grant tier must be valid, and one the caller may grant (the role's current tier was
    // checked above).
    if (body.grant_tier !== undefined) {
      if (!isValidGrantTier(body.grant_tier)) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'grant_tier', reason: 'grant_tier must be an integer from 1 to 3' },
        });
      }
      if (!mayManageEndUserRole(adminAuth, { grant_tier: body.grant_tier })) {
        return insufficientAdminPermissions(c);
      }
    }

    // Validate permissions if provided
    if (body.permissions !== undefined) {
      if (!Array.isArray(body.permissions) || body.permissions.length === 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
          variables: { field: 'permissions' },
        });
      }

      // Validate permission format
      const validPermissionPattern = /^[a-z]+:[a-z_]+$/;
      const invalidPermissions = body.permissions.filter((p) => !validPermissionPattern.test(p));
      if (invalidPermissions.length > 0) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: {
            field: 'permissions',
            reason: `Invalid permission format: ${invalidPermissions.slice(0, 3).join(', ')}`,
          },
        });
      }
    }

    const nowTs = Date.now();
    const updates: string[] = ['updated_at = ?'];
    const bindings: unknown[] = [nowTs];

    if (body.description !== undefined) {
      updates.push('description = ?');
      bindings.push(body.description || null);
    }

    if (body.permissions !== undefined) {
      updates.push('permissions_json = ?');
      bindings.push(JSON.stringify(body.permissions));
    }

    if (body.grant_tier !== undefined) {
      updates.push('grant_tier = ?');
      bindings.push(body.grant_tier);
    }

    // Add WHERE clause bindings: only the role as it was checked (its grant tier decides who may
    // change it), so a tier changed since by another administrator is not overwritten.
    bindings.push(tenantId, roleId, existingRole.grant_tier);

    const updated = await adapter.execute(
      `UPDATE roles SET ${updates.join(', ')}
        WHERE tenant_id = ? AND id = ? AND grant_tier = ?`,
      bindings
    );
    if (!updated.rowsAffected) {
      return c.json(
        {
          error: 'role_version_conflict',
          error_description: 'Role changed since it was read. Try again.',
        },
        409
      );
    }
    // Every subject holding the role (directly or through a group) carries its permissions.
    if (body.permissions !== undefined && c.env.REBAC_CACHE)
      await bumpTenantRBACCacheVersion(c.env.REBAC_CACHE, tenantId);

    // Write audit log
    await recordAdminOperationAudit(c, {
      action: 'role.updated',
      resourceType: 'role',
      resourceId: roleId,
      metadata: {
        name: existingRole.name,
        description_changed: body.description !== undefined,
        permissions_changed: body.permissions !== undefined,
        new_permission_count: body.permissions?.length,
        grant_tier_changed: body.grant_tier !== undefined,
      },
    });

    log.info('Role updated', { action: 'role_update', roleId, name: existingRole.name });

    // Return updated role
    const updatedPermissions =
      body.permissions ?? JSON.parse(existingRole.permissions_json || '[]');

    return c.json({
      role_id: roleId,
      name: existingRole.name,
      description: body.description !== undefined ? body.description : existingRole.description,
      permissions: updatedPermissions,
      grant_tier: body.grant_tier ?? existingRole.grant_tier,
      is_system: false,
      updated_at: new Date(nowTs).toISOString(),
    });
  } catch (error) {
    log.error('Admin role update error', { action: 'role_update', roleId }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to update role' }, 500);
  }
}

/**
 * DELETE /api/admin/roles/:id
 * Delete a custom role (only if no users are assigned)
 */
export async function adminRoleDeleteHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const roleId = c.req.param('id')!;
  const log = getLogger(c).module('ADMIN-RBAC');

  try {
    const stores = await tenantRBACStores(c, tenantId);
    const adapter = stores.metadata;

    // Get the existing role
    const existingRole = await adapter.queryOne<{
      id: string;
      name: string;
      is_system: number;
      role_type: string | null;
      grant_tier: number;
    }>(
      'SELECT id, name, is_system, role_type, grant_tier FROM roles WHERE tenant_id = ? AND id = ?',
      [tenantId, roleId]
    );

    if (!existingRole) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'role', id: roleId },
      });
    }

    if (!mayManageEndUserRole(getAdminAuthFromContext(c), existingRole)) {
      return insufficientAdminPermissions(c);
    }

    // Check if role can be deleted (only custom roles can be deleted)
    if (
      existingRole.is_system === 1 ||
      existingRole.role_type === 'system' ||
      existingRole.role_type === 'builtin'
    ) {
      return c.json(
        { error: 'forbidden', error_description: 'System and builtin roles cannot be deleted' },
        403
      );
    }

    // Refused while any user is assigned the role (expired or not), in any account database.
    // An assignment made after this check (no transaction spans the databases) names a role
    // that no longer exists, and grants nothing: readers ignore it.
    const assignedUsers =
      (
        await countRoleAssignments(stores.accounts, tenantId, {
          per: 'subject',
          roleIds: [roleId],
        })
      ).get(roleId) ?? 0;

    if (assignedUsers > 0) {
      return c.json(
        {
          error: 'role_in_use',
          error_description: `Cannot delete role: ${assignedUsers} user(s) are still assigned to this role. Remove all assignments first.`,
        },
        409
      );
    }

    // Delete the role
    // Only the role as it was checked (its grant tier decides who may delete it).
    const removed = await adapter.execute(
      `DELETE FROM roles WHERE tenant_id = ? AND id = ? AND grant_tier = ? AND NOT EXISTS (
        SELECT 1 FROM group_role_assignments WHERE tenant_id = ? AND role_id = ?
      )`,
      [tenantId, roleId, existingRole.grant_tier, tenantId, roleId]
    );
    if (!removed.rowsAffected) {
      // Say why the guarded delete matched nothing: the role is gone, its tier changed since it
      // was read, or a group (or, meanwhile, a user) has it.
      const current = await adapter.queryOne<{ grant_tier: number }>(
        'SELECT grant_tier FROM roles WHERE tenant_id = ? AND id = ?',
        [tenantId, roleId]
      );
      if (!current) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'role', id: roleId },
        });
      }
      if (Number(current.grant_tier) !== Number(existingRole.grant_tier)) {
        return c.json(
          {
            error: 'role_version_conflict',
            error_description: 'Role changed since it was read. Try again.',
          },
          409
        );
      }
      return c.json(
        {
          error: 'role_in_use',
          error_description: 'Cannot delete role: it is still granted to a group.',
        },
        409
      );
    }

    // Write audit log
    await recordAdminOperationAudit(c, {
      action: 'role.deleted',
      resourceType: 'role',
      resourceId: roleId,
      metadata: {
        name: existingRole.name,
      },
    });

    log.info('Role deleted', { action: 'role_delete', roleId, name: existingRole.name });

    return c.json({ success: true, message: `Role '${existingRole.name}' has been deleted` });
  } catch (error) {
    log.error('Admin role delete error', { action: 'role_delete', roleId }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete role' }, 500);
  }
}

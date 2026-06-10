/**
 * RBAC Admin API Endpoints
 *
 * Phase 1 RBAC implementation for administrative dashboard:
 * - Organization management
 * - Role management (read-only for system roles)
 * - Role assignment management
 * - Relationship management (parent-child between subjects)
 *
 * All endpoints require admin authentication via adminAuthMiddleware()
 */

import { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  getTenantIdFromContext,
  createAuthContextFromHono,
  createPIIContextFromHono,
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
  hasAdminPermission,
} from '@authrim/ar-lib-core';

/**
 * Hono context type with admin auth variable
 */
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
type MembershipType = 'member' | 'admin' | 'owner';
const VALID_MEMBERSHIP_TYPES = new Set<MembershipType>(['member', 'admin', 'owner']);

/**
 * Convert timestamp to milliseconds for API response
 * Handles both seconds (10 digits) and milliseconds (13 digits) timestamps
 */
function toMilliseconds(timestamp: number | null | undefined): number | null {
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

function getNumericHierarchyLevel(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function hasMachineFullAdminBypass(authContext: AdminAuthContext | null): boolean {
  if (authContext?.authMethod !== 'machine_access_token') {
    return false;
  }
  const permissions = authContext.permissions ?? [];
  return (
    hasAdminPermission(permissions, ADMIN_PERMISSIONS.ALL) ||
    permissions.some((permission) => permission === 'admin:*')
  );
}

function canManageRoleHierarchy(
  authContext: AdminAuthContext | null,
  targetHierarchyLevel: unknown
): boolean {
  if (hasMachineFullAdminBypass(authContext)) {
    return true;
  }

  if (authContext?.hierarchyLevel === undefined) {
    return false;
  }

  return getNumericHierarchyLevel(targetHierarchyLevel) < authContext.hierarchyLevel;
}

function insufficientAdminPermissions(c: Context<{ Bindings: Env }>) {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
}

function normalizeMembershipType(value: unknown): MembershipType | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (VALID_MEMBERSHIP_TYPES.has(value as MembershipType)) {
    return value as MembershipType;
  }

  return null;
}

/**
 * Create database adapters from context
 */
function createAdaptersFromContext(c: Context<{ Bindings: Env }>): {
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter | null;
} {
  const tenantId = getTenantIdFromContext(c);
  const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
  const piiAdapter = hasPIIDatabase(c)
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

async function runtimeUserExists(
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
// Organization Management
// =============================================================================

/**
 * GET /api/admin/organizations
 * List organizations with pagination and filtering
 */
export async function adminOrganizationsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const search = c.req.query('search') || '';
    const isActive = c.req.query('is_active'); // 'true', 'false', or undefined
    const plan = c.req.query('plan');
    const orgType = c.req.query('org_type');

    const offset = (page - 1) * limit;

    // Build query - tenant_id is always first for index usage
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    // Search filter (name or display_name)
    // Escape special LIKE characters (%, _) to prevent unintended wildcards
    if (search) {
      const escapedSearch = escapeLikePattern(search);
      whereClauses.push("(name LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')");
      bindings.push(`%${escapedSearch}%`, `%${escapedSearch}%`);
    }

    // Active status filter
    if (isActive !== undefined) {
      whereClauses.push('is_active = ?');
      bindings.push(isActive === 'true' ? 1 : 0);
    }

    // Plan filter
    if (plan) {
      whereClauses.push('plan = ?');
      bindings.push(plan);
    }

    // Org type filter
    if (orgType) {
      whereClauses.push('org_type = ?');
      bindings.push(orgType);
    }

    const whereClause = ' WHERE ' + whereClauses.join(' AND ');
    const countQuery = 'SELECT COUNT(*) as count FROM organizations' + whereClause;
    let query = 'SELECT * FROM organizations' + whereClause;

    // Order and pagination
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    // Execute queries in parallel
    const countBindings = [...bindings];
    const queryBindings = [...bindings, limit, offset];

    const [totalResult, organizations] = await Promise.all([
      coreAdapter.queryOne<{ count: number }>(countQuery, countBindings),
      coreAdapter.query<Record<string, unknown>>(query, queryBindings),
    ]);

    const total = totalResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    // Format organizations with boolean conversions and millisecond timestamps
    const formattedOrgs = organizations.map((org: Record<string, unknown>) => ({
      ...org,
      is_active: Boolean(org.is_active),
      created_at: toMilliseconds(org.created_at as number),
      updated_at: toMilliseconds(org.updated_at as number),
    }));

    return c.json({
      organizations: formattedOrgs,
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
    log.error('Admin organizations list error', { action: 'list_organizations' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve organizations',
      },
      500
    );
  }
}

/**
 * GET /api/admin/organizations/:id
 * Get organization details by ID
 */
export async function adminOrganizationGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const orgId = c.req.param('id')!;

    // Execute queries in parallel
    const [org, memberCount] = await Promise.all([
      coreAdapter.queryOne<Record<string, unknown>>(
        'SELECT * FROM organizations WHERE tenant_id = ? AND id = ?',
        [tenantId, orgId]
      ),
      coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM subject_org_membership WHERE tenant_id = ? AND org_id = ?',
        [tenantId, orgId]
      ),
    ]);

    if (!org) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Format organization
    const formattedOrg = {
      ...org,
      is_active: Boolean(org.is_active),
      created_at: toMilliseconds(org.created_at as number),
      updated_at: toMilliseconds(org.updated_at as number),
      member_count: memberCount?.count || 0,
    };

    return c.json({
      organization: formattedOrg,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin organization get error', { action: 'get_organization' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve organization',
      },
      500
    );
  }
}

/**
 * POST /api/admin/organizations
 * Create a new organization
 */
export async function adminOrganizationCreateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json<{
      name: string;
      display_name?: string;
      plan?: string;
      org_type?: string;
      metadata_json?: string;
    }>();

    const { name, display_name, plan, org_type, metadata_json } = body;

    if (!name) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Organization name is required',
        },
        400
      );
    }

    // Check if organization with same name already exists
    const existing = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND name = ?',
      [tenantId, name]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'Organization with this name already exists',
        },
        409
      );
    }

    const orgId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000); // UNIX seconds

    // Validate plan
    const validPlans = ['free', 'starter', 'professional', 'enterprise'];
    const orgPlan = plan && validPlans.includes(plan) ? plan : 'free';

    // Validate org_type
    const validOrgTypes = ['personal', 'team', 'enterprise', 'partner'];
    const orgTypeValue = org_type && validOrgTypes.includes(org_type) ? org_type : 'team';

    await coreAdapter.execute(
      `INSERT INTO organizations (id, tenant_id, name, display_name, plan, org_type, is_active, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        orgId,
        tenantId,
        name,
        display_name || name,
        orgPlan,
        orgTypeValue,
        metadata_json || null,
        now,
        now,
      ]
    );

    // Get created organization
    const org = await coreAdapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM organizations WHERE tenant_id = ? AND id = ?',
      [tenantId, orgId]
    );

    return c.json(
      {
        organization: {
          ...org,
          is_active: Boolean(org?.is_active),
          created_at: toMilliseconds(org?.created_at as number),
          updated_at: toMilliseconds(org?.updated_at as number),
        },
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin organization create error', { action: 'create_organization' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create organization',
      },
      500
    );
  }
}

/**
 * PUT /api/admin/organizations/:id
 * Update organization
 */
export async function adminOrganizationUpdateHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const orgId = c.req.param('id')!;
    const body = await c.req.json<{
      name?: string;
      display_name?: string;
      plan?: string;
      org_type?: string;
      is_active?: boolean;
      metadata_json?: string;
    }>();

    // Check if organization exists
    const org = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND id = ?',
      [tenantId, orgId]
    );

    if (!org) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const now = Math.floor(Date.now() / 1000); // UNIX seconds
    const updates: string[] = [];
    const bindings: unknown[] = [];

    // Build update query
    if (body.name !== undefined) {
      updates.push('name = ?');
      bindings.push(body.name);
    }
    if (body.display_name !== undefined) {
      updates.push('display_name = ?');
      bindings.push(body.display_name);
    }
    if (body.plan !== undefined) {
      const validPlans = ['free', 'starter', 'professional', 'enterprise'];
      if (!validPlans.includes(body.plan)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid plan. Must be one of: ${validPlans.join(', ')}`,
          },
          400
        );
      }
      updates.push('plan = ?');
      bindings.push(body.plan);
    }
    if (body.org_type !== undefined) {
      const validOrgTypes = ['personal', 'team', 'enterprise', 'partner'];
      if (!validOrgTypes.includes(body.org_type)) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: `Invalid org_type. Must be one of: ${validOrgTypes.join(', ')}`,
          },
          400
        );
      }
      updates.push('org_type = ?');
      bindings.push(body.org_type);
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      bindings.push(body.is_active ? 1 : 0);
    }
    if (body.metadata_json !== undefined) {
      updates.push('metadata_json = ?');
      bindings.push(body.metadata_json);
    }

    // Always update updated_at
    updates.push('updated_at = ?');
    bindings.push(now);

    if (updates.length === 1) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'No fields to update',
        },
        400
      );
    }

    // Execute update
    bindings.push(tenantId, orgId);
    await coreAdapter.execute(
      `UPDATE organizations SET ${updates.join(', ')} WHERE tenant_id = ? AND id = ?`,
      bindings
    );

    // Get updated organization
    const updatedOrg = await coreAdapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM organizations WHERE tenant_id = ? AND id = ?',
      [tenantId, orgId]
    );

    return c.json({
      organization: {
        ...updatedOrg,
        is_active: Boolean(updatedOrg?.is_active),
        created_at: toMilliseconds(updatedOrg?.created_at as number),
        updated_at: toMilliseconds(updatedOrg?.updated_at as number),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin organization update error', { action: 'update_organization' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to update organization',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/organizations/:id
 * Delete organization (soft delete by setting is_active = 0)
 */
export async function adminOrganizationDeleteHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const orgId = c.req.param('id')!;

    // Check if organization exists
    const org = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND id = ?',
      [tenantId, orgId]
    );

    if (!org) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Soft delete by deactivating
    const now = Math.floor(Date.now() / 1000);
    await coreAdapter.execute(
      'UPDATE organizations SET is_active = 0, updated_at = ? WHERE tenant_id = ? AND id = ?',
      [now, tenantId, orgId]
    );

    return c.json({
      success: true,
      message: 'Organization deactivated successfully',
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin organization delete error', { action: 'delete_organization' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete organization',
      },
      500
    );
  }
}

/**
 * GET /api/admin/organizations/:id/members
 * List organization members
 */
export async function adminOrganizationMembersListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const orgId = c.req.param('id')!;
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = (page - 1) * limit;

    // Check if organization exists
    const org = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE tenant_id = ? AND id = ?',
      [tenantId, orgId]
    );

    if (!org) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Execute queries in parallel
    // PII/Non-PII DB separation: Cannot JOIN, so fetch PII separately after getting membership
    const [totalResult, members] = await Promise.all([
      coreAdapter.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM subject_org_membership WHERE tenant_id = ? AND org_id = ?',
        [tenantId, orgId]
      ),
      coreAdapter.query<Record<string, unknown>>(
        `SELECT m.subject_id, m.org_id, m.membership_type, m.is_primary, m.created_at
         FROM subject_org_membership m
         WHERE m.tenant_id = ? AND m.org_id = ?
         ORDER BY m.created_at DESC
         LIMIT ? OFFSET ?`,
        [tenantId, orgId, limit, offset]
      ),
    ]);

    const total = totalResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    // Fetch PII for member users from PII DB
    const memberPIIMap = await fetchRuntimeUserContactMap(
      coreAdapter,
      piiAdapter,
      tenantId,
      members.map((m) => m.subject_id as string)
    );

    const formattedMembers = members.map((m: Record<string, unknown>) => {
      const pii = memberPIIMap.get(m.subject_id as string);
      return {
        subject_id: m.subject_id,
        org_id: m.org_id,
        membership_type: m.membership_type,
        is_primary: Boolean(m.is_primary),
        joined_at: toMilliseconds(m.created_at as number),
        user_email: pii?.email || null,
        user_name: pii?.name || null,
      };
    });

    return c.json({
      members: formattedMembers,
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
      'Admin organization members list error',
      { action: 'list_org_members' },
      error as Error
    );
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve organization members',
      },
      500
    );
  }
}

/**
 * POST /api/admin/organizations/:id/members
 * Add member to organization
 */
export async function adminOrganizationMemberAddHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const orgId = c.req.param('id')!;
    const body = await c.req.json<{
      subject_id: string;
      membership_type?: MembershipType;
      org_role?: string;
      is_primary?: boolean;
    }>();

    const { subject_id, is_primary } = body;

    if (!subject_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'subject_id is required',
        },
        400
      );
    }

    const membershipType =
      normalizeMembershipType(body.membership_type) ??
      normalizeMembershipType(body.org_role) ??
      'member';

    if (
      body.membership_type !== undefined &&
      normalizeMembershipType(body.membership_type) === null
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'membership_type',
          reason: 'Must be one of: member, admin, owner',
        },
      });
    }

    if (body.membership_type === undefined && body.org_role !== undefined) {
      if (normalizeMembershipType(body.org_role) === null) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: {
            field: 'membership_type',
            reason: 'Must be one of: member, admin, owner',
          },
        });
      }
    }

    // Check if organization exists
    const org = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE id = ? AND tenant_id = ?',
      [orgId, tenantId]
    );

    if (!org) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, subject_id))) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Check if membership already exists
    const existing = await coreAdapter.queryOne<{ subject_id: string }>(
      `SELECT subject_id FROM subject_org_membership
       WHERE tenant_id = ? AND org_id = ? AND subject_id = ?`,
      [tenantId, orgId, subject_id]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'User is already a member of this organization',
        },
        409
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const primary = is_primary ? 1 : 0;
    const membershipId = generateId();

    // If setting as primary, unset other primary memberships for this user
    if (primary) {
      await coreAdapter.execute(
        `UPDATE subject_org_membership
         SET is_primary = 0, updated_at = ?
         WHERE tenant_id = ? AND subject_id = ?`,
        [now, tenantId, subject_id]
      );
    }

    await coreAdapter.execute(
      `INSERT INTO subject_org_membership (
        id, tenant_id, subject_id, org_id, membership_type, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [membershipId, tenantId, subject_id, orgId, membershipType, primary, now, now]
    );

    return c.json(
      {
        success: true,
        message: 'Member added to organization',
        membership: {
          id: membershipId,
          tenant_id: tenantId,
          org_id: orgId,
          subject_id,
          membership_type: membershipType,
          is_primary: Boolean(primary),
          created_at: toMilliseconds(now),
          updated_at: toMilliseconds(now),
        },
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error('Admin organization member add error', { action: 'add_org_member' }, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to add member to organization',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/organizations/:id/members/:subjectId
 * Remove member from organization
 */
export async function adminOrganizationMemberRemoveHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const orgId = c.req.param('id')!;
    const subjectId = c.req.param('subjectId')!;

    // Check if membership exists
    const membership = await coreAdapter.queryOne<{ subject_id: string }>(
      `SELECT subject_id FROM subject_org_membership
       WHERE tenant_id = ? AND org_id = ? AND subject_id = ?`,
      [tenantId, orgId, subjectId]
    );

    if (!membership) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    await coreAdapter.execute(
      'DELETE FROM subject_org_membership WHERE tenant_id = ? AND org_id = ? AND subject_id = ?',
      [tenantId, orgId, subjectId]
    );

    return c.json({
      success: true,
      message: 'Member removed from organization',
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error(
      'Admin organization member remove error',
      { action: 'remove_org_member' },
      error as Error
    );
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to remove member from organization',
      },
      500
    );
  }
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
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const roles = await coreAdapter.query<Record<string, unknown>>(
      `SELECT id, tenant_id, name, display_name, description, permissions_json,
              is_system, role_type, parent_role_id, created_at, updated_at
       FROM roles
       WHERE tenant_id = ?
       ORDER BY is_system DESC, role_type ASC, name ASC`,
      [tenantId]
    );

    // Get assignment counts for all roles
    const assignmentCounts = await coreAdapter.query<{ role_id: string; count: number }>(
      `SELECT role_id, COUNT(DISTINCT subject_id) as count
       FROM role_assignments
       WHERE tenant_id = ?
       GROUP BY role_id`,
      [tenantId]
    );
    const countMap = new Map(assignmentCounts.map((r) => [r.role_id, r.count]));

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
 * Get role details with effective permissions (including inherited)
 */
export async function adminRoleGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const roleId = c.req.param('id')!;

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

    // Calculate effective permissions (including inherited from parent role)
    let effectivePermissions = [...ownPermissions];
    let parentRole: Record<string, unknown> | null = null;

    if (role.parent_role_id) {
      parentRole = await coreAdapter.queryOne<Record<string, unknown>>(
        'SELECT id, name, display_name, permissions_json FROM roles WHERE id = ? AND tenant_id = ?',
        [role.parent_role_id as string, tenantId]
      );
      if (parentRole) {
        const parentPermissions: string[] = JSON.parse(
          (parentRole.permissions_json as string) || '[]'
        );
        // Merge permissions (parent + own, deduplicated)
        effectivePermissions = [...new Set([...parentPermissions, ...ownPermissions])];
      }
    }

    // Get count of users with this role
    const assignmentCount = await coreAdapter.queryOne<{ count: number }>(
      'SELECT COUNT(DISTINCT subject_id) as count FROM role_assignments WHERE tenant_id = ? AND role_id = ?',
      [tenantId, roleId]
    );

    return c.json({
      role: {
        ...role,
        is_system: Boolean(role.is_system),
        created_at: toMilliseconds(role.created_at as number),
        updated_at: toMilliseconds(role.updated_at as number),
        assignment_count: assignmentCount?.count || 0,
        // Parsed permissions for easier frontend consumption
        added_permissions: ownPermissions,
        effective_permissions: effectivePermissions,
        parent_role: parentRole
          ? {
              id: parentRole.id,
              name: parentRole.name,
              display_name: parentRole.display_name,
            }
          : null,
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
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;

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

    // Get active role assignments with role info
    const assignments = await coreAdapter.query<Record<string, unknown>>(
      `SELECT ra.*, r.name as role_name, r.display_name as role_display_name,
              r.is_system, r.role_type
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND ra.tenant_id = ?
         AND r.tenant_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       ORDER BY r.name ASC`,
      [userId, tenantId, tenantId, now]
    );

    const formattedAssignments = assignments.map((a: Record<string, unknown>) => ({
      id: a.id,
      role_id: a.role_id,
      role_name: a.role_name,
      role_display_name: a.role_display_name,
      is_system_role: Boolean(a.is_system),
      role_type: a.role_type,
      scope: a.scope_type,
      scope_target: a.scope_target,
      assigned_by: a.assigned_by,
      expires_at: a.expires_at ? toMilliseconds(a.expires_at as number) : null,
      created_at: toMilliseconds(a.created_at as number),
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
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(
      c as unknown as Context<{ Bindings: Env }>
    );
    const tenantId = getTenantIdFromContext(c as unknown as Context<{ Bindings: Env }>);
    const userId = c.req.param('id')!;
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

    // Get role (by id or name)
    let role: Record<string, unknown> | null;
    if (role_id) {
      role = await coreAdapter.queryOne<Record<string, unknown>>(
        'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
        [role_id, tenantId]
      );
    } else {
      role = await coreAdapter.queryOne<Record<string, unknown>>(
        'SELECT * FROM roles WHERE name = ? AND tenant_id = ?',
        [role_name, tenantId]
      );
    }

    if (!role) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    if (role.is_assignable === 0 || role.is_assignable === false) {
      return insufficientAdminPermissions(c as unknown as Context<{ Bindings: Env }>);
    }

    if (!canManageRoleHierarchy(adminAuth, role.hierarchy_level)) {
      return insufficientAdminPermissions(c as unknown as Context<{ Bindings: Env }>);
    }

    const assignmentId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const assignmentScope = scope || 'global';
    const assignmentScopeTarget = scope_target || '';

    // Validate scope
    const validScopes = ['global', 'org', 'resource'];
    if (!validScopes.includes(assignmentScope)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Invalid scope. Must be one of: ${validScopes.join(', ')}`,
        },
        400
      );
    }

    // If scope is org or resource, scope_target is required
    if ((assignmentScope === 'org' || assignmentScope === 'resource') && !scope_target) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'scope_target is required for org or resource scope',
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    const assignmentId = c.req.param('assignmentId')!;
    const adminAuth = getAdminAuthFromContext(c);

    if (adminAuth?.userId === userId) {
      return insufficientAdminPermissions(c);
    }

    // Check if assignment exists and belongs to this user
    const assignment = await coreAdapter.queryOne<{ id: string; hierarchy_level: number }>(
      `SELECT ra.id, r.hierarchy_level
       FROM role_assignments ra
       JOIN roles r ON r.id = ra.role_id AND r.tenant_id = ra.tenant_id
       WHERE ra.tenant_id = ? AND ra.id = ? AND ra.subject_id = ?`,
      [tenantId, assignmentId, userId]
    );

    if (!assignment) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    if (!canManageRoleHierarchy(adminAuth, assignment.hierarchy_level)) {
      return insufficientAdminPermissions(c);
    }

    await coreAdapter.execute('DELETE FROM role_assignments WHERE tenant_id = ? AND id = ?', [
      tenantId,
      assignmentId,
    ]);

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
 * GET /api/admin/users/:id/relationships
 * Get user's relationships (both as subject and related_subject)
 */
export async function adminUserRelationshipsListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
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
         WHERE r.subject_id = ?
           AND r.tenant_id = ?
           AND (r.expires_at IS NULL OR r.expires_at > ?)
         ORDER BY r.created_at DESC`,
        [userId, tenantId, now]
      );

      // Fetch PII for related users from PII DB
      const relatedUserIds = [
        ...new Set(outgoingResult.map((r) => r.related_subject_id as string)),
      ];
      const relatedUserPIIMap = await fetchRuntimeUserContactMap(
        coreAdapter,
        piiAdapter,
        tenantId,
        relatedUserIds
      );

      for (const rel of outgoingResult) {
        const pii = relatedUserPIIMap.get(rel.related_subject_id as string);
        outgoing.push({
          id: rel.id,
          relationship_type: rel.relationship_type,
          related_subject_id: rel.related_subject_id,
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
         WHERE r.related_subject_id = ?
           AND r.tenant_id = ?
           AND (r.expires_at IS NULL OR r.expires_at > ?)
         ORDER BY r.created_at DESC`,
        [userId, tenantId, now]
      );

      // Fetch PII for subject users from PII DB
      const subjectUserPIIMap = await fetchRuntimeUserContactMap(
        coreAdapter,
        piiAdapter,
        tenantId,
        incomingResult.map((r) => r.subject_id as string)
      );

      for (const rel of incomingResult) {
        const pii = subjectUserPIIMap.get(rel.subject_id as string);
        incoming.push({
          id: rel.id,
          relationship_type: rel.relationship_type,
          subject_id: rel.subject_id,
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
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
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

    // Validate relationship type
    const validTypes = ['parent_of', 'guardian_of', 'manager_of', 'assistant_of', 'delegate_of'];
    if (!validTypes.includes(relationship_type)) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: `Invalid relationship_type. Must be one of: ${validTypes.join(', ')}`,
        },
        400
      );
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
       WHERE subject_id = ? AND related_subject_id = ? AND relationship_type = ? AND tenant_id = ?`,
      [userId, related_subject_id, relationship_type, tenantId]
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
    const expiresAtSeconds = expires_at ? Math.floor(expires_at / 1000) : null;

    await coreAdapter.execute(
      `INSERT INTO relationships (id, tenant_id, subject_id, related_subject_id, relationship_type, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        relationshipId,
        tenantId,
        userId,
        related_subject_id,
        relationship_type,
        expiresAtSeconds,
        now,
      ]
    );

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
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;
    const relationshipId = c.req.param('relationshipId')!;

    // Check if relationship exists and involves this user
    const relationship = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM relationships WHERE id = ? AND tenant_id = ? AND (subject_id = ? OR related_subject_id = ?)',
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
// Organization Hierarchy and Effective Permissions
// =============================================================================

/**
 * Organization hierarchy node
 */
interface OrganizationNode {
  id: string;
  name: string;
  display_name: string | null;
  parent_id: string | null;
  depth: number;
  is_active: boolean;
  member_count: number;
  children: OrganizationNode[];
}

/**
 * GET /api/admin/organizations/:id/hierarchy
 * Get organization hierarchy tree
 *
 * Returns the organization and all its descendants in a tree structure.
 * For root organization (parent_id = null), returns the full tree.
 */
export async function adminOrganizationHierarchyHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const orgId = c.req.param('id')!;
    const maxDepth = parseInt(c.req.query('max_depth') || '10', 10);

    if (!orgId) {
      return c.json(
        { error: 'invalid_request', error_description: 'Organization ID is required' },
        400
      );
    }

    // Get the root organization
    const rootOrg = await coreAdapter.queryOne<{
      id: string;
      name: string;
      display_name: string | null;
      parent_id: string | null;
      is_active: number;
    }>(
      'SELECT id, name, display_name, parent_id, is_active FROM organizations WHERE id = ? AND tenant_id = ?',
      [orgId, tenantId]
    );

    if (!rootOrg) {
      return c.json({ error: 'not_found', error_description: 'Organization not found' }, 404);
    }

    // Get all descendant organizations using recursive CTE
    // Note: SQLite supports recursive CTEs
    const descendants = await coreAdapter.query<{
      id: string;
      name: string;
      display_name: string | null;
      parent_id: string | null;
      is_active: number;
      depth: number;
    }>(
      `WITH RECURSIVE org_tree AS (
        -- Base case: start with the root organization
        SELECT id, name, display_name, parent_id, is_active, 0 as depth
        FROM organizations
        WHERE id = ? AND tenant_id = ?

        UNION ALL

        -- Recursive case: get children
        SELECT o.id, o.name, o.display_name, o.parent_id, o.is_active, ot.depth + 1
        FROM organizations o
        INNER JOIN org_tree ot ON o.parent_id = ot.id
        WHERE o.tenant_id = ? AND ot.depth < ?
      )
      SELECT * FROM org_tree ORDER BY depth, name`,
      [orgId, tenantId, tenantId, maxDepth]
    );

    // Get member counts for all organizations
    const orgIds = descendants.map((o) => o.id);
    const memberCounts: Record<string, number> = {};

    if (orgIds.length > 0) {
      const placeholders = orgIds.map(() => '?').join(',');
      const counts = await coreAdapter.query<{ org_id: string; count: number }>(
        `SELECT org_id, COUNT(*) as count
         FROM subject_org_membership
         WHERE tenant_id = ? AND org_id IN (${placeholders})
         GROUP BY org_id`,
        [tenantId, ...orgIds]
      );
      for (const row of counts) {
        memberCounts[row.org_id] = row.count;
      }
    }

    // Build tree structure
    const nodesById: Map<string, OrganizationNode> = new Map();

    // Create all nodes first
    for (const org of descendants) {
      nodesById.set(org.id, {
        id: org.id,
        name: org.name,
        display_name: org.display_name,
        parent_id: org.parent_id,
        depth: org.depth,
        is_active: org.is_active === 1,
        member_count: memberCounts[org.id] || 0,
        children: [],
      });
    }

    // Link children to parents
    for (const node of nodesById.values()) {
      if (node.parent_id && nodesById.has(node.parent_id)) {
        nodesById.get(node.parent_id)!.children.push(node);
      }
    }

    // Get the root node
    const rootNode = nodesById.get(orgId);

    if (!rootNode) {
      return c.json({ error: 'server_error', error_description: 'Failed to build hierarchy' }, 500);
    }

    // Calculate totals
    function countDescendants(node: OrganizationNode): { orgs: number; members: number } {
      let totalOrgs = 1;
      let totalMembers = node.member_count;
      for (const child of node.children) {
        const childTotals = countDescendants(child);
        totalOrgs += childTotals.orgs;
        totalMembers += childTotals.members;
      }
      return { orgs: totalOrgs, members: totalMembers };
    }

    const totals = countDescendants(rootNode);

    return c.json({
      organization: rootNode,
      summary: {
        total_organizations: totals.orgs,
        total_members: totals.members,
        max_depth: Math.max(...descendants.map((d) => d.depth)),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-RBAC');
    log.error(
      'Admin organization hierarchy error',
      { action: 'get_org_hierarchy' },
      error as Error
    );
    return c.json(
      { error: 'server_error', error_description: 'Failed to get organization hierarchy' },
      500
    );
  }
}

/**
 * Effective permission with source information
 */
interface EffectivePermission {
  permission: string;
  source: 'direct' | 'role' | 'organization' | 'inherited';
  source_id: string | null;
  source_name: string | null;
  granted_at: number | null;
  expires_at: number | null;
}

/**
 * GET /api/admin/users/:id/effective-permissions
 * Get user's effective permissions from all sources
 *
 * Collects permissions from:
 * - Direct user permissions
 * - Role-based permissions
 * - Organization-based permissions
 * - Inherited permissions from parent organizations
 */
export async function adminUserEffectivePermissionsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('id')!;

    if (!userId) {
      return c.json({ error: 'invalid_request', error_description: 'User ID is required' }, 400);
    }

    if (!(await runtimeUserExists(coreAdapter, piiAdapter, tenantId, userId))) {
      return c.json({ error: 'not_found', error_description: 'User not found' }, 404);
    }

    const permissions: EffectivePermission[] = [];
    const seenPermissions = new Set<string>();

    // 1. Get direct role assignments
    const userRoles = await coreAdapter.query<{
      role_id: string;
      role_name: string;
      granted_at: number | null;
      expires_at: number | null;
    }>(
      `SELECT ur.role_id, r.name as role_name, ur.created_at as granted_at, ur.expires_at
       FROM user_roles ur
       INNER JOIN roles r ON ur.role_id = r.id
       WHERE ur.tenant_id = ?
         AND ur.user_id = ?
         AND r.tenant_id = ?
         AND (ur.expires_at IS NULL OR ur.expires_at > ?)`,
      [tenantId, userId, tenantId, Math.floor(Date.now() / 1000)]
    );

    // Get permissions for each role
    for (const role of userRoles) {
      const rolePermissions = await coreAdapter.query<{ permission: string }>(
        'SELECT permission FROM role_permissions WHERE role_id = ?',
        [role.role_id]
      );

      for (const rp of rolePermissions) {
        if (!seenPermissions.has(rp.permission)) {
          seenPermissions.add(rp.permission);
          permissions.push({
            permission: rp.permission,
            source: 'role',
            source_id: role.role_id,
            source_name: role.role_name,
            granted_at: role.granted_at,
            expires_at: role.expires_at,
          });
        }
      }
    }

    // 2. Get organization memberships and their roles
    const orgMemberships = await coreAdapter.query<{
      org_id: string;
      org_name: string;
      role_id: string | null;
      role_name: string | null;
      membership_type: string;
      joined_at: number | null;
    }>(
      `SELECT om.org_id as org_id,
              o.name as org_name,
              r.id as role_id,
              COALESCE(r.display_name, r.name, om.membership_type) as role_name,
              om.membership_type,
              om.created_at as joined_at
       FROM subject_org_membership om
       INNER JOIN organizations o ON om.org_id = o.id AND o.tenant_id = om.tenant_id
       LEFT JOIN roles r ON r.name = om.membership_type AND r.tenant_id = om.tenant_id
       WHERE om.subject_id = ? AND om.tenant_id = ?`,
      [userId, tenantId]
    );

    for (const membership of orgMemberships) {
      if (membership.role_id) {
        const orgRolePermissions = await coreAdapter.query<{ permission: string }>(
          'SELECT permission FROM role_permissions WHERE role_id = ?',
          [membership.role_id]
        );

        for (const rp of orgRolePermissions) {
          if (!seenPermissions.has(rp.permission)) {
            seenPermissions.add(rp.permission);
            permissions.push({
              permission: rp.permission,
              source: 'organization',
              source_id: membership.org_id,
              source_name: `${membership.org_name} (${membership.role_name ?? membership.membership_type})`,
              granted_at: membership.joined_at,
              expires_at: null,
            });
          }
        }
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
        from_organizations: permissions.filter((p) => p.source === 'organization').length,
        from_inherited: permissions.filter((p) => p.source === 'inherited').length,
      },
      roles: userRoles.map((r) => ({
        role_id: r.role_id,
        role_name: r.role_name,
        granted_at: toMilliseconds(r.granted_at),
        expires_at: toMilliseconds(r.expires_at),
      })),
      organizations: orgMemberships.map((m) => ({
        organization_id: m.org_id,
        organization_name: m.org_name,
        role_id: m.role_id,
        role_name: m.role_name,
        joined_at: toMilliseconds(m.joined_at),
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
    const { coreAdapter, piiAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const roleId = c.req.param('id')!;
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = (page - 1) * limit;

    // Check if role exists
    const role = await coreAdapter.queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM roles WHERE id = ? AND tenant_id = ?',
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

    const now = Math.floor(Date.now() / 1000);

    // Get total count
    const totalResult = await coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT subject_id) as count FROM role_assignments
       WHERE tenant_id = ? AND role_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, roleId, now]
    );

    const total = totalResult?.count || 0;
    const totalPages = Math.ceil(total / limit);

    // Get assignments with pagination
    const assignments = await coreAdapter.query<Record<string, unknown>>(
      `SELECT DISTINCT ra.id, ra.subject_id, ra.scope_type, ra.scope_target, ra.assigned_by, ra.expires_at, ra.created_at
       FROM role_assignments ra
       WHERE ra.role_id = ? AND ra.tenant_id = ? AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       ORDER BY ra.created_at DESC
       LIMIT ? OFFSET ?`,
      [roleId, tenantId, now, limit, offset]
    );

    const userContactMap = await fetchRuntimeUserContactMap(
      coreAdapter,
      piiAdapter,
      tenantId,
      assignments.map((a) => a.subject_id as string)
    );

    const formattedAssignments = assignments.map((a: Record<string, unknown>) => {
      const pii = userContactMap.get(a.subject_id as string);
      return {
        assignment_id: a.id,
        user_id: a.subject_id,
        user_email: pii?.email || null,
        user_name: pii?.name || null,
        scope: a.scope_type,
        scope_target: a.scope_target,
        assigned_by: a.assigned_by,
        expires_at: a.expires_at ? toMilliseconds(a.expires_at as number) : null,
        assigned_at: toMilliseconds(a.created_at as number),
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
      description?: string;
      permissions: string[];
      inherits_from?: string;
      parent_role_id?: string;
      hierarchy_level?: number;
    }>();
    const adminAuth = getAdminAuthFromContext(c);

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

    // System roles cannot be created
    const systemRoles = [
      'super_admin',
      'system_admin',
      'security_admin',
      'distributor_admin',
      'tenant_admin',
      'admin',
      'support',
      'viewer',
      'user',
    ];
    if (systemRoles.includes(body.name.toLowerCase())) {
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
    const hierarchyLevel = body.hierarchy_level ?? 0;

    if (!canManageRoleHierarchy(adminAuth, hierarchyLevel)) {
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

    const parentRoleId = body.parent_role_id ?? body.inherits_from;

    // Validate inherits_from if provided
    if (parentRoleId) {
      const parentRole = await adapter.queryOne<{ id: string; hierarchy_level: number }>(
        'SELECT id, hierarchy_level FROM roles WHERE tenant_id = ? AND id = ?',
        [tenantId, parentRoleId]
      );

      if (!parentRole) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'parent_role', id: parentRoleId },
        });
      }

      if (!canManageRoleHierarchy(adminAuth, parentRole.hierarchy_level)) {
        return insufficientAdminPermissions(c);
      }
    }

    const roleId = generateId();
    const nowTs = Date.now();

    // Create the role
    await adapter.execute(
      `INSERT INTO roles (
         id, tenant_id, name, description, permissions_json, role_type, hierarchy_level,
         is_assignable, parent_role_id, is_system, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        roleId,
        tenantId,
        body.name,
        body.description ?? null,
        JSON.stringify(body.permissions),
        'custom',
        hierarchyLevel,
        1,
        parentRoleId ?? null,
        0,
        nowTs,
        nowTs,
      ]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'role.created', 'role', roleId, {
      name: body.name,
      permission_count: body.permissions.length,
      parent_role_id: parentRoleId,
    });

    log.info('Role created', { action: 'role_create', roleId, name: body.name });

    return c.json(
      {
        role_id: roleId,
        name: body.name,
        description: body.description ?? null,
        permissions: body.permissions,
        parent_role_id: parentRoleId ?? null,
        inherits_from: parentRoleId ?? null,
        hierarchy_level: hierarchyLevel,
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
      hierarchy_level?: number;
      parent_role_id?: string | null;
      inherits_from?: string | null;
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
      hierarchy_level: number;
      parent_role_id: string | null;
    }>(
      `SELECT id, name, description, permissions_json, is_system, role_type, hierarchy_level,
              parent_role_id
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

    if (!canManageRoleHierarchy(adminAuth, existingRole.hierarchy_level)) {
      return insufficientAdminPermissions(c);
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

    if (
      body.hierarchy_level !== undefined &&
      !canManageRoleHierarchy(adminAuth, body.hierarchy_level)
    ) {
      return insufficientAdminPermissions(c);
    }

    const parentRoleId = body.parent_role_id ?? body.inherits_from;
    if (parentRoleId !== undefined && parentRoleId !== null) {
      const parentRole = await adapter.queryOne<{ id: string; hierarchy_level: number }>(
        'SELECT id, hierarchy_level FROM roles WHERE tenant_id = ? AND id = ?',
        [tenantId, parentRoleId]
      );

      if (!parentRole) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
          variables: { resource: 'parent_role', id: parentRoleId },
        });
      }

      if (!canManageRoleHierarchy(adminAuth, parentRole.hierarchy_level)) {
        return insufficientAdminPermissions(c);
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

    if (body.hierarchy_level !== undefined) {
      updates.push('hierarchy_level = ?');
      bindings.push(body.hierarchy_level);
    }

    if (parentRoleId !== undefined) {
      updates.push('parent_role_id = ?');
      bindings.push(parentRoleId);
    }

    // Add WHERE clause bindings
    bindings.push(tenantId, roleId);

    await adapter.execute(
      `UPDATE roles SET ${updates.join(', ')} WHERE tenant_id = ? AND id = ?`,
      bindings
    );

    // Write audit log
    await createAuditLogFromContext(c, 'role.updated', 'role', roleId, {
      name: existingRole.name,
      description_changed: body.description !== undefined,
      permissions_changed: body.permissions !== undefined,
      new_permission_count: body.permissions?.length,
      hierarchy_changed: body.hierarchy_level !== undefined,
      parent_role_changed: parentRoleId !== undefined,
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
      parent_role_id: parentRoleId !== undefined ? parentRoleId : existingRole.parent_role_id,
      hierarchy_level:
        body.hierarchy_level !== undefined ? body.hierarchy_level : existingRole.hierarchy_level,
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
    const { coreAdapter: adapter } = createAdaptersFromContext(c);

    // Get the existing role
    const existingRole = await adapter.queryOne<{
      id: string;
      name: string;
      is_system: number;
      role_type: string | null;
      hierarchy_level: number;
    }>(
      'SELECT id, name, is_system, role_type, hierarchy_level FROM roles WHERE tenant_id = ? AND id = ?',
      [tenantId, roleId]
    );

    if (!existingRole) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
        variables: { resource: 'role', id: roleId },
      });
    }

    if (!canManageRoleHierarchy(getAdminAuthFromContext(c), existingRole.hierarchy_level)) {
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

    // Check if any users are assigned to this role
    const assignmentCount = await adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM role_assignments WHERE tenant_id = ? AND role_id = ?',
      [tenantId, roleId]
    );

    if (assignmentCount && assignmentCount.count > 0) {
      return c.json(
        {
          error: 'conflict',
          error_description: `Cannot delete role: ${assignmentCount.count} user(s) are still assigned to this role. Remove all assignments first.`,
        },
        409
      );
    }

    // Delete the role
    await adapter.execute('DELETE FROM roles WHERE tenant_id = ? AND id = ?', [tenantId, roleId]);

    // Write audit log
    await createAuditLogFromContext(c, 'role.deleted', 'role', roleId, {
      name: existingRole.name,
    });

    log.info('Role deleted', { action: 'role_delete', roleId, name: existingRole.name });

    return c.json({ success: true, message: `Role '${existingRole.name}' has been deleted` });
  } catch (error) {
    log.error('Admin role delete error', { action: 'role_delete', roleId }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to delete role' }, 500);
  }
}

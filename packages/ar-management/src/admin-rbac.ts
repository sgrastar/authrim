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
  getTenantIdFromContext,
  D1Adapter,
  type DatabaseAdapter,
  escapeLikePattern,
} from '@authrim/ar-lib-core';

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
function getAdminAuth(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (c as any).get('adminAuth') as AdminAuthContext | null;
}

/**
 * Create database adapters from context
 */
function createAdaptersFromContext(c: Context<{ Bindings: Env }>): {
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter | null;
} {
  const coreAdapter = new D1Adapter({ db: c.env.DB });
  const piiAdapter = c.env.DB_PII ? new D1Adapter({ db: c.env.DB_PII }) : null;
  return { coreAdapter, piiAdapter };
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
    const { coreAdapter } = createAdaptersFromContext(c);
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
    console.error('Admin organizations list error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const tenantId = getTenantIdFromContext(c);
    const orgId = c.req.param('id');

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
    console.error('Admin organization get error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
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
      'SELECT id FROM organizations WHERE name = ?',
      [name]
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
       VALUES (?, '', ?, ?, ?, ?, 1, ?, ?, ?)`,
      [orgId, name, display_name || name, orgPlan, orgTypeValue, metadata_json || null, now, now]
    );

    // Get created organization
    const org = await coreAdapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM organizations WHERE id = ?',
      [orgId]
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
    console.error('Admin organization create error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const orgId = c.req.param('id');
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
      'SELECT id FROM organizations WHERE id = ?',
      [orgId]
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
    bindings.push(orgId);
    await coreAdapter.execute(
      `UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`,
      bindings
    );

    // Get updated organization
    const updatedOrg = await coreAdapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM organizations WHERE id = ?',
      [orgId]
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
    console.error('Admin organization update error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const orgId = c.req.param('id');

    // Check if organization exists
    const org = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE id = ?',
      [orgId]
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
      'UPDATE organizations SET is_active = 0, updated_at = ? WHERE id = ?',
      [now, orgId]
    );

    return c.json({
      success: true,
      message: 'Organization deactivated successfully',
    });
  } catch (error) {
    console.error('Admin organization delete error:', error);
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
    const orgId = c.req.param('id');
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
        `SELECT m.*
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
    const memberUserIds = [...new Set(members.map((m) => m.subject_id as string))];
    const memberPIIMap = new Map<string, { email: string | null; name: string | null }>();

    if (piiAdapter && memberUserIds.length > 0) {
      const placeholders = memberUserIds.map(() => '?').join(',');
      const piiResult = await piiAdapter.query<{
        id: string;
        email: string | null;
        name: string | null;
      }>(`SELECT id, email, name FROM users_pii WHERE id IN (${placeholders})`, memberUserIds);

      for (const pii of piiResult) {
        memberPIIMap.set(pii.id, {
          email: pii.email || null,
          name: pii.name || null,
        });
      }
    }

    const formattedMembers = members.map((m: Record<string, unknown>) => {
      const pii = memberPIIMap.get(m.subject_id as string);
      return {
        subject_id: m.subject_id,
        org_id: m.org_id,
        org_role: m.org_role,
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
    console.error('Admin organization members list error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const orgId = c.req.param('id');
    const body = await c.req.json<{
      subject_id: string;
      org_role?: string;
      is_primary?: boolean;
    }>();

    const { subject_id, org_role, is_primary } = body;

    if (!subject_id) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'subject_id is required',
        },
        400
      );
    }

    // Check if organization exists
    const org = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE id = ?',
      [orgId]
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

    // Check if user exists
    const user = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_core WHERE id = ?',
      [subject_id]
    );

    if (!user) {
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
      'SELECT subject_id FROM subject_org_membership WHERE org_id = ? AND subject_id = ?',
      [orgId, subject_id]
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
    const role = org_role || 'member';
    const primary = is_primary ? 1 : 0;

    // If setting as primary, unset other primary memberships for this user
    if (primary) {
      await coreAdapter.execute(
        'UPDATE subject_org_membership SET is_primary = 0 WHERE subject_id = ?',
        [subject_id]
      );
    }

    await coreAdapter.execute(
      `INSERT INTO subject_org_membership (org_id, subject_id, org_role, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [orgId, subject_id, role, primary, now]
    );

    return c.json(
      {
        success: true,
        message: 'Member added to organization',
        membership: {
          org_id: orgId,
          subject_id,
          org_role: role,
          is_primary: Boolean(primary),
          created_at: toMilliseconds(now),
        },
      },
      201
    );
  } catch (error) {
    console.error('Admin organization member add error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const orgId = c.req.param('id');
    const subjectId = c.req.param('subjectId');

    // Check if membership exists
    const membership = await coreAdapter.queryOne<{ subject_id: string }>(
      'SELECT subject_id FROM subject_org_membership WHERE org_id = ? AND subject_id = ?',
      [orgId, subjectId]
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
      'DELETE FROM subject_org_membership WHERE org_id = ? AND subject_id = ?',
      [orgId, subjectId]
    );

    return c.json({
      success: true,
      message: 'Member removed from organization',
    });
  } catch (error) {
    console.error('Admin organization member remove error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const roles = await coreAdapter.query<Record<string, unknown>>(
      `SELECT id, tenant_id, name, display_name, description, is_system, created_at, updated_at
       FROM roles
       ORDER BY is_system DESC, name ASC`,
      []
    );

    const formattedRoles = roles.map((role: Record<string, unknown>) => ({
      ...role,
      is_system: Boolean(role.is_system),
      created_at: toMilliseconds(role.created_at as number),
      updated_at: toMilliseconds(role.updated_at as number),
    }));

    return c.json({
      roles: formattedRoles,
    });
  } catch (error) {
    console.error('Admin roles list error:', error);
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
 * Get role details
 */
export async function adminRoleGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter } = createAdaptersFromContext(c);
    const roleId = c.req.param('id');

    const role = await coreAdapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM roles WHERE id = ?',
      [roleId]
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

    // Get count of users with this role
    const assignmentCount = await coreAdapter.queryOne<{ count: number }>(
      'SELECT COUNT(DISTINCT subject_id) as count FROM role_assignments WHERE role_id = ?',
      [roleId]
    );

    return c.json({
      role: {
        ...role,
        is_system: Boolean(role.is_system),
        created_at: toMilliseconds(role.created_at as number),
        updated_at: toMilliseconds(role.updated_at as number),
        assignment_count: assignmentCount?.count || 0,
      },
    });
  } catch (error) {
    console.error('Admin role get error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const userId = c.req.param('id');

    // Check if user exists
    const user = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_core WHERE id = ?',
      [userId]
    );

    if (!user) {
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
      `SELECT ra.*, r.name as role_name, r.display_name as role_display_name, r.is_system
       FROM role_assignments ra
       JOIN roles r ON ra.role_id = r.id
       WHERE ra.subject_id = ?
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       ORDER BY r.name ASC`,
      [userId, now]
    );

    const formattedAssignments = assignments.map((a: Record<string, unknown>) => ({
      id: a.id,
      role_id: a.role_id,
      role_name: a.role_name,
      role_display_name: a.role_display_name,
      is_system_role: Boolean(a.is_system),
      scope: a.scope,
      scope_target: a.scope_target,
      granted_by: a.granted_by,
      expires_at: a.expires_at ? toMilliseconds(a.expires_at as number) : null,
      created_at: toMilliseconds(a.created_at as number),
    }));

    return c.json({
      user_id: userId,
      roles: formattedAssignments,
    });
  } catch (error) {
    console.error('Admin user roles list error:', error);
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
export async function adminUserRoleAssignHandler(c: Context<{ Bindings: Env }>) {
  try {
    const { coreAdapter } = createAdaptersFromContext(c);
    const userId = c.req.param('id');
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

    // Check if user exists
    const user = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_core WHERE id = ?',
      [userId]
    );

    if (!user) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    // Get role (by id or name)
    let role;
    if (role_id) {
      role = await coreAdapter.queryOne<Record<string, unknown>>(
        'SELECT * FROM roles WHERE id = ?',
        [role_id]
      );
    } else {
      role = await coreAdapter.queryOne<Record<string, unknown>>(
        'SELECT * FROM roles WHERE name = ?',
        [role_name]
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

    const assignmentId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const assignmentScope = scope || 'global';
    const assignmentScopeTarget = scope_target || '';

    // Validate scope
    const validScopes = ['global', 'organization', 'resource'];
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
    if ((assignmentScope === 'organization' || assignmentScope === 'resource') && !scope_target) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'scope_target is required for organization or resource scope',
        },
        400
      );
    }

    // Check for duplicate assignment
    const existing = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM role_assignments
       WHERE subject_id = ? AND role_id = ? AND scope = ? AND scope_target = ?`,
      [userId, role.id, assignmentScope, assignmentScopeTarget]
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
      `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, scope, scope_target, granted_by, expires_at, created_at)
       VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)`,
      [
        assignmentId,
        userId,
        role.id,
        assignmentScope,
        assignmentScopeTarget,
        adminAuth?.userId || 'system',
        expiresAtSeconds,
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
          granted_by: adminAuth?.userId || 'system',
          expires_at: expires_at || null,
          created_at: toMilliseconds(now),
        },
      },
      201
    );
  } catch (error) {
    console.error('Admin user role assign error:', error);
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
    const userId = c.req.param('id');
    const assignmentId = c.req.param('assignmentId');

    // Check if assignment exists and belongs to this user
    const assignment = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM role_assignments WHERE id = ? AND subject_id = ?',
      [assignmentId, userId]
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

    await coreAdapter.execute('DELETE FROM role_assignments WHERE id = ?', [assignmentId]);

    return c.json({
      success: true,
      message: 'Role assignment removed successfully',
    });
  } catch (error) {
    console.error('Admin user role remove error:', error);
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
    const userId = c.req.param('id');
    const direction = c.req.query('direction'); // 'outgoing', 'incoming', or undefined for both

    // Check if user exists in Core DB
    const userCore = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_core WHERE id = ? AND is_active = 1',
      [userId]
    );

    if (!userCore) {
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
           AND (r.expires_at IS NULL OR r.expires_at > ?)
         ORDER BY r.created_at DESC`,
        [userId, now]
      );

      // Fetch PII for related users from PII DB
      const relatedUserIds = [
        ...new Set(outgoingResult.map((r) => r.related_subject_id as string)),
      ];
      const relatedUserPIIMap = new Map<string, { email: string | null; name: string | null }>();

      if (piiAdapter && relatedUserIds.length > 0) {
        const placeholders = relatedUserIds.map(() => '?').join(',');
        const piiResult = await piiAdapter.query<{
          id: string;
          email: string | null;
          name: string | null;
        }>(`SELECT id, email, name FROM users_pii WHERE id IN (${placeholders})`, relatedUserIds);

        for (const pii of piiResult) {
          relatedUserPIIMap.set(pii.id, {
            email: pii.email || null,
            name: pii.name || null,
          });
        }
      }

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
           AND (r.expires_at IS NULL OR r.expires_at > ?)
         ORDER BY r.created_at DESC`,
        [userId, now]
      );

      // Fetch PII for subject users from PII DB
      const subjectUserIds = [...new Set(incomingResult.map((r) => r.subject_id as string))];
      const subjectUserPIIMap = new Map<string, { email: string | null; name: string | null }>();

      if (piiAdapter && subjectUserIds.length > 0) {
        const placeholders = subjectUserIds.map(() => '?').join(',');
        const piiResult = await piiAdapter.query<{
          id: string;
          email: string | null;
          name: string | null;
        }>(`SELECT id, email, name FROM users_pii WHERE id IN (${placeholders})`, subjectUserIds);

        for (const pii of piiResult) {
          subjectUserPIIMap.set(pii.id, {
            email: pii.email || null,
            name: pii.name || null,
          });
        }
      }

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
    console.error('Admin user relationships list error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const userId = c.req.param('id');
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

    // Check if both users exist
    const subject = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_core WHERE id = ?',
      [userId]
    );

    if (!subject) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'The requested resource was not found',
        },
        404
      );
    }

    const relatedSubject = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM users_core WHERE id = ?',
      [related_subject_id]
    );

    if (!relatedSubject) {
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
       WHERE subject_id = ? AND related_subject_id = ? AND relationship_type = ?`,
      [userId, related_subject_id, relationship_type]
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
       VALUES (?, '', ?, ?, ?, ?, ?)`,
      [relationshipId, userId, related_subject_id, relationship_type, expiresAtSeconds, now]
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
    console.error('Admin user relationship create error:', error);
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
    const { coreAdapter } = createAdaptersFromContext(c);
    const userId = c.req.param('id');
    const relationshipId = c.req.param('relationshipId');

    // Check if relationship exists and involves this user
    const relationship = await coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM relationships WHERE id = ? AND (subject_id = ? OR related_subject_id = ?)',
      [relationshipId, userId, userId]
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

    await coreAdapter.execute('DELETE FROM relationships WHERE id = ?', [relationshipId]);

    return c.json({
      success: true,
      message: 'Relationship deleted successfully',
    });
  } catch (error) {
    console.error('Admin user relationship delete error:', error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete relationship',
      },
      500
    );
  }
}

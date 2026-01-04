/**
 * Resource Permissions Admin API
 *
 * CRUD operations for ID-level resource permissions.
 *
 * POST   /api/admin/resource-permissions              - Grant permission
 * GET    /api/admin/resource-permissions              - List permissions
 * DELETE /api/admin/resource-permissions/:id          - Revoke permission
 * GET    /api/admin/resource-permissions/subject/:id  - Get by subject
 * GET    /api/admin/resource-permissions/resource/:type/:id - Get by resource
 * POST   /api/admin/resource-permissions/check        - Check permission
 */

import type { Context } from 'hono';
import {
  D1Adapter,
  createPermissionChangeNotifier,
  createPermissionChangeEvent,
  getLogger,
  type DatabaseAdapter,
  type ResourcePermission,
  type ResourcePermissionRow,
  type ResourcePermissionInput,
  type ResourcePermissionSubjectType,
  hasIdLevelPermission,
} from '@authrim/ar-lib-core';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TENANT_ID = 'default';
const MAX_PERMISSIONS_PER_PAGE = 100;

// =============================================================================
// Helpers
// =============================================================================

function rowToPermission(row: ResourcePermissionRow): ResourcePermission {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    subject_type: row.subject_type as ResourcePermissionSubjectType,
    subject_id: row.subject_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    actions: JSON.parse(row.actions_json) as string[],
    condition: row.condition_json ? JSON.parse(row.condition_json) : undefined,
    expires_at: row.expires_at ?? undefined,
    is_active: row.is_active === 1,
    granted_by: row.granted_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validatePermissionInput(input: ResourcePermissionInput): string[] {
  const errors: string[] = [];

  if (!input.subject_type) {
    errors.push('subject_type is required');
  } else if (!['user', 'role', 'org'].includes(input.subject_type)) {
    errors.push('subject_type must be "user", "role", or "org"');
  }

  if (!input.subject_id || input.subject_id.trim().length === 0) {
    errors.push('subject_id is required');
  }

  if (!input.resource_type || input.resource_type.trim().length === 0) {
    errors.push('resource_type is required');
  }

  if (!input.resource_id || input.resource_id.trim().length === 0) {
    errors.push('resource_id is required');
  }

  if (!input.actions || !Array.isArray(input.actions) || input.actions.length === 0) {
    errors.push('actions is required and must be a non-empty array');
  }

  return errors;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /api/admin/resource-permissions
 * Grant a new resource permission
 */
export async function createResourcePermission(c: Context) {
  const log = getLogger(c).module('ResourcePermissionsAPI');
  const body = await c.req.json<ResourcePermissionInput>();
  const tenantId = DEFAULT_TENANT_ID;

  // Validate input
  const errors = validatePermissionInput(body);
  if (errors.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: errors.join(', '),
      },
      400
    );
  }

  const id = `rp_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    // Check if permission already exists for this subject/resource
    const existing = await coreAdapter.queryOne<{ id: string }>(
      `SELECT id FROM resource_permissions
       WHERE tenant_id = ? AND subject_type = ? AND subject_id = ?
         AND resource_type = ? AND resource_id = ?`,
      [tenantId, body.subject_type, body.subject_id, body.resource_type, body.resource_id]
    );

    if (existing) {
      return c.json(
        {
          error: 'conflict',
          error_description:
            'Permission already exists for this subject and resource. Use PUT to update.',
        },
        409
      );
    }

    // Insert permission
    await coreAdapter.execute(
      `INSERT INTO resource_permissions (
        id, tenant_id, subject_type, subject_id,
        resource_type, resource_id, actions_json, condition_json,
        expires_at, is_active, granted_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        body.subject_type,
        body.subject_id,
        body.resource_type,
        body.resource_id,
        JSON.stringify(body.actions),
        body.condition ? JSON.stringify(body.condition) : null,
        body.expires_at || null,
        body.is_active !== false ? 1 : 0,
        null, // granted_by - TODO: get from context
        now,
        now,
      ]
    );

    // Invalidate cache for subject
    if (c.env.REBAC_CACHE) {
      try {
        await c.env.REBAC_CACHE.delete(`policy:idperms:${tenantId}:${body.subject_id}`);
      } catch {
        // Ignore cache invalidation errors
      }
    }

    // Phase 8.3: Publish permission change event
    try {
      const notifier = createPermissionChangeNotifier({
        db: c.env.DB,
        cache: c.env.REBAC_CACHE,
        permissionChangeHub: c.env.PERMISSION_CHANGE_HUB,
      });
      await notifier.publish(
        createPermissionChangeEvent('grant', tenantId, body.subject_id, {
          resource: `${body.resource_type}:${body.resource_id}`,
          permission: body.actions.join(','),
        })
      );
    } catch (notifyError) {
      // Log but don't fail the request if notification fails
      log.warn('Permission change notification failed', {}, notifyError as Error);
    }

    // Return created permission
    const permission: ResourcePermission = {
      id,
      tenant_id: tenantId,
      subject_type: body.subject_type,
      subject_id: body.subject_id,
      resource_type: body.resource_type,
      resource_id: body.resource_id,
      actions: body.actions,
      condition: body.condition,
      expires_at: body.expires_at,
      is_active: body.is_active !== false,
      created_at: now,
      updated_at: now,
    };

    return c.json(permission, 201);
  } catch (error) {
    log.error('Create error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to create permission',
      },
      500
    );
  }
}

/**
 * GET /api/admin/resource-permissions
 * List all resource permissions
 */
export async function listResourcePermissions(c: Context) {
  const log = getLogger(c).module('ResourcePermissionsAPI');
  const tenantId = DEFAULT_TENANT_ID;
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), MAX_PERMISSIONS_PER_PAGE);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const isActive = c.req.query('is_active');
  const subjectType = c.req.query('subject_type') as ResourcePermissionSubjectType | undefined;
  const resourceType = c.req.query('resource_type');

  try {
    let whereClause = 'WHERE tenant_id = ?';
    const values: unknown[] = [tenantId];

    if (isActive !== undefined) {
      whereClause += ' AND is_active = ?';
      values.push(isActive === 'true' ? 1 : 0);
    }

    if (subjectType) {
      whereClause += ' AND subject_type = ?';
      values.push(subjectType);
    }

    if (resourceType) {
      whereClause += ' AND resource_type = ?';
      values.push(resourceType);
    }

    // Get total count
    const countResult = (await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM resource_permissions ${whereClause}`
    )
      .bind(...values)
      .first()) as { count: number } | null;
    const total = countResult?.count ?? 0;

    // Get permissions
    const result = await c.env.DB.prepare(
      `SELECT * FROM resource_permissions ${whereClause}
       ORDER BY resource_type, resource_id, created_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...[...values, limit, offset])
      .all();

    const permissions = ((result.results || []) as ResourcePermissionRow[]).map(rowToPermission);

    return c.json({
      permissions,
      total,
      limit,
      offset,
    });
  } catch (error) {
    log.error('List error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list permissions',
      },
      500
    );
  }
}

/**
 * DELETE /api/admin/resource-permissions/:id
 * Revoke a permission
 */
export async function deleteResourcePermission(c: Context) {
  const log = getLogger(c).module('ResourcePermissionsAPI');
  const id = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;

  const coreAdapter: DatabaseAdapter = new D1Adapter({ db: c.env.DB });

  try {
    // Get permission first to know subject_id for cache invalidation
    const existing = await coreAdapter.queryOne<ResourcePermissionRow>(
      'SELECT * FROM resource_permissions WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!existing) {
      return c.json(
        {
          error: 'not_found',
          error_description: `Permission ${id} not found`,
        },
        404
      );
    }

    await coreAdapter.execute('DELETE FROM resource_permissions WHERE id = ? AND tenant_id = ?', [
      id,
      tenantId,
    ]);

    // Invalidate cache for subject
    if (c.env.REBAC_CACHE) {
      try {
        await c.env.REBAC_CACHE.delete(`policy:idperms:${tenantId}:${existing.subject_id}`);
      } catch {
        // Ignore cache invalidation errors
      }
    }

    // Phase 8.3: Publish permission change event
    try {
      const notifier = createPermissionChangeNotifier({
        db: c.env.DB,
        cache: c.env.REBAC_CACHE,
        permissionChangeHub: c.env.PERMISSION_CHANGE_HUB,
      });
      const actions = JSON.parse(existing.actions_json) as string[];
      await notifier.publish(
        createPermissionChangeEvent('revoke', tenantId, existing.subject_id, {
          resource: `${existing.resource_type}:${existing.resource_id}`,
          permission: actions.join(','),
        })
      );
    } catch (notifyError) {
      // Log but don't fail the request if notification fails
      log.warn('Permission change notification failed', {}, notifyError as Error);
    }

    return c.json({ success: true });
  } catch (error) {
    log.error('Delete error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to delete permission',
      },
      500
    );
  }
}

/**
 * GET /api/admin/resource-permissions/subject/:id
 * Get all permissions for a specific subject
 */
export async function getPermissionsBySubject(c: Context) {
  const log = getLogger(c).module('ResourcePermissionsAPI');
  const subjectId = c.req.param('id');
  const subjectType = (c.req.query('type') as ResourcePermissionSubjectType) || 'user';
  const tenantId = DEFAULT_TENANT_ID;

  try {
    const result = await c.env.DB.prepare(
      `SELECT * FROM resource_permissions
       WHERE tenant_id = ? AND subject_type = ? AND subject_id = ? AND is_active = 1
       ORDER BY resource_type, resource_id`
    )
      .bind(tenantId, subjectType, subjectId)
      .all();

    const permissions = ((result.results || []) as ResourcePermissionRow[]).map(rowToPermission);

    return c.json({
      subject_id: subjectId,
      subject_type: subjectType,
      permissions,
    });
  } catch (error) {
    log.error('Get by subject error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get permissions for subject',
      },
      500
    );
  }
}

/**
 * GET /api/admin/resource-permissions/resource/:type/:id
 * Get all permissions for a specific resource
 */
export async function getPermissionsByResource(c: Context) {
  const log = getLogger(c).module('ResourcePermissionsAPI');
  const resourceType = c.req.param('type');
  const resourceId = c.req.param('id');
  const tenantId = DEFAULT_TENANT_ID;

  try {
    const result = await c.env.DB.prepare(
      `SELECT * FROM resource_permissions
       WHERE tenant_id = ? AND resource_type = ? AND resource_id = ? AND is_active = 1
       ORDER BY subject_type, subject_id`
    )
      .bind(tenantId, resourceType, resourceId)
      .all();

    const permissions = ((result.results || []) as ResourcePermissionRow[]).map(rowToPermission);

    return c.json({
      resource_type: resourceType,
      resource_id: resourceId,
      permissions,
    });
  } catch (error) {
    log.error('Get by resource error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get permissions for resource',
      },
      500
    );
  }
}

/**
 * POST /api/admin/resource-permissions/check
 * Check if a subject has permission for a specific resource and action
 */
export async function checkResourcePermission(c: Context) {
  const log = getLogger(c).module('ResourcePermissionsAPI');
  const body = await c.req.json<{
    subject_id: string;
    resource_type: string;
    resource_id: string;
    action: string;
  }>();
  const tenantId = DEFAULT_TENANT_ID;

  try {
    const allowed = await hasIdLevelPermission(
      c.env.DB,
      body.subject_id,
      body.resource_type,
      body.resource_id,
      body.action,
      tenantId
    );

    return c.json({
      allowed,
      subject_id: body.subject_id,
      resource_type: body.resource_type,
      resource_id: body.resource_id,
      action: body.action,
    });
  } catch (error) {
    log.error('Check error', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to check permission',
      },
      500
    );
  }
}

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
  createPermissionChangeNotifier,
  createPermissionChangeEvent,
  getLogger,
  type Env,
  type ResourcePermission,
  type ResourcePermissionRow,
  type ResourcePermissionInput,
  type ResourcePermissionSubjectType,
  hasIdLevelPermission,
  invalidateIdPermissionCache,
  isValidPermissionId,
  isValidPermissionName,
  parseConcretePermission,
  resolveAccountCoreDataContext,
  subtreeHasSelfWritableDynamicGroup,
  lockGroupCatalog,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import { resolveSettingsCoreAdapter, resolveSettingsTenantId } from './tenant-resolver';

// =============================================================================
// Constants
// =============================================================================

const MAX_PERMISSIONS_PER_PAGE = 100;

// =============================================================================
// Helpers
// =============================================================================

function rowToPermission(row: ResourcePermissionRow): ResourcePermission {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    subject_type: row.subject_type,
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

/** A non-empty string after trimming (a JSON value of another type is not one). */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePermissionInput(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return ['the body must be a JSON object'];
  }
  const body = input as Record<string, unknown>;
  const errors: string[] = [];

  if (body.subject_type === undefined || body.subject_type === null || body.subject_type === '') {
    errors.push('subject_type is required');
  } else if (
    typeof body.subject_type !== 'string' ||
    !['user', 'role', 'group'].includes(body.subject_type)
  ) {
    errors.push('subject_type must be "user", "role", or "group"');
  }

  if (!nonEmptyString(body.subject_id)) {
    errors.push('subject_id is required and must be a string');
  }

  // The permission grammar (see isValidPermission): the grant is `resource_type:resource_id:action`
  // for each action, so each part must be one a check can name.
  if (!nonEmptyString(body.resource_type)) {
    errors.push('resource_type is required and must be a string');
  } else if (!isValidPermissionName(body.resource_type)) {
    errors.push('resource_type must match [a-z][a-z0-9_]*');
  }

  if (!nonEmptyString(body.resource_id)) {
    errors.push('resource_id is required and must be a string');
  } else if (!isValidPermissionId(body.resource_id)) {
    errors.push("resource_id must not contain whitespace, control characters or ':'");
  }

  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    errors.push('actions is required and must be a non-empty array');
  } else if (
    body.actions.some((action: unknown) => action !== '*' && !isValidPermissionName(action))
  ) {
    errors.push("each action must match [a-z][a-z0-9_]* or be '*'");
  }

  // Absent, or a plain object: any other JSON value (null, false, a string, an array, a number)
  // is refused rather than stored as a condition nobody can read.
  if (
    'condition' in body &&
    body.condition !== undefined &&
    (typeof body.condition !== 'object' || body.condition === null || Array.isArray(body.condition))
  ) {
    errors.push('condition must be a JSON object when present');
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
  const tenantId = resolveSettingsTenantId(c);

  // Validate input (the body is a JSON value: type-guarded before it is read)
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

  const coreAdapter = resolveSettingsCoreAdapter(c);

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

    const insert = (db: Pick<DatabaseAdapter, 'execute'>) =>
      db.execute(
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

    if (body.subject_type === 'group') {
      // A permission granted to a group reaches every member of it and of the groups below it, as
      // a role granted to the group does: the group must be the tenant's, and no service group
      // below it may be decided by an attribute users set themselves. The lock, the checks and the
      // insert are one transaction, so on PostgreSQL the grant serialises with a reparent or a
      // service-group save (as a group role grant does). On D1 the statements still run one by
      // one: this narrows the window between the checks and the write, it does not close it.
      const outcome = await coreAdapter.transaction(async (tx) => {
        await lockGroupCatalog(tx, tenantId, coreAdapter.getType());
        const group = await tx.queryOne<{ id: string }>(
          'SELECT id FROM "groups" WHERE tenant_id = ? AND id = ?',
          [tenantId, body.subject_id]
        );
        if (!group) return 'not_found' as const;
        if (await subtreeHasSelfWritableDynamicGroup(tx, tenantId, body.subject_id))
          return 'self_writable' as const;
        await insert(tx);
        return 'ok' as const;
      });
      if (outcome === 'not_found') {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'subject_id is not a group of the tenant',
          },
          400
        );
      }
      if (outcome === 'self_writable') {
        return c.json(
          {
            error: 'group_self_writable_attribute',
            error_description:
              'A service group below this group is decided by an attribute users can set themselves: it cannot carry permissions',
          },
          400
        );
      }
    } else {
      await insert(coreAdapter);
    }

    // Invalidate cache for subject
    if (c.env.REBAC_CACHE) {
      try {
        await invalidateIdPermissionCache(
          c.env.REBAC_CACHE,
          body.subject_id,
          tenantId,
          body.subject_type ?? 'user'
        );
      } catch {
        // Ignore cache invalidation errors
      }
    }

    // Phase 8.3: Publish permission change event
    try {
      const env = c.env as Env;
      const notifier = createPermissionChangeNotifier({
        env,
        cache: env.REBAC_CACHE,
        permissionChangeHub: env.PERMISSION_CHANGE_HUB,
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
  const tenantId = resolveSettingsTenantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), MAX_PERMISSIONS_PER_PAGE);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const isActive = c.req.query('is_active');
  const subjectType = c.req.query('subject_type') as ResourcePermissionSubjectType | undefined;
  const resourceType = c.req.query('resource_type');
  const coreAdapter = resolveSettingsCoreAdapter(c);

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
    const countResult = await coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM resource_permissions ${whereClause}`,
      values
    );
    const total = countResult?.count ?? 0;

    const permissions = await coreAdapter.query<ResourcePermissionRow>(
      `SELECT * FROM resource_permissions ${whereClause}
       ORDER BY resource_type, resource_id, created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    return c.json({
      permissions: permissions.map(rowToPermission),
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
  const id = c.req.param('id')!;
  const tenantId = resolveSettingsTenantId(c);

  const coreAdapter = resolveSettingsCoreAdapter(c);

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
        await invalidateIdPermissionCache(
          c.env.REBAC_CACHE,
          existing.subject_id,
          tenantId,
          existing.subject_type
        );
      } catch {
        // Ignore cache invalidation errors
      }
    }

    // Phase 8.3: Publish permission change event
    try {
      const env = c.env as Env;
      const notifier = createPermissionChangeNotifier({
        env,
        cache: env.REBAC_CACHE,
        permissionChangeHub: env.PERMISSION_CHANGE_HUB,
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
  const subjectId = c.req.param('id')!;
  const subjectType = (c.req.query('type') as ResourcePermissionSubjectType) || 'user';
  const tenantId = resolveSettingsTenantId(c);
  const coreAdapter = resolveSettingsCoreAdapter(c);

  try {
    const permissions = await coreAdapter.query<ResourcePermissionRow>(
      `SELECT * FROM resource_permissions
       WHERE tenant_id = ? AND subject_type = ? AND subject_id = ? AND is_active = 1
       ORDER BY resource_type, resource_id`,
      [tenantId, subjectType, subjectId]
    );

    return c.json({
      subject_id: subjectId,
      subject_type: subjectType,
      permissions: permissions.map(rowToPermission),
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
  const resourceType = c.req.param('type')!;
  const resourceId = c.req.param('id')!;
  const tenantId = resolveSettingsTenantId(c);
  const coreAdapter = resolveSettingsCoreAdapter(c);

  try {
    const permissions = await coreAdapter.query<ResourcePermissionRow>(
      `SELECT * FROM resource_permissions
       WHERE tenant_id = ? AND resource_type = ? AND resource_id = ? AND is_active = 1
       ORDER BY subject_type, subject_id`,
      [tenantId, resourceType, resourceId]
    );

    return c.json({
      resource_type: resourceType,
      resource_id: resourceId,
      permissions: permissions.map(rowToPermission),
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
  const tenantId = resolveSettingsTenantId(c);
  const coreAdapter = resolveSettingsCoreAdapter(c);

  // The check a grant answers is `resource_type:resource_id:action`, in the permission grammar.
  const raw = body as unknown;
  const fields =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (
    !nonEmptyString(fields.subject_id) ||
    typeof fields.resource_type !== 'string' ||
    typeof fields.resource_id !== 'string' ||
    typeof fields.action !== 'string' ||
    !parseConcretePermission(`${fields.resource_type}:${fields.resource_id}:${fields.action}`)
  ) {
    return c.json(
      {
        error: 'invalid_request',
        error_description:
          'subject_id, resource_type, resource_id and action are required, in the permission grammar',
      },
      400
    );
  }

  try {
    // Grants are in the tenant metadata database; the subject's roles, in its account database.
    // A subject without an account has no permission.
    const account = await resolveAccountCoreDataContext(c.env, {
      tenantId,
      accountId: body.subject_id,
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'account_data_route_not_found') return null;
      throw error;
    });
    const allowed = account
      ? await hasIdLevelPermission(
          { metadata: coreAdapter, account: account.coreDb },
          body.subject_id,
          body.resource_type,
          body.resource_id,
          body.action,
          tenantId
        )
      : false;

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

/**
 * Admin ABAC (Attribute-Based Access Control) API
 *
 * Endpoints for managing Admin attributes and attribute values.
 * These operate on DB_ADMIN, separate from EndUser ABAC.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  AdminAttributeRepository,
  AdminAttributeValueRepository,
  AdminAuditLogRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
} from '@authrim/ar-lib-core';

// Define context type
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

// Create router
export const adminAbacRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Apply admin authentication with ABAC permissions
adminAbacRouter.use(
  '*',
  adminAuthMiddleware({
    requirePermissions: [ADMIN_PERMISSIONS.ADMIN_ROLES_READ],
  })
);

/**
 * Helper to get DB_ADMIN adapter
 */
function getAdminAdapter(c: AdminContext) {
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
async function createAuditLog(
  c: AdminContext,
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
    admin_email: authContext.email || 'system',
    action,
    resource_type: 'admin_attribute',
    resource_id: resourceId,
    result,
    ip_address: c.req.header('CF-Connecting-IP') || undefined,
    user_agent: c.req.header('User-Agent') || undefined,
    metadata,
  });
}

// =============================================================================
// Attribute Endpoints
// =============================================================================

/**
 * GET /api/admin/admin-attributes
 * List all Admin attributes
 */
adminAbacRouter.get('/admin-attributes', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminAttributeRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const includeSystem = c.req.query('include_system') === 'true';
    const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 500);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    const attributes = await repo.listAttributes(tenantId, { includeSystem, limit, offset });

    return c.json({
      items: attributes,
      total: attributes.length,
      limit,
      offset,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-attributes/:id
 * Get Admin attribute by ID
 */
adminAbacRouter.get('/admin-attributes/:id', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminAttributeRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');

    const attribute = await repo.getAttribute(id);
    if (!attribute) {
      return c.json({ error: 'not_found', message: 'Attribute not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (attribute.tenant_id !== tenantId && !attribute.is_system) {
      return c.json({ error: 'not_found', message: 'Attribute not found' }, 404);
    }

    return c.json(attribute);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-attributes
 * Create new Admin attribute
 */
adminAbacRouter.post('/admin-attributes', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminAttributeRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json<{
      name: string;
      display_name?: string;
      description?: string;
      attribute_type?: 'string' | 'enum' | 'number' | 'boolean' | 'date' | 'array';
      allowed_values?: string[];
      min_value?: number;
      max_value?: number;
      regex_pattern?: string;
      is_required?: boolean;
      is_multi_valued?: boolean;
    }>();

    // Validate required fields
    if (!body.name) {
      return c.json({ error: 'invalid_request', message: 'name is required' }, 400);
    }

    // Check for duplicate
    const existing = await repo.getAttributeByName(tenantId, body.name);
    if (existing) {
      return c.json({ error: 'conflict', message: 'Attribute already exists' }, 409);
    }

    // Explicit field mapping to prevent Mass Assignment
    const attribute = await repo.createAttribute({
      tenant_id: tenantId,
      name: body.name,
      display_name: body.display_name,
      description: body.description,
      attribute_type: body.attribute_type,
      allowed_values: body.allowed_values,
      min_value: body.min_value,
      max_value: body.max_value,
      regex_pattern: body.regex_pattern,
      is_required: body.is_required,
      is_multi_valued: body.is_multi_valued,
    });

    await createAuditLog(c, 'admin_attribute.create', attribute.id, 'success', {
      name: attribute.name,
    });

    return c.json(attribute, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /api/admin/admin-attributes/:id
 * Update Admin attribute
 */
adminAbacRouter.patch('/admin-attributes/:id', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminAttributeRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');

    // Check if attribute exists and belongs to this tenant
    const existing = await repo.getAttribute(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'Attribute not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'Attribute not found' }, 404);
    }

    const body = await c.req.json<{
      display_name?: string;
      description?: string;
      allowed_values?: string[];
      min_value?: number;
      max_value?: number;
      regex_pattern?: string;
      is_required?: boolean;
      is_multi_valued?: boolean;
    }>();

    // Explicit field mapping to prevent Mass Assignment
    const attribute = await repo.updateAttribute(id, {
      display_name: body.display_name,
      description: body.description,
      allowed_values: body.allowed_values,
      min_value: body.min_value,
      max_value: body.max_value,
      regex_pattern: body.regex_pattern,
      is_required: body.is_required,
      is_multi_valued: body.is_multi_valued,
    });

    if (!attribute) {
      return c.json(
        { error: 'not_found', message: 'Attribute not found or is system attribute' },
        404
      );
    }

    await createAuditLog(c, 'admin_attribute.update', id, 'success', {
      updates: Object.keys(body),
    });

    return c.json(attribute);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admin-attributes/:id
 * Delete Admin attribute
 */
adminAbacRouter.delete('/admin-attributes/:id', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminAttributeRepository(adapter);
    const valueRepo = new AdminAttributeValueRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');

    // Check if attribute exists and belongs to this tenant
    const existing = await repo.getAttribute(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'Attribute not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'Attribute not found' }, 404);
    }

    // Delete all values for this attribute first
    await valueRepo.deleteAllByAttribute(id);

    const deleted = await repo.deleteAttribute(id);
    if (!deleted) {
      return c.json(
        { error: 'not_found', message: 'Attribute not found or is system attribute' },
        404
      );
    }

    await createAuditLog(c, 'admin_attribute.delete', id, 'success');

    return c.json({ success: true });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

// =============================================================================
// Attribute Value Endpoints
// =============================================================================

/**
 * GET /api/admin/admins/:userId/attributes
 * Get all attribute values for an Admin user
 */
adminAbacRouter.get('/admins/:userId/attributes', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminAttributeValueRepository(adapter);
    const userId = c.req.param('userId');

    const values = await repo.getAttributesByUser(userId);

    return c.json({
      items: values,
      total: values.length,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PUT /api/admin/admins/:userId/attributes/:attributeId
 * Set attribute value for an Admin user
 */
adminAbacRouter.put('/admins/:userId/attributes/:attributeId', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminAttributeValueRepository(adapter);
    const attrRepo = new AdminAttributeRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('userId');
    const attributeId = c.req.param('attributeId');

    // Verify attribute exists and belongs to this tenant
    const attribute = await attrRepo.getAttribute(attributeId);
    if (!attribute || (attribute.tenant_id !== tenantId && !attribute.is_system)) {
      return c.json({ error: 'not_found', message: 'Attribute not found' }, 404);
    }

    const body = await c.req.json<{
      value: string | number | boolean;
      value_index?: number;
      expires_at?: number;
    }>();

    if (body.value === undefined) {
      return c.json({ error: 'invalid_request', message: 'value is required' }, 400);
    }

    // Explicit field mapping to prevent Mass Assignment
    const value = await repo.setAttributeValue({
      tenant_id: tenantId,
      admin_user_id: userId,
      admin_attribute_id: attributeId,
      value: String(body.value),
      value_index: body.value_index ?? 0,
      expires_at: body.expires_at,
      assigned_by: authContext.userId,
    });

    await createAuditLog(c, 'admin_attribute_value.set', value.id, 'success', {
      admin_user_id: userId,
      attribute_id: attributeId,
    });

    return c.json(value);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admins/:userId/attributes/:attributeId
 * Delete attribute value for an Admin user
 */
adminAbacRouter.delete('/admins/:userId/attributes/:attributeId', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminAttributeValueRepository(adapter);
    const userId = c.req.param('userId');
    const attributeId = c.req.param('attributeId');
    const valueIndex = parseInt(c.req.query('value_index') || '0');

    const deleted = await repo.deleteAttributeValue(userId, attributeId, valueIndex);
    if (!deleted) {
      return c.json({ error: 'not_found', message: 'Attribute value not found' }, 404);
    }

    await createAuditLog(c, 'admin_attribute_value.delete', `${userId}:${attributeId}`, 'success');

    return c.json({ success: true });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export default adminAbacRouter;

/**
 * Admin ReBAC (Relationship-Based Access Control) API
 *
 * Endpoints for managing Admin relationships.
 * These operate on DB_ADMIN, separate from EndUser ReBAC.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  AdminRelationshipRepository,
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
export const adminRebacRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Apply admin authentication with ReBAC permissions
adminRebacRouter.use(
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
    resource_type: 'admin_relationship',
    resource_id: resourceId,
    result,
    ip_address: c.req.header('CF-Connecting-IP') || undefined,
    user_agent: c.req.header('User-Agent') || undefined,
    metadata,
  });
}

// =============================================================================
// Relationship Endpoints
// =============================================================================

/**
 * GET /api/admin/admin-relationships
 * List all Admin relationships
 */
adminRebacRouter.get('/admin-relationships', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRelationshipRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const relationshipType = c.req.query('type');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    const { relationships, total } = await repo.listRelationships(tenantId, {
      relationshipType,
      limit,
      offset,
    });

    return c.json({
      items: relationships,
      total,
      limit,
      offset,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-relationships/:id
 * Get Admin relationship by ID
 */
adminRebacRouter.get('/admin-relationships/:id', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRelationshipRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');

    const relationship = await repo.getRelationship(id);
    if (!relationship) {
      return c.json({ error: 'not_found', message: 'Relationship not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (relationship.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'Relationship not found' }, 404);
    }

    return c.json(relationship);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-relationships
 * Create new Admin relationship
 */
adminRebacRouter.post('/admin-relationships', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRelationshipRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json<{
      relationship_type: string;
      from_type?: string;
      from_id: string;
      to_type?: string;
      to_id: string;
      permission_level?: 'full' | 'limited' | 'read_only';
      is_transitive?: boolean;
      expires_at?: number;
      is_bidirectional?: boolean;
      metadata?: Record<string, unknown>;
    }>();

    // Validate required fields
    if (!body.relationship_type || !body.from_id || !body.to_id) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'relationship_type, from_id, and to_id are required',
        },
        400
      );
    }

    // Check for duplicate
    const exists = await repo.hasRelationship(body.from_id, body.to_id, body.relationship_type, {
      fromType: body.from_type,
      toType: body.to_type,
    });
    if (exists) {
      return c.json({ error: 'conflict', message: 'Relationship already exists' }, 409);
    }

    // Explicit field mapping to prevent Mass Assignment
    const relationship = await repo.createRelationship({
      tenant_id: tenantId,
      relationship_type: body.relationship_type,
      from_type: body.from_type,
      from_id: body.from_id,
      to_type: body.to_type,
      to_id: body.to_id,
      permission_level: body.permission_level,
      is_transitive: body.is_transitive,
      expires_at: body.expires_at,
      is_bidirectional: body.is_bidirectional,
      metadata: body.metadata,
      created_by: authContext.userId,
    });

    await createAuditLog(c, 'admin_relationship.create', relationship.id, 'success', {
      relationship_type: relationship.relationship_type,
      from_id: relationship.from_id,
      to_id: relationship.to_id,
    });

    return c.json(relationship, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admin-relationships/:id
 * Delete Admin relationship
 */
adminRebacRouter.delete('/admin-relationships/:id', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRelationshipRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');

    // Check if relationship exists and belongs to this tenant
    const existing = await repo.getRelationship(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'Relationship not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'Relationship not found' }, 404);
    }

    const deleted = await repo.deleteRelationship(id);
    if (!deleted) {
      return c.json({ error: 'not_found', message: 'Relationship not found' }, 404);
    }

    await createAuditLog(c, 'admin_relationship.delete', id, 'success');

    return c.json({ success: true });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

// =============================================================================
// User Relationship Endpoints
// =============================================================================

/**
 * GET /api/admin/admins/:userId/relationships
 * Get all relationships for an Admin user
 */
adminRebacRouter.get('/admins/:userId/relationships', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRelationshipRepository(adapter);
    const userId = c.req.param('userId');
    const relationshipType = c.req.query('type');
    const direction = c.req.query('direction') || 'both'; // from, to, both

    let from: typeof relationships = [];
    let to: typeof relationships = [];
    const relationships: Awaited<ReturnType<typeof repo.getRelationshipsFrom>> = [];

    if (direction === 'from' || direction === 'both') {
      from = await repo.getRelationshipsFrom(userId, { relationshipType });
    }
    if (direction === 'to' || direction === 'both') {
      to = await repo.getRelationshipsTo(userId, { relationshipType });
    }

    // Combine and deduplicate
    const combined = [...from, ...to];
    const seen = new Set<string>();
    for (const rel of combined) {
      if (!seen.has(rel.id)) {
        seen.add(rel.id);
        relationships.push(rel);
      }
    }

    return c.json({
      items: relationships,
      total: relationships.length,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admins/:userId/relationships
 * Create relationship for an Admin user
 */
adminRebacRouter.post('/admins/:userId/relationships', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRelationshipRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const userId = c.req.param('userId');
    const body = await c.req.json<{
      relationship_type: string;
      to_type?: string;
      to_id: string;
      permission_level?: 'full' | 'limited' | 'read_only';
      is_transitive?: boolean;
      expires_at?: number;
      is_bidirectional?: boolean;
      metadata?: Record<string, unknown>;
    }>();

    // Validate required fields
    if (!body.relationship_type || !body.to_id) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'relationship_type and to_id are required',
        },
        400
      );
    }

    // Check for duplicate
    const exists = await repo.hasRelationship(userId, body.to_id, body.relationship_type);
    if (exists) {
      return c.json({ error: 'conflict', message: 'Relationship already exists' }, 409);
    }

    // Explicit field mapping to prevent Mass Assignment
    const relationship = await repo.createRelationship({
      tenant_id: tenantId,
      relationship_type: body.relationship_type,
      from_id: userId,
      to_id: body.to_id,
      to_type: body.to_type,
      permission_level: body.permission_level,
      is_transitive: body.is_transitive,
      expires_at: body.expires_at,
      is_bidirectional: body.is_bidirectional,
      metadata: body.metadata,
      created_by: authContext.userId,
    });

    await createAuditLog(c, 'admin_relationship.create', relationship.id, 'success', {
      relationship_type: relationship.relationship_type,
      from_id: userId,
      to_id: relationship.to_id,
    });

    return c.json(relationship, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admins/:userId/relationships/:relationshipId
 * Delete specific relationship for an Admin user
 */
adminRebacRouter.delete(
  '/admins/:userId/relationships/:relationshipId',
  async (c: AdminContext) => {
    const authContext = c.get('adminAuth') as AdminAuthContext;
    if (!hasWritePermission(authContext)) {
      return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
    }

    try {
      const adapter = getAdminAdapter(c);
      const repo = new AdminRelationshipRepository(adapter);
      const tenantId = getTenantIdFromContext(c);
      const relationshipId = c.req.param('relationshipId');

      // Check if relationship exists and belongs to this tenant
      const existing = await repo.getRelationship(relationshipId);
      if (!existing) {
        return c.json({ error: 'not_found', message: 'Relationship not found' }, 404);
      }

      // Tenant boundary check - prevent IDOR
      if (existing.tenant_id !== tenantId) {
        return c.json({ error: 'not_found', message: 'Relationship not found' }, 404);
      }

      const deleted = await repo.deleteRelationship(relationshipId);
      if (!deleted) {
        return c.json({ error: 'not_found', message: 'Relationship not found' }, 404);
      }

      await createAuditLog(c, 'admin_relationship.delete', relationshipId, 'success');

      return c.json({ success: true });
    } catch (error) {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
  }
);

export default adminRebacRouter;

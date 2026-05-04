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
  AdminRelationshipRepository,
  AdminRebacDefinitionRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

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
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
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
  metadata?: Record<string, unknown>,
  resourceType: string = 'admin_relationship'
): Promise<void> {
  await writeAdminAuditLog(c, {
    action,
    resourceType,
    resourceId,
    result,
    metadata,
  });
}

// =============================================================================
// ReBAC Definition Endpoints
// =============================================================================

/**
 * GET /api/admin/admin-rebac-definitions
 * List all ReBAC relationship type definitions
 */
adminRebacRouter.get('/admin-rebac-definitions', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRebacDefinitionRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const includeSystem = c.req.query('include_system') !== 'false';
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined;
    const offset = c.req.query('offset') ? parseInt(c.req.query('offset')!) : undefined;

    const definitions = await repo.listDefinitions(tenantId, {
      includeSystem,
      limit,
      offset,
    });

    return c.json({
      items: definitions,
      total: definitions.length,
    });
  } catch (error) {
    console.error('Failed to list ReBAC definitions:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-rebac-definitions/:id
 * Get ReBAC definition by ID
 */
adminRebacRouter.get('/admin-rebac-definitions/:id', async (c: AdminContext) => {
  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRebacDefinitionRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;

    const definition = await repo.getDefinition(id);
    if (!definition) {
      return c.json({ error: 'not_found', message: 'ReBAC definition not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR (allow system definitions for all tenants)
    if (definition.tenant_id !== tenantId && !definition.is_system) {
      return c.json({ error: 'not_found', message: 'ReBAC definition not found' }, 404);
    }

    return c.json(definition);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/admin-rebac-definitions
 * Create new ReBAC relationship type definition
 */
adminRebacRouter.post('/admin-rebac-definitions', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRebacDefinitionRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const body = await c.req.json<{
      relation_name: string;
      display_name?: string;
      description?: string;
      priority?: number;
    }>();

    // Validate required fields
    if (!body.relation_name) {
      return c.json(
        {
          error: 'invalid_request',
          message: 'relation_name is required',
        },
        400
      );
    }

    // Check for duplicate
    const existing = await repo.getDefinitionByName(tenantId, body.relation_name);
    if (existing) {
      return c.json(
        { error: 'conflict', message: 'Definition with this name already exists' },
        409
      );
    }

    // Explicit field mapping to prevent Mass Assignment
    const definition = await repo.createDefinition({
      tenant_id: tenantId,
      relation_name: body.relation_name,
      display_name: body.display_name,
      description: body.description,
      priority: body.priority,
    });

    await createAuditLog(
      c,
      'admin_rebac_definition.create',
      definition.id,
      'success',
      {
        relation_name: definition.relation_name,
      },
      'admin_rebac_definition'
    );

    return c.json(definition, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /api/admin/admin-rebac-definitions/:id
 * Update ReBAC definition
 */
adminRebacRouter.patch('/admin-rebac-definitions/:id', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRebacDefinitionRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;

    // Check if definition exists
    const existing = await repo.getDefinition(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'ReBAC definition not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'ReBAC definition not found' }, 404);
    }

    // Can't update system definitions
    if (existing.is_system) {
      return c.json({ error: 'forbidden', message: 'Cannot update system definition' }, 403);
    }

    const body = await c.req.json<{
      display_name?: string;
      description?: string;
      priority?: number;
    }>();

    // Explicit field mapping to prevent Mass Assignment
    const definition = await repo.updateDefinition(id, {
      display_name: body.display_name,
      description: body.description,
      priority: body.priority,
    });

    if (!definition) {
      return c.json({ error: 'not_found', message: 'ReBAC definition not found' }, 404);
    }

    await createAuditLog(
      c,
      'admin_rebac_definition.update',
      id,
      'success',
      {
        changes: body,
      },
      'admin_rebac_definition'
    );

    return c.json(definition);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot update')) {
      return c.json({ error: 'forbidden', message: error.message }, 403);
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/admin-rebac-definitions/:id
 * Delete ReBAC definition
 */
adminRebacRouter.delete('/admin-rebac-definitions/:id', async (c: AdminContext) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  if (!hasWritePermission(authContext)) {
    return c.json({ error: 'forbidden', message: 'Write permission required' }, 403);
  }

  try {
    const adapter = getAdminAdapter(c);
    const repo = new AdminRebacDefinitionRepository(adapter);
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id')!;

    // Check if definition exists
    const existing = await repo.getDefinition(id);
    if (!existing) {
      return c.json({ error: 'not_found', message: 'ReBAC definition not found' }, 404);
    }

    // Tenant boundary check - prevent IDOR
    if (existing.tenant_id !== tenantId) {
      return c.json({ error: 'not_found', message: 'ReBAC definition not found' }, 404);
    }

    // Can't delete system definitions
    if (existing.is_system) {
      return c.json({ error: 'forbidden', message: 'Cannot delete system definition' }, 403);
    }

    const deleted = await repo.deleteDefinition(id);
    if (!deleted) {
      return c.json({ error: 'not_found', message: 'ReBAC definition not found' }, 404);
    }

    await createAuditLog(
      c,
      'admin_rebac_definition.delete',
      id,
      'success',
      {
        relation_name: existing.relation_name,
      },
      'admin_rebac_definition'
    );

    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Cannot delete')) {
      return c.json({ error: 'forbidden', message: error.message }, 403);
    }
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

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
    const id = c.req.param('id')!;

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
    const id = c.req.param('id')!;

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
    const userId = c.req.param('userId')!;
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
    const userId = c.req.param('userId')!;
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
      const relationshipId = c.req.param('relationshipId')!;

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

/**
 * ReBAC Admin API Endpoints
 *
 * Management endpoints for Relationship-Based Access Control:
 * - Relation definitions (viewer, editor, owner composition rules)
 * - Relationship tuples (user-relation-object)
 * - Permission check simulation
 *
 * All endpoints require admin authentication via adminAuthMiddleware()
 */

import { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  getTenantIdFromContext,
  D1Adapter,
  type DatabaseAdapter,
  type IStorageAdapter,
  escapeLikePattern,
  createErrorResponse,
  AR_ERROR_CODES,
  generateId,
  createAuditLogFromContext,
} from '@authrim/ar-lib-core';

/**
 * Hono context type with admin auth variable
 */
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/**
 * Base context type for utility functions that expect simpler context
 */
type BaseContext = Context<{ Bindings: Env }>;

/**
 * Cast AdminContext to BaseContext for utility function calls
 */
function asBaseContext(c: AdminContext): BaseContext {
  return c as unknown as BaseContext;
}

/**
 * Create database adapter from context
 */
function createAdapterFromContext(c: AdminContext): DatabaseAdapter {
  return new D1Adapter({ db: c.env.DB });
}

// =============================================================================
// Relation Definitions Management
// =============================================================================

/**
 * GET /api/admin/rebac/relation-definitions
 * List relation definitions with filtering
 */
export async function adminRelationDefinitionsListHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const objectType = c.req.query('object_type');
    const search = c.req.query('search');
    const isActive = c.req.query('is_active');

    const offset = (page - 1) * limit;

    // Build query
    const whereClauses: string[] = ['tenant_id IN (?, ?)'];
    const bindings: unknown[] = [tenantId, 'default'];

    if (objectType) {
      whereClauses.push('object_type = ?');
      bindings.push(objectType);
    }

    if (search) {
      const escapedSearch = escapeLikePattern(search);
      whereClauses.push(
        "(relation_name LIKE ? ESCAPE '\\' OR object_type LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"
      );
      bindings.push(`%${escapedSearch}%`, `%${escapedSearch}%`, `%${escapedSearch}%`);
    }

    if (isActive !== undefined) {
      whereClauses.push('is_active = ?');
      bindings.push(isActive === 'true' ? 1 : 0);
    }

    const whereClause = whereClauses.join(' AND ');

    // Get total count
    const countResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM relation_definitions WHERE ${whereClause}`,
      bindings
    );
    const total = countResult[0]?.count ?? 0;

    // Get paginated results
    const definitions = await adapter.query<{
      id: string;
      tenant_id: string;
      object_type: string;
      relation_name: string;
      definition_json: string;
      description: string | null;
      priority: number;
      is_active: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT * FROM relation_definitions
       WHERE ${whereClause}
       ORDER BY object_type ASC, priority DESC, relation_name ASC
       LIMIT ? OFFSET ?`,
      [...bindings, limit, offset]
    );

    return c.json({
      definitions: definitions.map((d) => ({
        id: d.id,
        tenant_id: d.tenant_id,
        object_type: d.object_type,
        relation_name: d.relation_name,
        definition: JSON.parse(d.definition_json),
        description: d.description,
        priority: d.priority,
        is_active: d.is_active === 1,
        created_at: d.created_at * 1000,
        updated_at: d.updated_at * 1000,
      })),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Failed to list relation definitions:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/rebac/relation-definitions/:id
 * Get a specific relation definition
 */
export async function adminRelationDefinitionGetHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id');

    const results = await adapter.query<{
      id: string;
      tenant_id: string;
      object_type: string;
      relation_name: string;
      definition_json: string;
      description: string | null;
      priority: number;
      is_active: number;
      created_at: number;
      updated_at: number;
    }>('SELECT * FROM relation_definitions WHERE id = ? AND tenant_id IN (?, ?)', [
      id,
      tenantId,
      'default',
    ]);

    if (results.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const d = results[0];
    return c.json({
      definition: {
        id: d.id,
        tenant_id: d.tenant_id,
        object_type: d.object_type,
        relation_name: d.relation_name,
        definition: JSON.parse(d.definition_json),
        description: d.description,
        priority: d.priority,
        is_active: d.is_active === 1,
        created_at: d.created_at * 1000,
        updated_at: d.updated_at * 1000,
      },
    });
  } catch (error) {
    console.error('Failed to get relation definition:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/rebac/relation-definitions
 * Create a new relation definition
 */
export async function adminRelationDefinitionCreateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const body = await c.req.json<{
      object_type: string;
      relation_name: string;
      definition: Record<string, unknown>;
      description?: string;
      priority?: number;
      is_active?: boolean;
    }>();

    // Validate required fields
    if (!body.object_type || !body.relation_name || !body.definition) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'object_type, relation_name, definition' },
      });
    }

    // Check for duplicate
    const existing = await adapter.query<{ id: string }>(
      `SELECT id FROM relation_definitions
       WHERE tenant_id = ? AND object_type = ? AND relation_name = ?`,
      [tenantId, body.object_type, body.relation_name]
    );

    if (existing.length > 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    const now = Math.floor(Date.now() / 1000);
    const id = generateId();

    await adapter.execute(
      `INSERT INTO relation_definitions
       (id, tenant_id, object_type, relation_name, definition_json, description, priority, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        body.object_type,
        body.relation_name,
        JSON.stringify(body.definition),
        body.description ?? null,
        body.priority ?? 0,
        body.is_active !== false ? 1 : 0,
        now,
        now,
      ]
    );

    // Audit log
    await createAuditLogFromContext(asBaseContext(c), 'create', 'relation_definition', id, {
      object_type: body.object_type,
      relation_name: body.relation_name,
    });

    return c.json(
      {
        definition: {
          id,
          tenant_id: tenantId,
          object_type: body.object_type,
          relation_name: body.relation_name,
          definition: body.definition,
          description: body.description ?? null,
          priority: body.priority ?? 0,
          is_active: body.is_active !== false,
          created_at: now * 1000,
          updated_at: now * 1000,
        },
      },
      201
    );
  } catch (error) {
    console.error('Failed to create relation definition:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PUT /api/admin/rebac/relation-definitions/:id
 * Update a relation definition
 */
export async function adminRelationDefinitionUpdateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id');
    const body = await c.req.json<{
      definition?: Record<string, unknown>;
      description?: string;
      priority?: number;
      is_active?: boolean;
    }>();

    // Check if exists and belongs to tenant (not default)
    const existing = await adapter.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM relation_definitions WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (existing[0].tenant_id === 'default') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (existing[0].tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    const now = Math.floor(Date.now() / 1000);
    const updates: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (body.definition !== undefined) {
      updates.push('definition_json = ?');
      params.push(JSON.stringify(body.definition));
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      params.push(body.description);
    }
    if (body.priority !== undefined) {
      updates.push('priority = ?');
      params.push(body.priority);
    }
    if (body.is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(body.is_active ? 1 : 0);
    }

    params.push(id);
    await adapter.execute(
      `UPDATE relation_definitions SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // Audit log
    await createAuditLogFromContext(asBaseContext(c), 'update', 'relation_definition', id, {
      changes: Object.keys(body),
    });

    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to update relation definition:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/rebac/relation-definitions/:id
 * Delete a relation definition
 */
export async function adminRelationDefinitionDeleteHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id');

    // Check if exists and belongs to tenant (not default)
    const existing = await adapter.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM relation_definitions WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (existing[0].tenant_id === 'default') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    if (existing[0].tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    await adapter.execute('DELETE FROM relation_definitions WHERE id = ?', [id]);

    // Audit log
    await createAuditLogFromContext(asBaseContext(c), 'delete', 'relation_definition', id, {});

    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to delete relation definition:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Relationship Tuples Management
// =============================================================================

/**
 * GET /api/admin/rebac/tuples
 * List relationship tuples with filtering
 */
export async function adminRelationshipTuplesListHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const fromType = c.req.query('from_type');
    const fromId = c.req.query('from_id');
    const toType = c.req.query('to_type');
    const toId = c.req.query('to_id');
    const relationshipType = c.req.query('relationship_type');

    const offset = (page - 1) * limit;

    // Build query
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    if (fromType) {
      whereClauses.push('from_type = ?');
      bindings.push(fromType);
    }
    if (fromId) {
      whereClauses.push('from_id = ?');
      bindings.push(fromId);
    }
    if (toType) {
      whereClauses.push('to_type = ?');
      bindings.push(toType);
    }
    if (toId) {
      whereClauses.push('to_id = ?');
      bindings.push(toId);
    }
    if (relationshipType) {
      whereClauses.push('relationship_type = ?');
      bindings.push(relationshipType);
    }

    const whereClause = whereClauses.join(' AND ');

    // Get total count
    const countResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM relationships WHERE ${whereClause}`,
      bindings
    );
    const total = countResult[0]?.count ?? 0;

    // Get paginated results
    const tuples = await adapter.query<{
      id: string;
      tenant_id: string;
      relationship_type: string;
      from_type: string;
      from_id: string;
      to_type: string;
      to_id: string;
      permission_level: string;
      expires_at: number | null;
      is_bidirectional: number;
      metadata_json: string | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT * FROM relationships
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...bindings, limit, offset]
    );

    return c.json({
      tuples: tuples.map((t) => ({
        id: t.id,
        tenant_id: t.tenant_id,
        relationship_type: t.relationship_type,
        from_type: t.from_type,
        from_id: t.from_id,
        to_type: t.to_type,
        to_id: t.to_id,
        permission_level: t.permission_level,
        expires_at: t.expires_at ? t.expires_at * 1000 : null,
        is_bidirectional: t.is_bidirectional === 1,
        metadata: t.metadata_json ? JSON.parse(t.metadata_json) : null,
        created_at: t.created_at * 1000,
        updated_at: t.updated_at * 1000,
      })),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Failed to list relationship tuples:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/rebac/tuples
 * Create a new relationship tuple
 */
export async function adminRelationshipTupleCreateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const body = await c.req.json<{
      relationship_type: string;
      from_type?: string;
      from_id: string;
      to_type: string;
      to_id: string;
      permission_level?: string;
      expires_at?: number;
      metadata?: Record<string, unknown>;
    }>();

    // Validate required fields
    if (!body.relationship_type || !body.from_id || !body.to_type || !body.to_id) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'relationship_type, from_id, to_type, to_id' },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const id = generateId();

    await adapter.execute(
      `INSERT INTO relationships
       (id, tenant_id, relationship_type, from_type, from_id, to_type, to_id, permission_level, expires_at, is_bidirectional, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        body.relationship_type,
        body.from_type ?? 'subject',
        body.from_id,
        body.to_type,
        body.to_id,
        body.permission_level ?? 'full',
        body.expires_at ? Math.floor(body.expires_at / 1000) : null,
        0, // is_bidirectional
        body.metadata ? JSON.stringify(body.metadata) : null,
        now,
        now,
      ]
    );

    // Audit log
    await createAuditLogFromContext(asBaseContext(c), 'create', 'relationship_tuple', id, {
      relationship_type: body.relationship_type,
      from: `${body.from_type ?? 'subject'}:${body.from_id}`,
      to: `${body.to_type}:${body.to_id}`,
    });

    return c.json(
      {
        tuple: {
          id,
          tenant_id: tenantId,
          relationship_type: body.relationship_type,
          from_type: body.from_type ?? 'subject',
          from_id: body.from_id,
          to_type: body.to_type,
          to_id: body.to_id,
          permission_level: body.permission_level ?? 'full',
          expires_at: body.expires_at ?? null,
          is_bidirectional: false,
          metadata: body.metadata ?? null,
          created_at: now * 1000,
          updated_at: now * 1000,
        },
      },
      201
    );
  } catch (error) {
    console.error('Failed to create relationship tuple:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/rebac/tuples/:id
 * Delete a relationship tuple
 */
export async function adminRelationshipTupleDeleteHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id');

    // Check if exists
    const existing = await adapter.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM relationships WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    if (existing[0].tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    }

    await adapter.execute('DELETE FROM relationships WHERE id = ?', [id]);

    // Audit log
    await createAuditLogFromContext(asBaseContext(c), 'delete', 'relationship_tuple', id, {});

    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to delete relationship tuple:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Permission Check Simulation
// =============================================================================

/**
 * POST /api/admin/rebac/check
 * Simulate a permission check (for debugging/testing)
 */
export async function adminRelationshipCheckHandler(c: AdminContext) {
  try {
    // Create IStorageAdapter wrapper for ReBACService
    // ReBACService only uses query() and execute() methods
    const dbAdapter = createAdapterFromContext(c);
    const storageAdapter: IStorageAdapter = {
      get: async () => null, // Not used by ReBACService
      set: async () => {}, // Not used by ReBACService
      delete: async () => {}, // Not used by ReBACService
      query: dbAdapter.query.bind(dbAdapter),
      execute: dbAdapter.execute.bind(dbAdapter),
    };
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const body = await c.req.json<{
      user_id: string;
      relation: string;
      object: string;
      object_type?: string;
      contextual_tuples?: Array<{
        user_id: string;
        relation: string;
        object: string;
        object_type?: string;
      }>;
    }>();

    // Validate required fields
    if (!body.user_id || !body.relation || !body.object) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'user_id, relation, object' },
      });
    }

    // Import ReBACService dynamically to avoid circular dependencies
    const { ReBACService } = await import('@authrim/ar-lib-core');

    const rebacService = new ReBACService(storageAdapter);
    const result = await rebacService.check({
      tenant_id: tenantId,
      user_id: body.user_id,
      relation: body.relation,
      object: body.object,
      object_type: body.object_type,
      context: body.contextual_tuples
        ? {
            contextual_tuples: body.contextual_tuples,
          }
        : undefined,
    });

    return c.json({
      allowed: result.allowed,
      resolved_via: result.resolved_via,
      path: result.path,
    });
  } catch (error) {
    console.error('Failed to check permission:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Object Types Summary
// =============================================================================

/**
 * GET /api/admin/rebac/object-types
 * Get unique object types used in relation definitions
 */
export async function adminObjectTypesListHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));

    const results = await adapter.query<{ object_type: string; count: number }>(
      `SELECT object_type, COUNT(*) as count
       FROM relation_definitions
       WHERE tenant_id IN (?, ?)
       GROUP BY object_type
       ORDER BY object_type ASC`,
      [tenantId, 'default']
    );

    return c.json({
      object_types: results.map((r) => ({
        name: r.object_type,
        definition_count: r.count,
      })),
    });
  } catch (error) {
    console.error('Failed to list object types:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

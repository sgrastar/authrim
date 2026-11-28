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
  createAuthContextFromHono,
  type DatabaseAdapter,
  type IStorageAdapter,
  escapeLikePattern,
  createErrorResponse,
  AR_ERROR_CODES,
  generateId,
  ruleOnRelationshipTupleSource,
  relationshipSourceTypes,
  isUniqueConstraintError,
  relationDefinitionErrors,
  subjectGroupsResolver,
  guardGroupUsersetWrite,
  parseObjectString,
  externalSubjectId,
} from '@authrim/ar-lib-core';
import { recordAdminOperationAudit } from './admin-operation-audit';
import { subjectAccountOf } from './admin-access-check';
import { bumpTenantReBACVersion } from './rebac-version';

/** Bumps the tenant's ReBAC version after a definition or tuple write (rebac-version.ts). */
function bumpReBACVersion(c: AdminContext, tenantId: string): Promise<void> {
  return bumpTenantReBACVersion(asBaseContext(c), tenantId);
}

/**
 * A stored definition as the API returns it: the expression, and `unusable: true` when the
 * relation parser rejects it (checks on its relation then deny; see rebac-service.ts). One that
 * is not even JSON is returned as `definition: null`.
 */
function storedDefinition(definitionJson: string): { definition: unknown; unusable: boolean } {
  let definition: unknown = null;
  try {
    definition = JSON.parse(definitionJson);
  } catch {
    return { definition: null, unusable: true };
  }
  return { definition, unusable: relationDefinitionErrors(definitionJson).length > 0 };
}

/** The errors of a definition a request sent (it must be an expression object). */
function requestDefinitionErrors(definition: unknown): string[] {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return ['definition must be a relation expression object'];
  }
  return relationDefinitionErrors(definition);
}

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
  const tenantId = getTenantIdFromContext(asBaseContext(c));
  return createAuthContextFromHono(asBaseContext(c), tenantId).coreAdapter;
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
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

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
        ...storedDefinition(d.definition_json),
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
    const id = c.req.param('id')!;

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
    }>('SELECT * FROM relation_definitions WHERE id = ? AND tenant_id = ?', [id, tenantId]);

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
        ...storedDefinition(d.definition_json),
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
    // An expression the relation parser rejects is never stored (it would deny every check).
    if (requestDefinitionErrors(body.definition).length > 0) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_REBAC_DEFINITION_INVALID);
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
    await bumpReBACVersion(c, tenantId);
    await recordAdminOperationAudit(asBaseContext(c), {
      action: 'create',
      resourceType: 'relation_definition',
      resourceId: id,
      metadata: {
        object_type: body.object_type,
        relation_name: body.relation_name,
      },
    });

    return c.json(
      {
        definition: {
          id,
          tenant_id: tenantId,
          object_type: body.object_type,
          relation_name: body.relation_name,
          definition: body.definition,
          unusable: false,
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
    const id = c.req.param('id')!;
    const body = await c.req.json<{
      definition?: Record<string, unknown>;
      description?: string;
      priority?: number;
      is_active?: boolean;
    }>();

    // An expression the relation parser rejects is never stored (it would deny every check).
    if (body.definition !== undefined && requestDefinitionErrors(body.definition).length > 0) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_REBAC_DEFINITION_INVALID);
    }

    // Check if exists and belongs to the current tenant
    const existing = await adapter.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM relation_definitions WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (existing.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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

    params.push(id, tenantId);
    await adapter.execute(
      `UPDATE relation_definitions SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );

    // Audit log
    await bumpReBACVersion(c, tenantId);
    await recordAdminOperationAudit(asBaseContext(c), {
      action: 'update',
      resourceType: 'relation_definition',
      resourceId: id,
      metadata: {
        changes: Object.keys(body),
      },
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
    const id = c.req.param('id')!;

    // Check if exists and belongs to the current tenant
    const existing = await adapter.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM relation_definitions WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (existing.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await adapter.execute('DELETE FROM relation_definitions WHERE id = ? AND tenant_id = ?', [
      id,
      tenantId,
    ]);

    // Audit log
    await bumpReBACVersion(c, tenantId);
    await recordAdminOperationAudit(asBaseContext(c), {
      action: 'delete',
      resourceType: 'relation_definition',
      resourceId: id,
      metadata: {},
    });

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
      // `subject` and `user` (what older writes stored) list the same direct subjects.
      whereClauses.push('from_type IN (?, ?)');
      bindings.push(...relationshipSourceTypes(fromType === 'user' ? 'subject' : fromType));
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
      from_relation: string | null;
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
        from_relation: t.from_relation ?? null,
        // A group row from before migration 020 (no `member`): listed, grants nothing until it
        // is written again through the guarded APIs.
        inactive_legacy: t.from_type === 'group' && t.from_relation !== 'member',
        to_type: t.to_type,
        to_id: t.to_id,
        permission_level: t.permission_level,
        expires_at:
          t.expires_at === null || t.expires_at === undefined ? null : t.expires_at * 1000,
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
 *
 * Only the tuple types of ar-lib-core's rebac/tuple-type-rules.ts are accepted, as on
 * `/api/rebac/write`: a direct subject (`from_type` `subject`, the default, or `user`, stored as
 * `subject`), a group userset (`group`, stored with `from_relation = 'member'`: every effective
 * member of the group; `from_relation` may be sent only as `member` and only with a group), or
 * an object edge declared as the source of a `tuple_to_userset`. Others are refused with 400
 * (POLICY_REBAC_TUPLE_TYPE_NOT_ALLOWED). A tuple that already exists (same relation, source and
 * target, after that normalisation) is refused with 409.
 */
export async function adminRelationshipTupleCreateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const body = await c.req.json<{
      relationship_type: string;
      from_type?: string;
      from_id: string;
      from_relation?: unknown;
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
    // expires_at: integer milliseconds (stored as whole seconds), or absent / null.
    if (
      body.expires_at !== undefined &&
      body.expires_at !== null &&
      !Number.isSafeInteger(body.expires_at)
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    }

    const source = await ruleOnRelationshipTupleSource(adapter, {
      tenantId,
      fromType: body.from_type ?? 'subject',
      relationshipType: body.relationship_type,
      fromRelation: body.from_relation,
    });
    if (!source.allowed) {
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_REBAC_TUPLE_TYPE_NOT_ALLOWED);
    }
    const fromType = source.fromType;

    // Uniqueness on the stored (normalised) key, as idx_relationships_unique holds it; a direct
    // subject also matches a row an older write stored as `user`.
    const duplicate = await adapter.query<{ id: string }>(
      `SELECT id FROM relationships
       WHERE tenant_id = ? AND relationship_type = ? AND from_type IN (?, ?) AND from_id = ?
         AND to_type = ? AND to_id = ?
       LIMIT 1`,
      [
        tenantId,
        body.relationship_type,
        ...relationshipSourceTypes(fromType),
        body.from_id,
        body.to_type,
        body.to_id,
      ]
    );
    if (duplicate.length > 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    const now = Math.floor(Date.now() / 1000);
    const id = generateId();

    const columns = `id, tenant_id, relationship_type, from_type, from_id, from_relation, to_type,
      to_id, permission_level, expires_at, is_bidirectional, metadata_json, created_at, updated_at`;
    const values = [
      id,
      tenantId,
      body.relationship_type,
      fromType,
      body.from_id,
      source.fromRelation,
      body.to_type,
      body.to_id,
      body.permission_level ?? 'full',
      // Any integer is an expiry (0: already expired); null / absent is none.
      body.expires_at === undefined || body.expires_at === null
        ? null
        : Math.floor(body.expires_at / 1000),
      0, // is_bidirectional
      body.metadata ? JSON.stringify(body.metadata) : null,
      now,
      now,
    ];

    // A concurrent create of the same tuple loses on idx_relationships_unique (D1 and, since
    // migration 020, PostgreSQL): 409, as the check above.
    try {
      if (source.kind === 'group_userset') {
        // A group userset gives the group's members the relation, as a role on the group does:
        // not on a group with a service group below it that an attribute people write themselves
        // decides. The check and the insert are one transaction under the catalog lock, and the
        // insert holds only while the catalog revision the check read does (D1).
        const outcome = await guardGroupUsersetWrite(
          adapter,
          tenantId,
          body.from_id,
          async (_reader, fence) => ({
            statements: [
              {
                sql: `INSERT INTO relationships (${columns})
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS BIGINT), CAST(? AS BOOLEAN), ?,
                 CAST(? AS BIGINT), CAST(? AS BIGINT) WHERE ${fence.sql}`,
                params: [...values, ...fence.params],
              },
            ],
            result: true,
          })
        );
        if (outcome.kind === 'group_self_writable_attribute') {
          return c.json(
            {
              error: 'group_self_writable_attribute',
              error_description:
                'A service group below this group is decided by an attribute users can set themselves: it cannot carry relations',
            },
            400
          );
        }
        if (outcome.kind === 'group_version_conflict') {
          return c.json(
            {
              error: 'group_version_conflict',
              error_description:
                'The service-group rules changed while the tuple was checked: retry',
            },
            409
          );
        }
      } else {
        await adapter.execute(
          `INSERT INTO relationships (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values
        );
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
      }
      throw error;
    }

    // Audit log
    await bumpReBACVersion(c, tenantId);
    await recordAdminOperationAudit(asBaseContext(c), {
      action: 'create',
      resourceType: 'relationship_tuple',
      resourceId: id,
      metadata: {
        relationship_type: body.relationship_type,
        from: `${fromType}:${body.from_id}`,
        to: `${body.to_type}:${body.to_id}`,
      },
    });

    return c.json(
      {
        tuple: {
          id,
          tenant_id: tenantId,
          relationship_type: body.relationship_type,
          from_type: fromType,
          from_id: body.from_id,
          from_relation: source.fromRelation,
          inactive_legacy: false,
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
    const id = c.req.param('id')!;

    // Check if exists
    const readRow = async () =>
      (
        await adapter.query<{
          tenant_id: string;
          from_type?: string;
          from_id?: string;
          from_relation?: string | null;
        }>(
          'SELECT tenant_id, from_type, from_id, from_relation FROM relationships WHERE id = ? AND tenant_id = ?',
          [id, tenantId]
        )
      )[0];
    const conflict = () =>
      c.json(
        {
          error: 'group_version_conflict',
          error_description:
            'The service-group rules or the authorization changed while the tuple was checked: retry',
        },
        409
      );

    let row = await readRow();
    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // A group userset goes through the guarded write; a legacy (inert) group row or another
    // tuple is deleted directly, a legacy one only while it is still inert (a row that became
    // `member` meanwhile is read again and routed to the guarded write).
    for (let attempt = 0; ; attempt++) {
      if (row.from_type === 'group' && row.from_relation === 'member' && row.from_id) {
        // Taking a userset away raises the tenant authorization version, fenced as a write (a
        // service-group rule save checked meanwhile then conflicts, and the other way round).
        const outcome = await guardGroupUsersetWrite(
          adapter,
          tenantId,
          row.from_id,
          async (_reader, fence) => ({
            statements: [
              {
                sql: `DELETE FROM relationships WHERE id = ? AND tenant_id = ? AND ${fence.sql}`,
                params: [id, tenantId, ...fence.params],
              },
            ],
            result: true,
          }),
          { refuseSelfWritable: false }
        );
        if (outcome.kind !== 'written') return conflict();
        break;
      }
      if (row.from_type !== 'group') {
        await adapter.execute('DELETE FROM relationships WHERE id = ? AND tenant_id = ?', [
          id,
          tenantId,
        ]);
        break;
      }
      const deleted = await adapter.execute(
        `DELETE FROM relationships
          WHERE id = ? AND tenant_id = ? AND from_type = 'group' AND from_relation IS NULL`,
        [id, tenantId]
      );
      if ((deleted.rowsAffected ?? 0) > 0) break;
      const current = await readRow();
      if (!current) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }
      if (attempt >= 1) return conflict();
      row = current;
    }

    // Audit log
    await bumpReBACVersion(c, tenantId);
    await recordAdminOperationAudit(asBaseContext(c), {
      action: 'delete',
      resourceType: 'relationship_tuple',
      resourceId: id,
      metadata: {},
    });

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
      subject_id?: string;
      user_id?: string;
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

    // `subject_id` is the stored id, taken verbatim (the console's picker value); the legacy
    // `user_id` keeps its meaning: one leading `user:` is taken away, as on /api/rebac/check.
    const subjectId =
      body.subject_id !== undefined
        ? body.subject_id
        : typeof body.user_id === 'string'
          ? externalSubjectId(body.user_id)
          : undefined;
    if (!subjectId || typeof subjectId !== 'string' || !body.relation || !body.object) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'subject_id, relation, object' },
      });
    }
    const target = body.object_type
      ? { type: body.object_type, id: body.object }
      : parseObjectString(body.object);

    // Import ReBACService dynamically to avoid circular dependencies
    const { ReBACService } = await import('@authrim/ar-lib-core/rebac/rebac-service');

    // Group usersets: the subject's groups from its account (as the Check API reads them).
    const rebacService = new ReBACService(storageAdapter, {
      subject_groups: subjectGroupsResolver(dbAdapter, (tenant, subject) =>
        subjectAccountOf(c.env, tenant, subject)
      ),
    });
    const result = await rebacService.checkResolved({
      tenantId,
      subjectId,
      relation: body.relation,
      objectType: target.type,
      objectId: target.id,
      ...(body.contextual_tuples && {
        contextualTuples: body.contextual_tuples
          // Named in the same form as the subject (verbatim with subject_id, one `user:` taken
          // away with user_id).
          .filter(
            (tuple) =>
              (body.subject_id !== undefined ? tuple.user_id : externalSubjectId(tuple.user_id)) ===
              subjectId
          )
          .map((tuple) => {
            const object = tuple.object_type
              ? { type: tuple.object_type, id: tuple.object }
              : parseObjectString(tuple.object);
            return { relation: tuple.relation, objectType: object.type, objectId: object.id };
          }),
      }),
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
       WHERE tenant_id = ?
       GROUP BY object_type
       ORDER BY object_type ASC`,
      [tenantId]
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

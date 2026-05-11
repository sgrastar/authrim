/**
 * ABAC Admin API Endpoints
 *
 * Management endpoints for Attribute-Based Access Control:
 * - List and search user attributes
 * - Manually assign/update/delete attributes
 * - View attribute verification history
 * - Bulk operations for attributes
 *
 * All endpoints require admin authentication via adminAuthMiddleware()
 */

import { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  getTenantIdFromContext,
  createAuthContextFromHono,
  type DatabaseAdapter,
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
 * Base context type for utility functions
 */
type BaseContext = Context<{ Bindings: Env }>;

/**
 * Cast AdminContext to BaseContext
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

function isUniqueConstraintError(error: unknown): boolean {
  return String(error).includes('UNIQUE constraint');
}

// =============================================================================
// User Attributes Management
// =============================================================================

/**
 * GET /api/admin/attributes
 * List all user attributes with filtering and pagination
 */
export async function adminAttributesListHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = (page - 1) * limit;

    // Filter parameters
    const userId = c.req.query('user_id');
    const attributeName = c.req.query('attribute_name');
    const sourceType = c.req.query('source_type');
    const includeExpired = c.req.query('include_expired') === 'true';
    const search = c.req.query('search');

    // Build query
    let whereConditions = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (userId) {
      whereConditions.push('user_id = ?');
      params.push(userId);
    }

    if (attributeName) {
      whereConditions.push('attribute_name = ?');
      params.push(attributeName);
    }

    if (sourceType) {
      whereConditions.push('source_type = ?');
      params.push(sourceType);
    }

    if (!includeExpired) {
      whereConditions.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(Math.floor(Date.now() / 1000));
    }

    if (search) {
      whereConditions.push('(attribute_name LIKE ? OR attribute_value LIKE ? OR user_id LIKE ?)');
      const searchPattern = `%${escapeLikePattern(search)}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    const whereClause = whereConditions.join(' AND ');

    // Count total
    const countResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM user_verified_attributes WHERE ${whereClause}`,
      params
    );
    const total = countResult[0]?.count || 0;

    // Get attributes with user info
    const attributes = await adapter.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      attribute_name: string;
      attribute_value: string;
      source_type: string;
      issuer_did: string | null;
      verification_id: string | null;
      verified_at: number;
      expires_at: number | null;
      user_email: string | null;
      user_name: string | null;
    }>(
      `SELECT
        a.id, a.tenant_id, a.user_id, a.attribute_name, a.attribute_value,
        a.source_type, a.issuer_did, a.verification_id, a.verified_at, a.expires_at,
        u.email as user_email, u.name as user_name
       FROM user_verified_attributes a
       LEFT JOIN users u ON a.user_id = u.id AND a.tenant_id = u.tenant_id
       WHERE ${whereClause
         .replace(/tenant_id/g, 'a.tenant_id')
         .replace(/user_id/g, 'a.user_id')
         .replace(/attribute_name/g, 'a.attribute_name')
         .replace(/attribute_value/g, 'a.attribute_value')
         .replace(/source_type/g, 'a.source_type')
         .replace(/expires_at/g, 'a.expires_at')}
       ORDER BY a.verified_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return c.json({
      attributes,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Failed to list attributes:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/attributes/users/:userId
 * Get all attributes for a specific user
 */
export async function adminUserAttributesHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const userId = c.req.param('userId')!;
    const includeExpired = c.req.query('include_expired') === 'true';

    let query = `
      SELECT id, tenant_id, user_id, attribute_name, attribute_value,
             source_type, issuer_did, verification_id, verified_at, expires_at
      FROM user_verified_attributes
      WHERE tenant_id = ? AND user_id = ?
    `;
    const params: unknown[] = [tenantId, userId];

    if (!includeExpired) {
      query += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(Math.floor(Date.now() / 1000));
    }

    query += ' ORDER BY attribute_name ASC';

    const attributes = await adapter.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      attribute_name: string;
      attribute_value: string;
      source_type: string;
      issuer_did: string | null;
      verification_id: string | null;
      verified_at: number;
      expires_at: number | null;
    }>(query, params);

    // Get user info
    const userResult = await adapter.query<{
      id: string;
      email: string;
      name: string | null;
    }>('SELECT id, email, name FROM users WHERE tenant_id = ? AND id = ?', [tenantId, userId]);

    return c.json({
      user: userResult[0] || null,
      attributes,
    });
  } catch (error) {
    console.error('Failed to get user attributes:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/attributes
 * Manually create/assign an attribute to a user
 */
export async function adminAttributeCreateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const body = await c.req.json<{
      user_id: string;
      attribute_name: string;
      attribute_value: string;
      expires_at?: number; // Unix timestamp in seconds
    }>();

    // Validate required fields
    if (!body.user_id || !body.attribute_name || body.attribute_value === undefined) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
        variables: { field: 'user_id, attribute_name, attribute_value' },
      });
    }

    // Check if user exists
    const userExists = await adapter.query<{ id: string }>(
      'SELECT id FROM users WHERE tenant_id = ? AND id = ?',
      [tenantId, body.user_id]
    );

    if (userExists.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const now = Math.floor(Date.now() / 1000);
    const existing = await adapter.queryOne<{
      id: string;
      created_at: number;
    }>(
      `SELECT id, created_at
       FROM user_verified_attributes
       WHERE tenant_id = ? AND user_id = ? AND attribute_name = ?`,
      [tenantId, body.user_id, body.attribute_name]
    );

    let id = existing?.id ?? generateId();

    if (existing) {
      await adapter.execute(
        `UPDATE user_verified_attributes
         SET attribute_value = ?,
             source_type = 'manual',
             issuer_did = NULL,
             verification_id = NULL,
             verified_at = ?,
             expires_at = ?,
             updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [body.attribute_value, now, body.expires_at || null, now, existing.id, tenantId]
      );
    } else {
      try {
        await adapter.execute(
          `INSERT INTO user_verified_attributes
           (id, tenant_id, user_id, attribute_name, attribute_value, source_type, verified_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
          [
            id,
            tenantId,
            body.user_id,
            body.attribute_name,
            body.attribute_value,
            now,
            body.expires_at || null,
            now,
            now,
          ]
        );
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }

        const raced = await adapter.queryOne<{ id: string; created_at: number }>(
          `SELECT id, created_at
           FROM user_verified_attributes
           WHERE tenant_id = ? AND user_id = ? AND attribute_name = ?`,
          [tenantId, body.user_id, body.attribute_name]
        );

        if (!raced) {
          throw new Error('Failed to resolve raced user attribute');
        }

        id = raced.id;

        await adapter.execute(
          `UPDATE user_verified_attributes
           SET attribute_value = ?,
               source_type = 'manual',
               issuer_did = NULL,
               verification_id = NULL,
               verified_at = ?,
               expires_at = ?,
               updated_at = ?
           WHERE id = ? AND tenant_id = ?`,
          [body.attribute_value, now, body.expires_at || null, now, raced.id, tenantId]
        );
      }
    }

    // Audit log
    await createAuditLogFromContext(asBaseContext(c), 'create', 'user_attribute', id, {
      user_id: body.user_id,
      attribute_name: body.attribute_name,
    });

    return c.json(
      {
        attribute: {
          id,
          tenant_id: tenantId,
          user_id: body.user_id,
          attribute_name: body.attribute_name,
          attribute_value: body.attribute_value,
          source_type: 'manual',
          issuer_did: null,
          verification_id: null,
          verified_at: now,
          expires_at: body.expires_at || null,
        },
      },
      201
    );
  } catch (error) {
    console.error('Failed to create attribute:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PUT /api/admin/attributes/:id
 * Update an existing attribute
 */
export async function adminAttributeUpdateHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id')!;
    const body = await c.req.json<{
      attribute_value?: string;
      expires_at?: number | null;
    }>();

    // Check if attribute exists
    const existing = await adapter.query<{ tenant_id: string; source_type: string }>(
      'SELECT tenant_id, source_type FROM user_verified_attributes WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (existing.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Build update
    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.attribute_value !== undefined) {
      updates.push('attribute_value = ?');
      params.push(body.attribute_value);
      // Mark as manual when value is manually updated
      updates.push("source_type = 'manual'");
    }

    if (body.expires_at !== undefined) {
      updates.push('expires_at = ?');
      params.push(body.expires_at);
    }

    if (updates.length === 0) {
      return c.json({ success: true });
    }

    const now = Math.floor(Date.now() / 1000);
    updates.push('verified_at = ?');
    params.push(now);

    params.push(id);
    params.push(tenantId);
    await adapter.execute(
      `UPDATE user_verified_attributes SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );

    // Audit log
    await createAuditLogFromContext(asBaseContext(c), 'update', 'user_attribute', id, {
      changes: Object.keys(body),
    });

    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to update attribute:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/attributes/:id
 * Delete an attribute
 */
export async function adminAttributeDeleteHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const id = c.req.param('id')!;

    // Check if attribute exists
    const existing = await adapter.query<{
      tenant_id: string;
      user_id: string;
      attribute_name: string;
    }>(
      'SELECT tenant_id, user_id, attribute_name FROM user_verified_attributes WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (existing.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await adapter.execute('DELETE FROM user_verified_attributes WHERE id = ? AND tenant_id = ?', [
      id,
      tenantId,
    ]);

    // Audit log
    await createAuditLogFromContext(asBaseContext(c), 'delete', 'user_attribute', id, {
      user_id: existing[0].user_id,
      attribute_name: existing[0].attribute_name,
    });

    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to delete attribute:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Attribute Verification History
// =============================================================================

/**
 * GET /api/admin/attributes/verifications
 * List attribute verification history
 */
export async function adminVerificationsListHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = (page - 1) * limit;

    // Filter parameters
    const userId = c.req.query('user_id');
    const result = c.req.query('result'); // 'verified', 'failed', 'expired'

    let whereConditions = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (userId) {
      whereConditions.push('user_id = ?');
      params.push(userId);
    }

    if (result) {
      whereConditions.push('verification_result = ?');
      params.push(result);
    }

    const whereClause = whereConditions.join(' AND ');

    // Count total
    const countResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM attribute_verifications WHERE ${whereClause}`,
      params
    );
    const total = countResult[0]?.count || 0;

    // Get verifications
    const verifications = await adapter.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      vp_request_id: string | null;
      issuer_did: string;
      credential_type: string;
      format: string;
      verification_result: string;
      holder_binding_verified: number;
      issuer_trusted: number;
      status_valid: number;
      mapped_attribute_ids: string | null;
      verified_at: string;
      expires_at: string | null;
    }>(
      `SELECT * FROM attribute_verifications
       WHERE ${whereClause}
       ORDER BY verified_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return c.json({
      verifications: verifications.map((v) => ({
        ...v,
        holder_binding_verified: Boolean(v.holder_binding_verified),
        issuer_trusted: Boolean(v.issuer_trusted),
        status_valid: Boolean(v.status_valid),
        mapped_attribute_ids: v.mapped_attribute_ids ? JSON.parse(v.mapped_attribute_ids) : [],
      })),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Failed to list verifications:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Attribute Statistics
// =============================================================================

/**
 * GET /api/admin/attributes/stats
 * Get attribute statistics
 */
export async function adminAttributeStatsHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const now = Math.floor(Date.now() / 1000);

    // Total attributes
    const totalResult = await adapter.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM user_verified_attributes WHERE tenant_id = ?',
      [tenantId]
    );

    // Active (non-expired) attributes
    const activeResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM user_verified_attributes
       WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, now]
    );

    // Expired attributes
    const expiredResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM user_verified_attributes
       WHERE tenant_id = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
      [tenantId, now]
    );

    // By source type
    const bySource = await adapter.query<{ source_type: string; count: number }>(
      `SELECT source_type, COUNT(*) as count
       FROM user_verified_attributes
       WHERE tenant_id = ?
       GROUP BY source_type`,
      [tenantId]
    );

    // By attribute name (top 10)
    const byName = await adapter.query<{ attribute_name: string; count: number }>(
      `SELECT attribute_name, COUNT(*) as count
       FROM user_verified_attributes
       WHERE tenant_id = ?
       GROUP BY attribute_name
       ORDER BY count DESC
       LIMIT 10`,
      [tenantId]
    );

    // Unique users with attributes
    const uniqueUsersResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(DISTINCT user_id) as count
       FROM user_verified_attributes
       WHERE tenant_id = ?`,
      [tenantId]
    );

    // Verification stats
    const verificationStats = await adapter.query<{ verification_result: string; count: number }>(
      `SELECT verification_result, COUNT(*) as count
       FROM attribute_verifications
       WHERE tenant_id = ?
       GROUP BY verification_result`,
      [tenantId]
    );

    return c.json({
      total: totalResult[0]?.count || 0,
      active: activeResult[0]?.count || 0,
      expired: expiredResult[0]?.count || 0,
      unique_users: uniqueUsersResult[0]?.count || 0,
      by_source: bySource,
      by_name: byName,
      verifications: verificationStats,
    });
  } catch (error) {
    console.error('Failed to get attribute stats:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Bulk Operations
// =============================================================================

/**
 * DELETE /api/admin/attributes/expired
 * Delete all expired attributes
 */
export async function adminDeleteExpiredAttributesHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));
    const now = Math.floor(Date.now() / 1000);

    // Count expired
    const countResult = await adapter.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM user_verified_attributes
       WHERE tenant_id = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
      [tenantId, now]
    );

    const count = countResult[0]?.count || 0;

    if (count > 0) {
      await adapter.execute(
        `DELETE FROM user_verified_attributes
         WHERE tenant_id = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
        [tenantId, now]
      );

      // Audit log
      await createAuditLogFromContext(
        asBaseContext(c),
        'bulk_delete',
        'user_attribute',
        'expired',
        { deleted_count: count }
      );
    }

    return c.json({
      success: true,
      deleted_count: count,
    });
  } catch (error) {
    console.error('Failed to delete expired attributes:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/attributes/names
 * Get unique attribute names used in the system
 */
export async function adminAttributeNamesHandler(c: AdminContext) {
  try {
    const adapter = createAdapterFromContext(c);
    const tenantId = getTenantIdFromContext(asBaseContext(c));

    const names = await adapter.query<{ attribute_name: string; count: number }>(
      `SELECT attribute_name, COUNT(*) as count
       FROM user_verified_attributes
       WHERE tenant_id = ?
       GROUP BY attribute_name
       ORDER BY attribute_name ASC`,
      [tenantId]
    );

    return c.json({
      attribute_names: names,
    });
  } catch (error) {
    console.error('Failed to get attribute names:', error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

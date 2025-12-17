/**
 * Tombstones Admin API
 *
 * Manages GDPR Art.17 deletion records (tombstones).
 * Tombstones track deleted users for compliance auditing
 * and to prevent re-registration during retention period.
 *
 * Endpoints:
 * - GET /api/admin/tombstones: List all tombstones
 * - GET /api/admin/tombstones/:id: Get specific tombstone
 * - GET /api/admin/tombstones/stats: Get tombstone statistics
 * - POST /api/admin/tombstones/cleanup: Delete expired tombstones
 * - DELETE /api/admin/tombstones/:id: Force delete a tombstone
 *
 * @see docs/architecture/pii-separation.md
 */

import type { Context } from 'hono';

/**
 * Tombstone entity from database
 */
interface TombstoneRecord {
  id: string;
  tenant_id: string;
  email_blind_index: string | null;
  deleted_at: number;
  deleted_by: string | null;
  deletion_reason: string | null;
  retention_until: number;
  deletion_metadata: string | null;
}

/**
 * Default retention days for tombstones
 */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * GET /api/admin/tombstones
 *
 * List tombstones with optional filters.
 *
 * Query Parameters:
 * - tenant_id: Filter by tenant
 * - deletion_reason: Filter by reason (user_request, admin_action, etc.)
 * - expired: Filter by expired status (true/false)
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 20, max: 100)
 */
export async function listTombstones(c: Context) {
  const db = c.env.DB_PII;
  if (!db) {
    return c.json({ error: 'DB_PII binding not available' }, 500);
  }

  const tenantId = c.req.query('tenant_id');
  const deletionReason = c.req.query('deletion_reason');
  const expiredParam = c.req.query('expired');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));
  const offset = (page - 1) * limit;
  const now = Date.now();

  // Build query
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (tenantId) {
    conditions.push('tenant_id = ?');
    params.push(tenantId);
  }

  if (deletionReason) {
    conditions.push('deletion_reason = ?');
    params.push(deletionReason);
  }

  if (expiredParam === 'true') {
    conditions.push('retention_until < ?');
    params.push(now);
  } else if (expiredParam === 'false') {
    conditions.push('retention_until >= ?');
    params.push(now);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    // Count total
    const countSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${whereClause}`;
    const countResult = (await db
      .prepare(countSql)
      .bind(...params)
      .first()) as {
      count: number;
    } | null;
    const total = countResult?.count ?? 0;

    // Get items
    const dataSql = `SELECT * FROM users_pii_tombstone ${whereClause} ORDER BY deleted_at DESC LIMIT ? OFFSET ?`;
    const dataResult = await db
      .prepare(dataSql)
      .bind(...params, limit, offset)
      .all();

    const items = (dataResult.results as TombstoneRecord[]).map((row: TombstoneRecord) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      has_email_blind_index: row.email_blind_index !== null,
      deleted_at: row.deleted_at,
      deleted_at_iso: new Date(row.deleted_at).toISOString(),
      deleted_by: row.deleted_by,
      deletion_reason: row.deletion_reason,
      retention_until: row.retention_until,
      retention_until_iso: new Date(row.retention_until).toISOString(),
      is_expired: row.retention_until < now,
      metadata: row.deletion_metadata ? safeJsonParse(row.deletion_metadata) : null,
    }));

    const totalPages = Math.ceil(total / limit);

    return c.json({
      items,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      filters: {
        tenant_id: tenantId ?? null,
        deletion_reason: deletionReason ?? null,
        expired: expiredParam ?? null,
      },
    });
  } catch (error) {
    // Table may not exist yet
    return c.json({
      items: [],
      pagination: {
        total: 0,
        page,
        limit,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
      note: 'users_pii_tombstone table may not exist yet. Run migrations first.',
    });
  }
}

/**
 * GET /api/admin/tombstones/:id
 *
 * Get a specific tombstone by ID.
 */
export async function getTombstone(c: Context) {
  const db = c.env.DB_PII;
  if (!db) {
    return c.json({ error: 'DB_PII binding not available' }, 500);
  }

  const id = c.req.param('id');
  if (!id) {
    return c.json({ error: 'id parameter is required' }, 400);
  }

  try {
    const row = (await db
      .prepare('SELECT * FROM users_pii_tombstone WHERE id = ?')
      .bind(id)
      .first()) as TombstoneRecord | null;

    if (!row) {
      return c.json({ error: 'Tombstone not found' }, 404);
    }

    const now = Date.now();

    return c.json({
      id: row.id,
      tenant_id: row.tenant_id,
      has_email_blind_index: row.email_blind_index !== null,
      deleted_at: row.deleted_at,
      deleted_at_iso: new Date(row.deleted_at).toISOString(),
      deleted_by: row.deleted_by,
      deletion_reason: row.deletion_reason,
      retention_until: row.retention_until,
      retention_until_iso: new Date(row.retention_until).toISOString(),
      is_expired: row.retention_until < now,
      days_until_expiry: Math.max(
        0,
        Math.ceil((row.retention_until - now) / (24 * 60 * 60 * 1000))
      ),
      metadata: row.deletion_metadata ? safeJsonParse(row.deletion_metadata) : null,
    });
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
}

/**
 * GET /api/admin/tombstones/stats
 *
 * Get tombstone statistics.
 *
 * Query Parameters:
 * - tenant_id: Filter by tenant (optional)
 */
export async function getTombstoneStats(c: Context) {
  const db = c.env.DB_PII;
  if (!db) {
    return c.json({ error: 'DB_PII binding not available' }, 500);
  }

  const tenantId = c.req.query('tenant_id');
  const now = Date.now();

  try {
    // Build base WHERE clause
    const baseCondition = tenantId ? 'WHERE tenant_id = ?' : '';
    const baseParams = tenantId ? [tenantId] : [];

    // Total count
    const totalSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${baseCondition}`;
    const totalResult = (await db
      .prepare(totalSql)
      .bind(...baseParams)
      .first()) as { count: number } | null;

    // Expired count
    const expiredCondition = tenantId
      ? 'WHERE tenant_id = ? AND retention_until < ?'
      : 'WHERE retention_until < ?';
    const expiredParams = tenantId ? [tenantId, now] : [now];
    const expiredSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${expiredCondition}`;
    const expiredResult = (await db
      .prepare(expiredSql)
      .bind(...expiredParams)
      .first()) as { count: number } | null;

    // By reason
    const byReasonSql = `SELECT deletion_reason, COUNT(*) as count FROM users_pii_tombstone ${baseCondition} GROUP BY deletion_reason`;
    const byReasonResult = await db
      .prepare(byReasonSql)
      .bind(...baseParams)
      .all();

    const byReason: Record<string, number> = {};
    for (const row of byReasonResult.results as {
      deletion_reason: string | null;
      count: number;
    }[]) {
      const reason = row.deletion_reason ?? 'unknown';
      byReason[reason] = row.count;
    }

    // By tenant (only if not filtered)
    let byTenant: Record<string, number> | null = null;
    if (!tenantId) {
      const byTenantSql =
        'SELECT tenant_id, COUNT(*) as count FROM users_pii_tombstone GROUP BY tenant_id';
      const byTenantResult = await db.prepare(byTenantSql).all();

      byTenant = {};
      for (const row of byTenantResult.results as { tenant_id: string; count: number }[]) {
        byTenant[row.tenant_id] = row.count;
      }
    }

    // Recent deletions (last 30 days)
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const recentCondition = tenantId
      ? 'WHERE tenant_id = ? AND deleted_at >= ?'
      : 'WHERE deleted_at >= ?';
    const recentParams = tenantId ? [tenantId, thirtyDaysAgo] : [thirtyDaysAgo];
    const recentSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${recentCondition}`;
    const recentResult = (await db
      .prepare(recentSql)
      .bind(...recentParams)
      .first()) as { count: number } | null;

    return c.json({
      total: totalResult?.count ?? 0,
      expired: expiredResult?.count ?? 0,
      active: (totalResult?.count ?? 0) - (expiredResult?.count ?? 0),
      recentDeletions: recentResult?.count ?? 0,
      byReason,
      byTenant,
      tenantId: tenantId ?? 'all',
      note: 'Expired tombstones can be cleaned up with POST /api/admin/tombstones/cleanup',
    });
  } catch (error) {
    return c.json({
      total: 0,
      expired: 0,
      active: 0,
      recentDeletions: 0,
      byReason: {},
      byTenant: null,
      note: 'users_pii_tombstone table may not exist yet. Run migrations first.',
    });
  }
}

/**
 * POST /api/admin/tombstones/cleanup
 *
 * Delete expired tombstones.
 *
 * Request Body (optional):
 * - tenant_id: Only cleanup for specific tenant
 * - dry_run: If true, only return count without deleting (default: false)
 */
export async function cleanupTombstones(c: Context) {
  const db = c.env.DB_PII;
  if (!db) {
    return c.json({ error: 'DB_PII binding not available' }, 500);
  }

  let body: { tenant_id?: string; dry_run?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    // No body is fine
  }

  const tenantId = body.tenant_id;
  const dryRun = body.dry_run ?? false;
  const now = Date.now();

  try {
    // Count expired tombstones
    const countCondition = tenantId
      ? 'WHERE tenant_id = ? AND retention_until < ?'
      : 'WHERE retention_until < ?';
    const countParams = tenantId ? [tenantId, now] : [now];
    const countSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${countCondition}`;
    const countResult = (await db
      .prepare(countSql)
      .bind(...countParams)
      .first()) as { count: number } | null;

    const toDelete = countResult?.count ?? 0;

    if (dryRun) {
      return c.json({
        dryRun: true,
        expiredCount: toDelete,
        message: `${toDelete} expired tombstones would be deleted`,
        tenantId: tenantId ?? 'all',
      });
    }

    if (toDelete === 0) {
      return c.json({
        dryRun: false,
        deletedCount: 0,
        message: 'No expired tombstones to cleanup',
        tenantId: tenantId ?? 'all',
      });
    }

    // Delete expired tombstones
    const deleteCondition = tenantId
      ? 'WHERE tenant_id = ? AND retention_until < ?'
      : 'WHERE retention_until < ?';
    const deleteParams = tenantId ? [tenantId, now] : [now];
    const deleteSql = `DELETE FROM users_pii_tombstone ${deleteCondition}`;
    await db
      .prepare(deleteSql)
      .bind(...deleteParams)
      .run();

    return c.json({
      dryRun: false,
      deletedCount: toDelete,
      message: `${toDelete} expired tombstones deleted`,
      tenantId: tenantId ?? 'all',
    });
  } catch (error) {
    return c.json({ error: 'Database error during cleanup' }, 500);
  }
}

/**
 * DELETE /api/admin/tombstones/:id
 *
 * Force delete a specific tombstone.
 * Use with caution - this removes the deletion record.
 */
export async function deleteTombstone(c: Context) {
  const db = c.env.DB_PII;
  if (!db) {
    return c.json({ error: 'DB_PII binding not available' }, 500);
  }

  const id = c.req.param('id');
  if (!id) {
    return c.json({ error: 'id parameter is required' }, 400);
  }

  try {
    // Check if exists
    const existing = await db
      .prepare('SELECT id FROM users_pii_tombstone WHERE id = ?')
      .bind(id)
      .first();

    if (!existing) {
      return c.json({ error: 'Tombstone not found' }, 404);
    }

    // Delete
    await db.prepare('DELETE FROM users_pii_tombstone WHERE id = ?').bind(id).run();

    return c.json({
      success: true,
      id,
      message: 'Tombstone deleted. Note: This removes the deletion audit trail.',
    });
  } catch (error) {
    return c.json({ error: 'Database error' }, 500);
  }
}

/**
 * Check if email is in tombstone (for registration prevention)
 *
 * This is an internal utility, not exposed as an endpoint.
 * Used by user registration flow.
 */
export async function isEmailInTombstone(
  db: D1Database,
  emailBlindIndex: string,
  tenantId: string
): Promise<boolean> {
  const now = Date.now();

  try {
    const result = await db
      .prepare(
        'SELECT id FROM users_pii_tombstone WHERE tenant_id = ? AND email_blind_index = ? AND retention_until > ?'
      )
      .bind(tenantId, emailBlindIndex, now)
      .first();

    return result !== null;
  } catch {
    // If table doesn't exist, email is not in tombstone
    return false;
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Safely parse JSON, returning null on error
 */
function safeJsonParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

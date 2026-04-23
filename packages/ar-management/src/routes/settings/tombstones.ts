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
import {
  createErrorResponse,
  AR_ERROR_CODES,
  ensureDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
  resolveUserStoreRuntimeSourcesFromEnv,
  type DatabaseSource,
  type Env,
} from '@authrim/ar-lib-core';

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

async function resolveTombstoneDatabase(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<DatabaseSource | null> {
  const sources = await resolveUserStoreRuntimeSourcesFromEnv(c.env, tenantId);
  return sources.piiDb;
}

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
export async function listTombstones(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.query('tenant_id') ?? getTenantIdFromContext(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant_id' },
    });
  }

  const db = await resolveTombstoneDatabase(c, tenantId);
  if (!db) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_DB_NOT_CONFIGURED);
  }
  const adapter = ensureDatabaseAdapter(db, 'admin-tombstones');
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
    const countResult = await adapter.queryOne<{ count: number }>(countSql, params);
    const total = countResult?.count ?? 0;

    // Get items
    const dataSql = `SELECT * FROM users_pii_tombstone ${whereClause} ORDER BY deleted_at DESC LIMIT ? OFFSET ?`;
    const items = (
      await adapter.query<TombstoneRecord>(dataSql, [...params, limit, offset])
    ).map(
      (row: TombstoneRecord) => ({
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
      })
    );

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
        tenant_id: tenantId,
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
export async function getTombstone(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TombstonesAPI');
  const tenantId = c.req.query('tenant_id') ?? getTenantIdFromContext(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant_id' },
    });
  }
  const db = await resolveTombstoneDatabase(c, tenantId);
  if (!db) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_DB_NOT_CONFIGURED);
  }
  const adapter = ensureDatabaseAdapter(db, 'admin-tombstones');

  const id = c.req.param('id')!;
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const row = await adapter.queryOne<TombstoneRecord>(
      'SELECT * FROM users_pii_tombstone WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!row) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
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
    log.error('getTombstone error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
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
export async function getTombstoneStats(c: Context<{ Bindings: Env }>) {
  const tenantId = c.req.query('tenant_id') ?? getTenantIdFromContext(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant_id' },
    });
  }
  const db = await resolveTombstoneDatabase(c, tenantId);
  if (!db) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_DB_NOT_CONFIGURED);
  }
  const adapter = ensureDatabaseAdapter(db, 'admin-tombstones');
  const now = Date.now();

  try {
    // Build base WHERE clause
    const baseCondition = 'WHERE tenant_id = ?';
    const baseParams = [tenantId];

    // Total count
    const totalSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${baseCondition}`;
    const totalResult = await adapter.queryOne<{ count: number }>(totalSql, baseParams);

    // Expired count
    const expiredCondition = 'WHERE tenant_id = ? AND retention_until < ?';
    const expiredParams = [tenantId, now];
    const expiredSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${expiredCondition}`;
    const expiredResult = await adapter.queryOne<{ count: number }>(expiredSql, expiredParams);

    // By reason
    const byReasonSql = `SELECT deletion_reason, COUNT(*) as count FROM users_pii_tombstone ${baseCondition} GROUP BY deletion_reason`;
    const byReasonResult = await adapter.query<{ deletion_reason: string | null; count: number }>(
      byReasonSql,
      baseParams
    );

    const byReason: Record<string, number> = {};
    for (const row of byReasonResult) {
      const reason = row.deletion_reason ?? 'unknown';
      byReason[reason] = row.count;
    }

    const byTenant: Record<string, number> | null = { [tenantId]: totalResult?.count ?? 0 };

    // Recent deletions (last 30 days)
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const recentCondition = 'WHERE tenant_id = ? AND deleted_at >= ?';
    const recentParams = [tenantId, thirtyDaysAgo];
    const recentSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${recentCondition}`;
    const recentResult = await adapter.queryOne<{ count: number }>(recentSql, recentParams);

    return c.json({
      total: totalResult?.count ?? 0,
      expired: expiredResult?.count ?? 0,
      active: (totalResult?.count ?? 0) - (expiredResult?.count ?? 0),
      recentDeletions: recentResult?.count ?? 0,
      byReason,
      byTenant,
      tenantId,
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
export async function cleanupTombstones(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TombstonesAPI');

  let body: { tenant_id?: string; dry_run?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    // No body is fine
  }

  const tenantId = body.tenant_id ?? getTenantIdFromContext(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant_id' },
    });
  }
  const db = await resolveTombstoneDatabase(c, tenantId);
  if (!db) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_DB_NOT_CONFIGURED);
  }
  const adapter = ensureDatabaseAdapter(db, 'admin-tombstones');
  const dryRun = body.dry_run ?? false;
  const now = Date.now();

  try {
    // Count expired tombstones
    const countCondition = 'WHERE tenant_id = ? AND retention_until < ?';
    const countParams = [tenantId, now];
    const countSql = `SELECT COUNT(*) as count FROM users_pii_tombstone ${countCondition}`;
    const countResult = await adapter.queryOne<{ count: number }>(countSql, countParams);

    const toDelete = countResult?.count ?? 0;

    if (dryRun) {
      return c.json({
        dryRun: true,
        expiredCount: toDelete,
        message: `${toDelete} expired tombstones would be deleted`,
        tenantId,
      });
    }

    if (toDelete === 0) {
      return c.json({
        dryRun: false,
        deletedCount: 0,
        message: 'No expired tombstones to cleanup',
        tenantId,
      });
    }

    // Delete expired tombstones
    const deleteCondition = 'WHERE tenant_id = ? AND retention_until < ?';
    const deleteParams = [tenantId, now];
    const deleteSql = `DELETE FROM users_pii_tombstone ${deleteCondition}`;
    await adapter.execute(deleteSql, deleteParams);

    return c.json({
      dryRun: false,
      deletedCount: toDelete,
      message: `${toDelete} expired tombstones deleted`,
      tenantId,
    });
  } catch (error) {
    log.error('cleanupTombstones error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * DELETE /api/admin/tombstones/:id
 *
 * Force delete a specific tombstone.
 * Use with caution - this removes the deletion record.
 */
export async function deleteTombstone(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('TombstonesAPI');
  const tenantId = c.req.query('tenant_id') ?? getTenantIdFromContext(c);
  if (!tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'tenant_id' },
    });
  }
  const db = await resolveTombstoneDatabase(c, tenantId);
  if (!db) {
    return createErrorResponse(c, AR_ERROR_CODES.CONFIG_DB_NOT_CONFIGURED);
  }
  const adapter = ensureDatabaseAdapter(db, 'admin-tombstones');

  const id = c.req.param('id')!;
  if (!id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    // Check if exists
    const existing = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM users_pii_tombstone WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Delete
    await adapter.execute('DELETE FROM users_pii_tombstone WHERE id = ? AND tenant_id = ?', [
      id,
      tenantId,
    ]);

    return c.json({
      success: true,
      id,
      message: 'Tombstone deleted. Note: This removes the deletion audit trail.',
    });
  } catch (error) {
    log.error('deleteTombstone error', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Check if email is in tombstone (for registration prevention)
 *
 * This is an internal utility, not exposed as an endpoint.
 * Used by user registration flow.
 */
export async function isEmailInTombstone(
  db: DatabaseSource,
  emailBlindIndex: string,
  tenantId: string
): Promise<boolean> {
  const now = Date.now();
  const adapter = ensureDatabaseAdapter(db, 'admin-tombstones');

  try {
    const result = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM users_pii_tombstone WHERE tenant_id = ? AND email_blind_index = ? AND retention_until > ?',
      [tenantId, emailBlindIndex, now]
    );

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

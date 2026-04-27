/**
 * Admin Access Trace API
 *
 * Handlers for viewing permission check audit logs (access trace).
 */

import { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  getLogger,
} from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

interface PermissionCheckAuditRow {
  id: string;
  tenant_id: string;
  subject_id: string;
  permission: string;
  permission_json: string | null;
  allowed: number;
  resolved_via_json: string;
  final_decision: string;
  reason: string | null;
  api_key_id: string | null;
  client_id: string | null;
  checked_at: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

function parseJson<T>(value: string | null, defaultValue: T): T {
  if (!value) return defaultValue;
  try {
    return JSON.parse(value);
  } catch {
    return defaultValue;
  }
}

function rowToAccessTrace(row: PermissionCheckAuditRow) {
  return {
    id: row.id,
    subject_id: row.subject_id,
    permission: row.permission,
    permission_parsed: parseJson(row.permission_json, null),
    allowed: row.allowed === 1,
    resolved_via: parseJson<string[]>(row.resolved_via_json, []),
    final_decision: row.final_decision,
    reason: row.reason,
    api_key_id: row.api_key_id,
    client_id: row.client_id,
    checked_at: row.checked_at,
  };
}

function aggregateResolvedVia(rows: Array<{ resolved_via_json: string | null }>): Array<{
  resolved_via: string;
  count: number;
}> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const parsed = parseJson<unknown>(row.resolved_via_json, []);
    const values = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

    for (const value of values) {
      const key = typeof value === 'string' ? value : JSON.stringify(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([resolved_via, count]) => ({ resolved_via, count }))
    .sort((a, b) => b.count - a.count);
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * List access trace entries (permission check audit logs)
 */
export async function adminAccessTraceListHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = createAuthContextFromHono(c, tenantId).coreAdapter;

    const {
      subject_id,
      permission,
      allowed,
      final_decision,
      start_time,
      end_time,
      page = '1',
      limit = '50',
    } = c.req.query();

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const whereClauses: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];

    if (subject_id) {
      whereClauses.push('subject_id = ?');
      params.push(subject_id);
    }

    if (permission) {
      whereClauses.push('permission LIKE ?');
      params.push(`%${permission}%`);
    }

    if (allowed !== undefined) {
      whereClauses.push('allowed = ?');
      params.push(allowed === 'true' ? 1 : 0);
    }

    if (final_decision) {
      whereClauses.push('final_decision = ?');
      params.push(final_decision);
    }

    if (start_time) {
      whereClauses.push('checked_at >= ?');
      params.push(parseInt(start_time));
    }

    if (end_time) {
      whereClauses.push('checked_at <= ?');
      params.push(parseInt(end_time));
    }

    const whereClause = ' WHERE ' + whereClauses.join(' AND ');

    // Get total count
    const countResult = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM permission_check_audit ${whereClause}`,
      params
    );
    const total = countResult?.count || 0;

    // Get entries
    const rows = await db.query<PermissionCheckAuditRow>(
      `SELECT * FROM permission_check_audit ${whereClause} ORDER BY checked_at DESC LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const entries = rows.map(rowToAccessTrace);

    return c.json({
      entries,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-ACCESS-TRACE');
    log.error('Failed to list access trace entries', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to list access trace entries',
      },
      500
    );
  }
}

/**
 * Get access trace entry by ID
 */
export async function adminAccessTraceGetHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = createAuthContextFromHono(c, tenantId).coreAdapter;
    const entryId = c.req.param('id')!;

    const row = await db.queryOne<PermissionCheckAuditRow>(
      'SELECT * FROM permission_check_audit WHERE tenant_id = ? AND id = ?',
      [tenantId, entryId]
    );

    if (!row) {
      return c.json(
        {
          error: 'not_found',
          error_description: 'Access trace entry not found',
        },
        404
      );
    }

    return c.json({
      entry: rowToAccessTrace(row),
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-ACCESS-TRACE');
    log.error('Failed to get access trace entry', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get access trace entry',
      },
      500
    );
  }
}

/**
 * Get access trace statistics
 */
export async function adminAccessTraceStatsHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = createAuthContextFromHono(c, tenantId).coreAdapter;

    const { period = '24h' } = c.req.query();

    // Calculate cutoff time based on period
    let cutoffSeconds: number;
    switch (period) {
      case '1h':
        cutoffSeconds = 3600;
        break;
      case '6h':
        cutoffSeconds = 6 * 3600;
        break;
      case '24h':
        cutoffSeconds = 24 * 3600;
        break;
      case '7d':
        cutoffSeconds = 7 * 24 * 3600;
        break;
      case '30d':
        cutoffSeconds = 30 * 24 * 3600;
        break;
      default:
        cutoffSeconds = 24 * 3600;
    }

    const cutoffTime = Math.floor(Date.now() / 1000) - cutoffSeconds;

    // Get overall stats
    const totalStats = await db.queryOne<{
      total: number;
      allowed: number;
      denied: number;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) as allowed,
        SUM(CASE WHEN allowed = 0 THEN 1 ELSE 0 END) as denied
      FROM permission_check_audit
      WHERE tenant_id = ? AND checked_at >= ?`,
      [tenantId, cutoffTime]
    );

    // Get top denied permissions
    const topDenied = await db.query<{ permission: string; count: number }>(
      `SELECT permission, COUNT(*) as count
       FROM permission_check_audit
       WHERE tenant_id = ? AND checked_at >= ? AND allowed = 0
       GROUP BY permission
       ORDER BY count DESC
       LIMIT 10`,
      [tenantId, cutoffTime]
    );

    // Get top subjects with denials
    const topDeniedSubjects = await db.query<{ subject_id: string; count: number }>(
      `SELECT subject_id, COUNT(*) as count
       FROM permission_check_audit
       WHERE tenant_id = ? AND checked_at >= ? AND allowed = 0
       GROUP BY subject_id
       ORDER BY count DESC
       LIMIT 10`,
      [tenantId, cutoffTime]
    );

    // Get resolution method distribution
    const resolutionRows = await db.query<{ resolved_via_json: string | null }>(
      `SELECT resolved_via_json
       FROM permission_check_audit
       WHERE tenant_id = ? AND checked_at >= ?`,
      [tenantId, cutoffTime]
    );
    const resolutionStats = aggregateResolvedVia(resolutionRows);

    return c.json({
      period,
      total: totalStats?.total || 0,
      allowed: totalStats?.allowed || 0,
      denied: totalStats?.denied || 0,
      allow_rate: totalStats?.total
        ? Math.round(((totalStats.allowed || 0) / totalStats.total) * 100)
        : 0,
      top_denied_permissions: topDenied,
      top_denied_subjects: topDeniedSubjects,
      resolution_distribution: resolutionStats,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-ACCESS-TRACE');
    log.error('Failed to get access trace stats', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get access trace stats',
      },
      500
    );
  }
}

/**
 * Get timeline data for charts
 */
export async function adminAccessTraceTimelineHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const db = createAuthContextFromHono(c, tenantId).coreAdapter;

    const { period = '24h', granularity = 'hour' } = c.req.query();

    // Calculate cutoff and bucket size
    let cutoffSeconds: number;
    let bucketSize: number; // in seconds

    switch (period) {
      case '1h':
        cutoffSeconds = 3600;
        bucketSize = 300; // 5 minutes
        break;
      case '6h':
        cutoffSeconds = 6 * 3600;
        bucketSize = 1800; // 30 minutes
        break;
      case '24h':
        cutoffSeconds = 24 * 3600;
        bucketSize = granularity === 'minute' ? 60 : 3600;
        break;
      case '7d':
        cutoffSeconds = 7 * 24 * 3600;
        bucketSize = 6 * 3600; // 6 hours
        break;
      case '30d':
        cutoffSeconds = 30 * 24 * 3600;
        bucketSize = 24 * 3600; // 1 day
        break;
      default:
        cutoffSeconds = 24 * 3600;
        bucketSize = 3600;
    }

    const cutoffTime = Math.floor(Date.now() / 1000) - cutoffSeconds;

    // Get timeline data
    const timeline = await db.query<{
      bucket: number;
      total: number;
      allowed: number;
      denied: number;
    }>(
      `SELECT
        (checked_at / ?) * ? as bucket,
        COUNT(*) as total,
        SUM(CASE WHEN allowed = 1 THEN 1 ELSE 0 END) as allowed,
        SUM(CASE WHEN allowed = 0 THEN 1 ELSE 0 END) as denied
      FROM permission_check_audit
      WHERE tenant_id = ? AND checked_at >= ?
      GROUP BY bucket
      ORDER BY bucket ASC`,
      [bucketSize, bucketSize, tenantId, cutoffTime]
    );

    return c.json({
      period,
      granularity: bucketSize,
      data: timeline.map((row) => ({
        timestamp: row.bucket,
        total: row.total,
        allowed: row.allowed,
        denied: row.denied,
      })),
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-ACCESS-TRACE');
    log.error('Failed to get access trace timeline', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get access trace timeline',
      },
      500
    );
  }
}

/**
 * Admin Statistics API Endpoints
 *
 * Statistics and analytics for administrative dashboard:
 * - GET /api/admin/stats/tokens      - Token statistics
 * - GET /api/admin/stats/auth        - Authentication statistics (success/failure)
 * - GET /api/admin/stats/timeline    - Time-series statistics
 * - GET /api/admin/stats/clients/:id - Client-specific statistics (Phase 2)
 * - GET /api/admin/stats/geography   - Geography-based statistics (Phase 3)
 *
 * Security:
 * - RBAC: tenant_admin or higher required
 * - Rate limit: moderate profile
 * - Tenant isolation: All queries filtered by tenant_id
 *
 * Date Range Specification:
 * - from/to: ISO 8601 UTC format (e.g., "2026-01-01T00:00:00Z")
 * - Interpretation: inclusive/inclusive [from, to]
 * - interval: 'hour' (max 7 days), 'day' (max 90 days), 'week' (max 90 days)
 * - tz: Output timezone (e.g., "Asia/Tokyo"), default "UTC"
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  getLogger,
  getClient,
} from '@authrim/ar-lib-core';
import { z } from 'zod';
import {
  createAuditHotQueryUnsupportedResponse,
  getAuditHotQuerySupport,
  getAuditHotQuerySqlSpec,
  getAuditTimeRange,
} from './audit-hot-query';
import { getAuditJsonTextExpr, getAuditTimelineGrouping } from './audit-sql-dialect';

// =============================================================================
// Constants
// =============================================================================

/**
 * Stats query limits
 */
const STATS_LIMITS = {
  MAX_RANGE_DAYS: 90,
  MAX_HOURLY_RANGE_DAYS: 7,
  DEFAULT_INTERVAL: 'day' as const,
};

/**
 * Milliseconds per day
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// =============================================================================
// Validation Schemas
// =============================================================================

/**
 * Stats query schema with interval-specific validation
 */
const StatsQuerySchema = z
  .object({
    from: z.string().datetime({ message: 'from must be ISO 8601 datetime' }),
    to: z.string().datetime({ message: 'to must be ISO 8601 datetime' }),
    interval: z.enum(['hour', 'day', 'week']).default('day'),
    tz: z.string().default('UTC'),
    client_id: z.string().uuid().optional(),
  })
  .refine(
    (data) => {
      const fromDate = new Date(data.from);
      const toDate = new Date(data.to);
      return toDate >= fromDate;
    },
    { message: 'to must be greater than or equal to from' }
  )
  .refine(
    (data) => {
      const fromDate = new Date(data.from);
      const toDate = new Date(data.to);
      const diffDays = (toDate.getTime() - fromDate.getTime()) / MS_PER_DAY;

      if (data.interval === 'hour') {
        return diffDays <= STATS_LIMITS.MAX_HOURLY_RANGE_DAYS;
      }
      return diffDays <= STATS_LIMITS.MAX_RANGE_DAYS;
    },
    {
      message: `Date range exceeds limit. hour: max ${STATS_LIMITS.MAX_HOURLY_RANGE_DAYS} days, day/week: max ${STATS_LIMITS.MAX_RANGE_DAYS} days`,
    }
  );

// =============================================================================
// Types
// =============================================================================

/**
 * Token statistics response
 */
interface TokenStats {
  access_tokens: {
    active: number;
    issued_today: number;
    revoked_today: number;
  };
  refresh_tokens: {
    active: number;
    issued_today: number;
    revoked_today: number;
  };
  period: {
    from: string;
    to: string;
  };
}

/**
 * Auth statistics response
 */
interface AuthStats {
  total_attempts: number;
  successful: number;
  failed: number;
  success_rate: number;
  mfa_used: number;
  by_grant_type: Record<string, { successful: number; failed: number }>;
  period: {
    from: string;
    to: string;
  };
}

/**
 * Timeline data point
 */
interface TimelineDataPoint {
  ts: string;
  success: number;
  failed: number;
  mfa_used: number;
}

/**
 * Timeline statistics response
 */
interface TimelineStats {
  data: TimelineDataPoint[];
  interval: 'hour' | 'day' | 'week';
  tz: string;
  period: {
    from: string;
    to: string;
  };
}

// =============================================================================
// Helpers
// =============================================================================

function createCoreAdapter(c: Context<{ Bindings: Env }>, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

/**
 * Parse and validate common stats query parameters
 */
function parseStatsQuery(c: Context<{ Bindings: Env }>) {
  const from = c.req.query('from');
  const to = c.req.query('to');
  const interval = c.req.query('interval');
  const tz = c.req.query('tz');
  const client_id = c.req.query('client_id');

  if (!from || !to) {
    return {
      valid: false as const,
      error: 'from and to are required query parameters',
    };
  }

  const rawQuery = { from, to, interval, tz, client_id };
  const parseResult = StatsQuerySchema.safeParse(rawQuery);

  if (!parseResult.success) {
    return {
      valid: false as const,
      error: parseResult.error.issues.map((i) => i.message).join(', '),
    };
  }

  return {
    valid: true as const,
    data: parseResult.data,
  };
}

/**
 * Format timestamp for response based on timezone
 * Note: Full timezone conversion requires a library like luxon.
 * For now, we return UTC and indicate the tz in the response.
 */
function formatTimestampForTz(timestamp: string, _tz: string): string {
  // TODO: Implement proper timezone conversion with luxon
  // For now, return as-is (UTC)
  return timestamp;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/stats/tokens
 * Get token statistics for the tenant
 */
export async function adminStatsTokensHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  const queryResult = parseStatsQuery(c);
  if (!queryResult.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'query', reason: queryResult.error },
    });
  }

  const { from, to } = queryResult.data;
  // Parse timestamps for future filtering support
  const _fromTs = Math.floor(new Date(from).getTime() / 1000);
  const _toTs = Math.floor(new Date(to).getTime() / 1000);
  void _fromTs;
  void _toTs;

  try {
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);
    if (!hotQuery.supported || !hotQuery.context) {
      return createAuditHotQueryUnsupportedResponse(c, hotQuery);
    }

    // Get today's boundaries for issued/revoked counts
    const todayStart = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
    const todayEnd = Math.floor(new Date().setUTCHours(23, 59, 59, 999) / 1000);
    const { tableName: auditTable, actionColumn } = getAuditHotQuerySqlSpec(hotQuery.context);
    const [auditFromTs, auditToTs] = getAuditTimeRange(todayStart, todayEnd, hotQuery.context);
    const auditAdapter = hotQuery.context.adapter;
    const coreAdapter = createCoreAdapter(c, tenantId);

    // Query access token stats
    // Note: In a real implementation, this would query the actual token tables
    // For now, we return placeholder data structure
    const [activeAccessTokens, issuedTodayAccess, revokedTodayAccess] = await Promise.all([
      coreAdapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM sessions
         WHERE tenant_id = ? AND expires_at > ? AND revoked = 0`,
        [tenantId, Math.floor(Date.now() / 1000)]
      ),
      auditAdapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${auditTable}
         WHERE tenant_id = ? AND ${actionColumn} = 'token.issued'
         AND created_at >= ? AND created_at <= ?`,
        [tenantId, auditFromTs, auditToTs]
      ),
      auditAdapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${auditTable}
         WHERE tenant_id = ? AND ${actionColumn} = 'token.revoked'
         AND created_at >= ? AND created_at <= ?`,
        [tenantId, auditFromTs, auditToTs]
      ),
    ]);

    // Query refresh token stats (using audit log as proxy)
    const [activeRefreshTokens, issuedTodayRefresh, revokedTodayRefresh] = await Promise.all([
      coreAdapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM sessions
         WHERE tenant_id = ? AND expires_at > ? AND revoked = 0`,
        [tenantId, Math.floor(Date.now() / 1000)]
      ),
      auditAdapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${auditTable}
         WHERE tenant_id = ? AND ${actionColumn} = 'refresh_token.issued'
         AND created_at >= ? AND created_at <= ?`,
        [tenantId, auditFromTs, auditToTs]
      ),
      auditAdapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${auditTable}
         WHERE tenant_id = ? AND ${actionColumn} = 'refresh_token.revoked'
         AND created_at >= ? AND created_at <= ?`,
        [tenantId, auditFromTs, auditToTs]
      ),
    ]);

    const stats: TokenStats = {
      access_tokens: {
        active: activeAccessTokens?.count ?? 0,
        issued_today: issuedTodayAccess?.count ?? 0,
        revoked_today: revokedTodayAccess?.count ?? 0,
      },
      refresh_tokens: {
        active: activeRefreshTokens?.count ?? 0,
        issued_today: issuedTodayRefresh?.count ?? 0,
        revoked_today: revokedTodayRefresh?.count ?? 0,
      },
      period: {
        from,
        to,
      },
    };

    return c.json(stats);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-STATS');
    log.error('Failed to get token statistics', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/stats/auth
 * Get authentication statistics for the tenant
 */
export async function adminStatsAuthHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  const queryResult = parseStatsQuery(c);
  if (!queryResult.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'query', reason: queryResult.error },
    });
  }

  const { from, to, client_id } = queryResult.data;
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs = Math.floor(new Date(to).getTime() / 1000);

  try {
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);
    if (!hotQuery.supported || !hotQuery.context) {
      return createAuditHotQueryUnsupportedResponse(c, hotQuery);
    }
    const context = hotQuery.context;

    const adapter = context.adapter;
    const [auditFromTs, auditToTs] = getAuditTimeRange(fromTs, toTs, context);
    const { tableName: auditTable, actionColumn, detailsColumn } = getAuditHotQuerySqlSpec(context);
    const authWhere =
      hotQuery.context.mode === 'legacy'
        ? `(${actionColumn} LIKE 'auth.%' OR ${actionColumn} LIKE 'token.%')`
        : `event_category IN ('auth', 'token')`;
    const successCase =
      hotQuery.context.mode === 'legacy'
        ? `CASE WHEN ${actionColumn} LIKE '%success%' OR ${actionColumn} LIKE '%issued%' THEN 1 ELSE 0 END`
        : `CASE WHEN result = 'success' THEN 1 ELSE 0 END`;
    const failureCase =
      hotQuery.context.mode === 'legacy'
        ? `CASE WHEN ${actionColumn} LIKE '%failed%' OR ${actionColumn} LIKE '%error%' THEN 1 ELSE 0 END`
        : `CASE WHEN result = 'failure' THEN 1 ELSE 0 END`;
    const mfaCase =
      hotQuery.context.mode === 'legacy'
        ? `CASE WHEN ${detailsColumn} LIKE '%mfa%' THEN 1 ELSE 0 END`
        : `CASE WHEN ${actionColumn} LIKE 'auth.mfa%' OR COALESCE(${detailsColumn}, '') LIKE '%mfa%' THEN 1 ELSE 0 END`;
    const grantTypeExpr =
      hotQuery.context.mode === 'legacy'
        ? `COALESCE(${getAuditJsonTextExpr(detailsColumn, 'grant_type', hotQuery.context.dialect)}, 'unknown')`
        : `COALESCE(${getAuditJsonTextExpr(detailsColumn, 'grant_type', hotQuery.context.dialect)}, ${getAuditJsonTextExpr(detailsColumn, 'grantType', hotQuery.context.dialect)}, 'unknown')`;

    // Build client filter
    const clientFilter = client_id
      ? hotQuery.context.mode === 'legacy'
        ? ` AND COALESCE(${detailsColumn}, '') LIKE ?`
        : ` AND (client_id = ? OR ${getAuditJsonTextExpr(detailsColumn, 'client_id', hotQuery.context.dialect)} = ? OR ${getAuditJsonTextExpr(detailsColumn, 'grant_client_id', hotQuery.context.dialect)} = ? OR (${getAuditJsonTextExpr(detailsColumn, 'resourceType', hotQuery.context.dialect)} = 'client' AND ${getAuditJsonTextExpr(detailsColumn, 'resourceId', hotQuery.context.dialect)} = ?))`
      : '';
    const clientBinding = client_id
      ? hotQuery.context.mode === 'legacy'
        ? [`%"client_id":"${client_id}"%`]
        : [client_id, client_id, client_id, client_id]
      : [];

    // Query overall auth stats from audit log
    const overallStats = await adapter.queryOne<{
      total: number;
      successful: number;
      failed: number;
      mfa_used: number;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(${successCase}) as successful,
        SUM(${failureCase}) as failed,
        SUM(${mfaCase}) as mfa_used
      FROM ${auditTable}
      WHERE tenant_id = ?
        AND ${authWhere}
        AND created_at >= ? AND created_at <= ?${clientFilter}`,
      [tenantId, auditFromTs, auditToTs, ...clientBinding]
    );

    // Query by grant type
    const grantTypeStats = await adapter.query<{
      grant_type: string;
      successful: number;
      failed: number;
    }>(
      `SELECT
        ${grantTypeExpr} as grant_type,
        SUM(${successCase}) as successful,
        SUM(${failureCase}) as failed
      FROM ${auditTable}
      WHERE tenant_id = ?
        AND ${authWhere}
        AND created_at >= ? AND created_at <= ?${clientFilter}
      GROUP BY grant_type`,
      [tenantId, auditFromTs, auditToTs, ...clientBinding]
    );

    const total = overallStats?.total ?? 0;
    const successful = overallStats?.successful ?? 0;
    const failed = overallStats?.failed ?? 0;

    const byGrantType: Record<string, { successful: number; failed: number }> = {};
    for (const row of grantTypeStats) {
      byGrantType[row.grant_type] = {
        successful: row.successful,
        failed: row.failed,
      };
    }

    const stats: AuthStats = {
      total_attempts: total,
      successful,
      failed,
      success_rate: total > 0 ? Math.round((successful / total) * 10000) / 100 : 0,
      mfa_used: overallStats?.mfa_used ?? 0,
      by_grant_type: byGrantType,
      period: {
        from,
        to,
      },
    };

    return c.json(stats);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-STATS');
    log.error('Failed to get auth statistics', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/stats/timeline
 * Get time-series authentication statistics for the tenant
 */
export async function adminStatsTimelineHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  const queryResult = parseStatsQuery(c);
  if (!queryResult.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'query', reason: queryResult.error },
    });
  }

  const { from, to, interval, tz, client_id } = queryResult.data;
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs = Math.floor(new Date(to).getTime() / 1000);

  try {
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);
    if (!hotQuery.supported || !hotQuery.context) {
      return createAuditHotQueryUnsupportedResponse(c, hotQuery);
    }

    const adapter = hotQuery.context.adapter;
    const [auditFromTs, auditToTs] = getAuditTimeRange(fromTs, toTs, hotQuery.context);
    const {
      tableName: auditTable,
      actionColumn,
      detailsColumn,
    } = getAuditHotQuerySqlSpec(hotQuery.context);

    // Build client filter
    const authWhere =
      hotQuery.context.mode === 'legacy'
        ? `(${actionColumn} LIKE 'auth.%' OR ${actionColumn} LIKE 'token.%')`
        : `event_category IN ('auth', 'token')`;
    const successCase =
      hotQuery.context.mode === 'legacy'
        ? `CASE WHEN ${actionColumn} LIKE '%success%' OR ${actionColumn} LIKE '%issued%' THEN 1 ELSE 0 END`
        : `CASE WHEN result = 'success' THEN 1 ELSE 0 END`;
    const failureCase =
      hotQuery.context.mode === 'legacy'
        ? `CASE WHEN ${actionColumn} LIKE '%failed%' OR ${actionColumn} LIKE '%error%' THEN 1 ELSE 0 END`
        : `CASE WHEN result = 'failure' THEN 1 ELSE 0 END`;
    const mfaCase =
      hotQuery.context.mode === 'legacy'
        ? `CASE WHEN ${detailsColumn} LIKE '%mfa%' THEN 1 ELSE 0 END`
        : `CASE WHEN ${actionColumn} LIKE 'auth.mfa%' OR COALESCE(${detailsColumn}, '') LIKE '%mfa%' THEN 1 ELSE 0 END`;
    const clientFilter = client_id
      ? hotQuery.context.mode === 'legacy'
        ? ` AND COALESCE(${detailsColumn}, '') LIKE ?`
        : ` AND (client_id = ? OR ${getAuditJsonTextExpr(detailsColumn, 'client_id', hotQuery.context.dialect)} = ? OR ${getAuditJsonTextExpr(detailsColumn, 'grant_client_id', hotQuery.context.dialect)} = ? OR (${getAuditJsonTextExpr(detailsColumn, 'resourceType', hotQuery.context.dialect)} = 'client' AND ${getAuditJsonTextExpr(detailsColumn, 'resourceId', hotQuery.context.dialect)} = ?))`
      : '';
    const clientBinding = client_id
      ? hotQuery.context.mode === 'legacy'
        ? [`%"client_id":"${client_id}"%`]
        : [client_id, client_id, client_id, client_id]
      : [];

    // Get interval grouping expression
    const grouping = getAuditTimelineGrouping(
      interval,
      hotQuery.context.dialect,
      hotQuery.context.createdAtUnit
    );

    // Query timeline data
    const timelineData = await adapter.query<{
      time_bucket: string;
      success: number;
      failed: number;
      mfa_used: number;
    }>(
      `SELECT
        ${grouping} as time_bucket,
        SUM(${successCase}) as success,
        SUM(${failureCase}) as failed,
        SUM(${mfaCase}) as mfa_used
      FROM ${auditTable}
      WHERE tenant_id = ?
        AND ${authWhere}
        AND created_at >= ? AND created_at <= ?${clientFilter}
      GROUP BY time_bucket
      ORDER BY time_bucket ASC`,
      [tenantId, auditFromTs, auditToTs, ...clientBinding]
    );

    // Format data points
    const data: TimelineDataPoint[] = timelineData.map((row) => ({
      ts: formatTimestampForTz(row.time_bucket, tz),
      success: row.success,
      failed: row.failed,
      mfa_used: row.mfa_used,
    }));

    const stats: TimelineStats = {
      data,
      interval,
      tz,
      period: {
        from,
        to,
      },
    };

    return c.json(stats);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-STATS');
    log.error('Failed to get timeline statistics', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 2 Types
// =============================================================================

/**
 * Client statistics response
 */
interface ClientStats {
  client_id: string;
  client_name: string | null;
  tokens: {
    active_access_tokens: number;
    active_refresh_tokens: number;
    issued_today: number;
    revoked_today: number;
  };
  auth: {
    total_attempts: number;
    successful: number;
    failed: number;
    success_rate: number;
  };
  usage: {
    api_calls_today: number;
    api_calls_this_month: number;
    unique_users: number;
    last_activity: string | null;
  };
  period: {
    from: string;
    to: string;
  };
}

// =============================================================================
// Phase 2 Handlers
// =============================================================================

/**
 * GET /api/admin/stats/clients/:id
 * Get statistics for a specific client
 */
export async function adminStatsClientHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const clientId = c.req.param('id')!;

  if (!clientId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  const queryResult = parseStatsQuery(c);
  if (!queryResult.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'query', reason: queryResult.error },
    });
  }

  const { from, to } = queryResult.data;
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs = Math.floor(new Date(to).getTime() / 1000);

  try {
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);
    if (!hotQuery.supported || !hotQuery.context) {
      return createAuditHotQueryUnsupportedResponse(c, hotQuery);
    }

    const {
      tableName: auditTable,
      actionColumn,
      detailsColumn,
    } = getAuditHotQuerySqlSpec(hotQuery.context);
    const auditAdapter = hotQuery.context.adapter;
    const coreAdapter = createCoreAdapter(c, tenantId);
    const [auditFromTs, auditToTs] = getAuditTimeRange(fromTs, toTs, hotQuery.context);
    const clientClause =
      hotQuery.context.mode === 'legacy'
        ? `((resource_type = 'client' AND resource_id = ?) OR ${getAuditJsonTextExpr(detailsColumn, 'client_id', hotQuery.context.dialect)} = ? OR ${getAuditJsonTextExpr(detailsColumn, 'clientId', hotQuery.context.dialect)} = ?)`
        : `(client_id = ? OR ${getAuditJsonTextExpr(detailsColumn, 'client_id', hotQuery.context.dialect)} = ? OR ${getAuditJsonTextExpr(detailsColumn, 'clientId', hotQuery.context.dialect)} = ? OR (${getAuditJsonTextExpr(detailsColumn, 'resourceType', hotQuery.context.dialect)} = 'client' AND ${getAuditJsonTextExpr(detailsColumn, 'resourceId', hotQuery.context.dialect)} = ?))`;
    const clientBindings =
      hotQuery.context.mode === 'legacy'
        ? [clientId, clientId, clientId]
        : [clientId, clientId, clientId, clientId];

    // Verify client exists and belongs to tenant using KV cache (with D1 fallback)
    const client = await getClient(c.env, tenantId, clientId, coreAdapter);

    if (!client || client.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Get today's boundaries
    const todayStart = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
    const todayEnd = Math.floor(new Date().setUTCHours(23, 59, 59, 999) / 1000);

    // Get month boundaries
    const now = new Date();
    const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

    // Query token stats for this client
    const [tokenStats, activeSessionsResult, authStats, usageStats] = await Promise.all([
      // Token statistics
      auditAdapter.queryOne<{
        issued_today: number;
        revoked_today: number;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM ${auditTable} WHERE tenant_id = ? AND ${clientClause} AND ${actionColumn} = 'token.issued' AND created_at >= ? AND created_at <= ?) as issued_today,
          (SELECT COUNT(*) FROM ${auditTable} WHERE tenant_id = ? AND ${clientClause} AND ${actionColumn} = 'token.revoked' AND created_at >= ? AND created_at <= ?) as revoked_today`,
        [
          tenantId,
          ...clientBindings,
          ...getAuditTimeRange(todayStart, todayEnd, hotQuery.context),
          tenantId,
          ...clientBindings,
          ...getAuditTimeRange(todayStart, todayEnd, hotQuery.context),
        ]
      ),
      coreAdapter.queryOne<{
        active_access: number;
        active_refresh: number;
      }>(
        `SELECT
          COUNT(DISTINCT sc.session_id) as active_access,
          COUNT(DISTINCT sc.session_id) as active_refresh
         FROM session_clients sc
         JOIN sessions s ON s.id = sc.session_id
         WHERE sc.client_id = ? AND sc.tenant_id = ? AND s.tenant_id = ? AND s.expires_at > ?`,
        [clientId, tenantId, tenantId, Math.floor(Date.now() / 1000)]
      ),

      // Auth statistics within period
      auditAdapter.queryOne<{
        total: number;
        successful: number;
        failed: number;
      }>(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN ${hotQuery.context.mode === 'legacy' ? `${actionColumn} LIKE '%success%' OR ${actionColumn} LIKE '%issued%'` : `result = 'success'`} THEN 1 ELSE 0 END) as successful,
          SUM(CASE WHEN ${hotQuery.context.mode === 'legacy' ? `${actionColumn} LIKE '%failed%' OR ${actionColumn} LIKE '%error%'` : `result = 'failure'`} THEN 1 ELSE 0 END) as failed
        FROM ${auditTable}
        WHERE tenant_id = ?
          AND ${clientClause}
          AND ${hotQuery.context.mode === 'legacy' ? `(${actionColumn} LIKE 'auth.%' OR ${actionColumn} LIKE 'token.%')` : `event_category IN ('auth', 'token')`}
          AND created_at >= ? AND created_at <= ?`,
        [tenantId, ...clientBindings, ...getAuditTimeRange(fromTs, toTs, hotQuery.context)]
      ),

      // Usage statistics
      auditAdapter.queryOne<{
        api_calls_today: number;
        api_calls_month: number;
        unique_users: number;
        last_activity: number | null;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM ${auditTable} WHERE tenant_id = ? AND ${clientClause} AND created_at >= ? AND created_at <= ?) as api_calls_today,
          (SELECT COUNT(*) FROM ${auditTable} WHERE tenant_id = ? AND ${clientClause} AND created_at >= ?) as api_calls_month,
          (SELECT COUNT(DISTINCT ${
            hotQuery.context.mode === 'legacy'
              ? `COALESCE(${getAuditJsonTextExpr(detailsColumn, 'user_id', hotQuery.context.dialect)}, ${getAuditJsonTextExpr(detailsColumn, 'userId', hotQuery.context.dialect)})`
              : `COALESCE(anonymized_user_id, ${getAuditJsonTextExpr(detailsColumn, 'user_id', hotQuery.context.dialect)}, ${getAuditJsonTextExpr(detailsColumn, 'userId', hotQuery.context.dialect)})`
          }) FROM ${auditTable} WHERE tenant_id = ? AND ${clientClause} AND created_at >= ? AND created_at <= ?) as unique_users,
          (SELECT MAX(created_at) FROM ${auditTable} WHERE tenant_id = ? AND ${clientClause}) as last_activity`,
        [
          tenantId,
          ...clientBindings,
          ...getAuditTimeRange(todayStart, todayEnd, hotQuery.context),
          tenantId,
          ...clientBindings,
          ...(hotQuery.context.createdAtUnit === 'milliseconds'
            ? [monthStart * 1000]
            : [monthStart]),
          tenantId,
          ...clientBindings,
          ...getAuditTimeRange(fromTs, toTs, hotQuery.context),
          tenantId,
          ...clientBindings,
        ]
      ),
    ]);

    const total = authStats?.total ?? 0;
    const successful = authStats?.successful ?? 0;

    const stats: ClientStats = {
      client_id: clientId,
      client_name: client.client_name ?? null,
      tokens: {
        active_access_tokens: activeSessionsResult?.active_access ?? 0,
        active_refresh_tokens: activeSessionsResult?.active_refresh ?? 0,
        issued_today: tokenStats?.issued_today ?? 0,
        revoked_today: tokenStats?.revoked_today ?? 0,
      },
      auth: {
        total_attempts: total,
        successful,
        failed: authStats?.failed ?? 0,
        success_rate: total > 0 ? Math.round((successful / total) * 10000) / 100 : 0,
      },
      usage: {
        api_calls_today: usageStats?.api_calls_today ?? 0,
        api_calls_this_month: usageStats?.api_calls_month ?? 0,
        unique_users: usageStats?.unique_users ?? 0,
        last_activity: usageStats?.last_activity
          ? new Date(
              hotQuery.context.createdAtUnit === 'milliseconds'
                ? usageStats.last_activity
                : usageStats.last_activity * 1000
            ).toISOString()
          : null,
      },
      period: {
        from,
        to,
      },
    };

    return c.json(stats);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-STATS');
    log.error('Failed to get client statistics', { clientId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 3: Geography Statistics
// =============================================================================

/**
 * Country statistics data
 */
interface CountryStats {
  country_code: string;
  country_name: string;
  total_requests: number;
  successful: number;
  failed: number;
  unique_users: number;
  last_activity: string | null;
}

/**
 * Region statistics data
 */
interface RegionStats {
  region: string;
  total_requests: number;
  countries: number;
  top_country: string | null;
}

/**
 * Geography statistics response
 */
interface GeographyStats {
  by_country: CountryStats[];
  by_region: RegionStats[];
  top_countries: Array<{ country_code: string; country_name: string; requests: number }>;
  period: {
    from: string;
    to: string;
  };
  summary: {
    total_countries: number;
    total_requests: number;
    unique_users: number;
  };
}

/**
 * Country code to name mapping (ISO 3166-1 alpha-2, subset)
 */
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  JP: 'Japan',
  DE: 'Germany',
  FR: 'France',
  CA: 'Canada',
  AU: 'Australia',
  CN: 'China',
  IN: 'India',
  BR: 'Brazil',
  KR: 'South Korea',
  MX: 'Mexico',
  IT: 'Italy',
  ES: 'Spain',
  NL: 'Netherlands',
  SG: 'Singapore',
  HK: 'Hong Kong',
  TW: 'Taiwan',
  SE: 'Sweden',
  CH: 'Switzerland',
  // Add more as needed
};

/**
 * Country code to region mapping
 */
const COUNTRY_REGIONS: Record<string, string> = {
  US: 'North America',
  CA: 'North America',
  MX: 'North America',
  GB: 'Europe',
  DE: 'Europe',
  FR: 'Europe',
  IT: 'Europe',
  ES: 'Europe',
  NL: 'Europe',
  SE: 'Europe',
  CH: 'Europe',
  JP: 'Asia Pacific',
  CN: 'Asia Pacific',
  KR: 'Asia Pacific',
  IN: 'Asia Pacific',
  SG: 'Asia Pacific',
  HK: 'Asia Pacific',
  TW: 'Asia Pacific',
  AU: 'Asia Pacific',
  BR: 'South America',
  // Default to 'Other' for unmapped
};

/**
 * GET /api/admin/stats/geography
 * Get geographic distribution of authentication attempts
 *
 * Returns statistics by country and region, including:
 * - Request counts per country
 * - Success/failure rates
 * - Unique users per country
 * - Regional aggregations
 */
export async function adminStatsGeographyHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  const queryResult = parseStatsQuery(c);
  if (!queryResult.valid) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'query', reason: queryResult.error },
    });
  }

  const { from, to } = queryResult.data;
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs = Math.floor(new Date(to).getTime() / 1000);

  try {
    const hotQuery = await getAuditHotQuerySupport(c.env, tenantId);
    if (!hotQuery.supported || !hotQuery.context) {
      return createAuditHotQueryUnsupportedResponse(c, hotQuery);
    }
    const context = hotQuery.context;

    const adapter = context.adapter;
    const [auditFromTs, auditToTs] = getAuditTimeRange(fromTs, toTs, context);
    const { tableName: auditTable, actionColumn, detailsColumn } = getAuditHotQuerySqlSpec(context);
    const countryExpr = `COALESCE(${getAuditJsonTextExpr(detailsColumn, 'country_code', context.dialect)}, ${getAuditJsonTextExpr(detailsColumn, 'countryCode', context.dialect)}, 'XX')`;
    const uniqueUserExpr =
      context.mode === 'legacy'
        ? `COALESCE(${getAuditJsonTextExpr(detailsColumn, 'user_id', context.dialect)}, ${getAuditJsonTextExpr(detailsColumn, 'ip', context.dialect)})`
        : `COALESCE(anonymized_user_id, ${getAuditJsonTextExpr(detailsColumn, 'ip', context.dialect)})`;
    const successCase =
      context.mode === 'legacy'
        ? `CASE WHEN ${actionColumn} LIKE '%success%' OR ${actionColumn} LIKE '%issued%' THEN 1 ELSE 0 END`
        : `CASE WHEN result = 'success' THEN 1 ELSE 0 END`;
    const failureCase =
      context.mode === 'legacy'
        ? `CASE WHEN ${actionColumn} LIKE '%failed%' OR ${actionColumn} LIKE '%error%' THEN 1 ELSE 0 END`
        : `CASE WHEN result = 'failure' THEN 1 ELSE 0 END`;

    // Query country-level statistics from audit log
    // Note: country_code is extracted from IP geolocation stored in audit log details
    const countryStats = await adapter.query<{
      country_code: string;
      total_requests: number;
      successful: number;
      failed: number;
      unique_users: number;
      last_activity: number | null;
    }>(
      `SELECT
        ${countryExpr} as country_code,
        COUNT(*) as total_requests,
        SUM(${successCase}) as successful,
        SUM(${failureCase}) as failed,
        COUNT(DISTINCT ${uniqueUserExpr}) as unique_users,
        MAX(created_at) as last_activity
      FROM ${auditTable}
      WHERE tenant_id = ?
        AND ${
          context.mode === 'legacy'
            ? `(${actionColumn} LIKE 'auth.%' OR ${actionColumn} LIKE 'token.%')`
            : `event_category IN ('auth', 'token')`
        }
        AND created_at >= ? AND created_at <= ?
      GROUP BY country_code
      ORDER BY total_requests DESC`,
      [tenantId, auditFromTs, auditToTs]
    );

    // Build country stats with names
    const byCountry: CountryStats[] = countryStats.map((row) => ({
      country_code: row.country_code,
      country_name: COUNTRY_NAMES[row.country_code] || row.country_code,
      total_requests: row.total_requests,
      successful: row.successful,
      failed: row.failed,
      unique_users: row.unique_users,
      last_activity: row.last_activity
        ? new Date(
            context.createdAtUnit === 'milliseconds' ? row.last_activity : row.last_activity * 1000
          ).toISOString()
        : null,
    }));

    // Aggregate by region
    const regionMap = new Map<
      string,
      {
        total_requests: number;
        countries: Set<string>;
        topCountry: string;
        topCountryRequests: number;
      }
    >();

    for (const country of byCountry) {
      const region = COUNTRY_REGIONS[country.country_code] || 'Other';
      const existing = regionMap.get(region);

      if (existing) {
        existing.total_requests += country.total_requests;
        existing.countries.add(country.country_code);
        if (country.total_requests > existing.topCountryRequests) {
          existing.topCountry = country.country_code;
          existing.topCountryRequests = country.total_requests;
        }
      } else {
        regionMap.set(region, {
          total_requests: country.total_requests,
          countries: new Set([country.country_code]),
          topCountry: country.country_code,
          topCountryRequests: country.total_requests,
        });
      }
    }

    const byRegion: RegionStats[] = Array.from(regionMap.entries())
      .map(([region, data]) => ({
        region,
        total_requests: data.total_requests,
        countries: data.countries.size,
        top_country: data.topCountry,
      }))
      .sort((a, b) => b.total_requests - a.total_requests);

    // Top 10 countries
    const topCountries = byCountry.slice(0, 10).map((c) => ({
      country_code: c.country_code,
      country_name: c.country_name,
      requests: c.total_requests,
    }));

    // Calculate summary
    const totalRequests = byCountry.reduce((sum, c) => sum + c.total_requests, 0);
    const totalUniqueUsers = byCountry.reduce((sum, c) => sum + c.unique_users, 0);

    const stats: GeographyStats = {
      by_country: byCountry,
      by_region: byRegion,
      top_countries: topCountries,
      period: {
        from,
        to,
      },
      summary: {
        total_countries: byCountry.length,
        total_requests: totalRequests,
        unique_users: totalUniqueUsers,
      },
    };

    return c.json(stats);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-STATS');
    log.error('Failed to get geography statistics', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

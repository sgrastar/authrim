/**
 * System log API: events of the platform itself (`runtime.system_events`).
 *
 * What a Worker, cron, outbox or delivery did in the selected tenant, with no administrator and
 * no end user behind it: a dropped webhook queue, a failed connector heartbeat, a metadata
 * refresh. Written by `logSystemEvent` (ar-lib-core). Not the end-user event log
 * (`/api/admin/audit-logs`) and not the admin audit log (`/api/admin/admin-audit-log`).
 *
 * Reads go through the log archive the way the other log lists do: a bounded period, cursors
 * instead of page numbers, coverage headers, and 503 `log_query_incomplete` when the period
 * could not be read in full. Rows carry no personal data, so one permission
 * (`admin:system_logs:read`) covers the list and the entry in full.
 */
import { logQueryErrorResponse } from '../../log-archive-query';
import {
  createLogReadAdapter,
  logCoverageHeaders,
  logDetailWindow,
  logPageRequest,
} from '../../log-read-adapter';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  createErrorResponse,
  getTenantIdFromContext,
  SYSTEM_EVENTS_DATASET,
} from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

/** One row of `runtime.system_events`, as the read adapter returns it. */
interface SystemEventRow {
  id: string;
  tenant_id: string;
  source: string;
  event_type: string;
  event_category: string;
  result: string;
  severity: string;
  error_code: string | null;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  details_json: string | null;
  created_at: number;
  retention_until: number | null;
}

const SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'critical']);
const RESULTS = new Set(['success', 'failure', 'partial']);
/** A filter value: the same shape the writer accepts for names and IDs. */
const FILTER_VALUE = /^[A-Za-z0-9._:/-]{1,200}$/u;
/** `end_date` given as a day (`2026-11-07`) rather than an instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
export const SYSTEM_LOG_TABLE = SYSTEM_EVENTS_DATASET.split('.')[1];

function parseDetails(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function systemEventView(row: SystemEventRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    source: row.source,
    event_type: row.event_type,
    event_category: row.event_category,
    result: row.result,
    severity: row.severity,
    error_code: row.error_code ?? null,
    target_type: row.target_type ?? null,
    target_id: row.target_id ?? null,
    request_id: row.request_id ?? null,
    details: parseDetails(row.details_json),
    created_at: row.created_at,
    retention_until: row.retention_until ?? null,
  };
}

/** An instant from `start_date` / `end_date`: ISO 8601, or a day, which `end` extends to its end. */
function parseInstant(value: string | undefined, end: boolean): number | null | 'invalid' {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 'invalid';
  return end && DATE_ONLY.test(value) ? parsed + 24 * 60 * 60 * 1000 - 1 : parsed;
}

export const systemLogsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

systemLogsRouter.use(
  '*',
  adminAuthMiddleware({
    requirePermissions: [ADMIN_PERMISSIONS.SYSTEM_LOGS_READ],
  })
);

/**
 * GET /api/admin/system-logs
 * Newest first. Filters: source, event_type, severity, result, target_type, target_id,
 * request_id, start_date, end_date. Pages by cursor (`limit` 1..100, default 50).
 */
systemLogsRouter.get('/', async (c) => {
  try {
    const tenantId = getTenantIdFromContext(c);
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100));
    const conditions = ['tenant_id = ?'];
    const bindings: Array<string | number> = [tenantId];

    for (const [column, allowed] of [
      ['source', null],
      ['event_type', null],
      ['severity', SEVERITIES],
      ['result', RESULTS],
      ['target_type', null],
      ['target_id', null],
      ['request_id', null],
    ] as const) {
      const value = c.req.query(column);
      if (value === undefined || value === '') continue;
      if (!FILTER_VALUE.test(value) || (allowed && !allowed.has(value))) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST, {
          extensions: { error_description: `Invalid ${column} filter.` },
        });
      }
      conditions.push(`${column} = ?`);
      bindings.push(value);
    }

    const from = parseInstant(c.req.query('start_date'), false);
    const to = parseInstant(c.req.query('end_date'), true);
    if (from === 'invalid' || to === 'invalid' || (from != null && to != null && from > to)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST, {
        extensions: { error_description: 'Invalid start_date or end_date.' },
      });
    }
    if (from != null) {
      conditions.push('created_at >= ?');
      bindings.push(from);
    }
    if (to != null) {
      conditions.push('created_at <= ?');
      bindings.push(to);
    }
    bindings.push(limit);

    const logRead = createLogReadAdapter({
      env: c.env,
      tenantId,
      dataset: SYSTEM_EVENTS_DATASET,
      onCoverage: logCoverageHeaders(c),
      page: logPageRequest(c, tenantId, limit),
    });
    const rows = await logRead.adapter.query<SystemEventRow>(
      `SELECT id, tenant_id, source, event_type, event_category, result, severity, error_code,
              target_type, target_id, request_id, details_json, created_at, retention_until
       FROM ${SYSTEM_LOG_TABLE}
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      bindings
    );
    const items = rows.map(systemEventView);
    const pagination = logRead.pagination();
    return c.json({
      coverage: logRead.coverage(),
      items,
      ...(pagination ? { pagination } : { total: items.length }),
    });
  } catch (error) {
    const incomplete = logQueryErrorResponse(c, error);
    if (incomplete) return incomplete;
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/system-logs/:id
 * One entry with its details. `event_at` (Unix milliseconds) narrows the archive lookup.
 */
systemLogsRouter.get('/:id', async (c: AdminContext) => {
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id') ?? '';
    if (!FILTER_VALUE.test(id)) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }
    const logRead = createLogReadAdapter({
      env: c.env,
      tenantId,
      dataset: SYSTEM_EVENTS_DATASET,
      onCoverage: logCoverageHeaders(c),
      ...logDetailWindow(c),
    });
    const row = await logRead.adapter.queryOne<SystemEventRow>(
      `SELECT id, tenant_id, source, event_type, event_category, result, severity, error_code,
              target_type, target_id, request_id, details_json, created_at, retention_until
       FROM ${SYSTEM_LOG_TABLE}
       WHERE tenant_id = ? AND id = ?`,
      [tenantId, id]
    );
    // A read that could not cover the window has already thrown `LogQueryIncompleteError`
    // (503); a complete read with no row is a 404, as for the other log entries.
    if (!row) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    return c.json({ coverage: logRead.coverage(), ...systemEventView(row) });
  } catch (error) {
    const incomplete = logQueryErrorResponse(c, error);
    if (incomplete) return incomplete;
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

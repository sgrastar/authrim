/**
 * Admin Security API Endpoints
 *
 * Security monitoring and alert management for administrative dashboard:
 * - GET  /api/admin/security/alerts                   - List security alerts
 * - POST /api/admin/security/alerts/:id/acknowledge   - Acknowledge an alert
 * - GET  /api/admin/security/suspicious-activities    - List suspicious activities (Phase 2)
 * - GET  /api/admin/security/threats                  - List detected threats (Phase 2)
 *
 * Security:
 * - RBAC: tenant_admin or higher required
 * - Rate limit: moderate profile
 * - Tenant isolation: All queries filtered by tenant_id
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  type DatabaseAdapter,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  createAuditLogFromContext,
  getLogger,
} from '@authrim/ar-lib-core';
import { z } from 'zod';

// =============================================================================
// Constants
// =============================================================================

/**
 * Alert severity levels
 */
const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * Alert status values
 */
const ALERT_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
type AlertStatus = (typeof ALERT_STATUSES)[number];

/**
 * Alert types
 */
const ALERT_TYPES = [
  'brute_force',
  'credential_stuffing',
  'suspicious_login',
  'impossible_travel',
  'account_takeover',
  'mfa_bypass_attempt',
  'token_abuse',
  'rate_limit_exceeded',
  'config_change',
  'privilege_escalation',
  'data_exfiltration',
  'other',
] as const;
type AlertType = (typeof ALERT_TYPES)[number];

/**
 * Suspicious activity types (Phase 2)
 */
const SUSPICIOUS_ACTIVITY_TYPES = [
  'unusual_login_time',
  'new_device',
  'new_location',
  'failed_mfa',
  'password_spray',
  'session_hijacking',
  'unusual_api_usage',
  'excessive_permissions',
  'data_access_anomaly',
] as const;
type SuspiciousActivityType = (typeof SUSPICIOUS_ACTIVITY_TYPES)[number];

/**
 * Threat types (Phase 2)
 */
const THREAT_TYPES = [
  'malware',
  'phishing',
  'ransomware',
  'ddos',
  'sql_injection',
  'xss',
  'credential_theft',
  'insider_threat',
  'apt',
  'zero_day',
] as const;
type ThreatType = (typeof THREAT_TYPES)[number];

/**
 * Threat status values
 */
const THREAT_STATUSES = ['detected', 'investigating', 'mitigated', 'false_positive'] as const;
type ThreatStatus = (typeof THREAT_STATUSES)[number];

/**
 * Allowed filter fields for alerts list
 */
const ALLOWED_FILTER_FIELDS = ['status', 'severity', 'type', 'created_at'];

/**
 * Allowed sort fields for alerts list
 */
const ALLOWED_SORT_FIELDS = ['created_at', 'severity', 'acknowledged_at'];

/**
 * Default and max limits for pagination
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// =============================================================================
// Validation Schemas
// =============================================================================

/**
 * List alerts query schema (cursor-based pagination)
 */
const ListAlertsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional(),
  sort: z.string().optional(),
  filter: z.string().optional(),
});

/**
 * Acknowledge alert request schema
 */
const AcknowledgeAlertSchema = z.object({
  notes: z.string().max(1000).optional(),
  resolution: z.string().max(500).optional(),
});

// =============================================================================
// Types
// =============================================================================

/**
 * Security alert database row
 */
interface AlertRow {
  id: string;
  tenant_id: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  description: string | null;
  source_ip: string | null;
  user_id: string | null;
  client_id: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
}

/**
 * Formatted alert for API response
 */
interface FormattedAlert {
  alert_id: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  description: string | null;
  source_ip: string | null;
  user_id: string | null;
  client_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create database adapter from context
 */
function createAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  return new D1Adapter({ db: c.env.DB });
}

/**
 * Get admin auth context from request
 */
function getAdminAuth(c: Context<{ Bindings: Env }>): { adminId?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return (c as any).get('adminAuth') as { adminId?: string } | null;
}

/**
 * Convert Unix timestamp (seconds) to ISO 8601 string
 */
function toISOString(timestamp: number | null): string | null {
  if (!timestamp) return null;
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  return new Date(ms).toISOString();
}

/**
 * Parse filter string into filter object
 * Format: "status=open,severity=high"
 */
function parseFilter(filter: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pairs = filter.split(',');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key && value) {
      result[key.trim()] = value.trim();
    }
  }
  return result;
}

/**
 * Validate filter fields against allowlist
 */
function validateFilterFields(filter: string): { valid: boolean; error?: string } {
  const parsed = parseFilter(filter);
  const fields = Object.keys(parsed);
  const invalid = fields.filter((f) => !ALLOWED_FILTER_FIELDS.includes(f));
  if (invalid.length > 0) {
    return { valid: false, error: `Invalid filter fields: ${invalid.join(', ')}` };
  }
  return { valid: true };
}

/**
 * Validate sort field against allowlist
 */
function validateSortField(sort: string): { valid: boolean; error?: string } {
  const field = sort.replace(/^-/, '');
  if (!ALLOWED_SORT_FIELDS.includes(field)) {
    return { valid: false, error: `Invalid sort field: ${field}` };
  }
  return { valid: true };
}

/**
 * Cursor data type for pagination
 */
interface CursorData {
  id: string;
  created_at: number;
}

/**
 * Encode cursor from alert ID and created_at
 */
function encodeCursor(id: string, createdAt: number): string {
  return Buffer.from(JSON.stringify({ id, created_at: createdAt })).toString('base64url');
}

/**
 * Decode cursor to get alert ID and created_at
 */
function decodeCursor(cursor: string): CursorData | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<CursorData>;
    if (parsed.id && typeof parsed.created_at === 'number') {
      return { id: parsed.id, created_at: parsed.created_at };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format alert row for API response
 */
function formatAlert(row: AlertRow): FormattedAlert {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      // Invalid JSON, ignore
    }
  }

  return {
    alert_id: row.id,
    type: row.type,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    source_ip: row.source_ip,
    user_id: row.user_id,
    client_id: row.client_id,
    metadata,
    created_at: toISOString(row.created_at) ?? new Date().toISOString(),
    updated_at: toISOString(row.updated_at) ?? new Date().toISOString(),
    acknowledged_at: toISOString(row.acknowledged_at),
    acknowledged_by: row.acknowledged_by,
    resolved_at: toISOString(row.resolved_at),
    resolved_by: row.resolved_by,
  };
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/security/alerts
 * List security alerts for the tenant with cursor-based pagination
 */
export async function adminSecurityAlertsListHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  // Reject page-based pagination (plan specification)
  const page = c.req.query('page');
  const pageSize = c.req.query('page_size');
  if (page || pageSize) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'pagination',
        reason: 'Use cursor-based pagination. page/page_size not supported.',
      },
    });
  }

  // Parse and validate query parameters
  const rawQuery = {
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    sort: c.req.query('sort'),
    filter: c.req.query('filter'),
  };

  const parseResult = ListAlertsQuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'query',
        reason: parseResult.error.issues.map((i) => i.message).join(', '),
      },
    });
  }

  const query = parseResult.data;

  // Validate filter fields
  if (query.filter) {
    const filterValidation = validateFilterFields(query.filter);
    if (!filterValidation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'filter', reason: filterValidation.error ?? 'Invalid filter' },
      });
    }
  }

  // Validate sort field
  if (query.sort) {
    const sortValidation = validateSortField(query.sort);
    if (!sortValidation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: { field: 'sort', reason: sortValidation.error ?? 'Invalid sort field' },
      });
    }
  }

  try {
    const adapter = createAdapter(c);

    // Build query
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    // Apply cursor
    let cursorData: { id: string; created_at: number } | null = null;
    if (query.cursor) {
      cursorData = decodeCursor(query.cursor);
      if (!cursorData) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'cursor', reason: 'Invalid cursor format' },
        });
      }
      // Cursor-based pagination: get rows after the cursor
      whereClauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
      bindings.push(cursorData.created_at, cursorData.created_at, cursorData.id);
    }

    // Apply filters
    if (query.filter) {
      const filters = parseFilter(query.filter);
      for (const [key, value] of Object.entries(filters)) {
        switch (key) {
          case 'status':
            if (ALERT_STATUSES.includes(value as AlertStatus)) {
              whereClauses.push('status = ?');
              bindings.push(value);
            }
            break;
          case 'severity':
            if (ALERT_SEVERITIES.includes(value as AlertSeverity)) {
              whereClauses.push('severity = ?');
              bindings.push(value);
            }
            break;
          case 'type':
            if (ALERT_TYPES.includes(value as AlertType)) {
              whereClauses.push('type = ?');
              bindings.push(value);
            }
            break;
        }
      }
    }

    // Build ORDER BY
    let orderBy = 'created_at DESC, id ASC';
    if (query.sort) {
      const desc = query.sort.startsWith('-');
      const field = query.sort.replace(/^-/, '');
      // Special handling for severity sorting (by priority)
      if (field === 'severity') {
        orderBy = `CASE severity
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          WHEN 'info' THEN 4
          END ${desc ? 'DESC' : 'ASC'}, id ASC`;
      } else {
        orderBy = `${field} ${desc ? 'DESC' : 'ASC'}, id ASC`;
      }
    }

    // Fetch one extra row to determine has_more
    const limitPlusOne = query.limit + 1;
    const sql = `
      SELECT id, tenant_id, type, severity, status, title, description,
             source_ip, user_id, client_id, metadata,
             created_at, updated_at, acknowledged_at, acknowledged_by,
             resolved_at, resolved_by
      FROM security_alerts
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    bindings.push(limitPlusOne);

    const rows = await adapter.query<AlertRow>(sql, bindings);

    // Determine has_more and trim results
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;

    // Generate next cursor
    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor(lastRow.id, lastRow.created_at);
    }

    return c.json({
      data: data.map(formatAlert),
      pagination: {
        has_more: hasMore,
        ...(nextCursor && { next_cursor: nextCursor }),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SECURITY');
    log.error('Failed to list security alerts', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/security/alerts/:id/acknowledge
 * Acknowledge a security alert
 *
 * Side effects:
 * - Alert status set to 'acknowledged'
 * - acknowledged_at and acknowledged_by updated
 * - Audit log entry created
 */
export async function adminSecurityAlertAcknowledgeHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const alertId = c.req.param('id');

  if (!alertId) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_REQUIRED_FIELD, {
      variables: { field: 'id' },
    });
  }

  try {
    const body = await c.req.json<{ notes?: string; resolution?: string }>().catch(() => ({}));
    const parseResult = AcknowledgeAlertSchema.safeParse(body);
    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const { notes, resolution } = parseResult.data;
    const adapter = createAdapter(c);

    // Get current alert state (verify tenant ownership)
    const alert = await adapter.queryOne<AlertRow>(
      'SELECT id, tenant_id, status, severity, type, title FROM security_alerts WHERE id = ? AND tenant_id = ?',
      [alertId, tenantId]
    );

    if (!alert) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Check if already acknowledged
    if (alert.status === 'acknowledged' || alert.status === 'resolved') {
      return c.json({
        alert_id: alertId,
        status: alert.status,
        already_acknowledged: true,
        message: `Alert is already ${alert.status}`,
      });
    }

    const nowTs = Math.floor(Date.now() / 1000);

    // Get admin user ID from context (from admin auth middleware)
    const adminAuth = getAdminAuth(c);
    const acknowledgedBy = adminAuth?.adminId ?? 'unknown';

    // Update alert status
    const updateFields: string[] = [
      'status = ?',
      'acknowledged_at = ?',
      'acknowledged_by = ?',
      'updated_at = ?',
    ];
    const updateBindings: unknown[] = ['acknowledged', nowTs, acknowledgedBy, nowTs];

    // Optionally store notes in metadata
    if (notes || resolution) {
      updateFields.push("metadata = json_patch(COALESCE(metadata, '{}'), ?)");
      updateBindings.push(
        JSON.stringify({
          acknowledgment: {
            notes,
            resolution,
            timestamp: toISOString(nowTs),
          },
        })
      );
    }

    await adapter.execute(
      `UPDATE security_alerts SET ${updateFields.join(', ')} WHERE id = ? AND tenant_id = ?`,
      [...updateBindings, alertId, tenantId]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'security_alert.acknowledge', 'security_alert', alertId, {
      alert_type: alert.type,
      alert_severity: alert.severity,
      previous_status: alert.status,
      has_notes: !!notes,
      has_resolution: !!resolution,
    });

    return c.json({
      alert_id: alertId,
      status: 'acknowledged',
      previous_status: alert.status,
      acknowledged_at: toISOString(nowTs),
      acknowledged_by: acknowledgedBy,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SECURITY');
    log.error('Failed to acknowledge security alert', { alertId }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 2 Types
// =============================================================================

/**
 * Suspicious activity database row
 */
interface SuspiciousActivityRow {
  id: string;
  tenant_id: string;
  type: SuspiciousActivityType;
  severity: AlertSeverity;
  user_id: string | null;
  client_id: string | null;
  source_ip: string | null;
  user_agent: string | null;
  description: string;
  metadata: string | null;
  created_at: number;
  resolved_at: number | null;
}

/**
 * Threat database row
 */
interface ThreatRow {
  id: string;
  tenant_id: string;
  type: ThreatType;
  severity: AlertSeverity;
  status: ThreatStatus;
  title: string;
  description: string | null;
  source: string | null;
  affected_resources: string | null;
  indicators: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  detected_at: number;
  mitigated_at: number | null;
}

// =============================================================================
// Phase 2 Handlers
// =============================================================================

/**
 * GET /api/admin/security/suspicious-activities
 * List suspicious activities for the tenant with cursor-based pagination
 */
export async function adminSecuritySuspiciousActivitiesHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  // Reject page-based pagination
  const page = c.req.query('page');
  const pageSize = c.req.query('page_size');
  if (page || pageSize) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'pagination',
        reason: 'Use cursor-based pagination. page/page_size not supported.',
      },
    });
  }

  // Parse query parameters
  const rawQuery = {
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    sort: c.req.query('sort'),
    filter: c.req.query('filter'),
  };

  const parseResult = ListAlertsQuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'query',
        reason: parseResult.error.issues.map((i) => i.message).join(', '),
      },
    });
  }

  const query = parseResult.data;

  try {
    const adapter = createAdapter(c);

    // Build query
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    // Apply cursor
    if (query.cursor) {
      const cursorData = decodeCursor(query.cursor);
      if (!cursorData) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'cursor', reason: 'Invalid cursor format' },
        });
      }
      whereClauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
      bindings.push(cursorData.created_at, cursorData.created_at, cursorData.id);
    }

    // Apply filters
    if (query.filter) {
      const filters = parseFilter(query.filter);
      for (const [key, value] of Object.entries(filters)) {
        switch (key) {
          case 'type':
            if (SUSPICIOUS_ACTIVITY_TYPES.includes(value as SuspiciousActivityType)) {
              whereClauses.push('type = ?');
              bindings.push(value);
            }
            break;
          case 'severity':
            if (ALERT_SEVERITIES.includes(value as AlertSeverity)) {
              whereClauses.push('severity = ?');
              bindings.push(value);
            }
            break;
          case 'user_id':
            whereClauses.push('user_id = ?');
            bindings.push(value);
            break;
        }
      }
    }

    // Build ORDER BY
    let orderBy = 'created_at DESC, id ASC';
    if (query.sort) {
      const desc = query.sort.startsWith('-');
      const field = query.sort.replace(/^-/, '');
      if (['created_at', 'severity', 'type'].includes(field)) {
        if (field === 'severity') {
          orderBy = `CASE severity
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            WHEN 'info' THEN 4
            END ${desc ? 'DESC' : 'ASC'}, id ASC`;
        } else {
          orderBy = `${field} ${desc ? 'DESC' : 'ASC'}, id ASC`;
        }
      }
    }

    // Fetch data
    const limitPlusOne = query.limit + 1;
    const sql = `
      SELECT id, tenant_id, type, severity, user_id, client_id, source_ip,
             user_agent, description, metadata, created_at, resolved_at
      FROM suspicious_activities
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    bindings.push(limitPlusOne);

    const rows = await adapter.query<SuspiciousActivityRow>(sql, bindings);

    // Pagination
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor(lastRow.id, lastRow.created_at);
    }

    // Format response
    const formattedData = data.map((row) => {
      let metadata: Record<string, unknown> | null = null;
      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          // Invalid JSON
        }
      }

      return {
        activity_id: row.id,
        type: row.type,
        severity: row.severity,
        user_id: row.user_id,
        client_id: row.client_id,
        source_ip: row.source_ip,
        user_agent: row.user_agent,
        description: row.description,
        metadata,
        created_at: toISOString(row.created_at),
        resolved_at: toISOString(row.resolved_at),
      };
    });

    return c.json({
      data: formattedData,
      pagination: {
        has_more: hasMore,
        ...(nextCursor && { next_cursor: nextCursor }),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SECURITY');
    log.error('Failed to list suspicious activities', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/security/threats
 * List detected threats for the tenant with cursor-based pagination
 */
export async function adminSecurityThreatsHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  // Reject page-based pagination
  const page = c.req.query('page');
  const pageSize = c.req.query('page_size');
  if (page || pageSize) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'pagination',
        reason: 'Use cursor-based pagination. page/page_size not supported.',
      },
    });
  }

  // Parse query parameters
  const rawQuery = {
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    sort: c.req.query('sort'),
    filter: c.req.query('filter'),
  };

  const parseResult = ListAlertsQuerySchema.safeParse(rawQuery);
  if (!parseResult.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'query',
        reason: parseResult.error.issues.map((i) => i.message).join(', '),
      },
    });
  }

  const query = parseResult.data;

  try {
    const adapter = createAdapter(c);

    // Build query
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    // Apply cursor
    if (query.cursor) {
      const cursorData = decodeCursor(query.cursor);
      if (!cursorData) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'cursor', reason: 'Invalid cursor format' },
        });
      }
      whereClauses.push('(detected_at < ? OR (detected_at = ? AND id > ?))');
      bindings.push(cursorData.created_at, cursorData.created_at, cursorData.id);
    }

    // Apply filters
    if (query.filter) {
      const filters = parseFilter(query.filter);
      for (const [key, value] of Object.entries(filters)) {
        switch (key) {
          case 'type':
            if (THREAT_TYPES.includes(value as ThreatType)) {
              whereClauses.push('type = ?');
              bindings.push(value);
            }
            break;
          case 'severity':
            if (ALERT_SEVERITIES.includes(value as AlertSeverity)) {
              whereClauses.push('severity = ?');
              bindings.push(value);
            }
            break;
          case 'status':
            if (THREAT_STATUSES.includes(value as ThreatStatus)) {
              whereClauses.push('status = ?');
              bindings.push(value);
            }
            break;
        }
      }
    }

    // Build ORDER BY
    let orderBy = 'detected_at DESC, id ASC';
    if (query.sort) {
      const desc = query.sort.startsWith('-');
      const field = query.sort.replace(/^-/, '');
      if (['detected_at', 'severity', 'type', 'status'].includes(field)) {
        if (field === 'severity') {
          orderBy = `CASE severity
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            WHEN 'info' THEN 4
            END ${desc ? 'DESC' : 'ASC'}, id ASC`;
        } else {
          orderBy = `${field} ${desc ? 'DESC' : 'ASC'}, id ASC`;
        }
      }
    }

    // Fetch data
    const limitPlusOne = query.limit + 1;
    const sql = `
      SELECT id, tenant_id, type, severity, status, title, description, source,
             affected_resources, indicators, metadata, created_at, updated_at,
             detected_at, mitigated_at
      FROM security_threats
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    bindings.push(limitPlusOne);

    const rows = await adapter.query<ThreatRow>(sql, bindings);

    // Pagination
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor(lastRow.id, lastRow.detected_at);
    }

    // Format response
    const formattedData = data.map((row) => {
      let metadata: Record<string, unknown> | null = null;
      let affectedResources: string[] | null = null;
      let indicators: string[] | null = null;

      if (row.metadata) {
        try {
          metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        } catch {
          // Invalid JSON
        }
      }
      if (row.affected_resources) {
        try {
          affectedResources = JSON.parse(row.affected_resources) as string[];
        } catch {
          // Invalid JSON
        }
      }
      if (row.indicators) {
        try {
          indicators = JSON.parse(row.indicators) as string[];
        } catch {
          // Invalid JSON
        }
      }

      return {
        threat_id: row.id,
        type: row.type,
        severity: row.severity,
        status: row.status,
        title: row.title,
        description: row.description,
        source: row.source,
        affected_resources: affectedResources,
        indicators,
        metadata,
        created_at: toISOString(row.created_at),
        updated_at: toISOString(row.updated_at),
        detected_at: toISOString(row.detected_at),
        mitigated_at: toISOString(row.mitigated_at),
      };
    });

    return c.json({
      data: formattedData,
      pagination: {
        has_more: hasMore,
        ...(nextCursor && { next_cursor: nextCursor }),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SECURITY');
    log.error('Failed to list threats', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 3: IP Reputation Check
// =============================================================================

/**
 * IP reputation check request schema
 */
const IpReputationRequestSchema = z.object({
  ip_addresses: z.array(z.string().ip()).min(1).max(100),
});

/**
 * POST /api/admin/security/ip-reputation
 * Check reputation of IP addresses
 */
export async function adminSecurityIpReputationHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    const body = await c.req.json<z.infer<typeof IpReputationRequestSchema>>();

    const parseResult = IpReputationRequestSchema.safeParse(body);
    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'ip_addresses',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const { ip_addresses } = parseResult.data;
    const adapter = createAdapter(c);

    // Check IP reputation from security events and known blocklists
    const results = await Promise.all(
      ip_addresses.map(async (ip) => {
        // Count failed auth attempts from this IP
        const failedAuthCount = await adapter.queryOne<{ count: number }>(
          `SELECT COUNT(*) as count FROM audit_log
           WHERE tenant_id = ?
             AND ip_address = ?
             AND action LIKE 'auth.%failed%'
             AND created_at >= ?`,
          [tenantId, ip, Math.floor(Date.now() / 1000) - 24 * 60 * 60] // Last 24 hours
        );

        // Check if IP is in blocklist
        const isBlocked = await adapter.queryOne<{ id: string }>(
          `SELECT id FROM ip_blocklist
           WHERE tenant_id = ? AND ip_address = ? AND expires_at > ?`,
          [tenantId, ip, Math.floor(Date.now() / 1000)]
        );

        // Check for rate limit violations
        const rateLimitViolations = await adapter.queryOne<{ count: number }>(
          `SELECT COUNT(*) as count FROM audit_log
           WHERE tenant_id = ?
             AND ip_address = ?
             AND action = 'rate_limit.exceeded'
             AND created_at >= ?`,
          [tenantId, ip, Math.floor(Date.now() / 1000) - 24 * 60 * 60]
        );

        // Calculate risk score (0-100)
        const failedAttempts = failedAuthCount?.count ?? 0;
        const rateLimitHits = rateLimitViolations?.count ?? 0;

        let riskScore = 0;
        let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';

        if (isBlocked) {
          riskScore = 100;
          riskLevel = 'critical';
        } else {
          riskScore += Math.min(failedAttempts * 5, 40);
          riskScore += Math.min(rateLimitHits * 10, 30);

          if (riskScore >= 70) riskLevel = 'critical';
          else if (riskScore >= 50) riskLevel = 'high';
          else if (riskScore >= 25) riskLevel = 'medium';
        }

        return {
          ip_address: ip,
          risk_score: riskScore,
          risk_level: riskLevel,
          is_blocked: !!isBlocked,
          indicators: {
            failed_auth_attempts_24h: failedAttempts,
            rate_limit_violations_24h: rateLimitHits,
          },
          recommendation:
            riskLevel === 'critical'
              ? 'Block immediately'
              : riskLevel === 'high'
                ? 'Monitor closely'
                : riskLevel === 'medium'
                  ? 'Review activity'
                  : 'No action needed',
        };
      })
    );

    // Write audit log
    await createAuditLogFromContext(c, 'security.ip_reputation_check', 'security', tenantId, {
      ip_count: ip_addresses.length,
      high_risk_count: results.filter((r) => r.risk_level === 'high' || r.risk_level === 'critical')
        .length,
    });

    return c.json({
      results,
      summary: {
        total_checked: results.length,
        critical: results.filter((r) => r.risk_level === 'critical').length,
        high: results.filter((r) => r.risk_level === 'high').length,
        medium: results.filter((r) => r.risk_level === 'medium').length,
        low: results.filter((r) => r.risk_level === 'low').length,
      },
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-SECURITY');
    log.error('Failed to check IP reputation', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

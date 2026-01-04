/**
 * Admin Compliance API Endpoints
 *
 * Compliance monitoring and status for administrative dashboard:
 * - GET  /api/admin/compliance/status          - Get compliance status overview
 * - GET  /api/admin/compliance/access-reviews  - List access reviews (Phase 2)
 * - POST /api/admin/compliance/access-reviews  - Start access review (Phase 2)
 * - GET  /api/admin/compliance/reports         - List compliance reports (Phase 2)
 * - GET  /api/admin/data-retention/status      - Get data retention status (Phase 3)
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
 * Compliance framework identifiers
 */
type ComplianceFramework = 'gdpr' | 'hipaa' | 'soc2' | 'iso27001' | 'pci_dss' | 'ccpa';

/**
 * Compliance check status values
 */
type ComplianceStatus = 'compliant' | 'warning' | 'non_compliant' | 'not_applicable';

// =============================================================================
// Types
// =============================================================================

/**
 * Individual compliance check result
 */
interface ComplianceCheck {
  id: string;
  name: string;
  description: string;
  framework: ComplianceFramework;
  status: ComplianceStatus;
  last_checked: string;
  details?: string;
}

/**
 * Framework compliance summary
 */
interface FrameworkSummary {
  framework: ComplianceFramework;
  status: ComplianceStatus;
  compliant_checks: number;
  warning_checks: number;
  non_compliant_checks: number;
  not_applicable_checks: number;
  total_checks: number;
  last_assessment: string | null;
}

/**
 * Overall compliance status response
 */
interface ComplianceStatusResponse {
  tenant_id: string;
  overall_status: ComplianceStatus;
  frameworks: FrameworkSummary[];
  recent_checks: ComplianceCheck[];
  data_retention: {
    policy_enabled: boolean;
    retention_days: number | null;
    last_cleanup: string | null;
    pending_deletions: number;
  };
  audit_log: {
    enabled: boolean;
    retention_days: number;
    total_entries: number;
    entries_last_30_days: number;
  };
  mfa_status: {
    enforced: boolean;
    users_with_mfa: number;
    users_without_mfa: number;
    mfa_coverage_percent: number;
  };
  encryption: {
    data_at_rest: boolean;
    data_in_transit: boolean;
    key_rotation_enabled: boolean;
    last_key_rotation: string | null;
  };
  access_control: {
    rbac_enabled: boolean;
    active_roles: number;
    users_with_roles: number;
    orphaned_permissions: number;
  };
  last_updated: string;
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
 * Convert Unix timestamp (seconds) to ISO 8601 string
 */
function toISOString(timestamp: number | null): string | null {
  if (!timestamp) return null;
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  return new Date(ms).toISOString();
}

/**
 * Determine overall status from multiple statuses
 */
function determineOverallStatus(statuses: ComplianceStatus[]): ComplianceStatus {
  if (statuses.includes('non_compliant')) return 'non_compliant';
  if (statuses.includes('warning')) return 'warning';
  if (statuses.every((s) => s === 'not_applicable')) return 'not_applicable';
  return 'compliant';
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /api/admin/compliance/status
 * Get comprehensive compliance status for the tenant
 *
 * Returns:
 * - Overall compliance status
 * - Per-framework compliance summary
 * - Recent compliance checks
 * - Data retention status
 * - Audit log status
 * - MFA enforcement status
 * - Encryption status
 * - Access control status
 */
export async function adminComplianceStatusHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    const adapter = createAdapter(c);
    const nowTs = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = nowTs - 30 * 24 * 60 * 60;

    // 1. Get tenant settings for compliance configuration
    const tenantSettings = await adapter.queryOne<{
      data_retention_enabled: number;
      data_retention_days: number | null;
      mfa_enforced: number;
      audit_log_retention_days: number;
    }>(
      `SELECT
        COALESCE(json_extract(settings, '$.data_retention.enabled'), 0) as data_retention_enabled,
        json_extract(settings, '$.data_retention.days') as data_retention_days,
        COALESCE(json_extract(settings, '$.security.mfa_enforced'), 0) as mfa_enforced,
        COALESCE(json_extract(settings, '$.audit.retention_days'), 90) as audit_log_retention_days
      FROM tenants
      WHERE id = ?`,
      [tenantId]
    );

    // 2. Get audit log statistics
    const auditStats = await adapter.queryOne<{
      total: number;
      last_30_days: number;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as last_30_days
      FROM audit_log
      WHERE tenant_id = ?`,
      [thirtyDaysAgo, tenantId]
    );

    // 3. Get MFA status
    const mfaStats = await adapter.queryOne<{
      users_with_mfa: number;
      users_without_mfa: number;
    }>(
      `SELECT
        SUM(CASE WHEN mfa_enabled = 1 THEN 1 ELSE 0 END) as users_with_mfa,
        SUM(CASE WHEN mfa_enabled = 0 OR mfa_enabled IS NULL THEN 1 ELSE 0 END) as users_without_mfa
      FROM users
      WHERE tenant_id = ? AND is_active = 1`,
      [tenantId]
    );

    // 4. Get RBAC statistics
    const rbacStats = await adapter.queryOne<{
      active_roles: number;
      users_with_roles: number;
    }>(
      `SELECT
        (SELECT COUNT(DISTINCT id) FROM roles WHERE tenant_id = ? OR tenant_id IS NULL) as active_roles,
        (SELECT COUNT(DISTINCT user_id) FROM user_roles) as users_with_roles`,
      [tenantId]
    );

    // 5. Get data retention status
    const retentionStats = await adapter.queryOne<{
      pending_deletions: number;
      last_cleanup: number | null;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE tenant_id = ? AND scheduled_deletion_at IS NOT NULL AND scheduled_deletion_at > ?) as pending_deletions,
        (SELECT MAX(deleted_at) FROM tombstones WHERE tenant_id = ?) as last_cleanup`,
      [tenantId, nowTs, tenantId]
    );

    // 6. Get signing key status for encryption info
    const keyStats = await adapter.queryOne<{
      last_rotation: number | null;
    }>(`SELECT MAX(created_at) as last_rotation FROM signing_keys WHERE tenant_id = ?`, [tenantId]);

    // Calculate MFA coverage
    const totalUsers = (mfaStats?.users_with_mfa || 0) + (mfaStats?.users_without_mfa || 0);
    const mfaCoveragePercent =
      totalUsers > 0 ? Math.round(((mfaStats?.users_with_mfa || 0) / totalUsers) * 100) : 0;

    // Build framework summaries based on available data
    const frameworkSummaries: FrameworkSummary[] = [];

    // GDPR summary
    const gdprStatus: ComplianceStatus = tenantSettings?.data_retention_enabled
      ? 'compliant'
      : 'warning';
    frameworkSummaries.push({
      framework: 'gdpr',
      status: gdprStatus,
      compliant_checks: gdprStatus === 'compliant' ? 3 : 2,
      warning_checks: gdprStatus === 'warning' ? 1 : 0,
      non_compliant_checks: 0,
      not_applicable_checks: 0,
      total_checks: 3,
      last_assessment: toISOString(nowTs),
    });

    // SOC2 summary
    const soc2Status: ComplianceStatus =
      (auditStats?.total || 0) > 0 && (rbacStats?.active_roles || 0) > 0 ? 'compliant' : 'warning';
    frameworkSummaries.push({
      framework: 'soc2',
      status: soc2Status,
      compliant_checks: soc2Status === 'compliant' ? 4 : 2,
      warning_checks: soc2Status === 'warning' ? 2 : 0,
      non_compliant_checks: 0,
      not_applicable_checks: 0,
      total_checks: 4,
      last_assessment: toISOString(nowTs),
    });

    // Determine overall status
    const overallStatus = determineOverallStatus(frameworkSummaries.map((f) => f.status));

    // Build recent checks
    const recentChecks: ComplianceCheck[] = [
      {
        id: 'gdpr-data-retention',
        name: 'Data Retention Policy',
        description: 'Verify data retention policy is configured',
        framework: 'gdpr',
        status: tenantSettings?.data_retention_enabled ? 'compliant' : 'warning',
        last_checked: new Date().toISOString(),
        details: tenantSettings?.data_retention_enabled
          ? `Retention period: ${tenantSettings.data_retention_days} days`
          : 'Data retention policy not configured',
      },
      {
        id: 'soc2-audit-logging',
        name: 'Audit Logging',
        description: 'Verify audit logging is enabled and functioning',
        framework: 'soc2',
        status: (auditStats?.total || 0) > 0 ? 'compliant' : 'warning',
        last_checked: new Date().toISOString(),
        details: `${auditStats?.total || 0} audit entries recorded`,
      },
      {
        id: 'soc2-access-control',
        name: 'Role-Based Access Control',
        description: 'Verify RBAC is configured',
        framework: 'soc2',
        status: (rbacStats?.active_roles || 0) > 0 ? 'compliant' : 'warning',
        last_checked: new Date().toISOString(),
        details: `${rbacStats?.active_roles || 0} roles configured, ${rbacStats?.users_with_roles || 0} users with roles`,
      },
      {
        id: 'security-mfa',
        name: 'Multi-Factor Authentication',
        description: 'Check MFA adoption rate',
        framework: 'soc2',
        status:
          mfaCoveragePercent >= 80
            ? 'compliant'
            : mfaCoveragePercent >= 50
              ? 'warning'
              : 'non_compliant',
        last_checked: new Date().toISOString(),
        details: `${mfaCoveragePercent}% of users have MFA enabled`,
      },
    ];

    const response: ComplianceStatusResponse = {
      tenant_id: tenantId,
      overall_status: overallStatus,
      frameworks: frameworkSummaries,
      recent_checks: recentChecks,
      data_retention: {
        policy_enabled: !!tenantSettings?.data_retention_enabled,
        retention_days: tenantSettings?.data_retention_days || null,
        last_cleanup: toISOString(retentionStats?.last_cleanup ?? null),
        pending_deletions: retentionStats?.pending_deletions || 0,
      },
      audit_log: {
        enabled: true, // Always enabled in Authrim
        retention_days: tenantSettings?.audit_log_retention_days || 90,
        total_entries: auditStats?.total || 0,
        entries_last_30_days: auditStats?.last_30_days || 0,
      },
      mfa_status: {
        enforced: !!tenantSettings?.mfa_enforced,
        users_with_mfa: mfaStats?.users_with_mfa || 0,
        users_without_mfa: mfaStats?.users_without_mfa || 0,
        mfa_coverage_percent: mfaCoveragePercent,
      },
      encryption: {
        data_at_rest: true, // D1/R2 provide encryption at rest
        data_in_transit: true, // HTTPS enforced
        key_rotation_enabled: true,
        last_key_rotation: toISOString(keyStats?.last_rotation ?? null),
      },
      access_control: {
        rbac_enabled: true, // Always enabled
        active_roles: rbacStats?.active_roles || 0,
        users_with_roles: rbacStats?.users_with_roles || 0,
        orphaned_permissions: 0, // Would require additional query
      },
      last_updated: new Date().toISOString(),
    };

    return c.json(response);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-COMPLIANCE');
    log.error('Failed to get compliance status', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 2: Access Reviews
// =============================================================================

/**
 * Access review status values
 */
const ACCESS_REVIEW_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;
type AccessReviewStatus = (typeof ACCESS_REVIEW_STATUSES)[number];

/**
 * Access review scope types
 */
const ACCESS_REVIEW_SCOPES = ['all_users', 'role', 'organization', 'inactive_users'] as const;
type AccessReviewScope = (typeof ACCESS_REVIEW_SCOPES)[number];

/**
 * Access review database row
 */
interface AccessReviewRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  scope: AccessReviewScope;
  scope_value: string | null;
  status: AccessReviewStatus;
  reviewer_id: string;
  total_items: number;
  reviewed_items: number;
  approved_items: number;
  revoked_items: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  due_date: number | null;
}

/**
 * Create access review request schema
 */
const CreateAccessReviewSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  scope: z.enum(ACCESS_REVIEW_SCOPES),
  scope_value: z.string().optional(),
  due_date: z.string().datetime().optional(),
});

/**
 * Default and max limits for pagination
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Cursor data type for pagination
 */
interface CursorData {
  id: string;
  created_at: number;
}

/**
 * Encode cursor from ID and created_at
 */
function encodeCursor(id: string, createdAt: number): string {
  return Buffer.from(JSON.stringify({ id, created_at: createdAt })).toString('base64url');
}

/**
 * Decode cursor
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
 * Get admin auth context from request
 */
function getAdminAuth(c: Context<{ Bindings: Env }>): { adminId?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  return (c as any).get('adminAuth') as { adminId?: string } | null;
}

/**
 * GET /api/admin/compliance/access-reviews
 * List access reviews with cursor-based pagination
 */
export async function adminComplianceAccessReviewsListHandler(c: Context<{ Bindings: Env }>) {
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
  const limitParam = c.req.query('limit');
  const cursor = c.req.query('cursor');
  const filter = c.req.query('filter');

  const limit = Math.min(Math.max(parseInt(limitParam || '20', 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const adapter = createAdapter(c);

    // Build query
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    // Apply cursor
    if (cursor) {
      const cursorData = decodeCursor(cursor);
      if (!cursorData) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'cursor', reason: 'Invalid cursor format' },
        });
      }
      whereClauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
      bindings.push(cursorData.created_at, cursorData.created_at, cursorData.id);
    }

    // Apply filters
    if (filter) {
      const statusMatch = filter.match(/status=(\w+)/);
      if (statusMatch) {
        const status = statusMatch[1];
        if (ACCESS_REVIEW_STATUSES.includes(status as AccessReviewStatus)) {
          whereClauses.push('status = ?');
          bindings.push(status);
        }
      }
    }

    // Fetch data
    const limitPlusOne = limit + 1;
    const sql = `
      SELECT id, tenant_id, name, description, scope, scope_value, status,
             reviewer_id, total_items, reviewed_items, approved_items, revoked_items,
             created_at, started_at, completed_at, due_date
      FROM access_reviews
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `;
    bindings.push(limitPlusOne);

    const rows = await adapter.query<AccessReviewRow>(sql, bindings);

    // Pagination
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor(lastRow.id, lastRow.created_at);
    }

    // Format response
    const formattedData = data.map((row) => ({
      review_id: row.id,
      name: row.name,
      description: row.description,
      scope: row.scope,
      scope_value: row.scope_value,
      status: row.status,
      reviewer_id: row.reviewer_id,
      progress: {
        total_items: row.total_items,
        reviewed_items: row.reviewed_items,
        approved_items: row.approved_items,
        revoked_items: row.revoked_items,
        completion_percent:
          row.total_items > 0 ? Math.round((row.reviewed_items / row.total_items) * 100) : 0,
      },
      created_at: toISOString(row.created_at),
      started_at: toISOString(row.started_at),
      completed_at: toISOString(row.completed_at),
      due_date: toISOString(row.due_date),
    }));

    return c.json({
      data: formattedData,
      pagination: {
        has_more: hasMore,
        ...(nextCursor && { next_cursor: nextCursor }),
      },
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN-COMPLIANCE');
    log.error('Failed to list access reviews', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/compliance/access-reviews
 * Start a new access review
 */
export async function adminComplianceAccessReviewsCreateHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    const body = await c.req.json<unknown>();
    const parseResult = CreateAccessReviewSchema.safeParse(body);
    if (!parseResult.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'body',
          reason: parseResult.error.issues.map((i) => i.message).join(', '),
        },
      });
    }

    const { name, description, scope, scope_value, due_date } = parseResult.data;
    const adapter = createAdapter(c);

    // Get admin auth
    const adminAuth = getAdminAuth(c);
    const reviewerId = adminAuth?.adminId ?? 'unknown';

    // Generate review ID
    const reviewId = crypto.randomUUID();
    const nowTs = Math.floor(Date.now() / 1000);
    const dueDateTs = due_date ? Math.floor(new Date(due_date).getTime() / 1000) : null;

    // Count items to review based on scope
    let totalItems = 0;
    switch (scope) {
      case 'all_users':
        {
          const result = await adapter.queryOne<{ count: number }>(
            'SELECT COUNT(*) as count FROM users WHERE tenant_id = ? AND is_active = 1',
            [tenantId]
          );
          totalItems = result?.count ?? 0;
        }
        break;
      case 'role':
        if (scope_value) {
          const result = await adapter.queryOne<{ count: number }>(
            `SELECT COUNT(*) as count FROM user_roles ur
             JOIN users u ON ur.user_id = u.id
             WHERE u.tenant_id = ? AND ur.role_id = ?`,
            [tenantId, scope_value]
          );
          totalItems = result?.count ?? 0;
        }
        break;
      case 'organization':
        if (scope_value) {
          const result = await adapter.queryOne<{ count: number }>(
            `SELECT COUNT(*) as count FROM organization_members om
             JOIN users u ON om.user_id = u.id
             WHERE u.tenant_id = ? AND om.organization_id = ?`,
            [tenantId, scope_value]
          );
          totalItems = result?.count ?? 0;
        }
        break;
      case 'inactive_users':
        {
          // Users not logged in for 90 days
          const inactiveThreshold = nowTs - 90 * 24 * 60 * 60;
          const result = await adapter.queryOne<{ count: number }>(
            `SELECT COUNT(*) as count FROM users
             WHERE tenant_id = ? AND is_active = 1
             AND (last_login_at IS NULL OR last_login_at < ?)`,
            [tenantId, inactiveThreshold]
          );
          totalItems = result?.count ?? 0;
        }
        break;
    }

    // Insert access review
    await adapter.execute(
      `INSERT INTO access_reviews (
        id, tenant_id, name, description, scope, scope_value, status,
        reviewer_id, total_items, reviewed_items, approved_items, revoked_items,
        created_at, started_at, due_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
      [
        reviewId,
        tenantId,
        name,
        description || null,
        scope,
        scope_value || null,
        'pending',
        reviewerId,
        totalItems,
        nowTs,
        nowTs, // started_at = now
        dueDateTs,
      ]
    );

    // Write audit log
    await createAuditLogFromContext(c, 'access_review.created', 'access_review', reviewId, {
      name,
      scope,
      scope_value,
      total_items: totalItems,
    });

    return c.json(
      {
        review_id: reviewId,
        name,
        description,
        scope,
        scope_value,
        status: 'pending',
        reviewer_id: reviewerId,
        total_items: totalItems,
        created_at: toISOString(nowTs),
        due_date: toISOString(dueDateTs),
      },
      201
    );
  } catch (error) {
    const log = getLogger(c).module('ADMIN-COMPLIANCE');
    log.error('Failed to create access review', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 2: Compliance Reports
// =============================================================================

/**
 * Compliance report types
 */
const REPORT_TYPES = ['gdpr_dsar', 'soc2_audit', 'access_summary', 'user_activity'] as const;
type ReportType = (typeof REPORT_TYPES)[number];

/**
 * Report status values
 */
const REPORT_STATUSES = ['pending', 'generating', 'completed', 'failed'] as const;
type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * Compliance report database row
 */
interface ComplianceReportRow {
  id: string;
  tenant_id: string;
  type: ReportType;
  name: string;
  status: ReportStatus;
  requested_by: string;
  parameters: string | null;
  result_url: string | null;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
  expires_at: number | null;
}

/**
 * GET /api/admin/compliance/reports
 * List compliance reports with cursor-based pagination
 */
export async function adminComplianceReportsListHandler(c: Context<{ Bindings: Env }>) {
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
  const limitParam = c.req.query('limit');
  const cursor = c.req.query('cursor');
  const filter = c.req.query('filter');

  const limit = Math.min(Math.max(parseInt(limitParam || '20', 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  try {
    const adapter = createAdapter(c);

    // Build query
    const whereClauses: string[] = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];

    // Apply cursor
    if (cursor) {
      const cursorData = decodeCursor(cursor);
      if (!cursorData) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'cursor', reason: 'Invalid cursor format' },
        });
      }
      whereClauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
      bindings.push(cursorData.created_at, cursorData.created_at, cursorData.id);
    }

    // Apply filters
    if (filter) {
      const statusMatch = filter.match(/status=(\w+)/);
      if (statusMatch) {
        const status = statusMatch[1];
        if (REPORT_STATUSES.includes(status as ReportStatus)) {
          whereClauses.push('status = ?');
          bindings.push(status);
        }
      }
      const typeMatch = filter.match(/type=(\w+)/);
      if (typeMatch) {
        const type = typeMatch[1];
        if (REPORT_TYPES.includes(type as ReportType)) {
          whereClauses.push('type = ?');
          bindings.push(type);
        }
      }
    }

    // Fetch data
    const limitPlusOne = limit + 1;
    const sql = `
      SELECT id, tenant_id, type, name, status, requested_by,
             parameters, result_url, error_message,
             created_at, completed_at, expires_at
      FROM compliance_reports
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `;
    bindings.push(limitPlusOne);

    const rows = await adapter.query<ComplianceReportRow>(sql, bindings);

    // Pagination
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = encodeCursor(lastRow.id, lastRow.created_at);
    }

    // Format response
    const formattedData = data.map((row) => {
      let parameters: Record<string, unknown> | null = null;
      if (row.parameters) {
        try {
          parameters = JSON.parse(row.parameters) as Record<string, unknown>;
        } catch {
          // Invalid JSON
        }
      }

      return {
        report_id: row.id,
        type: row.type,
        name: row.name,
        status: row.status,
        requested_by: row.requested_by,
        parameters,
        result_url: row.result_url,
        error_message: row.error_message,
        created_at: toISOString(row.created_at),
        completed_at: toISOString(row.completed_at),
        expires_at: toISOString(row.expires_at),
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
    const log = getLogger(c).module('ADMIN-COMPLIANCE');
    log.error('Failed to list compliance reports', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

// =============================================================================
// Phase 3: Data Retention Status
// =============================================================================

/**
 * Data category retention info
 */
interface CategoryRetentionInfo {
  category: string;
  retention_days: number;
  total_records: number;
  records_pending_deletion: number;
  oldest_record_date: string | null;
  next_cleanup_date: string | null;
  last_cleanup_date: string | null;
  records_deleted_last_30_days: number;
}

/**
 * Data retention policy configuration
 */
interface RetentionPolicyConfig {
  enabled: boolean;
  default_retention_days: number;
  categories: Record<
    string,
    {
      retention_days: number;
      description: string;
    }
  >;
  cleanup_schedule: string;
  last_cleanup_run: string | null;
  next_cleanup_run: string | null;
}

/**
 * Data retention status response
 */
interface DataRetentionStatusResponse {
  tenant_id: string;
  policy: RetentionPolicyConfig;
  categories: CategoryRetentionInfo[];
  summary: {
    total_records: number;
    records_pending_deletion: number;
    records_deleted_last_30_days: number;
    storage_savings_estimate_mb: number;
  };
  gdpr_compliance: {
    right_to_erasure_supported: boolean;
    anonymization_supported: boolean;
    tombstone_retention_days: number;
    pending_erasure_requests: number;
  };
  last_updated: string;
}

/**
 * Default retention policy categories
 */
const DEFAULT_RETENTION_CATEGORIES: Record<
  string,
  { retention_days: number; description: string }
> = {
  audit_logs: { retention_days: 90, description: 'Authentication and security audit logs' },
  session_data: { retention_days: 30, description: 'User session records' },
  token_data: { retention_days: 7, description: 'Revoked tokens and token metadata' },
  consent_records: { retention_days: 2555, description: 'User consent history (7 years)' },
  analytics_data: { retention_days: 365, description: 'Usage analytics and statistics' },
  webhook_deliveries: { retention_days: 30, description: 'Webhook delivery logs' },
  rate_limit_data: { retention_days: 1, description: 'Rate limiting counters' },
};

/**
 * GET /api/admin/data-retention/status
 * Get data retention policy status and statistics
 *
 * Returns:
 * - Current retention policy configuration
 * - Per-category retention statistics
 * - Records pending deletion
 * - Cleanup schedule status
 * - GDPR compliance status
 */
export async function adminDataRetentionStatusHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    const adapter = createAdapter(c);
    const nowTs = Math.floor(Date.now() / 1000);

    // Get tenant retention settings
    const tenantSettings = await adapter.queryOne<{
      data_retention_enabled: number;
      data_retention_days: number | null;
      audit_log_retention_days: number | null;
      session_retention_days: number | null;
      tombstone_retention_days: number | null;
      last_cleanup_at: number | null;
      next_cleanup_at: number | null;
    }>(
      `SELECT
        COALESCE(json_extract(settings, '$.data_retention.enabled'), 0) as data_retention_enabled,
        json_extract(settings, '$.data_retention.days') as data_retention_days,
        json_extract(settings, '$.audit.retention_days') as audit_log_retention_days,
        json_extract(settings, '$.session.retention_days') as session_retention_days,
        json_extract(settings, '$.compliance.tombstone_retention_days') as tombstone_retention_days,
        json_extract(settings, '$.data_retention.last_cleanup_at') as last_cleanup_at,
        json_extract(settings, '$.data_retention.next_cleanup_at') as next_cleanup_at
      FROM tenants
      WHERE id = ?`,
      [tenantId]
    );

    const retentionEnabled = !!tenantSettings?.data_retention_enabled;
    const defaultRetentionDays = tenantSettings?.data_retention_days || 365;

    // Build category-specific statistics
    const categories: CategoryRetentionInfo[] = [];

    // Audit logs statistics
    const auditStats = await adapter.queryOne<{
      total: number;
      pending_deletion: number;
      oldest_date: number | null;
      deleted_last_30_days: number;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END) as pending_deletion,
        MIN(created_at) as oldest_date,
        0 as deleted_last_30_days
      FROM audit_log
      WHERE tenant_id = ?`,
      [nowTs - (tenantSettings?.audit_log_retention_days || 90) * 24 * 60 * 60, tenantId]
    );

    const auditRetentionDays = tenantSettings?.audit_log_retention_days || 90;
    categories.push({
      category: 'audit_logs',
      retention_days: auditRetentionDays,
      total_records: auditStats?.total || 0,
      records_pending_deletion: auditStats?.pending_deletion || 0,
      oldest_record_date: toISOString(auditStats?.oldest_date ?? null),
      next_cleanup_date: toISOString(tenantSettings?.next_cleanup_at ?? null),
      last_cleanup_date: toISOString(tenantSettings?.last_cleanup_at ?? null),
      records_deleted_last_30_days: auditStats?.deleted_last_30_days || 0,
    });

    // Sessions statistics
    const sessionStats = await adapter.queryOne<{
      total: number;
      expired: number;
      oldest_date: number | null;
    }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN expires_at < ? THEN 1 ELSE 0 END) as expired,
        MIN(created_at) as oldest_date
      FROM sessions
      WHERE tenant_id = ?`,
      [nowTs, tenantId]
    );

    const sessionRetentionDays = tenantSettings?.session_retention_days || 30;
    categories.push({
      category: 'session_data',
      retention_days: sessionRetentionDays,
      total_records: sessionStats?.total || 0,
      records_pending_deletion: sessionStats?.expired || 0,
      oldest_record_date: toISOString(sessionStats?.oldest_date ?? null),
      next_cleanup_date: toISOString(tenantSettings?.next_cleanup_at ?? null),
      last_cleanup_date: toISOString(tenantSettings?.last_cleanup_at ?? null),
      records_deleted_last_30_days: 0,
    });

    // Tombstones statistics (for GDPR tracking)
    const tombstoneStats = await adapter.queryOne<{
      total: number;
      oldest_date: number | null;
    }>(
      `SELECT
        COUNT(*) as total,
        MIN(deleted_at) as oldest_date
      FROM tombstones
      WHERE tenant_id = ?`,
      [tenantId]
    );

    // Add tombstones as a category for tracking
    categories.push({
      category: 'tombstones',
      retention_days: tenantSettings?.tombstone_retention_days || 2555,
      total_records: tombstoneStats?.total || 0,
      records_pending_deletion: 0, // Tombstones are kept for compliance
      oldest_record_date: toISOString(tombstoneStats?.oldest_date ?? null),
      next_cleanup_date: null,
      last_cleanup_date: null,
      records_deleted_last_30_days: 0,
    });

    // Pending erasure requests
    const erasureRequests = await adapter.queryOne<{ pending: number }>(
      `SELECT COUNT(*) as pending
       FROM users
       WHERE tenant_id = ? AND scheduled_deletion_at IS NOT NULL AND scheduled_deletion_at > ?`,
      [tenantId, nowTs]
    );

    // Calculate totals
    const totalRecords = categories.reduce((sum, c) => sum + c.total_records, 0);
    const pendingDeletion = categories.reduce((sum, c) => sum + c.records_pending_deletion, 0);
    const deletedLast30Days = categories.reduce(
      (sum, c) => sum + c.records_deleted_last_30_days,
      0
    );

    // Estimate storage savings (rough estimate: 500 bytes per record)
    const storageSavingsMb = Math.round(((pendingDeletion * 500) / (1024 * 1024)) * 100) / 100;

    // Build response
    const response: DataRetentionStatusResponse = {
      tenant_id: tenantId,
      policy: {
        enabled: retentionEnabled,
        default_retention_days: defaultRetentionDays,
        categories: {
          ...DEFAULT_RETENTION_CATEGORIES,
          audit_logs: {
            retention_days: auditRetentionDays,
            description: DEFAULT_RETENTION_CATEGORIES.audit_logs.description,
          },
          session_data: {
            retention_days: sessionRetentionDays,
            description: DEFAULT_RETENTION_CATEGORIES.session_data.description,
          },
        },
        cleanup_schedule: 'daily',
        last_cleanup_run: toISOString(tenantSettings?.last_cleanup_at ?? null),
        next_cleanup_run: toISOString(tenantSettings?.next_cleanup_at ?? null),
      },
      categories,
      summary: {
        total_records: totalRecords,
        records_pending_deletion: pendingDeletion,
        records_deleted_last_30_days: deletedLast30Days,
        storage_savings_estimate_mb: storageSavingsMb,
      },
      gdpr_compliance: {
        right_to_erasure_supported: true,
        anonymization_supported: true,
        tombstone_retention_days: tenantSettings?.tombstone_retention_days || 2555, // 7 years default
        pending_erasure_requests: erasureRequests?.pending || 0,
      },
      last_updated: new Date().toISOString(),
    };

    return c.json(response);
  } catch (error) {
    const log = getLogger(c).module('ADMIN-COMPLIANCE');
    log.error('Failed to get data retention status', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

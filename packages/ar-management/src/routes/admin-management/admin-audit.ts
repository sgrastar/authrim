/**
 * Admin Audit Log API
 *
 * Endpoints for viewing Admin operation audit logs (stored in DB_ADMIN).
 * These are separate from general audit logs (EndUser operations).
 *
 * Requires super_admin role or admin:admin_audit:read permission.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  AdminAuditLogRepository,
  AdminUserRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
} from '@authrim/ar-lib-core';

// Define context type with adminAuth variable
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

// Create router
export const adminAuditRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Apply admin authentication to all routes
adminAuditRouter.use(
  '*',
  adminAuthMiddleware({
    requirePermissions: [ADMIN_PERMISSIONS.ADMIN_AUDIT_READ],
  })
);

/**
 * Helper to get DB_ADMIN adapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAdminAdapter(c: Context<any, any, any>) {
  if (!c.env.DB_ADMIN) {
    throw new Error('DB_ADMIN is not configured');
  }
  return new D1Adapter({ db: c.env.DB_ADMIN });
}

/**
 * GET /api/admin/admin-audit-log
 * List Admin audit log entries with pagination and filtering
 */
adminAuditRouter.get('/', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const auditRepo = new AdminAuditLogRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    // Parse query parameters
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
    const adminUserId = c.req.query('admin_user_id');
    const action = c.req.query('action');
    const resourceType = c.req.query('resource_type');
    const result = c.req.query('result') as 'success' | 'failure' | undefined;
    const severity = c.req.query('severity') as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error'
      | 'critical'
      | undefined;
    const startDate = c.req.query('start_date');
    const endDate = c.req.query('end_date');

    // Parse date filters
    let startTimestamp: number | undefined;
    let endTimestamp: number | undefined;

    if (startDate) {
      const parsed = Date.parse(startDate);
      if (!isNaN(parsed)) {
        startTimestamp = parsed;
      }
    }
    if (endDate) {
      const parsed = Date.parse(endDate);
      if (!isNaN(parsed)) {
        // Include the entire day
        endTimestamp = parsed + 24 * 60 * 60 * 1000 - 1;
      }
    }

    const logs = await auditRepo.searchAuditLogs(
      {
        tenant_id: tenantId,
        admin_user_id: adminUserId,
        action,
        resource_type: resourceType,
        result,
        severity,
        from_timestamp: startTimestamp,
        to_timestamp: endTimestamp,
      },
      {
        page,
        limit,
      }
    );

    // Enrich with admin user info if available
    const userRepo = new AdminUserRepository(adapter);
    const enrichedItems = await Promise.all(
      logs.items.map(async (log) => {
        let adminUserName: string | null = null;
        if (log.admin_user_id) {
          const user = await userRepo.getAdminUser(log.admin_user_id);
          adminUserName = user?.name || null;
        }
        return {
          ...log,
          admin_user_name: adminUserName,
        };
      })
    );

    return c.json({
      items: enrichedItems,
      total: logs.total,
      page: logs.page,
      limit: logs.limit,
      totalPages: logs.totalPages,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-audit-log/:id
 * Get Admin audit log entry details
 */
adminAuditRouter.get('/:id', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const auditRepo = new AdminAuditLogRepository(adapter);
    const userRepo = new AdminUserRepository(adapter);

    const id = c.req.param('id');
    const log = await auditRepo.getAuditLog(id);

    if (!log) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Enrich with admin user info
    let adminUser: {
      id: string;
      email: string;
      name: string | null;
    } | null = null;

    if (log.admin_user_id) {
      const user = await userRepo.getAdminUser(log.admin_user_id);
      if (user) {
        adminUser = {
          id: user.id,
          email: user.email,
          name: user.name,
        };
      }
    }

    // Return log with enriched admin user info
    return c.json({
      ...log,
      admin_user: adminUser,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-audit-log/actions
 * List all unique action types in audit log
 */
adminAuditRouter.get('/actions/list', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const tenantId = getTenantIdFromContext(c);

    // Query distinct actions
    const result = await adapter.query<{ action: string }>(
      `SELECT DISTINCT action FROM admin_audit_log WHERE tenant_id = ? ORDER BY action ASC`,
      [tenantId]
    );

    const actions = result.map((r) => r.action);

    return c.json({
      items: actions,
      total: actions.length,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-audit-log/resource-types
 * List all unique resource types in audit log
 */
adminAuditRouter.get('/resource-types/list', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const tenantId = getTenantIdFromContext(c);

    // Query distinct resource types
    const result = await adapter.query<{ resource_type: string }>(
      `SELECT DISTINCT resource_type FROM admin_audit_log WHERE tenant_id = ? AND resource_type IS NOT NULL ORDER BY resource_type ASC`,
      [tenantId]
    );

    const resourceTypes = result.map((r) => r.resource_type);

    return c.json({
      items: resourceTypes,
      total: resourceTypes.length,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-audit-log/stats
 * Get audit log statistics
 */
adminAuditRouter.get('/stats/summary', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const tenantId = getTenantIdFromContext(c);

    // Get time range (default: last 7 days)
    const days = parseInt(c.req.query('days') || '7', 10);
    const startTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;

    // Total entries
    const totalResult = await adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM admin_audit_log WHERE tenant_id = ?`,
      [tenantId]
    );

    // Entries in time range
    const recentResult = await adapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM admin_audit_log WHERE tenant_id = ? AND created_at >= ?`,
      [tenantId, startTimestamp]
    );

    // Success/failure breakdown
    const resultBreakdown = await adapter.query<{ result: string; count: number }>(
      `SELECT result, COUNT(*) as count FROM admin_audit_log WHERE tenant_id = ? AND created_at >= ? GROUP BY result`,
      [tenantId, startTimestamp]
    );

    // Severity breakdown
    const severityBreakdown = await adapter.query<{ severity: string; count: number }>(
      `SELECT severity, COUNT(*) as count FROM admin_audit_log WHERE tenant_id = ? AND created_at >= ? GROUP BY severity`,
      [tenantId, startTimestamp]
    );

    // Top actions
    const topActions = await adapter.query<{ action: string; count: number }>(
      `SELECT action, COUNT(*) as count FROM admin_audit_log WHERE tenant_id = ? AND created_at >= ? GROUP BY action ORDER BY count DESC LIMIT 10`,
      [tenantId, startTimestamp]
    );

    // Active admins
    const activeAdmins = await adapter.query<{
      admin_user_id: string;
      admin_email: string;
      count: number;
    }>(
      `SELECT admin_user_id, admin_email, COUNT(*) as count FROM admin_audit_log WHERE tenant_id = ? AND created_at >= ? AND admin_user_id IS NOT NULL GROUP BY admin_user_id, admin_email ORDER BY count DESC LIMIT 10`,
      [tenantId, startTimestamp]
    );

    return c.json({
      total_entries: totalResult?.count ?? 0,
      recent_entries: recentResult?.count ?? 0,
      time_range_days: days,
      result_breakdown: resultBreakdown.reduce(
        (acc, r) => ({ ...acc, [r.result]: r.count }),
        {} as Record<string, number>
      ),
      severity_breakdown: severityBreakdown.reduce(
        (acc, s) => ({ ...acc, [s.severity]: s.count }),
        {} as Record<string, number>
      ),
      top_actions: topActions,
      most_active_admins: activeAdmins.map((a) => ({
        admin_user_id: a.admin_user_id,
        admin_email: a.admin_email,
        action_count: a.count,
      })),
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/admin-audit-log/user/:userId
 * Get audit log entries for a specific admin user
 */
adminAuditRouter.get('/user/:userId', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const auditRepo = new AdminAuditLogRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const userId = c.req.param('userId');
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);

    const logs = await auditRepo.searchAuditLogs(
      {
        tenant_id: tenantId,
        admin_user_id: userId,
      },
      {
        page,
        limit,
      }
    );

    return c.json({
      items: logs.items,
      total: logs.total,
      page: logs.page,
      limit: logs.limit,
      totalPages: logs.totalPages,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export default adminAuditRouter;

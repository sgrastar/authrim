/**
 * Data Retention Management API
 *
 * Provides endpoints for managing data retention policies:
 * - GET /api/admin/data-retention/estimate - Get deletion estimates
 * - PUT /api/admin/data-retention/categories/:category - Update category retention settings
 * - POST /api/admin/data-retention/cleanup - Trigger manual cleanup
 * - GET /api/admin/data-retention/cleanup/:runId - Get cleanup run status
 *
 * Security:
 * - RBAC: tenant_admin or higher required
 * - Tenant isolation: All operations scoped by tenant_id
 * - Audit logging: All write operations logged
 */

import { Context } from 'hono';
import { z } from 'zod';
import {
  D1Adapter,
  type DatabaseAdapter,
  type Env,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  getLogger,
  createAuditLogFromContext,
} from '@authrim/ar-lib-core';

// =============================================================================
// Types
// =============================================================================

interface CleanupEstimate {
  category: string;
  records_to_delete: number;
  oldest_record_date: string | null;
  retention_days: number;
  estimated_storage_mb: number;
}

interface CleanupRun {
  id: string;
  tenant_id: string;
  status: 'pending' | 'running' | 'completed' | 'partial_success' | 'failed';
  categories: string[];
  records_deleted: Record<string, number>;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  created_at: string;
}

interface CategoryConfig {
  category: string;
  retention_days: number;
  updated_at: string;
}

// =============================================================================
// Helpers
// =============================================================================

function createAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  return new D1Adapter({ db: c.env.DB });
}

function toISOString(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  return new Date(timestamp * 1000).toISOString();
}

// Category definitions with default retention periods
const RETENTION_CATEGORIES: Record<
  string,
  { defaultDays: number; tableName: string; dateColumn: string }
> = {
  audit_logs: { defaultDays: 90, tableName: 'audit_log', dateColumn: 'created_at' },
  session_data: { defaultDays: 30, tableName: 'sessions', dateColumn: 'created_at' },
  tombstones: { defaultDays: 365, tableName: 'tombstones', dateColumn: 'deleted_at' },
  auth_codes: { defaultDays: 1, tableName: 'authorization_codes', dateColumn: 'created_at' },
  refresh_tokens: { defaultDays: 30, tableName: 'refresh_tokens', dateColumn: 'created_at' },
  access_tokens: { defaultDays: 1, tableName: 'access_tokens', dateColumn: 'created_at' },
};

// =============================================================================
// Schemas
// =============================================================================

const UpdateCategorySchema = z.object({
  retention_days: z.number().int().min(1).max(3650), // 1 day to 10 years
});

const RunCleanupSchema = z.object({
  categories: z.array(z.string()).optional(), // Empty = all categories
  idempotency_key: z.string().optional(),
});

// =============================================================================
// Handlers
// =============================================================================

// Note: GET /api/admin/data-retention/status is handled by adminDataRetentionStatusHandler
// in admin-compliance.ts for backward compatibility

/**
 * GET /api/admin/data-retention/estimate
 * Get deletion estimates for all categories or a specific category
 */
export async function getDataRetentionEstimate(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const categoryFilter = c.req.query('category');

  try {
    const adapter = createAdapter(c);
    const nowTs = Math.floor(Date.now() / 1000);
    const estimates: CleanupEstimate[] = [];

    // Get tenant-specific retention settings
    const tenantSettings = await adapter.queryOne<{
      settings: string | null;
    }>('SELECT settings FROM tenants WHERE id = ?', [tenantId]);

    const settings = tenantSettings?.settings
      ? (JSON.parse(tenantSettings.settings) as Record<string, unknown>)
      : {};
    const retentionConfig = (settings.data_retention as Record<string, unknown>) || {};

    for (const [category, config] of Object.entries(RETENTION_CATEGORIES)) {
      // Skip if filtering by category
      if (categoryFilter && category !== categoryFilter) continue;

      // Get category-specific retention days from settings or use default
      const categorySettings =
        (retentionConfig.categories as Record<string, { retention_days: number }>) || {};
      const retentionDays = categorySettings[category]?.retention_days || config.defaultDays;

      const cutoffTs = nowTs - retentionDays * 24 * 60 * 60;

      // Count records to delete
      try {
        const stats = await adapter.queryOne<{
          count: number;
          oldest_date: number | null;
        }>(
          `SELECT
            COUNT(*) as count,
            MIN(${config.dateColumn}) as oldest_date
          FROM ${config.tableName}
          WHERE tenant_id = ? AND ${config.dateColumn} < ?`,
          [tenantId, cutoffTs]
        );

        estimates.push({
          category,
          records_to_delete: stats?.count || 0,
          oldest_record_date: toISOString(stats?.oldest_date ?? null),
          retention_days: retentionDays,
          estimated_storage_mb: Math.round((stats?.count || 0) * 0.001 * 100) / 100, // Rough estimate: 1KB per record
        });
      } catch {
        // Table might not exist, skip
        estimates.push({
          category,
          records_to_delete: 0,
          oldest_record_date: null,
          retention_days: retentionDays,
          estimated_storage_mb: 0,
        });
      }
    }

    return c.json({
      estimates,
      total_records_to_delete: estimates.reduce((sum, e) => sum + e.records_to_delete, 0),
      total_estimated_storage_mb: estimates.reduce((sum, e) => sum + e.estimated_storage_mb, 0),
    });
  } catch (error) {
    const log = getLogger(c).module('DATA-RETENTION');
    log.error('Failed to get retention estimate', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * PUT /api/admin/data-retention/categories/:category
 * Update retention settings for a specific category
 */
export async function updateCategoryRetention(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const category = c.req.param('category');

  // Validate category exists
  if (!RETENTION_CATEGORIES[category]) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'category',
        reason: `Invalid category. Valid categories: ${Object.keys(RETENTION_CATEGORIES).join(', ')}`,
      },
    });
  }

  try {
    const body = await c.req.json();
    const validation = UpdateCategorySchema.safeParse(body);

    if (!validation.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: validation.error.issues[0]?.path.join('.') || 'retention_days',
          reason: validation.error.issues[0]?.message || 'Invalid value',
        },
      });
    }

    const { retention_days } = validation.data;
    const adapter = createAdapter(c);
    const nowTs = Math.floor(Date.now() / 1000);

    // Get current settings
    const tenant = await adapter.queryOne<{ settings: string | null }>(
      'SELECT settings FROM tenants WHERE id = ?',
      [tenantId]
    );

    const settings = tenant?.settings
      ? (JSON.parse(tenant.settings) as Record<string, unknown>)
      : {};
    const dataRetention = (settings.data_retention || {}) as Record<string, unknown>;
    const categories = (dataRetention.categories || {}) as Record<
      string,
      { retention_days: number; updated_at: number }
    >;

    // Update category settings
    categories[category] = {
      retention_days,
      updated_at: nowTs,
    };

    dataRetention.categories = categories;
    settings.data_retention = dataRetention;

    // Save updated settings
    await adapter.execute('UPDATE tenants SET settings = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(settings),
      nowTs,
      tenantId,
    ]);

    // Audit log
    await createAuditLogFromContext(
      c,
      'data_retention.category_updated',
      'data_retention',
      category,
      {
        category,
        retention_days,
        tenant_id: tenantId,
      }
    );

    const log = getLogger(c).module('DATA-RETENTION');
    log.info('Category retention updated', { category, retention_days });

    return c.json({
      category,
      retention_days,
      updated_at: toISOString(nowTs),
    });
  } catch (error) {
    const log = getLogger(c).module('DATA-RETENTION');
    log.error('Failed to update category retention', { category }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * POST /api/admin/data-retention/cleanup
 * Trigger manual cleanup for specified categories or all categories
 */
export async function runDataRetentionCleanup(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    const body = await c.req.json();
    const validation = RunCleanupSchema.safeParse(body);

    if (!validation.success) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: validation.error.issues[0]?.path.join('.') || 'categories',
          reason: validation.error.issues[0]?.message || 'Invalid value',
        },
      });
    }

    const { categories: requestedCategories, idempotency_key } = validation.data;
    const adapter = createAdapter(c);
    const nowTs = Math.floor(Date.now() / 1000);

    // Determine which categories to clean
    const categoriesToClean = requestedCategories?.length
      ? requestedCategories.filter((cat) => RETENTION_CATEGORIES[cat])
      : Object.keys(RETENTION_CATEGORIES);

    if (categoriesToClean.length === 0) {
      return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
        variables: {
          field: 'categories',
          reason: 'No valid categories specified',
        },
      });
    }

    // Generate run ID
    const runId = crypto.randomUUID();

    // Get tenant retention settings
    const tenantSettings = await adapter.queryOne<{ settings: string | null }>(
      'SELECT settings FROM tenants WHERE id = ?',
      [tenantId]
    );

    const settings = tenantSettings?.settings
      ? (JSON.parse(tenantSettings.settings) as Record<string, unknown>)
      : {};
    const retentionConfig = (settings.data_retention as Record<string, unknown>) || {};
    const categorySettings =
      (retentionConfig.categories as Record<string, { retention_days: number }>) || {};

    // Execute cleanup
    const recordsDeleted: Record<string, number> = {};
    let hasError = false;
    let errorMessage: string | null = null;

    for (const category of categoriesToClean) {
      const config = RETENTION_CATEGORIES[category];
      const retentionDays = categorySettings[category]?.retention_days || config.defaultDays;
      const cutoffTs = nowTs - retentionDays * 24 * 60 * 60;

      try {
        const result = await adapter.execute(
          `DELETE FROM ${config.tableName} WHERE tenant_id = ? AND ${config.dateColumn} < ?`,
          [tenantId, cutoffTs]
        );
        recordsDeleted[category] = result.rowsAffected || 0;
      } catch (error) {
        // Log error but continue with other categories
        const log = getLogger(c).module('DATA-RETENTION');
        log.warn('Cleanup failed for category', { category, error: (error as Error).message });
        recordsDeleted[category] = 0;
        if (!hasError) {
          hasError = true;
          errorMessage = `Failed to cleanup ${category}: ${(error as Error).message}`;
        }
      }
    }

    const totalDeleted = Object.values(recordsDeleted).reduce((sum, count) => sum + count, 0);

    // Update last cleanup timestamp
    const dataRetention = (settings.data_retention || {}) as Record<string, unknown>;
    dataRetention.last_cleanup_at = nowTs;
    settings.data_retention = dataRetention;

    await adapter.execute('UPDATE tenants SET settings = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(settings),
      nowTs,
      tenantId,
    ]);

    // Audit log
    await createAuditLogFromContext(c, 'data_retention.cleanup_executed', 'data_retention', runId, {
      run_id: runId,
      categories: categoriesToClean,
      records_deleted: recordsDeleted,
      total_deleted: totalDeleted,
      idempotency_key,
      tenant_id: tenantId,
    });

    const log = getLogger(c).module('DATA-RETENTION');
    log.info('Data retention cleanup completed', {
      run_id: runId,
      total_deleted: totalDeleted,
      has_error: hasError,
    });

    const response: CleanupRun = {
      id: runId,
      tenant_id: tenantId,
      status: hasError ? 'partial_success' : 'completed',
      categories: categoriesToClean,
      records_deleted: recordsDeleted,
      started_at: toISOString(nowTs),
      completed_at: toISOString(nowTs),
      error_message: errorMessage,
      created_at: toISOString(nowTs) || new Date().toISOString(),
    };

    return c.json(response);
  } catch (error) {
    const log = getLogger(c).module('DATA-RETENTION');
    log.error('Failed to run data retention cleanup', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * GET /api/admin/data-retention/cleanup/:runId
 * Get status of a cleanup run
 *
 * Note: For synchronous cleanup (current implementation), this just returns
 * the run ID validation. For async implementation, would query a jobs table.
 */
export async function getCleanupRunStatus(c: Context<{ Bindings: Env }>) {
  const runId = c.req.param('runId');

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(runId)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'runId', reason: 'Invalid run ID format' },
    });
  }

  // In current synchronous implementation, cleanup runs complete immediately
  // For async implementation, would query from a jobs table
  return c.json({
    id: runId,
    status: 'completed',
    message: 'Cleanup runs execute synchronously in current implementation',
  });
}

/**
 * GET /api/admin/data-retention/categories
 * List all available retention categories with their current settings
 */
export async function listRetentionCategories(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);

  try {
    const adapter = createAdapter(c);

    // Get tenant settings
    const tenantSettings = await adapter.queryOne<{ settings: string | null }>(
      'SELECT settings FROM tenants WHERE id = ?',
      [tenantId]
    );

    const settings = tenantSettings?.settings
      ? (JSON.parse(tenantSettings.settings) as Record<string, unknown>)
      : {};
    const retentionConfig = (settings.data_retention as Record<string, unknown>) || {};
    const categorySettings =
      (retentionConfig.categories as Record<
        string,
        { retention_days: number; updated_at: number }
      >) || {};

    const categories: CategoryConfig[] = Object.entries(RETENTION_CATEGORIES).map(
      ([category, config]) => ({
        category,
        retention_days: categorySettings[category]?.retention_days || config.defaultDays,
        updated_at: toISOString(categorySettings[category]?.updated_at ?? null) || 'default',
      })
    );

    return c.json({ categories });
  } catch (error) {
    const log = getLogger(c).module('DATA-RETENTION');
    log.error('Failed to list retention categories', {}, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

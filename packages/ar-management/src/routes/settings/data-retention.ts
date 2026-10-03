/**
 * Data Retention API: how long each kind of data is kept for the tenant.
 *
 * - GET /api/admin/data-retention/status       - Every category with record counts
 * - GET /api/admin/data-retention/categories   - Every category (no counts)
 * - GET /api/admin/data-retention/estimate     - Records past their retention, per category
 * - PUT /api/admin/data-retention/categories/lookup_directory - The lookup directory's retention
 *
 * Retention is decided where each kind of data lives (see compliance/retention-inventory.ts):
 * this API reports it and changes only the lookup directory policy, which has no other home.
 * Every other category answers where it is changed instead. Deletion is done by the scheduled
 * retention tasks and by expiry, not on request.
 *
 * Security: tenant_admin or higher; every query is scoped to the tenant; changes are audited.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import {
  createAuditLogFromContext,
  createAuthContextFromHono,
  createErrorResponse,
  ensureDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  AR_ERROR_CODES,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { getAdminAuth } from '../../admin-tenant-access';
import {
  buildRetentionInventory,
  RETENTION_CATEGORY_IDS,
  type RetentionCategory,
  type RetentionCategoryId,
} from '../../compliance/retention-inventory';
import { settingsUnavailableResponse } from './settings-unavailable';

const LOOKUP_RETENTION_MIN_DAYS = 30;
const LOOKUP_RETENTION_MAX_DAYS = 3650;

function coreAdapterFor(c: Context<{ Bindings: Env }>, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

async function piiAdaptersFor(
  c: Context<{ Bindings: Env }>,
  tenantId: string
): Promise<DatabaseAdapter[]> {
  const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(c.env, {
    tenantId,
    role: 'tenant_pii',
    dataRole: 'tenant_pii',
    maxStores: 32,
    concurrency: 4,
  });
  return stores.map((store, index) =>
    ensureDatabaseAdapter(store.source, `data-retention-pii:${index}`)
  );
}

/** The inventory, or null after logging when something it needs cannot be read. */
async function readInventory(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  withCounts: boolean
): Promise<RetentionCategory[] | null> {
  try {
    return await buildRetentionInventory({
      env: c.env,
      tenantId,
      coreAdapter: coreAdapterFor(c, tenantId),
      piiAdapters: withCounts ? await piiAdaptersFor(c, tenantId) : [],
      withCounts,
    });
  } catch (error) {
    getLogger(c)
      .module('DATA-RETENTION')
      .warn('Retention inventory could not be read', { tenantId, error: String(error) });
    return null;
  }
}

export type RetentionAttentionReason =
  | 'task_disabled'
  | 'task_failed'
  | 'never_run'
  | 'tenant_run_failed'
  | 'deleted_outside_authrim'
  | 'not_deleted'
  | 'projection_pending'
  | 'no_absolute_limit'
  /** Audit logs copied to an archive stay there: Authrim deletes them from the primary only. */
  | 'archive_not_deleted';

/**
 * Categories whose data is not being removed as its retention says, and why. Tasks that clean
 * some tenants per run are judged by their run for this tenant (a run for others says nothing
 * about it).
 */
export function retentionAttention(
  categories: RetentionCategory[]
): Array<{ category: RetentionCategoryId; reason: RetentionAttentionReason }> {
  const attention: Array<{ category: RetentionCategoryId; reason: RetentionAttentionReason }> = [];
  for (const category of categories) {
    const deletion = category.deletion;
    if (deletion.kind === 'not_deleted') {
      attention.push({ category: category.id, reason: 'not_deleted' });
      if ('projection' in deletion && deletion.projection === 'pending') {
        attention.push({ category: category.id, reason: 'projection_pending' });
      }
      continue;
    }
    if (category.archive) {
      attention.push({ category: category.id, reason: 'archive_not_deleted' });
    }
    if (category.extension && category.extension.absolute_limit_seconds === null) {
      attention.push({ category: category.id, reason: 'no_absolute_limit' });
    }
    if (deletion.kind !== 'scheduled_task') continue;
    const perTenant = TENANT_RECORDED_TASKS.has(deletion.task);
    const run = deletion.tenant_last_run;
    const reason: RetentionAttentionReason | null = !deletion.enabled
      ? 'task_disabled'
      : perTenant
        ? !run
          ? 'never_run'
          : run.outcome === 'archive_only'
            ? 'deleted_outside_authrim'
            : run.outcome !== 'cleaned'
              ? 'tenant_run_failed'
              : null
        : deletion.status === 'failed'
          ? 'task_failed'
          : deletion.last_completed_at === null
            ? 'never_run'
            : null;
    if (reason) attention.push({ category: category.id, reason });
  }
  return attention;
}

/** Retention tasks that record their run per tenant. */
const TENANT_RECORDED_TASKS: ReadonlySet<string> = new Set([
  'audit_retention',
  'check_api_audit_retention',
  'user_tombstone_retention',
  'r2_diagnostic_log_retention',
  'compliance_report_retention',
]);

/** GET /api/admin/data-retention/status */
export async function getDataRetentionStatus(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const categories = await readInventory(c, tenantId, true);
  if (!categories) return settingsUnavailableResponse(c);
  return c.json({
    tenant_id: tenantId,
    categories,
    summary: {
      expired_records: categories.reduce(
        (sum, category) => sum + (category.counts?.expired ?? 0),
        0
      ),
      attention: retentionAttention(categories),
    },
    generated_at: new Date().toISOString(),
  });
}

/** GET /api/admin/data-retention/categories */
export async function listRetentionCategories(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const categories = await readInventory(c, tenantId, false);
  if (!categories) return settingsUnavailableResponse(c);
  return c.json({ tenant_id: tenantId, categories });
}

/** GET /api/admin/data-retention/estimate?category= */
export async function getDataRetentionEstimate(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const filter = c.req.query('category');
  if (filter !== undefined && !RETENTION_CATEGORY_IDS.includes(filter as RetentionCategoryId)) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'category', reason: 'Unknown retention category' },
    });
  }
  const categories = await readInventory(c, tenantId, true);
  if (!categories) return settingsUnavailableResponse(c);
  return c.json({
    tenant_id: tenantId,
    estimates: categories
      .filter((category) => filter === undefined || category.id === filter)
      .map((category) => ({
        category: category.id,
        retention: category.retention,
        // Null when the records cannot be counted here (they expire or are not stored).
        records: category.counts?.total ?? null,
        records_past_retention: category.counts?.expired ?? null,
      })),
  });
}

const UpdateLookupRetentionSchema = z.object({
  retention_days: z.number().int().min(LOOKUP_RETENTION_MIN_DAYS).max(LOOKUP_RETENTION_MAX_DAYS),
  confirm_shortening: z.boolean().optional(),
  expected_current_retention_days: z
    .number()
    .int()
    .min(LOOKUP_RETENTION_MIN_DAYS)
    .max(LOOKUP_RETENTION_MAX_DAYS)
    .optional(),
});

async function attemptLookupRetentionPolicyProjection(
  c: Context<{ Bindings: Env }>,
  adapter: DatabaseAdapter,
  operationId: string
): Promise<void> {
  const control = c.env.CONTROL;
  if (!control?.applyLookupRetentionPolicyProjection) return;
  const row = await adapter.queryOne<{
    tenant_id: string;
    policy_generation: number | string;
    retention_days: number | string;
    updated_at: number | string;
  }>(
    `SELECT tenant_id, policy_generation, retention_days, updated_at
       FROM lookup_retention_policy_projection_outbox
      WHERE operation_id = ? AND status <> 'succeeded'`,
    [operationId],
    { consistencyClass: 'primary_required' }
  );
  if (!row) return;
  const policyGeneration = Number(row.policy_generation);
  const retentionDays = Number(row.retention_days);
  const sourceUpdatedAt = Number(row.updated_at);
  if (
    !Number.isSafeInteger(policyGeneration) ||
    policyGeneration < 1 ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < LOOKUP_RETENTION_MIN_DAYS ||
    retentionDays > LOOKUP_RETENTION_MAX_DAYS ||
    !Number.isSafeInteger(sourceUpdatedAt) ||
    sourceUpdatedAt < 1
  ) {
    throw new Error('lookup_retention_policy_projection_outbox_invalid');
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    await control.applyLookupRetentionPolicyProjection({
      tenantId: row.tenant_id,
      policyGeneration,
      retentionDays,
      sourceOperationId: operationId,
      sourceUpdatedAt,
    });
    await adapter.execute(
      `UPDATE lookup_retention_policy_projection_outbox
          SET status = 'succeeded', completed_at = ?, updated_at = ?,
              lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
        WHERE operation_id = ? AND status <> 'succeeded'`,
      [now, now, operationId]
    );
  } catch {
    await adapter.execute(
      `UPDATE lookup_retention_policy_projection_outbox
          SET status = 'pending', attempt_count = attempt_count + 1,
              next_attempt_at = ?, updated_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = 'control_projection_failed'
        WHERE operation_id = ? AND status <> 'succeeded'`,
      [now + 60, now, operationId]
    );
  }
}

/**
 * PUT /api/admin/data-retention/categories/:category
 *
 * Only the lookup directory's retention is set here. Shortening it needs the current value
 * (from a fresh read) and an explicit confirmation, since records past the new retention go.
 */
export async function updateCategoryRetention(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const category = c.req.param('category');

  if (category !== 'lookup_directory') {
    const categories = RETENTION_CATEGORY_IDS.includes(category as RetentionCategoryId)
      ? await readInventory(c, tenantId, false)
      : null;
    const edit = categories?.find((entry) => entry.id === category)?.edit ?? null;
    return c.json(
      {
        error: 'retention_not_set_here',
        error_description:
          'Only the lookup directory retention is set through this API; the others are set where they are kept',
        category,
        edit,
      },
      400
    );
  }

  const body: unknown = await c.req.json().catch(() => null);
  const validation = UpdateLookupRetentionSchema.safeParse(body);
  if (!validation.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: validation.error.issues[0]?.path.join('.') || 'retention_days',
        reason: validation.error.issues[0]?.message || 'Invalid value',
      },
    });
  }
  const { retention_days, confirm_shortening, expected_current_retention_days } = validation.data;

  const adminAuth = getAdminAuth(c);
  const updatedBy = adminAuth?.actorId ?? adminAuth?.userId;
  if (!updatedBy) {
    return c.json({ error: 'access_denied' }, 403);
  }

  try {
    const adapter = coreAdapterFor(c, tenantId);
    const current = await adapter.queryOne<{ retention_days: number | string }>(
      'SELECT retention_days FROM lookup_retention_policies WHERE tenant_id = ?',
      [tenantId],
      { consistencyClass: 'primary_required' }
    );
    const currentRetentionDays = current ? Number(current.retention_days) : 180;
    if (retention_days < currentRetentionDays) {
      if (confirm_shortening !== true || expected_current_retention_days !== currentRetentionDays) {
        return c.json(
          {
            error: 'retention_shortening_confirmation_required',
            error_description:
              'Shortening retention requires a fresh estimate and explicit confirmation',
            category,
            current_retention_days: currentRetentionDays,
            requested_retention_days: retention_days,
          },
          409
        );
      }
    }

    const nowTs = Math.floor(Date.now() / 1000);
    const projectionOperationId = `lookup-retention-policy:${crypto.randomUUID()}`;
    const results = await adapter.batch([
      {
        sql: `INSERT INTO lookup_retention_policies (
                tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
              ) VALUES (?, ?, 1, ?, ?, ?)
              ON CONFLICT (tenant_id) DO UPDATE SET
                retention_days = excluded.retention_days,
                policy_generation = lookup_retention_policies.policy_generation + 1,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at`,
        params: [tenantId, retention_days, updatedBy, nowTs, nowTs],
      },
      {
        sql: `INSERT INTO lookup_retention_policy_projection_outbox (
                operation_id, tenant_id, policy_generation, retention_days,
                next_attempt_at, created_at, updated_at
              )
              SELECT ?, tenant_id, policy_generation, retention_days, ?, ?, ?
                FROM lookup_retention_policies WHERE tenant_id = ?`,
        params: [projectionOperationId, nowTs, nowTs, nowTs, tenantId],
      },
      {
        sql: `INSERT INTO settings_history (
                id, tenant_id, category, version, snapshot, changes,
                actor_id, actor_type, change_reason, change_source, created_at
              )
              SELECT ?, ?, 'data_retention', COALESCE(MAX(version), 0) + 1, ?, ?,
                     ?, 'admin', 'retention_policy_update', 'admin_api', ?
                FROM settings_history
               WHERE tenant_id = ? AND category = 'data_retention'`,
        params: [
          `data-retention-history:${crypto.randomUUID()}`,
          tenantId,
          JSON.stringify({ lookup_directory: { retention_days } }),
          JSON.stringify({
            added: [],
            removed: [],
            modified: [
              {
                key: 'lookup_directory.retention_days',
                oldValue: currentRetentionDays,
                newValue: retention_days,
              },
            ],
          }),
          updatedBy,
          nowTs,
          tenantId,
        ],
      },
    ]);
    if (results.length !== 3 || results.some((result) => result.rowsAffected !== 1)) {
      throw new Error('lookup_retention_policy_projection_write_failed');
    }
    await attemptLookupRetentionPolicyProjection(c, adapter, projectionOperationId);

    await createAuditLogFromContext(
      c,
      'data_retention.category_updated',
      'data_retention',
      category,
      {
        category,
        retention_days,
        previous_retention_days: currentRetentionDays,
        shortened: retention_days < currentRetentionDays,
        tenant_id: tenantId,
      }
    );

    return c.json({
      category,
      retention_days,
      updated_at: new Date(nowTs * 1000).toISOString(),
    });
  } catch (error) {
    getLogger(c)
      .module('DATA-RETENTION')
      .error('Failed to update category retention', { category }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
}

/**
 * Retention tasks on the maintenance schedule: delete what is past its retention, and record
 * per tenant when that last happened (each run covers one page of tenants, so a task's own
 * last run does not say when a given tenant was last cleaned).
 *
 * - audit_retention: audit event and PII logs, by each entry's retention_until (audit profile).
 * - check_api_audit_retention: Check API decisions older than audit.check_api_retention_days.
 * - user_tombstone_retention: deleted users' PII tombstones past their retention_until.
 * - compliance_report_retention: compliance reports past their download period (their file is
 *   tombstoned in the admin catalog, which the artifact cleanup deletes).
 */
import {
  ensureDatabaseAdapter,
  resolvePlatformSettingsWithSources,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  type DatabaseAdapter,
  type Env,
  type Logger,
} from '@authrim/ar-lib-core';
import { cleanupResolvedAuditPrimaries } from './audit-maintenance';
import { removeReportFile } from './compliance/reports';
import { runTrackedMaintenanceTask } from './r2-storage-maintenance';
import { recordTenantRun, type TenantRetentionRun } from './retention-tenant-runs';

export interface RetentionMaintenanceTarget {
  tenantId: string;
  /** The tenant's core stores (Check API decisions live there). */
  adapters: Array<{ adapter: DatabaseAdapter; bindingRef: string }>;
}

/** Rows one statement deletes, and statements per store per run; the rest waits for the next run. */
const DELETE_BATCH_SIZE = 1000;
const DELETE_BATCHES_PER_STORE = 10;

/** Deletes up to DELETE_BATCHES_PER_STORE batches of the rows `select` finds. */
async function deleteInBatches(
  adapter: DatabaseAdapter,
  table: string,
  where: string,
  params: unknown[]
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < DELETE_BATCHES_PER_STORE; batch += 1) {
    const result = await adapter.execute(
      `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${where} LIMIT ?)`,
      [...params, DELETE_BATCH_SIZE]
    );
    const affected = result.rowsAffected || 0;
    deleted += affected;
    if (affected < DELETE_BATCH_SIZE) break;
  }
  return deleted;
}

async function auditRetention(
  env: Env,
  targets: RetentionMaintenanceTarget[],
  log: Logger
): Promise<Record<string, unknown>> {
  const { tenantOutcomes, ...summary } = await cleanupResolvedAuditPrimaries(env, {
    tenantIds: targets.map((target) => target.tenantId),
    logger: log,
  });
  const at = Date.now();
  for (const target of targets) {
    await recordTenantRun(
      env,
      target.tenantId,
      'audit_retention',
      {
        at,
        outcome: Object.hasOwn(tenantOutcomes, target.tenantId)
          ? tenantOutcomes[target.tenantId]!
          : 'not_supported',
      },
      log
    );
  }
  if (summary.failedTenants > 0) throw new Error('audit_retention_partial_failure');
  return { ...summary };
}

async function checkApiAuditRetention(
  env: Env,
  targets: RetentionMaintenanceTarget[],
  log: Logger
): Promise<Record<string, unknown>> {
  // The retention is platform-wide; if it cannot be read nothing is deleted this run. Without
  // the settings store the read would give the built-in default, not the platform's value.
  if (!env.SETTINGS) throw new Error('check_api_audit_retention_settings_unavailable');
  const { values } = await resolvePlatformSettingsWithSources(env, 'check-api-audit');
  const days = values['audit.check_api_retention_days'];
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1) {
    throw new Error('check_api_audit_retention_invalid');
  }
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  let deleted = 0;
  let failedTenants = 0;
  for (const target of targets) {
    let outcome: TenantRetentionRun['outcome'] = 'cleaned';
    for (const { adapter, bindingRef } of target.adapters) {
      try {
        deleted += await deleteInBatches(
          adapter,
          'permission_check_audit',
          'tenant_id = ? AND checked_at < ?',
          [target.tenantId, cutoff]
        );
      } catch (error) {
        outcome = 'failed';
        log.warn('Check API audit retention failed for a store', {
          tenantId: target.tenantId,
          bindingRef,
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
      }
    }
    if (outcome === 'failed') failedTenants += 1;
    await recordTenantRun(
      env,
      target.tenantId,
      'check_api_audit_retention',
      {
        at: Date.now(),
        outcome,
      },
      log
    );
  }
  if (failedTenants > 0) throw new Error('check_api_audit_retention_partial_failure');
  return { retentionDays: days, deleted, tenantCount: targets.length };
}

async function userTombstoneRetention(
  env: Env,
  targets: RetentionMaintenanceTarget[],
  log: Logger
): Promise<Record<string, unknown>> {
  const now = Date.now();
  let deleted = 0;
  let failedTenants = 0;
  for (const target of targets) {
    let outcome: TenantRetentionRun['outcome'] = 'cleaned';
    let stores: Awaited<ReturnType<typeof resolveTenantAssignedDatabaseSourcesFromRegistry>> = [];
    try {
      stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
        tenantId: target.tenantId,
        role: 'tenant_pii',
        dataRole: 'tenant_pii',
        maxStores: 32,
        concurrency: 4,
      });
    } catch (error) {
      outcome = 'failed';
      log.warn('Deleted user tombstone stores could not be resolved', {
        tenantId: target.tenantId,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    }
    // Each store on its own: one failing does not keep the others' tombstones.
    for (const store of stores) {
      try {
        deleted += await deleteInBatches(
          ensureDatabaseAdapter(store.source, `tombstone-retention:${store.bindingRef}`),
          'users_pii_tombstone',
          'tenant_id = ? AND retention_until < ?',
          [target.tenantId, now]
        );
      } catch (error) {
        outcome = 'failed';
        log.warn('Deleted user tombstone retention failed for a store', {
          tenantId: target.tenantId,
          bindingRef: store.bindingRef,
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
      }
    }
    if (outcome === 'failed') failedTenants += 1;
    await recordTenantRun(
      env,
      target.tenantId,
      'user_tombstone_retention',
      {
        at: Date.now(),
        outcome,
      },
      log
    );
  }
  if (failedTenants > 0) throw new Error('user_tombstone_retention_partial_failure');
  return { deleted, tenantCount: targets.length };
}

/** Reports one run marks expired per store; the rest waits for the next run. */
const REPORT_EXPIRY_BATCH = 100;

async function complianceReportRetention(
  env: Env,
  targets: RetentionMaintenanceTarget[],
  log: Logger
): Promise<Record<string, unknown>> {
  if (!env.DB_ADMIN) throw new Error('compliance_report_retention_admin_database_unavailable');
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'compliance-report-retention');
  let expired = 0;
  let failedTenants = 0;
  for (const target of targets) {
    let outcome: TenantRetentionRun['outcome'] = 'cleaned';
    // Reports live in the tenant's default store; the others hold none.
    for (const { adapter, bindingRef } of target.adapters) {
      try {
        // Past their time with a file: completed ones past their download period, and the file
        // of one that never completed (generating, or failed and not removed then).
        const rows = await adapter.query<{
          id: string;
          object_catalog_id: string | null;
          object_key_base: string | null;
        }>(
          `SELECT id, object_catalog_id, object_key_base FROM compliance_reports
            WHERE tenant_id = ? AND status IN ('completed', 'generating', 'failed')
              AND expires_at IS NOT NULL AND expires_at <= ?
              AND (object_catalog_id IS NOT NULL OR object_key_base IS NOT NULL)
            LIMIT ?`,
          [target.tenantId, new Date().toISOString(), REPORT_EXPIRY_BATCH]
        );
        for (const row of rows) {
          // The file first: a report shown expired has no file left to download.
          await removeReportFile(
            env,
            admin,
            target.tenantId,
            row.object_key_base,
            row.object_catalog_id
          );
          await adapter.execute(
            `UPDATE compliance_reports
                SET status = CASE WHEN status = 'failed' THEN 'failed' ELSE 'expired' END,
                    object_catalog_id = NULL, object_key_base = NULL
              WHERE tenant_id = ? AND id = ?`,
            [target.tenantId, row.id]
          );
          expired += 1;
        }
      } catch (error) {
        outcome = 'failed';
        log.warn('Compliance report retention failed for a store', {
          tenantId: target.tenantId,
          bindingRef,
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
      }
    }
    if (outcome === 'failed') failedTenants += 1;
    await recordTenantRun(
      env,
      target.tenantId,
      'compliance_report_retention',
      { at: Date.now(), outcome },
      log
    );
  }
  if (failedTenants > 0) throw new Error('compliance_report_retention_partial_failure');
  return { expired, tenantCount: targets.length };
}

/** Runs the retention tasks for one page of maintenance tenants. */
export async function runRetentionMaintenance(
  env: Env,
  targets: RetentionMaintenanceTarget[],
  log: Logger
): Promise<void> {
  await runTrackedMaintenanceTask(
    env,
    'audit_retention',
    () => auditRetention(env, targets, log),
    log
  );
  await runTrackedMaintenanceTask(
    env,
    'check_api_audit_retention',
    () => checkApiAuditRetention(env, targets, log),
    log
  );
  await runTrackedMaintenanceTask(
    env,
    'user_tombstone_retention',
    () => userTombstoneRetention(env, targets, log),
    log
  );
  await runTrackedMaintenanceTask(
    env,
    'compliance_report_retention',
    () => complianceReportRetention(env, targets, log),
    log
  );
}

import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  ensureDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';
import { TENANT_TABLES_TO_DELETE } from './admin-tenants';

interface TenantDeletionJobLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
}

interface TenantDeletionJobRow {
  id: string;
  tenant_id: string;
  config: string;
}

interface TenantDeletionJobConfig {
  tenant_id: string;
  backup_policy?: 'deletion_before_purge' | 'manual' | 'scheduled_periodic' | 'none';
  backup_job_id?: string;
  skip_backup?: boolean;
}

const TENANT_CONTROL_TABLES_TO_DELETE = [
  'internal_notification_events',
  'tenant_database_migration_state',
  'tenant_database_migration_job_targets',
  'tenant_database_migration_jobs',
  'tenant_database_stats',
  'tenant_discovery_indexes',
  'tenant_runtime_cache_generations',
  'tenant_runtime_registry_snapshots',
] as const;

function buildTenantDatabaseLifecycleMetadata(
  jobId: string,
  status: 'deleting' | 'deleted'
): string {
  return JSON.stringify({
    lifecycle_job_id: jobId,
    lifecycle_status: status,
    updated_at: new Date().toISOString(),
  });
}

function parseTenantDeletionJobConfig(config: string): TenantDeletionJobConfig {
  const parsed = JSON.parse(config) as Partial<TenantDeletionJobConfig>;
  if (!parsed.tenant_id || typeof parsed.tenant_id !== 'string') {
    throw new Error('Tenant deletion job config requires tenant_id');
  }
  return {
    tenant_id: parsed.tenant_id,
    backup_policy:
      parsed.backup_policy === 'manual' ||
      parsed.backup_policy === 'scheduled_periodic' ||
      parsed.backup_policy === 'none'
        ? parsed.backup_policy
        : 'deletion_before_purge',
    backup_job_id: typeof parsed.backup_job_id === 'string' ? parsed.backup_job_id : undefined,
    skip_backup: parsed.skip_backup === true,
  };
}

async function ensureDeletionBackupCompleted(
  adapter: Pick<DatabaseAdapter, 'execute' | 'queryOne'>,
  job: TenantDeletionJobRow,
  config: TenantDeletionJobConfig
): Promise<{ completed: boolean; backupJobId: string | null }> {
  if (config.skip_backup || config.backup_policy === 'none') {
    return { completed: true, backupJobId: null };
  }

  const nowTs = Math.floor(Date.now() / 1000);
  if (!config.backup_job_id) {
    const backupJobId = crypto.randomUUID();
    const nextConfig = { ...config, backup_job_id: backupJobId };
    await adapter.execute(
      `INSERT INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        backupJobId,
        config.tenant_id,
        'tenant-database/export',
        JSON.stringify({ stage: 'pending', policy: 'deletion_before_purge' }),
        JSON.stringify({
          policy: 'deletion_before_purge',
          consistency: 'maintenance_read_only',
          reason: `pre-purge backup for tenant deletion job ${job.id}`,
        }),
        job.id,
        nowTs,
        nowTs,
      ]
    );
    await adapter.execute(
      "UPDATE admin_jobs SET status = 'pending', progress = ?, config = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      [
        JSON.stringify({ stage: 'backup_requested', backup_job_id: backupJobId }),
        JSON.stringify(nextConfig),
        nowTs,
        job.id,
        job.tenant_id,
      ]
    );
    return { completed: false, backupJobId };
  }

  const backup = await adapter.queryOne<{ status: string }>(
    'SELECT status FROM admin_jobs WHERE id = ? AND tenant_id = ?',
    [config.backup_job_id, config.tenant_id]
  );
  if (!backup) {
    throw new Error(`tenant_deletion_backup_job_missing:${config.backup_job_id}`);
  }
  if (backup.status === 'completed') {
    return { completed: true, backupJobId: config.backup_job_id };
  }
  if (backup.status === 'failed' || backup.status === 'partial_failure') {
    throw new Error(`tenant_deletion_backup_job_failed:${config.backup_job_id}`);
  }

  await adapter.execute(
    "UPDATE admin_jobs SET status = 'pending', progress = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
    [
      JSON.stringify({
        stage: 'backup_waiting',
        backup_job_id: config.backup_job_id,
        backup_status: backup.status,
      }),
      nowTs,
      job.id,
      job.tenant_id,
    ]
  );
  return { completed: false, backupJobId: config.backup_job_id };
}

async function updateTenantDatabaseLifecycleState(
  adapter: Pick<DatabaseAdapter, 'execute'> | null,
  targetTenantId: string,
  currentJobId: string,
  status: 'deleting' | 'deleted'
): Promise<void> {
  if (!adapter) return;

  const now = new Date().toISOString();
  const metadata = buildTenantDatabaseLifecycleMetadata(currentJobId, status);

  await adapter.execute(
    `UPDATE tenant_database_registry
        SET status = ?, updated_at = ?, updated_by = ?, metadata_json = ?
      WHERE tenant_id = ? AND status <> 'deleted'`,
    [status, now, currentJobId, metadata, targetTenantId]
  );

  await adapter.execute(
    `UPDATE tenant_database_active_pointers
        SET status = 'disabled',
            runtime_generation = runtime_generation + 1,
            updated_at = ?,
            updated_by = ?,
            metadata_json = ?
      WHERE tenant_id = ?`,
    [now, currentJobId, metadata, targetTenantId]
  );
}

async function deleteTenantControlRows(
  tx: Pick<DatabaseAdapter, 'execute'>,
  targetTenantId: string
): Promise<void> {
  for (const table of TENANT_CONTROL_TABLES_TO_DELETE) {
    await tx.execute(`DELETE FROM ${table} WHERE tenant_id = ?`, [targetTenantId]);
  }
}

async function deleteTenantRows(
  tx: Pick<DatabaseAdapter, 'execute'>,
  targetTenantId: string,
  currentJobId: string,
  preserveJobIds: string[] = []
): Promise<void> {
  const preservedJobIds = Array.from(new Set([currentJobId, ...preserveJobIds]));
  for (const table of TENANT_TABLES_TO_DELETE) {
    if (table === 'admin_jobs') {
      const placeholders = preservedJobIds.map(() => '?').join(', ');
      await tx.execute(
        `DELETE FROM admin_jobs WHERE tenant_id = ? AND id NOT IN (${placeholders})`,
        [targetTenantId, ...preservedJobIds]
      );
      continue;
    }
    await tx.execute(`DELETE FROM ${table} WHERE tenant_id = ?`, [targetTenantId]);
  }
  await tx.execute('DELETE FROM tenants WHERE id = ?', [targetTenantId]);
}

export async function processPendingTenantDeletionJobs(
  env: Env,
  log: TenantDeletionJobLogger
): Promise<void> {
  const coreAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'management-scheduled-jobs'
  );
  const controlAdapter = env.DB_ADMIN
    ? ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-deletion-control')
    : null;
  const pendingJobs = await coreAdapter.query<TenantDeletionJobRow>(
    "SELECT id, tenant_id, config FROM admin_jobs WHERE job_type = 'tenants/delete' AND status = 'pending' LIMIT 5"
  );

  let claimedCount = 0;
  for (const job of pendingJobs) {
    const jobTenantId = job.tenant_id;
    const nowTs = Math.floor(Date.now() / 1000);
    const claim = await coreAdapter.execute(
      "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      [nowTs, nowTs, job.id, jobTenantId]
    );
    if (claim.rowsAffected === 0) continue;
    claimedCount += 1;

    try {
      const config = parseTenantDeletionJobConfig(job.config);
      const { tenant_id: targetTenantId } = config;

      const backup = await ensureDeletionBackupCompleted(coreAdapter, job, config);
      if (!backup.completed) {
        log.info('Tenant deletion job waiting for pre-purge backup', {
          job_id: job.id,
          tenant_id: targetTenantId,
          backup_job_id: backup.backupJobId,
        });
        continue;
      }

      await updateTenantDatabaseLifecycleState(controlAdapter, targetTenantId, job.id, 'deleting');

      await coreAdapter.transaction(async (tx) => {
        await deleteTenantRows(
          tx,
          targetTenantId,
          job.id,
          backup.backupJobId ? [backup.backupJobId] : []
        );
      });
      if (controlAdapter) {
        await controlAdapter.transaction(async (tx) => {
          await deleteTenantControlRows(tx, targetTenantId);
        });
      }

      await updateTenantDatabaseLifecycleState(controlAdapter, targetTenantId, job.id, 'deleted');

      const completedTs = Math.floor(Date.now() / 1000);
      await coreAdapter.execute(
        "UPDATE admin_jobs SET status = 'completed', completed_at = ?, updated_at = ?, progress = ? WHERE id = ? AND tenant_id = ?",
        [completedTs, completedTs, JSON.stringify({ stage: 'completed' }), job.id, jobTenantId]
      );

      log.info('Tenant deletion job completed', { job_id: job.id, tenant_id: targetTenantId });
    } catch (jobError) {
      const failedTs = Math.floor(Date.now() / 1000);
      await coreAdapter.execute(
        "UPDATE admin_jobs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
        [String(jobError), failedTs, failedTs, job.id, jobTenantId]
      );

      log.error('Tenant deletion job failed', { job_id: job.id }, jobError as Error);
    }
  }

  if (pendingJobs.length > 0) {
    log.info('Tenant deletion jobs processed', {
      selected_count: pendingJobs.length,
      claimed_count: claimedCount,
    });
  }
}

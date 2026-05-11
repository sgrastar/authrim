import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { resolveAuthCorePersistenceAdapterFromEnv } from '@authrim/ar-lib-core';
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
}

function parseTenantDeletionJobConfig(config: string): TenantDeletionJobConfig {
  const parsed = JSON.parse(config) as Partial<TenantDeletionJobConfig>;
  if (!parsed.tenant_id || typeof parsed.tenant_id !== 'string') {
    throw new Error('Tenant deletion job config requires tenant_id');
  }
  return { tenant_id: parsed.tenant_id };
}

async function deleteTenantRows(
  tx: Pick<DatabaseAdapter, 'execute'>,
  targetTenantId: string,
  currentJobId: string
): Promise<void> {
  for (const table of TENANT_TABLES_TO_DELETE) {
    if (table === 'admin_jobs') {
      await tx.execute('DELETE FROM admin_jobs WHERE tenant_id = ? AND id <> ?', [
        targetTenantId,
        currentJobId,
      ]);
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
  const pendingJobs = await coreAdapter.query<TenantDeletionJobRow>(
    "SELECT id, tenant_id, config FROM admin_jobs WHERE job_type = 'tenants/delete' AND status = 'pending' LIMIT 5"
  );

  for (const job of pendingJobs) {
    const jobTenantId = job.tenant_id;
    const nowTs = Math.floor(Date.now() / 1000);
    await coreAdapter.execute(
      "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      [nowTs, nowTs, job.id, jobTenantId]
    );

    try {
      const { tenant_id: targetTenantId } = parseTenantDeletionJobConfig(job.config);

      await coreAdapter.transaction(async (tx) => {
        await deleteTenantRows(tx, targetTenantId, job.id);
      });

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
    log.info('Tenant deletion jobs processed', { count: pendingJobs.length });
  }
}

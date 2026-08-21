import type { ControlTenantDeletionInventory, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { ensureDatabaseAdapter, listEnvironmentTenantDefaultStores } from '@authrim/ar-lib-core';
import { purgeTenantAuthoritativeShards } from './tenant-deletion-authoritative-purge';
import { disableTenantLookupDirectory } from './tenant-deletion-lookup-cleanup';
import { publishTenantRuntimeRegistryRouteState } from './tenant-runtime-registry-route-state';
import { deleteTenantPublicAssets } from './r2-storage-maintenance';

interface TenantDeletionJobLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
}

interface TenantDeletionJobRow {
  id: string;
  tenant_id: string;
  config: string;
  attempt_count?: number | null;
  max_attempts?: number | null;
}

interface TenantDeletionJobConfig {
  tenant_id: string;
  backup_policy?: 'deletion_before_purge' | 'manual' | 'scheduled_periodic' | 'none';
  backup_job_id?: string;
  skip_backup?: boolean;
  quarantine_started_at?: number;
}

interface TenantDeletionBackupJobRow {
  status: string;
  job_type: string;
  created_by: string;
  config: string;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const TENANT_DELETION_QUARANTINE_DRAIN_SECONDS = 30 * 60;
const TENANT_DELETION_DEFAULT_MAX_ATTEMPTS = 3;
const TENANT_DELETION_RETRY_SECONDS = [15, 60] as const;
const NON_RETRYABLE_DELETION_ERRORS = new Set([
  'tenant_deletion_job_config_invalid',
  'tenant_deletion_backup_job_invalid',
  'tenant_deletion_backup_job_failed',
  'tenant_deletion_control_environment_invalid',
  'tenant_deletion_control_unavailable',
  'tenant_deletion_control_inventory_invalid',
  'tenant_deletion_control_finalization_invalid',
  'tenant_deletion_lookup_cleanup_unavailable',
  'tenant_deletion_lookup_shards_invalid',
  'tenant_deletion_lookup_registry_inventory_mismatch',
  'tenant_deletion_authoritative_purge_unavailable',
  'tenant_deletion_authoritative_registry_invalid',
  'tenant_deletion_authoritative_shards_invalid',
  'tenant_deletion_authoritative_registry_inventory_mismatch',
  'tenant_deletion_authoritative_foreign_key_cycle',
  'runtime_registry_route_state_transition_invalid',
  'runtime_registry_route_state_operation_conflict',
]);

const TENANT_ADMIN_TABLES_TO_DELETE = [
  'internal_notification_events',
  'tenant_database_migration_state',
  'tenant_database_stats',
  'tenant_discovery_indexes',
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
  if (config.length > 16_384) throw new Error('tenant_deletion_job_config_invalid');
  let parsed: Partial<TenantDeletionJobConfig>;
  try {
    parsed = JSON.parse(config) as Partial<TenantDeletionJobConfig>;
  } catch {
    throw new Error('tenant_deletion_job_config_invalid');
  }
  if (typeof parsed.tenant_id !== 'string' || !SAFE_ID.test(parsed.tenant_id)) {
    throw new Error('tenant_deletion_job_config_invalid');
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
    quarantine_started_at:
      typeof parsed.quarantine_started_at === 'number' &&
      Number.isSafeInteger(parsed.quarantine_started_at) &&
      parsed.quarantine_started_at > 0
        ? parsed.quarantine_started_at
        : undefined,
  };
}

async function waitForTenantDeletionQuarantineDrain(
  adapter: Pick<DatabaseAdapter, 'execute'>,
  job: TenantDeletionJobRow,
  config: TenantDeletionJobConfig,
  publishedAt: string
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const publishedAtSeconds = Math.floor(Date.parse(publishedAt) / 1000);
  if (!Number.isSafeInteger(publishedAtSeconds) || publishedAtSeconds < 1) {
    throw new Error('tenant_deletion_quarantine_publication_invalid');
  }
  const quarantineStartedAt = config.quarantine_started_at ?? publishedAtSeconds;
  const drainReadyAt = quarantineStartedAt + TENANT_DELETION_QUARANTINE_DRAIN_SECONDS;
  if (now >= drainReadyAt) return false;

  const nextConfig = { ...config, quarantine_started_at: quarantineStartedAt };
  await adapter.execute(
    "UPDATE admin_jobs SET status = 'pending', progress = ?, config = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
    [
      JSON.stringify({
        stage: 'quarantine_draining',
        quarantine_started_at: quarantineStartedAt,
        drain_ready_at: drainReadyAt,
      }),
      JSON.stringify(nextConfig),
      now,
      job.id,
      job.tenant_id,
    ]
  );
  return true;
}

function backupJobId(jobId: string): string {
  if (!SAFE_ID.test(jobId)) throw new Error('tenant_deletion_job_config_invalid');
  const id = `tenant-delete-backup:${jobId}`;
  if (!SAFE_ID.test(id)) throw new Error('tenant_deletion_job_config_invalid');
  return id;
}

function expectedBackupConfig(jobId: string): Record<string, string> {
  return {
    policy: 'deletion_before_purge',
    consistency: 'maintenance_read_only',
    reason: `pre-purge backup for tenant deletion job ${jobId}`,
  };
}

function validateBackupJob(row: TenantDeletionBackupJobRow | null, job: TenantDeletionJobRow) {
  if (!row || row.job_type !== 'tenant-database/export' || row.created_by !== job.id) {
    throw new Error('tenant_deletion_backup_job_invalid');
  }
  try {
    if (row.config.length > 16_384) throw new Error('tenant_deletion_backup_job_invalid');
    const config = JSON.parse(row.config) as unknown;
    const expected = expectedBackupConfig(job.id);
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      Object.keys(config).length !== 3 ||
      Object.keys(config).some((key) => !Object.hasOwn(expected, key)) ||
      (config as Record<string, unknown>).policy !== expected.policy ||
      (config as Record<string, unknown>).consistency !== expected.consistency ||
      (config as Record<string, unknown>).reason !== expected.reason
    ) {
      throw new Error('tenant_deletion_backup_job_invalid');
    }
  } catch {
    throw new Error('tenant_deletion_backup_job_invalid');
  }
  return row;
}

function safeDeletionErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return code.length <= 128 && /^tenant_deletion_[a-z0-9_]+$/u.test(code)
    ? code
    : 'tenant_deletion_step_failed';
}

function deletionAttemptCount(job: TenantDeletionJobRow): number {
  return Number.isSafeInteger(job.attempt_count) && Number(job.attempt_count) >= 0
    ? Number(job.attempt_count)
    : 0;
}

function deletionMaxAttempts(job: TenantDeletionJobRow): number {
  return Number.isSafeInteger(job.max_attempts) && Number(job.max_attempts) >= 1
    ? Math.min(Number(job.max_attempts), 10)
    : TENANT_DELETION_DEFAULT_MAX_ATTEMPTS;
}

function shouldRetryTenantDeletion(error: unknown): boolean {
  const code = error instanceof Error ? error.message : '';
  return !NON_RETRYABLE_DELETION_ERRORS.has(code);
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
  const expectedJobId = backupJobId(job.id);
  if (config.backup_job_id && config.backup_job_id !== expectedJobId) {
    throw new Error('tenant_deletion_backup_job_invalid');
  }
  if (!config.backup_job_id) {
    const nextConfig = { ...config, backup_job_id: expectedJobId };
    await adapter.execute(
      `INSERT OR IGNORE INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        expectedJobId,
        config.tenant_id,
        'tenant-database/export',
        JSON.stringify({ stage: 'pending', policy: 'deletion_before_purge' }),
        JSON.stringify(expectedBackupConfig(job.id)),
        job.id,
        nowTs,
        nowTs,
      ]
    );
    validateBackupJob(
      await adapter.queryOne<TenantDeletionBackupJobRow>(
        'SELECT status, job_type, created_by, config FROM admin_jobs WHERE id = ? AND tenant_id = ?',
        [expectedJobId, config.tenant_id]
      ),
      job
    );
    await adapter.execute(
      "UPDATE admin_jobs SET status = 'pending', progress = ?, config = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      [
        JSON.stringify({ stage: 'backup_requested', backup_job_id: expectedJobId }),
        JSON.stringify(nextConfig),
        nowTs,
        job.id,
        job.tenant_id,
      ]
    );
    return { completed: false, backupJobId: expectedJobId };
  }

  const backup = validateBackupJob(
    await adapter.queryOne<TenantDeletionBackupJobRow>(
      'SELECT status, job_type, created_by, config FROM admin_jobs WHERE id = ? AND tenant_id = ?',
      [config.backup_job_id, config.tenant_id]
    ),
    job
  );
  if (backup.status === 'completed') {
    return { completed: true, backupJobId: config.backup_job_id };
  }
  if (backup.status === 'failed' || backup.status === 'partial_failure') {
    throw new Error('tenant_deletion_backup_job_failed');
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

function validateTenantDeletionInventory(
  value: ControlTenantDeletionInventory,
  environmentId: string,
  tenantId: string,
  operationId: string
): ControlTenantDeletionInventory {
  if (
    !value ||
    value.environmentId !== environmentId ||
    value.tenantId !== tenantId ||
    value.operationId !== operationId ||
    (value.state !== 'ready' && value.state !== 'finalized') ||
    !Array.isArray(value.lookupShards) ||
    !Array.isArray(value.tenantShards) ||
    (value.state === 'finalized' &&
      (value.lookupShards.length !== 0 || value.tenantShards.length !== 0))
  ) {
    throw new Error('tenant_deletion_control_inventory_invalid');
  }
  return value;
}

async function getTenantDeletionInventory(
  env: Env,
  tenantId: string,
  operationId: string
): Promise<ControlTenantDeletionInventory> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !SAFE_ID.test(environmentId)) {
    throw new Error('tenant_deletion_control_environment_invalid');
  }
  if (!env.CONTROL?.getTenantDeletionInventory) {
    throw new Error('tenant_deletion_control_unavailable');
  }
  return validateTenantDeletionInventory(
    await env.CONTROL.getTenantDeletionInventory({ tenantId, operationId }),
    environmentId,
    tenantId,
    operationId
  );
}

async function finalizeTenantDeletionControlState(
  env: Env,
  tenantId: string,
  operationId: string
): Promise<void> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !SAFE_ID.test(environmentId)) {
    throw new Error('tenant_deletion_control_environment_invalid');
  }
  if (!env.CONTROL?.finalizeTenantDeletionControlState) {
    throw new Error('tenant_deletion_control_unavailable');
  }
  const result = await env.CONTROL.finalizeTenantDeletionControlState({ tenantId, operationId });
  if (
    !result ||
    result.environmentId !== environmentId ||
    result.tenantId !== tenantId ||
    result.operationId !== operationId ||
    result.state !== 'finalized' ||
    !Number.isSafeInteger(result.finalizedAt) ||
    result.finalizedAt < 1
  ) {
    throw new Error('tenant_deletion_control_finalization_invalid');
  }
}

async function deleteTenantAdminRows(
  tx: Pick<DatabaseAdapter, 'execute'>,
  targetTenantId: string
): Promise<void> {
  for (const table of TENANT_ADMIN_TABLES_TO_DELETE) {
    await tx.execute(`DELETE FROM ${table} WHERE tenant_id = ?`, [targetTenantId]);
  }
}

async function suspendTenantAfterDeletionFailure(
  adapter: Pick<DatabaseAdapter, 'execute'>,
  targetTenantId: string | null
): Promise<void> {
  if (!targetTenantId) return;

  await adapter.execute(
    "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = ? WHERE id = ? AND lifecycle_state <> 'deleted'",
    [Math.floor(Date.now() / 1000), targetTenantId]
  );
}

async function processPendingTenantDeletionJobsInStore(
  env: Env,
  log: TenantDeletionJobLogger,
  coreAdapter: DatabaseAdapter
): Promise<number> {
  const adminAdapter = env.DB_ADMIN
    ? ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-deletion-admin')
    : null;
  const pendingJobs = await coreAdapter.query<TenantDeletionJobRow>(
    `SELECT id, tenant_id, config, attempt_count, max_attempts
       FROM admin_jobs
      WHERE job_type = 'tenants/delete'
        AND status = 'pending'
        AND (next_run_at IS NULL OR next_run_at <= ?)
      LIMIT 5`,
    [Math.floor(Date.now() / 1000)]
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

    let targetTenantId: string | null = null;
    try {
      const config = parseTenantDeletionJobConfig(job.config);
      targetTenantId = config.tenant_id;
      const deletionTargetTenantId = config.tenant_id;

      const backup = await ensureDeletionBackupCompleted(coreAdapter, job, config);
      if (!backup.completed) {
        log.info('Tenant deletion job waiting for pre-purge backup', {
          job_id: job.id,
          tenant_id: deletionTargetTenantId,
          backup_job_id: backup.backupJobId,
        });
        continue;
      }

      if (!adminAdapter) throw new Error('tenant_deletion_control_unavailable');
      const inventory = await getTenantDeletionInventory(env, deletionTargetTenantId, job.id);

      if (inventory.state === 'finalized') {
        await publishTenantRuntimeRegistryRouteState(env, {
          tenantId: deletionTargetTenantId,
          routeStatus: 'disabled',
          operationId: job.id,
          actorId: job.id,
        });
        await adminAdapter.transaction(async (tx) => {
          await deleteTenantAdminRows(tx, deletionTargetTenantId);
        });
        await updateTenantDatabaseLifecycleState(
          adminAdapter,
          deletionTargetTenantId,
          job.id,
          'deleted'
        );
      } else {
        await suspendTenantAfterDeletionFailure(coreAdapter, deletionTargetTenantId);
        const quarantining = config.quarantine_started_at
          ? {
              publishedAt: new Date(config.quarantine_started_at * 1000).toISOString(),
            }
          : await publishTenantRuntimeRegistryRouteState(env, {
              tenantId: deletionTargetTenantId,
              routeStatus: 'quarantining',
              operationId: job.id,
              actorId: job.id,
            });
        if (
          await waitForTenantDeletionQuarantineDrain(
            coreAdapter,
            job,
            config,
            quarantining.publishedAt
          )
        ) {
          log.info('Tenant deletion job waiting for runtime quarantine drain', {
            job_id: job.id,
            tenant_id: deletionTargetTenantId,
          });
          continue;
        }
        await publishTenantRuntimeRegistryRouteState(env, {
          tenantId: deletionTargetTenantId,
          routeStatus: 'quarantined',
          operationId: job.id,
          actorId: job.id,
        });

        await disableTenantLookupDirectory(env, inventory.lookupShards, deletionTargetTenantId);
        await coreAdapter.execute(
          'UPDATE admin_jobs SET progress = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
          [
            JSON.stringify({ stage: 'lookup_disabled' }),
            Math.floor(Date.now() / 1000),
            job.id,
            jobTenantId,
          ]
        );

        await purgeTenantAuthoritativeShards(
          env,
          inventory.tenantShards,
          deletionTargetTenantId,
          backup.backupJobId ? [job.id, backup.backupJobId] : [job.id]
        );
        await finalizeTenantDeletionControlState(env, deletionTargetTenantId, job.id);
        await publishTenantRuntimeRegistryRouteState(env, {
          tenantId: deletionTargetTenantId,
          routeStatus: 'disabled',
          operationId: job.id,
          actorId: job.id,
        });
        await updateTenantDatabaseLifecycleState(
          adminAdapter,
          deletionTargetTenantId,
          job.id,
          'deleting'
        );
        await adminAdapter.transaction(async (tx) => {
          await deleteTenantAdminRows(tx, deletionTargetTenantId);
        });
        await updateTenantDatabaseLifecycleState(
          adminAdapter,
          deletionTargetTenantId,
          job.id,
          'deleted'
        );
      }

      const deletedPublicAssets = await deleteTenantPublicAssets(env, deletionTargetTenantId);
      const completedTs = Math.floor(Date.now() / 1000);
      await coreAdapter.execute(
        "UPDATE admin_jobs SET status = 'completed', completed_at = ?, updated_at = ?, progress = ? WHERE id = ? AND tenant_id = ?",
        [completedTs, completedTs, JSON.stringify({ stage: 'completed' }), job.id, jobTenantId]
      );

      log.info('Tenant deletion job completed', {
        job_id: job.id,
        tenant_id: deletionTargetTenantId,
        deleted_public_assets: deletedPublicAssets,
      });
    } catch (jobError) {
      const failedTs = Math.floor(Date.now() / 1000);
      await suspendTenantAfterDeletionFailure(coreAdapter, targetTenantId);
      const attemptCount = deletionAttemptCount(job) + 1;
      const maxAttempts = deletionMaxAttempts(job);
      if (shouldRetryTenantDeletion(jobError) && attemptCount < maxAttempts) {
        const retryAt =
          failedTs +
          TENANT_DELETION_RETRY_SECONDS[
            Math.min(attemptCount - 1, TENANT_DELETION_RETRY_SECONDS.length - 1)
          ];
        await coreAdapter.execute(
          `UPDATE admin_jobs
              SET status = 'pending', progress = ?, error_message = ?, attempt_count = ?,
                  max_attempts = ?, next_run_at = ?, completed_at = NULL, updated_at = ?
            WHERE id = ? AND tenant_id = ?`,
          [
            JSON.stringify({
              stage: 'retry_scheduled',
              attempt_count: attemptCount,
              retry_at: retryAt,
            }),
            safeDeletionErrorCode(jobError),
            attemptCount,
            maxAttempts,
            retryAt,
            failedTs,
            job.id,
            jobTenantId,
          ]
        );
        log.error(
          'Tenant deletion job retry scheduled',
          {
            job_id: job.id,
            attempt_count: attemptCount,
            max_attempts: maxAttempts,
            retry_at: retryAt,
          },
          jobError as Error
        );
        continue;
      }

      await coreAdapter.execute(
        `UPDATE admin_jobs
            SET status = 'failed', error_message = ?, attempt_count = ?, max_attempts = ?,
                next_run_at = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`,
        [
          safeDeletionErrorCode(jobError),
          attemptCount,
          maxAttempts,
          failedTs,
          failedTs,
          job.id,
          jobTenantId,
        ]
      );

      log.error(
        'Tenant deletion job failed',
        { job_id: job.id, attempt_count: attemptCount, max_attempts: maxAttempts },
        jobError as Error
      );
    }
  }

  if (pendingJobs.length > 0) {
    log.info('Tenant deletion jobs processed', {
      selected_count: pendingJobs.length,
      claimed_count: claimedCount,
    });
  }
  return pendingJobs.length;
}

export async function processPendingTenantDeletionJobs(
  env: Env,
  log: TenantDeletionJobLogger
): Promise<void> {
  if (!env.AUTHRIM_CONFIG) throw new Error('tenant_deletion_tenant_directory_unavailable');

  const cursorKey = 'jobs:tenant-deletion:tenant-cursor';
  const afterTenantId = (await env.AUTHRIM_CONFIG.get(cursorKey))?.trim() || undefined;
  const tenants = await listEnvironmentTenantDefaultStores(env, {
    limit: 8,
    afterTenantId,
    concurrency: 4,
  });

  let selectedCount = 0;
  let lastScannedTenantId = '';
  let stoppedEarly = false;
  for (const tenant of tenants) {
    lastScannedTenantId = tenant.tenantId;
    const adapter = ensureDatabaseAdapter(
      tenant.store.source,
      `tenant-deletion-jobs:${tenant.store.bindingRef}`
    );
    selectedCount += await processPendingTenantDeletionJobsInStore(env, log, adapter);
    if (selectedCount >= 5) {
      stoppedEarly = true;
      break;
    }
  }

  const nextCursor = stoppedEarly || tenants.length === 8 ? lastScannedTenantId : '';
  await env.AUTHRIM_CONFIG.put(cursorKey, nextCursor);
}

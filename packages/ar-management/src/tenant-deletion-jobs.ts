import type { ControlTenantDeletionInventory, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  ensureDatabaseAdapter,
  listEnvironmentTenantDefaultStores,
  tombstoneObjectCatalogEntryForTenant,
} from '@authrim/ar-lib-core';
import { purgeTenantAuthoritativeShards } from './tenant-deletion-authoritative-purge';
import { tenantBackupObjectKeyPrefixes } from './admin-job-executor';
import { disableTenantLookupDirectory } from './tenant-deletion-lookup-cleanup';
import { readTenantRouteStateReading } from './tenant-deletion-chain';
import { publishTenantRuntimeRegistryRouteState } from './tenant-runtime-registry-route-state';
import { deleteTenantPublicAssets } from './r2-storage-maintenance';
import {
  createTenantAdminPurgeAuditWriter,
  purgeTenantHomedAdmins,
} from './tenant-deletion-admin-accounts';

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
  /** Epoch seconds the job was queued; fixed for the job's life. */
  created_at?: number | null;
}

interface TenantDeletionJobConfig {
  tenant_id: string;
  backup_policy?: 'deletion_before_purge' | 'manual' | 'scheduled_periodic' | 'none';
  backup_job_id?: string;
  skip_backup?: boolean;
  quarantine_started_at?: number;
  /**
   * Chain id of a deletion that continues a failed one: the operation id of the route state,
   * the Control calls and the backup. Set by the server only; absent means the job's own id.
   */
  operation_id?: string;
}

interface TenantDeletionBackupJobRow {
  status: string;
  job_type: string;
  created_by: string;
  config: string;
}

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const TENANT_DELETION_QUARANTINE_DRAIN_SECONDS = 30 * 60;
const TENANT_DELETION_DEFAULT_MAX_ATTEMPTS = 3;
const TENANT_DELETION_RETRY_SECONDS = [15, 60] as const;
const NON_RETRYABLE_DELETION_ERRORS = new Set([
  'tenant_deletion_job_config_invalid',
  'tenant_deletion_target_is_default',
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
  'tenant_settings_documents',
  'tenant_database_stats',
  'tenant_discovery_indexes',
  'login_ui_themes',
  'authentication_method_profiles',
  'session_profiles',
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
  if (
    parsed.operation_id !== undefined &&
    (typeof parsed.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(parsed.operation_id))
  ) {
    throw new Error('tenant_deletion_job_config_invalid');
  }
  return {
    tenant_id: parsed.tenant_id,
    operation_id: parsed.operation_id,
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
    "UPDATE admin_jobs SET status = 'pending', progress = ?, config = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
    [
      JSON.stringify({
        stage: 'quarantine_draining',
        quarantine_started_at: quarantineStartedAt,
        drain_ready_at: drainReadyAt,
      }),
      JSON.stringify(nextConfig),
      // Not selected again before the drain is over, so waiting jobs do not fill the batch.
      drainReadyAt,
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

function validateBackupJob(row: TenantDeletionBackupJobRow | null, operationId: string) {
  if (!row || row.job_type !== 'tenant-database/export' || row.created_by !== operationId) {
    throw new Error('tenant_deletion_backup_job_invalid');
  }
  try {
    if (row.config.length > 16_384) throw new Error('tenant_deletion_backup_job_invalid');
    const config = JSON.parse(row.config) as unknown;
    const expected = expectedBackupConfig(operationId);
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

/**
 * The pre-purge backup: a tenant-database/export job kept in DB_ADMIN (`jobsAdapter`), where the
 * scheduled admin job run claims it. The deletion job (in `adapter`) waits until it completed.
 */
async function ensureDeletionBackupCompleted(
  adapter: Pick<DatabaseAdapter, 'execute' | 'queryOne'>,
  jobsAdapter: Pick<DatabaseAdapter, 'execute' | 'queryOne'> | null,
  job: TenantDeletionJobRow,
  config: TenantDeletionJobConfig
): Promise<{ completed: boolean; backupJobId: string | null }> {
  if (config.skip_backup || config.backup_policy === 'none') {
    return { completed: true, backupJobId: null };
  }
  // Without DB_ADMIN the backup cannot run: the deletion stops, it never goes on without it.
  if (!jobsAdapter) throw new Error('tenant_deletion_control_unavailable');

  const nowTs = Math.floor(Date.now() / 1000);
  const operationId = config.operation_id ?? job.id;
  const expectedJobId = backupJobId(operationId);
  if (config.backup_job_id && config.backup_job_id !== expectedJobId) {
    throw new Error('tenant_deletion_backup_job_invalid');
  }
  // A backup requested before backups were kept in DB_ADMIN is in this database: one that ended
  // counts as it ended; one that never ran (nothing claimed it here) is requested again in
  // DB_ADMIN and removed here, so the backup is in one store only.
  const legacy = await adapter.queryOne<TenantDeletionBackupJobRow>(
    'SELECT status, job_type, created_by, config FROM admin_jobs WHERE id = ? AND tenant_id = ?',
    [expectedJobId, config.tenant_id]
  );
  const legacyEnded = !!legacy && legacy.status !== 'pending' && legacy.status !== 'processing';
  const backupStore = legacyEnded ? adapter : jobsAdapter;
  if (!legacyEnded) {
    await jobsAdapter.execute(
      `INSERT OR IGNORE INTO admin_jobs (
        id, tenant_id, job_type, status, progress, config, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [
        expectedJobId,
        config.tenant_id,
        'tenant-database/export',
        JSON.stringify({ stage: 'pending', policy: 'deletion_before_purge' }),
        JSON.stringify(expectedBackupConfig(operationId)),
        operationId,
        nowTs,
        nowTs,
      ]
    );
    if (legacy) {
      validateBackupJob(legacy, operationId);
      await adapter.execute(
        `DELETE FROM admin_jobs
          WHERE id = ? AND tenant_id = ? AND job_type = 'tenant-database/export'
            AND status IN ('pending', 'processing')`,
        [expectedJobId, config.tenant_id]
      );
    }
  }
  if (!config.backup_job_id) {
    const nextConfig = { ...config, backup_job_id: expectedJobId };
    validateBackupJob(
      await backupStore.queryOne<TenantDeletionBackupJobRow>(
        'SELECT status, job_type, created_by, config FROM admin_jobs WHERE id = ? AND tenant_id = ?',
        [expectedJobId, config.tenant_id]
      ),
      operationId
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
    await backupStore.queryOne<TenantDeletionBackupJobRow>(
      'SELECT status, job_type, created_by, config FROM admin_jobs WHERE id = ? AND tenant_id = ?',
      [config.backup_job_id, config.tenant_id]
    ),
    operationId
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

export async function updateTenantDatabaseLifecycleState(
  adapter: Pick<DatabaseAdapter, 'execute'> | null,
  targetTenantId: string,
  currentJobId: string,
  status: 'deleting' | 'deleted'
): Promise<void> {
  if (!adapter) return;

  const now = new Date().toISOString();
  const metadata = buildTenantDatabaseLifecycleMetadata(currentJobId, status);

  // Pointers first, registry second (two statements, no shared transaction across adapters). The
  // snapshot publisher only loads ACTIVE pointers, so "pointers disabled + registry still active"
  // publishes zero stores and a retry converges, whereas "registry deleting + pointers active" is
  // refused as `inactive_registry_row` and could never reach this step again. Idempotent: a
  // repeated call changes no generation.
  await adapter.execute(
    `UPDATE tenant_database_active_pointers
        SET status = 'disabled',
            runtime_generation = runtime_generation + 1,
            updated_at = ?,
            updated_by = ?,
            metadata_json = ?
      WHERE tenant_id = ? AND status <> 'disabled'`,
    [now, currentJobId, metadata, targetTenantId]
  );

  await adapter.execute(
    `UPDATE tenant_database_registry
        SET status = ?, updated_at = ?, updated_by = ?, metadata_json = ?
      WHERE tenant_id = ? AND status <> 'deleted'`,
    [status, now, currentJobId, metadata, targetTenantId]
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

/**
 * Removes the administrators homed in the deleted tenant (see tenant-deletion-admin-accounts).
 * Runs only after `deleteTenantAdminRows`, i.e. after the point of no return; a failure fails the
 * step (it is retried, and the tenant is not marked deleted) rather than passing silently.
 */
async function purgeTenantAdminAccounts(
  env: Env,
  log: TenantDeletionJobLogger,
  coreAdapter: Pick<DatabaseAdapter, 'queryOne'>,
  adminAdapter: DatabaseAdapter,
  targetTenantId: string,
  job: TenantDeletionJobRow
): Promise<void> {
  const jobId = job.id;
  const jobTenantId = job.tenant_id;
  // Every audit event of the job carries the time the job was queued, so a retry rewrites the
  // same events (the audit store refuses an event id whose content changed). A row without it
  // (never in the table: the column is NOT NULL) falls back to the clock.
  const auditAt =
    Number.isSafeInteger(job.created_at) && Number(job.created_at) > 0
      ? Number(job.created_at) * 1000
      : Date.now();
  // Checked again here, right before the destructive step.
  await assertDeletionTargetNotDefault(coreAdapter, targetTenantId);
  // The audit rows belong to a live tenant: the one the deletion was requested from.
  const auditTenantId =
    jobTenantId !== targetTenantId ? jobTenantId : env.DEFAULT_TENANT_ID || 'default';
  await purgeTenantHomedAdmins({
    adapter: adminAdapter,
    tenantId: targetTenantId,
    jobId,
    auditTenantId,
    auditAt,
    writeAudit: createTenantAdminPurgeAuditWriter(adminAdapter, env),
    log,
  });
}

/**
 * The object catalog entries an export job's result names (its manifest and table artifacts),
 * besides the job's own result artifact.
 */
function exportResultCatalogIds(result: string | null): string[] {
  if (!result || result.length > 1_048_576) return [];
  try {
    const parsed = JSON.parse(result) as {
      manifest?: { object_catalog_id?: unknown };
      table_artifacts?: Array<{ object_catalog_id?: unknown }>;
    };
    return [
      parsed.manifest?.object_catalog_id,
      ...(Array.isArray(parsed.table_artifacts)
        ? parsed.table_artifacts.map((artifact) => artifact?.object_catalog_id)
        : []),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * The tenant's admin jobs kept in DB_ADMIN (those the scheduled runs claim) go with the tenant,
 * as its jobs in its Core databases go with the authoritative purge: the artifacts they hold are
 * tombstoned (the object cleanup removes the objects) or deleted, then the rows. The deletion's
 * own jobs (its backup) stay, with their artifacts.
 */
export async function deleteTenantAdminJobs(
  env: Env,
  adminAdapter: DatabaseAdapter,
  targetTenantId: string,
  preserveJobIds: string[]
): Promise<void> {
  const keep = preserveJobIds.map(() => '?').join(', ');
  const jobs = await adminAdapter.query<{
    id: string;
    job_type: string;
    object_catalog_id: string | null;
    result_r2_key: string | null;
    result: string | null;
  }>(
    `SELECT id, job_type, object_catalog_id, result_r2_key,
            CASE WHEN job_type = 'tenant-database/export' THEN result END AS result
       FROM admin_jobs
      WHERE tenant_id = ? AND id NOT IN (${keep})
        AND (object_catalog_id IS NOT NULL OR result_r2_key IS NOT NULL
             OR job_type = 'tenant-database/export')`,
    [targetTenantId, ...preserveJobIds]
  );
  const objectKeys = jobs
    .filter((job) => !job.object_catalog_id && job.result_r2_key)
    .map((job) => job.result_r2_key as string);
  // Its rows are what finds these objects: none is removed while an object cannot be.
  const bucket = env.EXPORT_ARTIFACTS;
  if (objectKeys.length > 0 && !bucket) {
    throw new Error('tenant_deletion_artifact_storage_unavailable');
  }
  const catalogIds = new Set<string>();
  /** The catalogs whose objects are under one of an export job's key prefixes. */
  const exportCatalogIds = async (jobId: string) => {
    const ids: string[] = [];
    for (const prefix of tenantBackupObjectKeyPrefixes(targetTenantId, jobId)) {
      const catalogs = await adminAdapter.query<{ catalog_id: string }>(
        `SELECT DISTINCT oco.catalog_id
           FROM object_catalog_objects oco
           INNER JOIN object_catalog oc ON oc.id = oco.catalog_id
          WHERE oc.tenant_id = ? AND substr(oco.object_key, 1, ?) = ?`,
        [targetTenantId, prefix.length, prefix]
      );
      ids.push(...catalogs.map((catalog) => catalog.catalog_id));
    }
    return ids;
  };
  for (const job of jobs) {
    if (job.object_catalog_id) catalogIds.add(job.object_catalog_id);
    if (job.job_type !== 'tenant-database/export') continue;
    // An export's manifest and tables: named in its result when kept inline, and found by their
    // object keys (the job's own prefix, matched exactly) when its result is an artifact.
    for (const id of exportResultCatalogIds(job.result)) catalogIds.add(id);
    for (const id of await exportCatalogIds(job.id)) catalogIds.add(id);
  }
  // Never one of a preserved job's (the deletion's backup), whatever another job's names say.
  if (catalogIds.size > 0) {
    const preserved = await adminAdapter.query<{ object_catalog_id: string | null }>(
      `SELECT object_catalog_id FROM admin_jobs WHERE tenant_id = ? AND id IN (${keep})`,
      [targetTenantId, ...preserveJobIds]
    );
    for (const row of preserved) {
      if (row.object_catalog_id) catalogIds.delete(row.object_catalog_id);
    }
    for (const jobId of preserveJobIds) {
      for (const id of await exportCatalogIds(jobId)) catalogIds.delete(id);
    }
  }
  const deletedAt = Date.now();
  for (const catalogId of catalogIds) {
    await tombstoneObjectCatalogEntryForTenant(adminAdapter, targetTenantId, catalogId, deletedAt);
  }
  for (const key of objectKeys) {
    await bucket?.delete(key);
  }
  await adminAdapter.execute(`DELETE FROM admin_jobs WHERE tenant_id = ? AND id NOT IN (${keep})`, [
    targetTenantId,
    ...preserveJobIds,
  ]);
}

async function suspendTenantAfterDeletionFailure(
  adapter: Pick<DatabaseAdapter, 'execute'>,
  targetTenantId: string | null
): Promise<number> {
  if (!targetTenantId) return 0;

  const result = await adapter.execute(
    // Never the default tenant, whatever failed: a stale job must not take it offline.
    "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = ? WHERE id = ? AND lifecycle_state <> 'deleted' AND is_default = 0 AND default_tenant_guard IS NULL",
    [Math.floor(Date.now() / 1000), targetTenantId]
  );
  return result.rowsAffected;
}

/**
 * Stops the job (as a non-retryable failure, touching nothing) when the tenant is the default.
 * Called before each step that changes the tenant's state or routes.
 */
async function assertDeletionTargetNotDefault(
  adapter: Pick<DatabaseAdapter, 'queryOne'>,
  targetTenantId: string
): Promise<void> {
  const row = await adapter.queryOne<{ is_default: number | boolean }>(
    'SELECT is_default FROM tenants WHERE id = ?',
    [targetTenantId]
  );
  if (row && (row.is_default === 1 || row.is_default === true)) {
    throw new Error('tenant_deletion_target_is_default');
  }
}

/**
 * Marks the tenant's row in the platform database (`env.DB`, the one the tenant read and list APIs
 * report) as deleted once its data is purged. The purge marks the row only in the tenant's own
 * stores, which may be another database, so without this the platform row would stay in its
 * deleting or suspended state and a second delete would still be accepted. Idempotent, and a
 * no-op when the platform database is a store the purge already marked.
 */
async function markPlatformTenantDeleted(env: Env, targetTenantId: string): Promise<void> {
  if (!env.DB) return;
  await ensureDatabaseAdapter(env.DB, 'tenant-deletion-platform').execute(
    // Never the default tenant, and never a row that is already deleted.
    "UPDATE tenants SET lifecycle_state = 'deleted', updated_at = ? WHERE id = ? AND lifecycle_state <> 'deleted' AND is_default = 0 AND default_tenant_guard IS NULL",
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
    `SELECT id, tenant_id, config, attempt_count, max_attempts, created_at
       FROM admin_jobs
      WHERE job_type = 'tenants/delete'
        AND status = 'pending'
        AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY updated_at ASC, created_at ASC, id ASC
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

      // Nothing is changed for a default tenant: the check comes first and is repeated before each
      // step that changes the tenant's state or routes (and `set-default` and the reactivating
      // lifecycle commands refuse while this job is active, so the tenant cannot become one).
      await assertDeletionTargetNotDefault(coreAdapter, deletionTargetTenantId);

      const backup = await ensureDeletionBackupCompleted(coreAdapter, adminAdapter, job, config);
      if (!backup.completed) {
        log.info('Tenant deletion job waiting for pre-purge backup', {
          job_id: job.id,
          tenant_id: deletionTargetTenantId,
          backup_job_id: backup.backupJobId,
        });
        continue;
      }

      if (!adminAdapter) throw new Error('tenant_deletion_control_unavailable');
      const operationId = config.operation_id ?? job.id;
      const preserveJobIds = backup.backupJobId ? [job.id, backup.backupJobId] : [job.id];
      const inventory = await getTenantDeletionInventory(env, deletionTargetTenantId, operationId);

      if (inventory.state === 'finalized') {
        await assertDeletionTargetNotDefault(coreAdapter, deletionTargetTenantId);
        // A predecessor that already published `disabled` under this operation id may have left
        // its pointers active over registry rows another job has since marked non-active (the
        // publisher refuses that pair). Disabling the pointers first lets the publish succeed
        // with no stores; the step is idempotent. Any other state keeps the order below.
        if (config.operation_id) {
          const routeState = await readTenantRouteStateReading(
            adminAdapter,
            deletionTargetTenantId
          );
          if (routeState?.routeStatus === 'disabled' && routeState.operationId === operationId) {
            await updateTenantDatabaseLifecycleState(
              adminAdapter,
              deletionTargetTenantId,
              job.id,
              'deleting'
            );
          }
        }
        await publishTenantRuntimeRegistryRouteState(env, {
          tenantId: deletionTargetTenantId,
          routeStatus: 'disabled',
          operationId,
          actorId: job.id,
        });
        await deleteTenantAdminJobs(env, adminAdapter, deletionTargetTenantId, preserveJobIds);
        await adminAdapter.transaction(async (tx) => {
          await deleteTenantAdminRows(tx, deletionTargetTenantId);
        });
        await purgeTenantAdminAccounts(
          env,
          log,
          coreAdapter,
          adminAdapter,
          deletionTargetTenantId,
          job
        );
        await updateTenantDatabaseLifecycleState(
          adminAdapter,
          deletionTargetTenantId,
          job.id,
          'deleted'
        );
        await markPlatformTenantDeleted(env, deletionTargetTenantId);
      } else {
        const suspended = await suspendTenantAfterDeletionFailure(
          coreAdapter,
          deletionTargetTenantId
        );
        // The transition did not apply: stop, touching nothing, when the tenant is the default
        // (a tenant that is already deleted simply has nothing left to suspend).
        if (suspended === 0)
          await assertDeletionTargetNotDefault(coreAdapter, deletionTargetTenantId);
        // A continued job whose predecessor already reached `quarantined` under the same
        // operation id has drained: the forward-only transition cannot go back to `quarantining`.
        // Any other state (including a foreign operation) takes the normal path and conflicts there.
        let resumeAtQuarantined = false;
        if (config.operation_id && !config.quarantine_started_at) {
          const routeState = await readTenantRouteStateReading(
            adminAdapter,
            deletionTargetTenantId
          );
          resumeAtQuarantined =
            routeState?.routeStatus === 'quarantined' && routeState.operationId === operationId;
        }
        if (!resumeAtQuarantined) {
          const quarantining = config.quarantine_started_at
            ? {
                publishedAt: new Date(config.quarantine_started_at * 1000).toISOString(),
              }
            : await publishTenantRuntimeRegistryRouteState(env, {
                tenantId: deletionTargetTenantId,
                routeStatus: 'quarantining',
                operationId,
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
        }

        await assertDeletionTargetNotDefault(coreAdapter, deletionTargetTenantId);
        await publishTenantRuntimeRegistryRouteState(env, {
          tenantId: deletionTargetTenantId,
          routeStatus: 'quarantined',
          operationId,
          actorId: job.id,
        });

        await assertDeletionTargetNotDefault(coreAdapter, deletionTargetTenantId);
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

        await assertDeletionTargetNotDefault(coreAdapter, deletionTargetTenantId);
        await purgeTenantAuthoritativeShards(
          env,
          inventory.tenantShards,
          deletionTargetTenantId,
          preserveJobIds
        );
        await finalizeTenantDeletionControlState(env, deletionTargetTenantId, operationId);
        await publishTenantRuntimeRegistryRouteState(env, {
          tenantId: deletionTargetTenantId,
          routeStatus: 'disabled',
          operationId,
          actorId: job.id,
        });
        await updateTenantDatabaseLifecycleState(
          adminAdapter,
          deletionTargetTenantId,
          job.id,
          'deleting'
        );
        await deleteTenantAdminJobs(env, adminAdapter, deletionTargetTenantId, preserveJobIds);
        await adminAdapter.transaction(async (tx) => {
          await deleteTenantAdminRows(tx, deletionTargetTenantId);
        });
        await purgeTenantAdminAccounts(
          env,
          log,
          coreAdapter,
          adminAdapter,
          deletionTargetTenantId,
          job
        );
        await updateTenantDatabaseLifecycleState(
          adminAdapter,
          deletionTargetTenantId,
          job.id,
          'deleted'
        );
        await markPlatformTenantDeleted(env, deletionTargetTenantId);
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

  // The delete route queues its job in the platform database (`env.DB`), which is not necessarily
  // any tenant's default store, so it is scanned on its own, before the tenant stores.
  let selectedCount = 0;
  if (env.DB) {
    try {
      selectedCount += await processPendingTenantDeletionJobsInStore(
        env,
        log,
        ensureDatabaseAdapter(env.DB, 'tenant-deletion-jobs:platform')
      );
    } catch (error) {
      log.error('Tenant deletion platform job scan failed', {}, error as Error);
    }
  }
  // The budget is spent: leave the tenant cursor exactly where it is for the next run.
  if (selectedCount >= 5) return;

  const cursorKey = 'jobs:tenant-deletion:tenant-cursor';
  const afterTenantId = (await env.AUTHRIM_CONFIG.get(cursorKey))?.trim() || undefined;
  const tenants = await listEnvironmentTenantDefaultStores(env, {
    limit: 8,
    afterTenantId,
    concurrency: 4,
    // A job can live in a tenant's own store (for example when the platform database is itself a
    // tenant's default store), and that tenant may already be deleting or suspended.
    includeInactive: true,
  });

  let lastScannedTenantId = '';
  let stoppedEarly = false;
  for (const tenant of tenants) {
    lastScannedTenantId = tenant.tenantId;
    // Already scanned above as the platform database.
    if (env.DB && tenant.store.source === env.DB) continue;
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

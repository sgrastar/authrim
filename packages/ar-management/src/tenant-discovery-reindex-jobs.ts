import {
  ensureDatabaseAdapter,
  TenantDiscoveryIndexRepository,
  type DatabaseAdapter,
  type Env,
  type TenantDiscoveryIndexKind,
} from '@authrim/ar-lib-core';

export const TENANT_DISCOVERY_REINDEX_JOB_TYPE = 'tenant-discovery/reindex';

export type TenantDiscoveryReindexMode = 'validate_and_cleanup' | 'validate_only';

export interface TenantDiscoveryReindexJobConfig {
  index_kind: TenantDiscoveryIndexKind;
  previous_key_version: number;
  current_key_version: number;
  index_version?: number;
  mode?: TenantDiscoveryReindexMode;
  require_complete?: boolean;
}

interface TenantDiscoveryReindexJobRow {
  id: string;
  tenant_id: string;
  status: 'pending' | 'processing';
  config: string | null;
  created_at: number;
}

interface TenantDiscoveryReindexLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TenantDiscoveryReindexSummary {
  scanned: number;
  completed: number;
  partial: number;
  failed: number;
}

export interface TenantDiscoveryReindexOptions {
  limit?: number;
  now?: number;
}

export interface EnqueueTenantDiscoveryReindexJobOptions {
  tenantId?: string;
  createdBy: string;
  now?: number;
  jobId?: string;
  maxAttempts?: number;
}

const DEFAULT_REINDEX_JOB_LIMIT = 3;
const CONTROL_TENANT_ID = '__control__';
const DISCOVERY_INDEX_KINDS: TenantDiscoveryIndexKind[] = [
  'email_exact',
  'external_subject',
  'global_subject',
];

function isTenantDiscoveryIndexKind(value: unknown): value is TenantDiscoveryIndexKind {
  return typeof value === 'string' && DISCOVERY_INDEX_KINDS.includes(value as never);
}

function parsePositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`invalid_tenant_discovery_reindex_config:${fieldName}`);
  }
  return value as number;
}

function parseTenantDiscoveryReindexConfig(
  configJson: string | null
): TenantDiscoveryReindexJobConfig {
  if (!configJson) {
    throw new Error('invalid_tenant_discovery_reindex_config:missing');
  }
  const parsed = JSON.parse(configJson) as Record<string, unknown>;
  if (!isTenantDiscoveryIndexKind(parsed.index_kind)) {
    throw new Error('invalid_tenant_discovery_reindex_config:index_kind');
  }
  const mode = parsed.mode ?? 'validate_and_cleanup';
  if (mode !== 'validate_and_cleanup' && mode !== 'validate_only') {
    throw new Error('invalid_tenant_discovery_reindex_config:mode');
  }
  return {
    index_kind: parsed.index_kind,
    previous_key_version: parsePositiveInteger(parsed.previous_key_version, 'previous_key_version'),
    current_key_version: parsePositiveInteger(parsed.current_key_version, 'current_key_version'),
    index_version:
      parsed.index_version === undefined
        ? undefined
        : parsePositiveInteger(parsed.index_version, 'index_version'),
    mode,
    require_complete: parsed.require_complete === true,
  };
}

function createProgress(params: {
  total: number;
  readyForCleanup: number;
  missingCurrent: number;
  deletedPrevious: number;
  stage: 'completed' | 'partial_failure' | 'failed';
}): string {
  return JSON.stringify({
    total: params.total,
    processed: params.readyForCleanup + params.missingCurrent,
    succeeded: params.deletedPrevious,
    failed: params.missingCurrent,
    stage: params.stage,
  });
}

function createResult(params: {
  config: TenantDiscoveryReindexJobConfig;
  previousRows: number;
  readyForCleanup: number;
  missingCurrent: number;
  deletedPrevious: number;
}): string {
  return JSON.stringify({
    summary: {
      index_kind: params.config.index_kind,
      index_version: params.config.index_version ?? 1,
      previous_key_version: params.config.previous_key_version,
      current_key_version: params.config.current_key_version,
      previous_rows: params.previousRows,
      ready_for_cleanup: params.readyForCleanup,
      missing_current: params.missingCurrent,
      deleted_previous_rows: params.deletedPrevious,
      mode: params.config.mode ?? 'validate_and_cleanup',
    },
  });
}

async function runTenantDiscoveryReindexJob(
  adapter: DatabaseAdapter,
  repository: TenantDiscoveryIndexRepository,
  job: TenantDiscoveryReindexJobRow,
  completedTs: number
): Promise<'completed' | 'partial_failure'> {
  const config = parseTenantDiscoveryReindexConfig(job.config);
  const countOptions = {
    indexKind: config.index_kind,
    previousKeyVersion: config.previous_key_version,
    currentKeyVersion: config.current_key_version,
    indexVersion: config.index_version,
  };
  const previousRows = await repository.countPreviousKeyVersionRows({
    indexKind: config.index_kind,
    previousKeyVersion: config.previous_key_version,
    indexVersion: config.index_version,
  });
  const readyForCleanup =
    await repository.countPreviousKeyVersionRowsReadyForDeletion(countOptions);
  const missingCurrent = await repository.countPreviousKeyVersionRowsMissingCurrent(countOptions);

  if (missingCurrent > 0 && config.require_complete) {
    throw new Error(`tenant_discovery_reindex_incomplete:${missingCurrent}`);
  }

  const deletedPrevious =
    config.mode === 'validate_only'
      ? 0
      : await repository.deletePreviousKeyVersionRows(countOptions);
  const status = missingCurrent > 0 ? 'partial_failure' : 'completed';

  await adapter.execute(
    `UPDATE admin_jobs
        SET status = ?,
            completed_at = ?,
            updated_at = ?,
            progress = ?,
            result = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      status,
      completedTs,
      completedTs,
      createProgress({
        total: previousRows,
        readyForCleanup,
        missingCurrent,
        deletedPrevious,
        stage: status,
      }),
      createResult({
        config,
        previousRows,
        readyForCleanup,
        missingCurrent,
        deletedPrevious,
      }),
      job.id,
      job.tenant_id,
    ]
  );

  return status;
}

export async function enqueueTenantDiscoveryReindexJob(
  adapter: DatabaseAdapter,
  config: TenantDiscoveryReindexJobConfig,
  options: EnqueueTenantDiscoveryReindexJobOptions
): Promise<string> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const jobId = options.jobId ?? crypto.randomUUID();
  await adapter.execute(
    `INSERT INTO admin_jobs (
      id, tenant_id, job_type, status, progress, config, created_by,
      created_at, updated_at, max_attempts
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      options.tenantId ?? CONTROL_TENANT_ID,
      TENANT_DISCOVERY_REINDEX_JOB_TYPE,
      createProgress({
        total: 0,
        readyForCleanup: 0,
        missingCurrent: 0,
        deletedPrevious: 0,
        stage: 'completed',
      }),
      JSON.stringify(config),
      options.createdBy,
      now,
      now,
      options.maxAttempts ?? 3,
    ]
  );
  return jobId;
}

export async function processPendingTenantDiscoveryReindexJobs(
  env: Env,
  logger: TenantDiscoveryReindexLogger,
  options: TenantDiscoveryReindexOptions = {}
): Promise<TenantDiscoveryReindexSummary> {
  const summary: TenantDiscoveryReindexSummary = {
    scanned: 0,
    completed: 0,
    partial: 0,
    failed: 0,
  };
  if (!env.DB_ADMIN) {
    logger.warn('Tenant discovery reindex jobs skipped because DB_ADMIN is not configured');
    return summary;
  }

  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-discovery-reindex-jobs');
  const repository = new TenantDiscoveryIndexRepository(adapter);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const jobs = await adapter.query<TenantDiscoveryReindexJobRow>(
    `SELECT id, tenant_id, status, config, created_at
       FROM admin_jobs
      WHERE job_type = ?
        AND status IN ('pending', 'processing')
        AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?`,
    [TENANT_DISCOVERY_REINDEX_JOB_TYPE, now, options.limit ?? DEFAULT_REINDEX_JOB_LIMIT]
  );
  summary.scanned = jobs.length;

  for (const job of jobs) {
    const startedTs = Math.floor(Date.now() / 1000);
    if (job.status === 'pending') {
      const claimed = await adapter.execute(
        "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
        [startedTs, startedTs, job.id, job.tenant_id]
      );
      if ((claimed.rowsAffected ?? 0) === 0) {
        continue;
      }
    }

    try {
      const status = await runTenantDiscoveryReindexJob(adapter, repository, job, startedTs);
      if (status === 'partial_failure') {
        summary.partial += 1;
      } else {
        summary.completed += 1;
      }
    } catch (error) {
      await adapter.execute(
        "UPDATE admin_jobs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
        [String(error), startedTs, startedTs, job.id, job.tenant_id]
      );
      summary.failed += 1;
      logger.warn('Tenant discovery reindex job failed', {
        job_id: job.id,
        tenant_id: job.tenant_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summary.scanned > 0) {
    logger.info('Tenant discovery reindex jobs completed', { ...summary });
  }

  return summary;
}

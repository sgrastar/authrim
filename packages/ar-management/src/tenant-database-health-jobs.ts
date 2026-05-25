import {
  checkResolvedTenantDatabaseDeepHealth,
  ensureDatabaseAdapter,
  resolveTenantDatabaseSourceFromRegistry,
  TenantDatabaseRegistryRepository,
  type Env,
  type TenantDatabaseRegistryRow,
  type TenantDatabaseRole,
} from '@authrim/ar-lib-core';

export interface TenantDatabaseHealthRefreshSummary {
  scanned: number;
  healthy: number;
  degraded: number;
  failed: number;
  skipped: number;
}

export interface TenantDatabaseHealthCheckJobSummary {
  scanned: number;
  completed: number;
  failed: number;
}

interface TenantDatabaseHealthLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TenantDatabaseHealthRefreshOptions {
  roles?: TenantDatabaseRole[];
  tenantId?: string;
  limitPerRole?: number;
  checkedAt?: string;
  failureThreshold?: number;
}

const DEFAULT_HEALTH_ROLES: TenantDatabaseRole[] = ['tenant_core', 'tenant_pii'];
const DEFAULT_HEALTH_LIMIT_PER_ROLE = 25;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 2;
const TENANT_DATABASE_HEALTH_CHECK_JOB_TYPE = 'tenant-database/health-check';
const DEFAULT_HEALTH_CHECK_JOB_LIMIT = 5;

function createEmptySummary(): TenantDatabaseHealthRefreshSummary {
  return {
    scanned: 0,
    healthy: 0,
    degraded: 0,
    failed: 0,
    skipped: 0,
  };
}

function parseRegistryMetadata(metadataJson: string | null | undefined): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getHealthFailureCount(metadata: Record<string, unknown>): number {
  const value = metadata.health_failure_count;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function serializeRegistryMetadata(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata);
}

function isSchemaIncompatibleFailure(health: {
  severity: string;
  schemaDrift?: string;
  error?: string;
}): boolean {
  return (
    health.severity === 'failed' &&
    (health.schemaDrift === 'behind_registry' ||
      health.error?.startsWith('tenant_database_schema_version_too_old:') === true ||
      health.error?.startsWith('tenant_database_schema_version_unreadable:') === true)
  );
}

async function listActiveRowsForHealth(
  repository: TenantDatabaseRegistryRepository,
  role: TenantDatabaseRole,
  options: { tenantId?: string; batchSize: number }
) {
  if (options.tenantId) {
    return repository.listActiveRegistryRowsForTenantRole(options.tenantId, role);
  }

  const rows: TenantDatabaseRegistryRow[] = [];
  for (let offset = 0; ; offset += options.batchSize) {
    const page = await repository.listActiveRegistryRowsForRole(role, options.batchSize, offset);
    rows.push(...page);
    if (page.length < options.batchSize) {
      break;
    }
  }
  return rows;
}

export async function refreshTenantDatabaseHealth(
  env: Env,
  logger: TenantDatabaseHealthLogger,
  options: TenantDatabaseHealthRefreshOptions = {}
): Promise<TenantDatabaseHealthRefreshSummary> {
  const summary = createEmptySummary();
  if (!env.DB_ADMIN) {
    logger.warn('Tenant database health refresh skipped because DB_ADMIN is not configured');
    return summary;
  }

  const repository = new TenantDatabaseRegistryRepository(
    ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-database-health-control')
  );
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const roles = options.roles ?? DEFAULT_HEALTH_ROLES;
  const limit = options.limitPerRole ?? DEFAULT_HEALTH_LIMIT_PER_ROLE;
  const failureThreshold = Math.max(
    1,
    options.failureThreshold ?? DEFAULT_HEALTH_FAILURE_THRESHOLD
  );

  for (const role of roles) {
    const rows = await listActiveRowsForHealth(repository, role, {
      tenantId: options.tenantId,
      batchSize: limit,
    });
    for (const row of rows) {
      summary.scanned += 1;
      try {
        const resolved = await resolveTenantDatabaseSourceFromRegistry(
          env,
          {
            tenantId: row.tenant_id,
            role: row.role,
            shardGroup: row.shard_group,
            shardIndex: row.shard_index,
          },
          repository
        );
        const health = await checkResolvedTenantDatabaseDeepHealth(resolved, checkedAt);
        if (health.severity === 'healthy') {
          if (row.status === 'degraded') {
            const metadata = parseRegistryMetadata(row.metadata_json);
            metadata.health_failure_count = 0;
            metadata.last_health_checked_at = checkedAt;
            await repository.updateRegistryStatusAndMetadata(
              {
                tenant_id: row.tenant_id,
                role: row.role,
                generation: row.generation,
                shard_group: row.shard_group,
                shard_index: row.shard_index,
              },
              'active',
              serializeRegistryMetadata(metadata),
              'tenant-database-health'
            );
          }
          summary.healthy += 1;
          continue;
        }

        const metadata = parseRegistryMetadata(row.metadata_json);
        const nextFailureCount =
          health.severity === 'failed' ? getHealthFailureCount(metadata) + 1 : 0;
        metadata.health_failure_count = nextFailureCount;
        metadata.last_health_checked_at = checkedAt;
        metadata.last_health_error = health.error ?? null;
        metadata.last_schema_drift = health.schemaDrift;
        const nextStatus =
          health.severity === 'failed' &&
          (isSchemaIncompatibleFailure(health) || nextFailureCount >= failureThreshold)
            ? 'failed'
            : 'degraded';
        await repository.updateRegistryStatusAndMetadata(
          {
            tenant_id: row.tenant_id,
            role: row.role,
            generation: row.generation,
            shard_group: row.shard_group,
            shard_index: row.shard_index,
          },
          nextStatus,
          serializeRegistryMetadata(metadata),
          'tenant-database-health'
        );
        summary[nextStatus] += 1;
        logger.warn('Tenant database health state updated', {
          tenant_id: row.tenant_id,
          role: row.role,
          generation: row.generation,
          severity: health.severity,
          schema_drift: health.schemaDrift,
          error: health.error,
        });
      } catch (error) {
        await repository.updateRegistryStatus(
          {
            tenant_id: row.tenant_id,
            role: row.role,
            generation: row.generation,
            shard_group: row.shard_group,
            shard_index: row.shard_index,
          },
          'failed',
          'tenant-database-health'
        );
        summary.failed += 1;
        logger.warn('Tenant database health refresh failed', {
          tenant_id: row.tenant_id,
          role: row.role,
          generation: row.generation,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  logger.info('Tenant database health refresh completed', { ...summary });
  return summary;
}

function parseHealthCheckJobConfig(config: string | null): { roles?: TenantDatabaseRole[] } {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config) as { roles?: unknown };
    if (!Array.isArray(parsed.roles)) return {};
    const roles = parsed.roles.filter(
      (role): role is TenantDatabaseRole => role === 'tenant_core' || role === 'tenant_pii'
    );
    return roles.length > 0 ? { roles } : {};
  } catch {
    return {};
  }
}

export async function processPendingTenantDatabaseHealthCheckJobs(
  env: Env,
  logger: TenantDatabaseHealthLogger,
  options: { limit?: number; now?: number } = {}
): Promise<TenantDatabaseHealthCheckJobSummary> {
  const summary: TenantDatabaseHealthCheckJobSummary = {
    scanned: 0,
    completed: 0,
    failed: 0,
  };
  if (!env.DB_ADMIN) {
    logger.warn('Tenant database health-check jobs skipped because DB_ADMIN is not configured');
    return summary;
  }

  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-database-health-check-jobs');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const jobs = await adapter.query<{
    id: string;
    tenant_id: string;
    status: string;
    config: string | null;
  }>(
    `SELECT id, tenant_id, status, config
       FROM admin_jobs
      WHERE job_type = ?
        AND status IN ('pending', 'processing')
        AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?`,
    [TENANT_DATABASE_HEALTH_CHECK_JOB_TYPE, now, options.limit ?? DEFAULT_HEALTH_CHECK_JOB_LIMIT]
  );
  summary.scanned = jobs.length;

  for (const job of jobs) {
    const startedAt = Math.floor(Date.now() / 1000);
    if (job.status === 'pending') {
      const claimed = await adapter.execute(
        "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
        [startedAt, startedAt, job.id, job.tenant_id]
      );
      if ((claimed.rowsAffected ?? 0) === 0) {
        continue;
      }
    }

    try {
      const result = await refreshTenantDatabaseHealth(env, logger, {
        ...parseHealthCheckJobConfig(job.config),
        tenantId: job.tenant_id,
        checkedAt: new Date(startedAt * 1000).toISOString(),
      });
      await adapter.execute(
        "UPDATE admin_jobs SET status = 'completed', progress = ?, result = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
        [
          JSON.stringify({
            total: result.scanned,
            processed: result.scanned,
            succeeded: result.healthy,
            failed: result.failed,
            stage: 'completed',
          }),
          JSON.stringify(result),
          startedAt,
          startedAt,
          job.id,
          job.tenant_id,
        ]
      );
      summary.completed += 1;
    } catch (error) {
      await adapter.execute(
        "UPDATE admin_jobs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
        [
          error instanceof Error ? error.message : String(error),
          startedAt,
          startedAt,
          job.id,
          job.tenant_id,
        ]
      );
      summary.failed += 1;
      logger.warn('Tenant database health-check job failed', {
        job_id: job.id,
        tenant_id: job.tenant_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summary.scanned > 0) {
    logger.info('Tenant database health-check jobs completed', { ...summary });
  }
  return summary;
}

import {
  buildTenantDatabaseStatsRecommendedAction,
  collectTenantCoreDatabaseStats,
  ensureDatabaseAdapter,
  evaluateTenantDatabaseStatsWarning,
  InternalNotificationEventRepository,
  readResponseTextWithLimit,
  resolveTenantDatabaseStatsPolicy,
  resolveTenantDatabaseSourceFromControlRegistry,
  safeFetch,
  TenantDatabaseRegistryRepository,
  type Env,
  type TenantDatabaseD1FileSizeStatus,
  type TenantDatabaseRegistryRow,
  type TenantDatabaseStatsRow,
} from '@authrim/ar-lib-core';

interface TenantDatabaseStatsJobLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TenantDatabaseStatsRefreshSummary {
  scanned: number;
  refreshed: number;
  skipped: number;
  failed: number;
  resolved: number;
}

export const DEFAULT_TENANT_DATABASE_STATS_REFRESH_INTERVAL_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const D1_DATABASE_DETAILS_RESPONSE_LIMIT_BYTES = 64 * 1024;

interface CloudflareD1DatabaseDetailsResponse {
  success?: boolean;
  result?: {
    file_size?: number | null;
  } | null;
  errors?: Array<{ message?: string }>;
}

interface D1FileSizeResult {
  bytes: number | null;
  checkedAt: string | null;
  status: TenantDatabaseD1FileSizeStatus;
}

export function isTenantDatabaseStatsRefreshDue(
  stats: Pick<TenantDatabaseStatsRow, 'stats_checked_at'> | null,
  options: { now?: Date; intervalHours?: number } = {}
): boolean {
  if (!stats?.stats_checked_at) {
    return true;
  }

  const checkedAt = new Date(stats.stats_checked_at);
  if (Number.isNaN(checkedAt.getTime())) {
    return true;
  }

  const now = options.now ?? new Date();
  const intervalHours =
    options.intervalHours ?? DEFAULT_TENANT_DATABASE_STATS_REFRESH_INTERVAL_HOURS;
  return now.getTime() - checkedAt.getTime() >= intervalHours * MS_PER_HOUR;
}

function getDeploymentTarget(env: Env): string | undefined {
  return (env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string }).AUTHRIM_DEPLOYMENT_TARGET;
}

async function listAllActiveRegistryRowsForRole(
  repository: TenantDatabaseRegistryRepository,
  role: TenantDatabaseRegistryRow['role'],
  batchSize: number
): Promise<TenantDatabaseRegistryRow[]> {
  const rows: TenantDatabaseRegistryRow[] = [];
  for (let offset = 0; ; offset += batchSize) {
    const page = await repository.listActiveRegistryRowsForRole(role, batchSize, offset);
    rows.push(...page);
    if (page.length < batchSize) {
      break;
    }
  }
  return rows;
}

function statsKey(row: TenantDatabaseRegistryRow) {
  return {
    tenant_id: row.tenant_id,
    role: row.role,
    generation: row.generation,
    shard_group: row.shard_group,
    shard_index: row.shard_index,
  };
}

function statsNotificationDeduplicationKey(
  row: TenantDatabaseRegistryRow,
  type: 'refresh_failed' | 'warning' | 'strong_warning'
): string {
  const prefix =
    type === 'refresh_failed'
      ? 'tenant_database_stats_refresh_failed'
      : 'tenant_database_stats_warning';
  const parts: Array<string | number> = [
    prefix,
    row.tenant_id,
    row.role,
    row.generation,
    row.shard_group,
    row.shard_index,
  ];
  if (type !== 'refresh_failed') {
    parts.push(type);
  }
  return parts.join(':');
}

async function enqueueTenantStatsNotification(
  repository: InternalNotificationEventRepository,
  logger: TenantDatabaseStatsJobLogger,
  input: {
    row: TenantDatabaseRegistryRow;
    eventType: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    deduplicationKey: string;
    payload: Record<string, unknown>;
    now: Date;
  }
): Promise<void> {
  try {
    await repository.enqueue({
      tenantId: input.row.tenant_id,
      category: 'tenant_database_stats',
      eventType: input.eventType,
      severity: input.severity,
      deduplicationKey: input.deduplicationKey,
      reopenSuppressed: true,
      payload: {
        tenant_id: input.row.tenant_id,
        role: input.row.role,
        generation: input.row.generation,
        shard_group: input.row.shard_group,
        shard_index: input.row.shard_index,
        ...input.payload,
      },
      now: input.now,
    });
  } catch (error) {
    logger.warn('Tenant database stats notification enqueue failed', {
      tenant_id: input.row.tenant_id,
      event_type: input.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getCloudflareAccountId(env: Env): string | null {
  return env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || null;
}

function getCloudflareD1ApiToken(env: Env): string | null {
  return env.CLOUDFLARE_D1_API_TOKEN || env.CLOUDFLARE_API_TOKEN || null;
}

export async function fetchCloudflareD1DatabaseFileSize(
  env: Env,
  databaseId: string,
  checkedAt: string
): Promise<D1FileSizeResult> {
  const accountId = getCloudflareAccountId(env);
  const token = getCloudflareD1ApiToken(env);
  if (!accountId || !token) {
    return {
      bytes: null,
      checkedAt: null,
      status: 'unknown',
    };
  }

  const response = await safeFetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`,
    {
      method: 'GET',
      maxResponseSize: D1_DATABASE_DETAILS_RESPONSE_LIMIT_BYTES,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const body = (JSON.parse(
    await readResponseTextWithLimit(response, D1_DATABASE_DETAILS_RESPONSE_LIMIT_BYTES)
  ) ?? null) as CloudflareD1DatabaseDetailsResponse | null;

  if (!response.ok || !body?.success) {
    const message = body?.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join('; ');
    throw new Error(message || `cloudflare_d1_details_failed:${response.status}`);
  }

  return {
    bytes: typeof body.result?.file_size === 'number' ? body.result.file_size : null,
    checkedAt,
    status: 'fresh',
  };
}

async function resolveD1FileSizeForStats(
  env: Env,
  row: TenantDatabaseRegistryRow,
  existing: TenantDatabaseStatsRow | null,
  checkedAt: string
): Promise<D1FileSizeResult> {
  if (!row.database_id) {
    return {
      bytes: existing?.d1_file_size_bytes ?? null,
      checkedAt: existing?.d1_file_size_checked_at ?? null,
      status: existing?.d1_file_size_bytes == null ? 'unknown' : 'stale',
    };
  }

  try {
    const fetched = await fetchCloudflareD1DatabaseFileSize(env, row.database_id, checkedAt);
    if (fetched.status === 'fresh') {
      return fetched;
    }
  } catch {
    // Preserve the last known D1 file size below. The scheduled job itself should still
    // refresh account metrics even when Cloudflare's account API is temporarily unavailable.
  }

  return {
    bytes: existing?.d1_file_size_bytes ?? null,
    checkedAt: existing?.d1_file_size_checked_at ?? null,
    status: existing?.d1_file_size_bytes == null ? 'unavailable' : 'stale',
  };
}

export async function refreshTenantDatabaseStats(
  env: Env,
  logger: TenantDatabaseStatsJobLogger,
  options: {
    limit?: number;
    now?: Date;
    force?: boolean;
    intervalHours?: number;
  } = {}
): Promise<TenantDatabaseStatsRefreshSummary> {
  const controlAdapter = ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-database-stats-control');
  const repository = new TenantDatabaseRegistryRepository(controlAdapter);
  const notificationRepository = new InternalNotificationEventRepository(controlAdapter);
  const rows = await listAllActiveRegistryRowsForRole(
    repository,
    'tenant_core',
    options.limit ?? 25
  );
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const summary: TenantDatabaseStatsRefreshSummary = {
    scanned: rows.length,
    refreshed: 0,
    skipped: 0,
    failed: 0,
    resolved: 0,
  };

  for (const row of rows) {
    try {
      const existing = await repository.getStats(statsKey(row));
      if (
        !options.force &&
        !isTenantDatabaseStatsRefreshDue(existing, {
          now,
          intervalHours: options.intervalHours,
        })
      ) {
        summary.skipped += 1;
        continue;
      }

      const resolved = await resolveTenantDatabaseSourceFromControlRegistry(
        env,
        {
          tenantId: row.tenant_id,
          role: 'tenant_core',
          shardGroup: row.shard_group,
          shardIndex: row.shard_index,
          deploymentTarget: getDeploymentTarget(env),
        },
        repository
      );
      const stats = await collectTenantCoreDatabaseStats(
        ensureDatabaseAdapter(resolved.source, 'tenant-database-stats-tenant-core'),
        row.tenant_id,
        { checkedAt }
      );
      const d1FileSize = await resolveD1FileSizeForStats(env, row, existing, checkedAt);
      const warning = evaluateTenantDatabaseStatsWarning({
        accountCount: stats.accountCount,
        d1FileSizeBytes: d1FileSize.bytes,
      });
      const statsPolicy = resolveTenantDatabaseStatsPolicy({ warning });

      await repository.upsertStats({
        ...statsKey(row),
        account_count: stats.accountCount,
        active_user_count: stats.activeUserCount,
        active_pending_user_count: stats.activePendingUserCount,
        d1_file_size_bytes: d1FileSize.bytes,
        d1_file_size_checked_at: d1FileSize.checkedAt,
        d1_file_size_status: d1FileSize.status,
        row_count_estimate_json: JSON.stringify(stats.rowCountEstimates),
        warning_state: warning.state,
        warning_reasons_json: JSON.stringify(warning.reasons),
        stats_checked_at: checkedAt,
      });
      const resolvedKeys = [statsNotificationDeduplicationKey(row, 'refresh_failed')];
      if (warning.state !== 'warning') {
        resolvedKeys.push(statsNotificationDeduplicationKey(row, 'warning'));
      }
      if (warning.state !== 'strong_warning') {
        resolvedKeys.push(statsNotificationDeduplicationKey(row, 'strong_warning'));
      }
      summary.resolved += await notificationRepository.suppressResolvedByDeduplicationKeys(
        resolvedKeys,
        now
      );
      if (warning.state !== 'ok') {
        await enqueueTenantStatsNotification(notificationRepository, logger, {
          row,
          eventType: 'tenant_database.stats.warning',
          severity: warning.state === 'strong_warning' ? 'high' : 'medium',
          deduplicationKey: statsNotificationDeduplicationKey(row, warning.state),
          payload: {
            warning_state: warning.state,
            warning_reasons: warning.reasons,
            storage_ratio: warning.storageRatio,
            account_count: stats.accountCount,
            d1_file_size_bytes: d1FileSize.bytes,
            d1_file_size_status: d1FileSize.status,
            stats_checked_at: checkedAt,
            stats_policy: statsPolicy,
            recommended_action: buildTenantDatabaseStatsRecommendedAction({ warning }),
          },
          now,
        });
      }
      summary.refreshed += 1;
    } catch (error) {
      summary.failed += 1;
      await enqueueTenantStatsNotification(notificationRepository, logger, {
        row,
        eventType: 'tenant_database.stats.refresh_failed',
        severity: 'high',
        deduplicationKey: statsNotificationDeduplicationKey(row, 'refresh_failed'),
        payload: {
          error: error instanceof Error ? error.message : String(error),
          stats_checked_at: checkedAt,
        },
        now,
      });
      logger.warn('Tenant database stats refresh failed', {
        tenant_id: row.tenant_id,
        role: row.role,
        generation: row.generation,
        error: String(error),
      });
    }
  }

  if (summary.scanned > 0) {
    logger.info('Tenant database stats refresh completed', { ...summary });
  }

  return summary;
}

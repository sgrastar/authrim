import type { DatabaseAdapter } from '../db/adapter';

export interface TenantCoreDatabaseStats {
  tenantId: string;
  accountCount: number;
  activeUserCount: number;
  activePendingUserCount: number;
  rowCountEstimates: Record<string, number>;
  checkedAt: string;
}

export interface TenantDatabaseStatsWarning {
  state: 'ok' | 'warning' | 'strong_warning';
  reasons: string[];
  storageRatio: number | null;
}

export type TenantDatabaseSizeClass = 'small' | 'warning' | 'strong_warning';
export type TenantDatabaseWarningActionMode = 'none' | 'operator_job_recommended' | 'auto_job';

export interface TenantDatabaseStatsPolicy {
  sizeClass: TenantDatabaseSizeClass;
  refreshIntervalHours: number;
  staleAfterHours: number;
  warningActionMode: TenantDatabaseWarningActionMode;
  thresholdInputs: {
    queryLatencyP95Ms?: number | null;
    writeContentionRate?: number | null;
    migrationDurationSeconds?: number | null;
    regionalAccessSkewRatio?: number | null;
  };
}

export interface TenantDatabaseStatsRecommendedAction {
  mode: TenantDatabaseWarningActionMode;
  jobType: 'tenant-database/plan-upgrade' | null;
  reason: string | null;
}

export const DEFAULT_D1_MAX_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_TENANT_ACCOUNT_WARNING_THRESHOLD = 700_000;
export const DEFAULT_TENANT_ACCOUNT_STRONG_WARNING_THRESHOLD = 800_000;
export const DEFAULT_TENANT_STORAGE_WARNING_RATIO = 0.7;
export const DEFAULT_TENANT_STORAGE_STRONG_WARNING_RATIO = 0.8;
export const DEFAULT_TENANT_DATABASE_STATS_STALE_AFTER_HOURS = 36;

const ACTIVE_PENDING_LIFECYCLE_STATES = [
  'active',
  'invited',
  'pending_verification',
  'provisioning',
  'incomplete',
] as const;

function normalizeCount(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim()) {
    return Number(value);
  }
  return 0;
}

export function evaluateTenantDatabaseStatsWarning(
  stats: {
    accountCount?: number | null;
    d1FileSizeBytes?: number | null;
  },
  options: {
    warningAccountThreshold?: number;
    strongWarningAccountThreshold?: number;
    warningStorageRatio?: number;
    strongWarningStorageRatio?: number;
    maxD1SizeBytes?: number;
  } = {}
): TenantDatabaseStatsWarning {
  const warningAccountThreshold =
    options.warningAccountThreshold ?? DEFAULT_TENANT_ACCOUNT_WARNING_THRESHOLD;
  const strongWarningAccountThreshold =
    options.strongWarningAccountThreshold ?? DEFAULT_TENANT_ACCOUNT_STRONG_WARNING_THRESHOLD;
  const warningStorageRatio = options.warningStorageRatio ?? DEFAULT_TENANT_STORAGE_WARNING_RATIO;
  const strongWarningStorageRatio =
    options.strongWarningStorageRatio ?? DEFAULT_TENANT_STORAGE_STRONG_WARNING_RATIO;
  const maxD1SizeBytes = options.maxD1SizeBytes ?? DEFAULT_D1_MAX_SIZE_BYTES;
  const accountCount = stats.accountCount ?? null;
  const d1FileSizeBytes = stats.d1FileSizeBytes ?? null;
  const storageRatio =
    d1FileSizeBytes === null || maxD1SizeBytes <= 0 ? null : d1FileSizeBytes / maxD1SizeBytes;
  const reasons: string[] = [];
  let state: TenantDatabaseStatsWarning['state'] = 'ok';

  if (accountCount !== null && accountCount >= strongWarningAccountThreshold) {
    state = 'strong_warning';
    reasons.push('account_count_strong_threshold');
  } else if (accountCount !== null && accountCount >= warningAccountThreshold) {
    state = 'warning';
    reasons.push('account_count_warning_threshold');
  }

  if (storageRatio !== null && storageRatio >= strongWarningStorageRatio) {
    state = 'strong_warning';
    reasons.push('storage_ratio_strong_threshold');
  } else if (storageRatio !== null && storageRatio >= warningStorageRatio) {
    if (state !== 'strong_warning') {
      state = 'warning';
    }
    reasons.push('storage_ratio_warning_threshold');
  }

  return {
    state,
    reasons,
    storageRatio,
  };
}

export function classifyTenantDatabaseSize(
  warning: TenantDatabaseStatsWarning
): TenantDatabaseSizeClass {
  return warning.state === 'ok' ? 'small' : warning.state;
}

export function resolveTenantDatabaseStatsPolicy(options: {
  warning: TenantDatabaseStatsWarning;
  enableVariableFrequency?: boolean;
  warningActionMode?: TenantDatabaseWarningActionMode;
  thresholdInputs?: TenantDatabaseStatsPolicy['thresholdInputs'];
}): TenantDatabaseStatsPolicy {
  const sizeClass = classifyTenantDatabaseSize(options.warning);
  const refreshIntervalHours = !options.enableVariableFrequency
    ? 24
    : sizeClass === 'strong_warning'
      ? 6
      : sizeClass === 'warning'
        ? 12
        : 24;
  return {
    sizeClass,
    refreshIntervalHours,
    staleAfterHours:
      sizeClass === 'strong_warning' && options.enableVariableFrequency
        ? 18
        : DEFAULT_TENANT_DATABASE_STATS_STALE_AFTER_HOURS,
    warningActionMode: options.warningActionMode ?? 'none',
    thresholdInputs: {
      queryLatencyP95Ms: null,
      writeContentionRate: null,
      migrationDurationSeconds: null,
      regionalAccessSkewRatio: null,
      ...options.thresholdInputs,
    },
  };
}

export function buildTenantDatabaseStatsRecommendedAction(options: {
  warning: TenantDatabaseStatsWarning;
  mode?: TenantDatabaseWarningActionMode;
}): TenantDatabaseStatsRecommendedAction {
  const mode = options.mode ?? 'none';
  if (options.warning.state === 'ok' || mode === 'none') {
    return { mode, jobType: null, reason: null };
  }
  return {
    mode,
    jobType: 'tenant-database/plan-upgrade',
    reason: options.warning.reasons.join(','),
  };
}

async function queryCount(
  adapter: DatabaseAdapter,
  sql: string,
  params: unknown[]
): Promise<number> {
  const row = await adapter.queryOne<{ count: number | string | bigint | null }>(sql, params);
  return normalizeCount(row?.count);
}

/**
 * Collects capacity stats from the tenant core database.
 *
 * `accountCount` intentionally counts every `users_core` row for the tenant. Purged users should
 * no longer have a core row, while soft-deleted or PII-deleted accounts still consume tenant DB
 * capacity and must remain part of D1-size warning thresholds.
 */
export async function collectTenantCoreDatabaseStats(
  adapter: DatabaseAdapter,
  tenantId: string,
  options: { checkedAt?: string } = {}
): Promise<TenantCoreDatabaseStats> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const accountCount = await queryCount(
    adapter,
    'SELECT COUNT(*) AS count FROM users_core WHERE tenant_id = ?',
    [tenantId]
  );
  const activeUserCount = await queryCount(
    adapter,
    `SELECT COUNT(*) AS count
       FROM users_core
      WHERE tenant_id = ?
        AND is_active = 1
        AND status = 'active'
        AND lifecycle_state = 'active'`,
    [tenantId]
  );
  const activePendingUserCount = await queryCount(
    adapter,
    `SELECT COUNT(*) AS count
       FROM users_core
      WHERE tenant_id = ?
        AND is_active = 1
        AND status = 'active'
        AND lifecycle_state IN (${ACTIVE_PENDING_LIFECYCLE_STATES.map(() => '?').join(', ')})`,
    [tenantId, ...ACTIVE_PENDING_LIFECYCLE_STATES]
  );

  return {
    tenantId,
    accountCount,
    activeUserCount,
    activePendingUserCount,
    rowCountEstimates: {
      users_core: accountCount,
    },
    checkedAt,
  };
}

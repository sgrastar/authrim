import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  buildTenantDatabaseStatsRecommendedAction,
  collectTenantCoreDatabaseStats,
  evaluateTenantDatabaseStatsWarning,
  resolveTenantDatabaseStatsPolicy,
} from '../tenant-database-stats';

function createAdapter(counts: Array<number | string | bigint>): DatabaseAdapter {
  const queryOne = vi.fn(async () => ({ count: counts.shift() ?? 0 }));
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne,
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 0 }),
    transaction: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
  };
}

describe('tenant database stats', () => {
  it('counts all non-purged users for account capacity warnings', async () => {
    const adapter = createAdapter([10, 7, 9]);

    const stats = await collectTenantCoreDatabaseStats(adapter, 'tenant-a', {
      checkedAt: '2026-05-16T00:00:00.000Z',
    });

    expect(stats).toEqual({
      tenantId: 'tenant-a',
      accountCount: 10,
      activeUserCount: 7,
      activePendingUserCount: 9,
      rowCountEstimates: {
        identity_accounts: 10,
      },
      checkedAt: '2026-05-16T00:00:00.000Z',
    });
    expect(adapter.queryOne).toHaveBeenNthCalledWith(
      1,
      'SELECT COUNT(*) AS count FROM identity_accounts WHERE tenant_id = ?',
      ['tenant-a']
    );
  });

  it('uses active and active-plus-pending lifecycle filters for dashboard metrics', async () => {
    const adapter = createAdapter([100n, '80', 90]);

    await collectTenantCoreDatabaseStats(adapter, 'tenant-a');

    expect(adapter.queryOne).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("lifecycle_state = 'active'"),
      ['tenant-a']
    );
    expect(adapter.queryOne).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('lifecycle_state IN (?, ?, ?, ?, ?)'),
      ['tenant-a', 'active', 'invited', 'pending_verification', 'provisioning', 'incomplete']
    );
  });

  it('evaluates capacity warning thresholds for scheduled stats jobs', () => {
    expect(evaluateTenantDatabaseStatsWarning({ accountCount: 699_999 }).state).toBe('ok');
    expect(evaluateTenantDatabaseStatsWarning({ accountCount: 700_000 })).toMatchObject({
      state: 'warning',
      reasons: ['account_count_warning_threshold'],
    });
    expect(
      evaluateTenantDatabaseStatsWarning({
        accountCount: 800_000,
        d1FileSizeBytes: 8 * 1024 * 1024 * 1024,
      })
    ).toMatchObject({
      state: 'strong_warning',
      reasons: ['account_count_strong_threshold', 'storage_ratio_strong_threshold'],
    });
  });

  it('reserves variable refresh policy and warning-to-job action metadata', () => {
    const warning = evaluateTenantDatabaseStatsWarning({ accountCount: 750_000 });

    expect(resolveTenantDatabaseStatsPolicy({ warning })).toEqual({
      sizeClass: 'warning',
      refreshIntervalHours: 24,
      staleAfterHours: 36,
      warningActionMode: 'none',
      thresholdInputs: {
        queryLatencyP95Ms: null,
        writeContentionRate: null,
        migrationDurationSeconds: null,
        regionalAccessSkewRatio: null,
      },
    });
    expect(
      resolveTenantDatabaseStatsPolicy({ warning, enableVariableFrequency: true })
    ).toMatchObject({
      sizeClass: 'warning',
      refreshIntervalHours: 12,
    });
    expect(
      buildTenantDatabaseStatsRecommendedAction({
        warning,
        mode: 'operator_job_recommended',
      })
    ).toEqual({
      mode: 'operator_job_recommended',
      jobType: 'tenant-database/plan-upgrade',
      reason: 'account_count_warning_threshold',
    });
  });
});

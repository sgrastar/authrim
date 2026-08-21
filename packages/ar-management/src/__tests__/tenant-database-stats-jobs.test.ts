import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCollectTenantCoreDatabaseStats,
  mockEnsureDatabaseAdapter,
  mockEvaluateTenantDatabaseStatsWarning,
  mockNotificationRepository,
  mockRepository,
  mockResolveTenantDatabaseSourceFromControlRegistry,
  MockInternalNotificationEventRepository,
  MockTenantDatabaseRegistryRepository,
} = vi.hoisted(() => {
  const repository = {
    listActiveRegistryRowsForRole: vi.fn(),
    getStats: vi.fn(),
    upsertStats: vi.fn(),
  };
  const notificationRepository = {
    enqueue: vi.fn(),
    suppressResolvedByDeduplicationKeys: vi.fn(),
  };
  function MockRepositoryConstructor() {
    return repository;
  }
  function MockNotificationRepositoryConstructor() {
    return notificationRepository;
  }
  return {
    mockCollectTenantCoreDatabaseStats: vi.fn(),
    mockEnsureDatabaseAdapter: vi.fn((source: unknown) => source),
    mockEvaluateTenantDatabaseStatsWarning: vi.fn(),
    mockNotificationRepository: notificationRepository,
    mockRepository: repository,
    mockResolveTenantDatabaseSourceFromControlRegistry: vi.fn(),
    MockInternalNotificationEventRepository: vi.fn(MockNotificationRepositoryConstructor),
    MockTenantDatabaseRegistryRepository: vi.fn(MockRepositoryConstructor),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    collectTenantCoreDatabaseStats: mockCollectTenantCoreDatabaseStats,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
    evaluateTenantDatabaseStatsWarning: mockEvaluateTenantDatabaseStatsWarning,
    InternalNotificationEventRepository: MockInternalNotificationEventRepository,
    resolveTenantDatabaseSourceFromControlRegistry:
      mockResolveTenantDatabaseSourceFromControlRegistry,
    TenantDatabaseRegistryRepository: MockTenantDatabaseRegistryRepository,
  };
});

import {
  DEFAULT_TENANT_DATABASE_STATS_REFRESH_INTERVAL_HOURS,
  fetchCloudflareD1DatabaseFileSize,
  isTenantDatabaseStatsRefreshDue,
  refreshTenantDatabaseStats,
} from '../tenant-database-stats-jobs';

describe('tenant database stats jobs', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([]);
    mockRepository.getStats.mockResolvedValue(null);
    mockRepository.upsertStats.mockResolvedValue({});
    mockNotificationRepository.enqueue.mockResolvedValue({});
    mockNotificationRepository.suppressResolvedByDeduplicationKeys.mockResolvedValue(0);
    mockResolveTenantDatabaseSourceFromControlRegistry.mockResolvedValue({
      source: 'tenant-source',
    });
    mockCollectTenantCoreDatabaseStats.mockResolvedValue({
      tenantId: 'tenant-a',
      accountCount: 700000,
      activeUserCount: 650000,
      activePendingUserCount: 675000,
      rowCountEstimates: { identity_accounts: 700000 },
      checkedAt: '2026-05-16T00:00:00.000Z',
    });
    mockEvaluateTenantDatabaseStatsWarning.mockReturnValue({
      state: 'warning',
      reasons: ['account_count_warning_threshold'],
      storageRatio: null,
    });
  });

  it('uses a 24 hour first implementation refresh interval', () => {
    expect(DEFAULT_TENANT_DATABASE_STATS_REFRESH_INTERVAL_HOURS).toBe(24);
    expect(
      isTenantDatabaseStatsRefreshDue(
        { stats_checked_at: '2026-05-15T00:00:01.000Z' },
        { now: new Date('2026-05-16T00:00:00.000Z') }
      )
    ).toBe(false);
    expect(
      isTenantDatabaseStatsRefreshDue(
        { stats_checked_at: '2026-05-15T00:00:00.000Z' },
        { now: new Date('2026-05-16T00:00:00.000Z') }
      )
    ).toBe(true);
  });

  it('refreshes due tenant core stats and stores warning state in the control DB', async () => {
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        shard_group: 'default',
        shard_index: 0,
        database_id: 'd1-db-id',
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { file_size: 8_000_000_000 } }), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const summary = await refreshTenantDatabaseStats(
      {
        DB_ADMIN: 'control-db',
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_D1_API_TOKEN: 'd1-token',
      } as never,
      logger,
      {
        now: new Date('2026-05-16T00:00:00.000Z'),
      }
    );

    expect(summary).toEqual({ scanned: 1, refreshed: 1, skipped: 0, failed: 0, resolved: 0 });
    expect(mockRepository.listActiveRegistryRowsForRole).toHaveBeenCalledWith('tenant_core', 25, 0);
    expect(mockCollectTenantCoreDatabaseStats).toHaveBeenCalledWith('tenant-source', 'tenant-a', {
      checkedAt: '2026-05-16T00:00:00.000Z',
    });
    expect(mockRepository.upsertStats).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        account_count: 700000,
        active_user_count: 650000,
        active_pending_user_count: 675000,
        d1_file_size_bytes: 8_000_000_000,
        d1_file_size_checked_at: '2026-05-16T00:00:00.000Z',
        d1_file_size_status: 'fresh',
        row_count_estimate_json: '{"identity_accounts":700000}',
        warning_state: 'warning',
        warning_reasons_json: '["account_count_warning_threshold"]',
        stats_checked_at: '2026-05-16T00:00:00.000Z',
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/d1-db-id',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer d1-token',
        }),
      })
    );
    expect(mockEvaluateTenantDatabaseStatsWarning).toHaveBeenCalledWith({
      accountCount: 700000,
      d1FileSizeBytes: 8_000_000_000,
    });
    expect(mockNotificationRepository.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        category: 'tenant_database_stats',
        eventType: 'tenant_database.stats.warning',
        severity: 'medium',
        deduplicationKey: 'tenant_database_stats_warning:tenant-a:tenant_core:2:default:0:warning',
        payload: expect.objectContaining({
          warning_state: 'warning',
          warning_reasons: ['account_count_warning_threshold'],
          account_count: 700000,
          d1_file_size_bytes: 8_000_000_000,
          stats_policy: expect.objectContaining({
            sizeClass: 'warning',
            refreshIntervalHours: 24,
            warningActionMode: 'none',
          }),
          recommended_action: {
            mode: 'none',
            jobType: null,
            reason: null,
          },
          stats_checked_at: '2026-05-16T00:00:00.000Z',
        }),
      })
    );
    expect(mockNotificationRepository.suppressResolvedByDeduplicationKeys).toHaveBeenCalledWith(
      [
        'tenant_database_stats_refresh_failed:tenant-a:tenant_core:2:default:0',
        'tenant_database_stats_warning:tenant-a:tenant_core:2:default:0:strong_warning',
      ],
      new Date('2026-05-16T00:00:00.000Z')
    );
  });

  it('preserves the last known D1 file size as stale when the D1 API fetch fails', async () => {
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        shard_group: 'default',
        shard_index: 0,
        database_id: 'd1-db-id',
      },
    ]);
    mockRepository.getStats.mockResolvedValue({
      stats_checked_at: '2026-05-14T00:00:00.000Z',
      d1_file_size_bytes: 7_000_000_000,
      d1_file_size_checked_at: '2026-05-14T00:00:00.000Z',
      d1_file_size_status: 'fresh',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, errors: [{ message: 'rate limited' }] }), {
          status: 429,
        })
      )
    );

    await refreshTenantDatabaseStats(
      {
        DB_ADMIN: 'control-db',
        CLOUDFLARE_ACCOUNT_ID: 'account-id',
        CLOUDFLARE_D1_API_TOKEN: 'd1-token',
      } as never,
      logger,
      { now: new Date('2026-05-16T00:00:00.000Z') }
    );

    expect(mockRepository.upsertStats).toHaveBeenCalledWith(
      expect.objectContaining({
        d1_file_size_bytes: 7_000_000_000,
        d1_file_size_checked_at: '2026-05-14T00:00:00.000Z',
        d1_file_size_status: 'stale',
      })
    );
  });

  it('enqueues an internal notification when tenant stats refresh fails', async () => {
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        shard_group: 'default',
        shard_index: 0,
        database_id: 'd1-db-id',
      },
    ]);
    mockResolveTenantDatabaseSourceFromControlRegistry.mockRejectedValue(
      new Error('missing_binding')
    );

    const summary = await refreshTenantDatabaseStats(
      {
        DB_ADMIN: 'control-db',
      } as never,
      logger,
      { now: new Date('2026-05-16T00:00:00.000Z') }
    );

    expect(summary).toEqual({ scanned: 1, refreshed: 0, skipped: 0, failed: 1, resolved: 0 });
    expect(mockNotificationRepository.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        category: 'tenant_database_stats',
        eventType: 'tenant_database.stats.refresh_failed',
        severity: 'high',
        deduplicationKey: 'tenant_database_stats_refresh_failed:tenant-a:tenant_core:2:default:0',
        payload: expect.objectContaining({
          error: 'missing_binding',
          stats_checked_at: '2026-05-16T00:00:00.000Z',
        }),
      })
    );
  });

  it('resolves stale failure and warning notifications after a healthy refresh', async () => {
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        shard_group: 'default',
        shard_index: 0,
        database_id: 'd1-db-id',
      },
    ]);
    mockEvaluateTenantDatabaseStatsWarning.mockReturnValue({
      state: 'ok',
      reasons: [],
      storageRatio: null,
    });
    mockNotificationRepository.suppressResolvedByDeduplicationKeys.mockResolvedValue(3);

    const summary = await refreshTenantDatabaseStats({ DB_ADMIN: 'control-db' } as never, logger, {
      now: new Date('2026-05-16T00:00:00.000Z'),
    });

    expect(summary).toEqual({ scanned: 1, refreshed: 1, skipped: 0, failed: 0, resolved: 3 });
    expect(mockNotificationRepository.suppressResolvedByDeduplicationKeys).toHaveBeenCalledWith(
      [
        'tenant_database_stats_refresh_failed:tenant-a:tenant_core:2:default:0',
        'tenant_database_stats_warning:tenant-a:tenant_core:2:default:0:warning',
        'tenant_database_stats_warning:tenant-a:tenant_core:2:default:0:strong_warning',
      ],
      new Date('2026-05-16T00:00:00.000Z')
    );
    expect(mockNotificationRepository.enqueue).not.toHaveBeenCalled();
  });

  it('fetches D1 file size from the Cloudflare account D1 API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, result: { file_size: 1234 } }), {
          status: 200,
        })
      )
    );

    await expect(
      fetchCloudflareD1DatabaseFileSize(
        {
          CLOUDFLARE_ACCOUNT_ID: 'account-id',
          CLOUDFLARE_D1_API_TOKEN: 'd1-token',
        } as never,
        'd1-db-id',
        '2026-05-16T00:00:00.000Z'
      )
    ).resolves.toEqual({
      bytes: 1234,
      checkedAt: '2026-05-16T00:00:00.000Z',
      status: 'fresh',
    });
  });
});

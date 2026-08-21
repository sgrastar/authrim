import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCheckResolvedTenantDatabaseDeepHealth,
  mockEnsureDatabaseAdapter,
  mockRepository,
  mockResolveTenantDatabaseSourceFromControlRegistry,
  MockTenantDatabaseRegistryRepository,
} = vi.hoisted(() => {
  const repository = {
    listActiveRegistryRowsForRole: vi.fn(),
    listActiveRegistryRowsForTenantRole: vi.fn(),
    updateRegistryStatus: vi.fn(),
    updateRegistryStatusAndMetadata: vi.fn(),
  };
  function MockRepositoryConstructor() {
    return repository;
  }
  return {
    mockCheckResolvedTenantDatabaseDeepHealth: vi.fn(),
    mockEnsureDatabaseAdapter: vi.fn((source: unknown) => source),
    mockRepository: repository,
    mockResolveTenantDatabaseSourceFromControlRegistry: vi.fn(),
    MockTenantDatabaseRegistryRepository: vi.fn(MockRepositoryConstructor),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    checkResolvedTenantDatabaseDeepHealth: mockCheckResolvedTenantDatabaseDeepHealth,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
    resolveTenantDatabaseSourceFromControlRegistry:
      mockResolveTenantDatabaseSourceFromControlRegistry,
    TenantDatabaseRegistryRepository: MockTenantDatabaseRegistryRepository,
  };
});

import {
  processPendingTenantDatabaseHealthCheckJobs,
  refreshTenantDatabaseHealth,
} from '../tenant-database-health-jobs';

describe('tenant database health jobs', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValue([]);
    mockRepository.listActiveRegistryRowsForTenantRole.mockResolvedValue([]);
    mockRepository.updateRegistryStatus.mockResolvedValue(undefined);
    mockRepository.updateRegistryStatusAndMetadata.mockResolvedValue(undefined);
    mockResolveTenantDatabaseSourceFromControlRegistry.mockResolvedValue({
      source: 'tenant-source',
    });
    mockCheckResolvedTenantDatabaseDeepHealth.mockResolvedValue({
      severity: 'healthy',
      schemaDrift: 'none',
    });
  });

  it('skips health refresh when DB_ADMIN is not configured', async () => {
    const summary = await refreshTenantDatabaseHealth({} as never, logger);

    expect(summary).toEqual({ scanned: 0, healthy: 0, degraded: 0, failed: 0, skipped: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Tenant database health refresh skipped because DB_ADMIN is not configured'
    );
  });

  it('marks degraded and failed tenant databases in the registry', async () => {
    mockRepository.listActiveRegistryRowsForRole
      .mockResolvedValueOnce([
        {
          tenant_id: 'tenant-a',
          role: 'tenant_core',
          generation: 2,
          shard_group: 'default',
          shard_index: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          tenant_id: 'tenant-b',
          role: 'tenant_pii',
          generation: 1,
          shard_group: 'default',
          shard_index: 0,
        },
      ]);
    mockCheckResolvedTenantDatabaseDeepHealth
      .mockResolvedValueOnce({
        severity: 'degraded',
        schemaDrift: 'ahead_of_registry',
        error: 'tenant_database_schema_version_ahead:88>87',
      })
      .mockResolvedValueOnce({
        severity: 'failed',
        schemaDrift: 'behind_registry',
        error: 'tenant_database_schema_version_too_old:86<87',
      });

    const summary = await refreshTenantDatabaseHealth({ DB_ADMIN: 'control-db' } as never, logger, {
      checkedAt: '2026-05-16T00:00:00.000Z',
    });

    expect(summary).toEqual({ scanned: 2, healthy: 0, degraded: 1, failed: 1, skipped: 0 });
    expect(mockRepository.updateRegistryStatusAndMetadata).toHaveBeenNthCalledWith(
      1,
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        shard_group: 'default',
        shard_index: 0,
      },
      'degraded',
      expect.stringContaining('"last_schema_drift":"ahead_of_registry"'),
      'tenant-database-health'
    );
    expect(mockRepository.updateRegistryStatusAndMetadata).toHaveBeenNthCalledWith(
      2,
      {
        tenant_id: 'tenant-b',
        role: 'tenant_pii',
        generation: 1,
        shard_group: 'default',
        shard_index: 0,
      },
      'failed',
      expect.stringContaining('"last_schema_drift":"behind_registry"'),
      'tenant-database-health'
    );
  });

  it('keeps transient health failures degraded until the configured threshold', async () => {
    mockRepository.listActiveRegistryRowsForRole
      .mockResolvedValueOnce([
        {
          tenant_id: 'tenant-a',
          role: 'tenant_core',
          generation: 2,
          shard_group: 'default',
          shard_index: 0,
          metadata_json: JSON.stringify({ health_failure_count: 1 }),
        },
      ])
      .mockResolvedValueOnce([]);
    mockCheckResolvedTenantDatabaseDeepHealth.mockResolvedValueOnce({
      severity: 'failed',
      schemaDrift: 'unknown',
      error: 'database_unhealthy',
    });

    const summary = await refreshTenantDatabaseHealth({ DB_ADMIN: 'control-db' } as never, logger, {
      checkedAt: '2026-05-16T00:00:00.000Z',
      failureThreshold: 3,
    });

    expect(summary).toEqual({ scanned: 1, healthy: 0, degraded: 1, failed: 0, skipped: 0 });
    expect(mockRepository.updateRegistryStatusAndMetadata).toHaveBeenCalledWith(
      {
        tenant_id: 'tenant-a',
        role: 'tenant_core',
        generation: 2,
        shard_group: 'default',
        shard_index: 0,
      },
      'degraded',
      expect.stringContaining('"health_failure_count":2'),
      'tenant-database-health'
    );
  });

  it('leaves a healthy database pending until its failed snapshot is republished', async () => {
    mockRepository.listActiveRegistryRowsForRole
      .mockResolvedValueOnce([
        {
          tenant_id: 'tenant-a',
          role: 'tenant_core',
          generation: 2,
          shard_group: 'default',
          shard_index: 0,
          status: 'degraded_pending_snapshot',
          metadata_json: JSON.stringify({
            control_data_role: 'tenant_core/default',
            snapshot_publish_error: 'kv_unavailable',
          }),
        },
      ])
      .mockResolvedValueOnce([]);

    const summary = await refreshTenantDatabaseHealth({ DB_ADMIN: 'control-db' } as never, logger, {
      checkedAt: '2026-05-16T00:00:00.000Z',
    });

    expect(summary).toEqual({ scanned: 1, healthy: 1, degraded: 0, failed: 0, skipped: 0 });
    expect(mockRepository.updateRegistryStatus).not.toHaveBeenCalled();
    expect(mockRepository.updateRegistryStatusAndMetadata).not.toHaveBeenCalled();
  });

  it('processes pending operator-requested deep health-check jobs', async () => {
    const adapter = {
      query: vi.fn().mockResolvedValueOnce([
        {
          id: 'tenant-db-health:tenant-a:1',
          tenant_id: 'tenant-a',
          status: 'pending',
          config: JSON.stringify({ roles: ['tenant_core'] }),
        },
      ]),
      execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    };
    mockRepository.listActiveRegistryRowsForRole.mockResolvedValueOnce([]);

    const summary = await processPendingTenantDatabaseHealthCheckJobs(
      { DB_ADMIN: adapter } as never,
      logger,
      { now: 1_779_000_000 }
    );

    expect(summary).toEqual({ scanned: 1, completed: 1, failed: 0 });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE admin_jobs SET status = 'processing'"),
      expect.arrayContaining([
        expect.any(Number),
        expect.any(Number),
        'tenant-db-health:tenant-a:1',
      ])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE admin_jobs SET status = 'completed'"),
      expect.arrayContaining([
        expect.stringContaining('"stage":"completed"'),
        expect.stringContaining('"scanned":0'),
        expect.any(Number),
        expect.any(Number),
        'tenant-db-health:tenant-a:1',
        'tenant-a',
      ])
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const {
  mockResolveAuthCorePersistenceAdapterFromEnv,
  mockEnsureDatabaseAdapter,
  mockAdapter,
  mockTx,
  mockControlAdapter,
  mockControlTx,
  mockDisableTenantLookupDirectory,
  mockPublishTenantRuntimeRegistryRouteState,
  mockPurgeTenantAuthoritativeShards,
} = vi.hoisted(() => {
  const tx = {
    execute: vi.fn(),
  };
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (callback: (tx: Pick<DatabaseAdapter, 'execute'>) => Promise<void>) =>
      callback(tx)
    ),
  };
  const controlTx = {
    execute: vi.fn(),
  };
  const controlAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (callback: (tx: Pick<DatabaseAdapter, 'execute'>) => Promise<void>) =>
      callback(controlTx)
    ),
  };

  return {
    mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue(adapter),
    mockEnsureDatabaseAdapter: vi.fn().mockReturnValue(controlAdapter),
    mockAdapter: adapter,
    mockTx: tx,
    mockControlAdapter: controlAdapter,
    mockControlTx: controlTx,
    mockDisableTenantLookupDirectory: vi.fn(),
    mockPublishTenantRuntimeRegistryRouteState: vi.fn(),
    mockPurgeTenantAuthoritativeShards: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
    resolveAuthCorePersistenceAdapterFromEnv: mockResolveAuthCorePersistenceAdapterFromEnv,
  };
});

vi.mock('../tenant-deletion-lookup-cleanup', () => ({
  disableTenantLookupDirectory: mockDisableTenantLookupDirectory,
}));

vi.mock('../tenant-runtime-registry-route-state', () => ({
  publishTenantRuntimeRegistryRouteState: mockPublishTenantRuntimeRegistryRouteState,
}));

vi.mock('../tenant-deletion-authoritative-purge', () => ({
  purgeTenantAuthoritativeShards: mockPurgeTenantAuthoritativeShards,
}));

import { processPendingTenantDeletionJobs } from '../tenant-deletion-jobs';

const lookupShards = [
  { lookupShardId: 'lookup-1', bindingRef: 'LOOKUP_1', status: 'active' as const },
];
const tenantShards = [
  {
    shardId: 'default-1',
    dataRole: 'tenant_core/default' as const,
    residencyPolicyId: 'global',
    residencyPartition: 'global',
    bindingRef: 'TDB_DEFAULT',
    status: 'active' as const,
    allocationScope: 'tenant_exclusive' as const,
    ownerTenantId: 'target-tenant',
  },
  {
    shardId: 'users-1',
    dataRole: 'tenant_core/users' as const,
    residencyPolicyId: 'global',
    residencyPartition: 'global',
    bindingRef: 'TDB_USERS',
    status: 'active' as const,
    allocationScope: 'tenant_exclusive' as const,
    ownerTenantId: 'target-tenant',
  },
  {
    shardId: 'pii-1',
    dataRole: 'tenant_pii' as const,
    residencyPolicyId: 'global',
    residencyPartition: 'global',
    bindingRef: 'TDB_PII',
    status: 'active' as const,
    allocationScope: 'tenant_exclusive' as const,
    ownerTenantId: 'target-tenant',
  },
];

const mockGetTenantDeletionInventory = vi.fn();
const mockFinalizeTenantDeletionControlState = vi.fn();

function controlEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    DB_ADMIN: 'admin-db',
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL: {
      getTenantDeletionInventory: mockGetTenantDeletionInventory,
      finalizeTenantDeletionControlState: mockFinalizeTenantDeletionControlState,
    },
    ...overrides,
  } as never;
}

describe('tenant deletion jobs', () => {
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue(mockAdapter);
    mockAdapter.query.mockReset();
    mockAdapter.queryOne.mockReset();
    mockAdapter.execute.mockReset();
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
    mockAdapter.transaction.mockClear();
    mockTx.execute.mockReset();
    mockEnsureDatabaseAdapter.mockReturnValue(mockControlAdapter);
    mockControlAdapter.query.mockReset();
    mockControlAdapter.queryOne.mockReset();
    mockControlAdapter.execute.mockReset();
    mockControlAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
    mockControlAdapter.transaction.mockClear();
    mockControlTx.execute.mockReset();
    mockDisableTenantLookupDirectory.mockReset();
    mockDisableTenantLookupDirectory.mockResolvedValue(undefined);
    mockPublishTenantRuntimeRegistryRouteState.mockReset();
    mockPublishTenantRuntimeRegistryRouteState.mockImplementation(
      async (
        _env: unknown,
        options: { routeStatus: 'quarantining' | 'quarantined' | 'disabled' }
      ) => ({
        runtimeGeneration: options.routeStatus === 'quarantining' ? 2 : 3,
        routeStatus: options.routeStatus,
        quarantineDenyGeneration: options.routeStatus === 'quarantining' ? 1 : 2,
        changed: true,
        publishedAt: '2000-01-01T00:00:00.000Z',
      })
    );
    mockPurgeTenantAuthoritativeShards.mockReset();
    mockPurgeTenantAuthoritativeShards.mockResolvedValue(undefined);
    mockGetTenantDeletionInventory.mockReset();
    mockGetTenantDeletionInventory.mockImplementation(
      async ({ tenantId, operationId }: { tenantId: string; operationId: string }) => ({
        environmentId: 'test',
        tenantId,
        operationId,
        state: 'ready',
        lookupShards,
        tenantShards,
      })
    );
    mockFinalizeTenantDeletionControlState.mockReset();
    mockFinalizeTenantDeletionControlState.mockImplementation(
      async ({ tenantId, operationId }: { tenantId: string; operationId: string }) => ({
        environmentId: 'test',
        tenantId,
        operationId,
        state: 'finalized',
        finalizedAt: 1_700_000_000,
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates job rows with id and tenant_id while tombstoning the target tenant', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-1',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id, tenant_id, config, attempt_count, max_attempts'),
      [expect.any(Number)]
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      [expect.any(Number), expect.any(Number), 'job-1', 'operator-tenant']
    );
    expect(mockControlAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenant_database_registry'),
      ['deleting', expect.any(String), 'job-1', expect.any(String), 'target-tenant']
    );
    expect(mockPublishTenantRuntimeRegistryRouteState.mock.invocationCallOrder[2]).toBeLessThan(
      mockControlAdapter.execute.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ DB_ADMIN: 'admin-db' }),
      {
        tenantId: 'target-tenant',
        routeStatus: 'quarantining',
        operationId: 'job-1',
        actorId: 'job-1',
      }
    );
    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ DB_ADMIN: 'admin-db' }),
      {
        tenantId: 'target-tenant',
        routeStatus: 'quarantined',
        operationId: 'job-1',
        actorId: 'job-1',
      }
    );
    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ DB_ADMIN: 'admin-db' }),
      {
        tenantId: 'target-tenant',
        routeStatus: 'disabled',
        operationId: 'job-1',
        actorId: 'job-1',
      }
    );
    expect(mockDisableTenantLookupDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ DB_ADMIN: 'admin-db' }),
      lookupShards,
      'target-tenant'
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = ? WHERE id = ? AND lifecycle_state <> 'deleted'",
      [expect.any(Number), 'target-tenant']
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      'UPDATE admin_jobs SET progress = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify({ stage: 'lookup_disabled' }), expect.any(Number), 'job-1', 'operator-tenant']
    );
    expect(mockControlAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenant_database_active_pointers'),
      [expect.any(String), 'job-1', expect.any(String), 'target-tenant']
    );
    expect(mockPurgeTenantAuthoritativeShards).toHaveBeenCalledWith(
      expect.objectContaining({ DB_ADMIN: 'admin-db' }),
      tenantShards,
      'target-tenant',
      ['job-1']
    );
    expect(mockFinalizeTenantDeletionControlState).toHaveBeenCalledWith({
      tenantId: 'target-tenant',
      operationId: 'job-1',
    });
    expect(mockControlTx.execute).toHaveBeenCalledWith(
      'DELETE FROM tenant_discovery_indexes WHERE tenant_id = ?',
      ['target-tenant']
    );
    expect(mockControlTx.execute).not.toHaveBeenCalledWith(
      'DELETE FROM tenant_runtime_registry_snapshots WHERE tenant_id = ?',
      expect.any(Array)
    );
    expect(mockControlTx.execute).not.toHaveBeenCalledWith(
      'DELETE FROM tenant_runtime_cache_generations WHERE tenant_id = ?',
      expect.any(Array)
    );
    expect(mockControlTx.execute).toHaveBeenCalledWith(
      'DELETE FROM tenant_database_migration_job_targets WHERE tenant_id = ?',
      ['target-tenant']
    );
    expect(mockControlTx.execute).toHaveBeenCalledWith(
      'DELETE FROM tenant_database_migration_jobs WHERE tenant_id = ?',
      ['target-tenant']
    );
    expect(mockControlTx.execute).toHaveBeenCalledWith(
      'DELETE FROM internal_notification_events WHERE tenant_id = ?',
      ['target-tenant']
    );
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'completed', completed_at = ?, updated_at = ?, progress = ? WHERE id = ? AND tenant_id = ?",
      [
        expect.any(Number),
        expect.any(Number),
        JSON.stringify({ stage: 'completed' }),
        'job-1',
        'operator-tenant',
      ]
    );
    expect(mockControlAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenant_database_registry'),
      ['deleted', expect.any(String), 'job-1', expect.any(String), 'target-tenant']
    );
  });

  it('marks the scoped job failed when the config is invalid', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-2',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({}),
      },
    ]);

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed', error_message = ?, attempt_count = ?"),
      [
        'tenant_deletion_job_config_invalid',
        1,
        3,
        expect.any(Number),
        expect.any(Number),
        'job-2',
        'operator-tenant',
      ]
    );
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
  });

  it('defers destructive deletion until the 30-minute quarantine drain expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T00:10:00.000Z'));
    const quarantineStartedAt = Math.floor(new Date('2026-05-16T00:10:00.000Z').getTime() / 1000);
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-drain',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);
    mockPublishTenantRuntimeRegistryRouteState.mockResolvedValueOnce({
      runtimeGeneration: 2,
      routeStatus: 'quarantining',
      quarantineDenyGeneration: 1,
      changed: true,
      publishedAt: '2026-05-16T00:10:00.000Z',
    });

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'pending', progress = ?, config = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      [
        JSON.stringify({
          stage: 'quarantine_draining',
          quarantine_started_at: quarantineStartedAt,
          drain_ready_at: quarantineStartedAt + 30 * 60,
        }),
        expect.any(String),
        expect.any(Number),
        'job-drain',
        'operator-tenant',
      ]
    );
    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenCalledTimes(1);
    expect(mockDisableTenantLookupDirectory).not.toHaveBeenCalled();
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
  });

  it('resumes from the persisted quarantine checkpoint without rolling route state back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T01:00:01.000Z'));
    const quarantineStartedAt = Math.floor(new Date('2026-05-16T00:30:00.000Z').getTime() / 1000);
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-quarantined-resume',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({
          tenant_id: 'target-tenant',
          skip_backup: true,
          quarantine_started_at: quarantineStartedAt,
        }),
      },
    ]);

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenCalledTimes(2);
    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        routeStatus: 'quarantined',
        operationId: 'job-quarantined-resume',
      })
    );
    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ routeStatus: 'disabled' })
    );
    expect(mockFinalizeTenantDeletionControlState).toHaveBeenCalledTimes(1);
  });

  it('skips a job when another worker claimed it first', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-race',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);
    mockAdapter.execute.mockResolvedValueOnce({ rowsAffected: 0, success: true });

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      [expect.any(Number), expect.any(Number), 'job-race', 'operator-tenant']
    );
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
    expect(mockTx.execute).not.toHaveBeenCalled();
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
  });

  it('automatically retries the scoped job without reactivating lifecycle after purge starts', async () => {
    const failure = new Error('delete failed');
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-3',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);
    mockPurgeTenantAuthoritativeShards.mockRejectedValueOnce(failure);

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = ? WHERE id = ? AND lifecycle_state <> 'deleted'",
      [expect.any(Number), 'target-tenant']
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'pending', progress = ?, error_message = ?"),
      [
        expect.stringContaining('retry_scheduled'),
        'tenant_deletion_step_failed',
        1,
        3,
        expect.any(Number),
        expect.any(Number),
        'job-3',
        'operator-tenant',
      ]
    );
    expect(mockAdapter.execute).not.toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'completed', completed_at = ?, updated_at = ?, progress = ? WHERE id = ? AND tenant_id = ?",
      expect.any(Array)
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Tenant deletion job retry scheduled',
      expect.objectContaining({ job_id: 'job-3', attempt_count: 1, max_attempts: 3 }),
      failure
    );
  });

  it('fails closed and suspends the tenant when Lookup cleanup is not reflected', async () => {
    const failure = new Error('tenant_deletion_lookup_cleanup_not_reflected');
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-lookup-failed',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);
    mockDisableTenantLookupDirectory.mockRejectedValueOnce(failure);

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = ? WHERE id = ? AND lifecycle_state <> 'deleted'",
      [expect.any(Number), 'target-tenant']
    );
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
    expect(mockControlAdapter.transaction).not.toHaveBeenCalled();
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'pending', progress = ?, error_message = ?"),
      [
        expect.stringContaining('retry_scheduled'),
        expect.stringContaining('tenant_deletion_lookup_cleanup_not_reflected'),
        1,
        3,
        expect.any(Number),
        expect.any(Number),
        'job-lookup-failed',
        'operator-tenant',
      ]
    );
  });

  it('fails closed when control cleanup fails after authoritative shard purge', async () => {
    const failure = new Error('control cleanup failed');
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-control-failed',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);
    mockFinalizeTenantDeletionControlState.mockRejectedValueOnce(failure);

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockPurgeTenantAuthoritativeShards).toHaveBeenCalled();
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = ? WHERE id = ? AND lifecycle_state <> 'deleted'",
      [expect.any(Number), 'target-tenant']
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'pending', progress = ?, error_message = ?"),
      [
        expect.stringContaining('retry_scheduled'),
        'tenant_deletion_step_failed',
        1,
        3,
        expect.any(Number),
        expect.any(Number),
        'job-control-failed',
        'operator-tenant',
      ]
    );
  });

  it('completes Admin cleanup after a lost Control finalization response', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-finalized',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);
    mockGetTenantDeletionInventory.mockResolvedValueOnce({
      environmentId: 'test',
      tenantId: 'target-tenant',
      operationId: 'job-finalized',
      state: 'finalized',
      lookupShards: [],
      tenantShards: [],
    });

    await processPendingTenantDeletionJobs(controlEnvironment(), logger);

    expect(mockDisableTenantLookupDirectory).not.toHaveBeenCalled();
    expect(mockPurgeTenantAuthoritativeShards).not.toHaveBeenCalled();
    expect(mockFinalizeTenantDeletionControlState).not.toHaveBeenCalled();
    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenCalledTimes(1);
    expect(mockPublishTenantRuntimeRegistryRouteState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ routeStatus: 'disabled', operationId: 'job-finalized' })
    );
    expect(mockControlAdapter.transaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'completed'"),
      expect.arrayContaining(['job-finalized', 'operator-tenant'])
    );
  });

  it('marks the scoped job failed and suspends the tenant when the pre-purge backup job failed', async () => {
    const backupJobId = 'tenant-delete-backup:job-backup-failed';
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-backup-failed',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({
          tenant_id: 'target-tenant',
          backup_job_id: backupJobId,
        }),
      },
    ]);
    mockAdapter.queryOne.mockResolvedValueOnce({
      status: 'failed',
      job_type: 'tenant-database/export',
      created_by: 'job-backup-failed',
      config: JSON.stringify({
        policy: 'deletion_before_purge',
        consistency: 'maintenance_read_only',
        reason: 'pre-purge backup for tenant deletion job job-backup-failed',
      }),
    });

    await processPendingTenantDeletionJobs({} as never, logger);

    expect(mockAdapter.queryOne).toHaveBeenCalledWith(
      'SELECT status, job_type, created_by, config FROM admin_jobs WHERE id = ? AND tenant_id = ?',
      [backupJobId, 'target-tenant']
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE tenants SET lifecycle_state = 'suspended', updated_at = ? WHERE id = ? AND lifecycle_state <> 'deleted'",
      [expect.any(Number), 'target-tenant']
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed', error_message = ?, attempt_count = ?"),
      [
        'tenant_deletion_backup_job_failed',
        1,
        3,
        expect.any(Number),
        expect.any(Number),
        'job-backup-failed',
        'operator-tenant',
      ]
    );
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
  });

  it('creates and waits for a deletion-before-purge backup job by default', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-backup-first',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant' }),
      },
    ]);
    mockAdapter.queryOne.mockResolvedValueOnce({
      status: 'pending',
      job_type: 'tenant-database/export',
      created_by: 'job-backup-first',
      config: JSON.stringify({
        reason: 'pre-purge backup for tenant deletion job job-backup-first',
        consistency: 'maintenance_read_only',
        policy: 'deletion_before_purge',
      }),
    });

    await processPendingTenantDeletionJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO admin_jobs'),
      expect.arrayContaining([
        expect.any(String),
        'target-tenant',
        'tenant-database/export',
        expect.any(String),
      ])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'pending', progress = ?, config = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      expect.arrayContaining([
        expect.stringContaining('backup_requested'),
        expect.stringContaining('backup_job_id'),
        expect.any(Number),
        'job-backup-first',
        'operator-tenant',
      ])
    );
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
  });

  it('does not adopt a deterministic backup id owned by another job', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-backup-conflict',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant' }),
      },
    ]);
    mockAdapter.queryOne.mockResolvedValueOnce({
      status: 'completed',
      job_type: 'tenant-database/export',
      created_by: 'different-deletion-job',
      config: JSON.stringify({
        policy: 'deletion_before_purge',
        consistency: 'maintenance_read_only',
        reason: 'pre-purge backup for tenant deletion job different-deletion-job',
      }),
    });

    await processPendingTenantDeletionJobs({} as never, logger);

    expect(mockAdapter.transaction).not.toHaveBeenCalled();
    expect(mockDisableTenantLookupDirectory).not.toHaveBeenCalled();
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed', error_message = ?, attempt_count = ?"),
      [
        'tenant_deletion_backup_job_invalid',
        1,
        3,
        expect.any(Number),
        expect.any(Number),
        'job-backup-conflict',
        'operator-tenant',
      ]
    );
  });
});

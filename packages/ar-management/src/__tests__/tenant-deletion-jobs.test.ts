import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const {
  mockResolveAuthCorePersistenceAdapterFromEnv,
  mockEnsureDatabaseAdapter,
  mockAdapter,
  mockTx,
  mockControlAdapter,
  mockControlTx,
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

import { processPendingTenantDeletionJobs } from '../tenant-deletion-jobs';

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
  });

  it('updates job rows with id and tenant_id while deleting the target tenant', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-1',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);

    await processPendingTenantDeletionJobs({ DB_ADMIN: 'control-db' } as never, logger);

    expect(mockAdapter.query).toHaveBeenCalledWith(
      "SELECT id, tenant_id, config FROM admin_jobs WHERE job_type = 'tenants/delete' AND status = 'pending' LIMIT 5"
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      [expect.any(Number), expect.any(Number), 'job-1', 'operator-tenant']
    );
    expect(mockControlAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenant_database_registry'),
      ['deleting', expect.any(String), 'job-1', expect.any(String), 'target-tenant']
    );
    expect(mockControlAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE tenant_database_active_pointers'),
      [expect.any(String), 'job-1', expect.any(String), 'target-tenant']
    );
    expect(mockTx.execute).toHaveBeenCalledWith(
      'DELETE FROM admin_jobs WHERE tenant_id = ? AND id NOT IN (?)',
      ['target-tenant', 'job-1']
    );
    expect(mockControlTx.execute).toHaveBeenCalledWith(
      'DELETE FROM tenant_discovery_indexes WHERE tenant_id = ?',
      ['target-tenant']
    );
    expect(mockControlTx.execute).toHaveBeenCalledWith(
      'DELETE FROM tenant_runtime_registry_snapshots WHERE tenant_id = ?',
      ['target-tenant']
    );
    expect(mockControlTx.execute).toHaveBeenCalledWith(
      'DELETE FROM tenant_runtime_cache_generations WHERE tenant_id = ?',
      ['target-tenant']
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
    expect(mockTx.execute).not.toHaveBeenCalledWith(
      'DELETE FROM tenant_discovery_indexes WHERE tenant_id = ?',
      expect.any(Array)
    );
    expect(mockTx.execute).toHaveBeenCalledWith('DELETE FROM tenants WHERE id = ?', [
      'target-tenant',
    ]);
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

    await processPendingTenantDeletionJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      [
        expect.stringContaining('Tenant deletion job config requires tenant_id'),
        expect.any(Number),
        expect.any(Number),
        'job-2',
        'operator-tenant',
      ]
    );
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
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

    await processPendingTenantDeletionJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
      [expect.any(Number), expect.any(Number), 'job-race', 'operator-tenant']
    );
    expect(mockAdapter.transaction).not.toHaveBeenCalled();
    expect(mockTx.execute).not.toHaveBeenCalled();
    expect(mockAdapter.execute).toHaveBeenCalledTimes(1);
  });

  it('marks the scoped job failed when tenant row deletion fails', async () => {
    const failure = new Error('delete failed');
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-3',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant', skip_backup: true }),
      },
    ]);
    mockAdapter.transaction.mockRejectedValueOnce(failure);

    await processPendingTenantDeletionJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      [
        expect.stringContaining('delete failed'),
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
      'Tenant deletion job failed',
      { job_id: 'job-3' },
      failure
    );
  });

  it('creates and waits for a deletion-before-purge backup job by default', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-backup-first',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant' }),
      },
    ]);

    await processPendingTenantDeletionJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_jobs'),
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
});

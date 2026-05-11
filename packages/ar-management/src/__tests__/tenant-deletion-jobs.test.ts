import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const { mockResolveAuthCorePersistenceAdapterFromEnv, mockAdapter, mockTx } = vi.hoisted(() => {
  const tx = {
    execute: vi.fn(),
  };
  const adapter = {
    query: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (callback: (tx: Pick<DatabaseAdapter, 'execute'>) => Promise<void>) =>
      callback(tx)
    ),
  };

  return {
    mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue(adapter),
    mockAdapter: adapter,
    mockTx: tx,
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
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
    mockAdapter.execute.mockReset();
    mockAdapter.transaction.mockClear();
    mockTx.execute.mockReset();
  });

  it('updates job rows with id and tenant_id while deleting the target tenant', async () => {
    mockAdapter.query.mockResolvedValue([
      {
        id: 'job-1',
        tenant_id: 'operator-tenant',
        config: JSON.stringify({ tenant_id: 'target-tenant' }),
      },
    ]);

    await processPendingTenantDeletionJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenCalledWith(
      "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
      [expect.any(Number), expect.any(Number), 'job-1', 'operator-tenant']
    );
    expect(mockTx.execute).toHaveBeenCalledWith(
      'DELETE FROM admin_jobs WHERE tenant_id = ? AND id <> ?',
      ['target-tenant', 'job-1']
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
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, TransactionContext } from '@authrim/ar-lib-core';

const { mockEnsureDatabaseAdapter } = vi.hoisted(() => ({
  mockEnsureDatabaseAdapter: vi.fn((source: unknown) => source),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureDatabaseAdapter: mockEnsureDatabaseAdapter,
  };
});

import {
  TENANT_DISCOVERY_REINDEX_JOB_TYPE,
  enqueueTenantDiscoveryReindexJob,
  processPendingTenantDiscoveryReindexJobs,
} from '../tenant-discovery-reindex-jobs';

function createAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  const transaction: DatabaseAdapter['transaction'] = async <T>(
    fn: (tx: TransactionContext) => Promise<T>
  ): Promise<T> =>
    fn({
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockResolvedValue(null),
      execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    });
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue({ count: 0 }),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
    transaction,
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn(),
    ...overrides,
  };
}

describe('tenant discovery reindex jobs', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips processing when DB_ADMIN is not configured', async () => {
    const summary = await processPendingTenantDiscoveryReindexJobs({} as never, logger);

    expect(summary).toEqual({ scanned: 0, completed: 0, partial: 0, failed: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Tenant discovery reindex jobs skipped because DB_ADMIN is not configured'
    );
  });

  it('validates current key coverage and deletes previous key rows asynchronously', async () => {
    const adapter = createAdapter({
      query: vi.fn().mockResolvedValue([
        {
          id: 'job-1',
          tenant_id: '__control__',
          status: 'pending',
          config: JSON.stringify({
            index_kind: 'email_exact',
            previous_key_version: 1,
            current_key_version: 2,
          }),
          created_at: 1,
        },
      ]),
      queryOne: vi
        .fn()
        .mockResolvedValueOnce({ count: 12 })
        .mockResolvedValueOnce({ count: 10 })
        .mockResolvedValueOnce({ count: 2 }),
      execute: vi
        .fn()
        .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
        .mockResolvedValueOnce({ success: true, rowsAffected: 10 })
        .mockResolvedValueOnce({ success: true, rowsAffected: 1 }),
    });

    const summary = await processPendingTenantDiscoveryReindexJobs(
      { DB_ADMIN: adapter } as never,
      logger,
      { now: 1_779_000_000 }
    );

    expect(summary).toEqual({ scanned: 1, completed: 0, partial: 1, failed: 0 });
    expect(adapter.query).toHaveBeenCalledWith(expect.stringContaining('FROM admin_jobs'), [
      TENANT_DISCOVERY_REINDEX_JOB_TYPE,
      1_779_000_000,
      3,
    ]);
    expect(adapter.execute).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE admin_jobs'),
      expect.arrayContaining(['partial_failure'])
    );
    const finalParams = (adapter.execute as ReturnType<typeof vi.fn>).mock.calls[2][1] as unknown[];
    expect(JSON.parse(finalParams[3] as string)).toEqual({
      total: 12,
      processed: 12,
      succeeded: 10,
      failed: 2,
      stage: 'partial_failure',
    });
    expect(JSON.parse(finalParams[4] as string)).toEqual({
      summary: expect.objectContaining({
        previous_rows: 12,
        ready_for_cleanup: 10,
        missing_current: 2,
        deleted_previous_rows: 10,
      }),
    });
  });

  it('fails a job when complete current-key coverage is required', async () => {
    const adapter = createAdapter({
      query: vi.fn().mockResolvedValue([
        {
          id: 'job-1',
          tenant_id: '__control__',
          status: 'processing',
          config: JSON.stringify({
            index_kind: 'email_exact',
            previous_key_version: 1,
            current_key_version: 2,
            require_complete: true,
          }),
          created_at: 1,
        },
      ]),
      queryOne: vi
        .fn()
        .mockResolvedValueOnce({ count: 12 })
        .mockResolvedValueOnce({ count: 11 })
        .mockResolvedValueOnce({ count: 1 }),
    });

    const summary = await processPendingTenantDiscoveryReindexJobs(
      { DB_ADMIN: adapter } as never,
      logger
    );

    expect(summary).toEqual({ scanned: 1, completed: 0, partial: 0, failed: 1 });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      expect.arrayContaining(['Error: tenant_discovery_reindex_incomplete:1'])
    );
  });

  it('enqueues a control scoped reindex job', async () => {
    const adapter = createAdapter();

    const jobId = await enqueueTenantDiscoveryReindexJob(
      adapter,
      {
        index_kind: 'global_subject',
        previous_key_version: 1,
        current_key_version: 2,
        mode: 'validate_only',
      },
      {
        createdBy: 'operator-a',
        now: 1_779_000_000,
        jobId: 'job-1',
      }
    );

    expect(jobId).toBe('job-1');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_jobs'),
      expect.arrayContaining([
        'job-1',
        '__control__',
        TENANT_DISCOVERY_REINDEX_JOB_TYPE,
        expect.stringContaining('"stage":"completed"'),
        expect.stringContaining('"index_kind":"global_subject"'),
        'operator-a',
        1_779_000_000,
        1_779_000_000,
        3,
      ])
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';

const { mockAdapter, mockResolveAuthCorePersistenceAdapterFromEnv } = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
  } satisfies Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
  return {
    mockAdapter: adapter,
    mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue(adapter),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: mockResolveAuthCorePersistenceAdapterFromEnv,
  };
});

import { processPendingGenericAdminJobs } from '../admin-job-executor';

function createMockR2Bucket() {
  const put = vi.fn();
  return {
    put,
    bucket: {
      put,
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      head: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket,
  };
}

describe('generic admin job executor', () => {
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
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  it('claims and completes a tenant-scoped bulk user update job', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-1',
        tenant_id: 'tenant-a',
        job_type: 'users/bulk-update',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          fields: ['status'],
          values: { status: 'suspended' },
          filter: { lifecycle_state: 'active' },
          dry_run: false,
        }),
        created_at: 1,
      },
    ]);
    mockAdapter.query.mockResolvedValueOnce([{ id: 'user-1' }]);
    mockAdapter.queryOne.mockResolvedValue({ count: 1 });

    await processPendingGenericAdminJobs({} as never, logger);

    expect(mockAdapter.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("SET status = 'processing'"),
      expect.arrayContaining(['job-1', 'tenant-a'])
    );
    expect(mockAdapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'UPDATE users_core SET status = ?, updated_at = ? WHERE tenant_id = ? AND id IN (?)'
      ),
      expect.arrayContaining(['suspended', expect.any(Number), 'tenant-a', 'user-1'])
    );
    expect(mockAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('SET status = ?, progress = ?, result = ?'),
      expect.arrayContaining([
        'completed',
        expect.any(String),
        expect.any(String),
        'job-1',
        'tenant-a',
      ])
    );
  });

  it('keeps bulk user update jobs processing across chunks', async () => {
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'job-1',
          tenant_id: 'tenant-a',
          job_type: 'users/bulk-update',
          status: 'pending',
          progress: null,
          config: JSON.stringify({
            fields: ['status'],
            values: { status: 'suspended' },
            filter: { lifecycle_state: 'active' },
            batch_size: 2,
          }),
          created_at: 1,
        },
      ])
      .mockResolvedValueOnce([{ id: 'user-1' }, { id: 'user-2' }]);
    mockAdapter.queryOne.mockResolvedValue({ count: 3 });
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 2 });

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'processing'"));
    expect(finalUpdate?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"processed":2'),
        expect.any(Number),
        expect.any(Number),
        'job-1',
        'tenant-a',
      ])
    );
  });

  it('generates a tenant-scoped report result', async () => {
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'job-2',
          tenant_id: 'tenant-a',
          job_type: 'reports/generate',
          status: 'pending',
          progress: null,
          config: JSON.stringify({
            type: 'user_activity',
            from_date: '2026-01-01T00:00:00.000Z',
            to_date: '2026-01-31T00:00:00.000Z',
            format: 'json',
          }),
          created_at: 1,
        },
      ])
      .mockResolvedValueOnce([{ status: 'active', count: 7 }]);

    await processPendingGenericAdminJobs({} as never, logger);

    expect(mockAdapter.query).toHaveBeenLastCalledWith(expect.stringContaining('FROM users_core'), [
      'tenant-a',
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(mockAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('SET status = ?, progress = ?, result = ?'),
      expect.arrayContaining([
        'completed',
        expect.any(String),
        expect.any(String),
        'job-2',
        'tenant-a',
      ])
    );
  });

  it('materializes generic job results when artifact delivery is requested', async () => {
    const { bucket, put } = createMockR2Bucket();
    mockAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'job-2',
          tenant_id: 'tenant-a',
          job_type: 'reports/generate',
          status: 'pending',
          progress: null,
          config: JSON.stringify({
            type: 'user_activity',
            from_date: '2026-01-01T00:00:00.000Z',
            to_date: '2026-01-31T00:00:00.000Z',
            format: 'json',
            result_delivery: 'artifact',
          }),
          created_at: 1,
        },
      ])
      .mockResolvedValueOnce([{ status: 'active', count: 7 }]);

    await processPendingGenericAdminJobs(
      {
        EXPORT_ARTIFACTS: bucket,
        OBJECT_ENCRYPTION_ROOT_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      } as never,
      logger
    );

    expect(put).toHaveBeenCalledWith(
      'exports/tenant-a/admin-jobs/reports-generate/job-2/result.json',
      expect.any(String),
      expect.any(Object)
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO object_catalog'),
      expect.arrayContaining(['tenant-a', 'admin_job_result'])
    );
    expect(mockAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('object_catalog_id = COALESCE'),
      expect.arrayContaining([
        'completed',
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ])
    );
  });

  it('adds organization memberships with tenant-scoped checks', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-3',
        tenant_id: 'tenant-a',
        job_type: 'organizations/bulk-members',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          organization_id: 'org-1',
          organization_name: 'Example Org',
          action: 'add',
          role: 'admin',
          user_ids: ['user-1'],
        }),
        created_at: 1,
      },
    ]);
    mockAdapter.queryOne
      .mockResolvedValueOnce({ id: 'org-1' })
      .mockResolvedValueOnce({ id: 'user-1' })
      .mockResolvedValueOnce(null);

    await processPendingGenericAdminJobs({} as never, logger);

    expect(mockAdapter.queryOne).toHaveBeenNthCalledWith(
      1,
      'SELECT id FROM organizations WHERE id = ? AND tenant_id = ?',
      ['org-1', 'tenant-a']
    );
    expect(mockAdapter.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO subject_org_membership'),
      expect.arrayContaining(['tenant-a', 'user-1', 'org-1', 'admin'])
    );
    expect(mockAdapter.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('SET status = ?, progress = ?, result = ?'),
      expect.arrayContaining([
        'completed',
        expect.any(String),
        expect.any(String),
        'job-3',
        'tenant-a',
      ])
    );
  });

  it('records existing organization memberships as job result errors', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-4',
        tenant_id: 'tenant-a',
        job_type: 'organizations/bulk-members',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          organization_id: 'org-1',
          organization_name: 'Example Org',
          action: 'add',
          role: 'admin',
          user_ids: ['user-1'],
        }),
        created_at: 1,
      },
    ]);
    mockAdapter.queryOne
      .mockResolvedValueOnce({ id: 'org-1' })
      .mockResolvedValueOnce({ id: 'user-1' })
      .mockResolvedValueOnce({ id: 'membership-1' });

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(
      expect.stringContaining('SET status = ?, progress = ?, result = ?')
    );
    expect(finalUpdate?.[1]).toEqual(expect.arrayContaining(['partial_failure']));
    const resultJson = (finalUpdate?.[1] as unknown[])[2] as string;
    expect(JSON.parse(resultJson)).toMatchObject({
      failures: [{ user_id: 'user-1', error: 'membership_already_exists' }],
    });
  });

  it('schedules retry with backoff when a generic job fails before max attempts', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-5',
        tenant_id: 'tenant-a',
        job_type: 'reports/generate',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          type: 'user_activity',
          from_date: 'not-a-date',
          to_date: '2026-01-31T00:00:00.000Z',
        }),
        created_at: 1,
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'pending'"));
    expect(finalUpdate?.[1]).toEqual(
      expect.arrayContaining([expect.stringContaining('Invalid report date'), 1, 3])
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Generic admin job retry scheduled',
      expect.objectContaining({
        attempt_count: 1,
        max_attempts: 3,
        next_run_at: expect.any(Number),
      }),
      expect.any(Error)
    );
  });

  it('dead-letters generic jobs when max attempts are exhausted', async () => {
    mockAdapter.query.mockResolvedValueOnce([
      {
        id: 'job-6',
        tenant_id: 'tenant-a',
        job_type: 'reports/generate',
        status: 'pending',
        progress: null,
        config: JSON.stringify({
          type: 'user_activity',
          from_date: 'not-a-date',
          to_date: '2026-01-31T00:00:00.000Z',
        }),
        created_at: 1,
        attempt_count: 2,
        max_attempts: 3,
      },
    ]);

    await processPendingGenericAdminJobs({} as never, logger);

    const finalUpdate = mockAdapter.execute.mock.calls.at(-1);
    expect(finalUpdate?.[0]).toEqual(expect.stringContaining("SET status = 'failed'"));
    expect(finalUpdate?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Invalid report date'),
        expect.any(String),
        3,
        3,
      ])
    );
    const resultJson = (finalUpdate?.[1] as unknown[])[1] as string;
    expect(JSON.parse(resultJson)).toMatchObject({
      summary: { failed: 1, attempts: 3 },
      logs: [{ level: 'error', code: 'job_processor_error' }],
    });
  });
});

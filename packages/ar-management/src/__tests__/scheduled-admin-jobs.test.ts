import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockProcessPendingTenantDeletionJobs,
  mockProcessPendingUserImportJobs,
  mockProcessPendingDataExportRequests,
  mockProcessPendingSupportOpsSnapshotJobs,
  mockProcessPendingGenericAdminJobs,
} = vi.hoisted(() => ({
  mockProcessPendingTenantDeletionJobs: vi.fn(),
  mockProcessPendingUserImportJobs: vi.fn(),
  mockProcessPendingDataExportRequests: vi.fn(),
  mockProcessPendingSupportOpsSnapshotJobs: vi.fn(),
  mockProcessPendingGenericAdminJobs: vi.fn(),
}));

vi.mock('../tenant-deletion-jobs', () => ({
  processPendingTenantDeletionJobs: mockProcessPendingTenantDeletionJobs,
}));

vi.mock('../user-import-jobs', () => ({
  processPendingUserImportJobs: mockProcessPendingUserImportJobs,
}));

vi.mock('../data-export', () => ({
  processPendingDataExportRequests: mockProcessPendingDataExportRequests,
}));

vi.mock('../support-ops', () => ({
  processPendingSupportOpsSnapshotJobs: mockProcessPendingSupportOpsSnapshotJobs,
}));

vi.mock('../admin-job-executor', () => ({
  processPendingGenericAdminJobs: mockProcessPendingGenericAdminJobs,
}));

import { processScheduledAdminJobQueues } from '../scheduled-admin-jobs';

describe('scheduled admin job queues', () => {
  const env = {};
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessPendingTenantDeletionJobs.mockResolvedValue(undefined);
    mockProcessPendingUserImportJobs.mockResolvedValue(undefined);
    mockProcessPendingDataExportRequests.mockResolvedValue(undefined);
    mockProcessPendingSupportOpsSnapshotJobs.mockResolvedValue(undefined);
    mockProcessPendingGenericAdminJobs.mockResolvedValue(undefined);
  });

  it('runs all scheduled job processors in one maintenance pass', async () => {
    await processScheduledAdminJobQueues(env as never, log);

    expect(mockProcessPendingTenantDeletionJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingUserImportJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingDataExportRequests).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingSupportOpsSnapshotJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingGenericAdminJobs).toHaveBeenCalledWith(env, log);
  });

  it('continues remaining job processors when one processor fails', async () => {
    const failure = new Error('boom');
    mockProcessPendingUserImportJobs.mockRejectedValueOnce(failure);

    await processScheduledAdminJobQueues(env as never, log);

    expect(mockProcessPendingDataExportRequests).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingSupportOpsSnapshotJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingGenericAdminJobs).toHaveBeenCalledWith(env, log);
    expect(log.error).toHaveBeenCalledWith('User import job processing failed', {}, failure);
  });
});

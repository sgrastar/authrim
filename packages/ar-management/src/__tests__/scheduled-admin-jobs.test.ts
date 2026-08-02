import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockProcessPendingTenantDeletionJobs,
  mockProcessPendingUserImportJobs,
  mockProcessPendingDataExportRequests,
  mockProcessPendingSupportOpsSnapshotJobs,
  mockProcessConsentRetentionJobs,
  mockRefreshTenantDatabaseStats,
  mockProcessPendingTenantDatabaseHealthCheckJobs,
  mockRefreshTenantDatabaseHealth,
  mockProcessPendingTenantDatabaseReconciliationJobs,
  mockRefreshTenantDatabaseReconciliation,
  mockProcessPendingTenantDiscoveryReindexJobs,
  mockProcessLoggingStorageMaintenanceJobs,
  mockProcessPendingGenericAdminJobs,
} = vi.hoisted(() => ({
  mockProcessPendingTenantDeletionJobs: vi.fn(),
  mockProcessPendingUserImportJobs: vi.fn(),
  mockProcessPendingDataExportRequests: vi.fn(),
  mockProcessPendingSupportOpsSnapshotJobs: vi.fn(),
  mockProcessConsentRetentionJobs: vi.fn(),
  mockRefreshTenantDatabaseStats: vi.fn(),
  mockProcessPendingTenantDatabaseHealthCheckJobs: vi.fn(),
  mockRefreshTenantDatabaseHealth: vi.fn(),
  mockProcessPendingTenantDatabaseReconciliationJobs: vi.fn(),
  mockRefreshTenantDatabaseReconciliation: vi.fn(),
  mockProcessPendingTenantDiscoveryReindexJobs: vi.fn(),
  mockProcessLoggingStorageMaintenanceJobs: vi.fn(),
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

vi.mock('../consent-retention-jobs', () => ({
  processConsentRetentionJobs: mockProcessConsentRetentionJobs,
}));

vi.mock('../tenant-database-stats-jobs', () => ({
  refreshTenantDatabaseStats: mockRefreshTenantDatabaseStats,
}));

vi.mock('../tenant-database-health-jobs', () => ({
  processPendingTenantDatabaseHealthCheckJobs: mockProcessPendingTenantDatabaseHealthCheckJobs,
  refreshTenantDatabaseHealth: mockRefreshTenantDatabaseHealth,
}));

vi.mock('../tenant-database-reconciliation-jobs', () => ({
  processPendingTenantDatabaseReconciliationJobs:
    mockProcessPendingTenantDatabaseReconciliationJobs,
  refreshTenantDatabaseReconciliation: mockRefreshTenantDatabaseReconciliation,
}));

vi.mock('../tenant-discovery-reindex-jobs', () => ({
  processPendingTenantDiscoveryReindexJobs: mockProcessPendingTenantDiscoveryReindexJobs,
}));

vi.mock('../logging-storage-maintenance-jobs', () => ({
  processLoggingStorageMaintenanceJobs: mockProcessLoggingStorageMaintenanceJobs,
}));

vi.mock('../admin-job-executor', () => ({
  processPendingGenericAdminJobs: mockProcessPendingGenericAdminJobs,
}));

import {
  INTERACTIVE_ADMIN_JOB_CRON,
  isInteractiveAdminJobCron,
  processInteractiveAdminJobQueues,
  processScheduledAdminJobQueues,
} from '../scheduled-admin-jobs';

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
    mockProcessConsentRetentionJobs.mockResolvedValue(undefined);
    mockRefreshTenantDatabaseStats.mockResolvedValue(undefined);
    mockProcessPendingTenantDatabaseHealthCheckJobs.mockResolvedValue(undefined);
    mockRefreshTenantDatabaseHealth.mockResolvedValue(undefined);
    mockProcessPendingTenantDatabaseReconciliationJobs.mockResolvedValue(undefined);
    mockRefreshTenantDatabaseReconciliation.mockResolvedValue(undefined);
    mockProcessPendingTenantDiscoveryReindexJobs.mockResolvedValue(undefined);
    mockProcessLoggingStorageMaintenanceJobs.mockResolvedValue(undefined);
    mockProcessPendingGenericAdminJobs.mockResolvedValue(undefined);
  });

  it('identifies only the bounded interactive queue schedule', () => {
    expect(INTERACTIVE_ADMIN_JOB_CRON).toBe('*/5 * * * *');
    expect(isInteractiveAdminJobCron('*/5 * * * *')).toBe(true);
    expect(isInteractiveAdminJobCron('* * * * *')).toBe(false);
    expect(isInteractiveAdminJobCron('0 */6 * * *')).toBe(false);
  });

  it('runs interactive queues without periodic maintenance refreshes', async () => {
    await processInteractiveAdminJobQueues(env as never, log);

    expect(mockProcessPendingTenantDeletionJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingUserImportJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingDataExportRequests).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingSupportOpsSnapshotJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDatabaseHealthCheckJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDatabaseReconciliationJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDiscoveryReindexJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingGenericAdminJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessConsentRetentionJobs).not.toHaveBeenCalled();
    expect(mockRefreshTenantDatabaseStats).not.toHaveBeenCalled();
    expect(mockRefreshTenantDatabaseHealth).not.toHaveBeenCalled();
    expect(mockRefreshTenantDatabaseReconciliation).not.toHaveBeenCalled();
    expect(mockProcessLoggingStorageMaintenanceJobs).not.toHaveBeenCalled();
  });

  it('continues interactive queues when one processor fails', async () => {
    mockProcessPendingTenantDeletionJobs.mockRejectedValueOnce(new Error('boom'));

    await processInteractiveAdminJobQueues(env as never, log);

    expect(mockProcessPendingGenericAdminJobs).toHaveBeenCalledWith(env, log);
    expect(log.error).toHaveBeenCalledWith(
      'Tenant deletion job processing failed',
      {},
      expect.any(Error)
    );
  });

  it('runs all scheduled job processors in one maintenance pass', async () => {
    await processScheduledAdminJobQueues(env as never, log);

    expect(mockProcessPendingTenantDeletionJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingUserImportJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingDataExportRequests).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingSupportOpsSnapshotJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessConsentRetentionJobs).toHaveBeenCalledWith(env, log);
    expect(mockRefreshTenantDatabaseStats).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDatabaseHealthCheckJobs).toHaveBeenCalledWith(env, log);
    expect(mockRefreshTenantDatabaseHealth).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDatabaseReconciliationJobs).toHaveBeenCalledWith(env, log);
    expect(mockRefreshTenantDatabaseReconciliation).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDiscoveryReindexJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessLoggingStorageMaintenanceJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingGenericAdminJobs).toHaveBeenCalledWith(env, log);
  });

  it('continues remaining job processors when one processor fails', async () => {
    const failure = new Error('boom');
    mockProcessPendingUserImportJobs.mockRejectedValueOnce(failure);

    await processScheduledAdminJobQueues(env as never, log);

    expect(mockProcessPendingDataExportRequests).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingSupportOpsSnapshotJobs).toHaveBeenCalledWith(env, log);
    expect(mockRefreshTenantDatabaseStats).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDatabaseHealthCheckJobs).toHaveBeenCalledWith(env, log);
    expect(mockRefreshTenantDatabaseHealth).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDatabaseReconciliationJobs).toHaveBeenCalledWith(env, log);
    expect(mockRefreshTenantDatabaseReconciliation).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingTenantDiscoveryReindexJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessLoggingStorageMaintenanceJobs).toHaveBeenCalledWith(env, log);
    expect(mockProcessPendingGenericAdminJobs).toHaveBeenCalledWith(env, log);
    expect(log.error).toHaveBeenCalledWith('User import job processing failed', {}, failure);
  });
});

import type { Env } from '@authrim/ar-lib-core';
import { processPendingGenericAdminJobs } from './admin-job-executor';
import { processPendingDataExportRequests } from './data-export';
import { processLoggingStorageMaintenanceJobs } from './logging-storage-maintenance-jobs';
import { processPendingSupportOpsSnapshotJobs } from './support-ops';
import { processConsentRetentionJobs } from './consent-retention-jobs';
import { processPendingTenantDeletionJobs } from './tenant-deletion-jobs';
import {
  processPendingTenantDatabaseHealthCheckJobs,
  refreshTenantDatabaseHealth,
} from './tenant-database-health-jobs';
import {
  processPendingTenantDatabaseReconciliationJobs,
  refreshTenantDatabaseReconciliation,
} from './tenant-database-reconciliation-jobs';
import { refreshTenantDatabaseStats } from './tenant-database-stats-jobs';
import { processPendingTenantDiscoveryReindexJobs } from './tenant-discovery-reindex-jobs';
import { processPendingUserImportJobs } from './user-import-jobs';

interface ScheduledJobLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>, error?: Error) => void;
}

export const INTERACTIVE_ADMIN_JOB_CRON = '*/5 * * * *';

export function isInteractiveAdminJobCron(cron: string): boolean {
  return cron === INTERACTIVE_ADMIN_JOB_CRON;
}

export async function processInteractiveAdminJobQueues(
  env: Env,
  log: ScheduledJobLogger
): Promise<void> {
  try {
    await processPendingTenantDeletionJobs(env, log);
  } catch (jobsError) {
    log.error('Tenant deletion job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingUserImportJobs(env, log);
  } catch (jobsError) {
    log.error('User import job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingDataExportRequests(env, log);
  } catch (jobsError) {
    log.error('Data export job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingSupportOpsSnapshotJobs(env, log);
  } catch (jobsError) {
    log.error('Support Ops snapshot job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingTenantDatabaseHealthCheckJobs(env, log);
  } catch (jobsError) {
    log.error('Tenant database health-check job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingTenantDatabaseReconciliationJobs(env, log);
  } catch (jobsError) {
    log.error('Tenant database reconciliation job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingTenantDiscoveryReindexJobs(env, log);
  } catch (jobsError) {
    log.error('Tenant discovery reindex job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingGenericAdminJobs(env, log);
  } catch (jobsError) {
    log.error('Generic admin job processing failed', {}, jobsError as Error);
  }
}

export async function processScheduledAdminJobQueues(
  env: Env,
  log: ScheduledJobLogger
): Promise<void> {
  try {
    await processPendingTenantDeletionJobs(env, log);
  } catch (jobsError) {
    log.error('Tenant deletion job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingUserImportJobs(env, log);
  } catch (jobsError) {
    log.error('User import job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingDataExportRequests(env, log);
  } catch (jobsError) {
    log.error('Data export job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingSupportOpsSnapshotJobs(env, log);
  } catch (jobsError) {
    log.error('Support Ops snapshot job processing failed', {}, jobsError as Error);
  }

  try {
    await processConsentRetentionJobs(env, log);
  } catch (jobsError) {
    log.error('Consent retention job processing failed', {}, jobsError as Error);
  }

  try {
    await refreshTenantDatabaseStats(env, log);
  } catch (jobsError) {
    log.error('Tenant database stats refresh failed', {}, jobsError as Error);
  }

  try {
    await processPendingTenantDatabaseHealthCheckJobs(env, log);
    await refreshTenantDatabaseHealth(env, log);
  } catch (jobsError) {
    log.error('Tenant database health refresh failed', {}, jobsError as Error);
  }

  try {
    await processPendingTenantDatabaseReconciliationJobs(env, log);
    await refreshTenantDatabaseReconciliation(env, log);
  } catch (jobsError) {
    log.error('Tenant database reconciliation failed', {}, jobsError as Error);
  }

  try {
    await processPendingTenantDiscoveryReindexJobs(env, log);
  } catch (jobsError) {
    log.error('Tenant discovery reindex job processing failed', {}, jobsError as Error);
  }

  try {
    await processLoggingStorageMaintenanceJobs(env, log);
  } catch (jobsError) {
    log.error('Logging/storage maintenance job processing failed', {}, jobsError as Error);
  }

  try {
    await processPendingGenericAdminJobs(env, log);
  } catch (jobsError) {
    log.error('Generic admin job processing failed', {}, jobsError as Error);
  }
}

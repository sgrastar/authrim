import type { Env } from '@authrim/ar-lib-core';
import { processPendingGenericAdminJobs } from './admin-job-executor';
import { processPendingDataExportRequests } from './data-export';
import { processPendingSupportOpsSnapshotJobs } from './support-ops';
import { processPendingTenantDeletionJobs } from './tenant-deletion-jobs';
import { processPendingUserImportJobs } from './user-import-jobs';

interface ScheduledJobLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>, error?: Error) => void;
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
    await processPendingGenericAdminJobs(env, log);
  } catch (jobsError) {
    log.error('Generic admin job processing failed', {}, jobsError as Error);
  }
}

/**
 * Deletes the admin console's handled notices (resolved, or expired while open) once they are
 * older than the platform's retention (`admin-notices.retention_days`: KV, else
 * ADMIN_NOTICE_RETENTION_DAYS, else 90 days; nothing is deleted while it cannot be read). Runs with the six-hourly maintenance; what one run
 * leaves is deleted by the next.
 */

import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_NOTICES_DEFAULTS,
  AdminNoticeRepository,
  requireDedicatedAdminDatabaseAdapter,
  resolvePlatformSettingsWithSources,
} from '@authrim/ar-lib-core';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_KEY = 'admin-notices.retention_days';

interface RetentionLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The retention in days (KV, else the environment, else the default), or null when the setting
 * cannot be read: deleting by a guess could remove what a longer retention keeps.
 */
export async function adminNoticeRetentionDays(env: Env): Promise<number | null> {
  try {
    const { values } = await resolvePlatformSettingsWithSources(env, 'admin-notices', {
      fresh: true,
    });
    const days = values[RETENTION_KEY];
    return typeof days === 'number' && Number.isInteger(days) && days >= 1
      ? days
      : ADMIN_NOTICES_DEFAULTS[RETENTION_KEY];
  } catch {
    return null;
  }
}

export async function purgeHandledAdminNotices(
  adapter: DatabaseAdapter,
  retentionDays: number,
  now: number = Date.now()
): Promise<{ deleted: number; cutoff: number }> {
  const cutoff = now - retentionDays * DAY_MS;
  const deleted = await new AdminNoticeRepository(adapter).purgeHandledBefore(cutoff);
  return { deleted, cutoff };
}

/** The scheduled run: never throws, so the rest of the maintenance goes on. */
export async function processScheduledAdminNoticeRetention(
  env: Env,
  log: RetentionLog,
  now: number = Date.now()
): Promise<{ deleted: number; retentionDays: number } | null> {
  try {
    const retentionDays = await adminNoticeRetentionDays(env);
    if (retentionDays === null) {
      log.warn('Admin notice retention skipped: the retention setting could not be read');
      return null;
    }
    const adapter = requireDedicatedAdminDatabaseAdapter(env, 'admin-notice-retention');
    const { deleted } = await purgeHandledAdminNotices(adapter, retentionDays, now);
    if (deleted > 0) log.info('Handled admin notices deleted', { deleted, retentionDays });
    return { deleted, retentionDays };
  } catch (error) {
    log.warn('Admin notice retention failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { TENANT_DELETION_CANCELLED_ERROR } from './tenant-deletion-job-predicate';
import { readTenantRouteStateReading } from './tenant-route-state-reading';

/**
 * A tenant left `suspended` by a failed deletion looks resumable, but `resume` only flips the
 * platform row: the route (kept in DB_ADMIN) may still be quarantined or disabled, so the tenant
 * would look active while every request to it is denied. Such a tenant is brought back by
 * cancelling the failed deletion, which reactivates the route first. This module holds the
 * shared reading of "the latest deletion job of a tenant" and the check the reactivating
 * commands (and the validation job that completes them) run.
 */

export interface TenantDeleteJobRecord {
  id: string;
  status: string;
  config: string | null;
  progress: string | null;
  error_message: string | null;
  created_at: number;
}

/**
 * Every `tenants/delete` job of the tenant (`config.tenant_id`; the job's own `tenant_id` column
 * is the tenant the request came through), newest first. A tenant has a handful at most.
 */
export async function readTenantDeleteJobs(
  jobsAdapter: Pick<DatabaseAdapter, 'query'>,
  targetTenantId: string
): Promise<TenantDeleteJobRecord[]> {
  const rows = await jobsAdapter.query<TenantDeleteJobRecord>(
    `SELECT id, status, config, progress, error_message, created_at FROM admin_jobs
      WHERE job_type = 'tenants/delete' AND json_extract(config, '$.tenant_id') = ?
      ORDER BY created_at DESC, updated_at DESC, id DESC`,
    [targetTenantId]
  );
  return rows ?? [];
}

function parseObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The job is part of the chain `chainId`: its own id, or the `operation_id` it continues. */
export function tenantDeleteJobOwnsChain(
  job: Pick<TenantDeleteJobRecord, 'id' | 'config'>,
  chainId: string
): boolean {
  return job.id === chainId || parseObject(job.config).operation_id === chainId;
}

/** The deletion job persisted its destructive-step marker (right before the lookup disable). */
export function tenantDeleteJobDestructiveStarted(job: Pick<TenantDeleteJobRecord, 'config'>) {
  return parseObject(job.config).destructive_started_at !== undefined;
}

/** The job was queued (or ran) by code that writes the destructive marker. */
export function tenantDeleteJobMarkerAware(job: Pick<TenantDeleteJobRecord, 'config'>) {
  return parseObject(job.config).marker_aware === true;
}

/** `cancelling_at` of a cancel mark, or null when absent or unreadable. */
export function tenantDeleteJobCancellingAt(job: Pick<TenantDeleteJobRecord, 'progress'>) {
  const value = parseObject(job.progress).cancelling_at;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isCancelledTenantDeleteJob(job: Pick<TenantDeleteJobRecord, 'error_message'>) {
  return job.error_message === TENANT_DELETION_CANCELLED_ERROR;
}

/**
 * The stage of a cancel-marked deletion job: `cancelling` (the mark is set, the route may not be
 * reactivated and published yet: an INCOMPLETE cancel) or `cancelled` (done). A marked job whose
 * progress cannot be read counts as `cancelling` (the safe side). Null for an unmarked job.
 */
export function tenantDeleteJobCancelStage(
  job: Pick<TenantDeleteJobRecord, 'error_message' | 'progress'>
): 'cancelling' | 'cancelled' | null {
  if (!isCancelledTenantDeleteJob(job)) return null;
  return parseObject(job.progress).stage === 'cancelled' ? 'cancelled' : 'cancelling';
}

/** The chain id of a deletion job: its `config.operation_id`, else its own id. */
export function tenantDeleteJobChainId(job: Pick<TenantDeleteJobRecord, 'id' | 'config'>): string {
  try {
    const config = JSON.parse(job.config ?? '{}') as { operation_id?: unknown };
    return typeof config.operation_id === 'string' && config.operation_id
      ? config.operation_id
      : job.id;
  } catch {
    return job.id;
  }
}

/**
 * True when the reactivating commands must refuse with `tenant_deletion_failed_use_cancel`. The
 * cancel works on the tenant's failed deletion jobs as a SET, so this reads the set:
 *   (ii)  ANY marked job of the tenant is not `cancelled` (the cancel is incomplete: the published
 *         route may still be quarantined whatever the database says), whatever the route reads;
 *   (i/iii) the latest job failed (cancel-marked or not) while the route is quarantining,
 *         quarantined or disabled.
 * Only a completed cancel with an active route lets a reactivation through. A failed deletion
 * that never reached quarantine (route active or no row) does not block.
 *
 * Fail closed: for (i/iii) a route that cannot be read throws, and the caller refuses. The jobs
 * live in the tenant inventory and the route in DB_ADMIN (two databases): a code check.
 */
export async function failedTenantDeletionNeedsCancel(
  jobsAdapter: Pick<DatabaseAdapter, 'query'>,
  registryAdapter: DatabaseAdapter,
  targetTenantId: string
): Promise<boolean> {
  const jobs = await readTenantDeleteJobs(jobsAdapter, targetTenantId);
  if (jobs.some((job) => tenantDeleteJobCancelStage(job) === 'cancelling')) return true;
  const latest = jobs[0];
  if (!latest || latest.status !== 'failed') return false;
  const route = await readTenantRouteStateReading(registryAdapter, targetTenantId);
  return route !== null && route.routeStatus !== 'active';
}

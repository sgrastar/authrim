import { type DatabaseAdapter } from '@authrim/ar-lib-core';
import { readTenantRouteStateReading } from './tenant-route-state-reading';
import { TENANT_DELETION_CANCELLED_ERROR } from './tenant-deletion-job-predicate';

// Re-exported for existing importers; the reader lives in a neutral module.
export {
  readTenantRouteStateReading,
  type TenantRouteStateReading,
} from './tenant-route-state-reading';

/**
 * A deletion that failed part-way leaves the runtime route state under its operation id, and the
 * Control inventory, the Control finalisation and the backup keyed by it. A new deletion of the
 * same tenant can only continue that work under the same id, so it adopts that chain id
 * (`config.operation_id`, else the first job's own id).
 *
 * Adoption is decided from state, never from the request. The route state comes first: it must
 * be non-active and carry a UUID-shaped operation id (the candidate). The candidate is adopted
 * only if a failed deletion job of this tenant owns it (its id, or its `operation_id`, equals
 * the candidate); any later unrelated failed job does not matter. A job an operator cancelled is never adopted. Anything else (active route,
 * another operation's quarantine such as a disaster-recovery one, no owning failed job,
 * unreadable state, an error) returns null and the job keeps its own id as before.
 */
export async function resolveTenantDeletionChainOperationId(
  jobsAdapter: Pick<DatabaseAdapter, 'queryOne'>,
  registryAdapter: DatabaseAdapter,
  targetTenantId: string
): Promise<string | null> {
  try {
    const state = await readTenantRouteStateReading(registryAdapter, targetTenantId);
    if (!state || state.routeStatus === 'active') return null;
    const candidate = state.operationId;
    if (!candidate) return null;

    const owner = await jobsAdapter.queryOne<{ id: string }>(
      `SELECT id FROM admin_jobs
        WHERE job_type = 'tenants/delete'
          AND status = 'failed'
          AND (error_message IS NULL OR error_message <> ?)
          AND json_extract(config, '$.tenant_id') = ?
          AND (id = ? OR json_extract(config, '$.operation_id') = ?)
        LIMIT 1`,
      [TENANT_DELETION_CANCELLED_ERROR, targetTenantId, candidate, candidate]
    );
    return owner ? candidate : null;
  } catch {
    return null;
  }
}

import {
  getTenantRuntimeRegistryRouteState,
  TenantDatabaseRegistryRepository,
  type DatabaseAdapter,
  type TenantRuntimeRegistryRouteStatus,
} from '@authrim/ar-lib-core';

/**
 * A deletion that failed part-way leaves the runtime route state under its operation id, and the
 * Control inventory, the Control finalisation and the backup keyed by it. A new deletion of the
 * same tenant can only continue that work under the same id, so it adopts that chain id
 * (`config.operation_id`, else the first job's own id).
 *
 * Adoption is decided from state, never from the request. The route state comes first: it must
 * be non-active and carry a UUID-shaped operation id (the candidate). The candidate is adopted
 * only if a failed deletion job of this tenant owns it (its id, or its `operation_id`, equals
 * the candidate); any later unrelated failed job does not matter. Anything else (active route,
 * another operation's quarantine such as a disaster-recovery one, no owning failed job,
 * unreadable state, an error) returns null and the job keeps its own id as before.
 */
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_ID_PATTERN.test(value);
}

export interface TenantRouteStateReading {
  routeStatus: TenantRuntimeRegistryRouteStatus;
  /** `route_state_operation_id` of the row, null when absent or not UUID-shaped. */
  operationId: string | null;
}

/** The tenant's runtime-registry route state and the operation id it carries; null without a row. */
export async function readTenantRouteStateReading(
  registryAdapter: DatabaseAdapter,
  tenantId: string
): Promise<TenantRouteStateReading | null> {
  const row = await new TenantDatabaseRegistryRepository(registryAdapter).getRuntimeCacheGeneration(
    tenantId,
    'runtime_registry'
  );
  if (!row?.metadata_json) return null;
  const { routeStatus } = getTenantRuntimeRegistryRouteState(row);
  const metadata = JSON.parse(row.metadata_json) as { route_state_operation_id?: unknown };
  return {
    routeStatus,
    operationId: isOperationId(metadata.route_state_operation_id)
      ? metadata.route_state_operation_id
      : null,
  };
}

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
          AND json_extract(config, '$.tenant_id') = ?
          AND (id = ? OR json_extract(config, '$.operation_id') = ?)
        LIMIT 1`,
      [targetTenantId, candidate, candidate]
    );
    return owner ? candidate : null;
  } catch {
    return null;
  }
}

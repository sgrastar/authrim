import {
  getTenantRuntimeRegistryRouteState,
  TenantDatabaseRegistryRepository,
  type DatabaseAdapter,
  type TenantRuntimeRegistryRouteStatus,
} from '@authrim/ar-lib-core';

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_ID_PATTERN.test(value);
}

export interface TenantRouteStateReading {
  routeStatus: TenantRuntimeRegistryRouteStatus;
  /** `route_state_operation_id` of the row, null when absent or not UUID-shaped. */
  operationId: string | null;
  /** `quarantine_deny_generation` of the row (0 while the route was never quarantined). */
  quarantineDenyGeneration: number;
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
  const { routeStatus, quarantineDenyGeneration } = getTenantRuntimeRegistryRouteState(row);
  const metadata = JSON.parse(row.metadata_json) as { route_state_operation_id?: unknown };
  return {
    routeStatus,
    quarantineDenyGeneration,
    operationId: isOperationId(metadata.route_state_operation_id)
      ? metadata.route_state_operation_id
      : null,
  };
}

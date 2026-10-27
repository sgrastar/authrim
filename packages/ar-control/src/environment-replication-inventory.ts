import type { ControlEnv } from './types';
/** Called only after authenticated Control service props bind the environment. */
export async function readControlEnvironmentReplicationInventory(
  database: ControlEnv['CONTROL_DB'],
  environmentId: string
) {
  const rows = await database
    .prepare(
      `SELECT tenant_id,policy_state,policy_generation FROM control_tenant_placement_policies WHERE environment_id=? ORDER BY tenant_id LIMIT ?`
    )
    .bind(environmentId, 129)
    .all<{ tenant_id: string; policy_state: string; policy_generation: number }>();
  if (rows.results.length > 128) throw new Error('replication_environment_inventory_limit');
  const pending = await database
    .prepare(
      `SELECT operation_id FROM control_tenant_placement_migrations WHERE environment_id=? AND active_operation_key IS NOT NULL UNION ALL SELECT operation_id FROM control_tenant_disaster_recovery_operations WHERE environment_id=? AND active_operation_key IS NOT NULL LIMIT 1`
    )
    .bind(environmentId, environmentId)
    .first();
  return {
    environmentId,
    complete: true as const,
    pendingOperations: !!pending,
    tenants: rows.results.map((row) => ({
      tenantId: row.tenant_id,
      policyState: row.policy_state,
      policyGeneration: row.policy_generation,
    })),
  };
}

import {
  createD1Adapter,
  requireDedicatedAdminDatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { parseReplicationWriterConfiguration } from '@authrim/ar-lib-core/services/deployment-replication/writer';
import { getCanonicalTenantBaseUrlAsync } from './request-issuer';
import { version as productVersion } from '../package.json';

export { MAX_REPLICATION_ENVIRONMENT_TENANTS } from '@authrim/ar-lib-core/services/deployment-replication/environment-inventory';
import {
  MAX_REPLICATION_ENVIRONMENT_TENANTS,
  replicationInventoryDigest,
  type EnvironmentReplicationInventory,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-inventory';
export function environmentReplicationInstallation(
  env: Pick<Env, 'AUTHRIM_REPLICATION_WRITER' | 'AUTHRIM_ENVIRONMENT_NAME'>
) {
  const writer = parseReplicationWriterConfiguration(env.AUTHRIM_REPLICATION_WRITER ?? '');
  if (
    writer.version !== 2 ||
    writer.environmentId !== env.AUTHRIM_ENVIRONMENT_NAME ||
    writer.tenantId !== undefined ||
    writer.restoreId !== undefined ||
    writer.epoch !== 1
  )
    throw new Error('replication_environment_unavailable');
  return writer;
}
/** A membership check is mandatory even when a tenant-scoped grant authenticates successfully. */
export async function assertReplicationEnvironmentTenant(
  env: Env,
  tenantId: string
): Promise<void> {
  environmentReplicationInstallation(env);
  const row = await createD1Adapter(env.DB, 'replication-environment-membership').queryOne<{
    id: string;
    lifecycle_state: string;
  }>('SELECT id,lifecycle_state FROM tenants WHERE id=?', [tenantId]);
  if (row?.id !== tenantId || row.lifecycle_state !== 'active')
    throw new Error('backup_replication_grant_denied');
  const placement = await env.CONTROL?.getTenantPlacementPolicy?.(tenantId);
  if (!placement || placement.tenantId !== tenantId || placement.state !== 'active')
    throw new Error('backup_replication_grant_denied');
}
/** Read only: reconcile the platform directory with provisioning and Control before attesting completeness. */
export async function readEnvironmentReplicationInventory(
  env: Env
): Promise<EnvironmentReplicationInventory> {
  const writer = environmentReplicationInstallation(env);
  const core = createD1Adapter(env.DB, 'replication-environment-inventory');
  const admin = requireDedicatedAdminDatabaseAdapter(env, 'replication-environment-inventory');
  const limit = MAX_REPLICATION_ENVIRONMENT_TENANTS + 1;
  const rows = await core.query<{ id: string; lifecycle_state: string }>(
    "SELECT id,lifecycle_state FROM tenants WHERE lifecycle_state IS NOT 'deleted' ORDER BY id LIMIT ?",
    [limit]
  );
  if (
    !rows.length ||
    rows.length > MAX_REPLICATION_ENVIRONMENT_TENANTS ||
    rows.some(
      (row) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(row.id) || row.lifecycle_state !== 'active'
    ) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw new Error('replication_environment_inventory_unsupported');
  // A request may persist its provisioning operation before writing the platform directory.
  const pending = await admin.queryOne<{ operation_id: string }>(
    "SELECT operation_id FROM tenant_provisioning_operations WHERE environment_id=? AND status NOT IN ('succeeded','canceled') LIMIT 1",
    [writer.environmentId]
  );
  if (pending) throw new Error('replication_environment_provisioning_pending');
  if (!env.CONTROL?.getEnvironmentReplicationInventory || !env.CONTROL.inspectSamlDrWriterCoverage)
    throw new Error('replication_environment_inventory_unavailable');
  const control = await env.CONTROL.getEnvironmentReplicationInventory({});
  if (
    Object.keys(control).sort().join(',') !== 'complete,environmentId,pendingOperations,tenants' ||
    typeof control.pendingOperations !== 'boolean' ||
    control.environmentId !== writer.environmentId ||
    control.complete !== true ||
    control.pendingOperations ||
    !Array.isArray(control.tenants) ||
    control.tenants.length > 128 ||
    new Set(control.tenants.map((row) => row.tenantId)).size !== control.tenants.length
  )
    throw new Error('replication_environment_inventory_mismatch');
  const activeIds = new Set(rows.map((row) => row.id));
  // Control retains historical placements. Only a canonical deletion tombstone permits exclusion.
  for (const placement of control.tenants) {
    if (activeIds.has(placement.tenantId)) continue;
    const deleted = await core.queryOne<{ id: string; lifecycle_state: string }>(
      'SELECT id,lifecycle_state FROM tenants WHERE id=?',
      [placement.tenantId]
    );
    if (deleted?.id !== placement.tenantId || deleted.lifecycle_state !== 'deleted')
      throw new Error('replication_environment_inventory_mismatch');
  }
  const activePlacements = control.tenants.filter((row) => activeIds.has(row.tenantId));
  if (
    activePlacements.length !== rows.length ||
    activePlacements.some(
      (row, index) =>
        row.tenantId !== rows[index].id ||
        row.policyState !== 'active' ||
        !Number.isSafeInteger(row.policyGeneration) ||
        row.policyGeneration < 1
    )
  )
    throw new Error('replication_environment_inventory_mismatch');
  const tenants: EnvironmentReplicationInventory['tenants'] = [];
  for (const [index, row] of rows.entries()) {
    const issuer = await getCanonicalTenantBaseUrlAsync(env, row.id);
    const parsed = new URL(issuer);
    if (
      parsed.origin !== issuer ||
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      tenants.some((item) => item.issuer === issuer)
    )
      throw new Error('replication_environment_issuer_invalid');
    tenants.push({
      tenantId: row.id,
      issuer,
      productVersion,
      lifecycleState: row.lifecycle_state,
      placementGeneration: activePlacements[index].policyGeneration,
    });
  }
  const coverage = await env.CONTROL.inspectSamlDrWriterCoverage({ tenantId: tenants[0].tenantId });
  const writerCoverageSha256 = await replicationInventoryDigest(coverage);
  const body = {
    formatVersion: 1 as const,
    complete: true as const,
    environmentId: writer.environmentId,
    pairId: writer.pairId,
    sourceDeploymentId: writer.deploymentId,
    tenants,
    writerCoverageSha256,
  };
  return {
    ...body,
    inventorySha256: await replicationInventoryDigest(body),
    observedAtMs: Date.now(),
  };
}

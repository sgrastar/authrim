import {
  ensureDatabaseAdapter,
  publishTenantRuntimeRegistrySnapshot,
  TenantDatabaseRegistryRepository,
  type ControlTenantShardCapacityTarget,
  type Env,
  type TenantDatabaseRole,
  type TenantDatabaseRegistryRow,
} from '@authrim/ar-lib-core';
import { createControlRuntimeRegistrySigner } from './control-runtime-registry-signer';
import { resolveTenantRuntimePlacementSnapshot } from './tenant-runtime-placement';

interface TenantRuntimeRegistrySnapshotJobLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TenantRuntimeRegistrySnapshotRefreshSummary {
  scanned: number;
  published: number;
  skipped: number;
  failed: number;
}

export interface TenantRuntimeRegistrySnapshotRefreshOptions {
  limit?: number;
  now?: Date;
  actorId?: string;
}

const DEFAULT_TENANT_RUNTIME_REGISTRY_SNAPSHOT_LIMIT = 25;
const DEFAULT_SNAPSHOT_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const SAFE_CONTROL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_CONTROL_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
export const TENANT_RUNTIME_REGISTRY_REFRESH_CRON = '*/2 * * * *';

export function isTenantRuntimeRegistryRefreshCron(cron: string): boolean {
  return cron === TENANT_RUNTIME_REGISTRY_REFRESH_CRON;
}

function getDeploymentTarget(env: Env): string | null {
  return (env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string }).AUTHRIM_DEPLOYMENT_TARGET ?? null;
}

function createEmptySummary(): TenantRuntimeRegistrySnapshotRefreshSummary {
  return {
    scanned: 0,
    published: 0,
    skipped: 0,
    failed: 0,
  };
}

interface ControlRouteMetadata {
  dataRole: ControlTenantShardCapacityTarget['dataRole'];
  residencyPolicyId: string;
  residencyPartition: string;
}

function controlRouteMetadata(row: TenantDatabaseRegistryRow): ControlRouteMetadata | null {
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata_json ?? 'null') as unknown;
  } catch {
    return null;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = metadata as Record<string, unknown>;
  if (
    !['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(
      String(value.control_data_role)
    ) ||
    typeof value.control_residency_policy_id !== 'string' ||
    !SAFE_CONTROL_ID.test(value.control_residency_policy_id) ||
    typeof value.control_residency_partition !== 'string' ||
    !SAFE_CONTROL_ID.test(value.control_residency_partition)
  ) {
    return null;
  }
  return {
    dataRole: value.control_data_role as ControlTenantShardCapacityTarget['dataRole'],
    residencyPolicyId: value.control_residency_policy_id,
    residencyPartition: value.control_residency_partition,
  };
}

function validateControlTarget(target: ControlTenantShardCapacityTarget, tenantId: string): void {
  if (
    !SAFE_CONTROL_ID.test(target.shardId) ||
    !['tenant_core/default', 'tenant_core/users', 'tenant_pii'].includes(target.dataRole) ||
    !SAFE_CONTROL_ID.test(target.residencyPolicyId) ||
    !SAFE_CONTROL_ID.test(target.residencyPartition) ||
    !SAFE_CONTROL_BINDING.test(target.bindingRef) ||
    !SAFE_CONTROL_ID.test(target.databaseId) ||
    typeof target.databaseName !== 'string' ||
    target.databaseName.length < 1 ||
    !Number.isSafeInteger(target.routeGeneration) ||
    target.routeGeneration < 1 ||
    !Number.isSafeInteger(target.assignmentGeneration) ||
    target.assignmentGeneration < 1 ||
    (target.allocationScope === 'tenant_exclusive'
      ? target.ownerTenantId !== tenantId
      : target.allocationScope !== 'shared_pool' || target.ownerTenantId !== null)
  ) {
    throw new Error('tenant_runtime_registry_control_target_invalid');
  }
}

function groupIdentity(input: { role: TenantDatabaseRole; shardGroup: string }): string {
  return `${input.role}\0${input.shardGroup}`;
}

export async function synchronizeTenantRuntimeRegistryRoutes(input: {
  env: Env;
  repository: TenantDatabaseRegistryRepository;
  tenantId: string;
  placement: { isolationPolicy: 'shared_pool' | 'tenant_exclusive'; policyGeneration: number };
  actorId: string;
}): Promise<boolean> {
  const control = input.env.CONTROL;
  if (!control?.getTenantRuntimeRouteTargets) return false;
  const existing = [
    ...(await input.repository.listActiveRegistryRowsForTenantRole(input.tenantId, 'tenant_core')),
    ...(await input.repository.listActiveRegistryRowsForTenantRole(input.tenantId, 'tenant_pii')),
  ];
  const metadataByRole = new Map<ControlRouteMetadata['dataRole'], ControlRouteMetadata>();
  const groupByRole = new Map<
    ControlRouteMetadata['dataRole'],
    { role: TenantDatabaseRole; shardGroup: string }
  >();
  for (const row of existing) {
    const metadata = controlRouteMetadata(row);
    if (!metadata) continue;
    const prior = metadataByRole.get(metadata.dataRole);
    if (
      prior &&
      (prior.residencyPolicyId !== metadata.residencyPolicyId ||
        prior.residencyPartition !== metadata.residencyPartition)
    ) {
      throw new Error('tenant_runtime_registry_control_residency_ambiguous');
    }
    metadataByRole.set(metadata.dataRole, metadata);
    const group = { role: row.role, shardGroup: row.shard_group };
    const priorGroup = groupByRole.get(metadata.dataRole);
    if (priorGroup && groupIdentity(priorGroup) !== groupIdentity(group)) {
      throw new Error('tenant_runtime_registry_control_group_ambiguous');
    }
    groupByRole.set(metadata.dataRole, group);
  }
  const residencies = new Map<string, ControlRouteMetadata>();
  for (const metadata of metadataByRole.values()) {
    residencies.set(`${metadata.residencyPolicyId}\0${metadata.residencyPartition}`, metadata);
  }
  if (residencies.size === 0) {
    throw new Error('tenant_runtime_registry_control_residency_missing');
  }
  const targets = (
    await Promise.all(
      [...residencies.values()].map((residency) =>
        control.getTenantRuntimeRouteTargets!({
          tenantId: input.tenantId,
          residencyPolicyId: residency.residencyPolicyId,
          residencyPartition: residency.residencyPartition,
        })
      )
    )
  ).flat();
  const targetBindings = new Set<string>();
  const targetShardIds = new Set<string>();
  for (const target of targets) {
    validateControlTarget(target, input.tenantId);
    if (target.allocationScope !== input.placement.isolationPolicy) {
      throw new Error('tenant_runtime_registry_control_target_placement_mismatch');
    }
    if (targetBindings.has(target.bindingRef) || targetShardIds.has(target.shardId)) {
      throw new Error('tenant_runtime_registry_control_target_duplicate');
    }
    targetBindings.add(target.bindingRef);
    targetShardIds.add(target.shardId);
  }
  const existingBindings = new Set(
    existing.flatMap((row) => (typeof row.binding_ref === 'string' ? [row.binding_ref] : []))
  );
  if ([...existingBindings].some((bindingRef) => !targetBindings.has(bindingRef))) {
    throw new Error('tenant_runtime_registry_control_route_shrink_requires_migration');
  }
  if (
    targetBindings.size === existingBindings.size &&
    [...targetBindings].every((bindingRef) => existingBindings.has(bindingRef))
  ) {
    return false;
  }

  const runtimeGeneration = Math.max(
    input.placement.policyGeneration,
    ...targets.map((target) => target.assignmentGeneration)
  );

  const grouped = new Map<string, ControlTenantShardCapacityTarget[]>();
  for (const target of targets) {
    const group = groupByRole.get(target.dataRole);
    if (!group) throw new Error('tenant_runtime_registry_control_group_missing');
    const key = groupIdentity(group);
    grouped.set(key, [...(grouped.get(key) ?? []), target]);
  }
  for (const [key, values] of grouped) {
    const [role, shardGroup] = key.split('\0') as [TenantDatabaseRole, string];
    const ordered = [...values].sort(
      (left, right) =>
        left.assignmentGeneration - right.assignmentGeneration ||
        left.shardId.localeCompare(right.shardId)
    );
    const generations = new Set(ordered.map((target) => target.routeGeneration));
    if (generations.size !== 1) {
      throw new Error('tenant_runtime_registry_control_generation_mismatch');
    }
    const generation = ordered[0]!.routeGeneration;
    for (const [shardIndex, target] of ordered.entries()) {
      await input.repository.upsertRegistryRow({
        tenant_id: input.tenantId,
        role,
        generation,
        shard_group: shardGroup,
        shard_index: shardIndex,
        provider: 'd1',
        database_id: target.databaseId,
        database_name: target.databaseName,
        binding_ref: target.bindingRef,
        schema_version: 1,
        status: 'active',
        shard_count: ordered.length,
        shard_key_strategy: target.dataRole === 'tenant_core/default' ? 'none' : 'account_id',
        worker_shard: 'primary',
        actor_id: input.actorId,
        region_hint: null,
        jurisdiction: null,
        metadata_json: JSON.stringify({
          control_shard_id: target.shardId,
          control_assignment_generation: target.assignmentGeneration,
          control_data_role: target.dataRole,
          control_residency_policy_id: target.residencyPolicyId,
          control_residency_partition: target.residencyPartition,
          control_allocation_scope: target.allocationScope,
          control_owner_tenant_id: target.ownerTenantId,
          control_placement_policy_generation: input.placement.policyGeneration,
        }),
      });
    }
    await input.repository.setActivePointer({
      tenant_id: input.tenantId,
      role,
      shard_group: shardGroup,
      generation,
      shard_count: ordered.length,
      shard_key_strategy: ordered[0]!.dataRole === 'tenant_core/default' ? 'none' : 'account_id',
      runtime_generation: runtimeGeneration,
      status: 'active',
      updated_by: input.actorId,
      metadata_json: JSON.stringify({ source: 'control_scale_out_reconciliation' }),
    });
  }
  return true;
}

async function listAllActiveCoreRows(
  repository: TenantDatabaseRegistryRepository,
  batchSize: number
): Promise<TenantDatabaseRegistryRow[]> {
  const rows: TenantDatabaseRegistryRow[] = [];
  for (let offset = 0; ; offset += batchSize) {
    const page = await repository.listActiveRegistryRowsForRole('tenant_core', batchSize, offset);
    rows.push(...page);
    if (page.length < batchSize) {
      break;
    }
  }
  return rows;
}

async function shouldPublishSnapshot(input: {
  repository: TenantDatabaseRegistryRepository;
  tenantId: string;
  deploymentTarget: string | null;
  now: Date;
  rows: Array<{ tenant_id: string; status: string }>;
}): Promise<boolean> {
  if (input.rows.some((row) => row.status === 'degraded_pending_snapshot')) {
    return true;
  }

  const snapshot = await input.repository.getLatestRuntimeRegistrySnapshot(
    input.tenantId,
    input.deploymentTarget?.trim() || 'default'
  );
  if (!snapshot) {
    return true;
  }

  const expiresAt = Date.parse(snapshot.expires_at);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt - input.now.getTime() <= DEFAULT_SNAPSHOT_REFRESH_WINDOW_MS;
}

export async function refreshTenantRuntimeRegistrySnapshots(
  env: Env,
  logger: TenantRuntimeRegistrySnapshotJobLogger,
  options: TenantRuntimeRegistrySnapshotRefreshOptions = {}
): Promise<TenantRuntimeRegistrySnapshotRefreshSummary> {
  const summary = createEmptySummary();
  if (!env.DB_ADMIN) {
    logger.warn(
      'Tenant runtime registry snapshot refresh skipped because DB_ADMIN is not configured'
    );
    return summary;
  }
  if (!env.TENANT_RUNTIME_REGISTRY) {
    logger.warn(
      'Tenant runtime registry snapshot refresh skipped because TENANT_RUNTIME_REGISTRY is not configured'
    );
    return summary;
  }

  const repository = new TenantDatabaseRegistryRepository(
    ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-runtime-registry-snapshot-control')
  );
  const rows = await listAllActiveCoreRows(
    repository,
    options.limit ?? DEFAULT_TENANT_RUNTIME_REGISTRY_SNAPSHOT_LIMIT
  );
  const tenantIds = Array.from(new Set(rows.map((row) => row.tenant_id))).sort();
  const deploymentTarget = getDeploymentTarget(env);
  const now = options.now ?? new Date();
  summary.scanned = tenantIds.length;

  for (const tenantId of tenantIds) {
    try {
      const tenantRows = rows.filter((row) => row.tenant_id === tenantId);
      const placement = await resolveTenantRuntimePlacementSnapshot(env, tenantId);
      const synchronized = await synchronizeTenantRuntimeRegistryRoutes({
        env,
        repository,
        tenantId,
        placement,
        actorId: options.actorId ?? 'tenant-runtime-registry-snapshot',
      });
      const shouldPublish =
        synchronized ||
        (await shouldPublishSnapshot({
          repository,
          tenantId,
          deploymentTarget,
          now,
          rows: tenantRows,
        }));
      if (!shouldPublish) {
        summary.skipped += 1;
        continue;
      }

      await publishTenantRuntimeRegistrySnapshot({
        tenantId,
        placement,
        repository,
        snapshotStore: env.TENANT_RUNTIME_REGISTRY,
        deploymentTarget,
        now,
        actorId: options.actorId ?? 'tenant-runtime-registry-snapshot',
        externalSigner: await createControlRuntimeRegistrySigner(env),
      });
      summary.published += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn('Tenant runtime registry snapshot refresh failed', {
        tenant_id: tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summary.scanned > 0) {
    logger.info('Tenant runtime registry snapshot refresh completed', { ...summary });
  }

  return summary;
}

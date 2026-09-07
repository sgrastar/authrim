import type { D1Database } from '@cloudflare/workers-types';
import {
  ensureDatabaseAdapter,
  publishTenantRuntimeRegistrySnapshot,
  TenantDatabaseRegistryRepository,
  type ControlTenantPlacementMigrationView,
  type DatabaseAdapter,
  type Env,
  type TenantDatabaseRole,
} from '@authrim/ar-lib-core';
import { createControlRuntimeRegistrySigner } from './control-runtime-registry-signer';
import {
  activateTenantAliasDirectory,
  prepareTenantAliasPlacementMigration,
} from './tenant-alias-directory';
import type { TenantPlacementMigrationSagaDependencies } from './tenant-placement-migration-orchestrator';
import type { TenantPlacementMigrationJobView } from './tenant-placement-migration-job';

const SAFE_BINDING_REF = /^[A-Z][A-Z0-9_]{0,127}$/u;

interface RegistryTarget {
  dataRole: ControlTenantPlacementMigrationView['shards'][number]['dataRole'];
  residencyPolicyId: string;
  residencyPartition: string;
  shardId: string;
  bindingRef: string;
  routeGeneration: number;
  assignmentGeneration: number;
  databaseId: string;
  databaseName: string;
}

function targetDatabase(env: Env, bindingRef: string): D1Database {
  if (!SAFE_BINDING_REF.test(bindingRef)) {
    throw new Error('tenant_placement_registry_binding_invalid');
  }
  const value = (env as unknown as Record<string, unknown>)[bindingRef] as
    | Partial<D1Database>
    | undefined;
  if (!value || typeof value.withSession !== 'function') {
    throw new Error('tenant_placement_registry_binding_unavailable');
  }
  return value as D1Database;
}

function targets(migration: ControlTenantPlacementMigrationView): RegistryTarget[] {
  if (migration.state !== 'cutover_committed' || migration.writeFenceState !== 'active') {
    throw new Error('tenant_placement_registry_cutover_not_committed');
  }
  return migration.shards.map((shard) => {
    if (
      shard.state !== 'cutover_committed' ||
      !shard.target ||
      !shard.target.databaseId ||
      shard.target.shardId !== shard.targetShardId
    ) {
      throw new Error('tenant_placement_registry_target_incomplete');
    }
    return {
      dataRole: shard.dataRole,
      residencyPolicyId: shard.residencyPolicyId,
      residencyPartition: shard.residencyPartition,
      shardId: shard.target.shardId,
      bindingRef: shard.target.bindingRef,
      routeGeneration: shard.target.routeGeneration,
      assignmentGeneration: shard.target.assignmentGeneration,
      databaseId: shard.target.databaseId,
      databaseName: shard.target.databaseName,
    };
  });
}

function registryKey(target: RegistryTarget): { role: TenantDatabaseRole; shardGroup: string } {
  if (target.dataRole === 'tenant_core/default') {
    return { role: 'tenant_core', shardGroup: 'default' };
  }
  if (target.dataRole === 'tenant_core/users') {
    return { role: 'tenant_core', shardGroup: `users:${target.residencyPartition}` };
  }
  return { role: 'tenant_pii', shardGroup: `pii:${target.residencyPartition}` };
}

async function tenantAliasInput(
  platformAdapter: DatabaseAdapter,
  job: TenantPlacementMigrationJobView,
  migration: ControlTenantPlacementMigrationView
) {
  const tenant = await platformAdapter.queryOne<{ tenant_code: string }>(
    'SELECT tenant_code FROM tenants WHERE id = ?',
    [job.tenantId]
  );
  const defaultShards = migration.shards.filter(
    (shard) => shard.dataRole === 'tenant_core/default'
  );
  const defaultShard = defaultShards.length === 1 ? defaultShards[0] : null;
  if (!tenant?.tenant_code || !defaultShard?.target) {
    throw new Error('tenant_placement_alias_target_incomplete');
  }
  return {
    tenantId: job.tenantId,
    tenantCode: tenant.tenant_code,
    tenantSlug: job.tenantId,
    routeProjection: {
      schemaVersion: 1,
      tenantRouteGeneration: defaultShard.target.routeGeneration,
      residencyPolicyId: defaultShard.residencyPolicyId,
      target: {
        dataRole: 'tenant_core/default' as const,
        residencyPartition: defaultShard.residencyPartition,
        shardId: defaultShard.target.shardId,
        bindingRef: defaultShard.target.bindingRef,
        requiredBindingRouteGeneration: defaultShard.target.routeGeneration,
      },
    },
  };
}

async function publishRegistry(
  env: Env,
  platformAdapter: DatabaseAdapter,
  adminAdapter: DatabaseAdapter,
  job: TenantPlacementMigrationJobView,
  migration: ControlTenantPlacementMigrationView
): Promise<void> {
  if (!env.TENANT_RUNTIME_REGISTRY) {
    throw new Error('tenant_placement_registry_store_unavailable');
  }
  const allTargets = targets(migration);
  const defaultTargets = allTargets.filter((target) => target.dataRole === 'tenant_core/default');
  const defaultTarget = defaultTargets.length === 1 ? defaultTargets[0] : null;
  if (!defaultTarget) throw new Error('tenant_placement_registry_target_incomplete');

  const targetSession = targetDatabase(env, defaultTarget.bindingRef).withSession('first-primary');
  const targetUpdate = await targetSession
    .prepare(
      `UPDATE tenants SET isolation_policy = 'tenant_exclusive', updated_at = ?
        WHERE id = ? AND isolation_policy IN ('shared_pool', 'tenant_exclusive')`
    )
    .bind(Math.floor(Date.now() / 1000), job.tenantId)
    .run();
  const reflectedTarget = await targetSession
    .prepare('SELECT isolation_policy FROM tenants WHERE id = ?')
    .bind(job.tenantId)
    .first<{ isolation_policy: string }>();
  if (!targetUpdate.success || reflectedTarget?.isolation_policy !== 'tenant_exclusive') {
    throw new Error('tenant_placement_registry_target_tenant_update_failed');
  }

  const repository = new TenantDatabaseRegistryRepository(adminAdapter);
  const groups = new Map<string, RegistryTarget[]>();
  for (const target of allTargets) {
    const key = registryKey(target);
    const groupKey = `${key.role}\0${key.shardGroup}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), target]);
  }
  for (const [groupKey, groupTargets] of groups) {
    const [role, shardGroup] = groupKey.split('\0') as [TenantDatabaseRole, string];
    const ordered = [...groupTargets].sort((left, right) =>
      left.shardId.localeCompare(right.shardId)
    );
    const generations = new Set(ordered.map((target) => target.routeGeneration));
    if (generations.size !== 1) {
      throw new Error('tenant_placement_registry_group_generation_mismatch');
    }
    const generation = ordered[0]!.routeGeneration;
    for (const [shardIndex, target] of ordered.entries()) {
      await repository.upsertRegistryRow({
        tenant_id: job.tenantId,
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
        shard_key_strategy:
          role === 'tenant_core' && shardGroup === 'default' ? 'none' : 'account_id',
        worker_shard: 'primary',
        actor_id: job.requestedBy,
        metadata_json: JSON.stringify({
          control_operation_id: job.controlOperationId,
          control_shard_id: target.shardId,
          control_assignment_generation: target.assignmentGeneration,
          control_data_role: target.dataRole,
          control_residency_policy_id: target.residencyPolicyId,
          control_residency_partition: target.residencyPartition,
          control_allocation_scope: 'tenant_exclusive',
          control_owner_tenant_id: job.tenantId,
          control_placement_policy_generation: migration.targetPolicyGeneration,
        }),
      });
    }
    await repository.setActivePointer({
      tenant_id: job.tenantId,
      role,
      shard_group: shardGroup,
      generation,
      shard_count: ordered.length,
      shard_key_strategy:
        role === 'tenant_core' && shardGroup === 'default' ? 'none' : 'account_id',
      runtime_generation: migration.targetPolicyGeneration,
      status: 'active',
      updated_by: job.requestedBy,
      metadata_json: JSON.stringify({ control_operation_id: job.controlOperationId }),
    });
  }

  const published = await publishTenantRuntimeRegistrySnapshot({
    tenantId: job.tenantId,
    placement: {
      isolationPolicy: 'tenant_exclusive',
      policyGeneration: migration.targetPolicyGeneration,
    },
    repository,
    snapshotStore: env.TENANT_RUNTIME_REGISTRY,
    deploymentTarget: (env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string })
      .AUTHRIM_DEPLOYMENT_TARGET,
    actorId: job.requestedBy,
    externalSigner: await createControlRuntimeRegistrySigner(env),
  });
  const reflectedBindings = new Set(published.snapshot.stores.map((store) => store.bindingRef));
  if (
    published.snapshot.tenantId !== job.tenantId ||
    published.snapshot.routeStatus !== 'active' ||
    allTargets.some((target) => !reflectedBindings.has(target.bindingRef))
  ) {
    throw new Error('tenant_placement_registry_reflection_failed');
  }

  await platformAdapter.execute(
    `UPDATE tenants SET isolation_policy = 'tenant_exclusive', updated_at = ?
      WHERE id = ? AND isolation_policy IN ('shared_pool', 'tenant_exclusive')`,
    [Math.floor(Date.now() / 1000), job.tenantId]
  );
  const platformTenant = await platformAdapter.queryOne<{ isolation_policy: string }>(
    'SELECT isolation_policy FROM tenants WHERE id = ?',
    [job.tenantId]
  );
  if (platformTenant?.isolation_policy !== 'tenant_exclusive') {
    throw new Error('tenant_placement_registry_platform_tenant_update_failed');
  }
}

export function createTenantPlacementMigrationSagaDependencies(
  env: Env,
  platformAdapter = ensureDatabaseAdapter(env.DB, 'tenant-placement-migration-platform'),
  adminAdapter = ensureDatabaseAdapter(env.DB_ADMIN!, 'tenant-placement-migration')
): TenantPlacementMigrationSagaDependencies {
  return {
    async prepareAlias(job, migration) {
      await prepareTenantAliasPlacementMigration(
        env,
        await tenantAliasInput(platformAdapter, job, migration)
      );
    },
    publishRegistry(job, migration) {
      return publishRegistry(env, platformAdapter, adminAdapter, job, migration);
    },
    async activateAlias(job, migration) {
      await activateTenantAliasDirectory(
        env,
        await tenantAliasInput(platformAdapter, job, migration)
      );
    },
  };
}

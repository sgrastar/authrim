import type { DatabaseSync } from 'node:sqlite';
import type { TenantDisasterRecoveryService } from '../../tenant-disaster-recovery';

const HASH = 'a'.repeat(64);

/** Seeds one active tenant with a single shard, route and release on the current control baseline. */
export function seedTenantDr(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, requested_by_id, attempt_count, created_at, completed_at, updated_at
    ) VALUES ('seed-op', 'env-test', 'provision_shard', 'seed', 'succeeded',
      'setup', 'setup', 1, 1, 1, 1);
    INSERT INTO control_environment_resource_policies (
      environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
      daily_d1_create_budget, target_account_count, created_at, updated_at
    ) VALUES ('env-test', 2, 2, 1000, 20, 100000, 1, 1);
    INSERT INTO control_residency_partitions (
      environment_id, residency_policy_id, residency_partition, location_hint,
      status, created_at, updated_at
    ) VALUES ('env-test', 'default', 'apac', 'apac', 'active', 1, 1);
    INSERT INTO control_tenant_placement_policies (
      environment_id, tenant_id, isolation_policy, policy_generation, policy_state,
      source_operation_id, idempotency_key, activated_at, created_at, updated_at
    ) VALUES ('env-test', 'tenant-a', 'tenant_exclusive', 1, 'active',
      'seed-op', 'policy-a', 1, 1, 1);
    INSERT INTO control_desired_resources (
      desired_resource_id, environment_id, resource_kind, logical_shard_id, resource_scope,
      tenant_id, deterministic_name, ownership_fingerprint, provisioning_state,
      origin_operation_id, created_at, updated_at
    ) VALUES ('desired-a', 'env-test', 'd1', 'logical-a', 'tenant', 'tenant-a',
      'authrim-test-tenant-a-core', '${HASH}', 'creating', 'seed-op', 1, 1);
    INSERT INTO control_tenant_shards (
      shard_id, environment_id, data_role, residency_policy_id, residency_partition,
      generation, logical_shard_id, binding_ref, d1_desired_resource_id, location_hint,
      status, created_at, updated_at, allocation_scope, owner_tenant_id
    ) VALUES ('shard-a', 'env-test', 'tenant_core/default', 'default', 'apac',
      7, 'logical-a', 'TENANT_A_CORE', 'desired-a', 'apac', 'active', 1, 1,
      'tenant_exclusive', 'tenant-a');
    INSERT INTO control_observed_resources (
      observed_resource_id, environment_id, desired_resource_id, provider_resource_id,
      provider_name, resource_kind, ownership_fingerprint, observed_state, observed_at
    ) VALUES ('observed-a', 'env-test', 'desired-a',
      '11111111-1111-4111-8111-111111111111', 'authrim-test-tenant-a-core', 'd1',
      '${HASH}', 'present', 1);
    UPDATE control_desired_resources
       SET observed_resource_id = 'observed-a', provisioning_state = 'active'
     WHERE desired_resource_id = 'desired-a';
    INSERT INTO control_tenant_shard_assignments (
      environment_id, tenant_id, data_role, residency_policy_id, residency_partition,
      shard_id, assignment_generation, assignment_state, source_operation_id,
      created_at, activated_at, updated_at
    ) VALUES ('env-test', 'tenant-a', 'tenant_core/default', 'default', 'apac',
      'shard-a', 3, 'active', 'seed-op', 1, 1, 1);
    INSERT INTO control_runtime_registry_routes (
      environment_id, tenant_id, route_generation, tenant_lifecycle_generation,
      registry_publication_generation, tenant_lifecycle_state, route_status,
      residency_policy_id, route_projection_json, source_operation_id, created_at, updated_at
    ) VALUES ('env-test', 'tenant-a', 7, 1, 1, 'active', 'active', 'default',
      '{"targets":[{"shardId":"shard-a","bindingRef":"TENANT_A_CORE"}]}',
      'seed-op', 1, 1);
    INSERT INTO control_migration_release_catalog (
      environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
      state, active_stream_key, registered_by_operation_id, registered_at, activated_at
    ) VALUES ('env-test', 'core-d1', '0.4.0-test', '${HASH}',
      'releases/0.4.0-test/${HASH}/manifest.json', 'active', 'active', 'seed-op', 1, 1);
    INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES ('env-test', 'test-ar-auth', '@authrim/ar-auth', 'worker',
      '${HASH}', 'packages/ar-auth/capability.json', '${HASH}', '${HASH}',
      'core_manifest', 'packages/ar-auth', 'seed-op', 'setup', 1);
    INSERT INTO control_worker_required_data_roles (
      environment_id, worker_script_name, data_role, source_manifest_hash, updated_at
    ) VALUES ('env-test', 'test-ar-auth', 'tenant_core/default', '${HASH}', 1);
  `);
}

type Recovery = Awaited<ReturnType<TenantDisasterRecoveryService['start']>>;

export function evidence(view: Recovery) {
  return view.targets.map((entry) => ({
    shardId: entry.shardId,
    providerDatabaseId: entry.providerDatabaseId,
    shardGeneration: entry.shardGeneration,
    bindingRef: entry.bindingRef,
    releaseId: entry.releaseId,
    manifestDigest: entry.manifestDigest,
  }));
}

export const START = {
  tenantId: 'tenant-a',
  requestedById: 'admin-a',
  reasonCode: 'operator_disaster_recovery' as const,
  idempotencyKey: 'dr-a',
};

export const REGISTRY_DIGEST = 'c'.repeat(64);

/** Walks a started recovery through restore, migration and lookup reprojection to the smoke stage. */
export async function advanceToSmoke(
  service: TenantDisasterRecoveryService,
  tick: (seconds: number) => number
): Promise<Recovery> {
  let recovery = await service.start('env-test', START);
  await service.observeDeny('env-test', {
    operationId: recovery.operationId,
    runtimeGeneration: 12,
    denyRegistryGeneration: 4,
  });
  const now = tick(1800);
  await service.reconcileDrain('env-test');
  recovery = await service.confirmRestore('env-test', {
    operationId: recovery.operationId,
    restoreReferenceDigest: 'b'.repeat(64),
    restoredAt: now - 5,
    requestedById: 'admin-a',
    idempotencyKey: 'restore-a',
  });
  recovery = await service.recordVerification('env-test', {
    operationId: recovery.operationId,
    stage: 'migration',
    pinnedRouteGeneration: 7,
    targets: evidence(recovery),
  });
  const stages = [
    'cleanup',
    'account_id',
    'email_exact',
    'external_core',
    'external_pii',
    'verify',
  ];
  let work = await service.claimLookupReprojection('env-test', {
    operationId: recovery.operationId,
    ownerId: 'owner-a',
    registryDigest: REGISTRY_DIGEST,
    lookupShardCount: 1,
  });
  for (let index = 0; index < stages.length; index += 1) {
    const last = index === stages.length - 1;
    await service.checkpointLookupReprojection('env-test', {
      operationId: work.operationId,
      ownerId: work.ownerId,
      fencingToken: work.fencingToken,
      registryDigest: REGISTRY_DIGEST,
      lookupShardCount: 1,
      stage: stages[index] as 'cleanup',
      nextStage: (last ? 'verify' : stages[index + 1]) as 'cleanup',
      targetIndex: last ? 1 : 0,
      afterCreatedAt: 0,
      afterId: '',
      afterRowId: 0,
      projectedRowsDelta: 0,
      verifiedRowsDelta: 0,
    });
    work = await service.claimLookupReprojection('env-test', {
      operationId: work.operationId,
      ownerId: 'owner-a',
      registryDigest: REGISTRY_DIGEST,
      lookupShardCount: 1,
    });
  }
  return service.completeLookupReprojection('env-test', {
    operationId: work.operationId,
    ownerId: work.ownerId,
    fencingToken: work.fencingToken,
    registryDigest: REGISTRY_DIGEST,
  });
}

/** Marks the worker binding reconciliation and its three steps as fully succeeded. */
export function completeBindingWork(database: DatabaseSync, operationId: string, now: number) {
  database
    .prepare(
      `UPDATE control_worker_binding_reconciliations
          SET state = 'succeeded', expected_source_version_id = 'version-a',
              previous_restore_settings_json = '{}', completed_at = ?, updated_at = ?
        WHERE operation_id = ?`
    )
    .run(now, now, operationId);
  for (const status of ['running', 'succeeded']) {
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND step_key IN (
            'reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings')`
      )
      .run(status, now, now, operationId);
  }
}

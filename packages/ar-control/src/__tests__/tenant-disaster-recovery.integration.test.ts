import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { TenantDisasterRecoveryService } from '../tenant-disaster-recovery';

type SqliteValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HASH = 'a'.repeat(64);

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('required_test_value_missing');
  return value;
}

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqliteValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }

  async run() {
    return this.executeRun();
  }

  executeRun() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error(`unsupported_test_sqlite_value:${typeof value}`);
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch(statements: unknown[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof BoundStatement)) throw new Error('invalid_test_statement');
          return statement.executeRun();
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function seed(database: DatabaseSync): void {
  for (const filename of readdirSync(resolve(REPO_ROOT, 'migrations/control'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    database.exec(readFileSync(resolve(REPO_ROOT, 'migrations/control', filename), 'utf8'));
  }
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
    ) VALUES ('env-test', 'd1-core', '0.4.0-test', '${HASH}',
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

function evidence(view: Awaited<ReturnType<TenantDisasterRecoveryService['start']>>) {
  return view.targets.map((entry) => ({
    shardId: entry.shardId,
    providerDatabaseId: entry.providerDatabaseId,
    shardGeneration: entry.shardGeneration,
    bindingRef: entry.bindingRef,
    releaseId: entry.releaseId,
    manifestDigest: entry.manifestDigest,
  }));
}

describe('tenant disaster recovery', () => {
  let database: DatabaseSync;
  let now: number;
  let service: TenantDisasterRecoveryService;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    seed(database);
    now = 2_000_000_000;
    service = new TenantDisasterRecoveryService(d1(database), () => now);
  });

  it('pins identity, drains for 30 minutes, and requires every verification before reactivation', async () => {
    let recovery = await service.start('env-test', {
      tenantId: 'tenant-a',
      requestedById: 'admin-a',
      reasonCode: 'operator_disaster_recovery',
      idempotencyKey: 'dr-a',
    });
    expect(recovery).toMatchObject({
      state: 'publishing_deny',
      pinnedRouteGeneration: 7,
      canCancel: true,
    });
    expect(recovery.targets).toHaveLength(1);

    await expect(
      Promise.resolve().then(() =>
        database
          .prepare(
            `INSERT INTO control_tenant_default_allocations (
             allocation_id, environment_id, tenant_id, residency_policy_id, residency_partition,
             selected_shard_id, reservation_state, idempotency_key, route_generation,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            'blocked-allocation',
            'env-test',
            'tenant-a',
            'tenant_core/default',
            'apac',
            'shard-a',
            'reserved',
            'blocked',
            7,
            now,
            now
          )
      )
    ).rejects.toThrow('control_tenant_dr_allocation_blocked');

    recovery = await service.observeDeny('env-test', {
      operationId: recovery.operationId,
      runtimeGeneration: 12,
      denyRegistryGeneration: 4,
    });
    expect(recovery).toMatchObject({ state: 'draining', drainNotBefore: now + 1800 });
    await expect(
      service.cancel('env-test', {
        operationId: recovery.operationId,
        requestedById: 'admin-a',
        reasonCode: 'operator_cancel_before_deny',
        idempotencyKey: 'cancel-after-deny',
      })
    ).rejects.toThrow('control_tenant_dr_cancel_not_allowed');

    now += 1799;
    expect(await service.reconcileDrain('env-test')).toEqual({ advanced: 0 });
    now += 1;
    expect(await service.reconcileDrain('env-test')).toEqual({ advanced: 1 });
    recovery = required(await service.get('env-test', recovery.operationId));
    expect(recovery).toMatchObject({ state: 'operator_restore_required', canConfirmRestore: true });

    const restoreRequest = {
      operationId: recovery.operationId,
      restoreReferenceDigest: 'b'.repeat(64),
      restoredAt: now - 10,
      requestedById: 'admin-a',
      idempotencyKey: 'restore-a',
    };
    recovery = await service.confirmRestore('env-test', restoreRequest);
    expect(recovery.restoreReferenceRecorded).toBe(true);
    expect(JSON.stringify(recovery)).not.toContain('b'.repeat(64));
    expect(await service.confirmRestore('env-test', restoreRequest)).toEqual(recovery);
    await expect(
      service.confirmRestore('env-test', {
        ...restoreRequest,
        restoreReferenceDigest: 'd'.repeat(64),
      })
    ).rejects.toThrow('control_tenant_dr_restore_idempotency_conflict');
    await expect(
      service.confirmRestore('env-test', { ...restoreRequest, idempotencyKey: 'restore-b' })
    ).rejects.toThrow('control_tenant_dr_restore_idempotency_conflict');
    await expect(
      service.confirmRestore('env-test', { ...restoreRequest, requestedById: 'admin-b' })
    ).rejects.toThrow('control_tenant_dr_restore_idempotency_conflict');

    await expect(
      service.recordVerification('env-test', {
        operationId: recovery.operationId,
        stage: 'migration',
        pinnedRouteGeneration: 7,
        targets: evidence(recovery).map((entry) => ({ ...entry, bindingRef: 'WRONG' })),
      })
    ).rejects.toThrow('control_tenant_dr_verification_target_mismatch');

    recovery = await service.recordVerification('env-test', {
      operationId: recovery.operationId,
      stage: 'migration',
      pinnedRouteGeneration: 7,
      targets: evidence(recovery),
    });
    const registryDigest = 'c'.repeat(64);
    let work = await service.claimLookupReprojection('env-test', {
      operationId: recovery.operationId,
      ownerId: 'lookup-owner-a',
      registryDigest,
      lookupShardCount: 1,
    });
    expect(work.progress).toMatchObject({ stage: 'cleanup', targetIndex: 0 });
    const staleWork = work;
    now += 121;
    work = await service.claimLookupReprojection('env-test', {
      operationId: recovery.operationId,
      ownerId: 'lookup-owner-b',
      registryDigest,
      lookupShardCount: 1,
    });
    await expect(
      service.checkpointLookupReprojection('env-test', {
        operationId: staleWork.operationId,
        ownerId: staleWork.ownerId,
        fencingToken: staleWork.fencingToken,
        registryDigest,
        lookupShardCount: 1,
        stage: 'cleanup',
        nextStage: 'cleanup',
        targetIndex: 1,
        afterCreatedAt: 0,
        afterId: '',
        afterRowId: 0,
        projectedRowsDelta: 0,
        verifiedRowsDelta: 0,
      })
    ).rejects.toThrow('control_tenant_dr_lookup_stale_lease');
    await service.checkpointLookupReprojection('env-test', {
      operationId: work.operationId,
      ownerId: work.ownerId,
      fencingToken: work.fencingToken,
      registryDigest,
      lookupShardCount: 1,
      stage: 'cleanup',
      nextStage: 'account_id',
      targetIndex: 0,
      afterCreatedAt: 0,
      afterId: '',
      afterRowId: 0,
      projectedRowsDelta: 0,
      verifiedRowsDelta: 0,
    });
    for (const [stage, nextStage, projectedRowsDelta] of [
      ['account_id', 'email_exact', 2],
      ['email_exact', 'external_core', 0],
      ['external_core', 'external_pii', 0],
      ['external_pii', 'verify', 0],
    ] as const) {
      work = await service.claimLookupReprojection('env-test', {
        operationId: recovery.operationId,
        ownerId: `lookup-owner-${stage}`,
        registryDigest,
        lookupShardCount: 1,
      });
      await service.checkpointLookupReprojection('env-test', {
        operationId: work.operationId,
        ownerId: work.ownerId,
        fencingToken: work.fencingToken,
        registryDigest,
        lookupShardCount: 1,
        stage,
        nextStage,
        targetIndex: 0,
        afterCreatedAt: 0,
        afterId: '',
        afterRowId: 0,
        projectedRowsDelta,
        verifiedRowsDelta: 0,
      });
    }
    work = await service.claimLookupReprojection('env-test', {
      operationId: recovery.operationId,
      ownerId: 'lookup-owner-verify',
      registryDigest,
      lookupShardCount: 1,
    });
    await service.checkpointLookupReprojection('env-test', {
      operationId: work.operationId,
      ownerId: work.ownerId,
      fencingToken: work.fencingToken,
      registryDigest,
      lookupShardCount: 1,
      stage: 'verify',
      nextStage: 'verify',
      targetIndex: 1,
      afterCreatedAt: 0,
      afterId: '',
      afterRowId: 0,
      projectedRowsDelta: 0,
      verifiedRowsDelta: 2,
    });
    work = await service.claimLookupReprojection('env-test', {
      operationId: recovery.operationId,
      ownerId: 'lookup-owner-complete',
      registryDigest,
      lookupShardCount: 1,
    });
    recovery = await service.completeLookupReprojection('env-test', {
      operationId: work.operationId,
      ownerId: work.ownerId,
      fencingToken: work.fencingToken,
      registryDigest,
    });
    expect(
      database
        .prepare(
          `SELECT status, progress_current, progress_total
             FROM control_operation_steps
            WHERE operation_id = ? AND step_key = 'verify_runtime_bindings'`
        )
        .get(recovery.operationId)
    ).toEqual({ status: 'running', progress_current: 0, progress_total: 1 });
    await expect(
      service.recordVerification('env-test', {
        operationId: recovery.operationId,
        stage: 'binding_smoke',
        pinnedRouteGeneration: 7,
        targets: evidence(recovery),
      })
    ).rejects.toThrow('control_tenant_dr_binding_smoke_incomplete');
    expect(await service.handoffBindingSmokeToSetup('env-test')).toEqual({ handedOff: 1 });
    expect(
      database
        .prepare(`SELECT status, last_error_code FROM control_operations WHERE operation_id = ?`)
        .get(recovery.operationId)
    ).toEqual({ status: 'blocked', last_error_code: 'operator_action_required' });
    expect(
      database
        .prepare(
          `SELECT status, last_error_code FROM control_operation_steps
            WHERE operation_id = ? AND step_key = 'reconcile_worker_bindings'`
        )
        .get(recovery.operationId)
    ).toEqual({ status: 'blocked', last_error_code: 'operator_action_required' });
    database
      .prepare(
        `UPDATE control_operations
            SET status = 'running', last_error_code = NULL, last_error_redacted = NULL
          WHERE operation_id = ?`
      )
      .run(recovery.operationId);
    database
      .prepare(
        `UPDATE control_worker_binding_reconciliations
            SET state = 'succeeded', expected_source_version_id = 'version-a',
                previous_restore_settings_json = '{}', completed_at = ?, updated_at = ?
          WHERE operation_id = ?`
      )
      .run(now, now, recovery.operationId);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE operation_id = ? AND step_key IN (
            'reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings'
          )`
      )
      .run(now, now, recovery.operationId);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'succeeded', progress_current = progress_total,
                completed_at = ?, last_error_code = NULL, last_error_redacted = NULL,
                updated_at = ?
          WHERE operation_id = ? AND step_key IN (
            'reconcile_worker_bindings', 'smoke_bindings', 'stabilize_bindings'
          )`
      )
      .run(now, now, recovery.operationId);
    database
      .prepare(
        `UPDATE control_operation_steps
            SET status = 'running', last_error_code = NULL, last_error_redacted = NULL,
                updated_at = ?
          WHERE operation_id = ? AND step_key = 'verify_runtime_bindings'`
      )
      .run(now, recovery.operationId);
    expect(await service.reconcileBindingSmoke('env-test')).toEqual({ completed: 1 });
    recovery = required(await service.get('env-test', recovery.operationId));
    expect(
      database
        .prepare(
          `SELECT status, progress_current, progress_total
             FROM control_operation_steps
            WHERE operation_id = ? AND step_key = 'verify_runtime_bindings'`
        )
        .get(recovery.operationId)
    ).toEqual({ status: 'succeeded', progress_current: 1, progress_total: 1 });
    expect(recovery).toMatchObject({ state: 'ready_for_reactivation', canReactivate: true });

    const reactivationRequest = {
      operationId: recovery.operationId,
      requestedById: 'admin-a',
      reasonCode: 'operator_reactivate_recovered_tenant' as const,
      idempotencyKey: 'reactivate-a',
    };
    recovery = await service.requestReactivation('env-test', reactivationRequest);
    expect(await service.requestReactivation('env-test', reactivationRequest)).toEqual(recovery);
    await expect(
      service.requestReactivation('env-test', {
        ...reactivationRequest,
        idempotencyKey: 'reactivate-b',
      })
    ).rejects.toThrow('control_tenant_dr_reactivation_idempotency_conflict');
    await expect(
      service.requestReactivation('env-test', {
        ...reactivationRequest,
        requestedById: 'admin-b',
      })
    ).rejects.toThrow('control_tenant_dr_reactivation_idempotency_conflict');
    recovery = await service.completeReactivation('env-test', {
      operationId: recovery.operationId,
      runtimeGeneration: 13,
      pinnedRouteGeneration: 7,
    });
    expect(recovery).toMatchObject({
      state: 'succeeded',
      pinnedRouteGeneration: 7,
      reactivatedRuntimeGeneration: 13,
    });
    expect(await service.requestReactivation('env-test', reactivationRequest)).toEqual(recovery);
  });

  it('is idempotent at start and only allows cancel before deny publication', async () => {
    const request = {
      tenantId: 'tenant-a',
      requestedById: 'admin-a',
      reasonCode: 'operator_disaster_recovery' as const,
      idempotencyKey: 'dr-idempotent',
    };
    const first = await service.start('env-test', request);
    expect(await service.start('env-test', request)).toEqual(first);
    const canceled = await service.cancel('env-test', {
      operationId: first.operationId,
      requestedById: 'admin-a',
      reasonCode: 'operator_cancel_before_deny',
      idempotencyKey: 'cancel-a',
    });
    expect(canceled.state).toBe('canceled');
    expect(
      await service.cancel('env-test', {
        operationId: first.operationId,
        requestedById: 'admin-a',
        reasonCode: 'operator_cancel_before_deny',
        idempotencyKey: 'cancel-a',
      })
    ).toEqual(canceled);
    await expect(
      service.cancel('env-test', {
        operationId: first.operationId,
        requestedById: 'admin-a',
        reasonCode: 'operator_cancel_before_deny',
        idempotencyKey: 'cancel-b',
      })
    ).rejects.toThrow('control_tenant_dr_cancel_idempotency_conflict');
    await expect(
      service.cancel('env-test', {
        operationId: first.operationId,
        requestedById: 'admin-b',
        reasonCode: 'operator_cancel_before_deny',
        idempotencyKey: 'cancel-a',
      })
    ).rejects.toThrow('control_tenant_dr_cancel_idempotency_conflict');
    expect(() =>
      database
        .prepare(
          `UPDATE control_tenant_disaster_recovery_operations
              SET cancel_idempotency_key = 'cancel-rewritten'
            WHERE operation_id = ?`
        )
        .run(first.operationId)
    ).toThrow('control_tenant_dr_command_idempotency_immutable');
    expect(() =>
      database
        .prepare(
          `UPDATE control_tenant_disaster_recovery_operations
              SET cancel_requested_by = 'admin-rewritten'
            WHERE operation_id = ?`
        )
        .run(first.operationId)
    ).toThrow('control_tenant_dr_command_idempotency_immutable');
  });

  it('serializes disaster recovery with Lookup topology and HMAC mutations', async () => {
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, created_at, updated_at
      ) VALUES ('rotation-a', 'env-test', 'rotate_lookup_hmac_key', 'rotation-a', 'running',
        'scheduler', 'control', 1, 1, 1);
      INSERT INTO control_hmac_rotation_operations (
        operation_id, environment_id, normalization_version,
        source_key_generation, source_key_id, source_key_slot, source_key_fingerprint,
        candidate_key_generation, candidate_key_id, candidate_key_slot,
        candidate_key_fingerprint, state, active_operation_key, updated_at
      ) VALUES ('rotation-a', 'env-test', 1,
        1, 'source-a', 'A', '${'b'.repeat(64)}',
        2, 'candidate-b', 'B', '${'c'.repeat(64)}',
        'reindexing', 'active', 1);
    `);
    await expect(
      service.start('env-test', {
        tenantId: 'tenant-a',
        requestedById: 'admin-a',
        reasonCode: 'operator_disaster_recovery',
        idempotencyKey: 'dr-topology-busy',
      })
    ).rejects.toThrow('control_tenant_dr_lookup_topology_busy');

    database.exec(`
      UPDATE control_hmac_rotation_operations
         SET state = 'blocked', active_operation_key = 'operation:' || operation_id
       WHERE operation_id = 'rotation-a';
    `);
    await service.start('env-test', {
      tenantId: 'tenant-a',
      requestedById: 'admin-a',
      reasonCode: 'operator_disaster_recovery',
      idempotencyKey: 'dr-topology-lock',
    });
    expect(() =>
      database.exec(`
        INSERT INTO control_operations (
          operation_id, environment_id, operation_kind, idempotency_key, status,
          requested_by_type, requested_by_id, attempt_count, created_at, updated_at
        ) VALUES ('projection-a', 'env-test', 'migrate_route_projection', 'projection-a',
          'running', 'scheduler', 'control', 1, 2, 2);
        INSERT INTO control_route_projection_migrations (
          operation_id, environment_id, current_schema_version, previous_schema_version,
          state, active_operation_key, updated_at
        ) VALUES ('projection-a', 'env-test', 2, 1, 'planned', 'active', 2);
      `)
    ).toThrow('control_tenant_dr_lookup_topology_locked');
  });
});

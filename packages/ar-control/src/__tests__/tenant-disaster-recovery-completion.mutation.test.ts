import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { TenantDisasterRecoveryService } from '../tenant-disaster-recovery';
import {
  START,
  advanceToSmoke,
  completeBindingWork,
  evidence,
  seedTenantDr,
} from './support/tenant-dr-fixtures';
import { controlDatabase, d1Over, dropTriggers } from './support/sqlite-d1';

const NOW = 2_000_000_000;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing_value');
  return value;
}
const E = 'env-test';
let database: DatabaseSync;
let now: number;
let service: TenantDisasterRecoveryService;

beforeEach(() => {
  database = controlDatabase();
  seedTenantDr(database);
  now = NOW;
  service = new TenantDisasterRecoveryService(d1Over(database), () => now);
});

const tick = (seconds: number) => (now += seconds);
const row = (sql: string) => database.prepare(sql).get();
const operationRow = () =>
  row(
    `SELECT status, completed_at, last_error_code, last_error_redacted, next_attempt_at
       FROM control_operations WHERE operation_kind = 'tenant_disaster_recovery'`
  );
const smoke = (operationId: string, targets: ReturnType<typeof evidence>) => ({
  operationId,
  stage: 'binding_smoke' as const,
  pinnedRouteGeneration: 7,
  targets,
});

describe('cancellation', () => {
  const cancel = (operationId: string, patch: Record<string, unknown> = {}) =>
    service.cancel(E, {
      operationId,
      requestedById: 'admin-a',
      reasonCode: 'operator_cancel_before_deny',
      idempotencyKey: 'cancel-a',
      ...patch,
    });

  it.each([
    ['requester', { requestedById: 'a b' }],
    ['idempotency key', { idempotencyKey: '' }],
    ['reason', { reasonCode: 'other' }],
  ])('rejects a cancellation with an invalid %s', async (_label, patch) => {
    const recovery = await service.start(E, START);
    await expect(cancel(recovery.operationId, patch)).rejects.toThrow(
      'invalid_tenant_disaster_recovery_request'
    );
  });

  it('rejects cancelling an unknown operation', async () => {
    await expect(cancel('missing')).rejects.toThrow('control_tenant_dr_operation_not_found');
  });

  it('cancels before deny publication, closing the operation and its steps', async () => {
    const recovery = await service.start(E, START);
    now += 10;
    const canceled = await cancel(recovery.operationId);
    expect(canceled).toMatchObject({ state: 'canceled', canCancel: false, updatedAt: now });
    expect(
      row(
        `SELECT recovery_state, active_operation_key, cancel_idempotency_key, cancel_requested_by,
                completed_at FROM control_tenant_disaster_recovery_operations`
      )
    ).toEqual({
      recovery_state: 'canceled',
      active_operation_key: null,
      cancel_idempotency_key: 'cancel-a',
      cancel_requested_by: 'admin-a',
      completed_at: now,
    });
    expect(operationRow()).toMatchObject({ status: 'canceled', completed_at: now });
    expect(
      database.prepare('SELECT DISTINCT status FROM control_operation_steps ORDER BY status').all()
    ).toEqual([{ status: 'canceled' }]);
    expect(
      row(
        `SELECT actor_id, resource_id, outcome FROM control_audit_events
          WHERE event_type = 'control.tenant_dr.canceled_before_deny'`
      )
    ).toEqual({ actor_id: 'admin-a', resource_id: recovery.operationId, outcome: 'succeeded' });
    await expect(cancel(recovery.operationId)).resolves.toEqual(canceled);
    await expect(cancel(recovery.operationId, { requestedById: 'admin-b' })).rejects.toThrow(
      'control_tenant_dr_cancel_idempotency_conflict'
    );
    await expect(cancel(recovery.operationId, { idempotencyKey: 'cancel-b' })).rejects.toThrow(
      'control_tenant_dr_cancel_idempotency_conflict'
    );
  });
});

describe('binding smoke and reactivation', () => {
  async function smokeStage() {
    const recovery = await advanceToSmoke(service, tick);
    expect(recovery.state).toBe('smoke_verifying');
    return recovery;
  }

  it('rejects the smoke stage while bindings are unfinished and hands them to setup', async () => {
    const recovery = await smokeStage();
    await expect(
      service.recordVerification(E, smoke(recovery.operationId, evidence(recovery)))
    ).rejects.toThrow('control_tenant_dr_binding_smoke_incomplete');
    expect(await service.reconcileBindingSmoke('other-env')).toEqual({ completed: 0 });
    expect(await service.reconcileBindingSmoke(E)).toEqual({ completed: 0 });
    expect(await service.handoffBindingSmokeToSetup('other-env')).toEqual({ handedOff: 0 });
    expect(await service.handoffBindingSmokeToSetup(E)).toEqual({ handedOff: 1 });
    expect(await service.handoffBindingSmokeToSetup()).toEqual({ handedOff: 0 });
    expect(operationRow()).toEqual({
      status: 'blocked',
      completed_at: null,
      last_error_code: 'operator_action_required',
      last_error_redacted: 'Continue this operation with setup.',
      next_attempt_at: null,
    });
    expect(
      database
        .prepare(
          `SELECT step_key, status FROM control_operation_steps
            WHERE step_key IN ('verify_runtime_bindings', 'reconcile_worker_bindings')
            ORDER BY step_key`
        )
        .all()
    ).toEqual([
      { step_key: 'reconcile_worker_bindings', status: 'blocked' },
      { step_key: 'verify_runtime_bindings', status: 'blocked' },
    ]);
    expect(
      row(
        `SELECT event_id, actor_type, outcome FROM control_audit_events
          WHERE event_type = 'control.tenant_dr.operator_handoff'`
      )
    ).toEqual({
      event_id: `audit:${recovery.operationId}:binding-operator-handoff`,
      actor_type: 'reconciler',
      outcome: 'blocked',
    });
  });

  it.each([
    [
      'a missing reconciliation',
      'DELETE FROM control_worker_binding_reconciliations',
      'control_tenant_dr_binding_smoke_incomplete',
    ],
    [
      'a pending reconciliation',
      "UPDATE control_worker_binding_reconciliations SET state = 'pending'",
      'control_tenant_dr_binding_smoke_incomplete',
    ],
    [
      'a different shard',
      "UPDATE control_worker_binding_reconciliations SET shard_id = 'other'",
      'control_tenant_dr_binding_target_mismatch',
    ],
    [
      'a different binding',
      "UPDATE control_worker_binding_reconciliations SET binding_ref = 'OTHER'",
      'control_tenant_dr_binding_target_mismatch',
    ],
    [
      'a different provider database',
      "UPDATE control_worker_binding_reconciliations SET provider_database_id = 'other'",
      'control_tenant_dr_binding_target_mismatch',
    ],
    [
      'a different generation',
      'UPDATE control_worker_binding_reconciliations SET migration_generation = 99',
      'control_tenant_dr_binding_target_mismatch',
    ],
  ])('rejects the smoke stage with %s', async (_label, statement, code) => {
    const recovery = await smokeStage();
    completeBindingWork(database, recovery.operationId, now);
    dropTriggers(database);
    database.exec(statement);
    await expect(
      service.recordVerification(E, smoke(recovery.operationId, evidence(recovery)))
    ).rejects.toThrow(code);
  });

  it('rejects the smoke stage while a binding step is unfinished', async () => {
    const recovery = await smokeStage();
    completeBindingWork(database, recovery.operationId, now);
    dropTriggers(database);
    database.exec(
      "UPDATE control_operation_steps SET status = 'blocked' WHERE step_key = 'stabilize_bindings'"
    );
    await expect(
      service.recordVerification(E, smoke(recovery.operationId, evidence(recovery)))
    ).rejects.toThrow('control_tenant_dr_binding_smoke_incomplete');
  });

  it('rethrows unexpected failures from the smoke reconciler', async () => {
    const recovery = await smokeStage();
    completeBindingWork(database, recovery.operationId, now);
    dropTriggers(database);
    database.exec("UPDATE control_worker_binding_reconciliations SET shard_id = 'other'");
    await expect(service.reconcileBindingSmoke()).rejects.toThrow(
      'control_tenant_dr_binding_target_mismatch'
    );
  });

  it('completes recovery after the smoke, reactivation request and observation', async () => {
    const recovery = await smokeStage();
    completeBindingWork(database, recovery.operationId, now);
    expect(await service.reconcileBindingSmoke()).toEqual({ completed: 1 });
    const ready = await service.get(E, recovery.operationId);
    expect(ready).toMatchObject({ state: 'ready_for_reactivation', canReactivate: true });
    expect(ready?.bindingSmokeVerifiedAt).toBe(now);

    const request = {
      operationId: recovery.operationId,
      requestedById: 'admin-a',
      reasonCode: 'operator_reactivate_recovered_tenant' as const,
      idempotencyKey: 'reactivate-a',
    };
    for (const patch of [
      { requestedById: 'a b' },
      { idempotencyKey: '' },
      { reasonCode: 'other' },
    ]) {
      await expect(
        service.requestReactivation(E, { ...request, ...patch } as typeof request)
      ).rejects.toThrow('invalid_tenant_disaster_recovery_request');
    }
    const reactivating = await service.requestReactivation(E, request);
    expect(reactivating.state).toBe('reactivating');
    expect(
      row(
        `SELECT status, attempt_count FROM control_operation_steps WHERE step_key = 'reactivate_route'`
      )
    ).toEqual({ status: 'running', attempt_count: 1 });

    const observation = {
      operationId: recovery.operationId,
      runtimeGeneration: 13,
      pinnedRouteGeneration: 7,
    };
    for (const patch of [{ runtimeGeneration: 0 }, { runtimeGeneration: 1.5 }]) {
      await expect(service.completeReactivation(E, { ...observation, ...patch })).rejects.toThrow(
        'control_tenant_dr_reactivation_generation_invalid'
      );
    }
    for (const patch of [
      { runtimeGeneration: 12 },
      { runtimeGeneration: 11 },
      { pinnedRouteGeneration: 8 },
    ]) {
      await expect(service.completeReactivation(E, { ...observation, ...patch })).rejects.toThrow(
        'control_tenant_dr_reactivation_observation_invalid'
      );
    }
    tick(5);
    const done = await service.completeReactivation(E, observation);
    expect(done).toMatchObject({
      state: 'succeeded',
      reactivatedRuntimeGeneration: 13,
      reactivatedAt: now,
    });
    expect(
      row(
        `SELECT active_operation_key, completed_at FROM control_tenant_disaster_recovery_operations`
      )
    ).toEqual({ active_operation_key: null, completed_at: now });
    expect(operationRow()).toMatchObject({ status: 'succeeded', completed_at: now });
    await expect(service.completeReactivation(E, observation)).rejects.toThrow(
      'control_tenant_dr_reactivation_observation_invalid'
    );
  });

  it.each([
    [
      'a different worker',
      "UPDATE control_worker_binding_reconciliations SET worker_script_name = 'other-worker'",
    ],
    [
      'a different data role',
      "UPDATE control_worker_binding_reconciliations SET data_role = 'tenant_pii'",
    ],
    [
      'a different partition',
      "UPDATE control_worker_binding_reconciliations SET residency_partition = 'eu'",
    ],
  ])('rejects the smoke stage with %s', async (_label, statement) => {
    const recovery = await smokeStage();
    completeBindingWork(database, recovery.operationId, now);
    dropTriggers(database);
    database.exec(statement);
    await expect(
      service.recordVerification(E, smoke(recovery.operationId, evidence(recovery)))
    ).rejects.toThrow('control_tenant_dr_binding_target_mismatch');
  });

  it('rejects the smoke stage when a binding step row is missing', async () => {
    const recovery = await smokeStage();
    completeBindingWork(database, recovery.operationId, now);
    dropTriggers(database);
    database.exec("DELETE FROM control_operation_steps WHERE step_key = 'smoke_bindings'");
    await expect(
      service.recordVerification(E, smoke(recovery.operationId, evidence(recovery)))
    ).rejects.toThrow('control_tenant_dr_binding_smoke_incomplete');
  });

  it('scopes the smoke reconciler to the requested environment', async () => {
    const recovery = await smokeStage();
    completeBindingWork(database, recovery.operationId, now);
    expect(await service.reconcileBindingSmoke('other-env')).toEqual({ completed: 0 });
    expect(await service.reconcileBindingSmoke(E)).toEqual({ completed: 1 });
    expect(
      row(`SELECT status FROM control_operation_steps WHERE step_key = 'verify_runtime_bindings'`)
    ).toEqual({ status: 'succeeded' });
  });

  it('rejects the lookup verification when no worker requires the data role', async () => {
    const recovery = await smokeStage();
    dropTriggers(database);
    database.exec(
      "UPDATE control_tenant_disaster_recovery_operations SET recovery_state = 'reprojecting_lookup'"
    );
    database.exec('DELETE FROM control_worker_required_data_roles');
    await expect(
      service.recordVerification(E, {
        operationId: recovery.operationId,
        stage: 'lookup_reprojection',
        pinnedRouteGeneration: 7,
        targets: evidence(recovery),
      })
    ).rejects.toThrow('control_tenant_dr_binding_targets_missing');
  });

  it('exposes the available actions of every stage', async () => {
    const flags = (recovery: {
      canCancel: boolean;
      canConfirmRestore: boolean;
      canVerify: boolean;
      canReactivate: boolean;
    }) => [
      recovery.canCancel,
      recovery.canConfirmRestore,
      recovery.canVerify,
      recovery.canReactivate,
    ];
    const started = await service.start(E, START);
    expect(flags(started)).toEqual([true, false, false, false]);
    expect(started.restoreReferenceRecorded).toBe(false);
    const draining = await service.observeDeny(E, {
      operationId: started.operationId,
      runtimeGeneration: 12,
      denyRegistryGeneration: 4,
    });
    expect(flags(draining)).toEqual([false, false, false, false]);
    tick(1800);
    await service.reconcileDrain(E);
    expect(flags(must(await service.get(E, started.operationId)))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    now -= 1;
    expect(flags(must(await service.get(E, started.operationId)))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    now += 1;
    const verifying = await service.confirmRestore(E, {
      operationId: started.operationId,
      restoreReferenceDigest: 'b'.repeat(64),
      restoredAt: now - 1,
      requestedById: 'admin-a',
      idempotencyKey: 'restore-a',
    });
    expect(flags(verifying)).toEqual([false, false, true, false]);
    expect(verifying.restoreReferenceRecorded).toBe(true);
    expect(verifying.lookupReprojection).toMatchObject({
      registryDigestPinned: false,
      leaseActive: false,
    });
  });

  it('reports the lookup lease and pin while a reprojection is claimed', async () => {
    const recovery = await smokeStage();
    dropTriggers(database);
    database.exec(
      `UPDATE control_tenant_disaster_recovery_operations
          SET recovery_state = 'reprojecting_lookup', lookup_reprojection_registry_digest = '${'c'.repeat(64)}',
              lookup_reprojection_shard_count = 1, lookup_reprojection_lease_owner = 'owner-a',
              lookup_reprojection_lease_expires_at = ${now + 10}`
    );
    const read = async () => must(await service.get(E, recovery.operationId)).lookupReprojection;
    expect(await read()).toMatchObject({ registryDigestPinned: true, leaseActive: true });
    now += 10;
    expect(await read()).toMatchObject({ leaseActive: false });
  });

  it('completes the reactivation step with the observation', async () => {
    const recovery = await smokeStage();
    completeBindingWork(database, recovery.operationId, now);
    await service.reconcileBindingSmoke();
    await service.requestReactivation(E, {
      operationId: recovery.operationId,
      requestedById: 'admin-a',
      reasonCode: 'operator_reactivate_recovered_tenant',
      idempotencyKey: 'reactivate-a',
    });
    await service.completeReactivation(E, {
      operationId: recovery.operationId,
      runtimeGeneration: 13,
      pinnedRouteGeneration: 7,
    });
    expect(
      row(
        `SELECT status, completed_at FROM control_operation_steps WHERE step_key = 'reactivate_route'`
      )
    ).toEqual({ status: 'succeeded', completed_at: now });
  });

  it('rejects reactivation before every verification has finished', async () => {
    const recovery = await smokeStage();
    await expect(
      service.requestReactivation(E, {
        operationId: recovery.operationId,
        requestedById: 'admin-a',
        reasonCode: 'operator_reactivate_recovered_tenant',
        idempotencyKey: 'reactivate-a',
      })
    ).rejects.toThrow('control_tenant_dr_reactivation_not_allowed');
  });

  it('fails the smoke reconciler when no worker requires the data role', async () => {
    const recovery = await smokeStage();
    expect(recovery.lookupReprojectedAt).toBe(now);
    database.exec('DELETE FROM control_worker_required_data_roles');
    await expect(service.reconcileBindingSmoke()).rejects.toThrow(
      'control_tenant_dr_binding_targets_missing'
    );
  });
});

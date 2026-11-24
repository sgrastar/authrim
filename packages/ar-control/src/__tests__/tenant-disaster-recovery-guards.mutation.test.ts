import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { TenantDisasterRecoveryService } from '../tenant-disaster-recovery';
import { REGISTRY_DIGEST, START, evidence, seedTenantDr } from './support/tenant-dr-fixtures';
import { controlDatabase, d1Over, dropTriggers } from './support/sqlite-d1';

const NOW = 2_000_000_000;
let database: DatabaseSync;
let now: number;
let service: TenantDisasterRecoveryService;

beforeEach(() => {
  database = controlDatabase();
  seedTenantDr(database);
  now = NOW;
  service = new TenantDisasterRecoveryService(d1Over(database), () => now);
});

const E = 'env-test';
const row = (sql: string) => database.prepare(sql).get();

async function started() {
  return service.start(E, START);
}

async function draining() {
  const recovery = await started();
  return service.observeDeny(E, {
    operationId: recovery.operationId,
    runtimeGeneration: 12,
    denyRegistryGeneration: 4,
  });
}

async function restoreRequired() {
  const recovery = await draining();
  now += 1800;
  await service.reconcileDrain(E);
  return recovery;
}

const restoreRequest = (operationId: string) => ({
  operationId,
  restoreReferenceDigest: 'b'.repeat(64),
  restoredAt: NOW + 1790,
  requestedById: 'admin-a',
  idempotencyKey: 'restore-a',
});

async function verifyingRestore() {
  const recovery = await restoreRequired();
  return service.confirmRestore(E, restoreRequest(recovery.operationId));
}

async function reprojecting() {
  const recovery = await verifyingRestore();
  return service.recordVerification(E, {
    operationId: recovery.operationId,
    stage: 'migration',
    pinnedRouteGeneration: 7,
    targets: evidence(recovery),
  });
}

const claim = (operationId: string, overrides: Record<string, unknown> = {}) =>
  service.claimLookupReprojection(E, {
    operationId,
    ownerId: 'owner-a',
    registryDigest: REGISTRY_DIGEST,
    lookupShardCount: 1,
    ...overrides,
  });

const BAD_IDS: [string, unknown][] = [
  ['an empty id', ''],
  ['a numeric id', 5],
  ['an id with a space', 'a b'],
  ['an overlong id', 'x'.repeat(257)],
];

describe('tenant disaster recovery request validation', () => {
  it.each(BAD_IDS)('rejects %s for the environment', async (_label, value) => {
    await expect(service.get(value, 'op')).rejects.toThrow(
      'invalid_tenant_disaster_recovery_request'
    );
    await expect(service.start(value, START)).rejects.toThrow(
      'invalid_tenant_disaster_recovery_request'
    );
  });

  it('returns null for an unknown operation', async () => {
    await expect(service.get(E, 'missing')).resolves.toBeNull();
  });

  it.each([
    ['tenant', { tenantId: '' }],
    ['requester', { requestedById: 7 }],
    ['idempotency key', { idempotencyKey: 'a b' }],
    ['reason', { reasonCode: 'other' }],
  ])('rejects a start with an invalid %s', async (_label, patch) => {
    await expect(service.start(E, { ...START, ...patch } as typeof START)).rejects.toThrow(
      'invalid_tenant_disaster_recovery_request'
    );
  });

  it('rejects a tenant without an active route', async () => {
    await expect(service.start(E, { ...START, tenantId: 'tenant-z' })).rejects.toThrow(
      'control_tenant_dr_active_route_missing'
    );
  });

  it.each([
    [
      'a projection missing the assigned shard',
      `'{"targets":[]}'`,
      'control_tenant_dr_route_projection_mismatch',
    ],
    [
      'a projection naming an unassigned shard',
      `'{"targets":[{"shardId":"shard-a"},{"shardId":"shard-z"}]}'`,
      'control_tenant_dr_route_projection_mismatch',
    ],
  ])('rejects %s', async (_label, projection, code) => {
    database.exec(
      `UPDATE control_runtime_registry_routes SET route_projection_json = ${projection}`
    );
    await expect(started()).rejects.toThrow(code);
  });

  it('accepts a projection naming the shard in nested structures', async () => {
    database.exec(
      `UPDATE control_runtime_registry_routes SET route_projection_json = '{"a":[{"b":{"shardId":"shard-a"}}],"c":null}'`
    );
    await expect(started()).resolves.toMatchObject({ state: 'publishing_deny' });
  });
});

describe('deny observation and drain', () => {
  it.each([
    ['runtime generation zero', { runtimeGeneration: 0, denyRegistryGeneration: 4 }],
    ['fractional runtime generation', { runtimeGeneration: 1.5, denyRegistryGeneration: 4 }],
    ['registry generation zero', { runtimeGeneration: 3, denyRegistryGeneration: 0 }],
    ['string registry generation', { runtimeGeneration: 3, denyRegistryGeneration: '4' }],
  ])('rejects %s', async (_label, generations) => {
    const recovery = await started();
    await expect(
      service.observeDeny(E, { operationId: recovery.operationId, ...generations } as never)
    ).rejects.toThrow('control_tenant_dr_deny_generation_invalid');
  });

  it('records the deny observation, starts the drain step and audits nothing extra', async () => {
    const recovery = await draining();
    expect(recovery).toMatchObject({
      state: 'draining',
      denyRuntimeGeneration: 12,
      denyRegistryGeneration: 4,
      denyObservedAt: NOW,
      drainNotBefore: NOW + 1800,
      canCancel: false,
    });
    expect(
      database
        .prepare(
          `SELECT step_key, status, attempt_count FROM control_operation_steps
            WHERE step_key IN ('publish_signed_deny', 'drain_runtime_snapshots') ORDER BY step_key`
        )
        .all()
    ).toEqual([
      { step_key: 'drain_runtime_snapshots', status: 'running', attempt_count: 1 },
      { step_key: 'publish_signed_deny', status: 'succeeded', attempt_count: 0 },
    ]);
  });

  it('replays an identical observation and rejects a different one', async () => {
    const recovery = await draining();
    const same = {
      operationId: recovery.operationId,
      runtimeGeneration: 12,
      denyRegistryGeneration: 4,
    };
    await expect(service.observeDeny(E, same)).resolves.toEqual(recovery);
    await expect(service.observeDeny(E, { ...same, runtimeGeneration: 13 })).rejects.toThrow(
      'control_tenant_dr_deny_observation_conflict'
    );
    await expect(service.observeDeny(E, { ...same, denyRegistryGeneration: 5 })).rejects.toThrow(
      'control_tenant_dr_deny_observation_conflict'
    );
  });

  it('rejects an observation for an unknown operation', async () => {
    await expect(
      service.observeDeny(E, {
        operationId: 'missing',
        runtimeGeneration: 1,
        denyRegistryGeneration: 1,
      })
    ).rejects.toThrow('control_tenant_dr_operation_not_found');
  });

  it('drains only operations whose drain time has arrived and honours the environment filter', async () => {
    const recovery = await draining();
    expect(await service.reconcileDrain()).toEqual({ advanced: 0 });
    now = NOW + 1799;
    expect(await service.reconcileDrain(E)).toEqual({ advanced: 0 });
    now = NOW + 1800;
    expect(await service.reconcileDrain('other-env')).toEqual({ advanced: 0 });
    expect(await service.reconcileDrain()).toEqual({ advanced: 1 });
    expect(await service.reconcileDrain()).toEqual({ advanced: 0 });
    expect(await service.get(E, recovery.operationId)).toMatchObject({
      state: 'operator_restore_required',
      updatedAt: NOW + 1800,
      canConfirmRestore: true,
    });
    expect(
      database
        .prepare(
          `SELECT step_key, status FROM control_operation_steps
            WHERE step_key IN ('drain_runtime_snapshots', 'operator_restore') ORDER BY step_key`
        )
        .all()
    ).toEqual([
      { step_key: 'drain_runtime_snapshots', status: 'succeeded' },
      { step_key: 'operator_restore', status: 'running' },
    ]);
    await expect(service.reconcileDrain('bad id')).rejects.toThrow('invalid_environment_id');
  });
});

describe('restore confirmation', () => {
  it.each([
    [
      'a short digest',
      { restoreReferenceDigest: 'abc' },
      'control_tenant_dr_restore_reference_invalid',
    ],
    [
      'an uppercase digest',
      { restoreReferenceDigest: 'B'.repeat(64) },
      'control_tenant_dr_restore_reference_invalid',
    ],
    ['a zero timestamp', { restoredAt: 0 }, 'control_tenant_dr_restored_at_invalid'],
    ['a fractional timestamp', { restoredAt: 1.5 }, 'control_tenant_dr_restored_at_invalid'],
    [
      'a timestamp too far ahead',
      { restoredAt: NOW + 1800 + 301 },
      'control_tenant_dr_restored_at_invalid',
    ],
  ])('rejects %s', async (_label, patch, code) => {
    const recovery = await restoreRequired();
    await expect(
      service.confirmRestore(E, { ...restoreRequest(recovery.operationId), ...patch })
    ).rejects.toThrow(code);
  });

  it('accepts a timestamp exactly five minutes ahead', async () => {
    const recovery = await restoreRequired();
    await expect(
      service.confirmRestore(E, {
        ...restoreRequest(recovery.operationId),
        restoredAt: NOW + 1800 + 300,
      })
    ).resolves.toMatchObject({ state: 'verifying_restore', restoredAt: NOW + 1800 + 300 });
  });

  it('rejects a confirmation before the operator restore is required', async () => {
    const recovery = await draining();
    await expect(
      service.confirmRestore(E, { ...restoreRequest(recovery.operationId), restoredAt: NOW - 10 })
    ).rejects.toThrow('control_tenant_dr_restore_not_allowed');
  });

  it('records the confirmation on every target and completes the restore step', async () => {
    const recovery = await verifyingRestore();
    expect(recovery).toMatchObject({
      state: 'verifying_restore',
      restoredAt: NOW + 1790,
      canVerify: true,
    });
    expect(
      row('SELECT restore_confirmed_at FROM control_tenant_disaster_recovery_targets')
    ).toEqual({
      restore_confirmed_at: now,
    });
    expect(
      row(`SELECT status FROM control_operation_steps WHERE step_key = 'operator_restore'`)
    ).toEqual({ status: 'succeeded' });
    expect(
      row(
        `SELECT event_type, actor_id, redacted_payload_json FROM control_audit_events
          WHERE event_type = 'control.tenant_dr.restore_confirmed'`
      )
    ).toEqual({
      event_type: 'control.tenant_dr.restore_confirmed',
      actor_id: 'admin-a',
      redacted_payload_json: JSON.stringify({
        restoreReferenceRecorded: true,
        restoredAt: NOW + 1790,
      }),
    });
  });
});

describe('verification and lookup reprojection guards', () => {
  it('rejects verification evidence for a stale route generation', async () => {
    const recovery = await verifyingRestore();
    await expect(
      service.recordVerification(E, {
        operationId: recovery.operationId,
        stage: 'migration',
        pinnedRouteGeneration: 8,
        targets: evidence(recovery),
      })
    ).rejects.toThrow('control_tenant_dr_stale_route_generation');
  });

  it.each([
    ['an extra target', (list: ReturnType<typeof evidence>) => [...list, ...list]],
    ['no targets', () => []],
    [
      'another shard',
      (list: ReturnType<typeof evidence>) => list.map((e) => ({ ...e, shardId: 'z' })),
    ],
    [
      'another database',
      (list: ReturnType<typeof evidence>) => list.map((e) => ({ ...e, providerDatabaseId: 'z' })),
    ],
    [
      'another generation',
      (list: ReturnType<typeof evidence>) => list.map((e) => ({ ...e, shardGeneration: 99 })),
    ],
    [
      'another release',
      (list: ReturnType<typeof evidence>) => list.map((e) => ({ ...e, releaseId: 'z' })),
    ],
    [
      'another digest',
      (list: ReturnType<typeof evidence>) => list.map((e) => ({ ...e, manifestDigest: 'z' })),
    ],
  ])('rejects evidence with %s', async (_label, mutate) => {
    const recovery = await verifyingRestore();
    await expect(
      service.recordVerification(E, {
        operationId: recovery.operationId,
        stage: 'migration',
        pinnedRouteGeneration: 7,
        targets: mutate(evidence(recovery)),
      })
    ).rejects.toThrow('control_tenant_dr_verification_target_mismatch');
  });

  it.each([['lookup_reprojection'], ['binding_smoke'], ['unknown']])(
    'rejects the %s stage while the restore is being verified',
    async (stage) => {
      const recovery = await verifyingRestore();
      await expect(
        service.recordVerification(E, {
          operationId: recovery.operationId,
          stage: stage as 'migration',
          pinnedRouteGeneration: 7,
          targets: evidence(recovery),
        })
      ).rejects.toThrow('control_tenant_dr_verification_stage_invalid');
    }
  );

  it('marks migration verified on the operation, targets and steps', async () => {
    const recovery = await reprojecting();
    expect(recovery).toMatchObject({
      state: 'reprojecting_lookup',
      migrationVerifiedAt: NOW + 1800,
    });
    expect(recovery.targets[0]).toMatchObject({ migrationVerifiedAt: NOW + 1800 });
    expect(
      database
        .prepare(
          `SELECT step_key, status FROM control_operation_steps
            WHERE step_key IN ('verify_migrations', 'reproject_lookup') ORDER BY step_key`
        )
        .all()
    ).toEqual([
      { step_key: 'reproject_lookup', status: 'running' },
      { step_key: 'verify_migrations', status: 'succeeded' },
    ]);
  });

  it.each([
    ['an unsafe owner', { ownerId: 'a b' }, 'control_tenant_dr_lookup_owner_invalid'],
    [
      'a bad registry digest',
      { registryDigest: 'abc' },
      'control_tenant_dr_lookup_registry_digest_invalid',
    ],
    ['zero shards', { lookupShardCount: 0 }, 'control_tenant_dr_lookup_shard_count_invalid'],
    [
      'a fractional shard count',
      { lookupShardCount: 1.5 },
      'control_tenant_dr_lookup_shard_count_invalid',
    ],
    ['too many shards', { lookupShardCount: 4097 }, 'control_tenant_dr_lookup_shard_count_invalid'],
  ])('rejects a lookup claim with %s', async (_label, patch, code) => {
    const recovery = await reprojecting();
    await expect(claim(recovery.operationId, patch)).rejects.toThrow(code);
  });

  it('accepts the maximum shard count and rejects claims outside the reprojection state', async () => {
    const early = await verifyingRestore();
    await expect(claim(early.operationId)).rejects.toThrow(
      'control_tenant_dr_lookup_claim_conflict'
    );
    await service.recordVerification(E, {
      operationId: early.operationId,
      stage: 'migration',
      pinnedRouteGeneration: 7,
      targets: evidence(early),
    });
    await expect(claim(early.operationId, { lookupShardCount: 4096 })).resolves.toMatchObject({
      lookupShardCount: 4096,
      ownerId: 'owner-a',
      fencingToken: 1,
    });
  });

  it('refuses a second owner while the lease is live and a different registry digest', async () => {
    const recovery = await reprojecting();
    await claim(recovery.operationId);
    await expect(claim(recovery.operationId, { ownerId: 'owner-b' })).rejects.toThrow(
      'control_tenant_dr_lookup_claim_conflict'
    );
    await expect(claim(recovery.operationId, { registryDigest: 'd'.repeat(64) })).rejects.toThrow(
      'control_tenant_dr_lookup_claim_conflict'
    );
    await expect(claim(recovery.operationId)).resolves.toMatchObject({ fencingToken: 2 });
  });

  it('claims the next reprojection for an eligible owner only', async () => {
    const recovery = await reprojecting();
    const request = { ownerId: 'owner-a', registryDigest: REGISTRY_DIGEST, lookupShardCount: 1 };
    await expect(service.claimNextLookupReprojection(E, request)).resolves.toMatchObject({
      operationId: recovery.operationId,
    });
    await expect(
      service.claimNextLookupReprojection(E, { ...request, ownerId: 'owner-b' })
    ).resolves.toBeNull();
    now += 121;
    await expect(
      service.claimNextLookupReprojection(E, { ...request, ownerId: 'owner-b' })
    ).resolves.toMatchObject({ ownerId: 'owner-b' });
    await expect(service.claimNextLookupReprojection('other-env', request)).resolves.toBeNull();
  });
});

describe('start side effects', () => {
  it('records the audit event with the pinned generation and target count', async () => {
    const recovery = await started();
    expect(
      row(
        `SELECT event_type, actor_type, actor_id, resource_kind, resource_id, outcome,
                redacted_payload_json, created_at FROM control_audit_events
          WHERE event_type = 'control.tenant_dr.requested'`
      )
    ).toEqual({
      event_type: 'control.tenant_dr.requested',
      actor_type: 'admin',
      actor_id: 'admin-a',
      resource_kind: 'tenant',
      resource_id: 'tenant-a',
      outcome: 'succeeded',
      redacted_payload_json: JSON.stringify({ targetCount: 1, pinnedRouteGeneration: 7 }),
      created_at: NOW,
    });
    expect(recovery.targets).toHaveLength(1);
    await expect(started()).resolves.toEqual(recovery);
    expect(
      row(
        "SELECT COUNT(*) AS n FROM control_audit_events WHERE event_type LIKE 'control.tenant_dr.%'"
      )
    ).toEqual({ n: 1 });
  });

  it('is blocked by an unfinished route projection migration but not by a finished one', async () => {
    dropTriggers(database);
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, created_at, updated_at
      ) VALUES ('projection-a', 'env-test', 'migrate_route_projection', 'projection-a',
        'running', 'scheduler', 'control', 1, 2, 2);
      INSERT INTO control_route_projection_migrations (
        operation_id, environment_id, current_schema_version, previous_schema_version,
        state, active_operation_key, updated_at
      ) VALUES ('projection-a', 'env-test', 2, 1, 'planned', 'active', 2);`);
    await expect(started()).rejects.toThrow('control_tenant_dr_lookup_topology_busy');
    for (const state of ['complete', 'blocked']) {
      database.exec(
        `UPDATE control_route_projection_migrations SET state = '${state}', active_operation_key = 'operation:projection-a'`
      );
      await expect(started()).resolves.toMatchObject({ state: 'publishing_deny' });
      database.exec("DELETE FROM control_operation_steps WHERE operation_id LIKE 'tenant-dr:%'");
      database.exec('DELETE FROM control_tenant_disaster_recovery_targets');
      database.exec('DELETE FROM control_tenant_disaster_recovery_operations');
      database.exec('DELETE FROM control_audit_events');
      database.exec(
        "DELETE FROM control_operations WHERE operation_kind = 'tenant_disaster_recovery'"
      );
    }
  });

  it('rejects a restore replay that differs only in the restore time', async () => {
    const recovery = await restoreRequired();
    await service.confirmRestore(E, restoreRequest(recovery.operationId));
    await expect(
      service.confirmRestore(E, {
        ...restoreRequest(recovery.operationId),
        restoredAt: NOW + 1791,
      })
    ).rejects.toThrow('control_tenant_dr_restore_idempotency_conflict');
  });
});

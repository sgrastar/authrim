import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { TenantDisasterRecoveryService } from '../tenant-disaster-recovery';
import { REGISTRY_DIGEST, START, evidence, seedTenantDr } from './support/tenant-dr-fixtures';
import { controlDatabase, d1Over } from './support/sqlite-d1';

type ControlTenantDisasterRecoveryLookupWork = Awaited<
  ReturnType<TenantDisasterRecoveryService['claimLookupReprojection']>
>;

const NOW = 2_000_000_000;
const E = 'env-test';
let database: DatabaseSync;
let now: number;
let service: TenantDisasterRecoveryService;
let work: ControlTenantDisasterRecoveryLookupWork;

beforeEach(async () => {
  database = controlDatabase();
  seedTenantDr(database);
  now = NOW;
  service = new TenantDisasterRecoveryService(d1Over(database), () => now);
  let recovery = await service.start(E, START);
  await service.observeDeny(E, {
    operationId: recovery.operationId,
    runtimeGeneration: 12,
    denyRegistryGeneration: 4,
  });
  now += 1800;
  await service.reconcileDrain(E);
  recovery = await service.confirmRestore(E, {
    operationId: recovery.operationId,
    restoreReferenceDigest: 'b'.repeat(64),
    restoredAt: now - 5,
    requestedById: 'admin-a',
    idempotencyKey: 'restore-a',
  });
  recovery = await service.recordVerification(E, {
    operationId: recovery.operationId,
    stage: 'migration',
    pinnedRouteGeneration: 7,
    targets: evidence(recovery),
  });
  work = await service.claimLookupReprojection(E, {
    operationId: recovery.operationId,
    ownerId: 'owner-a',
    registryDigest: REGISTRY_DIGEST,
    lookupShardCount: 2,
  });
});

function checkpoint(overrides: Record<string, unknown> = {}) {
  return service.checkpointLookupReprojection(E, {
    operationId: work.operationId,
    ownerId: work.ownerId,
    fencingToken: work.fencingToken,
    registryDigest: REGISTRY_DIGEST,
    lookupShardCount: 2,
    stage: 'cleanup',
    nextStage: 'cleanup',
    targetIndex: 0,
    afterCreatedAt: 0,
    afterId: '',
    afterRowId: 0,
    projectedRowsDelta: 0,
    verifiedRowsDelta: 0,
    ...overrides,
  });
}

describe('lookup reprojection claim', () => {
  it('pins the claim with a fresh lease and an empty cursor', () => {
    expect(work).toMatchObject({
      environmentId: E,
      tenantId: 'tenant-a',
      pinnedRouteGeneration: 7,
      registryDigest: REGISTRY_DIGEST,
      lookupShardCount: 2,
      ownerId: 'owner-a',
      fencingToken: 1,
      leaseExpiresAt: NOW + 1800 + 120,
      progress: {
        stage: 'cleanup',
        targetIndex: 0,
        afterCreatedAt: 0,
        afterId: '',
        afterRowId: 0,
        projectedRows: 0,
        verifiedRows: 0,
        registryDigestPinned: true,
      },
    });
    expect(work.targets).toHaveLength(1);
  });

  it('rejects a different shard count for an existing pin', async () => {
    now += 121;
    await expect(
      service.claimLookupReprojection(E, {
        operationId: work.operationId,
        ownerId: 'owner-b',
        registryDigest: REGISTRY_DIGEST,
        lookupShardCount: 3,
      })
    ).rejects.toThrow('control_tenant_dr_lookup_claim_conflict');
  });

  it('rejects work lookups for an operation that is not reprojecting', async () => {
    await expect(checkpoint({ operationId: 'missing' })).rejects.toThrow(
      'control_tenant_dr_lookup_work_unavailable'
    );
  });
});

describe('lookup reprojection checkpoints', () => {
  it.each([
    ['a bad owner', { ownerId: 'a b' }, 'control_tenant_dr_lookup_owner_invalid'],
    ['a bad digest', { registryDigest: 'abc' }, 'control_tenant_dr_lookup_registry_digest_invalid'],
    ['a zero fencing token', { fencingToken: 0 }, 'control_tenant_dr_lookup_fencing_invalid'],
    ['a zero shard count', { lookupShardCount: 0 }, 'control_tenant_dr_lookup_shard_count_invalid'],
    ['an unknown stage', { stage: 'other' }, 'control_tenant_dr_lookup_stage_invalid'],
    ['an unknown next stage', { nextStage: 'other' }, 'control_tenant_dr_lookup_stage_invalid'],
    [
      'a skipped stage',
      { nextStage: 'email_exact' },
      'control_tenant_dr_lookup_stage_transition_invalid',
    ],
    [
      'a backward stage',
      { stage: 'account_id', nextStage: 'cleanup' },
      'control_tenant_dr_lookup_stage_transition_invalid',
    ],
    ['a negative target index', { targetIndex: -1 }, 'control_tenant_dr_lookup_cursor_invalid'],
    [
      'a target index above the bucket count',
      { targetIndex: 4097 },
      'control_tenant_dr_lookup_cursor_invalid',
    ],
    [
      'a fractional timestamp cursor',
      { afterCreatedAt: 0.5 },
      'control_tenant_dr_lookup_cursor_invalid',
    ],
    ['an unsafe id cursor', { afterId: 'a b' }, 'control_tenant_dr_lookup_cursor_invalid'],
    ['a negative row cursor', { afterRowId: -1 }, 'control_tenant_dr_lookup_cursor_invalid'],
    [
      'too many projected rows',
      { projectedRowsDelta: 1001 },
      'control_tenant_dr_lookup_count_invalid',
    ],
    [
      'negative projected rows',
      { projectedRowsDelta: -1 },
      'control_tenant_dr_lookup_count_invalid',
    ],
    [
      'too many verified rows',
      { verifiedRowsDelta: 251 },
      'control_tenant_dr_lookup_count_invalid',
    ],
  ])('rejects %s', async (_label, patch, code) => {
    await expect(checkpoint(patch)).rejects.toThrow(code);
  });

  it.each([
    ['another owner', { ownerId: 'owner-b' }],
    ['another fencing token', { fencingToken: 2 }],
    ['another digest', { registryDigest: 'd'.repeat(64) }],
    ['another shard count', { lookupShardCount: 3 }],
    ['another stage', { stage: 'account_id', nextStage: 'account_id' }],
  ])('rejects a checkpoint carrying %s as stale', async (_label, patch) => {
    await expect(checkpoint(patch)).rejects.toThrow('control_tenant_dr_lookup_stale_lease');
  });

  it('accepts a checkpoint one second before the lease expires', async () => {
    now = work.leaseExpiresAt - 1;
    await expect(checkpoint()).resolves.toMatchObject({ state: 'reprojecting_lookup' });
  });

  it('treats the lease as expired at its exact expiry second', async () => {
    now = work.leaseExpiresAt;
    await expect(checkpoint()).rejects.toThrow('control_tenant_dr_lookup_stale_lease');
  });

  it('requires an empty cursor when the stage changes', async () => {
    for (const patch of [
      { targetIndex: 1 },
      { afterCreatedAt: 1 },
      { afterId: 'row' },
      { afterRowId: 1 },
    ]) {
      await expect(checkpoint({ nextStage: 'account_id', ...patch })).rejects.toThrow(
        'control_tenant_dr_lookup_cursor_invalid'
      );
    }
    await expect(checkpoint({ nextStage: 'account_id' })).resolves.toMatchObject({
      state: 'reprojecting_lookup',
    });
  });

  it('accumulates counts and moves the cursor forward within a stage', async () => {
    await checkpoint({
      afterCreatedAt: 5,
      afterId: 'b',
      afterRowId: 3,
      projectedRowsDelta: 1000,
      verifiedRowsDelta: 250,
    });
    const row = (sql: string) => database.prepare(sql).get();
    expect(
      row(
        `SELECT lookup_reprojection_stage AS stage, lookup_reprojection_target_index AS target,
                lookup_reprojection_after_created_at AS created, lookup_reprojection_after_id AS id,
                lookup_reprojection_after_row_id AS row_id, lookup_reprojection_projected_rows AS projected,
                lookup_reprojection_verified_rows AS verified, lookup_reprojection_lease_owner AS owner,
                lookup_reprojection_lease_expires_at AS expires
           FROM control_tenant_disaster_recovery_operations`
      )
    ).toEqual({
      stage: 'cleanup',
      target: 0,
      created: 5,
      id: 'b',
      row_id: 3,
      projected: 1000,
      verified: 250,
      owner: null,
      expires: null,
    });
    work = await service.claimLookupReprojection(E, {
      operationId: work.operationId,
      ownerId: 'owner-a',
      registryDigest: REGISTRY_DIGEST,
      lookupShardCount: 2,
    });
    for (const patch of [
      { afterCreatedAt: 4, afterId: 'b', afterRowId: 3 },
      { afterCreatedAt: 5, afterId: 'a', afterRowId: 3 },
      { afterCreatedAt: 5, afterId: 'b', afterRowId: 2 },
      { targetIndex: 2 },
      { targetIndex: 1, afterRowId: 1 },
      { targetIndex: 1, afterId: 'x' },
      { targetIndex: 1, afterCreatedAt: 1 },
    ]) {
      await expect(checkpoint({ fencingToken: work.fencingToken, ...patch })).rejects.toThrow(
        'control_tenant_dr_lookup_cursor_invalid'
      );
    }
    await expect(
      checkpoint({
        fencingToken: work.fencingToken,
        afterCreatedAt: 6,
        afterId: 'a',
        afterRowId: 3,
        projectedRowsDelta: 1,
      })
    ).resolves.toMatchObject({ state: 'reprojecting_lookup' });
    expect(
      row(
        'SELECT lookup_reprojection_projected_rows AS projected FROM control_tenant_disaster_recovery_operations'
      )
    ).toEqual({ projected: 1001 });
  });

  it('advances to the next target with an empty cursor', async () => {
    await expect(checkpoint({ targetIndex: 1 })).resolves.toMatchObject({
      state: 'reprojecting_lookup',
    });
    expect(
      database
        .prepare(
          'SELECT lookup_reprojection_target_index AS target FROM control_tenant_disaster_recovery_operations'
        )
        .get()
    ).toEqual({ target: 1 });
  });
});

describe('lookup reprojection completion', () => {
  const STAGES = [
    'cleanup',
    'account_id',
    'email_exact',
    'external_core',
    'external_pii',
    'verify',
  ] as const;

  async function reclaim() {
    work = await service.claimLookupReprojection(E, {
      operationId: work.operationId,
      ownerId: 'owner-a',
      registryDigest: REGISTRY_DIGEST,
      lookupShardCount: 2,
    });
  }

  async function advanceStages() {
    for (let index = 0; index < STAGES.length - 1; index += 1) {
      await checkpoint({
        fencingToken: work.fencingToken,
        stage: STAGES[index],
        nextStage: STAGES[index + 1],
        projectedRowsDelta: index === 1 ? 4 : 0,
      });
      await reclaim();
    }
  }

  /** Verifies both shards and the projected rows, leaving the work ready to complete. */
  async function readyToComplete(extra: Record<string, unknown> = {}) {
    await advanceStages();
    for (const [targetIndex, verifiedRowsDelta] of [
      [1, 3],
      [2, 1],
    ] as const) {
      await checkpoint({
        fencingToken: work.fencingToken,
        stage: 'verify',
        nextStage: 'verify',
        targetIndex,
        verifiedRowsDelta,
        ...extra,
      });
      await reclaim();
    }
  }

  const complete = (overrides: Record<string, unknown> = {}) =>
    service.completeLookupReprojection(E, {
      operationId: work.operationId,
      ownerId: work.ownerId,
      fencingToken: work.fencingToken,
      registryDigest: REGISTRY_DIGEST,
      ...overrides,
    });

  it.each([
    ['a bad owner', { ownerId: 'a b' }, 'control_tenant_dr_lookup_owner_invalid'],
    ['a zero fencing token', { fencingToken: 0 }, 'control_tenant_dr_lookup_fencing_invalid'],
    ['a bad digest', { registryDigest: 'abc' }, 'control_tenant_dr_lookup_registry_digest_invalid'],
  ])('rejects %s', async (_label, patch, code) => {
    await expect(complete(patch)).rejects.toThrow(code);
  });

  it('rejects completion before the verify stage', async () => {
    await expect(complete()).rejects.toThrow('control_tenant_dr_lookup_completion_invalid');
    await advanceStages();
    await expect(complete()).rejects.toThrow('control_tenant_dr_lookup_completion_invalid');
  });

  it('rejects completion while the verify cursor has not covered every shard', async () => {
    await advanceStages();
    await checkpoint({
      fencingToken: work.fencingToken,
      stage: 'verify',
      nextStage: 'verify',
      targetIndex: 1,
      verifiedRowsDelta: 4,
    });
    await reclaim();
    await expect(complete()).rejects.toThrow('control_tenant_dr_lookup_completion_invalid');
  });

  it('rejects completion while projected and verified rows differ', async () => {
    await advanceStages();
    for (const [targetIndex, verifiedRowsDelta] of [
      [1, 3],
      [2, 0],
    ] as const) {
      await checkpoint({
        fencingToken: work.fencingToken,
        stage: 'verify',
        nextStage: 'verify',
        targetIndex,
        verifiedRowsDelta,
      });
      await reclaim();
    }
    await expect(complete()).rejects.toThrow('control_tenant_dr_lookup_completion_invalid');
  });

  it('rejects completion while the row cursor is open', async () => {
    await advanceStages();
    await checkpoint({
      fencingToken: work.fencingToken,
      stage: 'verify',
      nextStage: 'verify',
      targetIndex: 1,
      verifiedRowsDelta: 4,
    });
    await reclaim();
    await checkpoint({
      fencingToken: work.fencingToken,
      stage: 'verify',
      nextStage: 'verify',
      targetIndex: 2,
    });
    await reclaim();
    await checkpoint({
      fencingToken: work.fencingToken,
      stage: 'verify',
      nextStage: 'verify',
      targetIndex: 2,
      afterRowId: 9,
    });
    await reclaim();
    await expect(complete()).rejects.toThrow('control_tenant_dr_lookup_completion_invalid');
  });

  it('completes once every shard is verified and hands the reprojection to the binding smoke', async () => {
    await readyToComplete();
    await expect(complete()).resolves.toMatchObject({
      state: 'smoke_verifying',
      lookupReprojectedAt: now,
    });
    expect(
      database
        .prepare(
          `SELECT step_key, status FROM control_operation_steps
            WHERE step_key IN ('reproject_lookup', 'verify_runtime_bindings') ORDER BY step_key`
        )
        .all()
    ).toEqual([
      { step_key: 'reproject_lookup', status: 'succeeded' },
      { step_key: 'verify_runtime_bindings', status: 'running' },
    ]);
  });

  it.each([
    ['another owner', { ownerId: 'owner-b' }],
    ['another fencing token', (token: number) => ({ fencingToken: token + 1 })],
    ['another digest', { registryDigest: 'd'.repeat(64) }],
  ])('rejects completion by %s', async (_label, patch) => {
    await readyToComplete();
    const resolved = typeof patch === 'function' ? patch(work.fencingToken) : patch;
    await expect(complete(resolved)).rejects.toThrow('control_tenant_dr_lookup_completion_invalid');
  });

  it('rejects completion at the exact lease expiry and accepts it one second earlier', async () => {
    await readyToComplete();
    now = work.leaseExpiresAt;
    await expect(complete()).rejects.toThrow('control_tenant_dr_lookup_completion_invalid');
    now = work.leaseExpiresAt - 1;
    await expect(complete()).resolves.toMatchObject({ state: 'smoke_verifying' });
  });
});

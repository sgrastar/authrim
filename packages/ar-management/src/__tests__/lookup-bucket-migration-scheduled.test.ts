import type { ControlLookupBucketMigrationView, Env } from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isLookupScaleOutObservationDue,
  processNextLookupBucketMigration,
} from '../lookup-bucket-migration-scheduled';

const workerMocks = vi.hoisted(() => ({
  copyNext: vi.fn(),
  verifyNext: vi.fn(),
  quarantineSource: vi.fn(),
}));
const loadMocks = vi.hoisted(() => ({
  collect: vi.fn(),
}));

vi.mock('../lookup-bucket-migration-worker', () => ({
  LookupBucketMigrationWorker: class {
    copyNext = workerMocks.copyNext;
    verifyNext = workerMocks.verifyNext;
    quarantineSource = workerMocks.quarantineSource;
  },
}));

vi.mock('../lookup-bucket-load-snapshot', () => ({
  collectLookupBucketLoadSnapshot: loadMocks.collect,
}));

function view(
  state: ControlLookupBucketMigrationView['state'],
  verificationAttemptCount = 0
): ControlLookupBucketMigrationView {
  return {
    operationId: 'lookup-bucket:operation',
    virtualBucket: 7,
    source: { lookupShardId: 'lookup-a', bindingRef: 'LOOKUP_A', assignmentGeneration: 1 },
    target: { lookupShardId: 'lookup-b', bindingRef: 'LOOKUP_B', assignmentGeneration: 2 },
    state,
    fencingToken: 3,
    leaseExpiresAt: 1_000,
    backfillCursor: '{}',
    sourceRowCount: null,
    targetRowCount: null,
    verificationDigest: null,
    verificationAttemptCount,
    graceExpiresAt: state === 'grace' ? 500 : null,
  };
}

function d1() {
  return { prepare: vi.fn(), batch: vi.fn(), withSession: vi.fn() };
}

function env(current: ControlLookupBucketMigrationView | null) {
  const checkpoint = vi.fn(async (input) => view(input.nextState));
  const release = vi.fn(async () => current ?? view('dual_write'));
  const cutover = vi.fn(async () => view('grace'));
  const complete = vi.fn(async () => view('complete'));
  const block = vi.fn(async () => view('blocked'));
  const workerEnv = {
    CONTROL: {
      claimNextLookupBucketMigration: vi.fn(async () => current),
      checkpointLookupBucketMigration: checkpoint,
      releaseLookupBucketMigration: release,
      cutoverLookupBucketMigration: cutover,
      completeLookupBucketMigration: complete,
      blockLookupBucketMigration: block,
    },
    LOOKUP_A: d1(),
    LOOKUP_B: d1(),
  } as unknown as Env;
  return { workerEnv, checkpoint, release, cutover, complete, block };
}

describe('processNextLookupBucketMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerMocks.copyNext.mockResolvedValue({
      cursor: '{"copy":1}',
      processedRows: 10,
      done: false,
    });
    workerMocks.verifyNext.mockResolvedValue({
      cursor: '{"verify":1}',
      processedRows: 10,
      done: false,
      sourceRowCount: null,
      targetRowCount: null,
      verificationDigest: null,
    });
    workerMocks.quarantineSource.mockResolvedValue(undefined);
    loadMocks.collect.mockResolvedValue({
      ownerId: 'scheduler-1',
      observedAt: 600,
      buckets: [],
    });
  });

  it('derives planning cadence from the scheduled timestamp', () => {
    expect(isLookupScaleOutObservationDue(600)).toBe(true);
    expect(isLookupScaleOutObservationDue(661)).toBe(false);
  });

  it('is idle during staged deployment without the migration RPC capability', async () => {
    await expect(processNextLookupBucketMigration({} as Env)).resolves.toEqual({
      status: 'idle',
      operationId: null,
      state: null,
      processedRows: 0,
    });
  });

  it('automatically plans from a counter snapshot when no migration is active', async () => {
    const planned = env(null);
    const plan = vi.fn(async () => view('dual_write'));
    (
      planned.workerEnv.CONTROL as { planNextLookupBucketMigration?: typeof plan }
    ).planNextLookupBucketMigration = plan;

    await expect(
      processNextLookupBucketMigration(planned.workerEnv, {
        ownerId: 'scheduler-1',
        now: () => 600,
      })
    ).resolves.toMatchObject({ status: 'progressed', state: 'dual_write' });
    expect(loadMocks.collect).toHaveBeenCalledWith(planned.workerEnv, 'scheduler-1', 600);
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ observedAt: 600 }));
  });

  it('waits for forecast-provisioned Lookup capacity before bucket migration', async () => {
    const planned = env(null);
    const plan = vi.fn();
    const reconcile = vi.fn(async () => [
      {
        residencyPolicyId: 'global',
        residencyPartition: 'default',
        status: 'provisioning' as const,
        observedAt: 600,
        observedActiveRouteCount: 80_000,
        observedSuccessfulPublicationCount: 10_000,
        sampleIntervalSeconds: 600,
        sampleRateMicrorowsPerSecond: 10_000_000,
        ewmaRateMicrorowsPerSecond: 2_500_000,
        forecastHorizonSeconds: 3_600,
        forecastNewRouteCount: 9_000,
        projectedActiveRouteCount: 89_000,
        usableCapacityRouteCount: 80_000,
        capacityUnitCount: 1,
        additionalUnitsRequired: 1,
        decisionGeneration: 1,
        requestedOperationId: 'lookup-forecast-operation',
        lastErrorCode: null,
      },
    ]);
    Object.assign(planned.workerEnv.CONTROL ?? {}, {
      planNextLookupBucketMigration: plan,
      reconcileLookupScaleOut: reconcile,
    });

    await expect(
      processNextLookupBucketMigration(planned.workerEnv, {
        ownerId: 'scheduler-1',
        now: () => 600,
      })
    ).resolves.toEqual({
      status: 'progressed',
      operationId: 'lookup-forecast-operation',
      state: 'lookup_capacity_provisioning',
      processedRows: 0,
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(plan).not.toHaveBeenCalled();
  });

  it('does not scan every Lookup D1 outside the ten-minute planning boundary', async () => {
    const planned = env(null);
    const plan = vi.fn();
    (
      planned.workerEnv.CONTROL as { planNextLookupBucketMigration?: typeof plan }
    ).planNextLookupBucketMigration = plan;

    await expect(
      processNextLookupBucketMigration(planned.workerEnv, {
        ownerId: 'scheduler-1',
        now: () => 100,
      })
    ).resolves.toMatchObject({ status: 'idle' });
    expect(loadMocks.collect).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
  });

  it('keeps a scheduled planning boundary when earlier cron work delays observation', async () => {
    const planned = env(null);
    const plan = vi.fn(async () => null);
    (
      planned.workerEnv.CONTROL as { planNextLookupBucketMigration?: typeof plan }
    ).planNextLookupBucketMigration = plan;

    await expect(
      processNextLookupBucketMigration(planned.workerEnv, {
        ownerId: 'scheduler-1',
        now: () => 661,
        observationDue: true,
      })
    ).resolves.toMatchObject({ status: 'idle' });
    expect(loadMocks.collect).toHaveBeenCalledWith(planned.workerEnv, 'scheduler-1', 661);
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ observedAt: 600 }));
  });

  it('keeps observing scale-out while an existing bucket migration progresses', async () => {
    const active = env(view('dual_write'));
    const reconcile = vi.fn(async () => [
      {
        residencyPolicyId: 'global',
        residencyPartition: 'default',
        status: 'provisioning' as const,
        observedAt: 600,
        observedActiveRouteCount: 80_000,
        observedSuccessfulPublicationCount: 10_000,
        sampleIntervalSeconds: 600,
        sampleRateMicrorowsPerSecond: 10_000_000,
        ewmaRateMicrorowsPerSecond: 2_500_000,
        forecastHorizonSeconds: 3_600,
        forecastNewRouteCount: 9_000,
        projectedActiveRouteCount: 89_000,
        usableCapacityRouteCount: 80_000,
        capacityUnitCount: 1,
        additionalUnitsRequired: 1,
        decisionGeneration: 1,
        requestedOperationId: 'lookup-forecast-operation',
        lastErrorCode: null,
      },
    ]);
    Object.assign(active.workerEnv.CONTROL ?? {}, {
      planNextLookupBucketMigration: vi.fn(),
      reconcileLookupScaleOut: reconcile,
    });

    await expect(
      processNextLookupBucketMigration(active.workerEnv, {
        ownerId: 'scheduler-1',
        now: () => 600,
      })
    ).resolves.toMatchObject({ status: 'progressed', state: 'backfilling' });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(active.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'dual_write', nextState: 'backfilling' })
    );
    expect(active.release).toHaveBeenCalledWith({
      operationId: 'lookup-bucket:operation',
      ownerId: 'scheduler-1',
      fencingToken: 3,
    });
  });

  it('enables backfill before copying rows', async () => {
    const { workerEnv, checkpoint } = env(view('dual_write'));
    const result = await processNextLookupBucketMigration(workerEnv, {
      ownerId: 'scheduler-1',
      now: () => 100,
    });

    expect(result).toMatchObject({ status: 'progressed', state: 'backfilling' });
    expect(checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'dual_write', nextState: 'backfilling' })
    );
    expect(workerMocks.copyNext).not.toHaveBeenCalled();
  });

  it('persists bounded copy and verification checkpoints', async () => {
    const backfill = env(view('backfilling'));
    await expect(
      processNextLookupBucketMigration(backfill.workerEnv, {
        ownerId: 'scheduler-1',
        now: () => 100,
      })
    ).resolves.toMatchObject({ processedRows: 80, state: 'backfilling' });
    expect(workerMocks.copyNext).toHaveBeenCalledTimes(8);
    expect(backfill.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ backfillCursor: '{"copy":1}', nextState: 'backfilling' })
    );

    workerMocks.verifyNext.mockResolvedValueOnce({
      cursor: '{"done":true}',
      processedRows: 4,
      done: true,
      sourceRowCount: 24,
      targetRowCount: 24,
      verificationDigest: 'a'.repeat(64),
    });
    const verifying = env(view('verifying'));
    await processNextLookupBucketMigration(verifying.workerEnv, {
      ownerId: 'scheduler-2',
      now: () => 100,
    });
    expect(verifying.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        nextState: 'cutover_pending',
        sourceRowCount: 24,
        targetRowCount: 24,
        verificationDigest: 'a'.repeat(64),
      })
    );
  });

  it('delegates cutover to Control and waits for the fixed grace period', async () => {
    const pending = env(view('cutover_pending'));
    delete (pending.workerEnv as unknown as Record<string, unknown>).LOOKUP_A;
    delete (pending.workerEnv as unknown as Record<string, unknown>).LOOKUP_B;
    await processNextLookupBucketMigration(pending.workerEnv, {
      ownerId: 'scheduler-1',
      now: () => 100,
    });
    expect(pending.cutover).toHaveBeenCalledTimes(1);

    const grace = env(view('grace'));
    await expect(
      processNextLookupBucketMigration(grace.workerEnv, {
        ownerId: 'scheduler-2',
        now: () => 499,
      })
    ).resolves.toMatchObject({ status: 'waiting_grace' });
    expect(workerMocks.quarantineSource).not.toHaveBeenCalled();
  });

  it('quarantines old rows and retries transient verification races before blocking', async () => {
    const grace = env(view('grace'));
    await expect(
      processNextLookupBucketMigration(grace.workerEnv, {
        ownerId: 'scheduler-1',
        now: () => 501,
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(workerMocks.quarantineSource).toHaveBeenCalledTimes(1);
    expect(grace.complete).toHaveBeenCalledWith(
      expect.objectContaining({ oldRowsQuarantined: true })
    );

    workerMocks.verifyNext.mockRejectedValueOnce(
      new Error('lookup_bucket_migration_verification_mismatch')
    );
    const failed = env(view('verifying'));
    await expect(
      processNextLookupBucketMigration(failed.workerEnv, {
        ownerId: 'scheduler-2',
        now: () => 100,
      })
    ).resolves.toMatchObject({ status: 'progressed', state: 'backfilling' });
    expect(failed.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ expectedState: 'verifying', nextState: 'backfilling' })
    );
    expect(failed.block).not.toHaveBeenCalled();

    workerMocks.verifyNext.mockRejectedValueOnce(
      new Error('lookup_bucket_migration_verification_mismatch')
    );
    const exhausted = env(view('verifying', 2));
    await expect(
      processNextLookupBucketMigration(exhausted.workerEnv, {
        ownerId: 'scheduler-3',
        now: () => 100,
      })
    ).resolves.toMatchObject({ status: 'blocked', state: 'blocked' });
    expect(exhausted.block).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'lookup_bucket_migration_verification_mismatch' })
    );
  });
});

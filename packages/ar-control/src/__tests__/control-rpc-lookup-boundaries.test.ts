import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlEnv, ControlRpcProps } from '../types';

const mocks = vi.hoisted(() => ({
  review: vi.fn(),
  acknowledge: vi.fn(),
  prepareCutover: vi.fn(),
  publishRegistry: vi.fn(),
  confirmCutover: vi.fn(),
  verificationStatus: vi.fn(),
}));

vi.mock('../repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../repository')>()),
  D1ControlRepository: class {
    reviewWorkerInventoryDriftFinding = mocks.review;
    acknowledgeWorkerInventoryDriftNotifications = mocks.acknowledge;
  },
}));
vi.mock('../lookup-bucket-migration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lookup-bucket-migration')>()),
  LookupBucketMigrationService: class {
    prepareCutover = mocks.prepareCutover;
    confirmCutover = mocks.confirmCutover;
  },
}));
vi.mock('../lookup-registry-publisher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lookup-registry-publisher')>()),
  LookupRegistryPublisher: class {
    publishEnvironment = mocks.publishRegistry;
  },
}));
vi.mock('../lookup-hmac-candidate-verifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lookup-hmac-candidate-verifier')>()),
  D1LookupHmacCandidateVerificationRepository: class {
    status = mocks.verificationStatus;
  },
}));

import ControlWorker from '../index';

function worker(props: Partial<ControlRpcProps> = {}) {
  const env = {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    CONTROL_DB: {} as D1Database,
  } as ControlEnv;
  const control = new ControlWorker(
    {
      props: {
        caller: 'ar-management',
        audience: 'authrim-control-v1',
        environmentId: 'test',
        ...props,
      },
      waitUntil: vi.fn(),
    } as unknown as ConstructorParameters<typeof ControlWorker>[0],
    env
  );
  return { control, env };
}

const REVIEW = {
  findingId: 'drift:test:actual_only:worker-a',
  disposition: 'reviewed',
  reviewedBy: 'admin-a',
  idempotencyKey: 'review-a',
};
const CUTOVER = { operationId: 'migration-a', ownerId: 'owner-a', fencingToken: 7 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Control lookup and inventory RPC boundaries', () => {
  it.each([
    [
      { ...REVIEW, findingId: 'drift:other:actual_only:worker-a' },
      'invalid_worker_inventory_drift_review',
    ],
    [{ ...REVIEW, disposition: 'delete' }, 'invalid_worker_inventory_drift_review'],
    [{ ...REVIEW, reviewedBy: 'admin\nother' }, 'invalid_worker_inventory_drift_review'],
    [{ ...REVIEW, idempotencyKey: '../review' }, 'invalid_worker_inventory_drift_review'],
    [{ ...REVIEW, extra: 'unexpected' }, 'invalid_worker_inventory_drift_review'],
  ])('rejects malformed or cross-environment drift reviews before storage', async (input, code) => {
    await expect(worker().control.reviewWorkerInventoryDriftFinding(input)).rejects.toThrow(code);
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('passes an authorized drift review to storage and returns only the public finding', async () => {
    mocks.review.mockResolvedValue({
      finding_id: REVIEW.findingId,
      environment_id: 'test',
      worker_script_name: 'worker-a',
      finding_kind: 'actual_only',
      severity: 'warning',
      review_state: 'reviewed',
      notification_state: 'pending',
      first_observed_at: 100,
      last_observed_at: 200,
      resolved_at: null,
      notified_at: null,
      private_column: 'not returned',
    });
    const { control } = worker();

    const finding = await control.reviewWorkerInventoryDriftFinding(REVIEW);

    expect(mocks.review).toHaveBeenCalledExactlyOnceWith('test', REVIEW, 1_800_000_000);
    expect(finding).toEqual({
      findingId: REVIEW.findingId,
      environmentId: 'test',
      workerScriptName: 'worker-a',
      findingKind: 'actual_only',
      severity: 'warning',
      reviewState: 'reviewed',
      notificationState: 'pending',
      firstObservedAt: 100,
      lastObservedAt: 200,
      resolvedAt: null,
      notifiedAt: null,
    });
  });

  it('masks storage failures in drift review and rejects unauthorized callers', async () => {
    mocks.review.mockRejectedValue(new Error('private database response'));
    await expect(worker().control.reviewWorkerInventoryDriftFinding(REVIEW)).rejects.toThrow(
      'control_internal_error'
    );
    await expect(
      worker({ caller: 'ar-plugin-runner' }).control.reviewWorkerInventoryDriftFinding(REVIEW)
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.review).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ids: [] },
    { ids: ['drift:test:actual_only:worker-a', 'drift:test:actual_only:worker-a'] },
    { ids: ['drift:test:wrong:worker-a'] },
  ])('rejects invalid drift acknowledgements without a write', async ({ ids }) => {
    await expect(
      worker().control.acknowledgeWorkerInventoryDriftNotifications(ids)
    ).rejects.toThrow('invalid_worker_inventory_drift_finding_ids');
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it('acknowledges a valid finding in the caller environment', async () => {
    const ids = ['drift:test:actual_only:worker-a'];
    mocks.acknowledge.mockResolvedValue(undefined);

    await expect(worker().control.acknowledgeWorkerInventoryDriftNotifications(ids)).resolves.toBe(
      undefined
    );

    expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith('test', ids, 1_800_000_000);
  });

  it('prepares a lookup cutover before publishing and confirms the published generation', async () => {
    mocks.prepareCutover.mockResolvedValue(undefined);
    mocks.publishRegistry.mockResolvedValue({ generation: 19 });
    mocks.confirmCutover.mockResolvedValue({
      operationId: CUTOVER.operationId,
      state: 'completed',
    });

    const { control } = worker();
    await expect(control.cutoverLookupBucketMigration(CUTOVER)).resolves.toEqual({
      operationId: CUTOVER.operationId,
      state: 'completed',
    });

    expect(mocks.prepareCutover).toHaveBeenCalledExactlyOnceWith('test', CUTOVER);
    expect(mocks.publishRegistry).toHaveBeenCalledExactlyOnceWith('test');
    expect(mocks.confirmCutover).toHaveBeenCalledExactlyOnceWith('test', CUTOVER, 19);
    expect(mocks.prepareCutover.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publishRegistry.mock.invocationCallOrder[0]
    );
    expect(mocks.publishRegistry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.confirmCutover.mock.invocationCallOrder[0]
    );
  });

  it('does not publish or confirm a lookup cutover if preparation fails', async () => {
    mocks.prepareCutover.mockRejectedValue(new Error('private lease conflict'));

    await expect(worker().control.cutoverLookupBucketMigration(CUTOVER)).rejects.toThrow(
      'control_internal_error'
    );
    expect(mocks.publishRegistry).not.toHaveBeenCalled();
    expect(mocks.confirmCutover).not.toHaveBeenCalled();
  });

  it('does not confirm a lookup cutover when registry publication fails', async () => {
    mocks.prepareCutover.mockResolvedValue(undefined);
    mocks.publishRegistry.mockRejectedValue(new Error('private registry provider response'));

    await expect(worker().control.cutoverLookupBucketMigration(CUTOVER)).rejects.toThrow(
      'control_internal_error'
    );
    expect(mocks.prepareCutover).toHaveBeenCalledOnce();
    expect(mocks.confirmCutover).not.toHaveBeenCalled();
  });

  it('rejects an extra cutover field before preparing the migration', async () => {
    await expect(
      worker().control.cutoverLookupBucketMigration({ ...CUTOVER, tenantId: 'other' })
    ).rejects.toThrow('invalid_lookup_bucket_migration_cutover');
    expect(mocks.prepareCutover).not.toHaveBeenCalled();
    expect(mocks.publishRegistry).not.toHaveBeenCalled();
  });

  it('rejects unsupported HMAC verification phases before looking up status', async () => {
    await expect(
      worker().control.getLookupHmacVerificationStatus({
        operationId: 'rotation-a',
        phase: 'activation',
      })
    ).rejects.toThrow('invalid_lookup_hmac_verification_status');
    expect(mocks.verificationStatus).not.toHaveBeenCalled();
  });

  it('queries HMAC verification status with the authenticated environment and phase', async () => {
    const status = { operationId: 'rotation-a', phase: 'distribution', complete: false };
    mocks.verificationStatus.mockResolvedValue(status);

    await expect(
      worker().control.getLookupHmacVerificationStatus({
        operationId: 'rotation-a',
        phase: 'distribution',
      })
    ).resolves.toEqual(status);
    expect(mocks.verificationStatus).toHaveBeenCalledExactlyOnceWith(
      'test',
      'rotation-a',
      'distribution'
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { BoundedServiceBindingInvocationBudget } from '../service-binding-invocation-budget';
import { WorkerBindingReconciler } from '../worker-binding-reconciler';
import type { WorkerBindingTarget } from '../worker-binding-repository';
import {
  beforeSettings,
  controlEnv,
  inventoryMock,
  lease,
  repositoryMock,
  target,
} from './support/worker-binding-fixtures';

const NOW = 1_800_000_100;
const stabilizing = (overrides: Partial<WorkerBindingTarget> = {}) =>
  target({
    state: 'stabilizing',
    expectedSourceVersionId: 'version-old',
    previousDeploymentId: 'deployment-old',
    patchResultVersionId: 'version-new',
    patchResultDeploymentId: 'deployment-new',
    previousRestoreSettingsJson: JSON.stringify(beforeSettings),
    smokeAttemptCount: 3,
    consecutiveSmokeSuccesses: 3,
    stabilizationNotBefore: 1,
    ...overrides,
  });
const smokeResult = (overrides: Record<string, unknown> = {}) => ({
  bindingRef: 'TEST_TDB_USERS_001',
  migrationGeneration: 1,
  dataRole: 'tenant_core/users',
  residencyPartition: 'global',
  checkedAt: NOW,
  observedVersionId: 'version-new',
  observedVersionTag: 'release',
  observedVersionTimestamp: '2026-07-29T00:00:01.000Z',
  ...overrides,
});
const api = () => ({
  listWorkerDeployments: vi.fn(),
  getWorkerSettings: vi.fn(),
  patchWorkerSettings: vi.fn(),
  createWorkerDeployment: vi.fn(),
});

async function run(
  targets: WorkerBindingTarget[],
  smoke: Record<string, unknown> | undefined,
  repositoryOverrides: Record<string, unknown> = {},
  budget?: BoundedServiceBindingInvocationBudget
) {
  const repository = {
    ...repositoryMock(targets, lease({ mutationStarted: true })),
    ...repositoryOverrides,
  };
  const reconciler = new WorkerBindingReconciler(
    repository,
    inventoryMock(),
    api(),
    await controlEnv(smoke as never),
    () => NOW,
    true,
    budget
  );
  return { repository, result: await reconciler.reconcile() };
}

describe('stabilization smoke recheck', () => {
  it('records the final successful check, marks success and completes the operation', async () => {
    const subject = stabilizing();
    const smokeTenantBinding = vi.fn().mockResolvedValue(smokeResult());
    const { repository, result } = await run([subject], { smokeTenantBinding });
    expect(result).toMatchObject({ succeeded: 1, deferred: 0, blocked: 0 });
    expect(smokeTenantBinding).toHaveBeenCalledTimes(1);
    expect(repository.recordSmokeProgress).toHaveBeenCalledExactlyOnceWith({
      target: subject,
      successful: true,
      attempt: 4,
      completeStabilizationCheck: true,
      now: NOW,
    });
    expect(repository.markSucceeded).toHaveBeenCalledExactlyOnceWith(subject, NOW);
    expect(repository.completeOperationIfReady).toHaveBeenCalledExactlyOnceWith('operation-1', NOW);
  });

  it('uses the batch RPC with one token per target', async () => {
    const batch = vi.fn().mockResolvedValue([{ ok: true, result: smokeResult() }]);
    const single = vi.fn();
    const { result } = await run([stabilizing()], {
      smokeTenantBinding: single,
      smokeTenantBindings: batch,
    });
    expect(result.succeeded).toBe(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(1);
    expect(single).not.toHaveBeenCalled();
  });

  it.each([
    ['binding reference', { bindingRef: 'OTHER' }, 'binding_ref_mismatch'],
    ['migration generation', { migrationGeneration: 9 }, 'generation_mismatch'],
    ['data role', { dataRole: 'tenant_pii' }, 'data_role_mismatch'],
    ['partition', { residencyPartition: 'jp' }, 'residency_mismatch'],
    ['timestamp', { checkedAt: 0 }, 'timestamp_invalid'],
    ['version', { observedVersionId: 'version-other' }, 'version_mismatch'],
  ])(
    'blocks on a mismatching %s with a stabilization specific code',
    async (_name, patch, suffix) => {
      const subject = stabilizing();
      const { repository, result } = await run([subject], {
        smokeTenantBinding: vi.fn().mockResolvedValue(smokeResult(patch)),
      });
      expect(result).toMatchObject({ blocked: 1, succeeded: 0 });
      expect(repository.markBlocked).toHaveBeenCalledExactlyOnceWith(
        subject,
        `control_worker_stabilization_smoke_result_${suffix}`,
        NOW
      );
      expect(repository.markSucceeded).not.toHaveBeenCalled();
    }
  );

  it('defers without marking success when the checkpoint is stale', async () => {
    for (const code of [
      'control_worker_binding_smoke_state_stale',
      'control_worker_binding_smoke_lease_stale',
    ]) {
      const { repository, result } = await run(
        [stabilizing()],
        { smokeTenantBinding: vi.fn().mockResolvedValue(smokeResult()) },
        { recordSmokeProgress: vi.fn().mockRejectedValue(new Error(code)) }
      );
      expect(result).toMatchObject({ deferred: 1, succeeded: 0, blocked: 0 });
      expect(repository.markSucceeded).not.toHaveBeenCalled();
      expect(repository.recordTransientError).not.toHaveBeenCalled();
    }
  });

  it('records a failed attempt and schedules a retry when smoke fails', async () => {
    const subject = stabilizing();
    const { repository, result } = await run([subject], {
      smokeTenantBinding: vi.fn().mockRejectedValue(new Error('runtime_smoke_boom; detail')),
    });
    expect(result).toMatchObject({ deferred: 1, succeeded: 0 });
    expect(repository.recordSmokeProgress).toHaveBeenCalledExactlyOnceWith({
      target: subject,
      successful: false,
      attempt: 4,
      errorCode: 'runtime_smoke_boom',
      now: NOW,
    });
    expect(repository.recordTransientError).toHaveBeenCalledExactlyOnceWith(
      subject,
      'runtime_smoke_boom',
      NOW + 15,
      NOW
    );
  });

  it('falls back to a stable code for unrecognized smoke failures', async () => {
    const { repository } = await run([stabilizing()], {
      smokeTenantBinding: vi.fn().mockRejectedValue(new Error('socket hang up')),
    });
    expect(repository.recordTransientError.mock.calls[0]?.[1]).toBe(
      'control_worker_stabilization_smoke_failed'
    );
  });

  it('reports an item level failure from the batch RPC', async () => {
    const { repository } = await run([stabilizing()], {
      smokeTenantBinding: vi.fn(),
      smokeTenantBindings: vi
        .fn()
        .mockResolvedValue([{ ok: false, errorCode: 'runtime_smoke_item' }]),
    });
    expect(repository.recordTransientError.mock.calls[0]?.[1]).toBe('runtime_smoke_item');
  });

  it('blocks a stabilizing target that lost its patch result', async () => {
    const subject = stabilizing({ patchResultDeploymentId: null });
    const { repository, result } = await run([subject], {
      smokeTenantBinding: vi.fn().mockResolvedValue(smokeResult()),
    });
    expect(result).toMatchObject({ blocked: 1 });
    expect(repository.markBlocked).toHaveBeenCalledWith(
      subject,
      'control_worker_patch_result_missing',
      NOW
    );
  });

  it('defers every target once the service binding budget is exhausted', async () => {
    const budget = new BoundedServiceBindingInvocationBudget();
    const smokeTenantBinding = vi.fn().mockResolvedValue(smokeResult());
    for (let index = 0; index < 1000; index += 1) {
      if (!budget.tryConsume(1)) break;
    }
    const { repository, result } = await run([stabilizing()], { smokeTenantBinding }, {}, budget);
    expect(result).toMatchObject({ deferred: 1, succeeded: 0 });
    expect(smokeTenantBinding).not.toHaveBeenCalled();
    expect(repository.markSucceeded).not.toHaveBeenCalled();
  });

  it('blocks every target when no smoke service is bound', async () => {
    const subject = stabilizing();
    const repository = repositoryMock([subject], lease({ mutationStarted: true }));
    const env = await controlEnv();
    delete env.SMOKE_AR_AUTH;
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api(),
      env,
      () => NOW,
      true
    );
    await expect(reconciler.reconcile()).resolves.toMatchObject({ succeeded: 0 });
    const code: unknown =
      repository.markBlocked.mock.calls[0]?.[1] ??
      repository.recordTransientError.mock.calls[0]?.[1];
    expect(code).toBe('control_worker_smoke_service_binding_missing');
  });
});

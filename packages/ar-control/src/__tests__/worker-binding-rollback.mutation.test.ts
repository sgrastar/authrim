import { describe, expect, it, vi } from 'vitest';
import { BoundedServiceBindingInvocationBudget } from '../service-binding-invocation-budget';
import { WorkerBindingReconciler } from '../worker-binding-reconciler';
import type { WorkerBindingTarget } from '../worker-binding-repository';
import {
  beforeSettings,
  controlEnv,
  inventoryMock,
  lease,
  newDeployment,
  oldDeployment,
  repositoryMock,
  reflectedSettings,
  target,
} from './support/worker-binding-fixtures';

const NOW = 1_800_000_100;
const restoreSettings = {
  compatibility_date: '2026-07-01',
  bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-old' }],
};
const reflectedRestored = {
  compatibility_date: '2026-07-01',
  bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
};

const rollbackTarget = (overrides: Partial<WorkerBindingTarget> = {}) =>
  target({
    state: 'rollback_required',
    expectedSourceVersionId: 'version-old',
    previousDeploymentId: 'deployment-old',
    patchResultVersionId: 'version-new',
    patchResultDeploymentId: 'deployment-new',
    previousRestoreSettingsJson: JSON.stringify(restoreSettings),
    ...overrides,
  });

function workers(overrides: Record<string, unknown> = {}) {
  return {
    listWorkerDeployments: vi.fn().mockResolvedValue([newDeployment, oldDeployment]),
    getWorkerSettings: vi.fn().mockResolvedValue(reflectedRestored),
    patchWorkerSettings: vi.fn().mockResolvedValue(reflectedRestored),
    createWorkerDeployment: vi.fn(),
    ...overrides,
  };
}

async function run(
  subject: WorkerBindingTarget,
  api = workers(),
  repositoryOverrides: Record<string, unknown> = {}
) {
  const repository = {
    ...repositoryMock([subject], lease({ mutationStarted: true })),
    ...repositoryOverrides,
  };
  const reconciler = new WorkerBindingReconciler(
    repository,
    inventoryMock(),
    api,
    await controlEnv(),
    () => NOW,
    true
  );
  return { repository, api, result: await reconciler.reconcile() };
}

describe('worker binding rollback', () => {
  it('restores the saved settings, records the rollback and releases the lease', async () => {
    const subject = rollbackTarget();
    const { repository, api, result } = await run(subject);
    expect(result).toMatchObject({ blocked: 1, deferred: 0, succeeded: 0 });
    expect(api.patchWorkerSettings).toHaveBeenCalledExactlyOnceWith(
      'test-ar-auth',
      restoreSettings
    );
    expect(repository.markRolledBack).toHaveBeenCalledExactlyOnceWith(subject, NOW);
    expect(repository.releaseDeploymentLease).toHaveBeenCalledTimes(1);
    expect(repository.markBlocked).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing patch version', { patchResultVersionId: null }],
    ['a missing patch deployment', { patchResultDeploymentId: null }],
    ['another patch version', { patchResultVersionId: 'version-x' }],
    ['another patch deployment', { patchResultDeploymentId: 'deployment-x' }],
  ])('blocks the rollback on %s', async (_label, patch) => {
    const subject = rollbackTarget(patch);
    const { repository, api, result } = await run(subject);
    expect(result).toMatchObject({ blocked: 1 });
    expect(repository.markBlocked).toHaveBeenCalledExactlyOnceWith(
      subject,
      'control_worker_newer_deployment_detected',
      NOW
    );
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
  });

  it('defers while the deployment lease is no longer current', async () => {
    const { repository, api, result } = await run(rollbackTarget(), workers(), {
      leaseIsCurrent: vi.fn().mockResolvedValue(false),
    });
    expect(result).toMatchObject({ deferred: 1, blocked: 0 });
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(repository.markRolledBack).not.toHaveBeenCalled();
  });

  it('defers when the lease expires between the two lease checks', async () => {
    const leaseIsCurrent = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { repository, api, result } = await run(rollbackTarget(), workers(), { leaseIsCurrent });
    expect(leaseIsCurrent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ deferred: 1, blocked: 0 });
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(repository.markRolledBack).not.toHaveBeenCalled();
  });

  it('blocks when the provider rejects the restore', async () => {
    const subject = rollbackTarget();
    const { repository, result } = await run(
      subject,
      workers({ patchWorkerSettings: vi.fn().mockRejectedValue(new Error('rejected')) })
    );
    expect(result).toMatchObject({ blocked: 1 });
    expect(repository.markBlocked).toHaveBeenCalledExactlyOnceWith(
      subject,
      'control_worker_rollback_failed',
      NOW
    );
    expect(repository.markRolledBack).not.toHaveBeenCalled();
  });

  it('blocks when the reflected settings do not match the restore', async () => {
    const subject = rollbackTarget();
    const { repository } = await run(
      subject,
      workers({ getWorkerSettings: vi.fn().mockResolvedValue(reflectedSettings) })
    );
    expect(repository.markBlocked).toHaveBeenCalledExactlyOnceWith(
      subject,
      'control_worker_rollback_failed',
      NOW
    );
    expect(repository.releaseDeploymentLease).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null, 'control_worker_restore_settings_missing'],
    ['empty', '', 'control_worker_restore_settings_missing'],
    ['oversized', 'x'.repeat(1024 * 1024 + 1), 'control_worker_restore_settings_missing'],
    ['malformed', '{', 'control_worker_restore_settings_invalid'],
    ['an array', '[]', 'control_worker_restore_settings_invalid'],
    ['a string', '"x"', 'control_worker_restore_settings_invalid'],
    ['null', 'null', 'control_worker_restore_settings_invalid'],
  ])(
    'blocks with a stable code without patching when the saved settings are %s',
    async (_label, saved, code) => {
      const subject = rollbackTarget({ previousRestoreSettingsJson: saved });
      const { repository, api, result } = await run(subject);
      expect(result).toMatchObject({ blocked: 1, deferred: 0 });
      expect(api.patchWorkerSettings).not.toHaveBeenCalled();
      expect(repository.recordTransientError).not.toHaveBeenCalled();
      expect(repository.markBlocked).toHaveBeenCalledExactlyOnceWith(subject, code, NOW);
    }
  );

  it('accepts saved settings of exactly one mebibyte', async () => {
    const padding = 'x'.repeat(1024 * 1024 - JSON.stringify({ pad: '' }).length);
    const subject = rollbackTarget({
      previousRestoreSettingsJson: JSON.stringify({ pad: padding }),
    });
    const { api } = await run(subject);
    expect(api.patchWorkerSettings).toHaveBeenCalledTimes(1);
  });
});

describe('initial smoke budget', () => {
  it('defers every target without calling the smoke service once the budget is spent', async () => {
    const budget = new BoundedServiceBindingInvocationBudget();
    for (let index = 0; index < 1000; index += 1) if (!budget.tryConsume(1)) break;
    const smokeTenantBinding = vi.fn();
    const subject = target({
      state: 'settings_patched',
      expectedSourceVersionId: 'version-old',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      previousRestoreSettingsJson: JSON.stringify(beforeSettings),
    });
    const second = target({ ...subject, bindingRef: 'TEST_TDB_USERS_002', shardId: 'shard-2' });
    const repository = repositoryMock([subject, second], lease({ mutationStarted: true }));
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      workers(),
      await controlEnv({ smokeTenantBinding }),
      () => NOW,
      true,
      budget
    );
    const result = await reconciler.reconcile();
    expect(result).toMatchObject({ deferred: 2, succeeded: 0, blocked: 0 });
    expect(smokeTenantBinding).not.toHaveBeenCalled();
  });
});

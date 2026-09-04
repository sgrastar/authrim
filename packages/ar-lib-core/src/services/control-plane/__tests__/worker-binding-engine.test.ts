import { describe, expect, it, vi } from 'vitest';
import {
  activeWorkerDeployment,
  ensureWorkerBindingPatched,
  ensureWorkerBindingsPatched,
  type WorkerBindingPatchState,
} from '../worker-binding-engine.js';

const oldDeployment = {
  id: 'deployment-old',
  created_on: '2026-07-30T00:00:00.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-old' }],
};

const newDeployment = {
  ...oldDeployment,
  id: 'deployment-new',
  created_on: '2026-07-30T00:00:01.000Z',
  versions: [{ percentage: 100, version_id: 'version-new' }],
};

const target = {
  operationId: 'operation-1',
  workerScriptName: 'test-ar-auth',
  bindingRef: 'TDB_USERS_001',
  databaseId: 'database-id',
  previousRestoreSettingsJson: null as string | null,
};

const lease = {
  expectedSourceVersionId: 'version-old',
  mutationStarted: false,
  mutationStartedAt: null as number | null,
  previousDeploymentId: null as string | null,
};

function state(): WorkerBindingPatchState<typeof target, typeof lease> {
  return {
    leaseIsCurrent: vi.fn().mockResolvedValue(true),
    recordAlreadySatisfied: vi.fn().mockResolvedValue(undefined),
    recordPatchStarted: vi.fn().mockResolvedValue(undefined),
    rearmPatchIntent: vi.fn().mockResolvedValue(true),
    recordPatchResult: vi.fn().mockResolvedValue(undefined),
    recordTransientError: vi.fn().mockResolvedValue(undefined),
    markRollbackRequired: vi.fn().mockResolvedValue(undefined),
    markBlocked: vi.fn().mockResolvedValue(undefined),
  };
}

describe('shared Worker binding provisioning effect', () => {
  it('records an already-correct binding without creating a Worker version', async () => {
    const persistence = state();
    const before = {
      bindings: [
        { name: 'DB', type: 'd1', database_id: 'shared-db' },
        { name: target.bindingRef, type: 'd1', database_id: target.databaseId },
      ],
    };
    const api = {
      getWorkerSettings: vi.fn().mockResolvedValue(before),
      patchWorkerSettings: vi.fn(),
      listWorkerDeployments: vi.fn().mockResolvedValue([oldDeployment]),
    };

    await expect(
      ensureWorkerBindingPatched({
        target,
        lease,
        deploymentsBefore: [oldDeployment],
        activeBefore: activeWorkerDeployment([oldDeployment]),
        api,
        state: persistence,
        now: () => 200,
      })
    ).resolves.toMatchObject({
      state: 'patched',
      target: {
        patchResultVersionId: 'version-old',
        patchResultDeploymentId: 'deployment-old',
      },
    });
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(persistence.recordAlreadySatisfied).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'version-old',
        deploymentId: 'deployment-old',
        settingsJson: JSON.stringify(before),
      })
    );
  });

  it('preserves inherited settings and records the only new deployment', async () => {
    const persistence = state();
    const before = {
      bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
      compatibility_date: '2026-07-01',
      observability: { enabled: true },
    };
    const after = {
      ...before,
      bindings: [
        ...before.bindings,
        { name: target.bindingRef, type: 'd1', database_id: target.databaseId },
      ],
    };
    const api = {
      getWorkerSettings: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      patchWorkerSettings: vi.fn().mockResolvedValue(after),
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([newDeployment, oldDeployment]),
    };

    await expect(
      ensureWorkerBindingPatched({
        target,
        lease,
        deploymentsBefore: [oldDeployment],
        activeBefore: activeWorkerDeployment([oldDeployment]),
        api,
        state: persistence,
        now: () => 200,
      })
    ).resolves.toMatchObject({
      state: 'patched',
      target: {
        patchResultVersionId: 'version-new',
        patchResultDeploymentId: 'deployment-new',
      },
    });
    expect(api.patchWorkerSettings).toHaveBeenCalledWith(
      target.workerScriptName,
      expect.objectContaining({
        bindings: [
          { name: 'DB', type: 'inherit', version_id: 'latest' },
          { name: target.bindingRef, type: 'd1', database_id: target.databaseId },
        ],
      })
    );
    expect(persistence.recordPatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'version-new', deploymentId: 'deployment-new' })
    );
  });

  it('patches D1, KV, and R2 bindings in one preserving Worker settings mutation', async () => {
    const persistence = state();
    const multiTarget = {
      operationId: target.operationId,
      workerScriptName: 'test-ar-plugin-runner',
      previousRestoreSettingsJson: null as string | null,
    };
    const desiredBindings = [
      { name: 'PRES_D1_AAAAAAAAAAAAAAAAAAAAAAAA', type: 'd1', database_id: 'database-a' },
      {
        name: 'PRES_KV_BBBBBBBBBBBBBBBBBBBBBBBB',
        type: 'kv_namespace',
        namespace_id: 'namespace-a',
      },
      {
        name: 'PRES_R2_CCCCCCCCCCCCCCCCCCCCCCCC',
        type: 'r2_bucket',
        bucket_name: 'bucket-a',
      },
    ];
    const before = {
      bindings: [{ name: 'PLUGIN_LOADER', type: 'worker_loader' }],
      compatibility_date: '2026-07-01',
      observability: { enabled: true },
    };
    const after = {
      ...before,
      bindings: [...before.bindings, ...desiredBindings],
    };
    const api = {
      getWorkerSettings: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      patchWorkerSettings: vi.fn().mockResolvedValue(after),
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([newDeployment, oldDeployment]),
    };

    await expect(
      ensureWorkerBindingsPatched({
        target: multiTarget,
        lease,
        desiredBindings,
        deploymentsBefore: [oldDeployment],
        activeBefore: activeWorkerDeployment([oldDeployment]),
        api,
        state: persistence as unknown as WorkerBindingPatchState<typeof multiTarget, typeof lease>,
        now: () => 200,
      })
    ).resolves.toMatchObject({ state: 'patched' });
    expect(api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(api.patchWorkerSettings).toHaveBeenCalledWith(
      multiTarget.workerScriptName,
      expect.objectContaining({
        compatibility_date: '2026-07-01',
        observability: { enabled: true },
        bindings: [
          { name: 'PLUGIN_LOADER', type: 'inherit', version_id: 'latest' },
          ...desiredBindings,
        ],
      })
    );
  });

  it('adopts a response-lost patch and never emits a second PATCH', async () => {
    const persistence = state();
    const restoredTarget = {
      ...target,
      previousRestoreSettingsJson: JSON.stringify({
        bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-old' }],
      }),
    };
    const api = {
      getWorkerSettings: vi.fn().mockResolvedValue({
        bindings: [
          { name: 'DB', type: 'd1', database_id: 'shared-db' },
          { name: target.bindingRef, type: 'd1', database_id: target.databaseId },
        ],
      }),
      patchWorkerSettings: vi.fn(),
      listWorkerDeployments: vi.fn(),
    };

    await expect(
      ensureWorkerBindingPatched({
        target: restoredTarget,
        lease: {
          ...lease,
          mutationStarted: true,
          mutationStartedAt: 100,
          previousDeploymentId: 'deployment-old',
        },
        deploymentsBefore: [newDeployment, oldDeployment],
        activeBefore: activeWorkerDeployment([newDeployment, oldDeployment]),
        api,
        state: persistence,
        now: () => 200,
      })
    ).resolves.toMatchObject({ state: 'patched' });
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(persistence.recordPatchStarted).not.toHaveBeenCalled();
    expect(persistence.recordPatchResult).toHaveBeenCalledTimes(1);
  });

  it('immediately adopts a successful patch whose response was lost', async () => {
    const persistence = state();
    const before = {
      bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
    };
    const after = {
      bindings: [
        ...before.bindings,
        { name: target.bindingRef, type: 'd1', database_id: target.databaseId },
      ],
    };
    const api = {
      getWorkerSettings: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      patchWorkerSettings: vi.fn().mockRejectedValue(new Error('response_lost')),
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([newDeployment, oldDeployment]),
    };

    await expect(
      ensureWorkerBindingPatched({
        target,
        lease,
        deploymentsBefore: [oldDeployment],
        activeBefore: activeWorkerDeployment([oldDeployment]),
        api,
        state: persistence,
        now: () => 200,
      })
    ).resolves.toMatchObject({
      state: 'patched',
      target: { patchResultVersionId: 'version-new' },
    });
    expect(api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(persistence.recordPatchResult).toHaveBeenCalledTimes(1);
    expect(persistence.recordTransientError).not.toHaveBeenCalled();
  });

  it('rearms a lost settings mutation only after the propagation grace window', async () => {
    const persistence = state();
    const api = {
      getWorkerSettings: vi.fn().mockResolvedValue({
        bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
      }),
      patchWorkerSettings: vi.fn(),
      listWorkerDeployments: vi.fn(),
    };

    await expect(
      ensureWorkerBindingPatched({
        target,
        lease: {
          ...lease,
          mutationStarted: true,
          mutationStartedAt: 100,
          previousDeploymentId: 'deployment-old',
        },
        deploymentsBefore: [oldDeployment],
        activeBefore: activeWorkerDeployment([oldDeployment]),
        api,
        state: persistence,
        now: () => 200,
      })
    ).resolves.toEqual({ state: 'deferred', target: null });
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(persistence.rearmPatchIntent).toHaveBeenCalledTimes(1);

    persistence.rearmPatchIntent.mockClear();
    await ensureWorkerBindingPatched({
      target,
      lease: {
        ...lease,
        mutationStarted: true,
        mutationStartedAt: 170,
        previousDeploymentId: 'deployment-old',
      },
      deploymentsBefore: [oldDeployment],
      activeBefore: activeWorkerDeployment([oldDeployment]),
      api,
      state: persistence,
      now: () => 200,
    });
    expect(persistence.rearmPatchIntent).not.toHaveBeenCalled();
  });

  it('fails closed when a stale lease cannot rearm a lost settings mutation', async () => {
    const persistence = state();
    persistence.rearmPatchIntent.mockResolvedValue(false);

    await expect(
      ensureWorkerBindingPatched({
        target,
        lease: {
          ...lease,
          mutationStarted: true,
          mutationStartedAt: 100,
          previousDeploymentId: 'deployment-old',
        },
        deploymentsBefore: [oldDeployment],
        activeBefore: activeWorkerDeployment([oldDeployment]),
        api: {
          getWorkerSettings: vi.fn().mockResolvedValue({
            bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
          }),
          patchWorkerSettings: vi.fn(),
          listWorkerDeployments: vi.fn(),
        },
        state: persistence,
        now: () => 200,
      })
    ).rejects.toThrow('control_worker_deployment_lease_lost');
  });

  it('fails closed when latest changes immediately before the settings patch', async () => {
    const persistence = state();
    const api = {
      getWorkerSettings: vi.fn().mockResolvedValue({
        bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
      }),
      patchWorkerSettings: vi.fn(),
      listWorkerDeployments: vi.fn().mockResolvedValue([newDeployment, oldDeployment]),
    };

    await expect(
      ensureWorkerBindingPatched({
        target,
        lease,
        deploymentsBefore: [oldDeployment],
        activeBefore: activeWorkerDeployment([oldDeployment]),
        api,
        state: persistence,
        now: () => 200,
      })
    ).rejects.toThrow('control_worker_source_version_changed');
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous active deployment before mutation', () => {
    expect(() =>
      activeWorkerDeployment([
        oldDeployment,
        { ...newDeployment, created_on: oldDeployment.created_on },
      ])
    ).toThrow('control_worker_active_deployment_ambiguous');
  });
});

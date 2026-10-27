import { describe, expect, it, vi } from 'vitest';
import { runSamlDrCoveredOperation } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import { WorkerBindingReconciler } from '../worker-binding-reconciler';
import { ReleaseMigrationRolloutReconciler } from '../release-migration-rollout-reconciler';
import type { ControlEnv } from '../types';

function admitted() {
  const acquire = vi.fn(async () => ({ admitted: true }));
  const complete = vi.fn(async () => undefined);
  return {
    env: {
      ENABLE_SAML_DR_EXPORT: 'true',
      SAML_DR_MUTATION_CONTROL: {
        acquireEnvironmentBackupMutationPermit: acquire,
        completeEnvironmentBackupMutationPermit: complete,
      },
    },
    acquire,
    complete,
  };
}
function delayedWrite() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

describe('parallel Control source writes retain their parent admission', () => {
  it('drains a sibling Worker binding update after another worker fails', async () => {
    const gate = admitted();
    const delayed = delayedWrite();
    const targets = ['one', 'two'].map((workerScriptName) => ({
      workerScriptName,
      environmentId: 'test',
      state: 'pending',
    }));
    const repository = {
      ensurePendingTargets: vi.fn(async () => undefined),
      listDueTargetsForWorkers: vi.fn(async () => targets),
      acquireReconcilerLease: vi.fn(async () => true),
      releaseReconcilerLease: vi.fn(async () => undefined),
    };
    const reconciler = new WorkerBindingReconciler(
      repository as unknown as ConstructorParameters<typeof WorkerBindingReconciler>[0],
      {} as ConstructorParameters<typeof WorkerBindingReconciler>[1],
      {} as ConstructorParameters<typeof WorkerBindingReconciler>[2],
      {} as ControlEnv,
      () => 100
    );
    const mutate = vi.fn(async (rows: typeof targets) => {
      if (rows[0].workerScriptName === 'one') throw new Error('first_target_failed');
      await delayed.promise;
      return ['succeeded'];
    });
    Object.assign(reconciler, { reconcileWorkerTargets: mutate });
    const pending = runSamlDrCoveredOperation(gate.env, undefined, () => reconciler.reconcile());
    const result = expect(pending).rejects.toThrow('first_target_failed');
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(gate.complete).not.toHaveBeenCalled();
    delayed.finish();
    await result;
    expect(gate.complete).toHaveBeenCalledOnce();
  });

  it('drains a sibling database migration after one target cannot persist failure state', async () => {
    const gate = admitted();
    const delayed = delayedWrite();
    const database = {
      prepare(statement: string) {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: statement.includes('SELECT target.operation_id')
                    ? [{ target_id: 'one' }, { target_id: 'two' }]
                    : [],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const reconciler = new ReleaseMigrationRolloutReconciler(database, null, () => 100, {
      concurrency: 2,
    });
    const mutate = vi.fn(async (target: { target_id: string }) => {
      if (target.target_id === 'one') throw new Error('failure_checkpoint_failed');
      await delayed.promise;
      return 'succeeded';
    });
    Object.assign(reconciler, {
      recoverExpiredTargetLeases: async () => undefined,
      refreshPendingProviders: async () => undefined,
      resumeProviderBlockedRollouts: async () => undefined,
      blockExecutorUnavailable: async () => undefined,
      reconcileTarget: mutate,
    });
    const pending = runSamlDrCoveredOperation(gate.env, undefined, () => reconciler.reconcile());
    const result = expect(pending).rejects.toThrow('failure_checkpoint_failed');
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(gate.complete).not.toHaveBeenCalled();
    delayed.finish();
    await result;
    expect(gate.complete).toHaveBeenCalledOnce();
  });
});

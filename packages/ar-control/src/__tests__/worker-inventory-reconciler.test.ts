import { describe, expect, it, vi } from 'vitest';
import {
  WorkerInventoryReconciler,
  type WorkerInventoryReconcilerRepository,
} from '../worker-inventory-reconciler';

function repositoryMocks() {
  const listActiveEnvironments = vi.fn(async () => [
    {
      environment_id: 'env-test',
      environment_name: 'test',
      lifecycle_state: 'active' as const,
    },
  ]);
  const listActiveDesiredWorkerNames = vi.fn(async () => ['test-ar-auth', 'test-ar-token']);
  const recordActualOnlyWorkerFindings = vi.fn(async () => undefined);
  const resolveMissingActualOnlyWorkerFindings = vi.fn(async () => undefined);
  const value: WorkerInventoryReconcilerRepository = {
    listActiveEnvironments,
    listActiveDesiredWorkerNames,
    recordActualOnlyWorkerFindings,
    resolveMissingActualOnlyWorkerFindings,
  };
  return {
    value,
    listActiveEnvironments,
    listActiveDesiredWorkerNames,
    recordActualOnlyWorkerFindings,
    resolveMissingActualOnlyWorkerFindings,
  };
}

describe('WorkerInventoryReconciler', () => {
  it('records only valid actual-only scripts within the environment prefix', async () => {
    const repo = repositoryMocks();
    const api = {
      listWorkerScripts: vi.fn(async () => [
        { id: 'test-ar-auth' },
        { id: 'test-unmanaged' },
        { id: 'production-unmanaged' },
        { id: 'test/invalid' },
        { id: 'test-unmanaged' },
      ]),
    };
    const reconciler = new WorkerInventoryReconciler(repo.value, api, () => 1_800_000_000);

    await expect(reconciler.reconcile()).resolves.toEqual({
      environmentsChecked: 1,
      providerWorkersChecked: 3,
      actualOnlyCount: 1,
    });
    expect(repo.recordActualOnlyWorkerFindings).toHaveBeenCalledWith(
      'env-test',
      ['test-unmanaged'],
      1_800_000_000
    );
    expect(repo.resolveMissingActualOnlyWorkerFindings).toHaveBeenCalledWith(
      'env-test',
      ['test-unmanaged'],
      1_800_000_000
    );
  });

  it('rejects an unsafe environment name before persisting findings', async () => {
    const repo = repositoryMocks();
    repo.listActiveEnvironments.mockResolvedValue([
      {
        environment_id: 'env-test',
        environment_name: 'test/unsafe',
        lifecycle_state: 'active',
      },
    ]);
    const reconciler = new WorkerInventoryReconciler(
      repo.value,
      { listWorkerScripts: vi.fn(async () => [{ id: 'test-unmanaged' }]) },
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).rejects.toThrow(
      'control_invalid_environment_name_for_worker_inventory'
    );
    expect(repo.recordActualOnlyWorkerFindings).not.toHaveBeenCalled();
  });

  it('assigns scripts to only the most specific overlapping environment prefix', async () => {
    const repo = repositoryMocks();
    repo.listActiveEnvironments.mockResolvedValue([
      { environment_id: 'env-test', environment_name: 'test', lifecycle_state: 'active' },
      { environment_id: 'env-test-us', environment_name: 'test-us', lifecycle_state: 'active' },
    ]);
    repo.listActiveDesiredWorkerNames.mockResolvedValue([]);
    const reconciler = new WorkerInventoryReconciler(
      repo.value,
      { listWorkerScripts: vi.fn(async () => [{ id: 'test-us-ar-auth' }]) },
      () => 1_800_000_000
    );

    await reconciler.reconcile();

    expect(repo.recordActualOnlyWorkerFindings).toHaveBeenNthCalledWith(
      1,
      'env-test',
      [],
      1_800_000_000
    );
    expect(repo.recordActualOnlyWorkerFindings).toHaveBeenNthCalledWith(
      2,
      'env-test-us',
      ['test-us-ar-auth'],
      1_800_000_000
    );
  });
});

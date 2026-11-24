import { CloudflareControlApiError } from '@authrim/ar-lib-core/control-plane';
import { describe, expect, it, vi } from 'vitest';
import { WorkerBindingReconciler } from '../worker-binding-reconciler';
import type { WorkerBindingTarget } from '../worker-binding-repository';
import {
  controlEnv,
  inventoryMock,
  repositoryMock,
  target,
} from './support/worker-binding-fixtures';

const NOW = 1_800_000_000;

async function failWith(error: unknown, subject: WorkerBindingTarget = target()) {
  const repository = repositoryMock([subject]);
  const api = {
    listWorkerDeployments: vi.fn().mockRejectedValue(error),
    getWorkerSettings: vi.fn(),
    patchWorkerSettings: vi.fn(),
    createWorkerDeployment: vi.fn(),
  };
  const reconciler = new WorkerBindingReconciler(
    repository,
    inventoryMock(),
    api,
    await controlEnv(),
    () => NOW
  );
  const result = await reconciler.reconcile();
  return { repository, result, subject };
}

const provider = (status: number, retryAfter: number | null = null) =>
  new CloudflareControlApiError('workers.deployment.list', status, [], retryAfter);

describe('provider error classification', () => {
  it.each([
    [401, 'control_workers_capability_rejected'],
    [403, 'control_workers_capability_rejected'],
    [400, 'control_worker_settings_request_rejected'],
    [409, 'control_worker_settings_request_rejected'],
    [422, 'control_worker_settings_request_rejected'],
    [499, 'control_worker_settings_request_rejected'],
  ])('blocks permanently on provider status %i with %s', async (status, code) => {
    const { repository, result, subject } = await failWith(provider(status));
    expect(result).toMatchObject({ blocked: 1, deferred: 0 });
    expect(repository.markBlocked).toHaveBeenCalledExactlyOnceWith(subject, code, NOW);
    expect(repository.recordTransientError).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'control_worker_active_deployment_missing'],
    [408, 'control_worker_settings_request_failed'],
    [429, 'control_worker_settings_request_failed'],
    [500, 'control_worker_settings_request_failed'],
    [503, 'control_worker_settings_request_failed'],
    [399, 'control_worker_settings_request_failed'],
    [500, 'control_worker_settings_request_failed'],
  ])('defers on provider status %i with %s', async (status, code) => {
    const { repository, result, subject } = await failWith(provider(status));
    expect(result).toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError).toHaveBeenCalledExactlyOnceWith(
      subject,
      code,
      NOW + 15,
      NOW
    );
    expect(repository.markBlocked).not.toHaveBeenCalled();
  });

  it.each([
    [null, 15],
    [5, 15],
    [15, 15],
    [16, 16],
    [120, 120],
  ])('spaces a retry by the provider delay %s as %i seconds', async (retryAfter, delay) => {
    const { repository, subject } = await failWith(provider(429, retryAfter));
    expect(repository.recordTransientError).toHaveBeenCalledExactlyOnceWith(
      subject,
      'control_worker_settings_request_failed',
      NOW + delay,
      NOW
    );
  });
});

describe('message based classification', () => {
  it.each([
    ['control_worker_active_deployment_missing', 'deferred'],
    ['control_worker_deployment_lease_lost', 'deferred'],
    ['control_worker_source_version_changed', 'deferred'],
    ['control_worker_script_environment_mismatch', 'blocked'],
    ['control_worker_active_deployment_ambiguous', 'blocked'],
    ['control_worker_binding_batch_conflict', 'blocked'],
    ['worker_settings_binding_to_remove_missing', 'blocked'],
    ['worker_settings_binding_anything', 'blocked'],
    ['worker_settings_payload_too_large', 'blocked'],
    ['worker_settings_payload_too_large_extra', 'blocked'],
  ])('maps %s to %s keeping the code', async (message, outcome) => {
    const { repository, result, subject } = await failWith(new Error(message));
    expect(result[outcome as 'blocked' | 'deferred']).toBe(1);
    const call = (outcome === 'blocked' ? repository.markBlocked : repository.recordTransientError)
      .mock.calls[0];
    expect(call?.[0]).toBe(subject);
    expect(call?.[1]).toBe(message);
  });

  it.each([
    ['an unknown message', new Error('connection reset')],
    ['an empty message', new Error('')],
    ['a prefix of a known code', new Error('worker_settings_bind')],
    ['a suffixed known code', new Error('control_worker_active_deployment_missing_x')],
    ['a non error', 'control_worker_active_deployment_ambiguous'],
  ])('defers %s behind a stable code', async (_name, failure) => {
    const { repository, result } = await failWith(failure);
    expect(result).toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError.mock.calls[0]?.[1]).toBe(
      'control_worker_binding_reconciliation_failed'
    );
  });
});

describe('smoke service resolution', () => {
  const patched = (overrides: Partial<WorkerBindingTarget>) =>
    target({
      state: 'settings_patched',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      ...overrides,
    });
  const run = async (
    subject: WorkerBindingTarget,
    mutate?: (env: Awaited<ReturnType<typeof controlEnv>>) => void
  ) => {
    const repository = repositoryMock([subject]);
    const env = await controlEnv();
    mutate?.(env);
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn(),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      env,
      () => NOW,
      false
    );
    return { repository, result: await reconciler.reconcile() };
  };

  it('blocks a worker whose script does not belong to the environment', async () => {
    const subject = patched({ workerScriptName: 'other-ar-auth' });
    const { repository, result } = await run(subject);
    expect(result).toMatchObject({ blocked: 1 });
    expect(repository.markBlocked).toHaveBeenCalledExactlyOnceWith(
      subject,
      'control_worker_script_environment_mismatch',
      NOW
    );
  });

  it('requires the environment prefix at the start of the script name', async () => {
    const { repository } = await run(patched({ workerScriptName: 'xtest-ar-auth' }));
    expect(repository.markBlocked.mock.calls[0]?.[1]).toBe(
      'control_worker_script_environment_mismatch'
    );
  });

  it.each([
    ['an unknown component', { workerScriptName: 'test-ar-unknown' }, undefined],
    ['a missing binding', {}, (env: { SMOKE_AR_AUTH?: unknown }) => delete env.SMOKE_AR_AUTH],
    [
      'a binding without the smoke method',
      {},
      (env: { SMOKE_AR_AUTH?: unknown }) => {
        env.SMOKE_AR_AUTH = {};
      },
    ],
    [
      'a binding whose smoke method is not a function',
      {},
      (env: { SMOKE_AR_AUTH?: unknown }) => {
        env.SMOKE_AR_AUTH = { smokeTenantBinding: 'nope' };
      },
    ],
  ])('defers with the missing binding code for %s', async (_name, overrides, mutate) => {
    const { repository, result } = await run(patched(overrides), mutate);
    expect(result).toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError.mock.calls[0]?.[1]).toBe(
      'control_worker_smoke_service_binding_missing'
    );
  });
});

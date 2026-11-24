import { describe, expect, it, vi } from 'vitest';
import { WorkerBindingReconciler } from '../worker-binding-reconciler';
import type { WorkerBindingTarget } from '../worker-binding-repository';
import {
  controlEnv,
  inventoryMock,
  lease,
  repositoryMock,
  target,
} from './support/worker-binding-fixtures';

const NOW = 1_800_000_000;
const api = () => ({
  getWorkerSettings: vi.fn(),
  patchWorkerSettings: vi.fn(),
  listWorkerDeployments: vi.fn(),
  createWorkerDeployment: vi.fn(),
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

const patched = (overrides: Partial<WorkerBindingTarget> = {}) =>
  target({
    state: 'settings_patched',
    patchResultVersionId: 'version-new',
    patchResultDeploymentId: 'deployment-new',
    ...overrides,
  });

async function reconcileWith(
  repositoryTarget: WorkerBindingTarget,
  smokeTenantBinding: ReturnType<typeof vi.fn>,
  extra: Record<string, unknown> = {}
) {
  const repository = repositoryMock([repositoryTarget]);
  const reconciler = new WorkerBindingReconciler(
    repository,
    inventoryMock(),
    api(),
    await controlEnv({ smokeTenantBinding, ...extra } as never),
    () => NOW,
    false
  );
  const result = await reconciler.reconcile();
  return { repository, result };
}

describe('signed smoke result validation', () => {
  it.each([
    [
      'binding reference',
      { bindingRef: 'OTHER' },
      'control_worker_smoke_result_binding_ref_mismatch',
    ],
    [
      'migration generation',
      { migrationGeneration: 2 },
      'control_worker_smoke_result_generation_mismatch',
    ],
    ['data role', { dataRole: 'tenant_pii' }, 'control_worker_smoke_result_data_role_mismatch'],
    [
      'residency partition',
      { residencyPartition: 'jp' },
      'control_worker_smoke_result_residency_mismatch',
    ],
    ['timestamp of zero', { checkedAt: 0 }, 'control_worker_smoke_result_timestamp_invalid'],
    ['negative timestamp', { checkedAt: -5 }, 'control_worker_smoke_result_timestamp_invalid'],
    ['fractional timestamp', { checkedAt: 1.5 }, 'control_worker_smoke_result_timestamp_invalid'],
    ['non numeric timestamp', { checkedAt: '1' }, 'control_worker_smoke_result_timestamp_invalid'],
  ])('defers with a field specific code for a mismatching %s', async (_name, patch, code) => {
    const subject = patched();
    const { repository, result } = await reconcileWith(
      subject,
      vi.fn().mockResolvedValue(smokeResult(patch))
    );
    expect(result).toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError).toHaveBeenCalledExactlyOnceWith(
      subject,
      code,
      NOW + 15,
      NOW
    );
    expect(repository.recordSmokeProgress).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ successful: false, errorCode: code, attempt: 1, now: NOW })
    );
  });

  it('accepts a timestamp of exactly one', async () => {
    const { repository } = await reconcileWith(
      patched(),
      vi.fn().mockResolvedValue(smokeResult({ checkedAt: 1 }))
    );
    expect(repository.recordTransientError).not.toHaveBeenCalled();
  });
});

describe('smoke failure code extraction', () => {
  const failing = (failure: unknown) => vi.fn().mockRejectedValue(failure);
  const code = async (failure: unknown) => {
    const { repository } = await reconcileWith(patched(), failing(failure));
    return repository.recordTransientError.mock.calls[0]?.[1] as string | undefined;
  };

  it.each([
    ['runtime_smoke prefix', new Error('runtime_smoke_unknown_key'), 'runtime_smoke_unknown_key'],
    ['control_smoke prefix', new Error('control_smoke_budget'), 'control_smoke_budget'],
    [
      'result prefix',
      new Error('control_worker_smoke_result_x_y'),
      'control_worker_smoke_result_x_y',
    ],
    ['wrapped message', new Error('RPC failed: runtime_smoke_a1; detail'), 'runtime_smoke_a1'],
    ['plain string', 'runtime_smoke_from_string', 'runtime_smoke_from_string'],
    ['message object', { message: 'runtime_smoke_from_object' }, 'runtime_smoke_from_object'],
    [
      'cause chain',
      new Error('outer', { cause: new Error('mid', { cause: new Error('runtime_smoke_deep') }) }),
      'runtime_smoke_deep',
    ],
    [
      'object cause',
      new Error('outer', { cause: { message: 'control_smoke_cause' } }),
      'control_smoke_cause',
    ],
    ['unrelated text', new Error('connection reset'), 'control_worker_smoke_failed'],
    ['non string message', { message: 42 }, 'control_worker_smoke_failed'],
    ['number', 7, 'control_worker_smoke_failed'],
    ['null', null, 'control_worker_smoke_failed'],
    ['uppercase code', new Error('RUNTIME_SMOKE_X'), 'control_worker_smoke_failed'],
    ['embedded word', new Error('xruntime_smoke_x'), 'control_worker_smoke_failed'],
  ])('maps %s', async (_name, failure, expected) => {
    await expect(code(failure)).resolves.toBe(expected);
  });

  it('only follows four levels of causes', async () => {
    const level = (depth: number): Error =>
      depth === 0
        ? new Error('runtime_smoke_too_deep')
        : new Error(`wrapper ${depth}`, { cause: level(depth - 1) });
    await expect(code(level(3))).resolves.toBe('runtime_smoke_too_deep');
    await expect(code(level(4))).resolves.toBe('control_worker_smoke_failed');
  });
});

describe('batch smoke results', () => {
  it('uses the batch RPC when it returns one result per token', async () => {
    const batch = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 3 }, () => ({ ok: true, result: smokeResult() })));
    const single = vi.fn();
    const { repository } = await reconcileWith(patched(), single, { smokeTenantBindings: batch });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(single).not.toHaveBeenCalled();
    expect(repository.recordSmokeProgress).toHaveBeenCalledTimes(3);
  });

  it('records a reported item failure code without calling the single RPC', async () => {
    const batch = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 3 }, () => ({ ok: false, errorCode: 'runtime_smoke_item_failed' }))
      );
    const single = vi.fn();
    const subject = patched();
    const { repository } = await reconcileWith(subject, single, { smokeTenantBindings: batch });
    expect(single).not.toHaveBeenCalled();
    expect(repository.recordTransientError).toHaveBeenCalledExactlyOnceWith(
      subject,
      'runtime_smoke_item_failed',
      NOW + 15,
      NOW
    );
  });

  it.each([
    ['wrong length', []],
    ['not an array', { ok: true }],
    ['invalid item', Array.from({ length: 3 }, () => ({ ok: 'yes' }))],
    ['failed item without code', Array.from({ length: 3 }, () => ({ ok: false }))],
    ['successful item without result', Array.from({ length: 3 }, () => ({ ok: true }))],
  ])('falls back to the single RPC for a %s response', async (_name, response) => {
    const batch = vi.fn().mockResolvedValue(response);
    const single = vi.fn().mockResolvedValue(smokeResult());
    await reconcileWith(patched(), single, { smokeTenantBindings: batch });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledTimes(3);
  });

  it('falls back to the single RPC when the batch RPC throws', async () => {
    const batch = vi.fn().mockRejectedValue(new Error('not a function'));
    const single = vi.fn().mockResolvedValue(smokeResult());
    await reconcileWith(patched(), single, { smokeTenantBindings: batch });
    expect(single).toHaveBeenCalledTimes(3);
  });
});

describe('deployment lease and patch result guards', () => {
  const build = async (subject: WorkerBindingTarget, overrides: Record<string, unknown> = {}) => {
    const repository = { ...repositoryMock([subject]), ...overrides };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api(),
      await controlEnv(),
      () => NOW,
      false
    );
    return { repository, result: await reconciler.reconcile() };
  };

  it.each(['settings_patched', 'smoke_verifying', 'stabilizing'] as const)(
    'blocks a %s binding that lost its patch result',
    async (state) => {
      const subject = target({ state });
      const { repository, result } = await build(subject);
      expect(result).toMatchObject({ blocked: 1, deferred: 0 });
      expect(repository.markBlocked).toHaveBeenCalledExactlyOnceWith(
        subject,
        'control_worker_patch_result_missing',
        NOW
      );
      expect(repository.acquireDeploymentLease).not.toHaveBeenCalled();
    }
  );

  it.each(['settings_patched', 'smoke_verifying', 'stabilizing'] as const)(
    'defers a %s binding while the deployment lease is busy',
    async (state) => {
      const subject = target({ state, patchResultVersionId: 'version-new' });
      const { repository, result } = await build(subject, {
        acquireDeploymentLease: vi.fn().mockResolvedValue(null),
      });
      expect(result).toMatchObject({ deferred: 1, blocked: 0 });
      expect(repository.acquireDeploymentLease).toHaveBeenCalledExactlyOnceWith({
        target: subject,
        expectedSourceVersionId: 'version-new',
        now: NOW,
        ttlSeconds: 900,
      });
      expect(repository.recordTransientError).toHaveBeenCalledExactlyOnceWith(
        subject,
        'control_worker_deployment_lease_busy',
        NOW + 15,
        NOW
      );
    }
  );

  it('prefers the recorded expected source version over the patch result version', async () => {
    const subject = target({
      state: 'settings_patched',
      expectedSourceVersionId: 'version-recorded',
      patchResultVersionId: 'version-new',
    });
    const { repository } = await build(subject, {
      acquireDeploymentLease: vi.fn().mockResolvedValue(null),
    });
    expect(
      (repository.acquireDeploymentLease.mock.calls[0]?.[0] as { expectedSourceVersionId: string })
        .expectedSourceVersionId
    ).toBe('version-recorded');
    expect(lease().expectedSourceVersionId).toBe('version-old');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { NOW, callArg, repository, service } from './support/shard-cleanup-fixtures';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), verify: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  buildRemovingWorkerBindingSettingsPatch: mocks.patch,
  verifyWorkerSettingsBindingRemoved: mocks.verify,
}));

const cleanup = {
  operationId: 'cleanup-op',
  environmentId: 'env-1',
  shardId: 'shard-1',
  bindingRef: 'DB_A',
  databaseId: 'db-a',
  databaseName: 'name-a',
  state: 'approved',
  deleteDatabase: true,
  retryBudgetStartedAt: NOW - 10,
};
const binding = (overrides: Record<string, unknown> = {}) => ({
  operationId: 'cleanup-op',
  environmentId: 'env-1',
  workerScriptName: 'worker-1',
  bindingRef: 'DB_A',
  databaseId: 'db-a',
  state: 'pending',
  expectedSourceVersionId: null,
  previousDeploymentId: null,
  patchResultVersionId: null,
  patchResultDeploymentId: null,
  previousRestoreSettingsJson: null,
  ...overrides,
});
const deployment = (id: string, createdOn: string, versionId: string, percentage = 100) => ({
  id,
  created_on: createdOn,
  versions: [{ version_id: versionId, percentage }],
});
const OLD = deployment('dep-old', '2026-01-01T00:00:00.000Z', 'ver-old');
const NEW = deployment('dep-new', '2026-01-02T00:00:00.000Z', 'ver-new');
const PRESENT = { bindings: [{ type: 'd1', name: 'DB_A', database_id: 'db-a' }] };
const ABSENT = { bindings: [{ type: 'd1', name: 'DB_OTHER', database_id: 'db-other' }] };
const LEASE = {
  environmentId: 'env-1',
  workerScriptName: 'worker-1',
  operationId: 'cleanup-op',
  fencingToken: 3,
  expectedSourceVersionId: 'ver-old',
  mutationStarted: false,
};

function prepare(bindings: object[]) {
  const repo = repository();
  repo.listDueQuarantines.mockResolvedValue([]);
  repo.listDueCleanups.mockResolvedValue([cleanup]);
  repo.getQuarantineTargetForCleanup.mockResolvedValue({ drainNotBefore: NOW - 1, tenants: [] });
  repo.countActiveReferences.mockResolvedValue(0);
  repo.listPendingBindings.mockResolvedValue(bindings);
  repo.acquireDeploymentLease.mockResolvedValue(LEASE);
  repo.leaseIsCurrent.mockResolvedValue(true);
  const built = service(repo);
  built.workers.listWorkerDeployments.mockResolvedValue([OLD]);
  built.workers.getWorkerSettings.mockResolvedValue(PRESENT);
  mocks.patch.mockReset().mockReturnValue({ patched: true });
  mocks.verify.mockReset().mockReturnValue([]);
  return { repo, ...built };
}

async function failureCode(
  setup: (context: ReturnType<typeof prepare>) => void,
  target = binding()
) {
  const context = prepare([target]);
  setup(context);
  const result = await context.instance.reconcile();
  const blocked = context.repo.markCleanupBlocked.mock.calls[0];
  const waiting = context.repo.markCleanupWaiting.mock.calls[0];
  return {
    ...context,
    result,
    code: (blocked ?? waiting)?.[1] as string | undefined,
    blocked: Boolean(blocked),
  };
}

describe('binding removal: pending binding', () => {
  it('removes a present binding under a lease and records each step in order', async () => {
    const context = prepare([binding()]);
    const order: string[] = [];
    context.repo.recordBindingRemovalStarted.mockImplementation(() => {
      order.push('started');
    });
    context.workers.patchWorkerSettings.mockImplementation(() => {
      order.push('patch');
      return Promise.resolve();
    });
    context.workers.listWorkerDeployments
      .mockResolvedValueOnce([OLD])
      .mockResolvedValueOnce([OLD])
      .mockResolvedValueOnce([OLD, NEW]);
    context.workers.getWorkerSettings.mockResolvedValueOnce(PRESENT).mockResolvedValueOnce(ABSENT);
    context.repo.markBindingRemoved.mockImplementation(() => {
      order.push('removed');
    });
    context.workers.listWorkerDeployments.mockResolvedValue([NEW, OLD]);
    await expect(context.instance.reconcile()).resolves.toMatchObject({ cleanupAttempted: 1 });
    expect(order).toEqual(['started', 'patch', 'removed']);
    expect(context.repo.acquireDeploymentLease).toHaveBeenCalledExactlyOnceWith({
      target: binding(),
      expectedSourceVersionId: 'ver-old',
      now: NOW,
    });
    expect(context.repo.recordBindingRemovalStarted).toHaveBeenCalledExactlyOnceWith({
      target: binding(),
      lease: LEASE,
      sourceVersionId: 'ver-old',
      previousDeploymentId: 'dep-old',
      previousSettingsJson: JSON.stringify(PRESENT),
      now: NOW,
    });
    expect(mocks.patch).toHaveBeenCalledExactlyOnceWith({
      currentSettings: PRESENT,
      sourceVersionId: 'ver-old',
      bindingName: 'DB_A',
    });
    expect(context.workers.patchWorkerSettings).toHaveBeenCalledExactlyOnceWith('worker-1', {
      patched: true,
    });
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({
      before: PRESENT,
      after: ABSENT,
      bindingName: 'DB_A',
    });
    expect(context.repo.markBindingRemoved).toHaveBeenCalledExactlyOnceWith({
      target: binding(),
      lease: LEASE,
      versionId: 'ver-new',
      deploymentId: 'dep-new',
      now: NOW,
    });
    expect(context.repo.releaseDeploymentLease).toHaveBeenCalledExactlyOnceWith(LEASE);
  });

  it('uses the recorded expected source version instead of the current deployment', async () => {
    const context = prepare([binding({ expectedSourceVersionId: 'ver-recorded' })]);
    await context.instance.reconcile();
    expect(callArg(context.repo.acquireDeploymentLease).expectedSourceVersionId).toBe(
      'ver-recorded'
    );
  });

  it('marks an already absent binding without patching the worker', async () => {
    const context = prepare([binding()]);
    context.workers.getWorkerSettings.mockResolvedValue(ABSENT);
    context.workers.listWorkerDeployments.mockResolvedValue([OLD]);
    await context.instance.reconcile();
    expect(context.repo.markBindingAlreadyAbsent).toHaveBeenCalledExactlyOnceWith({
      target: binding(),
      lease: LEASE,
      versionId: 'ver-old',
      deploymentId: 'dep-old',
      currentSettingsJson: JSON.stringify(ABSENT),
      now: NOW,
    });
    expect(context.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(context.repo.recordBindingRemovalStarted).not.toHaveBeenCalled();
    expect(context.repo.markBindingRemoved).not.toHaveBeenCalled();
    expect(context.repo.releaseDeploymentLease).toHaveBeenCalledTimes(1);
  });

  it('fails when the lease is lost before marking an absent binding', async () => {
    const outcome = await failureCode((context) => {
      context.workers.getWorkerSettings.mockResolvedValue(ABSENT);
      context.repo.leaseIsCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    });
    expect(outcome.code).toBe('control_worker_deployment_lease_lost');
    expect(outcome.repo.markBindingAlreadyAbsent).not.toHaveBeenCalled();
    expect(outcome.repo.releaseDeploymentLease).toHaveBeenCalledTimes(1);
  });

  it('fails when the lease is lost between recording the removal and patching', async () => {
    const outcome = await failureCode((context) => {
      context.repo.leaseIsCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    });
    expect(outcome.code).toBe('control_worker_deployment_lease_lost');
    expect(outcome.repo.recordBindingRemovalStarted).toHaveBeenCalledTimes(1);
    expect(outcome.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(outcome.repo.releaseDeploymentLease).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'the lease is busy',
      (c: ReturnType<typeof prepare>) => c.repo.acquireDeploymentLease.mockResolvedValue(null),
      'control_worker_deployment_lease_busy',
      false,
    ],
    [
      'the lease is not current',
      (c: ReturnType<typeof prepare>) => c.repo.leaseIsCurrent.mockResolvedValue(false),
      'control_worker_deployment_lease_lost',
      false,
    ],
    [
      'the source version moved',
      (c: ReturnType<typeof prepare>) =>
        c.repo.acquireDeploymentLease.mockResolvedValue({
          ...LEASE,
          expectedSourceVersionId: 'ver-other',
        }),
      'control_worker_source_version_changed',
      false,
    ],
    [
      'no deployment is active',
      (c: ReturnType<typeof prepare>) => c.workers.listWorkerDeployments.mockResolvedValue([]),
      'control_worker_active_deployment_missing',
      true,
    ],
    [
      'a deployment is not fully rolled out',
      (c: ReturnType<typeof prepare>) =>
        c.workers.listWorkerDeployments.mockResolvedValue([
          deployment('d', '2026-01-01T00:00:00.000Z', 'v', 50),
        ]),
      'control_worker_active_deployment_missing',
      true,
    ],
    [
      'a deployment has an unparsable date',
      (c: ReturnType<typeof prepare>) =>
        c.workers.listWorkerDeployments.mockResolvedValue([deployment('d', 'nonsense', 'v')]),
      'control_worker_active_deployment_missing',
      true,
    ],
    [
      'two deployments share a timestamp',
      (c: ReturnType<typeof prepare>) =>
        c.workers.listWorkerDeployments.mockResolvedValue([
          OLD,
          deployment('dep-twin', OLD.created_on, 'ver-twin'),
        ]),
      'control_worker_active_deployment_ambiguous',
      true,
    ],
    [
      'the binding has another database id',
      (c: ReturnType<typeof prepare>) =>
        c.workers.getWorkerSettings.mockResolvedValue({
          bindings: [{ type: 'd1', name: 'DB_A', database_id: 'db-x' }],
        }),
      'control_shard_cleanup_binding_identity_mismatch',
      true,
    ],
    [
      'another binding points at the database',
      (c: ReturnType<typeof prepare>) =>
        c.workers.getWorkerSettings.mockResolvedValue({
          bindings: [{ type: 'd1', name: 'DB_Z', id: 'db-a' }],
        }),
      'control_shard_cleanup_binding_identity_mismatch',
      true,
    ],
    [
      'the binding name is duplicated',
      (c: ReturnType<typeof prepare>) =>
        c.workers.getWorkerSettings.mockResolvedValue({
          bindings: [PRESENT.bindings[0], PRESENT.bindings[0]],
        }),
      'control_shard_cleanup_binding_identity_mismatch',
      true,
    ],
  ])('reports the right failure when %s', async (_name, setup, code, permanent) => {
    const outcome = await failureCode(setup);
    expect(outcome.code).toBe(code);
    expect(outcome.blocked).toBe(permanent);
    expect(outcome.workers.patchWorkerSettings).not.toHaveBeenCalled();
    if (code !== 'control_worker_deployment_lease_busy') {
      expect(outcome.repo.releaseDeploymentLease).toHaveBeenCalledTimes(
        code.includes('active_deployment') ? 0 : 1
      );
    }
  });

  it('matches a binding by its id field when database_id is absent', async () => {
    const context = prepare([binding()]);
    context.workers.getWorkerSettings.mockResolvedValue({
      bindings: [{ type: 'd1', name: 'DB_A', id: 'db-a' }],
    });
    context.workers.listWorkerDeployments
      .mockResolvedValueOnce([OLD])
      .mockResolvedValueOnce([OLD])
      .mockResolvedValue([NEW, OLD]);
    await context.instance.reconcile();
    expect(context.repo.recordBindingRemovalStarted).toHaveBeenCalledTimes(1);
  });

  it('prefers the newest of several deployments when choosing the active one', async () => {
    const context = prepare([binding()]);
    context.workers.listWorkerDeployments.mockResolvedValue([OLD, NEW]);
    context.repo.acquireDeploymentLease.mockResolvedValue({
      ...LEASE,
      expectedSourceVersionId: 'ver-new',
    });
    await context.instance.reconcile();
    expect(callArg(context.repo.acquireDeploymentLease).expectedSourceVersionId).toBe('ver-new');
  });
});

describe('binding removal: reflection checks', () => {
  const removable = (context: ReturnType<typeof prepare>) => {
    context.workers.listWorkerDeployments
      .mockResolvedValueOnce([OLD])
      .mockResolvedValueOnce([OLD])
      .mockResolvedValueOnce([NEW, OLD]);
    context.workers.getWorkerSettings.mockResolvedValueOnce(PRESENT).mockResolvedValueOnce(ABSENT);
  };

  it('retries while the old version is still active after the patch', async () => {
    const outcome = await failureCode((context) => {
      context.workers.listWorkerDeployments.mockResolvedValue([OLD]);
    });
    expect(outcome.code).toBe('control_worker_binding_cleanup_propagating');
    expect(outcome.blocked).toBe(false);
    expect(outcome.repo.markBindingRemoved).not.toHaveBeenCalled();
  });

  it('blocks when another deployment slipped in between', async () => {
    const intruder = deployment('dep-intruder', '2026-01-03T00:00:00.000Z', 'ver-intruder');
    const outcome = await failureCode((context) => {
      context.workers.listWorkerDeployments
        .mockResolvedValueOnce([OLD])
        .mockResolvedValueOnce([OLD])
        .mockResolvedValueOnce([intruder, NEW, OLD]);
    });
    expect(outcome.code).toBe('control_worker_concurrent_deployment_detected');
    expect(outcome.blocked).toBe(true);
  });

  it('blocks when the reflected settings still differ', async () => {
    const outcome = await failureCode((context) => {
      removable(context);
      mocks.verify.mockReturnValue([{ field: 'x' }]);
    });
    expect(outcome.code).toBe('control_worker_binding_cleanup_reflection_mismatch');
    expect(outcome.blocked).toBe(true);
    expect(outcome.repo.markBindingRemoved).not.toHaveBeenCalled();
  });
});

describe('binding removal: resumed removal', () => {
  const removing = (overrides: Record<string, unknown> = {}) =>
    binding({
      state: 'removing',
      expectedSourceVersionId: 'ver-old',
      previousDeploymentId: 'dep-old',
      previousRestoreSettingsJson: JSON.stringify(PRESENT),
      ...overrides,
    });

  it('re-applies the patch while the source version is still active, restoring from the recorded settings', async () => {
    const context = prepare([removing()]);
    context.workers.listWorkerDeployments
      .mockResolvedValueOnce([OLD])
      .mockResolvedValueOnce([OLD])
      .mockResolvedValueOnce([NEW, OLD]);
    context.workers.getWorkerSettings.mockResolvedValueOnce(PRESENT).mockResolvedValueOnce(ABSENT);
    await context.instance.reconcile();
    expect(context.workers.patchWorkerSettings).toHaveBeenCalledExactlyOnceWith('worker-1', {
      patched: true,
    });
    expect(context.repo.recordBindingRemovalStarted).not.toHaveBeenCalled();
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({
      before: PRESENT,
      after: ABSENT,
      bindingName: 'DB_A',
    });
    expect(context.repo.markBindingRemoved).toHaveBeenCalledTimes(1);
  });

  it('does not patch again once the removal already took effect', async () => {
    const context = prepare([removing()]);
    context.repo.acquireDeploymentLease.mockResolvedValue({
      ...LEASE,
      expectedSourceVersionId: 'ver-old',
    });
    context.workers.listWorkerDeployments.mockResolvedValue([NEW, OLD]);
    context.workers.getWorkerSettings.mockResolvedValue(ABSENT);
    await context.instance.reconcile();
    expect(context.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(context.repo.markBindingRemoved).toHaveBeenCalledExactlyOnceWith({
      target: removing(),
      lease: LEASE,
      versionId: 'ver-new',
      deploymentId: 'dep-new',
      now: NOW,
    });
  });

  it('keeps the recorded previous deployment as the reference for the follow check', async () => {
    const context = prepare([removing({ previousDeploymentId: 'dep-older' })]);
    context.workers.listWorkerDeployments.mockResolvedValue([NEW, OLD]);
    context.workers.getWorkerSettings.mockResolvedValue(ABSENT);
    await context.instance.reconcile();
    expect(context.repo.markBindingRemoved).not.toHaveBeenCalled();
    expect(context.repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(
      'control_worker_concurrent_deployment_detected'
    );
  });

  it.each([
    [null, 'control_shard_cleanup_previous_settings_missing'],
    ['not json', 'control_shard_cleanup_previous_settings_invalid'],
    ['null', 'control_shard_cleanup_previous_settings_invalid'],
    ['[]', 'control_shard_cleanup_previous_settings_invalid'],
    ['5', 'control_shard_cleanup_previous_settings_invalid'],
    ['"text"', 'control_shard_cleanup_previous_settings_invalid'],
    ['true', 'control_shard_cleanup_previous_settings_invalid'],
    [
      JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
      'control_shard_cleanup_previous_settings_missing',
    ],
  ])('refuses unusable restore settings %s', async (settings, code) => {
    const context = prepare([removing({ previousRestoreSettingsJson: settings })]);
    context.workers.listWorkerDeployments.mockResolvedValue([NEW, OLD]);
    context.workers.getWorkerSettings.mockResolvedValue(ABSENT);
    await context.instance.reconcile();
    expect(context.repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(code);
    expect(context.repo.markBindingRemoved).not.toHaveBeenCalled();
  });

  it.each(['removed', 'blocked'])('refuses to act on a %s binding', async (state) => {
    const context = prepare([binding({ state })]);
    await context.instance.reconcile();
    expect(context.repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(
      'control_shard_cleanup_binding_state_invalid'
    );
    expect(context.workers.patchWorkerSettings).not.toHaveBeenCalled();
    expect(context.repo.releaseDeploymentLease).toHaveBeenCalledTimes(1);
  });

  it('removes every pending binding before completing the set', async () => {
    const context = prepare([binding(), binding({ workerScriptName: 'worker-2' })]);
    context.workers.getWorkerSettings.mockResolvedValue(ABSENT);
    await context.instance.reconcile();
    expect(context.repo.markBindingAlreadyAbsent).toHaveBeenCalledTimes(2);
    expect(
      context.workers.listWorkerDeployments.mock.calls.map((call) => call[0] as unknown)
    ).toEqual(['worker-1', 'worker-1', 'worker-2', 'worker-2']);
    expect(context.repo.markBindingsComplete).toHaveBeenCalledTimes(1);
  });
});

describe('deployment selection', () => {
  const run = async (listings: object[][]) => {
    const context = prepare([binding()]);
    context.workers.getWorkerSettings.mockResolvedValue(PRESENT);
    for (const listing of listings)
      context.workers.listWorkerDeployments.mockResolvedValueOnce(listing);
    context.workers.listWorkerDeployments.mockResolvedValue([NEW, OLD]);
    await context.instance.reconcile();
    return context;
  };
  const invalid = (overrides: Record<string, unknown>) => ({
    ...deployment('dep-bad', '2026-01-09T00:00:00.000Z', 'ver-bad'),
    ...overrides,
  });

  it.each([
    ['versions missing', invalid({ versions: undefined })],
    ['versions not a list', invalid({ versions: 'x' })],
    [
      'two versions',
      invalid({
        versions: [
          { version_id: 'a', percentage: 50 },
          { version_id: 'b', percentage: 50 },
        ],
      }),
    ],
    [
      'two versions with a full first share',
      invalid({
        versions: [
          { version_id: 'a', percentage: 100 },
          { version_id: 'b', percentage: 0 },
        ],
      }),
    ],
    ['a split rollout', invalid({ versions: [{ version_id: 'a', percentage: 99 }] })],
    ['no version id', invalid({ versions: [{ percentage: 100 }] })],
    ['empty version id', invalid({ versions: [{ version_id: '', percentage: 100 }] })],
    ['no deployment id', invalid({ id: '' })],
    ['an unparsable date', invalid({ created_on: 'never' })],
  ])('ignores a newer deployment with %s', async (_name, bad) => {
    const context = await run([
      [bad, OLD],
      [bad, OLD],
    ]);
    expect(callArg(context.repo.acquireDeploymentLease).expectedSourceVersionId).toBe('ver-old');
  });

  it('blocks when only unusable deployments exist', async () => {
    const context = await run([[invalid({ versions: [] })]]);
    expect(context.repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(
      'control_worker_active_deployment_missing'
    );
  });

  it('requires the reflected deployment list to start with the new active deployment', async () => {
    const intruder = invalid({ versions: undefined, created_on: '2026-02-01T00:00:00.000Z' });
    const context = await run([[OLD], [OLD], [intruder, NEW, OLD]]);
    expect(context.repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(
      'control_worker_concurrent_deployment_detected'
    );
    expect(context.repo.markBindingRemoved).not.toHaveBeenCalled();
  });

  it('requires the previous deployment to directly precede the new one', async () => {
    const skipped = deployment('dep-skipped', '2026-01-01T12:00:00.000Z', 'ver-skipped');
    const context = await run([[OLD], [OLD], [NEW, skipped, OLD]]);
    expect(context.repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(
      'control_worker_concurrent_deployment_detected'
    );
  });

  it('accepts exactly one megabyte of recorded restore settings', async () => {
    const filler = 'x'.repeat(1024 * 1024 - 10);
    const exact = `{"pad":"${filler}"}`;
    expect(new TextEncoder().encode(exact).byteLength).toBe(1024 * 1024);
    const context = prepare([
      binding({
        state: 'removing',
        expectedSourceVersionId: 'ver-old',
        previousDeploymentId: 'dep-old',
        previousRestoreSettingsJson: exact,
      }),
    ]);
    context.workers.listWorkerDeployments.mockResolvedValue([NEW, OLD]);
    context.workers.getWorkerSettings.mockResolvedValue(ABSENT);
    await context.instance.reconcile();
    expect(context.repo.markBindingRemoved).toHaveBeenCalledTimes(1);
  });

  it('does not trust a previous deployment id when the newest listed deployment is not the active one', async () => {
    const intruder = invalid({ versions: undefined, created_on: '2026-02-01T00:00:00.000Z' });
    const context = prepare([
      binding({
        state: 'removing',
        expectedSourceVersionId: 'ver-old',
        previousDeploymentId: 'dep-new',
        previousRestoreSettingsJson: JSON.stringify(PRESENT),
      }),
    ]);
    context.workers.getWorkerSettings.mockResolvedValue(ABSENT);
    context.workers.listWorkerDeployments
      .mockResolvedValueOnce([OLD])
      .mockResolvedValueOnce([OLD])
      .mockResolvedValue([intruder, NEW, OLD]);
    await context.instance.reconcile();
    expect(context.repo.markBindingRemoved).not.toHaveBeenCalled();
    expect(context.repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(
      'control_worker_concurrent_deployment_detected'
    );
  });
});

describe('lease and identity checks', () => {
  it('stops before reading the worker when the lease is lost at the start', async () => {
    const context = prepare([binding()]);
    context.repo.leaseIsCurrent.mockResolvedValueOnce(false).mockResolvedValue(true);
    await context.instance.reconcile();
    expect(context.repo.markCleanupWaiting.mock.calls[0]?.[1]).toBe(
      'control_worker_deployment_lease_lost'
    );
    expect(context.workers.getWorkerSettings).not.toHaveBeenCalled();
    expect(context.repo.releaseDeploymentLease).toHaveBeenCalledTimes(1);
  });

  it('re-checks the database identity of a binding that is being removed', async () => {
    const context = prepare([
      binding({
        state: 'removing',
        expectedSourceVersionId: 'ver-old',
        previousDeploymentId: 'dep-old',
        previousRestoreSettingsJson: JSON.stringify(PRESENT),
      }),
    ]);
    context.workers.getWorkerSettings.mockResolvedValue({
      bindings: [{ type: 'd1', name: 'DB_A', database_id: 'db-other' }],
    });
    await context.instance.reconcile();
    expect(context.repo.markCleanupBlocked.mock.calls[0]?.[1]).toBe(
      'control_shard_cleanup_binding_identity_mismatch'
    );
    expect(context.workers.patchWorkerSettings).not.toHaveBeenCalled();
  });
});

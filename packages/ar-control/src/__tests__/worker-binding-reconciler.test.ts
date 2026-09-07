import { describe, expect, it, vi } from 'vitest';
import { CloudflareControlApiError } from '@authrim/ar-lib-core/control-plane';
import { WorkerBindingReconciler } from '../worker-binding-reconciler';
import { BoundedServiceBindingInvocationBudget } from '../service-binding-invocation-budget';
import type { ControlEnv, RuntimeSmokeServiceBinding } from '../types';
import type { WorkerBindingTarget, WorkerDeploymentLease } from '../worker-binding-repository';

const beforeSettings = {
  bindings: [{ name: 'DB', type: 'd1', database_id: 'shared-db' }],
  compatibility_date: '2026-07-01',
  compatibility_flags: ['nodejs_compat'],
  observability: { enabled: true },
};

const reflectedSettings = {
  ...beforeSettings,
  bindings: [
    { name: 'DB', type: 'd1', database_id: 'shared-db' },
    { name: 'TEST_TDB_USERS_001', type: 'd1', database_id: 'tenant-db' },
  ],
};

const oldDeployment = {
  id: 'deployment-old',
  created_on: '2026-07-29T00:00:00.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-old' }],
};

const newDeployment = {
  id: 'deployment-new',
  created_on: '2026-07-29T00:00:01.000Z',
  source: 'api',
  strategy: 'percentage' as const,
  versions: [{ percentage: 100, version_id: 'version-new' }],
};

function target(overrides: Partial<WorkerBindingTarget> = {}): WorkerBindingTarget {
  return {
    operationId: 'operation-1',
    environmentId: 'env-test',
    environmentName: 'test',
    workerScriptName: 'test-ar-auth',
    shardId: 'shard-1',
    bindingRef: 'TEST_TDB_USERS_001',
    dataRole: 'tenant_core/users',
    residencyPartition: 'global',
    migrationGeneration: 1,
    databaseId: 'tenant-db',
    state: 'pending',
    expectedSourceVersionId: null,
    previousDeploymentId: null,
    patchResultVersionId: null,
    patchResultDeploymentId: null,
    previousRestoreSettingsJson: null,
    smokeAttemptCount: 0,
    consecutiveSmokeSuccesses: 0,
    stabilizationNotBefore: null,
    lastErrorCode: null,
    manualSettingsRestoreRequested: false,
    ...overrides,
  };
}

function lease(overrides: Partial<WorkerDeploymentLease> = {}): WorkerDeploymentLease {
  return {
    environmentId: 'env-test',
    workerScriptName: 'test-ar-auth',
    operationId: 'operation-1',
    fencingToken: 1,
    expectedSourceVersionId: 'version-old',
    mutationStarted: false,
    mutationStartedAt: null,
    previousDeploymentId: null,
    patchResultVersionId: null,
    patchResultDeploymentId: null,
    ...overrides,
  };
}

async function signingKey(kid = 'smoke-key') {
  const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  if (!('privateKey' in generated)) throw new Error('expected_crypto_key_pair');
  return {
    privateJwk: {
      ...(await crypto.subtle.exportKey('jwk', generated.privateKey)),
      kid,
      alg: 'EdDSA',
      use: 'sig',
    },
    kid,
  };
}

function repositoryMock(targets: WorkerBindingTarget[], deploymentLease = lease()) {
  return {
    ensurePendingTargets: vi.fn().mockResolvedValue(undefined),
    listDueTargets: vi.fn().mockResolvedValue(targets),
    listDueTargetsForWorkers: vi.fn().mockResolvedValue(targets),
    acquireReconcilerLease: vi.fn().mockResolvedValue(true),
    releaseReconcilerLease: vi.fn().mockResolvedValue(true),
    acquireDeploymentLease: vi.fn().mockResolvedValue(deploymentLease),
    leaseIsCurrent: vi.fn().mockResolvedValue(true),
    releaseDeploymentLease: vi.fn().mockResolvedValue(true),
    recordAlreadySatisfied: vi.fn().mockResolvedValue(undefined),
    recordPatchStarted: vi.fn().mockResolvedValue(undefined),
    rearmPatchIntent: vi.fn().mockResolvedValue(true),
    recordPatchResult: vi.fn().mockResolvedValue(undefined),
    recordSmokeProgress: vi.fn().mockResolvedValue(undefined),
    adoptSupersedingSmokeDeployment: vi.fn().mockResolvedValue(undefined),
    markSucceeded: vi.fn().mockResolvedValue(undefined),
    markRollbackRequired: vi.fn().mockResolvedValue(undefined),
    recordTransientError: vi.fn().mockResolvedValue(undefined),
    markRolledBack: vi.fn().mockResolvedValue(undefined),
    markBlocked: vi.fn().mockResolvedValue(undefined),
    completeOperationIfReady: vi.fn().mockResolvedValue(true),
  };
}

function inventoryMock(found = true) {
  return {
    getActiveDesiredWorker: vi.fn().mockResolvedValue(
      found
        ? {
            environment_id: 'env-test',
            worker_script_name: 'test-ar-auth',
            package_name: '@authrim/ar-auth',
            deployment_target: 'test-ar-auth',
            capability_manifest_digest: 'a'.repeat(64),
            source_kind: 'core_manifest',
            status: 'active',
          }
        : null
    ),
    markOperationAwaitingOperator: vi.fn().mockResolvedValue(undefined),
  };
}

async function controlEnv(smoke?: RuntimeSmokeServiceBinding): Promise<ControlEnv> {
  const key = await signingKey();
  return {
    CONTROL_DB: {} as D1Database,
    MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_D1_API_TOKEN: 'd1-token',
    CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
    SMOKE_RPC_SIGNING_JWK_SLOT_A: JSON.stringify(key.privateJwk),
    SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'A',
    SMOKE_RPC_SIGNING_ACTIVE_KID: key.kid,
    SMOKE_AR_AUTH:
      smoke ??
      ({
        smokeTenantBinding: vi.fn().mockResolvedValue({
          bindingRef: 'TEST_TDB_USERS_001',
          migrationGeneration: 1,
          dataRole: 'tenant_core/users',
          residencyPartition: 'global',
          checkedAt: 1_800_000_000,
          observedVersionId: 'version-new',
          observedVersionTag: 'release',
          observedVersionTimestamp: '2026-07-29T00:00:01.000Z',
        }),
      } satisfies RuntimeSmokeServiceBinding),
  };
}

describe('WorkerBindingReconciler', () => {
  it('rejects a non-finite Worker batch limit before touching durable state', async () => {
    const repository = repositoryMock([]);
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        listWorkerDeployments: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv(),
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile(Number.NaN)).rejects.toThrow(
      'invalid_worker_binding_reconciliation_limit'
    );
    expect(repository.ensurePendingTargets).not.toHaveBeenCalled();
  });

  it('hands an untouched binding operation to setup when provider mutation is disabled', async () => {
    const repository = repositoryMock([target()]);
    const inventory = inventoryMock();
    const api = {
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
      listWorkerDeployments: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventory,
      api,
      await controlEnv(),
      () => 1_800_000_000,
      false
    );

    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 0,
      blocked: 1,
    });
    expect(inventory.markOperationAwaitingOperator).toHaveBeenCalledWith(
      'operation-1',
      1_800_000_000
    );
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
    expect(repository.acquireDeploymentLease).not.toHaveBeenCalled();
  });

  it('does not starve setup handoff behind patched smoke targets', async () => {
    const smokeTargets = Array.from({ length: 15 }, (_, index) =>
      target({
        operationId: `smoke-operation-${index}`,
        workerScriptName: `test-ar-auth-${index}`,
        state: 'smoke_verifying',
        patchResultVersionId: 'version-new',
        patchResultDeploymentId: 'deployment-new',
      })
    );
    const pending = target({ operationId: 'pending-operation' });
    const repository = repositoryMock([...smokeTargets, pending]);
    const inventory = inventoryMock();
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventory,
      {
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        listWorkerDeployments: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv(),
      () => 1_800_000_000,
      false
    );

    const result = await reconciler.reconcile(10);

    expect(repository.listDueTargets).toHaveBeenCalledWith(100, 1_800_000_000);
    expect(inventory.markOperationAwaitingOperator).toHaveBeenCalledWith(
      'pending-operation',
      1_800_000_000
    );
    expect(result.attempted).toBe(11);
    expect(result.blocked).toBe(1);
  });

  it('reconciles different Worker scripts concurrently while preserving per-Worker ordering', async () => {
    const repository = repositoryMock([
      target({ operationId: 'auth-operation', workerScriptName: 'test-ar-auth' }),
      target({ operationId: 'token-operation', workerScriptName: 'test-ar-token' }),
    ]);
    repository.acquireDeploymentLease.mockResolvedValue(null);
    let releaseDeployments!: () => void;
    const deploymentsReady = new Promise<void>((resolve) => {
      releaseDeployments = resolve;
    });
    const listWorkerDeployments = vi.fn(async () => {
      await deploymentsReady;
      return [oldDeployment];
    });
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        listWorkerDeployments,
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv(),
      () => 1_800_000_000
    );

    const reconciliation = reconciler.reconcile(2);
    await vi.waitFor(() => expect(listWorkerDeployments).toHaveBeenCalledTimes(2));
    releaseDeployments();

    await expect(reconciliation).resolves.toEqual({
      attempted: 2,
      succeeded: 0,
      deferred: 2,
      blocked: 0,
    });
    expect(repository.releaseReconcilerLease).toHaveBeenCalledOnce();
  });

  it('defers an overlapping scheduled run without exposing a target error', async () => {
    const repository = repositoryMock([target()]);
    repository.acquireReconcilerLease.mockResolvedValue(false);
    const api = {
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
      listWorkerDeployments: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(repository.recordTransientError).not.toHaveBeenCalled();
    expect(repository.acquireDeploymentLease).not.toHaveBeenCalled();
    expect(repository.releaseReconcilerLease).not.toHaveBeenCalled();
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
  });

  it.each([
    ['ar-lib-core', 'SMOKE_AR_LIB_CORE'],
    ['ar-discovery', 'SMOKE_AR_DISCOVERY'],
    ['ar-auth', 'SMOKE_AR_AUTH'],
    ['ar-token', 'SMOKE_AR_TOKEN'],
    ['ar-userinfo', 'SMOKE_AR_USERINFO'],
    ['ar-management', 'SMOKE_AR_MANAGEMENT'],
    ['ar-agent-access', 'SMOKE_AR_AGENT_ACCESS'],
    ['ar-async', 'SMOKE_AR_ASYNC'],
    ['ar-policy', 'SMOKE_AR_POLICY'],
    ['ar-saml', 'SMOKE_AR_SAML'],
    ['ar-bridge', 'SMOKE_AR_BRIDGE'],
    ['ar-vc', 'SMOKE_AR_VC'],
    ['ar-plugin-runner', 'SMOKE_AR_PLUGIN_RUNNER'],
  ] as const)('resolves the generated smoke binding for %s', async (component, bindingName) => {
    const patched = target({
      workerScriptName: `test-${component}`,
      state: 'settings_patched',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
    });
    const repository = repositoryMock([patched]);
    const env = await controlEnv();
    const smoke = env.SMOKE_AR_AUTH;
    if (!smoke) throw new Error('expected_smoke_service');
    (env as unknown as Record<string, unknown>)[bindingName] = smoke;
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
      () => 1_800_000_000,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(smoke.smokeTenantBinding).toHaveBeenCalledTimes(3);
    expect(repository.markBlocked).not.toHaveBeenCalled();
  });

  it('classifies a Workers token rejection as a permanent authority failure', async () => {
    const pending = target();
    const repository = repositoryMock([pending]);
    const api = {
      listWorkerDeployments: vi
        .fn()
        .mockRejectedValue(new CloudflareControlApiError('workers.deployment.list', 403, [10000])),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 1, deferred: 0 });
    expect(repository.markBlocked).toHaveBeenCalledWith(
      pending,
      'control_workers_capability_rejected',
      1_800_000_000
    );
    expect(repository.recordTransientError).not.toHaveBeenCalled();
  });

  it('treats a not-yet-deployed Worker as retryable initial deployment progress', async () => {
    const pending = target();
    const repository = repositoryMock([pending]);
    const api = {
      listWorkerDeployments: vi
        .fn()
        .mockRejectedValue(new CloudflareControlApiError('workers.deployment.list', 404, [])),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 0, deferred: 1 });
    expect(repository.recordTransientError).toHaveBeenCalledWith(
      pending,
      'control_worker_active_deployment_missing',
      1_800_000_015,
      1_800_000_000
    );
    expect(repository.markBlocked).not.toHaveBeenCalled();
  });

  it('retries a temporarily unavailable smoke Service Binding', async () => {
    const patched = target({
      state: 'settings_patched',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
    });
    const repository = repositoryMock([patched]);
    const env = await controlEnv();
    delete env.SMOKE_AR_AUTH;
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
      () => 1_800_000_000,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError).toHaveBeenCalledWith(
      patched,
      'control_worker_smoke_service_binding_missing',
      1_800_000_015,
      1_800_000_000
    );
    expect(repository.markBlocked).not.toHaveBeenCalled();
  });

  it('preserves the safe lease-loss reason for an idempotent retry', async () => {
    const pending = target();
    const repository = repositoryMock([pending]);
    repository.leaseIsCurrent.mockResolvedValue(false);
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn().mockResolvedValue([oldDeployment]),
        getWorkerSettings: vi.fn().mockResolvedValue(beforeSettings),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv(),
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError).toHaveBeenCalledWith(
      pending,
      'control_worker_deployment_lease_lost',
      1_800_000_015,
      1_800_000_000
    );
  });

  it('patches only the desired D1 binding and requires three signed smoke successes', async () => {
    const pending = target();
    const repository = repositoryMock([pending]);
    const api = {
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([newDeployment, oldDeployment]),
      getWorkerSettings: vi
        .fn()
        .mockResolvedValueOnce(beforeSettings)
        .mockResolvedValueOnce(reflectedSettings),
      patchWorkerSettings: vi.fn().mockResolvedValue(reflectedSettings),
      createWorkerDeployment: vi.fn(),
    };
    const env = await controlEnv();
    const now = vi.fn().mockReturnValue(1_800_000_000);
    const reconciler = new WorkerBindingReconciler(repository, inventoryMock(), api, env, now);

    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      deferred: 1,
      blocked: 0,
    });
    expect(repository.recordPatchStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        previousDeploymentId: 'deployment-old',
      })
    );
    const patchStartedCalls: unknown = repository.recordPatchStarted.mock.calls;
    if (!Array.isArray(patchStartedCalls) || !Array.isArray(patchStartedCalls[0])) {
      throw new Error('expected_patch_started_call');
    }
    const patchStartedInput: unknown = patchStartedCalls[0][0];
    if (
      !patchStartedInput ||
      typeof patchStartedInput !== 'object' ||
      !('restoreSettingsJson' in patchStartedInput) ||
      typeof patchStartedInput.restoreSettingsJson !== 'string'
    ) {
      throw new Error('expected_restore_settings_json');
    }
    expect(patchStartedInput.restoreSettingsJson).not.toContain('tenant-db');
    expect(api.patchWorkerSettings).toHaveBeenCalledWith(
      'test-ar-auth',
      expect.objectContaining({
        bindings: [
          { name: 'DB', type: 'inherit', version_id: 'latest' },
          { name: 'TEST_TDB_USERS_001', type: 'd1', database_id: 'tenant-db' },
        ],
      })
    );
    const smokeService = env.SMOKE_AR_AUTH;
    if (!smokeService) throw new Error('expected_smoke_service');
    expect(smokeService.smokeTenantBinding).toHaveBeenCalledTimes(3);
    const tokens = vi.mocked(smokeService.smokeTenantBinding).mock.calls.map(([token]) => token);
    expect(new Set(tokens).size).toBe(3);
    expect(repository.recordSmokeProgress).toHaveBeenCalledTimes(3);
    expect(repository.recordSmokeProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        successful: true,
        attempt: 3,
        stabilizationNotBefore: 1_800_000_030,
      })
    );
    expect(repository.releaseDeploymentLease).not.toHaveBeenCalled();
  });

  it('patches every due binding for one Worker once and shares the stabilization window', async () => {
    const first = target();
    const second = target({
      operationId: 'operation-2',
      shardId: 'shard-2',
      bindingRef: 'TEST_TDB_USERS_002',
      databaseId: 'tenant-db-2',
    });
    const repository = repositoryMock([first, second]);
    repository.acquireDeploymentLease.mockImplementation(
      async (input: { target: WorkerBindingTarget; expectedSourceVersionId: string }) => ({
        ...lease(),
        operationId: input.target.operationId,
        expectedSourceVersionId: input.expectedSourceVersionId,
      })
    );
    const reflectedBatchSettings = {
      ...beforeSettings,
      bindings: [
        ...beforeSettings.bindings,
        { name: first.bindingRef, type: 'd1', database_id: first.databaseId },
        { name: second.bindingRef, type: 'd1', database_id: second.databaseId },
      ],
    };
    const api = {
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValueOnce([oldDeployment])
        .mockResolvedValue([newDeployment, oldDeployment]),
      getWorkerSettings: vi
        .fn()
        .mockResolvedValueOnce(beforeSettings)
        .mockResolvedValue(reflectedBatchSettings),
      patchWorkerSettings: vi.fn().mockResolvedValue(reflectedBatchSettings),
      createWorkerDeployment: vi.fn(),
    };
    const smokeBatch = vi.fn().mockResolvedValueOnce([
      ...Array.from({ length: 3 }, () => ({
        bindingRef: first.bindingRef,
        migrationGeneration: 1,
        dataRole: first.dataRole,
        residencyPartition: first.residencyPartition,
        checkedAt: 1_800_000_000,
        observedVersionId: 'version-new',
        observedVersionTag: 'release',
        observedVersionTimestamp: '2026-07-29T00:00:01.000Z',
      })),
      ...Array.from({ length: 3 }, () => ({
        bindingRef: second.bindingRef,
        migrationGeneration: 1,
        dataRole: second.dataRole,
        residencyPartition: second.residencyPartition,
        checkedAt: 1_800_000_000,
        observedVersionId: 'version-new',
        observedVersionTag: 'release',
        observedVersionTimestamp: '2026-07-29T00:00:01.000Z',
      })),
    ]);
    const env = await controlEnv({
      smokeTenantBinding: vi.fn(),
      smokeTenantBindings: smokeBatch,
    });
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      env,
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 2,
      succeeded: 0,
      deferred: 2,
      blocked: 0,
    });
    expect(api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(api.patchWorkerSettings).toHaveBeenCalledWith(
      first.workerScriptName,
      expect.objectContaining({
        bindings: [
          { name: 'DB', type: 'inherit', version_id: 'latest' },
          { name: first.bindingRef, type: 'd1', database_id: first.databaseId },
          { name: second.bindingRef, type: 'd1', database_id: second.databaseId },
        ],
      })
    );
    expect(smokeBatch).toHaveBeenCalledTimes(1);
    expect(smokeBatch.mock.calls[0]?.[0]).toHaveLength(6);
    expect(repository.releaseDeploymentLease).not.toHaveBeenCalled();
  });

  it('blocks conflicting database identities in one Worker batch before provider mutation', async () => {
    const first = target();
    const conflicting = target({ operationId: 'operation-2', databaseId: 'other-database-id' });
    const repository = repositoryMock([first, conflicting]);
    const api = {
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
      listWorkerDeployments: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 2, deferred: 0 });
    expect(repository.markBlocked).toHaveBeenCalledTimes(2);
    expect(repository.markBlocked).toHaveBeenCalledWith(
      first,
      'control_worker_binding_batch_conflict',
      1_800_000_000
    );
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
  });

  it('uses provider Retry-After when scheduling a rate-limited retry', async () => {
    const pending = target();
    const repository = repositoryMock([pending]);
    const rateLimitError = new CloudflareControlApiError('workers.deployment.list', 429, [1015]);
    Object.defineProperty(rateLimitError, 'retryAfterSeconds', { value: 90 });
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn().mockRejectedValue(rateLimitError),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv(),
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError).toHaveBeenCalledWith(
      pending,
      'control_worker_settings_request_failed',
      1_800_000_090,
      1_800_000_000
    );
  });

  it('falls back to signed individual smoke while older Workers lack the batch RPC', async () => {
    const patched = target({
      state: 'settings_patched',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
    });
    const repository = repositoryMock([patched]);
    const individualSmoke = vi.fn().mockResolvedValue({
      bindingRef: patched.bindingRef,
      migrationGeneration: patched.migrationGeneration,
      dataRole: patched.dataRole,
      residencyPartition: patched.residencyPartition,
      checkedAt: 1_800_000_000,
      observedVersionId: 'version-new',
      observedVersionTag: 'release',
      observedVersionTimestamp: '2026-07-29T00:00:01.000Z',
    });
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn(),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv({
        smokeTenantBinding: individualSmoke,
        smokeTenantBindings: vi.fn().mockRejectedValue(new Error('rpc_method_not_found')),
      }),
      () => 1_800_000_000,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(individualSmoke).toHaveBeenCalledTimes(3);
    expect(repository.recordSmokeProgress).toHaveBeenCalledTimes(3);
  });

  it('keeps batched smoke within the shared Service Binding invocation budget', async () => {
    const patchedTargets = Array.from({ length: 11 }, (_unused, index) =>
      target({
        operationId: `operation-${index + 1}`,
        shardId: `shard-${index + 1}`,
        bindingRef: `TEST_TDB_USERS_${String(index + 1).padStart(3, '0')}`,
        databaseId: `tenant-db-${index + 1}`,
        state: 'settings_patched',
        patchResultVersionId: 'version-new',
        patchResultDeploymentId: 'deployment-new',
      })
    );
    const repository = repositoryMock(patchedTargets);
    const smokeResults = patchedTargets.flatMap((patched) =>
      Array.from({ length: 3 }, () => ({
        bindingRef: patched.bindingRef,
        migrationGeneration: patched.migrationGeneration,
        dataRole: patched.dataRole,
        residencyPartition: patched.residencyPartition,
        checkedAt: 1_800_000_000,
        observedVersionId: 'version-new',
        observedVersionTag: 'release',
        observedVersionTimestamp: '2026-07-29T00:00:01.000Z',
      }))
    );
    const smokeBatch = vi
      .fn()
      .mockImplementation(async (tokens: string[]) => smokeResults.slice(0, tokens.length));
    const budget = new BoundedServiceBindingInvocationBudget(1);
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn(),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv({ smokeTenantBinding: vi.fn(), smokeTenantBindings: smokeBatch }),
      () => 1_800_000_000,
      false,
      budget
    );

    await expect(reconciler.reconcile()).resolves.toEqual({
      attempted: 11,
      succeeded: 0,
      deferred: 11,
      blocked: 0,
    });
    expect(smokeBatch).toHaveBeenCalledOnce();
    expect(smokeBatch.mock.calls[0]?.[0]).toHaveLength(30);
    expect(repository.recordSmokeProgress).toHaveBeenCalledTimes(30);
    expect(budget.remaining).toBe(0);
  });

  it('records a secret-free field-specific smoke mismatch code', async () => {
    const patched = target({
      state: 'settings_patched',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
    });
    const repository = repositoryMock([patched]);
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn(),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv({
        smokeTenantBinding: vi.fn().mockResolvedValue({
          bindingRef: patched.bindingRef,
          migrationGeneration: patched.migrationGeneration,
          dataRole: 'tenant_core/default',
          residencyPartition: patched.residencyPartition,
          checkedAt: 1_800_000_000,
          observedVersionId: 'version-new',
          observedVersionTag: 'release',
          observedVersionTimestamp: '2026-07-29T00:00:01.000Z',
        }),
      }),
      () => 1_800_000_000,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError).toHaveBeenCalledWith(
      patched,
      'control_worker_smoke_result_data_role_mismatch',
      1_800_000_015,
      1_800_000_000
    );
  });

  it('fenced-adopts an active superseding version after signed binding smoke succeeds', async () => {
    const patched = target({
      state: 'settings_patched',
      patchResultVersionId: 'version-old',
      patchResultDeploymentId: 'deployment-old',
    });
    const deploymentLease = lease({
      mutationStarted: true,
      patchResultVersionId: 'version-old',
      patchResultDeploymentId: 'deployment-old',
    });
    const repository = repositoryMock([patched], deploymentLease);
    const inventory = inventoryMock();
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventory,
      {
        listWorkerDeployments: vi.fn().mockResolvedValue([newDeployment, oldDeployment]),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv(),
      () => 1_800_000_000,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.adoptSupersedingSmokeDeployment).toHaveBeenCalledWith({
      target: patched,
      lease: deploymentLease,
      versionId: 'version-new',
      deploymentId: 'deployment-new',
      now: 1_800_000_000,
    });
    expect(inventory.markOperationAwaitingOperator).not.toHaveBeenCalled();
    expect(repository.recordTransientError).not.toHaveBeenCalled();
  });

  it('does not adopt a smoke version that is not the active provider deployment', async () => {
    const patched = target({
      state: 'smoke_verifying',
      patchResultVersionId: 'version-old',
      patchResultDeploymentId: 'deployment-old',
    });
    const repository = repositoryMock([patched]);
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn().mockResolvedValue([oldDeployment]),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv(),
      () => 1_800_000_000
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.adoptSupersedingSmokeDeployment).not.toHaveBeenCalled();
    expect(repository.recordTransientError).toHaveBeenCalledWith(
      patched,
      'control_worker_smoke_result_version_mismatch',
      1_800_000_015,
      1_800_000_000
    );
  });

  it('extracts only an allowlisted smoke code from a service-binding RPC wrapper', async () => {
    const patched = target({
      state: 'settings_patched',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
    });
    const repository = repositoryMock([patched]);
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn(),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv({
        smokeTenantBinding: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'The RPC receiver threw an exception: runtime_smoke_unknown_key; hidden detail'
            )
          ),
      }),
      () => 1_800_000_000,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordTransientError).toHaveBeenCalledWith(
      patched,
      'runtime_smoke_unknown_key',
      1_800_000_015,
      1_800_000_000
    );
    expect(JSON.stringify(repository.recordTransientError.mock.calls)).not.toContain(
      'hidden detail'
    );
  });

  it('rechecks the runtime version and binding after the stabilization window without provider access', async () => {
    const stabilizing = target({
      state: 'stabilizing',
      expectedSourceVersionId: 'version-old',
      previousDeploymentId: 'deployment-old',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      previousRestoreSettingsJson: JSON.stringify(beforeSettings),
      smokeAttemptCount: 3,
      consecutiveSmokeSuccesses: 3,
      stabilizationNotBefore: 1_800_000_000,
    });
    const repository = repositoryMock([stabilizing], lease({ mutationStarted: true }));
    const api = {
      listWorkerDeployments: vi.fn().mockResolvedValue([newDeployment, oldDeployment]),
      getWorkerSettings: vi.fn().mockResolvedValue(reflectedSettings),
      patchWorkerSettings: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_001
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ succeeded: 1, blocked: 0 });
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
    expect(api.getWorkerSettings).not.toHaveBeenCalled();
    expect(repository.acquireDeploymentLease).toHaveBeenCalledWith({
      target: stabilizing,
      expectedSourceVersionId: 'version-old',
      now: 1_800_000_001,
      ttlSeconds: 900,
    });
    expect(repository.markSucceeded).toHaveBeenCalledWith(stabilizing, 1_800_000_001);
    expect(repository.completeOperationIfReady).toHaveBeenCalledWith('operation-1', 1_800_000_001);
  });

  it('adopts one reflected patch after response loss without issuing a second PATCH', async () => {
    const pending = target({
      expectedSourceVersionId: 'version-old',
      previousDeploymentId: 'deployment-old',
      previousRestoreSettingsJson: JSON.stringify({
        bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-old' }],
        compatibility_date: '2026-07-01',
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true },
      }),
    });
    const repository = repositoryMock(
      [pending],
      lease({ mutationStarted: true, previousDeploymentId: 'deployment-old' })
    );
    const api = {
      listWorkerDeployments: vi.fn().mockResolvedValue([newDeployment, oldDeployment]),
      getWorkerSettings: vi.fn().mockResolvedValue(reflectedSettings),
      patchWorkerSettings: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_050
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
    expect(repository.recordPatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'version-new', deploymentId: 'deployment-new' })
    );
  });

  it('blocks when runtime smoke reports a different version during stabilization', async () => {
    const stabilizing = target({
      state: 'stabilizing',
      expectedSourceVersionId: 'version-old',
      previousDeploymentId: 'deployment-old',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      previousRestoreSettingsJson: JSON.stringify(beforeSettings),
      consecutiveSmokeSuccesses: 3,
      stabilizationNotBefore: 1,
    });
    const repository = repositoryMock([stabilizing], lease({ mutationStarted: true }));
    const api = {
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv({
        smokeTenantBinding: vi.fn().mockResolvedValue({
          bindingRef: 'TEST_TDB_USERS_001',
          migrationGeneration: 1,
          dataRole: 'tenant_core/users',
          residencyPartition: 'global',
          checkedAt: 1_800_000_100,
          observedVersionId: 'version-external',
          observedVersionTag: 'external',
          observedVersionTimestamp: '2026-07-29T00:00:02.000Z',
        }),
      }),
      () => 1_800_000_100
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(repository.markBlocked).toHaveBeenCalledWith(
      stabilizing,
      'control_worker_stabilization_smoke_result_version_mismatch',
      1_800_000_100
    );
    expect(api.createWorkerDeployment).not.toHaveBeenCalled();
    expect(api.patchWorkerSettings).not.toHaveBeenCalled();
  });

  it('continues private smoke while provider mutation is disabled', async () => {
    const patched = target({
      state: 'settings_patched',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
    });
    const repository = repositoryMock([patched]);
    const api = {
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_500,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordSmokeProgress).toHaveBeenCalledTimes(3);
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
    expect(repository.acquireDeploymentLease).toHaveBeenCalledWith({
      target: patched,
      expectedSourceVersionId: 'version-new',
      now: 1_800_000_500,
      ttlSeconds: 900,
    });
  });

  it('defers a stale smoke checkpoint without overwriting newer durable progress', async () => {
    const patched = target({
      state: 'settings_patched',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
    });
    const repository = repositoryMock([patched]);
    repository.recordSmokeProgress.mockRejectedValueOnce(
      new Error('control_worker_binding_smoke_state_stale')
    );
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      {
        listWorkerDeployments: vi.fn(),
        getWorkerSettings: vi.fn(),
        patchWorkerSettings: vi.fn(),
        createWorkerDeployment: vi.fn(),
      },
      await controlEnv(),
      () => 1_800_000_600,
      false
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1, blocked: 0 });
    expect(repository.recordSmokeProgress).toHaveBeenCalledOnce();
    expect(repository.recordTransientError).not.toHaveBeenCalled();
  });

  it('restores saved settings directly while the patched version remains fenced', async () => {
    const restoreSettings = {
      ...beforeSettings,
      bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-old' }],
    };
    const rollback = target({
      state: 'rollback_required',
      expectedSourceVersionId: 'version-old',
      previousDeploymentId: 'deployment-old',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      previousRestoreSettingsJson: JSON.stringify(restoreSettings),
    });
    const repository = repositoryMock(
      [rollback],
      lease({
        mutationStarted: true,
        previousDeploymentId: 'deployment-old',
        patchResultVersionId: 'version-new',
        patchResultDeploymentId: 'deployment-new',
      })
    );
    const api = {
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([newDeployment, oldDeployment])
        .mockResolvedValueOnce([newDeployment, oldDeployment]),
      getWorkerSettings: vi.fn().mockResolvedValue(beforeSettings),
      patchWorkerSettings: vi.fn().mockResolvedValue(beforeSettings),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_200
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(api.createWorkerDeployment).not.toHaveBeenCalled();
    expect(api.patchWorkerSettings).toHaveBeenCalledWith('test-ar-auth', restoreSettings);
    expect(repository.markRolledBack).toHaveBeenCalledWith(rollback, 1_800_000_200);
  });

  it('restores an extension Worker without requiring a runtime smoke binding', async () => {
    const restoreSettings = { bindings: [] };
    const rollback = target({
      workerScriptName: 'test-extension-worker',
      state: 'rollback_required',
      expectedSourceVersionId: 'version-old',
      previousDeploymentId: 'deployment-old',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      previousRestoreSettingsJson: JSON.stringify(restoreSettings),
    });
    const repository = repositoryMock(
      [rollback],
      lease({
        mutationStarted: true,
        previousDeploymentId: 'deployment-old',
        patchResultVersionId: 'version-new',
        patchResultDeploymentId: 'deployment-new',
      })
    );
    const api = {
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([newDeployment, oldDeployment])
        .mockResolvedValueOnce([newDeployment, oldDeployment]),
      getWorkerSettings: vi.fn().mockResolvedValue(restoreSettings),
      patchWorkerSettings: vi.fn().mockResolvedValue(restoreSettings),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_210
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(api.patchWorkerSettings).toHaveBeenCalledWith('test-extension-worker', restoreSettings);
    expect(repository.markRolledBack).toHaveBeenCalledWith(rollback, 1_800_000_210);
  });

  it('fails closed when the saved settings PATCH leaves the added binding active', async () => {
    const restoreSettings = {
      ...beforeSettings,
      bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-old' }],
    };
    const rollback = target({
      state: 'rollback_required',
      expectedSourceVersionId: 'version-old',
      previousDeploymentId: 'deployment-old',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      previousRestoreSettingsJson: JSON.stringify(restoreSettings),
    });
    const repository = repositoryMock(
      [rollback],
      lease({
        mutationStarted: true,
        previousDeploymentId: 'deployment-old',
        patchResultVersionId: 'version-new',
        patchResultDeploymentId: 'deployment-new',
      })
    );
    const api = {
      listWorkerDeployments: vi
        .fn()
        .mockResolvedValueOnce([newDeployment, oldDeployment])
        .mockResolvedValueOnce([newDeployment, oldDeployment]),
      getWorkerSettings: vi.fn().mockResolvedValue(reflectedSettings),
      patchWorkerSettings: vi.fn().mockResolvedValue(reflectedSettings),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_225
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(api.createWorkerDeployment).not.toHaveBeenCalled();
    expect(api.patchWorkerSettings).toHaveBeenCalledWith('test-ar-auth', restoreSettings);
    expect(repository.leaseIsCurrent).toHaveBeenCalledTimes(2);
    expect(repository.markBlocked).toHaveBeenCalledWith(
      rollback,
      'control_worker_rollback_failed',
      1_800_000_225
    );
    expect(repository.markRolledBack).not.toHaveBeenCalled();
  });

  it('uses only the saved settings compensation for an explicit manual restore request', async () => {
    const restoreSettings = {
      ...beforeSettings,
      bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-old' }],
    };
    const rollback = target({
      state: 'rollback_required',
      expectedSourceVersionId: 'version-old',
      previousDeploymentId: 'deployment-old',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      previousRestoreSettingsJson: JSON.stringify(restoreSettings),
      lastErrorCode: 'control_worker_manual_restore_requested',
      manualSettingsRestoreRequested: true,
    });
    const repository = repositoryMock(
      [rollback],
      lease({
        mutationStarted: true,
        previousDeploymentId: 'deployment-old',
        patchResultVersionId: 'version-new',
        patchResultDeploymentId: 'deployment-new',
      })
    );
    const api = {
      listWorkerDeployments: vi.fn().mockResolvedValue([newDeployment, oldDeployment]),
      getWorkerSettings: vi.fn().mockResolvedValue(beforeSettings),
      patchWorkerSettings: vi.fn().mockResolvedValue(beforeSettings),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_250
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(api.createWorkerDeployment).not.toHaveBeenCalled();
    expect(api.patchWorkerSettings).toHaveBeenCalledWith('test-ar-auth', restoreSettings);
    expect(repository.markRolledBack).toHaveBeenCalledWith(rollback, 1_800_000_250);
  });

  it('fails closed before provider access for a script outside the desired inventory', async () => {
    const pending = target();
    const repository = repositoryMock([pending]);
    const api = {
      listWorkerDeployments: vi.fn(),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn(),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(false),
      api,
      await controlEnv(),
      () => 1_800_000_300
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(repository.markBlocked).toHaveBeenCalledWith(
      pending,
      'control_worker_not_in_desired_inventory',
      1_800_000_300
    );
    expect(api.listWorkerDeployments).not.toHaveBeenCalled();
  });

  it('blocks and preserves evidence when the saved settings restore fails', async () => {
    const rollback = target({
      state: 'rollback_required',
      expectedSourceVersionId: 'version-old',
      previousDeploymentId: 'deployment-old',
      patchResultVersionId: 'version-new',
      patchResultDeploymentId: 'deployment-new',
      previousRestoreSettingsJson: JSON.stringify({
        bindings: [{ name: 'DB', type: 'inherit', version_id: 'version-old' }],
      }),
    });
    const repository = repositoryMock(
      [rollback],
      lease({
        mutationStarted: true,
        previousDeploymentId: 'deployment-old',
        patchResultVersionId: 'version-new',
        patchResultDeploymentId: 'deployment-new',
      })
    );
    const api = {
      listWorkerDeployments: vi.fn().mockResolvedValue([newDeployment, oldDeployment]),
      getWorkerSettings: vi.fn(),
      patchWorkerSettings: vi.fn().mockRejectedValue(new Error('restore-failed')),
      createWorkerDeployment: vi.fn(),
    };
    const reconciler = new WorkerBindingReconciler(
      repository,
      inventoryMock(),
      api,
      await controlEnv(),
      () => 1_800_000_400
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ blocked: 1 });
    expect(api.createWorkerDeployment).not.toHaveBeenCalled();
    expect(api.patchWorkerSettings).toHaveBeenCalledTimes(1);
    expect(repository.markBlocked).toHaveBeenCalledWith(
      rollback,
      'control_worker_rollback_failed',
      1_800_000_400
    );
    expect(repository.markRolledBack).not.toHaveBeenCalled();
  });
});

import type {
  ControlTenantDefaultRouteAllocation,
  ControlTenantRuntimeRouteObservation,
  ControlTenantShardCapacityResult,
  Env,
} from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { runTenantProvisioningSaga } from '../tenant-provisioning-orchestrator';
import type {
  TenantProvisioningLease,
  TenantProvisioningOperationRepository,
  TenantProvisioningOperationView,
} from '../tenant-provisioning-operation';

const NOW = 1_800_000_000;

function route(state: 'reserved' | 'committed' = 'reserved'): ControlTenantDefaultRouteAllocation {
  return {
    allocationId: 'tenant_default_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tenantId: 'tenant-a',
    state,
    target: {
      shardId: 'shard-default',
      dataRole: 'tenant_core/default',
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      routeGeneration: 3,
      bindingRef: 'TDB_DEFAULT_A',
      databaseId: 'database-default',
      databaseName: 'authrim-test-default-a',
      allocationScope: 'shared_pool',
      ownerTenantId: null,
      assignmentGeneration: 1,
    },
  };
}

function operation(overrides: Partial<TenantProvisioningOperationView> = {}) {
  return {
    operationId: 'tenant-create-a',
    environmentId: 'test',
    tenantId: 'tenant-a',
    tenantCode: 'acme',
    tenantName: 'Acme',
    tenantDescription: null,
    operationKind: 'create' as const,
    sourceTenantId: null,
    preparationPayload: null,
    preparationResult: null,
    residencyPolicyId: 'builtin:residency:default',
    residencyPartition: 'default',
    isolationPolicy: 'shared_pool' as const,
    requestHash: 'a'.repeat(64),
    idempotencyKey: 'tenant-create-a',
    status: 'running' as const,
    currentStep: 'capacity_check' as const,
    capacityOperationIds: {},
    defaultRouteAllocation: null,
    attemptCount: 1,
    retryBudgetStartedAt: NOW - 10,
    nextAttemptAt: null,
    lastErrorCode: null,
    fencingToken: 1,
    createdBy: 'admin-a',
    createdAt: NOW - 10,
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    steps: [],
    ...overrides,
  } satisfies TenantProvisioningOperationView;
}

function ready(role: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii') {
  const roleToken = role.replaceAll('/', '-');
  return {
    state: 'ready' as const,
    target: {
      shardId: `shard-${roleToken}`,
      dataRole: role,
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      routeGeneration: 1,
      bindingRef: role === 'tenant_pii' ? 'TDB_PII_A' : 'TDB_CORE_A',
      databaseId: `database-${roleToken}`,
      databaseName: `database-${roleToken}`,
      allocationScope: 'shared_pool' as const,
      ownerTenantId: null,
      assignmentGeneration: 1,
    },
    operation: null,
  } satisfies ControlTenantShardCapacityResult;
}

function harness(input: {
  operation?: TenantProvisioningOperationView;
  capacity?: (role: string) => ControlTenantShardCapacityResult;
}) {
  type Checkpoint = Parameters<TenantProvisioningOperationRepository['checkpoint']>[1];
  const checkpoints: Checkpoint[] = [];
  const repository = {
    checkpoint: vi.fn(async (_lease: TenantProvisioningLease, checkpoint: Checkpoint) => {
      checkpoints.push(checkpoint);
    }),
  } as unknown as TenantProvisioningOperationRepository;
  const current = input.operation ?? operation();
  const lease: TenantProvisioningLease = {
    operation: current,
    ownerId: 'worker-a',
    fencingToken: current.fencingToken,
  };
  const ensureTenantShardCapacity = vi.fn(async ({ dataRole }: { dataRole: string }) =>
    input.capacity ? input.capacity(dataRole) : ready(dataRole as Parameters<typeof ready>[0])
  );
  const reserveTenantDefaultRoute = vi.fn(async () => route());
  const commitTenantDefaultRoute = vi.fn(async () => route('committed'));
  const releaseTenantDefaultRoute = vi.fn(async () => route());
  const registerTenantPlacementPolicy = vi.fn(async () => ({
    tenantId: current.tenantId,
    isolationPolicy: current.isolationPolicy,
    policyGeneration: 1,
    state: 'provisioning' as const,
    pendingIsolationPolicy: null,
    pendingPolicyGeneration: null,
    migrationOperationId: null,
    sourceOperationId: current.operationId,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const activateTenantPlacementPolicy = vi.fn(async () => ({
    tenantId: current.tenantId,
    isolationPolicy: current.isolationPolicy,
    policyGeneration: 1,
    state: 'active' as const,
    pendingIsolationPolicy: null,
    pendingPolicyGeneration: null,
    migrationOperationId: null,
    sourceOperationId: current.operationId,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const env = {
    CONTROL: {
      ensureTenantShardCapacity,
      registerTenantPlacementPolicy,
      activateTenantPlacementPolicy,
      reserveTenantDefaultRoute,
      commitTenantDefaultRoute,
      releaseTenantDefaultRoute,
    },
  } as unknown as Env;
  const calls: string[] = [];
  const dependencies = {
    validatePlatformDraft: vi.fn(async () => void calls.push('draft')),
    seedTenant: vi.fn(async () => void calls.push('seed')),
    publishRegistry: vi.fn(async () => void calls.push('registry')),
    smokeTenant: vi.fn(async () => void calls.push('smoke')),
    prepareTenant: vi.fn(async (): Promise<Record<string, unknown> | null> => {
      calls.push('prepare');
      return null;
    }),
    activateLookup: vi.fn(async () => void calls.push('lookup')),
    activateTenant: vi.fn(async (): Promise<ControlTenantRuntimeRouteObservation> => {
      calls.push('active');
      return {
        runtimeGeneration: 3,
        registryPublicationGeneration: 3,
        tenantLifecycleState: 'active',
        routeStatus: 'active',
        targets: [
          {
            dataRole: 'tenant_core/default',
            shardId: 'shard-default',
            bindingRef: 'TDB_DEFAULT_A',
            generation: 3,
          },
          {
            dataRole: 'tenant_core/users',
            shardId: 'shard-users',
            bindingRef: 'TDB_USERS_A',
            generation: 3,
          },
          {
            dataRole: 'tenant_pii',
            shardId: 'shard-pii',
            bindingRef: 'TDB_PII_A',
            generation: 3,
          },
        ],
      };
    }),
  };
  return {
    repository,
    lease,
    env,
    dependencies,
    checkpoints,
    calls,
    ensureTenantShardCapacity,
    reserveTenantDefaultRoute,
    commitTenantDefaultRoute,
  };
}

describe('tenant provisioning orchestrator', () => {
  it('waits without reserving a tenant route while any capacity operation is pending', async () => {
    const pending: ControlTenantShardCapacityResult = {
      state: 'provisioning',
      target: null,
      operation: {
        operationId: 'control-capacity-a',
        status: 'waiting_retry',
        attemptCount: 1,
        nextAttemptAt: NOW + 15,
        lastErrorCode: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    const test = harness({ capacity: () => pending });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'capacity_check',
        stepStatus: 'waiting_retry',
        operationStatus: 'waiting_retry',
        nextAttemptAt: NOW + 15,
      }),
    ]);
    expect(test.reserveTenantDefaultRoute).not.toHaveBeenCalled();
    expect(test.calls).toEqual(['draft']);
  });

  it('keeps polling while a binding smoke retry is reported by Control', async () => {
    const pending: ControlTenantShardCapacityResult = {
      state: 'provisioning',
      target: null,
      operation: {
        operationId: 'control-capacity-smoke',
        status: 'waiting_retry',
        attemptCount: 3,
        nextAttemptAt: NOW + 15,
        lastErrorCode: 'runtime_smoke_binding_unavailable',
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    const test = harness({ capacity: () => pending });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'capacity_check',
        stepStatus: 'waiting_retry',
        operationStatus: 'waiting_retry',
        nextAttemptAt: NOW + 15,
      }),
    ]);
    expect(test.reserveTenantDefaultRoute).not.toHaveBeenCalled();
  });

  it('commits the sticky route before the final tenant lifecycle activation', async () => {
    const existingCapacityOperationIds = {
      'tenant_core/default': 'control-default',
      'tenant_core/users': 'control-users',
      tenant_pii: 'control-pii',
    };
    const test = harness({
      operation: operation({ capacityOperationIds: existingCapacityOperationIds }),
    });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.calls).toEqual([
      'draft',
      'seed',
      'registry',
      'smoke',
      'prepare',
      'lookup',
      'active',
    ]);
    expect(test.commitTenantDefaultRoute).toHaveBeenCalledWith({
      allocationId: route().allocationId,
    });
    const activationCallOrder = test.dependencies.activateTenant.mock.invocationCallOrder[0];
    expect(activationCallOrder).toBeDefined();
    expect(test.commitTenantDefaultRoute.mock.invocationCallOrder[0]).toBeLessThan(
      activationCallOrder ?? 0
    );
    expect(test.checkpoints.map((checkpoint) => checkpoint.step)).toEqual([
      'capacity_check',
      'reserve_default_route',
      'tenant_seed',
      'registry_publish',
      'tenant_smoke',
      'tenant_prepare',
      'lookup_activate',
      'tenant_active',
    ]);
    expect(test.checkpoints[0]).toMatchObject({
      capacityOperationIds: existingCapacityOperationIds,
    });
    expect(test.checkpoints.at(-1)).toMatchObject({
      operationStatus: 'succeeded',
      stepStatus: 'succeeded',
    });
  });

  it('carries clone preparation evidence into lookup and final activation', async () => {
    const test = harness({
      operation: operation({
        operationKind: 'clone',
        sourceTenantId: 'tenant-source',
        preparationPayload: { copy: { settings: true } },
        currentStep: 'tenant_prepare',
        defaultRouteAllocation: route() as unknown as Record<string, unknown>,
      }),
    });
    const preparationResult = {
      source_tenant_id: 'tenant-source',
      cloned_items: { settings: 1 },
      warnings: [],
    };
    test.dependencies.prepareTenant.mockResolvedValueOnce(preparationResult);

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.checkpoints[0]).toMatchObject({
      step: 'tenant_prepare',
      preparationResult,
    });
    expect(test.dependencies.activateLookup).toHaveBeenCalledWith(
      expect.objectContaining({ preparationResult }),
      expect.anything()
    );
    expect(test.dependencies.activateTenant).toHaveBeenCalledWith(
      expect.objectContaining({ preparationResult }),
      expect.anything()
    );
  });

  it('resumes at registry publication without repeating capacity, reservation, or seed', async () => {
    const test = harness({
      operation: operation({
        currentStep: 'registry_publish',
        defaultRouteAllocation: route() as unknown as Record<string, unknown>,
      }),
    });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.ensureTenantShardCapacity).not.toHaveBeenCalled();
    expect(test.reserveTenantDefaultRoute).not.toHaveBeenCalled();
    expect(test.dependencies.seedTenant).not.toHaveBeenCalled();
    expect(test.calls).toEqual(['registry', 'smoke', 'prepare', 'lookup', 'active']);
  });

  it('does not activate tenant lifecycle until the sticky route commit is reflected', async () => {
    const test = harness({
      operation: operation({
        currentStep: 'tenant_active',
        defaultRouteAllocation: route() as unknown as Record<string, unknown>,
      }),
    });
    test.commitTenantDefaultRoute.mockResolvedValueOnce(route('reserved'));

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.dependencies.activateTenant).not.toHaveBeenCalled();
    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'tenant_active',
        operationStatus: 'waiting_retry',
        errorCode: 'tenant_provisioning_route_commit_failed',
      }),
    ]);
  });

  it('blocks when Control reports a non-retryable capacity failure', async () => {
    const blocked: ControlTenantShardCapacityResult = {
      state: 'blocked',
      target: null,
      operation: {
        operationId: 'control-blocked',
        status: 'blocked',
        attemptCount: 1,
        nextAttemptAt: null,
        lastErrorCode: 'cloudflare_d1_capability_rejected',
        createdAt: NOW,
        updatedAt: NOW,
      },
      reasonCode: 'cloudflare_d1_capability_rejected',
    };
    const test = harness({ capacity: () => blocked });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'capacity_check',
        stepStatus: 'blocked',
        operationStatus: 'blocked',
        errorCode: 'cloudflare_d1_capability_rejected',
      }),
    ]);
  });

  it('keeps polling an operator handoff without requiring an Admin retry', async () => {
    const blocked: ControlTenantShardCapacityResult = {
      state: 'blocked',
      target: null,
      operation: {
        operationId: 'control-operator-handoff',
        status: 'blocked',
        attemptCount: 0,
        nextAttemptAt: null,
        lastErrorCode: 'operator_action_required',
        createdAt: NOW,
        updatedAt: NOW,
      },
      reasonCode: 'operator_action_required',
    };
    const test = harness({ capacity: () => blocked });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'capacity_check',
        stepStatus: 'waiting_retry',
        operationStatus: 'waiting_retry',
        nextAttemptAt: NOW + 60,
        errorCode: 'operator_action_required',
        capacityOperationIds: {
          'tenant_core/default': 'control-operator-handoff',
          'tenant_core/users': 'control-operator-handoff',
          tenant_pii: 'control-operator-handoff',
        },
      }),
    ]);
  });

  it('waits for a platform draft before requesting capacity', async () => {
    const test = harness({});
    test.dependencies.validatePlatformDraft.mockRejectedValueOnce(
      new Error('tenant_provisioning_platform_draft_missing')
    );

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.ensureTenantShardCapacity).not.toHaveBeenCalled();
    expect(test.reserveTenantDefaultRoute).not.toHaveBeenCalled();
    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'capacity_check',
        stepStatus: 'waiting_retry',
        operationStatus: 'waiting_retry',
        errorCode: 'tenant_provisioning_platform_draft_missing',
      }),
    ]);
  });

  it('blocks a platform draft owned by a conflicting tenant code', async () => {
    const test = harness({});
    test.dependencies.validatePlatformDraft.mockRejectedValueOnce(
      new Error('tenant_provisioning_platform_draft_conflict')
    );

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.ensureTenantShardCapacity).not.toHaveBeenCalled();
    expect(test.reserveTenantDefaultRoute).not.toHaveBeenCalled();
    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'capacity_check',
        stepStatus: 'blocked',
        operationStatus: 'blocked',
        errorCode: 'tenant_provisioning_platform_draft_conflict',
      }),
    ]);
  });

  it('retries fail closed when Control returns capacity for a different data role', async () => {
    const test = harness({
      capacity: (role) =>
        role === 'tenant_core/default'
          ? ready('tenant_pii')
          : ready(role as Parameters<typeof ready>[0]),
    });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.reserveTenantDefaultRoute).not.toHaveBeenCalled();
    expect(test.calls).toEqual(['draft']);
    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'capacity_check',
        stepStatus: 'waiting_retry',
        operationStatus: 'waiting_retry',
        nextAttemptAt: NOW + 15,
        errorCode: 'tenant_provisioning_capacity_response_invalid',
      }),
    ]);
  });

  it('blocks an invalid capacity response after the bounded retry budget', async () => {
    const test = harness({
      operation: operation({ retryBudgetStartedAt: NOW - 2 * 60 * 60 }),
      capacity: (role) =>
        role === 'tenant_core/default'
          ? ready('tenant_pii')
          : ready(role as Parameters<typeof ready>[0]),
    });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.reserveTenantDefaultRoute).not.toHaveBeenCalled();
    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'capacity_check',
        stepStatus: 'blocked',
        operationStatus: 'blocked',
        nextAttemptAt: null,
        errorCode: 'tenant_provisioning_capacity_response_invalid',
      }),
    ]);
  });

  it('fails closed before seeding when Control returns another tenant route', async () => {
    const test = harness({});
    test.reserveTenantDefaultRoute.mockResolvedValueOnce({
      ...route(),
      tenantId: 'tenant-b',
    });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.calls).toEqual(['draft']);
    expect(test.checkpoints.at(-1)).toMatchObject({
      step: 'reserve_default_route',
      stepStatus: 'blocked',
      operationStatus: 'blocked',
      errorCode: 'tenant_provisioning_default_route_invalid',
    });
  });

  it('blocks a malformed persisted route instead of leaving the operation running', async () => {
    const test = harness({
      operation: operation({
        currentStep: 'tenant_seed',
        defaultRouteAllocation: {
          ...(route() as unknown as Record<string, unknown>),
          tenantId: 'tenant-b',
        },
      }),
    });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.ensureTenantShardCapacity).not.toHaveBeenCalled();
    expect(test.calls).toEqual([]);
    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'tenant_seed',
        stepStatus: 'blocked',
        operationStatus: 'blocked',
        errorCode: 'tenant_provisioning_default_route_invalid',
      }),
    ]);
  });

  it('does not activate when the committed route changes its physical target', async () => {
    const test = harness({
      operation: operation({
        currentStep: 'tenant_active',
        defaultRouteAllocation: route() as unknown as Record<string, unknown>,
      }),
    });
    test.commitTenantDefaultRoute.mockResolvedValueOnce({
      ...route('committed'),
      target: {
        ...route('committed').target,
        bindingRef: 'TDB_DEFAULT_B',
        databaseId: 'database-default-b',
        databaseName: 'authrim-test-default-b',
      },
    });

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.dependencies.activateTenant).not.toHaveBeenCalled();
    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'tenant_active',
        stepStatus: 'blocked',
        operationStatus: 'blocked',
        errorCode: 'tenant_provisioning_route_commit_conflict',
      }),
    ]);
  });

  it('redacts arbitrary dependency errors and retries the exact failed step', async () => {
    const test = harness({
      operation: operation({
        currentStep: 'tenant_smoke',
        defaultRouteAllocation: route() as unknown as Record<string, unknown>,
      }),
    });
    test.dependencies.smokeTenant.mockRejectedValueOnce(
      new Error('provider response containing secret material')
    );

    await runTenantProvisioningSaga({ ...test, now: () => NOW });

    expect(test.checkpoints).toEqual([
      expect.objectContaining({
        step: 'tenant_smoke',
        operationStatus: 'waiting_retry',
        errorCode: 'tenant_provisioning_step_failed',
      }),
    ]);
  });
});

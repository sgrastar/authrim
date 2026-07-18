import { describe, expect, it, vi } from 'vitest';
import type { AgentBulkPlanRecord, AgentBulkTenantExecutionRecord } from '../../../core';
import { CloudflareAgentBulkCoordinator } from '../bulk-plans';

const definition = {
  schemaVersion: 'authrim-agent-bulk-plan-v1' as const,
  targetTenantIds: ['tenant-a'],
  canaryTenantIds: ['tenant-a'],
  plan: {
    schemaVersion: 'authrim-agent-plan-v1' as const,
    steps: [
      {
        id: 'step-1',
        operation: 'admin.write.clients.metadata',
        toolContractVersion: '1',
        input: { client_id: 'client-1', client_name: 'Updated' },
        resourcePrecondition: 'per-tenant-validation',
      },
    ],
  },
};

function plan(): AgentBulkPlanRecord {
  return {
    id: 'bulk-1',
    version: 1,
    controlTenantId: 'control',
    grantId: 'grant-1',
    actorSub: 'machine:principal-1',
    clientId: 'client-1',
    definition,
    definitionDigest: 'plan-digest',
    targetTenantIds: ['tenant-a'],
    targetSnapshotDigest: 'targets',
    canaryTenantIds: ['tenant-a'],
    canaryDigest: 'canaries',
    status: 'running',
    stage: 'validate',
    canarySize: 1,
    waveSize: 1,
    waveFailureThresholdBasisPoints: 500,
    currentWave: 0,
    succeededCount: 0,
    failedCount: 0,
    indeterminateCount: 0,
    expiresAt: 20_000,
    payloadPurgeAt: 30_000,
    createdAt: 1,
    updatedAt: 1,
    delegatorId: 'admin-1',
    actorMode: 'mode_b',
    actorAssurance: 'machine_key',
    tokenBinding: 'dpop',
    machinePrincipalId: 'principal-1',
    machineCredentialId: 'credential-1',
    grantGeneration: 2,
    consentVersion: 3,
    approvedBy: 'admin-1',
    approvedAt: 1,
    approvalDigest: 'approval-digest',
  };
}

function execution(
  overrides: Partial<AgentBulkTenantExecutionRecord> = {}
): AgentBulkTenantExecutionRecord {
  return {
    id: 'execution-1',
    bulkPlanId: 'bulk-1',
    bulkPlanVersion: 1,
    targetTenantId: 'tenant-a',
    targetSequence: 0,
    isCanary: true,
    stage: 'validate',
    status: 'pending',
    planDigest: 'plan-digest',
    executionAttempt: 0,
    executionFence: 0,
    idempotencyKey: 'key-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function setup(
  initial: AgentBulkTenantExecutionRecord,
  planOverrides: Partial<AgentBulkPlanRecord> = {}
) {
  const currentPlan = { ...plan(), ...planOverrides };
  let current = initial;
  const repository = {
    listRunning: vi.fn().mockResolvedValue([currentPlan]),
    get: vi.fn().mockResolvedValue(currentPlan),
    listTenantExecutions: vi.fn().mockImplementation(() => Promise.resolve([current])),
    listRunnableTenantExecutions: vi
      .fn()
      .mockImplementation(() => Promise.resolve(current.status === 'pending' ? [current] : [])),
    getTenantExecution: vi.fn().mockImplementation(() => Promise.resolve(current)),
    claimTenant: vi.fn().mockImplementation((input) => {
      current = {
        ...current,
        status: 'running',
        executionAttempt: current.executionAttempt + 1,
        executionFence: current.executionFence + 1,
        childCapabilityDigest: input.childCapabilityDigest,
        childCapabilityExpiresAt: input.childCapabilityExpiresAt,
        executionLeaseExpiresAt: input.leaseExpiresAt,
      };
      return Promise.resolve(true);
    }),
    setRunningProgress: vi.fn().mockResolvedValue(true),
    advanceTenantStage: vi.fn().mockImplementation((input) => {
      current = {
        ...current,
        status: 'pending',
        stage: input.to,
        result: input.checkpoint,
        resultDigest: input.checkpointDigest,
        preconditionSnapshotDigest: input.preconditionSnapshotDigest,
      };
      return Promise.resolve(true);
    }),
    completeTenant: vi.fn().mockImplementation((input) => {
      current = { ...current, status: input.status, result: input.result };
      return Promise.resolve(true);
    }),
    transition: vi.fn().mockResolvedValue(true),
  };
  const executor = { execute: vi.fn() };
  const coordinator = new CloudflareAgentBulkCoordinator(
    repository as never,
    executor,
    { now: () => 1_000 },
    { getIssuerOrigin: (tenantId) => `https://${tenantId}.auth.example` }
  );
  return { coordinator, repository, executor, current: () => current };
}

describe('CloudflareAgentBulkCoordinator', () => {
  it('captures a tenant-specific resource version before apply', async () => {
    const test = setup(execution());
    test.executor.execute.mockResolvedValue({
      status: 200,
      body: { client: { client_id: 'client-1' }, resource_version: 'resource-version-1' },
      executionStatus: 'definite',
    });
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'advanced',
      stage: 'validate',
    });
    expect(test.current()).toMatchObject({
      status: 'pending',
      stage: 'apply',
      result: { snapshots: [{ step_id: 'step-1', resource_version: 'resource-version-1' }] },
    });
  });

  it('marks an uncertain apply indeterminate and pauses the parent', async () => {
    const test = setup(
      execution({
        stage: 'apply',
        preconditionSnapshotDigest: 'snapshot-digest',
        result: { snapshots: [{ step_id: 'step-1', resource_version: 'resource-version-1' }] },
      })
    );
    test.executor.execute.mockResolvedValue({
      status: 503,
      body: { error: 'unknown' },
      executionStatus: 'indeterminate',
    });
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'paused',
      reason: 'indeterminate',
    });
    expect(test.repository.completeTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'indeterminate',
        failureKind: 'owner_result_indeterminate',
      })
    );
  });

  it('recovers an expired child lease as indeterminate before starting new work', async () => {
    const test = setup(
      execution({
        status: 'running',
        executionAttempt: 1,
        executionFence: 1,
        executionLeaseExpiresAt: 999,
      })
    );
    await expect(test.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'paused',
      reason: 'indeterminate',
    });
    expect(test.repository.completeTenant).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'indeterminate', failureKind: 'execution_lease_expired' })
    );
    expect(test.executor.execute).not.toHaveBeenCalled();
  });

  it('captures and verifies Login UI Settings v2 state for a cross-tenant Plan', async () => {
    const loginDefinition = {
      schemaVersion: 'authrim-agent-bulk-plan-v1' as const,
      targetTenantIds: ['tenant-a'],
      canaryTenantIds: ['tenant-a'],
      plan: {
        schemaVersion: 'authrim-agent-plan-v1' as const,
        steps: [
          {
            id: 'step-brand',
            operation: 'admin.write.login-ui.update',
            toolContractVersion: '1',
            input: { brandName: 'Example', supportedLocales: ['ja', 'en'] },
            resourcePrecondition: 'per-tenant-validation',
          },
        ],
      },
    };
    const validating = setup(execution(), { definition: loginDefinition });
    validating.executor.execute.mockResolvedValue({
      status: 200,
      body: { snapshot: { version: 'settings-v1', values: {} } },
      executionStatus: 'definite',
    });

    await expect(validating.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'advanced',
      stage: 'validate',
    });
    expect(validating.executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'admin.read.login-ui.inspect', input: {} })
    );
    expect(validating.current()).toMatchObject({
      status: 'pending',
      stage: 'apply',
      result: { snapshots: [{ step_id: 'step-brand', resource_version: 'settings-v1' }] },
    });

    const verifying = setup(
      execution({
        stage: 'verify',
        preconditionSnapshotDigest: 'snapshot-digest',
        result: { snapshots: [{ step_id: 'step-brand', resource_version: 'settings-v1' }] },
      }),
      { definition: loginDefinition }
    );
    verifying.executor.execute.mockResolvedValue({
      status: 200,
      body: {
        snapshot: {
          version: 'settings-v2',
          values: {
            'login-ui.brand_name': 'Example',
            'login-ui.supported_locales': 'ja,en',
          },
        },
      },
      executionStatus: 'definite',
    });

    await expect(verifying.coordinator.runPlan('control', 'bulk-1', 1)).resolves.toMatchObject({
      outcome: 'advanced',
      stage: 'verify',
    });
    expect(verifying.current()).toMatchObject({ status: 'succeeded' });
  });
});

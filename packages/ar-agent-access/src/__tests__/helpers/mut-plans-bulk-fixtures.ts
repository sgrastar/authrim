import { expect, vi } from 'vitest';
import type {
  AgentBulkRepository,
  AgentBulkPlanRecord,
  AgentBulkTenantExecutionRecord,
  JsonObject,
} from '../../core';
import type { AgentBulkChildExecutorPort } from '../../platform/ports';
import { CloudflareAgentBulkCoordinator } from '../../platform/cloudflare/bulk-plans';

export const BULK_NOW = 1_000;

export const BULK_CLIENT_STEP = {
  id: 'step-1',
  operation: 'admin.write.clients.metadata',
  toolContractVersion: '1',
  input: { client_id: 'client-1', client_name: 'Updated' },
  resourcePrecondition: 'per-tenant-validation',
};

export const BULK_LOGIN_STEP = {
  id: 'step-brand',
  operation: 'admin.write.login-ui.update',
  toolContractVersion: '1',
  input: { brandName: 'Example', supportedLocales: ['ja', 'en'] },
  resourcePrecondition: 'per-tenant-validation',
};

export function bulkDefinition(...steps: object[]): AgentBulkPlanRecord['definition'] {
  return {
    schemaVersion: 'authrim-agent-bulk-plan-v1',
    targetTenantIds: ['tenant-a'],
    canaryTenantIds: ['tenant-a'],
    plan: {
      schemaVersion: 'authrim-agent-plan-v1',
      goal: 'Apply an approved Authrim configuration change',
      steps: steps as NonNullable<AgentBulkPlanRecord['definition']>['plan']['steps'],
    },
  };
}

export function bulkPlan(overrides: Partial<AgentBulkPlanRecord> = {}): AgentBulkPlanRecord {
  return {
    id: 'bulk-1',
    version: 1,
    controlTenantId: 'control',
    grantId: 'grant-1',
    actorSub: 'machine:principal-1',
    clientId: 'client-1',
    definition: bulkDefinition(BULK_CLIENT_STEP),
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
    ...overrides,
  };
}

export function bulkExecution(
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

/** Expected audit row written by the Bulk coordinator. */
export function expectedBulkAudit(
  plan: AgentBulkPlanRecord,
  action: string,
  resourceId: string,
  metadata: JsonObject,
  severity: 'info' | 'warn' = 'info'
) {
  return {
    id: expect.stringMatching(/^audit_[0-9a-f-]{36}$/u) as string,
    tenantId: plan.controlTenantId,
    adminUserId: plan.delegatorId,
    action,
    resourceType: 'agent_bulk_tenant_execution',
    resourceId,
    severity,
    actorType: 'agent',
    actorSub: plan.actorSub,
    actorMode: plan.actorMode,
    actorAssurance: plan.actorAssurance,
    tokenBinding: plan.tokenBinding,
    actClientId: plan.clientId,
    actPrincipalId: plan.machinePrincipalId,
    grantId: plan.grantId,
    metadata,
    createdAt: BULK_NOW,
  };
}

/**
 * Stateful in-memory Bulk repository: executions mutate as the coordinator claims, advances and
 * completes them, so a test can assert what was persisted.
 */
type Bulk = AgentBulkRepository;

export function bulkHarness(
  initial: AgentBulkTenantExecutionRecord[],
  planOverrides: Partial<AgentBulkPlanRecord> = {},
  ownerId?: string
) {
  const currentPlan = bulkPlan(planOverrides);
  const executions = new Map(initial.map((item) => [item.id, item]));
  const list = () => [...executions.values()];
  const repository = {
    listRunning: vi.fn<Bulk['listRunning']>().mockResolvedValue([currentPlan]),
    get: vi.fn<Bulk['get']>().mockResolvedValue(currentPlan),
    listTenantExecutions: vi
      .fn<Bulk['listTenantExecutions']>()
      .mockImplementation(() => Promise.resolve(list())),
    listRunnableTenantExecutions: vi
      .fn<Bulk['listRunnableTenantExecutions']>()
      .mockImplementation(() =>
        Promise.resolve(list().filter((item) => item.status === 'pending'))
      ),
    getTenantExecution: vi
      .fn<Bulk['getTenantExecution']>()
      .mockImplementation((_t: string, _p: string, _v: number, id: string) =>
        Promise.resolve(executions.get(id) ?? null)
      ),
    claimTenant: vi.fn<Bulk['claimTenant']>().mockImplementation((input) => {
      const current = executions.get(input.executionId)!;
      executions.set(current.id, {
        ...current,
        status: 'running',
        executionAttempt: current.executionAttempt + 1,
        executionFence: current.executionFence + 1,
        childCapabilityDigest: input.childCapabilityDigest,
        executionLeaseExpiresAt: input.leaseExpiresAt,
      });
      return Promise.resolve(true);
    }),
    setRunningProgress: vi.fn<Bulk['setRunningProgress']>().mockResolvedValue(true),
    advanceTenantStage: vi.fn<Bulk['advanceTenantStage']>().mockImplementation((input) => {
      const current = executions.get(input.executionId)!;
      executions.set(current.id, {
        ...current,
        status: 'pending',
        stage: input.to,
        result: input.checkpoint,
        preconditionSnapshotDigest: input.preconditionSnapshotDigest,
      });
      return Promise.resolve(true);
    }),
    completeTenant: vi.fn<Bulk['completeTenant']>().mockImplementation((input) => {
      const current = executions.get(input.executionId)!;
      executions.set(current.id, { ...current, status: input.status, result: input.result });
      return Promise.resolve(true);
    }),
    transition: vi.fn<Bulk['transition']>().mockResolvedValue(true),
  };
  const executor = { execute: vi.fn<AgentBulkChildExecutorPort['execute']>() };
  const coordinator = new CloudflareAgentBulkCoordinator(
    repository,
    executor,
    { now: () => BULK_NOW },
    { getIssuerOrigin: (tenantId) => `https://${tenantId}.auth.example` },
    ownerId
  );
  return {
    coordinator,
    repository,
    executor,
    plan: currentPlan,
    execution: (id = 'execution-1') => executions.get(id)!,
  };
}

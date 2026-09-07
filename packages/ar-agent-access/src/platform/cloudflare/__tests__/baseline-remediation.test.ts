import { describe, expect, it, vi } from 'vitest';
import type {
  AgentBaselineRepository,
  AgentBulkPlanRecord,
  AgentBulkRepository,
} from '../../../core';
import { CloudflareAgentBaselineRemediationCoordinator } from '../baseline-remediation';

const profile = {
  schemaVersion: 'authrim-agent-plan-v1' as const,
  goal: 'Apply an approved Authrim configuration change',
  steps: [
    {
      id: 'client-metadata',
      operation: 'admin.write.clients.metadata',
      toolContractVersion: '1',
      input: {
        client_id: 'client-1',
        client_name: 'Expected',
      },
      resourcePrecondition: 'per-tenant-validation',
    },
  ],
};

const context = {
  assignment: {
    id: 'assignment-1',
    baselineId: 'baseline-1',
    baselineVersion: 1,
    tenantId: 'tenant-1',
    sourceBulkPlanId: 'bulk-source',
    sourceBulkPlanVersion: 1,
    assignedBy: 'admin-1',
    assignedAt: 1,
    driftStatus: 'drifted' as const,
    driftDigest: 'drift-1',
    remediationBulkPlanId: 'bulk-remediation',
    remediationBulkPlanVersion: 1,
    remediationDriftDigest: 'drift-1',
    remediationRequestedAt: 2,
  },
  baseline: {
    id: 'baseline-1',
    version: 1,
    controlTenantId: 'control',
    name: 'Managed baseline',
    mode: 'managed' as const,
    enforcement: 'standard_auto_remediation' as const,
    definition: {
      schemaVersion: 'authrim-agent-baseline-v1' as const,
      taskSet: { id: 'task-set', version: 1, digest: 'x'.repeat(32) },
      configurationProfile: profile,
    },
    definitionDigest: 'baseline-digest',
    status: 'active' as const,
    createdBy: 'admin-1',
    createdAt: 1,
  },
};

const source: AgentBulkPlanRecord = {
  id: 'bulk-source',
  version: 1,
  controlTenantId: 'control',
  grantId: 'grant-1',
  actorSub: 'machine:principal-1',
  clientId: 'client-1',
  definition: {
    schemaVersion: 'authrim-agent-bulk-plan-v1',
    targetTenantIds: ['tenant-1'],
    canaryTenantIds: ['tenant-1'],
    plan: profile,
  },
  definitionDigest: 'source-digest',
  targetTenantIds: ['tenant-1'],
  targetSnapshotDigest: 'target-digest',
  canaryTenantIds: ['tenant-1'],
  canaryDigest: 'canary-digest',
  status: 'completed',
  stage: 'verify',
  canarySize: 1,
  waveSize: 1,
  waveFailureThresholdBasisPoints: 0,
  currentWave: 0,
  succeededCount: 1,
  failedCount: 0,
  indeterminateCount: 0,
  expiresAt: 10,
  payloadPurgeAt: 20,
  createdAt: 1,
  updatedAt: 2,
  delegatorId: 'admin-1',
  actorMode: 'mode_b',
  actorAssurance: 'machine_key',
  tokenBinding: 'dpop',
  machinePrincipalId: 'principal-1',
  machineCredentialId: 'credential-1',
  grantGeneration: 1,
  consentVersion: 1,
};

describe('managed Baseline auto-remediation coordinator', () => {
  it('periodically evaluates managed assignments and atomically queues detected drift', async () => {
    const baselines = {
      listManagedEvaluationCandidates: vi
        .fn()
        .mockResolvedValue([{ controlTenantId: 'control', assignmentId: 'assignment-1' }]),
      getAssignmentContext: vi.fn().mockResolvedValue(context),
      listExceptions: vi.fn().mockResolvedValue([]),
      evaluateManagedAssignment: vi.fn().mockResolvedValue(true),
      reserveAutoRemediation: vi.fn().mockResolvedValue(true),
    };
    const coordinator = new CloudflareAgentBaselineRemediationCoordinator(
      baselines as unknown as AgentBaselineRepository,
      {} as AgentBulkRepository,
      {
        get: async () => ({ enabled: true, bulkCanaryProtected: false }),
      } as never,
      { now: () => 1_000_000 },
      { readCurrent: vi.fn().mockResolvedValue({ client_name: 'Changed' }) }
    );

    await expect(coordinator.evaluateScheduled()).resolves.toEqual([
      {
        assignmentId: 'assignment-1',
        outcome: 'queued',
        driftStatus: 'drifted',
      },
    ]);
    expect(baselines.evaluateManagedAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: 'assignment-1',
        status: 'drifted',
        evaluatedAt: 1_000_000,
      })
    );
    expect(baselines.reserveAutoRemediation).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: 'assignment-1',
        driftDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      })
    );
  });

  it('materializes and starts one crash-recoverable single-tenant Bulk Plan', async () => {
    let remediation: AgentBulkPlanRecord | null = null;
    const bulk = {
      get: vi.fn(async (_tenant: string, id: string) => (id === source.id ? source : remediation)),
      create: vi.fn(async (input) => {
        remediation = {
          ...source,
          id: input.id,
          definition: input.resolved.definition,
          definitionDigest: input.resolved.digest,
          targetSnapshotDigest: input.resolved.targetSnapshotDigest,
          canaryDigest: input.resolved.canaryDigest,
          status: 'draft',
        };
      }),
      transition: vi.fn(async () => {
        remediation = { ...remediation!, status: 'ready' };
        return true;
      }),
      startApproved: vi.fn().mockResolvedValue(true),
    };
    const coordinator = new CloudflareAgentBaselineRemediationCoordinator(
      {
        getAssignmentContext: vi.fn().mockResolvedValue(context),
      } as unknown as AgentBaselineRepository,
      bulk as unknown as AgentBulkRepository,
      { get: async () => ({ bulkCanaryProtected: false }) } as never,
      { now: () => 1_000 }
    );

    await expect(coordinator.run('control', 'assignment-1')).resolves.toMatchObject({
      outcome: 'started',
      bulkPlanId: 'bulk-remediation',
    });
    expect(bulk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorMode: 'mode_b',
        tokenBinding: 'dpop',
        resolved: expect.objectContaining({
          definition: expect.objectContaining({ targetTenantIds: ['tenant-1'] }),
        }),
      })
    );
    expect(bulk.startApproved).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedBy: 'admin-1',
        approvalDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      })
    );
  });

  it('does not materialize auto-remediation for a protected tenant', async () => {
    const bulk = { get: vi.fn(), create: vi.fn() };
    const coordinator = new CloudflareAgentBaselineRemediationCoordinator(
      {
        getAssignmentContext: vi.fn().mockResolvedValue(context),
      } as unknown as AgentBaselineRepository,
      bulk as unknown as AgentBulkRepository,
      { get: async () => ({ bulkCanaryProtected: true }) } as never,
      { now: () => 1_000 }
    );
    await expect(coordinator.run('control', 'assignment-1')).resolves.toMatchObject({
      outcome: 'blocked',
      reason: 'protected_tenant',
    });
    expect(bulk.create).not.toHaveBeenCalled();
  });
});

import { expect, vi } from 'vitest';
import type {
  AgentBaselineAssignmentContext,
  AgentBaselineRepository,
  AgentBulkPlanRecord,
  AgentBulkRepository,
} from '../../core';
import type { AgentConfigurationStateReaderPort } from '../../platform/ports';
import { CloudflareAgentBaselineRemediationCoordinator } from '../../platform/cloudflare/baseline-remediation';

export const BASELINE_NOW = 1_000_000;

export const profile = {
  schemaVersion: 'authrim-agent-plan-v1' as const,
  goal: 'Apply an approved Authrim configuration change',
  steps: [
    {
      id: 'client-metadata',
      operation: 'admin.write.clients.metadata',
      toolContractVersion: '1',
      input: { client_id: 'client-1', client_name: 'Expected' },
      resourcePrecondition: 'per-tenant-validation',
    },
  ],
};

export function baselineContext(
  assignment: Partial<AgentBaselineAssignmentContext['assignment']> = {},
  baseline: Partial<AgentBaselineAssignmentContext['baseline']> = {}
): AgentBaselineAssignmentContext {
  return {
    assignment: {
      id: 'assignment-1',
      baselineId: 'baseline-1',
      baselineVersion: 1,
      tenantId: 'tenant-1',
      sourceBulkPlanId: 'bulk-source',
      sourceBulkPlanVersion: 4,
      assignedBy: 'admin-1',
      assignedAt: 1,
      driftStatus: 'drifted',
      driftDigest: 'drift-1',
      remediationBulkPlanId: 'bulk-remediation',
      remediationBulkPlanVersion: 1,
      remediationDriftDigest: 'drift-1',
      remediationRequestedAt: 2,
      ...assignment,
    },
    baseline: {
      id: 'baseline-1',
      version: 2,
      controlTenantId: 'control',
      name: 'Managed baseline',
      mode: 'managed',
      enforcement: 'standard_auto_remediation',
      definition: {
        schemaVersion: 'authrim-agent-baseline-v1',
        taskSet: { id: 'task-set', version: 1, digest: 'x'.repeat(32) },
        configurationProfile: profile,
      },
      definitionDigest: 'baseline-digest',
      status: 'active',
      createdBy: 'admin-creator',
      createdAt: 1,
      ...baseline,
    },
  };
}

export function sourcePlan(overrides: Partial<AgentBulkPlanRecord> = {}): AgentBulkPlanRecord {
  return {
    id: 'bulk-source',
    version: 4,
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
    grantGeneration: 5,
    consentVersion: 6,
    ...overrides,
  };
}

export function expectedBaselineAudit(
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: object,
  createdAt = BASELINE_NOW
) {
  return {
    id: expect.stringMatching(/^audit_[0-9a-f-]{36}$/u) as string,
    tenantId: 'control',
    adminUserId: 'admin-creator',
    action,
    resourceType,
    resourceId,
    severity: 'info',
    actorType: 'system',
    actorSub: 'system:agent-baseline-remediator',
    metadata,
    createdAt,
  };
}

export function baselineHarness(options: { stateReader?: boolean } = {}) {
  const baselines = {
    listManagedEvaluationCandidates: vi.fn().mockResolvedValue([]),
    getAssignmentContext: vi.fn().mockResolvedValue(baselineContext()),
    listExceptions: vi.fn().mockResolvedValue([]),
    evaluateManagedAssignment: vi
      .fn<AgentBaselineRepository['evaluateManagedAssignment']>()
      .mockResolvedValue(true),
    reserveAutoRemediation: vi
      .fn<AgentBaselineRepository['reserveAutoRemediation']>()
      .mockResolvedValue(true),
    listPendingAutoRemediations: vi.fn().mockResolvedValue([]),
  };
  const bulk = {
    get: vi.fn(),
    create: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn().mockResolvedValue(true),
    startApproved: vi.fn().mockResolvedValue(true),
  };
  const settings = {
    get: vi.fn().mockResolvedValue({ enabled: true, bulkCanaryProtected: false }),
  };
  const stateReader = {
    readCurrent: vi.fn().mockResolvedValue({ client_name: 'Changed' }),
  } satisfies AgentConfigurationStateReaderPort;
  const coordinator = new CloudflareAgentBaselineRemediationCoordinator(
    baselines as unknown as AgentBaselineRepository,
    bulk as unknown as AgentBulkRepository,
    settings,
    { now: () => BASELINE_NOW },
    options.stateReader === false ? undefined : stateReader
  );
  return { baselines, bulk, settings, stateReader, coordinator };
}

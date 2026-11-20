import { vi } from 'vitest';
import {
  computeAgentBulkChildCapabilityDigest,
  type AgentBulkChildTokenRequest,
  type AgentGrantContract,
} from '@authrim/ar-agent-access/core';
import { createAdminToolCatalog } from '@authrim/ar-agent-access/protocol/mcp';

type Stage = AgentBulkChildTokenRequest['stage'];
type CatalogTool = ReturnType<ReturnType<typeof createAdminToolCatalog>['list']>[number];

const catalog = createAdminToolCatalog().list();

export function catalogTool(id: string): CatalogTool {
  const tool = catalog.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`unknown tool ${id}`);
  return tool;
}

/** A Grant pin that exactly matches the live catalog contract of the tool. */
export function pinTool(
  id: string
): AgentGrantContract['resolvedTools'] extends (infer T)[] | undefined ? T : never {
  const tool = catalogTool(id);
  return {
    toolId: tool.id,
    toolName: tool.name,
    contractVersion: tool.contractVersion,
    schemaDigest: tool.schemaDigest,
    permissions: [...tool.requiredPermissions],
    requiredScope: tool.requiredScope,
    riskLevel: tool.riskLevel,
    requiresElevation: tool.riskLevel === 'high',
  };
}

export interface BulkStep {
  id: string;
  operation: string;
  toolContractVersion: string;
  input: Record<string, unknown>;
  resourcePrecondition: string;
}

export function step(operation: string, input: Record<string, unknown> = {}): BulkStep {
  return {
    id: `step-${operation}`,
    operation,
    toolContractVersion: catalogTool(operation).contractVersion,
    input,
    resourcePrecondition: 'per-tenant-validation',
  };
}

export const NOW = 1_000;

export interface BulkScenarioOptions {
  stage?: Stage;
  steps?: BulkStep[];
  plan?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  grant?: Partial<AgentGrantContract>;
  request?: Partial<AgentBulkChildTokenRequest>;
  delegatorPermissions?: string[] | null;
  consent?: boolean;
  machinePermissions?: string[] | null;
}

/** A self-consistent Bulk child-token scenario whose capability digest is computed for real. */
export async function bulkScenario(options: BulkScenarioOptions = {}) {
  const stage = options.stage ?? 'apply';
  const steps = options.steps ?? [step('admin.write.clients.metadata', { client_id: 'client-1' })];
  const execution = {
    id: 'execution-1',
    targetTenantId: 'tenant-1',
    status: 'running',
    stage,
    executionAttempt: 2,
    executionFence: 3,
    planDigest: 'plan-digest',
    childCapabilityExpiresAt: 1_100,
    preconditionSnapshotDigest: 'snapshot-digest' as string | undefined,
    ...options.execution,
  };
  const childCapabilityDigest = await computeAgentBulkChildCapabilityDigest({
    purpose: 'authrim-agent-bulk-child-v1',
    controlTenantId: 'platform',
    targetTenantId: 'tenant-1',
    bulkPlanId: 'bulk-1',
    bulkPlanVersion: 4,
    executionId: 'execution-1',
    executionAttempt: 2,
    executionFence: 3,
    stage,
    planDigest: 'plan-digest',
    approvalDigest: 'approval-digest',
    ...(execution.preconditionSnapshotDigest
      ? { preconditionSnapshotDigest: execution.preconditionSnapshotDigest }
      : {}),
    expiresAt: 1_100,
  });
  const request: AgentBulkChildTokenRequest = {
    issuerOrigin: 'https://tenant-1.authrim.example',
    audience: 'authrim:admin-api',
    controlTenantId: 'platform',
    targetTenantId: 'tenant-1',
    bulkPlanId: 'bulk-1',
    bulkPlanVersion: 4,
    executionId: 'execution-1',
    executionAttempt: 2,
    executionFence: 3,
    stage,
    planDigest: 'plan-digest',
    approvalDigest: 'approval-digest',
    childCapabilityDigest,
    correlationId: 'correlation-bulk',
    ...options.request,
  };
  const plan = {
    id: 'bulk-1',
    version: 4,
    controlTenantId: 'platform',
    grantId: 'grant-bulk',
    actorSub: 'machine:principal-1',
    clientId: 'client-agent',
    definition: {
      schemaVersion: 'authrim-agent-bulk-plan-v1',
      targetTenantIds: ['tenant-1'],
      canaryTenantIds: ['tenant-1'],
      plan: { schemaVersion: 'authrim-agent-plan-v1', steps },
    },
    definitionDigest: 'plan-digest',
    status: 'running',
    approvalDigest: 'approval-digest',
    actorMode: 'mode_b',
    actorAssurance: 'machine_key',
    tokenBinding: 'dpop',
    delegatorId: 'admin-1',
    machinePrincipalId: 'principal-1',
    machineCredentialId: 'credential-1',
    grantGeneration: 3,
    consentVersion: 2,
    ...options.plan,
  };
  const grant: AgentGrantContract = {
    grantId: 'grant-bulk',
    tenantId: 'platform',
    clientId: 'client-agent',
    grantorId: 'admin-1',
    delegatorId: 'admin-1',
    machinePrincipalId: 'principal-1',
    permissions: ['admin:*'],
    scopes: ['agent:read', 'agent:write'],
    resolvedScopeConstraints: { tenantIds: ['platform', 'tenant-1'] },
    consentVersion: 2,
    generation: 3,
    status: 'active',
    delegationMode: 'admin_pre_authorized',
    expiresAt: 2_000,
    taskSetId: 'ats-bulk',
    taskSetVersion: 1,
    scopePolicyId: 'asp-bulk',
    scopePolicyVersion: 1,
    resolvedTools: steps.map((entry) => pinTool(entry.operation)),
    accessSnapshotHash: 'b'.repeat(43),
    ...options.grant,
  };
  const repo = {
    get: vi.fn().mockResolvedValue(plan),
    getTenantExecution: vi.fn().mockResolvedValue({ ...execution, childCapabilityDigest }),
    getGrant: vi.fn().mockResolvedValue(grant),
    getActiveDelegatorPermissions: vi
      .fn()
      .mockResolvedValue(
        options.delegatorPermissions === undefined ? ['admin:*'] : options.delegatorPermissions
      ),
    hasCurrentConsent: vi.fn().mockResolvedValue(options.consent ?? true),
  };
  const deps = {
    now: () => NOW,
    isFeatureEnabled: vi.fn().mockResolvedValue(true),
    createBulkRepository: vi.fn(() => ({
      get: repo.get,
      getTenantExecution: repo.getTenantExecution,
    })),
    createRepository: vi.fn(() => ({
      getGrant: repo.getGrant,
      getActiveDelegatorPermissions: repo.getActiveDelegatorPermissions,
      hasCurrentConsent: repo.hasCurrentConsent,
    })),
    getModeBPermissionLimit: vi
      .fn()
      .mockResolvedValue(
        options.machinePermissions === undefined ? ['admin:*'] : options.machinePermissions
      ),
    signToken: vi.fn().mockResolvedValue({ accessToken: 'child-token', expiresAt: 1_060 }),
  };
  return { request, plan, execution, grant, repo, deps, childCapabilityDigest };
}

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import type { AgentToolDefinition, JsonObject } from '../../core';
import { createAdminToolCatalog } from '../../protocol/mcp';
import type { AgentConfigurationOperationRequest } from '../../platform/ports';

export const BULK_PERMISSIONS = [
  ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
  ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
  ADMIN_PERMISSIONS.BULK_PLANS_READ,
  ADMIN_PERMISSIONS.CLIENTS_READ,
  ADMIN_PERMISSIONS.CLIENTS_WRITE,
];

const catalog = createAdminToolCatalog();
export const toolById = (id: string) => catalog.list().find((tool) => tool.id === id)!;

export function pinned(tool: AgentToolDefinition) {
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

export const BULK_CLIENT_WRITE_STEP = {
  id: 'step-1',
  operation: 'admin.write.clients.metadata',
  toolContractVersion: '1',
  input: { client_id: 'client-1', client_name: 'Updated' },
  resourcePrecondition: 'per-tenant-validation',
};

export function bulkPlanDefinition(steps: object[] = [BULK_CLIENT_WRITE_STEP]): JsonObject {
  return {
    schemaVersion: 'authrim-agent-bulk-plan-v1',
    targetTenantIds: ['platform', 'tenant-1'],
    canaryTenantIds: ['tenant-1'],
    plan: {
      schemaVersion: 'authrim-agent-plan-v1',
      goal: 'Apply an approved Authrim configuration change',
      steps: steps as JsonObject[],
    },
  };
}

export function bulkAdapterRequest(
  operation = 'admin.write.bulk.plan.create',
  input: JsonObject = { definition: bulkPlanDefinition() }
): AgentConfigurationOperationRequest {
  return {
    operation,
    actor: {
      mode: 'mode_b',
      sub: 'machine:principal-1',
      assurance: 'machine_key',
      tokenBinding: 'dpop',
      clientId: 'client-agent',
      machinePrincipalId: 'principal-1',
      machineCredentialId: 'credential-1',
    },
    grant: {
      grantId: 'grant-1',
      tenantId: 'platform',
      clientId: 'client-agent',
      machinePrincipalId: 'principal-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: [...BULK_PERMISSIONS],
      scopes: ['agent:read', 'agent:write'],
      resolvedScopeConstraints: { tenantIds: ['platform', 'tenant-1'], maxPerBulkPlan: 2 },
      consentVersion: 1,
      generation: 2,
      status: 'active',
      delegationMode: 'admin_pre_authorized',
      taskSetId: 'ats-bulk-client-write',
      taskSetVersion: 1,
      scopePolicyId: 'asp-bulk-tenant-1',
      scopePolicyVersion: 1,
      accessSnapshotHash: 'a'.repeat(43),
      resolvedTools: [pinned(toolById('admin.write.clients.metadata'))],
    },
    issuerOrigin: 'https://platform.example',
    correlationId: 'correlation-1',
    input,
  };
}

export function agentSettings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    maxTokenTtlSeconds: 900,
    elevationMode: 'self_reauth' as const,
    elevationTtlSeconds: 300,
    rateLimitPerMinute: 60,
    highRiskPermissionsAdditional: [],
    bulkCanaryProtected: false,
    ...overrides,
  };
}

export function machineSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    principal: { id: 'principal-1', status: 'active' },
    credential: { id: 'credential-1', principalId: 'principal-1', status: 'active' },
    principalTenantScopes: [
      { tenantId: 'platform', scopeMode: 'allow' },
      { tenantId: 'tenant-1', scopeMode: 'allow' },
    ],
    credentialTenantScopes: [],
    principalPermissions: [...BULK_PERMISSIONS],
    credentialPermissions: [],
    ...overrides,
  };
}

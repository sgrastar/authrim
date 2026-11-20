import { expect, vi } from 'vitest';
import {
  computeAgentToolContractDigest,
  createAgentToolCatalog,
  type AgentConfigurationPlanDefinition,
  type AgentConfigurationPlanRecord,
  type AgentConfigurationRepository,
  type AgentPlanConfirmationRecord,
  type AgentToolCatalog,
  type AgentToolDefinition,
  type JsonObject,
} from '../../core';
import { createAdminToolCatalog } from '../../protocol/mcp';
import type {
  AgentAuthorizationPort,
  AgentConfigurationOperationRequest,
  AgentJsonSchemaValidatorPort,
  ManagementApiPort,
} from '../../platform/ports';
import { CloudflareAgentConfigurationPlanAdapter } from '../../platform/cloudflare/configuration-plans';

export const NOW = 1_800_000_000_000;

export const CLIENT_STEP = {
  id: 'step-1',
  operation: 'admin.write.clients.metadata',
  toolContractVersion: '1',
  input: { client_id: 'client-target', client_name: 'Updated name' },
  resourcePrecondition: 'resource-v1',
};

export const LOGIN_STEP = {
  id: 'step-brand',
  operation: 'admin.write.login-ui.update',
  toolContractVersion: '1',
  input: { brandName: 'Example' },
  resourcePrecondition: 'settings-v1',
};

export function definitionOf(...steps: object[]): AgentConfigurationPlanDefinition {
  return {
    schemaVersion: 'authrim-agent-plan-v1',
    goal: 'Apply an approved Authrim configuration change',
    steps: steps as AgentConfigurationPlanDefinition['steps'],
  };
}

export function planRecord(
  overrides: Partial<AgentConfigurationPlanRecord> = {}
): AgentConfigurationPlanRecord {
  return {
    id: 'acp-1',
    version: 1,
    tenantId: 'tenant-1',
    grantId: 'grant-1',
    grantGeneration: 1,
    consentVersion: 1,
    actorSub: 'machine:amp-1',
    clientId: 'client-1',
    definition: definitionOf(CLIENT_STEP),
    definitionDigest: 'plan-digest',
    status: 'ready',
    stage: 'apply',
    appliedStepCount: 0,
    expiresAt: NOW + 60_000,
    payloadPurgeAt: NOW + 100_000,
    createdAt: NOW - 10,
    updatedAt: NOW - 5,
    ...overrides,
  };
}

export function planRequest(
  mode: 'mode_a' | 'mode_b',
  operation: string,
  input: JsonObject = { plan_id: 'acp-1', version: 1 }
): AgentConfigurationOperationRequest {
  return {
    operation,
    actor: {
      mode,
      sub: mode === 'mode_b' ? 'machine:amp-1' : 'client:client-1',
      assurance: mode === 'mode_b' ? 'machine_key' : 'public_client_transaction',
      tokenBinding: mode === 'mode_b' ? 'dpop' : 'bearer',
      clientId: 'client-1',
      ...(mode === 'mode_b' ? { machinePrincipalId: 'amp-1', machineCredentialId: 'cred-1' } : {}),
    },
    grant: {
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      machinePrincipalId: mode === 'mode_b' ? 'amp-1' : undefined,
      grantorId: 'admin-1',
      delegatorId: 'admin-2',
      permissions: [
        'admin:auth_config_plans:read',
        'admin:auth_config_plans:create',
        'admin:auth_config_plans:apply',
        'admin:clients:read',
        'admin:clients:write',
      ],
      scopes: ['agent:read', 'agent:write'],
      resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerPlan: 10 },
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: mode === 'mode_b' ? 'admin_pre_authorized' : 'user_consent',
    },
    issuerOrigin: 'https://tenant.example',
    correlationId: 'correlation-1',
    input,
  };
}

/** The full audit row the adapter must persist for a configuration Plan event. */
export function expectedPlanAudit(
  request: AgentConfigurationOperationRequest,
  action: string,
  resourceId: string,
  createdAt: number,
  metadata: JsonObject
) {
  return {
    id: expect.stringMatching(/^audit_[0-9a-f-]{36}$/u) as string,
    tenantId: request.grant.tenantId,
    adminUserId: request.grant.delegatorId,
    action,
    resourceType: 'agent_configuration_plan',
    resourceId,
    severity: 'info',
    actorType: 'agent',
    actorSub: request.actor.sub,
    actorMode: request.actor.mode,
    actorAssurance: request.actor.assurance,
    tokenBinding: request.actor.tokenBinding,
    actClientId: request.actor.clientId,
    actPrincipalId: request.actor.machinePrincipalId ?? request.grant.machinePrincipalId,
    grantId: request.grant.grantId,
    mcpTool: request.operation,
    requestId: request.correlationId,
    metadata,
    createdAt,
  };
}

/** The fixed Management Service Binding envelope for one tool call. */
export function expectedManagementCall(
  request: AgentConfigurationOperationRequest,
  operation: string,
  effectivePermissions: string[],
  input: JsonObject,
  idempotencyKey?: string
) {
  return {
    operation,
    tenantId: request.grant.tenantId,
    authorization: {
      actor: request.actor,
      grantId: request.grant.grantId,
      grantGeneration: request.grant.generation,
      delegatorId: request.grant.delegatorId,
      consentVersion: request.grant.consentVersion,
      effectivePermissions,
      audience: 'authrim:admin-api',
      issuerOrigin: request.issuerOrigin,
      correlationId: request.correlationId,
    },
    idempotencyKey,
    input,
  };
}

/** Re-seal an admin catalog tool with changed contract fields. */
export function resealTool(
  tool: AgentToolDefinition,
  patch: Partial<AgentToolDefinition>
): AgentToolDefinition {
  const next: AgentToolDefinition = { ...tool, ...patch };
  return { ...next, schemaDigest: computeAgentToolContractDigest(next) };
}

export function customCatalog(
  transform: (tools: AgentToolDefinition[]) => AgentToolDefinition[],
  version = 'custom-catalog-v1'
): AgentToolCatalog {
  return createAgentToolCatalog(version, transform([...createAdminToolCatalog().list()]));
}

export function clientReadBody(resourceVersion = 'resource-v1', client: JsonObject = {}) {
  return {
    status: 200,
    body: {
      client: { client_id: 'client-target', client_name: 'Old', ...client },
      resource_version: resourceVersion,
    },
  };
}

export function loginReadBody(version = 'settings-v1', values: JsonObject = {}) {
  return { status: 200, body: { snapshot: { version, values } } };
}

export function confirmation(
  overrides: Partial<AgentPlanConfirmationRecord> = {}
): AgentPlanConfirmationRecord {
  return {
    id: 'apc-1',
    tenantId: 'tenant-1',
    planId: 'acp-1',
    planVersion: 1,
    planDigest: 'plan-digest',
    grantId: 'grant-1',
    actorSub: 'client:client-1',
    status: 'pending',
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

type Repo = AgentConfigurationRepository;

export function planHarness() {
  const repository = {
    listTaskSets: vi.fn<Repo['listTaskSets']>(),
    listScopePolicies: vi.fn<Repo['listScopePolicies']>(),
    createPlan: vi.fn<Repo['createPlan']>(),
    getPlan: vi.fn<Repo['getPlan']>(),
    markPlanReady: vi.fn<Repo['markPlanReady']>(),
    getPlanConfirmation: vi.fn<Repo['getPlanConfirmation']>(),
    ensurePlanConfirmation: vi.fn<Repo['ensurePlanConfirmation']>(),
    claimPlanApply: vi.fn<Repo['claimPlanApply']>(),
    completePlan: vi.fn<Repo['completePlan']>(),
    cancelPlan: vi.fn<Repo['cancelPlan']>(),
    failCancelledRunningPlan: vi.fn<Repo['failCancelledRunningPlan']>(),
    writeAudit: vi.fn<Repo['writeAudit']>(),
  };
  const managementApi = { execute: vi.fn<ManagementApiPort['execute']>() };
  const authorization = { authorize: vi.fn<AgentAuthorizationPort['authorize']>() };
  repository.listTaskSets.mockResolvedValue([]);
  repository.listScopePolicies.mockResolvedValue([]);
  repository.createPlan.mockResolvedValue(undefined);
  repository.getPlan.mockResolvedValue(planRecord());
  repository.markPlanReady.mockResolvedValue(true);
  repository.getPlanConfirmation.mockResolvedValue(null);
  repository.ensurePlanConfirmation.mockResolvedValue(confirmation());
  repository.claimPlanApply.mockResolvedValue(true);
  repository.completePlan.mockResolvedValue(true);
  repository.cancelPlan.mockResolvedValue(true);
  repository.failCancelledRunningPlan.mockResolvedValue(true);
  repository.writeAudit.mockResolvedValue(undefined);
  authorization.authorize.mockResolvedValue({ allowed: true, requiresElevation: false });
  managementApi.execute.mockImplementation(async (incoming: { operation: string }) => {
    if (incoming.operation === 'admin.read.clients.get') return clientReadBody();
    if (incoming.operation === 'admin.read.login-ui.inspect') return loginReadBody();
    return { status: 200, body: { ok: incoming.operation } };
  });
  const build = (
    options: {
      catalog?: AgentToolCatalog;
      schemaValidator?: AgentJsonSchemaValidatorPort;
      confirmationBasePath?: string;
      now?: () => number;
    } = {}
  ) =>
    new CloudflareAgentConfigurationPlanAdapter(
      repository as unknown as Repo,
      options.catalog ?? createAdminToolCatalog(),
      managementApi,
      { now: options.now ?? (() => NOW) },
      authorization,
      options.schemaValidator ?? { validate: () => ({ valid: true }) },
      options.confirmationBasePath
    );
  return { repository, managementApi, authorization, build };
}

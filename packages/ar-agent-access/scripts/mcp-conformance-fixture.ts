import {
  ADMIN_CONFIGURATION_PROMPTS,
  ADMIN_CONFIGURATION_RESOURCES,
  McpSdkJsonSchemaValidator,
  createAdminConfigurationResourceTemplates,
  createAdminToolCatalog,
  createAgentAccessMcpSdkServer,
  createAgentAccessMcpServer,
  type AgentAccessMcpRequestContext,
} from '../src/protocol/mcp';

export const inspectorFixtureContext = {
  actor: {
    mode: 'mode_b',
    sub: 'principal:inspector-fixture',
    assurance: 'machine_key',
    tokenBinding: 'dpop',
    clientId: 'inspector-client',
    machinePrincipalId: 'inspector-principal',
  },
  grant: {
    grantId: 'inspector-grant',
    tenantId: 'inspector-tenant',
    clientId: 'inspector-client',
    grantorId: 'inspector-admin',
    delegatorId: 'inspector-admin',
    permissions: ['admin:*'],
    scopes: ['agent:read', 'agent:write', 'agent:bulk'],
    resolvedScopeConstraints: { tenantIds: ['inspector-tenant'] },
    consentVersion: 1,
    generation: 1,
    status: 'active',
    delegationMode: 'admin_pre_authorized',
  },
  resource: { tenantId: 'inspector-tenant' },
  issuerOrigin: 'https://inspector.authrim.invalid',
  correlationId: 'inspector-correlation',
} satisfies AgentAccessMcpRequestContext;

const resources = createAdminConfigurationResourceTemplates({
  readTenantSummary: async () => ({ tenant_id: 'inspector-tenant', fixture: true }),
  readPlan: async (_subject, planId) => ({ plan_id: planId, fixture: true }),
});

export function createInspectorFixtureMcpServer() {
  const application = createAgentAccessMcpServer({
    toolCatalog: createAdminToolCatalog(),
    authorization: { authorize: async () => ({ allowed: true, requiresElevation: false }) },
    managementApi: {
      execute: async (request) =>
        request.operation === 'admin.read.agent-settings.get'
          ? { status: 200, body: { settings: { enabled: true, fixture: true } } }
          : { status: 501, body: { error: 'INSPECTOR_FIXTURE_OPERATION_NOT_IMPLEMENTED' } },
    },
    rateLimiter: { consume: async () => ({ allowed: true, remaining: 99, resetAt: 0 }) },
    settings: {
      get: async () => ({
        enabled: true,
        maxTokenTtlSeconds: 900,
        elevationMode: 'self_reauth',
        elevationTtlSeconds: 300,
        rateLimitPerMinute: 100,
        highRiskPermissionsAdditional: [],
        bulkCanaryProtected: false,
      }),
    },
    audit: { write: async () => undefined },
    clock: { now: () => 0 },
    schemaValidator: new McpSdkJsonSchemaValidator(),
    resources: ADMIN_CONFIGURATION_RESOURCES,
    resourceTemplates: resources,
    prompts: ADMIN_CONFIGURATION_PROMPTS,
  });

  return createAgentAccessMcpSdkServer(application, () => inspectorFixtureContext);
}

import { describe, expect, it, vi } from 'vitest';
import { createAgentToolCatalog, type AgentGrantContract } from '../../../core';
import {
  ADMIN_CONFIGURATION_PROMPTS,
  ADMIN_CONFIGURATION_RESOURCES,
  createAdminConfigurationResourceTemplates,
} from '../admin-configuration-context';
import { createAgentAccessMcpServer } from '../server';

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-2',
  permissions: ['admin:auth_config_plans:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 1,
  generation: 1,
  status: 'active',
  delegationMode: 'user_consent',
};

const context = {
  actor: {
    mode: 'mode_a' as const,
    sub: 'client:client-1',
    assurance: 'public_client_transaction' as const,
    tokenBinding: 'bearer' as const,
    clientId: 'client-1',
  },
  grant,
  resource: { tenantId: 'tenant-1' },
  issuerOrigin: 'https://tenant.example',
  correlationId: 'correlation-1',
};

describe('MCP Resource and Prompt authorization', () => {
  it('filters list responses and reauthorizes direct reads/gets', async () => {
    const resourceTemplates = createAdminConfigurationResourceTemplates({
      readTenantSummary: async (subject) => ({ tenant_id: subject.tenantId }),
      readPlan: async (_subject, planId) => (planId === 'plan-1' ? { plan_id: planId } : null),
    });
    const audit = vi.fn(async () => undefined);
    const server = createAgentAccessMcpServer({
      toolCatalog: createAgentToolCatalog('empty', []),
      authorization: {
        authorize: async ({ tool, grant: currentGrant, resource }) => ({
          allowed:
            currentGrant.resolvedScopeConstraints.tenantIds?.includes(resource.tenantId) === true &&
            tool.requiredPermissions.every((permission) =>
              currentGrant.permissions.includes(permission)
            ),
          requiresElevation: false,
        }),
      },
      managementApi: { execute: async () => ({ status: 500, body: {} }) },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write: audit },
      clock: { now: () => 1 },
      schemaValidator: { validate: () => ({ valid: true }) },
      resources: ADMIN_CONFIGURATION_RESOURCES,
      resourceTemplates,
      prompts: ADMIN_CONFIGURATION_PROMPTS,
    });

    await expect(server.listResources(context)).resolves.toHaveLength(2);
    await expect(server.listPrompts(context)).resolves.toHaveLength(4);
    await expect(server.listResourceTemplates(context)).resolves.toHaveLength(4);
    await expect(server.readResource(context, 'authrim://capabilities/v1')).resolves.toMatchObject({
      uri: 'authrim://capabilities/v1',
    });
    await expect(
      server.readResource(context, 'authrim://schemas/clients/v1')
    ).resolves.toMatchObject({ uri: 'authrim://schemas/clients/v1' });
    await expect(
      server.readResource(context, 'authrim://tenants/tenant-1/configuration-summary/v1')
    ).resolves.toMatchObject({ text: '{"tenant_id":"tenant-1"}' });
    await expect(server.readResource(context, 'authrim://plans/plan-1/v1')).resolves.toMatchObject({
      text: '{"plan_id":"plan-1"}',
    });
    await expect(
      server.getPrompt(context, 'diagnose_auth_configuration_v1', { goal: 'test' })
    ).resolves.toMatchObject({ messages: expect.any(Array) });
    await expect(
      server.readResource(context, 'authrim://tenants/tenant-2/configuration-summary/v1')
    ).rejects.toThrow('access denied');
    await expect(server.readResource(context, 'authrim://plans/plan-other/v1')).rejects.toThrow(
      'resource unavailable'
    );
    await expect(server.readResource(context, 'authrim://task-sets/v1')).rejects.toThrow(
      'access denied'
    );

    const deniedContext = { ...context, grant: { ...grant, permissions: [] } };
    await expect(server.listPrompts(deniedContext)).resolves.toEqual([]);
    await expect(
      server.getPrompt(deniedContext, 'diagnose_auth_configuration_v1', { goal: 'test' })
    ).rejects.toThrow('access denied');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'agent.mcp.resource.read', outcome: 'success' })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'agent.mcp.resource.denied', outcome: 'denied' })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'agent.mcp.prompt.get', outcome: 'success' })
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'agent.mcp.prompt.denied', outcome: 'denied' })
    );
  });
});

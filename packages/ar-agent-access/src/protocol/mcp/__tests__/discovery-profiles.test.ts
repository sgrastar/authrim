import { describe, expect, it, vi } from 'vitest';
import type { AgentGrantContract, AgentResolvedToolContract } from '../../../core';
import type { AgentDiscoveryProfileSelection } from '../../../platform/ports';
import { createAdminToolCatalog } from '../admin-tools';
import { McpSdkJsonSchemaValidator } from '../json-schema-validator';
import { createAgentAccessMcpServer, type AgentAccessMcpRequestContext } from '../server';

function pinned(tool: ReturnType<ReturnType<typeof createAdminToolCatalog>['list']>[number]) {
  return {
    toolId: tool.id,
    toolName: tool.name,
    contractVersion: tool.contractVersion,
    schemaDigest: tool.schemaDigest,
    permissions: [...tool.requiredPermissions],
    requiredScope: tool.requiredScope,
    riskLevel: tool.riskLevel,
    requiresElevation: tool.riskLevel === 'high',
  } satisfies AgentResolvedToolContract;
}

describe('MCP discovery profile control', () => {
  it('switches the visible Tool subset without changing the Grant ceiling', async () => {
    const catalog = createAdminToolCatalog();
    const grantedNames = [
      'set_active_tool_profiles',
      'list_clients',
      'inspect_authentication_flows',
    ];
    const grantedTools = grantedNames.map((name) => catalog.get(name)!);
    const grant: AgentGrantContract = {
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-1',
      permissions: [...new Set(grantedTools.flatMap((tool) => tool.requiredPermissions))],
      scopes: ['agent:read'],
      resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'task-set-1',
      taskSetVersion: 1,
      scopePolicyId: 'scope-policy-1',
      scopePolicyVersion: 1,
      resolvedTools: grantedTools.map(pinned),
      accessSnapshotHash: 'x'.repeat(43),
    };
    const context: AgentAccessMcpRequestContext = {
      actor: {
        mode: 'mode_a',
        sub: 'client:client-1',
        assurance: 'public_client_transaction',
        tokenBinding: 'bearer',
        clientId: 'client-1',
      },
      grant,
      resource: { tenantId: 'tenant-1' },
      issuerOrigin: 'https://tenant-1.authrim.example',
      correlationId: 'correlation-1',
    };
    let selection: AgentDiscoveryProfileSelection | null = null;
    let discoveryReadFails = false;
    let controlAuthorized = true;
    const managementExecute = vi.fn(async () => ({ status: 200, body: {} }));
    const audit = vi.fn(async () => undefined);
    const server = createAgentAccessMcpServer({
      toolCatalog: catalog,
      authorization: {
        authorize: async ({ tool }) => ({
          allowed:
            grantedTools.some((grantedTool) => grantedTool.id === tool.id) &&
            (tool.name !== 'set_active_tool_profiles' || controlAuthorized),
          requiresElevation: false,
        }),
      },
      managementApi: { execute: managementExecute },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 10, resetAt: 60 }) },
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
      clock: { now: () => 100 },
      schemaValidator: new McpSdkJsonSchemaValidator(),
      discoveryProfiles: {
        get: async () => {
          if (discoveryReadFails) throw new Error('profile store unavailable');
          return selection;
        },
        put: async (next) => {
          selection = next;
        },
      },
    });

    await expect(server.listTools(context)).resolves.toMatchObject([
      { name: 'set_active_tool_profiles' },
      { name: 'list_clients' },
    ]);
    await expect(
      server.callTool(context, 'inspect_authentication_flows', {})
    ).resolves.toMatchObject({ isError: true });

    await expect(
      server.callTool(context, 'set_active_tool_profiles', {
        profile_ids: ['essential', 'all_granted'],
      })
    ).resolves.toMatchObject({ isError: true });
    expect(selection).toBeNull();

    await expect(
      server.callTool(context, 'set_active_tool_profiles', {
        profile_ids: ['flows_consent'],
      })
    ).resolves.toMatchObject({
      structuredContent: { selected_profile_ids: ['flows_consent'], visible_tool_count: 2 },
      toolListChanged: true,
    });
    await expect(server.listTools(context)).resolves.toMatchObject([
      { name: 'set_active_tool_profiles' },
      { name: 'inspect_authentication_flows' },
    ]);
    await expect(
      server.callTool(context, 'set_active_tool_profiles', {
        profile_ids: ['user_data'],
      })
    ).resolves.toMatchObject({ isError: true });
    expect(selection?.profileIds).toEqual(['flows_consent']);
    expect(managementExecute).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'agent.mcp.discovery_profile.changed' })
    );

    selection = { profileIds: ['removed_profile'], updatedAt: 200 };
    await expect(server.listTools(context)).resolves.toMatchObject([
      { name: 'set_active_tool_profiles' },
      { name: 'list_clients' },
    ]);
    expect(selection.profileIds).toEqual(['essential']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.discovery_profile.reset',
        outcome: 'success',
      })
    );

    selection = { profileIds: ['flows_consent'], updatedAt: 300 };
    discoveryReadFails = true;
    await expect(server.listTools(context)).resolves.toMatchObject([
      { name: 'set_active_tool_profiles' },
      { name: 'list_clients' },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.mcp.discovery_profile.reset',
        outcome: 'failed',
      })
    );

    discoveryReadFails = false;
    selection = null;
    controlAuthorized = false;
    await expect(server.listTools(context)).resolves.toMatchObject([{ name: 'list_clients' }]);
  });
});

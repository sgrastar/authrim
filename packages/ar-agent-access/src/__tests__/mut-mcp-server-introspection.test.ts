import { describe, expect, it } from 'vitest';
import type { AgentAuthorizationDecision, AgentToolDefinitionSource } from '../core';
import {
  ALLOW,
  ELEVATE,
  LOW_TOOL,
  createHarness,
  makeCatalog,
  makeContext,
  pinnedTool,
} from './helpers/mut-mcp-harness';

const explain: AgentToolDefinitionSource = {
  ...LOW_TOOL,
  id: 'admin.read.agent-access.explain',
  name: 'explain_agent_access',
  title: 'Explain',
  requiredPermissions: ['agent:use'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { include_denied: { type: 'boolean' } },
  },
  executionTarget: 'access_introspection',
};
const tool = (id: string, extra: Partial<AgentToolDefinitionSource> = {}) => ({
  ...LOW_TOOL,
  id,
  name: id.replace(/\./gu, '_'),
  title: id,
  ...extra,
});
const catalog = makeCatalog([
  explain,
  tool('t.allowed', { requiredScope: 'agent:write', riskLevel: 'standard' }),
  tool('t.elevate', { riskLevel: 'high', requiredPermissions: ['admin:users:suspend'] }),
  tool('t.elevate_default'),
  tool('t.scope'),
  tool('t.scope2'),
  tool('t.unknown'),
  tool('t.unpinned'),
]);
const decisions: Record<string, AgentAuthorizationDecision> = {
  'admin.read.agent-access.explain': ALLOW,
  't.allowed': ALLOW,
  't.elevate': ELEVATE,
  't.elevate_default': { allowed: false, requiresElevation: true },
  't.scope': { allowed: false, requiresElevation: false, deniedAxis: 'scope', code: 'C1' },
  't.scope2': { allowed: false, requiresElevation: false, deniedAxis: 'scope', code: 'C2' },
  't.unknown': { allowed: false, requiresElevation: false },
  't.unpinned': ALLOW,
};
const grantOverrides = {
  machinePrincipalId: 'mp-1',
  expiresAt: 5000,
  taskSetId: 'ts',
  taskSetVersion: 3,
  scopePolicyId: 'sp',
  scopePolicyVersion: 2,
  resolvedTools: catalog
    .list()
    .filter((item) => item.id !== 't.unpinned')
    .map(pinnedTool),
};
const summary = (id: string) => {
  const item = catalog.list().find((candidate) => candidate.id === id)!;
  return {
    id: item.id,
    name: item.name,
    required_scope: item.requiredScope,
    required_permissions: [...item.requiredPermissions],
    risk_level: item.riskLevel,
  };
};

function harness() {
  return createHarness({
    catalog,
    authorize: async ({ tool: candidate }) => decisions[candidate.id] ?? ALLOW,
  });
}

describe('access introspection tool', () => {
  it('evaluates every catalog tool live and reports the current subject', async () => {
    const h = harness();
    const result = await h.server.callTool(
      makeContext({ grant: grantOverrides }),
      'explain_agent_access',
      { include_denied: true }
    );

    const body = {
      subject: {
        current_agent_only: true,
        tenant_id: 'tenant-1',
        grant_id: 'grant-1',
        client_id: 'client-1',
        machine_principal_id: 'mp-1',
        actor_mode: 'mode_a',
        actor_assurance: 'public_client_transaction',
        token_binding: 'bearer',
        grant_status: 'active',
        expires_at: 5000,
        scopes: ['agent:read'],
        permissions: ['admin:users:read'],
        task_set: { id: 'ts', version: 3 },
        scope_policy: { id: 'sp', version: 2 },
      },
      summary: {
        authority_source: 'live_agent_grant_evaluation',
        oauth_client_scope_is_not_effective_authority: true,
        catalog_tool_count: 8,
        configured_tool_count: 7,
        allowed_tool_count: 2,
        elevation_required_tool_count: 2,
        denied_tool_count: 4,
      },
      allowed_tools: [summary('admin.read.agent-access.explain'), summary('t.allowed')],
      elevation_required_tools: [
        { ...summary('t.elevate'), denied_axis: 'risk', code: 'AGENT_ELEVATION_REQUIRED' },
        { ...summary('t.elevate_default'), denied_axis: 'risk', code: 'AGENT_ELEVATION_REQUIRED' },
      ],
      denied_by_axis: { scope: 2, unknown: 1, grant: 1 },
      denied_tools: [
        { ...summary('t.scope'), denied_axis: 'scope', code: 'C1' },
        { ...summary('t.scope2'), denied_axis: 'scope', code: 'C2' },
        { ...summary('t.unknown'), denied_axis: 'unknown', code: 'AGENT_ACCESS_DENIED' },
        { ...summary('t.unpinned'), denied_axis: 'grant', code: 'AGENT_TOOL_NOT_IN_TASK_SET' },
      ],
    };
    expect(result).toStrictEqual({
      structuredContent: body,
      content: [{ type: 'text', text: JSON.stringify(body) }],
    });
    // The unpinned tool is denied from the grant pin, never by asking the authorization port.
    const asked = h.authorize.mock.calls.map((call) => call[0].tool.id);
    expect(asked).not.toContain('t.unpinned');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.executed',
      outcome: 'success',
      details: {
        tool_id: 'admin.read.agent-access.explain',
        include_denied: true,
        allowed_tool_count: 2,
        elevation_required_tool_count: 2,
        denied_tool_count: 4,
      },
    });
  });

  it('hides denied tool details unless include_denied is exactly true', async () => {
    const h = harness();
    const result = await h.server.callTool(makeContext(), 'explain_agent_access', {});
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.denied_tools).toEqual([]);
    expect(body.subject).toMatchObject({
      machine_principal_id: null,
      expires_at: null,
      task_set: { id: null, version: null },
      scope_policy: { id: null, version: null },
    });
    expect(body.summary).toMatchObject({ configured_tool_count: 0, denied_tool_count: 8 });
    expect(body.denied_by_axis).toEqual({ grant: 8 });
    expect(h.lastEvent()?.details).toMatchObject({ include_denied: false });
  });
});

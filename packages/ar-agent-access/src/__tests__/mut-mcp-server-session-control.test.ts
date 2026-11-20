import { describe, expect, it } from 'vitest';
import {
  AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
  createAgentToolCatalog,
  sealAgentToolDefinition,
  type AgentToolDefinition,
} from '../core';
import { createAdminToolCatalog } from '../protocol/mcp/admin-tools';
import {
  ALLOW,
  createHarness,
  makeContext,
  memoryProfileStore,
  pinnedTool,
} from './helpers/mut-mcp-harness';

const admin = createAdminToolCatalog();
const control = admin.get('set_active_tool_profiles')!;
const listClients = admin.get('list_clients')!;
const flows = admin.get('inspect_authentication_flows')!;
// Same control-tool ID with a permissive schema so the server-side selection checks are reachable.
const laxControl: AgentToolDefinition = sealAgentToolDefinition({
  ...control,
  name: 'set_profiles_lax',
  inputSchema: { type: 'object' },
  outputSchema: undefined,
});
const catalog = createAgentToolCatalog('cat-1', [laxControl, listClients, flows]);
const grant = { resolvedTools: [laxControl, listClients, flows].map(pinnedTool) };
const granted = new Set([laxControl.id, listClients.id, flows.id]);

function harness(store = memoryProfileStore()) {
  const h = createHarness({
    catalog,
    authorize: async ({ tool }) =>
      granted.has(tool.id) ? ALLOW : { allowed: false, requiresElevation: false },
    discoveryProfiles: store.store,
  });
  return { ...h, store };
}

const denialDetails = (code: string, axis: string, requested: unknown[]) => ({
  tool_id: AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
  denied_axis: axis,
  code,
  requested_profile_ids: requested,
});

describe('session discovery profile control tool', () => {
  it('fails closed when the deployment has no discovery profile store', async () => {
    const h = createHarness({ catalog });
    const result = await h.server.callTool(makeContext({ grant }), 'set_profiles_lax', {
      profile_ids: ['essential'],
    });
    expect(result).toStrictEqual({
      content: [
        {
          type: 'text',
          text: 'AGENT_DISCOVERY_PROFILE_STATE_UNAVAILABLE: Discovery profile state unavailable',
        },
      ],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.failed',
      outcome: 'failed',
      details: { tool_id: control.id, code: 'AGENT_DISCOVERY_PROFILE_STATE_UNAVAILABLE' },
    });
  });

  it('persists the selection and returns the visible subset with a list-changed signal', async () => {
    const h = harness();
    const result = await h.server.callTool(makeContext({ grant }), 'set_profiles_lax', {
      profile_ids: ['flows_consent', 7, 'flows_consent'],
    });
    const body = {
      selected_profile_ids: ['flows_consent'],
      visible_tool_count: 2,
      available_profiles: [
        {
          id: 'essential',
          title: 'Essential operations',
          description:
            'Client inventory, Agent delegations, audit, Agent settings, and runtime diagnostics.',
          granted_tool_count: 1,
        },
        {
          id: 'flows_consent',
          title: 'Flows and consent',
          description: 'Authentication flows, consent policies, and configuration validation.',
          granted_tool_count: 1,
        },
        {
          id: 'all_granted',
          title: 'All granted tools',
          description:
            'Expose every tool already authorized by this Grant. This never expands the Grant.',
          granted_tool_count: 2,
        },
      ],
    };
    expect(result).toStrictEqual({
      structuredContent: body,
      content: [{ type: 'text', text: JSON.stringify(body) }],
      toolListChanged: true,
    });
    expect(h.store.state.selection).toStrictEqual({
      profileIds: ['flows_consent'],
      updatedAt: 1234,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.discovery_profile.changed',
      outcome: 'success',
      details: {
        tool_id: control.id,
        selected_profile_ids: ['flows_consent'],
        visible_tool_count: 2,
      },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('treats a non-array selection as the default essential profile', async () => {
    const h = harness();
    const result = await h.server.callTool(makeContext({ grant }), 'set_profiles_lax', {
      profile_ids: 'flows_consent',
    });
    expect(result.structuredContent).toMatchObject({ selected_profile_ids: ['essential'] });
    expect(h.store.state.selection?.profileIds).toEqual(['essential']);
  });

  it('rejects an unknown profile as an invalid selection without persisting', async () => {
    const h = harness();
    const result = await h.server.callTool(makeContext({ grant }), 'set_profiles_lax', {
      profile_ids: ['bogus'],
    });
    expect(result).toStrictEqual({
      content: [
        {
          type: 'text',
          text: 'AGENT_DISCOVERY_PROFILE_INVALID_SELECTION: Invalid discovery profile selection',
        },
      ],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: denialDetails('AGENT_DISCOVERY_PROFILE_INVALID_SELECTION', 'discovery_profile', [
        'bogus',
      ]),
    });
    expect(h.store.store.put).not.toHaveBeenCalled();
  });

  it('rejects a selection when any requested profile has no granted tools', async () => {
    const h = harness();
    const result = await h.server.callTool(makeContext({ grant }), 'set_profiles_lax', {
      profile_ids: ['flows_consent', 'user_data'],
    });
    expect(result).toStrictEqual({
      content: [
        {
          type: 'text',
          text: 'AGENT_DISCOVERY_PROFILE_NOT_GRANTED: One or more discovery profiles contain no granted tools',
        },
      ],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: denialDetails('AGENT_DISCOVERY_PROFILE_NOT_GRANTED', 'grant', [
        'flows_consent',
        'user_data',
      ]),
    });
    expect(h.store.store.put).not.toHaveBeenCalled();
  });

  it('reports state unavailable when the selection cannot be persisted', async () => {
    const store = memoryProfileStore();
    store.store.put.mockRejectedValueOnce(new Error('storage down'));
    const h = harness(store);
    const result = await h.server.callTool(makeContext({ grant }), 'set_profiles_lax', {
      profile_ids: ['flows_consent'],
    });
    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: 'AGENT_DISCOVERY_PROFILE_STATE_UNAVAILABLE: Discovery profile state unavailable',
        },
      ],
      isError: true,
    });
    expect(result.toolListChanged).toBeUndefined();
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.failed',
      outcome: 'failed',
      details: { tool_id: control.id, code: 'AGENT_DISCOVERY_PROFILE_STATE_UNAVAILABLE' },
    });
  });

  it('only counts tools the live authorization still allows', async () => {
    const h = createHarness({
      catalog,
      authorize: async ({ tool }) =>
        tool.id === flows.id ? { allowed: false, requiresElevation: false } : ALLOW,
      discoveryProfiles: memoryProfileStore().store,
    });
    const result = await h.server.callTool(makeContext({ grant }), 'set_profiles_lax', {
      profile_ids: ['flows_consent'],
    });
    expect(result.content[0]?.text).toMatch(/^AGENT_DISCOVERY_PROFILE_NOT_GRANTED/u);
  });
});

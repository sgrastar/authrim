import { describe, expect, it } from 'vitest';
import { createAgentToolCatalog } from '../core';
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
const fullCatalog = createAgentToolCatalog('cat-1', [control, listClients, flows]);
const allPinned = { resolvedTools: [control, listClients, flows].map(pinnedTool) };
const names = (tools: readonly { name: string }[]) => tools.map((tool) => tool.name);

describe('discovery profile filtering of tools/list and tools/call', () => {
  it('does not filter when no discovery profile store is configured', async () => {
    const h = createHarness({ catalog: fullCatalog });
    const context = makeContext({ grant: allPinned });
    expect(names(await h.server.listTools(context))).toEqual([
      'set_active_tool_profiles',
      'list_clients',
      'inspect_authentication_flows',
    ]);
    await h.server.callTool(context, 'inspect_authentication_flows', {});
    expect(h.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: flows.id }));
  });

  it('does not filter when the catalog has no profile control tool', async () => {
    const catalog = createAgentToolCatalog('cat-2', [listClients, flows]);
    const h = createHarness({ catalog, discoveryProfiles: memoryProfileStore().store });
    const context = makeContext({ grant: { resolvedTools: [listClients, flows].map(pinnedTool) } });
    expect(names(await h.server.listTools(context))).toEqual([
      'list_clients',
      'inspect_authentication_flows',
    ]);
  });

  it('does not filter when the grant did not pin the profile control tool', async () => {
    const h = createHarness({
      catalog: fullCatalog,
      discoveryProfiles: memoryProfileStore().store,
    });
    const context = makeContext({ grant: { resolvedTools: [listClients, flows].map(pinnedTool) } });
    expect(names(await h.server.listTools(context))).toEqual([
      'set_active_tool_profiles',
      'list_clients',
      'inspect_authentication_flows',
    ]);
  });

  it('denies calls outside the active profile with an audited profile code', async () => {
    const h = createHarness({
      catalog: fullCatalog,
      discoveryProfiles: memoryProfileStore().store,
    });
    const result = await h.server.callTool(
      makeContext({ grant: allPinned }),
      'inspect_authentication_flows',
      {}
    );
    expect(result).toStrictEqual({
      content: [
        {
          type: 'text',
          text: 'AGENT_TOOL_PROFILE_INACTIVE: Tool is outside the active discovery profiles. Use set_active_tool_profiles first.',
        },
      ],
      isError: true,
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.tool.denied',
      outcome: 'denied',
      details: {
        tool_id: flows.id,
        denied_axis: 'discovery_profile',
        code: 'AGENT_TOOL_PROFILE_INACTIVE',
      },
    });
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('honours a stored selection for both listing and calling', async () => {
    const store = memoryProfileStore({ profileIds: ['flows_consent'], updatedAt: 1 });
    const h = createHarness({ catalog: fullCatalog, discoveryProfiles: store.store });
    const context = makeContext({ grant: allPinned });
    expect(names(await h.server.listTools(context))).toEqual([
      'set_active_tool_profiles',
      'inspect_authentication_flows',
    ]);
    await h.server.callTool(context, 'inspect_authentication_flows', {});
    expect(h.execute).toHaveBeenCalledWith(expect.objectContaining({ operation: flows.id }));
    expect(h.events.some((event) => event.eventType.includes('discovery_profile.reset'))).toBe(
      false
    );
  });

  it('falls back to essential and audits a read failure without persisting', async () => {
    const store = memoryProfileStore({ profileIds: ['flows_consent'], updatedAt: 1 });
    store.store.get.mockRejectedValue(new Error('read failed'));
    const h = createHarness({ catalog: fullCatalog, discoveryProfiles: store.store });
    expect(names(await h.server.listTools(makeContext({ grant: allPinned })))).toEqual([
      'set_active_tool_profiles',
      'list_clients',
    ]);
    expect(store.store.put).not.toHaveBeenCalled();
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.discovery_profile.reset',
      outcome: 'failed',
      details: { reason: 'state_read_failed', selected_profile_ids: ['essential'] },
    });
  });

  it('keeps the fallback when even recovery telemetry fails', async () => {
    const store = memoryProfileStore({ profileIds: ['removed'], updatedAt: 1 });
    const h = createHarness({
      catalog: fullCatalog,
      discoveryProfiles: store.store,
      auditFails: (event) => event.eventType === 'agent.mcp.discovery_profile.reset',
    });
    expect(names(await h.server.listTools(makeContext({ grant: allPinned })))).toEqual([
      'set_active_tool_profiles',
      'list_clients',
    ]);
    store.store.get.mockRejectedValue(new Error('read failed'));
    expect(names(await h.server.listTools(makeContext({ grant: allPinned })))).toEqual([
      'set_active_tool_profiles',
      'list_clients',
    ]);
  });

  it('repairs an invalid persisted selection and audits whether the repair persisted', async () => {
    const store = memoryProfileStore({ profileIds: ['removed'], updatedAt: 1 });
    const h = createHarness({ catalog: fullCatalog, discoveryProfiles: store.store });
    await h.server.listTools(makeContext({ grant: allPinned }));
    expect(store.state.selection).toStrictEqual({ profileIds: ['essential'], updatedAt: 1234 });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.discovery_profile.reset',
      outcome: 'success',
      details: {
        reason: 'invalid_persisted_selection',
        selected_profile_ids: ['essential'],
        reset_persisted: true,
      },
    });

    store.state.selection = { profileIds: ['removed'], updatedAt: 2 };
    store.store.put.mockRejectedValueOnce(new Error('write failed'));
    expect(names(await h.server.listTools(makeContext({ grant: allPinned })))).toEqual([
      'set_active_tool_profiles',
      'list_clients',
    ]);
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.discovery_profile.reset',
      outcome: 'failed',
      details: { reason: 'invalid_persisted_selection', reset_persisted: false },
    });
  });

  it('keeps the control tool callable regardless of the active profile', async () => {
    const store = memoryProfileStore({ profileIds: ['flows_consent'], updatedAt: 1 });
    const h = createHarness({
      catalog: fullCatalog,
      discoveryProfiles: store.store,
      authorize: async () => ALLOW,
    });
    const result = await h.server.callTool(
      makeContext({ grant: allPinned }),
      'set_active_tool_profiles',
      { profile_ids: ['essential'] }
    );
    expect(result.isError).toBeUndefined();
    expect(store.state.selection?.profileIds).toEqual(['essential']);
  });
});

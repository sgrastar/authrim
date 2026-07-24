import { describe, expect, it } from 'vitest';
import {
  AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
  resolveAgentDiscoveryProfiles,
} from '../discovery-profiles';

const granted = [
  AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
  'admin.read.clients.list',
  'admin.read.flows.inspect',
  'admin.read.users.search',
];

describe('Agent discovery profiles', () => {
  it('defaults to essential Tools and always keeps the session control Tool visible', () => {
    const resolved = resolveAgentDiscoveryProfiles({ grantedToolIds: granted });

    expect(resolved.selectedProfileIds).toEqual(['essential']);
    expect([...resolved.visibleToolIds].sort()).toEqual(
      [AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID, 'admin.read.clients.list'].sort()
    );
  });

  it('combines profiles only within the already-granted Tool ceiling', () => {
    const resolved = resolveAgentDiscoveryProfiles({
      grantedToolIds: granted,
      selectedProfileIds: ['flows_consent', 'user_data'],
    });

    expect([...resolved.visibleToolIds].sort()).toEqual(
      [
        AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
        'admin.read.flows.inspect',
        'admin.read.users.search',
      ].sort()
    );
    expect(resolved.visibleToolIds.has('admin.read.users.get')).toBe(false);
  });

  it('restores all granted Tools without adding ungranted catalog entries', () => {
    const resolved = resolveAgentDiscoveryProfiles({
      grantedToolIds: granted,
      selectedProfileIds: ['all_granted'],
    });

    expect([...resolved.visibleToolIds].sort()).toEqual([...granted].sort());
  });

  it('rejects unknown profiles instead of silently widening discovery', () => {
    expect(() =>
      resolveAgentDiscoveryProfiles({
        grantedToolIds: granted,
        selectedProfileIds: ['unknown'],
      })
    ).toThrow('Unknown Agent discovery profile');
  });

  it('keeps only the control Tool when no essential Tool is granted', () => {
    const resolved = resolveAgentDiscoveryProfiles({
      grantedToolIds: [AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID, 'admin.write.users.suspend'],
    });

    expect(resolved.selectedProfileIds).toEqual(['essential']);
    expect([...resolved.visibleToolIds]).toEqual([AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID]);
  });

  it('requires all_granted to be selected by itself', () => {
    expect(() =>
      resolveAgentDiscoveryProfiles({
        grantedToolIds: granted,
        selectedProfileIds: ['essential', 'all_granted'],
      })
    ).toThrow('all_granted must be selected by itself');
  });
});

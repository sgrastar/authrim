import { describe, expect, it } from 'vitest';
import {
  AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
  BUILTIN_AGENT_DISCOVERY_PROFILES,
  resolveAgentDiscoveryProfiles,
} from '../core/discovery-profiles';
import {
  AGENT_ACCESS_SETTING_KEYS as K,
  AGENT_ACCESS_SETTINGS_DEFAULTS,
  parseAgentAccessSettings,
} from '../core/settings';

describe('parseAgentAccessSettings', () => {
  const defaults = {
    enabled: false,
    maxTokenTtlSeconds: 900,
    elevationMode: 'self_reauth',
    elevationTtlSeconds: 300,
    requestRateLimitPerMinute: 600,
    sessionInitializationRateLimitPerMinute: 30,
    maxConcurrentSessions: 20,
    rateLimitPerMinute: 120,
    publicClientStandardRateLimitPerMinute: 10,
    highRiskPermissionsAdditional: [],
    publicClientStandardToolIds: [],
    bulkCanaryProtected: false,
  };

  it('falls back to conservative defaults', () => {
    expect(AGENT_ACCESS_SETTINGS_DEFAULTS).toEqual(defaults);
    for (const value of [null, undefined, 'x', ['agent.mcp.enabled'], {}]) {
      expect(parseAgentAccessSettings(value)).toEqual(defaults);
    }
  });

  it('uses the persisted setting keys', () => {
    expect(K).toMatchObject({
      bulkCanaryProtected: 'agent.bulk.canary_protected',
      version: 'agent.mcp.settings_version',
      updatedAt: 'agent.mcp.settings_updated_at',
      updatedBy: 'agent.mcp.settings_updated_by',
    });
  });

  it('reads valid values', () => {
    expect(
      parseAgentAccessSettings({
        [K.enabled]: true,
        [K.elevationMode]: 'approval',
        [K.bulkCanaryProtected]: true,
      })
    ).toMatchObject({ enabled: true, elevationMode: 'approval', bulkCanaryProtected: true });
    expect(parseAgentAccessSettings({ [K.elevationMode]: 'both' }).elevationMode).toBe('both');
    expect(parseAgentAccessSettings({ [K.elevationMode]: 'self_reauth' }).elevationMode).toBe(
      'self_reauth'
    );
    expect(
      parseAgentAccessSettings({
        [K.elevationMode]: 'none',
        [K.enabled]: 'true',
        [K.bulkCanaryProtected]: 1,
      })
    ).toMatchObject({
      elevationMode: 'self_reauth',
      enabled: false,
      bulkCanaryProtected: false,
    });
  });

  it.each([
    ['maxTokenTtlSeconds', 60, 900],
    ['elevationTtlSeconds', 60, 300],
    ['requestRateLimitPerMinute', 10, 10_000],
    ['sessionInitializationRateLimitPerMinute', 1, 1_000],
    ['maxConcurrentSessions', 1, 1_000],
    ['rateLimitPerMinute', 1, 1_000],
    ['publicClientStandardRateLimitPerMinute', 1, 60],
  ] as const)('bounds %s to [%i, %i] inclusively', (field, min, max) => {
    const parse = (v: unknown) => parseAgentAccessSettings({ [K[field]]: v })[field];
    const fallback = AGENT_ACCESS_SETTINGS_DEFAULTS[field];
    expect(parse(min)).toBe(min);
    expect(parse(max)).toBe(max);
    expect(parse(min - 1)).toBe(fallback);
    expect(parse(max + 1)).toBe(fallback);
    expect(parse(min + 0.5)).toBe(fallback);
    expect(parse(String(min))).toBe(fallback);
  });

  it.each([['highRiskPermissionsAdditional'], ['publicClientStandardToolIds']] as const)(
    'sanitises the %s list',
    (field) => {
      const parse = (v: unknown) => parseAgentAccessSettings({ [K[field]]: v })[field];
      expect(parse(['a', 'a', '', 7, null, 'x'.repeat(256), 'y'.repeat(257), 'b'])).toEqual([
        'a',
        'x'.repeat(256),
        'b',
      ]);
      expect(parse('a')).toEqual([]);
      const many = Array.from({ length: 300 }, (_, i) => `p${i}`);
      expect(parse(many)).toEqual(many.slice(0, 256));
    }
  );
});

describe('resolveAgentDiscoveryProfiles', () => {
  const granted = [
    'admin.read.clients.list',
    'admin.read.users.search',
    AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
  ];

  it('gives every built-in profile a title and description', () => {
    for (const profile of BUILTIN_AGENT_DISCOVERY_PROFILES) {
      expect(profile.title.length).toBeGreaterThan(0);
      expect(profile.description.length).toBeGreaterThan(0);
    }
  });

  it('lists only profiles with granted tools, excluding the control tool from all_granted', () => {
    const result = resolveAgentDiscoveryProfiles({ grantedToolIds: granted });
    expect(result.availableProfiles.map((p) => [p.id, p.grantedToolCount])).toEqual([
      ['essential', 1],
      ['user_data', 1],
      ['all_granted', 2],
    ]);
    expect(
      resolveAgentDiscoveryProfiles({ grantedToolIds: [AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID] })
        .availableProfiles
    ).toEqual([]);
    const essential = result.availableProfiles[0];
    const def = BUILTIN_AGENT_DISCOVERY_PROFILES[0];
    expect(essential).toEqual({
      id: def.id,
      title: def.title,
      description: def.description,
      grantedToolCount: 1,
    });
  });

  it('defaults to the essential profile and always exposes a granted control tool', () => {
    const result = resolveAgentDiscoveryProfiles({ grantedToolIds: granted });
    expect(result.selectedProfileIds).toEqual(['essential']);
    expect([...result.visibleToolIds].sort()).toEqual(
      ['admin.read.clients.list', AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID].sort()
    );
  });

  it('does not expose an ungranted control tool', () => {
    const result = resolveAgentDiscoveryProfiles({ grantedToolIds: ['admin.read.clients.list'] });
    expect([...result.visibleToolIds]).toEqual(['admin.read.clients.list']);
  });

  it('exposes every granted tool for all_granted', () => {
    const result = resolveAgentDiscoveryProfiles({
      grantedToolIds: granted,
      selectedProfileIds: ['all_granted'],
    });
    expect([...result.visibleToolIds].sort()).toEqual([...granted].sort());
  });

  it('unions selected profiles restricted to granted tools', () => {
    const result = resolveAgentDiscoveryProfiles({
      grantedToolIds: ['admin.read.users.get', 'admin.read.webhooks.inspect'],
      selectedProfileIds: ['user_data', 'integrations_ui', 'user_data'],
    });
    expect(result.selectedProfileIds).toEqual(['user_data', 'integrations_ui']);
    expect([...result.visibleToolIds]).toEqual([
      'admin.read.users.get',
      'admin.read.webhooks.inspect',
    ]);
  });

  it('rejects too many, unknown, or combined all_granted selections', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `p${i}`);
    expect(() =>
      resolveAgentDiscoveryProfiles({ grantedToolIds: [], selectedProfileIds: twelve })
    ).toThrow('Too many Agent discovery profiles selected');
    expect(() =>
      resolveAgentDiscoveryProfiles({
        grantedToolIds: [],
        selectedProfileIds: BUILTIN_AGENT_DISCOVERY_PROFILES.map((p) => p.id),
      })
    ).toThrow('all_granted must be selected by itself');
    expect(() =>
      resolveAgentDiscoveryProfiles({ grantedToolIds: [], selectedProfileIds: ['nope'] })
    ).toThrow('Unknown Agent discovery profile: nope');
  });
});

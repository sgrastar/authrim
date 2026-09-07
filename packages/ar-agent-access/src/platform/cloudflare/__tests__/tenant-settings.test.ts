import { describe, expect, it } from 'vitest';
import { CloudflareAgentSettingsProvider } from '../tenant-settings';

describe('CloudflareAgentSettingsProvider', () => {
  it('loads the dedicated tenant category and returns live rate-limit policy', async () => {
    const provider = new CloudflareAgentSettingsProvider({
      SETTINGS: {
        get: async () =>
          JSON.stringify({
            'agent.mcp.enabled': true,
            'agent.mcp.rate_limit_per_minute': 17,
          }),
      },
    });
    await expect(provider.get('tenant-1')).resolves.toMatchObject({
      enabled: true,
      rateLimitPerMinute: 17,
    });
  });

  it('fails closed when configured tenant settings are malformed', async () => {
    const provider = new CloudflareAgentSettingsProvider({
      SETTINGS: { get: async () => '{invalid' },
      ENABLE_AGENT_MCP: 'true',
    });
    await expect(provider.get('tenant-1')).rejects.toThrow();
  });

  it('uses the environment value only when no tenant setting exists', async () => {
    const provider = new CloudflareAgentSettingsProvider({
      SETTINGS: { get: async () => null },
      ENABLE_AGENT_MCP: 'true',
    });
    await expect(provider.get('tenant-1')).resolves.toMatchObject({ enabled: true });
  });
});

import { describe, expect, it } from 'vitest';
import { AGENT_ACCESS_SETTINGS_DEFAULTS, parseAgentAccessSettings } from '../settings';

describe('Agent Access settings', () => {
  it('uses conservative defaults for missing or malformed stored values', () => {
    expect(parseAgentAccessSettings(null)).toEqual(AGENT_ACCESS_SETTINGS_DEFAULTS);
    expect(
      parseAgentAccessSettings({
        'agent.mcp.enabled': 'true',
        'agent.mcp.max_token_ttl_seconds': 901,
        'agent.mcp.elevation_mode': 'disabled',
      })
    ).toEqual(AGENT_ACCESS_SETTINGS_DEFAULTS);
  });

  it('parses the tenant settings representation and de-duplicates additions', () => {
    expect(
      parseAgentAccessSettings({
        'agent.mcp.enabled': true,
        'agent.mcp.max_token_ttl_seconds': 600,
        'agent.mcp.elevation_mode': 'both',
        'agent.mcp.elevation_ttl_seconds': 120,
        'agent.mcp.request_rate_limit_per_minute': 500,
        'agent.mcp.session_initialization_rate_limit_per_minute': 25,
        'agent.mcp.max_concurrent_sessions': 15,
        'agent.mcp.rate_limit_per_minute': 30,
        'agent.mcp.public_client_standard_rate_limit_per_minute': 5,
        'agent.mcp.high_risk_permissions_additional': [
          'admin:clients:write',
          'admin:clients:write',
        ],
        'agent.mcp.public_client_standard_tool_ids': [
          'admin.write.clients.metadata',
          'admin.write.clients.metadata',
        ],
      })
    ).toEqual({
      enabled: true,
      maxTokenTtlSeconds: 600,
      elevationMode: 'both',
      elevationTtlSeconds: 120,
      requestRateLimitPerMinute: 500,
      sessionInitializationRateLimitPerMinute: 25,
      maxConcurrentSessions: 15,
      rateLimitPerMinute: 30,
      publicClientStandardRateLimitPerMinute: 5,
      highRiskPermissionsAdditional: ['admin:clients:write'],
      publicClientStandardToolIds: ['admin.write.clients.metadata'],
      bulkCanaryProtected: false,
    });
  });
});

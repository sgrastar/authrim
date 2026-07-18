export type AgentElevationMode = 'self_reauth' | 'approval' | 'both';

export interface AgentAccessSettings {
  enabled: boolean;
  maxTokenTtlSeconds: number;
  elevationMode: AgentElevationMode;
  elevationTtlSeconds: number;
  rateLimitPerMinute: number;
  /** Stricter per-Tool limit used only for opted-in standard-risk public Mode A calls. */
  publicClientStandardRateLimitPerMinute: number;
  highRiskPermissionsAdditional: string[];
  publicClientStandardToolIds: string[];
  /** When true, this tenant cannot be selected as a Bulk Plan canary. */
  bulkCanaryProtected: boolean;
}

export const AGENT_ACCESS_SETTINGS_DEFAULTS: Readonly<AgentAccessSettings> = {
  enabled: false,
  maxTokenTtlSeconds: 900,
  elevationMode: 'self_reauth',
  elevationTtlSeconds: 300,
  rateLimitPerMinute: 60,
  publicClientStandardRateLimitPerMinute: 10,
  highRiskPermissionsAdditional: [],
  publicClientStandardToolIds: [],
  bulkCanaryProtected: false,
};

export const AGENT_ACCESS_SETTING_KEYS = {
  enabled: 'agent.mcp.enabled',
  maxTokenTtlSeconds: 'agent.mcp.max_token_ttl_seconds',
  elevationMode: 'agent.mcp.elevation_mode',
  elevationTtlSeconds: 'agent.mcp.elevation_ttl_seconds',
  rateLimitPerMinute: 'agent.mcp.rate_limit_per_minute',
  publicClientStandardRateLimitPerMinute: 'agent.mcp.public_client_standard_rate_limit_per_minute',
  highRiskPermissionsAdditional: 'agent.mcp.high_risk_permissions_additional',
  publicClientStandardToolIds: 'agent.mcp.public_client_standard_tool_ids',
  bulkCanaryProtected: 'agent.bulk.canary_protected',
  version: 'agent.mcp.settings_version',
  updatedAt: 'agent.mcp.settings_updated_at',
  updatedBy: 'agent.mcp.settings_updated_by',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : fallback;
}

/**
 * Reads the public Agent settings contract from a tenant settings record. Invalid stored values
 * fail to conservative defaults; callers still decide whether an unavailable store fails closed.
 */
export function parseAgentAccessSettings(value: unknown): AgentAccessSettings {
  const record = isRecord(value) ? value : {};
  const enabled = record[AGENT_ACCESS_SETTING_KEYS.enabled];
  const mode = record[AGENT_ACCESS_SETTING_KEYS.elevationMode];
  const highRisk = record[AGENT_ACCESS_SETTING_KEYS.highRiskPermissionsAdditional];
  const publicClientStandardTools = record[AGENT_ACCESS_SETTING_KEYS.publicClientStandardToolIds];
  return {
    enabled: typeof enabled === 'boolean' ? enabled : AGENT_ACCESS_SETTINGS_DEFAULTS.enabled,
    maxTokenTtlSeconds: boundedInteger(
      record[AGENT_ACCESS_SETTING_KEYS.maxTokenTtlSeconds],
      AGENT_ACCESS_SETTINGS_DEFAULTS.maxTokenTtlSeconds,
      60,
      900
    ),
    elevationMode:
      mode === 'self_reauth' || mode === 'approval' || mode === 'both'
        ? mode
        : AGENT_ACCESS_SETTINGS_DEFAULTS.elevationMode,
    elevationTtlSeconds: boundedInteger(
      record[AGENT_ACCESS_SETTING_KEYS.elevationTtlSeconds],
      AGENT_ACCESS_SETTINGS_DEFAULTS.elevationTtlSeconds,
      60,
      300
    ),
    rateLimitPerMinute: boundedInteger(
      record[AGENT_ACCESS_SETTING_KEYS.rateLimitPerMinute],
      AGENT_ACCESS_SETTINGS_DEFAULTS.rateLimitPerMinute,
      1,
      1_000
    ),
    publicClientStandardRateLimitPerMinute: boundedInteger(
      record[AGENT_ACCESS_SETTING_KEYS.publicClientStandardRateLimitPerMinute],
      AGENT_ACCESS_SETTINGS_DEFAULTS.publicClientStandardRateLimitPerMinute,
      1,
      60
    ),
    highRiskPermissionsAdditional: Array.isArray(highRisk)
      ? [
          ...new Set(
            highRisk.filter(
              (permission): permission is string =>
                typeof permission === 'string' && permission.length > 0 && permission.length <= 256
            )
          ),
        ].slice(0, 256)
      : [],
    publicClientStandardToolIds: Array.isArray(publicClientStandardTools)
      ? [
          ...new Set(
            publicClientStandardTools.filter(
              (toolId): toolId is string =>
                typeof toolId === 'string' && toolId.length > 0 && toolId.length <= 256
            )
          ),
        ].slice(0, 256)
      : [],
    bulkCanaryProtected:
      typeof record[AGENT_ACCESS_SETTING_KEYS.bulkCanaryProtected] === 'boolean'
        ? (record[AGENT_ACCESS_SETTING_KEYS.bulkCanaryProtected] as boolean)
        : AGENT_ACCESS_SETTINGS_DEFAULTS.bulkCanaryProtected,
  };
}

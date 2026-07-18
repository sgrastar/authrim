import {
  AGENT_ACCESS_SETTING_KEYS,
  evaluateAgentMcpFeatureFlag,
  parseAgentAccessSettings,
} from '../../core';
import type { AgentSettingsPort } from '../ports';

interface AgentSettingsKv {
  get(key: string): Promise<string | null>;
}

export interface CloudflareAgentSettingsEnv {
  SETTINGS?: AgentSettingsKv;
  AUTHRIM_CONFIG?: AgentSettingsKv;
  ENABLE_AGENT_MCP?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Tenant settings adapter shared by MCP policy enforcement and future Cloudflare resources. */
export class CloudflareAgentSettingsProvider implements AgentSettingsPort {
  constructor(private readonly env: CloudflareAgentSettingsEnv) {}

  async get(tenantId: string) {
    const store = this.env.SETTINGS ?? this.env.AUTHRIM_CONFIG;
    if (!store) {
      const enabled = evaluateAgentMcpFeatureFlag({
        configurationAvailable: true,
        environmentValue: this.env.ENABLE_AGENT_MCP,
      }).enabled;
      return { ...parseAgentAccessSettings(null), enabled };
    }
    const raw = await store.get(`settings:tenant:${tenantId}:agent-access`);
    let parsed: unknown = undefined;
    if (raw) {
      parsed = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error('Invalid Agent settings record');
    }
    const record = isRecord(parsed) ? parsed : {};
    const enabled = evaluateAgentMcpFeatureFlag({
      configurationAvailable: true,
      tenantValue: record[AGENT_ACCESS_SETTING_KEYS.enabled],
      environmentValue: this.env.ENABLE_AGENT_MCP,
    }).enabled;
    return { ...parseAgentAccessSettings(record), enabled };
  }
}

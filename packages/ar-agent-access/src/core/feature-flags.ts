export type AgentMcpFeatureFlagReason =
  | 'enabled_by_tenant'
  | 'enabled_by_environment'
  | 'disabled_by_tenant'
  | 'disabled_by_default'
  | 'configuration_unavailable'
  | 'invalid_configuration';

export interface AgentMcpFeatureFlagDecision {
  enabled: boolean;
  reason: AgentMcpFeatureFlagReason;
}

/** Pure fail-closed decision shared by every Agent access entry point. */
export function evaluateAgentMcpFeatureFlag(input: {
  configurationAvailable: boolean;
  tenantValue?: unknown;
  environmentValue?: string;
}): AgentMcpFeatureFlagDecision {
  if (!input.configurationAvailable) {
    return { enabled: false, reason: 'configuration_unavailable' };
  }
  if (input.tenantValue === true) {
    return { enabled: true, reason: 'enabled_by_tenant' };
  }
  if (input.tenantValue === false) {
    return { enabled: false, reason: 'disabled_by_tenant' };
  }
  if (input.tenantValue !== undefined) {
    return { enabled: false, reason: 'invalid_configuration' };
  }
  if (input.environmentValue === 'true') {
    return { enabled: true, reason: 'enabled_by_environment' };
  }
  if (input.environmentValue !== undefined && input.environmentValue !== 'false') {
    return { enabled: false, reason: 'invalid_configuration' };
  }
  return { enabled: false, reason: 'disabled_by_default' };
}

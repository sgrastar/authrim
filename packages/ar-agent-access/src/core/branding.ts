const AGENT_ACCESS_ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * Returns the deployment label that may be shown to an MCP user. The value comes from trusted
 * deployment configuration, but it is still constrained before crossing a public metadata
 * boundary so an accidental value cannot create an unbounded or misleading display name.
 */
export function normalizeAgentAccessEnvironmentName(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !AGENT_ACCESS_ENVIRONMENT_NAME_PATTERN.test(normalized)) return undefined;
  return normalized;
}

/** Human-readable product name for MCP initialize and OAuth protected-resource metadata. */
export function getAgentAccessDisplayName(environmentName?: string): string {
  const normalized = normalizeAgentAccessEnvironmentName(environmentName);
  if (!normalized || normalized === 'prod' || normalized === 'production') return 'Authrim';
  return `Authrim (${normalized})`;
}

/** Recommended client-owned connection identifier used in documentation and setup snippets. */
export function getAgentAccessRecommendedConnectionId(environmentName?: string): string {
  const normalized = normalizeAgentAccessEnvironmentName(environmentName);
  if (!normalized || normalized === 'prod' || normalized === 'production') return 'authrim';
  return `authrim-${normalized}`;
}

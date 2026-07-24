/**
 * Session-local discovery profiles reduce MCP tool-definition context without changing the
 * immutable Task Set authorization ceiling pinned by the Grant.
 */
export interface AgentDiscoveryProfileDefinition {
  id: string;
  title: string;
  description: string;
  toolIds: readonly string[];
  allGranted?: boolean;
}

export const AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID = 'admin.session.discovery-profiles.select';

export const DEFAULT_AGENT_DISCOVERY_PROFILE_ID = 'essential';

function profile(
  id: string,
  title: string,
  description: string,
  toolIds: readonly string[],
  allGranted = false
): AgentDiscoveryProfileDefinition {
  return Object.freeze({
    id,
    title,
    description,
    toolIds: Object.freeze([...toolIds]),
    ...(allGranted ? { allGranted: true } : {}),
  });
}

export const BUILTIN_AGENT_DISCOVERY_PROFILES: readonly AgentDiscoveryProfileDefinition[] =
  Object.freeze([
    profile(
      'essential',
      'Essential operations',
      'Client inventory, Agent delegations, audit, Agent settings, and runtime diagnostics.',
      [
        'admin.read.clients.list',
        'admin.read.clients.get',
        'admin.read.agent-grants.list',
        'admin.read.agent-access.explain',
        'admin.read.audit.search',
        'admin.read.agent-settings.get',
        'admin.read.runtime.diagnostics',
      ]
    ),
    profile(
      'identity_authorization',
      'Identity and authorization',
      'Identity providers, organizations, roles, policies, and policy simulation.',
      [
        'admin.read.identity-providers.inspect',
        'admin.read.authorization.organizations',
        'admin.read.authorization.roles',
        'admin.read.authorization.policies',
        'admin.read.authorization.simulate',
      ]
    ),
    profile(
      'flows_consent',
      'Flows and consent',
      'Authentication flows, consent policies, and configuration validation.',
      [
        'admin.read.flows.inspect',
        'admin.read.consent.inspect',
        'admin.read.flows.validate',
        'admin.read.tenant-policy.validate',
        'admin.read.clients.profile-validate',
      ]
    ),
    profile(
      'security_sessions',
      'Security and sessions',
      'Session, assurance, protocol, OAuth, token exchange, logout, and conformance posture.',
      [
        'admin.read.sessions.inspect',
        'admin.read.assurance.inspect',
        'admin.read.protocol-security.inspect',
        'admin.read.oauth.inspect',
        'admin.read.token-exchange.inspect',
        'admin.read.logout.inspect',
        'admin.read.conformance.inspect',
      ]
    ),
    profile('integrations_ui', 'Integrations and UI', 'Webhook and Login UI configuration.', [
      'admin.read.webhooks.inspect',
      'admin.read.login-ui.inspect',
    ]),
    profile(
      'user_data',
      'User data',
      'Masked user search and user detail tools. Requires an explicit user-data Grant scope.',
      ['admin.read.users.search', 'admin.read.users.get']
    ),
    profile(
      'configuration_design',
      'Configuration design',
      'Configuration capabilities and immutable Plan creation, validation, diff, status, and verification.',
      [
        'admin.read.configuration.capabilities',
        'admin.write.configuration.plan.create',
        'admin.write.configuration.plan.validate',
        'admin.read.configuration.plan.diff',
        'admin.read.configuration.plan.status',
        'admin.read.configuration.plan.verify',
      ]
    ),
    profile(
      'configuration_apply',
      'Configuration apply',
      'Apply or cancel an immutable single-tenant configuration Plan.',
      ['admin.write.configuration.plan.apply', 'admin.write.configuration.plan.cancel']
    ),
    profile(
      'administration_writes',
      'Granular administration writes',
      'Direct client, user, security, OAuth, session, and Login UI administration tools.',
      [
        'admin.write.clients.metadata',
        'admin.write.users.suspend',
        'admin.write.assurance.update',
        'admin.write.protocol-security.update',
        'admin.write.token-exchange.update',
        'admin.write.oauth.update',
        'admin.write.session.update',
        'admin.write.login-ui.update',
        'admin.write.clients.protocol-security',
        'admin.write.clients.public-create',
      ]
    ),
    profile(
      'bulk_rollout',
      'Bulk rollout',
      'Create, inspect, and validate immutable cross-tenant Bulk Plans.',
      ['admin.write.bulk.plan.create', 'admin.read.bulk.plan.get', 'admin.write.bulk.plan.validate']
    ),
    profile(
      'all_granted',
      'All granted tools',
      'Expose every tool already authorized by this Grant. This never expands the Grant.',
      [],
      true
    ),
  ]);

export interface ResolvedAgentDiscoveryProfiles {
  selectedProfileIds: readonly string[];
  visibleToolIds: ReadonlySet<string>;
  availableProfiles: readonly {
    id: string;
    title: string;
    description: string;
    grantedToolCount: number;
  }[];
}

export function resolveAgentDiscoveryProfiles(input: {
  grantedToolIds: readonly string[];
  selectedProfileIds?: readonly string[];
}): ResolvedAgentDiscoveryProfiles {
  const granted = new Set(input.grantedToolIds);
  const availableProfiles = BUILTIN_AGENT_DISCOVERY_PROFILES.map((definition) => ({
    id: definition.id,
    title: definition.title,
    description: definition.description,
    grantedToolCount: definition.allGranted
      ? [...granted].filter((id) => id !== AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID).length
      : definition.toolIds.filter((id) => granted.has(id)).length,
  })).filter((definition) => definition.grantedToolCount > 0);
  const definitions = new Map(BUILTIN_AGENT_DISCOVERY_PROFILES.map((item) => [item.id, item]));
  const requested = [...new Set(input.selectedProfileIds ?? [])];
  if (requested.length > BUILTIN_AGENT_DISCOVERY_PROFILES.length) {
    throw new TypeError('Too many Agent discovery profiles selected');
  }
  for (const id of requested) {
    if (!definitions.has(id)) throw new TypeError(`Unknown Agent discovery profile: ${id}`);
  }
  if (requested.includes('all_granted') && requested.length > 1) {
    throw new TypeError('all_granted must be selected by itself');
  }

  let selectedProfileIds = requested;
  if (selectedProfileIds.length === 0) {
    selectedProfileIds = [DEFAULT_AGENT_DISCOVERY_PROFILE_ID];
  }

  const visibleToolIds = new Set<string>();
  if (selectedProfileIds.some((id) => definitions.get(id)?.allGranted)) {
    for (const id of granted) visibleToolIds.add(id);
  } else {
    for (const id of selectedProfileIds) {
      for (const toolId of definitions.get(id)?.toolIds ?? []) {
        if (granted.has(toolId)) visibleToolIds.add(toolId);
      }
    }
  }
  if (granted.has(AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID)) {
    visibleToolIds.add(AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID);
  }
  return {
    selectedProfileIds: Object.freeze([...selectedProfileIds]),
    visibleToolIds,
    availableProfiles: Object.freeze(availableProfiles.map((item) => Object.freeze(item))),
  };
}

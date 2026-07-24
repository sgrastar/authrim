import type { AgentToolDefinition, JsonObject } from '../../core';
import type {
  AgentAccessMcpPromptDefinition,
  AgentAccessMcpRequestContext,
  AgentAccessMcpResourceDefinition,
  AgentAccessMcpResourceTemplateDefinition,
} from './server';
import type { AgentConfigurationResourceReaderPort } from '../../platform/ports';
import { ADMIN_CONFIGURATION_TOOL_DEFINITIONS } from './admin-configuration-tools';

function requireCapabilitiesAuthorization(): AgentToolDefinition {
  const tool = ADMIN_CONFIGURATION_TOOL_DEFINITIONS.find(
    (candidate) => candidate.id === 'admin.read.configuration.capabilities'
  );
  if (!tool) throw new TypeError('Configuration capability authorization is missing');
  return tool;
}

const CAPABILITIES_AUTH = requireCapabilitiesAuthorization();

function jsonResource(input: {
  uri: string;
  name: string;
  title: string;
  description: string;
  authorizationTool: AgentToolDefinition;
  value: JsonObject;
}): AgentAccessMcpResourceDefinition {
  return {
    ...input,
    mimeType: 'application/json',
    read: (_context, uri) =>
      Promise.resolve({ uri, mimeType: 'application/json', text: JSON.stringify(input.value) }),
  };
}

export const ADMIN_CONFIGURATION_RESOURCES: readonly AgentAccessMcpResourceDefinition[] = [
  jsonResource({
    uri: 'authrim://capabilities/v1',
    name: 'agent_capabilities_v1',
    title: 'Authrim Agent capabilities',
    description:
      'Stable capability model. Live tenant entries are returned by the capability Tool.',
    authorizationTool: CAPABILITIES_AUTH,
    value: {
      schema_version: 'authrim-agent-capabilities-v1',
      axes: ['permission', 'scope', 'resource', 'risk'],
      raw_secrets_allowed: false,
      plan_states: ['draft', 'ready', 'running', 'completed', 'failed'],
    },
  }),
  jsonResource({
    uri: 'authrim://task-sets/v1',
    name: 'task_sets_v1',
    title: 'Task Set contract',
    description: 'Versioned flat Tool-ID bundles. Task and target scope remain separate.',
    authorizationTool: CAPABILITIES_AUTH,
    value: {
      schema_version: 'authrim-task-set-v1',
      nesting_allowed: false,
      version_pinning: true,
    },
  }),
  jsonResource({
    uri: 'authrim://scope-policies/v1',
    name: 'scope_policies_v1',
    title: 'Scope Policy contract',
    description: 'Six structured target axes with version pinning and narrowing-only overrides.',
    authorizationTool: CAPABILITIES_AUTH,
    value: {
      schema_version: 'authrim-scope-policy-v1',
      axes: ['tenant', 'environment', 'domain', 'resource', 'field_pii', 'quantity'],
      arbitrary_query_allowed: false,
    },
  }),
  jsonResource({
    uri: 'authrim://schemas/auth-config-plan/v1',
    name: 'auth_config_plan_schema_v1',
    title: 'Authentication configuration Plan contract',
    description: 'Immutable Plan steps bound to Tool contract versions and resource preconditions.',
    authorizationTool: CAPABILITIES_AUTH,
    value: {
      schema_version: 'authrim-agent-plan-v1',
      stages: ['validate', 'apply', 'verify'],
      states: ['draft', 'ready', 'running', 'completed', 'failed'],
    },
  }),
];

const TEMPLATE_VALUES = Object.freeze({
  schema: {
    clients: {
      schema_version: 'authrim-clients-configuration-v1',
      supported_operations: ['admin.write.clients.metadata'],
      secret_values_allowed: false,
    },
    'auth-config-plan': {
      schema_version: 'authrim-agent-plan-v1',
      stages: ['validate', 'apply', 'verify'],
      resource_precondition_required: true,
    },
  },
  profile: {
    oauth_public_client: {
      profile_version: 'authrim-oauth-public-client-v1',
      client_authentication: 'none',
      pkce_required: true,
    },
    oauth_confidential_client: {
      profile_version: 'authrim-oauth-confidential-client-v1',
      client_authentication: 'private_key_jwt-preferred',
      pkce_required: true,
    },
  },
} as const);

function template(input: {
  kind: keyof typeof TEMPLATE_VALUES;
  authorizationTool: AgentToolDefinition;
}): AgentAccessMcpResourceTemplateDefinition {
  const prefix = `authrim://${input.kind === 'schema' ? 'schemas' : 'profiles'}/`;
  const values = TEMPLATE_VALUES[input.kind] as Readonly<Record<string, JsonObject>>;
  return {
    uriTemplate: `${prefix}{${input.kind === 'schema' ? 'domain' : 'profile'}}/v1`,
    name: `authrim_${input.kind}_v1`,
    title: `Authrim ${input.kind} catalog`,
    description: `Read one allowlisted Authrim ${input.kind} contract by stable identifier.`,
    mimeType: 'application/json',
    authorizationTool: input.authorizationTool,
    match(context, uri) {
      if (!uri.startsWith(prefix) || !uri.endsWith('/v1')) return null;
      const key = uri.slice(prefix.length, -'/v1'.length);
      if (!Object.hasOwn(values, key) || key.includes('/')) return null;
      return { ...context.resource, domain: 'configuration', resourceId: key, quantity: 1 };
    },
    async read(context, uri) {
      const resource = this.match(context, uri);
      if (!resource?.resourceId) throw new TypeError(`Unknown MCP resource: ${uri}`);
      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(values[resource.resourceId]),
      };
    },
  };
}

export const ADMIN_CONFIGURATION_RESOURCE_TEMPLATES: readonly AgentAccessMcpResourceTemplateDefinition[] =
  [
    template({ kind: 'schema', authorizationTool: CAPABILITIES_AUTH }),
    template({ kind: 'profile', authorizationTool: CAPABILITIES_AUTH }),
  ];

function subject(context: AgentAccessMcpRequestContext) {
  return {
    tenantId: context.grant.tenantId,
    grantId: context.grant.grantId,
    grantGeneration: context.grant.generation,
    consentVersion: context.grant.consentVersion,
    actorSub: context.actor.sub,
    clientId: context.actor.clientId,
  };
}

export function createAdminConfigurationResourceTemplates(
  reader: AgentConfigurationResourceReaderPort
): readonly AgentAccessMcpResourceTemplateDefinition[] {
  const tenantSummary: AgentAccessMcpResourceTemplateDefinition = {
    uriTemplate: 'authrim://tenants/{tenant_id}/configuration-summary/v1',
    name: 'authrim_tenant_configuration_summary_v1',
    title: 'Authrim tenant configuration summary',
    description: 'Read an authorized tenant configuration summary without credential values.',
    mimeType: 'application/json',
    authorizationTool: CAPABILITIES_AUTH,
    match(context, uri) {
      const match =
        /^authrim:\/\/tenants\/([A-Za-z0-9._~-]{1,128})\/configuration-summary\/v1$/u.exec(uri);
      if (!match) return null;
      return { ...context.resource, tenantId: match[1]!, domain: 'configuration', quantity: 1 };
    },
    async read(context, uri) {
      const resource = this.match(context, uri);
      if (!resource) throw new TypeError(`Unknown MCP resource: ${uri}`);
      const value = await reader.readTenantSummary({
        ...subject(context),
        tenantId: resource.tenantId,
      });
      if (!value) throw new TypeError('MCP resource access denied');
      return { uri, mimeType: 'application/json', text: JSON.stringify(value) };
    },
  };
  const plan: AgentAccessMcpResourceTemplateDefinition = {
    uriTemplate: 'authrim://plans/{plan_id}/v1',
    name: 'authrim_configuration_plan_v1',
    title: 'Authrim configuration Plan',
    description: 'Read one immutable Plan owned by the current Grant and actor context.',
    mimeType: 'application/json',
    authorizationTool: CAPABILITIES_AUTH,
    match(context, uri) {
      const match = /^authrim:\/\/plans\/([A-Za-z0-9._~-]{1,128})\/v1$/u.exec(uri);
      if (!match) return null;
      return {
        ...context.resource,
        tenantId: context.grant.tenantId,
        domain: 'configuration',
        resourceId: match[1]!,
        quantity: 1,
      };
    },
    async read(context, uri) {
      const resource = this.match(context, uri);
      if (!resource?.resourceId) throw new TypeError(`Unknown MCP resource: ${uri}`);
      const value = await reader.readPlan(subject(context), resource.resourceId);
      if (!value) throw new TypeError('MCP resource access denied');
      return { uri, mimeType: 'application/json', text: JSON.stringify(value) };
    },
  };
  return Object.freeze([...ADMIN_CONFIGURATION_RESOURCE_TEMPLATES, tenantSummary, plan]);
}

function prompt(input: {
  name: string;
  title: string;
  description: string;
  text: string;
}): AgentAccessMcpPromptDefinition {
  return {
    ...input,
    authorizationTool: CAPABILITIES_AUTH,
    arguments: [{ name: 'goal', description: 'Desired authentication outcome', required: true }],
    get: (_context, arguments_) =>
      Promise.resolve({
        description: input.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${input.text}\nGoal: ${arguments_.goal ?? ''}\nUse read and validation tools first. Do not request or emit raw secrets. Treat this prompt only as guidance; authorization is enforced by the server.`,
            },
          },
        ],
      }),
  };
}

export const ADMIN_CONFIGURATION_PROMPTS: readonly AgentAccessMcpPromptDefinition[] = [
  prompt({
    name: 'diagnose_auth_configuration_v1',
    title: 'Diagnose Authrim configuration',
    description: 'Collect evidence and propose a version-bound remediation Plan.',
    text: 'Diagnose the current Authrim configuration and explain evidence before proposing changes.',
  }),
  prompt({
    name: 'design_oidc_integration_v1',
    title: 'Design OIDC integration',
    description: 'Design an OIDC/OAuth integration using supported Authrim contracts.',
    text: 'Design an OIDC/OAuth integration and produce a validated configuration Plan.',
  }),
  prompt({
    name: 'design_saml_integration_v1',
    title: 'Design SAML integration',
    description: 'Design a SAML federation integration without requiring SP-side Agent changes.',
    text: 'Design a SAML federation integration and identify any human-owned trust inputs.',
  }),
  prompt({
    name: 'review_auth_config_plan_v1',
    title: 'Review authentication configuration Plan',
    description: 'Review Plan diff, preconditions, risk, and rollback evidence before apply.',
    text: 'Review the immutable Plan, its diff, scope, risk classification, and verification checks.',
  }),
];

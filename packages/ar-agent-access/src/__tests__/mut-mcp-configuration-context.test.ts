import { describe, expect, it } from 'vitest';
import {
  ADMIN_CONFIGURATION_RESOURCES,
  ADMIN_CONFIGURATION_RESOURCE_TEMPLATES,
} from '../protocol/mcp/admin-configuration-context';
import { makeContext } from './helpers/mut-mcp-harness';

const context = makeContext({ actor: { sub: 'client:abc', clientId: 'abc' } });
const CAPABILITIES_TOOL_ID = 'admin.read.configuration.capabilities';

async function readJson(
  definition: { read: (c: typeof context, uri: string) => Promise<{ text?: string }> },
  uri: string
) {
  const contents = await definition.read(context, uri);
  return JSON.parse(contents.text ?? 'null') as unknown;
}

describe('static configuration resources', () => {
  it('publishes the four versioned contract resources behind the capability tool', async () => {
    expect(
      ADMIN_CONFIGURATION_RESOURCES.map(({ uri, name, title, mimeType, authorizationTool }) => ({
        uri,
        name,
        title,
        mimeType,
        auth: authorizationTool.id,
      }))
    ).toEqual([
      {
        uri: 'authrim://capabilities/v1',
        name: 'agent_capabilities_v1',
        title: 'Authrim Agent capabilities',
        mimeType: 'application/json',
        auth: CAPABILITIES_TOOL_ID,
      },
      {
        uri: 'authrim://task-sets/v1',
        name: 'task_sets_v1',
        title: 'Task Set contract',
        mimeType: 'application/json',
        auth: CAPABILITIES_TOOL_ID,
      },
      {
        uri: 'authrim://scope-policies/v1',
        name: 'scope_policies_v1',
        title: 'Scope Policy contract',
        mimeType: 'application/json',
        auth: CAPABILITIES_TOOL_ID,
      },
      {
        uri: 'authrim://schemas/auth-config-plan/v1',
        name: 'auth_config_plan_schema_v1',
        title: 'Authentication configuration Plan contract',
        mimeType: 'application/json',
        auth: CAPABILITIES_TOOL_ID,
      },
    ]);
    for (const resource of ADMIN_CONFIGURATION_RESOURCES) {
      expect(resource.description.length).toBeGreaterThan(20);
    }
  });

  it('serves the exact contract values and echoes the requested URI', async () => {
    const [capabilities, taskSets, scopePolicies, plan] = ADMIN_CONFIGURATION_RESOURCES;
    const contents = await capabilities.read(context, 'authrim://capabilities/v1');
    expect(contents.uri).toBe('authrim://capabilities/v1');
    expect(contents.mimeType).toBe('application/json');
    expect(JSON.parse(contents.text!)).toEqual({
      schema_version: 'authrim-agent-capabilities-v1',
      axes: ['permission', 'scope', 'resource', 'risk'],
      raw_secrets_allowed: false,
      plan_states: ['draft', 'ready', 'running', 'completed', 'failed'],
    });
    expect(await readJson(taskSets, 'u')).toEqual({
      schema_version: 'authrim-task-set-v1',
      nesting_allowed: false,
      version_pinning: true,
    });
    expect(await readJson(scopePolicies, 'u')).toEqual({
      schema_version: 'authrim-scope-policy-v1',
      axes: ['tenant', 'environment', 'domain', 'resource', 'field_pii', 'quantity'],
      arbitrary_query_allowed: false,
    });
    expect(await readJson(plan, 'u')).toEqual({
      schema_version: 'authrim-agent-plan-v1',
      stages: ['validate', 'apply', 'verify'],
      states: ['draft', 'ready', 'running', 'completed', 'failed'],
    });
  });
});

describe('allowlisted schema and profile templates', () => {
  const [schema, profile] = ADMIN_CONFIGURATION_RESOURCE_TEMPLATES;

  it('describes both templates', () => {
    expect(
      ADMIN_CONFIGURATION_RESOURCE_TEMPLATES.map((item) => ({
        uriTemplate: item.uriTemplate,
        name: item.name,
        title: item.title,
        description: item.description,
        mimeType: item.mimeType,
        auth: item.authorizationTool.id,
      }))
    ).toEqual([
      {
        uriTemplate: 'authrim://schemas/{domain}/v1',
        name: 'authrim_schema_v1',
        title: 'Authrim schema catalog',
        description: 'Read one allowlisted Authrim schema contract by stable identifier.',
        mimeType: 'application/json',
        auth: CAPABILITIES_TOOL_ID,
      },
      {
        uriTemplate: 'authrim://profiles/{profile}/v1',
        name: 'authrim_profile_v1',
        title: 'Authrim profile catalog',
        description: 'Read one allowlisted Authrim profile contract by stable identifier.',
        mimeType: 'application/json',
        auth: CAPABILITIES_TOOL_ID,
      },
    ]);
  });

  it('matches allowlisted keys into a single-item configuration resource', () => {
    expect(schema.match(context, 'authrim://schemas/clients/v1')).toEqual({
      tenantId: 'tenant-1',
      domain: 'configuration',
      resourceId: 'clients',
      quantity: 1,
    });
    expect(profile.match(context, 'authrim://profiles/oauth_public_client/v1')).toMatchObject({
      resourceId: 'oauth_public_client',
    });
  });

  it.each([
    'authrim://schemas/clients/v2',
    'authrim://schemas/clients',
    'xauthrim://schemas/clients/v1',
    'authrim://profiles/clients/v1',
    'authrim://schemas/unknown/v1',
    'authrim://schemas/toString/v1',
    'authrim://schemas/clients/extra/v1',
    'authrim://schemas//v1',
  ])('refuses non-allowlisted schema URI %s', async (uri) => {
    expect(schema.match(context, uri)).toBeNull();
    await expect(schema.read(context, uri)).rejects.toThrow(`Unknown MCP resource: ${uri}`);
  });

  it('refuses a URI with the right prefix but wrong version suffix even for known keys', () => {
    expect(profile.match(context, 'authrim://profiles/oauth_public_client/v1x')).toBeNull();
    expect(profile.match(context, 'authrim://schemas/oauth_public_client/v1')).toBeNull();
  });

  it('serves each allowlisted value exactly', async () => {
    expect(await readJson(schema, 'authrim://schemas/clients/v1')).toEqual({
      schema_version: 'authrim-clients-configuration-v1',
      supported_operations: ['admin.write.clients.metadata'],
      secret_values_allowed: false,
    });
    expect(await readJson(schema, 'authrim://schemas/auth-config-plan/v1')).toEqual({
      schema_version: 'authrim-agent-plan-v1',
      stages: ['validate', 'apply', 'verify'],
      resource_precondition_required: true,
    });
    expect(await readJson(profile, 'authrim://profiles/oauth_public_client/v1')).toEqual({
      profile_version: 'authrim-oauth-public-client-v1',
      client_authentication: 'none',
      pkce_required: true,
    });
    const confidential = await profile.read(
      context,
      'authrim://profiles/oauth_confidential_client/v1'
    );
    expect(confidential).toEqual({
      uri: 'authrim://profiles/oauth_confidential_client/v1',
      mimeType: 'application/json',
      text: JSON.stringify({
        profile_version: 'authrim-oauth-confidential-client-v1',
        client_authentication: 'private_key_jwt-preferred',
        pkce_required: true,
      }),
    });
  });
});

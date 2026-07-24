import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import {
  createAgentToolCatalog,
  sealAgentToolDefinition,
  sealAgentToolDefinitions,
  type AgentGrantContract,
  type AgentToolDefinitionSource,
} from '../../../core';
import {
  createAgentAccessMcpSdkServer,
  createAgentAccessMcpServer,
  McpSdkJsonSchemaValidator,
  type AgentAccessMcpServer,
  type AgentAccessMcpRequestContext,
} from '../index';

const grant: AgentGrantContract = {
  grantId: 'grant-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  grantorId: 'admin-1',
  delegatorId: 'admin-1',
  permissions: ['admin:users:read'],
  scopes: ['agent:read'],
  resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
  consentVersion: 1,
  generation: 1,
  status: 'active',
  delegationMode: 'user_consent',
};

const context: AgentAccessMcpRequestContext = {
  actor: {
    mode: 'mode_a',
    sub: 'client:client-1',
    assurance: 'public_client_transaction',
    tokenBinding: 'bearer',
    clientId: 'client-1',
  },
  grant,
  resource: { tenantId: 'tenant-1' },
  issuerOrigin: 'https://tenant-1.authrim.example',
  correlationId: 'correlation-1',
};

function createTestCatalog(version: string, definitions: readonly AgentToolDefinitionSource[]) {
  return createAgentToolCatalog(version, sealAgentToolDefinitions(definitions));
}

describe('createAgentAccessMcpSdkServer', () => {
  it('returns invalid Tool arguments over Streamable HTTP without enumerating discovery state', async () => {
    const authorize = vi.fn(async () => ({ allowed: true, requiresElevation: false }));
    const execute = vi.fn(async () => ({ status: 200, body: {} }));
    const audit = vi.fn(async () => undefined);
    const catalog = createTestCatalog('streamable-http-invalid-input', [
      {
        id: 'admin.session.discovery-profiles.select',
        name: 'set_active_tool_profiles',
        title: 'Set active Tool profiles',
        description: 'Select session-local Tool discovery profiles.',
        contractVersion: '1',
        requiredPermissions: ['admin:users:read'],
        riskLevel: 'low',
        requiredScope: 'agent:read',
        inputSchema: { type: 'object' },
      },
      {
        id: 'admin.read.clients.get',
        name: 'get_client',
        title: 'Get client',
        description: 'Get one OAuth client.',
        contractVersion: '1',
        requiredPermissions: ['admin:users:read'],
        riskLevel: 'low',
        requiredScope: 'agent:read',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            client_id: { type: 'string', pattern: '^[A-Za-z0-9._~-]+$' },
          },
          required: ['client_id'],
        },
      },
    ]);
    const actualApplication = createAgentAccessMcpServer({
      toolCatalog: catalog,
      authorization: { authorize },
      managementApi: { execute },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write: audit },
      clock: { now: () => 1 },
      schemaValidator: new McpSdkJsonSchemaValidator(),
      discoveryProfiles: {
        get: () => new Promise<never>(() => undefined),
        put: async () => undefined,
      },
    });
    const discoveryCalls = {
      tools: vi.fn(() => new Promise<never>(() => undefined)),
      resources: vi.fn(() => new Promise<never>(() => undefined)),
      templates: vi.fn(() => new Promise<never>(() => undefined)),
      prompts: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const application: AgentAccessMcpServer = {
      ...actualApplication,
      listTools: discoveryCalls.tools,
      listResources: discoveryCalls.resources,
      listResourceTemplates: discoveryCalls.templates,
      readResource: async () => ({ uri: 'authrim://unused', text: '{}' }),
      listPrompts: discoveryCalls.prompts,
      getPrompt: async () => ({ messages: [] }),
    };
    const streamableContext: AgentAccessMcpRequestContext = {
      ...context,
      grant: {
        ...context.grant,
        resolvedTools: catalog.list().map((tool) => ({
          toolId: tool.id,
          contractVersion: tool.contractVersion,
          schemaDigest: tool.schemaDigest,
        })),
      },
    };
    const server = createAgentAccessMcpSdkServer(application, () => streamableContext);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => 'streamable-http-session-1',
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const post = async (message: unknown, session = true) =>
      transport.handleRequest(
        new Request('https://agent.example/mcp', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
            ...(session ? { 'mcp-session-id': 'streamable-http-session-1' } : {}),
          },
          body: JSON.stringify(message),
        })
      );
    try {
      const initialize = await post(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'streamable-http-regression', version: '1.0.0' },
          },
        },
        false
      );
      expect(initialize.status).toBe(200);
      const initialized = await post({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      });
      expect(initialized.status).toBe(202);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        post({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_client', arguments: { client_id: 'http://invalid.example' } },
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Streamable HTTP Tool error timed out')),
            2_000
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Invalid tool arguments' }],
        },
      });
      expect(authorize).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'agent.mcp.tool.denied',
          details: expect.objectContaining({
            denied_axis: 'input_schema',
            code: 'AGENT_INVALID_TOOL_ARGUMENTS',
          }),
        })
      );
      expect(discoveryCalls.tools).not.toHaveBeenCalled();
      expect(discoveryCalls.resources).not.toHaveBeenCalled();
      expect(discoveryCalls.templates).not.toHaveBeenCalled();
      expect(discoveryCalls.prompts).not.toHaveBeenCalled();
    } finally {
      await Promise.all([server.close(), transport.close()]);
    }
  });

  it('exposes platform-neutral Tools, Resources, and Prompts through the MCP SDK', async () => {
    const authorizationTool = sealAgentToolDefinition({
      id: 'context.read',
      name: 'context_read',
      title: 'Read context',
      description: 'Internal context authorization contract.',
      contractVersion: '1',
      requiredPermissions: ['admin:users:read'],
      riskLevel: 'low' as const,
      requiredScope: 'agent:read' as const,
      inputSchema: { type: 'object' },
      taskSupport: 'forbidden' as const,
    });
    const application = createAgentAccessMcpServer({
      toolCatalog: createTestCatalog('1', [
        {
          id: 'users.get',
          name: 'get_user',
          title: 'Get user',
          description: 'Returns one masked user.',
          contractVersion: '1',
          requiredPermissions: ['admin:users:read'],
          riskLevel: 'low',
          requiredScope: 'agent:read',
          inputSchema: { type: 'object', additionalProperties: false },
          taskSupport: 'forbidden',
        },
      ]),
      authorization: { authorize: async () => ({ allowed: true, requiresElevation: false }) },
      managementApi: { execute: async () => ({ status: 200, body: { id: 'user-1' } }) },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write: async () => undefined },
      clock: { now: () => 1 },
      schemaValidator: new McpSdkJsonSchemaValidator(),
      resources: [
        {
          uri: 'authrim://agent/capabilities',
          name: 'capabilities',
          title: 'Capabilities',
          description: 'Current delegated capabilities.',
          mimeType: 'application/json',
          authorizationTool,
          read: async (_context, uri) => ({ uri, mimeType: 'application/json', text: '{}' }),
        },
      ],
      resourceTemplates: [
        {
          uriTemplate: 'authrim://schemas/{domain}/v1',
          name: 'schemas',
          title: 'Schemas',
          description: 'Versioned schemas.',
          mimeType: 'application/json',
          authorizationTool,
          match: (requestContext, uri) =>
            uri === 'authrim://schemas/clients/v1'
              ? { ...requestContext.resource, domain: 'configuration', resourceId: 'clients' }
              : null,
          read: async (_context, uri) => ({
            uri,
            mimeType: 'application/json',
            text: '{"schema_version":"v1"}',
          }),
        },
      ],
      prompts: [
        {
          name: 'propose_configuration',
          title: 'Propose configuration',
          description: 'Build a safe configuration proposal.',
          authorizationTool,
          get: async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Propose a plan.' } }],
          }),
        },
      ],
    });
    const server = createAgentAccessMcpSdkServer(application, () => context, {
      environmentName: 'test',
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: 'authrim-agent-access',
        title: 'Authrim (test)',
        version: '0.4.0',
        description: 'Authrim administration and configuration through delegated Agent Access.',
        websiteUrl: 'https://authrim.com',
      });
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          {
            name: 'get_user',
            description: 'Returns one masked user.',
          },
        ],
      });
      const listedTool = (await client.listTools()).tools[0];
      expect(listedTool).not.toHaveProperty('title');
      expect(listedTool).not.toHaveProperty('execution');
      expect(listedTool).not.toHaveProperty('_meta');
      await expect(client.callTool({ name: 'get_user', arguments: {} })).resolves.toMatchObject({
        structuredContent: { id: 'user-1' },
        isError: false,
        _meta: {
          'com.authrim/dataProvenance': expect.objectContaining({
            source: 'management_api',
            trust_level: 'tenant_data_untrusted',
          }),
        },
      });
      await expect(client.listResources()).resolves.toMatchObject({
        resources: [{ uri: 'authrim://agent/capabilities' }],
      });
      await expect(
        client.readResource({ uri: 'authrim://agent/capabilities' })
      ).resolves.toMatchObject({
        contents: [
          {
            text: '{}',
            _meta: {
              'com.authrim/dataProvenance': expect.objectContaining({ source: 'resource' }),
            },
          },
        ],
      });
      await expect(client.listResourceTemplates()).resolves.toMatchObject({
        resourceTemplates: [{ uriTemplate: 'authrim://schemas/{domain}/v1' }],
      });
      await expect(
        client.readResource({ uri: 'authrim://schemas/clients/v1' })
      ).resolves.toMatchObject({ contents: [{ text: '{"schema_version":"v1"}' }] });
      await expect(client.listPrompts()).resolves.toMatchObject({
        prompts: [{ name: 'propose_configuration' }],
      });
      await expect(client.getPrompt({ name: 'propose_configuration' })).resolves.toMatchObject({
        messages: [{ role: 'user', content: { text: 'Propose a plan.' } }],
        _meta: {
          'com.authrim/dataProvenance': expect.objectContaining({
            source: 'server_prompt',
            trust_level: 'server_authored',
          }),
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('advertises and coalesces list-changed notifications when the effective set changes', async () => {
    let currentContext = context;
    const authorizationTool = sealAgentToolDefinition({
      id: 'context.read',
      name: 'context_read',
      title: 'Read context',
      description: 'Internal authorization contract.',
      contractVersion: '1',
      requiredPermissions: ['admin:users:read'],
      riskLevel: 'low' as const,
      requiredScope: 'agent:read' as const,
      inputSchema: { type: 'object' },
      taskSupport: 'forbidden' as const,
    });
    const application = createAgentAccessMcpServer({
      toolCatalog: createTestCatalog('1', [authorizationTool]),
      authorization: {
        authorize: async ({ tool, grant: currentGrant }) => ({
          allowed: tool.requiredPermissions.every((permission) =>
            currentGrant.permissions.includes(permission)
          ),
          requiresElevation: false,
        }),
      },
      managementApi: { execute: async () => ({ status: 200, body: {} }) },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      audit: { write: async () => undefined },
      clock: { now: () => 1 },
      schemaValidator: new McpSdkJsonSchemaValidator(),
      resources: [
        {
          uri: 'authrim://capabilities/v1',
          name: 'capabilities',
          title: 'Capabilities',
          description: 'Capabilities.',
          mimeType: 'application/json',
          authorizationTool,
          read: async (_requestContext, uri) => ({ uri, text: '{}' }),
        },
      ],
      prompts: [
        {
          name: 'diagnose',
          title: 'Diagnose',
          description: 'Diagnose.',
          authorizationTool,
          get: async () => ({ messages: [] }),
        },
      ],
    });
    const server = createAgentAccessMcpSdkServer(application, () => currentContext);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const notifications: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notifications.push('tools');
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      notifications.push('resources');
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      notifications.push('prompts');
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getServerCapabilities()).toMatchObject({
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      });
      await client.listTools();
      currentContext = {
        ...context,
        grant: { ...context.grant, permissions: [] },
      };
      await client.listTools();
      expect(notifications.sort()).toEqual(['prompts', 'resources', 'tools']);
      await client.listTools();
      expect(notifications).toHaveLength(3);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('sends tools/list_changed immediately after a session profile switch', async () => {
    const firstTool = {
      id: 'session.discovery.select',
      name: 'set_active_tool_profiles',
      title: 'Set profiles',
      description: 'Set session-local profiles.',
      contractVersion: '1',
      requiredPermissions: ['admin:agent:use'],
      riskLevel: 'low' as const,
      requiredScope: 'agent:read' as const,
      schemaDigest: 'sha256:first',
      inputSchema: { type: 'object' },
    };
    const secondTool = {
      ...firstTool,
      id: 'flows.inspect',
      name: 'inspect_authentication_flows',
      title: 'Inspect flows',
      description: 'Inspect authentication flows.',
      schemaDigest: 'sha256:second',
    };
    let switched = false;
    const application: AgentAccessMcpServer = {
      protocolRevision: '2025-11-25',
      listTools: async () => (switched ? [firstTool, secondTool] : [firstTool]),
      callTool: async () => {
        switched = true;
        return { content: [{ type: 'text', text: 'changed' }], toolListChanged: true };
      },
      listResources: async () => [],
      listResourceTemplates: async () => [],
      readResource: async () => ({ uri: 'authrim://unused', text: '{}' }),
      listPrompts: async () => [],
      getPrompt: async () => ({ messages: [] }),
    };
    const server = createAgentAccessMcpSdkServer(application, () => context);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const notifications: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notifications.push('tools');
    });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.listTools();
      await client.callTool({ name: 'set_active_tool_profiles', arguments: {} });
      expect(notifications).toEqual(['tools']);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: 'set_active_tool_profiles' }, { name: 'inspect_authentication_flows' }],
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('maps an operation-bound elevation challenge to MCP URL elicitation -32042', async () => {
    const application = createAgentAccessMcpServer({
      toolCatalog: createTestCatalog('1', [
        {
          id: 'admin.write.users.suspend',
          name: 'suspend_user',
          title: 'Suspend user',
          description: 'Suspends one user after human approval.',
          contractVersion: '1',
          requiredPermissions: ['admin:users:suspend'],
          riskLevel: 'high',
          requiredScope: 'agent:write',
          inputSchema: { type: 'object', additionalProperties: false },
          taskSupport: 'forbidden',
        },
      ]),
      authorization: {
        authorize: async () => ({
          allowed: false,
          requiresElevation: true,
          deniedAxis: 'risk',
          code: 'AGENT_ELEVATION_REQUIRED',
        }),
      },
      managementApi: { execute: async () => ({ status: 500, body: null }) },
      rateLimiter: { consume: async () => ({ allowed: true, remaining: 1, resetAt: 1 }) },
      settings: {
        get: async () => ({
          enabled: true,
          maxTokenTtlSeconds: 900,
          elevationMode: 'self_reauth',
          elevationTtlSeconds: 300,
          rateLimitPerMinute: 60,
          highRiskPermissionsAdditional: [],
          bulkCanaryProtected: false,
        }),
      },
      elevation: {
        resolve: async () => ({
          status: 'required',
          challengeId: 'elevation-1',
          url: 'https://tenant-1.authrim.example/admin/agent-access/elevations/elevation-1',
          message: 'Confirm suspension of one user.',
          expiresAt: 301,
        }),
        complete: async () => false,
      },
      audit: { write: async () => undefined },
      clock: { now: () => 1 },
      schemaValidator: new McpSdkJsonSchemaValidator(),
    });
    const server = createAgentAccessMcpSdkServer(application, () => context);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await expect(client.callTool({ name: 'suspend_user', arguments: {} })).rejects.toMatchObject({
        code: -32042,
        data: {
          elicitations: [
            {
              mode: 'url',
              elicitationId: 'elevation-1',
              url: 'https://tenant-1.authrim.example/admin/agent-access/elevations/elevation-1',
            },
          ],
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

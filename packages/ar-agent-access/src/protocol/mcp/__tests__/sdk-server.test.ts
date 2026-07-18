import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createAgentToolCatalog, type AgentGrantContract } from '../../../core';
import {
  createAgentAccessMcpSdkServer,
  createAgentAccessMcpServer,
  McpSdkJsonSchemaValidator,
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

describe('createAgentAccessMcpSdkServer', () => {
  it('exposes platform-neutral Tools, Resources, and Prompts through the MCP SDK', async () => {
    const authorizationTool = {
      id: 'context.read',
      name: 'context_read',
      title: 'Read context',
      description: 'Internal context authorization contract.',
      contractVersion: '1',
      requiredPermissions: ['admin:users:read'],
      riskLevel: 'low' as const,
      requiredScope: 'agent:read' as const,
      schemaDigest: 'sha256:context',
      inputSchema: { type: 'object' },
      taskSupport: 'forbidden' as const,
    };
    const application = createAgentAccessMcpServer({
      toolCatalog: createAgentToolCatalog('1', [
        {
          id: 'users.get',
          name: 'get_user',
          title: 'Get user',
          description: 'Returns one masked user.',
          contractVersion: '1',
          requiredPermissions: ['admin:users:read'],
          riskLevel: 'low',
          requiredScope: 'agent:read',
          schemaDigest: 'sha256:test',
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
    const server = createAgentAccessMcpSdkServer(application, () => context);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          {
            name: 'get_user',
            execution: { taskSupport: 'forbidden' },
            _meta: { 'com.authrim/toolId': 'users.get' },
          },
        ],
      });
      await expect(client.callTool({ name: 'get_user', arguments: {} })).resolves.toMatchObject({
        structuredContent: { id: 'user-1' },
        isError: false,
      });
      await expect(client.listResources()).resolves.toMatchObject({
        resources: [{ uri: 'authrim://agent/capabilities' }],
      });
      await expect(
        client.readResource({ uri: 'authrim://agent/capabilities' })
      ).resolves.toMatchObject({ contents: [{ text: '{}' }] });
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
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('advertises and coalesces list-changed notifications when the effective set changes', async () => {
    let currentContext = context;
    const authorizationTool = {
      id: 'context.read',
      name: 'context_read',
      title: 'Read context',
      description: 'Internal authorization contract.',
      contractVersion: '1',
      requiredPermissions: ['admin:users:read'],
      riskLevel: 'low' as const,
      requiredScope: 'agent:read' as const,
      schemaDigest: 'sha256:context',
      inputSchema: { type: 'object' },
      taskSupport: 'forbidden' as const,
    };
    const application = createAgentAccessMcpServer({
      toolCatalog: createAgentToolCatalog('1', [authorizationTool]),
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

  it('maps an operation-bound elevation challenge to MCP URL elicitation -32042', async () => {
    const application = createAgentAccessMcpServer({
      toolCatalog: createAgentToolCatalog('1', [
        {
          id: 'admin.write.users.suspend',
          name: 'suspend_user',
          title: 'Suspend user',
          description: 'Suspends one user after human approval.',
          contractVersion: '1',
          requiredPermissions: ['admin:users:suspend'],
          riskLevel: 'high',
          requiredScope: 'agent:write',
          schemaDigest: 'sha256:test',
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

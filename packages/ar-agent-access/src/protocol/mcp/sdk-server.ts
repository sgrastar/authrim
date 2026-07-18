import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  UrlElicitationRequiredError,
} from '@modelcontextprotocol/sdk/types.js';
import type { JsonObject } from '../../core';
import type { AgentAccessMcpRequestContext, AgentAccessMcpServer } from './server';

export type AgentAccessMcpContextProvider = () =>
  | AgentAccessMcpRequestContext
  | Promise<AgentAccessMcpRequestContext>;

/**
 * Adapts the platform-neutral Agent Access MCP definition to the official MCP TypeScript SDK.
 * This module deliberately has no Cloudflare or Agents SDK dependency and can be reused by a
 * future AWS transport adapter.
 */
export function createAgentAccessMcpSdkServer(
  application: AgentAccessMcpServer,
  contextProvider: AgentAccessMcpContextProvider
): Server {
  const server = new Server(
    { name: 'authrim-agent-access', version: '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions:
        'Use Authrim Agent Access tools only within the delegated tenant and approved plan.',
    }
  );

  let previousFingerprints: { tools: string; resources: string; prompts: string } | undefined;

  async function contextWithListChangeNotifications() {
    const context = await contextProvider();
    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
      application.listTools(context),
      application.listResources(context),
      application.listResourceTemplates(context),
      application.listPrompts(context),
    ]);
    const fingerprints = {
      tools: JSON.stringify(
        tools.map((tool) => [tool.id, tool.contractVersion, tool.schemaDigest, tool.riskLevel])
      ),
      resources: JSON.stringify([
        ...resources.map((resource) => resource.uri),
        ...resourceTemplates.map((template) => template.uriTemplate),
      ]),
      prompts: JSON.stringify(prompts.map((prompt) => prompt.name)),
    };
    const previous = previousFingerprints;
    previousFingerprints = fingerprints;
    if (previous) {
      const notifications: Promise<void>[] = [];
      if (previous.tools !== fingerprints.tools) notifications.push(server.sendToolListChanged());
      if (previous.resources !== fingerprints.resources) {
        notifications.push(server.sendResourceListChanged());
      }
      if (previous.prompts !== fingerprints.prompts) {
        notifications.push(server.sendPromptListChanged());
      }
      await Promise.allSettled(notifications);
    }
    return { context, tools, resources, resourceTemplates, prompts };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await contextWithListChangeNotifications();
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        execution: { taskSupport: tool.taskSupport ?? 'forbidden' },
        _meta: {
          ...tool.protocolMetadata,
          'com.authrim/toolId': tool.id,
          'com.authrim/contractVersion': tool.contractVersion,
          'com.authrim/requiresElevation': tool.riskLevel === 'high',
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.task) {
      return {
        content: [{ type: 'text' as const, text: 'MCP task augmentation is not supported' }],
        isError: true,
      };
    }
    const input = (request.params.arguments ?? {}) as JsonObject;
    const { context } = await contextWithListChangeNotifications();
    const result = await application.callTool(context, request.params.name, input, {
      idempotencyKey:
        typeof request.params._meta?.['com.authrim/idempotencyKey'] === 'string'
          ? request.params._meta['com.authrim/idempotencyKey']
          : undefined,
      elevationChallengeId:
        typeof request.params._meta?.['com.authrim/elevationChallengeId'] === 'string'
          ? request.params._meta['com.authrim/elevationChallengeId']
          : undefined,
    });
    if (result.urlElicitation) {
      throw new UrlElicitationRequiredError([
        {
          mode: 'url',
          elicitationId: result.urlElicitation.elicitationId,
          url: result.urlElicitation.url,
          message: result.urlElicitation.message,
        },
      ]);
    }
    return {
      content: [...result.content],
      structuredContent: result.structuredContent,
      isError: result.isError,
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const { resources } = await contextWithListChangeNotifications();
    return {
      resources: resources.map(
        ({ read: _read, authorizationTool: _authorizationTool, ...resource }) => resource
      ),
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const { resourceTemplates: templates } = await contextWithListChangeNotifications();
    return {
      resourceTemplates: templates.map(
        ({ read: _read, match: _match, authorizationTool: _authorizationTool, ...template }) =>
          template
      ),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { context } = await contextWithListChangeNotifications();
    return { contents: [await application.readResource(context, request.params.uri)] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const { prompts } = await contextWithListChangeNotifications();
    return {
      prompts: prompts.map(
        ({ get: _get, authorizationTool: _authorizationTool, arguments: args, ...prompt }) => ({
          ...prompt,
          arguments: args,
        })
      ),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { context } = await contextWithListChangeNotifications();
    const result = await application.getPrompt(
      context,
      request.params.name,
      request.params.arguments
    );
    return {
      description: result.description,
      messages: result.messages.map((message) => ({
        role: message.role,
        content: { ...message.content },
      })),
    };
  });

  return server;
}

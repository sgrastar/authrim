import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealAgentToolDefinition, type AgentToolDefinition } from '../core';
import { createAgentAccessMcpSdkServer } from '../protocol/mcp/sdk-server';
import type {
  AgentAccessMcpPromptDefinition,
  AgentAccessMcpResourceDefinition,
  AgentAccessMcpResourceTemplateDefinition,
  AgentAccessMcpServer,
  AgentAccessMcpToolResult,
} from '../protocol/mcp/server';
import { LOW_TOOL, makeContext } from './helpers/mut-mcp-harness';

const seal = (extra: Partial<AgentToolDefinition> = {}) =>
  sealAgentToolDefinition({ ...LOW_TOOL, ...extra });
const authTool = seal();
const resource = (uri: string): AgentAccessMcpResourceDefinition => ({
  uri,
  name: 'res',
  title: 'Res',
  description: 'A resource',
  mimeType: 'application/json',
  authorizationTool: authTool,
  read: async () => ({ uri, text: '{}' }),
});
const template = (uriTemplate: string): AgentAccessMcpResourceTemplateDefinition => ({
  uriTemplate,
  name: 'tpl',
  title: 'Tpl',
  description: 'A template',
  mimeType: 'application/json',
  authorizationTool: authTool,
  match: () => null,
  read: async (_c, uri) => ({ uri }),
});
const prompt = (name: string): AgentAccessMcpPromptDefinition => ({
  name,
  title: 'Prompt',
  description: 'A prompt',
  arguments: [{ name: 'goal', description: 'Goal', required: true }],
  authorizationTool: authTool,
  get: async () => ({ messages: [] }),
});

interface State {
  tools: AgentToolDefinition[];
  resources: AgentAccessMcpResourceDefinition[];
  templates: AgentAccessMcpResourceTemplateDefinition[];
  prompts: AgentAccessMcpPromptDefinition[];
  callResult: AgentAccessMcpToolResult;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function connect(initial: Partial<State> = {}) {
  const state: State = {
    tools: [seal()],
    resources: [resource('authrim://r/1')],
    templates: [template('authrim://t/{a}')],
    prompts: [prompt('p1')],
    callResult: { content: [{ type: 'text', text: 'ok' }] },
    ...initial,
  };
  const callTool = vi.fn(async () => state.callResult);
  const readResource = vi.fn(async (_c: unknown, uri: string) => ({
    uri,
    text: 'x',
    metadata: { source: 'resource' },
  }));
  const getPrompt = vi.fn(async () => ({
    description: 'desc',
    metadata: { source: 'prompt' },
    messages: [{ role: 'assistant' as const, content: { type: 'text' as const, text: 'm' } }],
  }));
  const application: AgentAccessMcpServer = {
    protocolRevision: '2025-11-25',
    listTools: async () => state.tools,
    callTool,
    listResources: async () => state.resources,
    listResourceTemplates: async () => state.templates,
    readResource,
    listPrompts: async () => state.prompts,
    getPrompt,
  };
  const server = createAgentAccessMcpSdkServer(application, () => makeContext());
  const client = new Client({ name: 'test-client', version: '1.0.0' });
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
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await Promise.all([client.close(), server.close()]);
  });
  return { client, state, notifications, callTool, readResource, getPrompt };
}

describe('MCP SDK adapter', () => {
  it('tells the client to stay within the delegated tenant and start from the essential profile', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toBe(
      'Use Authrim Agent Access tools only within the delegated tenant and approved plan. Start with the essential Tool profile and call set_active_tool_profiles when another granted domain is needed; profiles never add authority.'
    );
  });

  it('publishes compact schemas, annotations and elevation metadata only when present', async () => {
    const high = seal({
      id: 'h',
      name: 'high_tool',
      riskLevel: 'high',
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
      outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
      annotations: { readOnlyHint: false },
      protocolMetadata: { 'com.authrim/planStepAllowed': true },
    });
    const { client } = await connect({ tools: [seal(), high] });
    const { tools } = await client.listTools();
    expect(tools[0]).toStrictEqual({
      name: 'get_user',
      description: 'Returns a masked user.',
      inputSchema: LOW_TOOL.inputSchema,
    });
    expect(tools[1]).toStrictEqual({
      name: 'high_tool',
      description: 'Returns a masked user.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      annotations: { readOnlyHint: false },
      _meta: { 'com.authrim/planStepAllowed': true, 'com.authrim/requiresElevation': true },
    });
  });

  it('refuses task-augmented tool calls without invoking the application', async () => {
    const { client, callTool } = await connect();
    // The SDK refuses task creation before the adapter's own guard because no tasks capability is
    // advertised; either way the application must never run a task-augmented call.
    await expect(
      client.request(
        { method: 'tools/call', params: { name: 'get_user', arguments: {}, task: { ttl: 1000 } } },
        CallToolResultSchema
      )
    ).rejects.toThrow(/task/u);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('forwards only string idempotency and elevation metadata', async () => {
    const { client, callTool } = await connect();
    await client.callTool({
      name: 'get_user',
      arguments: { user_id: 'u' },
      _meta: { 'com.authrim/idempotencyKey': 'idem', 'com.authrim/elevationChallengeId': 'ch' },
    });
    await client.callTool({
      name: 'get_user',
      _meta: { 'com.authrim/idempotencyKey': 5, 'com.authrim/elevationChallengeId': true },
    });
    expect(callTool.mock.calls[0]).toEqual([
      makeContext(),
      'get_user',
      { user_id: 'u' },
      { idempotencyKey: 'idem', elevationChallengeId: 'ch' },
    ]);
    expect(callTool.mock.calls[1]?.slice(2)).toEqual([
      {},
      { idempotencyKey: undefined, elevationChallengeId: undefined },
    ]);
  });

  it('maps tool results including provenance metadata', async () => {
    const { client } = await connect({
      callResult: {
        content: [{ type: 'text', text: '{"a":1}' }],
        structuredContent: { a: 1 },
        isError: false,
        metadata: { provenance: 'x' },
      },
    });
    expect(await client.callTool({ name: 'get_user', arguments: {} })).toStrictEqual({
      content: [{ type: 'text', text: '{"a":1}' }],
      structuredContent: { a: 1 },
      isError: false,
      _meta: { provenance: 'x' },
    });
  });

  it('strips internal fields from resources, templates and prompts', async () => {
    const { client, readResource, getPrompt } = await connect();
    expect((await client.listResources()).resources).toStrictEqual([
      {
        uri: 'authrim://r/1',
        name: 'res',
        title: 'Res',
        description: 'A resource',
        mimeType: 'application/json',
      },
    ]);
    expect((await client.listResourceTemplates()).resourceTemplates).toStrictEqual([
      {
        uriTemplate: 'authrim://t/{a}',
        name: 'tpl',
        title: 'Tpl',
        description: 'A template',
        mimeType: 'application/json',
      },
    ]);
    expect((await client.listPrompts()).prompts).toStrictEqual([
      {
        name: 'p1',
        title: 'Prompt',
        description: 'A prompt',
        arguments: [{ name: 'goal', description: 'Goal', required: true }],
      },
    ]);
    expect(await client.readResource({ uri: 'authrim://r/1' })).toStrictEqual({
      contents: [{ uri: 'authrim://r/1', text: 'x', _meta: { source: 'resource' } }],
    });
    expect(readResource).toHaveBeenCalledWith(makeContext(), 'authrim://r/1');
    expect(await client.getPrompt({ name: 'p1', arguments: { goal: 'g' } })).toStrictEqual({
      description: 'desc',
      _meta: { source: 'prompt' },
      messages: [{ role: 'assistant', content: { type: 'text', text: 'm' } }],
    });
    expect(getPrompt).toHaveBeenCalledWith(makeContext(), 'p1', { goal: 'g' });
  });

  it.each([
    ['tools', (s: State) => (s.tools = [seal({ contractVersion: '2' })])],
    ['tools', (s: State) => (s.tools = [seal({ riskLevel: 'standard' })])],
    ['tools', (s: State) => (s.tools = [seal({ id: 'other.id' })])],
    ['resources', (s: State) => (s.resources = [resource('authrim://r/2')])],
    ['resources', (s: State) => (s.templates = [template('authrim://t2/{a}')])],
    ['prompts', (s: State) => (s.prompts = [prompt('p2')])],
  ])('notifies %s/list_changed when an entry changes in place', async (kind, mutate) => {
    const { client, state, notifications } = await connect();
    await client.listTools();
    mutate(state);
    await client.listTools();
    await vi.waitFor(() => expect(notifications).toEqual([kind]));
  });
});

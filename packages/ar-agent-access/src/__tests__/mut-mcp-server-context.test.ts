import { describe, expect, it, vi } from 'vitest';
import { sealAgentToolDefinition, type AgentAuthorizationDecision } from '../core';
import type {
  AgentAccessMcpPromptDefinition,
  AgentAccessMcpResourceDefinition,
  AgentAccessMcpResourceTemplateDefinition,
} from '../protocol/mcp/server';
import { ALLOW, LOW_TOOL, createHarness, makeContext } from './helpers/mut-mcp-harness';

const authTool = (id: string) => sealAgentToolDefinition({ ...LOW_TOOL, id, name: id });
const DENY: AgentAuthorizationDecision = {
  allowed: false,
  requiresElevation: false,
  deniedAxis: 'resource',
};
const ELEVATION_ONLY: AgentAuthorizationDecision = { allowed: false, requiresElevation: true };

function fixtures() {
  const staticRead = vi.fn(async (_c: unknown, uri: string) => ({ uri, text: 'static' }));
  const templateRead = vi.fn(async (_c: unknown, uri: string) => ({ uri, text: 'templated' }));
  const promptGet = vi.fn(async () => ({
    description: 'd',
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'hi' } }],
  }));
  const resources: AgentAccessMcpResourceDefinition[] = [
    {
      uri: 'authrim://a/v1',
      name: 'res_a',
      title: 'A',
      description: 'A',
      mimeType: 'text/plain',
      authorizationTool: authTool('auth.a'),
      read: staticRead,
    },
    {
      uri: 'authrim://b/v1',
      name: 'res_b',
      title: 'B',
      description: 'B',
      mimeType: 'text/plain',
      authorizationTool: authTool('auth.b'),
      read: staticRead,
    },
    {
      uri: 'authrim://t/static',
      name: 'res_shadow',
      title: 'S',
      description: 'Static resource inside a template namespace',
      mimeType: 'text/plain',
      authorizationTool: authTool('auth.b'),
      read: staticRead,
    },
  ];
  const resourceTemplates: AgentAccessMcpResourceTemplateDefinition[] = [
    {
      uriTemplate: 'authrim://t/{id}',
      name: 'tpl_t',
      title: 'T',
      description: 'T',
      mimeType: 'text/plain',
      authorizationTool: authTool('auth.t'),
      match: (context, uri) =>
        uri.startsWith('authrim://t/') ? { ...context.resource, resourceId: uri.slice(12) } : null,
      read: templateRead,
    },
    {
      uriTemplate: 'authrim://u/{id}',
      name: 'tpl_u',
      title: 'U',
      description: 'U',
      mimeType: 'text/plain',
      authorizationTool: authTool('auth.u'),
      match: () => null,
      read: templateRead,
    },
  ];
  const prompts: AgentAccessMcpPromptDefinition[] = [
    {
      name: 'p_a',
      title: 'P',
      description: 'P',
      authorizationTool: authTool('auth.a'),
      get: promptGet,
    },
    {
      name: 'p_b',
      title: 'P',
      description: 'P',
      authorizationTool: authTool('auth.b'),
      get: promptGet,
    },
  ];
  return { resources, resourceTemplates, prompts, staticRead, templateRead, promptGet };
}

function harness(decide: (toolId: string) => AgentAuthorizationDecision = () => ALLOW) {
  const f = fixtures();
  const h = createHarness({
    authorize: async ({ tool }) => decide(tool.id),
    extra: { resources: f.resources, resourceTemplates: f.resourceTemplates, prompts: f.prompts },
  });
  return { ...h, ...f };
}
const onlyA = (id: string) => (id === 'auth.a' || id === 'auth.t' ? ALLOW : ELEVATION_ONLY);

describe('MCP resources', () => {
  it('lists only directly allowed resources, templates and prompts (elevation is not enough)', async () => {
    const h = harness(onlyA);
    const context = makeContext();
    expect((await h.server.listResources(context)).map((item) => item.name)).toEqual(['res_a']);
    expect((await h.server.listResourceTemplates(context)).map((item) => item.name)).toEqual([
      'tpl_t',
    ]);
    expect((await h.server.listPrompts(context)).map((item) => item.name)).toEqual(['p_a']);
  });

  it('reads a static resource with provenance metadata and audits the read', async () => {
    const h = harness();
    const contents = await h.server.readResource(makeContext(), 'authrim://b/v1');
    expect(contents).toStrictEqual({
      uri: 'authrim://b/v1',
      text: 'static',
      metadata: {
        'com.authrim/dataProvenance': {
          source: 'resource',
          trust_level: 'tenant_data_untrusted',
          sensitivity: 'configuration',
          tenant_id: 'tenant-1',
          grant_id: 'grant-1',
          tool_id: 'auth.b',
          correlation_id: 'correlation-1',
          observed_at: 1234,
        },
      },
    });
    expect(h.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ resource: { tenantId: 'tenant-1' } })
    );
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.resource.read',
      outcome: 'success',
      details: { tool_id: 'auth.b', resource_name: 'res_b' },
    });
  });

  it('authorizes a template read against the concrete matched resource', async () => {
    const h = harness();
    const contents = await h.server.readResource(makeContext(), 'authrim://t/abc');
    expect(contents.text).toBe('templated');
    const input = h.authorize.mock.calls[0]?.[0];
    expect(input?.tool.id).toBe('auth.t');
    expect(input?.resource).toEqual({ tenantId: 'tenant-1', resourceId: 'abc' });
    expect(h.staticRead).not.toHaveBeenCalled();
  });

  it('prefers an exact static resource over a matching template', async () => {
    const h = harness();
    expect((await h.server.readResource(makeContext(), 'authrim://t/static')).text).toBe('static');
    expect(h.authorize).toHaveBeenCalledTimes(1);
    const input = h.authorize.mock.calls[0]?.[0];
    expect(input?.tool.id).toBe('auth.b');
    expect(input?.resource).toEqual({ tenantId: 'tenant-1' });
    expect(h.templateRead).not.toHaveBeenCalled();
  });

  it('rejects an unknown resource URI and audits it', async () => {
    const h = harness();
    await expect(h.server.readResource(makeContext(), 'authrim://zzz')).rejects.toThrow(
      new TypeError('Unknown MCP resource')
    );
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.resource.denied',
      outcome: 'denied',
      details: { reason: 'unknown_resource' },
    });
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('denies an unauthorized read without invoking the reader', async () => {
    const h = harness(() => DENY);
    await expect(h.server.readResource(makeContext(), 'authrim://a/v1')).rejects.toThrow(
      'MCP resource access denied'
    );
    expect(h.staticRead).not.toHaveBeenCalled();
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.resource.denied',
      details: { tool_id: 'auth.a', resource_name: 'res_a', denied_axis: 'resource' },
    });
  });

  it('defaults the denied axis to unknown', async () => {
    const h = harness(() => ({ allowed: false, requiresElevation: false }));
    await expect(h.server.readResource(makeContext(), 'authrim://t/x')).rejects.toThrow();
    expect(h.lastEvent()?.details).toMatchObject({
      resource_name: 'tpl_t',
      denied_axis: 'unknown',
    });
  });

  it('hides reader failures behind a generic error', async () => {
    const h = harness();
    h.staticRead.mockRejectedValueOnce(new Error('db exploded: secret detail'));
    await expect(h.server.readResource(makeContext(), 'authrim://a/v1')).rejects.toThrow(
      new TypeError('MCP resource unavailable')
    );
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.resource.failed',
      outcome: 'failed',
      details: { tool_id: 'auth.a', resource_name: 'res_a' },
    });
  });
});

describe('MCP prompts', () => {
  it('returns server-authored guidance with provenance', async () => {
    const h = harness();
    const result = await h.server.getPrompt(makeContext(), 'p_b', { goal: 'x' });
    expect(h.promptGet).toHaveBeenCalledWith(expect.anything(), { goal: 'x' });
    expect(result.metadata).toMatchObject({
      'com.authrim/dataProvenance': {
        source: 'server_prompt',
        trust_level: 'server_authored',
        sensitivity: 'guidance',
        tool_id: 'auth.b',
      },
    });
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.prompt.get',
      outcome: 'success',
      details: { tool_id: 'auth.b', prompt_name: 'p_b' },
    });
  });

  it('defaults prompt arguments to an empty object', async () => {
    const h = harness();
    await h.server.getPrompt(makeContext(), 'p_a');
    expect(h.promptGet).toHaveBeenCalledWith(expect.anything(), {});
  });

  it('rejects unknown prompts and audits them', async () => {
    const h = harness();
    await expect(h.server.getPrompt(makeContext(), 'nope')).rejects.toThrow(
      new TypeError('Unknown MCP prompt')
    );
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.prompt.denied',
      outcome: 'denied',
      details: { reason: 'unknown_prompt' },
    });
  });

  it('denies unauthorized prompts', async () => {
    const h = harness(() => DENY);
    await expect(h.server.getPrompt(makeContext(), 'p_a')).rejects.toThrow(
      'MCP prompt access denied'
    );
    expect(h.promptGet).not.toHaveBeenCalled();
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.prompt.denied',
      details: { tool_id: 'auth.a', prompt_name: 'p_a', denied_axis: 'resource' },
    });
    const h2 = harness(() => ({ allowed: false, requiresElevation: false }));
    await expect(h2.server.getPrompt(makeContext(), 'p_a')).rejects.toThrow();
    expect(h2.lastEvent()?.details).toMatchObject({ denied_axis: 'unknown' });
  });

  it('hides prompt generation failures', async () => {
    const h = harness();
    h.promptGet.mockRejectedValueOnce(new Error('boom'));
    await expect(h.server.getPrompt(makeContext(), 'p_a')).rejects.toThrow(
      new TypeError('MCP prompt unavailable')
    );
    expect(h.lastEvent()).toMatchObject({
      eventType: 'agent.mcp.prompt.failed',
      outcome: 'failed',
      details: { tool_id: 'auth.a', prompt_name: 'p_a' },
    });
  });
});

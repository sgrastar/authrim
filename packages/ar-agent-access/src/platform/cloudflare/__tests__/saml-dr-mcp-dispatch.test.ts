import { describe, expect, it, vi } from 'vitest';
vi.mock('agents/mcp', () => ({ McpAgent: class {} }));
import { createCoveredCloudflareMcpApplication } from '../mcp-agent';
import type { AgentAccessMcpServer } from '../../../protocol/mcp';

const methods = [
  'listTools',
  'callTool',
  'listResources',
  'listResourceTemplates',
  'readResource',
  'listPrompts',
  'getPrompt',
] as const;
function application() {
  return {
    protocolRevision: '2025-11-25',
    ...Object.fromEntries(methods.map((method) => [method, vi.fn(async () => [])])),
  } as unknown as AgentAccessMcpServer;
}
const context = { waitUntil: vi.fn() };

describe('MCP application dispatch source admission', () => {
  it.each(methods)('guards %s independently of an already-open SDK transport', async (method) => {
    const app = application();
    const guarded = createCoveredCloudflareMcpApplication(
      { ENABLE_SAML_DR_EXPORT: 'true' },
      context,
      () => app
    );
    const dispatch = guarded[method] as (...args: unknown[]) => Promise<unknown>;
    await expect(dispatch({}, 'name', {})).rejects.toThrow('saml_dr_writer_unavailable');
    expect(app[method]).not.toHaveBeenCalled();
  });
  it('preserves the application and environment while disabled', async () => {
    const app = application();
    const callTool = vi.fn(async () => ({ content: [] }));
    app.callTool = callTool;
    const env = { ENABLE_SAML_DR_EXPORT: 'false' };
    const factory = vi.fn(() => app);
    const guarded = createCoveredCloudflareMcpApplication(env, context, factory);
    await guarded.callTool({} as never, 'probe', {});
    expect(factory).toHaveBeenCalledExactlyOnceWith(env);
    expect(callTool).toHaveBeenCalledExactlyOnceWith({}, 'probe', {});
  });
  it('holds one permit until the awaited tool write finishes and builds its dependencies from the covered env', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const order: string[] = [];
    const app = application();
    app.callTool = vi.fn(async () => {
      order.push('write-start');
      await gate;
      order.push('write-finish');
      return { content: [] };
    });
    const env = {
      ENABLE_SAML_DR_EXPORT: 'true',
      SAML_DR_MUTATION_CONTROL: {
        acquireEnvironmentBackupMutationPermit: vi.fn(async () => {
          order.push('acquire');
          return { admitted: true };
        }),
        completeEnvironmentBackupMutationPermit: vi.fn(async () => {
          order.push('complete');
        }),
      },
    };
    const factory = vi.fn(() => app);
    const guarded = createCoveredCloudflareMcpApplication(env, context, factory);
    const pending = guarded.callTool({} as never, 'write', {});
    await vi.waitFor(() => expect(order).toEqual(['acquire', 'write-start']));
    expect(factory.mock.calls[1]?.[0]).not.toBe(env);
    finish();
    await pending;
    expect(order).toEqual(['acquire', 'write-start', 'write-finish', 'complete']);
  });
});

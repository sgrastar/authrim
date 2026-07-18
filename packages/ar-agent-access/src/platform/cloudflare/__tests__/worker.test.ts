import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    static serve() {
      return { fetch: () => Promise.resolve(new Response(null, { status: 501 })) };
    }
  },
}));

let worker: (typeof import('../worker'))['default'];
let AgentAccessMcpAgent: (typeof import('../worker'))['AgentAccessMcpAgent'];

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe('Agent Access Cloudflare composition root', () => {
  beforeAll(async () => {
    ({ default: worker, AgentAccessMcpAgent } = await import('../worker'));
  });

  it('exports the McpAgent Durable Object class expected by wrangler', () => {
    expect(AgentAccessMcpAgent).toBeTypeOf('function');
  });

  it('serves readiness without entering MCP authentication', async () => {
    const response = await worker.fetch!(
      new Request('https://issuer.example/health/ready'),
      {} as never,
      context
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ service: 'ar-agent-access' });
  });

  it('does not expose non-MCP application routes', async () => {
    const response = await worker.fetch!(
      new Request('https://issuer.example/api/admin/users'),
      {} as never,
      context
    );
    expect(response.status).toBe(404);
  });
});

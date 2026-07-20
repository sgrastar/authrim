import { describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    static serve() {
      return { fetch: () => Promise.resolve(new Response(null, { status: 501 })) };
    }
  },
}));

import worker, { AgentAccessMcpAgent, runAgentAccessScheduledTasks } from '../worker';

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe('Agent Access Cloudflare composition root', () => {
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

  it('runs every scheduled coordinator and surfaces all failures to Workers observability', async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error('evaluation failed'));
    const remediation = vi.fn().mockResolvedValue([]);
    const bulk = vi.fn().mockRejectedValue(new Error('bulk failed'));

    await expect(
      runAgentAccessScheduledTasks({
        evaluateBaselines: evaluate,
        runBaselineRemediation: remediation,
        runBulkPlans: bulk,
      })
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(remediation).toHaveBeenCalledOnce();
    expect(bulk).toHaveBeenCalledOnce();
  });
});

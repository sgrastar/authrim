import { describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    static serve() {
      return { fetch: () => Promise.resolve(new Response(null, { status: 501 })) };
    }
  },
}));

import worker, {
  AgentAccessMcpAgent,
  checkAgentAccessReadiness,
  runAgentAccessScheduledTasks,
} from '../worker';

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function readyEnv() {
  const namespace = { idFromName: vi.fn() };
  return {
    DB_ADMIN: {
      query: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      batch: vi.fn(),
      isHealthy: vi.fn(async () => ({ healthy: true, latencyMs: 0, type: 'test' })),
      getType: vi.fn(() => 'test'),
      close: vi.fn(),
    },
    SETTINGS: { get: vi.fn(async () => null) },
    RATE_LIMITER: namespace,
    AGENT_ACCESS_MCP: namespace,
    KEY_MANAGER: namespace,
    DPOP_JTI_STORE: namespace,
    AGENT_DOWNSCOPE: { exchangeAgentAccessToken: vi.fn() },
    AGENT_ELEVATION_ENCRYPTION_KEY: '00'.repeat(32),
    OP_MANAGEMENT: { fetch: vi.fn(async () => new Response(null, { status: 200 })) },
    OP_DISCOVERY: { fetch: vi.fn(async () => new Response(null, { status: 200 })) },
  } as never;
}

describe('Agent Access Cloudflare composition root', () => {
  it('exports the McpAgent Durable Object class expected by wrangler', () => {
    expect(AgentAccessMcpAgent).toBeTypeOf('function');
  });

  it('serves readiness without entering MCP authentication', async () => {
    const response = await worker.fetch!(
      new Request('https://issuer.example/health/ready'),
      readyEnv(),
      context
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ service: 'ar-agent-access' });
  });

  it('fails readiness closed and identifies unavailable dependencies', async () => {
    const readiness = await checkAgentAccessReadiness({} as never);
    expect(readiness.status).toBe('unavailable');
    expect(readiness.checks).toMatchObject({
      database: 'unavailable',
      settings: 'unavailable',
      management: 'unavailable',
      discovery: 'unavailable',
    });
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
    const cleanup = vi.fn().mockResolvedValue(0);

    await expect(
      runAgentAccessScheduledTasks({
        evaluateBaselines: evaluate,
        runBaselineRemediation: remediation,
        runBulkPlans: bulk,
        cleanupMcpSessions: cleanup,
      })
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(remediation).toHaveBeenCalledOnce();
    expect(bulk).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

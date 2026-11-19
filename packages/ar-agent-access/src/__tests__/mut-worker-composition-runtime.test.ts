import { afterEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const recorder = (name: string, members: () => Record<string, unknown> = () => ({})) =>
    class {
      constructor(...args: unknown[]) {
        record(name, args);
        Object.assign(this, members());
      }
    };
  const covered: { env: unknown; context: unknown } = { env: undefined, context: undefined };
  return {
    calls,
    record,
    recorder,
    last: (name: string) => calls[name]?.at(-1) ?? [],
    covered,
    expired: [] as unknown[],
    mcpFetch: vi.fn(async () => new Response('mcp')),
    validate: vi.fn(async () => 'active'),
    destroy: vi.fn(async () => undefined),
  };
});

vi.mock('agents/mcp', () => ({ McpAgent: class {} }));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer', () => ({
  runSamlDrCoveredFetch: (_env: unknown, _ctx: unknown, fn: (e: unknown, c: unknown) => unknown) =>
    fn(rec.covered.env, rec.covered.context),
  runSamlDrCoveredOperation: (env: unknown, _ctx: unknown, fn: (e: unknown) => unknown) => fn(env),
}));
vi.mock('../platform/cloudflare/mcp-agent', async (original) => ({
  ...(await original<typeof import('../platform/cloudflare/mcp-agent')>()),
  createCloudflareAgentAccessMcpAgent: () => class {},
  validateCloudflareAgentAccessMcpSession: rec.validate,
  destroyCloudflareAgentAccessMcpSession: rec.destroy,
}));
vi.mock('../platform/cloudflare/mcp-admission', async (original) => ({
  ...(await original<typeof import('../platform/cloudflare/mcp-admission')>()),
  createCloudflareAgentAccessMcpWorker: (agent: unknown, options: unknown) => {
    rec.record('workerOptions', [agent, options]);
    return { fetch: rec.mcpFetch };
  },
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  requireDedicatedAdminDatabaseAdapter: (_env: unknown, name: string) => ({ database: name }),
}));
vi.mock('../core', async (original) => ({
  ...(await original<typeof import('../core')>()),
  AdminAgentAccessRepository: rec.recorder('AdminAgentAccessRepository'),
  AgentBulkRepository: rec.recorder('AgentBulkRepository'),
  AgentBaselineRepository: rec.recorder('AgentBaselineRepository'),
}));
vi.mock('../platform/cloudflare/tenant-settings', () => ({
  CloudflareAgentSettingsProvider: rec.recorder('CloudflareAgentSettingsProvider', () => ({
    get: async (tenantId: string) => ({ tenantId }),
  })),
}));
vi.mock('../platform/cloudflare/mcp-session-registry', () => ({
  CloudflareAgentMcpSessionRegistry: rec.recorder('CloudflareAgentMcpSessionRegistry', () => ({
    listExpired: vi.fn(async (...args: unknown[]) => {
      rec.record('listExpired', args);
      return rec.expired;
    }),
    delete: vi.fn(async (...args: unknown[]) => rec.record('registryDelete', args)),
  })),
}));
vi.mock('../platform/cloudflare/durable-object-rate-limiter', () => ({
  CloudflareDurableObjectRateLimiter: rec.recorder('CloudflareDurableObjectRateLimiter'),
}));
vi.mock('../platform/cloudflare/mcp-admission-audit', () => ({
  CloudflareAgentMcpAdmissionAuditAdapter: rec.recorder('CloudflareAgentMcpAdmissionAuditAdapter'),
}));
vi.mock('../platform/cloudflare/bulk-plans', () => ({
  CloudflareAgentBulkCoordinator: rec.recorder('CloudflareAgentBulkCoordinator', () => ({
    runScheduled: async () => rec.record('bulkRun', []),
  })),
}));
vi.mock('../platform/cloudflare/baseline-remediation', () => ({
  CloudflareAgentBaselineRemediationCoordinator: rec.recorder('BaselineCoordinator', () => ({
    evaluateScheduled: async () => rec.record('baselineEvaluate', []),
    runScheduled: async () => rec.record('baselineRun', []),
  })),
}));
vi.mock('../platform/cloudflare/service-binding', async (original) => ({
  ...(await original<typeof import('../platform/cloudflare/service-binding')>()),
  CloudflareServiceBindingBulkChildExecutor: rec.recorder('BulkChildExecutor'),
}));

import worker, {
  SAML_DR_WRITER_SURFACES,
  cleanupExpiredAgentAccessMcpSessions,
  runAgentAccessScheduledTasks,
} from '../platform/cloudflare/worker';

type Options = {
  binding: string;
  authenticate: unknown;
  validateSession(id: string, env: unknown, props: unknown): Promise<unknown>;
  resolveAllowedOrigin(request: Request, env: unknown): string | null;
  controls: Record<string, (...args: never[]) => unknown>;
};
const options = rec.last('workerOptions')[1] as Options;
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
}

afterEach(() => {
  vi.useRealTimers();
});

/** The Workers runtime hands fetch an incoming request whose cf carries IncomingRequestCfProperties. */
type IncomingRequest = Parameters<NonNullable<typeof worker.fetch>>[0];

function incoming(url: string): IncomingRequest {
  return new Request(url) as IncomingRequest;
}

describe('MCP worker options', () => {
  it('uses the AGENT_ACCESS_MCP binding and validates sessions against it', async () => {
    expect(options.binding).toBe('AGENT_ACCESS_MCP');
    const props = { context: { grant: { tenantId: 't-1' } } };
    await options.validateSession('s-1', { AGENT_ACCESS_MCP: 'ns' }, props);
    expect(rec.validate).toHaveBeenCalledWith({
      namespace: 'ns',
      sessionId: 's-1',
      context: props.context,
    });
  });

  it('builds controls from the environment bindings', async () => {
    const env = { RATE_LIMITER: 'rl', AGENT_ACCESS_MCP: 'ns' };
    const c = options.controls as Record<string, (...args: unknown[]) => unknown>;
    await expect(c.getSettings(env, { context: { grant: { tenantId: 't-9' } } })).resolves.toEqual({
      tenantId: 't-9',
    });
    expect(rec.last('CloudflareAgentSettingsProvider')).toEqual([env]);
    c.getRateLimiter(env);
    expect(rec.last('CloudflareDurableObjectRateLimiter')).toEqual(['rl']);
    c.getAdmissionAudit(env);
    expect(rec.last('AdminAgentAccessRepository')[0]).toEqual({
      database: 'agent-access-mcp-admission-audit',
    });
    expect(rec.last('CloudflareAgentMcpAdmissionAuditAdapter')).toHaveLength(1);
    c.getSessionRegistry(env);
    expect(rec.last('CloudflareAgentMcpSessionRegistry')).toEqual([
      { database: 'agent-access-mcp-session-registry' },
    ]);
    await c.destroySession('s-2', env);
    expect(rec.destroy).toHaveBeenLastCalledWith({ namespace: 'ns', sessionId: 's-2' });
  });

  it.each([
    [undefined, 1200],
    ['60', 60],
    ['60000', 60_000],
    ['59', 1200],
    ['60001', 1200],
    ['75.5', 1200],
  ])('maps a pre-auth limit of %s to %s', (configured, expected) => {
    const c = options.controls as Record<string, (...args: unknown[]) => unknown>;
    expect(
      c.getPreAuthRateLimitPerMinute({ AGENT_MCP_PREAUTH_RATE_LIMIT_PER_MINUTE: configured })
    ).toBe(expected);
  });

  it.each([
    [undefined, undefined, null],
    ['https://auth.example', undefined, 'https://auth.example'],
    ['https://app.example', 'https://app.example', 'https://app.example'],
    ['https://evil.example', 'https://app.example', null],
  ])('resolves Origin %s with allow-list %s to %s', (origin, allowed, expected) => {
    const request = new Request('https://auth.example/mcp', {
      headers: origin ? { origin } : {},
    });
    expect(options.resolveAllowedOrigin(request, { ALLOWED_ORIGINS: allowed })).toBe(expected);
  });
});

describe('worker fetch routing', () => {
  it.each(['/health/live', '/api/health'])('answers liveness on %s', async (path) => {
    const response = await worker.fetch!(
      incoming(`https://a.example${path}`),
      {} as never,
      context
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', service: 'ar-agent-access' });
  });

  it('answers readiness failures with 503 and no-store', async () => {
    const response = await worker.fetch!(
      incoming('https://a.example/health/ready'),
      {} as never,
      context
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('dispatches /mcp with the covered environment and context when provided', async () => {
    const env = { name: 'raw' } as never;
    rec.covered = { env: { name: 'covered' }, context: { covered: true } };
    try {
      await worker.fetch!(incoming('https://a.example/mcp'), env, context);
      expect(rec.mcpFetch).toHaveBeenLastCalledWith(
        expect.any(Request),
        { name: 'covered' },
        {
          covered: true,
        }
      );
    } finally {
      rec.covered = { env: undefined, context: undefined };
    }
    await worker.fetch!(incoming('https://a.example/mcp'), env, context);
    expect(rec.mcpFetch).toHaveBeenLastCalledWith(expect.any(Request), env, context);
  });

  it('answers 404 for /mcp sub-paths without entering MCP', async () => {
    rec.mcpFetch.mockClear();
    const response = await worker.fetch!(incoming('https://a.example/mcp/x'), {} as never, context);
    expect(response.status).toBe(404);
    expect(rec.mcpFetch).not.toHaveBeenCalled();
  });

  it('declares the fetch and scheduled SAML DR writer surfaces', () => {
    expect(SAML_DR_WRITER_SURFACES).toEqual(['fetch', 'scheduled']);
  });
});

describe('scheduled work', () => {
  it('runs baseline evaluation, remediation, bulk plans and session cleanup', async () => {
    rec.expired = [];
    for (const key of [
      'baselineEvaluate',
      'baselineRun',
      'bulkRun',
      'listExpired',
      'AgentBulkRepository',
    ])
      rec.calls[key] = [];
    const env = { AGENT_ACCESS_MCP: 'ns', OP_MANAGEMENT: 'mgmt', AGENT_DOWNSCOPE: 'down' };
    await worker.scheduled!({} as ScheduledController, env as never, context);
    expect(rec.calls.baselineEvaluate).toHaveLength(1);
    expect(rec.calls.baselineRun).toHaveLength(1);
    expect(rec.calls.bulkRun).toHaveLength(1);
    expect(rec.calls.listExpired).toHaveLength(1);
    expect(rec.calls.AgentBulkRepository?.map(([db]) => db)).toEqual([
      { database: 'agent-baseline-remediation' },
      { database: 'agent-bulk-coordinator' },
    ]);
    expect(rec.last('AgentBaselineRepository')[0]).toEqual({
      database: 'agent-baseline-remediation',
    });
    const [, , , clock, reader] = rec.last('BaselineCoordinator') as [
      unknown,
      unknown,
      unknown,
      { now(): number },
      unknown,
    ];
    freezeClock();
    expect(clock.now()).toBe(FIXED_NOW);
    expect(reader).toBeDefined();
    const bulkArgs = rec.last('CloudflareAgentBulkCoordinator') as [
      unknown,
      unknown,
      { now(): number },
      { getIssuerOrigin(tenantId: string): string },
    ];
    expect(bulkArgs[2].now()).toBe(FIXED_NOW);
    expect(typeof bulkArgs[3].getIssuerOrigin).toBe('function');
    expect(rec.last('BulkChildExecutor')[0]).toBe('mgmt');
    expect(rec.last('BulkChildExecutor')[2]).toBe('down');
  });

  it('aggregates no error when every scheduled task succeeds', async () => {
    const ok = vi.fn(async () => undefined);
    await expect(
      runAgentAccessScheduledTasks({
        evaluateBaselines: ok,
        runBaselineRemediation: ok,
        runBulkPlans: ok,
        cleanupMcpSessions: ok,
      })
    ).resolves.toBeUndefined();
    const fail = vi.fn(async () => {
      throw new Error('x');
    });
    await expect(
      runAgentAccessScheduledTasks({
        evaluateBaselines: fail,
        runBaselineRemediation: ok,
        runBulkPlans: ok,
        cleanupMcpSessions: ok,
      })
    ).rejects.toThrow('One or more Agent Access scheduled tasks failed');
  });

  it('destroys and deletes each expired session, up to 500 per run', async () => {
    rec.expired = [
      { sessionId: 's-1', tenantId: 't', grantId: 'g', clientId: 'c' },
      { sessionId: 's-2', tenantId: 't', grantId: 'g', clientId: 'c' },
    ];
    rec.calls.registryDelete = [];
    rec.destroy.mockClear();
    await expect(
      cleanupExpiredAgentAccessMcpSessions({ AGENT_ACCESS_MCP: 'ns' } as never, 1_234)
    ).resolves.toBe(2);
    expect(rec.last('listExpired')).toEqual([1_234, 500]);
    expect(rec.last('CloudflareAgentMcpSessionRegistry')).toEqual([
      { database: 'agent-access-mcp-session-cleanup' },
    ]);
    expect(rec.destroy.mock.calls).toEqual([
      [{ namespace: 'ns', sessionId: 's-1' }],
      [{ namespace: 'ns', sessionId: 's-2' }],
    ]);
    expect(rec.calls.registryDelete?.map(([session]) => session)).toEqual(rec.expired);
    rec.expired = [];
    freezeClock();
    await cleanupExpiredAgentAccessMcpSessions({ AGENT_ACCESS_MCP: 'ns' } as never);
    expect(rec.last('listExpired')).toEqual([FIXED_NOW, 500]);
  });
});

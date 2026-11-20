import { describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    static serve() {
      return { fetch: () => Promise.resolve(new Response(null, { status: 501 })) };
    }
  },
}));

import { checkAgentAccessReadiness } from '../platform/cloudflare/worker';

function readyEnv(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

const ALL_OK = {
  database: 'ok',
  settings: 'ok',
  rateLimiter: 'ok',
  mcpSessions: 'ok',
  keyManager: 'ok',
  dpopReplayStore: 'ok',
  downscope: 'ok',
  elevationKey: 'ok',
  management: 'ok',
  discovery: 'ok',
};

describe('checkAgentAccessReadiness', () => {
  it('reports every dependency ready and probes settings and owner health endpoints', async () => {
    const env = readyEnv();
    await expect(checkAgentAccessReadiness(env as never)).resolves.toEqual({
      status: 'ok',
      service: 'ar-agent-access',
      checks: ALL_OK,
    });
    expect(env.SETTINGS.get).toHaveBeenCalledWith('__authrim_agent_access_readiness__');
    const management = env.OP_MANAGEMENT.fetch.mock.calls[0] as unknown as [Request];
    const discovery = env.OP_DISCOVERY.fetch.mock.calls[0] as unknown as [Request];
    expect(management[0].url).toBe('https://management.internal/health/ready');
    expect(discovery[0].url).toBe('https://discovery.internal/health/ready');
  });

  it('falls back to AUTHRIM_CONFIG and accepts function-valued bindings', async () => {
    const callable = Object.assign(() => undefined, { idFromName: vi.fn() });
    const config = { get: vi.fn(async () => null) };
    const result = await checkAgentAccessReadiness(
      readyEnv({ SETTINGS: undefined, AUTHRIM_CONFIG: config, RATE_LIMITER: callable }) as never
    );
    expect(result.checks).toMatchObject({ settings: 'ok', rateLimiter: 'ok' });
    expect(config.get).toHaveBeenCalledOnce();
  });

  it.each([
    ['database', { isHealthyFalse: true }],
    ['settings', { SETTINGS: { get: vi.fn(async () => Promise.reject(new Error('kv'))) } }],
    ['rateLimiter', { RATE_LIMITER: null }],
    ['mcpSessions', { AGENT_ACCESS_MCP: { idFromName: 'not-a-function' } }],
    ['keyManager', { KEY_MANAGER: 'namespace' }],
    ['dpopReplayStore', { DPOP_JTI_STORE: {} }],
    ['downscope', { AGENT_DOWNSCOPE: {} }],
    ['elevationKey', { AGENT_ELEVATION_ENCRYPTION_KEY: 'short' }],
    [
      'management',
      { OP_MANAGEMENT: { fetch: vi.fn(async () => new Response(null, { status: 500 })) } },
    ],
    [
      'discovery',
      { OP_DISCOVERY: { fetch: vi.fn(async () => Promise.reject(new Error('down'))) } },
    ],
    ['management', { OP_MANAGEMENT: {} }],
  ])('reports only %s unavailable', async (name, overrides) => {
    const { isHealthyFalse, ...rest } = overrides as Record<string, unknown>;
    const env = readyEnv(rest);
    if (isHealthyFalse) {
      env.DB_ADMIN.isHealthy.mockResolvedValue({ healthy: false, latencyMs: 0, type: 'test' });
    }
    const result = await checkAgentAccessReadiness(env as never);
    expect(result.status).toBe('unavailable');
    expect(result.checks).toEqual({ ...ALL_OK, [name]: 'unavailable' });
  });

  it('reads the elevation key under the configured version', async () => {
    const versioned = await checkAgentAccessReadiness(
      readyEnv({ AGENT_ELEVATION_KEY_VERSION: 'v3' }) as never
    );
    expect(versioned.checks.elevationKey).toBe('ok');
  });
});

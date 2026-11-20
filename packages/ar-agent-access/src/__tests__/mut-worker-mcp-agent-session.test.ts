import { describe, expect, it, vi } from 'vitest';

const saml = vi.hoisted(() => {
  const state: { coveredEnv: unknown } = { coveredEnv: undefined };
  return state;
});
vi.mock('agents/mcp', () => ({ McpAgent: class {} }));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer', () => ({
  runSamlDrCoveredOperation: (env: unknown, _ctx: unknown, op: (env: unknown) => unknown) =>
    op(saml.coveredEnv ?? env),
  runSamlDrCoveredFetch: vi.fn(),
}));

import {
  AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS,
  AGENT_ACCESS_MCP_SESSION_IDLE_MS,
  SAML_DR_WRITER_SURFACES,
  createCoveredCloudflareMcpApplication,
  destroyCloudflareAgentAccessMcpSession,
  evaluateCloudflareAgentAccessMcpSession,
  toCloudflareAgentAccessSessionBinding,
  validateCloudflareAgentAccessMcpSession,
} from '../platform/cloudflare/mcp-agent';
import type { AgentAccessMcpServer } from '../protocol/mcp';
import { agentContext } from './helpers/mut-worker-agent-context';

const INIT = 1_000_000;
const bound = {
  initializedAt: INIT,
  contextBinding: toCloudflareAgentAccessSessionBinding(agentContext),
};

function evaluate(now: number, state: Record<string, unknown> = {}) {
  return evaluateCloudflareAgentAccessMcpSession({
    state: { ...bound, ...state },
    context: agentContext,
    now,
  });
}

describe('evaluateCloudflareAgentAccessMcpSession clock checks', () => {
  it('is active exactly at initialization and at the last activity instant', () => {
    expect(evaluate(INIT)).toBe('active');
    expect(evaluate(INIT + 10, { lastActivityAt: INIT + 10 })).toBe('active');
  });

  it('falls back to the initialization time when no activity is recorded', () => {
    expect(evaluate(INIT + AGENT_ACCESS_MCP_SESSION_IDLE_MS - 1)).toBe('active');
    expect(evaluate(INIT + AGENT_ACCESS_MCP_SESSION_IDLE_MS)).toBe('expired');
  });

  it('expires a clock earlier than the last activity', () => {
    expect(evaluate(INIT + 5, { lastActivityAt: INIT + 6 })).toBe('expired');
  });

  it('expires a non-integer clock even within the deadlines', () => {
    expect(evaluate(INIT + 0.5)).toBe('expired');
  });

  it('stays active just before the absolute deadline when activity is recent', () => {
    const now = INIT + AGENT_ACCESS_MCP_SESSION_ABSOLUTE_MS - 1;
    expect(evaluate(now, { lastActivityAt: now - 1 })).toBe('active');
  });

  it('requires an initialization time as well as a binding', () => {
    expect(
      evaluateCloudflareAgentAccessMcpSession({
        state: { contextBinding: bound.contextBinding },
        context: agentContext,
        now: INIT,
      })
    ).toBe('not_found');
  });
});

describe('named session Durable Object helpers', () => {
  function namespace(stub: Record<string, unknown>) {
    return {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => stub),
    };
  }

  it('reports unavailable when the Durable Object cannot be reached', async () => {
    const ns = namespace({});
    ns.get.mockImplementation(() => {
      throw new Error('DO unreachable');
    });
    await expect(
      validateCloudflareAgentAccessMcpSession({
        namespace: ns as unknown as DurableObjectNamespace,
        sessionId: 's-1',
        context: agentContext,
      })
    ).resolves.toBe('unavailable');
  });

  it('returns active without scheduling destruction and defaults the clock to now', async () => {
    const stub = {
      setName: vi.fn(async () => undefined),
      getInitializeRequest: vi.fn(async () => ({ method: 'initialize' })),
      validateSessionContextRpc: vi.fn(async () => 'active'),
      _cf_scheduleDestroy: vi.fn(async () => undefined),
    };
    const before = Date.now();
    await expect(
      validateCloudflareAgentAccessMcpSession({
        namespace: namespace(stub) as unknown as DurableObjectNamespace,
        sessionId: 's-1',
        context: agentContext,
      })
    ).resolves.toBe('active');
    const [, now] = stub.validateSessionContextRpc.mock.calls[0] as unknown as [unknown, number];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(stub._cf_scheduleDestroy).not.toHaveBeenCalled();
  });

  it('destroys exactly the named session object', async () => {
    const stub = {
      setName: vi.fn(async () => undefined),
      _cf_scheduleDestroy: vi.fn(async () => undefined),
    };
    const ns = namespace(stub);
    await destroyCloudflareAgentAccessMcpSession({
      namespace: ns as unknown as DurableObjectNamespace,
      sessionId: 's-9',
    });
    expect(ns.idFromName).toHaveBeenCalledWith('streamable-http:s-9');
    expect(ns.get).toHaveBeenCalledWith({ name: 'streamable-http:s-9' });
    expect(stub.setName).toHaveBeenCalledWith('streamable-http:s-9');
    expect(stub._cf_scheduleDestroy).toHaveBeenCalledOnce();
  });
});

describe('createCoveredCloudflareMcpApplication', () => {
  const methods = [
    'listTools',
    'callTool',
    'listResources',
    'listResourceTemplates',
    'readResource',
    'listPrompts',
    'getPrompt',
  ] as const;

  function application(label: string) {
    return Object.fromEntries([
      ['protocolRevision', `rev-${label}`],
      ...methods.map((method) => [
        method,
        vi.fn(async (...args: unknown[]) => ({ label, method, args })),
      ]),
    ]) as unknown as AgentAccessMcpServer;
  }

  it('delegates every MCP operation with its arguments to the application', async () => {
    const env = { name: 'env' };
    const app = application('primary');
    const create = vi.fn(() => app);
    const covered = createCoveredCloudflareMcpApplication(
      env as never,
      { waitUntil: vi.fn() },
      create
    );
    expect(covered.protocolRevision).toBe('rev-primary');
    for (const method of methods) {
      const call = covered[method] as (...args: unknown[]) => Promise<unknown>;
      await expect(call('a', 1)).resolves.toEqual({ label: 'primary', method, args: ['a', 1] });
    }
    expect(create).toHaveBeenCalledOnce();
  });

  it('builds a fresh application for a covered replacement environment', async () => {
    const env = { name: 'env' };
    const replacement = { name: 'covered' };
    const create = vi.fn((target: { name: string }) => application(target.name));
    const covered = createCoveredCloudflareMcpApplication(
      env as never,
      { waitUntil: vi.fn() },
      create
    );
    saml.coveredEnv = replacement;
    try {
      await expect(covered.listTools({} as never)).resolves.toMatchObject({ label: 'covered' });
    } finally {
      saml.coveredEnv = undefined;
    }
    expect(create).toHaveBeenLastCalledWith(replacement);
  });

  it('declares every MCP application surface for the SAML DR writer guard', () => {
    expect(SAML_DR_WRITER_SURFACES).toEqual(
      methods.map((method) => `mcp:AgentAccessMcpAgent.${method}`)
    );
  });
});

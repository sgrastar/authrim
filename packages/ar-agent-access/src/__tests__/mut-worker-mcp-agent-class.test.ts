import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  sdkArgs: [] as unknown[][],
  createDependencies: vi.fn(),
  superConnect: vi.fn(),
}));
vi.mock('agents/mcp', () => ({
  McpAgent: class {
    state: Record<string, unknown> = {};
    props: unknown;
    constructor(
      public ctx: unknown,
      public env: unknown
    ) {}
    setState(state: Record<string, unknown>) {
      this.state = state;
    }
    async onConnect(...args: unknown[]) {
      return fake.superConnect(...args) as unknown;
    }
  },
}));
vi.mock('../protocol/mcp', async (original) => ({
  ...(await original<typeof import('../protocol/mcp')>()),
  createAgentAccessMcpServer: vi.fn((dependencies: unknown) => ({
    protocolRevision: 'test',
    dependencies,
  })),
  createAgentAccessMcpSdkServer: vi.fn((...args: unknown[]) => {
    fake.sdkArgs.push(args);
    return { sdk: true };
  }),
}));

import { createCloudflareAgentAccessMcpAgent } from '../platform/cloudflare/mcp-agent';
import {
  AGENT_ACCESS_INTERNAL_CONTEXT_HEADER,
  encodeCloudflareAgentAccessRequestContext,
  getCloudflareAgentAccessCurrentRequest,
  runWithCloudflareAgentAccessRequest,
} from '../platform/cloudflare/mcp-request-context';
import { toCloudflareAgentAccessSessionBinding } from '../platform/cloudflare/mcp-agent';
import { agentContext, otherGrantContext } from './helpers/mut-worker-agent-context';

type AgentInstance = {
  state: Record<string, unknown>;
  props: unknown;
  init(): Promise<void>;
  updateProps(props?: unknown): Promise<void>;
  onConnect(connection: unknown, context: unknown): Promise<unknown>;
  validateSessionContextRpc(context: unknown, now: number): Promise<string>;
};

function agent() {
  fake.sdkArgs.length = 0;
  const put = vi.fn(async () => undefined);
  const env = { AUTHRIM_ENVIRONMENT_NAME: 'staging-1' };
  const Agent = createCloudflareAgentAccessMcpAgent({
    getEnvironmentName: (target: typeof env) => target.AUTHRIM_ENVIRONMENT_NAME,
    createDependencies: fake.createDependencies.mockImplementation(() => ({ deps: true })),
  });
  const instance = new (Agent as unknown as new (ctx: unknown, env: unknown) => AgentInstance)(
    { storage: { put } },
    env
  );
  const [application, getContext, options] = fake.sdkArgs[0] as [
    { protocolRevision: string },
    () => unknown,
    unknown,
  ];
  return { instance, put, env, application, getContext, options };
}

const binding = toCloudflareAgentAccessSessionBinding(agentContext);

describe('McpAgent shell construction', () => {
  it('builds the SDK server with the environment name and per-session dependencies', async () => {
    const { options, application, env, instance } = agent();
    expect(options).toEqual({ environmentName: 'staging-1' });
    expect(application.protocolRevision).toBe('test');
    const [depEnv, getCurrent, store] = fake.createDependencies.mock.calls.at(-1) as [
      unknown,
      unknown,
      { get(): Promise<unknown>; put(value: unknown): Promise<void> },
    ];
    expect(depEnv).toBe(env);
    expect(getCurrent).toBe(getCloudflareAgentAccessCurrentRequest);
    await store.put({ profileIds: ['p-1'], updatedAt: 5 });
    expect(instance.state).toMatchObject({ discoveryProfileIds: ['p-1'] });
    await expect(store.get()).resolves.toEqual({ profileIds: ['p-1'], updatedAt: 5 });
  });

  it('resolves tool context only from the bound request-local context', () => {
    const { instance, getContext } = agent();
    expect(() => getContext()).toThrow('Agent Access MCP authentication context is unavailable');
    const run = (context: typeof agentContext) =>
      runWithCloudflareAgentAccessRequest({ context, sourceAccessToken: 't' }, () => getContext());
    expect(() => run(agentContext)).toThrow('Agent Access MCP session is not initialized');
    instance.state = { contextBinding: binding };
    expect(run(agentContext)).toBe(agentContext);
    expect(() => run(otherGrantContext())).toThrow(
      'Agent Access MCP token context does not match the bound session'
    );
  });
});

describe('McpAgent props persistence', () => {
  it('stores sanitized props and keeps the source token only in memory', async () => {
    const { instance, put } = agent();
    const props = { context: agentContext, sourceAccessToken: 'secret' };
    await instance.updateProps(props);
    expect(put).toHaveBeenCalledWith('props', { context: agentContext });
    expect(instance.props).toBe(props);
    await instance.updateProps(undefined);
    expect(put).toHaveBeenLastCalledWith('props', {});
    expect(instance.props).toBeUndefined();
  });
});

describe('McpAgent onConnect', () => {
  function connectionContext(headers: Record<string, string>) {
    return { request: new Request('https://auth.example/mcp', { headers }) };
  }
  const validHeaders = {
    authorization: 'DPoP tok-1',
    [AGENT_ACCESS_INTERNAL_CONTEXT_HEADER]: encodeCloudflareAgentAccessRequestContext(agentContext),
  };

  it.each([
    [
      'no authorization',
      {
        [AGENT_ACCESS_INTERNAL_CONTEXT_HEADER]: validHeaders[AGENT_ACCESS_INTERNAL_CONTEXT_HEADER],
      },
    ],
    ['a malformed authorization', { ...validHeaders, authorization: 'Basic tok-1' }],
    ['a token followed by extra text', { ...validHeaders, authorization: 'Bearer tok-1 extra' }],
    ['no internal context', { authorization: 'Bearer tok-1' }],
  ])('refuses a connection with %s', async (_name, headers) => {
    const { instance } = agent();
    instance.state = { initializedAt: Date.now(), contextBinding: binding };
    await expect(
      instance.onConnect({ close: vi.fn() }, connectionContext(headers))
    ).rejects.toThrow('Agent Access request-local authorization context is unavailable');
  });

  it('closes a connection whose session is not active with policy violation 1008', async () => {
    const { instance } = agent();
    const close = vi.fn();
    await expect(instance.onConnect({ close }, connectionContext(validHeaders))).rejects.toThrow(
      'Agent Access MCP session not_found'
    );
    expect(close).toHaveBeenCalledWith(1008, 'Agent Access MCP session not_found');
    expect(fake.superConnect).not.toHaveBeenCalled();
  });

  it('records activity and runs the SDK connection inside the request context', async () => {
    const { instance } = agent();
    const initializedAt = Date.now() - 1_000;
    instance.state = { initializedAt, contextBinding: binding };
    let seen: unknown;
    fake.superConnect.mockImplementationOnce(async () => {
      seen = getCloudflareAgentAccessCurrentRequest();
      return 'connected';
    });
    const connection = { close: vi.fn() };
    const context = connectionContext(validHeaders);
    await expect(instance.onConnect(connection, context)).resolves.toBe('connected');
    expect(fake.superConnect).toHaveBeenCalledWith(connection, context);
    expect(seen).toEqual({ context: agentContext, sourceAccessToken: 'tok-1' });
    expect(instance.state.initializedAt).toBe(initializedAt);
    expect(instance.state.lastActivityAt).toBeGreaterThan(initializedAt);
    expect(instance.state.contextBinding).toEqual(binding);
  });
});

describe('McpAgent init and RPC validation', () => {
  it('lets an empty object initialize without binding state', async () => {
    const { instance } = agent();
    await instance.init();
    expect(instance.state).toEqual({});
  });

  it('refuses to reopen a bound session without its persisted context', async () => {
    const { instance } = agent();
    instance.state = { contextBinding: binding };
    await expect(instance.init()).rejects.toThrow(
      'Agent Access MCP authentication context is unavailable'
    );
  });

  it('binds a fresh session to the verified context', async () => {
    const { instance } = agent();
    instance.props = { context: agentContext };
    const before = Date.now();
    await instance.init();
    expect(instance.state.contextBinding).toEqual(binding);
    expect(instance.state.initializedAt).toBeGreaterThanOrEqual(before);
    expect(instance.state.lastActivityAt).toBe(instance.state.initializedAt);
  });

  it('keeps an existing matching binding and rejects a different Grant', async () => {
    const { instance } = agent();
    const state = { initializedAt: 1, lastActivityAt: 2, contextBinding: binding };
    instance.state = state;
    instance.props = { context: agentContext };
    await instance.init();
    expect(instance.state).toBe(state);
    instance.props = { context: otherGrantContext() };
    await expect(instance.init()).rejects.toThrow('does not match the bound session');
  });

  it('evaluates the session state for the validation RPC without touching activity', async () => {
    const { instance } = agent();
    const state = { initializedAt: 1_000, contextBinding: binding };
    instance.state = state;
    await expect(instance.validateSessionContextRpc(agentContext, 1_001)).resolves.toBe('active');
    await expect(instance.validateSessionContextRpc(otherGrantContext(), 1_001)).resolves.toBe(
      'context_mismatch'
    );
    expect(instance.state).toBe(state);
  });
});

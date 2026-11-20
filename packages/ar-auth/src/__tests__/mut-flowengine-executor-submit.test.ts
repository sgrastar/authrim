/**
 * FlowExecutor.submitCapability - exact error contracts, rate-limit / timeout boundaries,
 * history truncation, plan caching and DO request shapes.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { CompiledPlan } from '../flow-engine/types';
import {
  graphDef,
  initOk,
  json,
  node,
  plan,
  sessionState,
} from './helpers/mut-flowengine-fixtures';

const mocks = vi.hoisted(() => ({
  getFlow: vi.fn(),
  compile: vi.fn(),
  generate: vi.fn(),
  doFetch: vi.fn(),
  getFlowStateStoreStub: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, getFlowStateStoreStub: mocks.getFlowStateStoreStub };
});

vi.mock('../flow-engine/flow-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flow-engine/flow-registry')>();
  return { ...actual, createFlowRegistry: vi.fn(() => ({ getFlow: mocks.getFlow })) };
});

vi.mock('../flow-engine/flow-compiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flow-engine/flow-compiler')>();
  return { ...actual, createFlowCompiler: vi.fn(() => ({ compile: mocks.compile })) };
});

vi.mock('../flow-engine/ui-contract-generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flow-engine/ui-contract-generator')>();
  return {
    ...actual,
    createUIContractGenerator: vi.fn(() => ({ generate: mocks.generate })),
  };
});

import { FlowExecutor } from '../flow-engine/flow-executor';

function createExecutor(compiledPlan: CompiledPlan = plan()) {
  mocks.compile.mockReturnValue(compiledPlan);
  return new FlowExecutor({ AUTHRIM_CONFIG: {} } as Env, { ttlMs: 120_000 });
}

async function initialize(executor: FlowExecutor) {
  mocks.doFetch.mockResolvedValueOnce(initOk());
  return executor.initFlow({ flowType: 'login', clientId: 'client-1', tenantId: 'tenant-1' });
}

const check = (state: Record<string, unknown> = sessionState()) => json({ found: false, state });

function submit(executor: FlowExecutor, overrides: Record<string, unknown> = {}) {
  return executor.submitCapability({
    sessionId: 'flow-session-1',
    requestId: 'request-1',
    capabilityId: 'password',
    response: { value: 'x' },
    tenantId: 'tenant-1',
    clientId: 'client-1',
    ...overrides,
  });
}

/** Initialize, then submit once with the given session state; DO /submit returns {}. */
async function submitWith(state: Record<string, unknown>, compiledPlan?: CompiledPlan) {
  mocks.doFetch.mockReset();
  const executor = createExecutor(compiledPlan);
  await initialize(executor);
  mocks.doFetch.mockResolvedValueOnce(check(sessionState(state))).mockResolvedValueOnce(json({}));
  return submit(executor);
}

async function lastRequestBody<T>(): Promise<T> {
  const request = mocks.doFetch.mock.calls.at(-1)?.[0] as Request;
  return await request.json();
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getFlow.mockResolvedValue(graphDef);
  mocks.generate.mockImplementation(({ compiledNode }: { compiledNode: { id: string } }) => ({
    nodeId: compiledNode.id,
    components: [],
  }));
  mocks.getFlowStateStoreStub.mockResolvedValue({ stub: { fetch: mocks.doFetch } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const T = 1_800_000_000_000;

describe('submit error contracts', () => {
  it('tenant_required has a stable message', async () => {
    expect(await submit(createExecutor(), { tenantId: '' })).toEqual({
      type: 'error',
      error: { code: 'tenant_required', message: 'Tenant context is required' },
    });
  });

  it('sends the idempotency check to /check-request with the requestId', async () => {
    mocks.doFetch.mockResolvedValueOnce(json({ found: false }));
    expect(await submit(createExecutor(), { requestId: 'req-42' })).toEqual({
      type: 'error',
      error: { code: 'session_not_found', message: 'Session not found' },
    });
    const request = mocks.doFetch.mock.calls[0][0] as Request;
    expect(request.url).toBe('http://localhost/check-request');
    expect(request.method).toBe('POST');
    expect(request.headers.get('X-Tenant-Id')).toBe('tenant-1');
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(await request.json()).toEqual({ requestId: 'req-42' });
  });

  it('node_not_found / next_node_not_found carry the node id', async () => {
    expect(await submitWith({ currentNodeId: 'ghost' })).toEqual({
      type: 'error',
      error: { code: 'node_not_found', message: 'Node not found: ghost' },
    });
    const broken = plan({ nodes: new Map([['current', node('current', 'custom_form', 'gone')]]) });
    expect(await submitWith({}, broken)).toEqual({
      type: 'error',
      error: { code: 'next_node_not_found', message: 'Next node not found: gone' },
    });
  });

  it('flow_not_found has a stable message', async () => {
    mocks.getFlow.mockResolvedValueOnce(null);
    mocks.doFetch.mockResolvedValueOnce(check());
    expect(await submit(createExecutor())).toEqual({
      type: 'error',
      error: { code: 'flow_not_found', message: 'Flow definition not found' },
    });
  });
});

describe('rate limiting and session timeout', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(T);
  });

  it('counts timestamps 30 seconds old inside the one-minute window', async () => {
    const result = await submitWith({
      startedAt: T,
      requestTimestamps: Array.from({ length: 30 }, () => T - 30_000),
    });
    expect(result).toEqual({
      type: 'error',
      error: {
        code: 'rate_limit_exceeded',
        message: 'Too many requests. Please wait a moment and try again.',
      },
    });
  });

  it('drops timestamps exactly 60 seconds old and persists only the recent ones', async () => {
    const result = await submitWith({
      startedAt: T,
      requestTimestamps: [...Array.from({ length: 30 }, () => T - 60_000), T - 1000],
    });
    expect(result.type).toBe('continue');
    const body = await lastRequestBody<{ requestTimestamps: number[] }>();
    expect(body.requestTimestamps).toEqual([T - 1000, T]);
  });

  it('keeps only the last 100 timestamps before counting', async () => {
    const recent = T - 1000;
    const history = [
      recent,
      ...Array.from({ length: 71 }, () => T - 120_000),
      ...Array.from({ length: 29 }, () => recent),
    ];
    expect(history).toHaveLength(101);
    const result = await submitWith({ startedAt: T, requestTimestamps: history });
    expect(result.type).toBe('continue');
    const body = await lastRequestBody<{ requestTimestamps: number[] }>();
    expect(body.requestTimestamps).toHaveLength(30);
  });

  it('allows a session started 10 minutes ago and exactly 30 minutes ago', async () => {
    expect((await submitWith({ startedAt: T - 10 * 60_000 })).type).toBe('continue');
    expect((await submitWith({ startedAt: T - 30 * 60_000 })).type).toBe('continue');
  });

  it('times out after 30 minutes with a stable message', async () => {
    expect(await submitWith({ startedAt: T - 30 * 60_000 - 1 })).toEqual({
      type: 'error',
      error: { code: 'session_timeout', message: 'Session has expired. Please start over.' },
    });
  });
});

describe('visit history', () => {
  it('circular_reference and flow_too_long have stable messages', async () => {
    expect(await submitWith({ visitedNodeIds: ['current', 'current', 'current'] })).toEqual({
      type: 'error',
      error: {
        code: 'circular_reference',
        message: 'Flow contains a circular reference. Please contact support.',
      },
    });
    expect(
      await submitWith({ visitedNodeIds: Array.from({ length: 50 }, (_, i) => `n${i}`) })
    ).toEqual({
      type: 'error',
      error: {
        code: 'flow_too_long',
        message: 'Flow execution limit exceeded. Please contact support.',
      },
    });
  });

  it('allows two prior visits of the current node', async () => {
    expect((await submitWith({ visitedNodeIds: ['current', 'current'] })).type).toBe('continue');
    const body = await lastRequestBody<{ visitedNodes: string[] }>();
    expect(body.visitedNodes).toEqual(['current', 'current', 'current']);
  });

  it('truncates history to the last 200 entries before counting visits', async () => {
    const history = [
      'current',
      'current',
      'current',
      ...Array.from({ length: 198 }, (_, i) => `n${i}`),
    ];
    expect(history).toHaveLength(201);
    // Without truncation the three 'current' visits would trip circular_reference first.
    expect(await submitWith({ visitedNodeIds: history })).toMatchObject({
      error: { code: 'flow_too_long' },
    });
  });

  it('persists an empty-based history when the stored history is malformed', async () => {
    expect((await submitWith({ visitedNodeIds: { bogus: true } })).type).toBe('continue');
    const body = await lastRequestBody<{ visitedNodes: string[] }>();
    expect(body.visitedNodes).toEqual(['current']);
  });
});

describe('plan cache and DO submit', () => {
  it('reuses the cached plan instead of reloading the flow', async () => {
    expect((await submitWith({})).type).toBe('continue');
    expect(mocks.getFlow).toHaveBeenCalledTimes(1);
    expect(mocks.compile).toHaveBeenCalledTimes(1);
  });

  it('recompiles an uncached plan from the session flowType', async () => {
    mocks.doFetch.mockResolvedValueOnce(check()).mockResolvedValueOnce(json({}));
    const result = await submit(createExecutor());
    expect(result).toMatchObject({ type: 'continue', uiContract: { nodeId: 'next' } });
    expect(mocks.getFlow).toHaveBeenCalledWith('login', 'tenant-1');
  });

  it('returns plan_not_found when the session flowId does not match the compiled flow', async () => {
    mocks.doFetch.mockResolvedValueOnce(check(sessionState({ flowId: 'other-flow' })));
    expect(await submit(createExecutor())).toEqual({
      type: 'error',
      error: { code: 'plan_not_found', message: 'Compiled plan not found' },
    });
  });

  it('posts the submit result to /submit', async () => {
    const result = await submitWith({});
    const request = mocks.doFetch.mock.calls.at(-1)?.[0] as Request;
    expect(request.url).toBe('http://localhost/submit');
    expect(request.method).toBe('POST');
    expect(await request.json()).toMatchObject({
      capabilityId: 'password',
      response: { value: 'x' },
      result: result,
      nextNodeId: 'next',
    });
  });

  it('redirects to /callback for an end node when no redirect_uri is stored', async () => {
    const endPlan = plan({
      nodes: new Map([
        ['current', node('current', 'custom_form', 'end')],
        ['end', node('end', 'end')],
      ]),
    });
    expect(await submitWith({ oauthParams: undefined }, endPlan)).toEqual({
      type: 'redirect',
      redirect: { url: '/callback', method: 'GET' },
    });
  });
});

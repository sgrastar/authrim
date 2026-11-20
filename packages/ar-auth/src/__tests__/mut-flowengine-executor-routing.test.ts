/**
 * FlowExecutor - decision/switch routing, trusted runtime context, init/state paths,
 * and diagnostic sanitization boundaries.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { CompiledPlan, CompiledTransition } from '../flow-engine/types';
import {
  graphDef,
  initOk,
  json,
  plan,
  routingPlan,
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

const t = (sourceHandle: string | undefined, targetNodeId: string): CompiledTransition => ({
  targetNodeId,
  type: 'conditional',
  ...(sourceHandle ? { sourceHandle } : {}),
});

async function routeTo(compiledPlan: CompiledPlan, collectedData: unknown = {}) {
  const result = await submitWith({ collectedData }, compiledPlan);
  return result.type === 'continue'
    ? (result.uiContract as unknown as { nodeId: string }).nodeId
    : result.type;
}

describe('decision routing', () => {
  const branch = (id: string, key: string, operator: string, value?: unknown) => ({
    id,
    label: id,
    condition: { key, operator, value } as never,
    priority: 1,
  });

  it('skips non-matching branches and takes the first matching one', async () => {
    const p = routingPlan(
      'decision',
      {
        branches: [branch('b1', 'form.c', 'equals', 'US'), branch('b2', 'form.c', 'equals', 'JP')],
      },
      [t('b1', 'next'), t('b2', 'other')]
    );
    expect(await routeTo(p, { form: { c: 'JP' } })).toBe('other');
  });

  it('routes on the DO-verified tenant and client ids', async () => {
    const byTenant = routingPlan(
      'decision',
      { branches: [branch('b1', 'tenant.id', 'equals', 'tenant-1')], defaultBranch: 'd' },
      [t('b1', 'next'), t('d', 'fallback')]
    );
    expect(await routeTo(byTenant)).toBe('next');
    const byClient = routingPlan(
      'decision',
      { branches: [branch('b1', 'client.id', 'equals', 'client-1')], defaultBranch: 'd' },
      [t('b1', 'next'), t('d', 'fallback')]
    );
    expect(await routeTo(byClient)).toBe('next');
  });

  it.each([
    ['an array', ['JP']],
    ['a string', 'JP'],
  ])('ignores form data that is %s', async (_label, form) => {
    const p = routingPlan(
      'decision',
      { branches: [branch('b1', 'form', 'exists')], defaultBranch: 'd' },
      [t('b1', 'next'), t('d', 'fallback')]
    );
    expect(await routeTo(p, { form })).toBe('fallback');
  });

  it('exposes object form and variables but never client-submitted user/risk data', async () => {
    const p = routingPlan(
      'decision',
      {
        branches: [
          branch('u', 'user.id', 'exists'),
          branch('r', 'risk.score', 'exists'),
          branch('v', 'variables.flag', 'isTrue'),
        ],
      },
      [t('u', 'next'), t('r', 'next'), t('v', 'other')]
    );
    expect(
      await routeTo(p, { user: { id: 'u1' }, risk: { score: 1 }, variables: { flag: true } })
    ).toBe('other');
  });

  it('does not use an un-handled transition when no defaultBranch is configured', async () => {
    const p = routingPlan('decision', { branches: [branch('b1', 'form.c', 'equals', 'US')] }, [
      t(undefined, 'next'),
    ]);
    expect(await routeTo(p, { form: { c: 'JP' } })).toBe('redirect');
  });

  it('fails closed when the default branch targets a missing node', async () => {
    const p = routingPlan(
      'decision',
      { branches: [branch('b1', 'form.c', 'equals', 'US')], defaultBranch: 'd' },
      [t('d', 'missing')]
    );
    expect(await routeTo(p, { form: { c: 'JP' } })).toBe('redirect');
  });
});

describe('switch routing', () => {
  const sw = (
    switchKey: string,
    defaultCase: string | undefined,
    transitions: CompiledTransition[]
  ) =>
    routingPlan(
      'switch',
      {
        switchKey,
        cases: [
          { id: 'c1', label: 'c1', values: ['US'] },
          { id: 'c2', label: 'c2', values: ['JP', 1] },
        ],
        ...(defaultCase ? { defaultCase } : {}),
      },
      transitions
    );
  const std = [t('c1', 'next'), t('c2', 'other'), t('d', 'fallback')];

  it('matches the case containing the value, not the first case', async () => {
    expect(await routeTo(sw('form.c', 'd', std), { form: { c: 'JP' } })).toBe('other');
  });

  it.each(['constructor', 'prototype', '__proto__'])(
    'rejects the dangerous segment %s even as an own property',
    async (segment) => {
      const form = JSON.parse(`{"${segment}": "JP"}`) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(form, segment)).toBe(true);
      expect(await routeTo(sw(`form.${segment}`, 'd', std), { form })).toBe('fallback');
    }
  );

  it('stops at null and primitive intermediate values', async () => {
    expect(await routeTo(sw('form.a.b', 'd', std), { form: { a: null } })).toBe('fallback');
    // 'x'.length is 1 (a c2 value): a primitive must not be traversed
    expect(await routeTo(sw('form.a.length', 'd', std), { form: { a: 'x' } })).toBe('fallback');
  });

  it('does not use an un-handled transition when no defaultCase is configured', async () => {
    expect(
      await routeTo(sw('form.c', undefined, [t(undefined, 'next')]), { form: { c: 'DE' } })
    ).toBe('redirect');
  });

  it('fails closed when the default case targets a missing node', async () => {
    expect(await routeTo(sw('form.c', 'd', [t('d', 'missing')]), { form: { c: 'DE' } })).toBe(
      'redirect'
    );
  });
});

describe('initFlow', () => {
  it('does not skip a non-start entry node that has a successor', async () => {
    const result = await initialize(createExecutor());
    expect(result.uiContract).toMatchObject({ nodeId: 'current' });
    expect(result.uiContractVersion).toBe('0.1');
    expect(result.sessionId).toMatch(/^flow_[0-9a-f-]{36}$/);
    const request = mocks.doFetch.mock.calls[0][0] as Request;
    expect(await request.json()).toMatchObject({ entryNodeId: 'current', flowType: 'login' });
  });

  it('reuses the compiled plan for the same flow version and recompiles on a new version', async () => {
    const executor = createExecutor();
    await initialize(executor);
    await initialize(executor);
    expect(mocks.compile).toHaveBeenCalledTimes(1);
    mocks.getFlow.mockResolvedValue({ ...graphDef, flowVersion: '2.0.0' });
    await initialize(executor);
    expect(mocks.compile).toHaveBeenCalledTimes(2);
  });

  it.each([
    [123, 'client-1', 'Invalid tenantId'],
    ['tenant-1', 123, 'Invalid clientId'],
  ])('rejects non-string tenant/client ids', async (tenantId, clientId, message) => {
    await expect(
      createExecutor().initFlow({
        flowType: 'login',
        tenantId: tenantId as string,
        clientId: clientId as string,
      })
    ).rejects.toThrow(message);
  });
});

describe('getFlowState', () => {
  it('reads /state with GET, uses the cached plan and passes collected data to the UI', async () => {
    const executor = createExecutor();
    await initialize(executor);
    mocks.doFetch.mockResolvedValueOnce(
      json({ state: sessionState({ collectedData: { form: { a: 1 } } }) })
    );
    await executor.getFlowState('flow-session-1', 'tenant-1');
    const request = mocks.doFetch.mock.calls.at(-1)?.[0] as Request;
    expect(request.url).toBe('http://localhost/state');
    expect(request.method).toBe('GET');
    expect(mocks.getFlow).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeState: { collectedData: { form: { a: 1 } } } })
    );
  });
});

describe('sanitizeForLogging boundaries', () => {
  const sanitize = (value: unknown) =>
    (createExecutor() as unknown as { sanitizeForLogging(v: unknown): unknown }).sanitizeForLogging(
      value
    );

  it('keeps values at depth 10 and cuts at depth 11', () => {
    let obj: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 10; i++) obj = { child: obj };
    let cur = sanitize(obj) as Record<string, unknown>;
    for (let i = 0; i < 10; i++) cur = cur.child as Record<string, unknown>;
    expect(cur).toEqual({ leaf: 'value' });

    let deeper: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 11; i++) deeper = { child: deeper };
    let cur2 = sanitize(deeper) as Record<string, unknown>;
    for (let i = 0; i < 10; i++) cur2 = cur2.child as Record<string, unknown>;
    expect(cur2.child).toBe('[MAX_DEPTH_EXCEEDED]');
  });

  it('applies the depth limit to nested arrays', () => {
    let arr: unknown = ['x'];
    for (let i = 0; i < 12; i++) arr = [arr];
    expect(JSON.stringify(sanitize(arr))).toContain('[MAX_DEPTH_EXCEEDED]');
  });

  it('keeps collections with exactly 100 items', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    expect(sanitize(arr)).toEqual(arr);
    const obj = Object.fromEntries(arr.map((i) => [`k${i}`, i]));
    expect(sanitize(obj)).toEqual(obj);
  });
});

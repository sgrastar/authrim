/**
 * FlowCompiler - contract tests for node/capability resolution, transitions,
 * compiled edge conditions, priority ordering and entry-node selection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowCompilerService, createFlowCompiler } from '../flow-engine/flow-compiler.js';
import type {
  GraphDefinition,
  GraphNode,
  GraphEdge,
  CompiledPlan,
  EvaluationContext,
} from '../flow-engine/types.js';

type LooseNode = {
  id: string;
  type: string;
  intent?: string;
  capabilities?: unknown[];
  config?: Record<string, unknown>;
};

function node(n: LooseNode): GraphNode {
  return {
    id: n.id,
    type: n.type,
    position: { x: 0, y: 0 },
    data: {
      label: n.id,
      ...(n.intent !== undefined ? { intent: n.intent } : {}),
      capabilities: n.capabilities ?? [],
      config: 'config' in n ? n.config : {},
    },
  } as unknown as GraphNode;
}

function edge(e: Partial<GraphEdge> & { source: string; target: string }): GraphEdge {
  return { id: `${e.source}->${e.target}`, type: 'success', ...e };
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = [], id = 'g1'): GraphDefinition {
  return {
    id,
    flowVersion: '2.3.4',
    name: 'n',
    description: 'd',
    profileId: 'core.human-basic-login',
    nodes,
    edges,
    metadata: { createdAt: '', updatedAt: '' },
  } as unknown as GraphDefinition;
}

const compiler = new FlowCompilerService();
const compile = (g: GraphDefinition): CompiledPlan => compiler.compile(g);
function nodeOf(p: CompiledPlan, id: string) {
  const n = p.nodes.get(id);
  if (!n) throw new Error(`missing node ${id}`);
  return n;
}
function transitionsOf(p: CompiledPlan, id: string) {
  const ts = p.transitions.get(id);
  if (!ts) throw new Error(`missing transitions ${id}`);
  return ts;
}
const ctx = (over: Partial<EvaluationContext> = {}): EvaluationContext => ({
  collectedData: {},
  completedCapabilities: [],
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('FlowCompiler plan metadata', () => {
  it('derives plan id, version and source metadata', () => {
    const plan = compile(graph([node({ id: 'start', type: 'start' })], [], 'my-flow'));
    expect(plan.id).toBe('compiled-my-flow');
    expect(plan.version).toBe('1.0.0');
    expect(plan.sourceVersion).toBe('2.3.4');
    expect(plan.profileId).toBe('core.human-basic-login');
    expect(Number.isNaN(Date.parse(plan.compiledAt))).toBe(false);
  });

  it('createFlowCompiler returns a working compiler', () => {
    const c = createFlowCompiler();
    expect(c.compile(graph([node({ id: 'a', type: 'end' })])).entryNodeId).toBe('a');
  });
});

describe('FlowCompiler intent derivation', () => {
  it.each([
    ['start', 'flow_start'],
    ['end', 'flow_end'],
    ['login', 'authenticate'],
    ['register', 'register'],
    ['mfa', 'mfa_verify'],
    ['consent', 'consent'],
    ['identifier', 'identifier_input'],
    ['auth_method_select', 'auth_method_select'],
    ['check_session', 'check_session'],
    ['redirect', 'redirect'],
    ['error', 'error'],
    ['decision', 'decision'],
    ['condition', 'condition'],
    ['resolve_tenant', 'resolve_tenant'],
  ])('type %s without intent -> %s', (type, intent) => {
    const config = type === 'decision' ? { branches: [] } : {};
    const plan = compile(graph([node({ id: 'n', type, config })]));
    expect(nodeOf(plan, 'n').intent).toBe(intent);
  });

  it('keeps an explicit intent', () => {
    const plan = compile(graph([node({ id: 'n', type: 'login', intent: 'core.custom' })]));
    expect(nodeOf(plan, 'n').intent).toBe('core.custom');
  });
});

describe('FlowCompiler capability resolution', () => {
  it('resolves ids, default hints, stability and validation rules', () => {
    const rules = [{ type: 'required', message: 'x' }];
    const plan = compile(
      graph([
        node({
          id: 'n1',
          type: 'identifier',
          capabilities: [
            { type: 'collect_identifier', idSuffix: 'email', required: true },
            { type: 'collect_secret', idSuffix: 'pw', required: false, validationRules: rules },
            { type: 'verify_possession', idSuffix: 'pk', required: true },
            { type: 'display_info', idSuffix: 'info', required: false },
            { type: 'confirm_consent', idSuffix: 'c', required: true },
            { type: 'redirect', idSuffix: 'r', required: true },
            { type: 'custom_thing', idSuffix: 'x', required: false },
          ],
        }),
      ])
    );
    const caps = nodeOf(plan, 'n1').capabilities;
    expect(caps.map((c) => c.id)).toEqual([
      'n1_email',
      'n1_pw',
      'n1_pk',
      'n1_info',
      'n1_c',
      'n1_r',
      'n1_x',
    ]);
    expect(caps[0]).toEqual({
      type: 'collect_identifier',
      id: 'n1_email',
      required: true,
      hints: { inputType: 'email', autoFocus: true },
      validationRules: [],
      stability: 'core',
    });
    expect(caps[1].hints).toEqual({ inputType: 'password' });
    expect(caps[1].required).toBe(false);
    expect(caps[1].validationRules).toBe(rules);
    expect(caps[2].hints).toEqual({
      webauthn: { mode: 'authenticate', discoverable: true, userVerification: 'required' },
    });
    expect(caps[3].hints).toEqual({ variant: 'info' });
    expect(caps[4].hints).toEqual({});
    expect(caps[5].hints).toEqual({});
    expect(caps[6].hints).toEqual({});
    expect(caps.slice(0, 6).every((c) => c.stability === 'core')).toBe(true);
    expect(caps[6].stability).toBe('stable');
  });

  it('lets hintsTemplate override defaults', () => {
    const plan = compile(
      graph([
        node({
          id: 'n',
          type: 'identifier',
          capabilities: [
            {
              type: 'collect_identifier',
              idSuffix: 'id',
              required: true,
              hintsTemplate: { inputType: 'tel', label: 'Phone' },
            },
          ],
        }),
      ])
    );
    expect(nodeOf(plan, 'n').capabilities[0].hints).toEqual({
      inputType: 'tel',
      autoFocus: true,
      label: 'Phone',
    });
  });

  it('accepts exactly 20 capabilities and rejects 21', () => {
    const caps = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        type: 'display_info',
        idSuffix: `c${i}`,
        required: false,
      }));
    const ok = compile(graph([node({ id: 'n', type: 'information', capabilities: caps(20) })]));
    expect(nodeOf(ok, 'n').capabilities).toHaveLength(20);
    expect(() =>
      compile(graph([node({ id: 'n', type: 'information', capabilities: caps(21) })]))
    ).toThrow('Invalid flow configuration');
  });
});

describe('FlowCompiler decision/switch limits', () => {
  const branches = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `b${i}`,
      label: `b${i}`,
      condition: { key: 'risk.score', operator: 'equals', value: i },
      priority: i,
    }));

  it('accepts a decision with exactly 50 branches', () => {
    const plan = compile(
      graph([node({ id: 'd', type: 'decision', config: { branches: branches(50) } })])
    );
    expect((nodeOf(plan, 'd').decisionConfig as { branches: unknown[] }).branches).toHaveLength(50);
  });

  it('accepts a switch with 100 cases and 100 values per case', () => {
    const cases = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      label: `c${i}`,
      values: Array.from({ length: 100 }, (_, j) => `${i}-${j}`),
    }));
    const plan = compile(
      graph([node({ id: 's', type: 'switch', config: { switchKey: 'k', cases } })])
    );
    expect((nodeOf(plan, 's').decisionConfig as { cases: unknown[] }).cases).toHaveLength(100);
  });

  it('does not attach decisionConfig to regular nodes', () => {
    const plan = compile(graph([node({ id: 'l', type: 'login', config: { branches: [] } })]));
    expect('decisionConfig' in nodeOf(plan, 'l')).toBe(false);
  });

  it('compiles a decision node without config or outgoing edges', () => {
    const plan = compile(
      graph(
        [node({ id: 'd', type: 'decision', config: undefined }), node({ id: 'x', type: 'end' })],
        [edge({ source: 'd', target: 'x', sourceHandle: 'h1', type: 'conditional' })]
      )
    );
    const d = nodeOf(plan, 'd');
    expect(d.decisionConfig).toBeUndefined();
    expect(transitionsOf(plan, 'd')[0].priority).toBeUndefined();
  });
});

describe('FlowCompiler transitions', () => {
  it('keeps sourceHandle only when present and compiles conditions only for conditional edges', () => {
    const plan = compile(
      graph(
        [node({ id: 'a', type: 'start' }), node({ id: 'b', type: 'end' })],
        [
          edge({
            source: 'a',
            target: 'b',
            type: 'success',
            data: { condition: { type: 'custom', expression: 'x' } },
          }),
          edge({ source: 'a', target: 'b', type: 'conditional', sourceHandle: 'h' }),
          edge({
            source: 'a',
            target: 'b',
            type: 'conditional',
            data: { condition: { type: 'feature_flag', expression: 'beta' } },
          }),
        ]
      )
    );
    const [t1, t2, t3] = transitionsOf(plan, 'a');
    expect('sourceHandle' in t1).toBe(false);
    expect('condition' in t1).toBe(false);
    expect(t2.sourceHandle).toBe('h');
    expect('condition' in t2).toBe(false);
    expect(t3.condition?.type).toBe('feature_flag');
    expect(t3.condition?.expression).toBe('beta');
  });

  function conditionFor(type: string, expression: string) {
    const plan = compile(
      graph(
        [node({ id: 'a', type: 'start' }), node({ id: 'b', type: 'end' })],
        [
          edge({
            source: 'a',
            target: 'b',
            type: 'conditional',
            data: { condition: { type, expression } as never },
          }),
        ]
      )
    );
    const condition = transitionsOf(plan, 'a')[0].condition;
    if (!condition) throw new Error('condition not compiled');
    return condition;
  }

  it('capability_result checks completed capability ids', () => {
    const c = conditionFor('capability_result', 'completed:id_email');
    expect(c.evaluate(ctx({ completedCapabilities: ['id_email'] }))).toBe(true);
    expect(c.evaluate(ctx({ completedCapabilities: ['other'] }))).toBe(false);
    expect(c.evaluate(ctx({ completedCapabilities: ['completed:id_email'] }))).toBe(false);
  });

  it('feature_flag reads the named flag and defaults to false', () => {
    const c = conditionFor('feature_flag', 'beta');
    expect(c.evaluate(ctx({ featureFlags: { beta: true } }))).toBe(true);
    expect(c.evaluate(ctx({ featureFlags: { beta: false } }))).toBe(false);
    expect(c.evaluate(ctx({ featureFlags: { other: true } }))).toBe(false);
    expect(c.evaluate(ctx())).toBe(false);
  });

  it('policy_check and unknown types always pass', () => {
    expect(conditionFor('policy_check', 'p').evaluate(ctx())).toBe(true);
    expect(conditionFor('something_else', 'p').evaluate(ctx())).toBe(true);
  });

  it('custom allowRetry expression checks collectedData strictly', () => {
    const c = conditionFor('custom', 'allowRetry === true');
    expect(c.evaluate(ctx({ collectedData: { allowRetry: true } }))).toBe(true);
    expect(c.evaluate(ctx({ collectedData: { allowRetry: 'true' } }))).toBe(false);
    expect(c.evaluate(ctx())).toBe(false);
    expect(conditionFor('custom', 'anything').evaluate(ctx())).toBe(true);
  });

  it('sorts decision transitions by branch priority, unprioritised last', () => {
    const config = {
      branches: [
        { id: 'p3', label: '', condition: { key: 'a', operator: 'exists' }, priority: 3 },
        { id: 'p1', label: '', condition: { key: 'a', operator: 'exists' }, priority: 1 },
        { id: 'p2', label: '', condition: { key: 'a', operator: 'exists' }, priority: 2 },
      ],
    };
    const plan = compile(
      graph(
        [node({ id: 'd', type: 'decision', config }), node({ id: 'x', type: 'end' })],
        [
          edge({ source: 'd', target: 'none', type: 'conditional', sourceHandle: 'unknown' }),
          edge({ source: 'd', target: 't3', type: 'conditional', sourceHandle: 'p3' }),
          edge({ source: 'd', target: 't1', type: 'conditional', sourceHandle: 'p1' }),
          edge({ source: 'd', target: 't2', type: 'conditional', sourceHandle: 'p2' }),
        ]
      )
    );
    const ts = transitionsOf(plan, 'd');
    expect(ts.map((t) => t.targetNodeId)).toEqual(['t1', 't2', 't3', 'none']);
    expect(ts.map((t) => t.priority)).toEqual([1, 2, 3, undefined]);
  });

  it('keeps switch transitions in definition order', () => {
    const config = { switchKey: 'k', cases: [{ id: 'c1', label: '', values: ['a'] }] };
    const plan = compile(
      graph(
        [node({ id: 's', type: 'switch', config })],
        [
          edge({ source: 's', target: 'z', type: 'conditional', sourceHandle: 'c2' }),
          edge({ source: 's', target: 'a', type: 'conditional', sourceHandle: 'c1' }),
        ]
      )
    );
    expect(transitionsOf(plan, 's').map((t) => t.targetNodeId)).toEqual(['z', 'a']);
  });
});

describe('FlowCompiler next-node resolution and entry node', () => {
  it('maps success and error edges independently of edge order', () => {
    const plan = compile(
      graph(
        [
          node({ id: 'a', type: 'login' }),
          node({ id: 'b', type: 'login' }),
          node({ id: 'c', type: 'end' }),
        ],
        [
          edge({ source: 'a', target: 'err', type: 'error' }),
          edge({ source: 'a', target: 'cond', type: 'conditional' }),
          edge({ source: 'a', target: 'ok', type: 'success' }),
          edge({ source: 'b', target: 'ok2', type: 'success' }),
          edge({ source: 'b', target: 'err2', type: 'error' }),
        ]
      )
    );
    expect(nodeOf(plan, 'a').nextOnSuccess).toBe('ok');
    expect(nodeOf(plan, 'a').nextOnError).toBe('err');
    expect(nodeOf(plan, 'b').nextOnSuccess).toBe('ok2');
    expect(nodeOf(plan, 'b').nextOnError).toBe('err2');
    expect(nodeOf(plan, 'c').nextOnSuccess).toBeNull();
    expect(nodeOf(plan, 'c').nextOnError).toBeNull();
  });

  it('leaves nextOnError null when only success/conditional edges exist', () => {
    const plan = compile(
      graph(
        [node({ id: 'a', type: 'login' })],
        [
          edge({ source: 'a', target: 'cond', type: 'conditional' }),
          edge({ source: 'a', target: 'ok', type: 'success' }),
        ]
      )
    );
    expect(nodeOf(plan, 'a').nextOnError).toBeNull();
    expect(nodeOf(plan, 'a').nextOnSuccess).toBe('ok');
  });

  it('uses the start node as entry even when it is not first', () => {
    const plan = compile(
      graph([node({ id: 'first', type: 'login' }), node({ id: 'begin', type: 'start' })])
    );
    expect(plan.entryNodeId).toBe('begin');
  });

  it('falls back to the first node when there is no start node', () => {
    const plan = compile(
      graph([node({ id: 'first', type: 'login' }), node({ id: 'second', type: 'end' })])
    );
    expect(plan.entryNodeId).toBe('first');
  });
});

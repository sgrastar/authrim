import { describe, expect, it } from 'vitest';
import {
  analyzeMappingDependencies,
  IDENTIFIER_POST_TRANSFORM_OPERATIONS,
  identifierGraphProblem,
  withMappingGraph,
} from '../../core/graph';
import type {
  FieldRef,
  MappingGraphTransform,
  MappingRuleEdge,
  MappingRuleGraph,
  MappingTransformStep,
  MappingValueReference,
  TransformOperation,
} from '../../core/types';

const target: FieldRef = { side: 'canonical', namespace: 'authrim.profile', path: 'email' };
const source: FieldRef = { side: 'source', namespace: 'csv', path: 'email' };

function step(
  id: string,
  inputs: MappingValueReference[],
  operation: TransformOperation = 'trim'
): MappingGraphTransform {
  return { id, operation, inputs };
}

function edge(id: string): MappingRuleEdge {
  return { id, sourceRef: source, targetRef: target };
}

function graph(
  transforms: MappingGraphTransform[],
  output: MappingValueReference,
  overrides: Partial<MappingRuleGraph> = {}
): MappingRuleGraph {
  return {
    id: 'rule',
    targetRef: target,
    edges: [edge('e0'), edge('e1'), edge('e2')],
    transforms,
    output,
    ...overrides,
  };
}

function analyze(
  transforms: MappingGraphTransform[],
  output: MappingValueReference,
  edgeCount = 3
) {
  return analyzeMappingDependencies({ edgeCount, transforms, output });
}

describe('identifier post-transform allow list', () => {
  it('names exactly the text operations that may follow an identifier', () => {
    expect(IDENTIFIER_POST_TRANSFORM_OPERATIONS).toEqual([
      'affix_text',
      'case',
      'trim',
      'keep_part',
      'remove_text',
      'replace_text',
      'regex_replace',
      'to_halfwidth',
      'to_fullwidth',
      'strip_accents',
      'ascii_digits',
    ]);
  });
});

describe('analyzeMappingDependencies reference validation', () => {
  it('accepts an output that points at the last edge or the last step', () => {
    expect(analyze([], { edgeIndex: 2 })).toEqual({
      stepIndexes: [],
      edgeIndexes: new Set([2]),
    });
    expect(analyze([step('s0', [{ edgeIndex: 0 }])], { stepIndex: 0 })).toEqual({
      stepIndexes: [0],
      edgeIndexes: new Set([0]),
    });
  });

  it.each([
    ['an edge index equal to the edge count', { edgeIndex: 3 }],
    ['a negative edge index', { edgeIndex: -1 }],
    ['a fractional edge index', { edgeIndex: 1.5 }],
    ['a NaN edge index', { edgeIndex: Number.NaN }],
    ['a step index equal to the step count', { stepIndex: 1 }],
    ['a negative step index', { stepIndex: -1 }],
    ['a fractional step index', { stepIndex: 0.5 }],
    ['a reference with neither index', {}],
    ['a reference with both indexes', { edgeIndex: 0, stepIndex: 0 }],
  ])('refuses %s as the output', (_label, output) => {
    expect(() =>
      analyze([step('s0', [{ edgeIndex: 0 }])], output as MappingValueReference)
    ).toThrow('invalid_reference');
  });

  it('refuses step inputs that point at themselves or later steps', () => {
    expect(() => analyze([step('s0', [{ stepIndex: 0 }])], { stepIndex: 0 })).toThrow(
      'invalid_reference'
    );
    expect(() =>
      analyze([step('s0', [{ edgeIndex: 0 }]), step('s1', [{ stepIndex: 2 }])], { stepIndex: 0 })
    ).toThrow('invalid_reference');
    expect(() =>
      analyze([step('s0', [{ edgeIndex: 0 }]), step('s1', [{ stepIndex: 0 }])], { stepIndex: 1 })
    ).not.toThrow();
  });

  it('validates references of steps the output never reaches', () => {
    expect(() =>
      analyze([step('s0', [{ edgeIndex: 9 }]), step('s1', [{ edgeIndex: 0 }])], { stepIndex: 1 })
    ).toThrow('invalid_reference');
  });

  it('checks edge indexes against the edge count of the rule', () => {
    expect(() => analyze([step('s0', [{ edgeIndex: 1 }])], { stepIndex: 0 }, 1)).toThrow(
      'invalid_reference'
    );
    expect(() => analyze([step('s0', [{ edgeIndex: 0 }])], { stepIndex: 0 }, 1)).not.toThrow();
  });

  it('bounds input names to 1..518 non-blank characters', () => {
    const named = (name: unknown) =>
      analyze([step('s0', [{ edgeIndex: 0, name } as MappingValueReference])], { stepIndex: 0 });
    expect(() => named('a'.repeat(518))).not.toThrow();
    expect(() => named('a'.repeat(519))).toThrow('invalid_reference');
    expect(() => named('')).toThrow('invalid_reference');
    expect(() => named('   ')).toThrow('invalid_reference');
    expect(() => named(5)).toThrow('invalid_reference');
    expect(() => named(null)).toThrow('invalid_reference');
    expect(() => named(' a ')).not.toThrow();
  });

  it('applies the name bound to the output reference as well', () => {
    expect(() => analyze([], { edgeIndex: 0, name: ' ' })).toThrow('invalid_reference');
    expect(() => analyze([], { edgeIndex: 0, name: 'ok' })).not.toThrow();
  });
});

describe('analyzeMappingDependencies walk', () => {
  it('lists reachable steps in dependency order, each once, and skips unreachable ones', () => {
    const transforms = [
      step('s0', [{ edgeIndex: 0 }]),
      step('unused', [{ edgeIndex: 1 }]),
      step('s2', [{ stepIndex: 0 }, { edgeIndex: 2 }]),
      step('s3', [{ stepIndex: 2 }, { stepIndex: 0 }, { stepIndex: 2 }]),
    ];
    const result = analyze(transforms, { stepIndex: 3 });
    expect(result.stepIndexes).toEqual([0, 2, 3]);
    expect([...result.edgeIndexes].sort()).toEqual([0, 2]);
  });

  it('visits a shared step once even when reached through several inputs', () => {
    const transforms = [
      step('base', [{ edgeIndex: 0 }]),
      step('left', [{ stepIndex: 0 }]),
      step('right', [{ stepIndex: 0 }]),
      step('join', [{ stepIndex: 1 }, { stepIndex: 2 }]),
    ];
    expect(analyze(transforms, { stepIndex: 3 }).stepIndexes).toEqual([0, 1, 2, 3]);
  });
});

describe('identifierGraphProblem', () => {
  const problem = 'identifier_post_transform_not_allowed';
  const identifier = step('pid', [], 'persistent_identifier');

  function problemFor(
    operation: TransformOperation,
    overrides: Partial<MappingRuleGraph> = {},
    withIdentifier = true
  ) {
    const transforms = withIdentifier
      ? [identifier, step('post', [{ stepIndex: 0 }], operation)]
      : [step('post', [], operation)];
    return identifierGraphProblem(
      graph(transforms, { stepIndex: transforms.length - 1 }, overrides)
    );
  }

  it('allows listed operations after an identifier on ordinary targets', () => {
    expect(problemFor('trim')).toBeNull();
    expect(problemFor('case')).toBeNull();
  });

  it('refuses unlisted operations after an identifier', () => {
    expect(problemFor('default_if_empty')).toBe(problem);
    expect(problemFor('hash')).toBe(problem);
  });

  it('does not constrain operations that do not follow an identifier', () => {
    expect(problemFor('default_if_empty', {}, false)).toBeNull();
    expect(problemFor('persistent_identifier', {}, false)).toBeNull();
  });

  it('refuses any step after an identifier for SAML name identifiers', () => {
    const nameId: FieldRef = { side: 'destination', namespace: 'saml.nameid', path: 'value' };
    expect(problemFor('trim', { targetRef: nameId })).toBe(problem);
    expect(
      problemFor('trim', { targetRef: { ...nameId, namespace: 'saml.attribute' } })
    ).toBeNull();
  });

  it('refuses any step after an identifier for a pairwise subject only', () => {
    const sub: FieldRef = { side: 'destination', namespace: 'oidc.claim', path: 'sub' };
    expect(problemFor('trim', { targetRef: sub, pairwiseSubject: true })).toBe(problem);
    expect(problemFor('trim', { targetRef: sub, pairwiseSubject: false })).toBeNull();
    expect(problemFor('trim', { targetRef: sub })).toBeNull();
    expect(
      problemFor('trim', { targetRef: { ...sub, path: 'email' }, pairwiseSubject: true })
    ).toBeNull();
  });

  it('propagates identifier dependence through allowed steps', () => {
    const transforms = [
      identifier,
      step('a', [{ stepIndex: 0 }], 'trim'),
      step('b', [{ stepIndex: 1 }], 'default_if_empty'),
    ];
    expect(identifierGraphProblem(graph(transforms, { stepIndex: 2 }))).toBe(problem);
    const unrelated = [
      identifier,
      step('a', [{ edgeIndex: 0 }], 'default_if_empty'),
      step('b', [{ stepIndex: 0 }, { stepIndex: 1 }], 'trim'),
    ];
    expect(identifierGraphProblem(graph(unrelated, { stepIndex: 2 }))).toBeNull();
  });

  it('ignores edge inputs when looking for identifier dependence', () => {
    const transforms = [identifier, step('a', [{ edgeIndex: 0 }], 'default_if_empty')];
    expect(identifierGraphProblem(graph(transforms, { stepIndex: 1 }))).toBeNull();
  });
});

describe('withMappingGraph', () => {
  const foreignEdge = edge('foreign-edge');
  const foreignStep: MappingTransformStep = {
    id: 'foreign-step',
    inputEdgeIds: ['foreign-edge'],
    operation: 'copy',
    outputTargetRef: target,
  };

  it('defaults transforms to an empty list without graph rules', () => {
    const binding = { edges: [foreignEdge], extra: 1 };
    const result = withMappingGraph(binding);
    expect(result).toEqual({ edges: [foreignEdge], extra: 1, transforms: [] });
    expect(result.transforms).toEqual([]);
    expect(result).not.toBe(binding);
  });

  it('keeps explicit transforms without graph rules', () => {
    const result = withMappingGraph({ edges: [foreignEdge], transforms: [foreignStep] });
    expect(result.edges).toEqual([foreignEdge]);
    expect(result.transforms).toEqual([foreignStep]);
  });

  it('replaces rule-owned bindings by the reachable parts of the rule graphs', () => {
    const rule = graph(
      [
        step('s0', [{ edgeIndex: 0, name: 'left' }, { edgeIndex: 2 }]),
        step('unused', [{ edgeIndex: 1 }]),
        step('s2', [{ stepIndex: 0 }], 'case'),
      ],
      { stepIndex: 2 }
    );
    const staleOwnedStep: MappingTransformStep = {
      id: 's0',
      inputEdgeIds: ['stale'],
      operation: 'copy',
      outputTargetRef: target,
    };
    const staleUnreachableStep: MappingTransformStep = { ...staleOwnedStep, id: 'unused' };
    const result = withMappingGraph({
      edges: [foreignEdge, ...rule.edges],
      transforms: [foreignStep, staleOwnedStep, staleUnreachableStep],
      graphRules: [rule],
    });

    expect(result.edges).toEqual([foreignEdge, rule.edges[0], rule.edges[2]]);
    expect(result.transforms).toEqual([
      foreignStep,
      {
        id: 's0',
        operation: 'trim',
        inputs: [{ edgeIndex: 0, name: 'left' }, { edgeIndex: 2 }],
        inputNames: ['left', undefined],
        inputEdgeIds: ['e0', 'e2'],
        outputTargetRef: target,
      },
      {
        id: 's2',
        operation: 'case',
        inputs: [{ stepIndex: 0 }],
        inputNames: [undefined],
        inputEdgeIds: ['step:s0'],
        outputTargetRef: target,
      },
    ]);
    expect(result.graphRules).toEqual([rule]);
  });

  it('merges several rules and uses each rule target', () => {
    const otherTarget: FieldRef = { ...target, path: 'name' };
    const first = graph([step('a', [{ edgeIndex: 1 }])], { stepIndex: 0 }, { id: 'first' });
    const second = graph(
      [step('b', [{ edgeIndex: 0 }])],
      { stepIndex: 0 },
      { id: 'second', targetRef: otherTarget, edges: [edge('x0')] }
    );
    const result = withMappingGraph({
      edges: [] as MappingRuleEdge[],
      graphRules: [first, second],
    });
    expect(result.edges.map((item) => item.id)).toEqual(['e1', 'x0']);
    expect(result.transforms.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.transforms.map((item) => item.outputTargetRef)).toEqual([target, otherTarget]);
    expect(result.transforms.map((item) => item.inputEdgeIds)).toEqual([['e1'], ['x0']]);
  });

  it('rejects graph rules whose references are invalid', () => {
    const broken = graph([step('s0', [{ edgeIndex: 7 }])], { stepIndex: 0 });
    expect(() => withMappingGraph({ edges: [], graphRules: [broken] })).toThrow(
      'invalid_reference'
    );
  });

  it('drops owned edges and steps that the graphs no longer reach', () => {
    const rule = graph([step('s0', [{ edgeIndex: 0 }])], { stepIndex: 0 });
    const result = withMappingGraph({
      edges: rule.edges,
      transforms: [] as MappingTransformStep[],
      graphRules: [rule],
    });
    expect(result.edges.map((item) => item.id)).toEqual(['e0']);
    expect(result.transforms.map((item) => item.id)).toEqual(['s0']);
  });
});

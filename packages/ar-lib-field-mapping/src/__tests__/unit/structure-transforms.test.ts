import { describe, expect, it } from 'vitest';
import { evaluateMappingRule } from '../../core/graph-evaluator';
import { analyzeMappingDependencies } from '../../core/graph';
import { validateMappingRuleGraph } from '../../core/graph-validation';
import {
  STRUCTURE_TRANSFORM_CASES,
  CONDITIONAL_PARAMETERS,
} from '../../test-support/structure-transform-cases';
import type {
  FieldRef,
  MappingEvaluationValue,
  MappingRuleGraph,
  TransformOperation,
} from '../../core/types';

const ref: FieldRef = { side: 'source', namespace: 'synthetic', path: 'input' };
const target: FieldRef = { side: 'destination', namespace: 'synthetic', path: 'output' };
function rule(
  operation: TransformOperation,
  parameters: Record<string, unknown> = {}
): MappingRuleGraph {
  return {
    id: 'rule',
    targetRef: target,
    edges: [{ id: 'edge', sourceRef: ref, targetRef: target }],
    transforms: [
      {
        id: 'step',
        operation,
        parameters,
        inputs: operation.startsWith('constant_') ? [] : [{ edgeIndex: 0 }],
      },
    ],
    output: { stepIndex: 0 },
  };
}
function run(
  operation: TransformOperation,
  input: unknown,
  parameters: Record<string, unknown> = {}
) {
  return evaluateMappingRule({
    rule: rule(operation, parameters),
    sourceValues: input === undefined ? [] : [{ value: input, sourceRef: ref }],
  });
}
function conditionRule(): MappingRuleGraph {
  const graph = rule('conditional', CONDITIONAL_PARAMETERS);
  graph.edges.push({
    id: 'department',
    sourceRef: { ...ref, path: 'department' },
    targetRef: target,
  });
  graph.transforms[0].inputs = [
    { edgeIndex: 0, name: 'value' },
    { edgeIndex: 1, name: 'field:department' },
  ];
  return graph;
}

describe('structure operations and constants', () => {
  it.each(STRUCTURE_TRANSFORM_CASES)('accepts $operation with shared parameters', (example) => {
    expect(run(example.operation, example.input, example.parameters)).toMatchObject({
      output: { kind: 'value', envelope: { value: example.output } },
      reasons: [],
    });
  });
  it.each([
    null,
    '',
    [],
    [null],
    { picture: null },
    { picture: '' },
    { picture: [] },
    { picture: false },
    { picture: 0 },
  ])('handles extraction edge value %j', (input) => {
    const extracted = run('json_extract_array', input, { path: 'picture' });
    expect(extracted.reasons).toEqual([]);
    const fallback = run('json_extract_or', input, { path: 'picture', defaultValue: 'default' });
    const found =
      input !== null && typeof input === 'object' && 'picture' in input ? input.picture : undefined;
    expect(fallback.output).toMatchObject({
      kind: 'value',
      envelope: {
        value:
          found === undefined
            ? 'default'
            : found === null
              ? null
              : typeof found === 'object'
                ? JSON.stringify(found)
                : String(found),
      },
    });
  });
  it('distinguishes absence, null and empty extraction', () => {
    expect(run('json_extract_array', {}, { path: 'items' }).output).toEqual({ kind: 'absent' });
    expect(run('json_extract_array', { items: null }, { path: 'items' }).output).toMatchObject({
      kind: 'value',
      envelope: { value: null },
    });
    expect(run('json_extract_array', { items: [] }, { path: 'items' }).output).toMatchObject({
      kind: 'value',
      envelope: { value: [] },
    });
    expect(
      run('json_extract_or', undefined, { path: 'items', defaultValue: '' }).output
    ).toMatchObject({ kind: 'value', envelope: { value: '' } });
    expect(
      run(
        'json_extract_or',
        { items: null },
        { path: 'items', defaultValue: 'x', nullAsMissing: true }
      ).output
    ).toMatchObject({ kind: 'value', envelope: { value: 'x' } });
  });
  it.each([
    'a..b',
    'a[-1]',
    'a[500]',
    'a[0]tail',
    'a[',
    '__proto__.x',
    'constructor',
    'a.'.repeat(300),
  ])('refuses malformed or unbounded path %s', (path) => {
    for (const operation of [
      'json_extract_array',
      'json_extract_or',
    ] satisfies TransformOperation[])
      expect(
        run(
          operation,
          {},
          { path, ...(operation === 'json_extract_or' ? { defaultValue: '' } : {}) }
        ).output.kind
      ).toBe('failed');
  });
  it.each(STRUCTURE_TRANSFORM_CASES)('bounds $operation parameters and inputs', (example) => {
    expect(
      run(example.operation, example.input, { ...example.parameters, surprise: true }).output.kind
    ).toBe('failed');
    if (!example.operation.startsWith('constant_')) {
      expect(
        run(example.operation, Array(501).fill('x'), example.parameters).reasons.map(
          (item) => item.code
        )
      ).toContain('transform.limit_exceeded');
      expect(run(example.operation, 'é'.repeat(17000), example.parameters).output.kind).toBe(
        'failed'
      );
    }
  });
  it.each([NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '42', null])(
    'refuses unsafe numeric constant %s',
    (value) => expect(run('constant_number', undefined, { value }).output.kind).toBe('failed')
  );
  it('requires constants to have no inputs and actual typed values', () => {
    const graph = rule('constant_boolean', { value: false });
    graph.transforms[0].inputs = [{ edgeIndex: 0 }];
    expect(validateMappingRuleGraph(graph).length).toBeGreaterThan(0);
    expect(run('constant_boolean', undefined, { value: 'false' }).output.kind).toBe('failed');
  });
  it.each(['failed', 'suppressed'] satisfies MappingEvaluationValue['kind'][])(
    'propagates %s even through fallback or condition',
    (kind) => {
      for (const example of STRUCTURE_TRANSFORM_CASES.filter(
        (item) => !item.operation.startsWith('constant_')
      )) {
        const graph = rule(example.operation, example.parameters);
        graph.transforms.unshift({ id: 'upstream', operation: 'copy', inputs: [{ edgeIndex: 0 }] });
        graph.transforms[1].inputs = [{ stepIndex: 0 }];
        graph.output = { stepIndex: 1 };
        const prepared: MappingEvaluationValue =
          kind === 'failed' ? { kind: 'failed' } : { kind: 'suppressed' };
        expect(
          evaluateMappingRule({
            rule: graph,
            sourceValues: [{ value: 'x', sourceRef: ref }],
            preparedSteps: new Map([['upstream', prepared]]),
          }).output
        ).toEqual(prepared);
      }
    }
  );
});

describe('conditional named dependencies', () => {
  it('includes condition-only sources in graph analysis, classification and provenance', () => {
    const graph = conditionRule();
    expect([
      ...analyzeMappingDependencies({ ...graph, edgeCount: graph.edges.length }).edgeIndexes,
    ]).toEqual([0, 1]);
    const result = evaluateMappingRule({
      rule: graph,
      sourceValues: [
        { sourceRef: ref, value: 'original' },
        {
          sourceRef: graph.edges[1].sourceRef,
          value: 'Engineering',
          classificationHint: 'secret',
          provenanceHint: { sourceId: 'condition-source' },
        },
      ],
    });
    expect(result.output).toMatchObject({
      kind: 'value',
      envelope: {
        value: 'member',
        classificationHint: 'secret',
        provenanceHints: [{ sourceId: 'condition-source' }],
      },
    });
  });
  it('does not consult runtimeContext subject fields', () => {
    const result = evaluateMappingRule({
      rule: conditionRule(),
      sourceValues: [{ sourceRef: ref, value: 'original' }],
      runtimeContext: { department: 'Engineering', subject: { department: 'Engineering' } },
    });
    expect(result.output).toMatchObject({ kind: 'value', envelope: { value: 'original' } });
  });
  it.each(['value', 'field:department', 'unknown'])(
    'refuses missing, duplicate or unowned name %s',
    (name) => {
      const graph = conditionRule();
      graph.transforms[0].inputs = [
        { edgeIndex: 0, name },
        { edgeIndex: 1, name },
      ];
      expect(validateMappingRuleGraph(graph).length).toBeGreaterThan(0);
    }
  );
  it.each([
    '{',
    JSON.stringify({ kind: 'group', match: 'all', children: [] }),
    JSON.stringify({ kind: 'rule', field: 'department', operator: 'regex', value: '(a+)+$' }),
    JSON.stringify({ kind: 'rule', field: 'hidden', operator: 'eq', value: 'x' }),
  ])('refuses invalid conditions and hidden dependencies', (condition) => {
    const graph = conditionRule();
    graph.transforms[0].parameters = { ...CONDITIONAL_PARAMETERS, condition };
    expect(validateMappingRuleGraph(graph).length).toBeGreaterThan(0);
  });
  it.each(['0x10', '1e3', '+2', '.5', '42.', 'Infinity'])(
    'refuses non-decimal conditional branch %s',
    (thenValue) => {
      const graph = conditionRule();
      graph.transforms[0].parameters = {
        ...CONDITIONAL_PARAMETERS,
        valueType: 'as_number',
        thenValue,
      };
      expect(validateMappingRuleGraph(graph).map((item) => item.code)).toContain(
        'transform.invalid_parameter'
      );
    }
  );
  it('retains the console decimal-number branch syntax', () => {
    const graph = conditionRule();
    graph.transforms[0].parameters = {
      ...CONDITIONAL_PARAMETERS,
      valueType: 'as_number',
      thenValue: ' -3.5 ',
    };
    expect(
      evaluateMappingRule({
        rule: graph,
        sourceValues: [{ sourceRef: graph.edges[1].sourceRef, value: 'Engineering' }],
      }).output
    ).toMatchObject({ kind: 'value', envelope: { value: -3.5 } });
  });

  it.each(['none', 'fixed', 'as_is'])('handles absent value with elseMode %s', (elseMode) => {
    const graph = conditionRule();
    graph.transforms[0].parameters = { ...CONDITIONAL_PARAMETERS, elseMode, elseValue: 'fallback' };
    const output = evaluateMappingRule({ rule: graph, sourceValues: [] }).output;
    if (elseMode === 'as_is') expect(output).toEqual({ kind: 'absent' });
    else
      expect(output).toMatchObject({
        kind: 'value',
        envelope: { value: elseMode === 'none' ? null : 'fallback' },
      });
  });
});

describe('structure safety matrices', () => {
  it('fails oversized parsed arrays instead of selecting a fallback', () => {
    const input = JSON.stringify({ items: Array(501).fill('synthetic') });
    for (const operation of [
      'json_extract_array',
      'json_extract_or',
    ] satisfies TransformOperation[]) {
      const result = run(operation, input, {
        path: 'items',
        ...(operation === 'json_extract_or' ? { defaultValue: 'must not replace failure' } : {}),
      });
      expect(result.output.kind).toBe('failed');
      expect(result.reasons.map((item) => item.code)).toContain('transform.limit_exceeded');
    }
  });
  it('caps array build output even when each source array is within the limit', () => {
    const graph = rule('array_build');
    graph.transforms[0].inputs = [{ edgeIndex: 0 }, { edgeIndex: 0 }];
    expect(
      evaluateMappingRule({
        rule: graph,
        sourceValues: [{ sourceRef: ref, value: Array(251).fill('x') }],
      }).reasons.map((item) => item.code)
    ).toContain('transform.limit_exceeded');
  });
  it('caps condition depth and node count before execution', () => {
    let node: unknown = { kind: 'rule', field: 'department', operator: 'exists', value: null };
    for (let i = 0; i < 4; i++) node = { kind: 'group', match: 'all', children: [node] };
    const graph = conditionRule();
    for (const condition of [
      JSON.stringify(node),
      JSON.stringify({
        kind: 'group',
        match: 'all',
        children: Array(64).fill({
          kind: 'rule',
          field: 'department',
          operator: 'exists',
          value: null,
        }),
      }),
    ]) {
      graph.transforms[0].parameters = { ...CONDITIONAL_PARAMETERS, condition };
      expect(validateMappingRuleGraph(graph).length).toBeGreaterThan(0);
    }
  });
  it('charges condition regex work and input limits before executing', () => {
    const graph = conditionRule();
    for (const [pattern, actual, expected] of [
      ['^' + 'a'.repeat(510), 'a'.repeat(1024), 'transform.work_limit_exceeded'],
      ['^a+$', 'a'.repeat(1025), 'transform.limit_exceeded'],
    ]) {
      graph.transforms[0].parameters = {
        ...CONDITIONAL_PARAMETERS,
        condition: JSON.stringify({
          kind: 'rule',
          field: 'department',
          operator: 'regex',
          value: pattern,
        }),
      };
      const result = evaluateMappingRule({
        rule: graph,
        sourceValues: [{ sourceRef: graph.edges[1].sourceRef, value: actual }],
      });
      expect(result.output.kind).toBe('failed');
      expect(result.reasons.map((item) => item.code)).toContain(expected);
    }
  });
  it.each([{ kind: 'failed' }, { kind: 'suppressed' }] satisfies MappingEvaluationValue[])(
    'propagates $kind from a condition-only transformed input',
    (prepared) => {
      const graph = conditionRule();
      graph.transforms.unshift({
        id: 'condition-input',
        operation: 'copy',
        inputs: [{ edgeIndex: 1 }],
      });
      graph.transforms[1].inputs = [
        { edgeIndex: 0, name: 'value' },
        { stepIndex: 0, name: 'field:department' },
      ];
      graph.output = { stepIndex: 1 };
      expect(
        evaluateMappingRule({
          rule: graph,
          sourceValues: [{ sourceRef: graph.edges[1].sourceRef, value: 'Engineering' }],
          preparedSteps: new Map([['condition-input', prepared]]),
        }).output
      ).toEqual(prepared);
    }
  );
  it.each([
    ...STRUCTURE_TRANSFORM_CASES.map((item) => ({
      operation: item.operation,
      parameters: item.parameters,
    })),
    { operation: 'hash', parameters: { encoding: 'hex' } },
  ] satisfies { operation: TransformOperation; parameters: Record<string, unknown> }[])(
    'refuses $operation after persistent identifiers',
    (example) => {
      const graph = rule(example.operation, example.parameters);
      graph.transforms.unshift({
        id: 'identifier',
        operation: 'persistent_identifier',
        inputs: [],
        parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
      });
      graph.transforms[1].inputs = [{ stepIndex: 0 }];
      graph.output = { stepIndex: 1 };
      expect(validateMappingRuleGraph(graph).map((item) => item.code)).toContain(
        'transform.identifier_post_transform_not_allowed'
      );
    }
  );
});

import { describe, expect, it } from 'vitest';
import { evaluateMappingRule } from '../../core/graph-evaluator';
import { analyzeMappingDependencies } from '../../core/graph';
import { executeRuntimeMapping } from '../../core/runtime';
import { dryRunMapping } from '../../core/dry-run';
import { dropSuppressedTargets } from '../../core/transforms';
import { validateMappingInput } from '../../core/validation';
import type {
  MappingRuleGraph,
  MappingEvaluationValue,
  MappingValueReference,
  MappingGraphTransform,
} from '../../core/types';
import { mappingInput, sourceValue } from '../../test-support';

function rule(
  transforms: MappingGraphTransform[] = [],
  output: MappingValueReference = { edgeIndex: 0 }
): MappingRuleGraph {
  const input = mappingInput([]);
  return {
    id: 'graph',
    edges: input.edges,
    targetRef: input.edges[0].targetRef,
    transforms,
    output,
  };
}
const trim: MappingGraphTransform = { id: 'trim', operation: 'trim', inputs: [{ edgeIndex: 0 }] };
const identifier: MappingGraphTransform = {
  id: 'identifier',
  operation: 'persistent_identifier',
  inputs: [],
  parameters: {
    input: 'account',
    format: 'plain',
    algorithm: 'authrim_sha256',
  },
};
function evaluate(graph: MappingRuleGraph, value: unknown) {
  return evaluateMappingRule({
    rule: graph,
    sourceValues: [sourceValue('csv', 'email', value, 'pii')],
  });
}

describe('rule graph evaluation', () => {
  it('evaluates per-input steps, combines all ordered inputs, and chains post-steps', () => {
    const graph = rule(
      [
        trim,
        {
          id: 'upper',
          operation: 'case',
          inputs: [{ edgeIndex: 1 }],
          parameters: { mode: 'upper' },
        },
        {
          id: 'combine',
          operation: 'concat',
          inputs: [{ stepIndex: 0 }, { stepIndex: 1 }],
          parameters: { delimiter: ':' },
        },
        {
          id: 'post',
          operation: 'affix_text',
          inputs: [{ stepIndex: 2 }],
          parameters: { prefix: '[', suffix: ']' },
        },
      ],
      { stepIndex: 3 }
    );
    const second = {
      ...graph.edges[0],
      id: 'second',
      sourceRef: { ...graph.edges[0].sourceRef, path: 'second', catalogEntryId: undefined },
    };
    graph.edges.push(second);
    const result = evaluateMappingRule({
      rule: graph,
      sourceValues: [
        sourceValue('csv', 'email', ' a ', 'public'),
        {
          value: 'b',
          sourceRef: second.sourceRef,
          classificationHint: 'secret',
          provenanceHint: { sourceId: 'second-source' },
        },
      ],
    });
    expect(result.output).toMatchObject({
      kind: 'value',
      envelope: {
        value: '[a:B]',
        classificationHint: 'secret',
        provenanceHints: [{ sourceId: 'second-source' }],
      },
    });
    expect(analyzeMappingDependencies({ ...graph, edgeCount: graph.edges.length })).toEqual({
      stepIndexes: [0, 1, 2, 3],
      edgeIndexes: new Set([0, 1]),
    });
  });

  it('copies without transforms and preserves null, empty string and empty array', () => {
    for (const value of [null, '', []])
      expect(evaluate(rule(), value).output).toMatchObject({ kind: 'value', envelope: { value } });
    expect(evaluateMappingRule({ rule: rule(), sourceValues: [] }).output).toEqual({
      kind: 'absent',
    });
  });

  it('propagates absence without missing_input failures and lets fallback handle it', () => {
    expect(
      evaluateMappingRule({ rule: rule([trim], { stepIndex: 0 }), sourceValues: [] })
    ).toMatchObject({ output: { kind: 'absent' }, reasons: [] });
    const graph = rule(
      [{ id: 'fallback', operation: 'fallback', inputs: [{ edgeIndex: 0 }, { edgeIndex: 1 }] }],
      { stepIndex: 0 }
    );
    graph.edges.push({ ...graph.edges[0], id: 'other' });
    expect(evaluateMappingRule({ rule: graph, sourceValues: [] }).output).toEqual({
      kind: 'absent',
    });
    graph.edges[1] = {
      ...graph.edges[1],
      sourceRef: { side: 'source', namespace: 'csv', path: 'backup' },
    };
    expect(
      evaluateMappingRule({
        rule: graph,
        sourceValues: [{ value: 'backup', sourceRef: graph.edges[1].sourceRef }],
      }).output
    ).toMatchObject({ kind: 'value', envelope: { value: 'backup' } });
  });

  it('passes every input to join, first and json_build in order, preserving source keys through per-input steps', () => {
    for (const operation of ['join', 'first', 'json_build']) {
      const combine: MappingGraphTransform = {
        id: 'combine',
        operation: operation === 'join' ? 'join' : operation === 'first' ? 'first' : 'json_build',
        inputs: [{ stepIndex: 0 }, { stepIndex: 1 }],
        parameters: operation === 'json_build' ? { nullHandling: 'include_null' } : undefined,
      };
      const graph = rule(
        [trim, { ...trim, id: 'second-trim', inputs: [{ edgeIndex: 1 }] }, combine],
        { stepIndex: 2 }
      );
      graph.edges.push({
        ...graph.edges[0],
        id: 'backup',
        sourceRef: { side: 'source', namespace: 'csv', path: 'backup' },
      });
      const result = evaluateMappingRule({
        rule: graph,
        sourceValues: [
          sourceValue('csv', 'email', ' a '),
          { value: ' b ', sourceRef: graph.edges[1].sourceRef },
        ],
      });
      const expected =
        operation === 'join' ? 'a,b' : operation === 'first' ? 'a' : { email: 'a', backup: 'b' };
      expect(result.output).toMatchObject({ kind: 'value', envelope: { value: expected } });
    }
  });

  it('allows first to consume absence and distinguishes absent from null in json_build', () => {
    const graph = rule(
      [{ id: 'first', operation: 'first', inputs: [{ edgeIndex: 0 }, { edgeIndex: 1 }] }],
      { stepIndex: 0 }
    );
    graph.edges.push({
      ...graph.edges[0],
      id: 'backup',
      sourceRef: { side: 'source', namespace: 'csv', path: 'backup' },
    });
    const sourceValues = [{ value: 'backup', sourceRef: graph.edges[1].sourceRef }];
    expect(evaluateMappingRule({ rule: graph, sourceValues }).output).toMatchObject({
      kind: 'value',
      envelope: { value: 'backup' },
    });
    graph.transforms[0] = {
      ...graph.transforms[0],
      operation: 'json_build',
      parameters: { nullHandling: 'include_null' },
    };
    expect(evaluateMappingRule({ rule: graph, sourceValues }).output).toMatchObject({
      kind: 'value',
      envelope: { value: { backup: 'backup' } },
    });
  });

  it('generates an identifier without any source edges', () => {
    const graph = { ...rule([identifier], { stepIndex: 0 }), edges: [] };
    expect(
      evaluateMappingRule({
        rule: graph,
        sourceValues: [],
        runtimeContext: { identifiers: { identifier: 'generated' } },
      }).output
    ).toMatchObject({ kind: 'value', envelope: { value: 'generated' } });
    expect(evaluateMappingRule({ rule: graph, sourceValues: [] })).toMatchObject({
      output: { kind: 'failed' },
      reasons: [expect.objectContaining({ code: 'transform.identifier_unavailable' })],
    });
  });

  it.each<MappingValueReference>([
    { edgeIndex: -1 },
    { edgeIndex: 9 },
    { edgeIndex: 0.5 },
    { stepIndex: 0 },
  ])('refuses dangling output %j', (output) => {
    expect(evaluateMappingRule({ rule: rule([], output), sourceValues: [] })).toMatchObject({
      output: { kind: 'failed' },
      reasons: [expect.objectContaining({ code: 'transform.invalid_reference' })],
    });
  });

  it('refuses forward references, cycles, and dangling unused steps', () => {
    for (const inputs of [[{ stepIndex: 0 }], [{ stepIndex: 1 }], [{ edgeIndex: 5 }]]) {
      const graph = rule([{ ...trim, inputs }]);
      expect(() => analyzeMappingDependencies({ ...graph, edgeCount: 1 })).toThrow(
        'invalid_reference'
      );
      expect(
        validateMappingInput({ ...mappingInput([]), graphRules: [graph] }).reasons
      ).toContainEqual(expect.objectContaining({ code: 'transform.invalid_reference' }));
    }
  });

  it('propagates suppression through allowed identifier steps and removes the target', () => {
    const graph = rule([identifier, { ...trim, inputs: [{ stepIndex: 0 }] }], { stepIndex: 1 });
    graph.edges = [];
    const runtimeContext = { suppressedIdentifiers: { identifier: true } };
    expect(evaluateMappingRule({ rule: graph, sourceValues: [], runtimeContext }).output).toEqual({
      kind: 'suppressed',
    });
    expect(
      dropSuppressedTargets(
        [{ value: 'stand-in', sourceRef: graph.targetRef }],
        [],
        runtimeContext,
        [graph]
      )
    ).toEqual([]);
  });

  it('allows registered safe identifier text steps and releases their final value', () => {
    const graph = rule(
      [
        identifier,
        {
          id: 'affix',
          operation: 'affix_text',
          inputs: [{ stepIndex: 0 }],
          parameters: { prefix: ' ID:' },
        },
        { id: 'trim-id', operation: 'trim', inputs: [{ stepIndex: 1 }] },
        {
          id: 'case-id',
          operation: 'case',
          inputs: [{ stepIndex: 2 }],
          parameters: { mode: 'lower' },
        },
      ],
      { stepIndex: 3 }
    );
    expect(
      evaluateMappingRule({
        rule: graph,
        sourceValues: [],
        runtimeContext: { identifiers: { identifier: 'ABC' } },
      }).output
    ).toMatchObject({ kind: 'value', envelope: { value: 'id:abc' } });
  });

  it.each(['saml.nameid', 'oidc.claim'])(
    'refuses identifier post-steps for protected target %s',
    (namespace) => {
      const graph = rule([identifier, { ...trim, inputs: [{ stepIndex: 0 }] }], { stepIndex: 1 });
      graph.targetRef = { side: 'destination', namespace, path: 'sub' };
      graph.pairwiseSubject = true;
      expect(evaluateMappingRule({ rule: graph, sourceValues: [] }).reasons).toContainEqual(
        expect.objectContaining({ code: 'transform.identifier_post_transform_not_allowed' })
      );
    }
  );

  it('refuses combining after an identifier, even in an unused step', () => {
    const graph = rule(
      [identifier, { id: 'bad', operation: 'fallback', inputs: [{ stepIndex: 0 }] }],
      { stepIndex: 0 }
    );
    expect(evaluateMappingRule({ rule: graph, sourceValues: [] }).reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.identifier_post_transform_not_allowed' })
    );
  });

  it('never lets prepared values override identifier suppression', () => {
    const graph = rule([identifier], { stepIndex: 0 });
    const preparedSteps = new Map<string, MappingEvaluationValue>([
      [
        'identifier',
        { kind: 'value', envelope: { value: 'stand-in', sourceRef: graph.targetRef } },
      ],
    ]);
    expect(
      evaluateMappingRule({
        rule: graph,
        sourceValues: [],
        preparedSteps,
        runtimeContext: { suppressedIdentifiers: { identifier: true } },
      }).output
    ).toEqual({ kind: 'suppressed' });
  });

  it.each([false, true])(
    'refuses invalid identifier settings despite a prepared value (preparedSteps=%s)',
    (usePreparedSteps) => {
      const graph = rule(
        [{ ...identifier, parameters: { ...identifier.parameters, algorithm: 'invalid' } }],
        { stepIndex: 0 }
      );
      const preparedSteps = new Map<string, MappingEvaluationValue>([
        [
          identifier.id,
          { kind: 'value', envelope: { value: 'prepared', sourceRef: graph.targetRef } },
        ],
      ]);
      const result = executeRuntimeMapping({
        ...mappingInput([sourceValue('csv', 'email', 'raw-stand-in')]),
        graphRules: [graph],
        ...(usePreparedSteps
          ? { preparedSteps }
          : { runtimeContext: { identifiers: { [identifier.id]: 'prepared' } } }),
      });
      expect(result.status).toBe('failed');
      expect(result.values).toEqual([]);
      expect(result.reasons).toContainEqual(
        expect.objectContaining({ code: 'transform.identifier_unavailable' })
      );
    }
  );

  it('supports prepared results from an asynchronous pre-pass and propagates failures', () => {
    const graph = rule([trim], { stepIndex: 0 });
    const prepared = new Map<string, MappingEvaluationValue>([['trim', { kind: 'failed' }]]);
    expect(
      evaluateMappingRule({
        rule: graph,
        sourceValues: [sourceValue('csv', 'email', 'value')],
        preparedSteps: prepared,
      }).output
    ).toEqual({ kind: 'failed' });
  });

  it('releases only the explicit output and validates the final type and cardinality', () => {
    const graph = rule([{ id: 'split', operation: 'split', inputs: [{ edgeIndex: 0 }] }], {
      stepIndex: 0,
    });
    const input = {
      ...mappingInput([sourceValue('csv', 'email', 'a,b')]),
      graphRules: [graph],
      validationRules: [
        {
          id: 'single',
          kind: 'cardinality',
          targetRef: graph.targetRef,
          parameters: { cardinality: 'single' },
        },
        {
          id: 'number',
          kind: 'type',
          targetRef: graph.targetRef,
          parameters: { valueType: 'number' },
        },
      ],
    } satisfies Parameters<typeof executeRuntimeMapping>[0];
    const result = executeRuntimeMapping(input);
    expect(result.values.map((value) => value.value)).toEqual([['a', 'b']]);
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'validation.cardinality_mismatch' })
    );
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'validation.type_mismatch' })
    );
    expect(dryRunMapping(input).reasons).toEqual(result.reasons);
  });

  it('reconstructs single-edge stored rows and releases only their final output', () => {
    const input = mappingInput([sourceValue('csv', 'email', ' a ')]);
    const transforms = [
      {
        id: 'trim',
        ruleId: 'stored-rule',
        operation: trim.operation,
        inputEdgeIds: [input.edges[0].id],
        outputTargetRef: input.edges[0].targetRef,
      },
    ];
    const stored = {
      ...input,
      edges: input.edges.map((edge) => ({ ...edge, ruleId: 'stored-rule' })),
      transforms,
    };
    expect(executeRuntimeMapping(stored).values.map((value) => value.value)).toEqual(['a']);
    expect(dryRunMapping(stored).summary.mappedCount).toBe(1);
    expect(
      executeRuntimeMapping({
        ...stored,
        transforms: [{ ...transforms[0], inputEdgeIds: ['missing'] }],
      })
    ).toMatchObject({ status: 'failed', values: [] });
    // TODO(W1b): callers without row rule boundaries still use the isolated compatibility path.
    expect(
      executeRuntimeMapping({
        ...input,
        transforms: [{ ...transforms[0], ruleId: undefined }],
      }).values.map((value) => value.value)
    ).toEqual([' a ', 'a']);
  });

  it('never lowers catalog classification through a source hint', () => {
    const graph = rule([trim], { stepIndex: 0 });
    const input = {
      ...mappingInput([sourceValue('csv', 'email', ' value ', 'public')]),
      graphRules: [graph],
    };
    expect(executeRuntimeMapping(input).values[0]?.classificationHint).toBe('pii');
  });

  it('validates required on the final absent value and rejects duplicate targets', () => {
    const graph = rule([trim], { stepIndex: 0 });
    const input = {
      ...mappingInput([]),
      graphRules: [graph],
      validationRules: [{ id: 'required', kind: 'required', targetRef: graph.targetRef }],
    } satisfies Parameters<typeof executeRuntimeMapping>[0];
    expect(executeRuntimeMapping(input).reasons).toContainEqual(
      expect.objectContaining({ code: 'validation.required_missing' })
    );
    const duplicate = executeRuntimeMapping({
      ...input,
      graphRules: [graph, { ...graph, id: 'other' }],
    });
    expect(duplicate).toMatchObject({ status: 'failed', values: [] });
    expect(duplicate.reasons.map((item) => item.code)).toContain('transform.duplicate_target');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { evaluateMappingRule, evaluatePreparedMappingRule } from '../../core/graph-evaluator';
import type { FieldRef, MappingEvaluationValue, MappingRuleGraph } from '../../core/types';

const ref: FieldRef = { side: 'source', namespace: 'synthetic', path: 'value' };
function graph(): MappingRuleGraph {
  return {
    id: 'deferred',
    targetRef: ref,
    edges: [{ id: 'input', sourceRef: ref, targetRef: ref }],
    transforms: [
      { id: 'first', operation: 'copy', inputs: [{ edgeIndex: 0 }] },
      { id: 'other', operation: 'copy', inputs: [{ edgeIndex: 0 }] },
      { id: 'output', operation: 'concat', inputs: [{ stepIndex: 0 }, { stepIndex: 1 }] },
    ],
    output: { stepIndex: 2 },
  };
}

describe('deferred evaluation state', () => {
  it.each([
    { kind: 'failed' },
    { kind: 'suppressed' },
    { kind: 'absent' },
  ] satisfies MappingEvaluationValue[])(
    'keeps $kind precedence over deferred where appropriate',
    (other) => {
      const preparedSteps = new Map<string, MappingEvaluationValue>([
        ['first', { kind: 'deferred' }],
        ['other', other],
        // A cached downstream value must not turn a pending dependency into an actual value.
        ['output', { kind: 'value', envelope: { sourceRef: ref, value: 'forbidden' } }],
      ]);
      const result = evaluateMappingRule({
        rule: graph(),
        sourceValues: [{ sourceRef: ref, value: 'synthetic' }],
        preparedSteps,
      });
      expect(result.output).toEqual(other.kind === 'absent' ? { kind: 'deferred' } : other);
      expect(result.reasons).toEqual([]);
    }
  );

  it('does not invoke another hash or its preparer with a deferred dependency', async () => {
    const rule = graph();
    rule.transforms = [
      {
        id: 'first',
        operation: 'hash',
        parameters: { encoding: 'hex' },
        inputs: [{ edgeIndex: 0 }],
      },
      {
        id: 'second',
        operation: 'hash',
        parameters: { encoding: 'hex' },
        inputs: [{ stepIndex: 0 }],
      },
    ];
    rule.output = { stepIndex: 1 };
    const prepare = vi.fn(async (): Promise<MappingEvaluationValue> => ({ kind: 'deferred' }));
    const result = await evaluatePreparedMappingRule(
      { rule, sourceValues: [{ sourceRef: ref, value: 'synthetic' }] },
      prepare
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.steps.get(1)).toEqual({ kind: 'deferred' });
    expect(result.output).toEqual({ kind: 'deferred' });
  });

  it('still refuses invalid parameters before accepting a deferred preparation', () => {
    const rule = graph();
    rule.transforms[2] = {
      id: 'output',
      operation: 'case',
      parameters: { mode: 'invalid' },
      inputs: [{ stepIndex: 0 }],
    };
    const result = evaluateMappingRule({
      rule,
      sourceValues: [{ sourceRef: ref, value: 'synthetic' }],
      preparedSteps: new Map([['first', { kind: 'deferred' }]]),
    });
    expect(result.output).toEqual({ kind: 'failed' });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.invalid_parameter' })
    );
  });

  it('defers approved identifier text post-steps while keeping explicit identifier suppression', () => {
    const rule = graph();
    rule.edges = [];
    rule.transforms = [
      {
        id: 'identifier',
        operation: 'persistent_identifier',
        parameters: { input: 'account', algorithm: 'shibboleth', format: 'plain' },
        inputs: [],
      },
      { id: 'upper', operation: 'case', parameters: { mode: 'upper' }, inputs: [{ stepIndex: 0 }] },
    ];
    rule.output = { stepIndex: 1 };
    const input = {
      rule,
      sourceValues: [],
      preparedSteps: new Map<string, MappingEvaluationValue>([
        ['identifier', { kind: 'deferred' }],
      ]),
    };
    expect(evaluateMappingRule(input).output).toEqual({ kind: 'deferred' });
    expect(
      evaluateMappingRule({
        ...input,
        runtimeContext: { suppressedIdentifiers: { identifier: true } },
      }).output
    ).toEqual({ kind: 'suppressed' });
  });
});

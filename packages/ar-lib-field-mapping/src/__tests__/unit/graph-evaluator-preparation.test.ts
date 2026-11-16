import { describe, expect, it, vi } from 'vitest';
import { evaluateMappingRule } from '../../core/graph-evaluator';
import { TRANSFORM_LIMITS } from '../../core/transform-safety';
import type { FieldRef, MappingEvaluationValue, MappingRuleGraph } from '../../core/types';

const sourceRef: FieldRef = { side: 'source', namespace: 'sample', path: 'value' };
const targetRef: FieldRef = { side: 'derived', namespace: 'sample', path: 'value' };
function graph(): MappingRuleGraph {
  return {
    id: 'prepared',
    targetRef,
    edges: [{ id: 'in', sourceRef, targetRef }],
    transforms: [
      { id: 'trim', operation: 'trim', inputs: [{ edgeIndex: 0 }] },
      { id: 'local', operation: 'concat', inputs: [{ stepIndex: 0 }] },
      {
        id: 'upper',
        operation: 'case',
        parameters: { mode: 'upper' },
        inputs: [{ stepIndex: 1 }],
      },
    ],
    output: { stepIndex: 2 },
  };
}
function value(value: unknown): MappingEvaluationValue {
  return { kind: 'value', envelope: { value, sourceRef } };
}

describe('graph evaluation with synchronous step preparers', () => {
  it('calls a preparer once with cached dependencies and retains classification', () => {
    const prepare = vi.fn((inputs: readonly MappingEvaluationValue[]) => {
      expect(inputs).toMatchObject([{ kind: 'value', envelope: { value: 'a' } }]);
      return value('local');
    });
    const result = evaluateMappingRule({
      rule: graph(),
      sourceValues: [{ value: ' a ', sourceRef, classificationHint: 'secret' }],
      stepPreparers: new Map([['local', prepare]]),
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.steps.get(0)).toMatchObject(value('a'));
    expect(result.steps.get(1)).toMatchObject(value('local'));
    expect(result.output).toMatchObject({
      kind: 'value',
      envelope: { value: 'LOCAL', classificationHint: 'secret' },
    });
  });

  it('includes disconnected authoring steps only when requested', () => {
    const rule = { ...graph(), output: { stepIndex: 0 } };
    const prepare = vi.fn(() => value('local'));
    const input = {
      rule,
      sourceValues: [{ value: ' a ', sourceRef }],
      stepPreparers: new Map([['local', prepare]]),
    };
    expect(evaluateMappingRule(input).steps.size).toBe(1);
    expect(prepare).not.toHaveBeenCalled();
    const result = evaluateMappingRule({ ...input, evaluateAllSteps: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.steps.size).toBe(3);
    expect(result.output).toMatchObject({
      kind: 'value',
      envelope: { value: 'a', sourceRef: targetRef },
    });
    expect(result.steps.get(2)).toMatchObject(value('LOCAL'));
  });

  it('uses only the remaining output budget for disconnected trace rows', () => {
    const rule = graph();
    rule.transforms = Array.from({ length: 80 }, (_, index) => ({
      id: `unused${index}`,
      operation: 'trim',
      inputs: [index === 0 ? { edgeIndex: 0 } : { stepIndex: index - 1 }],
    }));
    rule.transforms.push({ id: 'output', operation: 'trim', inputs: [{ edgeIndex: 0 }] });
    rule.output = { stepIndex: 80 };
    const text = 'a'.repeat(30000);
    const input = { rule, sourceValues: [{ value: text, sourceRef }] };
    const result = evaluateMappingRule({ ...input, evaluateAllSteps: true });
    expect(result.output).toEqual(evaluateMappingRule(input).output);
    expect(result.output).toMatchObject({ kind: 'value', envelope: { value: text } });
    expect(result.steps.get(79)).toEqual({ kind: 'failed' });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.work_limit_exceeded' })
    );
  });

  it('checks input caps before calling a preparer', () => {
    const prepare = vi.fn(() => value('small'));
    const rule = graph();
    rule.transforms[1].inputs = [{ edgeIndex: 0 }];
    const result = evaluateMappingRule({
      rule,
      sourceValues: [{ value: 'a'.repeat(TRANSFORM_LIMITS.valueBytes), sourceRef }],
      stepPreparers: new Map([['local', prepare]]),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(result.output).toEqual({ kind: 'failed' });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.limit_exceeded' })
    );
  });

  it('checks prepared output caps and catches preparer exceptions', () => {
    for (const prepare of [
      () => value('a'.repeat(TRANSFORM_LIMITS.valueBytes)),
      () => {
        throw new Error('invalid preview input');
      },
    ]) {
      const result = evaluateMappingRule({
        rule: graph(),
        sourceValues: [{ value: 'a', sourceRef }],
        stepPreparers: new Map([['local', prepare]]),
      });
      expect(result.output).toEqual({ kind: 'failed' });
      expect(result.reasons).toHaveLength(1);
    }
  });

  it('does not call preparers on failed or suppressed dependencies', () => {
    for (const kind of ['failed', 'suppressed']) {
      const prepare = vi.fn(() => value('unexpected'));
      const prepared: MappingEvaluationValue =
        kind === 'failed' ? { kind: 'failed' } : { kind: 'suppressed' };
      const result = evaluateMappingRule({
        rule: graph(),
        sourceValues: [{ value: 'a', sourceRef }],
        preparedSteps: new Map([['trim', prepared]]),
        stepPreparers: new Map([['local', prepare]]),
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(result.output).toEqual(prepared);
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { evaluateMappingRule } from '../../core/graph-evaluator';
import { executeTransformStep } from '../../core/transforms';
import { TRANSFORM_LIMITS } from '../../core/transform-safety';
import type { FieldRef, SourceValueEnvelope, MappingEvaluationValue } from '../../core/types';

const sourceRef: FieldRef = { side: 'source', namespace: 'csv', path: 'record.name' };
function run(source: SourceValueEnvelope, remaining = TRANSFORM_LIMITS.ruleWork) {
  const budget = { remaining };
  const result = executeTransformStep({
    step: {
      id: 'json',
      operation: 'json_build',
      parameters: { nullHandling: 'omit' },
      inputEdgeIds: ['in'],
      outputTargetRef: sourceRef,
    },
    edgeValues: new Map([['in', source]]),
    workBudget: budget,
  });
  return { result, budget };
}

describe('json_build key safety', () => {
  it('rejects the huge interior-underscore column name before key shaping', () => {
    const { result, budget } = run({
      sourceRef,
      value: 'x',
      metadata: { columnName: `a${'_'.repeat(30000)}a` },
    });
    expect(result.value).toBeUndefined();
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.limit_exceeded' })
    );
    expect(budget.remaining).toBe(TRANSFORM_LIMITS.ruleWork);
  });

  it.each(['columnName', 'csvHeaderName', 'fieldPath'])(
    'caps and charges the %s metadata used for key lookup',
    (field) => {
      const source = { sourceRef, value: 'x', metadata: { [field]: 'a'.repeat(1000) } };
      expect(run(source, 100).result.reasons).toContainEqual(
        expect.objectContaining({ code: 'transform.work_limit_exceeded' })
      );
      expect(
        run({ ...source, metadata: { [field]: 'é'.repeat(TRANSFORM_LIMITS.keyBytes) } }).result
          .reasons
      ).toContainEqual(expect.objectContaining({ code: 'transform.limit_exceeded' }));
    }
  );

  it.each(['path', 'catalogEntryId'])(
    'caps and charges the source reference %s before looking up keys',
    (field) => {
      const source = { sourceRef: { ...sourceRef, [field]: 'a'.repeat(1000) }, value: 'x' };
      expect(run(source, 100).result.reasons).toContainEqual(
        expect.objectContaining({ code: 'transform.work_limit_exceeded' })
      );
      expect(
        run({
          ...source,
          sourceRef: { ...sourceRef, [field]: 'a'.repeat(TRANSFORM_LIMITS.keyBytes + 1) },
        }).result.reasons
      ).toContainEqual(expect.objectContaining({ code: 'transform.limit_exceeded' }));
    }
  );

  it('preserves key shaping, interior underscores and path fallback within the bounds', () => {
    const key = `a${'_'.repeat(3000)}a`;
    expect(
      run({ sourceRef, value: 'x', metadata: { columnName: `__${key}__` } }).result.value?.value
    ).toEqual({ [key]: 'x' });
    expect(run({ sourceRef, value: 'x' }).result.value?.value).toEqual({ name: 'x' });
    expect(
      run({ sourceRef, value: 'x', metadata: { columnName: ' __ ' } }).result.value?.value
    ).toEqual({ value: 'x' });
  });

  it('checks the same key budget before calling a graph step preparer', () => {
    const prepare = vi.fn(
      (): MappingEvaluationValue => ({ kind: 'value', envelope: { sourceRef, value: {} } })
    );
    const result = evaluateMappingRule({
      rule: {
        id: 'json',
        targetRef: sourceRef,
        edges: [{ id: 'in', sourceRef, targetRef: sourceRef }],
        transforms: [
          {
            id: 'json',
            operation: 'json_build',
            parameters: { nullHandling: 'omit' },
            inputs: [{ edgeIndex: 0 }],
          },
        ],
        output: { stepIndex: 0 },
      },
      sourceValues: [{ sourceRef, value: 'x', metadata: { columnName: 'a'.repeat(30000) } }],
      stepPreparers: new Map([['json', prepare]]),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.limit_exceeded' })
    );
  });

  it('bounds the aggregate metadata and value bytes for a step', () => {
    const inputs: SourceValueEnvelope[] = Array.from({ length: 10 }, (_, index) => ({
      value: 'x',
      sourceRef: { ...sourceRef, path: `field${index}` },
      metadata: { columnName: 'a'.repeat(4000) },
    }));
    const result = executeTransformStep({
      step: {
        id: 'json',
        operation: 'json_build',
        parameters: { nullHandling: 'omit' },
        inputEdgeIds: inputs.map((_, i) => String(i)),
        outputTargetRef: sourceRef,
      },
      edgeValues: new Map(inputs.map((source, i) => [String(i), source])),
    });
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.limit_exceeded' })
    );
  });
});

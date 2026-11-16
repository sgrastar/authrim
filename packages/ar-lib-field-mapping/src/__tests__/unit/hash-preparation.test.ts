import { describe, expect, it, vi } from 'vitest';
import { evaluateMappingRule, evaluatePreparedMappingRule } from '../../core/graph-evaluator';
import type {
  FieldRef,
  MappingEvaluationValue,
  MappingRuleGraph,
  TransformOperation,
} from '../../core/types';
const ref: FieldRef = { side: 'source', namespace: 'synthetic', path: 'input' };
function rule(
  operation: TransformOperation,
  parameters: Record<string, unknown> = {}
): MappingRuleGraph {
  return {
    id: 'rule',
    targetRef: ref,
    edges: [{ id: 'edge', sourceRef: ref, targetRef: ref }],
    transforms: [{ id: 'step', operation, parameters, inputs: [{ edgeIndex: 0 }] }],
    output: { stepIndex: 0 },
  };
}
describe('asynchronous prepared hash continuation', () => {
  it('prepares transformed dependencies once, including chained hashes', async () => {
    const graph = rule('trim');
    graph.transforms.push(
      {
        id: 'hash1',
        operation: 'hash',
        parameters: { encoding: 'hex' },
        inputs: [{ stepIndex: 0 }],
      },
      {
        id: 'hash2',
        operation: 'hash',
        parameters: { encoding: 'hex' },
        inputs: [{ stepIndex: 1 }],
      }
    );
    graph.output = { stepIndex: 2 };
    const seen: unknown[] = [];
    const prepare = vi.fn(
      async ({
        inputs,
      }: {
        inputs: readonly MappingEvaluationValue[];
      }): Promise<MappingEvaluationValue> => {
        const first = inputs[0];
        if (first.kind !== 'value') return first;
        seen.push(first.envelope.value);
        return {
          kind: 'value',
          envelope: { ...first.envelope, value: `${String(first.envelope.value)}!` },
        };
      }
    );
    const result = await evaluatePreparedMappingRule(
      { rule: graph, sourceValues: [{ sourceRef: ref, value: ' transformed ' }] },
      prepare
    );
    expect(seen).toEqual(['transformed', 'transformed!']);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(result.output).toMatchObject({ kind: 'value', envelope: { value: 'transformed!!' } });
    expect(result.steps.size).toBe(3);
  });
  it('fails missing preparation and contains thrown key acquisition errors', async () => {
    const input = {
      rule: rule('hash', { encoding: 'hex' }),
      sourceValues: [{ sourceRef: ref, value: 'synthetic' }],
    };
    expect(evaluateMappingRule(input).reasons.map((item) => item.code)).toContain(
      'transform.hash_unavailable'
    );
    const result = await evaluatePreparedMappingRule(input, async () => {
      throw new Error('never expose this');
    });
    expect(result.output.kind).toBe('failed');
    expect(result.reasons.map((item) => item.code)).toEqual(['transform.hash_unavailable']);
  });
  it('checks budgets before preparing and propagates absence', async () => {
    const prepare = vi.fn(async (): Promise<MappingEvaluationValue> => ({ kind: 'failed' }));
    const graph = rule('hash', { encoding: 'hex' });
    await evaluatePreparedMappingRule({ rule: graph, sourceValues: [] }, prepare);
    await evaluatePreparedMappingRule(
      { rule: graph, sourceValues: [{ sourceRef: ref, value: 'x'.repeat(32768) }] },
      prepare
    );
    expect(prepare).not.toHaveBeenCalled();
  });
});

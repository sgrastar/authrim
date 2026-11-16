import { describe, expect, it } from 'vitest';
import { readMappingCondition } from '../../core/conditions';
import { evaluateMappingRule } from '../../core/graph-evaluator';
import type { FieldRef, MappingRuleGraph } from '../../core/types';

const targetRef: FieldRef = { side: 'destination', namespace: 'synthetic', path: 'membership' };
const department: FieldRef = { side: 'source', namespace: 'synthetic', path: 'department' };
const status: FieldRef = { ...department, path: 'status' };

function rule(match: unknown): MappingRuleGraph {
  return {
    id: 'group',
    targetRef,
    edges: [
      { id: 'department', sourceRef: department, targetRef },
      { id: 'status', sourceRef: status, targetRef },
    ],
    transforms: [
      {
        id: 'membership',
        operation: 'conditional',
        parameters: {
          condition: JSON.stringify({
            kind: 'group',
            match,
            children: [
              { kind: 'rule', field: 'department', operator: 'eq', value: 'Engineering' },
              { kind: 'rule', field: 'status', operator: 'eq', value: 'active' },
            ],
          }),
          valueType: 'as_text',
          thenValue: 'member',
          elseMode: 'fixed',
          elseValue: 'not-member',
        },
        inputs: [
          { edgeIndex: 0, name: 'value' },
          { edgeIndex: 0, name: 'field:department' },
          { edgeIndex: 1, name: 'field:status' },
        ],
      },
    ],
    output: { stepIndex: 0 },
  };
}

describe('condition group match contract', () => {
  it.each(
    [['all'], ['any'], ['none'], [['all']], [], null, 0, true, {}, { match: 'all' }, 'ALL', ''].map(
      (match) => ({ match })
    )
  )('rejects match $match without coercion', ({ match }) => {
    const graph = rule(match);
    expect(readMappingCondition(graph.transforms[0].parameters?.condition)).toBeUndefined();
    const evaluated = evaluateMappingRule({
      rule: graph,
      sourceValues: [
        { sourceRef: department, value: 'Engineering' },
        { sourceRef: status, value: 'active' },
      ],
    });
    expect(evaluated.output).toEqual({ kind: 'failed' });
    expect(evaluated.reasons).toContainEqual(
      expect.objectContaining({ code: 'transform.invalid_parameter' })
    );
  });

  it.each([
    { match: 'all', department: 'Engineering', status: 'active', expected: 'member' },
    { match: 'all', department: 'Engineering', status: 'inactive', expected: 'not-member' },
    { match: 'all', department: 'Other', status: 'inactive', expected: 'not-member' },
    { match: 'any', department: 'Engineering', status: 'active', expected: 'member' },
    { match: 'any', department: 'Engineering', status: 'inactive', expected: 'member' },
    { match: 'any', department: 'Other', status: 'inactive', expected: 'not-member' },
    { match: 'none', department: 'Engineering', status: 'active', expected: 'not-member' },
    { match: 'none', department: 'Engineering', status: 'inactive', expected: 'not-member' },
    { match: 'none', department: 'Other', status: 'inactive', expected: 'member' },
  ])('branches for $match with $department / $status', (example) => {
    const evaluated = evaluateMappingRule({
      rule: rule(example.match),
      sourceValues: [
        { sourceRef: department, value: example.department },
        { sourceRef: status, value: example.status },
      ],
    });
    expect(evaluated.reasons).toEqual([]);
    expect(evaluated.output).toMatchObject({
      kind: 'value',
      envelope: { value: example.expected },
    });
  });
});

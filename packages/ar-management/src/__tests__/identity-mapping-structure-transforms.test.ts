import { describe, expect, it } from 'vitest';
import {
  STRUCTURE_TRANSFORM_CASES,
  CONDITIONAL_PARAMETERS,
} from '@authrim/ar-lib-field-mapping/test-support';
import { assertMappingGraphContract } from '../identity-mapping-graph-contract';
import type { FieldMappingVersionRuleInput } from '../identity-mapping-control-plane';

const targetRef = { side: 'destination', namespace: 'oidc.claim', path: 'name' };
function rule(
  operation: string,
  parameters: Record<string, unknown>
): FieldMappingVersionRuleInput {
  return {
    ruleKey: 'structure',
    ruleKind: 'mapping',
    action: 'allow',
    targetRef,
    edges: [{ sourceRef: { side: 'source', namespace: 'synthetic', path: 'value' }, targetRef }],
    transforms: [
      {
        operation,
        parameters,
        inputs: operation.startsWith('constant_') ? [] : [{ edgeIndex: 0 }],
      },
    ],
    output: { stepIndex: 0 },
  };
}

describe('shared structure save schema', () => {
  it.each(['all', 'any', 'none'])('accepts a string group match %s on save', (match) => {
    const value = rule('conditional', {
      ...CONDITIONAL_PARAMETERS,
      condition: JSON.stringify({
        kind: 'group',
        match,
        children: [{ kind: 'rule', field: 'department', operator: 'eq', value: 'Engineering' }],
      }),
    });
    value.transforms = value.transforms?.map((step) => ({
      ...step,
      inputs: [
        { edgeIndex: 0, name: 'value' },
        { edgeIndex: 0, name: 'field:department' },
      ],
    }));
    expect(() => assertMappingGraphContract(value, 'rule')).not.toThrow();
  });
  it.each(
    [['all'], ['any'], ['none'], [['all']], [], null, 0, true, {}, { match: 'all' }].map(
      (match) => ({ match })
    )
  )('refuses non-string group match $match on save', ({ match }) => {
    const value = rule('conditional', {
      ...CONDITIONAL_PARAMETERS,
      condition: JSON.stringify({
        kind: 'group',
        match,
        children: [{ kind: 'rule', field: 'department', operator: 'eq', value: 'Engineering' }],
      }),
    });
    value.transforms = value.transforms?.map((step) => ({
      ...step,
      inputs: [
        { edgeIndex: 0, name: 'value' },
        { edgeIndex: 0, name: 'field:department' },
      ],
    }));
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow('parameters or input arity');
  });
  it.each(STRUCTURE_TRANSFORM_CASES)('accepts $operation', (example) =>
    expect(() =>
      assertMappingGraphContract(rule(example.operation, example.parameters), 'rule')
    ).not.toThrow()
  );
  it.each(STRUCTURE_TRANSFORM_CASES)('refuses malformed $operation parameters', (example) =>
    expect(() =>
      assertMappingGraphContract(
        rule(example.operation, { ...example.parameters, hidden: 'field' }),
        'rule'
      )
    ).toThrow('parameters or input arity')
  );
  it('requires owned named condition dependencies', () => {
    const value = rule('conditional', CONDITIONAL_PARAMETERS);
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow();
    value.transforms = [
      {
        operation: 'conditional',
        parameters: CONDITIONAL_PARAMETERS,
        inputs: [
          { edgeIndex: 0, name: 'value' },
          { edgeIndex: 0, name: 'field:department' },
        ],
      },
    ];
    expect(() => assertMappingGraphContract(value, 'rule')).not.toThrow();
    value.transforms[0].inputs = [
      { edgeIndex: 0, name: 'value' },
      { edgeIndex: 1, name: 'field:department' },
    ];
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow('reference');
  });
  it.each([
    ...STRUCTURE_TRANSFORM_CASES.map((item) => ({
      operation: item.operation,
      parameters: item.parameters,
    })),
    { operation: 'hash', parameters: { encoding: 'hex' } },
    { operation: 'conditional', parameters: CONDITIONAL_PARAMETERS },
  ])('refuses $operation after identifiers', (example) => {
    const value = rule(example.operation, example.parameters);
    value.transforms = [
      {
        operation: 'persistent_identifier',
        parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
        inputs: [],
      },
      {
        operation: example.operation,
        parameters: example.parameters,
        inputs:
          example.operation === 'conditional'
            ? [
                { stepIndex: 0, name: 'value' },
                { edgeIndex: 0, name: 'field:department' },
              ]
            : [{ stepIndex: 0 }],
      },
    ];
    value.output = { stepIndex: 1 };
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow();
  });
});

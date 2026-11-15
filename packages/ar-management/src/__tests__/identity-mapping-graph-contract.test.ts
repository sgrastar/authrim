import { describe, expect, it } from 'vitest';
import { assertMappingGraphContract } from '../identity-mapping-graph-contract';
import type { FieldMappingVersionRuleInput } from '../identity-mapping-control-plane';

const targetRef = { side: 'destination', namespace: 'oidc.claim', path: 'name' };
function rule(): FieldMappingVersionRuleInput {
  return {
    ruleKey: 'name',
    ruleKind: 'mapping',
    action: 'allow',
    targetRef,
    edges: ['given', 'family'].map((path) => ({
      sourceRef: { side: 'source', namespace: 'csv', path },
      targetRef,
    })),
    transforms: [
      {
        operation: 'concat',
        inputs: [
          { edgeIndex: 0, name: 'given' },
          { edgeIndex: 1, name: 'family' },
        ],
        parameters: { delimiter: ' ' },
      },
      { operation: 'trim', inputs: [{ stepIndex: 0 }] },
    ],
    output: { stepIndex: 1 },
  };
}
describe('persisted graph contract', () => {
  it('accepts chained, multi-input, named and non-last outputs', () => {
    const value = rule();
    expect(() => assertMappingGraphContract(value, 'rule')).not.toThrow();
    value.output = { stepIndex: 0 };
    expect(() => assertMappingGraphContract(value, 'rule')).not.toThrow();
  });
  it('refuses legacy transform edgeIndex', () => {
    const value = { ...rule(), transforms: [{ operation: 'trim', edgeIndex: 0 }] };
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow('legacy edgeIndex');
  });
  it('refuses an output name rather than discarding it at persistence', () => {
    const value = rule();
    value.output = { stepIndex: 1, name: 'not-an-input' };
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow(
      'names apply only to step inputs'
    );
  });
  it('checks unused and forward references', () => {
    const value = rule();
    if (value.transforms) value.transforms[0].inputs = [{ stepIndex: 1 }];
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow('reference');
  });
});

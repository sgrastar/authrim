import { describe, expect, it } from 'vitest';
import { TEST_CATALOG, CONDITIONAL_PARAMETERS } from '@authrim/ar-lib-field-mapping/test-support';
import type {
  FieldRef,
  MappingGraphTransform,
  MappingRuleGraph,
} from '@authrim/ar-lib-field-mapping/contract';
import { scimRuleOutputShape } from '../scim-identity-mapping-catalog';
const ref: FieldRef = { side: 'source', namespace: 'synthetic', path: 'value' };
function shape(step: MappingGraphTransform) {
  const rule: MappingRuleGraph = {
    id: 'shape',
    targetRef: ref,
    edges: [
      { id: 'value', sourceRef: ref, targetRef: ref },
      { id: 'condition', sourceRef: { ...ref, path: 'department' }, targetRef: ref },
    ],
    transforms: [step],
    output: { stepIndex: 0 },
  };
  return scimRuleOutputShape(rule, { ...TEST_CATALOG, entries: [] }, [
    { sourceRef: ref, value: 'synthetic' },
    { sourceRef: rule.edges[1].sourceRef, value: ['Engineering'] },
  ]);
}
describe('SCIM structure output shapes', () => {
  it('does not make a scalar conditional multi-valued because its condition reads an array', () => {
    expect(
      shape({
        id: 'choose',
        operation: 'conditional',
        parameters: { ...CONDITIONAL_PARAMETERS, valueType: 'as_boolean', thenBool: 'true' },
        inputs: [
          { edgeIndex: 0, name: 'value' },
          { edgeIndex: 1, name: 'field:department' },
        ],
      })
    ).toEqual({ valueType: 'boolean', cardinality: 'single' });
  });
  it('does not infer JSON array elements as text from a JSON-text input', () =>
    expect(
      shape({
        id: 'array',
        operation: 'json_extract_array',
        parameters: { path: 'items' },
        inputs: [{ edgeIndex: 0 }],
      })
    ).toEqual({ valueType: 'unknown', cardinality: 'multi' }));
  it('extracts fallback text as one value even from a collection input', () =>
    expect(
      shape({
        id: 'fallback',
        operation: 'json_extract_or',
        parameters: { path: 'name', defaultValue: '' },
        inputs: [{ edgeIndex: 1 }],
      })
    ).toEqual({ valueType: 'string', cardinality: 'single' }));
});

import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import { describe, expect, it } from 'vitest';
import { TEST_CATALOG, CONDITIONAL_PARAMETERS } from '@authrim/ar-lib-field-mapping/test-support';
import type { FieldRef, MappingRuleGraph } from '@authrim/ar-lib-field-mapping/contract';
import { assertRuntimeIdentityMappingReleaseSafety } from '../identity-mapping-runtime-resolver';

const valueRef: FieldRef = { side: 'source', namespace: 'synthetic', path: 'value' };
const conditionRef: FieldRef = { side: 'source', namespace: 'synthetic', path: 'department' };
const targetRef: FieldRef = { side: 'destination', namespace: 'saml.attribute', path: 'output' };
const rule: MappingRuleGraph = {
  id: 'condition-release',
  targetRef,
  edges: [
    { id: 'value', sourceRef: valueRef, targetRef },
    { id: 'condition', sourceRef: conditionRef, targetRef },
  ],
  transforms: [
    {
      id: 'choose',
      operation: 'conditional',
      parameters: CONDITIONAL_PARAMETERS,
      inputs: [
        { edgeIndex: 0, name: 'value' },
        { edgeIndex: 1, name: 'field:department' },
      ],
    },
  ],
  output: { stepIndex: 0 },
};

describe('conditional release safety', () => {
  it('refuses classification lowering through a condition-only dependency', () => {
    const binding = {
      edges: [],
      graphRules: [rule],
      catalog: {
        ...TEST_CATALOG,
        entries: [
          {
            id: 'value',
            namespace: 'synthetic',
            path: 'value',
            valueType: 'string',
            cardinality: 'single',
            classification: 'public',
          },
          {
            id: 'condition',
            namespace: 'synthetic',
            path: 'department',
            valueType: 'string',
            cardinality: 'single',
            classification: 'secret',
          },
        ],
      },
    } satisfies Parameters<typeof assertRuntimeIdentityMappingReleaseSafety>[0];
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(
        binding,
        [{ key: 'output', classification: 'public', requiredScopes: [] }],
        false,
        { requireKnownSources: true }
      )
    ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(
        binding,
        [{ key: 'output', classification: 'secret', requiredScopes: [] }],
        false,
        { requireKnownSources: true }
      )
    ).not.toThrow();
    const evaluated = executeRuntimeMapping({
      ...binding,
      catalog: {
        ...binding.catalog,
        entries: [
          ...binding.catalog.entries,
          {
            id: 'output',
            namespace: 'saml.attribute',
            path: 'output',
            valueType: 'string',
            cardinality: 'single',
            classification: 'public',
          },
        ],
      },
      sourceValues: [{ sourceRef: valueRef, value: 'synthetic' }],
    });
    expect(evaluated.values[0]?.classificationHint).toBe('secret');
    binding.catalog.entries.pop();
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(
        binding,
        [{ key: 'output', classification: 'secret', requiredScopes: [] }],
        false,
        { requireKnownSources: true }
      )
    ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
  });
});

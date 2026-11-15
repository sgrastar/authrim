import { withExplicitMappingGraphs } from '@authrim/ar-lib-field-mapping/test-support';
import { describe, expect, it } from 'vitest';
import type { MappingInput, ValidationRule } from '@authrim/ar-lib-field-mapping/contract';
import { TEST_CATALOG } from '@authrim/ar-lib-field-mapping/test-support';
import { buildSAMLAttributesForSPWithDiagnostics } from '../attributes';

function binding(single = false): Partial<MappingInput> {
  const targetRef: MappingInput['edges'][number]['targetRef'] = {
    side: 'destination',
    namespace: 'saml.attribute',
    path: 'mail',
  };
  const validationRules: ValidationRule[] = [{ id: 'required', kind: 'required', targetRef }];
  if (single)
    validationRules.push({
      id: 'single',
      kind: 'cardinality',
      targetRef,
      defaultSeverity: 'critical',
      parameters: { cardinality: 'single' },
    });
  return withExplicitMappingGraphs(
    {
      catalog: {
        ...TEST_CATALOG,
        entries: [
          ...['first', 'second'].map((path) => ({
            ...TEST_CATALOG.entries[0],
            id: path,
            namespace: 'authrim.profile',
            path: `attributes.${path}`,
          })),
          {
            ...TEST_CATALOG.entries[4],
            cardinality: 'multi',
          } satisfies import('@authrim/ar-lib-field-mapping/contract').FieldCatalogEntry,
        ],
      },
      edges: ['first', 'second'].map((id) => ({
        id,
        ruleId: id,
        targetRef,
        sourceRef: { side: 'source', namespace: 'authrim.profile', path: `attributes.${id}` },
      })),
      validationRules,
    },
    true
  );
}

describe('SAML validation after attribute aggregation', () => {
  it.each([false, true])(
    'accepts a required attribute with one empty and one present writer (reverse=%s)',
    (reverse) => {
      const result = buildSAMLAttributesForSPWithDiagnostics(
        {
          id: 'user',
          attributes: {
            first: reverse ? '' : 'present',
            second: reverse ? 'present' : '',
          },
        },
        { attributeMapping: {}, identityMapping: binding() }
      );
      expect(result.attributes.flatMap((attribute) => attribute.values)).toEqual(['present']);
    }
  );

  it('checks cardinality after merging and deduplicating every writer', () => {
    expect(() =>
      buildSAMLAttributesForSPWithDiagnostics(
        { id: 'user', attributes: { first: 'one', second: 'two' } },
        { attributeMapping: {}, identityMapping: binding(true) }
      )
    ).toThrow('validation.cardinality_mismatch');
    const result = buildSAMLAttributesForSPWithDiagnostics(
      { id: 'user', attributes: { first: 'one', second: 'one' } },
      { attributeMapping: {}, identityMapping: binding(true) }
    );
    expect(result.attributes.flatMap((attribute) => attribute.values)).toEqual(['one']);
  });
});

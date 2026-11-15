import { describe, expect, it } from 'vitest';
import type { MappingRuleGraph } from '@authrim/ar-lib-field-mapping/contract';
import { TEST_CATALOG } from '@authrim/ar-lib-field-mapping/test-support';
import { withMappingGraph } from '@authrim/ar-lib-field-mapping/authoring';
import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import { sliceOutputGraph } from '../identity-mapping-output-graph';
import { assertRuntimeIdentityMappingReleaseSafety } from '../identity-mapping-runtime-resolver';
import { mappedPairwiseSubject } from '../mapped-identifiers';

function graph(): MappingRuleGraph {
  return {
    id: 'rule',
    targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
    edges: [
      {
        id: 'first',
        sourceRef: {
          side: 'source',
          namespace: 'csv',
          path: 'email',
          catalogEntryId: 'field.csv.email',
        },
        targetRef: { side: 'derived', namespace: 'intermediate', path: 'first' },
      },
      {
        id: 'sensitive',
        sourceRef: {
          side: 'source',
          namespace: 'csv',
          path: 'employeeNumber',
          catalogEntryId: 'field.csv.employee_number',
        },
        targetRef: { side: 'derived', namespace: 'intermediate', path: 'second' },
      },
      {
        id: 'unused',
        sourceRef: { side: 'source', namespace: 'csv', path: 'email' },
        targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'unused' },
      },
    ],
    transforms: [
      { id: 'first-step', operation: 'trim', inputs: [{ edgeIndex: 0 }] },
      { id: 'second-step', operation: 'trim', inputs: [{ edgeIndex: 1 }] },
      { id: 'combine', operation: 'concat', inputs: [{ stepIndex: 0 }, { stepIndex: 1 }] },
      { id: 'unused-step', operation: 'copy', inputs: [{ edgeIndex: 2 }] },
    ],
    output: { stepIndex: 2 },
  };
}

describe('graph-aware release consumers', () => {
  it('slices every dependency, including the sensitive second input, and excludes unused values', () => {
    const rule = graph();
    const binding = withMappingGraph({
      catalog: TEST_CATALOG,
      edges: rule.edges,
      graphRules: [rule],
    });
    const slice = sliceOutputGraph({ ...binding, destinationNamespace: 'oidc.claim' });
    expect(slice.edges.map((edge) => edge.id)).toEqual(['first', 'sensitive']);
    expect(slice.transforms.map((step) => step.id)).toEqual([
      'first-step',
      'second-step',
      'combine',
    ]);
    expect(slice.graphRules).toEqual([rule]);
  });

  it.each([false, true])(
    'checks the final destination against every source (strict=%s)',
    (requireKnownSources) => {
      const rule = graph();
      const binding = { catalog: TEST_CATALOG, edges: rule.edges, graphRules: [rule] };
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding,
          [{ key: 'email', classification: 'pii', requiredScopes: ['email'] }],
          true,
          { requireKnownSources }
        )
      ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding,
          [{ key: 'email', classification: 'regulated', requiredScopes: ['email'] }],
          true,
          { requireKnownSources }
        )
      ).not.toThrow();
    }
  );

  it('requires the graph output itself to be the pairwise identifier', () => {
    const rule = graph();
    rule.targetRef.path = 'sub';
    rule.edges = [];
    rule.transforms = [
      {
        id: 'identifier',
        operation: 'persistent_identifier',
        inputs: [],
        parameters: {
          input: 'account',
          format: 'plain',
          algorithm: 'authrim_sha256',
          audience: 'sector',
        },
      },
    ];
    rule.output = { stepIndex: 0 };
    const input = {
      graphRules: [rule],
      identifiers: { identifier: 'made' },
      finalSubject: 'made',
      destinationNamespace: 'oidc.claim',
    };
    expect(mappedPairwiseSubject(input)).toBe('made');
    rule.transforms.push({ id: 'post', operation: 'trim', inputs: [{ stepIndex: 0 }] });
    rule.output = { stepIndex: 1 };
    expect(mappedPairwiseSubject(input)).toBeNull();
  });

  it.each([false, true])(
    'slices required checks on final graph targets, including generating rules (generating=%s)',
    (generating) => {
      const rules: MappingRuleGraph[] = ['canonical', 'saml'].map((id) => ({
        ...graph(),
        id,
        targetRef: {
          side: id === 'canonical' ? 'canonical' : 'destination',
          namespace: id === 'canonical' ? 'authrim.profile' : 'saml.attribute',
          path: id === 'canonical' ? 'email' : 'mail',
        },
        edges: generating ? [] : [{ ...graph().edges[0], id: `${id}-edge` }],
        transforms: [
          generating
            ? {
                id: `${id}-step`,
                operation: 'persistent_identifier',
                inputs: [],
                parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
              }
            : { id: `${id}-step`, operation: 'trim', inputs: [{ edgeIndex: 0 }] },
        ],
        output: { stepIndex: 0 },
      }));
      const binding = withMappingGraph({
        edges: rules.flatMap((rule) => rule.edges),
        graphRules: rules,
      });
      const sliced = sliceOutputGraph({
        ...binding,
        destinationNamespace: 'saml.attribute',
        validationRules: rules.map((rule) => ({
          id: `${rule.id}-required`,
          kind: 'required',
          targetRef: rule.targetRef,
        })),
      });
      expect(sliced.graphRules?.map((rule) => rule.id)).toEqual(['saml']);
      expect(sliced.validationRules.map((rule) => rule.id)).toEqual(['saml-required']);
      const result = executeRuntimeMapping({
        ...sliced,
        catalog: TEST_CATALOG,
        sourceValues: [
          { value: ' public ', sourceRef: { side: 'source', namespace: 'csv', path: 'email' } },
        ],
        validationRules: sliced.validationRules.map((rule) => ({ ...rule, kind: 'required' })),
        runtimeContext: { identifiers: { 'saml-step': 'public' } },
      });
      expect(result.status).toBe('success');
      expect(result.values.map((value) => value.value)).toEqual(['public']);
      expect(result.reasons.some((reason) => reason.code === 'validation.required_missing')).toBe(
        false
      );
    }
  );
});

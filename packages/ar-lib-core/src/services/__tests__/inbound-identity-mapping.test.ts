import { describe, expect, it } from 'vitest';
import { withMappingGraph } from '@authrim/ar-lib-field-mapping/authoring';
import type { FieldCatalogBundle, MappingRuleGraph } from '@authrim/ar-lib-field-mapping/contract';
import {
  assertInboundMappingGraph,
  defaultInboundSources,
  inboundProfileTargets,
  evaluateInboundMapping,
} from '../inbound-identity-mapping';

function fixture() {
  const targets = inboundProfileTargets();
  const catalog: FieldCatalogBundle = {
    identity: { id: 'incoming', version: '1', contentHash: 'synthetic', compatibilityRange: '*' },
    entries: [...defaultInboundSources('oidc'), ...targets],
  };
  const targetRef = { side: 'destination', namespace: 'authrim.profile', path: 'email' };
  const rule: MappingRuleGraph = {
    id: 'mail',
    targetRef: { ...targetRef, side: 'destination' },
    edges: [
      {
        id: 'source',
        sourceRef: { side: 'source', namespace: 'oidc.userinfo', path: 'email' },
        targetRef: { ...targetRef, side: 'destination' },
      },
    ],
    transforms: [{ id: 'trim', operation: 'trim', inputs: [{ edgeIndex: 0 }] }],
    output: { stepIndex: 0 },
  };
  return { rule, catalog, targets };
}
describe('incoming connection graph boundary', () => {
  it('uses the tenant evaluator and projection; extra provider claims do not become outputs', async () => {
    const { rule, catalog, targets } = fixture();
    const result = await evaluateInboundMapping({
      env: {},
      tenantId: 'synthetic',
      protocol: 'oidc',
      targets,
      sources: [
        {
          sourceRef: { side: 'source', namespace: 'oidc.userinfo', path: 'email' },
          value: ' sample@example.test ',
        },
        {
          sourceRef: { side: 'source', namespace: 'oidc.userinfo', path: 'unmapped' },
          value: 'ignored',
        },
      ],
      binding: {
        ...withMappingGraph({ graphRules: [rule], edges: [], transforms: [] }),
        catalog,
        validationRules: [],
        fieldMappingSet: { id: 'incoming', rules: [] },
      },
    });
    expect(result).toEqual({ profile: { email: 'sample@example.test' }, customClaims: {} });
  });
  it('refuses subject generation, outgoing targets, wrong-direction sources and invalid references', () => {
    const { rule, catalog, targets } = fixture();
    for (const changed of [
      { ...rule, targetRef: { ...rule.targetRef, namespace: 'oidc.claim' } },
      { ...rule, targetRef: { ...rule.targetRef, path: 'sub' } },
      { ...rule, targetRef: { ...rule.targetRef, path: 'email_verified' } },
      { ...rule, output: { edgeIndex: 99 } },
      {
        ...rule,
        edges: [
          {
            ...rule.edges[0],
            sourceRef: { ...rule.edges[0].sourceRef, namespace: 'authrim.profile' },
          },
        ],
      },
    ])
      expect(() => assertInboundMappingGraph('oidc', [changed], catalog, targets)).toThrow();
    rule.transforms[0] = { id: 'identifier', operation: 'persistent_identifier', inputs: [] };
    expect(() => assertInboundMappingGraph('oidc', [rule], catalog, targets)).toThrow();
  });
  it('does not let a catalog id disguise a different claim, or lower source classification', () => {
    const { rule, catalog, targets } = fixture();
    rule.edges[0].sourceRef.catalogEntryId = 'inbound.source.oidc.userinfo:sub';
    expect(() => assertInboundMappingGraph('oidc', [rule], catalog, targets)).toThrow();
    delete rule.edges[0].sourceRef.catalogEntryId;
    catalog.entries[0].classification = 'public';
    rule.edges[0].sourceRef.path = 'sub';
    expect(() => assertInboundMappingGraph('oidc', [rule], catalog, targets)).toThrow();
  });
  it('refuses boolean to string output and unexpected runtime source types', async () => {
    const { rule, catalog, targets } = fixture();
    rule.edges[0].sourceRef.path = 'email_verified';
    rule.transforms = [];
    rule.output = { edgeIndex: 0 };
    expect(() => assertInboundMappingGraph('oidc', [rule], catalog, targets)).toThrow(
      'output_type'
    );
    rule.edges[0].sourceRef.path = 'email';
    await expect(
      evaluateInboundMapping({
        env: {},
        tenantId: 'synthetic',
        protocol: 'oidc',
        targets,
        sources: [{ sourceRef: rule.edges[0].sourceRef, value: false }],
        binding: {
          ...withMappingGraph({ graphRules: [rule], edges: [], transforms: [] }),
          catalog,
          validationRules: [],
          fieldMappingSet: { id: 'incoming', rules: [] },
        },
      })
    ).rejects.toThrow();
  });
  it('requires an explicit reduction for multi-valued sources and protects custom classification', () => {
    const { rule, catalog, targets } = fixture();
    const source = catalog.entries.find(
      (entry) => entry.namespace === 'oidc.userinfo' && entry.path === 'email'
    );
    if (!source) throw new Error('Missing fixture source');
    source.cardinality = 'multi';
    rule.transforms = [];
    rule.output = { edgeIndex: 0 };
    expect(() => assertInboundMappingGraph('oidc', [rule], catalog, targets)).toThrow(
      'output_type'
    );
    rule.transforms = [{ id: 'first', operation: 'first', inputs: [{ edgeIndex: 0 }] }];
    rule.output = { stepIndex: 0 };
    expect(() => assertInboundMappingGraph('oidc', [rule], catalog, targets)).not.toThrow();
    const custom = inboundProfileTargets([
      {
        id: 'custom-schema',
        namespace: 'authrim.canonical',
        path: 'staff_code',
        valueType: 'string',
        cardinality: 'single',
        classification: 'internal',
      },
    ]);
    rule.targetRef = {
      side: 'destination',
      namespace: 'authrim.custom_claims',
      path: 'staff_code',
    };
    rule.edges[0].targetRef = rule.targetRef;
    expect(() => assertInboundMappingGraph('oidc', [rule], catalog, custom)).toThrow(
      'schema_invalid'
    );
  });
});

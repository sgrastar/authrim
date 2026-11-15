import { contentFromStoredVersion } from '../identity-mapping-set-facade-content';
import { describe, expect, it } from 'vitest';
import {
  assertMappingGraphContract,
  canonicalMappingRule,
  canRepresentStoredRuleGraph,
  persistentEdgeIndex,
} from '../identity-mapping-graph-contract';
import type { FieldMappingVersionRuleInput } from '../identity-mapping-control-plane';

const edge = {
  sourceRef: { side: 'source', namespace: 'csv', path: 'email' },
  targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
};
function rule(): FieldMappingVersionRuleInput {
  return {
    ruleKey: 'email',
    ruleKind: 'mapping',
    action: 'allow',
    edges: [edge],
    transforms: [{ operation: 'trim', edgeIndex: 0 }],
  };
}

describe('W1a save graph contract', () => {
  it('accepts legacy edgeIndex and translates it to ordered inputs and explicit output', () => {
    const legacy = rule();
    expect(() => assertMappingGraphContract(legacy, 'rule')).not.toThrow();
    const normalized = canonicalMappingRule(legacy);
    expect(normalized).toMatchObject({
      output: { stepIndex: 0 },
      transforms: [{ operation: 'trim', inputs: [{ edgeIndex: 0 }] }],
    });
    expect(normalized.transforms?.[0]).not.toHaveProperty('edgeIndex');
    expect(persistentEdgeIndex(normalized.transforms?.[0] ?? { operation: 'trim' })).toBe(0);
    expect(() => assertMappingGraphContract(normalized, 'rule')).not.toThrow();
  });

  it('keeps a legacy generating group with several output targets readable without advertising a false graph', () => {
    const targets = ['first', 'second'].map((path) => ({
      side: 'destination',
      namespace: 'oidc.claim',
      path,
    }));
    const stored = {
      compatibilityRange: null,
      latestSnapshot: { catalogVersionId: 'catalog' },
      releaseRules: [],
      conflictRules: [],
      rules: [
        {
          ruleKey: 'legacy',
          ruleKind: 'mapping',
          action: 'allow',
          priority: 0,
          scope: {},
          condition: {},
          metadata: {},
          edges: [],
          validationRules: [],
          transforms: targets.map((targetRef) => ({
            edgeId: null,
            targetRef,
            operation: 'persistent_identifier',
            parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
          })),
        },
      ],
    };
    expect(canRepresentStoredRuleGraph(stored.rules[0])).toBe(false);
    const content = contentFromStoredVersion(stored);
    expect(content.rules[0]).not.toHaveProperty('output');
    expect(content.rules[0].transforms?.[0]).not.toHaveProperty('inputs');
    expect(() => assertMappingGraphContract(content.rules[0], 'rule')).not.toThrow();
  });

  it.each(['as_array', 'split', 'join', 'first'])(
    'accepts %s with one direct input',
    (operation) => {
      const value = {
        ...rule(),
        output: { stepIndex: 0 },
        transforms: [{ operation, inputs: [{ edgeIndex: 0 }] }],
      };
      expect(() => assertMappingGraphContract(value, 'rule')).not.toThrow();
    }
  );

  it.each<FieldMappingVersionRuleInput>([
    {
      ...rule(),
      output: { stepIndex: 0 },
      edges: [edge, edge],
      transforms: [{ operation: 'concat', inputs: [{ edgeIndex: 0 }, { edgeIndex: 1 }] }],
    },
    {
      ...rule(),
      output: { stepIndex: 1 },
      transforms: [
        { operation: 'trim', inputs: [{ edgeIndex: 0 }] },
        { operation: 'trim', inputs: [{ stepIndex: 0 }] },
      ],
    },
    { ...rule(), output: { edgeIndex: 0 } },
    {
      ...rule(),
      output: { stepIndex: 0 },
      transforms: [{ operation: 'trim', inputs: [{ edgeIndex: 0, name: 'value' }] }],
    },
  ])('refuses nonrepresentable graphs before persistence', (value) => {
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow(
      expect.objectContaining({ reason: 'unsupported_until_w1b' })
    );
  });

  it.each<FieldMappingVersionRuleInput>([
    { ...rule(), output: { stepIndex: 2 } },
    { ...rule(), transforms: [{ operation: 'trim', edgeIndex: 3 }] },
    {
      ...rule(),
      output: { stepIndex: 0 },
      transforms: [{ operation: 'trim', inputs: [{ stepIndex: 0 }] }],
    },
    {
      ...rule(),
      output: { stepIndex: 0 },
      transforms: [{ operation: 'trim', inputs: [{ edgeIndex: 0 }], edgeIndex: 1 }],
    },
  ])('refuses dangling references, cycles and conflicting spellings', (value) => {
    expect(() => assertMappingGraphContract(value, 'rule')).toThrow(
      expect.objectContaining({ reason: 'invalid_reference' })
    );
  });

  it('validates parameter schemas and single-input arity for every operation', () => {
    for (const value of [
      {
        ...rule(),
        transforms: [{ operation: 'case', edgeIndex: 0, parameters: { mode: 'invalid' } }],
      },
      {
        ...rule(),
        output: { stepIndex: 0 },
        edges: [edge, edge],
        transforms: [{ operation: 'trim', inputs: [{ edgeIndex: 0 }, { edgeIndex: 1 }] }],
      },
      {
        ...rule(),
        transforms: [{ operation: 'split', edgeIndex: 0, parameters: { delimiter: false } }],
      },
      {
        ...rule(),
        transforms: [{ operation: 'trim', edgeIndex: 0, parameters: { unknown: true } }],
      },
    ])
      expect(() => assertMappingGraphContract(value, 'rule')).toThrow(
        expect.objectContaining({ reason: 'invalid_transform' })
      );
  });

  it('rejects forbidden identifier post-steps before the persistence gate', () => {
    const identifier = {
      operation: 'persistent_identifier',
      inputs: [],
      parameters: { input: 'account', algorithm: 'authrim_sha256', format: 'plain' },
    };
    const cases: Array<{ targetRef: Record<string, unknown>; operation: string }> = [
      { targetRef: { namespace: 'saml.nameid', path: 'value' }, operation: 'trim' },
      { targetRef: { namespace: 'oidc.claim', path: 'email' }, operation: 'fallback' },
    ];
    for (const { targetRef, operation } of cases) {
      const value: FieldMappingVersionRuleInput = {
        ...rule(),
        targetRef,
        output: { stepIndex: 1 },
        transforms: [identifier, { operation, inputs: [{ stepIndex: 0 }] }],
      };
      expect(() => assertMappingGraphContract(value, 'rule')).toThrow(
        expect.objectContaining({ reason: 'identifier_post_transform_not_allowed' })
      );
    }
  });
});

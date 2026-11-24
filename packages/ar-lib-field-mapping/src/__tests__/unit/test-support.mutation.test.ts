import { describe, expect, it } from 'vitest';
import {
  createTestFingerprintProvider,
  edge,
  fieldRef,
  mappingInput,
  sourceValue,
  TEST_CATALOG,
  validateStaticFixture,
  withExplicitMappingGraphs,
} from '../../test-support';
import type { StaticFixtureKind } from '../../test-support';
import { graphFixture } from '../../test-support/graph-fixture';
import { reason } from '../../core/reason-registry';
import type { FieldRef, MappingInput, MappingRuleGraph } from '../../core/types';

const src = (path: string): FieldRef => ({ side: 'source', namespace: 'csv', path });
const dst = (path: string): FieldRef => ({ side: 'destination', namespace: 'oidc', path });

describe('static fixture validation', () => {
  const ok = { valid: true, reasons: [] };
  const bad = { valid: false, reasons: [reason('fixture.invalid_static_fixture')] };

  it.each<[StaticFixtureKind, unknown]>([
    ['csv-user', { email: 'a@example.test' }],
    ['malformed-user', { email: '' }],
    ['regulated-user', { email: 'a@example.test', extra: 1 }],
    ['scim-user', { userName: 'a' }],
    ['saml-attributes', [{ name: 'mail' }, { name: 'uid', values: [] }]],
    ['saml-attributes', []],
    ['oidc-claims-request', { email: null }],
    ['conflict-field-mapping-set', { sets: [] }],
  ])('accepts a %s shaped like %j', (kind, fixture) => {
    expect(validateStaticFixture(kind, fixture)).toEqual(ok);
  });

  it.each<[StaticFixtureKind, unknown]>([
    ['csv-user', {}],
    ['csv-user', null],
    ['csv-user', 'email'],
    ['csv-user', [{ email: 'a' }]],
    ['malformed-user', { name: 'a' }],
    ['regulated-user', undefined],
    ['scim-user', { email: 'a' }],
    ['scim-user', []],
    ['scim-user', 5],
    ['saml-attributes', { name: 'mail' }],
    ['saml-attributes', [{ name: 'mail' }, { name: 5 }]],
    ['saml-attributes', [{ name: 'mail' }, 'mail']],
    ['saml-attributes', [{ name: 'mail' }, null]],
    ['saml-attributes', [{ name: 'mail' }, ['mail']]],
    ['saml-attributes', 'mail'],
    ['oidc-claims-request', { name: 'a' }],
    ['oidc-claims-request', []],
    ['conflict-field-mapping-set', { sets: 'x' }],
    ['conflict-field-mapping-set', {}],
    ['conflict-field-mapping-set', [[]]],
    ['conflict-field-mapping-set', null],
    ['nonsense' as StaticFixtureKind, { email: 'a', userName: 'a', sets: [] }],
  ])('rejects a %s shaped like %j', (kind, fixture) => {
    expect(validateStaticFixture(kind, fixture)).toEqual(bad);
  });
});

describe('fixture builders', () => {
  it('builds source refs, with an optional catalog entry', () => {
    expect(fieldRef('csv', 'email')).toEqual({ side: 'source', namespace: 'csv', path: 'email' });
    expect(fieldRef('csv', 'email', 'field.csv.email').catalogEntryId).toBe('field.csv.email');
  });

  it('builds source values with their provenance metadata', () => {
    expect(sourceValue('csv', 'email', 'a@example.test', 'pii')).toEqual({
      value: 'a@example.test',
      sourceRef: fieldRef('csv', 'email'),
      metadata: { sourceType: 'csv', fieldPath: 'email' },
      classificationHint: 'pii',
    });
    expect(sourceValue('csv', 'email', 1).classificationHint).toBeUndefined();
  });

  it('builds edges whose ids depend on both ends', () => {
    const a = edge(src('a'), dst('x'));
    expect(a.sourceRef).toEqual(src('a'));
    expect(a.targetRef).toEqual(dst('x'));
    expect(a.id).toMatch(/^edge\.csv\.a\.oidc\.x\.[0-9a-f]{6}$/u);
    expect(edge(src('a'), dst('x')).id).toBe(a.id);
    expect(edge(src('b'), dst('x')).id).not.toBe(a.id);
    expect(edge(src('a'), dst('y')).id).not.toBe(a.id);
    expect(edge(src('a'), { ...dst('x'), namespace: 'saml' }).id).not.toBe(a.id);
    expect(edge({ ...src('a'), namespace: 'scim' }, dst('x')).id).not.toBe(a.id);
  });

  it('builds a catalogued email mapping input around the given values', () => {
    const values = [sourceValue('csv', 'email', 'a@example.test', 'pii')];
    const input = mappingInput(values);
    expect(input.catalog).toBe(TEST_CATALOG);
    expect(input.sourceValues).toBe(values);
    expect(input.edges).toHaveLength(1);
    expect(input.edges[0].sourceRef).toEqual(fieldRef('csv', 'email', 'field.csv.email'));
    expect(input.edges[0].targetRef).toEqual({
      side: 'canonical',
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'field.canonical.email',
    });
    const ids = TEST_CATALOG.entries.map((entry) => entry.id);
    expect(ids).toContain('field.csv.email');
    expect(ids).toContain('field.canonical.email');
  });

  it('fingerprints by classification and value type only, never by the value', () => {
    const provider = createTestFingerprintProvider();
    const pii = provider.fingerprint({ classification: 'pii', value: 'a' });
    expect(pii).toMatch(/^fixture\.fingerprint\.pii\.[0-9a-f]{6}$/u);
    expect(provider.fingerprint({ classification: 'pii', value: 'b' })).toBe(pii);
    expect(provider.fingerprint({ classification: 'pii', value: 1 })).not.toBe(pii);
    expect(provider.fingerprint({ classification: 'regulated', value: 'a' })).toMatch(
      /^fixture\.fingerprint\.regulated\.[0-9a-f]{6}$/u
    );
    expect(provider.fingerprint({ classification: 'regulated', value: 'a' })).not.toBe(pii);
  });
});

describe('graphFixture', () => {
  const e1 = { id: 'e1', sourceRef: src('a'), targetRef: dst('x') };
  const e2 = { id: 'e2', sourceRef: src('b'), targetRef: dst('y'), ruleId: 'named' };
  const e3 = { id: 'e3', sourceRef: src('c'), targetRef: dst('z') };
  const e4 = { id: 'e4', sourceRef: src('d'), targetRef: dst('z') };
  const base: MappingInput = { ...mappingInput([]), edges: [e1, e2, e3, e4] };

  it('returns the input untouched when it already has graphs', () => {
    const graphRules: MappingRuleGraph[] = [];
    const input = { ...base, graphRules };
    expect(graphFixture(input)).toBe(input);
  });

  it('turns every edge no transform consumes into a pass-through rule, in order', () => {
    const rules = graphFixture(base).graphRules ?? [];
    expect(rules).toHaveLength(4);
    expect(rules.map((rule) => rule.id)).toEqual(['e1', 'named', 'e3', 'e4']);
    expect(rules.map((rule) => rule.writerOrder)).toEqual([0, 1, 2, 3]);
    expect(rules[0]).toEqual({
      id: 'e1',
      targetRef: e1.targetRef,
      edges: [e1],
      transforms: [],
      output: { edgeIndex: 0 },
      writerOrder: 0,
    });
  });

  it('wraps each transform step in a rule over the edges it consumes', () => {
    const output = dst('joined');
    const input: MappingInput = {
      ...base,
      transforms: [
        {
          id: 't1',
          operation: 'array_build',
          inputEdgeIds: ['e4', 'e3'],
          parameters: {},
          outputTargetRef: output,
        },
        {
          id: 't2',
          ruleId: 'custom',
          operation: 'strip_accents',
          inputEdgeIds: ['e1'],
          outputTargetRef: dst('plain'),
        },
      ],
    };
    const rules = graphFixture(input).graphRules ?? [];
    expect(rules.map((rule) => rule.id)).toEqual(['named', 't1', 'custom']);
    const [, joined, custom] = rules;
    expect(joined.targetRef).toBe(output);
    expect(joined.edges).toEqual([e4, e3]);
    expect(joined.transforms).toHaveLength(1);
    expect(joined.transforms[0].inputs).toEqual([{ edgeIndex: 0 }, { edgeIndex: 1 }]);
    expect(joined.transforms[0].id).toBe('t1');
    expect(joined.output).toEqual({ stepIndex: 0 });
    expect(joined.writerOrder).toBe(4 + 0);
    expect(joined.edgeValueReferences).toBe('target');
    expect(custom.writerOrder).toBe(4 + 1);
    expect(custom.edges).toEqual([e1]);
    expect(custom.transforms[0].inputs).toEqual([{ edgeIndex: 0 }]);
  });

  it('ignores a step input that names no edge', () => {
    const input: MappingInput = {
      ...base,
      transforms: [
        {
          id: 't1',
          operation: 'array_build',
          inputEdgeIds: ['e3', 'missing'],
          parameters: {},
          outputTargetRef: dst('joined'),
        },
      ],
    };
    const rule = (graphFixture(input).graphRules ?? []).find((item) => item.id === 't1');
    expect(rule?.edges).toEqual([e3]);
    expect(rule?.transforms[0].inputs).toEqual([{ edgeIndex: 0 }, { edgeIndex: -1 }]);
  });
});

describe('withExplicitMappingGraphs', () => {
  it('passes null through', () => {
    expect(withExplicitMappingGraphs(null)).toBeNull();
    expect(withExplicitMappingGraphs(null, true)).toBeNull();
  });

  it('normalises loose edges and fills defaults', () => {
    const result = withExplicitMappingGraphs({
      edges: [
        {
          id: 'e1',
          sourceRef: { namespace: 'saml', path: 'mail' },
          targetRef: dst('x'),
          ruleId: 'r',
        },
        {
          sourceRef: { side: 'canonical', fieldKey: 'k', catalogEntryId: 'c', valueType: 'string' },
          targetRef: { side: 'review', nodeId: 'n' },
        },
        {
          sourceRef: { side: 'derived', path: 'p', namespace: 7, catalogEntryId: 3, valueType: 4 },
        },
        { sourceRef: { side: 'bogus', path: 5 } },
        'not an edge',
      ],
    });
    expect(result.edges).toHaveLength(5);
    expect(result.edges[0]).toEqual({
      id: 'e1',
      sourceRef: {
        side: 'source',
        namespace: 'saml',
        path: 'mail',
        catalogEntryId: undefined,
        valueType: undefined,
      },
      targetRef: { ...dst('x'), catalogEntryId: undefined, valueType: undefined },
      ruleId: 'r',
    });
    expect(result.edges[1].id).toBe('1');
    expect(result.edges[1].ruleId).toBeUndefined();
    expect(result.edges[1].sourceRef).toEqual({
      side: 'canonical',
      fieldKey: 'k',
      namespace: 'unknown',
      path: 'k',
      catalogEntryId: 'c',
      valueType: 'string',
    });
    expect(result.edges[1].targetRef).toMatchObject({ side: 'review', path: 'n' });
    expect(result.edges[2].sourceRef).toMatchObject({
      side: 'derived',
      namespace: 'unknown',
      path: 'p',
      catalogEntryId: undefined,
      valueType: undefined,
    });
    expect(result.edges[2].targetRef).toMatchObject({
      side: 'source',
      namespace: 'unknown',
      path: '',
    });
    expect(result.edges[3].sourceRef).toMatchObject({ side: 'source', path: '' });
    expect(result.edges[4]).toMatchObject({ id: '4' });
    expect(withExplicitMappingGraphs({}).edges).toEqual([]);
    expect(withExplicitMappingGraphs({ edges: 'x' }).transforms).toEqual([]);
    expect(withExplicitMappingGraphs({ edges: { a: 1 } }).edges).toEqual([]);
  });

  it('keeps every other field of the input', () => {
    const result = withExplicitMappingGraphs({ role: 'idp', extra: 5 } as { role: 'idp' });
    expect(result).toMatchObject({ role: 'idp', extra: 5 });
  });

  it('normalises transform steps and rejects unknown operations', () => {
    const result = withExplicitMappingGraphs({
      edges: [{ id: 'e1', sourceRef: src('a'), targetRef: dst('x') }],
      transforms: [
        {
          id: 's1',
          operation: 'strip_accents',
          inputEdgeIds: ['e1', 7],
          parameters: { a: 1 },
          outputTargetRef: dst('out'),
          ruleId: 'rule-s1',
        },
        { operation: 'hash', inputEdgeIds: 'e1', parameters: [1], outputTargetRef: null },
      ],
    });
    expect(result.transforms[0]).toEqual({
      id: 's1',
      operation: 'strip_accents',
      inputEdgeIds: ['e1', ''],
      parameters: { a: 1 },
      outputTargetRef: {
        side: 'destination',
        namespace: 'oidc',
        path: 'out',
        catalogEntryId: undefined,
        valueType: undefined,
      },
      ruleId: 'rule-s1',
    });
    expect(result.transforms[1]).toMatchObject({
      id: '1',
      operation: 'hash',
      inputEdgeIds: [],
      parameters: {},
      outputTargetRef: { side: 'source', namespace: 'unknown', path: '' },
    });
    expect('ruleId' in result.transforms[1]).toBe(false);
    expect(() =>
      withExplicitMappingGraphs({ transforms: [{ id: 'x', operation: 'nonsense' }] })
    ).toThrow('transform.unsupported_operation');
    expect(() => withExplicitMappingGraphs({ transforms: [null] })).toThrow(
      'transform.unsupported_operation'
    );
  });

  it('builds the same rules as graphFixture when none are given', () => {
    const e1 = { id: 'e1', sourceRef: src('a'), targetRef: dst('x') };
    const e2 = { id: 'e2', sourceRef: src('b'), targetRef: dst('y'), ruleId: 'named' };
    const e3 = { id: 'e3', sourceRef: src('c'), targetRef: dst('z') };
    const step = {
      id: 't1',
      operation: 'array_build' as const,
      inputEdgeIds: ['e3', 'e1'],
      parameters: {},
      outputTargetRef: dst('joined'),
    };
    const loose = withExplicitMappingGraphs({ edges: [e1, e2, e3], transforms: [step] });
    const strict = graphFixture({
      ...mappingInput([]),
      edges: loose.edges,
      transforms: loose.transforms,
    });
    expect(loose.graphRules).toEqual(strict.graphRules);
    expect(loose.graphRules.map((rule) => rule.id)).toEqual(['named', 't1']);
    expect(loose.graphRules[0].edges).toEqual([loose.edges[1]]);
    expect(loose.graphRules[1].edges).toEqual([loose.edges[2], loose.edges[0]]);
    expect(loose.graphRules[1].writerOrder).toBe(3);
  });

  it('orders writers after the pass-through rules, one slot per step', () => {
    const e1 = { id: 'e1', sourceRef: src('a'), targetRef: dst('x') };
    const e2 = { id: 'e2', sourceRef: src('b'), targetRef: dst('y') };
    const make = (id: string, edgeId: string) => ({
      id,
      operation: 'strip_accents' as const,
      inputEdgeIds: [edgeId],
      parameters: {},
      outputTargetRef: dst(id),
    });
    const result = withExplicitMappingGraphs({
      edges: [e1, e2],
      transforms: [make('t1', 'e1'), make('t2', 'e2')],
    });
    expect(result.graphRules.map((rule) => [rule.id, rule.writerOrder])).toEqual([
      ['t1', 2],
      ['t2', 3],
    ]);
  });

  it('keeps supplied graphs unless forced to rebuild them', () => {
    const e1 = { id: 'e1', sourceRef: src('a'), targetRef: dst('x') };
    const supplied: MappingRuleGraph[] = [
      {
        id: 'mine',
        targetRef: dst('x'),
        edges: [],
        transforms: [],
        output: { edgeIndex: 0 },
      },
    ];
    const kept = withExplicitMappingGraphs({ edges: [e1], graphRules: supplied });
    expect(kept.graphRules).toBe(supplied);
    expect(kept.edges).toHaveLength(1);
    const forced = withExplicitMappingGraphs({ edges: [e1], graphRules: supplied }, true);
    expect(forced.graphRules.map((rule) => rule.id)).toEqual(['e1']);
    const empty = withExplicitMappingGraphs({ graphRules: [] });
    expect(empty.graphRules).toEqual([]);
  });
});

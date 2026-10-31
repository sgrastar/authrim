import { describe, expect, it } from 'vitest';
import { sameFieldRef } from '@authrim/ar-lib-field-mapping/authoring';
import {
  isDestinationProfileReference,
  isOutputGraphTarget,
  sliceOutputGraph,
} from '../identity-mapping-output-graph';

const target = (namespace: string, profileId?: string, path = 'p') => ({
  namespace,
  path,
  profileId,
});
const edge = (
  id: string,
  targetRef: { namespace: string; path: string; profileId?: string },
  sourceRef = { namespace: 'authrim.profile', path: `source-of-${id}` }
) => ({
  id,
  sourceRef,
  targetRef,
});
const transform = (
  id: string,
  inputEdgeIds: string[],
  outputTargetRef: { namespace: string; path: string; profileId?: string }
) => ({ id, inputEdgeIds, outputTargetRef });

describe('isOutputGraphTarget', () => {
  it('is a destination profile reference, or the destination’s own namespace', () => {
    expect(isDestinationProfileReference('destination-profile-x')).toBe(true);
    expect(isDestinationProfileReference('destination_profile_x')).toBe(true);
    expect(isDestinationProfileReference('source-profile-x')).toBe(false);
    expect(isDestinationProfileReference(undefined)).toBe(false);

    expect(isOutputGraphTarget(target('x', 'destination-profile-p'))).toBe(true);
    expect(isOutputGraphTarget(target('saml.attribute'), 'saml.attribute')).toBe(true);
    expect(isOutputGraphTarget(target('authrim.profile'), 'saml.attribute')).toBe(false);
    expect(isOutputGraphTarget(target('saml.attribute'))).toBe(false);
  });
});

describe('sliceOutputGraph', () => {
  const input = edge('in', target('authrim.profile'));
  const out = edge('out', target('saml.attribute'));
  const other = edge('other', target('oidc.claim'));

  it('keeps the edges that release to the destination and drops the rules that bring a source in', () => {
    const cut = sliceOutputGraph({
      edges: [input, out, other],
      transforms: [],
      destinationNamespace: 'saml.attribute',
    });
    expect(cut.edges.map((item) => item.id)).toEqual(['out']);
  });

  it('keeps the transforms that make a released value, and the edges they take as input', () => {
    const feeding = edge('feeding', target('authrim.profile'));
    const cut = sliceOutputGraph({
      edges: [input, feeding, out, other],
      transforms: [
        transform('t-out', ['out'], target('saml.attribute')),
        transform('t-multi', ['feeding', 'out'], target('saml.attribute')),
        transform('t-in', ['in'], target('authrim.profile')),
        transform('t-other', ['other'], target('oidc.claim')),
      ],
      destinationNamespace: 'saml.attribute',
    });
    expect(cut.transforms.map((item) => item.id)).toEqual(['t-out', 't-multi']);
    expect(cut.edges.map((item) => item.id)).toEqual(['feeding', 'out']);
  });

  it('leaves the order of the edges as it was', () => {
    const second = edge('second', target('saml.attribute'));
    expect(
      sliceOutputGraph({
        edges: [second, input, out],
        transforms: [],
        destinationNamespace: 'saml.attribute',
      }).edges.map((item) => item.id)
    ).toEqual(['second', 'out']);
  });
});

describe('sliceOutputGraph: validation rules', () => {
  type Side = 'source' | 'destination';
  const field = (side: Side, namespace: string, path: string, catalogEntryId?: string) => ({
    side,
    namespace,
    path,
    catalogEntryId,
  });
  const rule = (id: string, targetRef: ReturnType<typeof field>) => ({ id, targetRef });
  const uiEdge = (
    id: string,
    sourceRef: ReturnType<typeof field>,
    targetRef: ReturnType<typeof field>
  ) => ({ id, sourceRef, targetRef });

  // The shape the Admin UI saves: the rule that brings a source profile's email in, and the one
  // that releases a canonical field out.
  const inputEdge = uiEdge(
    'in',
    field('source', 'oidc.claim', 'email'),
    field('destination', 'authrim.profile', 'preferred_username')
  );
  const outputEdge = uiEdge(
    'out',
    field('source', 'authrim.profile', 'preferred_username'),
    field('destination', 'saml.attribute', 'urn:mail')
  );

  const cutOf = (edges: Array<ReturnType<typeof uiEdge>>, rules: Array<ReturnType<typeof rule>>) =>
    sliceOutputGraph({
      edges,
      transforms: [],
      validationRules: rules,
      destinationNamespace: 'saml.attribute',
    }).validationRules.map((item) => item.id);
  const cut = (rules: Array<ReturnType<typeof rule>>) => cutOf([inputEdge, outputEdge], rules);

  it('drops a rule on a field only the source profile’s rules use', () => {
    expect(cut([rule('input-email', field('source', 'oidc.claim', 'email'))])).toEqual([]);
  });

  it('keeps a rule on a field the released edges use, as a source or as a target', () => {
    expect(
      cut([
        rule('on-source', field('source', 'authrim.profile', 'preferred_username')),
        rule('on-target', field('destination', 'saml.attribute', 'urn:mail')),
      ])
    ).toEqual(['on-source', 'on-target']);
  });

  it('keeps a rule on a field both directions use', () => {
    // preferred_username is the target of the input rule and the source of the released one.
    expect(cut([rule('shared', field('source', 'authrim.profile', 'preferred_username'))])).toEqual(
      ['shared']
    );
  });

  it('keeps a rule on a field no edge uses: what cannot be told is left to apply', () => {
    expect(cut([rule('unknown', field('source', 'somewhere.else', 'x'))])).toEqual(['unknown']);
  });

  it('matches by catalog entry id when both name one', () => {
    const byId = uiEdge(
      'in',
      field('source', 'oidc.claim', 'email', 'src-email'),
      field('destination', 'authrim.profile', 'preferred_username')
    );
    expect(
      cutOf(
        [byId, outputEdge],
        [rule('input-email', field('source', 'anything', 'else', 'src-email'))]
      )
    ).toEqual([]);
  });

  describe('the same namespace and path on the two sides of the set', () => {
    // A SAML attribute brought in (a source) and the same attribute released (a destination),
    // saved without a catalog entry id: the validator tells them apart by side.
    const samlIn = uiEdge(
      'in',
      field('source', 'saml.attribute', 'urn:mail'),
      field('destination', 'authrim.profile', 'email')
    );
    const samlOut = uiEdge(
      'out',
      field('source', 'authrim.profile', 'email'),
      field('destination', 'saml.attribute', 'urn:mail')
    );

    it('drops a rule on the source side when only the dropped edge has that field as a source', () => {
      expect(
        cutOf([samlIn, samlOut], [rule('input', field('source', 'saml.attribute', 'urn:mail'))])
      ).toEqual([]);
    });

    it('keeps a rule on the destination side, which the released edge uses', () => {
      expect(
        cutOf(
          [samlIn, samlOut],
          [rule('output', field('destination', 'saml.attribute', 'urn:mail'))]
        )
      ).toEqual(['output']);
    });

    it('decides as the validator does, for every pair of sides and ids', () => {
      const refs = [
        field('source', 'saml.attribute', 'urn:mail'),
        field('destination', 'saml.attribute', 'urn:mail'),
        field('source', 'saml.attribute', 'urn:mail', 'id-a'),
        field('destination', 'saml.attribute', 'urn:mail', 'id-a'),
        field('source', 'saml.attribute', 'urn:mail', 'id-b'),
        field('source', 'authrim.profile', 'email'),
      ];
      const unrelated = (id: string) =>
        uiEdge(
          id,
          field('source', 'x', `${id}-source`),
          field('destination', 'authrim.profile', `${id}-target`)
        );
      for (const left of refs) {
        for (const right of refs) {
          // The only edge that uses `right` is dropped: a rule on `left` applies to it exactly
          // when the validator would take `left` for `right`, and then it is dropped too.
          const droppedUse = uiEdge(
            'dropped',
            right,
            field('destination', 'authrim.profile', 'sink')
          );
          const rules = [rule('r', left)];
          expect(
            cutOf(
              [droppedUse, unrelated('kept-a')].map((e, i) =>
                i === 1
                  ? { ...e, targetRef: field('destination', 'saml.attribute', 'urn:other') }
                  : e
              ),
              rules
            ).length === 1
          ).toBe(!sameFieldRef(left, right));
          // The same edge released instead: the rule applies, whatever the sides.
          const keptUse = uiEdge(
            'kept',
            right,
            field('destination', 'saml.attribute', 'urn:released')
          );
          expect(cutOf([keptUse], rules)).toEqual(['r']);
        }
      }
    });
  });

  it('keeps no rules when none are given', () => {
    expect(
      sliceOutputGraph({
        edges: [outputEdge],
        transforms: [],
        destinationNamespace: 'saml.attribute',
      }).validationRules
    ).toEqual([]);
  });
});

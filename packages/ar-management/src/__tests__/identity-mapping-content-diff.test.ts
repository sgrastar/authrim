import { describe, expect, it } from 'vitest';
import {
  claimShapes,
  diffClaimShapes,
  diffValidationRules,
  NO_CATALOG,
  releasePoints,
  type CatalogTypes,
} from '../identity-mapping-content-diff';
import type { MappingSetContent } from '../identity-mapping-set-facade-content';

/** The claims a content fills, and how one content's claims change into another's. */

type Step = { edgeIndex?: number; operation: string; parameters?: Record<string, unknown> };
type Rule = {
  priority?: number;
  ruleKey: string;
  ruleKind: string;
  action: string;
  edges: Array<{ sourceRef: Record<string, unknown>; targetRef: Record<string, unknown> }>;
  transforms?: Step[];
  validationRules?: MappingSetContent['rules'][number]['validationRules'];
};

function rule(
  claim: string,
  sources: string[],
  options: {
    profile?: string;
    profileField?: 'profileId' | 'profile_id';
    namespace?: string;
    catalogEntryId?: string;
    transforms?: Step[];
  } = {}
): Rule {
  return {
    ruleKey: claim,
    ruleKind: 'direct',
    action: 'allow',
    edges: sources.map((path) => ({
      sourceRef: {
        side: 'source',
        namespace: options.namespace ?? 'authrim.profile',
        path,
        ...(options.catalogEntryId ? { catalogEntryId: options.catalogEntryId } : {}),
      },
      targetRef: {
        side: 'destination',
        namespace: 'oidc.claim',
        path: claim,
        [options.profileField ?? 'profileId']: options.profile ?? 'profile-1',
      },
    })),
    ...(options.transforms ? { transforms: options.transforms } : {}),
  };
}

const content = (...rules: Rule[]) => ({ rules }) as never;
/** The changes, without the release namespace each claim here is written in (said once). */
const diff = (
  before: Rule[],
  after: Rule[],
  catalogs: { before?: CatalogTypes; after?: CatalogTypes } = {}
) =>
  diffClaimShapes(
    claimShapes(content(...before), catalogs.before ?? NO_CATALOG),
    claimShapes(content(...after), catalogs.after ?? NO_CATALOG)
  ).map(({ namespace, ...change }) =>
    namespace === 'oidc.claim' ? change : { ...change, namespace }
  );

/** A catalog version with one entry, as the runtime reads it. */
function catalog(entry: {
  rowId: string;
  stableId: string;
  namespace: string;
  path: string;
  cardinality: 'single' | 'multi';
  aliases?: Array<{ namespace: string; path: string }>;
}): CatalogTypes {
  return {
    bundle: {
      entries: [
        {
          id: entry.stableId,
          namespace: entry.namespace,
          path: entry.path,
          aliases: entry.aliases ?? [],
          valueType: 'string',
          cardinality: entry.cardinality,
        },
      ],
    } as never,
    stableIds: new Map([[entry.rowId, entry.stableId]]),
  };
}

describe('the changes of a content', () => {
  it('are none when nothing a claim depends on changes', () => {
    expect(diff([rule('email', ['email'])], [rule('email', ['email'])])).toEqual([]);
  });

  it('add and remove claims, in claim order', () => {
    expect(diff([rule('email', ['email'])], [rule('nickname', ['nickname'])])).toEqual([
      { kind: 'removed', claim: 'email', profile_id: 'profile-1' },
      { kind: 'added', claim: 'nickname', profile_id: 'profile-1' },
    ]);
  });

  it('rename a claim filled from the same attributes through the same profile, once', () => {
    expect(diff([rule('organization', ['org'])], [rule('org', ['org'])])).toEqual([
      { kind: 'renamed', claim: 'org', previous_claim: 'organization', profile_id: 'profile-1' },
    ]);
    expect(
      diff([rule('organization', ['org'])], [rule('org', ['org'], { profile: 'profile-2' })]).map(
        (change) => change.kind
      )
    ).toEqual(['added', 'removed']);
    const changes = diff([rule('a', ['x'])], [rule('b', ['x']), rule('c', ['x'])]);
    expect(changes.map((change) => `${change.kind}:${change.claim}`)).toEqual([
      'renamed:b',
      'added:c',
    ]);
  });

  it('tell a claim read from other attributes, the namespace included', () => {
    expect(diff([rule('name', ['name'])], [rule('name', ['display_name'])])).toEqual([
      { kind: 'source_changed', claim: 'name', profile_id: 'profile-1' },
    ]);
    expect(
      diff(
        [rule('role', ['role'], { namespace: 'authrim.custom_claims' })],
        [rule('role', ['role'], { namespace: 'authrim.attributes' })]
      )
    ).toEqual([{ kind: 'source_changed', claim: 'role', profile_id: 'profile-1' }]);
    // Another namespace is another attribute: no rename across it.
    expect(
      diff(
        [rule('a', ['role'], { namespace: 'authrim.custom_claims' })],
        [rule('b', ['role'], { namespace: 'authrim.attributes' })]
      ).map((change) => change.kind)
    ).toEqual(['removed', 'added']);
  });

  it('tell the same attributes written in another order, by priority or by edge', () => {
    const changed = [{ kind: 'source_changed', claim: 'nickname', profile_id: 'profile-1' }];
    expect(
      diff([rule('nickname', ['name', 'nickname'])], [rule('nickname', ['nickname', 'name'])])
    ).toEqual(changed);
    const first = { ...rule('nickname', ['name']), priority: 1 };
    const second = { ...rule('nickname', ['nickname']), priority: 2 };
    expect(diff([first, second], [{ ...first, priority: 3 }, second])).toEqual(changed);
    // The same order written another way is no change.
    expect(diff([first, second], [second, first])).toEqual([]);
  });

  it('tell a claim released through another profile', () => {
    expect(
      diff([rule('email', ['email'])], [rule('email', ['email'], { profile: 'profile-2' })])
    ).toEqual([
      {
        kind: 'profile_changed',
        claim: 'email',
        profile_id: 'profile-2',
        previous_profile_id: 'profile-1',
      },
    ]);
  });

  it('read the profile as the runtime does: either spelling, without the prefix', () => {
    expect(
      diff(
        [rule('email', ['email'], { profile: 'destination-profile-profile-1' })],
        [rule('email', ['email'], { profileField: 'profile_id' })]
      )
    ).toEqual([]);
    expect(diff([], [rule('email', ['email'], { profileField: 'profile_id' })])).toEqual([
      { kind: 'added', claim: 'email', profile_id: 'profile-1' },
    ]);
  });

  it('tell a claim whose steps change, their order and the rule’s own steps included', () => {
    const lower = { operation: 'case', parameters: { mode: 'lower' } };
    const upper = { operation: 'case', parameters: { mode: 'upper' } };
    const changed = [{ kind: 'transform_changed', claim: 'email', profile_id: 'profile-1' }];
    expect(
      diff(
        [rule('email', ['email'], { transforms: [{ edgeIndex: 0, ...lower }] })],
        [rule('email', ['email'], { transforms: [{ edgeIndex: 0, ...upper }] })]
      )
    ).toEqual(changed);
    expect(
      diff(
        [
          rule('email', ['email'], {
            transforms: [
              { edgeIndex: 0, ...lower },
              { edgeIndex: 0, ...upper },
            ],
          }),
        ],
        [
          rule('email', ['email'], {
            transforms: [
              { edgeIndex: 0, ...upper },
              { edgeIndex: 0, ...lower },
            ],
          }),
        ]
      )
    ).toEqual(changed);
    expect(
      diff(
        [rule('email', ['email'])],
        [rule('email', ['email'], { transforms: [{ edgeIndex: 0, ...lower }] })]
      )
    ).toEqual(changed);
    // A step on no edge (none named, or one the rule does not have) is released nowhere.
    for (const step of [lower, { edgeIndex: 5, ...lower }]) {
      expect(
        diff([rule('email', ['email'])], [rule('email', ['email'], { transforms: [step] })])
      ).toEqual([]);
    }
    // The same steps with their parameters written in another order are the same.
    expect(
      diff(
        [
          rule('a', ['a'], {
            transforms: [{ edgeIndex: 0, operation: 'x', parameters: { p: 1, q: 2 } }],
          }),
        ],
        [
          rule('a', ['a'], {
            transforms: [{ edgeIndex: 0, operation: 'x', parameters: { q: 2, p: 1 } }],
          }),
        ]
      )
    ).toEqual([]);
  });

  it('tell what is read taking another type, the entry found as the runtime finds it', () => {
    const entry = {
      rowId: 'row-groups',
      stableId: 'field.canonical.groups',
      namespace: 'authrim.canonical',
      path: 'groups',
    };
    const change = {
      kind: 'type_changed',
      claim: 'groups',
      type_before: 'string',
      type_after: 'string[]',
      profile_id: 'profile-1',
    };
    // By the entry's row ID.
    const byId = rule('groups', ['groups'], { catalogEntryId: 'row-groups' });
    expect(
      diff([byId], [byId], {
        before: catalog({ ...entry, cardinality: 'single' }),
        after: catalog({ ...entry, cardinality: 'multi' }),
      })
    ).toEqual([change]);
    // By an alias of the entry.
    const byAlias = rule('groups', ['groups']);
    const aliases = [{ namespace: 'authrim.profile', path: 'groups' }];
    expect(
      diff([byAlias], [byAlias], {
        before: catalog({ ...entry, cardinality: 'single', aliases }),
        after: catalog({ ...entry, cardinality: 'multi', aliases }),
      })
    ).toEqual([change]);
    // A type the catalog does not give is not a change.
    expect(
      diff([byAlias], [byAlias], { after: catalog({ ...entry, cardinality: 'multi', aliases }) })
    ).toEqual([]);
  });

  it.each([
    { before: ['string', 'number'], after: ['string', 'string'], label: 'mixed to one type' },
    { before: ['string', 'string'], after: ['string', 'number'], label: 'one type to mixed' },
    { before: ['string', 'number'], after: ['string', 'boolean'], label: 'mixed types changed' },
    { before: ['string', 'number'], after: ['number', 'string'], label: 'source types swapped' },
  ])('keeps each source type: $label', ({ before, after }) => {
    const types = (values: string[]): CatalogTypes => ({
      bundle: {
        entries: ['a', 'b'].map((path, index) => ({
          id: path,
          namespace: 'authrim.profile',
          path,
          valueType: values[index],
          cardinality: 'single',
        })),
      } as never,
      stableIds: new Map(),
    });
    const mapping = rule('nickname', ['a', 'b']);
    const summary = (values: string[]) => [...new Set(values)].sort().join(' | ');

    expect(diff([mapping], [mapping], { before: types(before), after: types(after) })).toEqual([
      {
        kind: 'type_changed',
        claim: 'nickname',
        profile_id: 'profile-1',
        type_before: summary(before),
        type_after: summary(after),
        source_types_before: before.map((type, index) => ({
          source: `authrim.profile:${index === 0 ? 'a' : 'b'}`,
          type,
        })),
        source_types_after: after.map((type, index) => ({
          source: `authrim.profile:${index === 0 ? 'a' : 'b'}`,
          type,
        })),
      },
    ]);
    expect(diff([mapping], [mapping], { before: types(before), after: types(before) })).toEqual([]);
  });

  it('tell a step that moves to another input, or runs in another order across inputs', () => {
    const two = (transforms: Step[]) => rule('name', ['given', 'family'], { transforms });
    const lower = { operation: 'case', parameters: { mode: 'lower' } };
    const trim = { operation: 'trim' };
    const changed = [{ kind: 'transform_changed', claim: 'name', profile_id: 'profile-1' }];
    expect(diff([two([{ edgeIndex: 0, ...lower }])], [two([{ edgeIndex: 1, ...lower }])])).toEqual(
      changed
    );
    expect(
      diff(
        [
          two([
            { edgeIndex: 0, ...lower },
            { edgeIndex: 1, ...trim },
          ]),
        ],
        [
          two([
            { edgeIndex: 1, ...trim },
            { edgeIndex: 0, ...lower },
          ]),
        ]
      )
    ).toEqual(changed);
  });

  it('order the edges of several rules as the runtime loads them, interleaved by priority', () => {
    const a = rule('name', ['given', 'family']);
    const b = rule('name', ['display_name']);
    // Same priority: given, display_name, family (family last). B later: display_name last.
    expect(diff([a, b], [a, { ...b, priority: 1 }])).toEqual([
      { kind: 'source_changed', claim: 'name', profile_id: 'profile-1' },
    ]);
  });

  it('order the steps of several rules as the runtime loads them, interleaved by priority', () => {
    const upper = { operation: 'case', parameters: { mode: 'upper' } };
    const lower = { operation: 'case', parameters: { mode: 'lower' } };
    const trim = { operation: 'trim' };
    const a = rule('name', ['name'], {
      transforms: [
        { edgeIndex: 0, ...upper },
        { edgeIndex: 0, ...lower },
      ],
    });
    const b = rule('name', ['name'], { transforms: [{ edgeIndex: 0, ...trim }] });
    // Same priority: upper, trim, lower. B later: upper, lower, trim.
    expect(diff([a, b], [a, { ...b, priority: 1 }])).toEqual([
      { kind: 'transform_changed', claim: 'name', profile_id: 'profile-1' },
    ]);
  });

  it('read a source that names only its catalog entry as the place the entry describes', () => {
    const canonical: CatalogTypes = {
      bundle: {
        entries: ['email', 'name'].map((path) => ({
          id: `field.canonical.${path}`,
          namespace: 'authrim.canonical',
          path,
          aliases: [],
          valueType: 'string',
          cardinality: 'single',
        })),
      } as never,
      stableIds: new Map(),
    };
    const byEntry = (id: string) => ({
      ruleKey: 'r',
      ruleKind: 'direct',
      action: 'allow',
      edges: [
        {
          sourceRef: { side: 'source', catalogEntryId: id },
          targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'who', profileId: 'p' },
        },
      ],
    });
    expect(
      diff([byEntry('field.canonical.email')], [byEntry('field.canonical.name')], {
        before: canonical,
        after: canonical,
      })
    ).toEqual([{ kind: 'source_changed', claim: 'who', profile_id: 'p' }]);
    expect(
      [...claimShapes(content(byEntry('field.canonical.email')), canonical).values()][0]?.sourceKeys
    ).toEqual(['authrim.canonical:email']);
  });

  it('release a claim whose edge names no profile through the set’s one profile', () => {
    const unnamed = rule('nickname', ['nickname']);
    delete unnamed.edges[0].targetRef.profileId;
    expect(diff([rule('email', ['email'])], [rule('email', ['email']), unnamed])).toEqual([
      { kind: 'added', claim: 'nickname', profile_id: 'profile-1' },
    ]);
  });

  it('say the profile before on every change of a claim whose profile changes', () => {
    expect(
      diff([rule('email', ['email'])], [rule('email', ['mail'], { profile: 'profile-2' })])
    ).toEqual([
      {
        kind: 'profile_changed',
        claim: 'email',
        profile_id: 'profile-2',
        previous_profile_id: 'profile-1',
      },
      {
        kind: 'source_changed',
        claim: 'email',
        profile_id: 'profile-2',
        previous_profile_id: 'profile-1',
      },
    ]);
  });

  it('tell other attributes and other steps of one claim apart, both at once', () => {
    const lower = { edgeIndex: 0, operation: 'case', parameters: { mode: 'lower' } };
    const upper = { edgeIndex: 0, operation: 'case', parameters: { mode: 'upper' } };
    expect(
      diff(
        [rule('name', ['name'], { transforms: [lower] })],
        [rule('name', ['display_name'], { transforms: [upper] })]
      ).map((change) => change.kind)
    ).toEqual(['source_changed', 'transform_changed']);
    // Another attribute under the same step is not a change of the step.
    expect(
      diff(
        [rule('name', ['name'], { transforms: [lower] })],
        [rule('name', ['display_name'], { transforms: [lower] })]
      ).map((change) => change.kind)
    ).toEqual(['source_changed']);
  });

  it('tell a claim written in another namespace, which the runtime does not release', () => {
    const moved = rule('email', ['email']);
    moved.edges[0].targetRef.namespace = 'custom.claim';
    expect(diff([rule('email', ['email'])], [moved])).toEqual([
      {
        kind: 'renamed',
        claim: 'email',
        previous_claim: 'email',
        previous_namespace: 'oidc.claim',
        namespace: 'custom.claim',
        profile_id: 'profile-1',
      },
    ]);
  });

  it('take every attribute a claim reads, across rules', () => {
    const shapes = claimShapes(
      content(rule('name', ['given']), rule('name', ['family'])),
      NO_CATALOG
    );
    expect([...shapes.values()].find((shape) => shape.claim === 'name')).toMatchObject({
      sourceKeys: ['authrim.profile:family', 'authrim.profile:given'],
    });
  });
});

describe('validation changes', () => {
  const required = {
    targetRef: { side: 'source', namespace: 'authrim.profile', path: 'nickname' },
    validationKind: 'required',
    severity: 'critical',
  };
  const withRules = (...validationRules: NonNullable<Rule['validationRules']>) => ({
    rules: [{ ...rule('email', ['email']), validationRules }],
  });
  const diffValidation = (
    before: NonNullable<Rule['validationRules']>,
    after: NonNullable<Rule['validationRules']>
  ) => diffValidationRules(withRules(...before), withRules(...after), 'p', 'p');
  const expected = (change: 'added' | 'removed' | 'changed', effect = 'may_reject') => ({
    kind: 'validation_changed',
    claim: 'nickname',
    namespace: 'authrim.profile',
    profile_id: 'p',
    validation_change: change,
    validation_effect: effect,
  });

  it('reports critical validation added, removed, or changed without any edge changing', () => {
    expect(diffValidation([], [required])).toEqual([expected('added')]);
    expect(diffValidation([required], [])).toEqual([expected('removed')]);
    expect(diffValidation([required], [{ ...required, severity: 'error' }])).toEqual([
      expected('changed'),
    ]);
    const enumeration = {
      ...required,
      validationKind: 'enum',
      parameters: { allowedValues: ['one'] },
    };
    expect(
      diffValidation([enumeration], [{ ...enumeration, parameters: { allowedValues: ['two'] } }])
    ).toEqual([expected('changed')]);
  });

  it('distinguishes noncritical changes, including when an unchanged critical rule shares the target', () => {
    const warning = { ...required, validationKind: 'format', severity: 'warning' };
    expect(diffValidation([], [warning])).toEqual([expected('added', 'validation_only')]);
    expect(diffValidation([required], [required, warning])).toEqual([
      expected('changed', 'validation_only'),
    ]);
    // An omitted severity is persisted as error, not the runtime required rule's fallback.
    const { severity: _severity, ...implicitError } = required;
    expect(diffValidation([implicitError], [{ ...required, severity: 'error' }])).toEqual([]);
  });

  it('ignores ordering, repeated identical rules, and parameter object key order', () => {
    const first = { ...required, parameters: { a: 1, b: 2 } };
    const second = { ...required, validationKind: 'enum', parameters: { allowedValues: ['one'] } };
    expect(
      diffValidation([first, second], [second, { ...first, parameters: { b: 2, a: 1 } }, second])
    ).toEqual([]);
  });
});

describe('where a change is released', () => {
  const at = (claim: string, profileId: string, namespace = 'oidc.claim') => ({
    claim,
    namespace,
    profileId,
  });
  it('is before and after, by claim, namespace and profile', () => {
    const base = { namespace: 'oidc.claim' };
    expect(releasePoints({ kind: 'added', claim: 'a', profile_id: 'p', ...base })).toEqual({
      before: null,
      after: at('a', 'p'),
    });
    expect(releasePoints({ kind: 'removed', claim: 'a', profile_id: 'p', ...base })).toEqual({
      before: at('a', 'p'),
      after: null,
    });
    expect(
      releasePoints({
        kind: 'renamed',
        claim: 'b',
        previous_claim: 'a',
        previous_namespace: 'x',
        profile_id: 'p',
        ...base,
      })
    ).toEqual({ before: at('a', 'p', 'x'), after: at('b', 'p') });
    expect(
      releasePoints({
        kind: 'profile_changed',
        claim: 'a',
        profile_id: 'q',
        previous_profile_id: 'p',
        ...base,
      })
    ).toEqual({ before: at('a', 'p'), after: at('a', 'q') });
    expect(
      releasePoints({
        kind: 'profile_field_removed',
        claim: 'a',
        profile_id: 'q',
        previous_profile_id: 'p',
        ...base,
      })
    ).toEqual({ before: at('a', 'p'), after: null });
  });
});

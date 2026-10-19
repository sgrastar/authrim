import { describe, expect, it } from 'vitest';
import {
  findPlatformMappingCompileViolation,
  findPlatformMappingVersionViolation,
  normalizePlatformActivationScope,
  platformDestinationProfileRefs,
  type PlatformCatalogEntry,
} from '../identity-mapping-platform-checks';

const source = (overrides: Record<string, unknown> = {}) => ({
  side: 'source',
  namespace: 'authrim.profile',
  path: 'email',
  ...overrides,
});
const destination = (overrides: Record<string, unknown> = {}) => ({
  side: 'destination',
  namespace: 'oidc.claim',
  path: 'email',
  profileId: 'destination_profile_1',
  ...overrides,
});
const rule = (edge: { sourceRef: object; targetRef: object }, extra: object = {}) => ({
  edges: [edge as never],
  ...extra,
});

describe('findPlatformMappingVersionViolation', () => {
  it('lets a mapping of standard fields through', () => {
    expect(
      findPlatformMappingVersionViolation([rule({ sourceRef: source(), targetRef: destination() })])
    ).toBeNull();
  });

  it('does not take a destination claim named like a subject part for a tenant-defined field', () => {
    // The destination’s path is a name of its own: only its namespace says what it is.
    expect(
      findPlatformMappingVersionViolation([
        rule({
          sourceRef: source(),
          targetRef: destination({ path: 'attributes' }),
        }),
        rule({
          sourceRef: source(),
          targetRef: destination({ path: 'custom_claims.x' }),
        }),
      ])
    ).toBeNull();
  });

  it.each([
    [
      'a source in the custom claims namespace',
      { sourceRef: source({ namespace: 'custom_claims' }) },
    ],
    ['a source read through the path', { sourceRef: source({ path: 'custom_fields.x' }) }],
    [
      'a source named by its field key',
      { sourceRef: { side: 'source', fieldKey: 'attributes.x' } },
    ],
    ['a source with no side', { sourceRef: { namespace: 'authrim.attributes', path: 'x' } }],
    [
      'a destination in the attributes namespace',
      { targetRef: destination({ namespace: 'authrim.attributes' }) },
    ],
  ])('refuses %s', (_name, edge) => {
    expect(
      findPlatformMappingVersionViolation([
        rule({ sourceRef: source(), targetRef: destination(), ...edge }),
      ])
    ).toMatch(/tenant-defined field/);
  });

  it('refuses a validation rule, release rule and conflict rule on a tenant-defined field', () => {
    const plain = { sourceRef: source(), targetRef: destination() };
    const bad = { namespace: 'authrim.custom_fields', path: 'x' };

    for (const extra of [
      { validationRules: [{ targetRef: { side: 'destination', ...bad } }] },
      {
        validationRules: [
          { targetRef: { side: 'source', namespace: 'authrim.profile', path: 'custom_claims.x' } },
        ],
      },
      { releaseRules: [{ sourceRef: { side: 'source', ...bad } }] },
      { conflictRules: [{ targetRef: { side: 'destination', ...bad } }] },
    ]) {
      expect(findPlatformMappingVersionViolation([rule(plain, extra)])).toMatch(/tenant-defined/);
    }
  });

  it('refuses persistent identifiers however they are asked for', () => {
    const plain = { sourceRef: source(), targetRef: destination() };
    for (const transform of [
      { operation: 'oidc_pairwise_sub' },
      { operation: 'saml_edu_person_targeted_id' },
      { operation: 'copy', parameters: { persistentIdentifierProfileId: 'pip-1' } },
    ]) {
      expect(
        findPlatformMappingVersionViolation([rule(plain, { transforms: [transform] })])
      ).toMatch(/persistent identifier/);
    }
    expect(
      findPlatformMappingVersionViolation([
        rule(plain, {
          transforms: [{ operation: 'trim', parameters: { persistentIdentifierProfileId: ' ' } }],
        }),
      ])
    ).toBeNull();
  });

  it('refuses a source profile', () => {
    expect(findPlatformMappingVersionViolation([], ['source_profile_1'])).toMatch(/source profile/);
    expect(findPlatformMappingVersionViolation([], [])).toBeNull();
  });
});

describe('findPlatformMappingCompileViolation', () => {
  const entry = (overrides: Partial<PlatformCatalogEntry> = {}): PlatformCatalogEntry => ({
    ids: ['platform_canonical_email', 'field.canonical.email'],
    namespace: 'authrim.canonical',
    path: 'email',
    classification: 'pii',
    targetType: 'canonical',
    targetTaxonomy: 'canonical',
    ...overrides,
  });
  const mapping = (overrides: Record<string, unknown> = {}) => ({
    edges: [{ sourceRef: source(), targetRef: destination() }],
    validationRules: [],
    transforms: [],
    ...overrides,
  });

  it('passes a source the catalog has', () => {
    expect(findPlatformMappingCompileViolation(mapping(), [entry()])).toBeNull();
  });

  it('refuses a source the catalog does not have', () => {
    expect(
      findPlatformMappingCompileViolation(
        mapping({ edges: [{ sourceRef: source({ path: 'nickname' }), targetRef: destination() }] }),
        [entry()]
      )
    ).toMatch(/not a field of the platform catalog/);
  });

  it('refuses a source that names an entry of another place', () => {
    expect(
      findPlatformMappingCompileViolation(
        mapping({
          edges: [
            {
              sourceRef: source({ path: 'email', catalogEntryId: 'platform_canonical_given_name' }),
              targetRef: destination(),
            },
          ],
        }),
        [entry(), entry({ ids: ['platform_canonical_given_name'], path: 'given_name' })]
      )
    ).toMatch(/not a field of the platform catalog/);
  });

  it('refuses a source a destination-only entry stands for', () => {
    expect(
      findPlatformMappingCompileViolation(mapping(), [
        entry({ targetType: 'destination-only', targetTaxonomy: 'destination-only' }),
      ])
    ).toMatch(/not a field of the platform catalog/);
  });

  it('refuses a custom entry named by id or read by place, but not a destination of the same name', () => {
    const custom = entry({
      ids: ['custom_1'],
      path: 'loyalty',
      targetType: 'custom',
      targetTaxonomy: 'custom',
    });
    const byPlace = mapping({
      edges: [{ sourceRef: source({ path: 'loyalty' }), targetRef: destination() }],
    });
    // The entry is a source of the place (custom is not destination-only), so it resolves, then
    // is refused for being custom.
    expect(findPlatformMappingCompileViolation(byPlace, [entry(), custom])).toMatch(
      /custom catalog field/
    );
    expect(
      findPlatformMappingCompileViolation(
        mapping({
          edges: [
            {
              sourceRef: source(),
              targetRef: destination({ catalogEntryId: 'custom_1' }),
            },
          ],
        }),
        [entry(), custom]
      )
    ).toMatch(/custom catalog field/);
    expect(
      findPlatformMappingCompileViolation(
        mapping({
          edges: [{ sourceRef: source(), targetRef: destination({ path: 'loyalty' }) }],
        }),
        [entry(), custom]
      )
    ).toBeNull();
  });

  it('asks a validation rule on a source for a catalog field, and a destination one only to not be custom', () => {
    expect(
      findPlatformMappingCompileViolation(
        mapping({
          validationRules: [{ targetRef: source({ path: 'nickname' }) }],
        }),
        [entry()]
      )
    ).toMatch(/validation target is not a field/);
    expect(
      findPlatformMappingCompileViolation(
        mapping({ validationRules: [{ targetRef: destination() }] }),
        [entry()]
      )
    ).toBeNull();
  });

  it('refuses again what the save-time check refuses', () => {
    expect(
      findPlatformMappingCompileViolation(
        mapping({ transforms: [{ operation: 'oidc_pairwise_sub', parameters: {} }] }),
        [entry()]
      )
    ).toMatch(/persistent identifier/);
    expect(
      findPlatformMappingCompileViolation(
        mapping({
          edges: [{ sourceRef: source({ namespace: 'custom_claims' }), targetRef: destination() }],
        }),
        [entry()]
      )
    ).toMatch(/tenant-defined/);
  });
});

describe('normalizePlatformActivationScope', () => {
  it.each([
    undefined,
    null,
    {},
    { kind: 'tenant' },
    { kind: 'tenant', id: 'platform' },
    { id: 'platform' },
  ])('writes %j as the empty scope', (scope) => {
    expect(normalizePlatformActivationScope(scope, 'platform')).toEqual({ scope: {} });
  });

  it.each([
    { kind: 'tenant', id: 'tenant-a' },
    { kind: 'client' },
    { clientId: 'app-1' },
    { protocol: 'oidc' },
    { destinationProfileId: 'destination_profile_1' },
    [],
    'tenant',
  ])('refuses %j', (scope) => {
    expect(normalizePlatformActivationScope(scope, 'platform')).toHaveProperty('violation');
  });
});

describe('platformDestinationProfileRefs', () => {
  it('finds the one profile, by either spelling', () => {
    expect(platformDestinationProfileRefs([{ profileId: 'p1' }, { profile_id: 'p1' }])).toEqual({
      profileIds: ['p1'],
    });
    expect(platformDestinationProfileRefs([{ profile_id: 'destination-profile-p1' }])).toEqual({
      profileIds: ['p1'],
    });
  });

  it.each([
    ['none', [{ path: 'email' }]],
    ['two', [{ profileId: 'p1' }, { profile_id: 'p2' }]],
    [
      'one that is not the shape of an ID, beside one that is',
      [{ profileId: 'destination_profile_1' }, { profileId: 'x' }],
    ],
  ])('refuses %s', (_name, refs) => {
    expect(platformDestinationProfileRefs(refs)).toHaveProperty('violation');
  });

  it('refuses a reference whose two spellings differ', () => {
    expect(platformDestinationProfileRefs([{ profileId: 'p1', profile_id: 'p2' }])).toEqual({
      violation: expect.stringContaining('two different'),
    });
  });
});

describe('references spelled by fieldKey or nodeId', () => {
  const entry: PlatformCatalogEntry = {
    ids: ['platform_canonical_email', 'field.canonical.email'],
    namespace: 'authrim.canonical',
    path: 'email',
    classification: 'pii',
    targetType: 'canonical',
    targetTaxonomy: 'canonical',
  };
  const compile = (sourceRef: Record<string, unknown>) =>
    findPlatformMappingCompileViolation(
      {
        edges: [{ sourceRef, targetRef: destination() }],
        validationRules: [],
        transforms: [],
      },
      [entry]
    );

  it.each([
    [{ side: 'source', namespace: 'authrim.canonical', fieldKey: 'email' }],
    [{ side: 'source', namespace: 'authrim.canonical', nodeId: 'email' }],
    [
      {
        side: 'source',
        namespace: 'authrim.profile',
        fieldKey: 'email',
        catalog_entry_id: 'field.canonical.email',
      },
    ],
  ])('judges %j as the field the runtime reads', (sourceRef) => {
    expect(compile(sourceRef)).toBeNull();
  });

  it('refuses one that reads a field the catalog lacks, or names the entry of another place', () => {
    expect(compile({ side: 'source', namespace: 'authrim.canonical', fieldKey: 'nope' })).toMatch(
      /not a field/
    );
    expect(
      compile({
        side: 'source',
        namespace: 'authrim.canonical',
        fieldKey: 'email',
        catalog_entry_id: 'other',
      })
    ).toMatch(/not a field/);
  });

  it('refuses a tenant-defined field spelled by fieldKey or nodeId', () => {
    for (const spelling of [{ fieldKey: 'custom_claims.x' }, { nodeId: 'attributes.x' }]) {
      expect(
        findPlatformMappingVersionViolation([
          rule({
            sourceRef: { side: 'source', namespace: 'authrim.profile', ...spelling },
            targetRef: destination(),
          }),
        ])
      ).toMatch(/tenant-defined/);
    }
  });
});

describe('a reference with no side, as the runtime reads it (a source)', () => {
  const plain = { sourceRef: source(), targetRef: destination() };
  const withValidation = (targetRef: Record<string, unknown>) => [
    rule(plain, { validationRules: [{ targetRef }] }),
  ];

  it.each([
    ['no side', { namespace: 'authrim.profile', path: 'custom_claims.x' }],
    ['no side, by namespace', { namespace: 'authrim.custom_fields', path: 'x' }],
    ['no side, by fieldKey', { namespace: 'authrim.profile', fieldKey: 'attributes.x' }],
    ['side source', { side: 'source', namespace: 'authrim.profile', path: 'custom_claims.x' }],
  ])('refuses a validation rule on a tenant-defined field (%s)', (_name, targetRef) => {
    expect(findPlatformMappingVersionViolation(withValidation(targetRef))).toMatch(
      /tenant-defined/
    );
  });

  it('lets a validation rule on a destination claim that is named like one through', () => {
    expect(
      findPlatformMappingVersionViolation(
        withValidation({
          side: 'destination',
          namespace: 'oidc.claim',
          path: 'custom_claims.x',
        })
      )
    ).toBeNull();
    expect(
      findPlatformMappingVersionViolation(
        withValidation({ namespace: 'oidc.claim', path: 'email' })
      )
    ).toBeNull();
  });

  it('judges an edge target with no side as a source too', () => {
    expect(
      findPlatformMappingVersionViolation([
        rule({
          sourceRef: source(),
          targetRef: { namespace: 'authrim.profile', path: 'custom_claims.x' },
        }),
      ])
    ).toMatch(/tenant-defined/);
  });

  const entry: PlatformCatalogEntry = {
    ids: ['platform_canonical_email', 'field.canonical.email'],
    namespace: 'authrim.canonical',
    path: 'email',
    classification: 'pii',
    targetType: 'canonical',
    targetTaxonomy: 'canonical',
  };
  const compile = (targetRef: Record<string, unknown>) =>
    findPlatformMappingCompileViolation(
      { edges: [plain], validationRules: [{ targetRef }], transforms: [] },
      [entry]
    );

  it('asks a validation rule with no side for a catalog field, as for a source', () => {
    expect(compile({ namespace: 'authrim.profile', path: 'nickname' })).toMatch(
      /validation target is not a field/
    );
    expect(compile({ side: 'source', namespace: 'authrim.profile', path: 'nickname' })).toMatch(
      /validation target is not a field/
    );
    expect(compile({ namespace: 'authrim.profile', path: 'email' })).toBeNull();
    // Only a destination is outside the catalog.
    expect(compile({ side: 'destination', namespace: 'oidc.claim', path: 'nickname' })).toBeNull();
  });
});

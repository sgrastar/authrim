import { describe, expect, it } from 'vitest';
import {
  assertRuntimeIdentityMappingReleaseSafety,
  isVirtualCanonicalCatalogVersion,
  loadCustomClaimSchemaCatalogEntries,
  mergeCanonicalCatalogEntries,
  resolveRuntimeIdentityMappingBinding,
} from '../identity-mapping-runtime-resolver';
import {
  BUILT_IN_SYSTEM_IDENTITY_SOURCES,
  sensitiveClassificationRank,
} from '../identity-mapping-source-reads';
import type { DatabaseAdapter } from '../../db/adapter';

type Binding = Parameters<typeof assertRuntimeIdentityMappingReleaseSafety>[0];

function entry(id: string, path: string, classification: string, namespace = 'authrim.canonical') {
  return { id, namespace, path, valueType: 'string', cardinality: 'single', classification };
}

function binding(
  sourceRef: Record<string, unknown>,
  entries: ReturnType<typeof entry>[],
  target = 'urn:attr'
) {
  return {
    catalog: { entries },
    edges: [
      {
        id: 'edge',
        sourceRef: { side: 'source', ...sourceRef },
        targetRef: { side: 'destination', namespace: 'saml.attribute', path: target },
      },
    ],
  } as unknown as Binding;
}

const destination = (classification: string, requiredScopes: string[] = []) => [
  { key: 'urn:attr', classification, requiredScopes },
];
const strict = { requireKnownSources: true };

describe('sensitiveClassificationRank', () => {
  it('orders classifications, key_material the most sensitive', () => {
    const ranks = ['public', 'internal', 'pii', 'regulated', 'key_material'].map(
      sensitiveClassificationRank
    );
    expect(ranks).toEqual([0, 0, 1, 2, 3]);
    for (const secret of ['secret', 'credential', 'token']) {
      expect(sensitiveClassificationRank(secret)).toBe(2);
    }
    expect(sensitiveClassificationRank('unheard-of')).toBe(0);
  });
});

describe('assertRuntimeIdentityMappingReleaseSafety', () => {
  const email = entry('field.canonical.email', 'email', 'pii');
  const emailRef = { namespace: 'authrim.profile', path: 'email', catalogEntryId: email.id };

  it.each([[false], [true]])(
    'refuses to lower a sensitive classification (strict: %s)',
    (isStrict) => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(emailRef, [email]),
          destination('internal'),
          false,
          isStrict ? strict : {}
        )
      ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
    }
  );

  it.each([
    ['key_material', 'public'],
    ['key_material', 'internal'],
    ['key_material', 'pii'],
    ['key_material', 'regulated'],
    ['regulated', 'pii'],
  ])('refuses a %s source to a %s destination, strict or not', (source, target) => {
    const vault = entry('field.canonical.vault', 'vault', source);
    const ref = { namespace: 'authrim.profile', path: 'vault', catalogEntryId: vault.id };
    for (const options of [{}, strict]) {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(ref, [vault]),
          destination(target),
          false,
          options
        )
      ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
    }
  });

  it('lets a key_material source go to a key_material destination only', () => {
    const vault = entry('field.canonical.vault', 'vault', 'key_material');
    const ref = { namespace: 'authrim.profile', path: 'vault', catalogEntryId: vault.id };
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(
        binding(ref, [vault]),
        destination('key_material'),
        false,
        strict
      )
    ).not.toThrow();
  });

  it('lets a personal-data source go to a destination that is at least as sensitive', () => {
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(
        binding(emailRef, [email]),
        destination('pii'),
        false,
        strict
      )
    ).not.toThrow();
  });

  it('still requires a scope on a sensitive field when asked to', () => {
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(
        binding(emailRef, [email]),
        destination('pii'),
        true,
        strict
      )
    ).toThrow(expect.objectContaining({ reason: 'scope_required' }));
  });

  describe('a source the catalog does not describe', () => {
    const unknown = { namespace: 'authrim.claim', path: 'email' };

    it('is let through when sources are not required to be known (OIDC, as before)', () => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(binding(unknown, []), destination('public'), true)
      ).not.toThrow();
    });

    it('is refused when they are', () => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(unknown, []),
          destination('public'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
    });

    it.each([
      ['an entry id the catalog lacks', { ...unknown, catalogEntryId: 'field.canonical.nothing' }],
      [
        'an entry that describes another path',
        { namespace: 'authrim.profile', path: 'email', catalogEntryId: 'field.canonical.locale' },
      ],
    ])('is refused for %s', (_name, ref) => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(ref, [entry('field.canonical.locale', 'locale', 'public')]),
          destination('public'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
    });

    it('is found by namespace and path when the catalog describes it so', () => {
      const own = entry('own', 'email', 'pii', 'authrim.claim');
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(unknown, [own]),
          destination('internal'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(unknown, [own]),
          destination('pii'),
          false,
          strict
        )
      ).not.toThrow();
    });

    it('is refused too when the destination profile does not list the field it goes to', () => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(unknown, [], 'urn:other'),
          destination('public'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
    });

    it('is not released-from-nothing: a known source to an unlisted field passes', () => {
      const own = entry('own', 'email', 'pii', 'authrim.claim');
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(unknown, [own], 'urn:other'),
          destination('public'),
          false,
          strict
        )
      ).not.toThrow();
    });
  });

  describe('a reference that is not what it says', () => {
    const locale = entry('field.canonical.locale', 'locale', 'public');
    const email = entry('field.canonical.email', 'email', 'pii');

    function twoEdges(first: Record<string, unknown>, second: Record<string, unknown>) {
      return {
        catalog: { entries: [locale, email] },
        edges: [
          {
            id: 'e1',
            sourceRef: { side: 'source', ...first },
            targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'urn:other' },
          },
          {
            id: 'e2',
            sourceRef: { side: 'source', ...second },
            targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'urn:attr' },
          },
        ],
      } as unknown as Binding;
    }
    const emailAsLocale = {
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'field.canonical.locale',
    };
    const localeRef = {
      namespace: 'authrim.profile',
      path: 'locale',
      catalogEntryId: 'field.canonical.locale',
    };

    it.each([
      ['a source side that says destination', { side: 'destination' }, {}],
      ['a target side that says source', {}, { side: 'source' }],
    ])('is refused, not skipped: %s', (_name, sourceSide, targetSide) => {
      const forged = {
        catalog: { entries: [locale, email] },
        edges: [
          {
            id: 'e',
            sourceRef: { side: 'source', ...emailAsLocale, ...sourceSide },
            targetRef: {
              side: 'destination',
              namespace: 'saml.attribute',
              path: 'urn:attr',
              ...targetSide,
            },
          },
        ],
      } as unknown as Binding;
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(forged, destination('public'), false, strict)
      ).toThrow(expect.objectContaining({ reason: 'edge_reference_invalid' }));
    });

    it('is skipped as before when sources are not required to be known (OIDC)', () => {
      const forged = {
        catalog: { entries: [email] },
        edges: [
          {
            id: 'e',
            sourceRef: {
              side: 'destination',
              namespace: 'authrim.profile',
              path: 'email',
              catalogEntryId: email.id,
            },
            targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'urn:attr' },
          },
        ],
      } as unknown as Binding;
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(forged, destination('public'), false)
      ).not.toThrow();
    });

    it('is refused when one catalog entry id stands for two reads (a value could be matched to the other edge)', () => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          twoEdges(emailAsLocale, localeRef),
          destination('public'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'source_reference_conflict' }));
    });

    it('is refused when the id it names describes another place than the one it reads', () => {
      const secretCustom = entry(
        'entry.custom.entitlement',
        'entitlement',
        'secret',
        'authrim.custom_claims'
      );
      const publicProfile = entry(
        'entry.profile.entitlement',
        'entitlement',
        'public',
        'authrim.profile'
      );
      const forged = {
        catalog: { entries: [publicProfile, secretCustom] },
        edges: [
          {
            id: 'e',
            sourceRef: {
              side: 'source',
              namespace: 'authrim.custom_claims',
              path: 'entitlement',
              catalogEntryId: publicProfile.id,
            },
            targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'urn:attr' },
          },
        ],
      } as unknown as Binding;
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(forged, destination('public'), false, strict)
      ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
      // Named by the entry that describes it, it is the secret source it is.
      forged.edges[0].sourceRef.catalogEntryId = secretCustom.id;
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(forged, destination('public'), false, strict)
      ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
    });

    it('judges custom_claims.x under the profile as the customClaims.x it reads: a secret one may not go to a public field', () => {
      const publicSpelling = entry(
        'entry.public',
        'custom_claims.entitlement',
        'public',
        'authrim.profile'
      );
      const secret = entry('entry.secret', 'entitlement', 'secret', 'authrim.custom_claims');
      const spelled = {
        catalog: { entries: [publicSpelling, secret] },
        edges: [
          {
            id: 'e',
            sourceRef: {
              side: 'source',
              namespace: 'authrim.profile',
              path: 'custom_claims.entitlement',
              catalogEntryId: publicSpelling.id,
            },
            targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'urn:attr' },
          },
        ],
      } as unknown as Binding;
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(spelled, destination('public'), false, strict)
      ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
    });

    it('takes the most sensitive classification of the entries that describe the place it reads', () => {
      const lax = entry('lax', 'email', 'internal', 'authrim.claim');
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding({ namespace: 'authrim.profile', path: 'email' }, [lax, email]),
          destination('internal'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
    });

    it('does not take an entry that describes what is released for a source', () => {
      const released = {
        ...entry('d', 'email', 'public', 'saml.attribute'),
        targetType: 'destination-only',
      };
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding({ namespace: 'authrim.claim', path: 'email' }, [released]),
          destination('public'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
    });
  });

  describe('a source the runtime defines', () => {
    it.each(BUILT_IN_SYSTEM_IDENTITY_SOURCES)('is known as itself: $catalogEntryId', (source) => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(
            {
              namespace: source.namespace,
              path: source.path,
              catalogEntryId: source.catalogEntryId,
            },
            []
          ),
          destination('public'),
          false,
          strict
        )
      ).not.toThrow();
    });

    it.each([
      ['another path', { namespace: 'authrim.profile', path: 'email' }],
      ['another namespace', { namespace: 'authrim.claim', path: 'edu_person_assurance' }],
    ])('is not that source when it reads %s', (_name, read) => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding({ ...read, catalogEntryId: 'system.identity.edu_person_assurance' }, []),
          destination('public'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
    });

    it('is not any system.identity id', () => {
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(
          binding(
            { namespace: 'authrim.profile', path: 'x', catalogEntryId: 'system.identity.x' },
            []
          ),
          destination('public'),
          false,
          strict
        )
      ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
    });
  });
});

describe('the tenant’s own fields as catalog entries', () => {
  const adapter = (rows: Array<Record<string, unknown>>) =>
    ({ query: async () => rows }) as unknown as DatabaseAdapter;

  it('become field.canonical entries, personal data when marked PII, by the active key', async () => {
    const entries = await loadCustomClaimSchemaCatalogEntries(
      adapter([
        {
          id: '1',
          field_key: 'old',
          active_field_key: 'employeeNumber',
          field_type: 'string',
          cardinality: 'single',
          is_pii: 1,
        },
        {
          id: '2',
          field_key: 'badge',
          active_field_key: null,
          field_type: 'boolean',
          cardinality: 'multi',
          is_pii: false,
        },
        {
          id: '3',
          field_key: '  ',
          active_field_key: null,
          field_type: 'string',
          cardinality: 'single',
          is_pii: 0,
        },
      ]),
      'tenant-a'
    );
    expect(entries).toEqual([
      expect.objectContaining({
        id: 'field.canonical.employeeNumber',
        path: 'employeeNumber',
        classification: 'pii',
        cardinality: 'single',
      }),
      expect.objectContaining({
        id: 'field.canonical.badge',
        valueType: 'boolean',
        classification: 'internal',
        cardinality: 'multi',
      }),
    ]);
  });

  it('merge by id, the more sensitive classification winning, without duplicates', () => {
    const merged = mergeCanonicalCatalogEntries(
      [
        entry('field.canonical.email', 'email', 'pii'),
        entry('field.canonical.locale', 'locale', 'public'),
      ] as never,
      [
        entry('field.canonical.email', 'email', 'internal'),
        entry('field.canonical.locale', 'locale', 'regulated'),
        entry('field.canonical.new', 'new', 'internal'),
      ] as never
    );
    expect(merged.map((item) => [item.id, item.classification])).toEqual([
      ['field.canonical.email', 'pii'],
      ['field.canonical.locale', 'regulated'],
      ['field.canonical.new', 'internal'],
    ]);
  });
});

describe('the catalog of a snapshot compiled against the tenant’s fields', () => {
  const VIRTUAL = 'system_default_canonical_catalog_schema_v3';

  function fake(options: { stored: Array<Record<string, unknown>>; versionId: string }) {
    const queries: string[] = [];
    const adapter = {
      async query(sql: string, params: unknown[] = []) {
        queries.push(sql);
        if (sql.includes('FROM field_mapping_activations')) {
          return [
            {
              activation_id: 'a',
              tenant_id: 't',
              field_mapping_set_id: 's',
              field_mapping_version_id: 'v',
              activation_scope_json: '{}',
              version_label: 'x',
              field_mapping_hash: 'h',
              field_mapping_compatibility_range: '*',
              catalog_version_id: options.versionId,
              snapshot_hash: 'sh',
            },
          ];
        }
        if (sql.includes('field_catalog_versions v')) {
          return options.stored;
        }
        if (sql.includes('FROM field_catalog_entries')) {
          return params[1] === options.versionId ? [] : options.stored;
        }
        return [];
      },
      async queryOne() {
        return null;
      },
    } as unknown as DatabaseAdapter;
    return { adapter, queries };
  }

  const storedRow = {
    id: 'row-email',
    stable_field_id: 'field.canonical.email',
    namespace: 'authrim.canonical',
    path: 'email',
    target_taxonomy: 'canonical',
    value_type: 'string',
    cardinality: 'single',
    classification: 'pii',
    aliases_json: '[]',
    validation_json: '{}',
  };
  const resolve = (adapter: DatabaseAdapter, resolveCanonicalCatalog = true) =>
    resolveRuntimeIdentityMappingBinding(adapter, {
      tenantId: 't',
      protocol: 'saml',
      role: 'idp',
      resolveCanonicalCatalog,
    });

  it('recognises the derived version, and nothing else', () => {
    expect(isVirtualCanonicalCatalogVersion(VIRTUAL)).toBe(true);
    expect(isVirtualCanonicalCatalogVersion('system_default_canonical_catalog_v1')).toBe(false);
    expect(isVirtualCanonicalCatalogVersion('catalog_version_1')).toBe(false);
  });

  it('is the stored default canonical catalog’s entries, as the derived version has none of its own', async () => {
    const { adapter } = fake({ stored: [storedRow], versionId: VIRTUAL });
    const binding = await resolve(adapter);
    expect(binding?.catalog.identity.id).toBe(VIRTUAL);
    expect(binding?.catalog.entries).toEqual([
      expect.objectContaining({
        id: 'field.canonical.email',
        namespace: 'authrim.canonical',
        path: 'email',
        classification: 'pii',
      }),
    ]);
  });

  it('stays empty for a caller that did not ask for it, so only SAML is affected', async () => {
    const { adapter } = fake({ stored: [storedRow], versionId: VIRTUAL });
    expect((await resolve(adapter, false))?.catalog.entries).toEqual([]);
  });

  it('is empty, not guessed, when nothing is stored', async () => {
    const { adapter } = fake({ stored: [], versionId: VIRTUAL });
    expect((await resolve(adapter))?.catalog.entries).toEqual([]);
  });

  it('is read as stored for any other version, with no second look', async () => {
    const { adapter, queries } = fake({ stored: [], versionId: 'catalog_version_1' });
    expect((await resolve(adapter))?.catalog.entries).toEqual([]);
    expect(queries.some((sql) => sql.includes('FROM field_catalog_versions v'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  catalogReferenceResolver,
  isDestinationOnlyTargetType,
  findConflictingSourceIds,
  isTenantDefinedSubjectNamespace,
  mappingDestinationProfileIds,
  mappingReferenceCatalogEntryId,
  mappingReferencePath,
  mappingReferenceProfileId,
  mappingSourceSubjectPath,
  normalizeSubjectReadPath,
  readsTenantDefinedSubjectPart,
  resolveSourceClassification,
  toMappingSourceReference,
} from '../identity-mapping-source-reads';

describe('mappingSourceSubjectPath', () => {
  it.each([
    ['authrim.profile', 'email', 'email'],
    ['authrim.claim', 'email', 'email'],
    ['oidc.claim', 'email', 'email'],
    ['authrim.canonical', 'email', 'email'],
    ['authrim.claims', 'department', 'claims.department'],
    ['claims', 'department', 'claims.department'],
    ['authrim.custom_claims', 'entitlement', 'customClaims.entitlement'],
    ['custom_claims', 'entitlement', 'customClaims.entitlement'],
    ['authrim.custom_fields', 'badge', 'customFields.badge'],
    ['custom_fields', 'badge', 'customFields.badge'],
    ['authrim.attributes', 'groups', 'attributes.groups'],
    ['attributes', 'groups', 'attributes.groups'],
    ['authrim.system', 'uid', 'id'],
    ['authrim.system', 'email', 'email'],
    ['vendor.extension', 'name', 'name'],
  ])('%s:%s is read from %s', (namespace, path, expected) => {
    expect(mappingSourceSubjectPath({ namespace, path })).toBe(expected);
  });
});

describe('findConflictingSourceIds', () => {
  const ref = (namespace: string, path: string, catalogEntryId?: string) => ({
    namespace,
    path,
    catalogEntryId,
  });

  it('names an id read from two places, and no other', () => {
    expect(
      findConflictingSourceIds([
        ref('authrim.profile', 'email', 'a'),
        ref('authrim.profile', 'locale', 'a'),
        ref('authrim.profile', 'name', 'b'),
        ref('authrim.profile', 'name', 'b'),
        ref('authrim.claim', 'name', 'b'),
        ref('authrim.profile', 'x'),
        ref('authrim.profile', 'y'),
      ])
    ).toEqual(['a']);
  });

  it('is not tripped by the same place under two namespaces', () => {
    expect(
      findConflictingSourceIds([
        ref('authrim.profile', 'email', 'a'),
        ref('oidc.claim', 'email', 'a'),
      ])
    ).toEqual([]);
  });
});

describe('resolveSourceClassification', () => {
  const entries = [
    { ids: ['p'], namespace: 'authrim.canonical', path: 'email', classification: 'pii' },
  ];

  it('is the classification of the place read, whatever the namespace says', () => {
    expect(
      resolveSourceClassification(entries, { namespace: 'authrim.profile', path: 'email' })
    ).toBe('pii');
    expect(
      resolveSourceClassification(entries, {
        namespace: 'authrim.claim',
        path: 'email',
        catalogEntryId: 'p',
      })
    ).toBe('pii');
  });

  it('is unknown for a place nothing describes, an id the catalog lacks, or an id of another place', () => {
    expect(
      resolveSourceClassification(entries, { namespace: 'authrim.profile', path: 'x' })
    ).toBeNull();
    expect(
      resolveSourceClassification(entries, {
        namespace: 'authrim.profile',
        path: 'email',
        catalogEntryId: 'zz',
      })
    ).toBeNull();
    expect(
      resolveSourceClassification(entries, {
        namespace: 'authrim.custom_claims',
        path: 'email',
        catalogEntryId: 'p',
      })
    ).toBeNull();
  });
});

describe('normalizeSubjectReadPath', () => {
  it.each([
    ['sub', 'id'],
    ['user_id', 'id'],
    ['id', 'id'],
    ['email', 'email'],
    ['custom_claims.entitlement', 'customClaims.entitlement'],
    ['customClaims.entitlement', 'customClaims.entitlement'],
    ['custom_fields.badge', 'customFields.badge'],
    ['claims.department', 'claims.department'],
    ['custom_claims.a.b', 'customClaims.a.b'],
    // Only the first segment names a part, and only a whole path is a key alias.
    ['x.custom_claims', 'x.custom_claims'],
    ['sub.x', 'sub.x'],
  ])('%s is %s', (path, expected) => {
    expect(normalizeSubjectReadPath(path)).toBe(expected);
  });

  it('is applied to a path under a namespace, so the spellings of one place meet', () => {
    expect(
      mappingSourceSubjectPath({ namespace: 'authrim.profile', path: 'custom_claims.x' })
    ).toBe(mappingSourceSubjectPath({ namespace: 'authrim.custom_claims', path: 'x' }));
    expect(mappingSourceSubjectPath({ namespace: 'authrim.profile', path: 'sub' })).toBe(
      mappingSourceSubjectPath({ namespace: 'authrim.system', path: 'uid' })
    );
  });

  it('keeps one id for the spellings of one place from being a conflict, and two places from being one', () => {
    expect(
      findConflictingSourceIds([
        { namespace: 'authrim.profile', path: 'custom_claims.x', catalogEntryId: 'a' },
        { namespace: 'authrim.custom_claims', path: 'x', catalogEntryId: 'a' },
        { namespace: 'authrim.profile', path: 'sub', catalogEntryId: 'b' },
        { namespace: 'authrim.profile', path: 'user_id', catalogEntryId: 'b' },
      ])
    ).toEqual([]);
    expect(
      findConflictingSourceIds([
        { namespace: 'authrim.profile', path: 'custom_claims.x', catalogEntryId: 'a' },
        { namespace: 'authrim.profile', path: 'claims.x', catalogEntryId: 'a' },
      ])
    ).toEqual(['a']);
  });

  it('classifies a spelling of a place as the strictest entry of any spelling of it', () => {
    const entries = [
      {
        ids: ['public'],
        namespace: 'authrim.profile',
        path: 'custom_claims.entitlement',
        classification: 'public',
      },
      {
        ids: ['secret'],
        namespace: 'authrim.custom_claims',
        path: 'entitlement',
        classification: 'secret',
      },
    ];
    expect(
      resolveSourceClassification(entries, {
        namespace: 'authrim.profile',
        path: 'custom_claims.entitlement',
        catalogEntryId: 'public',
      })
    ).toBe('secret');
  });
});

describe('keys that are members of Object.prototype', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    '%s is a key like any other',
    (key) => {
      expect(normalizeSubjectReadPath(key)).toBe(key);
      expect(normalizeSubjectReadPath(`${key}.x`)).toBe(`${key}.x`);
      expect(mappingSourceSubjectPath({ namespace: 'authrim.profile', path: key })).toBe(key);
      expect(mappingSourceSubjectPath({ namespace: 'authrim.custom_claims', path: key })).toBe(
        `customClaims.${key}`
      );
    }
  );

  it('are classified like any other field, and do not disturb the others', () => {
    const entries = [
      { ids: ['e'], namespace: 'authrim.canonical', path: 'email', classification: 'pii' },
      ...['constructor', '__proto__', 'toString', 'hasOwnProperty'].map((path) => ({
        ids: [`field.canonical.${path}`],
        namespace: 'authrim.canonical',
        path,
        classification: 'internal',
      })),
    ];
    expect(
      resolveSourceClassification(entries, { namespace: 'authrim.profile', path: 'email' })
    ).toBe('pii');
    expect(
      resolveSourceClassification(entries, { namespace: 'authrim.profile', path: 'constructor' })
    ).toBe('internal');
    expect(
      findConflictingSourceIds([
        { namespace: 'authrim.profile', path: 'constructor', catalogEntryId: '__proto__' },
      ])
    ).toEqual([]);
  });
});

describe('tenant-defined parts of the subject', () => {
  it.each([
    ['authrim.custom_claims', 'x'],
    ['custom_claims', 'x'],
    ['authrim.custom_fields', 'x'],
    ['custom_fields', 'x'],
    ['authrim.attributes', 'x'],
    ['attributes', 'x'],
    // Spelled by path: the same place is read whatever the namespace says.
    ['authrim.profile', 'custom_claims.x'],
    ['authrim.canonical', 'custom_fields.x'],
    ['oidc.claim', 'customClaims.x'],
    ['authrim.profile', 'attributes.x'],
  ])('%s:%s reads a part a tenant defines', (namespace, path) => {
    expect(readsTenantDefinedSubjectPart({ namespace, path })).toBe(true);
  });

  it.each([
    ['authrim.profile', 'email'],
    ['authrim.canonical', 'given_name'],
    ['authrim.claims', 'department'],
    ['claims', 'department'],
    ['authrim.system', 'uid'],
    ['oidc.claim', 'custom_claims'],
    ['authrim.profile', 'constructor'],
    ['authrim.profile', 'attributes_summary.x'],
  ])('%s:%s does not', (namespace, path) => {
    expect(readsTenantDefinedSubjectPart({ namespace, path })).toBe(false);
  });

  it('knows the namespaces on their own, and not a name the destination chose', () => {
    for (const namespace of [
      'authrim.custom_claims',
      'custom_claims',
      'authrim.custom_fields',
      'custom_fields',
      'authrim.attributes',
      'attributes',
    ]) {
      expect(isTenantDefinedSubjectNamespace(namespace)).toBe(true);
    }
    for (const namespace of ['authrim.profile', 'oidc.claim', 'authrim.claims', 'authrim.system']) {
      expect(isTenantDefinedSubjectNamespace(namespace)).toBe(false);
    }
  });
});

describe('how a stored reference is read', () => {
  it('takes the path from path, else fieldKey, else nodeId', () => {
    expect(mappingReferencePath({ path: 'a', fieldKey: 'b', nodeId: 'c' })).toBe('a');
    expect(mappingReferencePath({ fieldKey: 'b', nodeId: 'c' })).toBe('b');
    expect(mappingReferencePath({ path: '', fieldKey: '', nodeId: 'c' })).toBe('c');
    expect(mappingReferencePath({ path: 1, fieldKey: null })).toBeUndefined();
  });

  it('takes the catalog entry from catalogEntryId, else catalog_entry_id', () => {
    expect(mappingReferenceCatalogEntryId({ catalogEntryId: 'a', catalog_entry_id: 'b' })).toBe(
      'a'
    );
    expect(mappingReferenceCatalogEntryId({ catalog_entry_id: 'b' })).toBe('b');
    expect(mappingReferenceCatalogEntryId({})).toBeUndefined();
  });

  it('takes the Destination Profile from profileId, else profile_id', () => {
    expect(mappingReferenceProfileId({ profileId: 'a', profile_id: 'b' })).toBe('a');
    expect(mappingReferenceProfileId({ profile_id: 'b' })).toBe('b');
    expect(mappingReferenceProfileId({ profileId: '' })).toBeUndefined();
  });

  it('turns a source reference into the place it reads, whatever its spelling', () => {
    expect(
      toMappingSourceReference({
        namespace: 'authrim.canonical',
        fieldKey: 'email',
        catalog_entry_id: 'e',
      })
    ).toEqual({ namespace: 'authrim.canonical', path: 'email', catalogEntryId: 'e' });
    expect(toMappingSourceReference({})).toEqual({
      namespace: '',
      path: '',
      catalogEntryId: undefined,
    });
  });

  it('counts the profiles the way the resolver does: each once, destination side only', () => {
    expect(
      mappingDestinationProfileIds([
        { profileId: 'destination-profile-p1' },
        { profile_id: 'p1' },
        { side: 'destination', profile_id: 'p2' },
        { side: 'source', profileId: 'p3' },
        { path: 'email' },
      ])
    ).toEqual(['p1', 'p2']);
  });
});

describe('catalogReferenceResolver', () => {
  const entries = [
    {
      ids: ['platform_canonical_email', 'field.canonical.email'],
      namespace: 'authrim.canonical',
      path: 'email',
      classification: 'pii',
      targetType: 'canonical',
    },
    {
      ids: ['platform_canonical_name', 'field.canonical.name'],
      namespace: 'authrim.canonical',
      path: 'name',
      classification: 'pii',
      targetType: 'canonical',
    },
    {
      ids: ['claim_email', 'field.oidc.email'],
      namespace: 'oidc.claim',
      path: 'email',
      classification: 'pii',
      targetType: 'destination-only',
    },
    {
      ids: ['no_stable_id'],
      namespace: 'authrim.canonical',
      path: 'locale',
      classification: 'internal',
      targetType: 'canonical',
    },
  ];
  const resolve = catalogReferenceResolver(entries);
  const email = { namespace: 'authrim.canonical', path: 'email' };

  it('brings a row ID to the stable ID, and leaves a stable ID as it is', () => {
    expect(resolve({ ...email, catalogEntryId: 'platform_canonical_email' }).catalogEntryId).toBe(
      'field.canonical.email'
    );
    expect(resolve({ ...email, catalogEntryId: 'field.canonical.email' }).catalogEntryId).toBe(
      'field.canonical.email'
    );
  });

  it('leaves the row ID of another place’s entry as it is: the ID never decides what is read', () => {
    const resolved = resolve({ ...email, catalogEntryId: 'platform_canonical_name' });

    expect(resolved).toEqual({ ...email, catalogEntryId: 'platform_canonical_name' });
    // The same place by another namespace spelling is the same place.
    expect(
      resolve({
        namespace: 'authrim.profile',
        path: 'email',
        catalogEntryId: 'platform_canonical_email',
      }).catalogEntryId
    ).toBe('field.canonical.email');
  });

  describe('a reference that names only its entry', () => {
    it.each([
      ['by its row ID', 'platform_canonical_email'],
      ['by its stable ID', 'field.canonical.email'],
    ])('reads the place of the entry when asked to complete it, %s', (_n, catalogEntryId) => {
      for (const stored of [
        { namespace: '', path: '' },
        { namespace: 'unknown', path: 'unknown' },
      ]) {
        expect(resolve({ ...stored, catalogEntryId }, { completePlace: true })).toEqual({
          namespace: 'authrim.canonical',
          path: 'email',
          catalogEntryId: 'field.canonical.email',
        });
      }
    });

    it('keeps an explicit namespace, which then decides whether the place is the entry’s', () => {
      const resolved = resolve(
        { namespace: 'authrim.custom_claims', path: '', catalogEntryId: 'field.canonical.email' },
        { completePlace: true }
      );

      expect(resolved).toEqual({
        namespace: 'authrim.custom_claims',
        path: 'email',
        catalogEntryId: 'field.canonical.email',
      });
      expect(mappingSourceSubjectPath(resolved)).toBe('customClaims.email');
    });

    it('is not completed unless asked to (a destination’s path is its own name)', () => {
      expect(
        resolve({ namespace: 'oidc.claim', path: '', catalogEntryId: 'platform_canonical_email' })
      ).toEqual({
        namespace: 'oidc.claim',
        path: '',
        catalogEntryId: 'field.canonical.email',
      });
    });

    it.each([
      ['an entry that describes what is released (destination-only)', 'claim_email'],
      ['an ID the catalog does not have', 'field.unknown'],
    ])('reads no place from %s', (_n, catalogEntryId) => {
      const resolved = resolve(
        { namespace: '', path: '', catalogEntryId },
        { completePlace: true }
      );

      expect(resolved.path).toBe('');
      expect(resolveSourceClassification(entries, resolved)).toBeNull();
    });

    it('reads the place of an entry that has no stable ID by its only ID', () => {
      expect(
        resolve(
          { namespace: '', path: '', catalogEntryId: 'no_stable_id' },
          { completePlace: true }
        )
      ).toEqual({ namespace: 'authrim.canonical', path: 'locale', catalogEntryId: 'no_stable_id' });
    });

    it('classifies the place read: email is pii', () => {
      const resolved = resolve(
        { namespace: '', path: '', catalogEntryId: 'platform_canonical_email' },
        { completePlace: true }
      );

      expect(resolveSourceClassification(entries, resolved)).toBe('pii');
    });
  });

  it('leaves a reference with no ID alone', () => {
    expect(resolve(email, { completePlace: true })).toBe(email);
  });

  it('prefers a stable ID to a row ID spelled the same', () => {
    const clash = catalogReferenceResolver([
      { ids: ['a', 'b'], namespace: 'x', path: 'p', classification: 'pii' },
      { ids: ['b', 'c'], namespace: 'x', path: 'q', classification: 'pii' },
    ]);

    expect(clash({ namespace: 'x', path: 'p', catalogEntryId: 'b' }).catalogEntryId).toBe('b');
    expect(clash({ namespace: 'x', path: 'p', catalogEntryId: 'a' }).catalogEntryId).toBe('b');
  });
});

describe('an entry of the older taxonomy `destination`', () => {
  // Stored before the taxonomy was named `destination-only`: the runtime reads it as that, and so
  // do the checks that run before it (compile and activation), which get the stored word.
  const legacy = {
    ids: ['claim_email', 'field.oidc.email'],
    namespace: 'oidc.claim',
    path: 'email',
    classification: 'pii',
    targetType: 'destination',
  };
  const current = { ...legacy, targetType: 'destination-only' };
  const read = { namespace: 'oidc.claim', path: 'email' };

  it('is no source of what it describes, as destination-only is none', () => {
    for (const entry of [legacy, current]) {
      expect(resolveSourceClassification([entry], read), entry.targetType).toBeNull();
      expect(
        resolveSourceClassification([entry], { ...read, catalogEntryId: 'claim_email' }),
        entry.targetType
      ).toBeNull();
    }
  });

  it('completes no place for a reference that names only it', () => {
    for (const entry of [legacy, current]) {
      const resolved = catalogReferenceResolver([entry])(
        { namespace: '', path: '', catalogEntryId: 'claim_email' },
        { completePlace: true }
      );
      expect(resolved.path, entry.targetType).toBe('');
    }
  });

  it('agrees with the word the runtime reads it by', () => {
    expect(isDestinationOnlyTargetType('destination')).toBe(true);
    expect(isDestinationOnlyTargetType('destination-only')).toBe(true);
    for (const other of ['canonical', 'custom', 'derived', 'review-only', undefined, '']) {
      expect(isDestinationOnlyTargetType(other), String(other)).toBe(false);
    }
  });
});

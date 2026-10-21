/**
 * How the runtime resolver treats a catalog entry ID that is the entry's row ID (the stable ID is
 * what the runtime catalog carries). Only a Mapping Set the platform owns, read for OIDC, has the
 * row ID brought to the stable ID; every other result is what it was, and a reference that reads
 * one place while naming the entry of another is never made consistent by it.
 */
import { describe, expect, it } from 'vitest';
import { executeRuntimeMapping } from '@authrim/ar-lib-field-mapping/runtime';
import { PLATFORM_MAPPING_TENANT_ID } from '../identity-mapping-owner';
import {
  assertRuntimeIdentityMappingReleaseSafety,
  resolveRuntimeIdentityMappingBinding,
} from '../identity-mapping-runtime-resolver';
import { loadMappingBindingBySetId } from '../identity-mapping-set-binding';
import {
  openAdminDatabase,
  seedDestinationProfile,
  seedMapping,
  sqliteAdapter,
} from './identity-mapping-sqlite-fixture';

type Database = ReturnType<typeof openAdminDatabase>;

/** A set whose catalog has `email` (pii) and `account_id` (internal), and one edge reading email. */
function seed(owner: string, source: Record<string, unknown>): Database {
  const db = openAdminDatabase();
  seed.rows(db, owner);
  db.prepare('UPDATE mapping_rule_edges SET source_ref_json = ?').run(
    JSON.stringify({ side: 'source', ...source })
  );
  return db;
}
seed.rows = (db: Database, owner: string) => {
  seedMapping(db, { owner, id: 'x' });
  seedDestinationProfile(db, { owner, id: 'profile-x' });
  // Row ID `entry-internal`, stable ID `field.internal.account`: another place, not sensitive.
  db.prepare(
    `INSERT INTO field_catalog_entries (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, classification, created_at, updated_at)
     VALUES ('entry-internal', ?, 'catalog-x', 'field.internal.account', 'authrim.profile', 'account_id', 'canonical', 'string', 'internal', 1, 1)`
  ).run(owner);
  // An entry that describes what is released, not what is read.
  db.prepare(
    `INSERT INTO field_catalog_entries (id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy, value_type, classification, created_at, updated_at)
     VALUES ('entry-claim', ?, 'catalog-x', 'field.oidc.email', 'oidc.claim', 'email', 'destination', 'string', 'pii', 1, 1)`
  ).run(owner);
};

const OIDC = { protocol: 'oidc', role: 'op' } as const;
const PUBLIC_CLAIM = [{ key: 'email', classification: 'public', requiredScopes: [] as string[] }];

async function load(db: Database, owner: string) {
  return loadMappingBindingBySetId({
    adapter: sqliteAdapter(db),
    tenantId: 'tenant-a',
    setId: 'set-x',
    tier: owner === PLATFORM_MAPPING_TENANT_ID ? 'platform_default' : 'tenant_default',
    protocol: 'oidc',
    role: 'op',
  });
}

describe('a tenant-owned Mapping Set read for OIDC', () => {
  it('keeps the catalog entry ID as it was stored, row ID or not', async () => {
    const db = seed('tenant-a', {
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'entry-x',
    });

    const binding = await load(db, 'tenant-a');

    expect(binding.edges[0].sourceRef.catalogEntryId).toBe('entry-x');
  });

  it('judges a source by the place it reads when it names the entry of another place', async () => {
    const db = seed('tenant-a', {
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'entry-internal',
    });
    const binding = await load(db, 'tenant-a');

    // email is pii: it cannot go to a public claim that needs no scope.
    expect(binding.edges[0].sourceRef.catalogEntryId).toBe('entry-internal');
    expect(() => assertRuntimeIdentityMappingReleaseSafety(binding, PUBLIC_CLAIM, true)).toThrow(
      expect.objectContaining({ reason: 'classification_lowered' })
    );
  });
});

describe('a platform-owned Mapping Set read for OIDC', () => {
  const P = PLATFORM_MAPPING_TENANT_ID;

  it('brings the row ID of the entry it reads to the stable ID', async () => {
    const db = seed(P, { namespace: 'authrim.profile', path: 'email', catalogEntryId: 'entry-x' });

    const binding = await load(db, P);

    expect(binding.edges[0].sourceRef.catalogEntryId).toBe('field.profile.email.x');
  });

  it('brings the row ID to the stable ID for a reference that names the entry alone', async () => {
    const db = seed(P, { namespace: 'authrim.profile', catalogEntryId: 'entry-x' });

    const binding = await load(db, P);

    expect(binding.edges[0].sourceRef.catalogEntryId).toBe('field.profile.email.x');
  });

  it.each([
    ['the row ID of another place', 'entry-internal'],
    ['the stable ID of another place', 'field.internal.account'],
  ])('refuses a source that reads email and names %s', async (_name, catalogEntryId) => {
    const db = seed(P, { namespace: 'authrim.profile', path: 'email', catalogEntryId });
    const binding = await load(db, P);

    // Not made consistent by the ID: it stays unknown, and the strict check refuses it.
    expect(binding.edges[0].sourceRef.catalogEntryId).toBe(catalogEntryId);
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(binding, PUBLIC_CLAIM, true, {
        requireKnownSources: true,
      })
    ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
  });

  it.each(['fieldKey', 'nodeId'])(
    'takes the place a source reads from %s, not from the entry it names',
    async (key) => {
      const db = seed(P, {
        namespace: 'authrim.profile',
        [key]: 'email',
        catalogEntryId: 'entry-internal',
      });
      const binding = await load(db, P);

      expect(binding.edges[0].sourceRef.catalogEntryId).toBe('entry-internal');
      expect(() =>
        assertRuntimeIdentityMappingReleaseSafety(binding, PUBLIC_CLAIM, true, {
          requireKnownSources: true,
        })
      ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
    }
  );
});

describe('a source that names only its catalog entry', () => {
  const P = PLATFORM_MAPPING_TENANT_ID;
  const STRICT = { requireKnownSources: true } as const;
  const SCOPED_PII = [{ key: 'email', classification: 'pii', requiredScopes: ['email'] }];

  it.each([
    ['the row ID', { catalogEntryId: 'entry-x' }],
    ['the row ID (catalog_entry_id)', { catalog_entry_id: 'entry-x' }],
    ['the stable ID', { catalogEntryId: 'field.profile.email.x' }],
  ])('reads the place of the entry in a platform set, naming %s', async (_n, entry) => {
    const db = seed(P, entry);

    const binding = await load(db, P);

    expect(binding.edges[0].sourceRef).toMatchObject({
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'field.profile.email.x',
    });
  });

  it('keeps the namespace the reference gives', async () => {
    const db = seed(P, { namespace: 'authrim.canonical', catalogEntryId: 'entry-x' });

    const binding = await load(db, P);

    expect(binding.edges[0].sourceRef).toMatchObject({
      namespace: 'authrim.canonical',
      path: 'email',
    });
  });

  it('applies the classification and the scope requirement of the place it reads', async () => {
    const db = seed(P, { catalogEntryId: 'entry-x' });
    const binding = await load(db, P);

    // email is pii: not to a public claim, and not to a claim that asks for no scope.
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(binding, PUBLIC_CLAIM, true, STRICT)
    ).toThrow(expect.objectContaining({ reason: 'classification_lowered' }));
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(
        binding,
        [{ key: 'email', classification: 'pii', requiredScopes: [] }],
        true,
        STRICT
      )
    ).toThrow(expect.objectContaining({ reason: 'scope_required' }));
    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(binding, SCOPED_PII, true, STRICT)
    ).not.toThrow();
  });

  it.each([
    ['an ID the catalog does not have', { catalogEntryId: 'entry-nothing' }],
    [
      'the entry that describes what is released (destination-only)',
      { catalogEntryId: 'entry-claim' },
    ],
    [
      'an entry of another namespace than the one the reference gives',
      {
        namespace: 'authrim.custom_claims',
        catalogEntryId: 'entry-x',
      },
    ],
  ])('is refused by the strict check when it names %s', async (_n, entry) => {
    const db = seed(P, entry);
    const binding = await load(db, P);

    expect(() =>
      assertRuntimeIdentityMappingReleaseSafety(binding, SCOPED_PII, true, STRICT)
    ).toThrow(expect.objectContaining({ reason: 'source_classification_unknown' }));
  });

  it('is read as it is stored in a set a tenant owns', async () => {
    const db = seed('tenant-a', { catalogEntryId: 'entry-x' });

    const binding = await load(db, 'tenant-a');

    expect(binding.edges[0].sourceRef).toMatchObject({
      path: 'unknown',
      catalogEntryId: 'entry-x',
    });
  });

  it('is read as it is stored for another protocol, and completed only when asked to', async () => {
    const db = seed(P, { catalogEntryId: 'entry-x' });
    const read = (normalizeCatalogEntryIds?: boolean) =>
      resolveRuntimeIdentityMappingBinding(sqliteAdapter(db), {
        tenantId: 'tenant-a',
        ownerTenantId: P,
        fieldMappingSetId: 'set-x',
        protocol: 'saml',
        role: 'idp',
        normalizeCatalogEntryIds,
      });

    expect((await read())?.edges[0].sourceRef).toMatchObject({
      path: 'unknown',
      catalogEntryId: 'entry-x',
    });
    expect((await read(true))?.edges[0].sourceRef).toMatchObject({
      path: 'email',
      catalogEntryId: 'field.profile.email.x',
    });
  });
});

describe('the destination of a platform-owned Mapping Set that names a catalog entry', () => {
  const P = PLATFORM_MAPPING_TENANT_ID;

  /** The edge reads email and releases it under `claim`, naming `catalogEntryId` for the claim. */
  function seedClaim(claim: string, catalogEntryId: string): Database {
    const db = seed(P, { namespace: 'authrim.profile', path: 'email' });
    db.prepare('UPDATE mapping_rule_edges SET target_ref_json = ?').run(
      JSON.stringify({
        side: 'destination',
        namespace: 'oidc.claim',
        path: claim,
        profileId: 'profile-x',
        catalogEntryId,
      })
    );
    return db;
  }

  it.each([
    ['the claim name of the entry', 'email'],
    ['a custom claim name', 'mail'],
  ])('brings the row ID to the stable ID whatever the claim is called: %s', async (_n, claim) => {
    const binding = await load(seedClaim(claim, 'entry-x'), P);

    expect(binding.edges[0].targetRef).toMatchObject({
      path: claim,
      catalogEntryId: 'field.profile.email.x',
    });
  });

  it('keeps a stable ID, and an ID the catalog does not have', async () => {
    const stable = await load(seedClaim('mail', 'field.profile.email.x'), P);
    const unknown = await load(seedClaim('mail', 'entry-nothing'), P);

    expect(stable.edges[0].targetRef.catalogEntryId).toBe('field.profile.email.x');
    expect(unknown.edges[0].targetRef.catalogEntryId).toBe('entry-nothing');
  });

  it('is released: the value is not dropped at the output because its ID is a row ID', async () => {
    const binding = await load(seedClaim('mail', 'entry-x'), P);

    const result = executeRuntimeMapping({
      catalog: binding.catalog,
      sourceValues: [
        {
          sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
          value: 'a@example.com',
        },
      ] as never,
      edges: binding.edges,
      transforms: [],
      validationRules: [],
      fieldMappingSet: binding.fieldMappingSet,
    });

    expect(result.values.map((value) => [value.sourceRef.path, value.value])).toEqual([
      ['mail', 'a@example.com'],
    ]);
  });

  it('is read as stored in a set a tenant owns', async () => {
    const db = seed('tenant-a', { namespace: 'authrim.profile', path: 'email' });
    db.prepare('UPDATE mapping_rule_edges SET target_ref_json = ?').run(
      JSON.stringify({
        side: 'destination',
        namespace: 'oidc.claim',
        path: 'mail',
        profileId: 'profile-x',
        catalogEntryId: 'entry-x',
      })
    );

    const binding = await load(db, 'tenant-a');

    expect(binding.edges[0].targetRef.catalogEntryId).toBe('entry-x');
  });
});

describe('the shared resolver for another protocol', () => {
  const P = PLATFORM_MAPPING_TENANT_ID;
  const context = {
    tenantId: 'tenant-a',
    ownerTenantId: P,
    fieldMappingSetId: 'set-x',
    activationScope: undefined,
  };

  it.each([
    ['saml', 'idp'],
    ['vc', 'verifier'],
    ['introspection', 'authorization_server'],
    ['oidc', 'op'],
  ])(
    'leaves the IDs as stored for %s unless it is asked to bring them to the stable ID',
    async (protocol, role) => {
      const db = seed(P, {
        namespace: 'authrim.profile',
        path: 'email',
        catalogEntryId: 'entry-x',
      });
      const adapter = sqliteAdapter(db);

      const asStored = await resolveRuntimeIdentityMappingBinding(adapter, {
        tenantId: context.tenantId,
        ownerTenantId: context.ownerTenantId,
        fieldMappingSetId: context.fieldMappingSetId,
        protocol,
        role,
      });
      const normalized = await resolveRuntimeIdentityMappingBinding(adapter, {
        tenantId: context.tenantId,
        ownerTenantId: context.ownerTenantId,
        fieldMappingSetId: context.fieldMappingSetId,
        protocol,
        role,
        normalizeCatalogEntryIds: true,
      });

      expect(asStored?.edges[0].sourceRef.catalogEntryId).toBe('entry-x');
      expect(normalized?.edges[0].sourceRef.catalogEntryId).toBe('field.profile.email.x');
    }
  );

  it('leaves the target reference of a SAML mapping as stored', async () => {
    const db = seed('tenant-a', { namespace: 'authrim.profile', path: 'email' });
    db.prepare('UPDATE mapping_rule_edges SET target_ref_json = ?').run(
      JSON.stringify({
        side: 'destination',
        namespace: 'saml.attribute',
        path: 'email',
        profileId: 'profile-x',
        catalogEntryId: 'entry-x',
      })
    );

    const binding = await resolveRuntimeIdentityMappingBinding(sqliteAdapter(db), {
      tenantId: 'tenant-a',
      fieldMappingSetId: 'set-x',
      protocol: 'saml',
      role: 'idp',
    });

    expect(binding?.edges[0].targetRef.catalogEntryId).toBe('entry-x');
  });

  void OIDC;
});

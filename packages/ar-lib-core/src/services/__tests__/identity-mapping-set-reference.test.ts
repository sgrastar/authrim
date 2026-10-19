import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { DISABLED_MARKER } from '../../utils/settings-manager';
import { PLATFORM_MAPPING_TENANT_ID } from '../identity-mapping-owner';
import {
  oidcDefaultSetValueProblem,
  readOidcDefaultSetSelection,
  validateOidcMappingSetReference,
  type ValidateOidcMappingSetReferenceInput,
} from '../identity-mapping-set-reference';
import {
  openAdminDatabase,
  seedDestinationProfile,
  seedMapping,
  sqliteAdapter,
} from './identity-mapping-sqlite-fixture';

describe('oidcDefaultSetValueProblem', () => {
  it.each(['platform', 'tenant'] as const)('takes a Mapping Set ID at the %s scope', (scope) => {
    for (const id of [
      'field_mapping_8f0c1b8e-6a4d-4c47-9d6b-2f1d7f6f0a11',
      'mapping_set_1',
      'a',
      'A.b:c-d_e',
      'x'.repeat(200),
    ]) {
      expect(oidcDefaultSetValueProblem(id, scope), id).toBeNull();
    }
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['leading space', ' set-1'],
    ['trailing space', 'set-1 '],
    ['newline', 'set-1\n'],
    ['over 200 characters', 'x'.repeat(201)],
    ['a space inside', 'set 1'],
    ['a slash', 'set/1'],
    ['starting with a hyphen', '-set'],
    ['non-ASCII', 'セット'],
    ['a quote', 'set"1'],
  ])('refuses %s', (_name, value) => {
    for (const scope of ['platform', 'tenant'] as const) {
      expect(
        oidcDefaultSetValueProblem(value, scope),
        `${scope} ${JSON.stringify(value)}`
      ).not.toBe(null);
    }
  });

  it.each([
    ['false', false],
    ['true', true],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['an array', ['set-1']],
    ['an object', { id: 'set-1' }],
  ])('refuses %s: only a string can be saved', (_name, value) => {
    for (const scope of ['platform', 'tenant'] as const) {
      expect(oidcDefaultSetValueProblem(value, scope)).toMatch(/must be a Mapping Set ID/);
    }
  });

  it('refuses the disabled marker: it would read back as no value', () => {
    for (const scope of ['platform', 'tenant'] as const) {
      expect(oidcDefaultSetValueProblem(DISABLED_MARKER, scope)).toMatch(/cannot be disabled/);
    }
  });

  it('takes none for a tenant only, and only spelled exactly', () => {
    expect(oidcDefaultSetValueProblem('none', 'tenant')).toBeNull();
    expect(oidcDefaultSetValueProblem('none', 'platform')).toMatch(/cannot be none/);
    for (const spelling of ['None', 'NONE', 'nOnE']) {
      expect(oidcDefaultSetValueProblem(spelling, 'tenant')).toMatch(/exactly none/);
      expect(oidcDefaultSetValueProblem(spelling, 'platform')).toMatch(/exactly none/);
    }
    // Not the reserved value: an ID that merely contains it.
    expect(oidcDefaultSetValueProblem('none-set', 'tenant')).toBeNull();
    expect(oidcDefaultSetValueProblem('nonexistent', 'tenant')).toBeNull();
  });
});

describe('readOidcDefaultSetSelection', () => {
  it('reads nothing as unset, so the next level decides', () => {
    expect(readOidcDefaultSetSelection(undefined)).toEqual({ kind: 'unset' });
    expect(readOidcDefaultSetSelection(null)).toEqual({ kind: 'unset' });
  });

  it('reads none as the explicit opt-out, and an ID as a set', () => {
    expect(readOidcDefaultSetSelection('none')).toEqual({ kind: 'none' });
    expect(readOidcDefaultSetSelection('field_mapping_1')).toEqual({
      kind: 'set',
      setId: 'field_mapping_1',
    });
  });

  it.each([
    // The settings reader turns the disabled marker into false for every key.
    ['false', false],
    ['true', true],
    ['the disabled marker', DISABLED_MARKER],
    ['empty', ''],
    ['whitespace', ' '],
    ['an ID with surrounding whitespace', ' set-1'],
    ['an over-long ID', 'x'.repeat(201)],
    ['an ID of no valid form', 'set/1'],
    ['an uppercase none', 'NONE'],
    ['a number', 0],
    ['an object', {}],
    ['an array', []],
  ])('reads %s as a failure, never as unset or none', (_name, value) => {
    expect(readOidcDefaultSetSelection(value)).toEqual({ kind: 'invalid' });
  });
});

function input(
  adapter: DatabaseAdapter | null | undefined,
  overrides: Partial<ValidateOidcMappingSetReferenceInput> = {}
): ValidateOidcMappingSetReferenceInput {
  return {
    adminAdapter: adapter,
    contextTenantId: 'tenant-a',
    scope: 'tenant',
    setId: 'set-plat',
    ...overrides,
  };
}

/** One platform set with its platform profile, and one set and profile for each of two tenants. */
function seeded() {
  const db = openAdminDatabase();
  seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
  seedDestinationProfile(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'profile-plat' });
  seedMapping(db, { owner: 'tenant-a', id: 'a' });
  seedDestinationProfile(db, { owner: 'tenant-a', id: 'profile-a' });
  seedMapping(db, { owner: 'tenant-b', id: 'b' });
  seedDestinationProfile(db, { owner: 'tenant-b', id: 'profile-b' });
  return { db, adapter: sqliteAdapter(db) };
}

describe('validateOidcMappingSetReference', () => {
  describe('who may be named where', () => {
    it('lets the platform name a platform-owned set', async () => {
      const { adapter } = seeded();
      expect(
        await validateOidcMappingSetReference(
          input(adapter, { scope: 'platform', contextTenantId: PLATFORM_MAPPING_TENANT_ID })
        )
      ).toMatchObject({
        ok: true,
        ownerTenantId: PLATFORM_MAPPING_TENANT_ID,
        setId: 'set-plat',
        versionId: 'ver-plat',
        destinationProfileId: 'profile-plat',
        snapshotHash: 'snapshot-plat',
      });
    });

    it('lets the tenant scope name the platform’s set and its own', async () => {
      const { adapter } = seeded();
      expect(
        await validateOidcMappingSetReference(
          input(adapter, { scope: 'tenant', setId: 'set-plat' })
        )
      ).toMatchObject({ ok: true, ownerTenantId: PLATFORM_MAPPING_TENANT_ID });
      expect(
        await validateOidcMappingSetReference(input(adapter, { scope: 'tenant', setId: 'set-a' }))
      ).toMatchObject({ ok: true, ownerTenantId: 'tenant-a', destinationProfileId: 'profile-a' });
    });

    // Until the runtime resolves an app's own Mapping Set under its owner (stage 2), an app saved
    // with a platform-owned set would fail every sign-in.
    it('lets an app name its tenant’s own set, but refuses the platform’s as if it did not exist', async () => {
      const { adapter } = seeded();
      expect(
        await validateOidcMappingSetReference(input(adapter, { scope: 'client', setId: 'set-a' }))
      ).toMatchObject({ ok: true, ownerTenantId: 'tenant-a' });
      const platform = await validateOidcMappingSetReference(
        input(adapter, { scope: 'client', setId: 'set-plat' })
      );
      const missing = await validateOidcMappingSetReference(
        input(adapter, { scope: 'client', setId: 'set-nothing' })
      );
      expect(platform).toMatchObject({ ok: false, code: 'set_missing' });
      expect(platform).toEqual(missing);
    });

    it.each([
      [
        'a draft set',
        "UPDATE field_mapping_sets SET lifecycle_state = 'draft' WHERE id = 'set-plat'",
      ],
      [
        'a set with no active activation',
        "UPDATE field_mapping_activations SET lifecycle_state = 'inactive' WHERE id = 'act-plat'",
      ],
      [
        'a set with no active compiled snapshot',
        "UPDATE compiled_mapping_snapshots SET lifecycle_state = 'superseded' WHERE id = 'snap-plat'",
      ],
      [
        'a set with two Destination Profiles',
        'INSERT INTO mapping_rule_edges (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order, created_at, updated_at) VALUES (\'edge-x\', \'platform\', \'rule-plat\', \'{"side":"source","namespace":"authrim.profile","path":"email"}\', \'{"side":"destination","profileId":"profile-two","namespace":"oidc.claim","path":"email"}\', \'direct\', 1, 1, 1)',
      ],
      [
        'a set that holds what a platform set may not',
        'UPDATE mapping_rule_edges SET source_ref_json = \'{"side":"source","namespace":"authrim.custom_claims","path":"tier"}\' WHERE tenant_id = \'platform\'',
      ],
    ])(
      'answers an app naming %s of the platform exactly as a set that does not exist',
      async (_name, sql) => {
        const { db, adapter } = seeded();
        db.prepare(sql).run();
        const platform = await validateOidcMappingSetReference(
          input(adapter, { scope: 'client', setId: 'set-plat' })
        );
        const missing = await validateOidcMappingSetReference(
          input(adapter, { scope: 'client', setId: 'set-nothing' })
        );
        const otherTenant = await validateOidcMappingSetReference(
          input(adapter, { scope: 'client', setId: 'set-b' })
        );
        expect(platform).toMatchObject({ ok: false, code: 'set_missing' });
        expect(platform).toEqual(missing);
        expect(platform).toEqual(otherTenant);
      }
    );

    it('still tells the tenant default about the state of a platform set', async () => {
      const { db, adapter } = seeded();
      db.prepare(
        "UPDATE field_mapping_sets SET lifecycle_state = 'draft' WHERE id = 'set-plat'"
      ).run();
      expect(
        await validateOidcMappingSetReference(
          input(adapter, { scope: 'tenant', setId: 'set-plat' })
        )
      ).toMatchObject({ ok: false, code: 'set_inactive' });
    });

    it('refuses a tenant’s set for the platform’s default, as if it did not exist', async () => {
      const { adapter } = seeded();
      const own = await validateOidcMappingSetReference(
        input(adapter, {
          scope: 'platform',
          contextTenantId: PLATFORM_MAPPING_TENANT_ID,
          setId: 'set-a',
        })
      );
      const missing = await validateOidcMappingSetReference(
        input(adapter, {
          scope: 'platform',
          contextTenantId: PLATFORM_MAPPING_TENANT_ID,
          setId: 'set-nothing',
        })
      );
      expect(own).toMatchObject({ ok: false, code: 'set_missing' });
      expect(own).toEqual(missing);
    });

    it('holds the platform’s default to the platform’s sets whichever tenant the call is made for', async () => {
      const { adapter } = seeded();
      expect(
        await validateOidcMappingSetReference(
          input(adapter, { scope: 'platform', contextTenantId: 'tenant-a', setId: 'set-a' })
        )
      ).toMatchObject({ ok: false, code: 'set_missing' });
      expect(
        await validateOidcMappingSetReference(
          input(adapter, { scope: 'platform', contextTenantId: 'tenant-a', setId: 'set-plat' })
        )
      ).toMatchObject({ ok: true, ownerTenantId: PLATFORM_MAPPING_TENANT_ID });
    });

    it.each(['tenant', 'client'] as const)(
      'refuses another tenant’s set for the %s scope, as if it did not exist',
      async (scope) => {
        const { adapter } = seeded();
        const other = await validateOidcMappingSetReference(
          input(adapter, { scope, setId: 'set-b' })
        );
        const missing = await validateOidcMappingSetReference(
          input(adapter, { scope, setId: 'set-nothing' })
        );
        expect(other).toMatchObject({ ok: false, code: 'set_missing' });
        expect(other).toEqual(missing);
        expect(JSON.stringify(other)).not.toContain('tenant-b');
      }
    );
  });

  describe('a set that cannot be used', () => {
    it('refuses a set that is not active', async () => {
      const { db, adapter } = seeded();
      db.prepare(
        "UPDATE field_mapping_sets SET lifecycle_state = 'draft' WHERE id = 'set-a'"
      ).run();
      expect(
        await validateOidcMappingSetReference(input(adapter, { setId: 'set-a' }))
      ).toMatchObject({
        ok: false,
        code: 'set_inactive',
      });
    });

    it('refuses a set with no active activation', async () => {
      const { db, adapter } = seeded();
      db.prepare("UPDATE field_mapping_activations SET lifecycle_state = 'inactive'").run();
      for (const setId of ['set-a', 'set-plat']) {
        expect(await validateOidcMappingSetReference(input(adapter, { setId }))).toMatchObject({
          ok: false,
          code: 'set_inactive',
        });
      }
    });

    it('refuses a set whose version has no active compiled snapshot', async () => {
      const { db, adapter } = seeded();
      db.prepare("UPDATE compiled_mapping_snapshots SET lifecycle_state = 'superseded'").run();
      expect(
        await validateOidcMappingSetReference(input(adapter, { setId: 'set-a' }))
      ).toMatchObject({
        ok: false,
        code: 'set_inactive',
      });
    });

    it('refuses an activation that applies to one app only', async () => {
      const { db, adapter } = seeded();
      db.prepare(
        'UPDATE field_mapping_activations SET activation_scope_json = \'{"clientId":"app-1"}\' WHERE id = \'act-a\''
      ).run();
      expect(
        await validateOidcMappingSetReference(input(adapter, { setId: 'set-a' }))
      ).toMatchObject({
        ok: false,
        code: 'set_inactive',
      });
    });

    it('refuses a pinned version that is not the active one', async () => {
      const { adapter } = seeded();
      expect(
        await validateOidcMappingSetReference(
          input(adapter, { scope: 'client', setId: 'set-a', versionId: 'ver-a' })
        )
      ).toMatchObject({ ok: true, versionId: 'ver-a' });
      expect(
        await validateOidcMappingSetReference(
          input(adapter, { scope: 'client', setId: 'set-a', versionId: 'ver-other' })
        )
      ).toMatchObject({ ok: false, code: 'set_inactive' });
    });
  });

  describe('the Destination Profile', () => {
    it('refuses a set that releases into two profiles', async () => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-a', id: 'a', profiles: ['profile-a', 'profile-a2'] });
      seedDestinationProfile(db, { owner: 'tenant-a', id: 'profile-a' });
      expect(
        await validateOidcMappingSetReference(input(sqliteAdapter(db), { setId: 'set-a' }))
      ).toMatchObject({ ok: false, code: 'destination_profile_invalid' });
    });

    it.each([
      ['has no row', () => undefined],
      [
        'is a SAML profile',
        (db: ReturnType<typeof openAdminDatabase>) =>
          seedDestinationProfile(db, {
            owner: 'tenant-a',
            id: 'profile-a',
            destinationType: 'saml',
          }),
      ],
      [
        'is not active',
        (db: ReturnType<typeof openAdminDatabase>) =>
          seedDestinationProfile(db, {
            owner: 'tenant-a',
            id: 'profile-a',
            lifecycleState: 'draft',
          }),
      ],
      [
        'has no active version',
        (db: ReturnType<typeof openAdminDatabase>) =>
          seedDestinationProfile(db, { owner: 'tenant-a', id: 'profile-a', versionState: 'draft' }),
      ],
    ])('refuses a set whose profile %s', async (_name, arrange) => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-a', id: 'a' });
      arrange(db);
      expect(
        await validateOidcMappingSetReference(input(sqliteAdapter(db), { setId: 'set-a' }))
      ).toMatchObject({ ok: false, code: 'destination_profile_invalid' });
    });

    it('takes a platform profile for a tenant’s own set', async () => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-a', id: 'a', profiles: ['profile-shared'] });
      seedDestinationProfile(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'profile-shared' });
      expect(
        await validateOidcMappingSetReference(input(sqliteAdapter(db), { setId: 'set-a' }))
      ).toMatchObject({ ok: true, destinationProfileId: 'profile-shared' });
    });
  });

  describe('a set the platform owns is held to what a platform set may hold', () => {
    it('refuses a platform set whose profile belongs to a tenant', async () => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat', profiles: ['profile-a'] });
      seedDestinationProfile(db, { owner: 'tenant-a', id: 'profile-a' });
      for (const scope of ['platform', 'tenant'] as const) {
        expect(
          await validateOidcMappingSetReference(
            input(sqliteAdapter(db), {
              scope,
              contextTenantId: scope === 'platform' ? PLATFORM_MAPPING_TENANT_ID : 'tenant-a',
            })
          ),
          scope
        ).toMatchObject({ ok: false, code: 'destination_profile_invalid' });
      }
    });

    it.each([
      [
        'reads a tenant-defined field',
        'UPDATE mapping_rule_edges SET source_ref_json = \'{"side":"source","namespace":"authrim.custom_claims","path":"tier"}\'',
        /tenant-defined/,
      ],
      [
        'reads a source the platform catalog does not have',
        'UPDATE mapping_rule_edges SET source_ref_json = \'{"side":"source","namespace":"authrim.profile","path":"unknown_field"}\'',
        /not a field of the platform catalog/,
      ],
      [
        'makes a persistent identifier',
        "UPDATE mapping_transform_steps SET operation = 'oidc_pairwise_sub'",
        /persistent identifier/,
      ],
      [
        'uses a custom catalog field',
        "UPDATE field_catalog_entries SET target_taxonomy = 'custom'",
        /custom catalog field/,
      ],
    ])('refuses a platform set that %s', async (_name, sql, expected) => {
      const { db, adapter } = seeded();
      db.prepare(sql).run();
      for (const [scope, contextTenantId] of [
        ['platform', PLATFORM_MAPPING_TENANT_ID],
        ['tenant', 'tenant-a'],
      ] as const) {
        const result = await validateOidcMappingSetReference(
          input(adapter, { scope, contextTenantId, setId: 'set-plat' })
        );
        expect(result, scope).toMatchObject({ ok: false, code: 'platform_set_unsafe' });
        if (!result.ok) expect(result.message, scope).toMatch(expected);
      }
    });

    it('does not hold a tenant’s own set to the platform’s rules', async () => {
      const { db, adapter } = seeded();
      // A tenant may read its own custom fields.
      db.prepare(
        'UPDATE mapping_rule_edges SET source_ref_json = \'{"side":"source","namespace":"authrim.custom_claims","path":"tier"}\' WHERE tenant_id = \'tenant-a\''
      ).run();
      expect(
        await validateOidcMappingSetReference(input(adapter, { setId: 'set-a' }))
      ).toMatchObject({
        ok: true,
      });
    });
  });

  describe('when the database cannot answer', () => {
    it('fails without an Admin database, never as an empty answer', async () => {
      for (const adapter of [null, undefined]) {
        expect(await validateOidcMappingSetReference(input(adapter))).toMatchObject({
          ok: false,
          code: 'admin_database_unavailable',
          reasonCode: 'admin_database_not_configured',
        });
      }
    });

    it('fails when the lookup of the set fails, with a fixed reason and nothing of the error', async () => {
      const failing = {
        queryOne: async () => {
          throw new Error('D1_ERROR: no such table: field_mapping_sets (secret-tenant-x)');
        },
        query: async () => [],
      } as unknown as DatabaseAdapter;
      const result = await validateOidcMappingSetReference(input(failing));
      expect(result).toMatchObject({
        ok: false,
        code: 'admin_database_unavailable',
        reasonCode: 'no_such_table',
      });
      expect(JSON.stringify(result)).not.toContain('secret-tenant-x');
    });

    it('fails when a later read fails: the profile, or the platform set’s rows', async () => {
      const { adapter } = seeded();
      const failOn = (pattern: RegExp): DatabaseAdapter =>
        ({
          queryOne: async (sql: string, params?: unknown[]) => {
            if (pattern.test(sql)) throw new Error('database_timeout');
            return adapter.queryOne(sql, params);
          },
          query: async (sql: string, params?: unknown[]) => {
            if (pattern.test(sql)) throw new Error('database_timeout');
            return adapter.query(sql, params);
          },
        }) as unknown as DatabaseAdapter;

      expect(
        await validateOidcMappingSetReference(
          input(failOn(/FROM destination_profiles/), { setId: 'set-a' })
        )
      ).toMatchObject({ ok: false, code: 'admin_database_unavailable' });
      expect(
        await validateOidcMappingSetReference(
          input(failOn(/SELECT id, stable_field_id/), { setId: 'set-plat' })
        )
      ).toMatchObject({ ok: false, code: 'admin_database_unavailable' });
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { resolveOidcIdentityMappingBinding } from '../identity-mapping-resolution';
import { mapIDTokenClaims, type IDTokenReleaseContext } from '../oidc-id-token-release';
import {
  applyOIDCIdentityMapping,
  OIDCIdentityMappingRuntimeError,
  type ApplyOIDCIdentityMappingInput,
} from '../oidc-identity-mapping';

/**
 * Which Mapping Set an OIDC app is bound to is decided by what is named: the app's own choice,
 * else the tenant's default, else the platform's, else none (field mapping tiers, stage 2). An
 * activation's scope never binds an app to a set. The real selection, the real reading of the
 * set, the mapping runtime and the Destination Profile release filter run here; only the
 * databases and the settings store are fakes.
 *
 * The 2026-10-10 environment had an activation for the whole tenant (`{ kind: 'tenant' }`) and
 * apps with no Mapping Set: the ID token lost name, email, phone and address, and UserInfo
 * answered differently depending on whether the Worker could read the Admin database. Here such
 * an app is bound to nothing, in every Worker and on every surface.
 */

type Row = Record<string, unknown>;

const STANDARD_CLAIMS = [
  ['name', 'profile'],
  ['email', 'email'],
  ['email_verified', 'email'],
  ['phone_number', 'phone'],
  ['phone_number_verified', 'phone'],
  ['address', 'address'],
] as const;

const KEY = 'identity_mapping.oidc_default_set_id';

const fixture = {
  /** field_mapping_sets rows by set ID. */
  sets: {} as Record<string, { tenant_id: string; lifecycle_state: string }>,
  /** Active activations; the lookup returns those of the owner it is asked under, per set. */
  activations: [] as Array<{ tenantId: string; setId: string; scope: Record<string, unknown> }>,
  profileType: 'oidc' as 'oidc' | 'saml',
  /** Whether the Destination Profile the sets release into is there and active. */
  profile: 'active' as 'active' | 'draft' | 'missing',
  /** Whether the user already agreed to release the profile's fields. */
  selection: 'none' as 'none' | 'all',
  lookups: [] as string[],
};

/** The standard claims, all optional and for UserInfo only (the 2026-10-10 shape). */
function oidcProfileClaims() {
  return [
    { claimName: 'sub', required: true, surfaces: ['id_token', 'userinfo'] },
    ...STANDARD_CLAIMS.map(([claimName, scope]) => ({
      claimName,
      surfaces: ['userinfo'],
      requiredScopes: [scope],
      classification: 'pii',
    })),
  ];
}

function activationRow(owner: string, setId: string, scope: Record<string, unknown>): Row {
  return {
    activation_id: `activation-${setId}`,
    tenant_id: owner,
    field_mapping_set_id: setId,
    field_mapping_version_id: `version-${setId}`,
    activation_scope_json: JSON.stringify(scope),
    version_label: 'v1',
    field_mapping_hash: 'hash-1',
    field_mapping_compatibility_range: '^0.3.0',
    catalog_version_id: 'catalog-1',
    snapshot_hash: `snapshot-${setId}`,
    catalog_version_label: 'c1',
    catalog_bundle_hash: 'catalog-hash',
    catalog_compatibility_range: '^0.3.0',
  };
}

/** One database standing for the Admin database; it answers by statement. */
function adminDatabase(): DatabaseAdapter {
  const answer = async (sql: string, params: unknown[] = []): Promise<Row[]> => {
    fixture.lookups.push(sql);
    if (sql.includes('FROM field_mapping_activations')) {
      const [owner, , setId] = params as [string, string, string | undefined];
      const filtersBySet = sql.includes('a.field_mapping_set_id = ?');
      return fixture.activations
        .filter((a) => a.tenantId === owner && (!filtersBySet || a.setId === setId))
        .map((a) => activationRow(a.tenantId, a.setId, a.scope));
    }
    if (sql.includes('FROM field_catalog_entries')) {
      return [
        {
          id: 'entry-source-email',
          stable_field_id: 'field.profile.email',
          namespace: 'authrim.profile',
          path: 'email',
          target_taxonomy: 'canonical',
          value_type: 'string',
          cardinality: 'single',
          classification: 'pii',
          aliases_json: null,
          validation_json: '{}',
        },
        {
          id: 'entry-claim-email',
          stable_field_id: 'field.oidc.email',
          namespace: 'oidc.claim',
          path: 'email',
          target_taxonomy: 'destination',
          value_type: 'string',
          cardinality: 'single',
          classification: 'pii',
          aliases_json: null,
          validation_json: '{}',
        },
      ];
    }
    if (sql.includes('JOIN mapping_rule_edges')) {
      return [
        {
          id: 'edge-email',
          source_ref_json: JSON.stringify({
            side: 'source',
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'field.profile.email',
          }),
          target_ref_json: JSON.stringify({
            side: 'destination',
            profileId: 'profile-1',
            namespace: 'oidc.claim',
            path: 'email',
            catalogEntryId: 'field.oidc.email',
          }),
          edge_kind: 'direct',
          display_order: 0,
        },
      ];
    }
    return [];
  };
  const adapter = {
    query: answer,
    async queryOne(sql: string, params: unknown[] = []) {
      fixture.lookups.push(sql);
      if (sql.includes('FROM field_mapping_sets')) return fixture.sets[String(params[0])] ?? null;
      if (sql.includes('destination_profiles')) {
        // A profile set back to draft is not found by the active-profile lookup, nor is one that was removed.
        if (fixture.profile !== 'active') return null;
        return {
          profile_id: 'profile-1',
          destination_type: fixture.profileType,
          version_id: 'profile-version-1',
          schema_json: JSON.stringify(
            fixture.profileType === 'oidc'
              ? { claims: oidcProfileClaims() }
              : { attributes: [{ name: 'mail' }] }
          ),
        };
      }
      return null;
    },
    execute: async () => ({ success: true, rowsAffected: 0 }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(adapter),
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
    getType: () => 'test',
    close: async () => undefined,
  };
  return adapter as unknown as DatabaseAdapter;
}

/** The tenant's Core database: it holds no mapping, and a read of it for one is a defect. */
function coreDatabase() {
  const reads: string[] = [];
  const adapter = {
    query: async (sql: string) => {
      reads.push(sql);
      return [];
    },
    queryOne: async (sql: string) => {
      reads.push(sql);
      // The user's release consent is the Core database's.
      if (sql.includes('FROM consent_records') && fixture.selection === 'all') {
        return {
          id: 'consent-1',
          released_claims_json: JSON.stringify(oidcProfileClaims().map((c) => c.claimName)),
          released_attributes_json: null,
          evidence_json: '{}',
          created_at: 1,
        };
      }
      return null;
    },
    execute: async () => ({ success: true, rowsAffected: 0 }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(adapter),
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
    getType: () => 'test',
    close: async () => undefined,
  };
  return { adapter: adapter as unknown as DatabaseAdapter, reads };
}

function settingsStore(documents: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

interface Defaults {
  tenant?: unknown;
  platform?: unknown;
  /** The settings store cannot be read. */
  settingsUnreadable?: boolean;
}

/** The Worker's environment: the settings, and the Admin database when it is bound. */
function workerEnv(
  defaults: Defaults = {},
  adminBound = true
): ApplyOIDCIdentityMappingInput['env'] {
  const documents: Record<string, unknown> = {};
  if (defaults.tenant !== undefined) {
    documents['settings:tenant:tenant-a:identity-mapping'] = { [KEY]: defaults.tenant };
  }
  if (defaults.platform !== undefined) {
    documents['settings:platform:identity-mapping'] = { [KEY]: defaults.platform };
  }
  const SETTINGS = defaults.settingsUnreadable
    ? ({
        get: async () => {
          throw new Error('KV GET failed');
        },
      } as unknown as KVNamespace)
    : settingsStore(documents);
  return { SETTINGS, ...(adminBound ? { DB_ADMIN: adminDatabase() as never } : {}) };
}

const USER_CLAIMS = {
  sub: 'user-1',
  name: 'Alice Example',
  email: 'alice@example.com',
  email_verified: true,
  phone_number: '+8100000000',
  phone_number_verified: false,
  address: { country: 'JP' },
};

const ALL_SCOPES = ['openid', 'profile', 'email', 'phone', 'address'];

interface Entrance {
  surface: 'id_token' | 'userinfo' | 'subject';
}

function apply(
  env: ApplyOIDCIdentityMappingInput['env'],
  selector: ApplyOIDCIdentityMappingInput['selector'],
  entrance: Entrance['surface'] = 'id_token',
  core = coreDatabase().adapter
) {
  return applyOIDCIdentityMapping({
    adapter: core,
    env,
    tenantId: 'tenant-a',
    clientId: 'client-a',
    selector,
    destinationSurface: entrance === 'userinfo' ? 'userinfo' : 'id_token',
    grantedScopes: ALL_SCOPES,
    claims: { ...USER_CLAIMS },
    ...(entrance === 'subject' ? { subjectOnly: true } : {}),
  });
}

/** What an entrance did with the app: the set it was bound to, none, or the failure. */
async function outcome(run: () => ReturnType<typeof apply>): Promise<string> {
  try {
    const { binding } = await run();
    return binding ? `set:${binding.fieldMappingSetId}` : 'none';
  } catch (error) {
    if (error instanceof OIDCIdentityMappingRuntimeError) return `error:${error.details.code}`;
    const code = (error as { code?: string }).code;
    return `error:${(error as Error).name}${code ? `:${code}` : ''}`;
  }
}

const SETS = {
  // The tenant's own sets.
  'set-A': { tenant_id: 'tenant-a', lifecycle_state: 'active' },
  'set-T': { tenant_id: 'tenant-a', lifecycle_state: 'active' },
  'set-off': { tenant_id: 'tenant-a', lifecycle_state: 'draft' },
  // The platform's set, and another tenant's.
  'set-P': { tenant_id: 'platform', lifecycle_state: 'active' },
  'set-other': { tenant_id: 'tenant-b', lifecycle_state: 'active' },
};

beforeEach(() => {
  fixture.sets = { ...SETS };
  fixture.activations = [
    { tenantId: 'tenant-a', setId: 'set-A', scope: {} },
    { tenantId: 'tenant-a', setId: 'set-T', scope: {} },
    { tenantId: 'platform', setId: 'set-P', scope: {} },
  ];
  fixture.profileType = 'oidc';
  fixture.profile = 'active';
  fixture.selection = 'none';
  fixture.lookups = [];
});

describe('an app with no Mapping Set of its own, and an activation for the whole tenant', () => {
  const tenantWide = (scope: Record<string, unknown> = { kind: 'tenant' }) => {
    fixture.sets = { 'set-1': { tenant_id: 'tenant-a', lifecycle_state: 'active' } };
    fixture.activations = [{ tenantId: 'tenant-a', setId: 'set-1', scope }];
  };

  it.each([
    ['with the Admin database bound', true],
    ['without the Admin database', false],
  ])('is bound to nothing, and keeps the standard claims, %s', async (_name, adminBound) => {
    tenantWide();

    const { claims, binding } = await apply(workerEnv({}, adminBound), null);

    expect(binding).toBeNull();
    expect(claims).toMatchObject({
      sub: 'user-1',
      name: 'Alice Example',
      email: 'alice@example.com',
      phone_number: '+8100000000',
      address: { country: 'JP' },
    });
  });

  it('gets the same answer on every surface and in every Worker', async () => {
    tenantWide();

    const answers = [];
    for (const adminBound of [true, false]) {
      for (const surface of ['id_token', 'userinfo', 'subject'] as const) {
        const { claims, binding } = await apply(workerEnv({}, adminBound), null, surface);
        answers.push({ binding, sub: claims.sub, standard: 'email' in claims });
      }
    }

    expect(answers.map((a) => a.binding)).toEqual(Array(6).fill(null));
    expect(answers.map((a) => a.sub)).toEqual(Array(6).fill('user-1'));
    expect(answers.map((a) => a.standard)).toEqual(Array(6).fill(true));
  });

  it('reads no database for a mapping: a selection of none succeeds without one', async () => {
    tenantWide();
    const core = coreDatabase();
    const env = workerEnv({}, true);

    await apply(env, null, 'id_token', core.adapter);

    expect(fixture.lookups).toEqual([]);
    expect(core.reads).toEqual([]);
  });

  it('never looks an activation up by its scope', async () => {
    tenantWide();

    await apply(workerEnv(), null);
    await apply(workerEnv({ tenant: 'set-1' }), null);

    // The one lookup there is names the set.
    const lookups = fixture.lookups.filter((sql) => sql.includes('FROM field_mapping_activations'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain('a.field_mapping_set_id = ?');
  });

  it.each([
    [{ kind: 'tenant' }],
    [{ kind: 'tenant', id: 'tenant-a' }],
    [{ kind: 'tenant', protocol: 'oidc' }],
    [{ kind: 'tenant', protocol: 'oidc', role: 'op' }],
    [{ kind: 'tenant', clientId: 'client-a' }],
    [{ kind: 'tenant', partnerEntityId: 'client-a' }],
    [{}],
  ])('is not bound by an activation whose scope is %j, however well it fits', async (scope) => {
    tenantWide(scope);

    const { binding, claims } = await apply(workerEnv(), null);

    expect(binding).toBeNull();
    expect(claims.email).toBe('alice@example.com');
  });

  it('is not bound by an activation of a SAML Mapping Set, which no longer fails its sign-in', async () => {
    tenantWide();
    fixture.profileType = 'saml';

    const { binding } = await apply(workerEnv(), null);

    expect(binding).toBeNull();
  });

  it('is bound to the set the tenant names as its default, on the ID token and on UserInfo', async () => {
    tenantWide();
    fixture.selection = 'all';

    const idToken = await apply(workerEnv({ tenant: 'set-1' }), null, 'id_token');
    const userInfo = await apply(workerEnv({ tenant: 'set-1' }), null, 'userinfo');

    expect(idToken.binding?.fieldMappingSetId).toBe('set-1');
    expect(userInfo.binding?.fieldMappingSetId).toBe('set-1');
    // The profile lists the standard claims as optional and for UserInfo: the ID token holds
    // back what the app now has a mapping to hold back, and UserInfo releases what was agreed.
    expect(idToken.claims).toEqual({ sub: 'user-1' });
    expect(userInfo.claims).toMatchObject({ sub: 'user-1', email: 'alice@example.com' });
  });
});

describe('an app whose selector names only a Destination Profile (the older kind)', () => {
  const legacy = { destinationProfileId: 'profile-1' };

  // That profile once held the app's claims and its consent screen. It binds nothing now, and the
  // app must not lose that gate in silence: every entrance fails for it.
  it.each([
    ['with the Admin database', true],
    ['without the Admin database', false],
  ])('fails on every entrance, %s', async (_name, adminBound) => {
    for (const defaults of [{}, { tenant: 'set-T' }, { platform: 'set-P' }, { tenant: 'none' }]) {
      for (const surface of ['id_token', 'userinfo', 'subject'] as const) {
        const outcomeOf = await outcome(() =>
          apply(workerEnv(defaults, adminBound), legacy, surface)
        );

        expect(outcomeOf).toBe('error:policy.invalid_client_identity_mapping');
      }
    }
    expect(fixture.lookups).toEqual([]);
  });

  it('stops the consent screen’s lookup too', async () => {
    await expect(
      resolveOidcIdentityMappingBinding({
        env: workerEnv({ tenant: 'set-T' }),
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientSelector: legacy,
      })
    ).rejects.toMatchObject({
      name: 'IdentityMappingSelectionError',
      code: 'client_selector_invalid',
    });
  });

  it('answers invalid_client (400) for the ID token', async () => {
    const result = await mapIDTokenClaims(
      {
        env: workerEnv(),
        adapter: coreDatabase().adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientMetadata: { client_id: 'client-a', identity_mapping: legacy },
        loadUserAttributes: async () => null,
        log: { warn: vi.fn(), error: vi.fn() },
      } as unknown as IDTokenReleaseContext,
      { ...USER_CLAIMS },
      ALL_SCOPES
    );

    expect(result).toMatchObject({ ok: false, failure: { error: 'invalid_client', status: 400 } });
  });

  it('is no longer a failure once the app names a Mapping Set or opts out', async () => {
    expect(
      (await apply(workerEnv(), { ...legacy, fieldMappingSetId: 'set-A' })).binding
    ).toMatchObject({
      fieldMappingSetId: 'set-A',
    });
    expect((await apply(workerEnv(), { mode: 'none' })).binding).toBeNull();
  });
});

describe('an app whose selector uses the older spelling of its Mapping Set', () => {
  it('is bound to that set, as the newer spelling is', async () => {
    const older = await apply(workerEnv(), { policySetId: 'set-A' } as never);
    const newer = await apply(workerEnv(), { fieldMappingSetId: 'set-A' });

    expect(older.binding?.fieldMappingSetId).toBe('set-A');
    expect(older.claims).toEqual(newer.claims);
  });

  it('is bound to the set it names whatever the tenant names as its default', async () => {
    const { binding } = await apply(workerEnv({ tenant: 'set-T', platform: 'set-P' }), {
      policySetId: 'set-A',
    } as never);

    expect(binding?.fieldMappingSetId).toBe('set-A');
  });
});

describe('a Mapping Set whose Destination Profile is not an active OIDC profile', () => {
  const cases: Array<[string, () => void]> = [
    ['set back to draft', () => (fixture.profile = 'draft')],
    ['removed', () => (fixture.profile = 'missing')],
    ['of another kind (SAML)', () => (fixture.profileType = 'saml')],
  ];
  const entrances = ['id_token', 'userinfo', 'subject'] as const;

  it.each(cases)(
    'is refused alike on every entrance when the profile is %s',
    async (_name, arrange) => {
      arrange();
      const answers: string[] = [];
      for (const defaults of [{ tenant: 'set-T' }, { platform: 'set-P' }]) {
        for (const selector of [null, { fieldMappingSetId: 'set-A' }]) {
          for (const surface of entrances) {
            answers.push(await outcome(() => apply(workerEnv(defaults), selector, surface)));
          }
        }
      }

      // The same failure each time: a set whose profile cannot be used, never "no mapping" and
      // never a success on one entrance and a failure on another.
      expect(new Set(answers)).toEqual(
        new Set(['error:policy.invalid_destination_profile_binding'])
      );
      expect(answers).toHaveLength(12);
    }
  );

  it.each(cases)(
    'stops the consent screen’s lookup too when the profile is %s',
    async (_name, arrange) => {
      arrange();

      // The sign-in page asks the same function the release does.
      await expect(
        resolveOidcIdentityMappingBinding({
          env: workerEnv({ tenant: 'set-T' }),
          tenantId: 'tenant-a',
          clientId: 'client-a',
          clientSelector: null,
        })
      ).rejects.toMatchObject({
        name: 'IdentityMappingResolutionError',
        code: 'destination_profile_invalid',
      });
    }
  );

  it.each(cases)(
    'answers invalid_client (400) for the ID token when the profile is %s',
    async (_name, arrange) => {
      arrange();

      const result = await mapIDTokenClaims(
        {
          env: workerEnv({ tenant: 'set-T' }),
          adapter: coreDatabase().adapter,
          tenantId: 'tenant-a',
          clientId: 'client-a',
          clientMetadata: { client_id: 'client-a', identity_mapping: null },
          loadUserAttributes: async () => null,
          log: { warn: vi.fn(), error: vi.fn() },
        } as unknown as IDTokenReleaseContext,
        { ...USER_CLAIMS },
        ALL_SCOPES
      );

      expect(result).toMatchObject({
        ok: false,
        failure: { error: 'invalid_client', status: 400 },
      });
    }
  );

  it('keeps an app that opts out out of it', async () => {
    fixture.profile = 'draft';

    const { binding } = await apply(workerEnv({ tenant: 'set-T' }), { mode: 'none' });

    expect(binding).toBeNull();
  });
});

describe('a Worker without the Admin database', () => {
  it('succeeds when the selection is none', async () => {
    const { binding, claims } = await apply(workerEnv({}, false), null);

    expect(binding).toBeNull();
    expect(claims.email).toBe('alice@example.com');
  });

  it.each([
    ['the app names a set', {}, { fieldMappingSetId: 'set-A' }],
    ['the tenant default names a set', { tenant: 'set-T' }, null],
    ['the platform default names a set', { platform: 'set-P' }, null],
  ])(
    'fails, and does not fall back to the Core database, when %s',
    async (_name, defaults, selector) => {
      const core = coreDatabase();

      const error = await apply(
        workerEnv(defaults, false),
        selector,
        'id_token',
        core.adapter
      ).catch((e: unknown) => e);

      expect(error).toMatchObject({
        name: 'IdentityMappingResolutionError',
        code: 'admin_database_unavailable',
      });
      expect(error).not.toBeInstanceOf(OIDCIdentityMappingRuntimeError);
      expect(core.reads).toEqual([]);
    }
  );
});

describe('a Mapping Set the platform owns', () => {
  it('binds the apps of a tenant that has no default of its own, and is read under the platform', async () => {
    const { binding } = await apply(workerEnv({ platform: 'set-P' }), null);

    expect(binding).toMatchObject({ fieldMappingSetId: 'set-P', tenantId: 'platform' });
    const profileLookups = fixture.lookups.filter((sql) => sql.includes('destination_profiles'));
    expect(profileLookups.length).toBeGreaterThan(0);
  });

  it('can be named by the app itself', async () => {
    const { binding } = await apply(workerEnv(), { fieldMappingSetId: 'set-P' });

    expect(binding).toMatchObject({ fieldMappingSetId: 'set-P', tenantId: 'platform' });
  });

  it('is not used by an app whose tenant opted out of the platform default', async () => {
    const { binding } = await apply(workerEnv({ tenant: 'none', platform: 'set-P' }), null);

    expect(binding).toBeNull();
  });
});

describe('an app that opts out with { mode: "none" }', () => {
  it('is bound to nothing although the tenant and the platform name a set', async () => {
    const core = coreDatabase();

    const { binding, claims } = await apply(
      workerEnv({ tenant: 'set-T', platform: 'set-P' }),
      { mode: 'none' },
      'id_token',
      core.adapter
    );

    expect(binding).toBeNull();
    expect(claims.email).toBe('alice@example.com');
    expect(fixture.lookups).toEqual([]);
    expect(core.reads).toEqual([]);
  });

  it('is not even asked what the defaults say', async () => {
    const { binding } = await apply(workerEnv({ platform: 'set-P', settingsUnreadable: true }), {
      mode: 'none',
    });

    expect(binding).toBeNull();
  });
});

describe('a default that cannot be used', () => {
  it.each([
    ['a tenant default naming a set that does not exist', { tenant: 'set-gone' }],
    ['a tenant default naming a set that is not active', { tenant: 'set-off' }],
    ['a tenant default naming a set another tenant owns', { tenant: 'set-other' }],
    ['a platform default naming a set that does not exist', { platform: 'set-gone' }],
    ['a platform default naming a set a tenant owns', { platform: 'set-T' }],
  ])('fails the issuance for %s, and does not fall to the next level', async (_name, defaults) => {
    const withNext = {
      ...defaults,
      platform: 'platform' in defaults ? defaults.platform : 'set-P',
    };

    const error = await apply(workerEnv(withNext), null).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OIDCIdentityMappingRuntimeError);
    expect((error as OIDCIdentityMappingRuntimeError).details.code).toBe(
      'policy.missing_identity_mapping_binding'
    );
  });

  it.each([
    ['a tenant default that is not a value', { tenant: false }],
    ['a platform default that is not a value', { platform: 42 }],
  ])('fails the issuance for %s', async (_name, defaults) => {
    const error = await apply(workerEnv(defaults), null).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OIDCIdentityMappingRuntimeError);
    expect((error as OIDCIdentityMappingRuntimeError).details.code).toBe(
      'policy.invalid_default_identity_mapping'
    );
  });

  it('fails the issuance when the settings cannot be read, and does not read them as unset', async () => {
    const error = await apply(workerEnv({ settingsUnreadable: true }), null).catch(
      (e: unknown) => e
    );

    expect(error).toMatchObject({
      name: 'IdentityMappingSelectionError',
      code: 'settings_unreadable',
    });
  });

  it('fails for an app whose own choice is not a choice', async () => {
    const error = await apply(workerEnv(), {
      mode: 'none',
      fieldMappingSetId: 'set-A',
    } as never).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OIDCIdentityMappingRuntimeError);
    expect((error as OIDCIdentityMappingRuntimeError).details.code).toBe(
      'policy.invalid_client_identity_mapping'
    );
  });
});

/**
 * The whole table: the app's own choice, the tenant's default and the platform's. Each row is
 * run on the ID token, on UserInfo and on the derivation of the subject, and they must agree
 * with each other and with the order of the tiers, written out again here.
 */
describe('the resolution table', () => {
  type Client = 'unset' | 'A' | 'opt-out' | 'missing' | 'inactive' | 'invalid';
  type Tenant = 'unset' | 'T' | 'none' | 'missing' | 'invalid';
  type Platform = 'unset' | 'P' | 'missing';

  const CLIENTS: Client[] = ['unset', 'A', 'opt-out', 'missing', 'inactive', 'invalid'];
  const TENANTS: Tenant[] = ['unset', 'T', 'none', 'missing', 'invalid'];
  const PLATFORMS: Platform[] = ['unset', 'P', 'missing'];

  const selectorOf = (client: Client) =>
    ({
      unset: null,
      A: { fieldMappingSetId: 'set-A' },
      'opt-out': { mode: 'none' },
      missing: { fieldMappingSetId: 'set-gone' },
      inactive: { fieldMappingSetId: 'set-off' },
      invalid: { mode: 'other' },
    })[client] as ApplyOIDCIdentityMappingInput['selector'];
  const tenantValue = (tenant: Tenant) =>
    ({ unset: undefined, T: 'set-T', none: 'none', missing: 'set-gone', invalid: false })[tenant];
  const platformValue = (platform: Platform) =>
    ({ unset: undefined, P: 'set-P', missing: 'set-gone' })[platform];

  /** The order of the tiers: only an unset level falls to the next; a set level that fails fails. */
  function expected(client: Client, tenant: Tenant, platform: Platform): string {
    const missing = 'error:policy.missing_identity_mapping_binding';
    if (client === 'opt-out') return 'none';
    if (client === 'invalid') return 'error:policy.invalid_client_identity_mapping';
    if (client === 'A') return 'set:set-A';
    if (client === 'missing' || client === 'inactive') return missing;
    if (tenant === 'invalid') return 'error:policy.invalid_default_identity_mapping';
    if (tenant === 'T') return 'set:set-T';
    if (tenant === 'none') return 'none';
    if (tenant === 'missing') return missing;
    if (platform === 'P') return 'set:set-P';
    if (platform === 'missing') return missing;
    return 'none';
  }

  const rows = CLIENTS.flatMap((client) =>
    TENANTS.flatMap((tenant) => PLATFORMS.map((platform) => [client, tenant, platform] as const))
  );

  it('has every combination', () => {
    expect(rows).toHaveLength(6 * 5 * 3);
  });

  it.each(rows)(
    'client %s, tenant default %s, platform default %s: one answer on every surface',
    async (client, tenant, platform) => {
      const defaults = { tenant: tenantValue(tenant), platform: platformValue(platform) };
      const results: string[] = [];
      for (const surface of ['id_token', 'userinfo', 'subject'] as const) {
        for (const adminBound of [true, false]) {
          results.push(
            await outcome(() => apply(workerEnv(defaults, adminBound), selectorOf(client), surface))
          );
        }
      }

      const want = expected(client, tenant, platform);
      // Without the Admin database a set cannot be read, whether it exists or not: naming one is
      // a failure, never "none". A selection that fails, or is none, needs no database.
      const namesASet =
        want.startsWith('set:') || want === 'error:policy.missing_identity_mapping_binding';
      const wantUnbound = namesASet
        ? 'error:IdentityMappingResolutionError:admin_database_unavailable'
        : want;
      expect(results).toEqual(Array.from({ length: 3 }, () => [want, wantUnbound]).flat());
    }
  );
});

/**
 * An ID token is not issued when the Mapping Set the app is bound to cannot be used, and the
 * response is the one the token and authorization endpoints already give for a mapping that
 * cannot be applied.
 */
describe('the ID token when the default cannot be used', () => {
  function release(defaults: Defaults): ReturnType<typeof mapIDTokenClaims> {
    const log = { warn: vi.fn(), error: vi.fn() };
    const ctx = {
      env: workerEnv(defaults),
      adapter: coreDatabase().adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      clientMetadata: { client_id: 'client-a', identity_mapping: null },
      loadUserAttributes: async () => null,
      log,
    } as unknown as IDTokenReleaseContext;
    return mapIDTokenClaims(ctx, { ...USER_CLAIMS }, ALL_SCOPES);
  }

  it.each([
    ['a tenant default naming a set that was deleted', { tenant: 'set-gone' }],
    ['a tenant default naming a set that is not active', { tenant: 'set-off' }],
    ['a platform default naming a set that was deleted', { platform: 'set-gone' }],
    ['a tenant default that is not a value', { tenant: false }],
  ])('answers invalid_client (400) for %s', async (_name, defaults) => {
    const result = await release(defaults);

    expect(result).toMatchObject({
      ok: false,
      failure: { error: 'invalid_client', status: 400 },
    });
  });

  it('answers server_error (500) when the settings cannot be read', async () => {
    const result = await release({ settingsUnreadable: true });

    expect(result).toMatchObject({ ok: false, failure: { error: 'server_error', status: 500 } });
  });

  it('answers server_error (500) when the set cannot be read for lack of the Admin database', async () => {
    const result = await mapIDTokenClaims(
      {
        env: workerEnv({ tenant: 'set-T' }, false),
        adapter: coreDatabase().adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientMetadata: { client_id: 'client-a', identity_mapping: null },
        loadUserAttributes: async () => null,
        log: { warn: vi.fn(), error: vi.fn() },
      } as unknown as IDTokenReleaseContext,
      { ...USER_CLAIMS },
      ALL_SCOPES
    );

    expect(result).toMatchObject({ ok: false, failure: { error: 'server_error', status: 500 } });
  });

  it('issues the claims of an app that follows no default as they are', async () => {
    const result = await release({});

    expect(result).toMatchObject({
      ok: true,
      claims: { sub: 'user-1', email: 'alice@example.com' },
    });
  });
});

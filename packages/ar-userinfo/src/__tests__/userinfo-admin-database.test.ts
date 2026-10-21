/**
 * UserInfo binds the app to a Mapping Set the way the ID token does: the app's own choice, else
 * the tenant's default, else the platform's, else none. A selection of none reads no database, so
 * UserInfo answers the same with or without DB_ADMIN; a selection that names a set reads it from
 * the Admin database (DB_ADMIN) and fails without one. The reading of the set is faked so that it
 * finds the set only through the Admin database (the tenant database has no such tables), as in a
 * deployment with separate databases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const ADMIN_MARKER_SQL = 'SELECT marker FROM admin_database_marker';
const mockIntrospectTokenFromContext = vi.hoisted(() => vi.fn());
const mockGetClientCached = vi.hoisted(() => vi.fn());
const mockResolveEffectiveSettings = vi.hoisted(() => vi.fn());
// Each reading of a Mapping Set: true when it went through the Admin database.
const mappingLookups = vi.hoisted(() => ({ found: [] as boolean[], setIds: [] as string[] }));
// The Destination Profile the tenant-wide mapping carries, and whether the user has agreed to
// release its fields. Unset: the profile and the agreement the first tests below use.
const profileFixture = vi.hoisted(() => ({
  claims: undefined as Array<Record<string, unknown>> | undefined,
  selection: 'all' as 'all' | 'none',
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    introspectTokenFromContext: mockIntrospectTokenFromContext,
    getClientCached: mockGetClientCached,
    CanonicalRuntimeUserProjectionRepository: vi.fn().mockImplementation(function () {
      return { findByLegacyUserId: async () => userRow() };
    }),
    CanonicalSensitiveValueResolver: vi.fn(),
    resolveEffectiveSettings: mockResolveEffectiveSettings,
    resolveAccountDataContextFromHono: vi.fn().mockResolvedValue(undefined),
    isUserInfoEncryptionRequired: () => false,
    createPIIContextFromHono: () => ({
      coreAdapter: { query: async () => [] },
      defaultPiiAdapter: {},
    }),
  };
});

// The reading of the Mapping Set the selection named: a set that maps nothing and decides, through
// its Destination Profile, what UserInfo may carry. It is found only through the Admin database.
vi.mock('@authrim/ar-lib-core/services/identity-mapping-set-binding', async () => {
  const actual = await vi.importActual<Record<string, any>>(
    '@authrim/ar-lib-core/services/identity-mapping-set-binding'
  );
  return {
    ...actual,
    loadMappingBindingBySetId: async (input: {
      adapter: { query: (sql: string) => Promise<Array<{ marker?: string }>> } | null;
      setId: string;
      tier: string;
    }) => {
      mappingLookups.setIds.push(input.setId);
      if (input.setId === 'set-bad-profile') {
        // The set's Destination Profile is draft, removed or not OIDC.
        throw new actual.IdentityMappingResolutionError(
          'destination_profile_invalid',
          input.tier,
          input.setId
        );
      }
      const rows = (await input.adapter?.query(ADMIN_MARKER_SQL).catch(() => [])) ?? [];
      if (rows[0]?.marker !== 'admin') {
        mappingLookups.found.push(false);
        throw new actual.IdentityMappingResolutionError(
          'admin_database_unavailable',
          input.tier,
          input.setId,
          'admin_database_not_configured'
        );
      }
      mappingLookups.found.push(true);
      return {
        id: 'binding-tenant',
        tenantId: 'default',
        fieldMappingSetId: input.setId,
        fieldMappingVersionId: 'version-tenant',
        mappingSnapshotHash: 'hash-tenant',
        catalog: { identity: { id: 'c', version: '1', contentHash: 'c' }, entries: [] },
        edges: [],
        transforms: [],
        validationRules: [],
        fieldMappingSet: {},
        activationScope: {},
        destinationNamespace: 'oidc.claim',
        destinationProfileId: 'profile-1',
        destinationProfileIds: ['profile-1'],
      };
    },
  };
});

// The real release filter over a Destination Profile that lists sub and name for UserInfo only.
vi.mock('@authrim/ar-lib-core/services/destination-profile-consent', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@authrim/ar-lib-core/services/destination-profile-consent'
  );
  return {
    ...actual,
    filterOidcClaimsByDestinationConsent: (input: { claims: Record<string, unknown> }) => {
      const claims = profileFixture.claims ?? [
        { claimName: 'sub', required: true, surfaces: ['id_token', 'userinfo'] },
        { claimName: 'name', surfaces: ['userinfo'] },
        { claimName: 'email', surfaces: ['id_token'] },
      ];
      const database = {
        queryOne: async (sql: string) =>
          sql.includes('destination_profiles')
            ? {
                profile_id: 'profile-1',
                destination_type: 'oidc',
                version_id: 'version-1',
                schema_json: JSON.stringify({ claims }),
              }
            : profileFixture.selection === 'none'
              ? null
              : {
                  id: 'consent-1',
                  released_claims_json: JSON.stringify(claims.map((claim) => claim.claimName)),
                  released_attributes_json: null,
                  evidence_json: '{}',
                  created_at: 1,
                },
      };
      return (actual.filterOidcClaimsByDestinationConsent as (i: unknown) => unknown)({
        ...input,
        coreAdapter: database,
        adminAdapter: database,
      });
    },
  };
});

function userRow() {
  return {
    id: 'user-123',
    tenant_id: 'default',
    subject_id: 'subject:user-123',
    account_id: 'account:user-123',
    email: 'test@example.com',
    email_verified: 1,
    name: 'Test User',
    given_name: null,
    family_name: null,
    middle_name: null,
    nickname: null,
    preferred_username: null,
    profile: null,
    picture: null,
    website: null,
    gender: null,
    birthdate: null,
    zoneinfo: null,
    locale: null,
    phone_number: null,
    phone_number_verified: 0,
    address_json: null,
    password_hash: null,
    external_id: null,
    active: 1,
    custom_attributes_json: null,
    created_at: new Date(1_700_000_000_000).toISOString(),
    updated_at: new Date(1_700_000_000_000).toISOString(),
  };
}

/** A D1 stand-in: the tenant database knows no mapping tables, the Admin database says so. */
function fakeD1(marker?: string) {
  const statement = (sql: string) => {
    const statement = {
      bind: () => statement,
      first: async () => null,
      all: async () => ({ results: sql === ADMIN_MARKER_SQL && marker ? [{ marker }] : [] }),
      run: async () => ({ success: true, meta: {} }),
    };
    return statement;
  };
  return { prepare: statement, batch: async () => [] };
}

const logger = {
  module: () => logger,
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** The settings store with the default Mapping Set the tenant (or the platform) names. */
function settingsWith(defaults: { tenant?: string; platform?: string } = {}): KVNamespace {
  const documents: Record<string, unknown> = {};
  if (defaults.tenant) {
    documents['settings:tenant:default:identity-mapping'] = {
      'identity_mapping.oidc_default_set_id': defaults.tenant,
    };
  }
  if (defaults.platform) {
    documents['settings:platform:identity-mapping'] = {
      'identity_mapping.oidc_default_set_id': defaults.platform,
    };
  }
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

async function userinfo(env: Partial<Env>) {
  const { userinfoHandler } = await import('../userinfo');
  const c = {
    req: { header: (name: string) => (name === 'Authorization' ? 'Bearer t' : undefined) },
    env: { ISSUER_URL: 'https://op.example.com', ...env } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    header: vi.fn(),
    body: vi.fn(),
    get: vi.fn((key: string) => {
      if (key === 'logger') return logger;
      if (key === 'tenantId') return 'default';
      if (key === 'tenantMetadataContext') return { tenantId: 'default', coreDb: fakeD1() };
      return undefined;
    }),
  } as any;
  await userinfoHandler(c);
  const [body, status] = vi.mocked(c.json).mock.calls[0];
  return { body: body as Record<string, unknown>, status: status ?? 200 };
}

function arrange() {
  vi.clearAllMocks();
  mappingLookups.found = [];
  mappingLookups.setIds = [];
  profileFixture.claims = undefined;
  profileFixture.selection = 'all';
  mockResolveEffectiveSettings.mockResolvedValue({ 'oauth.userinfo_require_openid': false });
  mockGetClientCached.mockResolvedValue({ client_id: 'client-1', identity_mapping: null });
  mockIntrospectTokenFromContext.mockResolvedValue({
    valid: true,
    claims: { sub: 'user-123', client_id: 'client-1', scope: 'openid email profile' },
  });
}

describe('UserInfo and the Admin database', () => {
  beforeEach(arrange);

  it('reads the tenant default Mapping Set through DB_ADMIN and holds the claims to its Destination Profile', async () => {
    const { body, status } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: settingsWith({ tenant: 'set-tenant' }),
    });

    expect(status).toBe(200);
    expect(mappingLookups.found).toEqual([true]);
    expect(mappingLookups.setIds).toEqual(['set-tenant']);
    // The profile lists email for the ID token only and name for UserInfo.
    expect(body).toMatchObject({ sub: 'user-123', name: 'Test User' });
    expect(body).not.toHaveProperty('email');
  });

  it('reads the Mapping Set the app names itself, whatever the defaults say', async () => {
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-1',
      identity_mapping: { fieldMappingSetId: 'set-own' },
    });

    const { status } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: settingsWith({ tenant: 'set-tenant', platform: 'set-platform' }),
    });

    expect(status).toBe(200);
    expect(mappingLookups.setIds).toEqual(['set-own']);
  });

  it('fails without DB_ADMIN when the selection names a set: it does not answer the claims unmapped', async () => {
    const { body, status } = await userinfo({ SETTINGS: settingsWith({ tenant: 'set-tenant' }) });

    expect(status).toBe(500);
    expect(body).toEqual({
      error: 'server_error',
      error_description: 'Failed to apply identity mapping',
    });
    expect(mappingLookups.found).toEqual([false]);
    expect(JSON.stringify(body)).not.toContain('test@example.com');
  });

  it('answers 400 for a default that names a set that cannot be used', async () => {
    const { body, status } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: {
        get: async (key: string) =>
          key === 'settings:tenant:default:identity-mapping'
            ? JSON.stringify({ 'identity_mapping.oidc_default_set_id': 'bad id with spaces' })
            : null,
      } as unknown as KVNamespace,
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_client_metadata' });
    expect(mappingLookups.setIds).toEqual([]);
  });

  it('answers 400 for a default whose Destination Profile is not an active OIDC profile', async () => {
    const { body, status } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: settingsWith({ tenant: 'set-bad-profile' }),
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('answers 400 for an app whose selector is of the older kind (a Destination Profile, no Mapping Set)', async () => {
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-1',
      identity_mapping: { destinationProfileId: 'profile-1' },
    });

    const { body, status } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: settingsWith({ tenant: 'set-tenant' }),
    });

    // Its profile's gate is not dropped in silence: nothing is released.
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_client_metadata' });
    expect(body).not.toHaveProperty('email');
    expect(mappingLookups.setIds).toEqual([]);
  });

  it('answers 500 when the settings cannot be read', async () => {
    const { status } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: {
        get: async () => {
          throw new Error('KV GET failed');
        },
      } as unknown as KVNamespace,
    });

    expect(status).toBe(500);
  });
});

/**
 * The 2026-10-10 shape: the app's `identity_mapping` is NULL and the tenant has an activation for
 * the whole tenant (`{ kind: 'tenant' }`) whose Destination Profile lists the standard claims as
 * optional. The activation binds the app to nothing: with no default named, UserInfo answers every
 * claim the scopes release, with or without DB_ADMIN, which is what the ID token does.
 */
describe('UserInfo of an app with no Mapping Set, in a tenant with an activation for the whole tenant', () => {
  beforeEach(() => {
    arrange();
    profileFixture.claims = [
      { claimName: 'sub', required: true, surfaces: ['id_token', 'userinfo'] },
      { claimName: 'name', surfaces: ['userinfo'], requiredScopes: ['profile'] },
      { claimName: 'email', surfaces: ['userinfo'], requiredScopes: ['email'] },
      { claimName: 'email_verified', surfaces: ['userinfo'], requiredScopes: ['email'] },
    ];
    profileFixture.selection = 'none';
  });

  it.each([
    ['with DB_ADMIN', { DB_ADMIN: fakeD1('admin') as never }],
    ['without DB_ADMIN', {}],
  ])('answers every claim the scopes release, %s', async (_name, env) => {
    const { body, status } = await userinfo({ ...env, SETTINGS: settingsWith() });

    expect(status).toBe(200);
    expect(body).toMatchObject({ sub: 'user-123', name: 'Test User', email: 'test@example.com' });
    // Nothing was looked up for a mapping: not through the Admin database, not through the tenant's.
    expect(mappingLookups.found).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers the same with and without DB_ADMIN', async () => {
    const withAdmin = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: settingsWith(),
    });
    const withoutAdmin = await userinfo({ SETTINGS: settingsWith() });

    expect(withoutAdmin).toEqual(withAdmin);
  });

  it('holds the response to the profile of the set the tenant names as its default: no optional claim before the user selects it', async () => {
    const { body } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: settingsWith({ tenant: 'set-tenant' }),
    });

    expect(body).toEqual({ sub: 'user-123' });
  });

  it('answers the claims once the user has selected the profile’s fields', async () => {
    profileFixture.selection = 'all';

    const { body } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: settingsWith({ tenant: 'set-tenant' }),
    });

    expect(body).toMatchObject({ sub: 'user-123', name: 'Test User', email: 'test@example.com' });
  });

  it('is not held to any profile when the client opts out with { mode: "none" }, whatever the defaults say', async () => {
    mockGetClientCached.mockResolvedValue({
      client_id: 'client-1',
      identity_mapping: { mode: 'none' },
    });

    const { body } = await userinfo({
      DB_ADMIN: fakeD1('admin') as never,
      SETTINGS: settingsWith({ tenant: 'set-tenant', platform: 'set-platform' }),
    });

    expect(body).toMatchObject({ sub: 'user-123', name: 'Test User', email: 'test@example.com' });
    expect(mappingLookups.found).toEqual([]);
  });
});

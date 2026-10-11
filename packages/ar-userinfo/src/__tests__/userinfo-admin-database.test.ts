/**
 * UserInfo reads the app's identity mapping and Destination Profile from the Admin database
 * (DB_ADMIN), as the ID token does, so its claims match the ID token's. The mapping lookup is
 * faked so that it finds the mapping only through the Admin database (the tenant database has
 * no such tables), as in a deployment with separate databases.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const ADMIN_MARKER_SQL = 'SELECT marker FROM admin_database_marker';
const mockIntrospectTokenFromContext = vi.hoisted(() => vi.fn());
const mockGetClientCached = vi.hoisted(() => vi.fn());
const mockResolveEffectiveSettings = vi.hoisted(() => vi.fn());
const mappingLookups = vi.hoisted(() => ({ found: [] as boolean[] }));

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

// A tenant-wide mapping (no client selector) that maps nothing and decides, through its Destination
// Profile, what UserInfo may carry. It is found only through the Admin database.
vi.mock('@authrim/ar-lib-core/services/identity-mapping-runtime-resolver', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver'
  );
  return {
    ...actual,
    resolveRuntimeIdentityMappingBinding: async (adapter: {
      query: (sql: string) => Promise<Array<{ marker?: string }>>;
    }) => {
      const rows = await adapter.query(ADMIN_MARKER_SQL).catch(() => []);
      if (rows[0]?.marker !== 'admin') {
        mappingLookups.found.push(false);
        throw new Error('no such table: field_mapping_activations');
      }
      mappingLookups.found.push(true);
      return {
        id: 'binding-tenant',
        tenantId: 'default',
        fieldMappingSetId: 'set-tenant',
        fieldMappingVersionId: 'version-tenant',
        mappingSnapshotHash: 'hash-tenant',
        catalog: { identity: { id: 'c', version: '1', contentHash: 'c' }, entries: [] },
        edges: [],
        transforms: [],
        validationRules: [],
        fieldMappingSet: {},
        activationScope: { tenantId: 'default' },
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
      const claims = [
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

async function userinfo(env: Partial<Env>) {
  // The "DB_ADMIN is not bound" notice is given once per Worker instance.
  vi.resetModules();
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

describe('UserInfo and the Admin database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mappingLookups.found = [];
    mockResolveEffectiveSettings.mockResolvedValue({ 'oauth.userinfo_require_openid': false });
    mockGetClientCached.mockResolvedValue({ client_id: 'client-1', identity_mapping: null });
    mockIntrospectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: { sub: 'user-123', client_id: 'client-1', scope: 'openid email profile' },
    });
  });

  it('finds the tenant-wide mapping through DB_ADMIN and holds the claims to its Destination Profile', async () => {
    const { body, status } = await userinfo({ DB_ADMIN: fakeD1('admin') as never });

    expect(status).toBe(200);
    expect(mappingLookups.found).toEqual([true]);
    // The profile lists email for the ID token only and name for UserInfo.
    expect(body).toMatchObject({ sub: 'user-123', name: 'Test User' });
    expect(body).not.toHaveProperty('email');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not know the mapping without DB_ADMIN, answers the claims unmapped and says so', async () => {
    const { body, status } = await userinfo({});

    expect(status).toBe(200);
    expect(mappingLookups.found).toEqual([false]);
    expect(body).toMatchObject({ email: 'test@example.com' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DB_ADMIN is not bound'));
  });
});

/**
 * UserInfo: eduperson_assurance through the app's real identity mapping, Destination Profile
 * release filter and attribute release consent (only the database boundary is faked).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const fixture = vi.hoisted(() => ({
  profile: null as { claims: Array<Record<string, unknown>> } | null,
  consentCalls: [] as Array<Record<string, unknown>>,
  evidenceReads: 0,
}));
const mockIntrospectTokenFromContext = vi.hoisted(() => vi.fn());
const mockGetClientCached = vi.hoisted(() => vi.fn());
const mockResolveEffectiveSettings = vi.hoisted(() => vi.fn());

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
      coreAdapter: {
        query: async (sql: string) => {
          if (!sql.includes('assurance_evidence')) return [];
          fixture.evidenceReads += 1;
          return [
            {
              id: 'ev-IAL2',
              assurance_framework: 'nist_800_63',
              assurance_level: 'IAL2',
              verified_at: Date.now() - 86_400_000,
              expires_at: null,
              revoked_at: null,
            },
          ];
        },
      },
      defaultPiiAdapter: {},
    }),
  };
});

// The app's mapping binding: a Mapping Set that maps nothing and decides what each surface may
// carry through its Destination Profile. The app names it in its own `identity_mapping`.
vi.mock('@authrim/ar-lib-core/services/identity-mapping-set-binding', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@authrim/ar-lib-core/services/identity-mapping-set-binding'
  );
  return {
    ...actual,
    loadMappingBindingBySetId: async (input: { setId: string }) => ({
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
    }),
  };
});

// The real release filter over a Destination Profile in which the user has agreed to release
// every field.
vi.mock('@authrim/ar-lib-core/services/destination-profile-consent', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@authrim/ar-lib-core/services/destination-profile-consent'
  );
  return {
    ...actual,
    filterOidcClaimsByDestinationConsent: (input: { claims: Record<string, unknown> }) => {
      const claims = fixture.profile!.claims;
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

// The real consent step, observed.
vi.mock('@authrim/ar-lib-core/services/oidc-attribute-release-consent', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@authrim/ar-lib-core/services/oidc-attribute-release-consent'
  );
  return {
    ...actual,
    enforceOIDCAttributeReleaseConsent: (input: { claims: Record<string, unknown> }) => {
      fixture.consentCalls.push({ ...input.claims });
      return (actual.enforceOIDCAttributeReleaseConsent as (i: unknown) => unknown)(input);
    },
  };
});

import { userinfoHandler } from '../userinfo';

const IAL1_URI = 'https://example.org/assurance/IAL1';
const IAL2_URI = 'https://example.org/assurance/IAL2';

function userRow() {
  return {
    id: 'user-123',
    tenant_id: 'default',
    subject_id: 'subject:user-123',
    account_id: 'account:user-123',
    email: 'test@example.com',
    email_verified: 1,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
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

const d1 = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: {} }),
    }),
  }),
};

async function userinfo(options: {
  scope: string;
  claims?: unknown;
  client?: Record<string, unknown>;
}) {
  mockGetClientCached.mockResolvedValue({
    client_id: 'client-1',
    identity_mapping: { fieldMappingSetId: 'set-tenant' },
    ...options.client,
  });
  mockIntrospectTokenFromContext.mockResolvedValue({
    valid: true,
    claims: {
      sub: 'user-123',
      client_id: 'client-1',
      scope: options.scope,
      ...(options.claims ? { claims: JSON.stringify(options.claims) } : {}),
    },
  });
  const logger = {
    module: () => logger,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const c = {
    req: { header: (name: string) => (name === 'Authorization' ? 'Bearer t' : undefined) },
    env: { ISSUER_URL: 'https://op.example.com', DB_ADMIN: d1 } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    header: vi.fn(),
    body: vi.fn(),
    get: vi.fn((key: string) => {
      if (key === 'logger') return logger;
      if (key === 'tenantId') return 'default';
      if (key === 'tenantMetadataContext') return { tenantId: 'default', coreDb: d1 };
      return undefined;
    }),
  } as any;
  await userinfoHandler(c);
  const [body, status] = vi.mocked(c.json).mock.calls[0];
  return { body: body as Record<string, unknown>, status: status ?? 200 };
}

describe('UserInfo eduperson_assurance through the identity mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.consentCalls = [];
    fixture.evidenceReads = 0;
    fixture.profile = null;
    mockResolveEffectiveSettings.mockImplementation(async (_env: unknown, category: string) =>
      category === 'assurance'
        ? {
            'assurance.enabled': true,
            'assurance.ial_assurance_values': JSON.stringify({
              IAL1: [IAL1_URI],
              IAL2: [IAL2_URI],
            }),
          }
        : { 'oauth.userinfo_require_openid': false }
    );
  });

  const subField = { claimName: 'sub', required: true, surfaces: ['id_token', 'userinfo'] };

  it('releases it where the Destination Profile lists the field, after the consent step saw it', async () => {
    fixture.profile = { claims: [subField, { claimName: 'eduperson_assurance' }] };

    const { body, status } = await userinfo({ scope: 'openid eduperson_assurance' });

    expect(status).toBe(200);
    expect(body.eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);
    expect(fixture.consentCalls[0]).toMatchObject({ eduperson_assurance: [IAL1_URI, IAL2_URI] });
  });

  it('drops it where the Destination Profile does not list the field', async () => {
    fixture.profile = { claims: [subField] };

    const { body } = await userinfo({ scope: 'openid eduperson_assurance' });

    expect(body).not.toHaveProperty('eduperson_assurance');
    expect(fixture.evidenceReads).toBe(1);
  });

  it('releases it to a request without the scope when the client policy lets the claims parameter through, as authorize does', async () => {
    fixture.profile = { claims: [subField, { claimName: 'eduperson_assurance' }] };
    const claims = { userinfo: { eduperson_assurance: null } };

    const allowed = await userinfo({
      scope: 'openid',
      claims,
      client: { claims_parameter_policy: { eduperson_assurance: 'claims_allowed' } },
    });
    expect(allowed.body.eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);

    // Without that policy the scope is needed, and the request has none.
    const held = await userinfo({ scope: 'openid', claims });
    expect(held.body).not.toHaveProperty('eduperson_assurance');
  });

  it('holds other claims to the profile’s scopes as before, even when the client policy lets them through', async () => {
    fixture.profile = {
      claims: [subField, { claimName: 'eduperson_assurance' }, { claimName: 'email' }],
    };

    const { body } = await userinfo({
      scope: 'openid',
      claims: { userinfo: { eduperson_assurance: null, email: null } },
      client: {
        claims_parameter_policy: { eduperson_assurance: 'claims_allowed', email: 'claims_allowed' },
      },
    });

    expect(body.eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);
    expect(body).not.toHaveProperty('email');
  });
});
